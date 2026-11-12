// RouterDecision -> Claude Code hook output JSON.
// What each decision field maps to (Claude Code hooks reference):
//   decision.context     -> hookSpecificOutput.additionalContext (events that accept it)
//   decision.deny        -> PreToolUse hookSpecificOutput.permissionDecision="deny" + permissionDecisionReason
//   decision.allow       -> PreToolUse hookSpecificOutput.permissionDecision="allow" (skips the prompt; user deny/ask rules still apply); deny wins
//   decision.block       -> SubagentStop/Stop top-level decision="block" + reason (keeps the agent working)
//   decision.userMessage -> top-level systemMessage (a short notice shown to the user)
import type { RouterDecision, RouterEventType } from '@agentic-router/core';
import { TYPE_TO_HOOK_EVENT, type ClaudeHookEventName } from './events.ts';

/** The JSON object a hook writes to stdout. PreCompact uses plain stdout instead (see renderPreCompactStdout). */
export interface HookOutput {
  systemMessage?: string;
  decision?: 'block';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: ClaudeHookEventName;
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

/** Events whose output carries context via hookSpecificOutput.additionalContext. PreCompact is excluded (it has none). */
const CONTEXT_EVENTS: ReadonlySet<RouterEventType> = new Set([
  'prompt_submit', 'pre_tool_use', 'post_tool_use', 'subagent_start', 'subagent_stop', 'session_start', 'stop',
]);

/** Events that honor a block (keep the agent working). */
const BLOCK_EVENTS: ReadonlySet<RouterEventType> = new Set(['subagent_stop', 'stop']);

/**
 * Builds the Claude Code hook output for an event from the router's decision.
 * An empty decision yields `{}` (pass through). Fields that an event does not
 * support are dropped: a block on prompt_submit, a deny off pre_tool_use, etc.
 * PreCompact returns `{}` here; its summary instructions go through plain stdout.
 */
export function renderHookOutput(eventType: RouterEventType, decision: RouterDecision = {}): HookOutput {
  const hookEventName = TYPE_TO_HOOK_EVENT[eventType];
  const out: HookOutput = {};
  const hookOut: NonNullable<HookOutput['hookSpecificOutput']> = { hookEventName };
  let useHookOut = false;

  // PreCompact discards systemMessage; every other event shows it to the user.
  if (decision.userMessage && eventType !== 'pre_compact') out.systemMessage = decision.userMessage;

  if (decision.deny && eventType === 'pre_tool_use') {
    hookOut.permissionDecision = 'deny';
    hookOut.permissionDecisionReason = decision.deny.reason;
    useHookOut = true;
  } else if (decision.allow && eventType === 'pre_tool_use') {
    hookOut.permissionDecision = 'allow';
    if (decision.allow.reason) hookOut.permissionDecisionReason = decision.allow.reason;
    useHookOut = true;
  }

  if (decision.block && BLOCK_EVENTS.has(eventType)) {
    out.decision = 'block';
    out.reason = decision.block.reason;
  }

  // additionalContext is dropped by Claude Code when permissionDecision is "defer"; deny keeps it.
  if (decision.context && CONTEXT_EVENTS.has(eventType)) {
    hookOut.additionalContext = decision.context;
    useHookOut = true;
  }

  if (useHookOut) out.hookSpecificOutput = hookOut;
  return out;
}

/** PreCompact summary instructions: Claude Code reads a PreCompact hook's plain stdout as the summary guidance. */
export function renderPreCompactStdout(decision: RouterDecision = {}): string {
  return decision.context ?? '';
}
