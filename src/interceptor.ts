// src/interceptor.ts
// SPEC §5 rules 1–8. Turns an oversized tabular tool result into a loom_dataset_ref
// envelope; every failure degrades to byte-identical pass-through (G3). Correct
// for re-entrant calls (a loom_query result fed back with reentry:true) as well as
// first-pass downstream results — depth-1 only (SPEC §7 table).
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LoomDatasetRef, Provenance } from './types.js';
import { concatTextBlocks, estimateTokens, hasNonTextBlock, type ContentBlock } from './estimate.js';
import { deriveSchema, flattenRows } from './flatten.js';
import { extractRecords } from './extract.js';
import { buildEnvelope } from './envelope.js';
import type { ContextMatrix, RefKind } from './store.js';
import { log } from './log.js';

export interface InterceptMeta {
  server: string;
  tool: string;
  args: unknown;
  reentry?: boolean;
  denylisted?: boolean;
  depth?: number; // implicit ingests already performed in this upstream call (D2)
}

export type InterceptOutcome =
  | { intercepted: true; envelope: LoomDatasetRef }
  | { intercepted: false; result: CallToolResult };

// The subset of ContextMatrix the interceptor uses. The token threshold is a
// separate parameter, not part of the store — the interceptor stays pure.
export type StoreLike = Pick<ContextMatrix, 'ingest' | 'drop' | 'list' | 'scoredJoinHints'>;

function stripFences(text: string): string {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return m ? m[1]! : text;
}

// Locate the largest array-of-objects to depth 2; return it plus the scalar
// siblings of its container (the wrapper scalars to preserve in context).
function locateArray(
  parsed: unknown,
): { rows: Record<string, unknown>[]; context: Record<string, unknown> } | undefined {
  let best: { rows: Record<string, unknown>[]; containers: Record<string, unknown>[]; bytes: number } | undefined;
  const consider = (arr: unknown, containers: Record<string, unknown>[]) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    if (typeof arr[0] !== 'object' || arr[0] === null || Array.isArray(arr[0])) return;
    const bytes = Buffer.byteLength(JSON.stringify(arr));
    if (!best || arr.length > best.rows.length || (arr.length === best.rows.length && bytes > best.bytes)) {
      best = { rows: arr as Record<string, unknown>[], containers, bytes };
    }
  };
  if (Array.isArray(parsed)) consider(parsed, []); // depth 0 — no containers
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const top = parsed as Record<string, unknown>;
    for (const v of Object.values(top)) consider(v, [top]); // depth 1
    for (const v of Object.values(top)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const mid = v as Record<string, unknown>;
        for (const v2 of Object.values(mid)) consider(v2, [top, mid]); // depth 2
      }
    }
  }
  if (!best) return undefined;
  const context: Record<string, unknown> = {};
  // Merge scalar siblings from every container along the path to the chosen
  // array, outer→inner, so the container CLOSEST to the array wins on key
  // collisions (its metadata is more specific to the extracted rows).
  for (const container of best.containers) {
    for (const [k, v] of Object.entries(container)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) context[k] = v;
    }
  }
  return { rows: best.rows, context };
}

export async function intercept(
  result: CallToolResult,
  meta: InterceptMeta,
  store: StoreLike,
  tokenThreshold: number,
): Promise<InterceptOutcome> {
  const pass = (): InterceptOutcome => ({ intercepted: false, result });
  const content = (result.content ?? []) as ContentBlock[];

  if (result.isError) return pass(); // rule 1
  if (hasNonTextBlock(content)) return pass(); // rule 2

  const text = concatTextBlocks(content); // rule 3
  // The client receives both the text blocks and structuredContent, and the
  // envelope replaces the whole result — so the threshold (rule 4) and cost
  // guard (rule 8) measure against the full result, not the text render alone.
  // A small render over a large structured payload is still worth intercepting.
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const originalTokens =
    estimateTokens(text) + (structured != null ? estimateTokens(JSON.stringify(structured)) : 0);
  if (originalTokens < tokenThreshold) return pass(); // rule 4

  // D2 recursion cap: at most ONE implicit ingest per upstream tool call. A
  // re-entry (loom_query result) is an implicit ingest; if the budget is already
  // spent (depth >= 1), degrade inline — the caller keeps its result, just no new
  // ref — rather than mint a second implicit dataset within the same call. This
  // is the bounded-chain guarantee §7.1 exists to enforce; chains ACROSS calls
  // are fine (a fresh loom_query is depth 0 again).
  if (meta.reentry && (meta.depth ?? 0) >= 1) {
    log('warn', 'interception depth cap reached (D2); passing result through inline', { depth: meta.depth });
    return pass();
  }

  // rule 5 — everything below degrades to pass-through on any throw (rule 6).
  let ref: string | undefined;
  try {
    // Prefer the structured channel: modern SDK servers populate
    // result.structuredContent alongside the human-readable text blocks. When it
    // is (or contains) an array of objects it is strictly better input than
    // re-parsing the text rendering. Text parsing stays the fallback.
    // rung 1: structuredContent — strictly better input where present.
    let located = structured != null ? locateArray(structured) : undefined;
    let source: NonNullable<Provenance['source']> = 'structuredContent';
    // rung 2: JSON-in-text — the existing path. A non-JSON render falls THROUGH
    // to rung 3 rather than passing through, so formatted-text downstreams get a
    // chance.
    if (!located) {
      try {
        const parsed = JSON.parse(stripFences(text));
        located = locateArray(parsed);
        if (located) source = 'text';
      } catch { /* not JSON — try text-record extraction below */ }
    }
    // rung 3: tiered text-record extraction under the never-lie bar. Returns
    // the same { rows, context } shape as locateArray plus a per-tier source tag.
    if (!located) {
      const ex = extractRecords(text);
      if (ex) {
        located = { rows: ex.rows, context: ex.context };
        source = ex.source;
      }
    }
    if (!located) return pass();
    const { rows, context } = located;

    const schema = deriveSchema(rows); // may throw CapExceeded → pass-through
    if (schema.columns.length === 0) return pass();
    const cells = flattenRows(rows, schema);
    const bytes = Buffer.byteLength(JSON.stringify(rows));

    const refKind: RefKind = meta.reentry
      ? { kind: 'query' }
      : { kind: 'downstream', server: meta.server, tool: meta.tool };
    const provenance = { server: meta.server, tool: meta.tool, args: meta.args, createdAt: new Date().toISOString(), source };

    const { record, sample } = await store.ingest({ refKind, schema, cells, rows: rows.length, bytes, provenance });
    ref = record.ref; // from here, a later throw must DROP the table

    const hints = await store.scoredJoinHints(record);
    // rule 8 — envelope-cost guard: build, then discard if it doesn't save tokens.
    const draft = buildEnvelope({ record, sample, hints, context, denylisted: meta.denylisted ?? false, approxTokensSaved: 0 });
    const envelopeTokens = estimateTokens(JSON.stringify(draft));
    if (envelopeTokens >= originalTokens) {
      await store.drop(ref);
      return pass();
    }
    draft.approxTokensSaved = originalTokens - envelopeTokens;
    return { intercepted: true, envelope: draft };
  } catch (e) {
    // rule 6 — anything after a successful ingest orphaned a table; DROP it.
    if (ref) {
      try { await store.drop(ref); } catch (dropErr) { log('warn', 'failed to drop orphaned table after interception error', (dropErr as Error).message); }
    }
    log('warn', 'interception failed; passing result through (G3)', (e as Error).message);
    return pass();
  }
}
