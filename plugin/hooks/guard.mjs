#!/usr/bin/env node
// agentic-router guard: PreToolUse hook, registered with onFailure:"block" (fail-closed).
// Dependency-free single file (marketplace installs have no node_modules, decision 55).
//
// Applies ONLY to this plugin's subagents (agent_type "agentic-router:*"); the main session
// and every other agent pass untouched. Works without the daemon: the daemon writes
// agents/<agentId>.json and scopes/<key>.json locally, and the guard reads those files.
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
  '~/.gem/credentials', '~/.terraform.d/credentials.tfrc.json', '**/.env', '**/.env.*',
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
/** Lexical + realpath canonical forms (POSIX slashes). Both are checked so `..`, UNC, /c/, and symlinks are all covered. */
function canonicalForms(p) {
  let s = stripExtended(String(p));
  s = uncToDrive(s);
  s = cygToDrive(s);
  s = gitBashToDrive(s);
  const lexNative = path.resolve(s);                    // absolute, `.`/`..` collapsed
  let realNative;
  try { realNative = realpathNearest(lexNative); } catch { realNative = lexNative; }
  const lex = toPosix(lexNative), real = toPosix(realNative);
  return lex === real ? [lex] : [lex, real];
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
  return patterns.some(p => {
    const re = globToRegExp(toPosix(expandHome(p, userHome)));
    return forms.some(f => re.test(f));
  });
}

/** Fixed (glob-free) base dir of each `~`-rooted credential pattern — for Grep/Glob containment. */
function credentialDirs(userHome) {
  const out = [];
  for (const pat of CREDENTIAL_PATHS) {
    if (!pat.startsWith('~/')) continue;
    const base = pat.replace(/\/\*.*$/, '');                 // strip the first glob segment onward
    out.push(toPosix(expandHome(base, userHome)).toLowerCase().replace(/\/+$/, ''));
  }
  return out;
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
  const base = canonicalForms(dir)[0].toLowerCase().replace(/\/+$/, '');
  return canonicalForms(p).some(form => {
    const c = form.toLowerCase().replace(/\/+$/, '');
    return c === base || c.startsWith(base + '/');
  });
}

// ---------------------------------------------------------------- Bash allowlist (decision 90)
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'xargs', 'time', 'nohup', 'command']);
const SECRET_VAR_RE = /(?:\$\{?|\$env:|%)[A-Za-z0-9_]*(?:ANTHROPIC|API[_-]?KEY|TOKEN|SECRET)[A-Za-z0-9_]*\}?/i;

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
 */
function lexBash(cmd) {
  const commands = [];
  let tokens = [], cur = '', refuse = null;
  const pushTok = () => { if (cur !== '') { tokens.push(cur); cur = ''; } };
  const endCmd = () => { pushTok(); if (tokens.length) commands.push(tokens); tokens = []; };
  const n = cmd.length;
  for (let i = 0; i < n;) {
    const c = cmd[i];
    if (c === "'") { cur += c; i++; while (i < n && cmd[i] !== "'") { cur += cmd[i++]; } if (i < n) cur += cmd[i++]; continue; }
    if (c === '"') {
      cur += c; i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '`') refuse ??= 'a backtick command substitution in double quotes';
        else if (cmd[i] === '$' && cmd[i + 1] === '(') refuse ??= 'a $() command substitution in double quotes';
        else if (cmd[i] === '$' && cmd[i + 1] === '{') refuse ??= 'a ${} expansion in double quotes';
        cur += cmd[i++];
      }
      if (i < n) cur += cmd[i++];
      continue;
    }
    if (c === '\\') { cur += c; if (i + 1 < n) cur += cmd[i + 1]; i += 2; continue; }   // escape: keep both chars
    if (c === '`') { refuse ??= 'a backtick command substitution'; cur += c; i++; continue; }
    if (c === '$' && cmd[i + 1] === '(') { refuse ??= 'a $() command substitution'; cur += '$('; i += 2; continue; }
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
  return { commands, refuse };
}

/** Does one allowlist entry's words prefix-match the command's words? */
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
  return s.includes('/') || /^~/.test(raw) || /^[A-Za-z]:/.test(s)
    || /^\$\{?(HOME|USERPROFILE)\}?/i.test(raw) || /^\$env:/i.test(raw) || /^%[A-Za-z0-9_]+%/.test(raw) || raw.startsWith("$'");
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
  if (/\/proc\/[^/\s]+\/environ/.test(abs)) return true;
  return matchesPath(abs, CREDENTIAL_PATHS, userHome) || overlapsCredential(abs, userHome);
}
/** Resolves a shell path argument against the virtual cwd the way bash would (drive-normalised posix). */
function resolvePathArg(raw, vcwd, userHome) {
  const e = expandTilde(stripOuterQuotes(raw), userHome);
  const abs = path.isAbsolute(e) || /^[A-Za-z]:/.test(e) || /^[\\/]/.test(e) ? e : path.resolve(vcwd, e);
  return canonicalForms(abs)[0];
}
/** True if a Bash command reads/writes any path argument that resolves OUTSIDE the repo root (decision 96 detail). */
export function bashTouchesOutsideRepo(command, { userHome = os.homedir(), cwd = process.cwd(), root = cwd } = {}) {
  let vcwd = cwd;
  for (const words of lexBash(String(command)).commands) {
    if (words.length === 0) continue;
    if (baseName(words[0]) === 'cd') {
      const t = words[1];
      if (t && pathLikeArg(t) && !unsafePathArg(t)) vcwd = resolvePathArg(t, vcwd, userHome);
      continue;
    }
    for (let i = 1; i < words.length; i++) {
      const raw = words[i];
      if (!pathLikeArg(raw) || unsafePathArg(raw)) continue;   // unsafe args are denied elsewhere
      if (!isUnder(resolvePathArg(raw, vcwd, userHome), root)) return true;
    }
  }
  return false;
}

/**
 * Returns a deny reason for a router subagent's Bash command, or null to allow.
 * opts: { userHome, routerHome, bashAllow, cwd } (bashAllow = project policy.json extension; cwd = hook cwd).
 */
export function classifyBash(command, opts = {}) {
  const userHome = opts.userHome ?? os.homedir();
  const stateHome = opts.routerHome ?? routerHome();
  const baseCwd = opts.cwd ?? process.cwd();
  const allow = [...ROUTER_BASH_ALLOW, ...(Array.isArray(opts.bashAllow) ? opts.bashAllow : [])];

  const { commands, refuse } = lexBash(String(command));
  if (refuse) return `${DENY_NOT_ALLOWED} (it contains ${refuse})`;

  let vcwd = baseCwd;                                       // virtual cwd, advanced by `cd` within the chain
  for (const words of commands) {
    if (words.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return DENY_NOT_ALLOWED;   // leading VAR=value
    const cmd0 = baseName(words[0]);
    if (WRAPPERS.has(cmd0)) return `${DENY_NOT_ALLOWED} (it starts with the wrapper "${cmd0}")`;

    if (cmd0 === 'cd') {
      const target = words[1];
      if (target && pathLikeArg(target)) {
        const u = unsafePathArg(target);
        if (u) return `this command has a cd target with ${u}, which cannot be checked safely; it is not allowed.`;
        vcwd = resolvePathArg(target, vcwd, userHome);
      }
      continue;                                             // `cd` itself is on the allowlist implicitly
    }

    if (cmd0 === 'set') {
      if (!(words.length >= 2 && /^[-+]/.test(stripOuterQuotes(words[1])))) return DENY_NOT_ALLOWED;   // bare `set` dumps env
    } else if (!allow.some(e => entryMatches(words, e))) {
      return DENY_NOT_ALLOWED;
    }

    if (SECRET_VAR_RE.test(words.join(' '))) return 'this command references a secret environment variable, which is not allowed.';
    for (let i = 1; i < words.length; i++) {
      const raw = words[i];
      if (!pathLikeArg(raw)) continue;
      const u = unsafePathArg(raw);
      if (u) return `this command has a path argument with ${u}, which cannot be checked safely; it is not allowed.`;
      const abs = resolvePathArg(raw, vcwd, userHome);
      if (isCredentialPath(abs, userHome)) return 'this command reads or writes a credential path, which is not allowed.';
      if (isUnder(abs, stateHome)) return 'this command touches the router state folder (~/.agentic-router), which is not allowed.';
    }
    if (cmd0 === 'git' && words.includes('-c')) return 'git -c is not allowed (it can run arbitrary config or hooks).';

    // dangerous options on otherwise-allowed commands (run a program or write a file)
    const sub = stripOuterQuotes(words[1] || '').toLowerCase();
    const denied = ROUTER_BASH_DENY_OPTIONS[`${cmd0} ${sub}`] || ROUTER_BASH_DENY_OPTIONS[cmd0];
    if (denied) {
      for (let i = 1; i < words.length; i++) {
        const tok = stripOuterQuotes(words[i]);
        if (denied.some(opt => tok === opt || (opt.startsWith('--') ? tok.startsWith(opt + '=') : tok.startsWith(opt))))
          return `this command uses the option ${tok} (${cmd0}${sub ? ' ' + sub : ''}), which runs a program or writes a file and is not allowed.`;
      }
    }
    // commands that write to a second positional argument (e.g. `uniq IN OUT` writes OUT)
    if (cmd0 === 'uniq') {
      const positionals = words.slice(1).filter(w => !w.startsWith('-'));
      if (positionals.length >= 2) return 'this command writes to an output file argument, which is not allowed.';
    }
  }
  return null;
}

/** First words of each simple command runs a package script (npm/pnpm/yarn test|run). */
function runsPackageScript(command) {
  return lexBash(String(command)).commands.some(w =>
    w.length > 0 && ['npm', 'pnpm', 'yarn'].includes(baseName(w[0])) && ['test', 'run'].includes(stripOuterQuotes(w[1] || '').toLowerCase()));
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

export function decideWrite(a) {
  if (!a.outsideRepo && isProtectedPath(a.rel, a.extraProtected || []))
    return `${a.rel} is a protected path (.env, CI config, .claude, .git, .agentic-router, …) and needs user confirmation; add it to your report's "scope request" line instead of editing it`;
  if (a.outsideRepo)
    return 'writing outside the repository root is not allowed; stay within your worktree';
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
  return {
    allowed: Array.isArray(s.allowed) ? s.allowed : null,
    unscoped: s.unscoped === true || !Array.isArray(s.allowed),
    extraProtected: Array.isArray(s.protected) ? s.protected : [],
    confirmed,                       // true when a real scope record/file was read (vs fail-open)
  };
}
/** scopes/<scopeKey(session,subtask)>.json: present => confirmed; missing => fail-open; corrupt => throw. */
function scopeFromFile(sessionId, subtaskId, home) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'scopes', `${scopeKey(sessionId, subtaskId)}.json`), 'utf8'); }
  catch { return { allowed: null, unscoped: true, extraProtected: [], confirmed: false }; }   // missing: fail-open
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
    return { allowed: null, unscoped: true, extraProtected: [], confirmed: false };
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
/** Project Bash allowlist extension from <root>/.agentic-router/policy.json (a protected path). */
function projectBashAllow(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, '.agentic-router', 'policy.json'), 'utf8'));
    return Array.isArray(j.bashAllow) ? j.bashAllow.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
/** True when package.json's "scripts" differ from HEAD (audit #5). */
function packageScriptsChanged(root) {
  try {
    const show = spawnSync('git', ['-C', root, 'show', 'HEAD:package.json'], { encoding: 'utf8', timeout: 2000 });
    if (show.status !== 0) return false;
    const headScripts = JSON.stringify((JSON.parse(show.stdout) || {}).scripts ?? {});
    const wt = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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

export function evaluate(hookInput, opts = {}) {
  // userHome (base for '~' in CREDENTIAL_PATHS) and the router state folder are DIFFERENT dirs;
  // conflating them was a real bug (~/.ssh became ~/.agentic-router/.ssh). opts.home is a test alias for both.
  const userHome = opts.userHome ?? opts.home ?? os.homedir();
  const stateHome = opts.routerHome ?? opts.home ?? routerHome();
  const at = typeof hookInput.agent_type === 'string' ? hookInput.agent_type : '';
  if (!at.startsWith(ROUTER_AGENT_PREFIX)) return null;      // main session & non-router agents: unrestricted

  const tool = hookInput.tool_name || '';
  const input = (hookInput.tool_input && typeof hookInput.tool_input === 'object') ? hookInput.tool_input : {};

  // D7 (decision 102): router workers use Bash only; a PowerShell/pwsh tool call is always refused.
  if (tool === 'PowerShell' || tool === 'Pwsh') return { deny: '[router] blocked: router workers use Bash only, not PowerShell.' };

  const cwd = typeof hookInput.cwd === 'string' ? hookInput.cwd : process.cwd();
  const root = gitRoot(cwd);

  if (tool === 'Bash') {
    const command = input.command || '';
    const reason = classifyBash(command, { userHome, routerHome: stateHome, bashAllow: projectBashAllow(root), cwd });
    if (reason) return { deny: `[router] ${reason}` };
    if (runsPackageScript(command) && packageScriptsChanged(root))
      return { deny: '[router] package.json scripts changed from HEAD; the lead or user must confirm before running npm/pnpm/yarn scripts.' };
    // D1 detail (decision 96): only skip the prompt when the command stays inside the repo; a path arg
    // outside the repo is not denied, but we stay silent so Claude Code's out-of-folder confirmation runs.
    if (bashTouchesOutsideRepo(command, { userHome, cwd, root })) return null;
    return { allow: '[router] checked: Bash allowlist, args, credentials' };   // D1: verified -> skip the prompt
  }

  if (READ_TOOLS.has(tool)) {
    if (tool === 'Grep' || tool === 'Glob') {
      const searchRoot = typeof input.path === 'string' ? input.path : (typeof input.file_path === 'string' ? input.file_path : null);
      if (searchRoot && overlapsCredential(searchRoot, userHome))
        return { deny: `[router] blocked: a ${tool} rooted at ${toPosix(searchRoot)} would reach a credential path.` };
    }
    const targets = targetPaths(input);
    for (const p of targets)
      if (matchesPath(p, CREDENTIAL_PATHS, userHome))
        return { deny: `[router] blocked: ${toPosix(p)} is a credential path and may not be read.` };
    // D1 detail: allow (skip the prompt) only when every target is inside the repo; an out-of-repo read
    // (even a non-credential one, e.g. ~/Documents) is left to Claude Code's normal confirmation.
    return targets.every(p => isUnder(p, root)) ? { allow: '[router] checked: in-repo, not a credential path' } : null;
  }

  if (WRITE_TOOLS.has(tool)) {
    const scope = loadScope(hookInput, stateHome);
    for (const p of targetPaths(input)) {
      if (matchesPath(p, CREDENTIAL_PATHS, userHome))
        return { deny: `[router] blocked: ${toPosix(p)} is a credential path and may not be written.` };
      if (isUnder(p, stateHome))
        return { deny: `[router] blocked: ${toPosix(p)} is inside the router state folder and may not be written.` };
      const relRaw = path.relative(canonicalForms(root)[0], canonicalForms(p)[0]);
      const rel = toPosix(relRaw);
      const outsideRepo = rel === '' ? false : (rel.startsWith('..') || path.isAbsolute(relRaw) || /^[A-Za-z]:/.test(rel));
      const reason = decideWrite({ rel, outsideRepo, allowed: scope.allowed, unscoped: scope.unscoped, extraProtected: scope.extraProtected, userHome });
      if (reason) return { deny: `[router] ${reason}` };
    }
    // D1: allow (skip the prompt) only when the scope is CONFIRMED; on the fail-open path (no scope
    // record/file) stay silent so Claude Code's normal permission flow asks the user.
    return scope.confirmed ? { allow: '[router] checked: within the write scope' } : null;
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
