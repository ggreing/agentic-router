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

const CODER = 'agentic-router:coder';
const WIN = process.platform === 'win32';

interface World { base: string; repo: string; home: string; state: string; opts: { userHome: string; routerHome: string } }
function world(): World {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-guard-')));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), state = path.join(home, '.agentic-router');
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
      'grep -n "foo bar" src/a.ts', 'rg -n "TODO" src', 'git commit -m "fix: handle the empty case (#12)"', 'git add .', 'git add src/a.ts',
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
      ['cd ~/.agentic-router && cat token', /router state folder/],
      ['cd ~ && cat .ssh/id_rsa', /credential path/],
      ['cd && cat .ssh/id_rsa', /credential path/],
      ['cat ~/.agentic-router/token', /router state folder|credential path/],
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
    fs.mkdirSync(path.join(w.repo, '.agentic-router'));
    const file = path.join(w.repo, '.agentic-router', 'policy.json');
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
    fs.mkdirSync(path.join(other, '.agentic-router'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bashAllow: ['deno test'] }));
    guard.acceptPolicy(w.repo, w.state);
    fs.copyFileSync(file, path.join(other, '.agentic-router', 'policy.json'));
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
