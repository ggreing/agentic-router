# Agentic Router Proxy 0.1.0 (draft)

First public pre-release. Interfaces and defaults may still change.

**Agentic Router Proxy** is a difficulty-based team router for Claude Code. A plugin and a local
daemon read each request, estimate its difficulty, and either let the main session handle it directly
or build a right-sized subagent team (architect, coder, reviewer, tester, ui-designer). Each role
rides a model × effort "ladder" — up when work is hard, down when it's easy — to finish at the lowest
cost that still passes verification. Everything runs locally.

## Highlights

- **Three modes.** Subscription (default; no proxy, no subscription credential ever read or stored),
  API-key (a local proxy that aggregates real cost and enforces daily + per-request budgets, key kept
  only in the OS keychain), and direct.
- **Delegation and the ladder.** Rules-first triage (no embeddings, no extra model call), right-sized
  teams, and per-subtask build/typecheck/lint/test verification recorded in a local work ledger.
- **Local dashboard.** A read-only web view of the request timeline, teams, costs, KPIs and the
  learning report — in English, Korean, Japanese and Simplified Chinese. All data stays on the machine.
- **Privacy by default.** One local SQLite file; no prompt text stored unless you opt in with
  `recordPrompts` (turning it off deletes what was stored at the next daemon start). Logs and the
  dashboard mask keys and tokens.
- **A guard for subagents.** Refuses out-of-scope writes, credential files and off-allowlist commands;
  a refusal can't be overridden. For ordinary Bash it stays silent and your own Claude Code permission
  rules decide.

## Install (from source, pre-release)

```
git clone <repo> && cd agentic-router
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
```

Requires Node 24+, Claude Code ≥ 2.1.295, and Git Bash on Windows. See the README to get started and
docs/worker-permissions.md for what router workers may and may not do.

## Please read before relying on it

- The guard is a net, not a sandbox: workers run as your OS user, and code you allow a worker to run
  has your file access. See SECURITY.md "Limits".
- Verify can pass a fix that's wrong in a way its checks don't exercise; "accepted" is an upper bound,
  not a measured approval rate.
- On a shared machine the local binding does not separate users.

Report anything that gets past the guard through GitHub's private vulnerability reporting (see
SECURITY.md).
