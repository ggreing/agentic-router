// Whether a submitted prompt starts a new request (spec 3.2: an HITL answer or `/router resume`
// is not a new request).
//
// Decision Q1 (2026-11-10): explicit markers only.
//   - `/router resume` (or `/do-it-all-claude-code:router resume`) continues the session's latest request.
//   - When the lead asks the user something it ends its message with AWAITING_USER_MARKER; Stop then
//     parks the request as `awaiting_user` and the next prompt continues it (no triage, no team brief).
//   - `/router level <L0-L3>` sets the level manually (see Router#routerLevel).
//   - Any other slash command is not triaged.
//   - A background-task notification (Claude Code delivers an async subagent's result as a prompt that
//     starts with `<task-notification>`) is not a new request (decision after integration run 2).
import type { Level } from '@do-it-all-claude-code/core';
import type { RequestStatus } from './ledger.ts';

export const AWAITING_USER_MARKER = '[router:awaiting-user]';

const ROUTER_CMD = /^\s*\/(?:do-it-all-claude-code:)?router\s+(\S+)(?:\s+(\S+))?/i;
const SLASH_COMMAND = /^\s*\/[A-Za-z][\w-]*(?::[\w-]+)?(?:\s|$)/;

export const TASK_NOTIFICATION = /^\s*<task-notification[\s>]/;

export type PromptClass =
  | { kind: 'new' }
  | { kind: 'continue' }
  | { kind: 'resume' }
  | { kind: 'level'; level: Level | null }   // null: missing or invalid level argument
  | { kind: 'notification' }                 // not typed by the user: a background task reporting back
  | { kind: 'command' };

/** `notification`: the adapter's verdict (RouterEvent.promptOrigin / .notification); undefined: check the prefix. */
export function classifyPrompt(prompt: string, latest?: { status: RequestStatus }, notification?: boolean): PromptClass {
  if (notification ?? TASK_NOTIFICATION.test(prompt)) return { kind: 'notification' };
  const r = ROUTER_CMD.exec(prompt);
  const sub = r?.[1]?.toLowerCase();
  if (sub === 'resume') return latest ? { kind: 'resume' } : { kind: 'command' };
  if (sub === 'level') {
    const arg = r?.[2]?.toUpperCase();
    return { kind: 'level', level: arg === 'L0' || arg === 'L1' || arg === 'L2' || arg === 'L3' ? arg : null };
  }
  if (SLASH_COMMAND.test(prompt)) return { kind: 'command' };
  if (latest?.status === 'awaiting_user') return { kind: 'continue' };
  return { kind: 'new' };
}

export function awaitsUser(lastAssistantMessage: unknown): boolean {
  return typeof lastAssistantMessage === 'string' && lastAssistantMessage.includes(AWAITING_USER_MARKER);
}
