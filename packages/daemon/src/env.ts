// Environment for processes the daemon starts in a work tree (git, verify commands).
// Those processes run code a subagent may have edited (package scripts, git config), so
// credentials in the daemon's own environment are removed first.
//
// Decision 99 (env audit #6): the rule is narrow so ordinary settings stay (AWS_REGION, DOCKER_HOST,
// SESSION_STORE, GIT_AUTHOR_NAME): a name counts as a secret when it contains KEY, TOKEN, SECRET,
// PASSWORD / PASSWD, CREDENTIAL or AUTH (not AUTHOR), or it is a known credential or router-internal name.
// A subagent's verify gets the daemon's scrubbed environment overlaid with the toolchain variables
// its relay forwarded at SubagentStart (core VERIFY_ENV_PASSTHROUGH + the project's policy.json).

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH(?!OR))/i;
const KNOWN_SECRET = /^(ANTHROPIC_.*|CLAUDE_CODE_OAUTH.*|DO_IT_ALL_CLAUDE_CODE_.*|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|.*_API_KEY|NPM_CONFIG__?AUTH.*|.*COOKIE.*)$/i;
/** Never passed to verify commands or git: makes every node process load code (decision 99). */
const NODE_PRELOAD = /^NODE_OPTIONS$/i;

export const MAX_VERIFY_ENV = { names: 256, nameLength: 128, valueLength: 32 * 1024 };

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) || KNOWN_SECRET.test(name);
}

export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || isSecretName(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The daemon's own git: no secrets, no GIT_* from the daemon's environment (GIT_DIR, GIT_CONFIG_*...), no NODE_OPTIONS. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = scrubbedEnv(base);
  for (const k of Object.keys(out)) if (/^GIT_/i.test(k) || NODE_PRELOAD.test(k)) delete out[k];
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * A relay's `verifyEnv`, checked again here: string values only, size-limited, without secret-looking
 * names or NODE_OPTIONS. Undefined when there is nothing usable.
 */
export function cleanVerifyEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_VERIFY_ENV.names) break;
    if (typeof v !== 'string' || !k || k.length > MAX_VERIFY_ENV.nameLength || v.length > MAX_VERIFY_ENV.valueLength) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/.test(k) || isSecretName(k) || NODE_PRELOAD.test(k)) continue;
    out[k] = v;
    n++;
  }
  return n ? out : undefined;
}

/** Environment of one subagent's verify commands. Names compare case-insensitively on Windows (Path / PATH). */
export function verifyEnv(overlay?: Record<string, string>, base: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
  const out = scrubbedEnv(base);
  for (const k of Object.keys(out)) if (NODE_PRELOAD.test(k)) delete out[k];
  const clean = cleanVerifyEnv(overlay) ?? {};
  for (const [k, v] of Object.entries(clean)) {
    if (platform === 'win32') for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    out[k] = v;
  }
  return out;
}

/** The hook input as recorded in the events table: verifyEnv values are replaced by their names. */
export function withoutEnvValues(raw: Record<string, unknown>): Record<string, unknown> {
  const env = raw.verifyEnv;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return raw;
  return { ...raw, verifyEnv: Object.keys(env as object) };
}
