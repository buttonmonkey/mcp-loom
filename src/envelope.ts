// SPEC §5 rule 7: build the loom_dataset_ref envelope. Pure (no DB). The
// interceptor supplies approxTokensSaved after the cost guard (§5 rule 8).
import { z } from 'zod';
import type { DatasetRecord, JoinHint, LoomDatasetRef } from './types.js';
import type { IsDenylisted } from './denylist.js';

const COLUMN_TYPE = z.enum(['BIGINT', 'DOUBLE', 'BOOLEAN', 'VARCHAR']);

// The single source of truth for envelope shape — exercised as a unit and
// end-to-end, so validation is
// one literal schema, not divergent field-picking.
export const loomDatasetRefSchema = z.object({
  kind: z.literal('loom_dataset_ref'),
  ref: z.string(),
  rows: z.number(),
  approxTokensSaved: z.number(),
  schema: z.array(z.object({
    name: z.string(), type: COLUMN_TYPE,
    nullFraction: z.number(), approxDistinct: z.number(), uniqueness: z.number(),
  })),
  sample: z.array(z.record(z.unknown())),
  joinHints: z.array(z.object({
    column: z.string(), ref: z.string(), otherColumn: z.string(),
    type: COLUMN_TYPE, reason: z.enum(['name+type', 'key-suffix+type']),
    overlap: z.number().optional(), // §7.1 value-overlap score; absent = not scored
  })),
  provenance: z.object({ server: z.string(), tool: z.string(), args: z.unknown(), createdAt: z.string(), source: z.enum(['structuredContent', 'text', 'text:markdown-table', 'text:delimited', 'text:record-blocks']).optional() }),
  context: z.record(z.unknown()),
  usage: z.string(),
});

const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|bearer|credential)/i;
const MAX_CELL = 200;

function truncate(s: string): string {
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + '…' : s;
}

// Recursive, key-based redaction over the full arg structure (objects + arrays,
// every depth). A denylisted tool omits args entirely. Length truncation is a
// bound, NOT a secret control — the key regex does the security work (SPEC §5).
// Direct callers: NEVER hardcode `denylisted` — resolve it from the record's
// provenance via makeIsDenylisted(server, tool). Hardcoding false here is
// exactly how a phantom control is born.
export function redactArgs(args: unknown, denylisted: boolean): unknown {
  if (denylisted) return '[omitted]';
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? '[redacted]' : walk(val);
      }
      return out;
    }
    if (typeof v === 'string') return truncate(v);
    return v;
  };
  return walk(args);
}

function truncateSampleRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? truncate(v) : v;
  return out;
}

export interface BuildEnvelopeParams {
  record: DatasetRecord;
  sample: Record<string, unknown>[];
  hints: JoinHint[];
  context: Record<string, unknown>;
  // Resolves denylisting from record.provenance (server + tool) — computed here,
  // never threaded as a boolean, so every egress point stays in sync.
  isDenylisted: IsDenylisted;
  approxTokensSaved: number;
}

export function buildEnvelope(p: BuildEnvelopeParams): LoomDatasetRef {
  const { record } = p;
  const usage =
    `Query this dataset with loom_query, e.g. SELECT * FROM ${record.ref} LIMIT 20. ` +
    `Refs are session-scoped and may be evicted under memory pressure; ` +
    `call loom_list_datasets to see what currently exists.`;
  return {
    kind: 'loom_dataset_ref',
    ref: record.ref,
    rows: record.rows,
    approxTokensSaved: p.approxTokensSaved,
    schema: record.profile,
    sample: p.sample.map(truncateSampleRow),
    joinHints: p.hints,
    provenance: {
      ...record.provenance,
      args: redactArgs(record.provenance.args, p.isDenylisted(record.provenance.server, record.provenance.tool)),
    },
    context: p.context,
    usage,
  };
}

export const loomDatasetDescriptionSchema = loomDatasetRefSchema.extend({ ageSeconds: z.number() });

export interface LoomDatasetDescription extends LoomDatasetRef {
  ageSeconds: number;
}

export interface BuildDescriptionParams {
  record: DatasetRecord;
  sample: Record<string, unknown>[];
  hints: JoinHint[];
  ageSeconds: number;
  isDenylisted: IsDenylisted;
}

// Describe reuses the envelope build (same schema/redaction/usage path — one
// builder, no divergence) and extends it with a 10-row sample and ageSeconds.
export function buildDescription(p: BuildDescriptionParams): LoomDatasetDescription {
  const env = buildEnvelope({
    record: p.record, sample: p.sample, hints: p.hints, context: {},
    isDenylisted: p.isDenylisted, approxTokensSaved: 0,
  });
  return { ...env, ageSeconds: p.ageSeconds };
}
