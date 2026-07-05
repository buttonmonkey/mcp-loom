// src/flatten.ts
// SPEC §5.1: pure-JS normalization. No DuckDB, no JSON parsing (the interceptor
// parses; this receives already-parsed rows). Derives a typed schema and a typed
// cell matrix; enforces the ingest hard caps.
import type { ColumnType, DerivedSchema } from './types.js';

export type Cell = number | boolean | string | null;

export class CapExceeded extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CapExceeded';
  }
}

const MAX_COLS = 2000;
const MAX_ROWS = 500_000;
const MAX_BYTES = 64 * 1024 * 1024;

const NON_KEY = /[^a-zA-Z0-9_]/g;

function sanitizeKey(k: string): string {
  const s = k.replace(NON_KEY, '_');
  return s.length ? s : '_';
}

type Prim = 'int' | 'float' | 'bool' | 'string' | 'null';

// Yield one row's [originalDottedKey, Cell] pairs, unsanitized and unsuffixed:
// one level of object nesting → dotted key; deeper nesting and any array → a
// JSON-string value. Sanitizing and de-duplication happen later, dataset-wide.
function rawEntries(row: Record<string, unknown>): [string, Cell][] {
  const out: [string, Cell][] = [];
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 !== null && typeof v2 === 'object') out.push([`${k}.${k2}`, JSON.stringify(v2)]);
        else out.push([`${k}.${k2}`, v2 as Cell]);
      }
    } else if (Array.isArray(v)) {
      out.push([k, JSON.stringify(v)]);
    } else {
      out.push([k, (v ?? null) as Cell]);
    }
  }
  return out;
}

// Build a dataset-wide map from original (dotted) key to its unique emitted
// column name, scanning every row in first-appearance order (SPEC §5.1). The
// same original key always maps to the same column, across all rows. When a
// sanitized name is already emitted by a DIFFERENT original key, suffix
// _2, _3, ... choosing the first name not already in use — tracked via the
// actual emitted names, so a real key like "a_b_2" can never be silently
// overwritten by a generated suffix (or vice versa).
function buildColumnMap(rows: Record<string, unknown>[]): Map<string, string> {
  const colMap = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const row of rows) {
    for (const [origKey] of rawEntries(row)) {
      if (colMap.has(origKey)) continue;
      const base = sanitizeKey(origKey);
      let name = base;
      let n = 2;
      while (usedNames.has(name)) {
        name = `${base}_${n}`;
        n += 1;
      }
      usedNames.add(name);
      colMap.set(origKey, name);
    }
  }
  return colMap;
}

function primOf(v: Cell): Prim {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v) ? 'int' : 'float';
  return 'string';
}

function resolveType(set: Set<Prim>): ColumnType {
  const nn = [...set].filter((t) => t !== 'null');
  if (nn.length === 0) return 'VARCHAR'; // all-null column
  if (nn.length === 1) {
    switch (nn[0]) {
      case 'int': return 'BIGINT';
      case 'float': return 'DOUBLE';
      case 'bool': return 'BOOLEAN';
      default: return 'VARCHAR';
    }
  }
  if (nn.every((t) => t === 'int' || t === 'float')) return 'DOUBLE'; // any float → DOUBLE
  return 'VARCHAR'; // any other mix → VARCHAR
}

export function deriveSchema(rows: Record<string, unknown>[]): DerivedSchema {
  if (rows.length > MAX_ROWS) throw new CapExceeded(`rows ${rows.length} > ${MAX_ROWS}`);
  const bytes = Buffer.byteLength(JSON.stringify(rows));
  if (bytes > MAX_BYTES) throw new CapExceeded(`payload ${bytes} bytes > ${MAX_BYTES}`);

  const colMap = buildColumnMap(rows);
  const order = [...colMap.values()];
  if (order.length > MAX_COLS) throw new CapExceeded(`columns ${order.length} > ${MAX_COLS}`);

  const types = new Map<string, Set<Prim>>();
  for (const name of order) types.set(name, new Set<Prim>());
  for (const row of rows) {
    for (const [origKey, v] of rawEntries(row)) {
      const name = colMap.get(origKey)!;
      types.get(name)!.add(primOf(v));
    }
  }
  return { columns: order.map((name) => ({ name, type: resolveType(types.get(name)!) })) };
}

function coerce(v: Cell | undefined, type: ColumnType): Cell {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'BIGINT': return typeof v === 'number' ? v : Number(v);
    case 'DOUBLE': return typeof v === 'number' ? v : Number(v);
    case 'BOOLEAN': return typeof v === 'boolean' ? v : v === 'true';
    case 'VARCHAR': return typeof v === 'string' ? v : JSON.stringify(v);
  }
}

export function flattenRows(rows: Record<string, unknown>[], schema: DerivedSchema): Cell[][] {
  const colMap = buildColumnMap(rows);
  const indexByName = new Map(schema.columns.map((c, i) => [c.name, i]));
  return rows.map((row) => {
    const cells: (Cell | undefined)[] = new Array(schema.columns.length).fill(undefined);
    for (const [origKey, v] of rawEntries(row)) {
      const name = colMap.get(origKey);
      const idx = name === undefined ? undefined : indexByName.get(name);
      if (idx !== undefined) cells[idx] = v;
    }
    return schema.columns.map((c, i) => coerce(cells[i], c.type));
  });
}
