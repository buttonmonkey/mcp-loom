// SPEC §7: tool descriptions are the only prompt surface — they must teach the
// ref workflow. Voice inherited from the loom_query/loom_list_datasets text,
// which the adoption session validated (the model adopted the workflow
// first-try).

export const QUERY_DESCRIPTION =
  'Run read-only SQL (DuckDB dialect) over cached datasets. Large results from other tools arrive as loom_dataset_ref envelopes — SELECT from a ref by its name. Refs are session-scoped and evictable; if a ref is gone, call loom_list_datasets. Large query results are themselves cached and returned as a new ref.';

export const LIST_DATASETS_DESCRIPTION =
  'List currently cached datasets (ref, rows, bytes, age, pinned/implicit flags, provenance). Use this to recover a dangling ref.';

export const DESCRIBE_DESCRIPTION =
  'Inspect one cached dataset by its ref: full schema with per-column stats, a 10-row sample, ' +
  'fresh join hints to other datasets (with value-overlap scores), provenance, and how long ago it was created. ' +
  'Datasets arrive as loom_dataset_ref envelopes from other tools and are session-scoped and evictable — ' +
  'if a ref is gone, call loom_list_datasets to see what currently exists.';

export const EXPORT_DESCRIPTION =
  'Use loom_export to write a cached dataset to a file (csv or json only) and return its absolute path — the durability move ' +
  'for a result worth keeping outside the session. Refs are session-scoped and evictable; export before a ' +
  'ref is lost. The file is written under the configured export directory.';

export const MATERIALIZE_DESCRIPTION =
  'Use loom_materialize to persist the result of a read-only SELECT as a new pinned dataset that is never evicted — the durability ' +
  'move for a derived result you want to keep and query again. Returns the new dataset ref as an envelope. ' +
  'Columns are stored in their JSON representations, so date/decimal columns become text: CAST in your SELECT ' +
  'if you need date or numeric math on the materialized view. Refs from other tools are evictable — ' +
  'loom_list_datasets shows what exists.';
