// Decision 94: the daemon passes the common scope-glob table (packages/core/test/fixtures/scope-glob-cases.json)
// that the guard also uses. Platform-dependent rows are checked for win32, darwin and linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTECTED_WRITE_PATHS } from '@agentic-router/core';
import { matchScope, matchesAny } from '../src/glob.ts';

type Expect = boolean | Record<'win32' | 'darwin' | 'linux', boolean>;
const table = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../core/test/fixtures/scope-glob-cases.json', import.meta.url)), 'utf8')) as {
  scope: Array<{ pattern: string; path: string; expect: Expect }>;
  protected: Array<{ path: string; expect: boolean }>;
};
const PLATFORMS = ['win32', 'darwin', 'linux'] as const;

test('scope globs: every row of the common table, on every platform', () => {
  assert.ok(table.scope.length >= 20);
  for (const row of table.scope) {
    for (const p of PLATFORMS) {
      const want = typeof row.expect === 'boolean' ? row.expect : row.expect[p];
      assert.equal(matchScope(row.path, row.pattern, p), want, `${p}: ${JSON.stringify(row.pattern)} vs ${JSON.stringify(row.path)}`);
    }
  }
});

test('protected paths: every row of the common table, case-insensitive everywhere', () => {
  assert.ok(table.protected.length >= 14);
  for (const row of table.protected) {
    assert.equal(matchesAny(row.path, PROTECTED_WRITE_PATHS), row.expect, JSON.stringify(row.path));
    assert.equal(matchesAny(row.path.toUpperCase(), PROTECTED_WRITE_PATHS), row.expect, `upper-cased ${JSON.stringify(row.path)}`);
  }
});
