import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Decision 102 / audit #D6: the plugin ships dependency-free .mjs/.json that hooks run directly;
// a CRLF in them (e.g. a shebang line) breaks `#!/usr/bin/env node` on POSIX. Keep them LF.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dirs = ['plugin', 'packages/adapter-claude-code/src', 'packages/adapter-claude-code/test'];
const exts = new Set(['.mjs', '.json', '.md', '.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

test('plugin and adapter source files use LF line endings (no CRLF)', () => {
  const offenders: string[] = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) if (fs.readFileSync(f, 'utf8').includes('\r')) offenders.push(path.relative(root, f));
  }
  assert.deepEqual(offenders, [], `these files contain CRLF: ${offenders.join(', ')}`);
});
