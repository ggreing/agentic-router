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
 * Projects extend the list in .agentic-router/policy.json { "bashAllow": [...] } (protected path).
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
 * Environment variables the relay forwards from a router subagent's own hook environment at
 * SubagentStart, so that subagent's verify runs with the user's toolchain (decision 99, env audit #6):
 * the venv / conda / nvm / Java / Go / Rust selection of the terminal that launched Claude Code.
 * Names only; values are never logged. Secret-looking names are never forwarded even if listed.
 * Projects may add names in .agentic-router/policy.json { "verifyEnv": [...] } (protected path).
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

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // header or JSON field holding a credential, with or without quotes and an auth scheme
  /(authorization|x-api-key|api[-_]?key|access[-_]?token|auth[-_]?token|secret)["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token)\s+)?[^\s"',}]{8,}/gi,
  /\b(bearer|basic|token)\s+[A-Za-z0-9+/=._~-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,              // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                      // AWS access key id
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,      // JWT
  /\bANTHROPIC_[A-Z_]*\s*=\s*\S+/g,             // ANTHROPIC_API_KEY=..., ANTHROPIC_AUTH_TOKEN=...
];

/** Masks API keys, OAuth tokens and bearer headers. Apply before writing anything to logs or the ledger. */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const s of extraSecrets) if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  for (const re of SECRET_PATTERNS) out = out.replace(re, m => m.slice(0, 7) + '…[REDACTED]');
  return out;
}
