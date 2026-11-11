import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.ts';

test('slugify lower-cases and joins words with dashes', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('Version 2.0 Release'), 'version-2-0-release');
});

test('slugify collapses repeated separators and trims the ends', () => {
  assert.equal(slugify('  multiple   spaces  '), 'multiple-spaces');
  assert.equal(slugify('--already-slugged--'), 'already-slugged');
});
