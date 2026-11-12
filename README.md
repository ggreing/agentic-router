# Agentic Router Proxy

> **Draft — to be finalized before release.**

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

If you run Claude Code on Opus or Sonnet, the main session does almost everything itself, including
edits that a much cheaper model would get right. This project is a Claude Code plugin plus a small local
daemon that changes that. For each request it decides whether the main session should just do it, or
hand the work to a few subagents running on cheaper models while the main session plans and checks.

In the last check, with the router running as shipped on a Sonnet main session, a passed task cost 33%
less than with plain Claude Code, and the same tasks passed. For most tasks that meant the main session
handed the edit to a single Haiku coder. It's slower, though: each hand-off adds a worker start, and on
the bigger tasks the team took noticeably longer than one session working alone. The numbers and how we
got them are in [docs/measurements](docs/measurements/).

The CLI and package are called `agentic-router`.

## How it works

The plugin forwards Claude Code's hook events to a daemon on `127.0.0.1`. When you send a prompt, the
daemon sizes it up with plain rules (no model call) and tells the main session, which we call the lead,
what to do: handle it directly, or delegate to a team.

Small things (a typo, a one-line fix) stay with the lead. Anything bigger is delegated if the lead is an
Opus-class or Sonnet model, or if the router can't tell which model it is. A Haiku lead keeps L1 work for
itself, since its workers would run the same model anyway. When the rules can't tell how big a request
is, it goes to a small team and the lead decides which roles it actually needs (a Haiku lead gets a short
rubric and decides for itself).

Workers start on the cheapest rung that usually works (Haiku at low effort for coders) and move up when
they fail: two misses in a row, two rejections from a reviewer or tester, or the lead asking for it. A
worker that keeps getting "easy" verdicts from a reviewer moves back down. After three raises the user is
asked.

When a worker finishes, the daemon runs the project's build, typecheck, lint and tests in that working
tree and checks that the worker stayed inside the files it was given. Everything goes into one local
SQLite file: what was planned, what happened, what it cost.

If the daemon isn't running, Claude Code behaves as if the plugin weren't there. The one exception is
router workers: they can only write while the daemon is up, so they never edit outside their scope.

## Getting started

Nothing is on npm yet. You need Node 24+, Claude Code 2.1.295 or newer, and Git Bash if you're on
Windows.

```
git clone https://github.com/ggreing/agentic-router && cd agentic-router
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
node packages/cli/src/index.ts start
```

`node packages/cli/src/index.ts` is the CLI until there's a published package; below it's written as
`agentic-router`. `init` registers the plugin and a status line and asks before it changes your Claude
Code settings. `agentic-router doctor` checks the setup if something looks off.

Other commands you'll probably use:

| Command | What it does |
|---|---|
| `status`, `stop` | show or stop the daemon |
| `dashboard` | open the local dashboard |
| `mode subscription\|api\|direct\|proxy` | switch modes (below) |
| `policy show\|accept` | review a project's `.agentic-router/policy.json` before it takes effect |
| `data export`, `data purge` | export or delete what the router has recorded |
| `uninstall` | undo what `init` did; your data folder stays |

## Subscription or API key

By default it runs on your Claude subscription. In that mode there's no proxy and the router never reads
or stores your subscription credentials; Claude Code talks to Anthropic exactly as before.

With an API key, `agentic-router init --mode api` puts a small local proxy in front of the API. It records
the real token cost of every call and stops sending new calls once a budget is used up: $100 per day per
local token and $300 per day in total by default, plus a per-request budget. Calls that are already
streaming are allowed to finish, so you can end up slightly over. The key itself lives only in the OS
keychain. If the proxy ever gets in your way, `agentic-router mode direct` bypasses it and
`agentic-router mode proxy` puts it back.

## Workers and permissions

Router workers run Claude Code's normal tools behind a guard. The guard refuses writes outside a worker's
scope, anything touching credential files or the router's own folder, and commands outside a small
allowlist. It doesn't approve Bash on your behalf: a worker's `npm test` goes through your normal Claude
Code permission rules. To let workers build and test without being asked each time:

```
claude --allowedTools "Bash(npm test)" "Bash(npm run *)"
```

The full list of what's refused, and why, is in [docs/worker-permissions.md](docs/worker-permissions.md).

## Your data

Everything stays in one SQLite file on your machine, and the router makes no network calls of its own.
By default it doesn't keep your prompts or the text of what workers report, only ids, sizes, outcomes and
costs. If you want prompts kept for your own analysis, turn on `recordPrompts`; turning it off again
deletes them at the next daemon start. Event records are kept for 30 days.

## The dashboard

`agentic-router dashboard` opens a read-only page served by the daemon: recent requests, who did what,
which checks passed, what it cost (lead versus workers), and how often the router's first guess about a
request's size turned out right. It's available in English, Korean, Japanese and Simplified Chinese.

## Checking that delegation still pays off

About one in ten requests that would be delegated is handled by the lead on purpose, so there's
something to compare against. Out of the box the router only reports what it sees; it won't switch
anything off by itself unless you set `autoRelease` to on. Set `holdoutRate` to 0 if you'd rather not
have the comparison at all.

## What doesn't work well yet

The checks after a worker finishes are the project's own tests, so a fix that's wrong in a way the tests
don't cover will still pass. When that happens the lead can send the work back up a rung, but it has to
notice first.

"Accepted" in the dashboard means nobody reverted the change, asked for it again, or complained within
the next couple of prompts. That's a ceiling on how often the work was good, not a measurement of it.

The automatic switch-off is meant to catch delegation that has become clearly more expensive, not to
fine-tune. With the sample sizes involved it can't tell a 25% loss from noise.

This is a pre-release. Commands and defaults may still change.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in
[SECURITY.md](SECURITY.md), which also lists what the guard can't protect against.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
