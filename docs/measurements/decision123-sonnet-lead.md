# Direct vs team with a Sonnet lead (decisions 123, 124)

Date: 2026-11-11. Lead: Sonnet 5.5 (effort high). API key, budget $10, spent $5.21. The 15 tasks of
[decision107-direct-vs-team.md](decision107-direct-vs-team.md) x 2 arrangements (`direct`, `team-L2`) x 1 run.
Build with step-up, Python verify and the cost fixes; team runs get the wait-for-workers instruction.
The pylint `team-L2` run first hit the harness budget stop (remaining budget below half the task cap) and was
run separately with `--cap-scale 0.4`.

## Results

| task | level | direct | team-L2 | Opus team-L2 (decision 107) |
|---|---|---|---|---|
| c-l1-01 | L1 | PASS $0.06 28s | PASS $0.06 80s | PASS $0.14 55s |
| c-l1-02 | L1 | PASS $0.06 24s | PASS $0.05 43s | PASS $0.11 56s |
| c-l1-03 | L1 | PASS $0.08 33s | PASS $0.05 43s | PASS $0.10 45s |
| c-l1-04 | L1 | PASS $0.20 69s | PASS $0.06 72s | PASS $0.12 91s |
| c-l1-05 | L1 | PASS $0.08 32s | PASS $0.05 47s | PASS $0.10 52s |
| c-l2-01 | L2 | PASS $0.25 91s | PASS $0.18 156s | PASS $0.38 183s |
| c-l2-02 | L2 | PASS $0.20 68s | PASS $0.07 95s | PASS $0.36 148s |
| c-l2-03 | L2 | PASS $0.14 56s | PASS $0.08 111s | PASS $0.32 132s |
| p-l2-astropy__astropy-7671 | L2 | PASS $0.04 17s | PASS $0.04 48s | PASS $0.11 42s |
| p-l2-pydata__xarray-4966 | L2 | PASS $0.03 11s | PASS $0.06 42s | PASS $0.13 44s |
| c-l3-01 | L3 | PASS $0.62 247s | PASS $0.27 295s | PASS $1.12 535s |
| c-l3-02 | L3 | PASS $0.82 363s | PASS $0.71 506s | PASS $1.29 707s |
| p-l3-django__django-16263 | L3 | FAIL $0.15 72s | FAIL $0.09 151s | FAIL $0.30 208s |
| p-l3-sympy__sympy-16597 | L3 | FAIL $0.33 1319s | FAIL $0.12 148s | FAIL $0.15 223s |
| p-l3-pylint-dev__pylint-4551 | L3 | FAIL $0.18 81s | FAIL $0.08 85s | PASS $0.17 149s |

## Totals

| group | direct $ / min / pass | team-L2 $ / min / pass | Opus team-L2 |
|---|---|---|---|
| custom L1 (5) | 0.48 / 3.1 / 5 | 0.28 / 4.8 / 5 | 0.57 / 5.0 / 5 |
| custom L2 (3) | 0.59 / 3.6 / 3 | 0.33 / 6.0 / 3 | 1.05 / 7.7 / 3 |
| public L2 (2) | 0.07 / 0.5 / 2 | 0.11 / 1.5 / 2 | 0.24 / 1.4 / 2 |
| custom L3 (2) | 1.44 / 10.2 / 2 | 0.98 / 13.3 / 2 | 2.40 / 20.7 / 2 |
| public L3 (3) | 0.66 / 24.5 / 0 | 0.29 / 6.4 / 0 | 0.63 / 9.7 / 1 |
| all (15) | 3.23 / 41.9 / 12 | 1.98 / 32.0 / 12 | 4.89 / 44.5 / 13 |

## Regret

Mean regret per request in USD (`triage-eval-cli.ts regret`); in brackets the 12 tasks at least one arrangement passed.

| policy | time $0/min | time $0.10/min |
|---|---|---|
| always direct | 0.086 (0.077) | 0.183 (0.041) |
| always team-L2 (Sonnet lead after decision 124) | 0.003 (0.004) | 0.035 (0.037) |
| L1 direct, L2 and up team-L2 (Sonnet lead under decision 117) | 0.016 (0.020) | 0.037 (0.040) |
| stage 1 only, uncertain as direct | 0.038 (0.017) | 0.173 (0.028) |
| stage 1 + judge bands, open as team-L2 | 0.018 (0.005) | 0.163 (0.017) |

## Findings

1. A Sonnet lead delegating an L1 task costs $0.055 (lead $0.048 + Haiku coder $0.007) against $0.095 direct.
   Decision 117 had compared Sonnet direct with an Opus lead's delegation cost (about $0.10); delegating also
   shrinks the lead's own share at the lead's price, so the right comparison is the Sonnet lead's own delegation.
   Decision 124: a Sonnet lead delegates from L1, like an Opus-class lead. Haiku and unknown leads keep L2 (not measured).
2. The cost is latency: L1 went from 37 s to 57 s on average. From L2 up the team was as fast or faster.
3. One-file public L2 fixes were cheaper direct ($0.07 vs $0.11): delegation has a fixed cost (brief + worker start).
4. The Sonnet lead failed all three public L3 tasks in both arrangements (Opus: direct 2/3, team-L2 1/3).
   In two team runs (sympy, pylint) the coder's verify passed while SWE-bench grading failed: verify on related
   tests does not catch a wrong fix, so no step-up happens. In django the lead stopped after one verify miss
   (step-up starts at two consecutive misses).
5. Limits: one run per cell; on two of the five L1 tasks direct and team-L2 are within 5%.
