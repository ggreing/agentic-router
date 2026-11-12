// Credential and egress rules shared by the guard hooks and the daemon (spec 4.4, decisions 33-35).
import path from 'node:path';

/** Reads a subagent may never make (glob-like; `~` is the user's home, matched case-insensitively). */
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

/**
 * Credential locations that depend on the environment (env audit #8): a custom Claude config dir,
 * Windows %APPDATA% tools, and a Git Bash $HOME that differs from the OS profile (e.g. an H: home
 * drive). Callers add these to CREDENTIAL_PATHS; empty or relative values are ignored.
 */
export function envCredentialPaths(env: Record<string, string | undefined> = process.env): string[] {
  const abs = (v: string | undefined) => (v && (path.isAbsolute(v) || path.win32.isAbsolute(v)) ? v.replace(/\\/g, '/').replace(/\/+$/, '') : undefined);
  const out: string[] = [];
  const cfg = abs(env.CLAUDE_CONFIG_DIR);
  if (cfg) out.push(`${cfg}/**`);
  const appData = abs(env.APPDATA);
  if (appData) out.push(`${appData}/gcloud/**`, `${appData}/GitHub CLI/**`, `${appData}/Docker/**`);
  const home = abs(env.HOME);
  if (home) for (const p of CREDENTIAL_PATHS) if (p.startsWith('~/')) out.push(home + p.slice(1));
  return out;
}

/** Paths whose edit always needs user confirmation, even inside an allowed write scope. */
// Both root and nested forms: the session cwd can be above the repository root (audit #4).
export const PROTECTED_WRITE_PATHS = [
  '**/.env', '**/.env.*', '.claude/**', '**/.claude/**', '.github/workflows/**', '**/.github/workflows/**',
  '.gitlab-ci.yml', '**/.gitlab-ci.yml', '**/.npmrc', '.git/**', '**/.git/**',
  // project router config (verify.json, the Bash allowlist extension): a worker must not widen its own limits
  '.agentic-router/**', '**/.agentic-router/**',
];

/**
 * Paths a subtask with no [scope: ...] line may still not write even inside its scope: they change how the
 * agent or the repository's own hooks run (decision 142). Shared with the guard (mirrored copy + equality
 * test) so the daemon's stop check (verify.ts) refuses the same writes the guard does.
 */
export const UNSCOPED_PROTECTED_PATHS = [
  '.mcp.json', '**/.mcp.json', '.husky/**', '**/.husky/**', 'CLAUDE.md', '**/CLAUDE.md', 'CLAUDE.local.md', '**/CLAUDE.local.md',
  '.git', '**/.git', '.gitmodules', '.gitattributes', '**/.gitattributes', '.pre-commit-config.yaml',
];

/** Shell commands that dump the environment or read OS credential stores: always denied. */
export const ENV_DUMP_COMMANDS = ['env', 'printenv', 'set', 'export -p', 'Get-ChildItem Env:', 'gci env:', 'dir env:'];
export const KEYCHAIN_COMMANDS = ['security', 'secret-tool', 'cmdkey', 'Get-StoredCredential', 'vaultcmd'];

/** Commands that send data out. Denied by default for subagents (decision 34). */
export const NETWORK_COMMANDS = ['curl', 'wget', 'Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'irm', 'nc', 'ncat', 'netcat', 'scp', 'sftp', 'ftp', 'telnet', 'ssh'];

/**
 * Bash allowlist for router subagents (decision 90, audit #3). A command line is allowed only when
 * every simple command in it (split on && || ; | and newlines) matches one entry: the entry's
 * words must equal the command's first words (basename, `.exe` dropped); a trailing ` *` allows
 * further arguments, otherwise the entry itself allows any further arguments too. Anything that
 * cannot be split safely is refused: command substitution ($(...), backticks), process
 * substitution, subshell parentheses, output redirection other than `2>&1` / `>/dev/null` /
 * `>NUL`, leading VAR=value assignments, and wrappers (sudo, env, xargs, time, nohup, command).
 * Arguments are still checked: credential paths, the router home, secret variables ($ANTHROPIC_*,
 * $*_API_KEY, $*TOKEN*), `find -exec/-delete`, `git -c`, `sed -i`.
 * A project may extend the list in .agentic-router/policy.json { "bashAllow": [...] } (a protected path), but
 * that file counts only after the user accepts its exact content (agentic-router policy accept); until then it
 * is ignored.
 */
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

/**
 * Options that turn an allowlisted helper into a program runner or a file writer (env audit #3).
 * A command whose first words match the key is refused when any argument equals one of these or
 * starts with one followed by "=" (or, for single-letter options, is glued to its value: -Oprog).
 * `uniq` with two file operands writes the second one, so it is refused too (handled in the guard).
 */
export const ROUTER_BASH_DENY_OPTIONS: Record<string, string[]> = {
  rg: ['--pre', '--pre-glob', '--search-zip', '-z'],
  'git grep': ['-O', '--open-files-in-pager', '--ext-grep'],
  'git diff': ['--output', '--ext-diff', '--textconv'],
  'git log': ['--output', '--ext-diff', '--textconv'],
  'git show': ['--output', '--ext-diff', '--textconv'],
  'git commit': ['--no-verify', '-n'],
  sort: ['-o', '--output', '--compress-program'],
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'],
  diff: ['--to-file', '--from-file'],
  grep: ['--include-dir'],
};

/**
 * Options refused on top of ROUTER_BASH_DENY_OPTIONS (decision 142 and the checks after it): they read hidden
 * or ignored files, run a program, open an editor or an interactive mode, write outside the result, redirect a
 * package install to another registry or install outside the repository. The guard holds a mirrored copy
 * (it cannot import this package); a test asserts that the two are equal.
 */
export const GUARD_EXTRA_DENY_OPTIONS: Record<string, string[]> = {
  rg: ['--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-dot', '--no-ignore-parent', '--no-ignore-global', '--no-ignore-exclude', '--no-ignore-files', '--unrestricted', '-u', '-.', '--hostname-bin'],
  printf: ['-v'],
  'git grep': ['--no-index', '--untracked', '--no-exclude-standard', '--textconv'],
  'git diff': ['--no-index'],
  // interactive and editor modes cannot work without a terminal; --amend rewrites a commit the worker did not make
  'git add': ['-e', '--edit', '-i', '--interactive', '-p', '--patch', '--chmod'],
  'git commit': ['-e', '--edit', '--amend', '-p', '--patch', '--interactive', '--reedit-message', '--reset-author', '--no-post-rewrite'],
  // `git stash list` passes its options on to git log
  'git stash': ['--output', '--ext-diff', '--textconv'],
  sort: ['-T', '--temporary-directory'],
  diff: ['-l', '--paginate'],
  tail: ['-f', '-F', '--follow', '--retry'],
  // installs: the registry is fixed, and nothing is installed outside the repository
  'npm install': ['--registry', '-g', '--global', '--location', '--prefix', '--userconfig', '--globalconfig'], 'npm i': ['--registry', '-g', '--global', '--location', '--prefix', '--userconfig', '--globalconfig'], 'npm ci': ['--registry', '-g', '--global', '--location', '--prefix', '--userconfig', '--globalconfig'],
  'pnpm install': ['--registry', '-g', '--global', '--dir', '-C'], 'pnpm add': ['--registry', '-g', '--global', '--dir', '-C'],
  'yarn install': ['--registry', '--cwd', '--modules-folder', '--global-folder'], 'yarn add': ['--registry', '--cwd', '--modules-folder', '--global-folder'],
  'pip install': ['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--trusted-host', '-t', '--target', '--prefix', '--root', '--user'],
  'pip3 install': ['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--trusted-host', '-t', '--target', '--prefix', '--root', '--user'],
};

/** Names that are a credential store or hold one, as a single path segment: for globs, which cannot be resolved to a path. Mirrored in the guard. */
export const GUARD_SENSITIVE_SEGMENTS = [
  '.env', '.claude', '.claude.json', '.ssh', '.aws', '.azure', '.docker', '.npmrc', '.netrc', '_netrc', '.git-credentials',
  '.agentic-router', '.kube', '.gnupg', '.pgpass', '.pypirc', '.env.local', '.env.production', '.env.development', '.env.test',
];
/** Allowed commands that only read (and git, which has its own option list). Every other allowed command builds, tests or installs, and can write files. Mirrored in the guard. */
export const GUARD_READ_ONLY_COMMANDS = ['cd', 'pwd', 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'echo', 'printf', 'diff', 'sort', 'uniq', 'cut', 'tr', 'which', 'where', 'true', 'false', 'test', 'set', 'git'];
/** Commands that run another command: never allowed as the first word. Mirrored in the guard. */
export const GUARD_WRAPPER_COMMANDS = ['sudo', 'doas', 'env', 'xargs', 'time', 'nohup', 'command', 'builtin', 'exec', 'eval', 'source', '.'];
/** The only paths under /dev or /proc a worker's command may name. Mirrored in the guard. */
export const GUARD_PLAIN_DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'];

/**
 * The name fragments that mark a shell variable reference as secret-bearing ($FOO_API_KEY, %DB_PASSWORD%,
 * $env:AUTH_TOKEN): a regex alternation, shared with the guard's SECRET_VAR_RE (mirrored + equality test).
 * `API[_-]?KEY` is a sub-pattern, so this is a pattern string, not a plain word list.
 */
export const SECRET_VAR_NAME_PATTERN = 'ANTHROPIC|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|COOKIE|AUTH|DATABASE_URL|DSN';

/**
 * Environment variables the relay forwards from a router subagent's own hook environment at
 * SubagentStart, so that subagent's verify runs with the user's toolchain (decision 99, env audit #6):
 * the venv / conda / nvm / Java / Go / Rust selection of the terminal that launched Claude Code.
 * Names only; values are never logged. Secret-looking names are never forwarded even if listed.
 * A project may add names in .agentic-router/policy.json { "verifyEnv": [...] } (a protected path), but that
 * file counts only after the user accepts its exact content (agentic-router policy accept); until then it is
 * ignored.
 */
export const VERIFY_ENV_PASSTHROUGH = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PYENV_VERSION', 'PYTHONPATH', 'POETRY_ACTIVE',
  'NVM_BIN', 'NVM_DIR', 'VOLTA_HOME', 'FNM_MULTISHELL_PATH', 'NODE_PATH',
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOFLAGS', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CI',
];

/** Package installs are the one allowed form of network access. */
export const PACKAGE_INSTALL_PREFIXES = [
  'npm install', 'npm i ', 'npm ci', 'pnpm install', 'pnpm add', 'yarn install', 'yarn add',
  'pip install', 'pip3 install', 'python -m pip install', 'uv pip install', 'poetry install',
];

/**
 * Secret-masking patterns (audit A5). `lead: true` means the regex captures the part to KEEP as group 1
 * (a header/field name up to its separator, or a URL's `scheme://user:`) and only the value after it is
 * masked; the rest mask the whole match, keeping a 7-char hint. Every quantifier is bounded so masking stays
 * linear on long unbroken input (audit N6). Masking is a net, not a guarantee (see A4's field allowlist).
 *
 * The relay is dependency-free and ships the generated plugin/hooks/secret-patterns.json
 * (scripts/sync-secret-patterns.ts), which carries BOTH these text patterns and the secret-key-name rules
 * below; a test fails when the committed file is stale. For JSON, never run `redact` over a serialized
 * document (audit N1: it corrupts the document) — walk the parsed value with `redactJson` instead.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; lead?: boolean }> = [
  // vendor-prefixed tokens — mask the whole token, keep a short hint
  { re: /sk-ant-[A-Za-z0-9_-]{8,512}/g },
  { re: /\b(?:xox[baprs]-|sk-proj-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|glpat-|glrt-|npm_|hf_|github_pat_|gh[pousr]_|AIza|SG\.|ya29\.)[A-Za-z0-9_.-]{8,512}/g },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },                          // AWS access key id (long-term / temporary)
  { re: /\beyJ[\w-]{8,512}\.[\w-]{8,512}\.[\w-]{8,512}/g },          // JWT
  { re: /-----BEGIN (?:[A-Z ]{0,40} )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:[A-Z ]{0,40} )?PRIVATE KEY-----/g },  // PEM private key
  { re: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]{0,8192}?-----END PGP PRIVATE KEY BLOCK-----/g },                  // PGP private key
  { re: /\b(?:bearer|basic|token)\s+[A-Za-z0-9+/=._~-]{12,1024}/gi },  // auth-scheme values
  // URL userinfo — keep scheme://user:, mask the password up to '@' (classes bounded; N6)
  { re: /([a-z][a-z0-9+.-]{0,32}:\/\/[^\s:@/]{1,128}:)[^\s@/]{1,256}@/gi, lead: true },
  // Cookie / Set-Cookie header — keep the name, mask the value to end of line
  { re: /((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]{1,4096}/gi, lead: true },
  // JSON {"name":"...secret-ish...","value":"..."} — keep up to the value's opening quote
  { re: /("name"\s*:\s*"[^"]{0,128}(?:key|token|secret|password|passwd|credential)[^"]{0,128}"\s*,\s*"value"\s*:\s*")[^"]{0,4096}/gi, lead: true },
  // NAME ending in a secret word = "quoted value": keep the name and opening quote, mask to the closing
  // quote (N1: a value with a space is masked whole; the quote is a lookahead, so it is not consumed).
  { re: /((?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9_.-]{0,64}[_.-](?:key|token|secret|password|passwd|credential)|token|secret|password|passwd|credential)["']?\s*[:=]\s*")[^"\r\n]{0,4096}(?=")/gi, lead: true },
  { re: /((?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9_.-]{0,64}[_.-](?:key|token|secret|password|passwd|credential)|token|secret|password|passwd|credential)["']?\s*[:=]\s*')[^'\r\n]{0,4096}(?=')/gi, lead: true },
  // A secret-word name: either `token`/`secret`/`password`/`passwd`/`credential` on its own, or any name whose
  // last segment after a separator is one of those or `key`. So `password=`, `api_key=`, `--password` and
  // `AWS_SECRET_ACCESS_KEY=` match, but a bare `key` does not (prose like `primary key = id`, and `monkey`, are
  // left alone; a bare secret-word JSON key is caught by redactJson's key rule). The `(?!\[REDACTED\])` keeps
  // re-masking idempotent (so a value already `[REDACTED]` is not partly re-matched). The value stops at
  // whitespace, a quote or a JSON close.
  { re: /((?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9_.-]{0,64}[_.-](?:key|token|secret|password|passwd|credential)|token|secret|password|passwd|credential)["']?\s*[:=]\s*)(?!\[REDACTED\])[^\s"'}\]]{1,4096}/gi, lead: true },
  // legacy header/JSON credential field with an auth scheme (kept; 8+ value) for names without a secret word
  { re: /(?:authorization|x-api-key|access[-_]?token|auth[-_]?token)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?[^\s"',}]{8,1024}/gi },
  { re: /\bANTHROPIC_[A-Z_]{0,64}\s*=\s*\S{1,1024}/g },               // ANTHROPIC_API_KEY=…, ANTHROPIC_AUTH_TOKEN=…
];

/**
 * An object key whose name marks its string value as a secret, for `redactJson` (audit N1). The secret word
 * must be the WHOLE key or sit at a separator or camelCase boundary, so `api_key`, `apiKey`, `accessToken`
 * and `clientSecret` match while `totalTokens` and `monkey` do not.
 */
const SECRET_KEY_NAMES: RegExp[] = [
  /(?:^|[_\-.])(?:key|token|secret|password|passwd|credential)$/i,
  /[a-z0-9](?:Key|Token|Secret|Password|Passwd|Credential)$/,
];
function isSecretKey(name: string): boolean {
  return SECRET_KEY_NAMES.some(re => re.test(name));
}

/** Masking never scans more than this many characters of one string, so it stays bounded (audit N6). */
export const MAX_MASK_LENGTH = 1_000_000;

/** Serializable form of the text patterns and the secret-key rules for the plugin's generated copy. */
export interface SecretPatternSpec { source: string; flags: string; lead?: boolean }
export const SECRET_PATTERN_SPECS: SecretPatternSpec[] = SECRET_PATTERNS.map(p => ({ source: p.re.source, flags: p.re.flags, ...(p.lead ? { lead: true } : {}) }));
export const SECRET_KEY_NAME_SPECS: SecretPatternSpec[] = SECRET_KEY_NAMES.map(re => ({ source: re.source, flags: re.flags }));

/** Masks secrets in one text string: API keys, OAuth tokens, cookies and secret-named values. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text.length > MAX_MASK_LENGTH ? text.slice(0, MAX_MASK_LENGTH) + '…[truncated]' : text;
  for (const s of extraSecrets) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  for (const p of SECRET_PATTERNS) {
    out = p.lead
      ? out.replace(p.re, (_m: string, g1: string) => `${g1}[REDACTED]`)
      : out.replace(p.re, (m: string) => m.slice(0, 7) + '…[REDACTED]');
  }
  return out;
}

/**
 * Masks secrets in a PARSED JSON value without breaking its shape (audit N1): walks the value, masks string
 * leaves, and leaves keys, numbers, booleans and null untouched. A string under a secret-named key is
 * replaced whole; any other string is run through `redact`. Serialize the result — never `redact` the
 * serialized text. Returns a new value; the input is not mutated.
 */
export function redactJson(value: unknown, extraSecrets: string[] = []): unknown {
  const walk = (v: unknown, keyIsSecret: boolean): unknown => {
    if (typeof v === 'string') return keyIsSecret ? '[REDACTED]' : redact(v, extraSecrets);
    if (Array.isArray(v)) return v.map(x => walk(x, false));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, isSecretKey(k));
      return out;
    }
    return v;
  };
  return walk(value, false);
}
