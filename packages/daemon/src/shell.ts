// Decision 98: verify commands run in bash on every OS, so one command line (`npm ci && npm test`,
// `FOO=1 make`, quoting) means the same on Windows, macOS and Linux.
//   Windows  CLAUDE_CODE_GIT_BASH_PATH -> the Git for Windows install found from `git --exec-path`
//            -> bash.exe on PATH (never the WSL launchers in System32 / WindowsApps). Not found: the
//            verify commands are held ("bash not found"), not run in cmd.exe.
//   POSIX    /bin/bash, else /bin/sh.
// Also: a test command that ran no tests is not a pass (zeroTestsRan).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from './env.ts';

export type Shell = { ok: true; file: string; name: 'bash' | 'sh' } | { ok: false; reason: string };

export const BASH_NOT_FOUND = 'bash not found (install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH)';

export interface ShellProbe {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  isFile?: (p: string) => boolean;
  gitExecPath?: () => Promise<string | undefined>;
}

const isFileDefault = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function gitExecPathDefault(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['--exec-path'], { timeout: 5000, windowsHide: true, encoding: 'utf8', env: gitEnv() },
      (err, out) => resolve(err ? undefined : out.trim() || undefined));
  });
}

let cached: { key: string; shell: Promise<Shell> } | undefined;

/** The shell for verify commands; the result is cached per CLAUDE_CODE_GIT_BASH_PATH value. */
export function verifyShell(env: NodeJS.ProcessEnv = process.env): Promise<Shell> {
  const key = `${process.platform}|${env.CLAUDE_CODE_GIT_BASH_PATH ?? ''}`;
  if (cached?.key !== key) cached = { key, shell: findShell({ env }) };
  return cached.shell;
}

export async function findShell(p: ShellProbe = {}): Promise<Shell> {
  const platform = p.platform ?? process.platform;
  const env = p.env ?? process.env;
  const isFile = p.isFile ?? isFileDefault;
  if (platform !== 'win32') {
    if (isFile('/bin/bash')) return { ok: true, file: '/bin/bash', name: 'bash' };
    return { ok: true, file: '/bin/sh', name: 'sh' };
  }
  const win = path.win32;
  const configured = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (configured && isFile(configured)) return { ok: true, file: configured, name: 'bash' };
  const exec = await (p.gitExecPath ?? gitExecPathDefault)();
  if (exec) {
    // <Git>\mingw64\libexec\git-core -> <Git>\bin\bash.exe (the launcher that sets up PATH), then usr\bin
    for (const rel of ['../../../bin/bash.exe', '../../../usr/bin/bash.exe', '../../bin/bash.exe']) {
      const candidate = win.resolve(exec, rel);
      if (isFile(candidate)) return { ok: true, file: candidate, name: 'bash' };
    }
  }
  const sysRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows').toLowerCase();
  const pathVar = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '';
  for (const dir of pathVar.split(';').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const candidate = win.join(dir, 'bash.exe');
    const lower = candidate.toLowerCase();
    if (lower.startsWith(sysRoot) || lower.includes('\\windowsapps\\')) continue;   // WSL, not Git Bash
    if (isFile(candidate)) return { ok: true, file: candidate, name: 'bash' };
  }
  return { ok: false, reason: BASH_NOT_FOUND };
}

// ------------------------------------------------------------------ zero tests

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Decision 98: which test runner reported that it ran no tests, or undefined. A run with no tests proves
 * nothing, so it is a miss even with exit code 0 (e.g. a glob that matches no files).
 */
export function zeroTestsRan(command: string, output: string, code: number | null): string | undefined {
  const text = output.replace(ANSI, '');
  const counts = (re: RegExp) => [...text.matchAll(re)].map(m => Number(m[1]));
  const allZero = (n: number[]) => n.length > 0 && n.every(x => x === 0);
  // node --test, spec reporter "ℹ tests 0", TAP "# tests 0"; several runs (workspaces) count only if all are 0
  if (allZero(counts(/^\s*(?:ℹ|#)\s*tests\s+(\d+)\s*$/gm))) return 'node --test: tests 0';
  if (/\bno tests ran\b/i.test(text) || (code === 5 && /\b(pytest|py\.test)\b/.test(command))) return 'pytest: no tests ran';
  if (/\bNo test files found\b/.test(text)) return 'vitest: No test files found';
  if (/\bNo tests found\b/.test(text)) return 'jest: No tests found';
  if (/^\s*0 passing\b/m.test(text) && !/^\s*[1-9]\d* passing\b/m.test(text)) return 'mocha: 0 passing';
  return undefined;
}
