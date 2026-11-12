// Containment checks compare canonical paths on both sides: a folder reached through a link (a symlink, a
// Windows junction; macOS's /var -> /private/var is the same case) or a path whose last parts do not exist is
// still inside, and a link that leads out is still outside. The links here join temp folders made by the test,
// and each link is removed on its own before any folder is deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { canonicalPath, isWithin, relativeWithin } from '../src/canonical.ts';
import { createDashboard } from '../src/dashboard.ts';
import { Ledger } from '../src/ledger.ts';
import { readEditedPaths } from '../src/transcript.ts';
import { TOKEN, rmrf, tmpDir } from './helpers.ts';

/** A link at `at` to the folder `to` (a junction on Windows, which needs no privilege); false when not possible. */
function linkDir(to: string, at: string): boolean {
  try { fs.symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}
const unlink = (p: string) => { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* gone */ } } };

test('canonicalPath resolves the existing part and keeps the rest; isWithin stays strict', () => {
  const real = tmpDir('canon-real');
  const outside = tmpDir('canon-out');
  const via = path.join(tmpDir('canon-via'), 'link');
  const linked = linkDir(real, via);
  const escape = path.join(real, 'escape');
  const escaped = linkDir(outside, escape);
  try {
    const realCanon = canonicalPath(real);
    assert.equal(canonicalPath(path.join(real, 'a', 'b', 'c.txt')), path.join(realCanon, 'a', 'b', 'c.txt'), 'missing parts are appended as given');
    assert.ok(isWithin(real, path.join(real, 'no', 'such', 'route')));
    assert.ok(isWithin(real, real));
    assert.ok(!isWithin(real, path.join(real, '..', path.basename(outside), 'x')), 'a .. that leaves is outside');
    assert.ok(!isWithin(real, outside));
    assert.equal(relativeWithin(real, path.join(real, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(relativeWithin(real, outside), undefined);
    if (linked) {
      assert.equal(canonicalPath(via), realCanon);
      assert.ok(isWithin(real, path.join(via, 'some', 'route')), 'through a link, below a missing folder: inside');
      assert.ok(isWithin(via, path.join(real, 'x')), 'the base through a link, the target direct: inside');
      assert.equal(relativeWithin(real, path.join(via, 'docs', 'notes.md')), 'docs/notes.md');
    }
    if (escaped) {
      assert.ok(!isWithin(real, path.join(escape, 'secret.txt')), 'a link inside that leads out is outside');
      assert.equal(relativeWithin(real, path.join(escape, 'secret.txt')), undefined);
    }
  } finally {
    if (linked) unlink(via);
    if (escaped) unlink(escape);
    rmrf(real); rmrf(outside); rmrf(path.dirname(via));
  }
});

function get(port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard: a dist folder reached through a link serves its routes and assets; a link inside dist that leads out is refused', async () => {
  const real = tmpDir('canon-dist');
  fs.writeFileSync(path.join(real, 'index.html'), '<!doctype html><div id=app></div>');
  fs.mkdirSync(path.join(real, 'assets'));
  fs.writeFileSync(path.join(real, 'assets', 'index-abcd1234.js'), 'console.log(1)');
  const outside = tmpDir('canon-secret');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for the browser');
  const via = path.join(tmpDir('canon-dvia'), 'dist');
  const linked = linkDir(real, via);
  const leak = path.join(real, 'leak');
  const leaked = linkDir(outside, leak);
  const ledger = new Ledger(':memory:');
  let port = 0;
  const dash = createDashboard({ ledger, token: TOKEN, distDir: linked ? via : real, port: () => port });
  const server = http.createServer((req, res) => { if (!dash.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  try {
    assert.equal(await get(port, '/dashboard'), 200);
    assert.equal(await get(port, '/dashboard/some/spa/route'), 200, 'a route below folders that do not exist');
    assert.equal(await get(port, '/dashboard/assets/index-abcd1234.js'), 200);
    assert.equal(await get(port, '/dashboard/assets/missing.js'), 404);
    if (leaked) assert.equal(await get(port, '/dashboard/leak/secret.txt'), 403, 'still confined');
  } finally {
    dash.stop(); await new Promise<void>(r => server.close(() => r())); ledger.close();
    if (linked) unlink(via);
    if (leaked) unlink(leak);
    rmrf(real); rmrf(outside); rmrf(path.dirname(via));
  }
});

test('decision 95: an edit tool path spelled through a link to the repository counts as that repository file', async () => {
  const repo = tmpDir('canon-repo');
  const via = path.join(tmpDir('canon-rvia'), 'repo');
  const linked = linkDir(repo, via);
  const transcript = path.join(tmpDir('canon-tr'), 'agent-x.jsonl');
  const edit = (file: string) => JSON.stringify({ type: 'assistant', message: { id: file, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } });
  try {
    const lines = [edit(path.join(repo, 'src', 'a.ts')), edit(path.join(path.dirname(repo), 'elsewhere.ts'))];
    if (linked) lines.push(edit(path.join(via, 'docs', 'notes.md')));
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
    // the root as git names it: resolved
    const got = await readEditedPaths(transcript, canonicalPath(repo));
    assert.deepEqual(got?.sort(), linked ? ['docs/notes.md', 'src/a.ts'] : ['src/a.ts']);
  } finally {
    if (linked) unlink(via);
    rmrf(repo); rmrf(path.dirname(via)); rmrf(path.dirname(transcript));
  }
});
