# Agentic Router Proxy 0.1.0

First public release, and still a pre-release: commands and defaults may change.

This is a Claude Code plugin plus a small local daemon. For each request it decides whether the main
session should just do the work, or hand it to subagents on cheaper models while the main session plans
and checks. In our last check, with a Sonnet main session and the router running as shipped, a passed
task cost 33% less than with plain Claude Code and the same tasks passed. It is slower on bigger tasks,
because every hand-off starts a new worker. The details are in `docs/measurements/kpi-phase3.md`.

What's in it:

It runs on your Claude subscription by default, with no proxy and without ever reading your subscription
credentials. With an API key you can put a local proxy in front of the API that records real cost and
stops sending new calls once a daily or per-request budget is used up (calls already streaming are
allowed to finish). The key stays in the OS keychain.

Workers start on the cheapest model that usually works and move up when they fail or a reviewer rejects
their work, and back down after two "easy" verdicts. After each worker the daemon runs the project's
build, typecheck, lint and tests and checks the worker stayed within its files.

A guard sits in front of the workers' tools. It refuses writes outside a worker's scope, anything touching
credential files or the router's own folder, and commands outside a small allowlist. It never approves
Bash for you; your own Claude Code permission rules still decide.

Everything is kept in one SQLite file on your machine and the router makes no network calls of its own.
Prompts and worker reports aren't stored unless you turn on `recordPrompts`. A read-only local dashboard
shows what happened and what it cost, in English, Korean, Japanese and Simplified Chinese.

Getting started:

```
git clone https://github.com/ggreing/agentic-router && cd agentic-router
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
node packages/cli/src/index.ts start
```

You need Node 24+, Claude Code 2.1.295 or newer, and Git Bash on Windows.

Before you rely on it, please read the "What doesn't work well yet" section of the README and the
"Limits" section of SECURITY.md. In short: the checks are only as good as the project's tests, the guard
is not a sandbox, and on a shared machine the local daemon doesn't separate users.

Security issues: please report them privately through GitHub (see SECURITY.md).
