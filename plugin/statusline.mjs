#!/usr/bin/env node
// Do It All Claude Code status line for Claude Code (dependency-free, single file).
//
// Reads the status line input JSON on stdin, asks the local daemon for the session's request
// (GET /router/v1/status?session_id=..., port from config.json, Bearer token from the token file)
// and prints one line:  [Router] L2 | architect s3 · coder×2 s1 · reviewer s3 · tester s1 | $0.42
// The cost reads ~$0.42 when it includes estimates and $0.42+? when some subagent costs are unknown.
// A request the lead handles itself (L0) reads: [Router] L0 · direct | $0.00; a level forced by config.forceLevel: [Router] L2 forced | ...
// Daemon down, slow (> 1 s) or unauthorised: [Router] OFF.  No request yet in the session: [Router] idle.
// If config.json has `wrappedStatusLine` (the user's previous status line command), it runs with the
// same stdin and its output is appended after " | "; its failure is ignored. The wrapped command gets
// DO_IT_ALL_CLAUDE_CODE_STATUSLINE=1; a status line started with it set prints the router segment only, so
// a configuration that wraps this script itself cannot recurse.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
// decision 156: the token is a shared secret, never sent; every call to the daemon is sealed with it
import { sealedCall } from './hooks/seal.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAEMON_TIMEOUT_MS = 1000;
export const WRAPPED_TIMEOUT_MS = 2000;
export const NESTED_ENV = 'DO_IT_ALL_CLAUDE_CODE_STATUSLINE';
const MAX_STDIN = 256 * 1024;

export function routerHome(env = process.env) {
  return env.DO_IT_ALL_CLAUDE_CODE_HOME || path.join(os.homedir(), '.do-it-all-claude-code');
}

// ---------------------------------------------------------------- subscription limit capture (spec 3.8)
// The status line runs on every render, so forwarding rate_limits to the daemon is rate-limited: send only
// when the value changed or the last send is older than this interval. The daemon (limits.ts) parses the
// raw rate_limits object; here we just forward it. Fire-and-(briefly)-wait so a render stays fast.
export const LIMITS_ENDPOINT = '/router/v1/limits';
export const LIMITS_MIN_INTERVAL_MS = 60_000;
const LIMITS_POST_TIMEOUT_MS = 500;
const safeName = s => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
const limitsHash = rateLimits => { try { return JSON.stringify(rateLimits); } catch { return ''; } };
// Decision 144: the status line input names the session's model (model.id); Claude Code's hooks do not, so this is
// how the daemon learns the lead model before the first prompt's transcript has one. Sent with the limits.
const MODEL_ID = /^[A-Za-z0-9._:\[\]-]{1,128}$/;   // e.g. claude-sonnet-5-5, claude-opus-5-5[1m]
export const modelIdOf = parsed => (typeof parsed?.model?.id === 'string' && MODEL_ID.test(parsed.model.id) ? parsed.model.id : undefined);
const stampHash = (rateLimits, model) => {
  const r = rateLimits === undefined || rateLimits === null ? '' : limitsHash(rateLimits);
  const base = r === '{}' ? '' : r;
  return model ? `${base}|model:${model}` : base;
};

/** Whether to post now (rate_limits and/or the model), given the last send stamp ({hash, at}). Pure, for the rate limiter. */
export function shouldSendLimits(stamp, rateLimits, now, minIntervalMs = LIMITS_MIN_INTERVAL_MS, model = undefined) {
  const hash = stampHash(rateLimits, model);
  if (!hash) return false;
  if (!stamp || typeof stamp !== 'object') return true;
  if (stamp.hash !== hash) return true;
  return now - (Number(stamp.at) || 0) >= minIntervalMs;
}

async function postLimits({ home, port, token, sessionId, rateLimits, model, timeoutMs = LIMITS_POST_TIMEOUT_MS }) {
  const body = JSON.stringify({ sessionId, rateLimits, ...(model ? { model } : {}), at: new Date().toISOString() });
  await sealedCall({ home, port, secret: token, method: 'POST', path: LIMITS_ENDPOINT, body, timeoutMs });
}

/** Reads the per-session stamp, decides via shouldSendLimits, posts if due, and updates the stamp. Never throws. */
export async function maybeSendLimits({ home, port, token, sessionId, rateLimits, model, now = Date.now() }) {
  if (!Number.isInteger(port) || port <= 0 || !token || !sessionId) return;
  const dir = path.join(home, 'limits-cache');
  const file = path.join(dir, `${safeName(sessionId)}.json`);
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no stamp yet */ }
  if (!shouldSendLimits(stamp, rateLimits, now, LIMITS_MIN_INTERVAL_MS, model)) return;
  // Stamp before the POST so rapid renders don't queue duplicate requests even if the POST is slow.
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ hash: stampHash(rateLimits, model), at: now })); } catch { /* best effort */ }
  try { await postLimits({ home, port, token, sessionId, rateLimits, model }); } catch { /* daemon down/slow: the status line still prints */ }
}

/** One line from a /router/v1/status response; roles with the same step are grouped (coder×2 s1). */
/**
 * Decision 163: "update 0.4.0" while the daemon reports a newer release. Checked again here, so nothing but a
 * version number can reach the status line.
 */
export function updateSegment(view) {
  const v = view && typeof view === 'object' && view.update && typeof view.update === 'object' ? view.update.latest : undefined;
  return typeof v === 'string' && v.length <= 64 && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v) ? `update ${v}` : '';
}

export function formatStatus(view) {
  if (!view || typeof view !== 'object' || !view.request) return ['[Router] idle', updateSegment(view)].filter(Boolean).join(' | ');
  // Decision 87: a lead-direct request (L0) shows "L0 · direct" and only the roles actually dispatched.
  const direct = view.request.leadDirect === true;
  const roles = (Array.isArray(view.roles) ? view.roles : []).filter(r => !direct || r.status !== 'idle');
  const groups = [];
  for (const r of roles) {
    const g = groups.find(x => x.role === r.role && x.step === r.step);
    if (g) g.n++;
    else groups.push({ role: r.role, step: r.step, n: 1 });
  }
  const team = groups.map(g => `${g.role}${g.n > 1 ? `×${g.n}` : ''} ${g.step}`).join(' · ');
  // ~ : the total includes estimates from task notifications; +? : some subagent costs are unknown (decision 84)
  const cost = `${view.costEstimated ? '~' : ''}$${(Number(view.costUsd) || 0).toFixed(2)}${view.costUnknown ? '+?' : ''}`;
  // decision 107: a level forced by config.forceLevel (benchmarks) reads "L2 forced"
  const forced = view.request.forcedFrom ? ' forced' : '';
  return [`[Router] ${view.request.level}${forced}${direct ? ' · direct' : ''}`, team, cost, updateSegment(view)].filter(Boolean).join(' | ');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return undefined; }
}

/** The daemon's status view, or null when it does not answer properly within the time limit. */
export async function fetchStatus({ home, port, token, sessionId, timeoutMs = DAEMON_TIMEOUT_MS }) {
  if (!Number.isInteger(port) || port <= 0 || !token) return null;
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
  try {
    // sealed: the answer is shown only when it comes from the daemon that holds the token
    const res = await sealedCall({ home, port, secret: token, method: 'GET', path: `/router/v1/status${query}`, timeoutMs });
    return res.status === 200 ? JSON.parse(res.body) : null;
  } catch { return null; }
}

/** Runs the wrapped status line command with the same stdin; '' on failure, timeout or no command. */
export function runWrapped(setting, input, timeoutMs = WRAPPED_TIMEOUT_MS, env = process.env) {
  const command = typeof setting === 'string' ? setting : setting && typeof setting.command === 'string' ? setting.command : '';
  if (!command.trim()) return Promise.resolve('');
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn(command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, [NESTED_ENV]: '1' } });
    } catch {
      return resolve('');
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(''); }, timeoutMs);
    child.stdout.on('data', c => { out += c; });
    child.on('error', () => finish(''));
    child.on('close', code => finish(code === 0 ? out.replace(/\s+$/, '') : ''));
    child.stdin.on('error', () => { /* the command may not read stdin */ });
    child.stdin.end(input);
  });
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { if (data.length < MAX_STDIN) data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function statusLine(input, env = process.env) {
  let parsed = {};
  try { parsed = JSON.parse(input); } catch { /* no session: latest request */ }
  const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
  const home = routerHome(env);
  const config = readJson(path.join(home, 'config.json')) ?? {};
  const token = readText(path.join(home, 'token'));
  // Forward subscription rate limits to the daemon (rate-limited); runs alongside the status fetch so it
  // adds no latency beyond its own short timeout, and never affects the printed line.
  const model = modelIdOf(parsed);
  const limits = (!env[NESTED_ENV] && sessionId && (parsed.rate_limits || model))
    ? maybeSendLimits({ home, port: config.daemonPort, token, sessionId, rateLimits: parsed.rate_limits, model })
    : Promise.resolve();
  const [view, wrapped] = await Promise.all([
    fetchStatus({ home, port: config.daemonPort, token, sessionId }),
    env[NESTED_ENV] ? Promise.resolve('') : runWrapped(config.wrappedStatusLine, input, WRAPPED_TIMEOUT_MS, env),
    limits,
  ]);
  const router = view === null ? '[Router] OFF' : formatStatus(view);
  return wrapped ? `${router} | ${wrapped}` : router;
}

// Run directly (not imported by a test)? Compared by real path, so a plugin reached through a junction,
// symlink or `npm link` still runs (environment audit E1).
const real = p => { try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.stdout.write(`${await statusLine(await readStdin())}\n`);
  } catch {
    process.stdout.write('[Router] OFF\n');
  }
}
