// Decision 163: the daemon's side of the update check. While config.updateCheck is "on", a timer looks once an
// hour whether a check is due and asks GitHub at most once a day (core update.ts): never on the hook path, never
// blocking anything; a failure logs one line and keeps the last result. The router gets from here the notice for
// a session start (at most once a day per new version; the router hands it to the user as systemMessage, never
// as context) and the status view's line. Both are built from update.json; nothing from GitHub's answer but a
// checked tag reaches them.
import {
  UPDATE_INTERVAL_MS, checkForUpdate, readUpdateState, updateMessage, updateNotice, writeUpdateState,
  type FetchOptions, type UpdateNotice, type UpdateState,
} from '@do-it-all-claude-code/core';
import { readConfig } from './config.ts';
import { errorText, type Logger } from './log.ts';

export interface UpdateWatcherOptions {
  /** The router home (update.json) and its config.json. */
  home: string;
  configFile: string;
  /** The running version (package.json). */
  current: string;
  logger: Logger;
  now?: () => Date;
  /** Tests: the check itself (default: the request to GitHub). */
  check?: (home: string, o: FetchOptions & { now?: Date }) => ReturnType<typeof checkForUpdate>;
  /** How often the timer looks whether a check is due (1 h), and the first look after start (30 s). */
  tickMs?: number;
  firstTickMs?: number;
}

/** Fresh enough for status calls (the status line asks often): files are read again after this. */
const VIEW_MS = 30_000;

export type TickResult = 'off' | 'not due' | 'checked' | 'failed' | 'busy';

export class UpdateWatcher {
  readonly #o: UpdateWatcherOptions;
  #timers: NodeJS.Timeout[] = [];
  #running = false;
  #view: { at: number; on: boolean; state: UpdateState } | undefined;
  /** The last notice shown, also kept here, so a home that cannot be written does not repeat it at every start. */
  #shown: { version: string; at: number } | undefined;
  /** The last attempt, also kept here, so a home that cannot be written does not make every tick ask again. */
  #attempted: number | undefined;

  constructor(o: UpdateWatcherOptions) { this.#o = o; }

  #now(): number { return (this.#o.now?.() ?? new Date()).getTime(); }

  start(): void {
    const first = setTimeout(() => void this.tick(), this.#o.firstTickMs ?? 30_000);
    const every = setInterval(() => void this.tick(), this.#o.tickMs ?? 3_600_000);
    first.unref(); every.unref();
    this.#timers.push(first, every);
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  #on(): boolean {
    try { return readConfig(this.#o.configFile).updateCheck === 'on'; } catch { return false; }
  }

  #current(): { on: boolean; state: UpdateState } {
    const now = this.#now();
    if (!this.#view || now - this.#view.at > VIEW_MS || now < this.#view.at) this.#view = { at: now, on: this.#on(), state: readUpdateState(this.#o.home) };
    return this.#view;
  }

  /** One look: checks when the check is on and the last attempt is a day old (or in the future: a clock set back). */
  async tick(): Promise<TickResult> {
    if (this.#running) return 'busy';
    if (!this.#on()) return 'off';
    const now = this.#now();
    const recent = (last: number | undefined) => last !== undefined && Number.isFinite(last) && now >= last && now - last < UPDATE_INTERVAL_MS;
    if (recent(Date.parse(readUpdateState(this.#o.home).attemptedAt ?? '')) || recent(this.#attempted)) return 'not due';
    this.#attempted = now;
    this.#running = true;
    try {
      const { state, result } = await (this.#o.check ?? checkForUpdate)(this.#o.home, { now: new Date(now) });
      this.#view = undefined;
      if (result.ok) {
        this.#o.logger.info('update check', { latest: state.latest ?? null, unchanged: result.notModified });
        return 'checked';
      }
      this.#o.logger.warn('update check failed', { reason: result.reason });
      return 'failed';
    } catch (e) {
      this.#o.logger.warn('update check failed', { reason: errorText(e).slice(0, 200) });
      return 'failed';
    } finally { this.#running = false; }
  }

  /** The newer release while the check is on; null otherwise. */
  status(): UpdateNotice | null {
    const v = this.#current();
    return v.on ? updateNotice(v.state.latest, this.#o.current) : null;
  }

  /** The session-start notice, at most once a day per new version (recorded before it is returned); undefined otherwise. */
  sessionNotice(): string | undefined {
    const v = this.#current();
    if (!v.on) return undefined;
    const n = updateNotice(v.state.latest, this.#o.current);
    if (!n || !v.state.latest) return undefined;
    const now = this.#now();
    const recent = (version: string | undefined, at: number) => version === v.state.latest && now >= at && now - at < UPDATE_INTERVAL_MS;
    if (this.#shown && recent(this.#shown.version, this.#shown.at)) return undefined;
    const fileShown = v.state.notified;
    if (fileShown && recent(fileShown.version, Date.parse(fileShown.at))) return undefined;
    this.#shown = { version: v.state.latest, at: now };
    try {
      const s = readUpdateState(this.#o.home);
      s.notified = { version: v.state.latest, at: new Date(now).toISOString() };
      writeUpdateState(this.#o.home, s);
    } catch (e) { this.#o.logger.warn('update notice not recorded', { error: errorText(e).slice(0, 200) }); }
    this.#view = undefined;
    return updateMessage(n);
  }
}
