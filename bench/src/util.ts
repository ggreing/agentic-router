import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS = path.join(BENCH, 'results');

export function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function copyDir(src: string, dst: string): void {
  fs.cpSync(src, dst, { recursive: true, force: true });
}

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }

// Runs a process with a hard timeout. On Windows the whole process tree is killed.
export function exec(cmd: string, args: string[], opts: {
  cwd: string; env?: Record<string, string>; input?: string; timeoutSec?: number; shell?: boolean;
}): Promise<ExecResult> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: opts.shell ?? false, windowsHide: true });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = opts.timeoutSec ? setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    }, opts.timeoutSec * 1000) : null;
    child.on('error', e => { stderr += String(e); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - t0 });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
  });
}

export async function git(cwd: string, ...args: string[]): Promise<ExecResult> {
  return exec('git', args, { cwd });
}

export function parseList(v: string | undefined): string[] | undefined {
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined;
}
