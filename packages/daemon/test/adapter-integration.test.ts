// Daemon + the real Claude Code adapter through the public startDaemon() entry:
// the adapter is loaded by the daemon itself and verify commands come from the project's
// .do-it-all-claude-code/verify.json (read from the start commit). Spike s2 end to end, plus a deny, the
// HITL marker via RouterEvent.lastAssistantMessage, and the plain-text PreCompact output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon } from '../src/index.ts';
import type { StatusView } from '../src/router.ts';
import { AWAITING_USER_MARKER } from '../src/continuation.ts';
import { copyTranscript, getStatus, loadSpike, makeHome, makeRepo, postHook, retarget, rmrf, write, type HookInput } from './helpers.ts';

const CHECK = 'const t = require("fs").readFileSync("allowed/c.txt", "utf8");\nif (!t.includes("VERIFIED")) { console.error("c.txt is not VERIFIED"); process.exit(1); }\n';

test('startDaemon + real adapter: brief, deny, block then pass on spike s2, HITL marker, PreCompact as plain text', async () => {
  const home = makeHome();
  const repo = makeRepo({ 'check.cjs': CHECK, '.do-it-all-claude-code/verify.json': JSON.stringify({ coder: ['node check.cjs'] }) });
  try {
    const d = await startDaemon({ home, port: 0 });
    try {
      const inputs = retarget(loadSpike('s2'), repo);
      const sid = String(inputs[0]!.session_id);
      const post = async (h: HookInput) => {
        const r = await postHook(d.port, h);
        assert.equal(r.status, 200, r.text);
        return r;
      };
      type Out = { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
      let stops = 0;
      const stopOuts: Out[] = [];
      for (const h of inputs) {
        if (h.hook_event_name === 'UserPromptSubmit') {
          h.prompt = 'Fix the bug where parse() fails on empty input in src/parse.ts';
          const o = (await post(h)).body as Out;
          assert.equal(o.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
          assert.match(o.hookSpecificOutput?.additionalContext ?? '', /^\[do-it-all-claude-code\] level L1/);
          // a call at the wrong step is denied in Claude Code's PreToolUse format (sonnet/medium is neither the L2 nor
          // the L3 coder start, decision 113; the lead-direct L1 request is re-planned at L2 and checked against it)
          const wrong = (await post({ ...inputs.find(x => x.tool_name === 'Agent')!, tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:Z] x', model: 'sonnet', effort: 'medium' } })).body as Out;
          assert.equal(wrong.hookSpecificOutput?.hookEventName, 'PreToolUse');
          assert.equal(wrong.hookSpecificOutput?.permissionDecision, 'deny');
          assert.match(wrong.hookSpecificOutput?.permissionDecisionReason ?? '', /model="haiku", effort="low"/);
          continue;
        }
        if (h.hook_event_name === 'SubagentStop') {
          write(repo, 'allowed/c.txt', stops++ === 0 ? 'C\n' : 'C\nVERIFIED\n');
          h.agent_transcript_path = copyTranscript(home, String(h.agent_id));
        }
        if (h.hook_event_name === 'Stop') h.last_assistant_message = `Keep the old behaviour for null? ${AWAITING_USER_MARKER}`;
        const o = (await post(h)).body as Out;
        if (h.hook_event_name === 'SubagentStop') stopOuts.push(o);
      }
      assert.equal(stopOuts[0]?.decision, 'block');
      assert.match(stopOuts[0]?.reason ?? '', /node check\.cjs: exit 1[\s\S]*c\.txt is not VERIFIED/);
      assert.deepEqual(stopOuts[1], {});
      const st = (await getStatus(d.port, sid)).body as StatusView;
      assert.equal(st.request?.status, 'awaiting_user');            // read from RouterEvent.lastAssistantMessage
      assert.deepEqual(st.roles.find(r => r.role === 'coder'), { role: 'coder', slot: 0, step: 's1', model: 'haiku', effort: 'low', status: 'passed', subtaskId: 'C' });
      assert.ok(st.costUsd > 0);

      const pc = await post({ session_id: sid, transcript_path: String(inputs[0]!.transcript_path), cwd: repo, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' });
      assert.match(String(pc.headers['content-type']), /^text\/plain/);
      // the request is awaiting the user: the compaction guidance keeps its team state
      assert.match(pc.text, /^Do It All Claude Code: keep this team state/);
      assert.ok(pc.text.includes('  - C: coder#0 @s1 (model=haiku, effort=low) passed/meet; scope: whole repo'), pc.text);
    } finally { await d.close(); }
  } finally { rmrf(home); rmrf(repo); }
});
