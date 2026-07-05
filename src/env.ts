// src/env.ts
// SPEC §8: downstream child-process environment scoping. Default-deny — the
// launching shell's environment is NOT copied wholesale into every downstream
// server (a compromised `npx -y` package could otherwise read every secret in the
// shell, including ones meant for a different server). Instead, a child gets a
// curated non-secret base plus explicitly opted-in vars, then the per-server
// `env` overlay (the secret channel) last.
//
// Boundary (stated in README/SPEC, not oversold): least-privilege, not zero-leak.
// A passed-through proxy/CA var can still carry a secret, and this closes only the
// *environment* vector — a malicious child can still reach the filesystem/network.
// OS-level per-child isolation is the ceiling and is out of scope for a zero-config
// stdio proxy.

// The minimal non-secret vars a spawn actually needs. Load-bearing, not decoration:
// a bare clean env breaks `npx`/node spawns (no PATH/HOME/locale), and users "fix"
// that by pasting their whole env back — recreating the hole. The base is what keeps
// the secure default usable.
const SAFE_BASE_POSIX = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'];
const SAFE_BASE_WINDOWS = [
  'SystemRoot', 'windir', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'USERPROFILE', 'PROCESSOR_ARCHITECTURE',
];

export const SAFE_BASE: readonly string[] =
  process.platform === 'win32' ? SAFE_BASE_WINDOWS : SAFE_BASE_POSIX;

// Build a downstream child's environment: (SAFE_BASE ∪ passthrough) read from the
// source env, then the per-server `serverEnv` overlay last. Names not in the base
// and not opted into `passthrough` are never forwarded.
export function buildChildEnv(
  serverEnv: Record<string, string>,
  passthrough: string[] | undefined,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...SAFE_BASE, ...(passthrough ?? [])]) {
    const v = source[key];
    if (typeof v === 'string') env[key] = v;
  }
  Object.assign(env, serverEnv); // per-server overlay last (SPEC §8; unchanged)
  return env;
}
