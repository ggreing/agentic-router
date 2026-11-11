import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseDuration } from '../src/index.ts';

test('parseDuration handles single units', () => {
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('10s'), 10_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1.5s'), 1_500);
});

test('parseDuration handles compound values and numbers', () => {
  assert.equal(parseDuration('1m30s'), 90_000);
  assert.equal(parseDuration(1200), 1200);
});

test('parseDuration rejects garbage', () => {
  assert.throws(() => parseDuration(''), ConfigError);
  assert.throws(() => parseDuration('10'), ConfigError);
  assert.throws(() => parseDuration('ten seconds'), ConfigError);
  assert.throws(() => parseDuration(-1), ConfigError);
});
