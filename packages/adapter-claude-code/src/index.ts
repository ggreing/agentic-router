// Claude Code adapter: hook input/output translation (spec 3.1 "Client Adapter").
// The daemon imports toRouterEvent / renderHookOutput from here.
export {
  toRouterEvent,
  HookInputError,
  isClaudeHookEventName,
  HOOK_EVENT_TO_TYPE,
  TYPE_TO_HOOK_EVENT,
  hookEffort,
  isRouterAgent,
  routerRole,
  ROUTER_AGENT_PREFIX,
  isAgentToolEvent,
  agentCall,
  agentResult,
  isTaskNotification,
  parseTaskNotification,
  taskNotification,
  promptOrigin,
  subtaskTagFromTranscript,
} from './events.ts';
export { renderHookOutput, renderPreCompactStdout } from './render.ts';

export type { ClaudeHookEventName, ToRouterEventOptions, AgentCall, AgentResult, TaskNotification } from './events.ts';
export type { HookOutput } from './render.ts';
