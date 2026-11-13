#!/usr/bin/env node
// Starts the API-key mode proxy (`agentic-router supervise` runs it; decision 130). Reads config.json from the
// router home, loads the key from the OS keychain into memory, binds 127.0.0.1:<proxyPort>, and on SIGINT /
// SIGTERM lets in-flight streams finish (up to 30 s) and flushes usage rows before it exits.
import { checkTlsEnv, loadSettings } from './config.ts';
import { upstreamProxy } from './egress.ts';
import { Masker, errorText, fileLogger } from './log.ts';
import { proxyPaths, routerHome } from './paths.ts';
import { createProxy } from './server.ts';
import { LocalTokens } from './token.ts';
import { loadKey } from './vault.ts';

async function main(): Promise<void> {
  const paths = proxyPaths(routerHome());
  const masker = new Masker();
  const log = fileLogger(paths.log, masker);
  try {
    checkTlsEnv();
    const warnings: string[] = [];
    const settings = loadSettings(paths.config, warnings);
    for (const w of warnings) log.warn(w);
    // a corporate proxy for the upstream (HTTPS_PROXY and the like); one it cannot use stops the start (EgressError)
    const egress = upstreamProxy(process.env);
    for (const s of egress?.secrets ?? []) masker.add(s);
    // decision 156: a fresh local token at every start (no grace): one handed out before is refused with 401
    LocalTokens.freshAtStart(paths.proxyToken);
    const tokens = new LocalTokens(paths.proxyToken, { onChange: (added, removed) => { masker.add(added); masker.remove(removed); } });
    const key = await loadKey();
    masker.add(key.get());
    const proxy = createProxy({ paths, settings, key, tokens, log, ...(egress ? { egress } : {}) });
    const port = await proxy.listen(settings.port);
    log.info('proxy listening', { port, upstream: settings.upstream.origin, via: egress ? `${egress.shown} (${egress.from})` : 'direct', tls: settings.tls ? 'on' : 'off', key: key.masked });
    void proxy.reporter.replay();
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      log.info('proxy stopping', { signal });
      void proxy.close().then(() => { log.info('proxy stopped'); process.exit(0); });
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    // the supervisor asks over IPC: on Windows a signal to another process is a hard kill, with no drain
    process.on('message', m => { if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'stop') stop('supervisor'); });
  } catch (e) {
    log.error('proxy did not start', { error: errorText(e) });
    process.stderr.write(`agentic-router proxy: ${errorText(e)}\n`);
    process.exit(1);
  }
}

await main();
