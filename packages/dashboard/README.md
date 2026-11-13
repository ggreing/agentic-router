# @do-it-all-claude-code/dashboard

Read-only local web dashboard for the router. The daemon serves the built assets at
`http://127.0.0.1:<daemon port>/dashboard`; all data stays on the machine and the dashboard never writes
anything or sends anything off the device.

## Opening it

Run `do-it-all-claude-code dashboard`. The command mints a one-time login code and opens the dashboard URL with
that code in the page fragment (`…/dashboard#code=<code>`). The page exchanges the code once for an
HttpOnly, SameSite=Strict session cookie and then clears the code from the address bar. The long-lived
local token never reaches the browser, the URL, or any log; the code is single-use and expires in a
minute. If you open the page without a code and have no session yet, run the command again to get one.

Every request from the page is confined to the loopback origin: the daemon checks the `Host`, `Origin`,
and `Sec-Fetch-Site` headers and refuses anything that is not same-origin loopback, so another web page
cannot reach your data. The session cookie is required for the metrics API but not for the static page.

## Views

- **Overview** — the KPI tiles: requests handled, success rate, cost per accepted task, team fit,
  start-step fit, step-up rate, cache hit (API mode), and lead-vs-worker cost. A **cost by level** chart
  (inline SVG) and, when the status line has reported them, **subscription limits** (5-hour and 7-day
  usage with reset times). The Phase-0 off-router baseline is not measured yet, so baseline deltas read
  "pending", and cost badges mark figures that include an estimate or an unknown part.
- **Requests** — the timeline of closed requests, newest first, with keyset paging. Each row shows the
  triage level (and the final level if it changed), the outcome, lead-vs-worker and total cost, files and
  lines changed, duration, and verify failures. Click a row for its detail: the triage and plan, the
  subtasks with their steps and verdicts, the verify/review signals, and the full record. Prompt text
  appears only if `recordPrompts` was on; secrets are masked.
- **Learning** — triage-vs-actual: how often the planned level held, team fit and start-step fit, a
  per-rule table (how often the lead reinforced the team or a slot stepped up) with non-binding
  suggestions to raise a rule's level or start step, and a planned-vs-final level breakdown. Suggestions
  are shown, never applied automatically.
- **Now** — the current session: the active request's level, status, lead model, cost against budget,
  the team roles with their model/effort/step/status, and the session's subscription limits.

Each view shows an explicit loading, "router daemon not running", or timeout state and never blocks or
invents data.

## Acceptance and success (what the numbers mean)

The MVP cannot see a user's approval directly, so **"accepted" means no objection was seen**: a request
counts as accepted when, in the turns that follow, the user did not revert the change, repeat the same
request, or object to it. Because the absence of an objection is not positive confirmation — a user may
simply have moved on — **the reported success / acceptance rate is an upper bound on true acceptance**,
not an exact measure. Until the objection-detection signal lands (later in Phase 3), the dashboard uses
the router's **verify verdict** as the success proxy, which is an upper bound in the same direction: a
change that passed verification may still be wrong. Read the rates as a ceiling, and use the cost and
step-up numbers alongside them.

## Develop

```
npm run -w @do-it-all-claude-code/dashboard dev         # Vite dev server (mock data by default)
npm run -w @do-it-all-claude-code/dashboard typecheck   # vue-tsc (see the TypeScript note)
npm run -w @do-it-all-claude-code/dashboard build       # typecheck + vite build -> dist/
```

Data source: `VITE_USE_MOCK` defaults on, so the SPA runs and builds with sample data and no daemon
(the one-time-code exchange is skipped in mock mode). Set `VITE_USE_MOCK=false` to call the live metrics
API (`/router/v1/metrics/*`), proxied in dev to `VITE_DAEMON_PORT` (default 8787). Charts are inline SVG
(no chart library).

## Dependencies

Dev-only (the built output is plain JS/CSS/HTML; the daemon serves it as static files and gains no
runtime dependency): `vue`, `vite`, `@vitejs/plugin-vue`, `vue-tsc`, and `typescript` (see below).

## TypeScript note

The monorepo root pins TypeScript 7, whose package `exports` no longer publish the `./lib/tsc` subpath
that `vue-tsc` 3.x loads, so `vue-tsc` cannot run against it. This workspace therefore pins its own
TypeScript 5.9.3 and runs `vue-tsc` through `scripts/vue-tsc-shim.cjs`, which redirects `typescript`
resolution to the local copy. When `vue-tsc` supports TypeScript 7 (or the root adopts a compatible
setup), the shim can be removed and `typecheck`/`build` can call `vue-tsc` directly.
