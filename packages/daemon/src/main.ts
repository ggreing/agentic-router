// Process entry point (started by `do-it-all-claude-code start`). Logs only to <home>/logs/daemon.log,
// masked; never to the console. The CLI owns the PID file.
import { homeLayout } from './home.ts';
import { errorText, fileLogger } from './log.ts';
import { startDaemon } from './index.ts';

const log = fileLogger(homeLayout().logsDir);

process.on('uncaughtException', e => {
  log.error('uncaught exception', { error: errorText(e) });
  process.exit(1);
});
process.on('unhandledRejection', e => {
  log.error('unhandled rejection', { error: errorText(e) });
});

try {
  const daemon = await startDaemon();
  // close() by a signal or POST /router/v1/shutdown: exit once the daemon has stopped.
  daemon.closed.then(() => process.exit(0), e => {
    log.error('shutdown failed', { error: errorText(e) });
    process.exit(1);
  });
  const stop = (signal: string) => {
    log.info('shutdown requested', { signal });
    daemon.close().catch(() => {});   // the failure reaches `closed` above
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => stop(sig));
} catch (e) {
  log.error('daemon failed to start', { error: errorText(e) });
  process.exitCode = 1;
}
