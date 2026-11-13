// Masked JSON-lines log at <home>/logs/daemon.log. The daemon never writes to the console.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '@do-it-all-claude-code/core';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LINE = 8192;

export function fileLogger(dir: string, secrets: string[] = []): Logger {
  const file = path.join(dir, 'daemon.log');
  const write = (level: string, msg: string, data?: Record<string, unknown>) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let line = redact(JSON.stringify({ t: new Date().toISOString(), level, msg, ...data }), secrets);
      if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE) + '…[truncated]';
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch { /* no log yet */ }
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch { /* logging must never break the daemon */ }
  };
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
