# Security Policy

> **Draft — to be finalized before release.**

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
- It never sends prompt text anywhere except Anthropic: apart from Claude Code's own traffic, the only
  outbound call is the stage-2 triage judge in API-key mode, made with your key. Prompt text is stored
  locally only when you turn on `recordPrompts`, and the stored copy never leaves the machine.
- It never stores API keys outside the OS keychain — not in environment variables, not in plaintext files.
