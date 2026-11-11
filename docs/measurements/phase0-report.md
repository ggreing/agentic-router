# Phase 0 benchmark report

runs: 120, total cost: $22.96

## Cost per completed task (USD) and pass rate, by level

| config | L0 $/done (pass) | L1 $/done (pass) | L2 $/done (pass) | L3 $/done (pass) | all $/done | coef vs s1 | vs baseline |
|---|---|---|---|---|---|---|---|
| s1 | 0.001 (5/5) | 0.005 (5/5) | 0.011 (4/5) | — (0/5) | 0.008 | 1.00 | 0.02 |
| s2 | 0.002 (5/5) | 0.010 (5/5) | 0.017 (5/5) | — (0/5) | 0.023 | 3.05 | 0.07 |
| s3 | 0.014 (5/5) | 0.046 (5/5) | 0.097 (5/5) | — (0/5) | 0.069 | 9.13 | 0.20 |
| s4 | 0.021 (5/5) | 0.095 (5/5) | 0.155 (5/5) | — (0/5) | 0.116 | 15.29 | 0.34 |
| s5 | 0.058 (5/5) | 0.266 (5/5) | 0.359 (5/5) | 1.196 (2/5) | 0.342 | 44.89 | 1.00 |
| s6 | 0.094 (5/5) | 0.362 (5/5) | 0.665 (5/5) | 2.076 (4/5) | 0.732 | 96.20 | 2.14 |

`$/done` = total cost of all runs ÷ number of passed runs (failed attempts are charged). `coef vs s1` is the effective cost coefficient of spec 3.5.