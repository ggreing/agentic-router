# Guard end-to-end check

Checks the subagent guard (`plugin/hooks/guard.mjs`) the way it really runs: as a `PreToolUse` hook of a
real Claude Code, for a real router coder subagent, with the router daemon writing the scope record.

**No API call is made and nothing is billed.** The model is played by a local fake (`fake.mjs`) that
listens on 127.0.0.1 only. Claude Code runs with a fresh temp config directory (no login) and a dummy key
that only the fake accepts. The daemon runs in a temp router home, and the subagent works in a temp
fixture repository. Your own `~/.claude` and `~/.agentic-router` are not read or changed.

## Run

```
node scripts/guard-e2e/run.mjs              # both scenarios
node scripts/guard-e2e/run.mjs --only=plain
node scripts/guard-e2e/run.mjs --selftest   # everything except Claude Code itself
```

Needs the `claude` executable on `PATH` (or `CLAUDE_BIN=<path>`), `git`, and `npm ci` done in this
repository. On Windows use Git Bash. A run takes under a minute per scenario. The exit code is 1 when a
step did not end as expected.

Results are written to `scripts/guard-e2e/results/` (ignored by git): `summary.json`, one
`run-<scenario>.json` with every step's tool result and what the hook saw, and `requests.jsonl`.

## What it checks

The scripted lead dispatches one coder with `[scope: src/**]`. The coder then issues the tool calls listed
in `steps()` in `run.mjs`, one per turn. Each step carries a comment naming the class of bypass it covers.

| Expectation | Meaning |
|---|---|
| `deny` | The tool result carries the guard's `[router]` refusal. |
| `pass` | The guard does not refuse. Claude Code's own permission rules decide, so the call may run or be declined. |
| `ran` | The call really ran. |

Two scenarios:

- **plain**: `--allowedTools Agent`. Build and test commands are declined by Claude Code, not by the guard.
- **allowed**: adds `Bash(npm test)`, `Bash(npm run *)` and `Bash(cat *)`. `npm test` and `npm run build`
  must run; `npm run env` and `cat .env` must still be refused, which shows that a guard deny wins over an
  allow rule.

`summary.json` also records the keys of the real hook input, so a change in what Claude Code sends to
hooks shows up here before it shows up as a wrong guard decision.

## When to run it

After any change to `plugin/hooks/guard.mjs`, `plugin/hooks/hooks.json`, the scope records the daemon
writes, or the agent definitions in `plugin/agents/`, and after a Claude Code upgrade. The unit tests
(`packages/adapter-claude-code/test/guard*.test.ts`) cover the decisions; this covers the wiring.

## Adding a step

Add it to `steps()` with a comment that names the class it covers. Use only paths inside the fixture or
the temp router home, and only `127.0.0.1` or `*.invalid` hosts, so that a step is harmless even when the
guard fails to refuse it.

## Files

- `run.mjs`: fixture, daemon, scenarios, grading.
- `fake.mjs`: the fake upstream and the script of the lead and the coder.
- `key-helper.mjs`: prints the dummy key.
- `probe/`: a second plugin whose hooks only log the shape of each hook input and never answer.
