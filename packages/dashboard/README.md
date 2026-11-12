# @agentic-router/dashboard

Read-only local web dashboard for the router. The daemon serves the built assets at
`http://127.0.0.1:<daemon port>/dashboard` behind a local session cookie (decision 132); nothing leaves
the machine. Screens: Overview (KPIs), Requests (timeline + per-request detail), Learning
(triage-vs-actual and non-binding rule suggestions), and Now (the current session's team).

## Develop

```
npm run -w @agentic-router/dashboard dev         # Vite dev server (mock data by default)
npm run -w @agentic-router/dashboard typecheck   # vue-tsc (see the TypeScript note)
npm run -w @agentic-router/dashboard build       # typecheck + vite build -> dist/
```

Data source: `VITE_USE_MOCK` defaults on, so the SPA runs and builds with sample data and no daemon.
Set `VITE_USE_MOCK=false` to call the live metrics API (`/router/v1/metrics/*`), proxied in dev to
`VITE_DAEMON_PORT` (default 8787). Every view shows an explicit loading / daemon-not-running / timeout
state and never blocks. Charts are inline SVG (no chart library).

## Dependencies

Dev-only (the built output is plain JS/CSS/HTML; the daemon serves it as static files and gains no
runtime dependency): `vue`, `vite`, `@vitejs/plugin-vue`, `vue-tsc`, and `typescript` (see below).

## TypeScript note

The monorepo root pins TypeScript 7, whose package `exports` no longer publish the `./lib/tsc` subpath
that `vue-tsc` 3.x loads, so `vue-tsc` cannot run against it. This workspace therefore pins its own
TypeScript 5.9.3 and runs `vue-tsc` through `scripts/vue-tsc-shim.cjs`, which redirects `typescript`
resolution to the local copy. When `vue-tsc` supports TypeScript 7 (or the root adopts a compatible
setup), the shim can be removed and `typecheck`/`build` can call `vue-tsc` directly.
