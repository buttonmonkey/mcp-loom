# mcp-loom — Specification

The normative specification for mcp-loom, a stdio MCP proxy that intercepts oversized tool results into a queryable embedded DuckDB.

---

## 1. One-paragraph summary

mcp-loom is a stdio MCP proxy that sits between one MCP client (Claude Desktop, Claude Code, Cursor) and N downstream MCP servers. It namespaces and re-exposes all downstream tools, and intercepts oversized tool results: instead of flooding the LLM's context with bulk JSON, it ingests tabular payloads into an embedded DuckDB and returns a compact envelope (dataset ref, schema, column stats, sample rows, join hints, provenance). Synthetic tools let the LLM run read-only SQL across cached datasets — including joins across data from different servers — with large query results recursively subject to the same interception rule.

## 2. Goals / Non-goals

**Goals**
- G1: Zero-config-change adoption — Loom is itself a standard stdio MCP server; any MCP client can use it.
- G2: Context economics — the LLM never receives a tool result above the token threshold when that result is tabularizable.
- G3: Never worse than no proxy — any internal failure (ingest, profiling, DuckDB) degrades to passing the original result through untouched. **This is the prime directive.**
- G4: Cross-server SQL over cached datasets with deterministic join-key discovery.
- G5: Safe by default — the SQL surface cannot read/write the host filesystem or network.
- G6: Robust under a real client: concurrent tool calls, downstream crashes, long sessions.

**Non-goals (v1)**
- No UI / visualization layer.
- No proxying of MCP resources or prompts (tools only; design must not preclude adding them).
- No persistence across restarts (in-memory DB only; export exists for durability).
- No embedding/semantic matching for join hints (name/type/value-overlap heuristics only).
- No auth or multi-tenant concerns — single local user.

## 3. Stack (locked)

- Node ≥ 20, TypeScript ≥ 5.5, strict mode, ESM, `module: NodeNext`.
- `@modelcontextprotocol/sdk` ^1.29 — low-level `Server` for Loom (dynamic tool list), `Client` + `StdioClientTransport` downstream, `McpServer` for test fixtures.
- `@duckdb/node-api` (DuckDB Neo) **1.5.4-r.1, exact pin** — promise API; use `getRowObjectsJson()` exclusively for serialization (handles BigInt); ingest via the **Appender API** (§5.1 — verified on 1.5.4-r.1: `connection.createAppender(table)` 1-arg form, typed appends, `appendNull`). The pin is exact, not a caret range, for two reasons: (1) the package publishes every version with an `-r.N` prerelease suffix, so semver ranges like `^1.5.4` never resolve; (2) §5.1 and §6 behavior was verified against this exact version — bumps are deliberate and re-run the hardening+ingest coexistence and spill tests before anything else, which an exact pin enforces mechanically.
- `zod` for config validation. `vitest` for tests. No framework, no build tooling beyond `tsc`.
- Packaged as a bin (`npx mcp-loom`) reading `loom.config.json` (path via `--config` or `LOOM_CONFIG`).

## 4. Architecture

```
MCP client ⇄ stdio ⇄ LoomServer
                      ├─ DownstreamGateway ── ClientSession[tracker] ⇄ stdio ⇄ child proc
                      │                    └─ ClientSession[repo]    ⇄ stdio ⇄ child proc
                      ├─ Interceptor  (the gate: §5)
                      ├─ ContextMatrix (DuckDB + registry: §6)
                      └─ SyntheticTools (query/describe/list/export/materialize: §7)
```

Module boundaries (each independently unit-testable, no cross-imports except via interfaces):
`config.ts`, `gateway.ts`, `supervisor.ts`, `interceptor.ts`, `flatten.ts`, `store.ts`, `hints.ts`, `synthetics.ts`, `loom-server.ts`, `types.ts`.

**Invariant: stdout is the protocol.** All logging via a `log()` helper writing to stderr with a level prefix. Lint rule or grep-check in CI: no `console.log` outside `demo/`.

### 4.1 Namespacing and re-exposure (normative)

- Upstream-exposed name for a downstream tool: `<server>_<tool>`, where `<server>` is the config name. Charset after joining must match `[a-zA-Z0-9_-]`; any other character in the downstream tool name is replaced with `_`.
- **`loom` is a reserved server name** — config validation rejects it. The `loom_` prefix belongs exclusively to synthetic tools (§7); without this reservation, a server named `loom` exposing a tool named `query` collides with `loom_query`.
- Length bound: client tool-name limits are commonly 64 chars. If `<server>_<tool>` exceeds 64, truncate the tool portion and append `_` + first **8 hex chars** of a SHA-256 of the full original name (8 rather than 4 is free insurance against two long names colliding at the hash; the `_2` suffix path below then stays reserved for genuine post-sanitization collisions rather than hash birthdays). Truncation must be deterministic across the session so re-listed tools keep stable names.
- Post-sanitization collisions (two downstream tools mapping to one name) → suffix `_2`, `_3` in downstream declaration order; log at `warn`.
- The gateway keeps a bidirectional map (exposed name ⇄ server + original name); routing uses the map, never string-splitting on `_` (server names may contain `_`).
- **Re-exposure drops the downstream `outputSchema`.** Everything else in the tool definition forwards verbatim — `inputSchema`, description, annotations. Rationale: §5 reserves Loom's right to replace any result with a `loom_dataset_ref` envelope, which cannot satisfy an arbitrary downstream output shape — a re-advertised `outputSchema` is a contract Loom will violate, and spec-strict clients (the SDK `Client`, and by extension Claude Desktop) cache each tool's schema at `listTools` and reject the schema-less envelope with `MCP error -32600`. Loom cannot synthesize `structuredContent` matching an arbitrary downstream schema, so dropping the advertisement is the only honest shape. Cost, stated plainly: clients lose structured-output *validation* for tools proxied through Loom; `structuredContent` itself still passes through untouched on below-threshold results. Found against a real `@modelcontextprotocol/server-filesystem` — the earlier test fixtures declared no `outputSchema`, so the incompatibility was unreachable until field contact.

## 5. The interception rule (normative)

Applied to every downstream tool result AND every `loom_query` result:

1. If `result.isError` → pass through.
2. **If the result contains any non-text content block (image, audio, resource, embedded resource) → pass through unchanged.** Interception is defined only over all-text results; the envelope replaces the entire result, and silently dropping non-text blocks is data loss.
3. Concatenate text content blocks; estimate tokens (`chars / 4`). The estimator is coarse — it undercounts CJK and dense-unicode payloads badly. Treat `tokenThreshold` as an order-of-magnitude dial, not a precision instrument, and document it as such. **The estimate covers the whole result the client would otherwise receive — the text blocks AND `result.structuredContent` (serialized) when present.** The envelope replaces the entire result, so a small text render over a large `structuredContent` payload is still worth intercepting; measuring the text alone would under-count and skip it. **Stated boundary:** this measure is protocol-honest, not host-aware. Loom cannot know from its seat whether a host actually surfaces `structuredContent` into the model's context — a host that renders only the text pays only the render, and against such a host a tiny-render/large-payload interception can hand the model an envelope *larger* than what it would otherwise have seen. The rule-8 never-cost-more guarantee therefore holds at the **protocol layer only**; the choice is correct because the protocol delivers both channels, but do not represent it as a host-observed saving.
4. If tokens < `tokenThreshold` (default 2000) → pass through **byte-identical** (do not re-serialize, do not touch content blocks).
5. Else attempt ingest via a **four-rung preference order — first success wins, every failure falls to the next rung, and the final miss degrades per rule 6:**
   1. **`structuredContent`** — if `result.structuredContent` is (or contains, to depth 2) an array-of-objects, ingest from that. The protocol's machine channel, strictly better input than re-parsing the render.
   2. **JSON-in-text** — else parse JSON from the concatenated text and locate the largest array-of-objects, where "largest" means **most rows, ties broken by serialized byte size** (searching nested properties to depth 2, e.g. `{data:{results:[...]}}`).
   3. **Text-record extraction (§5.2)** — else, if the text is not parseable JSON, attempt tiered conservative record extraction under the never-lie bar. This is the rung the field found missing: a formatted-text downstream (the HN `getStories` shape) that defeated rungs 1–2 and degraded to an inert pass-through.
   4. **Pass through** — no rung succeeded.
   Whichever rung wins, the located rows → flatten (§5.1) → ingest → profile → build envelope; the winning rung is recorded in `provenance.source` (`structuredContent` | `text` | `text:markdown-table` | `text:delimited` | `text:record-blocks`, §5 rule 7).
6. **If any step in (5) throws or the array is empty/non-tabular → pass through the original result unchanged**, logging the reason at `warn`. Because ingest is incremental (Appender, §5.1), a mid-append failure leaves a **partial table: the failure path must `DROP` it (write lane) before passing through** — G3 covers the caller, the drop covers the registry; a half-ingested dataset must never become queryable or evictable state. Interception failure must never surface as a tool error (G3).
7. On successful interception, the returned envelope must include: `kind: "loom_dataset_ref"`, `ref`, `rows`, `approxTokensSaved`, `schema[]` (name, type, nullFraction, approxDistinct, uniqueness), `sample` (5 rows; any string cell > 200 chars truncates with `…`), `joinHints[]`, `provenance` (server, tool, args, createdAt, **`source`** — the result channel the rows were ingested from: `structuredContent` | `text` | one of the `text:*` extraction tiers; absent for loom-internal ingests like materialized views that read no result channel), `usage` (example SQL string). The `usage` text must also state that **refs are session-scoped and may be evicted under memory pressure; `loom_list_datasets` shows what currently exists** — otherwise the model's ref-workflow degrades in long sessions in exactly the way a short smoke test cannot catch. Wrapper scalars discarded during array extraction (e.g. `{total, cursor, items}`) must be preserved in an `envelope.context` object — pagination cursors and follow-up IDs are load-bearing for the LLM. `provenance.args` is stored and surfaced **redacted** via **recursive traversal** of the full arg structure (objects and arrays, every depth — `{auth:{token}}` and `{headers:{Authorization}}` must be caught): any value whose key matches `/(token|secret|password|api[_-]?key|authorization|bearer|credential)/i` becomes `"[redacted]"`. All remaining values truncate to 200 chars — a length bound only, **not** a secret control (200 chars of a JWT is a usable prefix); the key regex does all the real security work. **Stated boundary:** key-based redaction cannot catch secrets embedded in values under innocuous keys (e.g. a key inside a query string) — do not represent this control as airtight. For servers whose args are nothing but credentials, a per-tool `provenanceDenylist` (config) stores `args: "[omitted]"` entirely.
8. **Envelope-cost guard:** estimate the envelope's own tokens; if `envelopeTokens >= originalTokens`, drop the just-created table and pass the original through unchanged. Interception must never cost more context than it saves — results just over threshold otherwise pay for schema+sample+hints AND a SQL round-trip. `approxTokensSaved` is computed from the same estimator, only after the guard passes (guaranteed positive). Note: the guard necessarily builds the full envelope (incl. hint scoring) before it can discard it; correct over cheap is intended — if profiling shows it matters, short-circuit hint-scoring when `originalTokens < 1.5 × threshold`.

### 5.1 Flattening + ingest contract (`flatten.ts`)

**Ingest mechanism (normative): Appender, never file readers.** A temp-file + `read_json_auto` ingest path cannot run under §6's hardening — `enable_external_access = false` gates *all* DuckDB file readers by the same mechanism the security self-test relies on, and `lock_configuration = true` makes it un-toggleable by design. Verified against `@duckdb/node-api` 1.5.4-r.1: `read_json_auto` on a temp file fails with "file system operations are disabled by configuration" under the exact §6 init sequence, while `CREATE TABLE` + Appender ingests cleanly with the hardening fully on. This is also a net simplification: normalization already computes per-column types, so `read_json_auto`'s type inference was redundant, and the entire temp-file lifecycle (write, read, `finally` delete) disappears from the ingest path.

Normalization, in JS, before touching DuckDB:

- Per column across all rows, compute the type set. Mapping to DuckDB types: all-integer-safe numbers → BIGINT; any float → DOUBLE; all-boolean → BOOLEAN; all-string → VARCHAR; mixed (e.g. string+number) → coerce the entire column to VARCHAR via `JSON.stringify` of non-string values.
- Nested objects: flatten one level to dotted columns (`user.email`); deeper nesting → single JSON-string column named after the path.
- Arrays-of-scalars in a cell → JSON-string column.
- `null`/missing → NULL (`appendNull`). Keys sanitized to `[a-zA-Z0-9_]`, collisions suffixed `_2`.
- Hard caps: max 2,000 columns, max 500k rows, max 64 MB payload per ingest — beyond caps, pass through (rule 6).
- Ingest: `CREATE TABLE` with the derived schema (write lane), then `createAppender(table)` → typed row appends → close. Any throw mid-append → `DROP TABLE` in the same write-lane failure path, then pass through (rule 6).

### 5.2 Text-record extraction contract (`extract.ts`)

Rung 3 of §5 rule 5. A pure module (`extractRecords(text) → { rows, context, source } | undefined`) that turns formatted text into validated records **or nothing** — it returns the same `{ rows, context }` shape as the JSON path's array locator, so flatten/ingest/caps/cost-guard (§5.1, §5 rule 8) are reused with **zero new ingest surface**; `undefined` means "fall through to pass-through (G3)."

**Tiered, conservative — not a general text-understander.** Three tiers, tried in a fixed order, each a small parser for one high-confidence shape behind its own strict validator:
1. **Markdown tables** (`text:markdown-table`) — a header row + a `| --- | :--: |` separator row + data rows of the same cell count. Near-deterministic. Owns the `|` shape.
2. **Delimiter-consistent lines** (`text:delimited`) — CSV/TSV-in-text: a sniffed delimiter (`\t` `,` `;` — **not `|`**, which is markdown's) yielding a consistent column count **≥ 3** across all non-blank lines, **and at least one column consistently numeric** across every data row. The ≥3-columns-plus-a-numeric-column requirement is the prose guard: a two-column single-delimiter block, or a delimiter-consistent block of sentences with no numeric column, is where prose collides with tables — such input is not a table and passes through.
3. **Repeating record blocks** (`text:record-blocks`) — blocks split on leading numbering (`N.`) or blank lines, `Key: value` lines and `k1: v | k2: v` stat lines becoming fields; a leading `N. Title` yields `rank`+`title`. Requires **≥ 5 blocks** and passes the key-set-consistency gate.

Freeform prose, narrative bullets, and anything matching no tier is **never** attempted.

**The never-lie bar (hard requirements — a mis-parsed envelope is a lying envelope, worse than no envelope).** Every successful extraction passes ALL of:
- **Reject-whole, never skip** — the first malformed record aborts the entire tier (`undefined`). A tier physically cannot skip a bad record and keep going, so lying-by-omission-of-a-row is unreachable. (This, not a same-pass "row-count reconciliation," is the row-integrity guarantee — a count derived from the same pass that builds the rows is theater and is deliberately not claimed.)
- **Numbered-sequence contiguity** — for numbered record blocks, the parsed `rank` values must form a contiguous `1..N` run. The numbering is server-emitted data, genuinely independent of how the parser split blocks; a gap or duplicate → reject. This is the one genuinely independent reconciliation.
- **Coverage accounting over source spans** — `nonWs(capturedSourceSpan) / nonWs(fullText) ≥ 0.5`, measured over the actual source substring consumed (never over reconstructed keys+values, which would inflate it). Whatever is uncaptured is preserved **readably** (raw, bounded) in `envelope.context.residue` — the §5 rule 7 wrapper-scalar principle applied to text: a "Top 100 stories:" banner or trailing count survives, nothing is dropped silently.
- **Key-set consistency** — the share of records whose key set equals the modal set must be ≥ 0.9. Below → reject (drifting keys).
- **Ambiguity → pass-through** — if two tiers produce candidates of differing row count, reject (logged at `warn` with the reason). After the `|`-reservation the tiers are disjoint, so this is a preventive guard.
- **Provenance honesty** — a text-derived dataset carries a per-tier `provenance.source`, so the model knows the data came from an extraction and which tier's confidence profile applies (markdown ≈ deterministic; delimited sniffer-dependent; record-blocks the fuzziest).

**Stated boundaries (the spec must not imply coverage it lacks):** the tiers are conservative single-shape parsers; freeform prose is never attempted; a non-markdown pipe-separated block is **out of scope** (`|` is reserved to markdown); and a kv-less list of `name (parenthetical)` lines is **out of scope** — a named future `text:kv-less-list` variant, because stretching record-blocks to swallow `name (paren)` lines would admit ambiguous `word (x)` prose and breach the never-lie bar.

## 6. ContextMatrix (`store.ts`)

- One `DuckDBInstance(':memory:')`. **DuckDB hardening executed at init, before anything else:**
  `SET enable_external_access = false; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET memory_limit = '<config, default 512MB>'; SET threads = <computed, see below>; SET preserve_insertion_order = false; SET lock_configuration = true;` (order matters: lock last; if the §6-export carve-out is chosen, `allowed_directories` must be set **before** `enable_external_access = false`) — write a startup self-test that asserts `SELECT * FROM read_csv('/etc/hostname')` fails; refuse to start if it doesn't (G5). **Ingest mechanism pinned: Appender (§5.1), which needs zero file access — so this self-test stays maximally strict.**
  - **Thread bound (primary spill control):** `SET threads = max(1, min(hostCores, floor(memoryLimitBytes / 64MB)))`, computed in JS at init from `duckdbMemoryLimit`. This is the mechanism that makes the `memory_limit` backstop actually *spill* instead of hard-OOM: DuckDB defaults `threads` to host core count, and each sort/hash thread reserves buffer space that must be pinned simultaneously — at a tight limit on a many-core host the working set can't be pinned and the query OOMs *even though spill is available* (verified: a 20M-row sort at a 20 MB limit OOMs at default threads on a 10-core host **with and without hardening**, but completes at `threads=1`). At the 512 MB default the formula yields 8 (or fewer if the host has fewer cores) — no perf cost in normal operation; at deliberately tight limits it collapses toward 1, which is what forces the spill. `store.ts` must implement this exact formula; the spill regression test pins `threads=1` to assert the floor case host-independently and names the formula in a comment so test and product config cannot drift.
  - **`preserve_insertion_order = false` (secondary):** an additional memory-pressure reduction, **not** the graceful-degradation mechanism — the thread bound is. Consequence, stated honestly: implicit result order becomes arbitrary — **envelope `sample` rows are arbitrary rows**, and any ordering the LLM needs must come from an explicit `ORDER BY` in `loom_query` (unaffected). Loom never promised input-order preservation, so this is a safe default.
- **Two-lane DB access:** a *write lane* (own connection + async FIFO) for ingest/DDL/eviction/export, and a *read lane* (second connection + own FIFO) for `loom_query` and sampling — DuckDB supports concurrent readers, and this prevents one slow query (up to `queryTimeoutMs`) from head-of-line-blocking every ingest behind it. Eviction and `DROP` acquire a **barrier across both lanes** so a drop can never race an in-flight read. **Lane hand-off rule:** recursive interception and `loom_materialize` mean a read-lane query can trigger a write-lane ingest — the read connection must be fully released (result drained) *before* the ingest enters the write FIFO; never hold a read lane while awaiting the write lane. No pools beyond these two connections in v1.
- Registry: `Map<ref, DatasetRecord>` with `{ref, rows, bytes, schema, provenance, lastAccessed, pinned, implicit}` — `implicit: true` marks datasets created by recursive interception of `loom_query` results (as opposed to downstream ingests and materialized views).
- Refs: `ds_<server>_<tool>_<seq>` for downstream ingests; `ds_query_<seq>` for implicit query-result datasets; `ds_view_<n>_<seq>` for materialized views. Sanitized, guaranteed unique per session.
- Profiling in one SQL pass per ingest: `count(*)`, per-column `count(col)`, `approx_count_distinct(col)`.
- **Eviction:** `bytes` means **serialized normalized-JSON payload size** — an explicit proxy metric, not DuckDB's in-engine footprint (columnar storage is usually smaller; STRUCT-heavy data can be larger, and DuckDB doesn't cheaply expose per-table memory). Eviction on tracked bytes is therefore *soft* control; the *hard* OOM backstop is the `memory_limit` pragma above — and its failure mode must be contained: an engine OOM fails only the single operation, never the process (ingest OOM → pass-through per G3, partial table dropped per §5 rule 6; `loom_query` OOM → clean tool error). **Spill-to-disk works under hardening — but graceful degradation depends on the thread bound above, not on hardening.** With `temp_directory` set to the managed temp dir, buffer-manager spill functions with `enable_external_access = false` (verified, 1.5.4-r.1: a 20M-row sort completes under a 20 MB `memory_limit` at `threads=1`). What governs spill-vs-OOM is *not* the hardening — the same sort OOMs at default (many-core) thread count with hardening **off** as well — it is Loom's computed thread bound. So `memory_limit` is a graceful backstop (ops slow and spill) *given that bound*; without it a tight limit hard-OOMs on a multi-core host. Keep the startup spill check as a **regression guard for engine version bumps**; if a future version gates spill outright, log loudly so "backstop" is understood as "op dies cleanly," not "op slows." (The managed temp dir exists *only* for engine spill — the ingest path no longer touches it.) When total tracked bytes > `memoryBudgetBytes` (default 256 MB), evict in this order: **implicit query-result datasets LRU-first, then downstream-ingest datasets LRU** — implicit datasets are cheap to regenerate (re-run the query) while source datasets may be expensive or impossible to re-fetch, and without this ordering a run of large queries can evict the very sources they joined. Never evict the dataset currently being created, never a `pinned` one, and eviction runs *inside the queue* so it cannot race a query.
- **SQL guard:** the read-only boundary is **engine statement-type classification**, not `enable_external_access`. `enable_external_access = false` gates the file/network surface (file readers, `COPY TO`, `ATTACH`, extensions) but does **not** gate catalog DDL/DML against in-memory tables — verified during development, where two bypasses of a keyword-only guard were reproduced against the pinned engine: `SELECT 1; DROP TABLE t` (the promise API executes every semicolon-separated statement it is handed, so a leading-keyword check on the first statement guards nothing) and `WITH x AS (SELECT 1) DELETE FROM t` (a single statement leading with `WITH` that mutates). The guard is therefore three layers, each independently necessary: (1) reject statements not starting `SELECT`/`WITH` after comment-stripping — the cheap first gate; (2) enforce **exactly one statement**, counted by the engine's own parser (`extractStatements().count === 1`), never by splitting on `;` (quoting and comments defeat string-splitting); (3) require the prepared statement to classify as `SELECT` (`prepare().statementType`) — this admits legitimate `WITH … SELECT` CTE reads, which cross-dataset joins depend on, and rejects CTE-fronted DML and all other DDL/DML. Per-query timeout 30 s — **mechanism: `SET statement_timeout` does not exist in the pinned engine version; use `connection.interrupt()` on a timer**; on timeout return a clean tool error.
- **Export under hardening (all engine behavior below verified on 1.5.4-r.1):** `COPY TO` is gated by `enable_external_access = false` — export is the one operation that legitimately needs a file write. Two viable mechanisms:
  - **(a) Sealed engine:** serialize in JS from a read-lane `SELECT` and write the file in Node. External access stays fully off; **covers csv and json only** — there is no pure-JS parquet writer without a new dependency (which the locked stack resists), and parquet is exactly what the engine writer is for.
  - **(b) exportDir carve-out:** `SET allowed_directories = [exportDir]` **before** disabling external access. Verified semantics: `allowed_directories` is a **carve-out from the disabled state**, not a restriction on the enabled one (with external access on, it does nothing at runtime), and **no write-only scoping exists**. Under the carve-out: reads *and* writes succeed inside `exportDir`, everything outside stays rejected, and the carve-out participates in `lock_configuration` (widening after lock is refused — verified). The global switch never flips on; the precise cost is one **bidirectional hole**: a crafted `loom_query` can read files inside `exportDir`, including Loom's own prior exports. Self-test under (b) becomes: reads outside `exportDir` fail, reads inside succeed.
  - The real fork is therefore **sealed + csv/json only** versus **carve-out + all three formats + exportDir readable by queries**, with the choice and its cost stated in the README. Do not represent (b) as write-only, and never silently re-enable external access.
  Export mechanics regardless of fork: `exportDir` only; filename basename-sanitized; formats per the fork chosen. **(Ruling: fork (a), sealed engine — csv/json only; a spike measured 0.42 s for a 100k-row export, ~24× under the bar, so (b)'s permanent readable hole buys nothing.)**

## 7. Synthetic tools

| Tool | Behavior |
|---|---|
| `loom_query {sql}` | Run guarded SQL. Result re-enters interception rule (§5); an intercepted query result registers as an `implicit` dataset `ds_query_<seq>`. Inline result shape: `{rows, rowCount}`. |
| `loom_describe {ref}` | Full record + 10-row sample + fresh join hints + `ageSeconds`. Unknown ref → error listing known refs. |
| `loom_list_datasets {}` | All records: ref, rows, bytes, ageSeconds, pinned/implicit flags, provenance. |
| `loom_export {ref, format, filename?}` | Write file, return absolute path. |
| `loom_materialize {sql, name}` | Persist a SELECT as a new **pinned** dataset `ds_view_<n>_<seq>`; returns its envelope. |

Tool descriptions must teach the workflow (they are the only prompt surface): mention refs, the DuckDB dialect, that other tools' large results arrive as envelopes, and that **refs are session-scoped and evictable** — the recovery move for a dangling ref is `loom_list_datasets`, and the durability move for a result worth keeping is `loom_materialize` (pinned) or `loom_export`.

### 7.1 Join hints (`hints.ts`)

Candidate columns: key-ish name suffix (`id|key|uuid|email|slug|sku|code`) or uniqueness ≥ 0.95 with rows > 10. Cross-reference against all cached datasets: exact name+type match, or shared key-ish suffix + type match. **Value-overlap scoring:** for each candidate pair, sample ≤ 1,000 distinct values per side and compute Jaccard overlap in SQL; attach `overlap: 0..1` to the hint and sort by it. **Cost cap:** value-overlap scoring runs for at most 20 candidate pairs per ingest (key-suffix matches prioritized); pairs beyond the cap keep name/type hints without an overlap score — otherwise scoring goes quadratic as a session accumulates datasets. This demotes false positives like disjoint `id` spaces. The cap bounds scoring **attempts**, not successes — a failed Jaccard read still costs a read, so a failure storm must not exceed the read budget the cap enforces.

## 8. Process supervision (`supervisor.ts`)

- Each downstream child: spawn, health = initialized handshake completed. **Child environment (normative, default-deny):** child env = a curated non-secret base `SAFE_BASE` (POSIX: `PATH HOME TMPDIR LANG LC_ALL LC_CTYPE TZ TERM`; Windows: `SystemRoot windir PATH Path PATHEXT ComSpec APPDATA LOCALAPPDATA TEMP TMP USERPROFILE PROCESSOR_ARCHITECTURE`) ∪ the per-server `envPassthrough` allowlist, read from Loom's env, then the per-server `env` overlay **last**. The launching shell's environment is **not** copied wholesale, so a compromised downstream cannot read secrets meant for another server. `SAFE_BASE` is load-bearing, not decoration: a bare clean env breaks `npx`/node spawns (no PATH/HOME/locale), and users "fix" that by pasting their whole env back — recreating the hole; the base is what keeps the secure default *usable*. **Boundary (must not be oversold):** least-privilege, not zero-leak — a passed-through proxy/CA var can carry a secret, and this closes only the *environment* vector (a malicious child can still reach the filesystem/network itself). OS-level per-child isolation (uid/namespace/container) is the ceiling and is out of scope for a zero-config stdio proxy. No "inherit-everything" flag; if ever added it must warn loudly at startup, naming the secret-shaped vars it forwards. A `*TOKEN*/*SECRET*/*KEY*` denylist on the inherited env is the same brittle key-heuristic as §5-rule-7 provenance redaction — defense-in-depth only, never the primary control.
- On child exit/transport error: mark its tools `unavailable` (calls to them return a clean tool error naming the server), attempt restart with exponential backoff (1 s → 30 s cap, max 5 attempts), re-list tools on reconnect (tool set may have changed → emit `notifications/tools/list_changed` upward). **After the final failed attempt: delist the server's tools and emit `list_changed`** — permanently-erroring tools pollute the model's tool list and invite retry loops; a delisted server stays down until Loom restarts.
- Graceful shutdown on SIGINT/SIGTERM **or upward transport close (stdin EOF)** — clients commonly signal server shutdown by closing the pipe, not by signaling, and the pipe-close path is a common orphan source: close upward transport, `close()` each client, `kill()` lingering children after 3 s, remove the spill temp dir. No orphaned processes (verify in tests via PID checks).
- A downstream server failing to start is a warning, not fatal, unless zero servers connect.

## 9. Config schema (zod-validated; fail fast with a readable error)

```jsonc
{
  "servers": [ { "name": "str (^[a-z][a-z0-9_]{0,31}$, unique, `loom` rejected as reserved)", "command": "str", "args": ["str"], "env": {"K":"V"}, "envPassthrough": ["str (non-secret var names; default [])"] } ],
  "tokenThreshold": 2000,          // int ≥ 100; chars/4 estimate — an order-of-magnitude dial, not precise
  "memoryBudgetBytes": 268435456,  // int ≥ 1 MB (soft eviction budget, see §6)
  "duckdbMemoryLimit": "512MB",    // hard engine backstop (SET memory_limit); zod-refine format ^\d+(\.\d+)?(KB|MB|GB|TB)$
  "exportDir": "./exports",
  "queryTimeoutMs": 30000,
  "restart": { "maxAttempts": 5, "baseDelayMs": 1000 }
}
```

## 10. Open decisions

- SSE / streamable-HTTP downstream transports: `gateway.ts` is designed so transport is per-server-config polymorphic; stdio is implemented.
- `notifications/tools/list_changed` from downstream servers: subscribe and propagate where the SDK makes it cheap.
- Export fork under hardening (§6): **decided — (a) sealed** (csv/json only).
- **Interception recursion depth (final):** the depth cap is global at 1, counted per upstream tool call; a within-call second implicit ingest degrades inline (G3), never errors; chains across calls are fine (each link bounded and model-initiated); `loom_materialize` does not consume the budget.
- **Forward-compatibility — selection round-trips (design only):** a future canvas will pass selections back as query inputs. Constraints on that contract, so v1 doesn't preclude it: (a) selections arrive as a structured predicate AST (`{col, op, value}` conjunctions) plus optional bounded ID list — never raw SQL from the frontend; the server compiles to SQL at the existing guarded gate. (b) Predicate and ID list are alternative encodings of one selection (approximate vs exact), never OR-combined. (c) ID lists > ~500 entries spill to a temp table and semi-join. (d) A selection materializes via the existing `loom_materialize` path as a normal pinned ref, with provenance = source ref + serialized selection. (e) Canvas↔store transport: dual-transport loopback sidecar (Loom stays a stdio child; boots an HTTP/WS server on 127.0.0.1, random port). Security is not optional hardening: mandatory per-session token (0600 file or launch-URL delivery; no-token handshakes dropped; no auth-off flag), Origin validation on WS handshake (WS is not CORS-protected — any webpage can attempt localhost connections), and the canvas channel is capability-scoped to selection ASTs + ref reads only, never the raw SQL gate. Sidecar lifecycle is tied to the stdio pipe via §8 shutdown handling.
