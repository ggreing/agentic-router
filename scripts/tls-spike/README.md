# Local-TLS spike (API-key mode, decision 156)

Does the Claude Code binary accept `ANTHROPIC_BASE_URL=https://127.0.0.1:<port>` with a **private
self-signed certificate** trusted through `NODE_EXTRA_CA_CERTS`? And, when the cert is **not** trusted, does
it fail with a TLS error rather than silently falling back to plain HTTP?

This drives a real `claude -p` against a local fake that speaks HTTPS and listens on `127.0.0.1` only, with a
fresh temp config directory (no login) and a dummy key that only the fake accepts. **No API call is made and
nothing is billed.** Your own `~/.claude` and `~/.agentic-router` are not read or changed. It reuses the
shape of `scripts/guard-e2e`.

## Run

```
node scripts/tls-spike/run.mjs                 # all four cases (starts a real claude per case)
node scripts/tls-spike/run.mjs --only=no-trust # one case
node scripts/tls-spike/run.mjs --selftest      # cert + fake only, no claude (safe to run anywhere)
node scripts/tls-spike/run.mjs --keep          # keep the temp dir (cert, per-case configs, summary.json)
```

Needs the `claude` executable on `PATH` (or `CLAUDE_BIN=<path>`) and `openssl` (or `OPENSSL_BIN=<path>`; Git
for Windows ships one at `C:\Program Files\Git\usr\bin\openssl.exe`, which the script also looks for). On
Windows, run from PowerShell or Git Bash. `--timeout=<seconds>` sets the per-case cap (default 120). The exit
code is 1 when a case did not meet its expectation or a plain-HTTP downgrade was seen, 2 on a setup error.

The cert, the per-case config dirs, and `summary.json` go in a fresh temp dir (printed at the end), not in the
repo. `--keep` leaves them for inspection; otherwise the temp dir is removed.

## The certificate

One self-signed cert carries **both** SANs, so it serves every case:

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -config openssl.cnf
```

`openssl.cnf` (written by the script):

```
[req]
distinguished_name = dn
x509_extensions = v3ext
prompt = no
[dn]
CN = agentic-router-tls-spike
[v3ext]
subjectAltName = IP:127.0.0.1, DNS:localhost
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyCertSign
```

A config file is used instead of `-addext` on purpose: it works on old OpenSSL, OpenSSL 3, **and** the
LibreSSL that ships with macOS (where `-addext` support is version-dependent). The cert is its own CA
(self-signed) so it validates as a trust anchor when added through `NODE_EXTRA_CA_CERTS`. Verified on this
machine with OpenSSL 3.5.5 on Windows. The syntax is standard `openssl req` and is portable to macOS and
Linux; re-run the `--selftest` there to confirm per-platform.

## Cases

Each case runs one tiny prompt and prints one line: **connected** / **TLS error** / other, plus the error text
and the first matching `claude --debug` CA/proxy line.

| Case | Base URL host | Where the CA is trusted | Expectation |
|---|---|---|---|
| `no-trust` | `127.0.0.1` | nowhere | **TLS error** — never a silent plain-HTTP fallback |
| `env-process` | `127.0.0.1` | `NODE_EXTRA_CA_CERTS` in the process env | connected (case **a**; exercises the **IP SAN**) |
| `env-settings` | `127.0.0.1` | `NODE_EXTRA_CA_CERTS` only in `settings.json` `env` | **report which happens** (case **b**) |
| `localhost` | `localhost` | `NODE_EXTRA_CA_CERTS` in the process env | connected (case **c**; exercises the **DNS SAN**) |

**connected** = a parsed HTTP request reached the fake (the handshake succeeded). **TLS error** = no request
reached the fake and `claude`'s output/stderr carries a cert/TLS signature
(`SELF_SIGNED_CERT…`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID`, `unable to verify`, …).
A **plain-HTTP downgrade** would show up as non-TLS bytes on the HTTPS port (`wrong version number`) and is
flagged loudly.

`--selftest` (no claude) confirms the cert and fake directly with a Node HTTPS client: a trusted client must
connect to each host and an untrusted one must be rejected. It does **not** distinguish `env-settings` from
`env-process` (only the real `claude` run can) — it treats both trusted cases as "with CA". On this machine
the selftest passes: `no-trust` → rejected `DEPTH_ZERO_SELF_SIGNED_CERT`; the IP-SAN and DNS-SAN cases → 200.

## What the docs say (code.claude.com)

- **`NODE_EXTRA_CA_CERTS` is documented** for Claude Code — on the network page under "Custom CA
  certificates" (`export NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem`), **not** in the env-vars reference table.
  `claude --debug` logs `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (...)`, and `/status`
  shows an "Additional CA cert(s)" row. By default Claude Code trusts its bundled Mozilla CAs **and** the OS
  store (`CLAUDE_CODE_CERT_STORE=bundled,system`; the OS store needs the native installer or Node 22.15+).
  <https://code.claude.com/docs/en/network-config.md>
- **`settings.json` `env` block**: documented; values are read directly from the file and "take effect no
  matter how `claude` was launched", copied verbatim (no shell expansion). **Caveat that bears on case b:** if
  the launch environment already sets a variable, Claude Code **ignores** the settings-file value and logs the
  name — so case `env-settings` must not also set `NODE_EXTRA_CA_CERTS` in the process env (the script does
  not). Separately, **cloud sessions ignore** `NODE_EXTRA_CA_CERTS` (and the client-cert vars) when they come
  from a settings-file `env` block; this spike targets a **local** session.
  <https://code.claude.com/docs/en/env-vars.md#in-settings-files>,
  <https://code.claude.com/docs/en/settings-reference.md#env>
- **`apiKeyHelper` refresh/TTL**: the setting is `apiKeyHelper` (a `settings.json` string). The refresh
  interval is the **environment variable** `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` (milliseconds) — not a
  settings key. **Default 5 minutes** (stated on the settings-reference page; the env-vars row lists no
  default). The helper also re-runs when an API request returns 401/403 — so a local proxy returning 401/403
  triggers a credential refresh. Output is sent as both `X-Api-Key` and `Authorization: Bearer`.
  <https://code.claude.com/docs/en/settings-reference.md#apikeyhelper>,
  <https://code.claude.com/docs/en/env-vars.md>
- **`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`**: Claude Code respects the standard proxy vars (lowercase
  variants too; first of `https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY` set wins). `NO_PROXY` takes
  comma/space-separated hosts/IPs and `*`. The **only** documented loopback bypass is for **WebSockets**
  (`localhost, ::1, 127.0.0.0/8` are never proxied); whether a plain **HTTPS** request to
  `https://127.0.0.1:<port>` bypasses `HTTPS_PROXY` automatically is **undocumented** — so set
  `NO_PROXY=127.0.0.1,localhost` explicitly. SOCKS is not supported. The byte-level idle watchdog (300 s
  default) does run on a custom `ANTHROPIC_BASE_URL`. (A is checking the proxy behaviour in depth.)
  <https://code.claude.com/docs/en/network-config.md#proxy-configuration>

This spike isolates TLS from the proxy question: it strips any ambient `HTTP(S)_PROXY` from the child env and
sets `NO_PROXY=127.0.0.1,localhost,::1`, so a loopback request never leaves the machine regardless of the
host's proxy settings.

## Files

- `run.mjs` — openssl cert generation, cases, spawning `claude`, grading, `--selftest`.
- `fake-tls.mjs` — the fake HTTPS upstream (127.0.0.1 only; records parsed requests and TLS handshake errors).
- `key-helper.mjs` — prints the dummy key.
