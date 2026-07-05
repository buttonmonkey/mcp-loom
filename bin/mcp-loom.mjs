#!/usr/bin/env node
// bin/mcp-loom.mjs
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLoomServer, installShutdownHandlers, loadConfig } from '../dist/index.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function argConfig() {
  const i = process.argv.indexOf('--config');
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let handle;
try {
  const config = loadConfig(argConfig());
  handle = createLoomServer(config, version);
  installShutdownHandlers(handle);
  await handle.start(new StdioServerTransport());
} catch (e) {
  process.stderr.write(`mcp-loom failed to start: ${e?.message ?? e}\n`);
  // Tear the supervisor down so pending restart timers / half-started sessions
  // don't keep the event loop alive (or register a server with no upward
  // transport connected). Without this the process lingers instead of draining
  // to exit on a fatal startup.
  await handle?.shutdown();
  process.exitCode = 1;
}
