# Direct vs team measurement (decision 107)

Date: 2026-11-11. Lead: Opus 5.5 (effort high). API key, own budget $50, spent $25.63. 15 tasks x 3 arrangements x 1 run.
Arrangements: `direct` = Claude Code without the plugin; `team-L2` / `team-L3` = plugin + daemon with the level forced (config `forceLevel`).
Grading: hidden tests for custom tasks, SWE-bench harness (Docker) for public tasks.

## Results

| task | level | direct | team-L2 | team-L3 |
|---|---|---|---|---|
| c-l1-01 | L1 | PASS $0.15 42s | PASS $0.14 55s | PASS $0.30 90s |
| c-l1-02 | L1 | PASS $0.20 55s | PASS $0.11 56s | PASS $0.37 95s |
| c-l1-03 | L1 | PASS $0.17 48s | PASS $0.10 45s | PASS $0.25 77s |
| c-l1-04 | L1 | PASS $0.38 92s | PASS $0.12 91s | PASS $0.47 136s |
| c-l1-05 | L1 | PASS $0.22 70s | PASS $0.10 52s | PASS $0.26 73s |
| c-l2-01 | L2 | PASS $0.59 167s | PASS $0.38 183s | PASS $1.00 256s |
| c-l2-02 | L2 | PASS $0.48 120s | PASS $0.36 148s | PASS $0.62 161s |
| c-l2-03 | L2 | PASS $0.35 98s | PASS $0.32 132s | PASS $0.86 219s |
| p-l2-astropy__astropy-7671 | L2 | PASS $0.10 27s | PASS $0.11 42s | PASS $0.27 63s |
| p-l2-pydata__xarray-4966 | L2 | PASS $0.13 38s | PASS $0.13 44s | PASS $0.30 79s |
| c-l3-01 | L3 | PASS $1.12 301s | PASS $1.12 535s | PASS $2.35 563s |
| c-l3-02 | L3 | PASS $1.35 380s | PASS $1.29 707s | PASS $3.07 677s |
| p-l3-django__django-16263 | L3 | FAIL $1.30 1575s | FAIL $0.30 208s | FAIL $1.76 493s |
| p-l3-sympy__sympy-16597 | L3 | PASS $0.66 1279s | FAIL $0.15 223s | PASS $0.52 620s |
| p-l3-pylint-dev__pylint-4551 | L3 | PASS $0.57 147s | PASS $0.17 149s | PASS $0.59 130s |

## Totals

| level | direct $ / pass / min | team-L2 $ / pass / min | team-L3 $ / pass / min |
|---|---|---|---|
| L1 (5) | 1.11 / 5 / 5.1 | 0.57 / 5 / 5.0 | 1.64 / 5 / 7.8 |
| L2 (5) | 1.65 / 5 / 7.5 | 1.29 / 5 / 9.2 | 3.04 / 5 / 13.0 |
| L3 (5) | 5.00 / 4 / 61.4 | 3.03 / 3 / 30.4 | 8.29 / 4 / 41.4 |
| all | 7.77 / 14 / 74.0 | 4.89 / 13 / 44.5 | 12.97 / 14 / 62.2 |

Cheapest passing arrangement per task: team-L2 12, direct 1, team-L3 1, none 1.
Lead vs workers inside team runs: team-L2 lead $3.54 / workers $1.14; team-L3 lead $2.52 / workers $10.10.

Notes: one run per cell; with a Sonnet lead (integration rounds 3-4) delegating L0/L1 cost more than direct handling,
so the answer depends on the lead model. Public L2 tasks are small fixes (one file) despite their difficulty label.
