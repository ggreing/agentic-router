import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERN_SPECS } from '@agentic-router/core';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'hooks', 'secret-patterns.json');

test('plugin/hooks/secret-patterns.json is the current output of core SECRET_PATTERN_SPECS (run scripts/sync-secret-patterns.ts if this fails)', () => {
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  assert.deepEqual(onDisk, SECRET_PATTERN_SPECS);
});

test('every generated pattern compiles as a RegExp', () => {
  for (const p of SECRET_PATTERN_SPECS) assert.doesNotThrow(() => new RegExp(p.source, p.flags));
});
