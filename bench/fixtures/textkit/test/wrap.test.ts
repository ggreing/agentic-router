import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordWrap, TextkitError } from '../src/index.ts';

test('wordWrap fills lines greedily', () => {
  assert.equal(wordWrap('the quick brown fox jumps', 10), 'the quick\nbrown fox\njumps');
});

test('wordWrap keeps a long word on its own line', () => {
  assert.equal(wordWrap('a supercalifragilistic b', 5), 'a\nsupercalifragilistic\nb');
});

test('wordWrap rejects an invalid width', () => {
  assert.throws(() => wordWrap('abc', 0), TextkitError);
});
