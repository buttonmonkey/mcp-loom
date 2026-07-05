import { ClientSession, DownstreamGateway } from './gateway.js';
import type { LoomConfig, ServerConfig } from './types.js';
import { log } from './log.js';

const BACKOFF_CAP_MS = 30_000;
const KILL_GRACE_MS = 3_000;

export class Supervisor {
  private readonly sessions = new Map<string, ClientSession>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private shuttingDown = false;

  constructor(
    private readonly config: LoomConfig,
    private readonly gateway: DownstreamGateway,
    private readonly onToolsChanged: () => void,
  ) {}

  async startAll(): Promise<void> {
    let connected = 0;
    for (const cfg of this.config.servers) {
      const ok = await this.tryStart(cfg, 0); // attempt 0 = initial connect (not a retry)
      if (ok) connected++;
    }
    if (connected === 0) throw new Error('No downstream servers connected — refusing to start.');
  }

  private makeSession(cfg: ServerConfig): ClientSession {
    return new ClientSession(cfg, (server) => this.handleExit(server));
  }

  /**
   * Start one server; on failure schedule a restart. Returns true if it became ready.
   * `attempt` is the restart-attempt number: 0 = the initial connect (not a retry),
   * so the first restart from any trigger is attempt 1 (delay = baseDelayMs).
   */
  private async tryStart(cfg: ServerConfig, attempt: number): Promise<boolean> {
    if (this.shuttingDown) return false;
    const session = this.makeSession(cfg);
    this.sessions.set(cfg.name, session);
    try {
      await session.start();
      if (this.shuttingDown) {
        // Shutdown began while this (re)start was in flight — do not register the
        // session or fire callbacks after shutdown; reap the freshly-started child.
        void session.close();
        return false;
      }
      this.gateway.setSession(session);
      this.onToolsChanged();
      return true;
    } catch (e) {
      const which = attempt === 0 ? 'initial connect' : `restart attempt ${attempt}`;
      log('warn', `downstream "${cfg.name}" failed ${which}`, (e as Error).message);
      this.scheduleRestart(cfg, attempt + 1);
      return false;
    }
  }

  private handleExit(server: string): void {
    if (this.shuttingDown) return;
    this.gateway.markUnavailable(server);
    this.onToolsChanged();
    const cfg = this.config.servers.find((s) => s.name === server);
    if (cfg) this.scheduleRestart(cfg, 1);
  }

  private scheduleRestart(cfg: ServerConfig, attempt: number): void {
    if (this.shuttingDown) return;
    if (attempt > this.config.restart.maxAttempts) {
      log('error', `downstream "${cfg.name}" exhausted ${this.config.restart.maxAttempts} restart attempts — delisting`);
      const session = this.sessions.get(cfg.name);
      if (session) void session.close(); // defensively reap any lingering child before dropping the ref
      this.sessions.delete(cfg.name);
      this.gateway.delist(cfg.name);
      this.onToolsChanged();
      return;
    }
    const delay = Math.min(this.config.restart.baseDelayMs * 2 ** (attempt - 1), BACKOFF_CAP_MS);
    log('info', `restarting "${cfg.name}" in ${delay}ms (attempt ${attempt})`);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.tryStart(cfg, attempt);
    }, delay);
    this.timers.add(timer);
  }

  pids(): number[] {
    const out: number[] = [];
    for (const s of this.sessions.values()) if (typeof s.pid === 'number') out.push(s.pid);
    return out;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const pids = this.pids();
    await Promise.all([...this.sessions.values()].map((s) => s.close()));

    // Poll child liveness and exit as soon as all are gone. The 3 s grace is a
    // DEADLINE, not a fixed sleep — a clean shutdown (children exit when their
    // stdin closes on client.close()) finishes in ~ms; the grace only costs time
    // when a child misbehaves. SIGKILL any survivor at the deadline.
    const isAlive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const deadline = Date.now() + KILL_GRACE_MS;
    while (Date.now() < deadline && pids.some(isAlive)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const pid of pids) {
      if (!isAlive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        log('warn', `force-killed lingering child pid ${pid}`);
      } catch {
        /* raced to dead */
      }
    }
    this.sessions.clear();
  }
}
