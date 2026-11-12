<!--
Use a Conventional Commits PR title (e.g. `feat(dashboard): add routing panel`, `fix(daemon): …`).
PRs are squash-merged, so the title becomes the commit message. See CONTRIBUTING.md.
-->

## What and why

What changed, and why. Keep the PR focused.

## Checklist

Before every PR (see CONTRIBUTING.md):

- [ ] `npm test` passes (the whole suite is green).
- [ ] `npx tsc -b` passes.
- [ ] `npm run build:dashboard` passes (the dashboard type-check and build).
- [ ] Behavior changes come with unit tests.

If this PR changes the **subagent guard** (`plugin/hooks/guard.mjs`, `plugin/hooks/hooks.json`, the scope records, or `plugin/agents/`):

- [ ] `node --test packages/adapter-claude-code/test/guard.test.ts packages/adapter-claude-code/test/guard-hardening.test.ts` passes (a regression case is added for any new bypass).
- [ ] `node scripts/guard-e2e/run.mjs` passes — every step ends as expected.

If this PR changes **triage rules, team presets, or the ladder**:

- [ ] Benchmark results attached: ran the benchmark in `bench/` and the scorer (`packages/core/src/triage-eval-cli.ts`), with the numbers in the PR, and any metric that got worse explained.

Dependencies and security:

- [ ] No new runtime or build dependency — or, if there is one, it is called out for security review with its name, version, size, whether it has native code, and its transitive count.
- [ ] The security model is not weakened: no component reads subscription credentials, keys stay only in the OS keychain, and the write-scope guard still blocks out-of-scope writes.
