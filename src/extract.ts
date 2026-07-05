// src/extract.ts
// SPEC §5.2: tiered, conservative text-record extraction under the never-lie bar.
// Pure JS. Produces the same { rows, context } shape as the interceptor's
// locateArray, plus a per-tier `source` tag, so the flatten/ingest path is reused
// unchanged. Every uncertainty returns undefined → the caller passes through (G3).

export interface ExtractResult {
  rows: Record<string, unknown>[];
  context: Record<string, unknown>;
  source: 'text:markdown-table' | 'text:delimited' | 'text:record-blocks';
}

export const COVERAGE_MIN = 0.5; // captured non-whitespace must be ≥ this fraction of the source
export const KEYSET_MIN = 0.9;   // share of records matching the modal key set

const nonWs = (s: string): string => s.replace(/\s+/g, '');
export const nonWsLen = (s: string): number => nonWs(s).length;

const RESIDUE_MAX = 500;

// Bound + make readable the uncaptured remainder for envelope.context (§5 rule 7 /
// coverage accounting). Raw text, whitespace-collapsed, capped — NOT nonWs-stripped
// (N-4: a stripped "Hereisalong…" residue is useless to the model).
function boundedResidue(residueLines: string[]): string {
  return residueLines.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, RESIDUE_MAX);
}

// Shared never-lie gate. Coverage is measured over the SOURCE SPAN the tier
// actually consumed (`capturedText`), NOT over reconstructed keys+values — that
// avoids header-key inflation (N-2) and makes COVERAGE_MIN mean what it reads.
// There is deliberately NO independent-row-count check here: the honest
// guarantees are (a) reject-whole-never-skip, enforced structurally inside each
// tier, and (b) numbered-sequence contiguity, checked inside tierRecordBlocks
// where the numbering is genuinely independent of the parse (N-1). A vacuous
// count == count check would be theater and is not written.
function passesNeverLie(
  rows: Record<string, unknown>[],
  capturedText: string,
  fullText: string,
): boolean {
  if (rows.length === 0) return false;
  const totalNonWs = nonWsLen(fullText);
  if (totalNonWs === 0) return false;
  if (nonWsLen(capturedText) / totalNonWs < COVERAGE_MIN) return false; // coverage over source spans
  const sig = (r: Record<string, unknown>) => Object.keys(r).sort().join('');
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(sig(r), (counts.get(sig(r)) ?? 0) + 1);
  if (Math.max(...counts.values()) / rows.length < KEYSET_MIN) return false; // key-set consistency
  return true;
}

// ---- Tier 1: markdown tables ----------------------------------------------
const SEP_CELL = /^:?-{1,}:?$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function tierMarkdown(text: string): ExtractResult | undefined {
  const lines = text.split('\n');
  // find header+separator: a line, then a line whose cells are all separators, same count ≥ 2
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.includes('|')) continue;
    const header = splitRow(lines[i]!);
    if (header.length < 2) continue;
    const sep = splitRow(lines[i + 1]!);
    if (sep.length !== header.length || !sep.every((c) => SEP_CELL.test(c))) continue;
    // consume contiguous data rows with the SAME cell count; a wrong-count row aborts the whole tier
    const rows: Record<string, unknown>[] = [];
    let j = i + 2;
    let sawWrong = false;
    for (; j < lines.length; j++) {
      if (lines[j]!.trim() === '') break;
      if (!lines[j]!.includes('|')) break;
      const cells = splitRow(lines[j]!);
      if (cells.length !== header.length) { sawWrong = true; break; }
      const rec: Record<string, unknown> = {};
      header.forEach((h, k) => { rec[h || `col${k + 1}`] = cells[k]!; });
      rows.push(rec);
    }
    if (sawWrong) return undefined; // a malformed row inside the block → reject, never skip
    const captured = lines.slice(i, j).join('\n');            // the exact source span consumed
    if (!passesNeverLie(rows, captured, text)) continue;       // coverage over source span + key-set
    const residue = boundedResidue([...lines.slice(0, i), ...lines.slice(j)]); // readable remainder (N-4)
    return { rows, context: residue ? { residue } : {}, source: 'text:markdown-table' };
  }
  return undefined;
}

// ---- Tier 2: delimiter-consistent lines ------------------------------------
// '|' is deliberately NOT a delimiter here: every markdown table is also a
// consistent pipe-SV block, so admitting it collides tierMarkdown into the
// ambiguity rule (D-1). Markdown owns the pipe shape; a genuine pipe-SV that is
// not a markdown table is exotic and named out-of-scope in §5.2.
const DELIMS = ['\t', ',', ';'] as const;
const MIN_DELIMITED_LINES = 3;
const MIN_DELIMITED_COLS = 3;

const isNumericCell = (s: string): boolean => s.trim() !== '' && Number.isFinite(Number(s));

function tierDelimited(text: string): ExtractResult | undefined {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < MIN_DELIMITED_LINES) return undefined;
  for (const d of DELIMS) {
    const cols = lines.map((l) => l.split(d).length);
    const c = cols[0]!;
    if (c < MIN_DELIMITED_COLS) continue;      // D-2: >=3 cols; 2-col single-delim is where prose collides most
    if (!cols.every((n) => n === c)) continue; // any drift → this delimiter is out (never skip a line)
    const header = lines[0]!.split(d).map((h) => h.trim());
    const dataLines = lines.slice(1);
    const rows: Record<string, unknown>[] = dataLines.map((l) => {
      const cells = l.split(d).map((x) => x.trim());
      const rec: Record<string, unknown> = {};
      header.forEach((h, k) => { rec[h || `col${k + 1}`] = cells[k]!; });
      return rec;
    });
    // D-2 prose guard: real tabular data has >=1 column that is consistently
    // numeric across every data row; "Hello, world / Foo, bar" prose has none.
    // No numeric column → not a table → pass through (conservative never-lie).
    const hasNumericCol = header.some((_, k) => dataLines.every((l) => isNumericCell(l.split(d)[k] ?? '')));
    if (!hasNumericCol) continue;
    const captured = lines.join('\n');
    if (!passesNeverLie(rows, captured, text)) return undefined;
    // delimited fires only when EVERY non-blank line is column-consistent, so the
    // captured span IS the whole non-whitespace content — coverage is total and
    // there is no dropped structural residue (D-3 honest-empty, not silent-drop).
    return { rows, context: {}, source: 'text:delimited' };
  }
  return undefined;
}

// ---- Tier 3: repeating record blocks ---------------------------------------
const MIN_BLOCKS = 5;
const NUM_LEAD = /^\s*(\d+)\.\s+(.*)$/;       // "12. Title"
const KV = /^\s*([A-Za-z][\w .-]*?):\s+(.+)$/; // "Key: value"

// Split into blocks: prefer numbered leads (1., 2., ...); else blank-line groups.
// Also expose the uncaptured `preamble` (text before the first numbered lead) so
// a "Top 100 stories:" banner survives as residue (D-3 / §5 rule 7).
function splitBlocks(text: string): { blocks: string[]; numbered: boolean; preamble: string } {
  const lines = text.split('\n');
  const leadIdx = lines.map((l, i) => (NUM_LEAD.test(l) ? i : -1)).filter((i) => i >= 0);
  if (leadIdx.length >= MIN_BLOCKS) {
    const blocks: string[] = [];
    for (let k = 0; k < leadIdx.length; k++) {
      const start = leadIdx[k]!;
      const end = k + 1 < leadIdx.length ? leadIdx[k + 1]! : lines.length;
      blocks.push(lines.slice(start, end).join('\n'));
    }
    return { blocks, numbered: true, preamble: lines.slice(0, leadIdx[0]).join('\n') };
  }
  const groups = text.split(/\n\s*\n/).map((g) => g.trim()).filter(Boolean);
  return { blocks: groups, numbered: false, preamble: '' };
}

function parseBlock(block: string, numbered: boolean): Record<string, unknown> | undefined {
  const rec: Record<string, unknown> = {};
  const lines = block.split('\n');
  let start = 0;
  if (numbered) {
    const m = NUM_LEAD.exec(lines[0]!);
    if (!m) return undefined;
    rec.rank = Number(m[1]);
    rec.title = m[2]!.trim();
    start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    // stat line "K: v | K2: v2" OR single "K: v"
    const parts = line.includes(' | ') ? line.split(' | ') : [line];
    let matchedAny = false;
    for (const p of parts) {
      const m = KV.exec(p.trim());
      if (m) { rec[m[1]!.trim()] = m[2]!.trim(); matchedAny = true; }
    }
    if (!matchedAny) return undefined; // a non-KV, non-lead line → this block is not a clean record
  }
  return Object.keys(rec).length > (numbered ? 2 : 0) ? rec : undefined;
}

function tierRecordBlocks(text: string): ExtractResult | undefined {
  const { blocks, numbered, preamble } = splitBlocks(text);
  if (blocks.length < MIN_BLOCKS) return undefined;
  const rows: Record<string, unknown>[] = [];
  for (const b of blocks) {
    const rec = parseBlock(b, numbered);
    if (!rec) return undefined; // any block that is not a clean record → reject (never skip)
    rows.push(rec);
  }
  // the one genuinely independent count (N-1): for numbered records the numbering
  // must be a contiguous 1..N sequence — data-derived, not parse-derived.
  if (numbered) {
    const ranks = rows.map((r) => Number(r.rank));
    if (!ranks.every((v, i) => v === ranks[0]! + i)) return undefined; // numbering gap → reject
  }
  const captured = blocks.join('\n');
  if (!passesNeverLie(rows, captured, text)) return undefined; // coverage catches a dropped header/footer
  const residue = boundedResidue([preamble]); // §5 rule 7: a "Top 100 stories:" header survives in context
  return { rows, context: residue ? { residue } : {}, source: 'text:record-blocks' };
}

// Preventive ambiguity guard, isolated so it is directly testable (§7/D2 precedent).
// After D-1 the tiers are disjoint, so a natural two-tier disagreement is not
// constructable — this guards the invariant anyway.
export function selectCandidate(candidates: ExtractResult[]): ExtractResult | undefined {
  if (candidates.length === 0) return undefined;
  if (new Set(candidates.map((c) => c.rows.length)).size > 1) return undefined; // disagreement → pass-through
  return candidates[0]; // fixed order = highest-confidence tier first
}

export function extractRecords(text: string): ExtractResult | undefined {
  const candidates = [tierMarkdown(text), tierDelimited(text), tierRecordBlocks(text)]
    .filter((c): c is ExtractResult => c !== undefined);
  return selectCandidate(candidates);
}
