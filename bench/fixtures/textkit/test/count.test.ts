import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charCount, wordCount } from '../src/count.ts';

test('wordCount counts words and keeps contractions together', () => {
  assert.equal(wordCount("don't stop me now"), 4);
  assert.equal(wordCount('  '), 0);
  assert.equal(wordCount('안녕하세요 여러분'), 2);
});

test('charCount counts grapheme clusters', () => {
  assert.equal(charCount('abc'), 3);
  assert.equal(charCount('é'), 1);
  assert.equal(charCount('👍🏽!'), 2);
});
