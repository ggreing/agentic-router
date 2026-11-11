// Client adapter seam. The Claude Code adapter (packages/adapter-claude-code)
// translates hook input into a RouterEvent and a RouterDecision back into hook output.
import type { RouterDecision, RouterEvent, RouterEventType } from '@agentic-router/core';

export interface ToRouterEventOptions {
  receivedAt?: string;   // original receive time (spool replay)
  spooled?: boolean;     // replayed from the local spool
}

export interface ClientAdapter {
  /** Throws for payloads that are not a supported hook input (the server answers 400). */
  toRouterEvent(hookInput: Record<string, unknown>, opts?: ToRouterEventOptions): RouterEvent;
  /** Hook output JSON for every event except pre_compact. */
  renderHookOutput(type: RouterEventType, decision: RouterDecision): unknown;
  /** pre_compact: Claude Code reads the hook's plain stdout as compaction guidance. */
  renderPreCompactStdout?(decision: RouterDecision): string;
}

/** Loads @agentic-router/adapter-claude-code at runtime. */
export async function loadClaudeCodeAdapter(): Promise<ClientAdapter> {
  const mod = (await import('@agentic-router/adapter-claude-code')) as unknown as Partial<ClientAdapter>;
  if (typeof mod.toRouterEvent !== 'function' || typeof mod.renderHookOutput !== 'function') {
    throw new Error('@agentic-router/adapter-claude-code does not export toRouterEvent() and renderHookOutput()');
  }
  return {
    toRouterEvent: mod.toRouterEvent,
    renderHookOutput: mod.renderHookOutput,
    ...(typeof mod.renderPreCompactStdout === 'function' ? { renderPreCompactStdout: mod.renderPreCompactStdout } : {}),
  };
}
