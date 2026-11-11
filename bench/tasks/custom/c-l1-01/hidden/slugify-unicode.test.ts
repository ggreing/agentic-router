import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/index.ts';

type Slugify = (input: string, options?: { separator?: string }) => string;
const slug = slugify as Slugify;

test('diacritics are removed from latin letters', () => {
  assert.equal(slug('Crème Brûlée'), 'creme-brulee');
  assert.equal(slug('ÉCOLE Française'), 'ecole-francaise');
});

test('Hangul and digits are preserved (NFC output)', () => {
  assert.equal(slug('안녕 세상'), '안녕-세상');
  assert.equal(slug('React 훅 정리 2편'), 'react-훅-정리-2편');
});

test('custom separator', () => {
  assert.equal(slug('Hello World', { separator: '_' }), 'hello_world');
  assert.equal(slug('  --Hello,   World!--  ', { separator: '_' }), 'hello_world');
  assert.equal(slug('Crème Brûlée', { separator: '.' }), 'creme.brulee');
});

test('empty, blank and symbol-only input gives an empty slug', () => {
  assert.equal(slug(''), '');
  assert.equal(slug('   '), '');
  assert.equal(slug('!!! ??? ---'), '');
});

test('existing ASCII behaviour is unchanged', () => {
  assert.equal(slug('Hello, World!'), 'hello-world');
  assert.equal(slug('Version 2.0 Release'), 'version-2-0-release');
});
