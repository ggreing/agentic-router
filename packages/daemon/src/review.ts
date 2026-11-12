// The verdict of a reviewer or tester, read from the two lines its report begins with (decision 145):
//
//   Verdict: accept | reject
//   Margin: easy | normal
//
// The daemon reads them from the subagent's last message when the subagent stops and applies them as a
// router_report_result by that role would be applied. Only these tokens leave this module: the report's
// text is not stored anywhere (decision 141).

export interface ReportVerdict { verdict: 'accept' | 'reject'; margin?: 'easy' | 'normal' }

const MAX_REPORT_CHARS = 20_000;
// markdown emphasis, a list dash or a quote mark may surround the words; "accepted" / "rejected" are read too
const VERDICT = /(?:^|[\s>*_`~|-])verdict[*_`]*\s*:\s*[*_`]*\s*(accept|reject)(?:ed)?\b/gi;
const MARGIN = /(?:^|[\s>*_`~|-])margin[*_`]*\s*:\s*[*_`]*\s*(easy|normal)\b/gi;

function only<T extends string>(text: string, re: RegExp): T | undefined {
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[1]!.toLowerCase());
  return found.size === 1 ? ([...found][0] as T) : undefined;
}

/**
 * The verdict a report states, or undefined when it states none or more than one (a report that repeats
 * its instructions, "Verdict: accept or Verdict: reject", says nothing). A margin counts with an accept only;
 * two different margins count as none.
 */
export function parseReportVerdict(lastMessage: unknown): ReportVerdict | undefined {
  if (typeof lastMessage !== 'string' || !lastMessage) return undefined;
  const text = lastMessage.slice(0, MAX_REPORT_CHARS);
  const verdict = only<'accept' | 'reject'>(text, VERDICT);
  if (!verdict) return undefined;
  const margin = verdict === 'accept' ? only<'easy' | 'normal'>(text, MARGIN) : undefined;
  return { verdict, ...(margin ? { margin } : {}) };
}

const SCOPE_REQUEST = /(?:^|[\s>*_`~|-])scope request[*_`]*\s*:\s*[*_`]*\s*([^\n]*)/i;
const NOTHING = /^(?:none|no|n\/a|nothing|-|—)?[.*_`\s]*$/i;

/** Whether a worker's report asks for paths outside its scope (its "Scope request:" item is not "none"). */
export function reportAsksForScope(lastMessage: unknown): boolean {
  if (typeof lastMessage !== 'string') return false;
  const m = SCOPE_REQUEST.exec(lastMessage.slice(0, MAX_REPORT_CHARS));
  return !!m && !NOTHING.test(m[1]!.trim());
}
