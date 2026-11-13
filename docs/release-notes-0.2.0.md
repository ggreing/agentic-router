# Agentic Router Proxy 0.2.0

Second pre-release. Most of it is about one question: what happens on a machine you share with other
people, or when another program grabs one of the router's local ports while it is down. In 0.1.0 the
answer was "it could read the token and your prompts". Now it can't.

What changed:

The router's own programs (the hooks, the status line, the MCP server and the CLI) no longer send the
daemon's token at all. Every message to the daemon is encrypted and authenticated with a key derived from
it, so whatever sits on the port can't read anything or answer in the daemon's place. On macOS and Linux
they go one step further and talk to the daemon through a socket in your router folder that only your user
can open.

In API-key mode, Claude Code now reaches the local proxy over TLS, with a certificate that only this router
has and that is good for 127.0.0.1 and localhost only. A program that takes the proxy's port can't complete
the handshake, so it gets neither the local token nor a prompt. The key helper also refuses to hand out the
token unless the proxy proves it holds the current one, and the proxy picks a new token every time it
starts. If you already trust extra certificates through `NODE_EXTRA_CA_CERTS`, they stay trusted: the router
puts a bundle of yours and its own in Claude Code's settings.

Also in API-key mode: each request now reserves its worst-case cost against the daily caps before it is
sent, and the proxy works behind a corporate HTTP(S) proxy (Node 24.5 or later), without letting Claude
Code's calls to the local proxy wander through the corporate one.

Outside security: the router sizes up requests better in Japanese, Chinese (now including Traditional) and
Korean, a reviewer can say which of several workers it is rejecting, and everything is tested on Linux,
Windows and macOS for every change.

Upgrading from 0.1.0:

```
node packages/cli/src/index.ts stop
git pull
npm ci
npm run build:dashboard
node packages/cli/src/index.ts start
```

Then restart your Claude Code sessions. In API-key mode, run `node packages/cli/src/index.ts mode api`
once to create the certificate and switch Claude Code to https. The daemon still accepts the old way of
calling it for this one release, so a session that was open during the upgrade keeps working until you
restart it.

The full list is in `CHANGELOG.md`, and what the router still can't protect against is in the "Limits"
section of `SECURITY.md`. Without `openssl` the proxy stays on plain HTTP, and `agentic-router doctor` tells
you so.

Security issues: please report them privately through GitHub (see SECURITY.md).
