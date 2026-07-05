// src/denylist.ts
// SPEC §5 rule 7: the per-tool provenance denylist. Resolves "should this
// dataset's provenance.args be omitted entirely" from data already on every
// DatasetRecord - its provenance.server + provenance.tool - rather than threading
// a boolean through the ingest path. One predicate feeds every egress point
// (envelope, loom_describe, loom_list_datasets), so they cannot drift.
import type { ServerConfig } from './types.js';

export type IsDenylisted = (server: string, tool: string) => boolean;

// JSON-tuple key so server/tool names containing spaces or other characters
// (e.g. a "weird name!" tool) cannot collide across the boundary.
const key = (server: string, tool: string): string => JSON.stringify([server, tool]);

// Build the predicate from config: each server's provenanceDenylist is a list of
// that server's ORIGINAL downstream tool names. Loom-internal provenance
// (server "loom" - materialized views, query re-entries) is never in the set, so
// it resolves not-denylisted naturally, no special-casing.
export function makeIsDenylisted(servers: ServerConfig[]): IsDenylisted {
  const set = new Set<string>();
  for (const s of servers) for (const t of s.provenanceDenylist ?? []) set.add(key(s.name, t));
  return (server, tool) => set.has(key(server, tool));
}