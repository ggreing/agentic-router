import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESETS as PRESETS0, L3_PLANNED_AS_L2, L3_SIGNS, L3_SIZE_RULE, RULE_CONFIDENCE_THRESHOLD, TEAM_SIZE_RULE, formatTriageContext, l3SignalRoles, promptFeatures, triage, uncertainLevel, withLeadModel } from '@agentic-router/core';

// Briefs for delegated teams: L1 is lead-direct by default (decision 88), so tests of the team brief turn it off.
const DEFAULT_PRESETS = PRESETS0;
const TEAM = { ...PRESETS0, L1: { ...PRESETS0.L1, leadDirect: false } };

test('typo fix is L0', () => {
  const r = triage({ prompt: 'src/util.ts 에 있는 오타 하나 고쳐줘' });
  assert.equal(r.level, 'L0');
  assert.equal(r.source, 'rule');
});

test('a new service request is planned at L2 and keeps its L3 signs (decision 119)', () => {
  const r = triage({ prompt: '결제 처리를 위한 신규 서비스를 처음부터 설계하고 구현해줘. 아키텍처 문서도 함께.' });
  assert.deepEqual([r.kind, r.level, r.preset, r.budgetUsd, r.l3Signs], ['team', 'L2', 'L2', DEFAULT_PRESETS.L2.budgetUsd, true]);
  assert.ok(r.rationale.startsWith(L3_PLANNED_AS_L2));
  // ten or more files named: the same
  const many = triage({ prompt: 'update these: ' + Array.from({ length: L3_SIZE_RULE.files }, (_, i) => `src/m${i}/file${i}.ts`).join(', ') });
  assert.deepEqual([many.level, many.rule, many.l3Signs], ['L2', 'many-files', true]);
  assert.ok(many.rationale.startsWith(L3_PLANNED_AS_L2));
  // no rule plans L3, and only these two mark it
  for (const prompt of ['fix the typo in README.md', '태스크에 댓글 기능 넣어줘', 'Refactor the validation module across multiple files and add an audit log']) {
    assert.equal(triage({ prompt }).l3Signs, false, prompt);
  }

  // The team brief of a marked request shows the L3 team as the lead's own way up, with the first call that raises it.
  const brief = formatTriageContext(r, DEFAULT_PRESETS.L2);
  assert.match(brief, /^\[agentic-router\] level L2 /);
  assert.match(brief, /team preset L2: architect x1 @s3/);
  assert.ok(brief.includes(`If it is clearly beyond this team (${L3_SIGNS}, or edits in ${L3_SIZE_RULE.files} or more files), use the L3 team instead: make your first Agent call the L3 team's architect with the L3 values below, and the router re-plans this request as L3. When unsure, stay with this team.`));
  const l3Part = brief.split('L3 team (team preset L3):')[1]!;
  assert.match(l3Part, /^\n   - architect: subagent_type "agentic-router:architect", model "opus", effort "high"/);
  assert.equal(brief.match(/\[subtask:<ID>\]/g)!.length, 1);
  // an unmarked L2 request, a stored row without the mark, a lead-direct L3 and an L3 no first call could tell apart: no L3 text
  const plain = triage({ prompt: 'Refactor the validation module across multiple files and add an audit log' });
  assert.doesNotMatch(formatTriageContext(plain, DEFAULT_PRESETS.L2), /L3/);
  const { l3Signs: _m, ...unmarked } = r;
  assert.doesNotMatch(formatTriageContext(unmarked, DEFAULT_PRESETS.L2), /L3 team/);
  assert.doesNotMatch(formatTriageContext(r, DEFAULT_PRESETS.L2, { ...DEFAULT_PRESETS, L3: { ...DEFAULT_PRESETS.L3, leadDirect: true } }), /L3 team/);
  assert.doesNotMatch(formatTriageContext(r, DEFAULT_PRESETS.L2, { ...DEFAULT_PRESETS, L3: { ...DEFAULT_PRESETS.L3, roles: DEFAULT_PRESETS.L2.roles } }), /L3 team/);
  assert.doesNotMatch(formatTriageContext(r, DEFAULT_PRESETS.L2, DEFAULT_PRESETS.L2), /L3 team/);
  // a request the user put at L3 by hand gets the L3 team brief itself, not the way up
  assert.doesNotMatch(formatTriageContext({ ...r, level: 'L3', preset: 'L3', source: 'manual' }, DEFAULT_PRESETS.L3), /Larger team/);
});

test('questions stay cheap', () => {
  assert.equal(triage({ prompt: '이 함수는 왜 null을 반환해?' }).taskType, 'question');
});

test('"pylint" is not a lint task', () => {
  assert.notEqual(triage({ prompt: 'pylint의 pyreverse가 타입 힌트를 UML에 반영하도록 해줘' }).level, 'L0');
});

test('low confidence falls back to L1', () => {
  const r = triage({ prompt: '음' });
  assert.equal(r.level, 'L1');
  assert.equal(r.source, 'default');
  assert.ok(r.confidence < RULE_CONFIDENCE_THRESHOLD);
});

test('lead brief names the per-role start step with model and effort', () => {
  const r = triage({ prompt: '모듈 단위로 리팩터링해줘' });
  const text = formatTriageContext(r, DEFAULT_PRESETS[r.level]);
  assert.match(text, /model=(haiku|sonnet|opus), effort=/);
  assert.match(text, /\[subtask:<ID>\]/);
});

test('lead brief is directive and spells out the Agent call for every preset role', () => {
  for (const level of ['L1', 'L2', 'L3'] as const) {
    const p = TEAM[level];
    const text = formatTriageContext({ level, confidence: 0.9, source: 'rule', taskType: 'feature', preset: p.id, budgetUsd: p.budgetUsd, rationale: 'x' }, p);
    assert.match(text, /Do not edit or write files yourself/);
    for (const r of p.roles) assert.match(text, new RegExp(`subagent_type "agentic-router:${r.role}", model "(haiku|sonnet|opus|fable)", effort "\\w+"`));
    assert.match(text, /\[scope: /);
  }
});

test('English keywords need word boundaries (review #10)', () => {
  const r = triage({ prompt: 'fix typo: optional is misspelled in README.md' });
  assert.equal(r.level, 'L0');
  assert.doesNotMatch(r.rationale, /new API|small feature/);
  const rapid = triage({ prompt: 'make the rapid prefix handling in node_modules docs clearer' });
  assert.doesNotMatch(rapid.rationale, /new API|module-level|bug fix/);
});

test('pasted stack traces and code blocks do not count as mentioned files (review #9)', () => {
  const frames = Array.from({ length: 10 }, (_, i) => `    at fn${i} (src/mod${i}/file${i}.ts:${i + 1}:5)`).join('\n');
  const r = triage({ prompt: `parseConfig throws on empty input, please fix\nTypeError: Cannot read properties of undefined\n${frames}` });
  assert.notEqual(r.level, 'L3');
  assert.doesNotMatch(r.rationale, /10 files/);
  assert.match(r.rationale, /log attached/);
  assert.equal(r.taskType, 'debug');
  const imports = '```ts\n' + Array.from({ length: 6 }, (_, i) => `import { x${i} } from './lib/m${i}.ts';`).join('\n') + '\n```';
  assert.doesNotMatch(triage({ prompt: `이 파일 맨 위 import 정리해줘\n${imports}` }).rationale, /\d+ files/);
});

test('a question about a failure is a debugging task, not an L0 question (review #11)', () => {
  const r = triage({ prompt: 'Why does the build fail on Windows only?' });
  assert.equal(r.taskType, 'debug');
  assert.notEqual(r.level, 'L0');
  assert.equal(triage({ prompt: 'What does the slugify helper return for empty strings?' }).taskType, 'question');
});

test('worktree isolation is only asked for when writers run in parallel (decision 83)', () => {
  const brief = (level: 'L0' | 'L1' | 'L2' | 'L3') => {
    const p = TEAM[level];
    return formatTriageContext({ level, confidence: 0.9, source: 'rule', taskType: 'feature', preset: p.id, budgetUsd: p.budgetUsd, rationale: 'x' }, p);
  };
  assert.match(brief('L1'), /Do not pass isolation/); assert.doesNotMatch(brief('L1'), /isolation "worktree"/);
  for (const l of ['L2', 'L3'] as const) assert.match(brief(l), /isolation "worktree"/);
  assert.match(brief('L1'), /task-notification/);
});

test('L0 and L1 are handled by the lead directly by default; team briefs keep the lead from reading files and re-running checks (decisions 87, 88)', () => {
  const brief = (level: 'L0' | 'L1' | 'L2' | 'L3', presets = DEFAULT_PRESETS) => {
    const p = presets[level];
    return formatTriageContext({ level, confidence: 0.9, source: 'rule', taskType: 'edit', preset: p.id, budgetUsd: p.budgetUsd, rationale: 'x' }, p);
  };
  for (const l of ['L0', 'L1'] as const) {
    assert.equal(DEFAULT_PRESETS[l].leadDirect, true);
    assert.match(brief(l), /handled by you directly/);
    assert.doesNotMatch(brief(l), /subagent_type/);
  }
  for (const l of ['L1', 'L2', 'L3'] as const) {
    assert.match(brief(l, TEAM), /Do not open or read source files to plan/);
    assert.match(brief(l, TEAM), /do not re-run them/);
  }
});

// ------------------------------------------------------------------ three-way answer (decisions 104-111)

test('stage 1 answers direct, team or uncertain, and the level follows the answer', () => {
  const cases: Array<[string, 'direct' | 'team' | 'uncertain', 'L0' | 'L1' | 'L2' | 'L3', string]> = [
    ['fix the typo in README.md', 'direct', 'L0', 'l0-keyword'],
    ['Fix the typo in the error message in src/a/x.ts', 'direct', 'L0', 'l0-keyword'],
    ['Fix the bug where parse() fails on empty input in src/parse.ts', 'direct', 'L1', 'small-fix'],
    ['Also fix the bug in src/b/y.ts where it fails on empty input', 'direct', 'L1', 'small-fix'],
    ['이 함수는 왜 null을 반환해?', 'direct', 'L0', 'question'],
    ['Refactor the validation module across multiple files and add an audit log', 'team', 'L2', 'stated-breadth'],
    ['Add a pagination module and refactor the API layer across multiple files', 'team', 'L2', 'stated-breadth'],
    ['결제 처리를 위한 신규 서비스를 처음부터 설계하고 구현해줘. 아키텍처 문서도 함께.', 'team', 'L2', 'l3-keyword'],
    ['태스크에 댓글 기능 넣어줘', 'uncertain', 'L1', 'none'],
    ['convert the data access layer from callbacks to async/await', 'uncertain', 'L1', 'none'],
    ['src/parse.ts', 'uncertain', 'L1', 'none'],
    ['', 'uncertain', 'L1', 'none'],
  ];
  for (const [prompt, kind, level, rule] of cases) {
    const r = triage({ prompt });
    assert.deepEqual([r.kind, r.level, r.rule], [kind, level, rule], prompt);
    assert.equal(r.source, kind === 'uncertain' ? 'default' : 'rule', prompt);
    assert.equal(r.confidence < RULE_CONFIDENCE_THRESHOLD, kind === 'uncertain', prompt);
    assert.ok(r.teamScore >= 0 && r.teamScore <= 1);
    assert.notEqual(r.level, 'L3', prompt);
  }
});

test('the size of the request is not the size of the change', () => {
  // a long bug report with a stack trace and environment details is still one fix
  const frames = Array.from({ length: 12 }, (_, i) => `    at fn${i} (/app/src/mod${i}/file${i}.ts:${i + 1}:5)`).join('\n');
  const report = `Production crash after the last deploy.\n\nTypeError: Cannot read properties of undefined (reading 'lines')\n${frames}\n\n`
    + 'Environment: Node 24, Postgres 16. '.repeat(30) + '\nExpected: an order without a shipment renders with a total of 0. Please fix and add a regression test.';
  assert.notEqual(triage({ prompt: report }).kind, 'team');
  // naming four files does not make a team (tests and helpers are named too) ...
  const four = '캐시에 TTL 옵션을 넣어 주세요. 손댈 곳은 `src/cache/cache.ts`, `src/config/schema.ts`, `test/cache/cache.test.ts`이고 시계는 `src/util/clock.ts`에 있습니다.';
  assert.equal(triage({ prompt: four }).kind, 'uncertain');
  // ... a long list does
  const six = 'update these: src/a/one.ts, src/a/two.ts, src/b/three.ts, src/b/four.ts, src/c/five.ts, src/c/six.ts';
  assert.deepEqual([triage({ prompt: six }).kind, triage({ prompt: six }).rule], ['team', 'many-files']);
  // "all of them" is never settled as a small direct change, even with an L0 word in it
  assert.equal(triage({ prompt: '에러 메시지를 전부 메시지 키로 바꾸고 한국어/영어 카탈로그 붙여줘' }).kind, 'uncertain');
  assert.equal(triage({ prompt: 'fix the typo in every error message' }).kind, 'uncertain');
});

test('with a lead that delegates L1, an uncertain request gets the L2 team and staffs it itself (decision 121)', () => {
  const prompt = '태스크에 댓글 기능 넣어줘';
  const opus = withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5');
  const haiku = withLeadModel(DEFAULT_PRESETS, 'claude-haiku-5-5');
  const sonnet = withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5');
  assert.deepEqual([uncertainLevel(DEFAULT_PRESETS), uncertainLevel(haiku), uncertainLevel(sonnet), uncertainLevel(opus)], ['L1', 'L1', 'L2', 'L2']);
  // L2 lead-direct as well (teams.yaml): nothing to delegate to, so the request stays L1
  assert.equal(uncertainLevel({ ...opus, L2: { ...opus.L2, leadDirect: true } }), 'L1');

  // a lead that handles L1 itself: as before, lead-direct with the rubric
  const s = triage({ prompt }, haiku);
  assert.deepEqual([s.kind, s.level, s.preset, s.source], ['uncertain', 'L1', 'L1', 'default']);
  assert.match(s.rationale, /-> start as L1, the lead decides$/);
  assert.match(formatTriageContext(s, haiku[s.level], haiku), /handled by you directly/);

  // a lead that delegates L1: the L2 team, still uncertain (source 'default', low confidence), the lead picks the roles
  const o = triage({ prompt }, opus);
  assert.deepEqual([o.kind, o.level, o.preset, o.budgetUsd, o.source, o.rule], ['uncertain', 'L2', 'L2', DEFAULT_PRESETS.L2.budgetUsd, 'default', 'none']);
  assert.ok(o.confidence < RULE_CONFIDENCE_THRESHOLD);
  assert.match(o.rationale, /-> L2 team, the lead picks the roles$/);
  const brief = formatTriageContext(o, opus[o.level], opus);
  assert.match(brief, /^\[agentic-router\] level L2 \(source=default/);
  assert.match(brief, /Do not edit or write files yourself/);
  assert.match(brief, new RegExp(`the staffing is yours: call only the roles the change needs\\. One coder subtask alone is right for a small change \\(fewer than ${TEAM_SIZE_RULE.files} files, one module\\)`));
  assert.match(brief, new RegExp(`${TEAM_SIZE_RULE.dirs} or more modules or layers`));
  for (const r of DEFAULT_PRESETS.L2.roles) assert.match(brief, new RegExp(`subagent_type "agentic-router:${r.role}"`));
  assert.doesNotMatch(brief, /handled by you directly|L3/);

  // requests settled as small use the one-coder L1 team; settled team requests get no staffing line
  const small = triage({ prompt: 'Fix the bug where parse() fails on empty input in src/parse.ts' }, opus);
  assert.deepEqual([small.kind, small.level, small.preset], ['direct', 'L1', 'L1']);
  const smallBrief = formatTriageContext(small, opus[small.level], opus);
  assert.match(smallBrief, /team preset L1: coder x1 @s1/);
  assert.doesNotMatch(smallBrief, /the staffing is yours/);
  const wide = triage({ prompt: 'Refactor the validation module across multiple files and add an audit log' }, opus);
  assert.doesNotMatch(formatTriageContext(wide, opus[wide.level], opus), /the staffing is yours/);
  // trivial requests stay with the lead whatever the lead model
  const typo = triage({ prompt: 'fix the typo in README.md' }, opus);
  assert.match(formatTriageContext(typo, opus[typo.level], opus), /handled by you directly/);
});

test('a written specification with sections, declared types and many requirements is a team request', () => {
  const spec = ['taskboard에 태스크 댓글 기능을 추가해 주세요. 저장소, 서비스, 핸들러에 각각 맞게 나눠서 구현합니다.', '', '## 모델', '```ts', 'interface Comment { id: string; taskId: string; body: string }', '```', '',
    '## 요구 사항', ...Array.from({ length: 9 }, (_, i) => `${i + 1}. 요구 사항 ${i + 1}: ${'댓글을 작성자만 수정할 수 있고 실패하면 정해진 에러로 응답합니다. '.repeat(3)}`)].join('\n');
  const r = triage({ prompt: spec });
  assert.deepEqual([r.kind, r.level, r.rule], ['team', 'L2', 'written-spec']);
  // the same amount of text without the structure is left to stage 2
  assert.equal(triage({ prompt: spec.replace(/^## .*$/gm, '').replace(/```[\s\S]*?```/, '').replace(/^\d+\. /gm, '') }).kind, 'uncertain');
});

test('features are numbers and categories, never prompt text', () => {
  const secret = 'ZZTOPSECRETZZ';
  const f = promptFeatures(`Fix the bug in \`${secret}\` handling, see src/${secret}.ts\n\n## Steps\n- one\n- two\n1. three\n\`\`\`ts\ninterface ${secret} { a: string }\n\`\`\`\nhttps://example.com/${secret}`);
  assert.ok(!JSON.stringify(f).includes(secret));
  for (const v of Object.values(f)) assert.ok(typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 12));
  assert.deepEqual([f.headings, f.bullets, f.numberedItems, f.codeFences, f.typeDecls, f.filePaths, f.urls], [1, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(triage({ prompt: 'fix the typo in README.md' }).features, promptFeatures('fix the typo in README.md'));
  assert.ok(Number(promptFeatures('오타를 고쳐 주세요').hangulRatio) > 0.9);
});

test('an uncertain lead-direct request gets the rubric and the L2 call values; a settled one does not', () => {
  const t = triage({ prompt: '태스크에 댓글 기능 넣어줘' });
  const text = formatTriageContext(t, DEFAULT_PRESETS.L1);
  assert.match(text, /^\[agentic-router\] level L1 \(source=default, confidence=0\.\d\d\)/);
  assert.match(text, /handled by you directly/);
  assert.match(text, new RegExp(`${TEAM_SIZE_RULE.files} or more files`));
  assert.match(text, new RegExp(`${TEAM_SIZE_RULE.dirs} or more modules`));
  for (const r of DEFAULT_PRESETS.L2.roles) assert.match(text, new RegExp(`subagent_type "agentic-router:${r.role}", model "(haiku|sonnet|opus)", effort "\\w+"`));
  assert.match(text, /\[subtask:<ID>\]/);
  // decision 113: the L3 team is offered too, with a higher bar and the call that tells the router "L3"
  assert.match(text, new RegExp(`Which team: the L2 team, unless the change is clearly beyond it: ${L3_SIGNS}, or edits in ${L3_SIZE_RULE.files} or more files\\.`));
  assert.match(text, /When unsure between the two, use L2\./);
  assert.match(text, /as L3 when that call is the L3 team's architect, coder or reviewer with the L3 values below, as L2 for any other call/);
  const [l2Part, l3Part] = text.split('L3 team (team preset L3); make your first call the architect:');
  assert.match(l2Part!, /L2 team \(team preset L2\):\n   - architect: subagent_type "agentic-router:architect", model "sonnet", effort "medium"/);
  assert.match(l3Part!, /^\n   - architect: subagent_type "agentic-router:architect", model "opus", effort "high"/);
  assert.match(l3Part!, /agentic-router:ui-designer/);
  assert.equal(text.match(/\[subtask:<ID>\]/g)!.length, 1);
  assert.ok(L3_SIZE_RULE.files > TEAM_SIZE_RULE.files);
  // the roles that signal L3: in both teams, at a different start step (the tester starts at s1 in both)
  assert.deepEqual(l3SignalRoles(DEFAULT_PRESETS.L2, DEFAULT_PRESETS.L3), ['architect', 'coder', 'reviewer']);
  // the escalation teams are the ones passed in (a customised teams.yaml); a single preset is the L2 team alone
  const custom = { ...DEFAULT_PRESETS.L2, roles: [{ role: 'coder' as const, count: 1, start: 's3' as const }] };
  const customText = formatTriageContext(t, DEFAULT_PRESETS.L1, custom);
  assert.match(customText, /agentic-router:coder", model "sonnet", effort "medium"/);
  assert.match(customText, /re-plans this request as L2 at your first call/);
  assert.doesNotMatch(customText, /agentic-router:architect|L3/);
  const both = formatTriageContext(t, DEFAULT_PRESETS.L1, { ...DEFAULT_PRESETS, L2: custom });
  assert.match(both, /as L3 when that call is the L3 team's coder with the L3 values below/);
  assert.match(both, /make your first call the coder:/);
  // no L3 path when the first call could not tell the teams apart, or when L3 is lead-direct
  const same = formatTriageContext(t, DEFAULT_PRESETS.L1, { L2: DEFAULT_PRESETS.L2, L3: { ...DEFAULT_PRESETS.L3, roles: DEFAULT_PRESETS.L2.roles } });
  assert.match(same, /re-plans this request as L2 at your first call/);
  assert.doesNotMatch(same, /Which team/);
  assert.doesNotMatch(formatTriageContext(t, DEFAULT_PRESETS.L1, { L2: DEFAULT_PRESETS.L2, L3: { ...DEFAULT_PRESETS.L3, leadDirect: true } }), /Which team/);
  assert.doesNotMatch(formatTriageContext(t, DEFAULT_PRESETS.L1, { L2: DEFAULT_PRESETS.L2 }), /Which team/);
  // settled direct: the short brief, no call values
  const direct = formatTriageContext(triage({ prompt: 'fix the typo in README.md' }), DEFAULT_PRESETS.L0);
  assert.doesNotMatch(direct, /subagent_type|or more files/);
  // uncertain with L1 delegated by configuration: the ordinary team brief
  assert.match(formatTriageContext(t, TEAM.L1), /Do not edit or write files yourself/);
  // a stored result without the new fields (older ledger rows) still formats
  const { kind: _k, rule: _r, teamScore: _s, features: _f, ...old } = t;
  assert.match(formatTriageContext(old, DEFAULT_PRESETS.L1), /handled by you directly/);
});
