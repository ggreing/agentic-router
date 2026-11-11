import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, TextkitError } from '../src/index.ts';

test('interpolate replaces placeholders', () => {
  assert.equal(interpolate('Hi {{ name }}, you have {{count}} messages', { name: 'Ada', count: 3 }),
    'Hi Ada, you have 3 messages');
});

test('interpolate throws for a missing value in strict mode', () => {
  assert.throws(() => interpolate('Hi {{name}}', {}), TextkitError);
  assert.throws(() => interpolate('Hi {{name}}', { name: null }), TextkitError);
});

test('interpolate keeps unknown placeholders when strict is false', () => {
  assert.equal(interpolate('Hi {{name}}', {}, { strict: false }), 'Hi {{name}}');
});
