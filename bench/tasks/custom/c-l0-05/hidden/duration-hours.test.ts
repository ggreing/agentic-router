import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/index.ts';

test('one hour is 3,600,000 ms', () => {
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
});

test('compound values with hours', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1d2h'), 93_600_000);
});

test('other units are unchanged', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1d'), 86_400_000);
});
