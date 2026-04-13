#!/usr/bin/env node
// Thin loader: resolves package root from this file's location (NOT process.cwd()),
// then spawns tsx against src/cli/index.ts so the bin works from any directory
// after `pnpm link --global`.

import { fileURLToPath } from 'url';
import path from 'path';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const tsxBin = path.join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = path.join(pkgRoot, 'src', 'cli', 'index.ts');

// Inherit cwd so `kb ls` from ~/notes sees paths relative to where the user is.
const child = spawn(
  process.execPath,
  [tsxBin, cliEntry, ...process.argv.slice(2)],
  { stdio: 'inherit' }
);

child.on('exit', (code) => process.exit(code ?? 0));
