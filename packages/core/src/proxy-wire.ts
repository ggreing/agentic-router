// Wire shapes between the API-key mode proxy and the daemon (decision 130). Types only: the proxy imports
// them with `import type`, so loading them costs nothing at runtime in the key-holding process.

export type UsageRowState = 'complete' | 'partial' | 'error';

/**
 * One proxied exchange (POST /router/v1/usage, body `{ rows: UsageRow[] }`). Ids, attribution headers, the
 * model and token counts only: never a body, a prompt, another header or a credential. The daemon takes
 * each `id` once (spool replays) and can also dedupe on `messageId`.
 */
export interface UsageRow {
  id: string;
  messageId: string | null;
  upstreamRequestId: string | null;
  /** x-claude-code-session-id: equals the hooks' session_id (contract spike). */
  sessionId: string | null;
  /** x-claude-code-agent-id: equals the hooks' agent_id; null for the main conversation. */
  agentId: string | null;
  parentAgentId: string | null;
  /** x-claude-code-prompt-id: equals the hooks' prompt_id (needs CLAUDE_CODE_GATEWAY_HINT_HEADERS=1). */
  promptId: string | null;
  /** x-claude-code-request-class: main | subagent | workflow | compaction | auxiliary. */
  requestClass: string | null;
  agentType: string | null;
  path: string;
  model: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m: number; cacheWrite1h: number };
  /** Priced with core's table; for a model without a price, at the most expensive model's rates. */
  usd: number;
  priced: boolean;
  state: UsageRowState;
  httpStatus: number;
  /** Short hash of the local token used; never the token. */
  tokenId: string;
  startedAt: string;
  endedAt: string;
}

/**
 * GET /router/v1/budget?session_id=&prompt_id= : 200 with this body, or 404 when no request of the session
 * has that prompt (the proxy then applies its daily caps only).
 */
export interface BudgetAnswer {
  requestId: string;
  budgetUsd: number;
  spentUsd: number;
}
