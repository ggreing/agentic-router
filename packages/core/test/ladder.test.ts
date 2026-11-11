import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESETS, crossesTier, redact, stepDown, stepUp, topStep } from '@agentic-router/core';

test('ladder moves one step at a time and stops at the top', () => {
  assert.equal(stepUp('s1'), 's2');
  assert.equal(stepUp('s6'), null);
  assert.equal(stepUp('s6', true), 's7');
  assert.equal(stepDown('s1'), null);
  assert.equal(topStep(false), 's6');
});

test('a model change happens only across tier boundaries', () => {
  assert.equal(crossesTier('s1', 's2'), false);
  assert.equal(crossesTier('s2', 's3'), true);
  assert.equal(crossesTier('s5', 's6'), false);
});

test('L3 workers and reviewer start at s5 (decisions 46-47)', () => {
  const l3 = DEFAULT_PRESETS.L3.roles;
  assert.equal(l3.find(r => r.role === 'coder')?.start, 's5');
  assert.equal(l3.find(r => r.role === 'reviewer')?.start, 's5');
});

test('redact masks Anthropic keys and bearer tokens', () => {
  const s = redact('key=sk-ant-api03-abcdefghijklmnop and Authorization: Bearer abcdefghijklmnopqrstuvwx');
  assert.ok(!s.includes('abcdefghijklmnop'));
});
