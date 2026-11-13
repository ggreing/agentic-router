// Decision 142: the guard after the pre-release audit. Every bypass the audit reproduced is a case here,
// next to ordinary commands that must still get through (denied = a reason, not denied = null; the guard
// never answers "allow" for Bash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as guard from '../../../plugin/hooks/guard.mjs';

const CODER = 'do-it-all-claude-code:coder';
const WIN = process.platform === 'win32';

interface World { base: string; repo: string; home: string; state: string; opts: { userHome: string; routerHome: string } }
function world(): World {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-guard-')));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), state = path.join(home, '.do-it-all-claude-code');
  for (const d of [path.join(repo, 'src'), path.join(home, '.ssh'), path.join(state, 'agents'), path.join(state, 'scopes')]) fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, '.env'), 'FAKE=1\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'KEY=\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a\n');
  fs.writeFileSync(path.join(state, 'token'), 'fake\n');
  // ag1: scope src/**; ag2: no [scope: ...] line (whole repository)
  const rec = (subtaskId: string, scope: object) => JSON.stringify({ sessionId: 's1', subtaskId, role: 'coder', slot: 0, step: 's1', pairing: 'confirmed', scope });
  fs.writeFileSync(path.join(state, 'agents', 'ag1.json'), rec('A', { allowed: ['src/**'], protected: guard.PROTECTED_WRITE_PATHS }));
  fs.writeFileSync(path.join(state, 'agents', 'ag2.json'), rec('B', { allowed: ['**'], protected: guard.PROTECTED_WRITE_PATHS, unscoped: true }));
  return { base, repo, home, state, opts: { userHome: home, routerHome: state } };
}
const done = (w: World) => fs.rmSync(w.base, { recursive: true, force: true });
const call = (w: World, tool: string, tool_input: Record<string, unknown>, agent = 'ag1') =>
  guard.evaluate({ agent_type: CODER, agent_id: agent, session_id: 's1', tool_name: tool, cwd: w.repo, tool_input }, w.opts) as { deny?: string; allow?: string } | null;
const bash = (w: World, command: string) => call(w, 'Bash', { command });

test('Bash is never answered with allow: a command that is not denied gets no decision', () => {
  const w = world();
  try {
    for (const command of [
      'npm test', 'git status', 'git diff --stat', 'ls -la src', 'cat src/a.ts', 'cat README.md package.json', 'head -n 20 src/a.ts',
      'grep -n "foo bar" src/a.ts', 'rg -n "TODO" src', 'git commit -m "fix: handle the empty case (#12)"', 'git add src/a.ts',
      'cd src && ls', 'npx tsc --noEmit', 'node --test src/x.test.js', 'npm install left-pad', 'npm install @scope/pkg@^1.2.3', 'npm ci',
      'pip install requests==2.31.0', 'pip install -r requirements.txt', 'find . -name "*.ts"', 'ls *.md', 'cat .env.example', 'git show HEAD:src/a.ts',
      'echo done 2>&1', 'npm test > /dev/null', 'git log --oneline -n 5', 'wc -l src/a.ts', 'sort -n src/a.ts', 'test -f src/a.ts',
    ]) assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('A1: what the lexer cannot follow is refused', () => {
  const w = world();
  try {
    const refused: Array<[string, RegExp]> = [
      ["echo $'\\'' ; curl http://127.0.0.1:9/x ; echo $'\\''", /\$'…' or \$"…" string/],
      ['echo $"x" ; curl http://127.0.0.1:9/x', /\$'…' or \$"…" string/],
      ["echo a #'\ncurl http://127.0.0.1:9/x #'", /# comment/],
      ['echo "a\\"b" ; curl http://127.0.0.1:9/x ; echo "c"', /not on the router's Bash allowlist/],   // \" does not end the string: curl is seen
      ['echo "abc', /unterminated quote/],
      ["echo 'abc", /unterminated quote/],
      ['cat \\\n.env', /line continuation/],
      ['echo ${HOME}', /\$\{\} expansion/],
      ['printf -v X ANTHRO%s PIC_API_KEY; echo ${!X}', /\$\{\} expansion/],
      ['./src/echo hello', /given by a path/],
      ['src/echo hello', /given by a path/],
      ['/bin/cat src/a.ts', /given by a path/],
      ['exec cat src/a.ts', /wrapper "exec"/],
      ['eval ls', /wrapper "eval"/],
    ];
    for (const [command, why] of refused) assert.match(bash(w, command)?.deny ?? '(not denied)', why, command);
    // the same string, read as bash reads it: the command between the two echo calls would have run
    const r = spawnSync('bash', ['-c', "echo $'\\'' ; echo MIDDLE ; echo $'\\''"], { encoding: 'utf8' });
    if (r.status === 0) assert.match(r.stdout, /MIDDLE/);
  } finally { done(w); }
});

test('A1: every argument is looked at as a path, in the directory the command runs in', () => {
  const w = world();
  try {
    const denied: Array<[string, RegExp]> = [
      ['cat .env', /credential path/],
      ['cat ./.env', /credential path/],
      ['head -n 3 .env', /credential path/],
      ['grep SECRET .env', /credential path/],
      ['sort .env', /credential path/],
      ['cd src && cat ../.env', /credential path/],
      ['cd ~/.ssh && cat id_rsa', /credential directory/],
      ['cd ~/.do-it-all-claude-code && cat token', /router state folder/],
      ['cd ~ && cat .ssh/id_rsa', /credential path/],
      ['cd && cat .ssh/id_rsa', /credential path/],
      ['cat ~/.do-it-all-claude-code/token', /router state folder|credential path/],
      ['cd -', /cd target that cannot be checked/],
      ['cd $HOME', /cd target that cannot be checked/],
      ['cd a b', /more than one argument/],
      ['cat $FILE', /variable reference/],
      ['cat .e*', /glob over dotfiles/],
      ['cat .en?', /glob over dotfiles/],
      ['cat src/../.e[n]v', /glob over dotfiles/],
      ['cat */.env', /credential name \.env/],
      ['cat {.env,src/a.ts}', /credential path/],
      ['cat ~/.ssh/*', /credential name \.ssh/],
      ['git show HEAD:.env', /credential name \.env/],
      ['git diff --no-index src/a.ts .env', /credential path|--no-index/],
      ['grep --file=.env x src/a.ts', /credential path/],
      ['cat ~root/.ssh/id_rsa', /~user reference/],
    ];
    for (const [command, why] of denied) assert.match(bash(w, command)?.deny ?? '(not denied)', why, command);
    // an env template is not a credential (decision 142): reading it is not denied
    assert.equal(bash(w, 'cat .env.example'), null);
    assert.equal(guard.isEnvTemplate('.env.example'), true);
    assert.equal(guard.isEnvTemplate('.env.local'), false);
  } finally { done(w); }
});

test('A1: options that run a program, write a file or read hidden files: written out, abbreviated or bundled', () => {
  const w = world();
  try {
    for (const command of [
      'sort -o out.txt src/a.ts', 'sort --output=out.txt src/a.ts', 'sort --out=.github/workflows/ci.yml src/a.ts', 'sort --o=x src/a.ts',
      'sort -uo .claude/settings.json src/a.ts', 'sort -ruo x src/a.ts',
      "git grep --open-files-in-p='touch marker' x", 'git grep -O x', 'git grep --no-index x', 'git commit --no-verify -m x', 'git commit -anm x',
      'git commit --no-ver -m x', 'git diff --output=x', 'git diff --outp=x', 'git log --ext-diff', 'git -c core.pager=x log', 'git -ccore.pager=x log',
      'git --git-dir=/tmp/x status', 'find . -exec cat {} +', 'find . -delete', 'rg --hidden SECRET', 'rg -uu SECRET', 'rg --no-ignore-vcs SECRET',
      'rg --pre cat x', 'rg -. SECRET', 'printf -v X %s y', 'uniq src/a.ts out.txt', 'diff --to-file=x src/a.ts',
    ]) assert.match(bash(w, command)?.deny ?? '(not denied)', /option|not allowed|allowlist/, command);
    // options of the same commands that are fine
    for (const command of ['sort -n -k2 src/a.ts', 'git commit -am "message"', 'git diff --stat', 'git log --oneline', 'rg -i -n foo src', 'find . -name a.ts -type f', 'printf "%s\\n" done'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('A1: the environment and secret variables', () => {
  const w = world();
  try {
    for (const command of ['npm run env', 'yarn run env', 'pnpm run env', 'echo $DB_PASSWORD', 'echo $ANTHROPIC_API_KEY', 'echo $GITHUB_TOKEN', 'echo "$MY_SECRET"',
      'echo $SESSION_COOKIE', 'echo $DATABASE_URL', 'echo %API_KEY%', 'printenv', 'env', 'set', 'export -p'])
      assert.ok(bash(w, command)?.deny, command);
    assert.equal(bash(w, 'echo $PWD'), null);
  } finally { done(w); }
});

test('A1: installs take registry names only', () => {
  const w = world();
  try {
    for (const command of [
      'npm install https://example.invalid/pkg.tgz', 'npm i git+https://example.invalid/x.git', 'npm install github:user/repo', 'npm install user/repo',
      'npm install --registry=https://example.invalid left-pad', 'pnpm add https://example.invalid/x.tgz', 'yarn add file:../x',
      'pip install --index-url https://example.invalid/simple requests', 'pip install -i https://example.invalid requests', 'pip install git+https://example.invalid/x.git',
      'pip install https://example.invalid/x.whl', 'pip install --extra-index-url=https://example.invalid requests', 'pip install -f https://example.invalid requests',
    ]) assert.match(bash(w, command)?.deny ?? '(not denied)', /registry name|option|NTFS stream/, command);
    for (const command of ['npm install', 'npm install left-pad lodash@4', 'npm i -D @types/node', 'pip install requests', 'pip install -e .', 'pnpm add zod', 'yarn add react@18'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('A1: package scripts and installs are refused when scripts changed from HEAD, also below the root', () => {
  const w = world();
  try {
    const git = (...a: string[]) => spawnSync('git', ['-C', w.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
    fs.mkdirSync(path.join(w.repo, 'pkg'));
    fs.writeFileSync(path.join(w.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(w.repo, 'pkg', 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    git('add', '-A'); git('commit', '-qm', 'init');
    assert.equal(bash(w, 'npm test'), null);
    assert.equal(bash(w, 'cd pkg && npm run build'), null);
    fs.writeFileSync(path.join(w.repo, 'pkg', 'package.json'), JSON.stringify({ scripts: { build: 'tsc', postinstall: 'node x.js' } }));
    assert.match(bash(w, 'cd pkg && npm run build')!.deny!, /scripts changed from HEAD/);
    assert.match(bash(w, 'cd pkg && npm install')!.deny!, /scripts changed from HEAD/);
    assert.equal(bash(w, 'git status'), null, 'commands that run no script are not affected');
  } finally { done(w); }
});

test('A1: a recursive grep is refused where it would open a credential file', () => {
  const w = world();
  try {
    assert.match(bash(w, 'grep -r SECRET .')!.deny!, /recursive grep/);
    assert.match(bash(w, 'grep -rn SECRET')!.deny!, /recursive grep/);
    assert.match(bash(w, 'grep --recursive SECRET .')!.deny!, /recursive grep/);
    assert.equal(bash(w, 'grep -rn TODO src'), null, 'a directory without credential files');
    fs.writeFileSync(path.join(w.repo, 'src', '.npmrc'), '//registry/:_authToken=x\n');
    assert.match(bash(w, 'grep -rn TODO src')!.deny!, /recursive grep/);
  } finally { done(w); }
});

test('A2: a write is checked as written and with links resolved', () => {
  const w = world();
  try {
    assert.ok(call(w, 'Write', { file_path: path.join(w.repo, 'src', 'a.ts'), content: 'x' })!.allow);
    fs.mkdirSync(path.join(w.repo, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(w.repo, 'lib'));
    fs.mkdirSync(path.join(w.base, 'elsewhere'));
    const link = (name: string, target: string) => fs.symlinkSync(target, path.join(w.repo, 'src', name), 'junction');
    let linked = true;
    try {
      link('wf', path.join(w.repo, '.github', 'workflows'));
      link('g', path.join(w.repo, '.git'));
      link('lib', path.join(w.repo, 'lib'));
      link('out', path.join(w.base, 'elsewhere'));
    } catch { linked = false; }   // no permission to create links here: the lexical checks below still run
    if (linked) {
      assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', 'wf', 'ci.yml'), content: 'x' })!.deny!, /\.github\/workflows\/ci\.yml is a protected path/);
      assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', 'g', 'hooks', 'pre-commit'), content: 'x' })!.deny!, /protected path/);
      assert.match(call(w, 'Edit', { file_path: path.join(w.repo, 'src', 'lib', 'x.ts'), old_string: 'a', new_string: 'b' })!.deny!, /outside your allowed paths/);
      assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', 'out', 'x.ts'), content: 'x' })!.deny!, /outside the repository root/);
      // the unscoped subtask is held to the same resolved form; .git can never be reached through a link
      assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', 'g', 'config'), content: 'x' }, 'ag2')!.deny!, /protected path/);
      // reading through a link that leaves the repository is not "in the repository": no allow
      assert.equal(call(w, 'Read', { file_path: path.join(w.repo, 'src', 'out', 'x.ts') }), null);
    }
    assert.ok(call(w, 'Read', { file_path: path.join(w.repo, 'src', 'a.ts') })!.allow);
    // a write with no path the guard can check, and one for an agent without any scope record
    assert.match(call(w, 'Write', { content: 'x' })!.deny!, /names no file/);
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', 'a.ts'), content: 'x' }, 'nobody')!.deny!, /no scope record/);
    // a record without its allowed list is a broken record, not "whole repository"
    fs.writeFileSync(path.join(w.state, 'agents', 'ag3.json'), JSON.stringify({ sessionId: 's1', subtaskId: 'C', scope: {} }));
    assert.throws(() => call(w, 'Write', { file_path: path.join(w.repo, 'src', 'a.ts'), content: 'x' }, 'ag3'), /allowed list/);
  } finally { done(w); }
});

test('A2: spellings Windows resolves to another file are refused', () => {
  const p = guard.windowsPathProblem;
  assert.match(p('C:\\repo\\src\\.env::$DATA', 'win32')!, /NTFS stream/);
  assert.match(p('C:\\repo\\.git::$INDEX_ALLOCATION\\x', 'win32')!, /NTFS stream/);
  assert.match(p('C:\\repo\\GITHUB~1\\WORKFL~1\\x.yml', 'win32')!, /8\.3 short name \(GITHUB~1\)/);
  assert.match(p('C:\\repo\\GIT~1\\hooks\\pre-commit', 'win32')!, /8\.3 short name/);
  assert.match(p('C:\\repo\\.env.', 'win32')!, /ending in a dot or a space/);
  assert.match(p('C:\\repo\\.env ', 'win32')!, /ending in a dot or a space/);
  assert.match(p('\\\\?\\GLOBALROOT\\??\\C:\\Users\\x\\.ssh\\id_rsa', 'win32')!, /device or extended-length/);
  assert.match(p('\\\\.\\C:\\x', 'win32')!, /device or extended-length/);
  for (const ok of ['C:\\repo\\src\\a.ts', 'C:/repo/src/a.ts', '/c/repo/src/a.ts', 'src\\..\\a.ts', 'C:\\repo\\my~file.txt', 'C:\\repo\\v1.2\\a.ts'])
    assert.equal(p(ok, 'win32'), null, ok);
  assert.equal(p('C:\\repo\\src\\.env::$DATA', 'linux'), null, 'only where Windows resolves them');
  if (!WIN) return;
  const w = world();
  try {
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', '.env::$DATA'), content: 'x' })!.deny!, /NTFS stream/);
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'GITHUB~1', 'WORKFL~1', 'x.yml'), content: 'x' }, 'ag2')!.deny!, /8\.3 short name/);
    assert.match(call(w, 'Read', { file_path: `\\\\?\\GLOBALROOT\\??\\${path.join(w.home, '.ssh', 'id_rsa')}` })!.deny!, /device or extended-length/);
    assert.match(call(w, 'Read', { file_path: path.join(w.repo, '.env.') })!.deny!, /ending in a dot/);
    assert.match(bash(w, 'cat .env.')!.deny!, /credential path|dot or a space/);
    assert.match(bash(w, 'cat src/.env::$DATA')!.deny!, /NTFS stream|variable/);
  } finally { done(w); }
});

test('A3: a project policy.json counts only after the user accepted that exact content', () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.repo, '.do-it-all-claude-code'));
    const file = path.join(w.repo, '.do-it-all-claude-code', 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ bashAllow: ['deno test', 'curl'], verifyEnv: ['DATABASE_URL'] }));
    // shipped with the repository, not accepted: ignored
    let s = guard.policyStatus(w.repo, w.state);
    assert.deepEqual([s.present, s.valid, s.accepted, s.acceptedHash, s.policy], [true, true, false, null, { bashAllow: ['deno test', 'curl'], verifyEnv: ['DATABASE_URL'] }]);
    assert.equal(guard.readAcceptedPolicy(w.repo, w.state), null);
    assert.deepEqual(guard.acceptedVerifyEnvNames(w.repo, w.state), []);
    assert.ok(bash(w, 'deno test')?.deny);
    assert.ok(bash(w, 'curl http://127.0.0.1:9/x')?.deny);
    // accepted: honoured
    s = guard.acceptPolicy(w.repo, w.state, new Date('2026-11-12T00:00:00Z'));
    assert.deepEqual([s.accepted, s.acceptedHash], [true, s.hash]);
    assert.deepEqual(guard.readAcceptedPolicy(w.repo, w.state), { bashAllow: ['deno test', 'curl'], verifyEnv: ['DATABASE_URL'] });
    assert.equal(bash(w, 'deno test'), null);
    assert.deepEqual(guard.acceptedVerifyEnvNames(path.join(w.repo, 'src'), w.state), ['DATABASE_URL'], 'from a subdirectory, keyed by the repository root');
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, guard.POLICY_ACCEPT_FILE), 'utf8')).version, 1);
    // acceptance is of the content that was shown: with the hash of what the user saw, a file that changed
    // while the question was open is not recorded
    guard.revokePolicy(w.repo, w.state);
    const shown = guard.policyStatus(w.repo, w.state);
    fs.writeFileSync(file, JSON.stringify({ bashAllow: ['curl', 'bash'], verifyEnv: ['AWS_SECRET_ACCESS_KEY'] }));
    const swapped = guard.acceptPolicy(w.repo, w.state, new Date(), shown.hash);
    assert.deepEqual([swapped.accepted, swapped.changed], [false, true]);
    assert.equal(guard.readAcceptedPolicy(w.repo, w.state), null);
    assert.ok(bash(w, 'curl http://127.0.0.1:9/x')?.deny);
    fs.writeFileSync(file, JSON.stringify({ bashAllow: ['deno test', 'curl'], verifyEnv: ['DATABASE_URL'] }));
    assert.equal(guard.acceptPolicy(w.repo, w.state, new Date(), shown.hash).accepted, true, 'the content that was shown');
    // changed after acceptance: ignored again until it is accepted again
    fs.writeFileSync(file, JSON.stringify({ bashAllow: ['deno test', 'curl', 'bash'] }));
    s = guard.policyStatus(w.repo, w.state);
    assert.deepEqual([s.accepted, s.acceptedHash === s.hash], [false, false]);
    assert.ok(bash(w, 'deno test')?.deny);
    assert.ok(bash(w, 'bash -c "id"')?.deny);
    guard.acceptPolicy(w.repo, w.state);
    assert.equal(bash(w, 'deno test'), null);
    // revoked, broken, absent
    assert.equal(guard.revokePolicy(w.repo, w.state), true);
    assert.equal(guard.revokePolicy(w.repo, w.state), false);
    assert.ok(bash(w, 'deno test')?.deny);
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual((x => [x.present, x.valid, x.accepted])(guard.acceptPolicy(w.repo, w.state)), [true, false, false]);
    fs.rmSync(file);
    assert.deepEqual((x => [x.present, x.accepted])(guard.policyStatus(w.repo, w.state)), [false, false]);
    // an acceptance belongs to one repository
    const other = path.join(w.base, 'other');
    fs.mkdirSync(path.join(other, '.do-it-all-claude-code'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bashAllow: ['deno test'] }));
    guard.acceptPolicy(w.repo, w.state);
    fs.copyFileSync(file, path.join(other, '.do-it-all-claude-code', 'policy.json'));
    assert.equal(guard.readAcceptedPolicy(other, w.state), null);
    // a worker can change neither file
    assert.ok(call(w, 'Write', { file_path: file, content: '{}' }, 'ag2')!.deny);
    assert.ok(call(w, 'Write', { file_path: path.join(w.state, guard.POLICY_ACCEPT_FILE), content: '{}' }, 'ag2')!.deny);
    assert.ok(bash(w, `cat ${path.join(w.state, guard.POLICY_ACCEPT_FILE).replace(/\\/g, '/')}`)!.deny);
  } finally { done(w); }
});

test('B3: Grep and Glob aimed at credential files; default protected files of an unscoped subtask', () => {
  const w = world();
  try {
    const denied: Array<[string, Record<string, unknown>]> = [
      ['Grep', { pattern: 'SECRET', path: w.repo, glob: '.env' }], ['Grep', { pattern: 'SECRET', glob: '**/.env*' }], ['Grep', { pattern: 'x', glob: '*.{env,npmrc}' }],
      ['Grep', { pattern: 'x', glob: '.e*' }], ['Grep', { pattern: 'x', glob: '**/.npmrc' }], ['Grep', { pattern: 'x', glob: '.ssh/*' }],
      ['Glob', { pattern: '**/.env*', path: w.repo }], ['Glob', { pattern: '.env' }], ['Glob', { pattern: '**/.git-credentials' }], ['Glob', { pattern: '{.env,src/a.ts}' }],
      ['Read', { file_path: path.join(w.repo, '.env') }], ['Read', { file_path: path.join(w.repo, '.env.local') }], ['Read', { file_path: path.join(w.state, 'token') }],
    ];
    for (const [tool, input] of denied) assert.ok(call(w, tool, input)?.deny, `${tool} ${JSON.stringify(input)}`);
    for (const [tool, input] of [
      ['Grep', { pattern: 'TODO', path: w.repo, glob: '*.ts' }], ['Grep', { pattern: 'TODO', path: w.repo, type: 'ts' }], ['Grep', { pattern: 'TODO', path: path.join(w.repo, 'src', 'a.ts') }], ['Glob', { pattern: 'src/**/*.ts', path: w.repo }],
      ['Glob', { pattern: '**/*.env.example' }], ['Read', { file_path: path.join(w.repo, '.env.example') }],
    ] as Array<[string, Record<string, unknown>]>) assert.ok(call(w, tool, input)?.allow, `${tool} ${JSON.stringify(input)}`);

    // without a [scope: ...] line: the whole repository, except what changes how the agent or the repository's hooks run
    const unscoped = (rel: string) => call(w, 'Write', { file_path: path.join(w.repo, ...rel.split('/')), content: 'x' }, 'ag2');
    for (const rel of ['.mcp.json', '.husky/pre-commit', 'CLAUDE.md', 'pkg/CLAUDE.md', '.gitattributes', '.gitmodules', '.git', 'sub/.git', '.github/workflows/ci.yml', '.claude/settings.json'])
      assert.match(unscoped(rel)!.deny!, /protected path/, rel);
    for (const rel of ['src/a.ts', 'README.md', 'docs/guide.md', 'package.json']) assert.ok(unscoped(rel)!.allow, rel);
    // with a scope line the scope decides; a `.git` file is refused even inside it
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, 'src', '.git'), content: 'x' })!.deny!, /protected path/);
  } finally { done(w); }
});

test('B3: a Grep over a directory is denied when a credential file git does not ignore lies below it', () => {
  const w = world();
  try {
    const grep = (input: Record<string, unknown>) => call(w, 'Grep', { pattern: 'x', ...input });
    // the fixture's .env is not ignored: a search of the repository that names no files would open it
    assert.match(grep({ path: w.repo })!.deny!, /would read \.env below .*git does not ignore/);
    assert.match(grep({})!.deny!, /would read \.env/, 'no path = the working directory');
    assert.match(grep({ path: w.repo, glob: '*' })!.deny!, /would read \.env/, 'a bare * narrows nothing');
    assert.match(grep({ path: w.repo, glob: '**/*' })!.deny!, /would read \.env/);
    assert.match(grep({ path: w.repo, glob: '!*.md' })!.deny!, /would read \.env/, 'an exclusion narrows nothing');
    assert.match(grep({ path: '.' })!.deny!, /would read \.env/, 'a relative path is resolved in the working directory');
    // a directory without one: no decision either way
    assert.equal(grep({ path: path.join(w.repo, 'src') }), null);
    // named files, a glob or a type: as before
    assert.ok(grep({ path: w.repo, glob: '*.ts' })!.allow);
    assert.ok(grep({ path: w.repo, type: 'js' })!.allow);
    assert.ok(grep({ path: path.join(w.repo, 'src', 'a.ts') })!.allow);
    // nested, and other credential file names
    fs.mkdirSync(path.join(w.repo, 'src', 'conf'));
    fs.writeFileSync(path.join(w.repo, 'src', 'conf', '.npmrc'), '//registry/:_authToken=x\n');
    assert.match(grep({ path: path.join(w.repo, 'src') })!.deny!, /would read conf\/\.npmrc/);
    assert.deepEqual(guard.unignoredCredentialFiles(w.repo).sort(), ['.env', 'src/conf/.npmrc']);
    // ignored by git: the search skips them, so it is not denied (and not vouched for)
    fs.writeFileSync(path.join(w.repo, '.gitignore'), '.env\n.npmrc\n');
    assert.deepEqual(guard.unignoredCredentialFiles(w.repo), []);
    assert.equal(grep({ path: w.repo }), null);
    assert.equal(grep({ path: path.join(w.repo, 'src') }), null);
    // an env template is not a credential file
    assert.deepEqual(guard.unignoredCredentialFiles(path.join(w.repo)), []);
    // outside a git repository nothing is ignored
    const plain = path.join(w.base, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(plain, '.env'), 'FAKE=1\n');
    assert.deepEqual(guard.unignoredCredentialFiles(plain), ['.env']);
    // the router state folder is never searched
    assert.match(grep({ path: w.state })!.deny!, /router state folder|credential path/);
  } finally { done(w); }
});

// Delta audit: the index forms of git's path syntax, brace expansions without end, very long command lines.
test('git show :path and :N:path are read as paths, like rev:path', () => {
  const w = world();
  try {
    for (const command of ['git show :.env', 'git show :0:.env', 'git show :2:.env', 'git show :./.env', 'git show HEAD:.env', 'git diff :.env', 'git show :src/../.env'])
      assert.match(bash(w, command)?.deny ?? '(not denied)', /credential/, command);
    for (const command of ['git show :src/a.ts', 'git show :0:src/a.ts', 'git show HEAD:src/a.ts', 'git log --format=%h:%s'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('a brace expansion beyond what is checked is refused, quickly', () => {
  const w = world();
  try {
    const many = '{a,b}'.repeat(30);
    const t0 = performance.now();
    assert.match(bash(w, `echo ${many}`)!.deny!, /brace expansion with more alternatives than can be checked/);
    assert.match(call(w, 'Glob', { pattern: many })!.deny!, /brace expansion/);
    assert.match(call(w, 'Grep', { pattern: 'x', glob: many })!.deny!, /brace expansion/);
    assert.match(bash(w, `cat {${Array.from({ length: 100 }, (_, i) => `f${i}`).join(',')}}`)!.deny!, /brace expansion/, 'one group with a hundred alternatives');
    assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
    // ordinary expansions are still followed
    assert.equal(bash(w, 'cat src/{a,b}.ts'), null);
    assert.equal(bash(w, 'ls {src,docs}/{a,b,c}.{ts,js}'), null);
    assert.match(bash(w, 'cat {src/a.ts,.env}')!.deny!, /credential/);
    assert.match(bash(w, 'cat {a,b}/{c,d}/{.env,x}')!.deny!, /credential/);
  } finally { done(w); }
});

test('a command line longer than is checked is refused', () => {
  const w = world();
  try {
    const t0 = performance.now();
    assert.match(bash(w, 'echo a; '.repeat(4000))!.deny!, /longer than 20000 characters/);
    assert.ok(performance.now() - t0 < 1000);
    assert.equal(bash(w, 'echo a; '.repeat(100)), null);
  } finally { done(w); }
});

test('git: the repository options are refused before the subcommand only', () => {
  const w = world();
  try {
    for (const command of ['git rev-parse --git-dir', 'git rev-parse --git-common-dir', 'git rev-parse --git-dir --git-common-dir', 'git rev-parse --show-toplevel'])
      assert.equal(bash(w, command), null, command);
    for (const command of ['git --git-dir=/x/.git status', 'git --git-dir /x/.git status', 'git --work-tree=/x status', 'git --exec-path=/x status', 'git -C src --git-dir=/x/.git log', 'git --namespace=x log'])
      assert.ok(bash(w, command)?.deny, command);
  } finally { done(w); }
});

test('D: an env template is protected for writes, can be granted, and the grant then works', () => {
  const w = world();
  try {
    const target = path.join(w.repo, '.env.example');
    assert.match(call(w, 'Write', { file_path: target, content: 'x' }, 'ag2')!.deny!, /\.env\.example is a protected path/);
    fs.writeFileSync(path.join(w.state, 'agents', 'ag4.json'), JSON.stringify({ sessionId: 's1', subtaskId: 'D', pairing: 'confirmed',
      scope: { allowed: ['src/**'], protected: guard.PROTECTED_WRITE_PATHS, protectedGranted: ['.env.example', '.git/config', '.env'] } }));
    assert.ok(call(w, 'Write', { file_path: target, content: 'x' }, 'ag4')!.allow, 'the granted template');
    // a real .env stays a credential whatever the grant list says; .git is never grantable
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, '.env'), content: 'x' }, 'ag4')!.deny!, /credential path/);
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, '.git', 'config'), content: 'x' }, 'ag4')!.deny!, /protected path/);
    assert.match(call(w, 'Write', { file_path: path.join(w.repo, '.env.local'), content: 'x' }, 'ag4')!.deny!, /credential path/);
  } finally { done(w); }
});

test('the guard still does nothing for callers that are not router subagents', () => {
  const w = world();
  try {
    for (const agent_type of ['Explore', 'general-purpose', '', undefined]) {
      assert.equal(guard.evaluate({ agent_type, tool_name: 'Bash', cwd: w.repo, tool_input: { command: 'curl http://127.0.0.1:9/x' } }, w.opts), null);
      assert.equal(guard.evaluate({ agent_type, tool_name: 'Write', cwd: w.repo, tool_input: { file_path: path.join(w.repo, '.env'), content: 'x' } }, w.opts), null);
    }
  } finally { done(w); }
});

// Git Bash (MSYS) paths: the Bash tool on Windows reads "/tmp/x" as %TEMP%\x and "/x" as <Git>\x.
test('msysPathForms: bash collapses ".." before it maps; a native program gets the mapped prefix with ".." left in', () => {
  const env = { tmp: 'C:\\Users\\u\\AppData\\Local\\Temp', root: 'C:\\Program Files\\Git' };
  const f = (p: string) => guard.msysPathForms(p, env);
  assert.deepEqual(f('/tmp/work/a.txt'), ['C:\\Users\\u\\AppData\\Local\\Temp\\work\\a.txt']);
  assert.deepEqual(f('/tmp'), ['C:\\Users\\u\\AppData\\Local\\Temp']);
  assert.deepEqual(f('/c/Users/u/x'), ['C:\\Users\\u\\x']);
  assert.deepEqual(f('/usr/share/x'), ['C:\\Program Files\\Git\\usr\\share\\x']);
  assert.deepEqual(f('/home/u/.ssh/id_rsa'), ['C:\\Program Files\\Git\\home\\u\\.ssh\\id_rsa']);
  // the two readings differ once ".." climbs out of the mount
  assert.deepEqual(f('/tmp/../../../.ssh/id_rsa'), ['C:\\Program Files\\Git\\.ssh\\id_rsa', 'C:\\Users\\u\\.ssh\\id_rsa']);
  assert.deepEqual(f('/tmp/../xy'), ['C:\\Program Files\\Git\\xy', 'C:\\Users\\u\\AppData\\Local\\xy']);
  assert.deepEqual(f('/tmp/../x'), ['X:\\', 'C:\\Users\\u\\AppData\\Local\\x'], 'a single letter at the top is a drive');
  assert.deepEqual(f('/c/../d/x'), ['D:\\x', 'C:\\d\\x']);
  assert.deepEqual(f('/dev/null'), []);
  assert.deepEqual(f('/proc/self/environ'), []);
  // without a known Git directory only the mounts that do not need it are mapped
  assert.deepEqual(guard.msysPathForms('/tmp/a', { tmp: 'C:\\T', root: null }), ['C:\\T\\a']);
  assert.deepEqual(guard.msysPathForms('/usr/a', { tmp: 'C:\\T', root: null }), []);
});

test('Git Bash paths in Bash commands are checked in every reading (Windows)', { skip: !WIN }, () => {
  const w = world();
  try {
    // /tmp is mounted at <base>/tmp for this test; the home (credentials, state folder) is its sibling
    const tmp = path.join(w.base, 'tmp');
    fs.mkdirSync(path.join(tmp, 'work'), { recursive: true });
    const msys = { tmp, root: path.join(w.base, 'gitroot') };
    const c = (command: string) => guard.classifyBash(command, { ...w.opts, cwd: w.repo, root: w.repo, msys });
    // a native program reads /tmp/../home/.ssh/id_rsa as <tmp>\..\home\.ssh\id_rsa
    assert.match(c('rg x /tmp/../home/.ssh/id_rsa') ?? '', /credential path/);
    assert.match(c('git grep x /tmp/../home/.ssh/id_rsa') ?? '', /credential path/);
    assert.match(c('cat /tmp/../home/.do-it-all-claude-code/token') ?? '', /credential path|router state folder/);
    assert.match(c('head --lines=3 /tmp/../home/.ssh/id_rsa') ?? '', /credential path/);
    assert.match(c('cat /tmp/.env') ?? '', /credential path/);
    assert.match(c('grep --file=/tmp/../home/.ssh/id_rsa x src/a.ts') ?? '', /credential path/);
    // ordinary uses are not refused
    for (const ok of ['cat /tmp/work/a.txt', 'ls /tmp', 'cd /tmp/work && ls', 'cat /usr/share/doc/x', 'ls /dev/null', 'cd /tmp/work && cat a.txt'])
      assert.equal(c(ok), null, ok);
    // cd follows bash's own reading, so what comes after it is resolved in the right directory
    fs.writeFileSync(path.join(tmp, 'work', '.env'), 'X=1\n');
    assert.match(c('cd /tmp/work && cat .env') ?? '', /credential path/);
    // bash collapses /tmp/.. to / first, so this cd lands in <Git>/home, which is not the user's home
    assert.equal(c('cd /tmp/../home && cat .ssh/id_rsa'), null);
  } finally { done(w); }
});

test('a file tool given a Git Bash path is refused with the Windows path to use (Windows)', { skip: !WIN }, () => {
  const w = world();
  try {
    // the fixture lives under the real temp directory, so /tmp/<name>/repo/... is its Git Bash spelling
    const rel = path.relative(fs.realpathSync(os.tmpdir()), w.repo).replace(/\\/g, '/');
    assert.ok(!rel.startsWith('..'), 'the fixture is under the temp directory');
    const p = `/tmp/${rel}/src/a.ts`;
    for (const [tool, input] of [['Read', { file_path: p }], ['Glob', { pattern: '**/*', path: `/tmp/${rel}` }], ['Grep', { pattern: 'x', path: `/tmp/${rel}/src` }],
      ['Write', { file_path: p, content: 'x' }], ['Edit', { file_path: p, old_string: 'a', new_string: 'b' }]] as Array<[string, Record<string, unknown>]>) {
      const d = call(w, tool, input)?.deny ?? '(not denied)';
      assert.match(d, /is a Git Bash path; Read, Edit, Write, Grep and Glob take Windows paths/, tool);
      assert.ok(d.toLowerCase().includes(path.join(w.repo, tool === 'Glob' ? '' : 'src').toLowerCase()), `${tool}: the message gives the Windows path (${d})`);
    }
    // as Claude Code hands it to the hook: backslashes, still no drive
    const back = p.replace(/\//g, '\\');
    assert.match(call(w, 'Read', { file_path: back })!.deny!, /is a Git Bash path/);
    assert.ok(call(w, 'Read', { file_path: back })!.deny!.toLowerCase().includes(path.join(w.repo, 'src', 'a.ts').toLowerCase()));
    // a new file in a directory that is there under the Git Bash reading
    assert.match(call(w, 'Write', { file_path: `/tmp/${rel}/src/new.ts`, content: 'x' })!.deny!, /is a Git Bash path/);
    // a rooted path that names nothing under the Git Bash reading is left as the Windows path it is
    for (const other of ['/tmp/no-such-dir-for-this-test/a.ts', '\\tmp\\no-such-dir-for-this-test\\a.ts', '/no-such-top-level-dir/x'])
      assert.ok(!/Git Bash path/.test(call(w, 'Read', { file_path: other })?.deny ?? ''), other);
    // drive forms and Windows paths are handled as before
    assert.ok(call(w, 'Read', { file_path: path.join(w.repo, 'src', 'a.ts') })!.allow);
    assert.ok(call(w, 'Read', { file_path: 'src/a.ts' }) === null || call(w, 'Read', { file_path: 'src/a.ts' })!.allow !== undefined);
    const driveForm = '/' + w.repo[0]!.toLowerCase() + w.repo.slice(2).replace(/\\/g, '/') + '/src/a.ts';
    assert.ok(call(w, 'Read', { file_path: driveForm })!.allow, 'the /c/... form is still understood');
  } finally { done(w); }
});

// Deep pass over the option lists and path spellings (after the delta audit).
test('shellWord: a word as bash passes it on', () => {
  const w = guard.shellWord;
  assert.equal(w('.en""v'), '.env');
  assert.equal(w(".e'n'v"), '.env');
  assert.equal(w('.e\\nv'), '.env');
  assert.equal(w('".e"nv'), '.env');
  assert.equal(w('--no-ver""ify'), '--no-verify');
  assert.equal(w('"a b"'), 'a b');
  assert.equal(w("'a\\b'"), 'a\\b', 'single quotes keep a backslash');
  assert.equal(w('"a\\b"'), 'a\\b', 'double quotes keep a backslash before an ordinary character');
  assert.equal(w('"a\\"b"'), 'a"b');
  assert.equal(w('"a\\\\b"'), 'a\\b');
  assert.equal(w('C:\\Users\\x'), 'C:Usersx', 'unquoted backslashes are escapes, as in bash');
  assert.equal(w("'C:\\Users\\x'"), 'C:\\Users\\x');
  assert.equal(w('""'), '');
  assert.equal(w('a\\ b'), 'a b');
});

test('quotes and escapes inside a word do not hide a credential file or a refused option', () => {
  const w = world();
  try {
    const H = w.home.replace(/\\/g, '/');
    const denied: Array<[string, RegExp]> = [
      ['cat .e\\nv', /credential/], ['cat \\.env', /credential/], ['cat .en""v', /credential/], ["cat .e'n'v", /credential/], ['cat ".e"nv', /credential/],
      [`cat ${H}/.s""sh/id_rsa`, /credential/], [`cat ${H}/.do-it-all-clau""de-code/token`, /credential|state folder/],
      // the home of the previous release (decision 161) stays protected until it is moved
      [`cat ${H}/.agentic-rou""ter/token`, /credential|state folder/],
      ['git show HEAD:.e""nv', /credential/], ['git show :.e\\nv', /credential/],
      ['git commit --no-ver""ify -m x', /option/], ['git commit --no-verif\\y -m x', /option/], ['git commit "--no-verify" -m x', /option/],
      ['sort -""o out.txt src/a.ts', /option/], ['sort --out""put=out.txt src/a.ts', /option/], ['sort --outpu\\t=out.txt src/a.ts', /option/],
      ["find . -ex'e'c cat {} +", /option/], ['find . "-delete"', /option/], ["git grep --open-files-in-pa'g'er=x y", /option/],
      ['c""at .env', /credential/], ['c""url http://127.0.0.1:9/x', /allowlist/],['"cu"rl http://127.0.0.1:9/x', /allowlist/], ['\\curl http://127.0.0.1:9/x', /allowlist/], ['"" cat src/a.ts', /allowlist/],
      ['git "pu"sh', /allowlist/], ['npm r""un env', /environment/],
    ];
    for (const [command, why] of denied) assert.match(bash(w, command)?.deny ?? '(not denied)', why, command);
    // the same .env read, confirmed against a real shell where one is available: each spelling is the file .env
    const r = spawnSync('bash', ['-c', 'cat .en""v; cat .e\\nv; cat ".e"nv'], { cwd: w.repo, encoding: 'utf8' });
    if (r.status === 0) assert.equal(r.stdout, 'FAKE=1\nFAKE=1\nFAKE=1\n');
    // quoting that changes nothing is still fine
    for (const command of ["cat 'src/a.ts'", 'ls -la "src"', 'git commit -m "fix: it\'s done (#12)"', "git log --format='%h %s'", "grep -n 'a\\|b' src/a.ts", "rg -n 'foo\\.bar' src",
      'echo "done: 3 files"', "find . -name '*.ts'", 'git commit -m \'cost is $5\'', 'git add "src/a.ts"'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('values attached to a short option, and paths under /proc and /dev', () => {
  const w = world();
  try {
    const H = w.home.replace(/\\/g, '/');
    for (const command of ['grep -f.env src/a.ts', 'git grep -f.env x', `git commit -F${H}/.ssh/id_rsa`, `git blame -S${H}/.ssh/id_rsa src/a.ts`, 'grep -nf./.env src/a.ts', `head -c5 -q${H}/.ssh/id_rsa`])
      assert.match(bash(w, command)?.deny ?? '(not denied)', /credential/, command);
    for (const command of ['cat /proc/self/cwd/.env', 'cat /proc/self/root/home/u/.ssh/id_rsa', 'cat /proc/1/cwd/x', 'cat /dev/clipboard', 'cat /dev/fd/0', 'head /dev/sda', 'cat //proc/self/environ', 'ls /proc'])
      assert.match(bash(w, command)?.deny ?? '(not denied)', /\/proc or \/dev|credential/, command);
    for (const command of ['cat /dev/null', 'npm test > /dev/null', 'grep -n5 foo src/a.ts', 'head -n20 src/a.ts', 'grep -e.ts src/a.ts', 'rg -g*.ts foo src', 'git log -n5'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('options that open an editor, run a program or install outside the repository', () => {
  const w = world();
  try {
    for (const command of [
      'git add -e', 'git add --edit', 'git add -i', 'git add --interactive', 'git add -p', 'git add --patch', 'git add -up',
      'git commit', 'git commit -a', 'git commit -e -m x', 'git commit --amend -m x', 'git commit --amend --no-edit', 'git commit -p -m x', 'git commit --edit -m x',
      "rg --hostname-bin ./src/x --hyperlink-format 'file://{host}{path}' a", 'rg --hostname-bin=./src/x a',
      'git add --chmod=+x src/a.ts', 'git commit --reedit-message=HEAD', 'git commit -c HEAD', 'git commit --reset-author -m x', 'git commit --no-post-rewrite -m x',
      'git grep --textconv x', 'git stash list -p --output=out.txt', 'git stash list --ext-diff', 'git branch --show-current -D main', 'git branch --show-current --edit-description',
      'sort -T /x src/a.ts', 'sort --temporary-directory=/x src/a.ts', 'diff -l src/a.ts README.md', 'diff --paginate src/a.ts README.md', 'tail -f src/a.ts', 'tail -n5 -F src/a.ts', 'tail --follow=name src/a.ts',
      'npm install -g left-pad', 'npm i --global left-pad', 'npm install --location=global left-pad', 'npm install --prefix /somewhere left-pad', 'npm ci --userconfig=x',
      'pnpm add -g zod', 'pnpm install --dir /x', 'yarn add --cwd /x react', 'pip install --target /somewhere requests', 'pip install -t /x requests', 'pip install --user requests', 'pip install --prefix=/x requests',
    ]) assert.ok(bash(w, command)?.deny, command);
    for (const command of ['git add src/a.ts', 'git add -u', 'git add -f src/a.ts', 'git commit -m x', 'git commit -am "x"', 'git commit --message=x', 'git commit -F msg.txt', 'git commit -C HEAD',
      'npm install left-pad', 'npm i -D typescript', 'npm ci', 'pnpm add zod', 'yarn add react', 'pip install requests', 'pip install -e .', 'rg -n foo src',
      'git branch --show-current', 'git stash list', 'git stash list --stat', 'sort -t, -k2 src/a.ts', 'diff -u src/a.ts README.md', 'tail -n 20 src/a.ts', 'git grep -n foo'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('git add of a directory, or of everything, is refused where it would stage a credential file', () => {
  const w = world();
  try {
    // the fixture's .env is not ignored
    for (const command of ['git add -A', 'git add --all', 'git add .', 'git add -Av', 'cd src && git add ..', 'git add -A src/..'])
      assert.match(bash(w, command)?.deny ?? '(not denied)', /would stage \.env, a credential file that git does not ignore/, command);
    assert.equal(bash(w, 'git add src'), null, 'a directory without one');
    assert.equal(bash(w, 'git add src/a.ts README.md'), null);
    fs.writeFileSync(path.join(w.repo, '.gitignore'), '.env\n');
    for (const command of ['git add -A', 'git add .']) assert.equal(bash(w, command), null, `${command} once .env is ignored`);
  } finally { done(w); }
});

test('a recursive grep in every spelling of the option', () => {
  const w = world();
  try {
    for (const command of ['grep -d recurse SECRET .', 'grep --directories recurse SECRET .', 'grep --directories=recurse SECRET .', 'grep -drecurse SECRET .', 'grep --dir=recurse SECRET .', 'grep -nR SECRET .', 'grep --dereference-recursive SECRET .'])
      assert.match(bash(w, command)?.deny ?? '(not denied)', /recursive grep/, command);
    assert.equal(bash(w, 'grep -n SECRET src/a.ts'), null);
  } finally { done(w); }
});

test('a build, test or install command may not name a protected path', () => {
  const w = world();
  try {
    for (const command of [
      'go build -o .git/hooks/pre-commit ./cmd/x', 'npx tsc --outDir .git/hooks', 'npx tsc --outFile .github/workflows/x.js', 'npx eslint -o .github/workflows/ci.yml src',
      'npx prettier --write .github/workflows/ci.yml', 'cargo build --target-dir .git/hooks', 'pytest --junitxml=.github/workflows/x.xml', 'npx tsc --outDir=.claude',
      'go build -o.git/hooks/pre-commit ./cmd/x', 'npx prettier --write .do-it-all-claude-code/policy.json', 'cd src && npx tsc --outDir ../.git/hooks', 'make build -C .git', 'npx jest --outputFile=.claude/settings.json',
    ]) assert.match(bash(w, command)?.deny ?? '(not denied)', /a protected path .* can write files/, command);
    // the same commands on ordinary paths, and readers on protected paths, are not refused
    for (const command of ['go build ./...', 'go test ./...', 'go build -o bin/app ./cmd/x', 'npx tsc --outDir dist', 'npx tsc --noEmit', 'npx eslint src', 'npx prettier --check .', 'npx prettier --write src/a.ts',
      'cargo build', 'pytest -q', 'npm run build', 'cat .github/workflows/ci.yml', 'ls .git', 'git log -- .github/workflows', 'grep -n on .github/workflows/ci.yml', 'npx prettier --check .env.example'])
      assert.equal(bash(w, command), null, command);
  } finally { done(w); }
});

test('path spellings for Bash arguments (Windows)', { skip: !WIN }, () => {
  const w = world();
  try {
    const H = w.home.replace(/\\/g, '/');
    for (const command of [
      'cat c:.env', 'cat .ENV', 'cat ./src/../.env', 'cat src/..//.env', "cat '.env '", 'cat .env.', 'cat .env:x', "cat '.env::$DATA'", 'cat .ENV.',
      `cat //localhost/${H[0]}$/${H.slice(3)}/.ssh/id_rsa`, `cat //127.0.0.1/${H[0]}$/${H.slice(3)}/.ssh/id_rsa`, `cat '\\\\?\\${w.home}\\.ssh\\id_rsa'`, `cat '\\\\.\\${w.home}\\.ssh\\id_rsa'`,
      `cat ${H}/.SSH/ID_RSA`, `cat ${H}//.ssh///id_rsa`, `cat '${w.home}\\.ssh\\id_rsa'`, `cat ${H.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`)}/.ssh/id_rsa`,
      `cat ${H}/.ssh./id_rsa`, `grep --file=${H}/.SSH/id_rsa x src/a.ts`, `sort --files0-from=${H}/.ssh/id_rsa`, `wc --files0-from='${w.home}\\.ssh\\id_rsa'`,
      `git blame --contents ${H}/.ssh/id_rsa src/a.ts`, `head -n1 ${H}/.do-it-all-claude-code/TOKEN`, `cat ${H}/.AGENTIC-ROUTER/token`,
    ]) assert.ok(bash(w, command)?.deny, command);
  } finally { done(w); }
});

test('path spellings for the file tools: UNC, extended-length, short names, streams, case, trailing dots, mixed slashes (Windows)', { skip: !WIN }, () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.repo, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(w.repo, '.claude'));
    const D = w.repo[0]!, rest = w.repo.slice(3), hrest = w.home.slice(3);
    const fwd = (p: string) => p.replace(/\\/g, '/');
    const writes = [
      path.join(w.repo, '.GITHUB', 'Workflows', 'x.yml'), fwd(w.repo) + '/.github\\workflows/x.yml', path.join(w.repo, 'src', '..', '.github', 'workflows', 'x.yml'),
      `\\\\localhost\\${D}$\\${rest}\\.github\\workflows\\x.yml`, `\\\\127.0.0.1\\${D}$\\${rest}\\.git\\hooks\\pre-commit`, `//localhost/${D}$/${fwd(rest)}/.claude/settings.json`,
      `\\\\?\\${w.repo}\\.github\\workflows\\x.yml`, `\\\\.\\${w.repo}\\.git\\config`, `\\\\?\\UNC\\localhost\\${D}$\\${rest}\\.git\\config`,
      path.join(w.repo, '.git.', 'hooks', 'x'), path.join(w.repo, '.git ', 'hooks', 'x'), path.join(w.repo, '.github', 'workflows.', 'x.yml'), path.join(w.repo, '.claude', 'settings.json.'),
      path.join(w.repo, '.git::$INDEX_ALLOCATION', 'hooks', 'x'), path.join(w.repo, '.github', 'workflows', 'x.yml::$DATA'), path.join(w.repo, '.github', 'workflows', 'x.yml:s'),
      path.join(w.repo, 'GIT~1', 'hooks', 'x'), path.join(w.repo, 'GITHUB~1', 'WORKFL~1', 'x.yml'), path.join(w.repo, 'CLAUDE~1', 'settings.json'),
      path.join(w.repo, '.ENV'), path.join(w.repo, '.env.'), path.join(w.repo, '.env '), path.join(w.repo, 'src', '.Env.Local'),
      path.join(w.home, '.SSH', 'authorized_keys'), `\\\\localhost\\${D}$\\${hrest}\\.ssh\\authorized_keys`, path.join(w.state, 'TOKEN'), path.join(w.home, '.AGENTIC-ROUTER', 'agents', 'ag2.json'),
      path.join(w.repo, '.Mcp.Json'), path.join(w.repo, 'claude.MD'), path.join(w.repo, '.HUSKY', 'pre-commit'),
    ];
    for (const p of writes) assert.ok(call(w, 'Write', { file_path: p, content: 'x' }, 'ag2')?.deny, `write ${p}`);
    const reads = [
      path.join(w.repo, '.ENV'), `\\\\localhost\\${D}$\\${rest}\\.env`, `\\\\?\\${w.repo}\\.env`, path.join(w.repo, '.env.'), path.join(w.repo, '.env::$DATA'), path.join(w.repo, 'src', '..', '.env'),
      path.join(w.home, '.SSH', 'ID_RSA'), `\\\\127.0.0.1\\${D}$\\${hrest}\\.ssh\\id_rsa`, `//localhost/${D}$/${fwd(hrest)}/.ssh/id_rsa`, `\\\\?\\${w.home}\\.ssh\\id_rsa`, path.join(w.home, 'SSH~1', 'id_rsa'),
      path.join(w.state, 'Token'), `\\\\localhost\\${D}$\\${hrest}\\.do-it-all-claude-code\\token`, fwd(w.home) + '/.ssh\\id_rsa',
    ];
    for (const p of reads) assert.ok(call(w, 'Read', { file_path: p })?.deny, `read ${p}`);
    for (const p of [path.join(w.home, '.ssh'), `\\\\localhost\\${D}$\\${hrest}\\.ssh`, w.state, w.home])
      for (const tool of ['Grep', 'Glob']) assert.ok(call(w, tool, { pattern: 'x', path: p })?.deny, `${tool} ${p}`);
    // the ordinary spellings of an ordinary file are fine
    assert.ok(call(w, 'Write', { file_path: fwd(w.repo) + '/src\\b.ts', content: 'x' }, 'ag2')!.allow);
    assert.ok(call(w, 'Read', { file_path: path.join(w.repo, 'SRC', 'A.TS') })!.allow);
  } finally { done(w); }
});

// Portability: a home or a project reached through a link, case on Linux, macOS specifics.
/** A directory link that works on every platform (a junction on Windows); false when links cannot be made here. */
function linkDir(target: string, link: string): boolean {
  try { fs.symlinkSync(target, link, 'junction'); return true; } catch { return false; }
}

test('a home reached through a link: credentials and the state folder are refused under both of its names', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-guard-home-')));
  try {
    const realHome = path.join(base, 'data', 'home', 'u'), linkHome = path.join(base, 'home-link'), repo = path.join(base, 'repo');
    for (const d of [path.join(realHome, '.ssh'), path.join(realHome, '.do-it-all-claude-code', 'agents'), path.join(repo, 'src')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(realHome, '.do-it-all-claude-code', 'agents', 'ag.json'), JSON.stringify({ sessionId: 's', subtaskId: 'A', pairing: 'confirmed', scope: { allowed: ['**'], protected: guard.PROTECTED_WRITE_PATHS, unscoped: true } }));
    spawnSync('git', ['-C', repo, 'init', '-q']);
    if (!linkDir(realHome, linkHome)) return;   // no permission to create links here
    const sh = (p: string) => p.replace(/\\/g, '/');
    // the router is configured with either name of the home; a path may use either name too
    for (const home of [linkHome, realHome]) {
      const opts = { userHome: home, routerHome: path.join(home, '.do-it-all-claude-code') };
      const ev = (tool: string, input: Record<string, unknown>) => guard.evaluate({ agent_type: CODER, agent_id: 'ag', session_id: 's', tool_name: tool, cwd: repo, tool_input: input }, opts) as { deny?: string; allow?: string } | null;
      const b = (command: string) => guard.classifyBash(command, { ...opts, cwd: repo, root: repo });
      for (const h of [realHome, linkHome]) {
        const how = `configured ${home === linkHome ? 'through the link' : 'by the real path'}, used ${h === linkHome ? 'through the link' : 'by the real path'}`;
        assert.ok(ev('Read', { file_path: path.join(h, '.ssh', 'id_rsa') })?.deny, `Read key: ${how}`);
        assert.ok(ev('Read', { file_path: path.join(h, '.do-it-all-claude-code', 'token') })?.deny, `Read token: ${how}`);
        assert.ok(ev('Write', { file_path: path.join(h, '.do-it-all-claude-code', 'agents', 'ag.json'), content: '{}' })?.deny, `Write scope record: ${how}`);
        assert.ok(ev('Write', { file_path: path.join(h, '.ssh', 'authorized_keys'), content: 'x' })?.deny, `Write authorized_keys: ${how}`);
        assert.ok(ev('Grep', { pattern: 'x', path: path.join(h, '.ssh') })?.deny, `Grep: ${how}`);
        assert.ok(ev('Glob', { pattern: '**/*', path: h })?.deny, `Glob over the home: ${how}`);
        for (const c of [`cat ${sh(h)}/.ssh/id_rsa`, `cat ${sh(h)}/.do-it-all-claude-code/token`, `cd ${sh(h)} && cat .ssh/id_rsa`, `cd ${sh(h)}/.ssh && cat id_rsa`, `ls ${sh(h)}/.do-it-all-claude-code`])
          assert.ok(b(c), `${c}: ${how}`);
      }
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a project opened through a link: the scope applies to both names of the repository', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-guard-proj-')));
  try {
    const realRepo = path.join(base, 'vol', 'repo'), linkRepo = path.join(base, 'repo-link'), home = path.join(base, 'home'), state = path.join(home, '.do-it-all-claude-code');
    for (const d of [path.join(realRepo, 'src'), path.join(realRepo, '.github', 'workflows'), path.join(state, 'agents')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(realRepo, 'src', 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(state, 'agents', 'ag.json'), JSON.stringify({ sessionId: 's', subtaskId: 'A', pairing: 'confirmed', scope: { allowed: ['src/**'], protected: guard.PROTECTED_WRITE_PATHS } }));
    spawnSync('git', ['-C', realRepo, 'init', '-q']);
    if (!linkDir(realRepo, linkRepo)) return;
    // the working directory the hook reports may be either name (/tmp/x and /private/tmp/x on macOS)
    for (const cwd of [realRepo, linkRepo]) {
      const ev = (tool: string, input: Record<string, unknown>) => guard.evaluate({ agent_type: CODER, agent_id: 'ag', session_id: 's', tool_name: tool, cwd, tool_input: input }, { userHome: home, routerHome: state }) as { deny?: string; allow?: string } | null;
      for (const r of [realRepo, linkRepo]) {
        const how = `cwd ${cwd === linkRepo ? 'link' : 'real'}, path ${r === linkRepo ? 'link' : 'real'}`;
        assert.ok(ev('Write', { file_path: path.join(r, 'src', 'b.ts'), content: 'x' })?.allow, `in scope: ${how}`);
        assert.ok(ev('Read', { file_path: path.join(r, 'src', 'a.ts') })?.allow, `read in the repository: ${how}`);
        assert.match(ev('Write', { file_path: path.join(r, 'docs', 'x.md'), content: 'x' })?.deny ?? '', /outside your allowed paths/, `out of scope: ${how}`);
        assert.match(ev('Write', { file_path: path.join(r, '.github', 'workflows', 'x.yml'), content: 'x' })?.deny ?? '', /protected path/, `protected: ${how}`);
        assert.match(ev('Write', { file_path: path.join(r, '..', 'elsewhere.ts'), content: 'x' })?.deny ?? '', /outside the repository/, `outside: ${how}`);
      }
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('case: refusing ignores it everywhere; allowing follows the file system', () => {
  const w = world();
  try {
    // credential and protected names are refused in any case, on every platform (more matching is the safe side)
    assert.ok(call(w, 'Read', { file_path: path.join(w.home, '.SSH', 'id_rsa') })?.deny);
    assert.ok(call(w, 'Read', { file_path: path.join(w.repo, '.ENV') })?.deny);
    assert.ok(call(w, 'Write', { file_path: path.join(w.repo, '.GitHub', 'Workflows', 'x.yml'), content: 'x' }, 'ag2')?.deny);
    assert.ok(call(w, 'Write', { file_path: path.join(w.home, '.Do-It-All-Claude-Code', 'agents', 'ag1.json'), content: '{}' }, 'ag2')?.deny);
    assert.ok(bash(w, `cat ${w.home.replace(/\\/g, '/')}/.SSH/ID_RSA`)?.deny);
    // "inside the repository" and the scope allow: a name that differs by case is another directory on Linux only
    const sibling = path.join(path.dirname(w.repo), path.basename(w.repo).toUpperCase(), 'x.ts');
    const upper = call(w, 'Write', { file_path: path.join(w.repo, 'SRC', 'b.ts'), content: 'x' });
    if (process.platform === 'linux') {
      assert.equal(call(w, 'Read', { file_path: sibling }), null, 'a sibling directory is not the repository');
      assert.match(upper?.deny ?? '', /outside your allowed paths/);
    } else {
      assert.ok(call(w, 'Read', { file_path: sibling })?.allow, 'the same directory on a case-insensitive file system');
      assert.ok(upper?.allow);
    }
  } finally { done(w); }
});

test('macOS: the data-volume spelling of a path, and the keychain', () => {
  assert.equal(guard.dataVolumePath('/System/Volumes/Data/Users/me/.ssh/id_rsa', 'darwin'), '/Users/me/.ssh/id_rsa');
  assert.equal(guard.dataVolumePath('/System/Volumes/Data', 'darwin'), '/');
  assert.equal(guard.dataVolumePath('/System/Volumes/Database/x', 'darwin'), '/System/Volumes/Database/x');
  assert.equal(guard.dataVolumePath('/System/Volumes/Data/Users/me', 'linux'), '/System/Volumes/Data/Users/me', 'only on macOS');
  assert.ok(guard.CREDENTIAL_PATHS.includes('~/Library/Keychains/**'));
  const w = world();
  try {
    for (const rel of ['Library/Keychains/login.keychain-db', '.local/share/keyrings/login.keyring', '.password-store/site.gpg', '.config/git/credentials']) {
      assert.ok(call(w, 'Read', { file_path: path.join(w.home, ...rel.split('/')) })?.deny, `Read ~/${rel}`);
      assert.ok(bash(w, `cat ${w.home.replace(/\\/g, '/')}/${rel}`)?.deny, `cat ~/${rel}`);
    }
    assert.ok(bash(w, 'ls ~/Library/Keychains')?.deny);
  } finally { done(w); }
});

/** The 8.3 name Windows gave a directory, or null when the volume has none (or off Windows). */
function shortNameOf(dir: string): string | null {
  if (!WIN) return null;
  try {
    const out = spawnSync('cmd', ['/d', '/c', 'dir', '/x', '/ad', path.dirname(dir)], { encoding: 'utf8' }).stdout ?? '';
    const name = path.basename(dir);
    const line = out.split(/\r?\n/).find(l => l.trimEnd().endsWith(name));
    const m = line ? /\s([^\s~]{1,8}~\d{1,3})\s/.exec(line) : null;
    return m ? path.join(path.dirname(dir), m[1]!) : null;
  } catch { return null; }
}

test('a working directory, home or temp directory given by its 8.3 name is not held against the paths under it (Windows)', { skip: !WIN }, () => {
  // Windows hands out %TEMP% as C:\Users\LONGNA~1\AppData\Local\Temp for a long or non-ASCII account name,
  // so a project or a home below it arrives with a short name in its path through no choice of the caller.
  const longBase = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ar guard long base name '));
  try {
    const shortBase = shortNameOf(longBase);
    if (!shortBase || !fs.existsSync(shortBase)) return;   // this volume makes no short names
    assert.match(path.basename(shortBase), /~\d/);
    for (const d of ['repo/src', 'repo/.github/workflows', 'home/.ssh', 'home/.do-it-all-claude-code/agents']) fs.mkdirSync(path.join(longBase, ...d.split('/')), { recursive: true });
    spawnSync('git', ['-C', path.join(longBase, 'repo'), 'init', '-q']);
    fs.writeFileSync(path.join(longBase, 'repo', 'src', 'a.ts'), 'a\n');
    fs.writeFileSync(path.join(longBase, 'repo', '.env'), 'X=1\n');
    fs.writeFileSync(path.join(longBase, 'home', '.do-it-all-claude-code', 'agents', 'ag.json'), JSON.stringify({ sessionId: 's', subtaskId: 'A', pairing: 'confirmed', scope: { allowed: ['src/**'], protected: guard.PROTECTED_WRITE_PATHS } }));
    // every combination: the session's directories given short or long, the path given short or long
    for (const given of [shortBase, longBase]) {
      const repo = path.join(given, 'repo'), home = path.join(given, 'home'), state = path.join(home, '.do-it-all-claude-code');
      const ev = (tool: string, input: Record<string, unknown>) => guard.evaluate({ agent_type: CODER, agent_id: 'ag', session_id: 's', tool_name: tool, cwd: repo, tool_input: input }, { userHome: home, routerHome: state }) as { deny?: string; allow?: string } | null;
      const sh = (c: string) => guard.classifyBash(c, { userHome: home, routerHome: state, cwd: repo, root: repo });
      /** A path for a shell command: forward slashes, quoted (the long name has spaces). */
      const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
      for (const used of [shortBase, longBase]) {
        const how = `directories given ${given === shortBase ? 'short' : 'long'}, path written ${used === shortBase ? 'short' : 'long'}`;
        const r = path.join(used, 'repo'), h = path.join(used, 'home');
        // a short name in a path is accepted only as part of a directory the session itself was given that way
        const ok = used === given || used === longBase;
        if (ok) {
          assert.ok(ev('Write', { file_path: path.join(r, 'src', 'b.ts'), content: 'x' })?.allow, `write in scope: ${how}`);
          assert.ok(ev('Read', { file_path: path.join(r, 'src', 'a.ts') })?.allow, `read in the repository: ${how}`);
          assert.match(ev('Write', { file_path: path.join(r, 'docs', 'x.md'), content: 'x' })?.deny ?? '', /outside your allowed paths/, `out of scope: ${how}`);
          assert.match(ev('Write', { file_path: path.join(r, '.github', 'workflows', 'x.yml'), content: 'x' })?.deny ?? '', /protected path/, `protected: ${how}`);
          assert.equal(sh(`cat ${q(path.join(r, 'src', 'a.ts'))}`), null, `cat a source file: ${how}`);
        } else {
          assert.match(ev('Write', { file_path: path.join(r, 'src', 'b.ts'), content: 'x' })?.deny ?? '', /8\.3 short name/, `a short name the session did not use: ${how}`);
        }
        // whatever the spelling, credentials and the state folder are refused
        assert.ok(ev('Read', { file_path: path.join(r, '.env') })?.deny, `read .env: ${how}`);
        assert.ok(ev('Read', { file_path: path.join(h, '.ssh', 'id_rsa') })?.deny, `read the key: ${how}`);
        assert.ok(ev('Read', { file_path: path.join(h, '.do-it-all-claude-code', 'token') })?.deny, `read the token: ${how}`);
        assert.ok(ev('Write', { file_path: path.join(h, '.do-it-all-claude-code', 'agents', 'ag.json'), content: '{}' })?.deny, `write the scope record: ${how}`);
        assert.ok(sh(`cat ${q(path.join(h, '.ssh', 'id_rsa'))}`), `cat the key: ${how}`);
        assert.ok(sh(`cd ${q(h)} && cat .ssh/id_rsa`), `cd home, cat the key: ${how}`);
        assert.ok(sh(`npx tsc --outDir ${q(path.join(r, '.git', 'hooks'))}`), `build output into .git/hooks: ${how}`);
      }
      // a short name AFTER the given directory is still refused: it is the caller's spelling
      assert.match(ev('Write', { file_path: path.join(repo, 'GITHUB~1', 'WORKFL~1', 'x.yml'), content: 'x' })?.deny ?? '', /8\.3 short name|protected path/);
      assert.match(ev('Read', { file_path: path.join(home, 'SSH~1', 'id_rsa') })?.deny ?? '', /8\.3 short name|credential/);
      assert.ok(sh(`cat ${q(path.join(home, 'SSH~1', 'id_rsa'))}`));
    }
    // the function itself
    assert.equal(guard.windowsPathProblem(path.join(shortBase, 'repo', 'src', 'a.ts'), 'win32', [path.join(shortBase, 'repo')]), null);
    assert.match(guard.windowsPathProblem(path.join(shortBase, 'repo', 'src', 'a.ts'), 'win32', [])!, /8\.3 short name/);
    assert.match(guard.windowsPathProblem(path.join(shortBase, 'repo', 'GIT~1', 'config'), 'win32', [path.join(shortBase, 'repo')])!, /8\.3 short name \(GIT~1\)/);
    assert.match(guard.windowsPathProblem(path.join(shortBase, 'repo', 'src', 'a.ts::$DATA'), 'win32', [path.join(shortBase, 'repo')])!, /NTFS stream/);
  } finally { fs.rmSync(longBase, { recursive: true, force: true }); }
});
