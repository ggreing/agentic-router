// The proxy's way out to the API through a corporate HTTP(S) proxy: the rules live in core (core/src/egress.ts),
// which the update check uses too (decision 163).
export {
  EgressError, LOOPBACK_NO_PROXY, NO_PROXY_VARS, PROXY_SUPPORT_SINCE, PROXY_VARS, agentProxyEnv, nodeHasProxySupport, noProxyCovers,
  shownProxyUrl, splitNoProxy, upstreamProxy, type UpstreamProxy,
} from '@do-it-all-claude-code/core';
