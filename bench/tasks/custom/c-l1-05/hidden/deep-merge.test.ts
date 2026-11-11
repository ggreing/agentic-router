import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../src/index.ts';
import type { ConfigObject } from '../src/index.ts';

test('input layers are not mutated', () => {
  const a = { db: { host: 'a', port: 1 }, tags: ['x'] };
  const b = { db: { port: 2 } };
  const result = deepMerge(a, b);
  assert.deepEqual(result, { db: { host: 'a', port: 2 }, tags: ['x'] });
  assert.deepEqual(a, { db: { host: 'a', port: 1 }, tags: ['x'] });
  assert.deepEqual(b, { db: { port: 2 } });
});

test('the result does not share nested references with the inputs', () => {
  const a: ConfigObject = { db: { host: 'a', replica: { host: 'r' } }, tags: ['x'] };
  const result = deepMerge(a);
  (result.db as ConfigObject).host = 'changed';
  ((result.db as ConfigObject).replica as ConfigObject).host = 'changed';
  (result.tags as string[]).push('y');
  assert.deepEqual(a, { db: { host: 'a', replica: { host: 'r' } }, tags: ['x'] });
});

test('reusing a defaults object gives independent results', () => {
  const defaults = { db: { host: 'localhost', port: 5432 } };
  const first = deepMerge(defaults, { db: { host: 'one' } });
  const second = deepMerge(defaults, { db: { port: 6543 } });
  assert.deepEqual(first, { db: { host: 'one', port: 5432 } });
  assert.deepEqual(second, { db: { host: 'localhost', port: 6543 } });
});

test('undefined values do not override, null does', () => {
  assert.deepEqual(
    deepMerge({ port: 8080, db: { host: 'x' } }, { port: undefined, db: { host: undefined } }),
    { port: 8080, db: { host: 'x' } },
  );
  assert.deepEqual(deepMerge({ port: 8080 }, { port: null }), { port: null });
});

test('arrays are replaced by a copy', () => {
  const later = { hosts: ['d'] };
  const result = deepMerge({ hosts: ['a', 'b', 'c'] }, later);
  assert.deepEqual(result, { hosts: ['d'] });
  assert.notEqual(result.hosts, later.hosts);
});

test('__proto__ / constructor / prototype keys are ignored', () => {
  const proto = Object.prototype as Record<string, unknown>;
  try {
    const result = deepMerge({ a: 1 }, JSON.parse('{"__proto__": {"polluted": "yes"}, "b": 2}'));
    assert.equal(proto.polluted, undefined);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(result, { a: 1, b: 2 });
    assert.equal(Object.hasOwn(result, '__proto__'), false);

    const nested = deepMerge(
      { db: { host: 'x' } },
      JSON.parse('{"db": {"__proto__": {"evil": true}}, "constructor": {"prototype": {"evil2": true}}, "prototype": 1}'),
    );
    assert.equal(proto.evil, undefined);
    assert.equal(proto.evil2, undefined);
    assert.equal(Object.hasOwn(nested, 'constructor'), false);
    assert.equal(Object.hasOwn(nested, 'prototype'), false);
    assert.deepEqual(nested, { db: { host: 'x' } });
  } finally {
    delete proto.polluted;
    delete proto.evil;
    delete proto.evil2;
  }
});

test('deep nested merging still works', () => {
  assert.deepEqual(
    deepMerge({ a: { b: { c: 1, d: 2 } } }, { a: { b: { d: 3 } } }, { a: { e: true } }),
    { a: { b: { c: 1, d: 3 }, e: true } },
  );
});
