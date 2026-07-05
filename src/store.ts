// src/store.ts
import os from 'node:os';
import { createWriteStream, mkdirSync } from 'node:fs';
import { basename, join as pathJoin, resolve as pathResolve } from 'node:path';
import { DuckDBInstance, StatementType, type DuckDBConnection, type DuckDBAppender } from '@duckdb/node-api';
import type { DatasetRecord, DerivedSchema, EnvelopeSchemaCol, JoinHint, Provenance } from './types.js';
import type { Cell } from './flatten.js';
import { deriveSchema, flattenRows } from './flatten.js';
import { log } from './log.js';
import { structuralJoinHints } from './hints.js';
import { buildDescription, type LoomDatasetDescription } from './envelope.js';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export interface StoreOptions {
  memoryLimit: string; // SET memory_limit (SPEC §6)
  memoryBudgetBytes: number; // soft eviction budget (SPEC §6)
  queryTimeoutMs: number;
  tempDir: string; // managed engine spill dir (engine spill only)
}

export type RefKind =
  | { kind: 'downstream'; server: string; tool: string }
  | { kind: 'query' }
  | { kind: 'view'; name: string };

export interface IngestParams {
  refKind: RefKind;
  schema: DerivedSchema;
  cells: Cell[][];
  rows: number;
  bytes: number;
  provenance: Provenance;
}

export interface IngestResult {
  record: DatasetRecord;
  sample: Record<string, unknown>[];
}

export function parseMemoryLimit(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(KB|MB|GB|TB)$/.exec(s);
  if (!m) throw new Error(`unparseable memory_limit "${s}"`);
  const mult: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.floor(parseFloat(m[1]!) * mult[m[2]!]!);
}

// Distinguishes "hardening blocked this" from any other failure reason. The
// startup self-test (G5) must not treat an arbitrary error (e.g. file-not-found,
// permission denied on some platform/engine version) as proof the engine sealed.
// Matches the same pattern the engine-hardening checks pin for DuckDB's
// rejection message ("...disabled by configuration").
export function isHardeningRejection(message: string): boolean {
  return /disabled by config/i.test(message);
}

// SPEC §6 primary spill control. Mirrors the engine-hardening spill check:
//   threads = max(1, min(hostCores, floor(memoryLimitBytes / 64MB)))
// This comment is the anti-drift anchor between store.ts and the spill guard.
export function computeThreads(memoryLimit: string, hostCores: number): number {
  const bytes = parseMemoryLimit(memoryLimit);
  return Math.max(1, Math.min(hostCores, Math.floor(bytes / (64 * 1024 * 1024))));
}

// SPEC §6 SQL guard: strip comments first so a trick like `/*x*/COPY...` or
// `-- ok\nATTACH...` can't hide a write/attach statement behind a leading
// SELECT-shaped comment before the read-only check runs.
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' '); // line comments
}

export function isReadOnlySql(sql: string): boolean {
  return /^\s*(SELECT|WITH)\b/i.test(stripSqlComments(sql));
}

// A minimal async FIFO: serializes work on one DuckDB connection (SPEC §6 two-lane).
class Lane {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class ContextMatrix {
  private instance?: DuckDBInstance;
  private writeConn!: DuckDBConnection;
  private readConn!: DuckDBConnection;
  private readonly writeLane = new Lane();
  private readonly readLane = new Lane();
  protected readonly registry = new Map<string, DatasetRecord>();
  private seq = 0;

  constructor(protected readonly opts: StoreOptions) {}

  async init(): Promise<void> {
    this.instance = await DuckDBInstance.create(':memory:');
    this.writeConn = await this.instance.connect();
    const threads = computeThreads(this.opts.memoryLimit, os.cpus().length);
    // Order matters — lock last (SPEC §6). These are database-global settings;
    // setting them on the write connection hardens the shared instance.
    await this.writeConn.run(`SET temp_directory = '${this.opts.tempDir.replace(/'/g, "''")}'`);
    await this.writeConn.run('SET enable_external_access = false');
    await this.writeConn.run('SET autoinstall_known_extensions = false');
    await this.writeConn.run('SET autoload_known_extensions = false');
    await this.writeConn.run(`SET memory_limit = '${this.opts.memoryLimit}'`);
    await this.writeConn.run(`SET threads = ${threads}`);
    await this.writeConn.run('SET preserve_insertion_order = false');
    await this.writeConn.run('SET lock_configuration = true');
    // Second lane inherits the now-locked global config.
    this.readConn = await this.instance.connect();
    // Startup self-test (G5): host reads MUST fail for the RIGHT reason; refuse
    // to start otherwise. A resolve means the read went through — not sealed.
    // A throw for an unrecognized reason is also not proof of sealing (could be
    // file-not-found, permission denied, or an engine-version behavior change);
    // refusing to start is the safe posture and forces re-verification on bump.
    try {
      await this.writeConn.run("SELECT * FROM read_csv('/etc/hostname')");
    } catch (err) {
      const message = (err as Error).message;
      if (!isHardeningRejection(message)) {
        log('error', 'hardening self-test rejected for an unrecognized reason', { message });
        throw new Error(
          `DuckDB hardening self-test failed: host file read rejected for an unrecognized reason "${message}"; refusing to start (SPEC §6/G5)`,
        );
      }
      log('info', 'store hardened and sealed', { threads });
      return;
    }
    throw new Error('DuckDB hardening self-test failed: host file read not rejected; refusing to start (SPEC §6/G5)');
  }

  private sanitizeId(s: string): string {
    return s.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private mintRef(kind: RefKind): string {
    const n = ++this.seq;
    if (kind.kind === 'query') return `ds_query_${n}`;
    if (kind.kind === 'view') return `ds_view_${this.sanitizeId(kind.name)}_${n}`;
    return `ds_${this.sanitizeId(kind.server)}_${this.sanitizeId(kind.tool)}_${n}`;
  }

  private appendCells(appender: DuckDBAppender, schema: DerivedSchema, cells: Cell[][]): void {
    for (const row of cells) {
      for (let i = 0; i < schema.columns.length; i++) {
        const cell = row[i] ?? null;
        if (cell === null) { appender.appendNull(); continue; }
        const type = schema.columns[i]!.type;
        switch (type) {
          case 'BIGINT': appender.appendBigInt(BigInt(cell as number)); break;
          case 'DOUBLE': appender.appendDouble(cell as number); break;
          case 'BOOLEAN': appender.appendBoolean(cell as boolean); break;
          case 'VARCHAR': appender.appendVarchar(cell as string); break;
          default: throw new Error(`unsupported column type: ${type}`);
        }
      }
      appender.endRow();
    }
  }

  async ingest(p: IngestParams): Promise<IngestResult> {
    const ref = this.mintRef(p.refKind);
    const table = ref; // ref is already [a-z0-9_]
    return this.writeLane.run(async () => {
      let appender: DuckDBAppender | undefined;
      try {
        const ddl = p.schema.columns.map((c) => `"${c.name}" ${c.type}`).join(', ');
        await this.writeConn.run(`CREATE TABLE "${table}" (${ddl})`);
        appender = await this.writeConn.createAppender(table);
        this.appendCells(appender, p.schema, p.cells);
        appender.closeSync();
        const profile = await this.profile(table, p.schema, p.rows);
        const record: DatasetRecord = {
          ref, table, rows: p.rows, bytes: p.bytes, schema: p.schema, profile,
          provenance: p.provenance, lastAccessed: Date.now(),
          pinned: p.refKind.kind === 'view',
          implicit: p.refKind.kind === 'query',
        };
        this.registry.set(ref, record);
        const sampleReader = await this.writeConn.runAndReadAll(`SELECT * FROM "${table}" LIMIT 5`);
        const sample = sampleReader.getRowObjectsJson() as Record<string, unknown>[];
        await this.evictIfNeeded(ref);
        return { record, sample };
      } catch (e) {
        // Any failure anywhere from CREATE TABLE through eviction (mid-append,
        // profiling, registry bookkeeping, the sample read, eviction itself) must
        // leave ZERO trace (SPEC §5 rule 6: no queryable or evictable state on a
        // throw). A mid-append failure leaves the appender handle open — close it
        // best-effort before cleanup so repeated malformed ingests (expected;
        // Loom degrades to pass-through per G3) don't leak native handles.
        try {
          appender?.closeSync();
        } catch {
          /* already broken; DROP is the real cleanup */
        }
        // registry.delete is a safe no-op if a throw happened before registry.set
        // ever ran (e.g. mid-append or during profiling).
        this.registry.delete(ref);
        await this.writeConn.run(`DROP TABLE IF EXISTS "${table}"`);
        throw e;
      }
    });
  }

  private totalBytes(): number {
    let sum = 0;
    for (const r of this.registry.values()) sum += r.bytes;
    return sum;
  }

  private pickVictim(currentRef: string): DatasetRecord | undefined {
    const eligible = [...this.registry.values()].filter((r) => r.ref !== currentRef && !r.pinned);
    // implicit query-result datasets evict first, then downstream; LRU within class.
    const rank = (r: DatasetRecord) => (r.implicit ? 0 : 1);
    eligible.sort((a, b) => rank(a) - rank(b) || a.lastAccessed - b.lastAccessed);
    return eligible[0];
  }

  // Runs INSIDE the ingest write-lane task (SPEC §6: eviction inside the queue so
  // it cannot race a query). The DROP acquires the read lane too — the cross-lane
  // barrier — so it cannot race an in-flight read.
  private async evictIfNeeded(currentRef: string): Promise<void> {
    while (this.totalBytes() > this.opts.memoryBudgetBytes) {
      const victim = this.pickVictim(currentRef);
      if (!victim) break;
      await this.readLane.run(() => this.writeConn.run(`DROP TABLE IF EXISTS "${victim.table}"`));
      this.registry.delete(victim.ref);
      log('info', 'evicted dataset under memory pressure', { ref: victim.ref, implicit: victim.implicit });
    }
  }

  // Public drop (interceptor calls this after a post-ingest throw, and callers may
  // release a ref). Acquires the write lane, then the read lane (cross-lane
  // barrier). Lane ordering is always write-outer/read-inner. This is acyclic —
  // and here is WHY, so a future editor can't silently break it: the ONLY place a
  // read-lane task could trigger a write-lane task is the depth-1 hand-off, and
  // handoff() is caller-level sequential — produceRead's read-lane task RESOLVES
  // (read lane released) before reingest ever touches the write lane; it never
  // holds the read lane while awaiting write. So no task ever holds read-inner
  // while another awaits write-outer on it. write-outer/read-inner is a strict
  // order with no back-edge → no cycle → no deadlock. (See handoff() below.)
  async drop(ref: string): Promise<void> {
    const rec = this.registry.get(ref);
    if (!rec) return;
    await this.writeLane.run(async () => {
      await this.readLane.run(() => this.writeConn.run(`DROP TABLE IF EXISTS "${rec.table}"`));
      this.registry.delete(ref);
    });
  }

  // Depth-1 lane hand-off (SPEC §6). produceRead's read-lane task has completed by
  // the time it resolves, so the read lane is released before reingest may enter
  // the write lane. On success the reingest product goes upstream (envelope-or-
  // inline). A reingest throw degrades to onFailure(result) — the query result is
  // returned clean, no error propagated up (G3, the orphan-class discipline one
  // level deep). Depth-N recursion is deferred.
  async handoff<T, R>(produceRead: () => Promise<T>, reingest: (r: T) => Promise<R>, onFailure: (r: T) => R): Promise<R> {
    const result = await produceRead();
    try {
      return await reingest(result);
    } catch (e) {
      log('warn', 'depth-1 hand-off ingest failed; returning query result clean (G3)', (e as Error).message);
      return onFailure(result);
    }
  }

  // One SQL pass over the freshly-created table: per-column non-null count and
  // approx-distinct count, from which nullFraction/approxDistinct/uniqueness are
  // derived (SPEC §6). Runs on the write connection, same write-lane task as the
  // ingest that created the table.
  private async profile(table: string, schema: DerivedSchema, rows: number): Promise<EnvelopeSchemaCol[]> {
    if (schema.columns.length === 0) return [];
    const parts = schema.columns.map(
      (c, i) => `count("${c.name}") AS c${i}, approx_count_distinct("${c.name}") AS d${i}`,
    );
    const reader = await this.writeConn.runAndReadAll(`SELECT ${parts.join(', ')} FROM "${table}"`);
    const r = reader.getRowObjectsJson()[0] as Record<string, unknown>;
    return schema.columns.map((c, i) => {
      const nonNull = Number(r[`c${i}`]);
      // approx_count_distinct is HyperLogLog — it can overcount at small
      // cardinalities and return a distinct count above the row count. Clamp so
      // the envelope never reports an impossible statistic (approxDistinct > rows
      // or uniqueness > 1), which would teach the model to distrust the envelope.
      const distinct = Math.min(Number(r[`d${i}`]), rows);
      return {
        name: c.name, type: c.type,
        nullFraction: rows ? 1 - nonNull / rows : 0,
        approxDistinct: distinct,
        uniqueness: rows ? distinct / rows : 0,
      };
    });
  }

  // SPEC §6 guarded read-lane query. The guard runs BEFORE the engine is
  // touched at all — a rejected statement never reaches readConn. Once past
  // the guard, the query runs on the read lane with an interrupt() timer:
  // there is no statement_timeout in the pinned engine, so a slow query is
  // stopped by calling interrupt() on the connection from a setTimeout.
  async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (!isReadOnlySql(sql)) {
      throw new Error('only read-only SELECT/WITH queries are allowed');
    }
    return this.readLane.run(async () => {
      // The leading-keyword guard above only looks at the first statement — but
      // runAndReadAll executes EVERY semicolon-separated statement it's given, so
      // `SELECT 1; DROP TABLE t; --` would pass the guard and still run the DROP
      // on this shared read connection. enable_external_access=false does not
      // stop catalog-level DDL/DML on already-loaded in-memory tables, so this is
      // the only thing standing between a query and a mutation. DuckDB's own
      // parser (not a regex) counts statements correctly, quoting/comments and
      // all — reject anything but exactly one.
      let statementCount: number;
      try {
        statementCount = (await this.readConn.extractStatements(sql)).count;
      } catch (e) {
        throw new Error(`could not parse query: ${(e as Error).message}`);
      }
      if (statementCount !== 1) {
        throw new Error('only a single read-only statement is allowed');
      }
      // The leading-keyword guard cannot tell `WITH x AS (SELECT 1) SELECT * FROM x`
      // (a legit CTE read — joins depend on this staying allowed) apart from
      // `WITH x AS (SELECT 1) DELETE FROM t` (a CTE-fronted DELETE): both are a
      // single statement starting with WITH, so extractStatements' count check
      // above does not catch it either. Only the engine's own parser knows what
      // kind of statement it prepared into — ask it, via prepare(), before ever
      // running anything.
      let prepared;
      try {
        prepared = await this.readConn.prepare(sql);
      } catch (e) {
        throw new Error(`could not parse query: ${(e as Error).message}`);
      }
      try {
        if (prepared.statementType !== StatementType.SELECT) {
          throw new Error('only read-only SELECT queries are allowed');
        }
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          this.readConn.interrupt();
        }, this.opts.queryTimeoutMs);
        try {
          const reader = await prepared.runAndReadAll();
          const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
          // True-LRU: reading a dataset is an access. Bump lastAccessed on every
          // registered ref this query names (joins included), so a recently-read
          // dataset survives eviction over a merely-newer untouched one. Word-
          // boundary match, not substring, so `ds_query_1` isn't bumped whenever
          // `ds_query_10` is read — that would make low-numbered refs sticky and
          // defeat the ordering. Refs are `[a-z0-9_]` so they need no escaping.
          const now = Date.now();
          for (const rec of this.registry.values()) {
            if (new RegExp(`\\b${rec.ref}\\b`).test(sql)) rec.lastAccessed = now;
          }
          return { rows, rowCount: rows.length };
        } catch (e) {
          if (timedOut) throw new Error(`query exceeded ${this.opts.queryTimeoutMs}ms and was interrupted`);
          throw e;
        } finally {
          clearTimeout(timer);
        }
      } finally {
        prepared.destroySync();
      }
    });
  }

  // SPEC §7 loom_materialize (reviewer ruling: reuse the ingest path, not
  // CREATE TABLE AS). Run the model's guarded SELECT on the read lane, then push
  // its rows through the SAME flatten/ingest path as any dataset — inheriting the
  // caps, the guard, profiling, and the envelope machinery — as a PINNED view.
  // Read fully drains (query resolves) before the write-lane ingest (drain-before-
  // write). Caps exceeded / bad SQL are CLEAN errors: materialize is an explicit
  // "persist this" action, not interception, so it fails loudly (no G3 degrade).
  async materialize(sql: string, name: string): Promise<IngestResult> {
    const clean = this.sanitizeId(name);
    if (!clean) throw new Error('materialize requires a non-empty name');
    // Name-collision check is check-then-act (TOCTOU). Safe by construction here:
    // Loom is single-session and every ref is minted with a unique sequence suffix
    // (ds_view_<name>_<seq>), so two materializes with the same name resolve to
    // distinct refs and cannot corrupt each other. Revisit only if refs ever
    // become caller-chosen or the store goes multi-session (deferral 2).
    if (this.list().some((r) => new RegExp(`^ds_view_${clean}_\\d+$`).test(r.ref))) {
      throw new Error(`a materialized view named "${name}" already exists`);
    }
    const { rows } = await this.query(sql); // guarded read lane; throws on non-SELECT/timeout
    const schema = deriveSchema(rows); // throws CapExceeded (names the cap) → clean error up
    const cells = flattenRows(rows, schema);
    // Deliberate second walk of `rows`: flattenRows produces the stored cells, and
    // this JSON.stringify measures the exact stored byte count for the eviction
    // budget. Accepted cost — byte accounting must reflect what is stored, and
    // materialized payloads are session-sized. Fold into the flatten pass only if
    // profiling shows it matters (deferral 3).
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    const provenance = { server: 'loom', tool: 'materialize', args: { sql, name }, createdAt: new Date().toISOString() };
    return this.ingest({ refKind: { kind: 'view', name: clean }, schema, cells, rows: rows.length, bytes, provenance });
  }

  list(): DatasetRecord[] {
    return [...this.registry.values()];
  }

  get(ref: string): DatasetRecord | undefined {
    return this.registry.get(ref);
  }

  // Loom-constructed read-only SQL on the read lane (Jaccard scoring, export
  // paging). NOT a model-input path — no guard, no lastAccessed bump. Identifiers
  // are registry table/column names (already [a-z0-9_]); values are none. Carries
  // the SAME interrupt()-timer as query(): a wedged scoring or export-page read
  // would otherwise block the read-lane FIFO — and every model loom_query behind
  // it — forever, and the degrade-on-failure catch never fires on a hang (D-2). A
  // scoring timeout lands in scoredJoinHints' catch → structural degrade; an
  // export-page timeout surfaces as the clean export tool error.
  private async readLaneQuery(sql: string): Promise<Record<string, unknown>[]> {
    return this.readLane.run(async () => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.readConn.interrupt(); }, this.opts.queryTimeoutMs);
      try {
        const reader = await this.readConn.runAndReadAll(sql);
        return reader.getRowObjectsJson() as Record<string, unknown>[];
      } catch (e) {
        if (timedOut) throw new Error(`read exceeded ${this.opts.queryTimeoutMs}ms and was interrupted`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private static readonly EXPORT_PAGE = 5000;

  // SPEC §6 sealed export: no COPY, no engine file access. Read the dataset in
  // pages on the read lane and write csv/json to a file in Node, one page at a
  // time — a large export never materializes the whole file as one string (C5).
  // exportDir-only; filename basename-sanitized (no traversal). Failures throw
  // (the loom-server handler returns a clean tool error).
  async exportDataset(ref: string, format: 'csv' | 'json', filename: string | undefined, exportDir: string): Promise<string> {
    const record = this.registry.get(ref);
    if (!record) throw new Error(`unknown ref "${ref}"`);
    if (format !== 'csv' && format !== 'json') throw new Error(`unsupported export format "${format}" (sealed: csv or json only)`);

    const safeName = basename(filename ?? `${ref}.${format}`).replace(/[^a-zA-Z0-9._-]/g, '_') || `${ref}.${format}`;
    mkdirSync(exportDir, { recursive: true });
    const outPath = pathResolve(pathJoin(exportDir, safeName));

    const stream = createWriteStream(outPath, { encoding: 'utf8' });
    const write = (s: string) => new Promise<void>((res, rej) => { stream.write(s, (e) => (e ? rej(e) : res())); });
    const cols = record.schema.columns.map((c) => c.name);
    try {
      if (format === 'csv') await write(cols.map(csvCell).join(',') + '\n');
      else await write('[');
      let offset = 0;
      let first = true;
      for (;;) {
        // ORDER BY rowid is REQUIRED, not cosmetic (D-1): the store runs
        // preserve_insertion_order = false, so unordered LIMIT/OFFSET across
        // separate page scans is not stable — pages could duplicate or drop rows,
        // silently corrupting the export. rowid is DuckDB's stable base-table key.
        const rows = await this.readLaneQuery(`SELECT * FROM "${record.table}" ORDER BY rowid LIMIT ${ContextMatrix.EXPORT_PAGE} OFFSET ${offset}`);
        for (const row of rows) {
          if (format === 'csv') {
            await write(cols.map((c) => csvCell(row[c])).join(',') + '\n');
          } else {
            await write((first ? '' : ',') + JSON.stringify(row));
            first = false;
          }
        }
        if (rows.length < ContextMatrix.EXPORT_PAGE) break;
        offset += ContextMatrix.EXPORT_PAGE;
      }
      if (format === 'json') await write(']');
      await new Promise<void>((res, rej) => stream.end((e?: Error | null) => (e ? rej(e) : res())));
      return outPath;
    } catch (e) {
      stream.destroy();
      throw e;
    }
  }

  // SPEC §7.1: value-overlap scoring layered onto structural hints. For each
  // candidate pair (key-suffix-reason pairs prioritized), sample ≤1000 distinct
  // values/side and compute Jaccard in SQL. Cap at 20 scoring ATTEMPTS/call —
  // otherwise scoring goes quadratic as the session accumulates datasets; pairs
  // beyond the cap keep their structural hint with no overlap. The cap counts
  // attempts (reads issued), not successes, so a run of failing reads can't
  // exceed the read budget. Any scoring read failure degrades that hint to
  // structural (G3-in-spirit: a hint is advisory, never fail the surrounding
  // ingest/describe over it).
  private static readonly SCORE_CAP = 20;

  async scoredJoinHints(target: DatasetRecord): Promise<JoinHint[]> {
    const structural = structuralJoinHints(target, this.list());
    // Key-suffix pairs first (more likely real join keys), then name+type.
    const ordered = [...structural].sort(
      (a, b) => (a.reason === 'key-suffix+type' ? 0 : 1) - (b.reason === 'key-suffix+type' ? 0 : 1),
    );
    const out: JoinHint[] = [];
    // Bound ATTEMPTS, not successes (deferral 1): the cap exists to
    // bound read cost per call, and a failed Jaccard read still costs a read — so
    // a failure storm must not blow the budget the cap enforces. Count each read
    // we are about to issue; a registry-miss does no read and is not counted.
    let attempts = 0;
    for (const h of ordered) {
      if (attempts >= ContextMatrix.SCORE_CAP) { out.push(h); continue; }
      const other = this.registry.get(h.ref);
      if (!other) { out.push(h); continue; }
      attempts++;
      try {
        const overlap = await this.jaccard(target.table, h.column, other.table, h.otherColumn);
        out.push({ ...h, overlap });
      } catch (e) {
        log('warn', 'value-overlap scoring failed; keeping structural hint', (e as Error).message);
        out.push(h);
      }
    }
    // Scored hints sort by overlap desc; unscored keep their relative order after.
    return out.sort((a, b) => (b.overlap ?? -1) - (a.overlap ?? -1));
  }

  private async jaccard(tableA: string, colA: string, tableB: string, colB: string): Promise<number> {
    const sql =
      `WITH a AS (SELECT DISTINCT "${colA}" AS v FROM "${tableA}" WHERE "${colA}" IS NOT NULL LIMIT 1000), ` +
      `b AS (SELECT DISTINCT "${colB}" AS v FROM "${tableB}" WHERE "${colB}" IS NOT NULL LIMIT 1000), ` +
      `i AS (SELECT count(*) AS n FROM a JOIN b USING (v)), ` +
      `u AS (SELECT count(*) AS n FROM (SELECT v FROM a UNION SELECT v FROM b)) ` +
      `SELECT CASE WHEN u.n = 0 THEN 0 ELSE i.n::DOUBLE / u.n END AS overlap FROM i, u`;
    const rows = await this.readLaneQuery(sql);
    return Number(rows[0]?.overlap ?? 0);
  }

  // Fresh join hints for a ref. Scored with value-overlap (SPEC §7.1).
  // describe() and the interceptor both call it, so the scoring upgrade reaches
  // both call sites in one change.
  async joinHintsFor(ref: string): Promise<JoinHint[]> {
    const record = this.registry.get(ref);
    if (!record) return [];
    return this.scoredJoinHints(record);
  }

  // SPEC §7 loom_describe: full record + 10-row sample + fresh hints + ageSeconds.
  // Unknown ref throws an error listing known refs (the recovery cue the model
  // needs). Reading the sample bumps lastAccessed via query() (describe is an
  // access). Provenance is redacted by buildEnvelope (both-egress rule, C4).
  async describe(ref: string): Promise<LoomDatasetDescription> {
    const record = this.registry.get(ref);
    if (!record) {
      const known = this.list().map((r) => r.ref).join(', ') || '(none)';
      throw new Error(`unknown ref "${ref}"; known refs: ${known}`);
    }
    const { rows: sample } = await this.query(`SELECT * FROM "${record.table}" LIMIT 10`);
    const hints = await this.joinHintsFor(ref);
    const ageSeconds = Math.round((Date.now() - Date.parse(record.provenance.createdAt)) / 1000);
    return buildDescription({ record, sample, hints, ageSeconds });
  }

  async close(): Promise<void> {
    try {
      this.readConn?.closeSync();
    } catch {
      /* already closed */
    }
    try {
      this.writeConn?.closeSync();
    } catch {
      /* already closed */
    }
    try {
      this.instance?.closeSync();
    } catch {
      /* already closed */
    }
    this.registry.clear();
  }
}
