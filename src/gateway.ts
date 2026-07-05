import { createHash } from 'node:crypto';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ExposedTool, ToolRoute, ServerConfig, SessionStatus } from './types.js';
import { log } from './log.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_NAME = 64;

export function sanitizeToolPart(tool: string): string {
  return tool.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Deterministic namespaced name. Collision resolution is disambiguateName's job. */
export function exposedNameFor(server: string, tool: string): string {
  const joined = `${server}_${sanitizeToolPart(tool)}`;
  if (joined.length <= MAX_NAME) return joined;
  const hash = createHash('sha256').update(`${server}_${tool}`).digest('hex').slice(0, 8);
  // room for: server + "_" + <trunc> + "_" + hash(8)
  const room = MAX_NAME - server.length - 1 - 1 - 8;
  const trunc = sanitizeToolPart(tool).slice(0, Math.max(0, room));
  return `${server}_${trunc}_${hash}`;
}

/** Collision-suffix rule (SPEC §4.1) as a pure, directly-testable function. */
export function disambiguateName(base: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(base)) return base;
  let n = 2;
  while (isTaken(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export class NameMap {
  private readonly byExposed = new Map<string, ExposedTool>();

  addServerTools(server: string, tools: Tool[]): void {
    for (const t of tools) {
      const base = exposedNameFor(server, t.name);
      const name = disambiguateName(base, (n) => this.byExposed.has(n));
      if (name !== base) {
        log('warn', `tool name collision for exposed "${base}"; using "${name}"`, { server, tool: t.name });
      }
      const route: ToolRoute = { server, originalName: t.name };
      // Drop the downstream outputSchema: loom may replace any result with a
      // loom_dataset_ref envelope on interception (SPEC §5), which cannot satisfy
      // the downstream's declared output shape. Re-advertising a schema loom will
      // violate makes strict clients reject intercepted results (-32600). Input
      // schema and everything else are preserved verbatim.
      const { outputSchema: _dropped, ...rest } = t;
      this.byExposed.set(name, { exposedName: name, route, tool: { ...rest, name } });
    }
  }

  removeServer(server: string): void {
    for (const [name, e] of this.byExposed) {
      if (e.route.server === server) this.byExposed.delete(name);
    }
  }

  list(): ExposedTool[] {
    return [...this.byExposed.values()];
  }

  route(exposedName: string): ToolRoute | undefined {
    return this.byExposed.get(exposedName)?.route;
  }
}

export class ClientSession {
  readonly name: string;
  status: SessionStatus = 'init';
  tools: Tool[] = [];
  private client?: Client;
  private transport?: StdioClientTransport;
  private closing = false;
  private started = false;

  constructor(private readonly cfg: ServerConfig, private readonly onExit: (server: string) => void) {
    this.name = cfg.name;
  }

  get pid(): number | undefined {
    return this.transport?.pid ?? undefined;
  }

  async start(): Promise<void> {
    this.closing = false;
    this.started = false;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    Object.assign(env, this.cfg.env); // per-server overlay (SPEC §8)

    const transport = new StdioClientTransport({ command: this.cfg.command, args: this.cfg.args, env });
    const client = new Client({ name: 'mcp-loom', version: '0.0.0' }, { capabilities: {} });
    // Retain refs BEFORE the handshake: connect() spawns the child, so if the
    // handshake rejects we must still be able to close()/kill it — otherwise the
    // spawned child is orphaned, invisible to pid()/shutdown() (SPEC §8, no orphans).
    this.transport = transport;
    this.client = client;
    client.onclose = () => {
      // Only a disconnect of a *ready* session is an unexpected exit. A close
      // during the handshake (started === false) is owned by start()'s catch; a
      // deliberate close() sets closing. Neither should fire onExit — otherwise a
      // failed start both rejects AND schedules a restart via onExit (double-fire).
      if (this.closing || !this.started) return;
      this.status = 'unavailable';
      log('warn', `downstream "${this.name}" disconnected`);
      this.onExit(this.name);
    };
    try {
      await client.connect(transport); // performs the initialize handshake
      const listed = await client.listTools();
      this.tools = listed.tools;
    } catch (e) {
      // Handshake failed: reap the spawned child so it cannot linger, then surface
      // the failure to the supervisor (which schedules a restart).
      this.closing = true;
      try { await client.close(); } catch { /* already gone */ }
      this.status = 'unavailable';
      throw e;
    }
    this.started = true;
    this.status = 'ready';
    log('info', `downstream "${this.name}" ready`, { tools: this.tools.length, pid: this.pid });
  }

  async callTool(originalName: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    // Gate on `started`, not merely `client`: the client is now assigned before the
    // handshake completes, so `started` is what distinguishes a ready session.
    if (!this.started || !this.client) throw new Error(`session ${this.name} not started`);
    return (await this.client.callTool({ name: originalName, arguments: args ?? {} })) as CallToolResult;
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.client?.close();
    } catch {
      /* already gone */
    }
  }
}

export class DownstreamGateway {
  private readonly sessions = new Map<string, ClientSession>();
  private nameMap = new NameMap();

  private rebuild(): void {
    const map = new NameMap();
    for (const s of this.sessions.values()) {
      if (s.status === 'ready') map.addServerTools(s.name, s.tools);
    }
    this.nameMap = map;
  }

  setSession(session: ClientSession): void {
    this.sessions.set(session.name, session);
    this.rebuild();
  }

  markUnavailable(server: string): void {
    const s = this.sessions.get(server);
    if (s) s.status = 'unavailable';
    this.rebuild();
  }

  delist(server: string): void {
    this.sessions.delete(server);
    this.rebuild();
  }

  getSession(server: string): ClientSession | undefined {
    return this.sessions.get(server);
  }

  listExposedTools(): Tool[] {
    return this.nameMap.list().map((e) => e.tool);
  }

  routeOf(exposedName: string): ToolRoute | undefined {
    return this.nameMap.route(exposedName);
  }

  async callExposed(exposedName: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const route = this.nameMap.route(exposedName);
    if (!route) return errorResult(`Unknown tool "${exposedName}".`);
    const session = this.sessions.get(route.server);
    if (!session || session.status !== 'ready') {
      return errorResult(`Downstream server "${route.server}" is currently unavailable.`);
    }
    try {
      return await session.callTool(route.originalName, args); // pass-through, unchanged
    } catch (e) {
      // Child can die mid-call (crash-drill race): the rejection must NOT reach
      // the upward client as a protocol error. Convert to a clean isError (G3).
      return errorResult(`Downstream server "${route.server}" failed mid-call: ${(e as Error).message}`);
    }
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
