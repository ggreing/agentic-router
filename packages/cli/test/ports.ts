// A daemon port for tests that start the real daemon through `start` (it binds the configured port, so the test
// has to pick one first). Test files run in parallel processes, and dozens of servers in them bind port 0.
// Picking with a port-0 listen and closing it hands out an ephemeral port that the OS can give to the next
// port-0 bind in any of those processes before the daemon binds it (a flaky EADDRINUSE or a foreign server
// answering). So the port comes from 21000-28999, below every ephemeral range (Linux 32768+, Windows and macOS
// 49152+), which no port-0 bind ever gets; and test processes claim it with an exclusive file, so two of them
// never pick the same one.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const LOW = 21000;
const SPAN = 8000;
const CLAIMS = path.join(os.tmpdir(), 'agentic-router-test-ports');
const STALE_MS = 30 * 60_000;

const free = (port: number) => new Promise<boolean>(resolve => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

export async function testPort(): Promise<number> {
  fs.mkdirSync(CLAIMS, { recursive: true });
  for (let i = 0; i < 500; i++) {
    const port = LOW + Math.floor(Math.random() * SPAN);
    const claim = path.join(CLAIMS, String(port));
    try {
      if (Date.now() - fs.statSync(claim).mtimeMs > STALE_MS) fs.rmSync(claim, { force: true });   // left by an old run
    } catch { /* no claim */ }
    try { fs.writeFileSync(claim, String(process.pid), { flag: 'wx' }); } catch { continue; }   // another test process has it
    if (await free(port)) return port;
  }
  throw new Error('no free test port in 21000-28999');
}
