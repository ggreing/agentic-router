// User acceptance on the daemon side (spec 3.8, decision 137): the parts that hold state outside the ledger.
//
// The previous prompts of a session are kept in memory only, to compare the next prompt with them. They are
// never written anywhere; what is recorded is the similarity (two numbers) and, for a dissatisfaction
// phrase, the id of the rule that matched. A daemon restart loses them; the re-ask signal is then missing
// for the requests that were open, and the record says so.
import { ACCEPT_WINDOW_PROMPTS, acceptanceVerdict, type AcceptSignal, type Acceptance } from '@do-it-all-claude-code/core';
import type { AcceptState } from './ledger.ts';

export const PROMPT_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;

interface Kept { requestId: string; prompt: string; at: number }

export class PromptMemory {
  readonly #bySession = new Map<string, Kept[]>();

  /** Keeps the prompt that opened a request; a session holds as many as the acceptance window is long. */
  remember(sessionId: string, requestId: string, prompt: string, now: number): void {
    if (!prompt.trim()) return;
    const list = (this.#bySession.get(sessionId) ?? []).filter(k => k.requestId !== requestId && now - k.at <= PROMPT_MEMORY_TTL_MS);
    list.push({ requestId, prompt, at: now });
    this.#bySession.delete(sessionId);
    this.#bySession.set(sessionId, list.slice(-ACCEPT_WINDOW_PROMPTS));
    while (this.#bySession.size > MAX_SESSIONS) this.#bySession.delete(this.#bySession.keys().next().value!);
  }

  get(sessionId: string, requestId: string, now: number): string | undefined {
    const k = this.#bySession.get(sessionId)?.find(x => x.requestId === requestId);
    return k && now - k.at <= PROMPT_MEMORY_TTL_MS ? k.prompt : undefined;
  }

  forget(sessionId: string, requestId: string): void {
    const list = this.#bySession.get(sessionId)?.filter(k => k.requestId !== requestId);
    if (!list) return;
    if (list.length) this.#bySession.set(sessionId, list); else this.#bySession.delete(sessionId);
  }

  get size(): number {
    let n = 0;
    for (const l of this.#bySession.values()) n += l.length;
    return n;
  }
}

export const newAcceptState = (): AcceptState => ({ promptsSeen: 0, signals: [], similarity: [], done: false });

/** Adds a signal once per kind (the first sighting is kept). */
export function addSignal(state: AcceptState, sig: AcceptSignal): void {
  if (!state.signals.some(x => x.kind === sig.kind)) state.signals.push(sig);
}

/**
 * The acceptance to store now. While the window is open and nothing was seen it is 'unobserved': exactly
 * what is known, and what stays if the session ends here.
 */
export function storedAcceptance(state: AcceptState): Acceptance {
  if (state.applicable === false) return 'n/a';
  return acceptanceVerdict({ applicable: true, signals: state.signals, promptsSeen: state.promptsSeen, sessionEnded: false }) ?? 'unobserved';
}

/** The `acceptance` object of the request record. */
export function acceptanceBlob(state: AcceptState, ruleVersion: number): Record<string, unknown> {
  return {
    verdict: storedAcceptance(state), ruleVersion, window: ACCEPT_WINDOW_PROMPTS, promptsSeen: state.promptsSeen,
    signals: state.signals, similarity: state.similarity, done: state.done,
  };
}
