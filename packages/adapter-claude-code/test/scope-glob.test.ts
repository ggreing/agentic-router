import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as guard from '../../../plugin/hooks/guard.mjs';

// Decision 94: the guard and the daemon must both pass this shared table.
const tablePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'test', 'fixtures', 'scope-glob-cases.json');
const table = JSON.parse(fs.readFileSync(tablePath, 'utf8')) as {
  scope: Array<{ pattern: string; path: string; expect: boolean | Record<string, boolean> }>;
  protected: Array<{ path: string; expect: boolean }>;
};

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
function expected(e: boolean | Record<string, boolean>, platform: string): boolean {
  return typeof e === 'boolean' ? e : !!e[platform];
}

test('scope glob matching passes the shared table on win32, darwin and linux', () => {
  for (const platform of PLATFORMS) {
    for (const c of table.scope) {
      const got = guard.inScope(c.path, [c.pattern], platform);
      assert.equal(got, expected(c.expect, platform),
        `[${platform}] inScope(${JSON.stringify(c.path)}, [${JSON.stringify(c.pattern)}]) => ${got}, want ${expected(c.expect, platform)}`);
    }
  }
});

test('protected-path matching passes the shared table (always case-insensitive, every platform)', () => {
  for (const c of table.protected) {
    const got = guard.isProtectedPath(c.path);
    assert.equal(got, c.expect, `isProtectedPath(${JSON.stringify(c.path)}) => ${got}, want ${c.expect}`);
  }
});

test('scope case sensitivity actually differs by platform (sanity on the table)', () => {
  // src/API/** vs src/api/x.ts: matches on win32/darwin, not on linux
  assert.equal(guard.inScope('src/api/x.ts', ['src/API/**'], 'win32'), true);
  assert.equal(guard.inScope('src/api/x.ts', ['src/API/**'], 'linux'), false);
});
