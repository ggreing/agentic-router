import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toRouterEvent, leadModelFromTranscript } from '@agentic-router/adapter-claude-code';
import { leadModelClass, withLeadModel, DEFAULT_PRESETS } from '@agentic-router/core';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readUtf8 = (p: string) => fs.readFileSync(p, 'utf8');
function hookInputs(file: string): Record<string, unknown>[] {
  return readUtf8(path.join(fixturesDir, file)).split(/\r?\n/).filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(r => r.input && typeof r.input === 'object' && (r.input as Record<string, unknown>).hook_event_name)
    .map(r => r.input as Record<string, unknown>);
}
const inputs = hookInputs('spike-leadmodel.jsonl');
const bySource = (src: string) => inputs.find(i => i.hook_event_name === 'SessionStart' && i.source === src)!;

test('decision 117: SessionStart that carries a top-level model fills RouterEvent.leadModel', () => {
  const ev = toRouterEvent(bySource('startup'));
  assert.equal(ev.type, 'session_start');
  assert.equal(ev.leadModel, 'claude-opus-4-8');
});

test('decision 117: events without a top-level model leave leadModel undefined', () => {
  // SessionStart does not always include model (Claude Code 2.1.322), and UserPromptSubmit never does.
  assert.equal(toRouterEvent(bySource('resume')).leadModel, undefined);
  const prompt = inputs.find(i => i.hook_event_name === 'UserPromptSubmit')!;
  const pev = toRouterEvent(prompt);
  assert.equal(pev.type, 'prompt_submit');
  assert.equal(pev.leadModel, undefined);
});

test('the lead-model fixture converts cleanly and covers the SessionStart/UserPromptSubmit shapes', () => {
  for (const i of inputs) assert.ok(toRouterEvent(i).type);
  assert.ok(inputs.some(i => i.hook_event_name === 'SessionStart'));
  assert.ok(inputs.some(i => i.hook_event_name === 'UserPromptSubmit'));
});

test('leadModelFromTranscript returns the LAST assistant model (reflects a mid-session /model switch)', () => {
  // transcript-main.jsonl switches sonnet -> opus; a malformed trailing line must be skipped.
  const model = leadModelFromTranscript(path.join(fixturesDir, 'transcript-main.jsonl'), readUtf8);
  assert.equal(model, 'claude-opus-4-8');
});

test('leadModelFromTranscript reads only message.model, never the message content', () => {
  // content names a different model; the result must still come from message.model.
  const transcript =
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n' +
    '{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"text","text":"mentioning claude-opus-4-8 and claude-sonnet-5-5 in prose"}]}}\n';
  assert.equal(leadModelFromTranscript('/x/t.jsonl', () => transcript), 'claude-haiku-5-5');
});

test('leadModelFromTranscript is null for a missing path, an unreadable file, or no assistant line yet', () => {
  assert.equal(leadModelFromTranscript(undefined, readUtf8), null);
  assert.equal(leadModelFromTranscript('/missing', () => { throw new Error('ENOENT'); }), null);
  // before the first reply the transcript may hold only the user line
  const onlyUser = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"start"}]}}\n';
  assert.equal(leadModelFromTranscript('/x/t.jsonl', () => onlyUser), null);
  // an assistant line without a model is not a match
  const noModel = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}\n';
  assert.equal(leadModelFromTranscript('/x/t.jsonl', () => noModel), null);
});

test('the resolved lead model drives core delegation tiers end to end (decision 117)', () => {
  // the id the adapter surfaces -> core tier -> where delegation starts.
  const fromTranscript = leadModelFromTranscript(path.join(fixturesDir, 'transcript-main.jsonl'), readUtf8);
  assert.equal(leadModelClass(fromTranscript ?? undefined), 'opus');

  // an Opus-class lead delegates from L1; a Sonnet-class lead keeps L1 lead-direct.
  const opusPresets = withLeadModel(DEFAULT_PRESETS, 'claude-opus-4-8');
  assert.equal(opusPresets.L1.leadDirect ?? false, false, 'Opus lead: L1 is delegated');
  const sonnetPresets = withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5');
  assert.equal(sonnetPresets.L1.leadDirect, true, 'Sonnet lead: L1 is handled directly');
  // L0 is always lead-direct regardless of lead model.
  assert.equal(opusPresets.L0.leadDirect, true);
});
