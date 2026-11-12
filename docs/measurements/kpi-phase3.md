# Phase 3 KPI check: router on vs off (decision 146)

Date: 2026-11-12. Lead: Sonnet 5.5, effort high, API key. The 15 bench tasks (10 custom, 5 SWE-bench
Verified), one run per cell, 30 runs, $4.69 in total.

- `direct`: plain Claude Code, no plugin (router off).
- `auto`: plugin and daemon as a user runs them: automatic triage, the lead picks the roles, default
  settings. Only the auto-release holdout is off (holdoutRate 0) so every request is routed normally.

Targets set before the run: cost per passed task at least 30% lower, pass rate no more than 5 points lower.

## Result

| | router off | router on |
|---|---|---|
| total cost | $2.81 | $1.88 |
| passed | 12 / 15 | 12 / 15 |
| cost per passed task | $0.235 | $0.156 (**-33%**) |
| lead / workers | $2.81 / – | $1.06 / $0.81 |
| wall time, all tasks | 38.8 min | 32.1 min |
| wall time without sympy | 18.1 min | 30.5 min |

Both targets are met. The same three public L3 tasks (django, sympy, pylint) failed in both arrangements.

| group | router off | router on |
|---|---|---|
| custom L1 (5) | $0.52 · 3.4 min · 5/5 | $0.27 · 4.9 min · 5/5 |
| custom L2 (3) | $0.61 · 3.8 min · 3/3 | $0.24 · 5.3 min · 3/3 |
| custom L3 (2) | $1.20 · 8.3 min · 2/2 | $1.07 · 15.3 min · 2/2 |
| public L2 (2) | $0.06 · 0.5 min · 2/2 | $0.09 · 2.0 min · 2/2 |
| public L3 (3) | $0.43 · 22.9 min · 0/3 | $0.20 · 4.7 min · 0/3 |

## What the router did

Every request was delegated. Thirteen were planned at L2 and one public L3 task (sympy) at L1; nothing
was planned at L3, as designed (automatic L3 is planned as L2). The lead used a single Haiku coder for
thirteen of the fifteen tasks. The two custom L3 tasks got an architect and two coders, one of them a
reviewer as well. No lead took a task over (no lead edits after dispatch), and no writer finished
without changing anything.

## Reading it

The saving comes from the lead not editing: on the small tasks the lead's own cost was about $0.05 per
task, against $0.06 to $0.19 when it did the work itself. On the one-file public L2 fixes the router
costs a little more, because briefing a worker costs more than the fix.

Time goes the other way. Without the sympy outlier (20.7 min when the lead worked alone), the router run
took about 70% longer: each delegation adds a worker start, and the bigger tasks add coordination. Users
who value latency over cost can set `delegateFrom` to start delegating at L2.

## Limits

One run per cell. The custom tasks were written for this project. The lead model is Sonnet only; the
decision-107 run (Opus lead, levels forced) showed a similar saving. Quality is judged by hidden tests
and SWE-bench grading only.

Raw runs: `bench/results/kpi-phase3/runs.jsonl` (not committed).
