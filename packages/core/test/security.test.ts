import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTED_WRITE_PATHS, redact, scopeKey } from '@do-it-all-claude-code/core';

test('redact masks the credential forms found in review #6', () => {
  const samples = [
    'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ="',
    '{"authorization":"Token abcdefghijklmnop1234"}',
    '{"x-api-key": "abcd1234efgh5678ijkl"}',
    'ANTHROPIC_AUTH_TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2ln',
    'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'aws AKIAIOSFODNN7EXAMPLE',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2ln',
    'key sk-ant-api03-abcdefghijklmnop',
  ];
  const secrets = ['dXNlcjpwYXNzd29yZDEyMzQ', 'abcdefghijklmnop1234', 'abcd1234efgh5678ijkl', 'c2lnbmF0dXJlc2ln', 'QRSTUVWXYZ0123456789', 'AKIAIOSFODNN7EXAMPLE', 'api03-abcdefghijklmnop'];
  const out = samples.map(s => redact(s)).join('\n');
  for (const s of secrets) assert.ok(!out.includes(s), `leaked ${s}\n${out}`);
  assert.equal(redact('npm test passed in 3.2s'), 'npm test passed in 3.2s');
});

test('scopeKey has no separator collisions and stays file-name safe (review #15)', () => {
  assert.notEqual(scopeKey('a__b', 'c'), scopeKey('a', 'b__c'));
  assert.notEqual(scopeKey('s', 'a/b'), scopeKey('s', 'a_b'));
  const k = scopeKey('x'.repeat(200), '../../etc');
  assert.match(k, /^[A-Za-z0-9_.-]+$/);
  assert.ok(k.length <= 40 + 2 + 40 + 2 + 10);
  assert.ok(!k.includes('/'));
});

test('.git internals are protected (review #3)', () => {
  assert.ok(PROTECTED_WRITE_PATHS.includes('.git/**') && PROTECTED_WRITE_PATHS.includes('**/.git/**'));
});

test('environment-dependent credential paths (env audit #8)', async () => {
  const { envCredentialPaths } = await import('@do-it-all-claude-code/core');
  const p = envCredentialPaths({ CLAUDE_CONFIG_DIR: String.raw`D:\cc`, APPDATA: String.raw`C:\Users\u\AppData\Roaming`, HOME: 'H:/' });
  assert.ok(p.includes('D:/cc/**'));
  assert.ok(p.includes('C:/Users/u/AppData/Roaming/gcloud/**'));
  assert.ok(p.some(x => x === 'H:/.ssh/**'));
  assert.deepEqual(envCredentialPaths({ CLAUDE_CONFIG_DIR: 'relative/dir', HOME: '' }), []);
});

test('a relative DO_IT_ALL_CLAUDE_CODE_HOME is ignored (env audit #7)', async () => {
  const { routerHome } = await import('@do-it-all-claude-code/core');
  const prev = process.env.DO_IT_ALL_CLAUDE_CODE_HOME;
  try {
    process.env.DO_IT_ALL_CLAUDE_CODE_HOME = 'rel/home';
    assert.ok(routerHome().endsWith('.do-it-all-claude-code'));
  } finally { if (prev === undefined) delete process.env.DO_IT_ALL_CLAUDE_CODE_HOME; else process.env.DO_IT_ALL_CLAUDE_CODE_HOME = prev; }
});
