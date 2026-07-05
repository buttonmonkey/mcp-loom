// src/hints.ts
// SPEC §7.1 — structural join hints only (shared name+type, or shared
// key-ish suffix + type). Value-overlap (Jaccard) scoring is layered on separately; no `overlap`
// field is emitted here — that absence is asserted in tests.
import type { DatasetRecord, EnvelopeSchemaCol, JoinHint } from './types.js';

const KEY_SUFFIX = /(id|key|uuid|email|slug|sku|code)$/i;

function keySuffix(name: string): string | undefined {
  const m = KEY_SUFFIX.exec(name);
  return m ? m[1]!.toLowerCase() : undefined;
}

function isCandidate(col: EnvelopeSchemaCol, rows: number): boolean {
  if (keySuffix(col.name)) return true;
  return col.uniqueness >= 0.95 && rows > 10;
}

export function structuralJoinHints(target: DatasetRecord, all: DatasetRecord[]): JoinHint[] {
  const hints: JoinHint[] = [];
  const candidates = target.profile.filter((c) => isCandidate(c, target.rows));
  for (const col of candidates) {
    const colSuffix = keySuffix(col.name);
    for (const other of all) {
      if (other.ref === target.ref) continue;
      for (const oc of other.profile) {
        if (oc.type !== col.type) continue;
        if (oc.name === col.name) {
          hints.push({ column: col.name, ref: other.ref, otherColumn: oc.name, type: col.type, reason: 'name+type' });
        } else if (colSuffix && keySuffix(oc.name) === colSuffix) {
          hints.push({ column: col.name, ref: other.ref, otherColumn: oc.name, type: col.type, reason: 'key-suffix+type' });
        }
      }
    }
  }
  return hints;
}
