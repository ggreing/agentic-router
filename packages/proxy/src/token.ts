// The local token Claude Code presents instead of the API key (decision 130: printed by bin/local-token.mjs as
// Claude Code's apiKeyHelper; the token is never in settings.json).
//
// Every proxy start writes a new token (decision 156, freshAtStart): a token from before the restart gets 401.
// Rotation (`agentic-router token rotate`) writes a new token to the file. The proxy notices on the next
// request and keeps accepting the previous token for a grace window, because Claude Code caches the helper's
// output (CLAUDE_CODE_API_KEY_HELPER_TTL_MS: 5 min by default, 60 s in proxy mode, set by `mode api`). After the
// window the old token gets 401.
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

// C3: the rotation grace is measured from rotation time, not from when the proxy next reads the file. The
// rotator (this class, or the CLI's `token rotate`) records the moment and whether a grace applies in a
// side file; the proxy reads it when it notices the new token. `grace: false` (token rotate --no-grace)
// invalidates the previous token at once.
const metaFile = (file: string): string => `${file}.rotated`;
export function writeRotationMeta(file: string, at: number, grace: boolean): void {
  try { fs.writeFileSync(metaFile(file), JSON.stringify({ at, grace }), { mode: 0o600 }); } catch { /* best effort */ }
}
function readRotationMeta(file: string): { at?: number; grace?: boolean } | null {
  try { const v = JSON.parse(fs.readFileSync(metaFile(file), 'utf8')) as unknown; return v && typeof v === 'object' ? v as { at?: number; grace?: boolean } : null; }
  catch { return null; }
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
    if (old) {
      const meta = readRotationMeta(this.#file);
      const graceMs = meta && meta.grace === false ? 0 : this.#graceMs;
      // measure from the recorded rotation time, clamped to now so a future-dated meta can't extend the window
      const at = Math.min(typeof meta?.at === 'number' ? meta.at : this.#now(), this.#now());
      this.#previous = graceMs > 0 ? { token: old, until: at + graceMs } : undefined;
    }
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

  /** Writes a new token now (what `token rotate` does); the old one stays valid for the grace window unless
   *  `grace: false` (token rotate --no-grace). The rotation time is recorded so the grace starts now (C3). */
  rotate(opts: { grace?: boolean } = {}): string {
    const token = newToken();
    writeRotationMeta(this.#file, this.#now(), opts.grace !== false);
    writeTokenFile(this.#file, token);
    this.#mtimeMs = -1;
    this.#reload();
    return token;
  }

  /** The secrets currently accepted, for log masking. */
  secrets(): string[] {
    return [this.#current, ...(this.#previous ? [this.#previous.token] : [])];
  }

  /** The current token (the file re-read first), for the proof answer (proof.ts); never sent anywhere. */
  current(): string {
    this.#reload();
    return this.#current;
  }

  /**
   * Decision 156: a fresh token at every proxy start, with no grace for the old one. A token handed out before the
   * restart, to Claude Code or to a program that held the port meanwhile, gets 401; Claude Code then runs the
   * helper again (it does on a 401), which checks this proxy before it prints the new token.
   */
  static freshAtStart(file: string): void {
    try { fs.rmSync(metaFile(file), { force: true }); } catch { /* none */ }
    writeTokenFile(file, newToken());
  }
}
