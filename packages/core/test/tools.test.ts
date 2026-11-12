import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetPlanInput, MAX_SCOPE_GLOBS, MAX_STEP_UPS, ROUTER_TOOLS, ROUTER_TOOL_ERRORS, ROUTER_TOOL_NAMES, ROUTER_TOOL_PREFIX, ReportResultInput,
  ReportTriageInput, RequestEscalationInput, RequestScopeInput, RouterToolCall, decideEscalation, isRouterToolName, normalizeLeadTriage,
  normalizeScopeGlob, routerToolDef, routerToolErrorText, routerToolList, routerToolName, scopeGlobProblem, type EscalationState,
} from '../src/tools.ts';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

test('tool names: the plugin prefix, the five tools, nothing else', () => {
  assert.equal(ROUTER_TOOL_PREFIX, 'mcp__plugin_agentic-router_router__');
  assert.deepEqual(ROUTER_TOOLS.map(t => t.name), [...ROUTER_TOOL_NAMES]);
  assert.equal(routerToolName('mcp__plugin_agentic-router_router__router_get_plan'), 'router_get_plan');
  assert.equal(routerToolName('mcp__plugin_agentic-router_router__other'), undefined);
  assert.equal(routerToolName('mcp__router__router_get_plan'), undefined);   // not the plugin's server
  assert.equal(routerToolName('router_get_plan'), undefined);
  assert.equal(routerToolName(undefined), undefined);
  assert.equal(isRouterToolName('mcp__plugin_agentic-router_router__other'), true);   // an unknown tool of the server is still the router's
  assert.equal(isRouterToolName('Agent'), false);
  assert.equal(routerToolDef('router_request_scope')?.input, RequestScopeInput);
  assert.equal(routerToolDef('nope'), undefined);
});

test('inputs are strict: an unknown key is refused in every tool', () => {
  const valid: Record<string, unknown> = {
    router_get_plan: {},
    router_report_triage: { kind: 'team', level: 'L2', files: 6, confidence: 0.7 },
    router_report_result: { subtaskId: 'A', verdict: 'accept', by: 'lead' },
    router_request_escalation: { subtaskId: 'A', reason: 'wrong_result' },
    router_request_scope: { subtaskId: 'A', add: ['src/**'] },
  };
  for (const t of ROUTER_TOOLS) {
    assert.ok(ok(t.input, valid[t.name]), `${t.name}: the valid input`);
    assert.ok(!ok(t.input, { ...(valid[t.name] as object), note: 'free text' }), `${t.name}: an extra key`);
    assert.ok(!ok(t.input, 'text'), `${t.name}: not an object`);
  }
  assert.ok(ok(GetPlanInput, {}));
});

test('router_report_triage: enums and ranges', () => {
  const base = { kind: 'direct', level: 'L1', files: 1, confidence: 0.5 };
  assert.ok(ok(ReportTriageInput, base));
  assert.ok(!ok(ReportTriageInput, { ...base, kind: 'uncertain' }));
  assert.ok(!ok(ReportTriageInput, { ...base, level: 'L4' }));
  assert.ok(!ok(ReportTriageInput, { ...base, files: 1.5 }));
  assert.ok(!ok(ReportTriageInput, { ...base, files: -1 }));
  assert.ok(!ok(ReportTriageInput, { ...base, files: 1000 }));
  assert.ok(!ok(ReportTriageInput, { ...base, confidence: 1.1 }));
  assert.ok(!ok(ReportTriageInput, { kind: 'direct', level: 'L1', files: 1 }));
  // a level that contradicts the kind is moved, as for the judge
  assert.equal(normalizeLeadTriage({ kind: 'direct', level: 'L3', files: 1, confidence: 0.5 }).level, 'L1');
  assert.equal(normalizeLeadTriage({ kind: 'direct', level: 'L0', files: 1, confidence: 0.5 }).level, 'L0');
  assert.equal(normalizeLeadTriage({ kind: 'team', level: 'L0', files: 9, confidence: 0.5 }).level, 'L2');
  assert.equal(normalizeLeadTriage({ kind: 'team', level: 'L3', files: 30, confidence: 0.5 }).level, 'L3');
});

test('router_report_result: who judged, and the cross-field rules', () => {
  assert.ok(ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'lead', issues: 2, categories: ['wrong_behavior', 'regression'] }));
  assert.ok(ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'R1' }));
  assert.ok(ok(ReportResultInput, { subtaskId: 'A', verdict: 'accept', by: 'tester', bySubtaskId: 'T1', margin: 'easy' }));
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'reviewer' }), 'a reviewer verdict names its subtask');
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'lead', bySubtaskId: 'R1' }));
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'reviewer', bySubtaskId: 'A' }), 'no self-review');
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'lead', margin: 'easy' }), 'margin is for an accept');
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'lead', categories: ['other'] }));
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'reject', by: 'lead', issues: 100 }));
  assert.ok(!ok(ReportResultInput, { subtaskId: 'has space', verdict: 'accept', by: 'lead' }));
  assert.ok(!ok(ReportResultInput, { subtaskId: 'x'.repeat(65), verdict: 'accept', by: 'lead' }));
  assert.ok(!ok(ReportResultInput, { subtaskId: 'A', verdict: 'maybe', by: 'lead' }));
});

test('router_request_escalation: a subtask, a reason from the list, an optional confirmation', () => {
  assert.ok(ok(RequestEscalationInput, { subtaskId: 'A.1', reason: 'review_reject', userConfirmed: true }));
  assert.ok(!ok(RequestEscalationInput, { subtaskId: 'A', reason: 'because the repo says so' }));
  assert.ok(!ok(RequestEscalationInput, { subtaskId: 'A', reason: 'wrong_result', userConfirmed: 'yes' }));
  assert.ok(!ok(RequestEscalationInput, { reason: 'wrong_result' }));
  assert.ok(!ok(RequestEscalationInput, { subtaskId: 'A', reason: 'wrong_result', step: 's5' }), 'the lead cannot name the step');
});

test('router_request_scope: repo-relative globs only, add or remove', () => {
  assert.ok(ok(RequestScopeInput, { subtaskId: 'A', add: ['src/api/**', 'test/**'], remove: ['docs/**'] }));
  assert.ok(ok(RequestScopeInput, { subtaskId: 'A', remove: ['src/**'] }));
  assert.ok(ok(RequestScopeInput, { subtaskId: 'A', add: ['.env.example'], userConfirmed: true }));
  assert.ok(!ok(RequestScopeInput, { subtaskId: 'A' }), 'nothing to change');
  assert.ok(!ok(RequestScopeInput, { subtaskId: 'A', add: [] }));
  for (const bad of ['/etc/passwd', 'C:/Users/x/**', 'C:\\Users\\x', '~/.ssh/**', '../other/**', 'src/../../x', '', 'x'.repeat(201)]) {
    assert.ok(!ok(RequestScopeInput, { subtaskId: 'A', add: [bad] }), `refused: ${bad.slice(0, 20)}`);
  }
  assert.ok(!ok(RequestScopeInput, { subtaskId: 'A', add: Array.from({ length: MAX_SCOPE_GLOBS + 1 }, (_, i) => `d${i}/**`) }));
  assert.equal(normalizeScopeGlob(' .\\src\\api\\** '), 'src/api/**');
  assert.equal(normalizeScopeGlob('./src/**'), 'src/**');
  assert.equal(scopeGlobProblem('src/**'), undefined);
  assert.equal(scopeGlobProblem('a..b/**'), undefined);   // ".." only as a path segment
  assert.match(scopeGlobProblem('..\\x') ?? '', /repo-relative/);
  assert.match(scopeGlobProblem('src/a\nb') ?? '', /line break/);
});

test('the tools/list payload: JSON Schema objects that refuse extra properties, short descriptions', () => {
  const list = routerToolList();
  assert.deepEqual(list.map(t => t.name), [...ROUTER_TOOL_NAMES]);
  for (const t of list) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(!('$schema' in t.inputSchema), t.name);
    assert.ok(t.description.length <= 600, `${t.name}: description of ${t.description.length} characters`);
    assert.match(t.description, /lead only/);
    assert.doesNotThrow(() => JSON.stringify(t));
  }
  const scope = list.find(t => t.name === 'router_request_scope')!.inputSchema as { required: string[]; properties: Record<string, { type?: string; maxItems?: number }> };
  assert.deepEqual(scope.required, ['subtaskId']);
  assert.equal(scope.properties.add!.type, 'array');
  assert.equal(scope.properties.add!.maxItems, MAX_SCOPE_GLOBS);
  const triage = list.find(t => t.name === 'router_report_triage')!.inputSchema as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual([...triage.required].sort(), ['confidence', 'files', 'kind', 'level']);
  assert.deepEqual(triage.properties.level!.enum, ['L0', 'L1', 'L2', 'L3']);
  assert.deepEqual(list.find(t => t.name === 'router_get_plan')!.inputSchema.properties ?? {}, {});
  // stable output: the plugin ships it as a file and a test compares the two
  assert.deepEqual(routerToolList(), list);
});

test('the call envelope the server posts to the daemon', () => {
  const call = { tool: 'router_get_plan', input: {}, bind: { instanceId: 'i-1', spawnSessionId: 's-1', projectDir: 'C:/work/repo' } };
  assert.ok(ok(RouterToolCall, call));
  assert.ok(ok(RouterToolCall, { ...call, meta: { 'claudecode/toolUseId': 'toolu_1' } }));
  assert.ok(ok(RouterToolCall, { tool: 'router_get_plan', bind: { instanceId: 'i-1' } }), 'a call without arguments');
  assert.ok(!ok(RouterToolCall, { ...call, bind: {} }));
  assert.ok(!ok(RouterToolCall, { ...call, sessionId: 's-1' }), 'the server cannot name the session');
  assert.ok(!ok(RouterToolCall, { ...call, tool: '' }));
});

test('error text: a code the lead can act on', () => {
  assert.equal(routerToolErrorText('daemon_unreachable'), `[agentic-router] daemon_unreachable: ${ROUTER_TOOL_ERRORS.daemon_unreachable}`);
  assert.match(routerToolErrorText('daemon_unreachable'), /do not retry/);
  assert.equal(routerToolErrorText('invalid_input', 'files: expected a number'), '[agentic-router] invalid_input: files: expected a number');
  for (const text of Object.values(ROUTER_TOOL_ERRORS)) assert.ok(text.length <= 160 && !text.includes('\n'));
});

test('escalation on request (decision 128)', () => {
  const base: EscalationState = { step: 's1', upCount: 0, fableOptIn: false, evidence: 'lead', leadOnlyRaises: 0, userTurn: false };
  // the lead's word alone: once per slot, inside the same model
  assert.deepEqual(decideEscalation(base), { granted: true, to: 's2', leadOnly: true });
  assert.deepEqual(decideEscalation({ ...base, leadOnlyRaises: 1 }), { granted: false, code: 'needs_user', why: 'second_lead_only' });
  // a model change needs more than the lead's word, even the first time
  assert.deepEqual(decideEscalation({ ...base, step: 's2' }), { granted: false, code: 'needs_user', why: 'tier' });
  assert.deepEqual(decideEscalation({ ...base, step: 's4' }), { granted: false, code: 'needs_user', why: 'tier' });
  assert.deepEqual(decideEscalation({ ...base, step: 's3' }), { granted: true, to: 's4', leadOnly: true });
  // a user turn or a reviewer / tester reject lifts both limits
  assert.deepEqual(decideEscalation({ ...base, step: 's2', userTurn: true }), { granted: true, to: 's3', leadOnly: false });
  assert.deepEqual(decideEscalation({ ...base, leadOnlyRaises: 1, userTurn: true }), { granted: true, to: 's2', leadOnly: false });
  assert.deepEqual(decideEscalation({ ...base, step: 's2', evidence: 'independent', leadOnlyRaises: 1 }), { granted: true, to: 's3', leadOnly: false });
  // the shared limit of raises and the top step always go to the user, whatever the evidence
  assert.equal(MAX_STEP_UPS, 3);
  for (const evidence of ['lead', 'independent'] as const) {
    assert.deepEqual(decideEscalation({ ...base, evidence, upCount: 3, userTurn: true }), { granted: false, code: 'needs_user', why: 'limit' });
    assert.deepEqual(decideEscalation({ ...base, evidence, step: 's6', userTurn: true }), { granted: false, code: 'needs_user', why: 'limit' });
  }
  assert.deepEqual(decideEscalation({ ...base, upCount: 2 }), { granted: true, to: 's2', leadOnly: true });
  // the top step moves with the Fable opt-in
  assert.deepEqual(decideEscalation({ ...base, step: 's6', fableOptIn: true, evidence: 'independent' }), { granted: true, to: 's7', leadOnly: false });
  assert.deepEqual(decideEscalation({ ...base, step: 's7', fableOptIn: true, evidence: 'independent' }), { granted: false, code: 'needs_user', why: 'limit' });
});
