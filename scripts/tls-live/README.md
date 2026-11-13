# Local-TLS live check (API-key mode, decisions 156-158)

The follow-up to `scripts/tls-spike`: a real `claude -p` against the router's own pieces instead of a bare fake. The
certificate comes from the CLI's `localtls.ts` (openssl), the proxy is the real `createProxy` serving HTTPS with it,
and the apiKeyHelper is the real `packages/proxy/bin/local-token.mjs`, which checks the proxy's proof (and that the
session's `ANTHROPIC_BASE_URL` is that proxy) before it prints the local token. The proxy forwards to a fake Messages
API on `127.0.0.1` that accepts one dummy key. **No API call is made and nothing is billed.** A fresh temp config dir
and a temp router home are used; your own `~/.claude` and `~/.agentic-router` are not read or changed.

## Run

```
node scripts/tls-live/run.mjs                # all cases (a real claude per case)
node scripts/tls-live/run.mjs --only=minted-leaf
node scripts/tls-live/run.mjs --selftest     # no claude: the helper and one HTTPS request stand in for it
node scripts/tls-live/run.mjs --keep         # keep the temp dir (configs, router home, certificates, summary.json)
```

Needs `claude` on `PATH` (or `CLAUDE_BIN=<path>`) and `openssl` (`OPENSSL_BIN=<path>`, else `PATH`, else the one Git
for Windows ships). `--timeout=<seconds>` sets the per-case cap (default 120). Exit code 1 when a case is not met, 2 on
a setup error.

## Cases through the router's proxy

| Case | Setup | Expectation |
|---|---|---|
| `tls` | settings env: `ANTHROPIC_BASE_URL=https://127.0.0.1:<port>`, `NODE_EXTRA_CA_CERTS=<router leaf>`, the helper | connected; the fake sees the dummy key. Also reports `helperSawBaseUrl`: whether the helper found `ANTHROPIC_BASE_URL` in the environment Claude Code gave it (the value is never written) |
| `restart` | the proxy restarts between runs (a fresh local token, as at every start) | the old token gets 401; the next run connects |
| `squatter` | the proxy is stopped and another program serves HTTPS on its port with a certificate of its own | the helper prints nothing; no request carrying a credential reaches the squatter |
| `shell-ca` | settings: the bundle (the user's CA plus the router's); launch environment: the user's CA | connected (decision 158) |
| `precedence` | settings: the router's certificate only; launch environment: the user's CA only | connected: the settings value replaces the launch one. Pins today's behaviour so a change in Claude Code shows up |
| `plain` | local TLS off (the no-openssl fallback): `http://` base URL, no CA | connected, through the proof-checking helper |

## Certificate-shape cases

A fake HTTPS API is reached directly (a dummy-key helper), trusted through `NODE_EXTRA_CA_CERTS` in the settings.

| Case | Trusted | Served | Expectation |
|---|---|---|---|
| `minted-leaf` | the router's leaf (`CA:FALSE`, `digitalSignature`, `serverAuth`) | a leaf for 127.0.0.1 made with the leaf's key, with the chain | TLS error: the key cannot mint certificates Claude Code accepts |
| `control-ca` | the older `CA:TRUE` shape | a leaf made with its key, with the chain | connected: the risk the leaf shape removes |
| `nc-anchor` | `CA:TRUE, pathlen:0` with critical `nameConstraints` (IP 127.0.0.1/32, DNS localhost) | itself | connected (the fallback shape, if Claude Code refused the leaf) |
| `nc-minted` | the same anchor | a leaf it made for 127.0.0.2, served on 127.0.0.2 | TLS error (skipped on macOS, where 127.0.0.2 needs an alias) |

`--selftest` checks this script's own plumbing on any machine, with Node's TLS standing in for Claude Code's. Only the
real run shows how Claude Code reads the settings, which certificate shapes it accepts, and what it passes to the
helper.
