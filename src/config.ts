import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { LoomConfig } from './types.js';

const serverName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'server name must match ^[a-z][a-z0-9_]{0,31}$')
  .refine((n) => n !== 'loom', 'server name "loom" is reserved for synthetic tools');

const ServerSchema = z.object({
  name: serverName,
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  // Opt-in passthrough of extra non-secret parent-env vars (default-deny; §8).
  envPassthrough: z.array(z.string()).default([]),
  // Original tool names whose provenance.args are omitted from egress (§5 rule 7).
  provenanceDenylist: z.array(z.string()).default([]),
});

const ConfigSchema = z
  .object({
    servers: z.array(ServerSchema).min(1, 'servers must contain at least one entry'),
    tokenThreshold: z.number().int().min(100).default(2000),
    memoryBudgetBytes: z.number().int().min(1_048_576).default(268_435_456),
    duckdbMemoryLimit: z
      .string()
      .regex(/^\d+(\.\d+)?(KB|MB|GB|TB)$/, 'duckdbMemoryLimit must look like "512MB"')
      .default('512MB'),
    exportDir: z.string().default('./exports'),
    queryTimeoutMs: z.number().int().min(1).default(30_000),
    restart: z
      .object({
        maxAttempts: z.number().int().min(0).default(5),
        baseDelayMs: z.number().int().min(1).default(1000),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const s of cfg.servers) {
      if (seen.has(s.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate server name "${s.name}"; names must be unique` });
      }
      seen.add(s.name);
    }
  });

export function parseConfig(raw: unknown): LoomConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid loom.config.json:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function loadConfig(explicitPath?: string): LoomConfig {
  const path = resolve(explicitPath ?? process.env.LOOM_CONFIG ?? './loom.config.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`Could not read config at ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(json);
}
