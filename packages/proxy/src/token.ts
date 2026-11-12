// The local token Claude Code presents instead of the API key (decision 130: printed by bin/local-token.mjs as
// Claude Code's apiKeyHelper; the token is never in settings.json).
//
// Rotation (`agentic-router token rotate`) writes a new token to the file. The proxy notices on the next
// request and keeps accepting the previous token for a grace window, because Claude Code caches the helper's
// output (5 min by default, CLAUDE_CODE_API_KEY_HELPER_TTL_MS). After the window the old token gets 401.
// Tokens are compared in constant time; a token is identified in totals and rows by a short hash only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Helper cache (5 min) plus 5 min of margin. */
export const ROTATION_GRACE_MS = 10 * 60 * 1000;
export const MIN_TOKEN_LENGTH = 32;

export const tokenId = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 12);

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Writes a token file atomically, readable by the user only. */
export function writeTokenFile(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class LocalTokens {
  readonly #file: string;
  readonly #graceMs: number;
  readonly #now: () => number;
  #current = '';
  #mtimeMs = -1;
  #previous: { token: string; until: number } | undefined;
  readonly #onChange: ((added: string | undefined, removed?: string) => void) | undefined;

  constructor(file: string, o: { graceMs?: number; now?: () => number; onChange?: (added: string | undefined, removed?: string) => void } = {}) {
    this.#file = file;
    this.#graceMs = o.graceMs ?? ROTATION_GRACE_MS;
    this.#now = o.now ?? Date.now;
    this.#onChange = o.onChange;
    this.#reload(true);
  }

  /** Creates the token file when missing (the CLI normally does). */
  static ensure(file: string): void {
    if (!fs.existsSync(file)) writeTokenFile(file, newToken());
  }

  #reload(initial = false): void {
    let st: fs.Stats;
    try { st = fs.statSync(this.#file); } catch { if (initial) throw new Error(`local token file not found: ${this.#file}`); return; }
    if (st.mtimeMs === this.#mtimeMs) return;
    const token = fs.readFileSync(this.#file, 'utf8').trim();
    this.#mtimeMs = st.mtimeMs;
    if (token.length < MIN_TOKEN_LENGTH) { if (initial) throw new Error(`local token in ${this.#file} is too short`); return; }
    if (token === this.#current) return;
    const old = this.#current;
    if (old) this.#previous = { token: old, until: this.#now() + this.#graceMs };
    this.#current = token;
    this.#onChange?.(token, undefined);
  }

  /** Which token this is: 'current', 'previous' (inside the grace window) or null. */
  accept(presented: string | undefined): { id: string; which: 'current' | 'previous' } | null {
    this.#reload();
    if (!presented) return null;
    if (same(presented, this.#current)) return { id: tokenId(presented), which: 'current' };
    const p = this.#previous;
    if (p && this.#now() <= p.until && same(presented, p.token)) return { id: tokenId(presented), which: 'previous' };
    if (p && this.#now() > p.until) {
      this.#onChange?.(undefined, p.token);
      this.#previous = undefined;
    }
    return null;
  }

  /** Writes a new token now (what `token rotate` does from the CLI); the old one stays valid for the grace window. */
  rotate(): string {
    const token = newToken();
    writeTokenFile(this.#file, token);
    this.#mtimeMs = -1;
    this.#reload();
    return token;
  }

  /** The secrets currently accepted, for log masking. */
  secrets(): string[] {
    return [this.#current, ...(this.#previous ? [this.#previous.token] : [])];
  }
}
