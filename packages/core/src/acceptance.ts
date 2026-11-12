// User acceptance of a finished request (spec 3.8, decision 137): the rules that need no ledger.
//
// After a request closes, the next two user prompts of the session are watched for signs that the change
// was not accepted: its files went back to their start state, the same request came again, or the user
// said so. Nothing of a prompt is kept: the similarity is computed against the previous prompt held in
// memory and only the number is recorded; a dissatisfaction phrase is recorded by its rule id.
// "Accepted" therefore means "no objection seen": an upper bound, and the records say what was observed.

export const ACCEPTANCE_RULE_VERSION = 1;
/** The window: this many following user prompts of the session (requests or continuations). */
export const ACCEPT_WINDOW_PROMPTS = 2;

// ------------------------------------------------------------------ the same request again

export const SIMILARITY_MAX_CHARS = 4000;
/** A prompt shorter than this (after folding) is not compared: "yes", "go on" match too much. */
export const SIMILARITY_MIN_CHARS = 20;
/** Provisional (decision 137): tuned later from the recorded numbers. */
export const REASK_THRESHOLDS = { jaccard: 0.6, containment: 0.8 } as const;

/** NFKC, lower case, whitespace folded, cut to the first SIMILARITY_MAX_CHARS characters. */
export function foldPrompt(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, SIMILARITY_MAX_CHARS);
}

function trigrams(folded: string): Set<string> {
  const chars = [...folded];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

export interface PromptSimilarity {
  /** Shared character 3-grams over all 3-grams of both prompts. */
  jaccard: number;
  /** How much of the earlier prompt is inside the later one ("it still fails: <the old text>"). */
  containment: number;
}

/** Lexical similarity of a prompt to the one before it; undefined when either is too short to compare. */
export function promptSimilarity(previous: string, next: string): PromptSimilarity | undefined {
  const a = foldPrompt(previous);
  const b = foldPrompt(next);
  if (a.length < SIMILARITY_MIN_CHARS || b.length < SIMILARITY_MIN_CHARS) return undefined;
  const ga = trigrams(a);
  const gb = trigrams(b);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  const union = ga.size + gb.size - shared;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { jaccard: union ? round(shared / union) : 0, containment: ga.size ? round(shared / ga.size) : 0 };
}

/** Whether a similarity reads as the same request asked again. Wording only: a paraphrase is not caught. */
export function isReask(s: PromptSimilarity | undefined, t: { jaccard: number; containment: number } = REASK_THRESHOLDS): boolean {
  return !!s && (s.jaccard >= t.jaccard || s.containment >= t.containment);
}

// ------------------------------------------------------------------ explicit dissatisfaction

/** Looked for in the start of the next prompt only. A weak signal: "revert the migration" is a new task. */
export const DISSATISFACTION_RULES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'en-still-broken', re: /\bstill\s+(?:broken|failing|fails|wrong|not\s+working|doesn'?t\s+work|does\s+not\s+work)\b/i },
  { id: 'en-does-not-work', re: /\b(?:doesn'?t|does\s+not|didn'?t|did\s+not)\s+work\b|\bnot\s+working\b/i },
  { id: 'en-wrong', re: /\b(?:that'?s|that\s+is|this\s+is|it'?s|it\s+is)\s+(?:wrong|incorrect|not\s+what\s+i\s+(?:asked|wanted|meant))\b/i },
  { id: 'en-undo', re: /\b(?:undo|revert|roll\s*back)\s+(?:that|this|it|your|the\s+(?:last\s+)?changes?)\b/i },
  { id: 'ko-still', re: /아직(?:도)?\s*(?:안\s*(?:돼|되|됩)|똑같|그대로|실패|에러|오류)/ },
  { id: 'ko-not-working', re: /(?:안\s*(?:돼요?|됩니다|되는데|되네요?|된다)|동작(?:을)?\s*(?:안|하지\s*않)|작동(?:을)?\s*(?:안|하지\s*않))/ },
  { id: 'ko-wrong', re: /(?:틀렸|잘못\s*(?:됐|되었|했|고쳤|만들)|이게\s*아니|그게\s*아니)/ },
  { id: 'ko-undo', re: /(?:되돌려|원래대로|원상\s*복구|롤백|취소해)/ },
];
const DISSATISFACTION_HEAD_CHARS = 600;

/** The id of the first dissatisfaction rule the prompt's start matches, if any. */
export function dissatisfactionRule(prompt: string): string | undefined {
  const head = prompt.normalize('NFKC').slice(0, DISSATISFACTION_HEAD_CHARS);
  return DISSATISFACTION_RULES.find(r => r.re.test(head))?.id;
}

// ------------------------------------------------------------------ the request's files, looked at again

/** Fingerprint of a file that does not exist. */
export const ABSENT = '-';
/** A request counts as reverted when at least this share of its changed files is back at the start state. */
export const REVERTED_SHARE = 0.5;
/** Mostly deleted: the lines the request added are down by this share while the files are not reverted. */
export const DELETED_SHARE = 0.8;
export const MAX_END_STATE_FILES = 200;

/** One file a request changed: its content before and after, and the lines it has against the start commit. */
export interface FileEnd { path: string; start: string; end: string; added: number }
export interface FileNow { fp: string; added: number }

export interface FileSignals {
  checked: number;
  revertedFiles: number;
  /** Strong: enough of the changed files are back at their start state (a created file is gone). */
  reverted: boolean;
  /** Weak: most of the added lines are gone although the files are not at their start state. */
  mostlyDeleted: boolean;
  /** Every changed file still has the content the request left. */
  untouched: boolean;
}

export function fileSignals(end: readonly FileEnd[], now: Readonly<Record<string, FileNow>>): FileSignals {
  const seen = end.filter(f => now[f.path] !== undefined && f.start !== f.end);
  const revertedFiles = seen.filter(f => now[f.path]!.fp === f.start).length;
  const reverted = seen.length > 0 && revertedFiles >= Math.max(1, Math.ceil(seen.length * REVERTED_SHARE));
  const addedEnd = seen.reduce((s, f) => s + f.added, 0);
  const addedNow = seen.reduce((s, f) => s + Math.min(f.added, now[f.path]!.added), 0);
  return {
    checked: seen.length, revertedFiles, reverted,
    mostlyDeleted: !reverted && addedEnd > 0 && addedNow <= (1 - DELETED_SHARE) * addedEnd,
    untouched: seen.length > 0 && seen.every(f => now[f.path]!.fp === f.end),
  };
}

// ------------------------------------------------------------------ verdict

export type AcceptSignalKind = 'reverted' | 'mostly_deleted' | 'reask' | 'dissatisfied' | 'committed' | 'unavailable';
export interface AcceptSignal {
  kind: AcceptSignalKind;
  /** 1 or 2: the following prompt at which it was seen; 0 for a check without a prompt (session resume). */
  turn: number;
  at: string;
  /** reask: the similarity; dissatisfied: the rule id; unavailable: what could not be read. */
  value?: number | string;
}

export type Acceptance = 'accepted' | 'not_accepted' | 'unobserved' | 'n/a';

export interface AcceptanceState {
  /** The request changed files or delegated work; a question or a request without changes is n/a. */
  applicable: boolean;
  signals: readonly AcceptSignal[];
  /** Following user prompts seen so far. */
  promptsSeen: number;
  /** The session ended, or the record is being closed for good. */
  sessionEnded: boolean;
}

/**
 * Rule v1. Not accepted: reverted, or asked again, or the two weak signals together (a dissatisfaction
 * phrase and mostly deleted lines). A negative wins over a commit. Accepted: committed, or the window passed
 * with none of these. Unobserved: the session ended first. Undefined: the window is still open.
 */
export function acceptanceVerdict(s: AcceptanceState): Acceptance | undefined {
  if (!s.applicable) return 'n/a';
  const has = (k: AcceptSignalKind) => s.signals.some(x => x.kind === k);
  if (has('reverted') || has('reask') || (has('dissatisfied') && has('mostly_deleted'))) return 'not_accepted';
  if (has('committed') || s.promptsSeen >= ACCEPT_WINDOW_PROMPTS) return 'accepted';
  return s.sessionEnded ? 'unobserved' : undefined;
}

/** For the KPI: a request counts as an accepted task unless it was seen not to be (unobserved counts, with its share shown). */
export const countsAsAccepted = (a: Acceptance | null | undefined): boolean => a === 'accepted' || a === 'unobserved';
