import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../src/index.ts';

test('later layers win and nested objects are merged', () => {
  assert.deepEqual(
    deepMerge({ port: 3000, db: { host: 'localhost', port: 5432 } }, { port: 8080, db: { host: 'db' } }),
    { port: 8080, db: { host: 'db', port: 5432 } },
  );
});

test('arrays are replaced, not merged', () => {
  assert.deepEqual(deepMerge({ hosts: ['a', 'b', 'c'] }, { hosts: ['d'] }), { hosts: ['d'] });
});

test('a scalar can replace an object and vice versa', () => {
  assert.deepEqual(deepMerge({ cache: { ttl: 5 } }, { cache: false }), { cache: false });
  assert.deepEqual(deepMerge({ cache: false }, { cache: { ttl: 5 } }), { cache: { ttl: 5 } });
});

test('no layers gives an empty object', () => {
  assert.deepEqual(deepMerge(), {});
});
