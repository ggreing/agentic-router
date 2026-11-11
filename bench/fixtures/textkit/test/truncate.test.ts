import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate, TextkitError } from '../src/index.ts';

test('truncate cuts long text and appends an ellipsis', () => {
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello world', 8).length, 8);
});

test('truncate leaves short text alone', () => {
  assert.equal(truncate('short', 10), 'short');
});

test('truncate supports a custom ellipsis', () => {
  assert.equal(truncate('hello world', 8, { ellipsis: '...' }), 'hello...');
});

test('truncate rejects a non-positive maxLength', () => {
  assert.throws(() => truncate('abc', 0), TextkitError);
  assert.throws(() => truncate('abc', 2.5), TextkitError);
});
