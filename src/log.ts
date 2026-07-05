export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// stdout is the protocol (SPEC §4) — logging goes to stderr only.
export function log(level: LogLevel, msg: string, ...args: unknown[]): void {
  const extra = args.length
    ? ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    : '';
  process.stderr.write(`[${level}] ${msg}${extra}\n`);
}
