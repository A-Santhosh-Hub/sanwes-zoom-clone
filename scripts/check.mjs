#!/usr/bin/env node
// Quick health check of the source code: every JavaScript file must at least parse. Used by the GitHub Actions workflow (npm run check).
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'bin', 'data', 'uploads', '.git', 'stage', 'public']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else if (/\.(m?js)$/.test(name)) files.push(p);
  }
})(ROOT);

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`FAIL  ${path.relative(ROOT, f)}\n${r.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} JavaScript files parse`);
process.exit(bad ? 1 : 0);
