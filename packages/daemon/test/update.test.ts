// Decision 163: the daemon's update check. A timer asks at most once a day while config.updateCheck is "on"; a
// newer release reaches the user at session start as systemMessage (never as context the model reads), at most
// once a day per version, and the status view (status line). Fake checks only: nothing reaches GitHub.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseVersion, readUpdateState, writeUpdateState, type FetchOptions, type UpdateState } from '@do-it-all-claude-code/core';
import { formatStatus } from '../../../plugin/statusline.mjs';
import { DAEMON_VERSION } from '../src/index.ts';
import { readConfig } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import { UpdateWatcher } from '../src/updates.ts';
import { claudeAdapter, getStatus, makeHome, postHook, rmrf, startTestDaemon } from './helpers.ts';

let home = '';
beforeEach(() => { home = makeHome({}); });
afterEach(() => { rmrf(home); });

const current = parseVersion(DAEMON_VERSION)!;
const NEWER = `v${current.major + 1}.0.0`;
const NEWEST = `v${current.major + 2}.0.0`;
const config = (o: Record<string, unknown>) => {
  const f = path.join(home, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...o }));
};
function logs(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m, d) => lines.push(`info ${m} ${JSON.stringify(d ?? {})}`), warn: (m, d) => lines.push(`warn ${m} ${JSON.stringify(d ?? {})}`), error: (m, d) => lines.push(`error ${m} ${JSON.stringify(d ?? {})}`) };
}
/** A check that writes what GitHub would have said (or fails), and counts its calls. */
function fakeCheck(answer: () => { latest?: string; fail?: string }) {
  const calls: Date[] = [];
  const check = async (h: string, o: FetchOptions & { now?: Date }) => {
    calls.push(o.now!);
    const a = answer();
    const now = o.now!.toISOString();
    const s: UpdateState = { ...readUpdateState(h), attemptedAt: now };
    if (a.fail) { s.lastError = a.fail; writeUpdateState(h, s); return { state: s, result: { ok: false as const, reason: a.fail } }; }
    Object.assign(s, { checkedAt: now, ...(a.latest ? { latest: a.latest } : {}) });
    writeUpdateState(h, s);
    return { state: s, result: { ok: true as const, notModified: false as const, latest: a.latest ?? null } };
  };
  return { calls, check };
}

test('decision 163: existing installs start off; "on" in config.json is the only way the daemon checks', async () => {
  assert.equal(readConfig(path.join(home, 'config.json')).updateCheck, undefined);
  config({ updateCheck: 'yes' });
  assert.equal(readConfig(path.join(home, 'config.json')).updateCheck, undefined, 'anything else is ignored');
  const f = fakeCheck(() => ({ latest: NEWER }));
  const w = new UpdateWatcher({ home, configFile: path.join(home, 'config.json'), current: DAEMON_VERSION, logger: logs(), check: f.check });
  assert.equal(await w.tick(), 'off');
  config({ updateCheck: 'off' });
  assert.equal(await w.tick(), 'off');
  assert.equal(w.sessionNotice(), undefined);
  assert.equal(w.status(), null);
  assert.equal(f.calls.length, 0, 'never asked');
});

test('decision 163: at most one check a day; a failure logs one line and keeps the last result', async () => {
  config({ updateCheck: 'on' });
  let now = new Date('2026-11-13T08:00:00Z');
  let answer: { latest?: string; fail?: string } = { latest: NEWER };
  const f = fakeCheck(() => answer);
  const log = logs();
  const w = new UpdateWatcher({ home, configFile: path.join(home, 'config.json'), current: DAEMON_VERSION, logger: log, check: f.check, now: () => now });
  assert.equal(await w.tick(), 'checked');
  assert.equal(await w.tick(), 'not due');
  now = new Date('2026-11-14T07:59:00Z');
  assert.equal(await w.tick(), 'not due', 'less than a day');
  now = new Date('2026-11-14T08:00:00Z');
  answer = { fail: 'ETIMEDOUT' };
  assert.equal(await w.tick(), 'failed');
  assert.equal(readUpdateState(home).latest, NEWER, 'the last result stays');
  assert.equal(log.lines.filter(l => l.startsWith('warn update check failed')).length, 1);
  assert.equal(await w.tick(), 'not due', 'a failed attempt counts too: no retry storm');
  now = new Date('2026-11-01T00:00:00Z');
  answer = { latest: NEWER };
  assert.equal(await w.tick(), 'checked', 'an attempt in the future (the clock was set back) does not block checks');
  assert.equal(f.calls.length, 3);
});

test('review L4: a home that cannot be written does not make every tick ask GitHub again (the attempt is kept in memory too)', async () => {
  config({ updateCheck: 'on' });
  let now = new Date('2026-11-13T08:00:00Z');
  let calls = 0;
  // writing update.json fails (a full disk, a read-only home): the check throws and attemptedAt never reaches the file
  const check = async () => { calls++; throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); };
  const log = logs();
  const w = new UpdateWatcher({ home, configFile: path.join(home, 'config.json'), current: DAEMON_VERSION, logger: log, check, now: () => now });
  assert.equal(await w.tick(), 'failed');
  assert.equal(readUpdateState(home).attemptedAt, undefined);
  for (const h of [1, 2, 23]) {
    now = new Date(Date.parse('2026-11-13T08:00:00Z') + h * 3_600_000);
    assert.equal(await w.tick(), 'not due', `hour ${h}`);
  }
  now = new Date('2026-11-14T08:00:00Z');
  assert.equal(await w.tick(), 'failed', 'a day later it tries again');
  assert.equal(calls, 2);
  assert.equal(log.lines.filter(l => l.startsWith('warn update check failed')).length, 2, 'one line per attempt');
});

test('decision 163: the session-start notice: once a day per new version, only while on, only for a newer release', () => {
  config({ updateCheck: 'on' });
  let now = new Date('2026-11-13T08:00:00Z');
  writeUpdateState(home, { version: 1, latest: NEWER, checkedAt: now.toISOString() });
  const watcher = () => new UpdateWatcher({ home, configFile: path.join(home, 'config.json'), current: DAEMON_VERSION, logger: logs(), now: () => now });
  let w = watcher();
  const text = `Do It All Claude Code ${NEWER.slice(1)} is available (you have ${DAEMON_VERSION}): https://github.com/ggreing/do-it-all-claude-code/releases/tag/${NEWER}`;
  assert.equal(w.sessionNotice(), text);
  assert.equal(w.sessionNotice(), undefined, 'once');
  assert.equal(watcher().sessionNotice(), undefined, 'a daemon restart remembers it (update.json)');
  assert.deepEqual(w.status(), { latest: NEWER.slice(1), current: DAEMON_VERSION, link: `https://github.com/ggreing/do-it-all-claude-code/releases/tag/${NEWER}` }, 'the status line keeps showing it');
  now = new Date('2026-11-14T08:00:01Z');
  w = watcher();
  assert.equal(w.sessionNotice(), text, 'the next day');
  writeUpdateState(home, { ...readUpdateState(home), latest: NEWEST });
  w = watcher();
  assert.match(w.sessionNotice() ?? '', new RegExp(`${NEWEST.slice(1).replace(/\./g, '\\.')} is available`), 'a newer version the same day');
  writeUpdateState(home, { version: 1, latest: `v${DAEMON_VERSION}` });
  assert.equal(watcher().sessionNotice(), undefined, 'not newer');
  writeUpdateState(home, { version: 1, latest: NEWER });
  config({ updateCheck: 'off' });
  assert.equal(watcher().sessionNotice(), undefined, 'off');
});

test('decision 163: at session start the notice is systemMessage (shown to the user), never additionalContext; the status view and status line carry it', async () => {
  config({ updateCheck: 'on' });
  writeUpdateState(home, { version: 1, latest: NEWER, checkedAt: new Date().toISOString() });
  const f = fakeCheck(() => ({ fail: 'not in tests' }));
  const d = await startTestDaemon({ home, updateCheck: { check: f.check, firstTickMs: 3_600_000 } });
  try {
    const start = (sid: string, source = 'startup') => postHook(d.port, { session_id: sid, cwd: home, hook_event_name: 'SessionStart', source });
    const first = (await start('s1')).body as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
    assert.match(first.systemMessage ?? '', new RegExp(`^Do It All Claude Code ${NEWER.slice(1).replace(/\./g, '\\.')} is available \\(you have ${DAEMON_VERSION.replace(/\./g, '\\.')}\\): https://github\\.com/ggreing/do-it-all-claude-code/releases/tag/${NEWER.replace(/\./g, '\\.')}$`));
    assert.ok(!JSON.stringify(first.hookSpecificOutput ?? {}).includes('is available'), 'nothing of it in the context');
    const second = (await start('s2')).body as Record<string, unknown>;
    assert.equal(second.systemMessage, undefined, 'once a day');
    // the status view, and the status line made from it
    const view = (await getStatus(d.port)).body as { update?: unknown };
    assert.deepEqual(view.update, { latest: NEWER.slice(1), current: DAEMON_VERSION, link: `https://github.com/ggreing/do-it-all-claude-code/releases/tag/${NEWER}` });
    assert.equal(formatStatus(view), `[Router] idle | update ${NEWER.slice(1)}`);
    assert.equal(f.calls.length, 0, 'no check on the hook path');
  } finally { await d.close(); }
});

test('decision 163: a replayed session start shows nothing, and a resumed one keeps its context apart from the notice', async () => {
  config({ updateCheck: 'on' });
  writeUpdateState(home, { version: 1, latest: NEWER });
  const d = await startTestDaemon({ home, updateCheck: { check: fakeCheck(() => ({})).check, firstTickMs: 3_600_000 } });
  try {
    const ev = claudeAdapter.toRouterEvent({ session_id: 's9', cwd: home, hook_event_name: 'SessionStart', source: 'startup' });
    const replayed = await d.router.process({ ...ev, spooled: true });
    assert.equal(replayed.userMessage, undefined, 'a replayed event is not a session the user is looking at');
    const live = await d.router.process(ev);
    assert.match(live.userMessage ?? '', /is available/);
    assert.equal(live.context, undefined, 'the notice is never context');
    const out = claudeAdapter.renderHookOutput('session_start', { context: 'restored team state', userMessage: 'Do It All Claude Code 9.0.0 is available' });
    assert.deepEqual(out, { systemMessage: 'Do It All Claude Code 9.0.0 is available', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'restored team state' } });
  } finally { await d.close(); }
});

test('decision 163: the SessionStart hook stays synchronous (Claude Code hands an async hook\'s systemMessage to Claude)', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../../../plugin/hooks/hooks.json', import.meta.url), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
  const start = hooks.hooks.SessionStart!.flatMap(g => g.hooks);
  assert.ok(start.length > 0);
  for (const h of start) for (const k of ['async', 'asyncRewake']) assert.equal(h[k], undefined, `SessionStart hook has ${k}`);
});
