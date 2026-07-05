import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownstreamGateway } from './gateway.js';
import { Supervisor } from './supervisor.js';
import { ContextMatrix } from './store.js';
import { intercept } from './interceptor.js';
import { redactArgs, buildEnvelope } from './envelope.js';
import { QUERY_DESCRIPTION, LIST_DATASETS_DESCRIPTION, DESCRIBE_DESCRIPTION, EXPORT_DESCRIPTION, MATERIALIZE_DESCRIPTION } from './tool-descriptions.js';
import type { LoomConfig, LoomDatasetRef } from './types.js';
import { log } from './log.js';

export const SYNTHETIC_TOOLS: Tool[] = [
  {
    name: 'loom_query',
    description: QUERY_DESCRIPTION,
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  },
  {
    name: 'loom_list_datasets',
    description: LIST_DATASETS_DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'loom_describe',
    description: DESCRIBE_DESCRIPTION,
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'loom_export',
    description: EXPORT_DESCRIPTION,
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, format: { type: 'string', enum: ['csv', 'json'] }, filename: { type: 'string' } }, required: ['ref', 'format'] },
  },
  {
    name: 'loom_materialize',
    description: MATERIALIZE_DESCRIPTION,
    inputSchema: { type: 'object', properties: { sql: { type: 'string' }, name: { type: 'string' } }, required: ['sql', 'name'] },
  },
];

function envelopeToResult(env: LoomDatasetRef): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(env) }] };
}

export interface LoomHandle {
  server: Server;
  gateway: DownstreamGateway;
  start(transport: Transport): Promise<void>;
  shutdown(): Promise<void>;
}

export function createLoomServer(config: LoomConfig, version: string): LoomHandle {
  const gateway = new DownstreamGateway();
  const spillDir = mkdtempSync(join(tmpdir(), 'loom-spill-'));
  const store = new ContextMatrix({
    memoryLimit: config.duckdbMemoryLimit,
    memoryBudgetBytes: config.memoryBudgetBytes,
    queryTimeoutMs: config.queryTimeoutMs,
    tempDir: spillDir,
  });
  const server = new Server({ name: 'mcp-loom', version }, { capabilities: { tools: { listChanged: true } } });
  const supervisor = new Supervisor(config, gateway, () => {
    server.sendToolListChanged().catch(() => { /* not connected yet */ });
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...gateway.listExposedTools(), ...SYNTHETIC_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments as Record<string, unknown> | undefined;
    const toolError = (msg: string): CallToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

    if (name === 'loom_list_datasets') {
      // Provenance.args is stored raw (SPEC comment, types.ts); redact here same
      // as buildEnvelope does, so listings never re-surface secrets (SPEC §5 rule 7,
      // §5 rule 7). Denylisted=false — the per-tool provenanceDenylist is optional, but
      // redactArgs still strips secret-shaped keys (api_key/token/password/...) at
      // every depth.
      const datasets = store.list().map((r) => ({
        ref: r.ref, rows: r.rows, bytes: r.bytes,
        ageSeconds: Math.round((Date.now() - Date.parse(r.provenance.createdAt)) / 1000),
        pinned: r.pinned, implicit: r.implicit,
        provenance: { ...r.provenance, args: redactArgs(r.provenance.args, false) },
      }));
      return { content: [{ type: 'text', text: JSON.stringify(datasets) }] };
    }

    if (name === 'loom_query') {
      const sql = String(args?.sql ?? '');
      const inlineOf = (q: { rows: Record<string, unknown>[]; rowCount: number }): CallToolResult => ({
        content: [{ type: 'text', text: JSON.stringify({ rows: q.rows, rowCount: q.rowCount }) }],
      });
      try {
        // Depth-1 hand-off: query on the read lane (produceRead drains it), THEN
        // re-enter intercept once on the write lane. store.handoff owns the
        // drain-before-write ordering and the G3 fallback. On success the reingest
        // product (envelope-or-inline) is what goes upstream.
        return await store.handoff<{ rows: Record<string, unknown>[]; rowCount: number }, CallToolResult>(
          () => store.query(sql),
          async (q) => {
            const outcome = await intercept(inlineOf(q), { server: 'loom', tool: 'query', args: { sql }, reentry: true, depth: 0 }, store, config.tokenThreshold);
            return outcome.intercepted ? envelopeToResult(outcome.envelope) : inlineOf(q);
          },
          (q) => inlineOf(q), // G3: re-entry threw → return the plain query result
        );
      } catch (e) {
        // The query itself failed (guard reject, timeout, engine error) — clean tool error.
        return toolError(`loom_query failed: ${(e as Error).message}`);
      }
    }

    if (name === 'loom_describe') {
      try {
        const d = await store.describe(String(args?.ref ?? ''));
        return { content: [{ type: 'text', text: JSON.stringify(d) }] };
      } catch (e) {
        return toolError(`loom_describe failed: ${(e as Error).message}`);
      }
    }

    if (name === 'loom_export') {
      try {
        const path = await store.exportDataset(String(args?.ref ?? ''), args?.format as 'csv' | 'json', args?.filename as string | undefined, config.exportDir);
        return { content: [{ type: 'text', text: path }] };
      } catch (e) {
        return toolError(`loom_export failed: ${(e as Error).message}`);
      }
    }

    if (name === 'loom_materialize') {
      try {
        const { record, sample } = await store.materialize(String(args?.sql ?? ''), String(args?.name ?? ''));
        const hints = await store.joinHintsFor(record.ref);
        const env = buildEnvelope({ record, sample, hints, context: {}, denylisted: false, approxTokensSaved: 0 });
        return { content: [{ type: 'text', text: JSON.stringify(env) }] };
      } catch (e) {
        return toolError(`loom_materialize failed: ${(e as Error).message}`);
      }
    }

    // Downstream tool → call, then intercept the result (G3 built into intercept).
    // Route is captured BEFORE the await: a reconnect that lands mid-call must not
    // change (or erase) which server/tool this call's provenance attributes to.
    const route = gateway.routeOf(name);
    const result = await gateway.callExposed(name, args);
    if (!route) return result;
    const outcome = await intercept(result, { server: route.server, tool: route.originalName, args }, store, config.tokenThreshold);
    return outcome.intercepted ? envelopeToResult(outcome.envelope) : outcome.result;
  });

  let shutdownOnce: Promise<void> | undefined;
  let shuttingDown = false;
  const handle: LoomHandle = {
    server,
    gateway,
    async start(transport: Transport) {
      await store.init();
      await supervisor.startAll();
      if (shuttingDown) return;
      await server.connect(transport);
      log('info', 'mcp-loom ready');
    },
    async shutdown() {
      shutdownOnce ??= (async () => {
        shuttingDown = true;
        log('info', 'mcp-loom shutting down');
        await supervisor.shutdown();
        try { await server.close(); } catch { /* already closed */ }
        await store.close();
        try { rmSync(spillDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      })();
      return shutdownOnce;
    },
  };
  return handle;
}

export function installShutdownHandlers(handle: LoomHandle): void {
  const go = () => { void handle.shutdown(); };
  process.once('SIGINT', go);
  process.once('SIGTERM', go);
  handle.server.onclose = go;
}
