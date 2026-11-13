// Routing auto-release on the daemon (spec 3.8, decision 138): the arms read from the records, the holdout
// draw at a new request, release and re-enable in mode 'on', and the default mode 'observe' that only shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Level } from '@do-it-all-claude-code/core';
import { readConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { metricsRouting } from '../src/metrics.ts';
import type { StatusView } from '../src/router.ts';
import { applyRelease, releaseArms, releaseChange, releaseNotice, routingHoldoutRate, routingMode, routingView } from '../src/routing.ts';
import { getStatus, makeHome, makeRepo, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
const NOW = '2026-11-12T12:00:00.000Z';
const daysAgo = (d: number, i = 0) => new Date(Date.parse(NOW) - d * 86_400_000 - i * 1000).toISOString();
let seq = 0;

interface Seed {
  leadClass?: string; level?: Level; leadDirect?: boolean; holdout?: string | null; usd?: number; acceptance?: string | null; status?: string;
  closedAt?: string; forcedFrom?: Level | null; manualLevel?: Level | null; replannedFrom?: Level | null; unknown?: boolean;
}
function seed(l: Ledger, o: Seed = {}): void {
  const level = o.level ?? 'L2';
  const direct = o.leadDirect ?? false;
  const record = {
    version: 1,
    plan: { level, leadDirect: direct, leadClass: o.leadClass ?? 'other', holdout: o.holdout ?? null, forcedFrom: o.forcedFrom ?? null, manualLevel: o.manualLevel ?? null, replannedFrom: o.replannedFrom ?? null },
    outcome: direct ? 'direct' : 'delegated',
    subtasks: direct ? [] : [{ status: o.status ?? 'passed' }],
    costs: { unknown: !!o.unknown },
  };
  const at = o.closedAt ?? daysAgo(1, seq);
  l.upsertRecord({
    requestId: `seed-${++seq}`, sessionId: 'seed', createdAt: at, closedAt: at, kind: direct ? 'direct' : 'team', level, finalLevel: level,
    outcome: record.outcome, changedFiles: 1, linesAdded: 1, linesRemoved: 0, durationMs: 1, activeMs: 1, subtaskUsd: 0, leadUsd: o.usd ?? 0.1, totalUsd: o.usd ?? 0.1,
    record, prompt: null, acceptance: o.acceptance === undefined ? 'accepted' : o.acceptance, acceptSignals: [],
  });
}
const many = (l: Ledger, n: number, o: Seed) => { for (let i = 0; i < n; i++) seed(l, o); };

test('arms: who is in them, who is left out, and only the latest requests of the window', () => {
  const l = new Ledger(':memory:');
  many(l, 3, { usd: 0.3 });                                          // delegated, planned by the rules
  seed(l, { usd: 0.3, acceptance: 'not_accepted' });                 // costs, not an accepted task
  seed(l, { usd: 0.3, status: 'failed' });                           // verify failed: the same
  seed(l, { usd: 0.3, acceptance: 'unobserved' });                   // counts as accepted
  many(l, 2, { leadDirect: true, holdout: 'direct', usd: 0.1 });     // the holdout
  seed(l, { leadDirect: true, holdout: 'released', usd: 0.1 });      // lead-direct because the level is released
  seed(l, { holdout: 'probe', usd: 0.2 });                           // delegated as a probe
  // left out of both arms
  seed(l, { leadDirect: true, holdout: null });                      // direct by configuration
  seed(l, { forcedFrom: 'L1' });
  seed(l, { manualLevel: 'L2' });
  seed(l, { replannedFrom: 'L1' });
  seed(l, { unknown: true });
  seed(l, { acceptance: 'n/a' });
  seed(l, { acceptance: null });
  seed(l, { level: 'L3' });
  seed(l, { level: 'L0', leadDirect: true, holdout: 'direct' });
  seed(l, { closedAt: daysAgo(61), usd: 9 });                        // older than the 60-day window
  seed(l, { leadClass: 'opus', level: 'L1', usd: 0.5 });
  const arms = releaseArms(l, NOW);
  const other = arms.get('other|L2')!;
  assert.deepEqual([other.delegated.n, other.delegated.accepted, Math.round(other.delegated.costUsd * 100) / 100], [6, 4, 1.8]);
  assert.deepEqual([other.direct.n, other.direct.accepted, Math.round(other.direct.costUsd * 100) / 100], [2, 2, 0.2]);
  // the arms of a released level are counted apart
  assert.deepEqual([other.probe.n, other.probe.costUsd, other.releasedDirect.n, other.releasedDirect.costUsd], [1, 0.2, 1, 0.1]);
  assert.deepEqual([...arms.keys()].sort(), ['opus|L1', 'other|L2']);
  // an arm holds at most its latest 30
  many(l, 40, { leadClass: 'sonnet', level: 'L1', usd: 1 });
  assert.equal(releaseArms(l, NOW).get('sonnet|L1')!.delegated.n, 30);
  l.close();
});

test('the view and the rule: observe shows what it would do, on applies it, off does nothing', () => {
  const l = new Ledger(':memory:');
  many(l, 30, { usd: 0.4 });
  many(l, 10, { leadDirect: true, holdout: 'direct', usd: 0.1 });
  // the records are of an L2-delegating class (decision 144 made an unknown lead delegate from L1 by default)
  const cfg = { holdoutRate: 0.1, delegateFrom: { other: 'L2' as const } };
  assert.deepEqual([routingMode(cfg), routingHoldoutRate(cfg), routingHoldoutRate({ ...cfg, autoRelease: 'off' }), routingHoldoutRate({})], ['observe', 0.1, 0, 0]);
  const v = routingView(l, cfg, NOW);
  assert.deepEqual([v.mode, v.holdoutRate, v.classes.map(c => c.leadClass)], ['observe', 0.1, ['opus', 'sonnet', 'haiku', 'other']]);
  const other = v.classes.find(c => c.leadClass === 'other')!;
  assert.deepEqual([other.configuredFrom, other.autoFrom, other.effectiveFrom], ['L2', null, 'L2']);
  const l2 = other.levels.find(x => x.level === 'L2')!;
  assert.deepEqual([l2.delegatedByConfig, l2.released, l2.candidate, l2.decision.action, l2.decision.ratio, l2.delegated.costPerAcceptedUsd, l2.direct.costPerAcceptedUsd, l2.delegated.n, l2.direct.n],
    [true, false, true, 'release', 4, 0.4, 0.1, 30, 10]);
  const l1 = other.levels.find(x => x.level === 'L1')!;
  assert.deepEqual([l1.delegatedByConfig, l1.candidate, l1.decision.action, l1.decision.reason], [false, false, 'hold', 'not_enough_data'], 'L1 is direct by configuration for this lead');
  assert.deepEqual(metricsRouting(l, cfg, NOW), v);

  const change = releaseChange(l, cfg, 'other', NOW)!;
  assert.deepEqual([change.kind, change.level, change.from, change.to], ['release', 'L2', 'L2', 'L3']);
  assert.equal(releaseNotice(change), '[do-it-all-claude-code] L2 requests with a other lead are now handled directly: the last 30 delegated L2 requests cost $0.400 per accepted task against $0.100 per accepted task for 10 handled directly. Undo: do-it-all-claude-code routing reset');
  assert.equal(releaseChange(l, { ...cfg, autoRelease: 'off' }, 'other', NOW), undefined);
  assert.equal(releaseChange(l, cfg, 'opus', NOW), undefined);

  // applied (the caller does this in mode 'on' only): the start level moves, and in mode 'on' the view shows the level released
  applyRelease(l, cfg, change, NOW);
  assert.deepEqual((r => [r.autoDelegateFrom, typeof r.notice])(l.getRelease('other')!), ['L3', 'string']);
  assert.equal(routingView(l, cfg, NOW).classes.find(c => c.leadClass === 'other')!.effectiveFrom, 'L2', 'observe never applies a stored level');
  const on = { ...cfg, autoRelease: 'on' as const };
  const after = routingView(l, on, NOW).classes.find(c => c.leadClass === 'other')!;
  assert.deepEqual([after.autoFrom, after.effectiveFrom, after.levels.find(x => x.level === 'L2')!.released], ['L3', 'L3', true]);
  assert.equal(releaseChange(l, on, 'other', NOW), undefined, 'released: the probes have to fill their arm first');

  // probes come in cheaper than direct: the level comes back; the dear requests from before the release do not count here
  many(l, 9, { holdout: 'probe', usd: 0.05 });
  many(l, 30, { leadDirect: true, holdout: 'released', usd: 0.1 });
  assert.equal(releaseChange(l, on, 'other', NOW), undefined, 'nine probes are not enough');
  seed(l, { holdout: 'probe', usd: 0.05 });
  const back = releaseChange(l, on, 'other', NOW)!;
  assert.deepEqual([back.kind, back.level, back.to], ['reenable', 'L2', 'L2']);
  assert.match(releaseNotice(back), /L2 requests with a other lead go to a team again/);
  applyRelease(l, on, back, NOW);
  assert.equal(l.getRelease('other')!.autoDelegateFrom, null);
  assert.equal(l.takeReleaseNotice('other'), releaseNotice(back));
  assert.equal(l.takeReleaseNotice('other'), undefined, 'a notice is shown once');
  l.close();
});

test('a configured delegateFrom is never lowered, and a lead that delegates from L1 releases L1 first', () => {
  const l = new Ledger(':memory:');
  many(l, 30, { leadClass: 'opus', level: 'L1', usd: 0.4 });
  many(l, 10, { leadClass: 'opus', level: 'L1', leadDirect: true, holdout: 'direct', usd: 0.1 });
  const on = { holdoutRate: 0.1, autoRelease: 'on' as const };
  const c = releaseChange(l, on, 'opus', NOW)!;
  assert.deepEqual([c.level, c.from, c.to], ['L1', 'L1', 'L2']);
  applyRelease(l, on, c, NOW);
  // the user then sets delegateFrom.opus = L3: the stored L2 does not pull it back down
  const v = routingView(l, { ...on, delegateFrom: { opus: 'L3' } }, NOW).classes.find(x => x.leadClass === 'opus')!;
  assert.deepEqual([v.configuredFrom, v.autoFrom, v.effectiveFrom, v.levels.map(x => x.delegatedByConfig)], ['L3', 'L2', 'L3', [false, false]]);
  l.close();
});

test('config: observe and 0.1 by default, the rate held to 0..0.2', () => {
  const home = makeHome({ holdoutRate: undefined });
  try {
    const warnings: string[] = [];
    const file = path.join(home, 'config.json');
    assert.deepEqual((c => [c.autoRelease, c.holdoutRate])(readConfig(file, warnings)), [undefined, 0.1]);
    for (const [raw, mode, rate, warns] of [
      [{ autoRelease: 'on', holdoutRate: 0.05 }, 'on', 0.05, 0], [{ autoRelease: 'off', holdoutRate: 0 }, 'off', 0, 0],
      [{ autoRelease: 'always', holdoutRate: 0.9 }, undefined, 0.2, 2], [{ holdoutRate: '0.1' }, undefined, 0.1, 1],
    ] as const) {
      const h = makeHome(raw as Record<string, unknown>);
      const w: string[] = [];
      assert.deepEqual((c => [c.autoRelease, c.holdoutRate, w.length])(readConfig(path.join(h, 'config.json'), w)), [mode, rate, warns], JSON.stringify(raw));
      rmrf(h);
    }
  } finally { rmrf(home); }
});

// ------------------------------------------------------------------ through the daemon

type Out = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
async function withDaemon(config: Record<string, unknown>, fn: (d: TestDaemon, ask: (sid: string, prompt?: string) => Promise<Out>, repo: string) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] }, config });
  const ask = async (sid: string, prompt = L2_PROMPT): Promise<Out> => {
    const h: HookInput = { session_id: sid, cwd: repo, transcript_path: path.join(d.home, `${sid}.jsonl`), hook_event_name: 'UserPromptSubmit', prompt };
    const r = await postHook(d.port, h);
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  try { await fn(d, ask, repo); } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}
const planned = (d: TestDaemon) => rows(d, 'SELECT session_id, level, holdout, team, triage FROM requests ORDER BY created_at, rowid')
  .map(r => ({ sid: String(r.session_id), level: r.level, holdout: r.holdout, leadDirect: JSON.parse(String(r.team)).leadDirect === true, triage: JSON.parse(String(r.triage)) as { kind?: string; rationale: string } }));

test('holdout: about one delegated-level request in five at rate 0.2 is handled lead-direct on purpose, and says so', () => withDaemon({ holdoutRate: 0.2 }, async (d, ask) => {
  const briefs = new Map<string, string>();
  for (let i = 0; i < 60; i++) briefs.set(`h${i}`, (await ask(`h${i}`)).hookSpecificOutput?.additionalContext ?? '');
  const all = planned(d);
  const held = all.filter(r => r.holdout === 'direct');
  assert.ok(held.length >= 2 && held.length <= 30, `holdouts: ${held.length} of 60`);
  assert.ok(all.every(r => r.level === 'L2'));
  for (const r of held) {
    assert.deepEqual([r.leadDirect, r.triage.kind], [true, 'direct']);
    assert.match(r.triage.rationale, /^holdout \(decision 138\): handled directly on purpose, to measure what delegation saves; /);
    assert.doesNotMatch(briefs.get(r.sid)!, /Call the Agent tool once per subtask/);
  }
  for (const r of all.filter(x => x.holdout === null)) assert.deepEqual([r.leadDirect, r.triage.kind], [false, 'team']);
  // a level that is direct by configuration, and L0, are never drawn
  for (let i = 0; i < 20; i++) await ask(`l0-${i}`, 'fix the typo in README.md');
  assert.ok(planned(d).filter(r => r.sid.startsWith('l0-')).every(r => r.holdout === null));
  const st = (await getStatus(d.port, 'h0')).body as StatusView;
  assert.deepEqual([st.routing.mode, st.routing.holdoutRate], ['observe', 0.2]);
}));

test('no holdout for forced levels, with the rate at zero, or with auto-release off', async () => {
  for (const config of [{ holdoutRate: 0.2, forceLevel: 'L2' }, { holdoutRate: 0 }, { holdoutRate: 0.2, autoRelease: 'off' }]) {
    await withDaemon(config, async (d, ask) => {
      for (let i = 0; i < 40; i++) await ask(`n${i}`);
      assert.ok(planned(d).every(r => r.holdout === null && !r.leadDirect), JSON.stringify(config));
    });
  }
});

test('mode on: a level that costs far more delegated is released, the user is told once, probes keep running, reset undoes it', () => withDaemon({ holdoutRate: 0.2, autoRelease: 'on' }, async (d, ask) => {
  const now = new Date().toISOString();
  const at = (i: number) => new Date(Date.parse(now) - 3_600_000 - i * 1000).toISOString();
  for (let i = 0; i < 30; i++) seed(d.ledger, { usd: 0.4, closedAt: at(i) });
  for (let i = 0; i < 10; i++) seed(d.ledger, { leadDirect: true, holdout: 'direct', usd: 0.1, closedAt: at(40 + i) });
  // the rule is looked at when a record is written: one request of this lead class closes
  await ask('first', 'fix the typo in README.md');
  await postHook(d.port, { session_id: 'first', cwd: d.home, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await d.router.drain();
  assert.deepEqual(rows(d, 'SELECT lead_class, auto_delegate_from FROM release_state'), [{ lead_class: 'other', auto_delegate_from: 'L3' }]);

  // the next request of that lead class carries the notice, once
  const first = await ask('r0');
  assert.match(first.systemMessage ?? '', /^\[do-it-all-claude-code\] L2 requests with a other lead are now handled directly: the last 30 delegated L2 requests cost \$0\.400 per accepted task against \$0\.100/);
  assert.equal((await ask('r1')).systemMessage, undefined);
  for (let i = 2; i < 60; i++) await ask(`r${i}`);
  const after = planned(d).filter(r => r.sid.startsWith('r'));
  const direct = after.filter(r => r.holdout === 'released');
  const probes = after.filter(r => r.holdout === 'probe');
  assert.equal(direct.length + probes.length, 60);
  assert.ok(probes.length >= 2 && probes.length <= 30, `probes: ${probes.length} of 60`);
  assert.ok(direct.every(r => r.leadDirect && r.triage.kind === 'direct' && /^released \(decision 138\)/.test(r.triage.rationale)));
  assert.ok(probes.every(r => !r.leadDirect));
  const st = (await getStatus(d.port, 'r0')).body as StatusView;
  const other = st.routing.classes.find(c => c.leadClass === 'other')!;
  assert.deepEqual([st.routing.mode, other.effectiveFrom, other.levels.find(x => x.level === 'L2')!.released], ['on', 'L3', true]);

  assert.deepEqual(d.router.routingReset(), { cleared: 1 });
  seq += 1000;   // the seeded arms are still there, so keep the next close from releasing again: make them old
  d.ledger.db.exec("UPDATE request_records SET closed_at = '2020-01-01T00:00:00.000Z' WHERE session_id = 'seed'");
  for (let i = 0; i < 20; i++) await ask(`z${i}`);
  assert.ok(planned(d).filter(r => r.sid.startsWith('z')).every(r => r.holdout === null || r.holdout === 'direct'));
}));

test('mode observe (the default): the same numbers release nothing; the view says what it would do', () => withDaemon({ holdoutRate: 0.2 }, async (d, ask) => {
  const now = new Date().toISOString();
  const at = (i: number) => new Date(Date.parse(now) - 3_600_000 - i * 1000).toISOString();
  for (let i = 0; i < 30; i++) seed(d.ledger, { usd: 0.4, closedAt: at(i) });
  for (let i = 0; i < 10; i++) seed(d.ledger, { leadDirect: true, holdout: 'direct', usd: 0.1, closedAt: at(40 + i) });
  await ask('first', 'fix the typo in README.md');
  await postHook(d.port, { session_id: 'first', cwd: d.home, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  await d.router.drain();
  assert.equal(d.ledger.listReleases().length, 0);
  assert.equal((await ask('o1')).systemMessage, undefined);
  const st = (await getStatus(d.port, 'o1')).body as StatusView;
  const l2 = st.routing.classes.find(c => c.leadClass === 'other')!.levels.find(x => x.level === 'L2')!;
  assert.deepEqual([st.routing.mode, l2.released, l2.candidate, l2.decision.action, l2.decision.ratio], ['observe', false, true, 'release', 4]);
}));
