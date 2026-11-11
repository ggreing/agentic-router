// Where verify commands come from (decision Q2): the role file's `x-router.verify` is the default;
// the project's `.agentic-router/verify.json` overrides it. Role files live in
// <config.pluginDir>/agents/<role>.md and are parsed by core's parseRoleFile (decision 64);
// without pluginDir only the scope check runs.
//
// The project file is read from the commit the subagent started on (when known), so a subagent
// cannot weaken its own verification by editing the file.
import fs from 'node:fs';
import path from 'node:path';
import { parseRoleFile, type Role, type SignalKind } from '@agentic-router/core';
import { showFile } from './git.ts';
import { validTreePath, type VerifyCommand } from './verify.ts';

export const PROJECT_VERIFY_FILE = '.agentic-router/verify.json';

export type VerifySource = 'project' | 'role' | 'none';

export interface VerifySourceInput {
  role: Role;
  pluginDir?: string;
  repoRoot?: string;
  baseRef?: string;
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function resolveVerifyCommands(i: VerifySourceInput): Promise<{ commands: VerifyCommand[]; source: VerifySource; warning?: string }> {
  const warnings: string[] = [];
  const done = (commands: VerifyCommand[], source: VerifySource) => ({ commands, source, ...(warnings.length ? { warning: warnings.join('; ') } : {}) });
  if (i.repoRoot) {
    const text = i.baseRef ? await showFile(i.repoRoot, i.baseRef, PROJECT_VERIFY_FILE) : readIfExists(path.join(i.repoRoot, PROJECT_VERIFY_FILE));
    if (text !== undefined) {
      try {
        const cmds = projectCommands(JSON.parse(text), i.role);
        if (cmds) return done(cmds, 'project');
      } catch (e) {
        warnings.push(`${PROJECT_VERIFY_FILE} ignored: ${why(e)}`);
      }
    }
  }
  if (i.pluginDir) {
    const file = path.join(i.pluginDir, 'agents', `${i.role}.md`);
    const text = readIfExists(file);
    if (text !== undefined) {
      try {
        return done(parseRoleFile(text).verify.map(x => toCommand(parseItem(x))), 'role');
      } catch (e) {
        warnings.push(`role file ${file} ignored: ${why(e)}`);
      }
    }
  }
  return done([], 'none');
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ entries (project file and role file)

type Item = string | { kind?: SignalKind; command: string; timeoutMs?: number; ifExists?: string; ifMissing?: string };
const KINDS: readonly SignalKind[] = ['build', 'typecheck', 'lint', 'test', 'scope', 'review', 'error_repeat', 'max_turns', 'tool_error'];

/** `{ "<role>": Item[], "*": Item[] }`; the role's own list wins over "*". Undefined when neither is present. */
export function projectCommands(doc: unknown, role: Role): VerifyCommand[] | undefined {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected an object of role -> command list');
  const o = doc as Record<string, unknown>;
  const list = o[role] ?? o['*'];
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Error(`"${role in o ? role : '*'}" must be a list`);
  return list.map(x => toCommand(parseItem(x)));
}

function parseItem(x: unknown): Item {
  if (typeof x === 'string' && x.trim()) return x.trim();
  if (x && typeof x === 'object' && typeof (x as { command?: unknown }).command === 'string') {
    const o = x as { kind?: unknown; command: string; timeoutMs?: unknown; ifExists?: unknown; ifMissing?: unknown };
    if (o.kind !== undefined && !KINDS.includes(o.kind as SignalKind)) throw new Error(`unknown kind "${String(o.kind)}"`);
    for (const k of ['ifExists', 'ifMissing'] as const) {
      const v = o[k];
      if (v !== undefined && (typeof v !== 'string' || !validTreePath(v))) throw new Error(`${k} must be a repo-relative path inside the repository: ${String(v)}`);
    }
    return {
      command: o.command,
      ...(o.kind ? { kind: o.kind as SignalKind } : {}),
      ...(typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? { timeoutMs: o.timeoutMs } : {}),
      ...(typeof o.ifExists === 'string' ? { ifExists: o.ifExists } : {}),
      ...(typeof o.ifMissing === 'string' ? { ifMissing: o.ifMissing } : {}),
    };
  }
  throw new Error('each command must be a string or { command, kind?, timeoutMs?, ifExists?, ifMissing? }');
}

function toCommand(x: Item): VerifyCommand {
  if (typeof x === 'string') return { kind: inferKind(x), command: x };
  return {
    kind: x.kind ?? inferKind(x.command), command: x.command,
    ...(x.timeoutMs ? { timeoutMs: x.timeoutMs } : {}), ...(x.ifExists ? { ifExists: x.ifExists } : {}),
    ...(x.ifMissing ? { ifMissing: x.ifMissing } : {}),
  };
}

export function inferKind(command: string): SignalKind {
  if (/\b(tsc|typecheck|type-check|mypy|pyright)\b/i.test(command)) return 'typecheck';
  if (/\b(lint|eslint|ruff|flake8|pylint|biome|clippy)\b/i.test(command)) return 'lint';
  if (/\bbuild\b/i.test(command)) return 'build';
  return 'test';
}
