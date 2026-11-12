# Contributing to Agentic Router Proxy

> **Draft — to be finalized before release.**

Thanks for your interest. This project is pre-release; interfaces and defaults may still change. Please
open an issue to discuss anything substantial before you start.

## What you can contribute

- **Role files** — the subagent definitions in `plugin/agents/*.md` (tools, model/effort, verify steps).
- **Team presets** — the per-level teams and ladder start steps (`presets/`).
- **Triage rules** — the stage-1 rules, including the Japanese and Chinese rule sets.
- **Client adapters** — translating another client's events to the router's neutral event model
  (`packages/adapter-*`).
- **The dashboard** — the read-only local web UI (`packages/dashboard`), including UI translations.
- **Docs and translations** — the README and these guides, in any of the supported languages.

## Development setup

- **Node 24+**. On **Windows**, use **Git Bash** (several scripts assume a POSIX shell).
- Install: `npm ci`.
- Before every PR, all of these must pass:
  - `npm test` — the unit tests (`node --test`).
  - `npx tsc -b` — the TypeScript build.
  - `npm run -w @agentic-router/dashboard build` — the dashboard type-check and build.
- Line endings are **LF**, enforced by `.gitattributes` (CRLF only for Windows-native `.ps1`/`.cmd`/`.bat`).

## Pull requests

- **Unit tests are required** for behavior changes. Keep the whole suite green.
- A PR that changes **triage rules, team presets, or the ladder must attach benchmark results.** Run the
  benchmark in `bench/` and the scorer (`packages/core/src/triage-eval-cli.ts`), include the numbers, and
  explain any metric that gets worse and why the change is still worth it.
- Keep PRs focused; describe what changed and why.

## Code style and rules

- **TypeScript strict.** Match the surrounding style — there is **no ESLint or Prettier yet** (deferred
  until after release to avoid a repo-wide reformat during development), so follow the conventions already
  in the file you are editing rather than introducing a formatter.
- **Dependencies:** adding or upgrading a runtime or build dependency gets a **security review**. Prefer
  the standard library; list a new dependency's name, version, size, whether it has native code, and its
  transitive count in the PR.
- Do not weaken the security model: no component reads subscription credentials, keys live only in the OS
  keychain, and the subagent write-scope guard must keep blocking out-of-scope writes.

## Commit messages

- Use **[Conventional Commits](https://www.conventionalcommits.org/)** for the **PR title** (for example
  `feat(dashboard): add routing panel` or `fix(daemon): …`). PRs are **squash-merged**, so the PR title
  becomes the commit message.
