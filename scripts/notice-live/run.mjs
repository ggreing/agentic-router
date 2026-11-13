#!/usr/bin/env node
// Live check of the update notice path (decision 163) with a real Claude Code: is a SessionStart hook's systemMessage
// kept from the model? A plugin of its own (in a temp folder) has one synchronous SessionStart hook that prints what
// the router renders for a session start with a restored team state and an update notice (the adapter's
// renderHookOutput: the state as additionalContext, the notice as systemMessage). Claude Code runs once with
// `claude -p` and a fresh temp config dir (no login) against a fake Messages API on 127.0.0.1, which accepts only the
// dummy key of scripts/tls-live/dummy-key.mjs and records every request body. No API call is made and nothing is
// billed; your own ~/.claude and ~/.do-it-all-claude-code are not read or changed.
//
// Met when the context's marker is in a request to the model (the hook ran and its context arrived) and the
// notice's marker is in none (systemMessage is shown to the user only). It also reports whether the notice appeared
// in Claude Code's output.
//
// Usage: node scripts/notice-live/run.mjs [--keep] [--timeout=<seconds>] [--selftest]
//   --selftest: no claude; the hook runs as Claude Code would run it, and one request carries its context
// Env: CLAUDE_BIN=<path> (default "claude").
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const { renderHookOutput } = await import(new URL('../../packages/adapter-claude-code/src/render.ts', import.meta.url).href);
const DUMMY_KEY = 'tls-live-dummy-key';                 // what scripts/tls-live/dummy-key.mjs prints
const WIN = process.platform === 'win32';
const flag = name => process.argv.includes(`--${name}`);
const opt = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const TIMEOUT_MS = Number(opt('timeout') ?? 120) * 1000;
const posix = p => p.replace(/\\/g, '/');

const mark = randomBytes(6).toString('hex');
const CONTEXT = `notice-live context ${mark}: restored team state`;
const NOTICE = `Do It All Claude Code 99.0.0 is available (you have 0.3.0): https://github.com/ggreing/do-it-all-claude-code/releases/tag/v99.0.0 (notice-live ${mark})`;
const NOTICE_MARK = `notice-live ${mark})`;

/** A fake Messages API: the dummy key only; every request body is kept (they hold only this run's markers and prompt). */
function startFakeApi() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const key = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      bodies.push({ path: (req.url ?? '').split('?')[0], body });
      if ((req.url ?? '').startsWith('/api/hello')) { res.writeHead(200, { 'content-length': 0 }); return res.end(); }
      if (key !== DUMMY_KEY) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"authentication_error","message":"fake: dummy key only"}}'); }
      if ((req.url ?? '').startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* not needed */ }
      const usage = { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const msg = { id: `msg_notice_${Date.now()}`, type: 'message', role: 'assistant', model: parsed.model || 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ping' }], stop_reason: 'end_turn', stop_sequence: null, usage };
      if (parsed.stream !== true) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(msg)); }
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      ev('message_start', { message: { ...msg, content: [], usage: { ...usage, output_tokens: 1 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ping' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      ev('message_stop', {});
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) }));
  });
}

/** The plugin: one synchronous SessionStart hook that prints the router's rendering of a session start. */
function makePlugin(root) {
  const dir = path.join(root, 'plugin');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'notice-live', version: '0.0.0' }));
  const output = renderHookOutput('session_start', { context: CONTEXT, userMessage: NOTICE });
  fs.writeFileSync(path.join(dir, 'hooks', 'start.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`);
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
    { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/start.mjs'], timeout: 10 },
  ] }] } }, null, 2));
  return { dir, output };
}

function cleanEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    // as in scripts/tls-live: nothing of a surrounding Claude Code session, no credential, no ambient proxy
    if (/^(?:CLAUDE|ANTHROPIC|AWS_BEARER|MCP_|ENABLE_TOOL_SEARCH|DO_IT_ALL_CLAUDE_CODE|AGENTIC_ROUTER|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT|HTTPS?_PROXY|NO_PROXY)/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, NO_PROXY: '127.0.0.1,localhost,::1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false', ...extra };
}

/** --selftest: the hook as Claude Code runs it, then one request that carries its context the way a SessionStart context goes. */
async function selftestClaude(plugin, port) {
  const hook = spawnSync(process.execPath, [path.join(plugin.dir, 'hooks', 'start.mjs')], { encoding: 'utf8' });
  const out = JSON.parse(hook.stdout);
  const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: `${out.hookSpecificOutput?.additionalContext ?? ''}\nping` }] });
  await new Promise(resolve => {
    const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', agent: false, headers: { 'x-api-key': DUMMY_KEY, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, x => { x.resume(); x.on('end', resolve); });
    q.on('error', resolve);
    q.end(body);
  });
  return { exitCode: 0, stdout: JSON.stringify({ result: 'ping' }), stderr: out.systemMessage ? `[user] ${out.systemMessage}` : '' };
}

function runClaude(env, plugin, port) {
  if (flag('selftest')) return selftestClaude(plugin, port);
  return new Promise(resolve => {
    const bin = process.env.CLAUDE_BIN || 'claude';
    let out = '', err = '', timedOut = false, child;
    const args = ['-p', '--plugin-dir', plugin.dir, '--model', 'sonnet', '--max-turns', '1', '--output-format', 'json'];
    try { child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: /\.(cmd|bat)$/i.test(bin) }); }
    catch (e) { return resolve({ spawnError: String(e?.message) }); }
    const timer = setTimeout(() => { timedOut = true; try { WIN ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) : child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS);
    child.stdout.on('data', d => { if (out.length < 400_000) out += d; });
    child.stderr.on('data', d => { if (err.length < 200_000) err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ spawnError: String(e?.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdout: out, stderr: err }); });
    child.stdin.on('error', () => {});
    child.stdin.end('Reply with just the word: ping');
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-notice-live-'));
const fake = await startFakeApi();
try {
  const plugin = makePlugin(root);
  const config = path.join(root, 'config');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    apiKeyHelper: `node "${posix(path.join(REPO, 'scripts', 'tls-live', 'dummy-key.mjs'))}"`,
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}` },
  }, null, 2) + '\n');
  if (!flag('selftest')) {
    const v = spawnSync(process.env.CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8', windowsHide: true, shell: WIN });
    console.log(`claude: ${(v.stdout || v.stderr || '').trim().split('\n')[0] || 'not found'}; temp: ${root}`);
  }
  console.log(`the hook prints: ${JSON.stringify(plugin.output)}`);
  const r = await runClaude(cleanEnv({ CLAUDE_CONFIG_DIR: config }), plugin, fake.port);
  const toModel = fake.bodies.filter(b => b.path.startsWith('/v1/messages'));
  const facts = {
    exitCode: r.exitCode ?? null, timedOut: !!r.timedOut, spawnError: r.spawnError ?? null, modelRequests: toModel.length,
    contextReachedModel: toModel.some(b => b.body.includes(CONTEXT)),
    noticeReachedModel: fake.bodies.some(b => b.body.includes(NOTICE_MARK)),
    noticeInOutput: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.includes(NOTICE_MARK),
  };
  const met = facts.contextReachedModel && !facts.noticeReachedModel;
  console.log(`${met ? 'met    ' : 'NOT met'}  session-start notice  ${JSON.stringify(facts)}`);
  if (!facts.contextReachedModel) console.log('  the context did not arrive either: the hook may not have run (a plugin not loaded, or a hook error); see the temp folder with --keep');
  process.exitCode = met ? 0 : 1;
} finally {
  await fake.close();
  if (!flag('keep')) fs.rmSync(root, { recursive: true, force: true });
}
