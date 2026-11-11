import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/index.ts';

test('loadConfig layers defaults, INI sources and env', () => {
  const config = loadConfig({
    defaults: { port: 3000, db: { host: 'localhost', port: 5432 }, debug: false },
    sources: ['[db]\nhost = "db.internal"\n', 'debug = true\n'],
    env: { SVC_PORT: '9000', APP_PORT: 'ignored' },
    envPrefix: 'SVC_',
  });
  assert.deepEqual(config, { port: '9000', db: { host: 'db.internal', port: 5432 }, debug: true });
});

test('loadConfig with no options is empty', () => {
  assert.deepEqual(loadConfig(), {});
});
