import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as confkit from '../src/index.ts';
import type { ConfigObject } from '../src/index.ts';

type Issue = { path: string; message: string };
type Result = { ok: true; value: ConfigObject } | { ok: false; issues: Issue[] };
// Loose views so the test does not depend on how the new members are typed.
const validateConfig = (config: unknown, schema: unknown): Result =>
  (confkit as unknown as { validateConfig: (c: unknown, s: unknown) => Result }).validateConfig(config, schema);
const loadConfig = (options: Record<string, unknown>): ConfigObject =>
  (confkit.loadConfig as unknown as (o: Record<string, unknown>) => ConfigObject)(options);

const schema = {
  host: { type: 'string', default: 'localhost' },
  port: { type: 'number', integer: true, min: 1, max: 65535, default: 3000 },
  debug: { type: 'boolean', default: false },
  mode: { type: 'string', enum: ['development', 'production'], required: true },
  timeout: { type: 'duration', default: '30s' },
  db: {
    type: 'object',
    properties: {
      url: { type: 'string', required: true },
      pool: { type: 'number', integer: true, min: 1, default: 5 },
    },
  },
};

const byPath = (a: Issue, b: Issue) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function issuesOf(result: Result): Issue[] {
  assert.equal(result.ok, false, 'expected validation to fail');
  return [...(result as { issues: Issue[] }).issues].sort(byPath);
}

function valueOf(result: Result): ConfigObject {
  assert.equal(result.ok, true, `expected validation to pass: ${JSON.stringify(result)}`);
  return (result as { value: ConfigObject }).value;
}

test('coerces strings and fills defaults', () => {
  const value = valueOf(validateConfig(
    { mode: 'production', port: '8080', debug: 'true', timeout: '1m30s', db: { url: 'postgres://x' } },
    schema,
  ));
  assert.deepEqual(value, {
    host: 'localhost',
    port: 8080,
    debug: true,
    mode: 'production',
    timeout: 90_000,
    db: { url: 'postgres://x', pool: 5 },
  });
});

test('duration defaults and numeric durations are milliseconds; native booleans pass', () => {
  const a = valueOf(validateConfig({ mode: 'development', debug: 'false', db: { url: 'u' } }, schema));
  assert.equal(a.timeout, 30_000);
  assert.equal(a.debug, false);
  const b = valueOf(validateConfig({ mode: 'development', timeout: 1500, debug: true, db: { url: 'u' } }, schema));
  assert.equal(b.timeout, 1500);
  assert.equal(b.debug, true);
});

test('optional fields without a default are omitted', () => {
  assert.deepEqual(valueOf(validateConfig({}, { name: { type: 'string' }, retries: { type: 'number' } })), {});
});

test('a missing object is validated as empty so nested defaults apply', () => {
  const cacheSchema = {
    cache: {
      type: 'object',
      properties: { ttl: { type: 'duration', default: '5m' }, enabled: { type: 'boolean', default: true } },
    },
  };
  assert.deepEqual(valueOf(validateConfig({}, cacheSchema)), { cache: { ttl: 300_000, enabled: true } });
  assert.deepEqual(issuesOf(validateConfig({ mode: 'production' }, schema)), [{ path: 'db.url', message: 'is required' }]);
});

test('collects every issue with exact messages', () => {
  const result = validateConfig(
    { port: '70000', debug: 'yes', mode: 'staging', timeout: 'soon', db: { pool: 0.5, extra: 1 }, color: 'red' },
    schema,
  );
  assert.deepEqual(issuesOf(result), [
    { path: 'color', message: 'unknown key' },
    { path: 'db.extra', message: 'unknown key' },
    { path: 'db.pool', message: 'must be an integer' },
    { path: 'db.url', message: 'is required' },
    { path: 'debug', message: 'expected boolean' },
    { path: 'mode', message: 'must be one of: development, production' },
    { path: 'port', message: 'must be <= 65535' },
    { path: 'timeout', message: 'expected duration' },
  ]);
});

test('type mismatches; a non-object is reported once', () => {
  const result = validateConfig({ mode: 'production', host: 42, port: 'abc', db: 'nope' }, schema);
  assert.deepEqual(issuesOf(result), [
    { path: 'db', message: 'expected object' },
    { path: 'host', message: 'expected string' },
    { path: 'port', message: 'expected number' },
  ]);
  assert.deepEqual(issuesOf(validateConfig({ mode: 'production', port: 0, db: { url: 'u' } }, schema)), [
    { path: 'port', message: 'must be >= 1' },
  ]);
  assert.deepEqual(issuesOf(validateConfig({ db: { url: 'u' } }, schema)), [{ path: 'mode', message: 'is required' }]);
});

test('the input object is not modified', () => {
  const input = { mode: 'production', port: '8080', db: { url: 'x' } };
  validateConfig(input, schema);
  assert.deepEqual(input, { mode: 'production', port: '8080', db: { url: 'x' } });
});

test('loadConfig validates and coerces when a schema is given', () => {
  const config = loadConfig({
    defaults: { mode: 'development' },
    sources: ['[db]\nurl = "postgres://local"\n'],
    env: { APP_PORT: '9090', APP_DEBUG: 'true' },
    schema,
  });
  assert.deepEqual(config, {
    host: 'localhost',
    port: 9090,
    debug: true,
    mode: 'development',
    timeout: 30_000,
    db: { url: 'postgres://local', pool: 5 },
  });
});

test('loadConfig throws ConfigError with issues when invalid', () => {
  assert.throws(
    () => loadConfig({ defaults: { mode: 'development' }, env: { APP_PORT: 'eighty' }, schema }),
    (err: unknown) => {
      assert.ok(err instanceof confkit.ConfigError);
      assert.ok(err.message.startsWith('Invalid configuration'), err.message);
      const issues = [...(err as unknown as { issues: Issue[] }).issues].sort(byPath);
      assert.deepEqual(issues, [
        { path: 'db.url', message: 'is required' },
        { path: 'port', message: 'expected number' },
      ]);
      return true;
    },
  );
});

test('loadConfig without a schema is unchanged', () => {
  assert.deepEqual(loadConfig({ defaults: { port: 3000 }, env: { APP_PORT: '9090' } }), { port: '9090' });
});
