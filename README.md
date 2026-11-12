# Agentic Router Proxy

> **Draft — to be finalized before release.**

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

Agentic Router Proxy is a difficulty-based team router for Claude Code: a plugin plus a local daemon that
read each request, size it up, and either let the main session handle it directly or build a right-sized
team of subagents (architect, coder, reviewer, tester, ui-designer), each placed on a model × effort
"ladder" and moved up or down as the work proves hard or easy — to finish the work at the lowest cost
that still passes. The CLI and package are named `agentic-router`.

**How it works.** The Claude Code plugin forwards hook events to a local daemon over `127.0.0.1`; the
daemon triages each request, writes a plan and a work ledger to one local SQLite file, and injects a
brief telling the main session (the "lead") whether to handle the request itself or delegate. When it
delegates, the lead calls subagents with a write scope the plugin enforces; the daemon runs each
subtask's build, typecheck, lint and tests, records the cost, and adjusts each role on the ladder. Hooks
that record or advise fail open: if the daemon is not running, Claude Code works as it would without the
plugin and the work is recorded as unverified. The write-scope guard for router subagents works from
local files and blocks on error, so a subagent never writes outside its scope.

## Triage

Stage 1 is rules only — no embeddings, no extra model call. Only when the rules cannot tell the size does
the request go to stage 2: in **subscription** mode the lead decides with a rubric injected into its
context; in **API-key** mode a Sonnet 5.5 judge call (effort medium) runs through your API key. Similar-
case search over embeddings is deferred for now.

## Delegation and the ladder

Whether a level is delegated depends on the lead (main-session) model: an Opus-class or Sonnet lead
delegates from **L1** up, a Haiku or unknown lead from **L2** up, and **L0** is always handled directly.
Delegating pays off because the expensive lead stops doing the edits itself: in the direct-vs-team
measurements a lead + one Haiku coder was about 40% cheaper than the lead working alone (see
`docs/measurements/`).

A role moves **up** one rung after two misses in a row, or two rejects, or when the lead asks: once per
slot without asking unless it changes the model, otherwise after the user confirms. A slot is raised at
most 3 times, after which the user is asked. A role moves **down** one rung after two results in a row
that a reviewer or tester judged "easy".

## Install (pre-release, from source)

Nothing is published to npm yet. Run it from a clone:

```
git clone <repo> && cd agentic-router
npm ci
node packages/cli/src/index.ts <command>      # pre-release entry point
```

Below, `agentic-router <command>` is that entry point. Requirements: **Node 24+**, **Claude Code
≥ 2.1.295**, and **Git Bash on Windows**.

- `agentic-router init` — registers the Claude Code plugin (roles, hooks, the lead skill, the router MCP
  tools) and the status line, and sets subscription mode (the default). Use `init --mode api` for API-key
  mode.
- `agentic-router start` — starts the local daemon (triage API, work ledger, dashboard) in the background.
- `agentic-router doctor` — checks the setup and reports problems.
- `agentic-router status` / `stop` — show daemon status; stop it.
- `agentic-router dashboard [--no-open]` — open the local dashboard (see below).
- `agentic-router mode subscription|api|direct|proxy` — switch mode (see Modes).
- `agentic-router policy show|accept|revoke` — review and accept a project's `.agentic-router/policy.json`
  (see Permissions for router workers).
- `agentic-router data export|purge`, `agentic-router routing reset` — export or clear local data; reset
  the learned routing.
- `agentic-router uninstall [--keep-key]` — asks first, then removes the plugin's settings entries, the
  project's `worktree.baseRef` and `.gitignore` line, the settings backup and the keychain key, and stops
  the daemon. Your data folder stays.
- API-key mode only: `agentic-router token rotate [--no-grace]`, `agentic-router key set`,
  `agentic-router proxy allow-upstream <https origin>`.

## Modes

- **Subscription** (default, from `init`): the plugin and the local daemon do everything; there is no
  proxy, and no subscription credential is ever read or stored. Traffic goes straight from Claude Code to
  Anthropic.
- **API key** (`init --mode api`): an opt-in local proxy aggregates real token cost and enforces daily
  caps of $100 per local token and $300 in total (configurable), plus the per-request budget; over a cap
  the proxy refuses new calls with a 429 and never cuts a response already in progress. The API key is
  kept only in the OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret).
- **Direct**: if the proxy has a problem, `agentic-router mode direct` connects with the API key directly,
  bypassing the proxy; `agentic-router mode proxy` switches back.

Switch at any time with `agentic-router mode subscription|api|direct|proxy`.

## Dashboard

`agentic-router dashboard` opens a read-only local web dashboard (served by the daemon at `127.0.0.1`)
showing the request timeline, each request's team, steps and verify result, cost (lead vs workers), the
KPIs, the triage-vs-actual learning report, and the auto-release panel. It is available in English,
Korean, Japanese and Simplified Chinese. All data stays on the machine.

## Privacy

Everything is stored in one local SQLite file; nothing leaves the machine except Claude Code's own
traffic and, in API-key mode only, the stage-2 judge call to Anthropic. The learning store keeps
rule-derived features, outcomes, costs, and numbers such as similarity scores — not embeddings, and not
prompt text unless you turn on `recordPrompts`. Switching `recordPrompts` off deletes the stored prompt
text at the next daemon start. Logs and the dashboard mask API keys and tokens. No component reads or
stores subscription credentials.

## Auto-release holdout

To check that delegating still pays off, about 1 in 10 requests at a delegated level are handled directly
by the lead on purpose, as a holdout baseline. The default is **observe**: the holdout runs and the
dashboard shows the comparison and what a release would do, but nothing switches until you turn
`autoRelease` on. Set `holdoutRate` to `0`, or turn `autoRelease` off, to stop taking the holdout.

## Permissions for router workers

Router workers (the coder, tester and other subagents the lead dispatches) use Claude Code's tools like
any other agent. The router adds a guard in front of those tools, and the guard gives one of three answers:

| Guard's answer | When | What happens |
|---|---|---|
| Refuses | The call is recognised as not allowed: a write outside the subtask's scope, a credential file, the router's own folder, a command or option that is not on the worker allowlist. | The call does not run. No allow rule can override this. |
| Allows | Reading or searching named files inside the repository, and editing files inside the subtask's scope. | The call runs without a prompt. |
| Says nothing | Every Bash command it did not refuse. | Claude Code's own permission rules decide, as they would without the router. |

### Bash goes through your permission rules

The guard reads a command line; it does not sandbox it. So it never approves a Bash command on your
behalf. A worker's `npm test` or `npm run build` is handled like any other Bash command in Claude Code:
it runs if a rule allows it, and otherwise you are asked. In non-interactive runs (`claude -p`) there is
nobody to ask, so a command without an allow rule is declined.

To let workers build and test without prompts, allow those commands:

```
claude --allowedTools "Bash(npm test)" "Bash(npm run *)"
```

or in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(npm test)", "Bash(npm run *)"] } }
```

Use `"Bash(npm run build)"` in place of `"Bash(npm run *)"` to allow one script only. For another
toolchain, allow its test and build commands the same way.

Things to know before you add a rule:

- **A chained command needs every part allowed.** Claude Code splits a command on `&&`, `||`, `;` and `|`
  and checks each part on its own, so `Bash(npm test)` alone does not cover `make && npm test`. A `cd` into
  a directory inside the working tree is read-only and needs no rule, so `cd packages/web && npm test` needs
  only the rule for `npm test`.
- **Rules are session-wide.** They apply to the lead and to every worker, not only to router workers.
- **Allowing a command that runs code means vouching for that code.** A test file or a package script is
  a program. Once allowed, it runs as you, with your file access. The router refuses package scripts and
  installs when the `scripts` in `package.json` differ from the last commit, until you or the lead confirm;
  it does not inspect what a test or script does.
- **A refusal wins over an allow rule.** With `"Bash(npm run *)"` allowed, `npm run env` (which prints the
  environment) is still refused. With `"Bash(cat *)"` allowed, `cat .env` is still refused.

### What workers cannot do, whatever you allow

- Write outside the paths of their subtask (`[scope: ...]`), or to CI configuration, `.claude/`, `.git/`,
  `.mcp.json`, `.husky/`, `CLAUDE.md` and similar files that change how the repository or the agent runs.
- Read, search for or list credential files (`.env`, `.npmrc`, `~/.ssh`, `~/.aws`, …) or the router's
  folder (`~/.agentic-router`). `.env.example` and other templates are readable.
- Run commands outside the worker allowlist (network tools, shells, interpreters with inline code), print
  the environment, or reference secret-looking variables.
- Use shell syntax the guard cannot follow: `$'…'` strings, `${VAR}` expansions, command substitution,
  comments, output redirection to files.
- Install packages from anywhere but the registry (no URLs, git specs or `user/repo` shorthands).
- Use PowerShell. Workers use Bash only.

Some refusals may surprise a worker that is doing honest work. The message says what to do instead:

| Refused | Use instead |
|---|---|
| `rg --hidden`, `rg --no-ignore` | `rg` without them, or name the files |
| `git diff --no-index` | `git diff` on tracked files, or `diff` |
| `printf -v`, `echo ${VAR}` | plain `printf` / `echo $VAR` (non-secret names) |
| A comment inside a command | drop the comment |
| `npm install user/repo` | a registry name; ask the lead for anything else |
| Grep over a directory that holds an un-ignored `.env` | add a glob or type, search a subdirectory, or add the file to `.gitignore` |

### Project policy

A repository can extend the worker allowlist in `.agentic-router/policy.json` (`bashAllow`) and name
environment variables to pass to verification (`verifyEnv`). The file takes effect only after you accept
it:

```
agentic-router policy show
agentic-router policy accept
```

Acceptance is tied to the file's content. If the file changes, for example after a `git pull`, it is
ignored again until you accept the new content. `agentic-router doctor` shows the current state.

### Workers need the daemon

A worker may write only when the router has a scope record for it, and the daemon writes that record when
the lead dispatches the worker. If the daemon is not running, router workers cannot edit files; reading
still works. `agentic-router status` shows whether it is up.

## Limits

- Verify runs the related build/typecheck/lint/tests, so it can pass a fix that is wrong in a way those
  checks do not exercise.
- "Accepted" means no objection was seen (no revert, re-request, or complaint), so the success/acceptance
  rate is an **upper bound**, not a measured approval rate.
- Auto-release is a brake against gross losses, not a fine optimiser: it releases a level back to direct
  handling when the team is clearly no longer cheaper, within a wide band.

## Status

Pre-release. Interfaces and defaults may still change.

## License

Apache-2.0.
