#!/usr/bin/env node
// agentic-router guard: PreToolUse hook, registered with onFailure:"block" (fail-closed).
// Dependency-free single file (marketplace installs have no node_modules, decision 55).
//
// Applies ONLY to this plugin's subagents (agent_type "agentic-router:*"); the main session
// and every other agent pass untouched. The daemon writes agents/<agentId>.json and scopes/<key>.json
// locally and the guard reads those files, so a check needs no daemon call; without any scope record a
// router subagent may not write (decision 142).
//
// What the answers mean (decision 142):
//   deny   - recognised as not allowed.
//   allow  - Read / Grep / Glob inside the repository and off every credential path, and Edit / Write inside a
//            confirmed scope, in both the written and the link-resolved form of the path. The prompt is skipped.
//   silent - everything else, and every Bash command that was not denied: the guard reads a command line, it
//            does not sandbox it, so it never vouches for one. Claude Code's own permission rules then decide.
// The guard and the workers run as the same OS user. It keeps a worker's tool calls away from the router
// state folder and from credential files on every path it can see; it cannot stop code the user lets a
// worker run (a test, a package script) from reading what that user can read.
//
// The constants below MUST equal packages/core/src/security.ts and the key helpers in
// paths.ts; guard.test.ts checks that they do.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- policy constants (mirror of core/security.ts)
export const CREDENTIAL_PATHS = [
  '~/.claude/**', '~/.claude.json', '~/.ssh/**', '~/.aws/**', '~/.config/gcloud/**', '~/.azure/**',
  '~/.docker/config.json', '~/.npmrc', '~/.netrc', '~/_netrc', '~/.git-credentials', '~/.agentic-router/token',
  '~/.config/gh/**', '~/.kube/**', '~/.gnupg/**', '~/.pgpass', '~/.pypirc', '~/.cargo/credentials*',
  '~/.gem/credentials', '~/.terraform.d/credentials.tfrc.json',
  // the macOS keychains, and the keyrings and password stores of a Linux desktop
  '~/Library/Keychains/**', '~/Library/Cookies/**', '~/Library/Application Support/com.apple.TCC/**',
  '~/.local/share/keyrings/**', '~/.password-store/**', '~/.config/op/**', '~/.config/git/credentials', '~/.config/pip/pip.conf', '~/.config/npm/npmrc',
  '**/.env', '**/.env.*',
];
// Both root and nested forms: the session cwd can be above the repository root (audit #4).
export const PROTECTED_WRITE_PATHS = [
  '**/.env', '**/.env.*', '.claude/**', '**/.claude/**', '.github/workflows/**', '**/.github/workflows/**',
  '.gitlab-ci.yml', '**/.gitlab-ci.yml', '**/.npmrc', '.git/**', '**/.git/**',
  '.agentic-router/**', '**/.agentic-router/**',
];
export const ENV_DUMP_COMMANDS = ['env', 'printenv', 'set', 'export -p', 'Get-ChildItem Env:', 'gci env:', 'dir env:'];
export const KEYCHAIN_COMMANDS = ['security', 'secret-tool', 'cmdkey', 'Get-StoredCredential', 'vaultcmd'];
export const NETWORK_COMMANDS = ['curl', 'wget', 'Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'irm', 'nc', 'ncat', 'netcat', 'scp', 'sftp', 'ftp', 'telnet', 'ssh'];

/** Bash allowlist for router subagents (decision 90). Must equal core ROUTER_BASH_ALLOW. */
export const ROUTER_BASH_ALLOW = [
  // build, test, lint, package installs (the one allowed network use, decision 34)
  'npm test', 'npm run', 'npm ci', 'npm install', 'npm i', 'npm ls', 'npm pkg get',
  'npx tsc', 'npx vitest', 'npx jest', 'npx eslint', 'npx prettier', 'npx playwright test',
  'pnpm test', 'pnpm run', 'pnpm install', 'pnpm add', 'pnpm exec tsc',
  'yarn test', 'yarn run', 'yarn install', 'yarn add',
  'node --test', 'tsc',
  'pytest', 'python -m pytest', 'python3 -m pytest', 'py -m pytest',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install', 'uv sync', 'poetry install',
  'go test', 'go build', 'go vet', 'cargo test', 'cargo build', 'cargo check', 'make test', 'make build',
  // git: read and local commit only (no push, no config, no hooks)
  'git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rev-parse', 'git ls-files',
  'git grep', 'git blame', 'git branch --show-current', 'git stash list',
  // read-only helpers
  'cd', 'pwd', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'echo', 'printf',
  'diff', 'sort', 'uniq', 'cut', 'tr', 'which', 'where', 'true', 'false', 'test',
];

export const PACKAGE_INSTALL_PREFIXES = [
  'npm install', 'npm i ', 'npm ci', 'pnpm install', 'pnpm add', 'yarn install', 'yarn add',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install', 'poetry install',
];

/** Options on otherwise-allowed commands that run a program or write a file (decision 90 / audit #3). Must equal core. */
export const ROUTER_BASH_DENY_OPTIONS = {
  'rg': ['--pre', '--pre-glob', '--search-zip', '-z'],
  'git grep': ['-O', '--open-files-in-pager', '--ext-grep'],
  'git diff': ['--output', '--ext-diff', '--textconv'],
  'git log': ['--output', '--ext-diff', '--textconv'],
  'git show': ['--output', '--ext-diff', '--textconv'],
  'git commit': ['--no-verify', '-n'],
  'sort': ['-o', '--output', '--compress-program'],
  'find': ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'],
  'diff': ['--to-file', '--from-file'],
  'grep': ['--include-dir'],
};

export const ROUTER_AGENT_PREFIX = 'agentic-router:';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// Router MCP tools are lead-only; a router subagent must never call them (mirror of core/tools.ts).
export const ROUTER_TOOL_PREFIX = 'mcp__plugin_agentic-router_router__';
export const ROUTER_TOOL_NAMES = [
  'router_get_plan', 'router_report_triage', 'router_report_result', 'router_request_escalation', 'router_request_scope',
];
export const isRouterToolName = (toolName) => typeof toolName === 'string' && toolName.startsWith(ROUTER_TOOL_PREFIX);
// Protected write paths a user grant can never open (decision 129; mirror of core NEVER_GRANTABLE_WRITE_PATHS).
export const NEVER_GRANTABLE_WRITE_PATHS = ['.git/**', '**/.git/**', '.agentic-router/**', '**/.agentic-router/**'];

const DENY_NOT_ALLOWED = 'this command is not on the router\'s Bash allowlist; ask the lead (the lead can run it, or the user can add it to .agentic-router/policy.json).';

// ---------------------------------------------------------------- paths (mirror of core/paths.ts)
export function routerHome() {
  return process.env.AGENTIC_ROUTER_HOME || path.join(os.homedir(), '.agentic-router');
}
export function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}
export function scopeKey(sessionId, subtaskId) {
  const h = createHash('sha256').update(`${sessionId}\0${subtaskId}`).digest('hex').slice(0, 10);
  return `${safeName(sessionId).slice(0, 40)}__${safeName(subtaskId).slice(0, 40)}__${h}`;
}

// ---------------------------------------------------------------- path normalization (audit #4)
function toPosix(p) { return String(p).replace(/\\/g, '/'); }

/** Strips the Windows extended-length prefix (\\?\ and \\?\UNC\). */
function stripExtended(p) {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(p)) return '\\\\' + p.slice(8);
  if (/^[\\/]{2}\?[\\/]/.test(p)) return p.slice(4);
  return p;
}
/** \\host\C$\rest -> C:\rest (admin share). */
function uncToDrive(p) {
  const m = p.match(/^[\\/]{2}[^\\/]+[\\/]([A-Za-z])\$[\\/]?(.*)$/);
  return m ? `${m[1]}:\\${m[2]}` : p;
}
/** cygwin /cygdrive/c/rest and /proc/cygdrive/c/rest -> C:\rest. */
function cygToDrive(p) {
  const m = p.match(/^\/(?:proc\/)?cygdrive\/([A-Za-z])\/(.*)$/);
  return m ? `${m[1]}:\\${m[2]}` : p;
}
/** git-bash /c/rest -> C:\rest. */
function gitBashToDrive(p) {
  const m = p.match(/^\/([A-Za-z])\/(.*)$/);
  return m ? `${m[1]}:\\${m[2]}` : p;
}
/** Walks up to the nearest existing ancestor, realpaths it (resolving symlinks/junctions), re-appends the tail. */
function realpathNearest(abs) {
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = (fs.realpathSync.native || fs.realpathSync)(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
/**
 * macOS keeps user data on a second volume that is also visible as /System/Volumes/Data: a file under
 * /Users/me is the same file as /System/Volumes/Data/Users/me, and realpath does not fold the two.
 */
export function dataVolumePath(p, platform = process.platform) {
  const m = platform === 'darwin' ? /^\/System\/Volumes\/Data(\/.*)?$/i.exec(String(p)) : null;
  return m ? (m[1] || '/') : String(p);
}
/** Whether names are compared without case: yes on Windows and macOS, no on Linux (decision 96: never looser than the file system for an allow). */
const FS_NOCASE = process.platform !== 'linux';
const fsCase = s => (FS_NOCASE ? s.toLowerCase() : s);

/** Lexical + realpath canonical forms (POSIX slashes). Both are checked so `..`, UNC, /c/, and symlinks are all covered. */
function canonicalForms(p) {
  let s = stripExtended(dataVolumePath(String(p)));
  s = uncToDrive(s);
  s = cygToDrive(s);
  s = gitBashToDrive(s);
  const lexNative = path.resolve(s);                    // absolute, `.`/`..` collapsed
  let realNative;
  try { realNative = realpathNearest(lexNative); } catch { realNative = lexNative; }
  const lex = toPosix(lexNative), real = toPosix(realNative);
  return lex === real ? [lex] : [lex, real];
}

// ---------------------------------------------------------------- Git Bash (MSYS) paths on Windows
//
// On Windows the Bash tool is Git Bash, where a path that starts with "/" is not a Windows path:
//   /c/Users/x   -> C:\Users\x            (any single letter is a drive)
//   /tmp/x       -> %TEMP%\x
//   /usr/x, /etc/x, /home/x, /x  -> <Git install directory>\...
// and the two kinds of program a command can start read the same text differently:
//   - bash itself and its own tools (cd, cat, ls, …) collapse ".." first, then map:  /tmp/../x -> <Git>\x
//   - a native program (git, node, rg, npm, …) gets the argument mapped by its prefix, ".." left in place:
//     /tmp/../x -> %TEMP%\..\x
// A check that resolves such an argument the Windows way (/tmp/x -> C:\tmp\x) looks at a file the command
// never opens. So for Bash every reading is produced and all of them are checked.
// The file tools (Read, Edit, Glob, …) are not Git Bash: they take the text as a Windows path. There such a
// path is refused with the Windows spelling in the message, never mapped and allowed.
let gitRootCache;
/** The Git for Windows install directory ("/" in Git Bash), or null when it cannot be found. */
function msysRoot() {
  if (gitRootCache !== undefined) return gitRootCache;
  gitRootCache = null;
  try {
    const exe = process.env.EXEPATH;                       // set inside Git Bash: <Git>\bin or <Git>
    if (exe && fs.existsSync(path.join(exe, '..', 'usr', 'bin'))) return (gitRootCache = path.resolve(exe, '..'));
    if (exe && fs.existsSync(path.join(exe, 'usr', 'bin'))) return (gitRootCache = path.resolve(exe));
    const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 2000 });   // <Git>/mingw64/libexec/git-core
    const p = r.status === 0 ? r.stdout.trim() : '';
    const m = /^(.*?)[\\/](?:mingw64|mingw32|clangarm64|usr)[\\/]/i.exec(p);
    if (m && fs.existsSync(path.join(m[1], 'usr', 'bin'))) gitRootCache = path.resolve(m[1]);
  } catch { /* not found */ }
  return gitRootCache;
}
/** True for a Git Bash absolute path that is not already a drive form the file tools understand. */
function isMsysOnlyPath(p, platform = process.platform) {
  const s = toPosix(p);   // Claude Code may hand the hook "\tmp\x" for a "/tmp/x" the model wrote
  return platform === 'win32' && /^\/(?!\/)/.test(s) && !/^\/[A-Za-z](?:\/|$)/.test(s) && !/^\/(?:proc\/)?cygdrive\//.test(s);
}
/** One Git Bash absolute path (already a POSIX string) to the Windows path its mount gives; null for /dev and /proc. */
function msysMount(posixPath, env) {
  if (/^\/(?:dev|proc)(?:\/|$)/.test(posixPath)) return null;
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(posixPath);
  if (drive) return path.win32.normalize(`${drive[1].toUpperCase()}:\\${drive[2] ?? ''}`);
  const tmp = /^\/tmp(?:\/(.*))?$/.exec(posixPath);
  if (tmp) return path.win32.join(env.tmp, tmp[1] ?? '');
  return env.root ? path.win32.join(env.root, posixPath) : null;
}
/**
 * The Windows paths a Git Bash absolute path can mean: as bash and its tools read it, and as a native
 * program started from bash gets it. `env`: { tmp, root } (tests pass fixed values).
 */
export function msysPathForms(p, env = {}) {
  const e = { tmp: env.tmp ?? os.tmpdir(), root: env.root !== undefined ? env.root : msysRoot() };
  const out = [];
  const add = w => { if (w && !out.includes(w)) out.push(w); };
  add(msysMount(path.posix.normalize(p), e));              // bash, cat, ls: ".." collapsed first
  // native programs: the longest mount prefix is replaced, the rest (".." included) is appended
  const m = /^\/(tmp|[A-Za-z])(?=\/|$)(.*)$/.exec(p);
  if (m) add(path.win32.resolve((m[1].length === 1 ? `${m[1].toUpperCase()}:\\` : e.tmp) + m[2]));
  else if (e.root && !/^\/(?:dev|proc)(?:\/|$)/.test(p)) add(path.win32.resolve(e.root + p));
  return out;
}

// ---------------------------------------------------------------- glob matching
export function globToRegExp(glob, nocase = true) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; }
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, nocase ? 'i' : '');
}
/** Repo-relative path/pattern normalization: backslashes -> /, strip a leading `./`. */
function normRel(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, ''); }
function expandHome(pattern, userHome) {
  return pattern.startsWith('~/') ? toPosix(userHome) + pattern.slice(1) : pattern;
}
/** Simple matcher used for repo-relative candidates (no path canonicalisation). */
export function matchesAny(candidate, patterns, home) {
  const c = toPosix(candidate);
  return patterns.some(p => globToRegExp(expandHome(p, home)).test(c));
}
/** Matcher for an ABSOLUTE filesystem path: both canonical forms are tested against each pattern. */
function matchesPath(candidate, patterns, userHome) {
  const forms = canonicalForms(candidate);
  // A home that is reached through a link (/home/u -> /data/home/u) has two names, and a path may use either.
  const homes = userHome ? canonicalForms(userHome) : [undefined];
  return patterns.some(p => (p.startsWith('~/') ? homes : [userHome]).some(h => {
    const re = globToRegExp(toPosix(expandHome(p, h)));
    return forms.some(f => re.test(f));
  }));
}

/** Fixed (glob-free) base dir of each `~`-rooted credential pattern — for Grep/Glob containment. */
function credentialDirs(userHome) {
  const out = [];
  for (const pat of CREDENTIAL_PATHS) {
    if (!pat.startsWith('~/')) continue;
    const base = pat.replace(/\/\*.*$/, '');                 // strip the first glob segment onward
    for (const h of canonicalForms(userHome)) out.push(toPosix(expandHome(base, h)).toLowerCase().replace(/\/+$/, ''));
  }
  return [...new Set(out)];
}
/** True if a Grep/Glob rooted at dirPath would touch (be at, under, or above) a credential location. */
function overlapsCredential(dirPath, userHome) {
  const dirs = credentialDirs(userHome);
  return canonicalForms(dirPath).some(form => {
    const c = form.toLowerCase().replace(/\/+$/, '');
    return dirs.some(d => c === d || c.startsWith(d + '/') || d.startsWith(c + '/'));
  });
}
/** True if `p` resolves to `dir` or anything under it. */
function isUnder(p, dir) {
  // every spelling of the directory (as given, and with links resolved) against every spelling of the path;
  // without case, since this is used to refuse
  const bases = canonicalForms(dir).map(b => b.toLowerCase().replace(/\/+$/, ''));
  return canonicalForms(p).some(form => {
    const c = form.toLowerCase().replace(/\/+$/, '');
    return bases.some(base => c === base || c.startsWith(base + '/'));
  });
}

// ---------------------------------------------------------------- path rules shared by every tool (decision 142)

/** `.env.example` and its kin are templates that repositories commit: readable, and writable once granted. */
const ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template|dist|defaults?)$/i;
const ENV_PATTERNS = new Set(['**/.env', '**/.env.*']);
const HOME_CREDENTIAL_PATHS = CREDENTIAL_PATHS.filter(p => !ENV_PATTERNS.has(p));
export function isEnvTemplate(p) {
  return ENV_TEMPLATE_RE.test(toPosix(String(p)).split('/').pop() ?? '');
}
/** A credential path, in either canonical form. An env template is one only where another pattern covers it (inside ~/.ssh, say). */
function credentialHit(abs, userHome) {
  if (matchesPath(abs, HOME_CREDENTIAL_PATHS, userHome)) return true;
  return matchesPath(abs, [...ENV_PATTERNS], userHome) && !isEnvTemplate(abs);
}

/**
 * Spellings Windows resolves to another file than the text says. They are refused rather than normalised:
 * a device or extended-length prefix, an NTFS stream (":" after the drive letter), an 8.3 short name
 * (GITHUB~1), and a segment ending in a dot or a space (".env." opens ".env").
 */
export function windowsPathProblem(p, platform = process.platform, bases = []) {
  if (platform !== 'win32') return null;
  const s = String(p);
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return 'a device or extended-length path (\\\\?\\ or \\\\.\\)';
  // A directory the guard was given (the working directory, the home, the temp directory) may itself be
  // spelled with a short name: Windows hands out %TEMP% as C:\Users\LONGNA~1\… for a long or non-ASCII
  // account name. That prefix is not the caller's choice of spelling, so only what follows it is examined.
  const norm = toPosix(s).replace(/^\/([A-Za-z])\//, '$1:/');   // the Git Bash drive form /c/… is C:/…
  const lower = norm.toLowerCase();
  let skip = 0;
  for (const b of bases) {
    const base = toPosix(String(b ?? '')).toLowerCase().replace(/\/+$/, '');
    if (base.length > skip && /^[a-z]:\//.test(base) && (lower === base || lower.startsWith(base + '/'))) skip = base.length;
  }
  const rest = skip ? norm.slice(skip) : s.replace(/^[A-Za-z]:/, '');
  if (rest.includes(':')) return 'an NTFS stream name (":" inside the path)';
  for (const seg of rest.split(/[\\/]+/)) {
    if (/^[^\\/]{1,8}~\d{1,3}(?:\.[^\\/.]{0,3})?$/.test(seg)) return `an 8.3 short name (${seg})`;
    if (seg !== '.' && seg !== '..' && seg !== '...' && /[. ]$/.test(seg)) return 'a path segment ending in a dot or a space';
  }
  return null;
}

/**
 * True when `p`, with links resolved, is `dir` or under it (with links resolved). Used to ALLOW, so names are
 * compared the way the file system compares them: on Linux "Repo" is not "repo". The spelling of the path does
 * not matter: a project opened as /tmp/x on macOS is /private/tmp/x, and both name the same files.
 */
function allFormsUnder(p, dir) {
  const real = forms => fsCase(forms[forms.length - 1]).replace(/\/+$/, '');
  const base = real(canonicalForms(dir)), c = real(canonicalForms(p));
  return c === base || c.startsWith(base + '/');
}

/** The directories a call was given by the session or the environment, as they were spelled (for windowsPathProblem). */
function trustedBases(...dirs) {
  return [...dirs, os.tmpdir()].filter(d => typeof d === 'string' && d !== '');
}

/** Names that are a credential store or hold one, as a single path segment (for globs, which cannot be resolved). Must equal core. */
export const GUARD_SENSITIVE_SEGMENTS = [
  '.env', '.claude', '.claude.json', '.ssh', '.aws', '.azure', '.docker', '.npmrc', '.netrc', '_netrc', '.git-credentials',
  '.agentic-router', '.kube', '.gnupg', '.pgpass', '.pypirc', '.env.local', '.env.production', '.env.development', '.env.test',
];
const SENSITIVE_SEGMENTS = GUARD_SENSITIVE_SEGMENTS;
const GLOB_CHARS = /[*?[]/;
/** A bash glob segment as a RegExp (no "/" inside; a leading dot is matched only by a literal dot, as in bash). */
function segmentRegExp(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) { re += '\\['; continue; }
      re += `[${seg.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`, 'i'); } catch { return /^$/; }
}
/** Why a path or glob text names a credential by one of its segments, or null. Used where nothing can be resolved. */
function sensitiveSegment(text) {
  for (const seg of toPosix(String(text)).split('/')) {
    if (!seg || seg === '.' || seg === '..' || seg === '**' || /^\*+$/.test(seg)) continue;   // a bare * names nothing
    const lower = seg.toLowerCase();
    if (!GLOB_CHARS.test(seg)) {
      if (SENSITIVE_SEGMENTS.includes(lower) || (lower.startsWith('.env.') && !ENV_TEMPLATE_RE.test(lower))) return `the credential name ${seg}`;
      continue;
    }
    // A glob reaches a dotfile only when the segment itself starts with a dot (bash) - or anywhere, for the
    // Grep and Glob tools, whose matcher does not have that rule. So a dot-leading glob is refused outright,
    // and any other glob is tested against the names above.
    if (seg.startsWith('.')) return `a glob over dotfiles (${seg})`;
    const re = segmentRegExp(seg);
    if (SENSITIVE_SEGMENTS.some(n => re.test(n))) return `a glob that matches a credential name (${seg})`;
  }
  return null;
}
/** `{a,b}` alternatives of a word, one level, bounded. */
function expandBraces(word, budget = { left: MAX_BRACE_WORK }) {
  if (budget.left-- <= 0) return null;
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(word);
  if (!m) return [word];
  const out = [];
  for (const alt of m[2].split(',')) {
    const more = expandBraces(`${m[1]}${alt}${m[3]}`, budget);
    if (more === null || out.length + more.length > MAX_BRACE_WORDS) return null;
    out.push(...more);
  }
  return out;
}
/**
 * A word's brace alternatives, or null when there are more than the guard will go through (the caller then
 * refuses). The bound is on the work, not only on the result: `{a,b}` twenty times over is a million words.
 */
const MAX_BRACE_WORDS = 64;
const MAX_BRACE_WORK = 256;
const TOO_MANY_BRACES = 'a brace expansion with more alternatives than can be checked';

// ---------------------------------------------------------------- Bash checks (decisions 90, 142)
//
// What this can and cannot do. A command line is checked by reading it, not by running it in a sandbox, so
// the check is a deny-list with a small grammar: anything the lexer cannot follow is refused, every argument
// is looked at as a possible path, and options that run a program or write a file are refused. A command that
// passes is NOT declared safe: the guard stays silent and Claude Code's own permission rules decide (decision
// 142; the guard never answers "allow" for Bash). Commands on the allowlist that run code the worker may have
// written (test runners, package scripts, installs) are exactly that: allowed to be asked about, never vouched for.
const MAX_COMMAND_CHARS = 20_000;
/** Commands that run another command: never allowed as the first word. Must equal core. */
export const GUARD_WRAPPER_COMMANDS = ['sudo', 'doas', 'env', 'xargs', 'time', 'nohup', 'command', 'builtin', 'exec', 'eval', 'source', '.'];
const WRAPPERS = new Set(GUARD_WRAPPER_COMMANDS);
/** The secret-looking part of a variable name; mirrors core/security.ts (a test asserts equality). */
export const SECRET_VAR_NAME_PATTERN = 'ANTHROPIC|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|COOKIE|AUTH|DATABASE_URL|DSN';
const SECRET_VAR_RE = new RegExp(String.raw`(?:\$\{?!?|\$env:|%)[A-Za-z0-9_]*(?:${SECRET_VAR_NAME_PATTERN})[A-Za-z0-9_]*\}?`, 'i');

/**
 * Options refused on top of ROUTER_BASH_DENY_OPTIONS: they read hidden or ignored files, run a program, open an
 * editor or an interactive mode, write outside the result, or take an install to another registry or out of
 * the repository. Must equal core GUARD_EXTRA_DENY_OPTIONS.
 */
export const GUARD_EXTRA_DENY_OPTIONS = {
  'rg': ['--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-dot', '--no-ignore-parent', '--no-ignore-global', '--no-ignore-exclude', '--no-ignore-files', '--unrestricted', '-u', '-.', '--hostname-bin'],
  'printf': ['-v'],
  'git grep': ['--no-index', '--untracked', '--no-exclude-standard', '--textconv'],
  'git diff': ['--no-index'],
  // interactive and editor modes cannot work without a terminal; --amend rewrites a commit the worker did not make
  'git add': ['-e', '--edit', '-i', '--interactive', '-p', '--patch', '--chmod'],
  'git commit': ['-e', '--edit', '--amend', '-p', '--patch', '--interactive', '--reedit-message', '--reset-author', '--no-post-rewrite'],
  // `git stash list` passes its options on to git log
  'git stash': ['--output', '--ext-diff', '--textconv'],
  'sort': ['-T', '--temporary-directory'],
  'diff': ['-l', '--paginate'],
  'tail': ['-f', '-F', '--follow', '--retry'],
  // installs: the registry is fixed, and nothing is installed outside the repository
  'npm install': ['--registry', '-g', '--global', '--location', '--prefix', '--userconfig', '--globalconfig'], 'npm i': ['--registry', '-g', '--global', '--location', '--prefix', '--userconfig', '--globalconfig'], 'npm ci': ['--registry', '-g', '--global', '--location', '--prefix', '--userconfig', '--globalconfig'],
  'pnpm install': ['--registry', '-g', '--global', '--dir', '-C'], 'pnpm add': ['--registry', '-g', '--global', '--dir', '-C'],
  'yarn install': ['--registry', '--cwd', '--modules-folder', '--global-folder'], 'yarn add': ['--registry', '--cwd', '--modules-folder', '--global-folder'],
  'pip install': ['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--trusted-host', '-t', '--target', '--prefix', '--root', '--user'],
  'pip3 install': ['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--trusted-host', '-t', '--target', '--prefix', '--root', '--user'],
};
/** Allowed commands that only read (and git, which has its own option list). Every other allowed command builds, tests or installs, and can write files. Must equal core. */
export const GUARD_READ_ONLY_COMMANDS = ['cd', 'pwd', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'echo', 'printf', 'diff', 'sort', 'uniq', 'cut', 'tr', 'which', 'where', 'true', 'false', 'test', 'set', 'git'];
const READ_ONLY_COMMANDS = new Set(GUARD_READ_ONLY_COMMANDS);
/** The only paths under /dev or /proc a command may name. Must equal core. */
export const GUARD_PLAIN_DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'];
const PLAIN_DEVICES = new Set(GUARD_PLAIN_DEVICES);

function stripOuterQuotes(w) { return w.replace(/^["']/, '').replace(/["']$/, ''); }
function baseName(w) {
  const s = stripOuterQuotes(w).replace(/\\/g, '/').split('/').pop();
  return s.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
}
function expandTilde(p, userHome) { return /^~(?=[\\/]|$)/.test(p) ? toPosix(userHome) + String(p).slice(1) : p; }

/**
 * A quote-aware shell lexer: splits a command line into simple commands (token arrays), honoring
 * single/double quotes so operators INSIDE quotes are literal. Flags constructs we refuse to run.
 * Allowed redirections (2>&1, >/dev/null, 2>/dev/null, >NUL) are consumed and dropped.
 * It must never read more as "inside a quote" than bash does: $'…' and $"…" (other quoting rules), a
 * word-initial # (a comment to bash) and a backslash-newline are refused, and \" inside double quotes is
 * followed as bash follows it.
 */
function lexBash(cmd) {
  const commands = [];
  let tokens = [], cur = '', refuse = null;
  const pushTok = () => { if (cur !== '') { tokens.push(cur); cur = ''; } };
  const endCmd = () => { pushTok(); if (tokens.length) commands.push(tokens); tokens = []; };
  const n = cmd.length;
  for (let i = 0; i < n;) {
    const c = cmd[i];
    if (c === '$' && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) { refuse ??= 'a $\'…\' or $"…" string'; cur += c; i++; continue; }
    if (c === '#' && cur === '') { refuse ??= 'a # comment'; cur += c; i++; continue; }
    if (c === "'") { cur += c; i++; while (i < n && cmd[i] !== "'") { cur += cmd[i++]; } if (i < n) cur += cmd[i++]; else refuse ??= 'an unterminated quote'; continue; }
    if (c === '"') {
      cur += c; i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < n) { cur += cmd[i] + cmd[i + 1]; i += 2; continue; }   // \" does not end the string
        if (cmd[i] === '`') refuse ??= 'a backtick command substitution in double quotes';
        else if (cmd[i] === '$' && cmd[i + 1] === '(') refuse ??= 'a $() command substitution in double quotes';
        else if (cmd[i] === '$' && cmd[i + 1] === '{') refuse ??= 'a ${} expansion in double quotes';
        cur += cmd[i++];
      }
      if (i < n) cur += cmd[i++]; else refuse ??= 'an unterminated quote';
      continue;
    }
    if (c === '\\') {
      if (cmd[i + 1] === '\n' || cmd[i + 1] === '\r') refuse ??= 'a backslash line continuation';
      cur += c; if (i + 1 < n) cur += cmd[i + 1]; i += 2; continue;   // escape: keep both chars
    }
    if (c === '`') { refuse ??= 'a backtick command substitution'; cur += c; i++; continue; }
    if (c === '$' && cmd[i + 1] === '(') { refuse ??= 'a $() command substitution'; cur += '$('; i += 2; continue; }
    if (c === '$' && cmd[i + 1] === '{') { refuse ??= 'a ${} expansion'; cur += '${'; i += 2; continue; }
    if ((c === '<' || c === '>') && cmd[i + 1] === '(') { refuse ??= 'a process substitution'; cur += c; i++; continue; }
    if (c === '(' || c === ')') { refuse ??= 'a subshell / grouping parenthesis'; cur += c; i++; continue; }
    if (/[0-9]/.test(c) && (cmd[i + 1] === '>' || cmd[i + 1] === '<')) {
      const m = cmd.slice(i).match(/^(2>&1|2>\s*\/dev\/null|2>\s*nul\b)/i);
      if (m) { pushTok(); i += m[0].length; continue; }
      refuse ??= 'an output redirection'; cur += c; i++; continue;
    }
    if (c === '<' || c === '>') {
      const m = cmd.slice(i).match(/^(>\s*\/dev\/null|>\s*nul\b)/i);
      if (m) { pushTok(); i += m[0].length; continue; }
      refuse ??= 'an output redirection'; cur += c; i++; continue;
    }
    if (c === '\n' || c === ';') { endCmd(); i++; continue; }
    if (c === '&') { if (cmd[i + 1] === '&') i++; endCmd(); i++; continue; }
    if (c === '|') { if (cmd[i + 1] === '|') i++; endCmd(); i++; continue; }
    if (/\s/.test(c)) { pushTok(); i++; continue; }
    cur += c; i++;
  }
  endCmd();
  return { commands: commands.map(ws => ws.map(shellWord)), refuse };
}

/**
 * A word as bash passes it on: quotes removed, escapes resolved. `.en""v`, `.e'n'v`, `.e\nv` and `".e"nv` are
 * all the file .env to bash, and `--no-ver""ify` is --no-verify; every check has to look at that word, not at
 * the text. (lexBash has already refused what would need more than this: $'…', $"…", substitutions, a
 * backslash-newline.) A `$` keeps its place either way, so a quoted one is still treated as a variable.
 */
export function shellWord(raw) {
  let out = '';
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (c === "'") { const end = raw.indexOf("'", i + 1); if (end < 0) { out += raw.slice(i + 1); break; } out += raw.slice(i + 1, end); i = end + 1; continue; }
    if (c === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\' && i + 1 < raw.length && '"\\$`'.includes(raw[i + 1])) { out += raw[i + 1]; i += 2; continue; }
        out += raw[i++];
      }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < raw.length) { out += raw[i + 1]; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** Does one allowlist entry's words prefix-match the command's words? The command name must be bare (no path). */
function entryMatches(words, entry) {
  const ew = entry.split(/\s+/);
  if (baseName(words[0]) !== baseName(ew[0])) return false;
  for (let i = 1; i < ew.length; i++) {
    if (ew[i] === '*') return true;
    if (words[i] === undefined || stripOuterQuotes(words[i]).toLowerCase() !== ew[i].toLowerCase()) return false;
  }
  return true;
}

/** An argument that looks like a filesystem path (not a message/pattern/flag value). */
function pathLikeArg(raw) {
  const s = stripOuterQuotes(raw);
  if (/\s/.test(s)) return false;                           // messages / patterns have spaces
  return s.includes('/') || /^~/.test(raw) || /^[A-Za-z]:/.test(s) || /^\.{1,2}(?:$|[\\/])/.test(s)
    || /^\$\{?(HOME|USERPROFILE)\}?/i.test(raw) || /^\$env:/i.test(raw) || /^%[A-Za-z0-9_]+%/.test(raw);
}
/** A path argument containing a construct we cannot resolve the way bash would -> refuse (fail-closed). */
function unsafePathArg(raw) {
  const inner = raw.replace(/^(['"])/, '').replace(/(['"])$/, '');
  if (/['"]/.test(inner)) return 'a quote inside the word';
  if (/\$/.test(raw)) return 'a variable reference ($)';
  if (/`/.test(raw)) return 'a command substitution';
  if (/[*?[{]/.test(raw)) return 'a glob character (* ? [ {)';
  if (/\\/.test(raw) && (/^~/.test(raw) || raw.includes('/'))) return 'a backslash escape in a POSIX-style path';
  if (/^~[^/]/.test(raw)) return 'a ~user reference';
  return null;
}
function isCredentialPath(abs, userHome) {
  if (/\/proc\/[^/\s]+\/(?:task\/[^/\s]+\/)?environ/.test(abs)) return true;
  return credentialHit(abs, userHome) || overlapsCredential(abs, userHome);
}
/**
 * Every file a shell path argument can name, resolved against the virtual cwd (drive-normalised posix).
 * Usually one. On Windows a Git Bash absolute path has two readings (see msysPathForms); the first entry is
 * bash's own, which is what `cd` follows.
 */
function resolvePathArgForms(raw, vcwd, userHome, msys) {
  let e = expandTilde(stripOuterQuotes(raw), userHome);
  // Windows opens ".env." and ".env " as ".env": drop trailing dots and spaces of each segment before matching
  if (process.platform === 'win32') e = e.split(/([\\/]+)/).map(seg => (/^[\\/]+$/.test(seg) || seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/, ''))).join('');
  if (process.platform === 'win32' && /^\/(?![\\/])/.test(e) && !/^\/(?:proc\/)?cygdrive\//.test(e)) {
    const forms = msysPathForms(toPosix(e), msys).map(w => canonicalForms(w)[0]);
    if (forms.length) return [...new Set(forms)];
  }
  const abs = path.isAbsolute(e) || /^[A-Za-z]:/.test(e) || /^[\\/]/.test(e) ? e : path.resolve(vcwd, e);
  return [canonicalForms(abs)[0]];
}
function resolvePathArg(raw, vcwd, userHome, msys) {
  return resolvePathArgForms(raw, vcwd, userHome, msys)[0];
}
/** True if a Bash command reads/writes any path argument that resolves OUTSIDE the repo root (decision 96 detail). */
export function bashTouchesOutsideRepo(command, { userHome = os.homedir(), cwd = process.cwd(), root = cwd } = {}) {
  let vcwd = cwd;
  for (const words of lexBash(String(command)).commands) {
    if (words.length === 0) continue;
    if (baseName(words[0]) === 'cd') {
      const t = words[1];
      if (t && !unsafePathArg(t)) vcwd = resolvePathArg(t, vcwd, userHome);
      continue;
    }
    for (let i = 1; i < words.length; i++) {
      const raw = words[i];
      if (!pathLikeArg(raw) || unsafePathArg(raw)) continue;   // unsafe args are denied elsewhere
      if (resolvePathArgForms(raw, vcwd, userHome).some(abs => !isUnder(abs, root))) return true;
    }
  }
  return false;
}

/** Commands whose arguments are files to read: a variable in one of them cannot be checked. */
const READER_COMMANDS = new Set(['cat', 'type', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'diff', 'sort', 'uniq', 'cut', 'tr', 'ls', 'dir', 'test']);
const CREDENTIAL_FILE_RE = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|_netrc|\.git-credentials|\.pgpass|\.pypirc)$/i;
const WALK_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__']);
/** Whether a directory holds a credential file a recursive read would open (bounded walk: 4 levels, 3000 entries). */
function dirHoldsCredentialFile(dir) {
  let seen = 0;
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (++seen > 3000) return false;
      if (CREDENTIAL_FILE_RE.test(e.name) && !ENV_TEMPLATE_RE.test(e.name)) return true;
      if (e.isDirectory() && depth < 4 && !WALK_SKIP.has(e.name) && walk(path.join(d, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/**
 * Credential files below `dir` that a search honouring .gitignore would still open: found by the same
 * bounded walk, then without those git ignores (tracked or not, as the search tools decide by pattern).
 * Outside a git repository nothing is ignored. Returns paths relative to `dir`, at most 20.
 */
export function unignoredCredentialFiles(dir) {
  const found = [];
  let seen = 0;
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 3000 || found.length >= 20) return;
      if (CREDENTIAL_FILE_RE.test(e.name) && !ENV_TEMPLATE_RE.test(e.name) && !e.isDirectory()) found.push(toPosix(path.relative(dir, path.join(d, e.name))));
      else if (e.isDirectory() && depth < 4 && !WALK_SKIP.has(e.name)) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  if (!found.length) return [];
  try {
    const r = spawnSync('git', ['-C', dir, 'check-ignore', '--no-index', '-z', '--stdin'], { input: found.join('\0') + '\0', encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 || r.status === 1) {
      const ignored = new Set(String(r.stdout).split('\0').filter(Boolean));
      return found.filter(f => !ignored.has(f));
    }
  } catch { /* git missing: nothing is known to be ignored */ }
  return found;
}
/** Whether a Grep `glob` narrows the search to named files (a bare "*" or "**\/*" does not, nor does an exclusion). */
function narrowingGlob(g) {
  if (typeof g !== 'string' || g.trim() === '') return false;
  const alts = expandBraces(g.trim());
  return alts !== null && alts.every(alt => !alt.startsWith('!') && alt.split('/').some(seg => seg !== '' && !/^\*+$/.test(seg)));
}

const NPM_NAME_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~<>=*|-]+)?$/i;
const PIP_NAME_RE = /^[A-Za-z0-9][\w.-]*(?:\[[\w,.-]+\])?(?:[<>=!~]=?[\w.*,<>=!~]+)?$/;
/** An install may name registry packages only: a URL, a git spec, a tarball or a host/path shorthand fetches from anywhere. */
function installArgProblem(tool, arg) {
  const s = stripOuterQuotes(arg);
  if (/:\/\/|^git[+@]|^github:|^gitlab:|^bitbucket:|^file:|^https?:/i.test(s)) return `a package source that is not a registry name (${s.slice(0, 60)})`;
  if (tool === 'pip') return PIP_NAME_RE.test(s) || /^\.{1,2}(?:$|[\\/])/.test(s) || /\.(?:txt|toml|cfg)$/i.test(s) ? null : `a package source that is not a registry name (${s.slice(0, 60)})`;
  return NPM_NAME_RE.test(s) || /^\.{1,2}(?:$|[\\/])/.test(s) ? null : `a package source that is not a registry name (${s.slice(0, 60)})`;
}

/** Whether a word is one of the refused options, written out, abbreviated (--out for --output) or bundled (-uo for -o). */
function deniedOption(tok, denied) {
  if (!tok.startsWith('-') || tok === '-' || tok === '--') return false;
  if (tok.startsWith('--')) {
    const name = tok.split('=')[0];
    return denied.some(opt => opt.startsWith('--') && (name === opt || (name.length > 2 && opt.startsWith(name))));
  }
  return denied.some(opt => {
    if (opt.startsWith('--')) return false;
    // a single-letter flag anywhere in a bundle; the bundle ends where a value starts (-g*.ts, -n5, -k1,2)
    if (opt.length === 2) return (/^[A-Za-z.]*/.exec(tok.slice(1))?.[0] ?? '').includes(opt[1]);
    return tok === opt || tok.startsWith(opt);                            // find's -exec and the like
  });
}

/**
 * Returns a deny reason for a router subagent's Bash command, or null when nothing recognised as bad was
 * found (which is not a statement that the command is safe).
 * opts: { userHome, routerHome, bashAllow, cwd, root, denyExec, msys } (bashAllow = the accepted project policy's
 * extension; msys = { tmp, root } overrides where Git Bash's /tmp and / point, for tests).
 */
export function classifyBash(command, opts = {}) {
  const userHome = opts.userHome ?? os.homedir();
  const stateHome = opts.routerHome ?? routerHome();
  const baseCwd = opts.cwd ?? process.cwd();
  const allow = [...ROUTER_BASH_ALLOW, ...(Array.isArray(opts.bashAllow) ? opts.bashAllow : [])];
  const bases = trustedBases(baseCwd, opts.root, userHome, stateHome);

  if (String(command).length > MAX_COMMAND_CHARS) return `${DENY_NOT_ALLOWED} (the command line is longer than ${MAX_COMMAND_CHARS} characters, which is more than is checked)`;
  const { commands, refuse } = lexBash(String(command));
  if (refuse) return `${DENY_NOT_ALLOWED} (it contains ${refuse})`;
  if (SECRET_VAR_RE.test(String(command))) return 'this command references a secret environment variable, which is not allowed.';

  /** One argument (or the value of --opt=value) looked at as a possible path, in the directory the command runs in. */
  const checkArg = (cmd0, raw, vcwd) => {
    const words = expandBraces(stripOuterQuotes(raw));
    if (words === null) return `this command has ${TOO_MANY_BRACES}; it is not allowed.`;
    for (const word of words) {
      if (word === '') continue;
      // /proc/self/root/…, /proc/<pid>/cwd/…, /dev/clipboard, /dev/fd/N: other names for files and data the
      // path checks below would not recognise
      const px = toPosix(word).replace(/^\/+/, '/');
      if (/^\/(?:proc|dev)(?:\/|$)/.test(px) && !PLAIN_DEVICES.has(px)) return 'this command names a path under /proc or /dev, which is not allowed.';
      if (/\$/.test(word)) {
        if (pathLikeArg(word) || READER_COMMANDS.has(cmd0)) return 'this command has a file argument with a variable reference ($), which cannot be checked; it is not allowed.';
        continue;
      }
      const inner = raw.replace(/^(['"])/, '').replace(/(['"])$/, '');
      if (/['"]/.test(inner) && pathLikeArg(inner.replace(/['"]/g, ''))) return 'this command has a path argument with a quote inside the word, which cannot be checked safely; it is not allowed.';
      if (/^~[^/\\]/.test(word)) return 'this command has a path argument with a ~user reference, which cannot be checked safely; it is not allowed.';
      // `git show HEAD:.env` and the like: the part after the colon is a path in the repository
      const staged = cmd0 === 'git' ? /^:(?:[0-3]:)?(?![\\/:])(.+)$/.exec(word) : null;   // ":.env", ":0:.env" (not ":/text", a commit search)
      const candidates = staged ? [word, staged[1]]
        : cmd0 === 'git' && /^[^:\\/]+:(?![\\/]{2})./.test(word) && !/^[A-Za-z]:[\\/]/.test(word) ? [word, word.slice(word.indexOf(':') + 1)] : [word];
      for (const cand of candidates) {
        const named = sensitiveSegment(cand);
        if (named && (GLOB_CHARS.test(cand) || candidates.length > 1)) return `this command names ${named}, which is not allowed.`;
        if (GLOB_CHARS.test(cand)) continue;                 // a glob without a credential name: nothing to resolve
        if (/[\\/]/.test(cand) || /^\./.test(cand)) {
          const w = windowsPathProblem(cmd0 === 'git' ? cand.replace(/^(?::(?:[0-3]:)?|[^:\\/]+:)(?![\\/])/, '') : cand, process.platform, bases);
          if (w && !/^[a-z][a-z0-9+.-]*:\/\//i.test(cand)) return `this command has a path argument with ${w}, which is not allowed.`;
        }
        if (/\\/.test(cand) && (/^~/.test(cand) || cand.includes('/'))) return 'this command has a path argument with a backslash escape in a POSIX-style path, which cannot be checked safely; it is not allowed.';
        for (const abs of resolvePathArgForms(cand, vcwd, userHome, opts.msys)) {
          if (isCredentialPath(abs, userHome)) return 'this command reads or writes a credential path, which is not allowed.';
          if (isUnder(abs, stateHome)) return 'this command touches the router state folder (~/.agentic-router), which is not allowed.';
          if (Array.isArray(opts.denyExec) && opts.denyExec.some(d => isUnder(abs, d)))
            return 'this command touches the router proxy binaries, which is not allowed.';
          // A build, test or install command can write where its arguments point (-o, --outDir, --write,
          // --target-dir, a report file, …). No list of such options would be complete, so for these commands
          // any argument inside a protected place is refused: .git (hooks run at the next commit), CI
          // configuration, .claude, the project's router policy.
          if (!READ_ONLY_COMMANDS.has(cmd0) && opts.root) {
            for (const { rel, outsideRepo } of relForms(opts.root, abs)) {
              if (rel && !outsideRepo && !isEnvTemplate(rel)
                // the path itself, or a directory whose content is protected (--outDir .claude)
                && [rel, `${rel}/x`].some(r => isProtectedPath(r, ['.git', '**/.git']) || isNeverGrantable(r)))
                return `this command names ${rel}, a protected path (CI config, .git, .claude, …), and ${cmd0} can write files; it is not allowed.`;
            }
          }
        }
      }
    }
    return null;
  };

  let vcwd = baseCwd;                                       // virtual cwd, advanced by `cd` within the chain
  for (const words of commands) {
    if (words.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return DENY_NOT_ALLOWED;   // leading VAR=value
    if (/[\\/]/.test(stripOuterQuotes(words[0]))) return `${DENY_NOT_ALLOWED} (the command is given by a path; only bare command names are checked)`;
    const cmd0 = baseName(words[0]);
    if (WRAPPERS.has(cmd0)) return `${DENY_NOT_ALLOWED} (it starts with the wrapper "${cmd0}")`;

    if (cmd0 === 'cd') {
      // The directory is followed, so every later argument is resolved where the command will really run.
      if (words.length > 2) return 'this command has a cd with more than one argument, which cannot be checked safely; it is not allowed.';
      const target = words[1] === undefined ? '~' : words[1];
      const t = stripOuterQuotes(target);
      if (t === '-' || /[$`*?[{]/.test(t) || /^~[^/\\]/.test(t) || /['"]/.test(t)) return 'this command has a cd target that cannot be checked safely; it is not allowed.';
      const w = windowsPathProblem(t, process.platform, bases);
      if (w) return `this command has a cd target with ${w}, which is not allowed.`;
      vcwd = resolvePathArg(t, vcwd, userHome, opts.msys);
      if (credentialHit(vcwd, userHome) || credentialDirs(userHome).some(d => vcwd.toLowerCase() === d || vcwd.toLowerCase().startsWith(d + '/')))
        return 'this command changes into a credential directory, which is not allowed.';
      if (isUnder(vcwd, stateHome)) return 'this command changes into the router state folder (~/.agentic-router), which is not allowed.';
      continue;
    }

    let entry;
    if (cmd0 === 'set') {
      if (!(words.length >= 2 && /^[-+]/.test(stripOuterQuotes(words[1])))) return DENY_NOT_ALLOWED;   // bare `set` dumps env
    } else if (!(entry = allow.find(e => entryMatches(words, e)))) {
      return DENY_NOT_ALLOWED;
    }

    const sub = stripOuterQuotes(words[1] || '').toLowerCase();
    // `npm run env` (and yarn / pnpm) prints the whole environment
    if (['npm', 'pnpm', 'yarn'].includes(cmd0) && ['run', 'run-script'].includes(sub) && stripOuterQuotes(words[2] || '').toLowerCase() === 'env')
      return 'this command prints the environment (run env), which is not allowed.';

    // every argument, and the value of every --opt=value, as a possible path
    for (let i = 1; i < words.length; i++) {
      const raw = words[i];
      const bare = stripOuterQuotes(raw);
      const value = bare.startsWith('-') ? (bare.includes('=') ? bare.slice(bare.indexOf('=') + 1) : null) : raw;
      if (value === null) {
        // -f.env, -F/path/to/file: the value of a short option written without a space. Where it begins is
        // not known, so every tail of the word that looks like a path is checked.
        if (/^-[^-]/.test(bare)) {
          for (let k = 2; k < bare.length; k++) {
            const tail = bare.slice(k);
            if (!/^[.~\\/]|^[A-Za-z]:[\\/]/.test(tail)) continue;
            const reason = checkArg(cmd0, tail, vcwd);
            if (reason) return reason;
          }
        }
        continue;
      }
      if (value === '') continue;
      const reason = checkArg(cmd0, value, vcwd);
      if (reason) return reason;
    }
    if (cmd0 === 'git' && words.slice(1).some(w => { const t = stripOuterQuotes(w); return t === '-c' || /^-c[^=\s]+=/.test(t); })) return 'git -c is not allowed (it can run arbitrary config or hooks).';
    // git's own options (before the subcommand) that point it at another repository or program directory.
    // After the subcommand the same words are something else: `git rev-parse --git-dir` only prints a path.
    if (cmd0 === 'git') {
      for (let i = 1; i < words.length; i++) {
        const t = stripOuterQuotes(words[i]);
        if (!t.startsWith('-')) break;                        // the subcommand
        if (/^--(?:exec-path|git-dir|work-tree|namespace)(?:=|$)/.test(t)) return 'git --git-dir / --work-tree / --exec-path are not allowed.';
        if (t === '-C' || t === '-c') i++;                    // these take a value
      }
    }

    // dangerous options on otherwise-allowed commands (run a program, write a file, or read hidden files)
    const key = `${cmd0} ${sub}`;
    const denied = [...(ROUTER_BASH_DENY_OPTIONS[key] || ROUTER_BASH_DENY_OPTIONS[cmd0] || []), ...(GUARD_EXTRA_DENY_OPTIONS[key] || GUARD_EXTRA_DENY_OPTIONS[cmd0] || [])];
    if (denied.length) {
      for (let i = 1; i < words.length; i++) {
        const tok = stripOuterQuotes(words[i]);
        if (tok === '--') break;                              // what follows is not an option
        if (deniedOption(tok, denied))
          return `this command uses the option ${tok} (${cmd0}${sub ? ' ' + sub : ''}), which runs a program, writes a file or reads files it should not, and is not allowed.`;
      }
    }
    if (cmd0 === 'git' && sub === 'commit') {
      const has = words.slice(2).some(w => /^--(?:message|file|reuse-message|fixup|squash)(?:=|$)/.test(w) || /^-[A-Za-z]*[mFC]/.test(w));
      if (!has) return 'this git commit has no message on the command line (-m), so it would open an editor; it is not allowed.';
    }
    // `git branch` is allowed for --show-current only; anything more (-d, -m, --edit-description) changes branches
    if (cmd0 === 'git' && sub === 'branch' && words.length > 3) return 'git branch is allowed only as `git branch --show-current`.';
    if (cmd0 === 'git' && sub === 'add') {
      // `git add -A`, `git add .`, `git add <dir>`: whatever lies below is staged, and `git diff --cached` then shows it
      const rest = words.slice(2);
      const all = rest.some(w => w === '-A' || w === '--all' || w === '--no-ignore-removal' || /^-[A-Za-z]*A/.test(w));
      const dirs = rest.filter(w => !w.startsWith('-')).map(w => resolvePathArg(w, vcwd, userHome, opts.msys))
        .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
      if (all && !dirs.length) dirs.push(opts.root ?? vcwd);
      for (const d of dirs) {
        const open = unignoredCredentialFiles(d);
        if (open.length) return `this git add would stage ${open.slice(0, 3).join(', ')}, a credential file that git does not ignore; add the files by name, or add it to .gitignore.`;
      }
    }
    // commands that write to a second positional argument (e.g. `uniq IN OUT` writes OUT)
    if (cmd0 === 'uniq') {
      const positionals = words.slice(1).filter(w => !w.startsWith('-'));
      if (positionals.length >= 2) return 'this command writes to an output file argument, which is not allowed.';
    }
    // a recursive grep opens every file below its start, dotfiles included
    if (cmd0 === 'grep' && words.slice(1).some(w => { const t = stripOuterQuotes(w); return /^--(?:rec|dereference-rec|dir)/.test(t) || (/^-[A-Za-z]+/.test(t) && /[rRd]/.test(t.replace(/^-/, '').replace(/[^A-Za-z].*$/, ''))); })) {
      const dirs = words.slice(2).map(w => stripOuterQuotes(w)).filter(w => !w.startsWith('-') && !GLOB_CHARS.test(w)).map(w => resolvePathArg(w, vcwd, userHome, opts.msys))
        .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
      if ((dirs.length ? dirs : [vcwd]).some(dirHoldsCredentialFile))
        return 'this recursive grep would read a credential file (.env, .npmrc, …) under its start directory; use rg or the Grep tool, which skip hidden files, or name the files.';
    }
    // installs: registry names only
    const install = PACKAGE_INSTALL_PREFIXES.find(p => entry && entry.trim().toLowerCase() === p.trim().toLowerCase());
    if (install) {
      const tool = /pip|uv|poetry/.test(install) ? 'pip' : 'npm';
      const skip = install.trim().split(/\s+/).length;
      for (let i = skip; i < words.length; i++) {
        const tok = stripOuterQuotes(words[i]);
        if (tok.startsWith('-')) {
          if (/=.*(?::\/\/|^git[+@])/i.test(tok)) return `this install uses a package source that is not a registry name (${tok.slice(0, 60)}), which is not allowed.`;
          continue;
        }
        if (i > 0 && /^(?:-r|--requirement|-c|--constraint|-e|--editable|--prefix|-C)$/.test(stripOuterQuotes(words[i - 1]))) continue;   // a file or directory, already checked as a path
        const problem = installArgProblem(tool, tok);
        if (problem) return `this install uses ${problem}, which is not allowed.`;
      }
    }
  }
  return null;
}

/** The directories in which a command runs a package script or an install (npm / pnpm / yarn), following `cd`. */
function packageScriptDirs(command, cwd, userHome) {
  const dirs = [];
  let vcwd = cwd;
  for (const w of lexBash(String(command)).commands) {
    if (!w.length) continue;
    const c = baseName(w[0]);
    if (c === 'cd') { const t = stripOuterQuotes(w[1] ?? '~'); if (!/[$`*?[{'"]/.test(t) && t !== '-') vcwd = resolvePathArg(t, vcwd, userHome); continue; }
    if (['npm', 'pnpm', 'yarn'].includes(c) && ['test', 'run', 'run-script', 'install', 'i', 'ci', 'add', 't'].includes(stripOuterQuotes(w[1] || '').toLowerCase())) dirs.push(vcwd);
  }
  return dirs;
}

// ---------------------------------------------------------------- write-scope decision (pure)
/**
 * Scope glob dialect (decision 94, shared table core/test/fixtures/scope-glob-cases.json):
 * paths are repo-relative; a plain dir / trailing `/` / `/**` all mean the whole subtree;
 * `*`/`?` are globs. Case sensitivity follows the FILE SYSTEM — case-insensitive on win32/darwin,
 * case-sensitive on linux — so a scope never widens past what the OS would match.
 */
export function inScope(rel, allowed, platform = process.platform) {
  const nocase = platform !== 'linux';
  const r0 = normRel(rel);
  const r = nocase ? r0.toLowerCase() : r0;
  for (const g of allowed) {
    const e = normRel(g).replace(/\/+$/, '');
    const ec = nocase ? e.toLowerCase() : e;
    if (/[*?]/.test(e)) {
      if (globToRegExp(e, nocase).test(r0)) return true;
      const prefix = ec.replace(/\/\*\*$/, '');
      if (prefix !== ec && (r === prefix || r.startsWith(prefix + '/'))) return true;
    } else if (r === ec || r.startsWith(ec + '/')) return true;
  }
  return false;
}

/** Protected-write match. ALWAYS case-insensitive (deny more, never less), on every platform. */
export function isProtectedPath(rel, extraProtected = []) {
  const r = normRel(rel);
  return [...PROTECTED_WRITE_PATHS, ...extraProtected].some(p => globToRegExp(normRel(p), true).test(r));
}

/** A protected path a user grant can NEVER open (.git, .agentic-router). Credential paths are refused on
 *  their own before decideWrite. ALWAYS case-insensitive. */
export function isNeverGrantable(rel) {
  const r = normRel(rel);
  return NEVER_GRANTABLE_WRITE_PATHS.some(p => globToRegExp(normRel(p), true).test(r));
}

export function decideWrite(a) {
  // A user-granted scope (decision 129) opens a protected or out-of-scope path - never .git/.agentic-router.
  // evaluate() calls this for the path as written and for the path with links resolved; both must pass.
  const granted = Array.isArray(a.protectedGranted) && a.protectedGranted.length > 0;
  const grantCovers = (rel) => granted && !isNeverGrantable(rel) && matchesAny(rel, a.protectedGranted, a.userHome ?? os.homedir());
  if (!a.outsideRepo && isProtectedPath(a.rel, a.extraProtected || [])) {
    if (grantCovers(a.rel)) return null;
    return `${a.rel} is a protected path (.env, CI config, .claude, .git, .agentic-router, …) and needs user confirmation; add it to your report's "scope request" line instead of editing it`;
  }
  if (a.outsideRepo)
    return 'writing outside the repository root is not allowed; stay within your worktree';
  if (grantCovers(a.rel)) return null;
  if (a.allowed && !a.unscoped && !inScope(a.rel, a.allowed, a.platform ?? process.platform))
    return `${a.rel} is outside your allowed paths (${a.allowed.join(', ')}); add it to your report's "scope request" line instead of editing it`;
  return null;
}

// ---------------------------------------------------------------- scope lookup (filesystem)
/** Reads the daemon's agents/<agentId>.json (bound agent record), or null. */
function readAgentRecord(hookInput, home) {
  const agentId = hookInput.agent_id;
  if (!agentId) return null;
  try { return JSON.parse(fs.readFileSync(path.join(home, 'agents', `${safeName(agentId)}.json`), 'utf8')); }
  catch { return null; }   // not bound yet
}
/** The [subtask:<ID>] tag read ONLY from the subagent's own transcript (spec 3.4). */
function tagFromTranscript(hookInput) {
  const agentId = hookInput.agent_id, tp = hookInput.transcript_path;
  if (agentId && typeof tp === 'string') {
    const sub = path.join(tp.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
    try {
      const m = fs.readFileSync(sub, 'utf8').match(/\[subtask:([A-Za-z0-9_-]+)\]/);
      if (m) return m[1];
    } catch { /* transcript not written yet */ }
  }
  return null;
}
/** The subtask id: the daemon's bound record first, else the transcript tag (pre-pairing fallback). */
export function resolveSubtaskId(hookInput, home) {
  const rec = readAgentRecord(hookInput, home);
  if (rec && typeof rec.subtaskId === 'string') return rec.subtaskId;
  return tagFromTranscript(hookInput);
}
function normalizeScope(s, confirmed) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.allowed)) throw new Error('scope record without an allowed list');   // -> fail-closed deny
  return {
    allowed: s.allowed,
    unscoped: s.unscoped === true,
    extraProtected: Array.isArray(s.protected) ? s.protected : [],
    protectedGranted: Array.isArray(s.protectedGranted) ? s.protectedGranted : [],   // decision 129 grants
    confirmed,                       // true when a real scope record/file was read
  };
}
/** scopes/<scopeKey(session,subtask)>.json: present => confirmed; missing => unconfirmed (writes are then denied); corrupt => throw. */
function scopeFromFile(sessionId, subtaskId, home) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'scopes', `${scopeKey(sessionId, subtaskId)}.json`), 'utf8'); }
  catch { return { allowed: null, unscoped: true, extraProtected: [], protectedGranted: [], confirmed: false }; }   // missing: no record
  return normalizeScope(JSON.parse(text), true);                           // corrupt: throw -> fail-closed deny
}
/**
 * The subagent's write scope. Once the daemon binds the agent it embeds the scope in
 * agents/<agentId>.json (audit #10). That record carries `pairing`:
 *   - "confirmed" (or absent): the pair was verified (PostToolUse/tag), so the embedded scope is authoritative.
 *   - "order": paired only by start order, which foreground order-reversal can get wrong. If the subagent's
 *     own transcript tag disagrees with the record's subtaskId, the pairing is wrong — use the TAG's scope
 *     file instead (the daemon rewrites the record to "confirmed" once it fixes the pair).
 * Before any binding, fall back to the transcript tag -> scopes/<scopeKey>.json.
 */
export function loadScope(hookInput, home) {
  const rec = readAgentRecord(hookInput, home);
  if (rec && rec.scope && typeof rec.scope === 'object') {
    if (rec.pairing === 'order' && typeof hookInput.session_id === 'string') {
      const tag = tagFromTranscript(hookInput);
      if (tag && tag !== rec.subtaskId) return scopeFromFile(hookInput.session_id, tag, home);   // order pairing wrong: trust the tag
    }
    return normalizeScope(rec.scope, true);
  }
  const subtaskId = resolveSubtaskId(hookInput, home);
  if (!subtaskId || typeof hookInput.session_id !== 'string')
    return { allowed: null, unscoped: true, extraProtected: [], protectedGranted: [], confirmed: false };
  return scopeFromFile(hookInput.session_id, subtaskId, home);
}

/** Repo root for scope checks: the git top-level of cwd, else cwd (audit #15). */
function gitRoot(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* git missing or not a repo */ }
  return cwd;
}

// ---------------------------------------------------------------- project policy, honoured only once accepted (decision 142)
//
// <repo>/.agentic-router/policy.json can widen the Bash allowlist (bashAllow) and name environment variables
// to forward to verify (verifyEnv). A repository the user cloned must not be able to do that for itself, so
// the file counts only after the user accepted it: its hash is recorded in the router home, per repository,
// and a changed file is ignored until it is accepted again. Workers cannot write either file (the policy
// folder and the router home are both off-limits to them).
export const POLICY_FILE = path.join('.agentic-router', 'policy.json');
export const POLICY_ACCEPT_FILE = 'policy-accepted.json';

function policyKey(root) {
  const forms = canonicalForms(root);
  const real = forms[forms.length - 1];
  return process.platform === 'linux' ? real : real.toLowerCase();
}
function readAccepted(stateHome) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateHome, POLICY_ACCEPT_FILE), 'utf8'));
    return j && typeof j === 'object' && j.roots && typeof j.roots === 'object' ? j.roots : {};
  } catch { return {}; }
}
/**
 * The project policy of a repository and whether the user accepted this exact content.
 * { present, valid, hash, accepted, acceptedHash, policy: { bashAllow, verifyEnv } } - `policy` is the file's
 * content whether accepted or not (for doctor to show); use readAcceptedPolicy to act on it.
 */
export function policyStatus(root, stateHome = routerHome()) {
  let text;
  try { text = fs.readFileSync(path.join(root, POLICY_FILE)); } catch { return { present: false, valid: false, hash: null, accepted: false, acceptedHash: null, policy: null }; }
  const hash = createHash('sha256').update(text).digest('hex');
  const acceptedHash = readAccepted(stateHome)[policyKey(root)]?.hash ?? null;
  let policy = null;
  try {
    const j = JSON.parse(text.toString('utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 200).slice(0, 100) : []);
      policy = { bashAllow: list(j.bashAllow), verifyEnv: list(j.verifyEnv) };
    }
  } catch { /* not JSON: present but not valid */ }
  return { present: true, valid: policy !== null, hash, accepted: policy !== null && acceptedHash === hash, acceptedHash, policy };
}
/** The project policy when the user accepted its current content; null otherwise (absent, invalid, new or changed). */
export function readAcceptedPolicy(root, stateHome = routerHome()) {
  const s = policyStatus(root, stateHome);
  return s.accepted ? s.policy : null;
}
/**
 * Records the user's acceptance of the policy file. For the CLI, after it showed the user the content:
 * pass the hash of what was shown as `expectedHash`, so that only that content can be accepted.
 */
export function acceptPolicy(root, stateHome = routerHome(), now = new Date(), expectedHash = undefined) {
  const s = policyStatus(root, stateHome);
  if (!s.present || !s.valid) return s;
  // The caller showed the user a policy and passes that policy's hash: a file that changed while the
  // question was open is not what the user agreed to, and is not recorded.
  if (expectedHash !== undefined && s.hash !== expectedHash) return { ...s, accepted: false, changed: true };
  const roots = readAccepted(stateHome);
  roots[policyKey(root)] = { hash: s.hash, acceptedAt: now.toISOString() };
  fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const file = path.join(stateHome, POLICY_ACCEPT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, roots }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return policyStatus(root, stateHome);
}
/** The accepted verifyEnv names of the project that contains `dir` (for the relay); [] unless the policy is accepted. */
export function acceptedVerifyEnvNames(dir = process.env.CLAUDE_PROJECT_DIR || process.cwd(), stateHome = routerHome()) {
  return readAcceptedPolicy(gitRoot(dir), stateHome)?.verifyEnv ?? [];
}
/** The repository root the policy is keyed by (git top-level of `dir`, else `dir`). For the CLI and doctor. */
export function policyRoot(dir) { return gitRoot(dir); }
/** Takes an acceptance back (the policy is ignored again). */
export function revokePolicy(root, stateHome = routerHome()) {
  const roots = readAccepted(stateHome);
  if (!(policyKey(root) in roots)) return false;
  delete roots[policyKey(root)];
  const file = path.join(stateHome, POLICY_ACCEPT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, roots }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/** True when the "scripts" of the package.json in `dir` differ from HEAD (audit #5), or the file is new. */
function packageScriptsChanged(root, dir = root) {
  try {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) return false;
    const inRepo = relForms(root, file)[0];
    if (!inRepo || inRepo.outsideRepo) return false;
    const rel = inRepo.rel;
    const wt = JSON.parse(fs.readFileSync(file, 'utf8'));
    const show = spawnSync('git', ['-C', root, 'show', `HEAD:${rel}`], { encoding: 'utf8', timeout: 2000 });
    if (show.status !== 0) return Object.keys(wt.scripts ?? {}).length > 0 && fs.existsSync(path.join(root, '.git'));   // not in HEAD: a new file with scripts
    const headScripts = JSON.stringify((JSON.parse(show.stdout) || {}).scripts ?? {});
    return headScripts !== JSON.stringify(wt.scripts ?? {});
  } catch { return false; }
}

// ---------------------------------------------------------------- top-level evaluation
function targetPaths(input) {
  const out = [];
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof input[k] === 'string') out.push(input[k]);
  if (Array.isArray(input.edits)) for (const e of input.edits) if (e && typeof e.file_path === 'string') out.push(e.file_path);
  return out;
}

/** Files a subtask without a [scope: ...] line may still not write: they change how the agent or the repository's hooks run. */
export const UNSCOPED_PROTECTED_PATHS = [
  '.mcp.json', '**/.mcp.json', '.husky/**', '**/.husky/**', 'CLAUDE.md', '**/CLAUDE.md', 'CLAUDE.local.md', '**/CLAUDE.local.md',
  '.git', '**/.git', '.gitmodules', '.gitattributes', '**/.gitattributes', '.pre-commit-config.yaml',
];

/** A repo-relative path for each canonical form of `p`: as written, and with links resolved. */
function relForms(root, p) {
  const roots = canonicalForms(root);
  const forms = canonicalForms(p);
  const out = [];
  const add = (r, f) => {
    const relRaw = path.relative(r, f);
    const rel = toPosix(relRaw);
    if (out.some(x => x.rel === rel)) return;
    out.push({ rel, outsideRepo: rel === '' ? false : (rel.startsWith('..') || path.isAbsolute(relRaw) || /^[A-Za-z]:/.test(rel)) });
  };
  // Where the write lands: the path with links resolved, against the repository with links resolved.
  add(roots[roots.length - 1], forms[forms.length - 1]);
  // The path as written, against whichever spelling of the repository it uses (the project may be open
  // through a link: /tmp/x is /private/tmp/x on macOS). Written through some other link into the
  // repository, it has no repo-relative spelling of its own; the resolved form above is what counts then.
  if (forms[0] !== forms[forms.length - 1]) {
    const lex = fsCase(forms[0]);
    const r = roots.find(b => lex === fsCase(b) || lex.startsWith(fsCase(b).replace(/\/+$/, '') + '/'));
    if (r) add(r, forms[0]);
  }
  return out;
}

/**
 * A file tool was given a Git Bash path (/tmp/..., /usr/...). The tool would read it as a Windows path and
 * open another file than the one meant, so it is refused, with the path to use instead.
 */
function msysPathHint(p, msys) {
  if (typeof p !== 'string' || !isMsysOnlyPath(p)) return null;
  // A rooted path without a drive is also a valid Windows path (the root of the current drive). It is taken
  // for a Git Bash path only when that reading names something that is there (the file, or the directory a
  // new file would go into) and the Windows reading does not.
  const meant = msysPathForms(toPosix(p), msys)[0];
  const there = q => { try { return fs.existsSync(q); } catch { return false; } };
  if (!meant || there(path.resolve(p)) || !(there(meant) || there(path.dirname(meant)))) return null;
  return `[router] blocked: ${toPosix(p)} is a Git Bash path; Read, Edit, Write, Grep and Glob take Windows paths. Use ${meant} (or a path relative to the working directory).`;
}

export function evaluate(hookInput, opts = {}) {
  // userHome (base for '~' in CREDENTIAL_PATHS) and the router state folder are DIFFERENT dirs;
  // conflating them was a real bug (~/.ssh became ~/.agentic-router/.ssh). opts.home is a test alias for both.
  const userHome = opts.userHome ?? opts.home ?? os.homedir();
  const stateHome = opts.routerHome ?? opts.home ?? routerHome();
  const at = typeof hookInput.agent_type === 'string' ? hookInput.agent_type : '';
  if (!at.startsWith(ROUTER_AGENT_PREFIX)) return null;      // main session & non-router agents: unrestricted

  const tool = hookInput.tool_name || '';
  const input = (hookInput.tool_input && typeof hookInput.tool_input === 'object') ? hookInput.tool_input : {};

  // Router MCP tools are lead-only; a router subagent must never call them (decision 127). The daemon
  // also denies these from a subagent, but this is the local defence when the daemon is down.
  if (isRouterToolName(tool)) return { deny: '[router] blocked: router MCP tools are for the lead only; a subagent may not call them.' };

  // D7 (decision 102): router workers use Bash only; a PowerShell/pwsh tool call is always refused.
  if (tool === 'PowerShell' || tool === 'Pwsh') return { deny: '[router] blocked: router workers use Bash only, not PowerShell.' };

  const cwd = typeof hookInput.cwd === 'string' ? hookInput.cwd : process.cwd();
  const root = gitRoot(cwd);
  const proxyBinDir = path.join(root, 'packages', 'proxy', 'bin');   // subagents may not run the proxy (decision 130)
  const bases = trustedBases(cwd, root, userHome, stateHome);

  if (tool === 'Bash') {
    const command = input.command || '';
    const policy = readAcceptedPolicy(root, stateHome);       // decision 142: a project policy counts only once the user accepted it
    const reason = classifyBash(command, { userHome, routerHome: stateHome, bashAllow: policy?.bashAllow ?? [], cwd, root, denyExec: [proxyBinDir] });
    if (reason) return { deny: `[router] ${reason}` };
    const scriptDirs = packageScriptDirs(command, cwd, userHome);
    if (scriptDirs.length && [root, ...scriptDirs].some(d => packageScriptsChanged(root, d)))
      return { deny: '[router] package.json scripts changed from HEAD; the lead or user must confirm before running npm/pnpm/yarn scripts or installs.' };
    // Decision 142: the guard never answers "allow" for Bash. Nothing recognised as bad was found, which is
    // not the same as safe: Claude Code's own permission rules decide whether the command runs or the user is asked.
    return null;
  }

  if (READ_TOOLS.has(tool)) {
    const targets = targetPaths(input);
    for (const p of targets) {
      const m = msysPathHint(p, opts.msys);
      if (m) return { deny: m };
      const w = windowsPathProblem(p, process.platform, bases);
      if (w) return { deny: `[router] blocked: ${toPosix(p)} is written with ${w}, which is not allowed.` };
    }
    if (tool === 'Grep' || tool === 'Glob') {
      const searchRoot = typeof input.path === 'string' ? input.path : (typeof input.file_path === 'string' ? input.file_path : null);
      if (searchRoot && overlapsCredential(searchRoot, userHome))
        return { deny: `[router] blocked: a ${tool} rooted at ${toPosix(searchRoot)} would reach a credential path.` };
      // a search aimed at credential files by its glob (Grep `glob`, Glob `pattern`), whatever the root
      for (const g of [input.glob, tool === 'Glob' ? input.pattern : undefined]) {
        if (typeof g !== 'string') continue;
        const alts = expandBraces(g);
        if (alts === null) return { deny: `[router] blocked: this ${tool} uses ${TOO_MANY_BRACES}.` };
        const named = alts.map(sensitiveSegment).find(Boolean);
        if (named) return { deny: `[router] blocked: this ${tool} uses ${named}; credential files may not be searched or listed.` };
      }
    }
    for (const p of targets)
      if (credentialHit(p, userHome))
        return { deny: `[router] blocked: ${toPosix(p)} is a credential path and may not be read.` };
    // A Grep over a directory that names no files opens whatever lies below it, hidden files included, except
    // what git ignores. With a credential file there that git does not ignore, it is denied; without one the
    // guard says nothing (the walk is bounded, so it does not vouch for the directory).
    if (tool === 'Grep' && !narrowingGlob(input.glob) && typeof input.type !== 'string') {
      const dir = typeof input.path === 'string' && input.path !== '' ? (path.isAbsolute(input.path) ? input.path : path.resolve(cwd, input.path)) : cwd;
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* not there: nothing to open */ }
      if (isDir) {
        if (isUnder(dir, stateHome)) return { deny: `[router] blocked: ${toPosix(dir)} is inside the router state folder and may not be searched.` };
        const open = unignoredCredentialFiles(dir);
        if (open.length)
          return { deny: `[router] blocked: this Grep would read ${open.slice(0, 3).join(', ')}${open.length > 3 ? ', …' : ''} below ${toPosix(dir)}: a credential file that git does not ignore. Add a glob or a type (for example glob "*.ts"), search a subdirectory, or name the files.` };
        return null;
      }
    }
    // The router state folder holds the local token and the proxy token (decision 130); off-limits to subagents.
    for (const p of targets)
      if (isUnder(p, stateHome))
        return { deny: `[router] blocked: ${toPosix(p)} is inside the router state folder (incl. proxy-token) and may not be read.` };
    // D1 detail: allow (skip the prompt) only when every target is inside the repo in every form (a link that
    // leaves the repository is not "inside"); an out-of-repo read is left to Claude Code's normal confirmation.
    return targets.every(p => allFormsUnder(p, root)) ? { allow: '[router] checked: in-repo, not a credential path' } : null;
  }

  if (WRITE_TOOLS.has(tool)) {
    const targets = targetPaths(input);
    if (!targets.length) return { deny: '[router] blocked: this write names no file the router can check.' };
    const scope = loadScope(hookInput, stateHome);
    // Fail-closed (decision 142): without a scope record nothing may be written. The record is there before
    // the subagent's first call when the daemon runs; without the daemon a router worker cannot write.
    if (!scope.confirmed)
      return { deny: '[router] blocked: the router has no scope record for this subagent, so no file may be written. Is the router daemon running (agentic-router status)? Report this instead of retrying.' };
    // `.git` as a FILE (a worktree or submodule pointer) redirects git; the mirrored list only has `.git/**`
    const extraProtected = [...scope.extraProtected, '.git', '**/.git', ...(scope.unscoped ? UNSCOPED_PROTECTED_PATHS : [])];
    for (const p of targets) {
      const m = msysPathHint(p, opts.msys);
      if (m) return { deny: m };
      const w = windowsPathProblem(p, process.platform, bases);
      if (w) return { deny: `[router] blocked: ${toPosix(p)} is written with ${w}, which is not allowed.` };
      if (credentialHit(p, userHome))
        return { deny: `[router] blocked: ${toPosix(p)} is a credential path and may not be written.` };
      if (isUnder(p, stateHome))
        return { deny: `[router] blocked: ${toPosix(p)} is inside the router state folder and may not be written.` };
      // Both forms must pass: the path as written, and the path with links resolved (a link inside the scope
      // that points at a protected directory, or out of the repository, is where the write really lands).
      for (const { rel, outsideRepo } of relForms(root, p)) {
        const reason = decideWrite({ rel, outsideRepo, allowed: scope.allowed, unscoped: scope.unscoped, extraProtected, protectedGranted: scope.protectedGranted, userHome });
        if (reason) return { deny: `[router] ${reason}` };
      }
    }
    return { allow: '[router] checked: within the write scope' };   // D1: a confirmed scope, every form inside it
  }

  return null;   // other tools pass
}

// ---------------------------------------------------------------- hook I/O
function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
}
function emitDeny(reason) { emit('deny', reason); }

/** True only for a well-formed hook input whose agent_type marks one of this plugin's subagents. */
export function isRouterSubagent(input) {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && typeof input.agent_type === 'string' && input.agent_type.startsWith(ROUTER_AGENT_PREFIX);
}

export function runGuard(raw) {
  let input;
  try { input = JSON.parse(raw); } catch {
    emitDeny('[router] guard could not parse the hook input.');
    return;
  }
  // Gate FIRST: anything that is not a router subagent passes untouched. A bug below cannot block a user's work.
  if (!isRouterSubagent(input)) return;
  // Fail-closed applies ONLY to router subagents.
  let decision;
  try { decision = evaluate(input); }
  catch { emitDeny('[router] guard could not evaluate this call; blocking it for safety. Report the problem if it persists.'); return; }
  if (!decision) return;                                    // silent: Claude Code's normal permission flow
  if (decision.deny) emitDeny(decision.deny);
  else if (decision.allow) emit('allow', decision.allow);   // D1: verified router-worker call -> skip the prompt
}

/** True when this file is the process entry point, comparing REAL paths so a junction/symlink/npm-link
 *  spelling of the plugin dir still runs the hook (audit E1: a mismatched spelling skipped the guard). */
function isMain() {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const real = p => { try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return path.resolve(p); } };
    return real(argv1) === real(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { data += d; });
  process.stdin.on('end', () => { runGuard(data); process.exit(0); });
}
