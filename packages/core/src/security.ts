// Credential and egress rules shared by the guard hooks and the daemon (spec 4.4, decisions 33-35).
import path from 'node:path';

/** Reads a subagent may never make (glob-like; `~` is the user's home, matched case-insensitively). */
export const CREDENTIAL_PATHS = [
  '~/.claude/**', '~/.claude.json', '~/.ssh/**', '~/.aws/**', '~/.config/gcloud/**', '~/.azure/**',
  '~/.docker/config.json', '~/.npmrc', '~/.netrc', '~/_netrc', '~/.git-credentials', '~/.agentic-router/token',
  '~/.config/gh/**', '~/.kube/**', '~/.gnupg/**', '~/.pgpass', '~/.pypirc', '~/.cargo/credentials*',
  '~/.gem/credentials', '~/.terraform.d/credentials.tfrc.json',
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
 * Options refused on top of ROUTER_BASH_DENY_OPTIONS: they read hidden or ignored files, or redirect a
 * package install to another registry (decision 142). Shared with the guard (mirrored copy + equality test)
 * so the daemon's stop check applies the same rule.
 */
export const GUARD_EXTRA_DENY_OPTIONS: Record<string, string[]> = {
  rg: ['--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-dot', '--no-ignore-parent', '--no-ignore-global', '--no-ignore-exclude', '--no-ignore-files', '--unrestricted', '-u', '-.'],
  printf: ['-v'],
  'git grep': ['--no-index', '--untracked', '--no-exclude-standard'],
  'git diff': ['--no-index'],
  'npm install': ['--registry'], 'npm i': ['--registry'], 'npm ci': ['--registry'],
  'pnpm install': ['--registry'], 'pnpm add': ['--registry'], 'yarn install': ['--registry'], 'yarn add': ['--registry'],
  'pip install': ['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--trusted-host'],
  'pip3 install': ['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--trusted-host'],
};

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
 * masked; the rest mask the whole match, keeping a 7-char hint. One list lives here; the relay's copy is
 * generated from SECRET_PATTERN_SPECS into plugin/hooks/secret-patterns.json (scripts/sync-secret-patterns.ts),
 * and a test fails when that file is stale. Masking is a net, not a guarantee (see A4's field allowlist).
 */
const SECRET_PATTERNS: Array<{ re: RegExp; lead?: boolean }> = [
  // vendor-prefixed tokens — mask the whole token, keep a short hint
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { re: /\b(?:xox[baprs]-|sk-proj-|sk_live_|sk_test_|glpat-|npm_|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{8,}/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },                                    // AWS access key id
  { re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g },                    // JWT
  { re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g },  // PEM block
  { re: /\b(?:bearer|basic|token)\s+[A-Za-z0-9+/=._~-]{12,}/gi },      // auth-scheme values
  // URL userinfo — keep scheme://user:, mask the password up to '@'
  { re: /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, lead: true },
  // Cookie / Set-Cookie header — keep the name, mask the value to end of line
  { re: /((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/gi, lead: true },
  // JSON {"name":"...secret-ish...","value":"..."} — keep up to the value's opening quote
  { re: /("name"\s*:\s*"[^"]*(?:key|token|secret|password|passwd|credential)[^"]*"\s*,\s*"value"\s*:\s*")[^"]*/gi, lead: true },
  // any NAME containing a secret word = VALUE (env/flag/json); value runs to whitespace or a quote, past
  // commas, any length. Runs before the legacy field pattern so a comma in the value does not cut it short.
  { re: /([A-Za-z0-9_]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"']+/gi, lead: true },
  // legacy header/JSON credential field with an auth scheme (kept; 8+ value) for names without a secret word
  { re: /(?:authorization|x-api-key|access[-_]?token|auth[-_]?token)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?[^\s"',}]{8,}/gi },
  { re: /\bANTHROPIC_[A-Z_]*\s*=\s*\S+/g },                            // ANTHROPIC_API_KEY=…, ANTHROPIC_AUTH_TOKEN=…
];

/** Serializable form of SECRET_PATTERNS for the plugin's generated copy; `lead` matches the redact rule above. */
export interface SecretPatternSpec { source: string; flags: string; lead?: boolean }
export const SECRET_PATTERN_SPECS: SecretPatternSpec[] = SECRET_PATTERNS.map(p => ({ source: p.re.source, flags: p.re.flags, ...(p.lead ? { lead: true } : {}) }));

/** Masks API keys, OAuth tokens, cookies and secret-named values. Apply before writing anything to logs or the ledger. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const s of extraSecrets) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  for (const p of SECRET_PATTERNS) {
    out = p.lead
      ? out.replace(p.re, (_m: string, g1: string) => `${g1}[REDACTED]`)
      : out.replace(p.re, (m: string) => m.slice(0, 7) + '…[REDACTED]');
  }
  return out;
}
