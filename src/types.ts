import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  // Extra non-secret parent-env vars to forward beyond SAFE_BASE (default-deny).
  // Optional escape hatch — empty/absent by default; zod fills `[]` for parsed configs.
  envPassthrough?: string[];
}

export interface RestartConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface LoomConfig {
  servers: ServerConfig[];
  tokenThreshold: number;
  memoryBudgetBytes: number;
  duckdbMemoryLimit: string;
  exportDir: string;
  queryTimeoutMs: number;
  restart: RestartConfig;
}

export type SessionStatus = 'init' | 'ready' | 'unavailable';

/** An exposed (namespaced) tool and where it routes. */
export interface ToolRoute {
  server: string;
  originalName: string;
}

export interface ExposedTool {
  /** Namespaced upstream-facing name, e.g. `github_list_issues`. */
  exposedName: string;
  route: ToolRoute;
  /** The downstream tool definition, name rewritten to `exposedName`. */
  tool: Tool;
}

// --- interception + store types (SPEC §5, §5.1, §6, §7) ---

export type ColumnType = 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'VARCHAR';

export interface DerivedColumn {
  name: string;
  type: ColumnType;
}

export interface DerivedSchema {
  columns: DerivedColumn[];
}

export interface Provenance {
  server: string;
  tool: string;
  args: unknown; // stored raw; redacted at envelope-build time (SPEC §5 rule 7)
  createdAt: string; // ISO 8601
  // Which result channel the rows were ingested from (SPEC §5 rule 5/7).
  // Rung 1 of the envelope-honesty marking; text extraction extends the enum with the
  // text-extraction sources. Absent for loom-internal ingests (materialized
  // views) that read no result channel.
  source?: 'structuredContent' | 'text' | 'text:markdown-table' | 'text:delimited' | 'text:record-blocks';
}

export interface EnvelopeSchemaCol {
  name: string;
  type: ColumnType;
  nullFraction: number;
  approxDistinct: number;
  uniqueness: number; // approxDistinct / rows
}

export interface JoinHint {
  column: string; // column in this dataset
  ref: string; // the other dataset's ref
  otherColumn: string; // column in the other dataset
  type: ColumnType;
  reason: 'name+type' | 'key-suffix+type';
  overlap?: number; // value-overlap Jaccard score (§7.1); absent = not scored
}

export interface DatasetRecord {
  ref: string;
  table: string; // DuckDB table name (== ref; already [a-z0-9_])
  rows: number;
  bytes: number; // serialized normalized-JSON payload size (proxy metric, SPEC §6)
  schema: DerivedSchema;
  profile: EnvelopeSchemaCol[];
  provenance: Provenance;
  lastAccessed: number; // epoch ms
  pinned: boolean;
  implicit: boolean; // true for ds_query_<seq> (recursive interception of a query result)
}

export interface LoomDatasetRef {
  kind: 'loom_dataset_ref';
  ref: string;
  rows: number;
  approxTokensSaved: number;
  schema: EnvelopeSchemaCol[];
  sample: Record<string, unknown>[];
  joinHints: JoinHint[];
  provenance: Provenance;
  context: Record<string, unknown>; // wrapper scalars discarded during array extraction
  usage: string;
}
