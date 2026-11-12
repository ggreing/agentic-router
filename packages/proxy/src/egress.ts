// The proxy's own way out to the API through a corporate HTTP(S) proxy (Appendix B), with Node's built-in proxy
// support (an https.Agent with proxyEnv, Node 24.5 and later): HTTPS goes through a CONNECT tunnel, so TLS to the
// API is negotiated and verified end to end, never by the corporate proxy. No dependency.
//   variables    the first set of https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY (Claude Code's order, so one
//                environment means the same proxy for both), and NO_PROXY / no_proxy. An http:// or https:// URL;
//                credentials in it are sent as Proxy-Authorization and are never logged or shown.
//   NO_PROXY     comma or space separated (Claude Code accepts both, Node only commas, so it is rewritten with
//                commas); loopback is always added, so a loopback upstream never leaves the machine.
//   fail closed  a proxy URL the proxy cannot use (another scheme such as socks5, or no URL at all) or a Node
//                without the support stops the proxy with a message, instead of going around the proxy.
// The other direction (Claude Code to this proxy on 127.0.0.1) is NO_PROXY in Claude Code's settings: see the CLI.

export const PROXY_VARS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;
export const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'] as const;
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'] as const;
/** Built-in proxy support for http.Agent / https.Agent (proxyEnv) arrived in Node 24.5.0. */
export const PROXY_SUPPORT_SINCE: readonly [number, number] = [24, 5];

export class EgressError extends Error {}

export interface UpstreamProxy {
  /** The proxy URL (with any credentials; never log it, use `shown`). */
  url: URL;
  /** The proxy URL without credentials: what logs, errors, health and doctor show. */
  shown: string;
  /** The variable it came from. */
  from: string;
  /** NO_PROXY for the agent: the user's entries with commas, plus loopback. */
  noProxy: string;
  /** The credential parts, for the log masker. */
  secrets: string[];
}

/** A proxy URL with any user name and password taken out (and anything that is not a URL hidden whole). */
export function shownProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hidden = u.username || u.password;
    u.username = ''; u.password = '';
    return `${u.origin}${hidden ? ' (credentials hidden)' : ''}`;
  } catch { return '(not a URL)'; }
}

export const splitNoProxy = (v: string | undefined): string[] => (v ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

/** Whether a NO_PROXY list keeps requests to `host` (and port) off the proxy, as Claude Code and Node match it. */
export function noProxyCovers(list: readonly string[], host: string, port?: number): boolean {
  const h = host.toLowerCase();
  return list.some(e => {
    const x = e.toLowerCase();
    return x === '*' || x === h || (port !== undefined && x === `${h}:${port}`);
  });
}

export function nodeHasProxySupport(version = process.versions.node): boolean {
  const [maj = 0, min = 0] = version.split('.').map(Number);
  return maj > PROXY_SUPPORT_SINCE[0] || (maj === PROXY_SUPPORT_SINCE[0] && min >= PROXY_SUPPORT_SINCE[1]);
}

const firstSet = (env: NodeJS.ProcessEnv, names: readonly string[]): [string, string] | undefined => {
  for (const n of names) { const v = env[n]; if (typeof v === 'string' && v.trim()) return [n, v.trim()]; }
  return undefined;
};

/** The corporate proxy the upstream connection goes through; undefined when none is set. Throws EgressError. */
export function upstreamProxy(env: NodeJS.ProcessEnv = process.env, nodeVersion = process.versions.node): UpstreamProxy | undefined {
  const hit = firstSet(env, PROXY_VARS);
  if (!hit) return undefined;
  const [from, raw] = hit;
  let url: URL;
  try { url = new URL(raw); } catch { throw new EgressError(`${from} is set but is not a URL (${shownProxyUrl(raw)}): fix it, or unset it to reach the API directly`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressError(`${from} uses ${url.protocol.replace(':', '')}, which is not supported (an http:// or https:// proxy only; Claude Code does not support SOCKS either)`);
  }
  if (!nodeHasProxySupport(nodeVersion)) {
    throw new EgressError(`${from} is set, but Node ${nodeVersion} has no built-in proxy support: Node 24.5 or later is needed to reach the API through ${shownProxyUrl(raw)}`);
  }
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const user = dec(url.username);
  const pass = dec(url.password);
  const entries = splitNoProxy(firstSet(env, NO_PROXY_VARS)?.[1]);
  for (const l of LOOPBACK_NO_PROXY) if (!entries.includes(l)) entries.push(l);
  return {
    url, shown: shownProxyUrl(raw), from, noProxy: entries.join(','),
    secrets: [url.password, pass, user.length >= 8 ? user : ''].filter(s => s.length >= 4),
  };
}

/** The proxyEnv for the upstream https.Agent (only HTTPS goes upstream). */
export function agentProxyEnv(p: UpstreamProxy): Record<string, string> {
  return { HTTPS_PROXY: p.url.href, NO_PROXY: p.noProxy };
}
