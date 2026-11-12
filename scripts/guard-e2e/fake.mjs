// Fake Messages API for the guard end-to-end check (see run.mjs). It plays the model: the lead dispatches
// one router coder, and the coder issues a fixed list of tool calls, one per turn. Binds 127.0.0.1 only and
// accepts the dummy key of key-helper.mjs only; no request leaves the machine.
// Credential header values are never kept. Tool results are kept (first 500 characters): they come from the
// throwaway fixture repository of this run.
import http from 'node:http';

export const DUMMY_KEY = 'guard-e2e-dummy';
const CODER_BODY_MARKER = '## Work unit';   // from plugin/agents/coder.md, in case the agent-id header is missing

const systemText = s => (typeof s === 'string' ? s : Array.isArray(s) ? s.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '');
const resultText = r => (typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map(c => (c && typeof c.text === 'string' ? c.text : `[${c && c.type}]`)).join(' ') : '');

let seq = 0;
const usage = { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const message = (model, content, stop) => ({ id: `msg_e2e_${++seq}`, type: 'message', role: 'assistant', model: model || 'claude-sonnet-5-5', content, stop_reason: stop, stop_sequence: null, usage });
function sse(res, model, block, stop) {
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_e2e_${seq + 1}` });
  ev('message_start', { message: { ...message(model, [], null), usage: { ...usage, output_tokens: 1 } } });
  if (block.type === 'text') {
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
  } else {
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  }
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev('message_stop', {});
  res.end();
}
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'request-id': `req_e2e_${++seq}` });
  res.end(text);
}
const apiError = (type, msg) => ({ type: 'error', error: { type, message: msg } });
const text = t => ({ type: 'text', text: t });
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_e2e_${String(++seq).padStart(4, '0')}`, name, input });

/**
 * One scenario's script. `steps`: [{ id, tool, input }]. `dispatch`: the Agent tool input.
 * state.outcomes[id] = { isError, text } once the coder's next request brings the tool result.
 */
/** Subtask ids of the coders, one per batch of steps. */
const BATCH_TAGS = 'ABCDEFGH';

/**
 * A coder has a turn limit (40 in the role file), and a step's result is only seen on the coder's NEXT turn.
 * So one coder gets at most `scn.perCoder` steps, and the lead dispatches another coder for the rest.
 */
function dispatchNext(scn, state, req, hint) {
  const with_ = hint ?? state.dispatchedWith ?? { model: scn.dispatch.model, effort: scn.dispatch.effort };
  if (!hint) {                                             // a new batch (a repeat after a refusal keeps its batch)
    state.batch++;
    state.batchEnd = Math.min(scn.steps.length, state.next + (scn.perCoder ?? scn.steps.length));
    state.batchTurns = 0;
    state.missing = 0;
  }
  state.dispatches++;
  state.dispatchedWith = with_;
  const tag = BATCH_TAGS[Math.min(state.batch, BATCH_TAGS.length - 1)];
  const prompt = String(scn.dispatch.prompt ?? '').replace(/^\[subtask:[^\]]*\]/, `[subtask:${tag}]`);
  return { act: `${hint ? 're-dispatch' : 'dispatch'} ${tag} ${with_.model ?? ''}/${with_.effort ?? ''}`, block: toolUse(req.agentTool, { ...scn.dispatch, ...with_, prompt }) };
}

export function nextAction(scn, state, req) {
  if (req.kind === 'side') return { act: 'side-text', block: text('ok') };
  if (req.kind === 'main') {
    const more = () => state.batchTurns > 0 && state.next < scn.steps.length && state.batch + 1 < BATCH_TAGS.length && !!req.agentTool;
    if (req.results.length) {
      state.dispatchResults.push(...req.results);
      // The daemon names the step it planned when the call's model or effort does not fit: take it and call once more.
      const t = req.results[0].text;
      const model = /model="([^"]+)"/.exec(t)?.[1], effort = /effort="([^"]+)"/.exec(t)?.[1];
      if (state.batchTurns === 0 && state.dispatches < 12 && req.agentTool && t.includes('[agentic-router]') && model && effort && !state.retried[state.batch]) {
        state.retried[state.batch] = true;
        return dispatchNext(scn, state, req, { model, effort });
      }
      if (more()) return dispatchNext(scn, state, req);    // the coder finished its batch: the next one
      return { act: 'main-final', block: text('E2E_MAIN_DONE') };
    }
    state.mainTurns++;
    if (state.dispatches > 0) {
      state.mainNotes.push(req.lastText.slice(0, 300));
      if (more()) return dispatchNext(scn, state, req);    // an Agent call that ran in the background: its notification
      return { act: 'main-final(after the dispatch)', block: text('E2E_MAIN_DONE') };
    }
    if (!req.agentTool) return { act: 'no-agent-tool', block: text('E2E_NO_AGENT_TOOL') };
    return dispatchNext(scn, state, req);
  }
  // the coder
  state.coderTurns++;
  state.batchTurns++;
  if (state.pending) {
    const got = req.allResults.find(r => r.id === state.toolUseIds[state.pending]) ?? (req.results.length === 1 ? req.results[0] : null);
    if (got) { state.outcomes[state.pending] = { isError: got.isError, text: got.text }; state.missing = 0; }
    else { state.outcomes[state.pending] = { isError: null, text: `(no tool result came back for this step; last message: ${req.lastShape})` }; state.missing++; }
    state.pending = null;
  } else if (state.next >= state.batchEnd && state.batchTurns > 1) state.feedback.push(req.lastText.slice(0, 500));   // a stop hook sent the coder back
  if (state.next < state.batchEnd && state.missing < 3) {
    const s = scn.steps[state.next++];
    state.pending = s.id;
    const block = toolUse(s.tool, s.input);
    state.toolUseIds[s.id] = block.id;
    return { act: `step ${s.id}`, block };
  }
  return { act: 'coder-final', block: text('## Result\nScripted checks finished.\n## Remaining issues\nNone.') };
}

export const newState = () => ({ batch: -1, batchEnd: 0, batchTurns: 0, retried: {}, missing: 0, mainNotes: [], dispatches: 0, dispatchedWith: null, mainTurns: 0, coderTurns: 0, next: 0, pending: null, outcomes: {}, toolUseIds: {}, dispatchResults: [], feedback: [] });

/** The facts the script needs from a /v1/messages body. */
export function facts(body, headers) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map(t => t && t.name).filter(n => typeof n === 'string');
  const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : undefined;
  const blocks = last && Array.isArray(last.content) ? last.content : [];
  const results = last && last.role === 'user' ? blocks.filter(b => b && b.type === 'tool_result') : [];
  const lastText = last && last.role === 'user' ? (typeof last.content === 'string' ? last.content : blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n')) : '';
  const sub = typeof headers['x-claude-code-agent-id'] === 'string' || systemText(body.system).includes(CODER_BODY_MARKER);
  return {
    kind: !names.length ? 'side' : sub ? 'subagent' : 'main',
    model: body.model, stream: body.stream === true, toolNames: names,
    agentTool: names.find(n => n === 'Agent' || n === 'Task') ?? null,
    results: results.map(r => ({ id: r.tool_use_id, isError: r.is_error === true, text: resultText(r).slice(0, 500) })),
    allResults: (Array.isArray(body.messages) ? body.messages : []).flatMap(m => (m && m.role === 'user' && Array.isArray(m.content) ? m.content : []))
      .filter(b => b && b.type === 'tool_result').map(r => ({ id: r.tool_use_id, isError: r.is_error === true, text: resultText(r).slice(0, 500) })),
    lastShape: last ? `${last.role}:${typeof last.content === 'string' ? 'string' : blocks.map(b => b && b.type).join('+')}` : 'none',
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    lastText,
  };
}

export async function startFake({ port = 0 } = {}) {
  const entries = [];
  let scn = { name: 'idle', steps: [], dispatch: {} };
  let state = newState();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const keys = [req.headers['x-api-key'], req.headers.authorization].filter(v => typeof v === 'string').map(v => v.replace(/^Bearer\s+/i, '').trim());
      const credential = !keys.length ? 'none' : keys.every(k => k === DUMMY_KEY) ? 'dummy' : keys.some(k => /sk-ant-oat/i.test(k)) ? 'oat-like' : 'other';
      const entry = { at: new Date().toISOString(), scenario: scn.name, method: req.method, path: url.pathname, credential,
        agentIdHeader: req.headers['x-claude-code-agent-id'] ?? null, sessionIdHeader: req.headers['x-claude-code-session-id'] ?? null };
      entries.push(entry);
      const done = (status, act) => { entry.status = status; entry.action = act; };
      try {
        if (url.pathname === '/api/hello') { done(200, 'hello'); res.writeHead(200, { 'content-length': 0 }); return res.end(); }
        if (credential !== 'dummy') { done(401, `refused: credential ${credential}`); return json(res, 401, apiError('authentication_error', 'e2e: dummy key required')); }
        if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') { done(200, 'count_tokens'); return json(res, 200, { input_tokens: 100 }); }
        if (req.method !== 'POST' || url.pathname !== '/v1/messages') { done(404, 'not scripted'); return json(res, 404, apiError('not_found_error', 'e2e: not scripted')); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { done(400, 'bad json'); return json(res, 400, apiError('invalid_request_error', 'e2e: bad json')); }
        const f = facts(body, req.headers);
        entry.kind = f.kind; entry.model = f.model; entry.toolCount = f.toolNames.length; entry.lastShape = f.lastShape; entry.messageCount = f.messageCount;
        if (f.kind === 'subagent' && !state.coderTools) state.coderTools = f.toolNames;
        const out = nextAction(scn, state, f);
        const stop = out.block.type === 'tool_use' ? 'tool_use' : 'end_turn';
        done(200, out.act);
        if (f.stream) return sse(res, body.model, out.block, stop);
        return json(res, 200, message(body.model, [out.block], stop));
      } catch (e) {
        done(500, `fake failed: ${String(e && e.message).slice(0, 200)}`);
        if (!res.headersSent) json(res, 500, apiError('api_error', 'e2e: fake failed'));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port: server.address().port, entries,
    setScenario(s) { scn = s; state = newState(); },
    state: () => state,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
