import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyLimitsSchema, parseRateLimits, recordLimits, latestLimits } from '../src/limits.ts';

// The rate_limits shape from the Claude Code status line docs (code.claude.com/docs/en/statusline).
const FULL = {
  five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
  seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  spend_limit: { used_percentage: 62.8, resets_at: 1740787200, used_usd: 314.12, limit_usd: 500, period: 'monthly' },
};

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  applyLimitsSchema(d);
  return d;
}

test('parseRateLimits reads the documented shape and ignores junk', () => {
  const p = parseRateLimits(FULL)!;
  assert.deepEqual(p.fiveHour, { usedPercentage: 23.5, resetsAt: 1738425600 });
  assert.deepEqual(p.sevenDay, { usedPercentage: 41.2, resetsAt: 1738857600 });
  assert.equal(p.spendLimit!.usedUsd, 314.12);
  assert.equal(p.spendLimit!.period, 'monthly');
  assert.equal(parseRateLimits(undefined), null);
  assert.equal(parseRateLimits({}), null);
  assert.equal(parseRateLimits({ five_hour: {} }), null, 'a window with no percentage is nothing');
});

test('each window is independently absent (docs: dropped once resets_at passes)', () => {
  const only5h = parseRateLimits({ five_hour: { used_percentage: 10 } })!;
  assert.deepEqual(only5h.fiveHour, { usedPercentage: 10, resetsAt: null });
  assert.equal(only5h.sevenDay, null);
  assert.equal(only5h.spendLimit, null);
});

test('recordLimits upserts the latest per session; latestLimits reads it back', () => {
  const d = db();
  assert.equal(recordLimits(d, { sessionId: 's1', rateLimits: FULL, at: '2026-11-12T10:00:00.000Z' }), true);
  const got = latestLimits(d, 's1')!;
  assert.equal(got.fiveHour!.usedPercentage, 23.5);
  assert.equal(got.sevenDay!.usedPercentage, 41.2);
  assert.equal(got.spendLimit!.limitUsd, 500);
  assert.equal(got.updatedAt, '2026-11-12T10:00:00.000Z');
  // a later report replaces it
  recordLimits(d, { sessionId: 's1', rateLimits: { five_hour: { used_percentage: 55, resets_at: 1738425600 } }, at: '2026-11-12T11:00:00.000Z' });
  const upd = latestLimits(d, 's1')!;
  assert.equal(upd.fiveHour!.usedPercentage, 55);
  assert.equal(upd.sevenDay, null, 'the newer report had no seven_day window');
});

test('latestLimits with no session returns the most recently updated one', () => {
  const d = db();
  recordLimits(d, { sessionId: 'a', rateLimits: { five_hour: { used_percentage: 1 } }, at: '2026-11-12T10:00:00.000Z' });
  recordLimits(d, { sessionId: 'b', rateLimits: { five_hour: { used_percentage: 2 } }, at: '2026-11-12T12:00:00.000Z' });
  assert.equal(latestLimits(d)!.fiveHour!.usedPercentage, 2);
});

test('recordLimits is a no-op for empty/unusable input; latestLimits tolerates a missing table', () => {
  const d = db();
  assert.equal(recordLimits(d, { sessionId: 's', rateLimits: {}, at: 'now' }), false);
  assert.equal(recordLimits(d, { sessionId: '', rateLimits: FULL, at: 'now' }), false);
  assert.equal(latestLimits(d, 's'), null);
  const bare = new DatabaseSync(':memory:');   // no schema applied (pre-migration)
  assert.equal(latestLimits(bare, 's'), null, 'missing table -> null, not a throw');
});
