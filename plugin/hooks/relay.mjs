#!/usr/bin/env node
// agentic-router relay: forwards a Claude Code hook event to the local daemon and writes the
// daemon's response to stdout verbatim. Dependency-free single file (decisions 54, 55).
//
// Fail-open: if the daemon is down, slow, or errors, the event is appended to the local spool
// (replayed when the daemon restarts) and the hook passes — Claude Code then behaves exactly as
// it would with no plugin. The only thing written to the spool or any log is masked.
//
// Usage (hooks.json): node relay.mjs <EventName>
//   argv[2] is the Claude Code event name; it sets the per-event timeout and the pre_compact
//   special case (pre_compact passes with EMPTY output on failure, not "{}").
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// decision 142: a project's verifyEnv names count only once the user accepted its policy (importing does not run the guard)
import { acceptedVerifyEnvNames } from './guard.mjs';
// decision 156: the token is a shared secret, never sent; every call to the daemon is sealed with it
import { sealedCall } from './seal.mjs';

const EVENT = process.argv[2] || '';
const ENDPOINT = '/router/v1/hooks/claude-code';

// Per-event timeout (ms). SubagentStop waits for the daemon's verify run (up to ~240s); the rest are short.
const TIMEOUTS = { SubagentStop: 300_000 };
const DEFAULT_TIMEOUT = 10_000;

function routerHome() {
  return process.env.AGENTIC_ROUTER_HOME || path.join(os.homedir(), '.agentic-router');
}

// ---------------------------------------------------------------- masking (core/security.ts redact, redactJson)
// The patterns and the secret-key rules come from secret-patterns.json next to this file, generated from core
// SECRET_PATTERN_SPECS and SECRET_KEY_NAME_SPECS (decision 142, audit N1; a test keeps it current), applied the
// way core applies them. Without the file nothing is spooled.
const MAX_MASK_LENGTH = 1_000_000;   // core MAX_MASK_LENGTH (audit N6)
function loadPatterns() {
  try {
    const doc = JSON.parse(fs.readFileSync(new URL('./secret-patterns.json', import.meta.url), 'utf8'));
    if (!doc || !Array.isArray(doc.patterns) || !Array.isArray(doc.secretKeyNames)) return null;
    return {
      text: doc.patterns.map(s => ({ re: new RegExp(s.source, s.flags), lead: s.lead === true })),
      keys: doc.secretKeyNames.map(s => new RegExp(s.source, s.flags)),
    };
  } catch { return null; }
}
const SECRET_PATTERNS = loadPatterns();
const missing = () => new Error('secret-patterns.json is missing: nothing can be masked');
export function redact(text) {
  if (!SECRET_PATTERNS) throw missing();
  let out = String(text);
  if (out.length > MAX_MASK_LENGTH) out = out.slice(0, MAX_MASK_LENGTH) + '…[truncated]';
  for (const p of SECRET_PATTERNS.text) {
    out = p.lead ? out.replace(p.re, (_m, g1) => `${g1}[REDACTED]`) : out.replace(p.re, m => m.slice(0, 7) + '…[REDACTED]');
  }
  return out;
}
/**
 * Audit N1: masks a PARSED value (string leaves; a string under a secret-named key whole), so the JSON written
 * after it stays valid. Masking the serialized text could cut a string at a quote or eat a closing brace.
 */
export function redactJson(value) {
  if (!SECRET_PATTERNS) throw missing();
  const secretKey = k => SECRET_PATTERNS.keys.some(re => re.test(k));
  const walk = (v, keyIsSecret) => {
    if (typeof v === 'string') return keyIsSecret ? '[REDACTED]' : redact(v);
    if (Array.isArray(v)) return v.map(x => walk(x, false));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, secretKey(k));
      return out;
    }
    return v;
  };
  return walk(value, false);
}

// ---------------------------------------------------------------- verify env passthrough (decision 99)
// Kept in sync with core/security.ts VERIFY_ENV_PASSTHROUGH (relay is dependency-free). A test checks it.
export const VERIFY_ENV_PASSTHROUGH = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PYENV_VERSION', 'PYTHONPATH', 'POETRY_ACTIVE',
  'NVM_BIN', 'NVM_DIR', 'VOLTA_HOME', 'FNM_MULTISHELL_PATH', 'NODE_PATH',
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOFLAGS', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CI',
];
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** { name: value } for the allowed verify env vars present in this process, excluding secret-looking names. */
export function buildVerifyEnv(env = process.env, extraNames = acceptedVerifyEnvNames()) {
  const out = {};
  for (const name of [...VERIFY_ENV_PASSTHROUGH, ...extraNames]) {
    if (name === 'NODE_OPTIONS' || SECRET_NAME_RE.test(name)) continue;
    const v = env[name];
    if (typeof v === 'string') out[name] = v;
  }
  return out;
}

/** Diagnostics the daemon's doctor/status compares against its own (decision 97). */
function routerClientInfo(home, port) {
  return { node: process.execPath, nodeVersion: process.versions.node, routerHome: home, port };
}

// ---------------------------------------------------------------- config / token
function readConfig(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
  catch { return null; }
}
function readToken(home) {
  try { return fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); }
  catch { return null; }
}

// ---------------------------------------------------------------- minimal form (decisions 141-142)
// A copy of the daemon's minimalPayload (packages/daemon/src/payload.ts; relay is dependency-free). A test runs
// both on the same inputs and requires equal output. With recordPrompts off the spool holds this form: ids,
// tool name, model, effort, paths, flags, verify-env names, a task notification's structured tags, the Agent
// prompt's [subtask:]/[scope:] lines and the awaiting-user marker; no prompt, spec, report or message text.
const MINIMAL_MARK = '_min';
const AWAITING_USER_MARKER = '[router:awaiting-user]';
const KEEP = ['hook_event_name', 'session_id', 'agent_id', 'agent_type', 'prompt_id', 'tool_name', 'tool_use_id', 'permission_mode', 'cwd',
  'transcript_path', 'agent_transcript_path', 'source', 'model', 'trigger', 'stop_hook_active', 'routerClient'];
const AGENT_INPUT = ['subagent_type', 'model', 'effort', 'isolation', 'run_in_background'];
const AGENT_RESPONSE = ['status', 'agentId', 'agentType', 'resolvedModel', 'isAsync', 'totalTokens', 'totalDurationMs', 'totalToolUseCount',
  'worktreePath', 'worktreeBranch', 'outputFile', 'usage'];
const ROUTER_TOOL = /^mcp__plugin_agentic-router_router__/;
const EDIT_TOOL_PATH = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
// the dispatch lines the router parses (daemon policy.ts): the tag that starts line 1, the scope that is line 2
const TAG_LINE = /^\s*\[subtask:\s*([A-Za-z0-9_.-]{1,64})\s*\]/;
const SCOPE_LINE = /^\s*\[scope:[^\]]*\]\s*$/;
const NOTIFICATION_TAGS = ['task-id', 'tool-use-id', 'output-file', 'status'];
const PATH_LIKE = /^[^<>\n]{1,1024}$/;
const TASK_NOTIFICATION = /^\s*<task-notification[\s>]/;
const promptKind = p => (TASK_NOTIFICATION.test(p) ? 'notification' : /^\s*\//.test(p) ? 'command' : 'user');
const tagOf = (src, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(src)?.[1]?.trim();

export function notificationSkeleton(prompt) {
  const lines = ['<task-notification>'];
  for (const t of NOTIFICATION_TAGS) { const v = tagOf(prompt, t); if (v && PATH_LIKE.test(v)) lines.push(`<${t}>${v}</${t}>`); }
  const wt = tagOf(prompt, 'worktree');
  if (wt) {
    const parts = ['worktreePath', 'worktreeBranch'].map(t => [t, tagOf(wt, t)]).filter(([, v]) => v && PATH_LIKE.test(v));
    if (parts.length) lines.push(`<worktree>${parts.map(([t, v]) => `<${t}>${v}</${t}>`).join('')}</worktree>`);
  }
  const usage = tagOf(prompt, 'usage');
  if (usage) {
    const parts = ['subagent_tokens', 'tool_uses', 'duration_ms'].map(t => [t, tagOf(usage, t)]).filter(([, v]) => v && /^\d{1,12}$/.test(v));
    if (parts.length) lines.push(`<usage>${parts.map(([t, v]) => `<${t}>${v}</${t}>`).join('')}</usage>`);
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}

export function minimalHookInput(raw) {
  if (!isRecord(raw)) return raw;
  const again = raw[MINIMAL_MARK] === 1;
  const size = (o, k) => (again && typeof o[`${k}_chars`] === 'number' ? o[`${k}_chars`] : typeof o[k] === 'string' ? o[k].length : undefined);
  const out = { [MINIMAL_MARK]: 1 };
  for (const k of KEEP) if (raw[k] !== undefined) out[k] = raw[k];
  if (raw.verifyEnv !== undefined) {
    out.verifyEnv = (isRecord(raw.verifyEnv) ? Object.keys(raw.verifyEnv) : Array.isArray(raw.verifyEnv) ? raw.verifyEnv : []).filter(k => typeof k === 'string').sort();
  }
  const event = String(raw.hook_event_name ?? '');
  if (event === 'UserPromptSubmit' || raw.prompt !== undefined || raw.prompt_chars !== undefined) {
    const kind = again && (raw.prompt_kind === 'user' || raw.prompt_kind === 'notification' || raw.prompt_kind === 'command')
      ? raw.prompt_kind : promptKind(typeof raw.prompt === 'string' ? raw.prompt : '');
    const n = size(raw, 'prompt');
    if (n !== undefined) out.prompt_chars = n;
    out.prompt_kind = kind;
    if (kind === 'notification' && typeof raw.prompt === 'string') out.prompt = notificationSkeleton(raw.prompt);
  }
  for (const k of ['custom_instructions', 'last_assistant_message']) {
    const n = size(raw, k);
    if (n !== undefined) out[`${k}_chars`] = n;
  }
  if (typeof raw.last_assistant_message === 'string' && raw.last_assistant_message.includes(AWAITING_USER_MARKER)) out.last_assistant_message = AWAITING_USER_MARKER;
  const tool = typeof raw.tool_name === 'string' ? raw.tool_name : '';
  if (isRecord(raw.tool_input)) {
    if (tool === 'Agent') {
      const ti = raw.tool_input;
      const t = {};
      for (const k of AGENT_INPUT) if (ti[k] !== undefined) t[k] = ti[k];
      const n = size(ti, 'prompt');
      if (n !== undefined) t.prompt_chars = n;
      const ls = typeof ti.prompt === 'string' ? ti.prompt.split(/\r?\n/) : [];
      const tag = TAG_LINE.exec(ls[0] ?? '')?.[1];
      const scope = SCOPE_LINE.test(ls[1] ?? '') ? ls[1].trim() : undefined;
      if (tag || scope) t.prompt = scope ? `${tag ? `[subtask:${tag}]` : ''}\n${scope}` : `[subtask:${tag}]`;
      out.tool_input = t;
    } else if (ROUTER_TOOL.test(tool)) out.tool_input = raw.tool_input;
    else if (EDIT_TOOL_PATH[tool]) {   // decision 145: the lead's own edits, by path only (never the content)
      const k = EDIT_TOOL_PATH[tool];
      const p = raw.tool_input[k];
      out.tool_input = typeof p === 'string' && PATH_LIKE.test(p) ? { [k]: p } : {};
    }
    else out.tool_input = {};
  }
  if (isRecord(raw.tool_response) && tool === 'Agent') {
    const tr = raw.tool_response;
    const r = {};
    for (const k of AGENT_RESPONSE) if (tr[k] !== undefined) r[k] = tr[k];
    const text = Array.isArray(tr.content) ? tr.content.reduce((a, b) => a + (isRecord(b) && typeof b.text === 'string' ? b.text.length : 0), 0) : undefined;
    const n = again && typeof tr.text_chars === 'number' ? tr.text_chars : text;
    if (n !== undefined) r.text_chars = n;
    out.tool_response = r;
  }
  return out;
}

/** What goes to the spool: the minimal form, or (recordPrompts on) the input with verify-env names only. */
export function spoolForm(input, recordPrompts) {
  // decision 149: an edit tool is spooled by path only even with recordPrompts on (it covers prompt text, not file contents)
  if (!recordPrompts || (isRecord(input) && EDIT_TOOL_PATH[input.tool_name])) return minimalHookInput(input);
  if (!isRecord(input) || !isRecord(input.verifyEnv)) return input;
  return { ...input, verifyEnv: Object.keys(input.verifyEnv).sort() };
}

// ---------------------------------------------------------------- spool (decision 100)
const SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;     // drop events older than 24h
const SPOOL_MAX_BYTES = 20 * 1024 * 1024;         // keep the whole spool under 20MB

/** Deletes spool files older than 24h, then (oldest first) until the total is under the size cap. */
export function cleanSpool(dir) {
  let entries;
  try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return { p, mtime: st.mtimeMs, size: st.size };
  }); } catch { return; }
  const now = Date.now();
  for (const e of entries) if (now - e.mtime > SPOOL_MAX_AGE_MS) { try { fs.rmSync(e.p); e.size = -1; } catch { /* ignore */ } }
  let remaining = entries.filter(e => e.size >= 0).sort((a, b) => a.mtime - b.mtime);
  let total = remaining.reduce((s, e) => s + e.size, 0);
  for (const e of remaining) {
    if (total <= SPOOL_MAX_BYTES) break;
    try { fs.rmSync(e.p); total -= e.size; } catch { /* ignore */ }
  }
}

/**
 * Appends one masked event to spool/<ISO>-<event>-<rand>.jsonl: one line `{receivedAt, input}`, the input in
 * its spool form (decision 142). The folder is 0700 and the file 0600.
 */
export function spool(home, eventInput, receivedAt, recordPrompts = false) {
  const dir = path.join(home, 'spool');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ } }
    cleanSpool(dir);                              // prune before writing (decision 100)
    const stamp = receivedAt.replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${EVENT || 'event'}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
    // audit N1: mask the parsed value, then serialize (the line stays one valid JSON record)
    const line = JSON.stringify({ receivedAt, input: redactJson(spoolForm(eventInput, recordPrompts)) }) + '\n';
    fs.writeFileSync(file, line, { mode: 0o600 });
  } catch { /* spool is best-effort; never block the hook on a spool failure */ }
}

// ---------------------------------------------------------------- daemon POST
// Sealed (decision 156): a program that took the daemon's port while the daemon was down gets neither the
// token nor the hook input, and cannot answer. Anything but a sealed answer from the daemon that holds the
// token counts as "daemon not reachable": the event is spooled and the hook passes. There is no fallback
// to a call that sends the token, also not against a daemon of an older version.
async function post({ port, token, body, timeoutMs }) {
  const res = await sealedCall({ port, secret: token, method: 'POST', path: ENDPOINT, body, timeoutMs });
  if (res.status >= 200 && res.status < 300) return res.body;
  throw new Error(`daemon status ${res.status}`);
}

// ---------------------------------------------------------------- main
/** What the hook writes to stdout when the daemon can't be reached. pre_compact must stay empty. */
export function fallbackOutput(event) {
  return event === 'PreCompact' ? '' : '{}';
}

export async function relay(raw, { home = routerHome(), write = s => process.stdout.write(s) } = {}) {
  const receivedAt = new Date().toISOString();
  let input;
  try { input = JSON.parse(raw); } catch {
    write(fallbackOutput(EVENT));           // unparseable: pass through, nothing to spool
    return;
  }
  // Decision 145: an edit tool's PostToolUse is relayed for the lead only (a takeover after delegating);
  // a subagent's edit (it has an agent_id) is answered at once, without the daemon.
  if (isRecord(input) && EDIT_TOOL_PATH[input.tool_name] && input.hook_event_name === 'PostToolUse' && input.agent_id) {
    write('{}');
    return;
  }

  const cfg = readConfig(home);
  const token = readToken(home);
  const port = cfg && typeof cfg.daemonPort === 'number' ? cfg.daemonPort : null;
  if (!port || !token) {
    // D5 (decision 100): before `init` (no config/token) there is nothing to replay to — pass, don't spool.
    write(fallbackOutput(EVENT));
    return;
  }

  // Augment the body for two events (the daemon reads these from the raw input; spool keeps them too).
  if (isRecord(input)) {
    if (EVENT === 'SessionStart') input.routerClient = routerClientInfo(home, port);   // D2: doctor/status compare
    else if (EVENT === 'SubagentStart') input.verifyEnv = buildVerifyEnv();            // D4: verify env passthrough
  }

  const timeoutMs = TIMEOUTS[EVENT] ?? DEFAULT_TIMEOUT;
  try {
    // decision 149: the lead's edit reaches the daemon as tool name and path only; its content never leaves this hook
    const body = JSON.stringify(isRecord(input) && EDIT_TOOL_PATH[input.tool_name] ? minimalHookInput(input) : input);
    const response = await post({ port, token, body, timeoutMs });
    write(response);                        // verbatim: JSON for most events, text/plain for pre_compact
  } catch {
    spool(home, input, receivedAt, cfg.recordPrompts === true);   // daemon down / slow / error: queue for replay, then pass
    write(fallbackOutput(EVENT));
  }
}

function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }

/** Real-path comparison so a junction/symlink/npm-link spelling of the plugin dir still runs the hook. */
function isMain() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const real = p => { try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return path.resolve(p); } };
    return real(argv1) === real(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { relay(data).then(() => process.exit(0), () => process.exit(0)); });
}
