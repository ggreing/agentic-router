# Do It All Claude Code

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

The CLI and package are called `do-it-all-claude-code`.

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
git clone https://github.com/ggreing/do-it-all-claude-code && cd do-it-all-claude-code
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
node packages/cli/src/index.ts start
```

`node packages/cli/src/index.ts` is the CLI until there's a published package; below it's written as
`do-it-all-claude-code`. `init` registers the plugin and a status line and asks before it changes your Claude
Code settings. `do-it-all-claude-code doctor` checks the setup if something looks off.

Other commands you'll probably use:

| Command | What it does |
|---|---|
| `status`, `stop` | show or stop the daemon |
| `dashboard` | open the local dashboard |
| `mode subscription\|api\|direct\|proxy` | switch modes (below) |
| `policy show\|accept` | review a project's `.do-it-all-claude-code/policy.json` before it takes effect |
| `data export`, `data purge` | export or delete what the router has recorded |
| `uninstall` | undo what `init` did; your data folder stays |

## Subscription or API key

By default it runs on your Claude subscription. In that mode there's no proxy and the router never reads
or stores your subscription credentials; Claude Code talks to Anthropic exactly as before.

With an API key, `do-it-all-claude-code init --mode api` puts a small local proxy in front of the API. It records
the real token cost of every call and applies daily budgets — $100 per day per local token and $300 per day
in total by default. Each request holds its worst case (its prompt size and `max_tokens` at the model's
highest rates) against those caps until it finishes, and does not start when that would not fit. Even so,
the hold covers only the request body: content the API fetches for itself — files referenced by id, images
by URL, and server tools such as web search — is charged when the call settles, so a day can still end a
little over the cap. The key itself lives only in the OS keychain. If the proxy ever gets in your way, `do-it-all-claude-code mode direct`
bypasses it and `do-it-all-claude-code mode proxy` puts it back.

**Local TLS.** In API-key mode Claude Code reaches the proxy over `https://127.0.0.1:<port>` with a
certificate only this router holds — made with `openssl`, good for `127.0.0.1` and `localhost` only and
unable to vouch for any other site, and kept readable by you alone in the router home — which Claude Code
trusts through `NODE_EXTRA_CA_CERTS` in its settings. The certificate is renewed before it expires, and
Claude Code sessions that were open during a renewal need a restart; `doctor` says when. If another program
takes the proxy's port while the proxy is down, it cannot complete the TLS handshake, so neither the local
token nor a prompt reaches it. If you already set `NODE_EXTRA_CA_CERTS` yourself (say a corporate CA), the router
writes a bundle of your certificates and its own into Claude Code's settings so your CA stays trusted;
`mode direct`, `mode subscription` and `uninstall` put your own value back, and `doctor` offers to point
your shell variable at the bundle too. Without `openssl` the proxy stays on plain HTTP with the same request
checks, and `doctor` says so.

**Behind a corporate proxy.** The proxy reaches the API through whatever proxy your environment names — the
first of `https_proxy`, `HTTPS_PROXY`, `http_proxy` and `HTTP_PROXY` (the order Claude Code uses), with
`NO_PROXY` honoured. It uses Node's built-in proxy support (Node 24.5 or later), so HTTPS goes through a
CONNECT tunnel and the API's certificate is still verified end to end. Any credentials in the proxy URL go
only to the proxy and never appear in logs, errors or `doctor`. A TLS-inspecting proxy needs its root
certificate trusted by Node, for example through `NODE_EXTRA_CA_CERTS`. SOCKS is not supported, and a proxy
setting the router cannot use stops it from starting rather than quietly going around the proxy.

In the other direction, Claude Code would otherwise send its own requests for the local proxy at
`127.0.0.1:<port>` (local token included) through your corporate proxy too. So when a proxy is set,
`do-it-all-claude-code init --mode api` and `mode api` add `127.0.0.1` and `localhost` to `NO_PROXY` in Claude
Code's settings, keeping your own entries; `mode direct`, `mode subscription` and `uninstall` remove only
what they added. `do-it-all-claude-code doctor` checks both directions.

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

Everything stays in one SQLite file on your machine, and the router makes no network calls of its own,
apart from the optional update check (see Updates below).
By default it doesn't keep your prompts or the text of what workers report, only ids, sizes, outcomes and
costs. If you want prompts kept for your own analysis, turn on `recordPrompts`; turning it off again
deletes them at the next daemon start. Event records are kept for 30 days.

## Updates

The router can tell you when a newer version is out — off unless you turn it on. `do-it-all-claude-code init`
asks (press Enter for yes); later, `do-it-all-claude-code update on` turns it on, `off` turns it off, and
`check` looks right now whatever the setting and prints what you have against the newest release. An existing
install stays off until you turn it on, and `doctor` offers it meanwhile. When on, the daemon checks GitHub's
public release list at most once a day. GitHub sees an ordinary web request from your machine — your IP
address and a generic client name — and nothing else: no prompts, no usage, no identifiers. A newer version
then shows in the status line (` | update 0.4.0`) and as a one-line note at the start of a session, only to
you and at most once a day per version. Nothing updates itself.

## The dashboard

`do-it-all-claude-code dashboard` opens a read-only page served by the daemon: recent requests, who did what,
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
