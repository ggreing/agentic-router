# Design note: settings editing (Phase 4)

Phase 4 is **settings editing from the CLI and the dashboard** (read-only today) — `config.json`, team
presets, and the role files — rather than a desktop app. For each choice this note gives the options and a
recommendation, and it carries forward the write-path and security analysis from the earlier desktop-app
exploration.

Target release: **0.5.0**.

## What exists, and the one invariant

- **Settings live in three places.**
  - `config.json` in the router home — scalar keys read by `daemon/src/config.ts`: `budgetsUsd` per level
    (L0–L3), `recordPrompts`, `autoRelease` (on/observe/off), `holdoutRate` (0–0.2), `eventRetentionDays`,
    `stepDown`, `delegateFrom` (lead class → level), `apiMode` (proxy/direct), `updateCheck`, and the
    advanced `forceLevel`/`fableOptIn`/`bearerApi`. `daemonPort`/`proxyPort` are set by `init`, not here.
  - `teams.yaml` — team **presets** per level: the roles, each role's `count` and ladder `start` step
    (`s1`–`s7`), and the per-level budget. zod-validated (`core/presets.ts`).
  - `plugin/agents/*.md` — the **role files**. Standard front matter (`name`, `tools`, `model`, `effort`,
    `maxTurns`, `isolation`), `x-router` (`role`, `verify` steps), and the instruction body
    (`core/roles.ts`). Claude Code reads the whole file from the plugin dir; the daemon reads the parsed
    front matter.
- **Two consumers, two transports.** The daemon reads all three (its `config.pluginDir` points at the
  plugin dir). Claude Code loads the role `.md` files from the plugin dir registered with `--plugin-dir`
  (which `init` sets and stores as `config.pluginDir`). The CLI is already a **sealed client** of the daemon
  (`core/seal.ts`); the dashboard is a **browser** on the read-only `/dashboard/*` cookie surface.
- **The security invariant that makes role editing safe.** The guard's hard floor — credential files, the
  router home, the never-grantable/protected paths, the secret-pattern denials, and the forbidden role tools
  (`FORBIDDEN_ROLE_TOOLS` = `Agent`, `Task`, `WebFetch`, `WebSearch`) — lives in
  `core/security.ts` and `core/roles.ts`, **not** in the editable files. No edit to a role file, preset, or
  `config.json` can widen what the guard refuses. Role editing changes a role's tool list (within that
  floor), model/effort, verify steps and instructions — never the floor. This invariant is the backbone of
  the whole feature and is re-checked on every write and on load.

## 1. CLI: commands and shape

**Commands.** `config get|set|list`, `preset show|edit`, `role show|edit`, plus `config edit` for the whole
file and a `reload` for externally-edited files.

**$EDITOR, field-level set, or both — recommend both, matched to the shape of the data.**

- **`config`**: scalar keys, so **field-level** is natural: `config get holdoutRate`, `config set
  holdoutRate 0.1`, `config list` (all keys with their effective values and defaults). `config edit` opens
  the whole `config.json` in `$EDITOR` for a bulk change. Field-level for the everyday toggles; `$EDITOR`
  for a sweep.
- **`preset`**: nested (roles × count × start step), so field-level set is awkward. **`preset show [L2]`**
  prints it; **`preset edit [L2]`** opens `teams.yaml` (or that level) in `$EDITOR`, validated on save.
- **`role`**: **`role show <role>`** prints the effective role; **`role edit <role>`** opens the role's
  effective file in `$EDITOR`, validated on save. A few scalar fields (`model`, `effort`) may also be
  field-settable for convenience, but `tools`, `verify` and the body belong in `$EDITOR`.

So: field-level `set` for scalar `config` keys; `$EDITOR`-based `edit` for `config.json`, presets and roles.

**Validation — reuse the existing schemas, and hard-reject.** `config` → `readConfig`'s rules (made to
reject, not silently clamp, on an interactive write, returning the specific problems); presets → the zod
preset schema; roles → `parseRoleFile` plus the guard-floor checks (forbidden tools absent, `name`/`role`
identity unchanged — see §3). On an `$EDITOR` save that fails, reopen the buffer with the errors as comments
(like `git commit` reopening a bad message) or abort and keep the file unchanged; a rejected write **never**
touches the live file.

**Atomic writes.** Temp file + `rename`, mode `0600`, in the router home (or the role-override location in
§3) — never a partial file, and a crash mid-write leaves the previous one.

**Audit.** Every applied change appends one line to a settings audit log (in the ledger or a dedicated log):
timestamp, the keys that changed (old → new; secret values never logged), and the source (`cli` or
`dashboard`). On a single-user machine "who" is that user, but the history answers "why did routing change?".

**How a running daemon picks the change up.**

- **Option A — the daemon is the single runtime writer.** The write goes to the daemon (sealed route for the
  CLI, see below); the daemon validates, writes the file atomically, reloads in-process, and audits. One
  writer, effect is immediate, no file-watcher.
- **Option B — the writer writes the file; the daemon watches and reloads.** A file-watcher per OS is flaky
  (rename semantics, editors writing twice), and two processes may write at once.

**Recommendation: A.** When the daemon is up, the CLI sends the change over a sealed `POST
/router/v1/config` (and `/router/v1/presets`, `/router/v1/role`); the daemon validates + writes + reloads +
audits, so one process owns the files at runtime. When the daemon is **down**, the CLI writes directly using
the **same core validators**, and the daemon loads fresh on next start. `reload` (a sealed route / CLI
command) re-reads the files for the case where someone edited them outside the tools. No file-watcher.

## 2. Dashboard: an edit page, or stay read-only?

**Option A — add an edit page.** The dashboard gets settings screens. Browser writes need protection on top
of the existing read guards (`Host`/`Origin`/`Sec-Fetch-Site`, the one-time-code → `HttpOnly` cookie): a
**per-session CSRF token** required on every write (issued with the session, sent as a header the page reads
from memory, checked by the daemon), plus the existing same-origin-loopback Origin/Sec-Fetch checks. Workers
can't reach it — they have no session cookie, and the guard keeps them out of the router home and the token.

**Option B — keep the dashboard read-only; edit only via the CLI.**

**Recommendation: A, but built on the same validated write core as the CLI, and sequenced after it.** The
spec's Phase 4 is "dashboard settings editing," and the dashboard is the product's UI, so a read-only
dashboard would miss the point. But the safe way to get there is to land the daemon's **one** validated
write core (validate → atomic write → reload → audit) with the **CLI (sealed) front door first**, then add
the dashboard's **cookie + CSRF + Origin** front door onto that same core. Both front doors call identical
validation and audit; neither bypasses the guard floor. So: one write core, two authenticated entries —
sealed for the CLI, cookie+CSRF+same-origin for the dashboard. Whether the dashboard editor must ship in
0.5.0 or can follow the CLI within the release is an open question; the recommendation is the same release,
CLI first.

Keep every write **off** the read-only metrics surface: the write routes are their own handlers with the
CSRF requirement, and a request without a valid session + CSRF token (dashboard) or a valid sealed message
(CLI) writes nothing.

## 3. Role files — the hard part

Claude Code loads `plugin/agents/*.md` from the plugin dir, which today is the user's **checkout**
(`--plugin-dir <checkout>/plugin`, stored as `config.pluginDir`). The daemon reads the same files. Editing
them in the checkout collides with `git pull`, dirties the tree, and is lost on a reclone.

**Options for where edits live.**

- **A — edit in place in the checkout, with a warning.** Simplest; both consumers see it at once. But it
  fights `git pull` (merge conflicts, or your edits overwritten), leaves a dirty tree, and vanishes on
  reclone. Rejected.
- **B — user-level overrides in the router home, with a generated effective plugin.** Store each override as
  a small layer in the home (e.g. `~/.do-it-all-claude-code/roles/<role>.json`, only the changed fields, or
  a patch). A generator merges the packaged defaults (the checkout's `plugin/agents/*.md`, now treated as
  **templates**) with the overrides into an **effective plugin directory in the router home**, and `init`
  points **both** Claude Code (`--plugin-dir`) and the daemon (`config.pluginDir`) at that generated
  directory. The generator runs on `init`, on `start`, and when `role edit` applies a change. `git pull`
  updates the templates; a regenerate re-merges, so upstream changes and your overrides both survive.
- **C — project-level overrides** (`.do-it-all-claude-code/roles/` in a repo), merged for that project only.

**Recommendation: B, with C as a later addition.** B solves the `git pull` collision (the checkout becomes
read-only templates), gives both consumers one source (the generated effective files), and reuses machinery
that already exists — `init` already chooses `--plugin-dir` and records `config.pluginDir`, and the guard
loads from `config.pluginDir`. The cost is the generator and the repoint of the plugin dir away from the
raw checkout. Whether per-project role overrides (C) are needed in 0.5.0 is an open question; the
recommendation is user-level (B) first, project-level later. (A caveat to record: when the plugin later installs from a
marketplace rather than `--plugin-dir`, this repoint must be revisited; for the current `--plugin-dir`
model, B works.)

**Which fields are safe, and which are locked or validated.**

| Field | Edit? | Rule |
|---|---|---|
| instruction body, `description` | safe | free text; it is guidance, not a capability |
| `model`, `effort`, `maxTurns` | safe | validate against known model/effort values and sane bounds |
| ladder `start` step | safe | it lives in the **preset** (`teams.yaml`), not the role file; edit it there |
| `verify` steps (commands) | editable, flagged | they **run** at verify time as you, like a project policy's `bashAllow` — "you vouch for the command"; validate they are well-formed and surface that they execute |
| `tools` | editable within a floor | may change, but **never** include `FORBIDDEN_ROLE_TOOLS` (`Agent`, `Task`, `WebFetch`, `WebSearch`); a write adding one is rejected |
| `name`, `x-router.role` | locked | identity the daemon maps on and the contract tests pin; a write that renames the role is rejected |
| scope / never-grantable paths / credential and home protection | not here | they are **not** in the role file — they are enforced in `core/security.ts` and per-subtask `[scope: …]`, so no role edit can touch them |

**Keeping the guard contract.** The contract tests (`plugin-agents.test.ts`) pin the **templates** in the
checkout, which stay unchanged, so edits to a user's overrides don't break them. At runtime the guard reads
the **effective** (generated) files; the write path and a load-time check both re-assert the floor
(forbidden tools absent, identity unchanged), so a user override cannot ship a role that weakens the guard —
an invalid effective file is refused and the previous effective file is kept.

## 4. Tests and the security review plan

**Tests.**

- **Validation**: each of `config`/`preset`/`role` rejects invalid input (unknown key, out-of-range number,
  bad YAML, a forbidden tool, a renamed role identity) and keeps the previous content; accepts valid input.
- **Atomic write + reload**: a write is atomic and `0600`; the daemon reflects it after reload; a simulated
  crash mid-write leaves the old file intact.
- **Audit**: exactly one audit line per applied change; no secret value ever appears in it.
- **Role overrides (B)**: defaults + overrides → the expected effective files; after a template change
  (simulated `git pull`) a regenerate preserves the overrides; an override that tries to add a forbidden
  tool or rename the role is refused and the floor holds on the effective files.
- **Two write front doors share one core**: the sealed (CLI) path and the cookie+CSRF (dashboard) path run
  identical validation and audit; a CLI-direct write while the daemon is down is picked up on next start.
- **Dashboard write guards** (if in 0.5.0): a write without a CSRF token, with a cross-site Origin, or with
  no session is refused; a worker-shaped request reaches no write route.
- **Contract tests still green** on the unchanged templates, plus a new runtime guard-floor assertion over
  the effective role files.

**Security review plan.**

- **Write surface**: confirm the only entries are the sealed `/router/v1/*` routes (CLI) and the
  cookie+CSRF+same-origin dashboard routes; confirm the read-only metrics surface gained no write handler.
- **Guard floor independence**: confirm no role/preset/config edit can widen the credential-file, router-home,
  never-grantable-path, secret-pattern, or forbidden-tool protections — the floor is in core and re-enforced
  on effective files and on every write.
- **Workers**: confirm a worker can reach no write path (no token to seal with, no session cookie, and the
  guard keeps it out of the home and token), and that both `.agentic-router/` and `.do-it-all-claude-code/`
  stay write-protected.
- **Integrity**: confirm validation rejects rather than clamps, writes are atomic, and a failed write leaves
  the previous content; confirm the plugin-dir repoint exposes no token and changes only the intended
  overrides.
- **Audit**: confirm completeness (one line per change) and that no secret leaks into it or the logs.

## Out of 0.5.0 (propose)

- Project-level role overrides (C), after user-level (B).
- Any interaction with a future marketplace plugin install (revisit the plugin-dir repoint then).
- Editing `daemonPort`/`proxyPort` as settings (they stay with `init`).

## Design choices (summary)

| # | Choice | Options | Recommendation |
|---|---|---|---|
| 1 | CLI edit shape | field-level / `$EDITOR` / both | **Both**: field-level `config set`, `$EDITOR` for config/presets/roles |
| 1 | Daemon picks up a change | daemon is sole writer / file-watcher | **Daemon-mediated when up**, CLI-direct when down, explicit `reload` |
| 2 | Dashboard | edit page / read-only | **Edit page**, on the same validated core as the CLI, CLI landing first (open: whether it must be in 0.5.0) |
| 3 | Where role edits live | in-checkout / home overrides + generated plugin / per-project | **Home overrides + generated effective plugin (B)**; per-project later |
| 3 | Role fields | — | body/model/effort/maxTurns/verify editable; **tools floored**, **name/role locked**; guard floor never editable |
