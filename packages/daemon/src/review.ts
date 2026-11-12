// The verdict of a reviewer or tester, read from the two lines its report begins with (decision 145):
//
//   Verdict: accept | reject
//   Margin: easy | normal
//
// The daemon reads them from the subagent's last message when the subagent stops and applies them as a
// router_report_result by that role would be applied. Only these tokens leave this module: the report's
// text is not stored anywhere (decision 141).

export interface ReportVerdict { verdict: 'accept' | 'reject'; margin?: 'easy' | 'normal'; subtasks?: string[] }

const MAX_REPORT_CHARS = 20_000;
// markdown emphasis, a list dash or a quote mark may surround the words; "accepted" / "rejected" are read too
const VERDICT = /(?:^|[\s>*_`~|-])verdict[*_`]*\s*:\s*[*_`]*\s*(accept|reject)(?:ed)?\b/gi;
const MARGIN = /(?:^|[\s>*_`~|-])margin[*_`]*\s*:\s*[*_`]*\s*(easy|normal)\b/gi;
// Appendix B: a judge that reviewed more than one writer names which writer subtask(s) the verdict is about:
//   Subtask: <id>[, <id>...]
const SUBTASK = /(?:^|[\s>*_`~|-])subtasks?[*_`]*\s*:\s*[*_`]*\s*([^\n]+)/gi;

function only<T extends string>(text: string, re: RegExp): T | undefined {
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[1]!.toLowerCase());
  return found.size === 1 ? ([...found][0] as T) : undefined;
}

/** The subtask ids a "Subtask:" line names, or undefined when there is none. A line with a placeholder (the
 *  echoed instruction, `<id>`) or no id-shaped token names nothing. The ids are not checked here; the caller
 *  compares them against the writers the judge actually reviewed. */
function subtaskIds(text: string): string[] | undefined {
  const ids = new Set<string>();
  for (const m of text.matchAll(SUBTASK)) {
    const line = m[1]!;
    if (/[<>]/.test(line)) continue;                               // an echoed instruction placeholder, not real ids
    for (const id of line.match(/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}/g) ?? []) if (!/^(?:none|all|n\/?a)$/i.test(id)) ids.add(id);
  }
  return ids.size ? [...ids] : undefined;
}

/**
 * The verdict a report states, or undefined when it states none or more than one (a report that repeats
 * its instructions, "Verdict: accept or Verdict: reject", says nothing). A margin counts with an accept only;
 * two different margins count as none. `subtasks` are the ids of a "Subtask:" line when one is present.
 */
export function parseReportVerdict(lastMessage: unknown): ReportVerdict | undefined {
  if (typeof lastMessage !== 'string' || !lastMessage) return undefined;
  const text = lastMessage.slice(0, MAX_REPORT_CHARS);
  const verdict = only<'accept' | 'reject'>(text, VERDICT);
  if (!verdict) return undefined;
  const margin = verdict === 'accept' ? only<'easy' | 'normal'>(text, MARGIN) : undefined;
  const subtasks = subtaskIds(text);
  return { verdict, ...(margin ? { margin } : {}), ...(subtasks ? { subtasks } : {}) };
}

const SCOPE_REQUEST = /(?:^|[\s>*_`~|-])scope request[*_`]*\s*:\s*[*_`]*\s*([^\n]*)/i;
const NOTHING = /^(?:none|no|n\/a|nothing|-|—)?[.*_`\s]*$/i;

/** Whether a worker's report asks for paths outside its scope (its "Scope request:" item is not "none"). */
export function reportAsksForScope(lastMessage: unknown): boolean {
  if (typeof lastMessage !== 'string') return false;
  const m = SCOPE_REQUEST.exec(lastMessage.slice(0, MAX_REPORT_CHARS));
  return !!m && !NOTHING.test(m[1]!.trim());
}
