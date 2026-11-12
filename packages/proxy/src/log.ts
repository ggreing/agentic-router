// JSON-lines log for the proxy. Every line is masked: the secrets the proxy holds (the API key, the local
// tokens) are replaced wherever they appear, and anything shaped like an Anthropic key or a bearer value too.
// Request and response bodies and headers are never logged.
import fs from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /\b(bearer)\s+[A-Za-z0-9+/=._~-]{12,}/gi];
/** Credentials in a URL (a corporate proxy's user:password@): the scheme and host stay, the userinfo goes. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@"]{1,256}@/gi;

export class Masker {
  readonly #secrets = new Set<string>();
  add(secret: string | undefined): void {
    if (secret && secret.length >= 8) this.#secrets.add(secret);
  }
  remove(secret: string | undefined): void {
    if (secret) this.#secrets.delete(secret);
  }
  mask(text: string): string {
    let out = text;
    for (const s of this.#secrets) {
      out = out.split(s).join('[REDACTED]');
      // the line is already JSON, so a secret with a quote or backslash appears escaped — mask that form too (D)
      const esc = JSON.stringify(s).slice(1, -1);
      if (esc !== s) out = out.split(esc).join('[REDACTED]');
    }
    for (const re of PATTERNS) out = out.replace(re, m => (/^bearer/i.test(m) ? 'Bearer [REDACTED]' : '[REDACTED]'));
    out = out.replace(URL_USERINFO, (_m, scheme: string) => `${scheme}[REDACTED]@`);
    return out;
  }
}

export function fileLogger(file: string, masker: Masker, now: () => Date = () => new Date()): Logger {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const write = (level: string, msg: string, data?: Record<string, unknown>) => {
    try {
      const line = masker.mask(JSON.stringify({ t: now().toISOString(), level, msg, ...(data ?? {}) }));
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch { /* logging never breaks the proxy */ }
  };
  return { info: (m, d) => write('info', m, d), warn: (m, d) => write('warn', m, d), error: (m, d) => write('error', m, d) };
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);
