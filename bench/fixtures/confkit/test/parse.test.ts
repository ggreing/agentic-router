import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseIni } from '../src/index.ts';

test('parseIni reads sections, comments and coerces values', () => {
  const text = [
    '# service config',
    'name = api',
    'debug = false',
    '',
    '[db]',
    'host = "db.local"',
    'port = 5432',
    '; replica settings',
    '[db.replica]',
    "host = 'replica.local'",
    'lag = 1.5',
  ].join('\n');
  assert.deepEqual(parseIni(text), {
    name: 'api',
    debug: false,
    db: { host: 'db.local', port: 5432, replica: { host: 'replica.local', lag: 1.5 } },
  });
});

test('quoted values stay strings', () => {
  assert.deepEqual(parseIni('version = "2"\nflag = "true"'), { version: '2', flag: 'true' });
});

test('parseIni reports the line of a syntax error', () => {
  assert.throws(() => parseIni('a = 1\noops\n'), (err: unknown) => err instanceof ConfigError && err.line === 2);
});
