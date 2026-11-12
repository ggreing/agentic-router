// Routing auto-release (decision 138): the comparison rule, the holdout draw and what a release changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AUTO_RELEASE, DEFAULT_HOLDOUT_RATE, RELEASE_RULE, costPerAccepted, decideRelease, effectiveDelegateFrom, holdoutDraw, holdoutRate,
  releasedFrom, type Arm,
} from '../src/release.ts';

const arm = (n: number, costPerTask: number, accepted = n): Arm => ({ n, accepted, costUsd: n * costPerTask });

test('defaults: observe, one request in ten held out', () => {
  assert.equal(DEFAULT_AUTO_RELEASE, 'observe');
  assert.equal(DEFAULT_HOLDOUT_RATE, 0.1);
  assert.deepEqual([holdoutRate(undefined), holdoutRate(0.05), holdoutRate(0), holdoutRate(0.9), holdoutRate(-1), holdoutRate('0.1'), holdoutRate(NaN)], [0.1, 0.05, 0, 0.2, 0.1, 0.1, 0.1]);
  assert.deepEqual(RELEASE_RULE, { majorityMin: 30, minorityMin: 10, releaseAbove: 1.5, reenableAtOrBelow: 1.0, windowDays: 60 });
});

test('cost per accepted task carries the cost of what was not accepted', () => {
  assert.equal(costPerAccepted({ n: 10, accepted: 8, costUsd: 4 }), 0.5);
  assert.equal(costPerAccepted({ n: 10, accepted: 0, costUsd: 4 }), null);
  assert.equal(costPerAccepted({ n: 0, accepted: 0, costUsd: 0 }), null);
});

test('release needs both arms full and a delegated cost above 1.5x direct', () => {
  const d = (delegated: Arm, direct: Arm, released = false) => decideRelease({ released, delegated, direct });
  assert.deepEqual((x => [x.action, x.reason, x.ratio, x.need])(d(arm(29, 0.4), arm(10, 0.1))), ['hold', 'not_enough_data', null, { delegated: [29, 30], direct: [10, 10] }]);
  assert.deepEqual((x => [x.action, x.reason])(d(arm(30, 0.4), arm(9, 0.1))), ['hold', 'not_enough_data']);
  assert.deepEqual((x => [x.action, x.reason, x.ratio])(d(arm(30, 0.2), arm(10, 0.1))), ['release', 'delegated_dearer', 2]);
  assert.deepEqual((x => [x.action, x.reason, x.ratio])(d(arm(30, 0.15), arm(10, 0.1))), ['hold', 'inside_band', 1.5], 'exactly 1.5x is not above it');
  assert.deepEqual((x => [x.action, x.reason, x.ratio])(d(arm(30, 0.066), arm(10, 0.1))), ['hold', 'delegated_not_dearer', 0.66]);
  // acceptance moves the comparison: the same spend with half of the delegated work not accepted is twice the cost per task
  assert.deepEqual((x => [x.action, x.ratio])(d(arm(30, 0.1, 15), arm(10, 0.1))), ['release', 2]);
  // a full delegated arm with nothing accepted is the gross loss; a direct arm with nothing accepted gives no baseline
  assert.deepEqual((x => [x.action, x.reason, x.ratio])(d(arm(30, 0.1, 0), arm(10, 0.1))), ['release', 'delegated_dearer', null]);
  assert.deepEqual((x => [x.action, x.reason])(d(arm(30, 0.1), arm(10, 0.1, 0))), ['hold', 'no_direct_cost']);
});

test('re-enable through probes, with the arms swapped and a gap between the two thresholds', () => {
  const d = (delegated: Arm, direct: Arm) => decideRelease({ released: true, delegated, direct });
  assert.deepEqual((x => [x.action, x.reason, x.need])(d(arm(9, 0.05), arm(30, 0.1))), ['hold', 'not_enough_data', { delegated: [9, 10], direct: [30, 30] }]);
  assert.deepEqual((x => [x.action, x.reason])(d(arm(10, 0.05), arm(29, 0.1))), ['hold', 'not_enough_data']);
  assert.deepEqual((x => [x.action, x.reason, x.ratio])(d(arm(10, 0.08), arm(30, 0.1))), ['reenable', 'delegated_not_dearer', 0.8]);
  assert.deepEqual((x => [x.action, x.ratio])(d(arm(10, 0.1), arm(30, 0.1))), ['reenable', 1]);
  // between 1.0 and 1.5 nothing moves in either state
  assert.deepEqual((x => [x.action, x.reason])(d(arm(10, 0.12), arm(30, 0.1))), ['hold', 'inside_band']);
  assert.deepEqual((x => [x.action, x.reason])(decideRelease({ released: false, delegated: arm(30, 0.12), direct: arm(10, 0.1) })), ['hold', 'inside_band']);
  assert.deepEqual((x => [x.action, x.reason])(d(arm(10, 0.3), arm(30, 0.1))), ['hold', 'delegated_dearer']);
});

test('a release raises the delegation start level one step, bottom-up, and never lowers the configured one', () => {
  assert.deepEqual([releasedFrom('L1'), releasedFrom('L2'), releasedFrom('L3'), releasedFrom('L0')], ['L2', 'L3', null, null]);
  assert.equal(effectiveDelegateFrom('L1', 'L2'), 'L2');
  assert.equal(effectiveDelegateFrom('L2', 'L2'), 'L2');
  assert.equal(effectiveDelegateFrom('L2', 'L1'), 'L2', 'the automatic level never delegates more than the user configured');
  assert.equal(effectiveDelegateFrom('L1', null), 'L1');
  assert.equal(effectiveDelegateFrom('L1', undefined), 'L1');
});

test('holdout draw: stable per request id, close to its rate, off at zero', () => {
  const ids = Array.from({ length: 20000 }, (_, i) => `r-${(i * 2654435761 >>> 0).toString(16)}-${i}`);
  assert.equal(holdoutDraw('r-abc', 0.1), holdoutDraw('r-abc', 0.1));
  const share = (rate: number) => ids.filter(id => holdoutDraw(id, rate)).length / ids.length;
  assert.ok(Math.abs(share(0.1) - 0.1) < 0.01, `share at 0.1: ${share(0.1)}`);
  assert.ok(Math.abs(share(0.2) - 0.2) < 0.012, `share at 0.2: ${share(0.2)}`);
  assert.equal(share(0), 0);
  // a request held out at a low rate stays held out at a higher one
  assert.ok(ids.filter(id => holdoutDraw(id, 0.05)).every(id => holdoutDraw(id, 0.1)));
  // sequential ids do not come in runs
  const seq = Array.from({ length: 2000 }, (_, i) => holdoutDraw(`r-${i}`, 0.1));
  let longest = 0, run = 0;
  for (const x of seq) { run = x ? run + 1 : 0; longest = Math.max(longest, run); }
  assert.ok(longest <= 5, `longest run ${longest}`);
});

test('how often the rule fires, by chance and rightly (the decision-138 bootstrap table as a regression test)', () => {
  // Request costs spread like the measured ones: log-normal with sd(log) 0.8 (appendices G and H, direct and L2 team runs).
  let seed = 20261112;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const cost = (scale: number) => scale * Math.exp(0.8 * normal());
  const draw = (n: number, scale: number): Arm => ({ n, accepted: n, costUsd: Array.from({ length: n }, () => cost(scale)).reduce((a, b) => a + b, 0) });
  const fireRate = (ratio: number, trials = 4000) => {
    let fired = 0;
    for (let t = 0; t < trials; t++) if (decideRelease({ released: false, delegated: draw(30, ratio), direct: draw(10, 1) }).action === 'release') fired++;
    return fired / trials;
  };
  const at = { saves40: fireRate(0.6), same: fireRate(1.0), dearer50: fireRate(1.5), double: fireRate(2.0) };
  assert.ok(at.saves40 < 0.01, `router saves 40%: released by chance ${at.saves40}`);
  assert.ok(at.same < 0.15, `no difference: released by chance ${at.same}`);
  assert.ok(at.dearer50 > 0.35 && at.dearer50 < 0.65, `1.5x: about a coin flip, ${at.dearer50}`);
  assert.ok(at.double > 0.8, `2x loss caught: ${at.double}`);
});
