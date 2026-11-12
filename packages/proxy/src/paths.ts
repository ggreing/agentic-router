// Files of the proxy inside the router home. Same home rule as the rest of the router
// ($AGENTIC_ROUTER_HOME when absolute, else ~/.agentic-router), kept here so the key-holding
// process loads no third-party code.
import { homedir } from 'node:os';
import path from 'node:path';

export function routerHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AGENTIC_ROUTER_HOME;
  return v && path.isAbsolute(v) ? v : path.join(homedir(), '.agentic-router');
}

export interface ProxyPaths {
  home: string;
  config: string;
  /** The daemon's local token (usage reports). */
  daemonToken: string;
  /** The local token Claude Code presents (printed by bin/local-token.mjs, decision 130). */
  proxyToken: string;
  /** Daily totals per local token. */
  db: string;
  /** Usage rows the daemon has not taken yet. */
  spoolDir: string;
  log: string;
}

export function proxyPaths(home: string = routerHome()): ProxyPaths {
  const root = path.resolve(home);
  return {
    home: root,
    config: path.join(root, 'config.json'),
    daemonToken: path.join(root, 'token'),
    proxyToken: path.join(root, 'proxy-token'),
    db: path.join(root, 'proxy.db'),
    spoolDir: path.join(root, 'proxy-spool'),
    log: path.join(root, 'logs', 'proxy.log'),
  };
}
