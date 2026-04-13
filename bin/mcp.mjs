#!/usr/bin/env node
// Thin loader: resolves package root from this file's location (NOT process.cwd()),
// then spawns tsx against src/mcp/server.ts so the bin works from any directory
// after `pnpm link --global`.

import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const tsxBin = path.join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const mcpEntry = path.join(pkgRoot, 'src', 'mcp', 'server.ts');

// stdio: 'inherit' is required for the MCP stdio transport — stdout/stdin are
// the JSON-RPC channel; do not redirect them.
const child = spawn(
  process.execPath,
  [tsxBin, mcpEntry, ...process.argv.slice(2)],
  { stdio: 'inherit' }
);

child.on('exit', (code) => process.exit(code ?? 0));
