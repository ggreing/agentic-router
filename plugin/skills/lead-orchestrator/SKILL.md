---
name: lead-orchestrator
description: Mandatory whenever your context contains a line starting "[agentic-router] level …" — routing is ON and you are the lead. At level L0 the lead makes the small change itself (the router only records it); at L1 and above the lead delegates to the team instead of editing, stays light, and does not read source files to plan. Covers the L0/L1+ split, keeping the lead light, the exact Agent call shape, write scopes, the worktree rule, trusting the router's verify result, step changes, HITL, and merging.
---

# Lead orchestrator

Routing is ON when your context holds a brief like:

```
[agentic-router] level L2 (source=rule, confidence=0.72): <one line>
team preset L2: architect x1 @s3 (model=sonnet, effort=medium); coder x2 @s1 (model=haiku, effort=low); reviewer x1 @s3 (model=sonnet, effort=medium); tester x1 @s1 (model=haiku, effort=low). budget $5.
Routing is ON for this request. You are the lead: read only what you need to plan, then delegate.
Do not edit or write files yourself (unless the user explicitly asks you to); the team below does the changes.
…
```

You are the **lead** (the main session). **The injected brief is authoritative** — do what it tells you for this request, rather than deciding from the level number:

- If the brief says to **handle it yourself** (the lead-direct presets — L0 and L1 by default, changeable per level in `teams.yaml` with `lead_direct` — the brief reads "handle it yourself directly, without subagents"), make the change **yourself**, directly and minimally. Don't build a team, and don't explore beyond what the change needs. The router only records the request. The rest of this skill is for the delegating case.
- If the brief gives you a **team** (it lists roles with their `model`/`effort` and asks you to call the Agent tool), **delegate; do not edit or write files yourself** (unless the user explicitly asks you to). Keep your own work small: every call you make re-reads your whole context at the lead model's price. **Do not open or read source files to plan** — hand the user's request, with the files and symbols it names, to the worker as the spec, and let the worker read and investigate the code. Use at most one quick search only if you cannot tell which files are involved.

### When the brief says the size is uncertain (decisions 104–113)

Sometimes the brief says the router **could not tell the size** of the request from its wording: it has you start directly but gives a rubric and the team's Agent-call values. Judge it yourself by that rubric — do not ask the router again:

- **Switch to the team** only if the change needs edits in **4 or more files**, or in **2 or more modules/layers**, or a design decision first (a new public API, schema, or data model). To switch, just call the Agent tool once per subtask with exactly the values the brief lists; the router re-plans this request at your first Agent call, and from then on you delegate per this skill. Don't send a separate "I'm escalating" message — the call is the switch.
- **If the brief offers both an L2 and an L3 team** (it lists two teams, "L2 team …" and "L3 team …"), use the **L2** team unless the change is clearly beyond it — **a new service or subsystem, an architecture change, a redesign that cuts across layers**, or edits in **10 or more files**. Only then use the L3 team, and make your **first** call the role the brief names for it (its architect). The router reads the level from that first call: the L3 team's architect, coder or reviewer signals L3, and any other first call is treated as L2. When unsure between the two, use **L2**.
- **Otherwise handle it yourself**, minimally. Don't switch for something you can finish in a few edits.
- **Don't explore just to decide.** Looking at one or two files to gauge the scope is fine; opening many files to plan is not — that is the lead cost the router is trying to avoid.

The injected brief already names the roles and the exact `model`/`effort` for each; this skill is the full procedure behind it. If no `[agentic-router] level …` line is present, routing is off (daemon down) — just do the work yourself.

## The three steps

1. **Split** the request into subtasks `A`, `B`, … (a single subtask `A` is fine for a small change). Give each a short ID, unique within this request, and a **write scope**: the repo-relative globs it may edit. Keep scopes disjoint across parallel subtasks so two workers never touch the same file. Build each subtask's spec from the user's request and the files/symbols it names — **not** from reading the source yourself.
2. **Call the Agent tool once per subtask**, with exactly the `subagent_type`, `model`, and `effort` the brief gives for that role (don't pick your own — a hook blocks a call whose model/effort doesn't match the ledger step). The prompt's first line is `[subtask:<ID>]`, the second `[scope: <globs>]`, then the spec (goal, the named files/symbols, acceptance check).
3. **Wait** for the results, then merge (if needed) and answer the user. Agent calls run **asynchronously**: each subagent's result arrives later as a `<task-notification>` delivered as a new message, carrying the subtask's report **and the router's verify result**. The router has already run build, typecheck, lint and tests for each subtask and put the outcome in the notification — **trust it; do not re-run the build or tests yourself**. Do not merge, and do not tell the user the work is done, until a task-notification has arrived for **every** subtask you launched. Confirm the edits landed with a single `git diff --stat`. Handle verify blocks, step changes, and HITL as below.

### Agent call examples

**Default — a writer that runs alone** edits the user's working tree directly. Do **not** pass `isolation`:

```
Agent(
  subagent_type: "agentic-router:coder",
  description: "Subtask A: fix off-by-one in paginate()",
  model: "haiku",
  effort: "low",
  prompt: """
[subtask:A]
[scope: src/pagination/**, test/pagination/**]
Goal: paginate() returns the last page when total % size === 0.
Files: src/pagination/paginate.ts (+ its test).
Acceptance: npm test passes, including a new case for an exact-multiple total.
"""
)
```

**Parallel — two or more writers at the same time** each get an isolated git worktree, so add `isolation: "worktree"` to every one of them and launch them in a single message:

```
Agent(subagent_type: "agentic-router:coder", description: "Subtask A", model: "haiku", effort: "low",
      isolation: "worktree",
      prompt: "[subtask:A]\n[scope: src/api/**]\n…")
Agent(subagent_type: "agentic-router:coder", description: "Subtask B", model: "haiku", effort: "low",
      isolation: "worktree",
      prompt: "[subtask:B]\n[scope: src/web/**]\n…")
```

- `subagent_type` is `agentic-router:<role>` — one of `agentic-router:architect`, `agentic-router:ui-designer`, `agentic-router:coder`, `agentic-router:reviewer`, `agentic-router:tester`.
- Line 2 `[scope: …]` sets the write scope. If you omit it, the whole repository is writable and only protected paths (`.env`, CI config, `.claude/`, `.git/`) are blocked — prefer to always set it.
- A read-only role (reviewer, architect reviewing) still gets `[subtask:<ID>]`; its scope may be empty, and it never needs `isolation`.
- **`isolation` rule (decision 83):** pass `isolation: "worktree"` **only** when two or more writers run concurrently; a writer that runs alone gets **no** `isolation` and edits the working tree directly (no merge step for it). Keep concurrent scopes disjoint.
- Agent calls run **asynchronously by default** — you don't need to set `run_in_background`. Each subagent's result returns later as a `<task-notification>` (see step 3). The router records each subtask's cost from the subagent's own transcript, so you never manage usage yourself.
- For **L2+**, have the `architect` write the subtask specs first and approve them before you run workers. Before launching concurrent worktree writers, if the working tree has uncommitted changes, ask the user whether to snapshot-commit or run sequentially (end that question with the HITL marker — see below).

## Verify and adjust — handled for you

When a subagent finishes, the daemon runs its verify commands and scope check in its working directory (its isolated worktree when it ran with `isolation: "worktree"`, otherwise the working tree) and tells you the outcome; you don't score it yourself.

- If a subagent is **blocked from stopping** with a verify reason, it keeps working in the same context to fix the problem — let it finish; don't re-call it.
- If the router reports a subtask **stepped up** (missed twice), re-call it as a *new* subagent at the `model`/`effort` the router now gives, and include the previous failure in the handoff brief.
- A worker that needs to edit outside its scope says so in its report's "scope request" line. Only widen scope when the work truly needs it; widening into a protected path (`.env`, CI, `.claude/`, `.git/`) requires user confirmation.

## Integrate (only concurrent worktree writers)

A writer that ran **alone** already edited the working tree — there is nothing to merge. Only the writers you launched concurrently with `isolation: "worktree"` need integrating. Merge their branches in completion order:

1. Confirm the writer committed its work to its branch `worktree-agent-<agentId>` (the task-notification reports the branch). If it did not commit, re-call it to commit.
2. `git merge --no-ff worktree-agent-<agentId>`.
3. On a conflict, re-call that writer with the conflict details to resolve it, then merge again.
4. After a clean merge, `git worktree remove <path>` and delete the branch.

Then run a final check. Keep each subagent's report as the structured summary it returned — don't paste repository contents the subagent quoted back into your own context unchanged.

## Before you report completion

Before you tell the user the request is finished:

- Confirm you received a task-notification for **every** subtask, and that each one's injected **verify result passed** and reported no unmet "scope request". Trust that result — do not re-run the build or tests to double-check.
- A **concurrent worktree writer's** edits are **not** in the user's working tree until you merge its branch (above). A writer that ran **alone** edited the working tree directly, so its edits are already there.
- Confirm the edits landed with a single `git diff --stat` (not a full `git diff` or a test run): the expected files changed and nothing is still stranded in an unmerged worktree branch.
- If a change is only in a worktree branch, it is **not** done: merge it first, then re-check. Never report success based solely on a worker's self-report.

## Asking the user (HITL)

Whenever you ask the user to choose or confirm — a HITL stop, a scope-widening confirmation, a snapshot-vs-sequential choice, a budget overrun — put this marker **exactly**, on its own, as the last line of your message:

```
[router:awaiting-user]
```

The user's next message is then treated as the answer to this request, not a new request. To continue a stopped subtask afterwards, the user runs `/router resume` (see the `router` skill).

## Router tools (optional)

The router exposes five MCP tools for **you, the lead** (never the workers). Tool search defers them, so call them **by name**; they are optional — the hooks are the system of record and everything works if you never call one, and if the daemon is down a tool just returns an error and you continue.

- **`router_get_plan`** — re-read the current plan (level, team, each slot's model/effort/step, the subtasks and their verify results). Use it after a compaction or resume, or before you dispatch a subtask again.
- **`router_report_triage`** — report your own size judgement (`direct`/`team`, level, files, confidence) **before** the first subtask is dispatched. The router records it and re-plans upward if you judge the request larger than planned.
- **`router_report_result`** — accept or reject a finished subtask. When a reviewer or tester judged it, pass their verdict on: `by: "reviewer"` (or `"tester"`), `bySubtaskId` = the reviewer's subtask ID, and `margin` exactly as their report says (`easy` or `normal`). Do not set `margin: "easy"` on your own judgement; it is not counted. Two easy results in a row let the router run that slot one step lower. Use `reject` when the result is wrong even though verify passed; a reject counts as one failure of that slot.
- **`router_request_escalation`** — raise a finished subtask's slot one step when verify passed but the result is wrong. Granted at once on a reviewer/tester reject; on your judgement alone once per slot within a model tier, otherwise it answers `needs_user` (ask the user, then call again with `userConfirmed: true`).
- **`router_request_scope`** — change a pending/running subtask's write paths (add/remove globs). A protected path needs the user's confirmation first; `.git`, `.agentic-router` and credential paths are never grantable.
