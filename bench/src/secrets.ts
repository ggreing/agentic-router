// Credential handling for benchmark runs.
//
// Goals (spec 4.4, "credential theft and leakage"):
//  - The harness never reads, prints or stores the API key. Preferred channel: Claude Code's
//    apiKeyHelper runs a keychain lookup command inside the child process.
//  - The child never sees the user's Claude.ai subscription credentials: runs use --bare
//    (OAuth and keychain are never read) and a fresh CLAUDE_CONFIG_DIR per run.
//  - The child gets an allow-listed environment, so unrelated secrets in the parent
//    environment (cloud keys, tokens) are not visible to the agent's Bash tool.
//  - Anything written to results/ is passed through redact().
import type { AuthChannel } from './types.ts';

// Environment variables the child Claude Code process may inherit. Everything else is dropped.
const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'USERNAME', 'LOGNAME',
];

export function childEnv(configDir: string, auth: AuthChannel): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = configDir;          // isolated config: no access to the user's ~/.claude
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_ERROR_REPORTING = '1';
  void auth;                                  // the key reaches the child only via apiKeyHelper (--settings)
  return env;
}

// Permission rules passed to the child via --settings. Reads of credential stores and
// environment dumps are denied even if a prompt (or prompt injection) asks for them.
export const CREDENTIAL_DENY = [
  'Read(~/.claude/**)', 'Read(~/.claude.json)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)',
  'Read(~/.config/gcloud/**)', 'Read(~/.azure/**)', 'Read(~/.docker/config.json)',
  'Read(~/.npmrc)', 'Read(~/.netrc)', 'Read(~/.git-credentials)',
  'Read(**/.env)', 'Read(**/.env.*)',
  'Bash(env)', 'Bash(env:*)', 'Bash(printenv:*)', 'Bash(set)',
  'Bash(security:*)', 'Bash(secret-tool:*)', 'Bash(cmdkey:*)',
];

// Bash commands the agent may run without a prompt (headless runs auto-deny anything else).
export const BASH_ALLOW = [
  'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npx tsc:*)', 'Bash(git status:*)', 'Bash(git diff:*)',
  'Bash(git log:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)',
];

// Built-in tools available to the agent. No WebFetch/WebSearch: nothing can be sent out except
// through the model API itself.
export const TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

export function childSettings(auth: AuthChannel): string {
  const s: Record<string, unknown> = { permissions: { deny: CREDENTIAL_DENY } };
  if (auth.kind === 'api-key-helper' && auth.helperCmd) s.apiKeyHelper = auth.helperCmd;
  return JSON.stringify(s);
}

// Anthropic key / OAuth token shapes plus generic bearer tokens.
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /(authorization|x-api-key)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\b(bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export function redact(text: string, extra: string[] = []): string {
  let out = text;
  for (const s of extra) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, m => m.slice(0, 7) + '…[REDACTED]');
  return out;
}

export function redactDeep<T>(value: T, extra: string[] = []): T {
  return JSON.parse(redact(JSON.stringify(value), extra)) as T;
}

// Resolve the auth channel. The harness only ever holds the helper *command*, never the key.
// ANTHROPIC_API_KEY in the parent environment is deliberately ignored (and not passed on).
export function resolveAuth(opts: { apiKeyHelper?: string }): AuthChannel {
  const helper = opts.apiKeyHelper || process.env.BENCH_API_KEY_HELPER;
  if (helper) return { kind: 'api-key-helper', helperCmd: helper };
  return { kind: 'none' };
}

export function describeAuth(a: AuthChannel): string {
  if (a.kind === 'api-key-helper') return 'apiKeyHelper (OS keychain command, run inside Claude Code; key never seen by the harness)';
  const envNote = process.env.ANTHROPIC_API_KEY ? ' (ANTHROPIC_API_KEY found in environment: ignored — keychain only)' : '';
  return 'none — runs cannot execute' + envNote;
}
