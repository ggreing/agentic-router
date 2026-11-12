import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldSendLimits, maybeSendLimits, LIMITS_MIN_INTERVAL_MS } from '../../../plugin/statusline.mjs';
import { sealedFake } from '../../core/test/sealed-fake.ts';

const RL = { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } };

test('shouldSendLimits: no stamp sends; same value within the interval skips; change or staleness sends', () => {
  const now = 1_000_000;
  assert.equal(shouldSendLimits(undefined, RL, now), true, 'first time');
  const stamp = { hash: JSON.stringify(RL), at: now };
  assert.equal(shouldSendLimits(stamp, RL, now + 1000), false, 'unchanged, within interval');
  assert.equal(shouldSendLimits(stamp, RL, now + LIMITS_MIN_INTERVAL_MS), true, 'stale');
  assert.equal(shouldSendLimits(stamp, { five_hour: { used_percentage: 99 } }, now + 1000), true, 'changed');
  assert.equal(shouldSendLimits(undefined, undefined, now), false, 'no rate_limits');
  assert.equal(shouldSendLimits(undefined, {}, now), false, 'empty rate_limits');
});

function fakeDaemon(): Promise<{ port: number; posts: Array<{ path: string; body: Record<string, unknown> }>; close: () => Promise<void> }> {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  // the daemon side of a sealed call (decision 156); the tests below use the token 't'
  const server = http.createServer(sealedFake('t', r => { try { posts.push({ path: r.path, body: JSON.parse(r.body ?? '') }); } catch { /* ignore */ } return { body: '{}' }; }));
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as { port: number }).port, posts, close: () => new Promise<void>(r => server.close(() => r())),
  })));
}

test('maybeSendLimits posts once, rate-limits repeats, and resends on change or staleness', async () => {
  const d = await fakeDaemon();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-slh-'));
  try {
    const args = { home, port: d.port, token: 't', sessionId: 's1', rateLimits: RL };
    const t0 = 1_000_000;
    await maybeSendLimits({ ...args, now: t0 });
    assert.equal(d.posts.length, 1, 'first render sends');
    assert.equal(d.posts[0]!.path, '/router/v1/limits');
    assert.equal(d.posts[0]!.body.sessionId, 's1');
    assert.deepEqual(d.posts[0]!.body.rateLimits, RL);
    assert.ok(typeof d.posts[0]!.body.at === 'string');
    assert.ok(fs.existsSync(path.join(home, 'limits-cache', 's1.json')), 'stamp written');

    await maybeSendLimits({ ...args, now: t0 + 1000 });
    assert.equal(d.posts.length, 1, 'unchanged within the interval: no second post');

    await maybeSendLimits({ ...args, now: t0 + LIMITS_MIN_INTERVAL_MS + 1 });
    assert.equal(d.posts.length, 2, 'stale: resends');

    await maybeSendLimits({ ...args, rateLimits: { five_hour: { used_percentage: 90 } }, now: t0 + LIMITS_MIN_INTERVAL_MS + 2 });
    assert.equal(d.posts.length, 3, 'changed value: resends');
  } finally {
    await d.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('maybeSendLimits never throws when the daemon is unreachable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-slh-'));
  try {
    await maybeSendLimits({ home, port: 1, token: 't', sessionId: 's', rateLimits: RL, now: 1 });  // closed port
    assert.ok(true, 'resolved without throwing');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
