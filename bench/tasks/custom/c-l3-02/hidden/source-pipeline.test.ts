import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as confkit from '../src/index.ts';

type Obj = Record<string, unknown>;
type Source = { name: string; load: () => Obj };
type Change = { path: string; before: unknown; after: unknown };
type Config = {
  get(path: string): unknown;
  has(path: string): boolean;
  require(path: string): unknown;
  getString(path: string, fallback?: string): string;
  getNumber(path: string, fallback?: number): number;
  getBoolean(path: string, fallback?: boolean): boolean;
  getDuration(path: string, fallback?: number): number;
  origin(path: string): string | undefined;
  explain(): Array<{ path: string; value: unknown; source: string }>;
  toObject(options?: { redact?: boolean }): Obj;
  reload(): Change[];
  onChange(listener: (changes: Change[]) => void): () => void;
};
type Api = {
  objectSource(name: string, value: Obj | (() => Obj)): Source;
  iniSource(name: string, text: string | (() => string)): Source;
  jsonSource(name: string, text: string | (() => string)): Source;
  envSource(env: Record<string, string | undefined>, prefix?: string, name?: string): Source;
  argvSource(argv: string[], name?: string): Source;
  resolveSources(sources: Source[]): { value: Obj; origins: Record<string, string> };
  interpolate(config: Obj): Obj;
  diffConfig(before: Obj, after: Obj): Change[];
  createConfig(options: { sources: Source[]; interpolate?: boolean; secrets?: string[] }): Config;
  loadConfig(options?: Obj): Obj;
  ConfigError: new (...args: unknown[]) => Error & { path?: string };
};

const api = confkit as unknown as Api;
const { ConfigError } = api;

function need(name: keyof Api): void {
  assert.equal(typeof api[name], 'function', `${name} is exported from src/index.ts`);
}

/** Asserts a ConfigError; optionally its path and a fragment of its message. */
function throwsConfigError(fn: () => unknown, path?: string, fragment?: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
    if (path !== undefined) assert.equal(err.path, path);
    if (fragment) assert.match(err.message, fragment);
    return true;
  });
}

test('objectSource, iniSource and envSource wrap the existing loaders', () => {
  for (const name of ['objectSource', 'iniSource', 'envSource'] as const) need(name);
  const defaults = { port: 3000, db: { host: 'localhost' }, tags: ['a', 'b'] };
  const object = api.objectSource('defaults', defaults);
  assert.equal(object.name, 'defaults');
  const loaded = object.load();
  assert.deepEqual(loaded, defaults);
  // a copy: changing what was loaded does not reach the original
  (loaded.db as Obj).host = 'changed';
  (loaded.tags as string[]).push('c');
  assert.deepEqual(defaults, { port: 3000, db: { host: 'localhost' }, tags: ['a', 'b'] });

  const ini = api.iniSource('file', 'debug = true\n[db]\nport = 5432\nname = "7"\n');
  assert.equal(ini.name, 'file');
  assert.deepEqual(ini.load(), { debug: true, db: { port: 5432, name: '7' } });

  const env = api.envSource({ SVC_DB__HOST: 'db', SVC_PORT: '80', APP_PORT: '1' }, 'SVC_');
  assert.equal(env.name, 'env');
  assert.deepEqual(env.load(), { db: { host: 'db' }, port: '80' });
  assert.deepEqual(api.envSource({ APP_PORT: '1', OTHER: 'x' }).load(), { port: '1' });
  assert.equal(api.envSource({}, 'APP_', 'process').name, 'process');
});

test('a source given a function reads it again on every load', () => {
  let text = 'level = 1\n';
  const ini = api.iniSource('file', () => text);
  assert.deepEqual(ini.load(), { level: 1 });
  text = 'level = 2\n';
  assert.deepEqual(ini.load(), { level: 2 });

  let json = '{"a": 1}';
  const source = api.jsonSource('j', () => json);
  assert.deepEqual(source.load(), { a: 1 });
  json = '{"a": 2}';
  assert.deepEqual(source.load(), { a: 2 });

  let value: Obj = { n: 1 };
  const object = api.objectSource('o', () => value);
  assert.deepEqual(object.load(), { n: 1 });
  value = { n: 2 };
  assert.deepEqual(object.load(), { n: 2 });
});

test('jsonSource parses a JSON object and rejects everything else when it loads', () => {
  need('jsonSource');
  const source = api.jsonSource('settings', '{"port": 8080, "db": {"host": "h", "replicas": ["a", "b"]}, "flag": null}');
  assert.equal(source.name, 'settings');
  assert.deepEqual(source.load(), { port: 8080, db: { host: 'h', replicas: ['a', 'b'] }, flag: null });

  // building the source does not parse; loading does
  const broken = api.jsonSource('broken', '{"port": ');
  throwsConfigError(() => broken.load(), undefined, /broken/);
  throwsConfigError(() => api.jsonSource('list', '[1, 2]').load());
  throwsConfigError(() => api.jsonSource('scalar', '42').load());
  throwsConfigError(() => api.jsonSource('nothing', 'null').load());
});

test('argvSource reads --key=value, --key value, flags and --no- flags', () => {
  need('argvSource');
  const source = api.argvSource([
    'serve',
    '--port', '8080',
    '--db.host=db.internal',
    '--db.replica.lag=1.5',
    '--debug',
    '--no-cache.enabled',
    '--name=',
    '--version="2"',
    '--offset', '-5',
    '--mode', 'fast',
    '--verbose',
    '--',
    '--ignored=1',
  ]);
  assert.equal(source.name, 'argv');
  assert.deepEqual(source.load(), {
    port: 8080,
    db: { host: 'db.internal', replica: { lag: 1.5 } },
    debug: true,
    cache: { enabled: false },
    name: '',
    version: '2',
    offset: -5,
    mode: 'fast',
    verbose: true,
  });
  assert.deepEqual(api.argvSource([]).load(), {});
  assert.deepEqual(api.argvSource(['--a=true', '--b=false', '--c=x=y']).load(), { a: true, b: false, c: 'x=y' });
  // --no-x never takes a value, and a flag followed by another option is true
  assert.deepEqual(api.argvSource(['--no-color', 'always', '--quiet', '--level', '3']).load(), { color: false, quiet: true, level: 3 });
  assert.equal(api.argvSource(['--x=1'], 'cli').name, 'cli');
});

test('resolveSources merges in order and records where every leaf came from', () => {
  need('resolveSources');
  const { value, origins } = api.resolveSources([
    api.objectSource('defaults', { port: 3000, db: { host: 'localhost', port: 5432 }, tags: ['a'], log: { level: 'info' } }),
    api.iniSource('file', 'debug = true\n[db]\nhost = "db.internal"\n'),
    api.envSource({ APP_PORT: '9000' }),
    api.argvSource(['--log.level=debug']),
  ]);
  assert.deepEqual(value, {
    port: '9000',
    db: { host: 'db.internal', port: 5432 },
    tags: ['a'],
    log: { level: 'debug' },
    debug: true,
  });
  assert.deepEqual(origins, {
    port: 'env',
    'db.host': 'file',
    'db.port': 'defaults',
    tags: 'defaults',
    'log.level': 'argv',
    debug: 'file',
  });
  assert.deepEqual(api.resolveSources([]), { value: {}, origins: {} });
});

test('resolveSources: replacing an object or a scalar replaces its origins too', () => {
  const objectToScalar = api.resolveSources([
    api.objectSource('a', { cache: { ttl: 5, size: 10 }, keep: 1 }),
    api.objectSource('b', { cache: false }),
  ]);
  assert.deepEqual(objectToScalar.value, { cache: false, keep: 1 });
  assert.deepEqual(objectToScalar.origins, { cache: 'b', keep: 'a' });

  const scalarToObject = api.resolveSources([
    api.objectSource('a', { cache: false }),
    api.objectSource('b', { cache: { ttl: 5 } }),
    api.objectSource('c', { cache: { size: 10 } }),
  ]);
  assert.deepEqual(scalarToObject.value, { cache: { ttl: 5, size: 10 } });
  assert.deepEqual(scalarToObject.origins, { 'cache.ttl': 'b', 'cache.size': 'c' });

  // arrays are replaced as a whole
  const arrays = api.resolveSources([
    api.objectSource('a', { hosts: ['x', 'y'] }),
    api.objectSource('b', { hosts: ['z'] }),
  ]);
  assert.deepEqual(arrays.value, { hosts: ['z'] });
  assert.deepEqual(arrays.origins, { hosts: 'b' });

  throwsConfigError(() => api.resolveSources([api.objectSource('same', {}), api.objectSource('same', {})]), undefined, /same/);
});

test('interpolate replaces ${path} references', () => {
  need('interpolate');
  const input = {
    host: 'example.com',
    port: 8080,
    secure: true,
    url: 'http://${host}:${port}/api',
    samePort: '${port}',
    sameFlag: '${ secure }',
    db: { name: 'app', dsn: 'pg://${host}/${db.name}', alias: '${db.dsn}?ssl=${secure}' },
    list: ['${host}', 'plain', 7, '${port}'],
    literal: 'cost: $${port} or $${host}',
    untouched: 'no references here $ { }',
  };
  const snapshot = structuredClone(input);
  const out = api.interpolate(input);
  assert.deepEqual(out, {
    host: 'example.com',
    port: 8080,
    secure: true,
    url: 'http://example.com:8080/api',
    samePort: 8080,
    sameFlag: true,
    db: { name: 'app', dsn: 'pg://example.com/app', alias: 'pg://example.com/app?ssl=true' },
    list: ['example.com', 'plain', 7, 8080],
    literal: 'cost: ${port} or ${host}',
    untouched: 'no references here $ { }',
  });
  assert.deepEqual(input, snapshot, 'the input is not modified');
  assert.notEqual(out, input);
});

test('interpolate reports unknown, circular and non-scalar references', () => {
  throwsConfigError(() => api.interpolate({ a: { b: 'x ${missing.key} y' } }), 'a.b', /unknown reference/);
  throwsConfigError(() => api.interpolate({ a: '${b}', b: '${c}', c: '${a}' }), undefined, /circular reference/);
  throwsConfigError(() => api.interpolate({ self: 'again ${self}' }), 'self', /circular reference/);
  throwsConfigError(() => api.interpolate({ db: { host: 'h' }, bad: '${db}' }), 'bad');
  throwsConfigError(() => api.interpolate({ hosts: ['a'], bad: 'to ${hosts}' }), 'bad');
  throwsConfigError(() => api.interpolate({ nothing: null, bad: '${nothing}' }), 'bad');
  // a chain that ends is fine
  assert.deepEqual(api.interpolate({ a: '${b}', b: '${c}!', c: 1 }), { a: '1!', b: '1!', c: 1 });
});

test('diffConfig lists added, removed and changed leaves', () => {
  need('diffConfig');
  const before = { alpha: 1, beta: { x: 'same', y: 'old' }, gamma: ['a', 'b'], delta: ['a'], gone: true, shape: 1 };
  const after = { alpha: 2, beta: { x: 'same', y: 'new', z: 0 }, gamma: ['a', 'b'], delta: ['a', 'b'], shape: { inner: 1 } };
  const changes = api.diffConfig(before, after);
  const byPath = Object.fromEntries(changes.map((c) => [c.path, [c.before, c.after]]));
  assert.deepEqual(byPath, {
    alpha: [1, 2],
    'beta.y': ['old', 'new'],
    'beta.z': [undefined, 0],
    delta: [['a'], ['a', 'b']],
    gone: [true, undefined],
    shape: [1, undefined],
    'shape.inner': [undefined, 1],
  });
  assert.equal(changes.length, 7);
  assert.deepEqual(api.diffConfig(before, structuredClone(before)), []);
  // sorted by path
  const sorted = api.diffConfig({}, { cherry: 1, apple: 1, banana: 1 });
  assert.deepEqual(sorted.map((c) => c.path), ['apple', 'banana', 'cherry']);
});

function sample(extra: { secrets?: string[]; interpolate?: boolean } = {}) {
  return api.createConfig({
    sources: [
      api.objectSource('defaults', {
        port: 3000,
        host: 'localhost',
        url: 'http://${host}:${port}',
        db: { password: 'hunter2', pool: 5 },
        timeout: '1m30s',
        retries: '3',
        debug: 'false',
        tags: ['a', 'b'],
      }),
      api.iniSource('file', 'verbose = true\nratio = 0.5\n[db]\npool = 10\n[api]\ntoken = "t0k3n"\nkey = "k3y"\n'),
      api.envSource({ APP_PORT: '9000' }),
    ],
    ...extra,
  });
}

test('createConfig: get, has, require and origin', () => {
  need('createConfig');
  const config = sample();
  assert.equal(config.get('port'), '9000');
  assert.equal(config.get('url'), 'http://localhost:9000');
  assert.deepEqual(config.get('db'), { password: 'hunter2', pool: 10 });
  assert.deepEqual(config.get('tags'), ['a', 'b']);
  assert.equal(config.get('db.missing'), undefined);
  assert.equal(config.has('db.pool'), true);
  assert.equal(config.has('db'), true);
  assert.equal(config.has('nope'), false);
  assert.equal(config.require('api.token'), 't0k3n');
  throwsConfigError(() => config.require('nope.deeper'), 'nope.deeper', /missing required config/);

  assert.equal(config.origin('port'), 'env');
  assert.equal(config.origin('db.pool'), 'file');
  assert.equal(config.origin('db.password'), 'defaults');
  assert.equal(config.origin('url'), 'defaults');
  assert.equal(config.origin('db'), undefined);
  assert.equal(config.origin('nope'), undefined);

  // interpolation can be switched off
  assert.equal(sample({ interpolate: false }).get('url'), 'http://${host}:${port}');
});

test('createConfig: typed getters convert, fall back and complain', () => {
  const config = sample();
  assert.equal(config.getString('host'), 'localhost');
  assert.equal(config.getString('nope', 'fallback'), 'fallback');
  assert.equal(config.getString('nope', ''), '');
  throwsConfigError(() => config.getString('nope'), 'nope', /missing required config/);
  throwsConfigError(() => config.getString('db.pool'), 'db.pool', /expected string/);
  throwsConfigError(() => config.getString('db'), 'db', /expected string/);

  assert.equal(config.getNumber('db.pool'), 10);
  assert.equal(config.getNumber('port'), 9000);
  assert.equal(config.getNumber('retries'), 3);
  assert.equal(config.getNumber('ratio'), 0.5);
  assert.equal(config.getNumber('nope', 0), 0);
  throwsConfigError(() => config.getNumber('host'), 'host', /expected number/);
  throwsConfigError(() => config.getNumber('verbose'), 'verbose', /expected number/);
  throwsConfigError(() => config.getNumber('nope'), 'nope', /missing required config/);

  assert.equal(config.getBoolean('verbose'), true);
  assert.equal(config.getBoolean('debug'), false);
  assert.equal(config.getBoolean('nope', false), false);
  assert.equal(config.getBoolean('nope', true), true);
  throwsConfigError(() => config.getBoolean('host'), 'host', /expected boolean/);
  throwsConfigError(() => config.getBoolean('retries'), 'retries', /expected boolean/);

  assert.equal(config.getDuration('timeout'), 90_000);
  assert.equal(config.getDuration('db.pool'), 10);
  assert.equal(config.getDuration('nope', 250), 250);
  throwsConfigError(() => config.getDuration('host'), 'host', /expected duration/);
  throwsConfigError(() => config.getDuration('tags'), 'tags', /expected duration/);
  // the fallback is only for a missing value, never for a wrong one
  throwsConfigError(() => config.getNumber('host', 1), 'host', /expected number/);
});

test('createConfig: toObject, explain and secrets', () => {
  const config = sample({ secrets: ['db.password', 'api.*'] });
  const plain = config.toObject();
  assert.deepEqual(plain, {
    port: '9000',
    host: 'localhost',
    url: 'http://localhost:9000',
    db: { password: 'hunter2', pool: 10 },
    timeout: '1m30s',
    retries: '3',
    debug: 'false',
    tags: ['a', 'b'],
    verbose: true,
    ratio: 0.5,
    api: { token: 't0k3n', key: 'k3y' },
  });
  // a copy: changing it does not change the config
  (plain.db as Obj).pool = 99;
  (plain.tags as string[]).push('c');
  assert.equal(config.get('db.pool'), 10);
  assert.deepEqual(config.get('tags'), ['a', 'b']);

  const redacted = config.toObject({ redact: true });
  assert.deepEqual(redacted.db, { password: '***', pool: 10 });
  assert.deepEqual(redacted.api, { token: '***', key: '***' });
  assert.equal(redacted.port, '9000');
  // reading a secret directly still gives the real value
  assert.equal(config.get('db.password'), 'hunter2');
  assert.equal(config.getString('api.token'), 't0k3n');

  const explained = config.explain();
  const paths = explained.map((e) => e.path);
  assert.deepEqual([...paths].sort(), [
    'api.key', 'api.token', 'db.password', 'db.pool', 'debug', 'host', 'port', 'ratio', 'retries', 'tags', 'timeout', 'url', 'verbose',
  ]);
  const at = (path: string) => explained.find((e) => e.path === path);
  assert.deepEqual(at('port'), { path: 'port', value: '9000', source: 'env' });
  assert.deepEqual(at('db.pool'), { path: 'db.pool', value: 10, source: 'file' });
  assert.deepEqual(at('url'), { path: 'url', value: 'http://localhost:9000', source: 'defaults' });
  assert.deepEqual(at('tags'), { path: 'tags', value: ['a', 'b'], source: 'defaults' });
  assert.deepEqual(at('db.password'), { path: 'db.password', value: '***', source: 'defaults' });
  assert.deepEqual(at('api.token'), { path: 'api.token', value: '***', source: 'file' });

  // without secrets nothing is masked, with or without redact
  assert.deepEqual(sample().toObject({ redact: true }), sample().toObject());
});

test('secret patterns: * is one segment, and a secret object hides everything below it', () => {
  const config = api.createConfig({
    sources: [api.objectSource('o', {
      token: 'top',
      service: { token: 'one', nested: { token: 'deep' }, name: 'svc' },
      vault: { a: 1, inner: { b: 2 } },
      open: 'visible',
    })],
    secrets: ['*.token', 'vault'],
  });
  assert.deepEqual(config.toObject({ redact: true }), {
    token: 'top',
    service: { token: '***', nested: { token: 'deep' }, name: 'svc' },
    vault: '***',
    open: 'visible',
  });
  const explained = Object.fromEntries(config.explain().map((e) => [e.path, e.value]));
  assert.deepEqual(explained, {
    token: 'top',
    'service.token': '***',
    'service.nested.token': 'deep',
    'service.name': 'svc',
    'vault.a': '***',
    'vault.inner.b': '***',
    open: 'visible',
  });
});

test('explain is sorted by path', () => {
  const config = api.createConfig({ sources: [api.objectSource('o', { cherry: 1, apple: { zeta: 1, alpha: 2 }, banana: 3 })] });
  assert.deepEqual(config.explain().map((e) => e.path), ['apple.alpha', 'apple.zeta', 'banana', 'cherry']);
});

test('reload re-reads the sources, reports the changes and tells the listeners', () => {
  let text = 'level = "info"\nworkers = 2\n[db]\nhost = "a"\n';
  const env: Record<string, string | undefined> = {};
  const config = api.createConfig({
    sources: [
      api.objectSource('defaults', { greeting: 'hi ${db.host}', stable: [1, 2] }),
      api.iniSource('file', () => text),
      api.envSource(env),
    ],
  });
  const seen: Change[][] = [];
  const other: Change[][] = [];
  const unsubscribe = config.onChange((changes) => seen.push(changes));
  config.onChange((changes) => other.push(changes));
  assert.equal(typeof unsubscribe, 'function');

  // nothing changed: no changes, no notification
  assert.deepEqual(config.reload(), []);
  assert.equal(seen.length, 0);

  text = 'level = "debug"\n[db]\nhost = "b"\nport = 5432\n';
  env.APP_WORKERS = '8';
  const changes = config.reload();
  assert.deepEqual(changes, [
    { path: 'db.host', before: 'a', after: 'b' },
    { path: 'db.port', before: undefined, after: 5432 },
    { path: 'greeting', before: 'hi a', after: 'hi b' },
    { path: 'level', before: 'info', after: 'debug' },
    { path: 'workers', before: 2, after: '8' },
  ]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], changes);
  assert.equal(other.length, 1);
  assert.equal(config.get('db.host'), 'b');
  assert.equal(config.get('greeting'), 'hi b');
  assert.equal(config.origin('workers'), 'env');
  assert.equal(config.origin('db.port'), 'file');

  // a removed key is reported with after undefined
  delete env.APP_WORKERS;
  unsubscribe();
  assert.deepEqual(config.reload(), [{ path: 'workers', before: '8', after: undefined }]);
  assert.equal(seen.length, 1, 'an unsubscribed listener is not called');
  assert.equal(other.length, 2);
  assert.equal(config.has('workers'), false);
});

test('a failing reload keeps the previous configuration', () => {
  let text = 'name = "one"\nref = "${name}"\n';
  const config = api.createConfig({ sources: [api.iniSource('file', () => text)] });
  let calls = 0;
  config.onChange(() => calls++);
  assert.equal(config.get('ref'), 'one');

  text = 'this is not ini';
  throwsConfigError(() => config.reload());
  text = 'name = "two"\nref = "${nowhere}"\n';
  throwsConfigError(() => config.reload(), 'ref', /unknown reference/);

  assert.equal(calls, 0);
  assert.deepEqual(config.toObject(), { name: 'one', ref: 'one' });
  assert.equal(config.origin('name'), 'file');

  text = 'name = "three"\nref = "${name}"\n';
  assert.deepEqual(config.reload().map((c) => c.path), ['name', 'ref']);
  assert.equal(calls, 1);
  assert.equal(config.get('ref'), 'three');
});

test('createConfig fails right away when a source or a reference is broken', () => {
  throwsConfigError(() => api.createConfig({ sources: [api.jsonSource('bad', '{')] }));
  throwsConfigError(() => api.createConfig({ sources: [api.objectSource('o', { a: '${b}' })] }), 'a', /unknown reference/);
  throwsConfigError(() => api.createConfig({ sources: [api.objectSource('x', {}), api.objectSource('x', {})] }));
  // with interpolation off the same input is fine
  assert.equal(api.createConfig({ sources: [api.objectSource('o', { a: '${b}' })], interpolate: false }).get('a'), '${b}');
  assert.deepEqual(api.createConfig({ sources: [] }).toObject(), {});
});

test('loadConfig keeps its behaviour and gains argv and interpolate', () => {
  // unchanged: defaults < INI sources < env, no interpolation unless asked
  assert.deepEqual(
    api.loadConfig({
      defaults: { port: 3000, db: { host: 'localhost', port: 5432 }, debug: false, motto: 'run on ${port}' },
      sources: ['[db]\nhost = "db.internal"\n', 'debug = true\n'],
      env: { SVC_PORT: '9000', APP_PORT: 'ignored' },
      envPrefix: 'SVC_',
    }),
    { port: '9000', db: { host: 'db.internal', port: 5432 }, debug: true, motto: 'run on ${port}' },
  );
  assert.deepEqual(api.loadConfig(), {});

  // argv wins over everything
  assert.deepEqual(
    api.loadConfig({
      defaults: { port: 3000, debug: true, db: { host: 'localhost' } },
      sources: ['port = 4000\n'],
      env: { APP_PORT: '5000', APP_DB__HOST: 'from-env' },
      argv: ['--port', '6000', '--no-debug', '--db.user=admin'],
    }),
    { port: 6000, debug: false, db: { host: 'from-env', user: 'admin' } },
  );

  assert.deepEqual(
    api.loadConfig({ defaults: { host: 'h', url: 'http://${host}/' }, argv: ['--host=cli'], interpolate: true }),
    { host: 'cli', url: 'http://cli/' },
  );
});
