import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/index.ts';

test('text exactly maxLength long is returned unchanged', () => {
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('a', 1), 'a');
});

test('exact length with a custom ellipsis is unchanged', () => {
  assert.equal(truncate('abcdefgh', 8, { ellipsis: '...' }), 'abcdefgh');
});

test('text one character too long is still truncated', () => {
  assert.equal(truncate('hello!', 5), 'hell…');
  assert.equal(truncate('abcdefghi', 8, { ellipsis: '...' }), 'abcde...');
});
