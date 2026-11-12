# Security Policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's **"Report a vulnerability"** (private
vulnerability reporting) on this repository's **Security** tab. Do not open a public issue for a
vulnerability, and do not include working exploit steps in a public place. There is no e-mail contact for
now.

We will acknowledge the report, investigate, and coordinate a fix and disclosure with you.

## Supported versions

Pre-release: only `main` is supported. There are no released versions yet.

## Scope

The plugin hooks (`plugin/`), the local daemon, the API-key proxy, the CLI, and the dashboard.

## If a credential leaks

- **Anthropic API key** (API-key mode): revoke it in the Anthropic Console first, then set a new one with
  `agentic-router key set` (the key is read over stdin/TTY and stored only in the OS keychain). Check the
  proxy log and the daily totals for unexpected usage.
- **Local proxy token** (the token Claude Code sends to the local proxy): run
  `agentic-router token rotate`. The proxy keeps accepting the old token for about 10 more minutes so
  in-flight sessions keep working; Claude Code picks up the new one through its `apiKeyHelper`.
- **Daemon token** (the bearer for the daemon's local API at `127.0.0.1`, stored at
  `<router-home>/token`, mode `0600`): `init` writes this token once, as 32 random bytes, and keeps an
  existing one. To regenerate it, stop the daemon (`agentic-router stop`), delete `<router-home>/token`,
  run `agentic-router init` (which writes a fresh token and restores `0600`), then start the daemon
  again. The default router home is `~/.agentic-router` (overridable with `AGENTIC_ROUTER_HOME`).

All local endpoints bind to `127.0.0.1` only and check the `Host`/`Origin` headers, so a web page cannot
reach them; tokens still matter because they sit in local files.

## What the project never does

- It never reads or stores subscription (Claude.ai) credentials.
- It never sends prompt text anywhere except Anthropic through Claude Code's own traffic; the router makes
  no outbound call of its own, in either mode. Prompt text is stored locally only when you turn on
  `recordPrompts`, and the stored copy never leaves the machine.
- It never stores API keys outside the OS keychain — not in environment variables, not in plaintext files.

## Limits

**The guard is a net, not a sandbox.** It decides from the text of a tool call: the paths it names and
the command line it carries. It refuses what it recognises and refuses shell syntax it cannot follow. It
does not observe what a program does once it runs, and a command on the worker allowlist may have an
option or behaviour that the guard's list does not cover.

**Workers run as you.** The hooks, the daemon and every worker are processes of the same OS user, so
there is no isolation boundary between them. What the router does: it keeps a worker's own tool calls
away from the router folder and from credential files, on every path spelling it can resolve; it never
places the router's tokens in a worker's environment or on a command line; and it keeps the records the
guard trusts (scope records, the accepted project policy) where workers may not write. What it cannot do:
stop code that you allow a worker to run. A test, a build script or any other program that runs with
your approval has your user's file access, including to `~/.agentic-router` and your credential files.
Treat an allow rule for a command that runs code as you would treat running that code yourself.

**Searches.** A search that names no files opens whatever the search tool opens below its start
directory. Files ignored by git are skipped. The guard refuses such a search when it finds a credential
file that git does not ignore, but it looks only four directory levels deep and at a bounded number of
entries, so a credential file committed deep in a large tree can be missed. Keep credential files out of
the repository or in `.gitignore`.

**Credential files committed to the repository.** A file that is in the repository's history can be read
through git itself (`git grep`, `git show HEAD`, `git log -p`), and workers may run those commands. The
guard refuses paths that name a credential file, but no path check can cover content that git prints from
its own store. Keep secrets out of the repository; if one was committed, treat it as exposed and rotate it.

**Letter case.** On Windows and macOS the guard compares names without case, as those file systems do. A
macOS volume formatted case-sensitive (not the default) is compared without case all the same, so a
worker's write scope there is slightly wider than it looks: `src/` also admits `SRC/`. Refusals ignore
case on every system.

**Writes depend on the daemon.** A worker without a scope record cannot write (fail-closed). This means
a stopped or crashed daemon blocks worker edits rather than leaving them unchecked.

**Outside the guard's reach.** The guard applies to this plugin's subagents only. The main session, other
plugins' agents, and anything else running on the machine are not restricted by it.

**Shared machines.** On a machine with other local users, another user could bind the daemon's or proxy's
port while it is down, and hooks would then send it the local token and hook data. The router binds
`127.0.0.1` only, which does not separate users. Use it on a machine you don't share, or keep the daemon
running; proving the listener's identity before sending the token is planned.

**What real isolation would take.** Running workers as another OS user or in a container. That is not
part of this release.

Report anything that gets past the guard as a security issue (see "Reporting a vulnerability" above).
Every confirmed bypass becomes a regression test and a step in `scripts/guard-e2e`.
