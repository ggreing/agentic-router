import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as textkit from '../src/index.ts';

test('wordCount is exported from the package entry point', () => {
  assert.equal(typeof textkit.wordCount, 'function');
});

test('the exported wordCount counts words', () => {
  const { wordCount } = textkit as unknown as { wordCount: (text: string) => number };
  assert.equal(wordCount('hello brave new world'), 4);
  assert.equal(wordCount(''), 0);
});

test('existing exports are still available', () => {
  assert.equal(typeof textkit.charCount, 'function');
  assert.equal(typeof textkit.slugify, 'function');
  assert.equal(typeof textkit.interpolate, 'function');
});
