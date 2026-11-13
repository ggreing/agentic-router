// Router MCP tools, the parts that need no ledger (decisions 127, 129, 134): binding a tool call to its
// session, and sorting the globs of a scope request.
//
// Binding. An MCP tools/call carries no session id, but its `_meta` carries the tool-use id, and the
// PreToolUse hook for the same call carries that id with the session. So the hook leaves a ticket and the
// call takes it: exact, single use, short-lived. A call from a subagent never gets a ticket.
import { NEVER_GRANTABLE_WRITE_PATHS, PROTECTED_WRITE_PATHS, normalizeScopeGlob } from '@do-it-all-claude-code/core';
import { matchesAny } from './glob.ts';

/** `_meta` key of a tools/call under which Claude Code sends the tool-use id. */
export const TOOL_USE_ID_META = 'claudecode/toolUseId';
/** A ticket is taken within moments of the hook; this only bounds what is kept when the call never comes. */
export const TICKET_TTL_MS = 60_000;
export const MAX_TICKETS = 500;

interface Ticket { sessionId: string; tool: string; at: number }

export class TicketStore {
  readonly #tickets = new Map<string, Ticket>();

  get size(): number {
    return this.#tickets.size;
  }

  add(toolUseId: string, sessionId: string, tool: string, now: number): void {
    this.#prune(now);
    this.#tickets.delete(toolUseId);            // re-insert: the map's order is the age order
    this.#tickets.set(toolUseId, { sessionId, tool, at: now });
    while (this.#tickets.size > MAX_TICKETS) this.#tickets.delete(this.#tickets.keys().next().value!);
  }

  /** The session of the call with this tool-use id, once: the ticket is gone afterwards, also when it does not fit. */
  redeem(toolUseId: string, tool: string, now: number): string | undefined {
    const t = this.#tickets.get(toolUseId);
    if (!t) return undefined;
    this.#tickets.delete(toolUseId);
    return t.tool === tool && now - t.at <= TICKET_TTL_MS ? t.sessionId : undefined;
  }

  #prune(now: number): void {
    for (const [id, t] of this.#tickets) {
      if (now - t.at <= TICKET_TTL_MS) break;
      this.#tickets.delete(id);
    }
  }
}

/** The tool-use id in a call's `_meta`, if the client sent one. */
export function toolUseIdOf(meta: Record<string, unknown> | undefined): string | undefined {
  const v = meta?.[TOOL_USE_ID_META];
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined;
}

// ------------------------------------------------------------------ scope globs (decision 129)

const NEVER_SEGMENTS = new Set(['.git', '.do-it-all-claude-code', '.agentic-router'])   // and the previous release's folder (decision 161);
const isProtectedSegment = (seg: string) => seg.startsWith('.env') || seg === '.claude' || seg === '.npmrc' || seg === '.gitlab-ci.yml';

export interface SortedGlobs {
  /** Globs that name no protected path. A protected file inside one stays protected. */
  ordinary: string[];
  /** Globs that name a protected path (.env files, CI config, .claude/): granted only after a user turn. */
  protectedPaths: string[];
  /** Globs that name .git or the router's own folder: never granted. */
  never: string[];
}

/**
 * Sorts the globs of a scope request by what they name. Only a glob that names a protected path can open
 * one: `src/**` does not open `src/.env`, `src/.env.example` does (after a user turn). A glob is taken to
 * name a protected path when it matches a protected pattern as written or has a protected path segment.
 */
export function sortScopeGlobs(globs: readonly string[]): SortedGlobs {
  const out: SortedGlobs = { ordinary: [], protectedPaths: [], never: [] };
  for (const raw of globs) {
    const g = normalizeScopeGlob(raw);
    const segs = g.toLowerCase().split('/');
    const bare = g.replace(/\/\*\*$/, '');
    if (segs.some(x => NEVER_SEGMENTS.has(x)) || matchesAny(g, NEVER_GRANTABLE_WRITE_PATHS) || matchesAny(bare, NEVER_GRANTABLE_WRITE_PATHS)) out.never.push(g);
    else if (segs.some(isProtectedSegment) || g.toLowerCase().includes('.github/workflows') || matchesAny(g, PROTECTED_WRITE_PATHS) || matchesAny(bare, PROTECTED_WRITE_PATHS)) out.protectedPaths.push(g);
    else out.ordinary.push(g);
  }
  return out;
}

/** Union of two glob lists in the ledger's spelling, in first-seen order. */
export function addGlobs(have: readonly string[], add: readonly string[]): string[] {
  return [...new Set([...have, ...add].map(normalizeScopeGlob))];
}

export function removeGlobs(have: readonly string[], remove: readonly string[]): string[] {
  const gone = new Set(remove.map(normalizeScopeGlob));
  return have.map(normalizeScopeGlob).filter(g => !gone.has(g));
}
