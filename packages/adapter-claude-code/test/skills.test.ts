import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS, formatTriageContext, triage, L3_SIZE_RULE, L3_SIGNS, l3SignalRoles } from '@do-it-all-claude-code/core';

const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin');
const read = (p: string) => fs.readFileSync(path.join(pluginDir, p), 'utf8');

function frontMatter(md: string): { fm: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(m, 'SKILL.md has front matter');
  return { fm: m![1]!, body: m![2]! };
}

test('lead-orchestrator skill: front matter names the trigger and the delegate-even-small rule', () => {
  const { fm } = frontMatter(read('skills/lead-orchestrator/SKILL.md'));
  assert.match(fm, /^name:\s*lead-orchestrator/m);
  assert.match(fm, /description:/);
  // description must make the trigger and the "don't do it yourself, even small" point discoverable
  assert.match(fm, /\[do-it-all-claude-code\] level/);
  assert.match(fm, /small/i);
  assert.match(fm, /delegat/i);
});

test('lead-orchestrator skill: body spells out the Agent call with the real parameter names', () => {
  const { body } = frontMatter(read('skills/lead-orchestrator/SKILL.md'));
  for (const token of ['subagent_type', 'description', 'prompt', 'model', 'effort'])
    assert.ok(body.includes(token), `body mentions ${token}`);
  // decision 84: cost comes from the subagent transcript, so the skill must not require foreground.
  assert.ok(!/run_in_background:\s*false/.test(body), 'skill no longer mandates foreground (run_in_background: false)');
  assert.match(body, /\[subtask:<ID>\]/);
  assert.match(body, /\[scope:/);
  assert.match(body, /do-it-all-claude-code:coder/);
  assert.match(body, /\[router:awaiting-user\]/);
  // the later detail sections are retained
  for (const re of [/verify/i, /step/i, /HITL/i, /merge/i])
    assert.match(body, re);
});

test('skill covers async task-notifications and the before-done verification gate', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // async: Agent calls return later as task-notifications; wait for all before merging/answering
  assert.match(body, /task-notification/i);
  assert.match(body, /asynchronous/i);
  assert.match(body, /every\*{0,2}\s*subtask/i);   // tolerate markdown bold: **every** subtask
  // before reporting done: confirm the change is in the user's working tree, not just a worktree
  assert.match(body, /git status|git diff/i);
  assert.match(body, /working tree/i);
  assert.match(body, /worktree/i);
});

test('skill is brief-driven (decision 87/88): handle-yourself vs delegate, no hardcoded level, no source reading, trust verify', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // the brief decides; lead-direct is configurable via teams.yaml lead_direct (not a fixed level)
  assert.match(body, /handle it \*{0,2}yourself|handle the small change \*{0,2}yourself/i);
  assert.match(body, /lead[_-]direct/i);
  assert.match(body, /teams\.yaml/i);
  assert.match(body, /delegat/i);
  // don't read source to plan — hand the request as the spec
  assert.match(body, /do not open or read source files|not\*{0,2} from reading the source/i);
  // trust the router's injected verify result; don't re-run build/tests; check with git diff --stat
  assert.match(body, /do not re-run/i);
  assert.match(body, /verify result/i);
  assert.match(body, /git diff --stat/);
});

test('skill encodes the decision-83 isolation rule and the worktree merge procedure', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  assert.match(body, /isolation:\s*"worktree"/);              // the Agent param
  assert.match(body, /runs alone|writer that ran alone|alone gets no/i); // lone writer: no isolation
  assert.match(body, /two or more/i);                         // only concurrent writers isolate
  // merge only concurrent worktree writers, with concrete commands
  assert.match(body, /git merge --no-ff/);
  assert.match(body, /git worktree remove/);
  assert.match(body, /worktree-agent-<agentId>/);
});

test('skill does not contradict the injected brief: the lead does not edit files itself', () => {
  const md = read('skills/lead-orchestrator/SKILL.md');
  // The injected formatTriageContext says "Do not edit or write files yourself"; the skill must agree
  // and must NOT tell the lead to handle a level by editing directly (the old "L0: do it yourself" line).
  assert.match(md, /do not edit or write files yourself/i);
  assert.ok(!/do it yourself \(or (a|one) /i.test(md), 'no "do it yourself" delegation-bypass remains');
});

test('skill subagent types line up with every role the presets can assign', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  const roles = new Set<string>();
  for (const preset of Object.values(DEFAULT_PRESETS)) for (const r of preset.roles) roles.add(r.role);
  for (const role of roles)
    assert.ok(body.includes(`do-it-all-claude-code:${role}`), `skill lists do-it-all-claude-code:${role}`);
});

test('the injected brief and the skill share the same prompt-line markers', () => {
  // Guard against drift: if core changes the marker wording, this fails so the skill is updated too.
  // Use a DELEGATING preset (some levels are lead-direct, decision 87+); the markers only appear there.
  const delegating = Object.values(DEFAULT_PRESETS).find(p => !p.leadDirect);
  const body = read('skills/lead-orchestrator/SKILL.md');
  assert.ok(body.includes('[subtask:<ID>]') && body.includes('[scope:') && body.includes('do-it-all-claude-code:'), 'skill documents the markers');
  if (!delegating) { assert.ok(true, 'all presets are lead-direct; no delegating brief to compare'); return; }
  const brief = formatTriageContext({ ...triage({ prompt: 'x' }), level: delegating.level, preset: delegating.id }, delegating);
  assert.ok(brief.includes('[subtask:<ID>]'), 'brief has [subtask:<ID>]');
  assert.ok(brief.includes('[scope:'), 'brief has [scope:');
  assert.ok(brief.includes('do-it-all-claude-code:'), 'brief has do-it-all-claude-code:');
  assert.match(brief, /Do not edit or write files yourself/);
});

test('skill covers the uncertain-size escalation and shares the brief\'s rubric/markers (decisions 104-113)', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // the uncertain brief: lead-direct preset + stage-1 kind 'uncertain' -> rubric + L2/L3 call values.
  const t = triage({ prompt: 'improve this' });
  assert.equal((t as { kind?: string }).kind, 'uncertain', 'test prompt yields an uncertain stage-1 result');
  // escalation defaults to DEFAULT_PRESETS ({ L2, L3 }), so the brief carries the L3 path (decision 113).
  const brief = formatTriageContext(t, DEFAULT_PRESETS[t.level]);
  assert.match(brief, /could not tell the size/i);

  // the L2 size rubric numbers must match between the brief and the skill (drift guard)
  assert.match(brief, /\b4 or more files\b/);
  assert.match(brief, /\b2 or more\b/);
  assert.match(body, /4 or more files/);
  assert.match(body, /2 or more/);
  assert.match(body, /do not explore just to decide|Don't explore just to decide/i);

  // the L3 escalation threshold + signs come from core, so this follows if the provisional values change
  assert.ok(brief.includes(`${L3_SIZE_RULE.files} or more files`), 'brief states the L3 file threshold');
  assert.ok(brief.includes(L3_SIGNS), 'brief lists the L3 signs');
  assert.ok(body.includes(`${L3_SIZE_RULE.files} or more files`), 'skill states the L3 file threshold');
  assert.ok(body.includes(L3_SIGNS), 'skill lists the L3 signs');

  // the role whose first call signals L3: the brief names it for the first call, the skill mentions it
  const signal = l3SignalRoles(DEFAULT_PRESETS.L2, DEFAULT_PRESETS.L3);
  assert.ok(signal.length > 0, 'default presets have an L3-signalling first-call role');
  assert.ok(brief.includes(`make your first call the ${signal[0]}`), 'brief names the first-call L3 role');
  assert.ok(body.includes(signal[0]!), 'skill mentions the first-call L3 role');

  // the escalation brief carries the team Agent-call markers the skill also documents
  assert.ok(brief.includes('do-it-all-claude-code:') && body.includes('do-it-all-claude-code:'));
  assert.ok(brief.includes('[subtask:<ID>]') && brief.includes('[scope:'));
  assert.match(body, /re-plans|re-plan/i);
});

test('router skill documents both commands', () => {
  const md = read('skills/router/SKILL.md');
  assert.match(md, /^name:\s*router/m);
  assert.match(md, /\/router level/);
  assert.match(md, /\/router resume/);
});
