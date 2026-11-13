# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Dates are in UTC.

## [Unreleased]

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

### Security

- Messages between the router's own programs (hooks, status line, MCP server, CLI) and the daemon are now
  encrypted and authenticated with a key derived from the token. A program that takes the daemon's port
  while it is down can read neither the token nor your prompts and cannot answer in the daemon's place
  (decision 156).
- On macOS and Linux the router's programs reach the daemon through a Unix socket in the router home that
  only your user can enter, and never fall back to the port when the socket is gone; Windows keeps the
  local port with sealed messages.

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

[Unreleased]: https://github.com/ggreing/agentic-router/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ggreing/agentic-router/releases/tag/v0.1.0
