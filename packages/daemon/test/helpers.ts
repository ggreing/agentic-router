// Test helpers: temp router home, temp git repos, spike fixtures, HTTP client.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS, type Level, type TeamPreset } from '@do-it-all-claude-code/core';
import { loadClaudeCodeAdapter, type ClientAdapter } from '../src/adapter.ts';
import { createDaemon, type Daemon, type DaemonOptions } from '../src/index.ts';

export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ar-${prefix}-`));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function makeHome(config: Record<string, unknown> = {}): string {
  const home = tmpDir('home');
  fs.writeFileSync(path.join(home, 'token'), TOKEN + '\n');
  // holdoutRate 0: no random holdout. delegateFrom.other L2: test daemons have no transcript, so the lead model is
  // unknown; most flows here were written for an L1 request that starts lead-direct (decision 88). Decision 144
  // made the real default L1 for an unknown lead; its own tests pass `delegateFrom: undefined` to get it.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: 0, fableOptIn: false, holdoutRate: 0, delegateFrom: { other: 'L2' }, ...config }));
  return home;
}

// ------------------------------------------------------------------ git

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A git repo with one commit containing `files`. */
export function makeRepo(files: Record<string, string> = { 'README.md': 'test repo\n' }): string {
  const dir = tmpDir('repo');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [f, body] of Object.entries(files)) write(dir, f, body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

export function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// ------------------------------------------------------------------ fixtures

const FIXTURES = fileURLToPath(new URL('../../adapter-claude-code/test/fixtures/', import.meta.url));

export type HookInput = Record<string, unknown>;

/** Hook inputs of a spike run (the `input` of each recorded line; probe log lines are dropped). */
export function loadSpike(name: 's1' | 's2' | 's5'): HookInput[] {
  return fs.readFileSync(path.join(FIXTURES, `spike-${name}.jsonl`), 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => JSON.parse(l) as { input?: HookInput }).filter(o => o.input).map(o => o.input!);
}

const AGENT_TYPES: Record<string, string> = { 'probe:coder': 'do-it-all-claude-code:coder', 'probe:coder-2': 'do-it-all-claude-code:coder', 'probe:wt-coder': 'do-it-all-claude-code:coder' };

/** Points a spike run at `root` (paths rewritten) and maps the probe agents to router agents. */
export function retarget(inputs: HookInput[], root: string): HookInput[] {
  const orig = String(inputs[0]!.cwd);
  const fix = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (AGENT_TYPES[v]) return AGENT_TYPES[v];
      if (v.startsWith(orig)) return root + v.slice(orig.length).replace(/\\/g, path.sep);
      return v.split(orig).join(root);
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return inputs.map(i => fix(i) as HookInput);
}

/** Applies `edit` to the Agent prompt everywhere it appears (tool_input and tool_response). */
export function editAgentPrompt(inputs: HookInput[], match: string, edit: (p: string) => string): void {
  for (const i of inputs) {
    for (const k of ['tool_input', 'tool_response'] as const) {
      const o = i[k] as { prompt?: unknown } | undefined;
      if (o && typeof o.prompt === 'string' && o.prompt.includes(match)) o.prompt = edit(o.prompt);
    }
  }
}

// ------------------------------------------------------------------ adapter

/** The real Claude Code adapter: every test goes through its conversion and rendering. */
export const claudeAdapter: ClientAdapter = await loadClaudeCodeAdapter();

// ------------------------------------------------------------------ daemon + HTTP

export interface TestDaemon extends Daemon { home: string }

export async function startTestDaemon(opts: DaemonOptions & { config?: Record<string, unknown> } = {}): Promise<TestDaemon> {
  const home = opts.home ?? makeHome(opts.config);
  const d = await createDaemon({ adapter: claudeAdapter, port: 0, ...opts, home });
  return Object.assign(d, { home });
}

export interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: unknown; text: string }

export function request(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export function postHook(port: number, input: HookInput): Promise<RawResponse> {
  return request(port, {
    method: 'POST', path: '/router/v1/hooks/claude-code', body: JSON.stringify(input),
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
}

export function getStatus(port: number, sessionId?: string): Promise<RawResponse> {
  return request(port, {
    path: `/router/v1/status${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

/** Ledger rows as plain objects, for assertions. */
export function rows(d: Daemon, sql: string, ...params: Array<string | number | null>): Array<Record<string, unknown>> {
  return (d.ledger.db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(r => ({ ...r }));
}

// ------------------------------------------------------------------ subagent transcripts (decision #4)

export const TRANSCRIPT_FIXTURE = fileURLToPath(new URL('./fixtures/subagent-transcript-e1.jsonl', import.meta.url));

/** The four API calls of the E1 coder in the fixture (one usage per message.id). */
export const FIXTURE_CALLS = [
  { input_tokens: 2, cache_creation_input_tokens: 7560, cache_read_input_tokens: 0, output_tokens: 295, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 7560 } },
  { input_tokens: 2, cache_creation_input_tokens: 3293, cache_read_input_tokens: 7560, output_tokens: 417, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 3293 } },
  { input_tokens: 2, cache_creation_input_tokens: 800, cache_read_input_tokens: 10853, output_tokens: 377, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 800 } },
  { input_tokens: 2, cache_creation_input_tokens: 594, cache_read_input_tokens: 11653, output_tokens: 388, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 594 } },
];

/** A copy of the transcript fixture at <dir>/subagents/agent-<id>.jsonl (absolute path). */
export function copyTranscript(dir: string, agentId: string): string {
  const file = path.join(dir, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(TRANSCRIPT_FIXTURE, file);
  return file;
}

// ------------------------------------------------------------------ presets

/** Decision 88 made L1 lead-direct by default; tests of team behaviour use the opt-out (`L1: { lead_direct: false }`). */
export const TEAM_L1_PRESETS: Record<Level, TeamPreset> = { ...DEFAULT_PRESETS, L1: { ...DEFAULT_PRESETS.L1, leadDirect: false } };
/** An L0 team that delegates with a fixed size (teams.yaml `L0: { lead_direct: false }`): no T6 re-plan. */
export const TEAM_L0_PRESETS: Record<Level, TeamPreset> = { ...DEFAULT_PRESETS, L0: { ...DEFAULT_PRESETS.L0, leadDirect: false } };
