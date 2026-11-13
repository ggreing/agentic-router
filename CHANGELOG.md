# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Dates are in UTC.

## [Unreleased]

## [0.3.0] — 2026-11-13

Third pre-release: the project is renamed. Nothing else changes in how it works.

### Renamed to Do It All Claude Code

- The project is now **Do It All Claude Code** (was Agentic Router Proxy). The CLI and the published
  package are `do-it-all-claude-code`, so the install name is the command; the internal packages are
  `@do-it-all-claude-code/{core,daemon,adapter-claude-code,proxy,dashboard}`, the proxy binary is
  `do-it-all-claude-code-proxy`, the router home is `~/.do-it-all-claude-code`, the per-project folder is
  `.do-it-all-claude-code/`, the environment variables start with `DO_IT_ALL_CLAUDE_CODE_`, and the agent
  types are `do-it-all-claude-code:coder` and the like. The repository is now
  `github.com/ggreing/do-it-all-claude-code` (GitHub redirects the old URL).
- A project that still has a `.agentic-router/` folder keeps working this release: each file in it
  (`policy.json`, `verify.json`, `teams.yaml`) is read when the new `.do-it-all-claude-code/` folder does
  not have that file, and the new folder wins where both do. `do-it-all-claude-code doctor` flags the old
  folder so you can rename it, and an accepted policy carries over the rename.

### Upgrading from 0.1.0 or 0.2.0

- Stop the old install with the **old** CLI first, from your current checkout:
  `node packages/cli/src/index.ts stop`.
- `git pull`, then `npm ci` and `npm run build:dashboard`. The remote is now `ggreing/do-it-all-claude-code`;
  GitHub redirects the old URL, and you can update your remote with
  `git remote set-url origin https://github.com/ggreing/do-it-all-claude-code`.
- Run `do-it-all-claude-code init`. When it finds an old install (the folder named by
  `AGENTIC_ROUTER_HOME`, or `~/.agentic-router`), it lists what it will change — including, by pid, the
  processes it will stop — and asks first. On yes it stops the old supervisor, daemon and proxy; moves the
  router home (ledger, tokens, the TLS certificate and bundle, config) to `~/.do-it-all-claude-code`; backs
  up Claude Code's settings (the backup is named in its report) and rewrites only its own entries there — its
  MCP tools, its agent types, rules for its own commands, the status line, the key helper, env values such as
  `NODE_EXTRA_CA_CERTS`, and paths under the old folder — leaving your other rules exactly as they are; and
  moves the API key in the OS keychain to the new name without showing it (on macOS you paste it once when
  asked). It prints what moved.
- `init` only migrates a source that is a real folder (not a link), holds the router's config or token, and
  on macOS and Linux is owned by you; otherwise it changes nothing and says why. It stops only processes it
  can confirm are the previous release's; if it cannot confirm one, it leaves everything and asks you to stop
  it. If both an old and a new install already exist, it changes nothing and says so.
- Then `do-it-all-claude-code start`, and restart any open Claude Code sessions. After migration
  `AGENTIC_ROUTER_HOME` is no longer read; `doctor` warns when it is still set ("previous home",
  "AGENTIC_ROUTER_HOME").

## [0.2.0] — 2026-11-13

Second pre-release: mostly security work for shared machines and API-key mode, plus better triage outside English.

### Upgrading from 0.1.0

- Run `agentic-router stop`, then `git pull`, `npm ci` and `npm run build:dashboard`, then
  `agentic-router start`: the daemon needs a restart for the sealed messages and, on macOS and Linux, the
  socket. Restart open Claude Code sessions too; the plugin is read from your checkout.
- In API-key mode, run `agentic-router mode api` once. It makes the local certificate and switches Claude
  Code's settings to `https://127.0.0.1:<port>`.
- The daemon still accepts the 0.1.0 way of calling it (the token sent as a header) for this release, so
  sessions that were open during the upgrade keep working. It is controlled by `bearerApi` and will be off
  by default in the next release.

### API-key mode

- The proxy now holds each request's worst case — its prompt size and `max_tokens` priced at the model's
  highest rates — against the daily caps until the request finishes, and refuses a request that would not
  fit. This tightens the budgets that 0.1.0 noted were not hard caps.
- **Corporate proxy support.** The proxy reaches the API through the proxy your environment names (the first
  of `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, with `NO_PROXY` honoured), using Node's
  built-in proxy support (Node 24.5+): HTTPS goes through a CONNECT tunnel with the API's certificate still
  verified end to end. A TLS-inspecting proxy needs its root certificate trusted by Node (e.g.
  `NODE_EXTRA_CA_CERTS`); SOCKS is not supported, and an unusable proxy setting stops the router from
  starting rather than going around it. So that Claude Code's own calls to the local proxy are not sent
  through the corporate proxy, `init --mode api` and `mode api` add `127.0.0.1` and `localhost` to
  `NO_PROXY` in Claude Code's settings (keeping your entries); `mode direct`, `mode subscription` and
  `uninstall` remove only what they added. `agentic-router doctor` checks both directions.
- Pricing knows Claude Fable 5.2, charges fast-mode requests at their real rate, and prices Fable 5.1 cache
  reads correctly (they were overestimated).

### Security

- Messages between the router's own programs (hooks, status line, MCP server, CLI) and the daemon are now
  encrypted and authenticated with a key derived from the token. A program that takes the daemon's port
  while it is down can read neither the token nor your prompts and cannot answer in the daemon's place.
- On macOS and Linux the router's programs reach the daemon through a Unix socket in the router home that
  only your user can enter, and never fall back to the port when the socket is gone; Windows keeps the
  local port with sealed messages.
- In API-key mode the proxy serves Claude Code over local TLS: a private certificate, held only by this
  router and valid for `127.0.0.1` and `localhost` only, that Claude Code trusts through
  `NODE_EXTRA_CA_CERTS` in its settings (bundled with any certificate you already trust there, and restored
  on a mode switch and `uninstall`). The local-token helper prints the token only after the proxy proves it
  holds the current one, and the proxy writes a fresh token at every start, so an old token is refused.
  Without `openssl` the proxy stays on plain HTTP and `doctor` says so.

### Delegation

- A reviewer's or tester's verdict can name the writer subtask it is about with a `Subtask:` line, so a
  reject that covers several writers is credited to the right one instead of to none.
- Triage handles more languages more accurately: Traditional Chinese task sets, Korean grammatical particles
  after file names, and length thresholds weighted per script for CJK.

### The guard

- Path comparisons are canonicalized on both sides, and a directory is checked under every spelling it can
  take on Linux, macOS and Windows, closing cross-platform ways around a scope.

### Project

- Continuous integration builds and tests on Linux, Windows and macOS.

## [0.1.0] — 2026-11-12

First public pre-release.

### Modes

- **Subscription mode** (default): the plugin and a local daemon do all the work. There is no proxy,
  and no subscription credential is ever read or stored. Traffic goes straight from Claude Code to
  Anthropic.
- **API-key mode** (opt-in): a local proxy aggregates real token cost and applies daily budgets ($100
  per local token, $300 total, both configurable) plus a per-request budget. These are not hard caps:
  new calls are refused with a 429 once a budget is reached, but responses already in flight can go over
  it. The API key lives only in the OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret).
- **Direct mode**: connect with the API key, bypassing the proxy, if the proxy has a problem. Switch
  between modes with `agentic-router mode subscription|api|direct|proxy`.

### Delegation and the ladder

- Each request is triaged (stage 1 is rules only — no embeddings, no extra model call) and either
  handled directly by the lead or delegated to a right-sized subagent team (architect, coder,
  reviewer, tester, ui-designer).
- Which levels are delegated depends on the lead model; roles move up or down a model × effort ladder
  to finish at the lowest cost that still passes verification.
- The daemon runs each subtask's build/typecheck/lint/tests, records cost, and keeps a work ledger.

### Dashboard

- A read-only local web dashboard (served by the daemon at `127.0.0.1`) shows the request timeline,
  each request's team, steps and verify result, cost (lead vs. workers), KPIs, the triage-vs-actual
  learning report, and the auto-release panel. Available in English, Korean, Japanese and Simplified
  Chinese. All data stays on the machine.

### Privacy (defaults)

- Everything is stored in one local SQLite file; nothing leaves the machine except Claude Code's own
  traffic — the router makes no outbound call of its own, in either mode.
- The learning store keeps rule-derived features, outcomes, costs and numbers — not embeddings, and
  not prompt text unless you turn on `recordPrompts`. Turning it back off deletes the stored prompt
  text at the next daemon start. Logs and the dashboard mask API keys and tokens.

### The guard (and its limits)

- A guard in front of router subagents' tools refuses writes outside a subtask's scope, writes to
  credential and repository-config files, reads of credential files, and off-allowlist or
  environment-dumping commands. A refusal cannot be overridden by an allow rule.
- For ordinary Bash the guard is silent: Claude Code's own permission rules decide, as they would
  without the router. To let workers build and test without prompts, allow those commands (e.g.
  `Bash(npm test)`, `Bash(npm run *)`). See docs/worker-permissions.md.
- The guard is a net, not a sandbox: it reads the text of a tool call and does not observe what a
  program does once it runs. Workers run as your OS user; code you allow a worker to run has your
  file access. See SECURITY.md "Limits".

### Known limits

- Verify runs the related build/typecheck/lint/tests, so a fix that is wrong in a way those checks do
  not exercise can still pass.
- "Accepted" means no objection was seen, so the success/acceptance rate is an upper bound, not a
  measured approval rate.
- Auto-release is a brake against gross losses, not a fine optimiser; its default is **observe** and
  nothing switches until you turn `autoRelease` on.
- On a shared machine the local binding does not separate users; use it on a machine you don't share,
  or keep the daemon running. See SECURITY.md.
- API-mode budgets are not hard caps: new calls are refused with a 429 once a budget is reached, but
  responses already in flight can push the total over it. Sizing the reservation from a request's
  `max_tokens` and reserving against the per-request budget are planned after release.

### Install note

- `npm ci` installs dependencies but does not build the dashboard SPA. Run `npm run build:dashboard`
  (or the dashboard shows a short page telling you to). `agentic-router doctor` reports the build
  state.

[Unreleased]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.1.0
