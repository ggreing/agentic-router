// Runs one benchmark task with a headless, isolated Claude Code session.
// Isolation: --bare (no user hooks/plugins/CLAUDE.md/auto-memory; never reads OAuth or keychain),
// --strict-mcp-config (no MCP servers), --no-session-persistence (no transcript on disk),
// fresh CLAUDE_CONFIG_DIR, allow-listed env, credential-read deny rules, no web tools.
import type { AuthChannel, PlannedRun } from '../types.ts';
import { BASH_ALLOW, TOOLS, childEnv, childSettings, redact } from '../secrets.ts';
import { exec } from '../util.ts';

export interface ClaudeOutcome {
  exitCode: number | null; timedOut: boolean; durationMs: number; costUsd: number; numTurns: number | null;
  isError: boolean; subtype: string | null; resolvedModels: string[]; usage: Record<string, unknown> | null;
  resultText: string; stderr: string;
}

export function claudeArgs(run: PlannedRun, auth: AuthChannel): string[] {
  return [
    '-p', '--bare', '--strict-mcp-config', '--no-session-persistence',
    '--output-format', 'json',
    '--model', run.config.model, '--effort', run.config.effort,
    '--max-budget-usd', String(run.capUsd),
    '--permission-mode', 'acceptEdits',
    '--tools', TOOLS,
    '--settings', childSettings(auth),
    '--allowedTools', ...BASH_ALLOW,
  ];
}

export async function runClaude(run: PlannedRun, repo: string, configDir: string, prompt: string, auth: AuthChannel): Promise<ClaudeOutcome> {
  const secrets: string[] = [];   // the harness never holds the key; pattern-based redaction still applies
  const r = await exec('claude', claudeArgs(run, auth), {
    cwd: repo, env: childEnv(configDir, auth), input: prompt, timeoutSec: run.task.limits.timeoutSec,
  });
  let j: Record<string, any> = {};
  try { j = JSON.parse(r.stdout); } catch { /* non-JSON output: keep defaults */ }
  return {
    exitCode: r.code, timedOut: r.timedOut, durationMs: r.ms,
    costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0,
    numTurns: typeof j.num_turns === 'number' ? j.num_turns : null,
    isError: j.is_error === true || r.code !== 0,
    subtype: j.subtype ?? null,
    resolvedModels: j.modelUsage ? Object.keys(j.modelUsage) : [],
    usage: j.usage ?? null,
    resultText: redact(String(j.result ?? r.stdout).slice(0, 4000), secrets),
    stderr: redact(r.stderr.slice(0, 2000), secrets),
  };
}
