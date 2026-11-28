## States by engine, corpus and caller

| engine | corpus | caller | affected cells | improves | neutral | regresses | safe | loss | unresolved | p50 T/C | p95 T/C |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pg15-v087 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg15-v087 | latent-375000 | untrusted | 42 | 24 | 18 | 0 | 40 | 1 | 1 | 0.26 | 0.29 |
| pg15-v087 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pg15-v087 | latent-75000 | untrusted | 42 | 6 | 25 | 11 | 42 | 0 | 0 | 0.72 | 0.88 |
| pg16-v087 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pg16-v087 | latent-375000 | untrusted | 42 | 24 | 18 | 0 | 40 | 1 | 1 | 0.28 | 0.34 |
| pg16-v087 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.01 | 1.02 |
| pg16-v087 | latent-75000 | untrusted | 42 | 5 | 26 | 11 | 42 | 0 | 0 | 0.75 | 0.93 |
| pg17-v074 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg17-v074 | latent-375000 | untrusted | 42 | 2 | 36 | 4 | 42 | 0 | 0 | 0.77 | 0.99 |
| pg17-v074 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg17-v074 | latent-75000 | untrusted | 42 | 6 | 36 | 0 | 42 | 0 | 0 | 0.61 | 0.95 |
| pg17-v087 | latent-15000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.01 | 1.00 |
| pg17-v087 | latent-15000 | untrusted | 60 | 7 | 47 | 6 | 60 | 0 | 0 | 1.02 | 0.98 |
| pg17-v087 | latent-1500000 | trusted | 54 | 4 | 50 | 0 | 54 | 0 | 0 | 0.98 | 1.00 |
| pg17-v087 | latent-1500000 | untrusted | 60 | 17 | 43 | 0 | 60 | 0 | 0 | 0.51 | 0.52 |
| pg17-v087 | latent-375000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.01 | 1.01 |
| pg17-v087 | latent-375000 | untrusted | 60 | 33 | 27 | 0 | 58 | 1 | 1 | 0.27 | 0.30 |
| pg17-v087 | latent-75000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.00 | 1.01 |
| pg17-v087 | latent-75000 | untrusted | 60 | 12 | 37 | 11 | 60 | 0 | 0 | 0.71 | 0.86 |
| pg17-v087 | wiki-375000 | trusted | 54 | 0 | 54 | 0 | 54 | 0 | 0 | 1.01 | 1.01 |
| pg17-v087 | wiki-375000 | untrusted | 60 | 25 | 35 | 0 | 60 | 0 | 0 | 0.45 | 0.41 |
| pg18-v087 | latent-375000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pg18-v087 | latent-375000 | untrusted | 42 | 24 | 18 | 0 | 40 | 1 | 1 | 0.30 | 0.37 |
| pg18-v087 | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pg18-v087 | latent-75000 | untrusted | 42 | 5 | 26 | 11 | 42 | 0 | 0 | 0.75 | 0.93 |
| pglite | latent-15000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.01 |
| pglite | latent-15000 | untrusted | 42 | 5 | 28 | 9 | 42 | 0 | 0 | 1.11 | 1.08 |
| pglite | latent-75000 | trusted | 36 | 0 | 36 | 0 | 36 | 0 | 0 | 1.00 | 1.00 |
| pglite | latent-75000 | untrusted | 42 | 8 | 24 | 10 | 42 | 0 | 0 | 0.67 | 0.86 |

## The rule's flip side in stage 1

| engine | corpus | cells the rule flips | improves | loss, unresolved or regresses | lowest recall interval end | median p50 T/C of improving cells | range |
|---|---|---|---|---|---|---|---|
| pg15-v087 | latent-375000 | 26 | 12 | 0 | 0.000 | 0.10 | 0.03 to 0.60 |
| pg16-v087 | latent-375000 | 26 | 12 | 0 | 0.000 | 0.12 | 0.04 to 0.63 |
| pg17-v074 | latent-375000 | 26 | 2 | 0 | 0.000 | 0.04 | 0.04 to 0.04 |
| pg17-v087 | latent-1500000 | 38 | 13 | 0 | 0.000 | 0.04 | 0.01 to 0.78 |
| pg17-v087 | latent-375000 | 38 | 17 | 0 | 0.000 | 0.12 | 0.03 to 0.66 |
| pg17-v087 | wiki-375000 | 38 | 14 | 0 | 0.000 | 0.13 | 0.06 to 0.69 |
| pg18-v087 | latent-375000 | 26 | 12 | 0 | 0.000 | 0.11 | 0.05 to 0.62 |

## Cells that lose, stay unresolved or regress

| cell | recall | latency | p50 C (ms) | p50 T (ms) | p50 T/C | p95 T/C | recall T − C | re-run (seed 29819) |
|---|---|---|---|---|---|---|---|---|
| pg17-v074 latent 375000 clustered untrusted where-5 k20 warm | safe | regresses | 448.3 | 262.2 | 0.58 | 1.24 | 0.000 | safe, regresses |
| pg17-v074 latent 375000 clustered untrusted scope-3 k20 warm | safe | regresses | 93.8 | 94.2 | 1.00 | 1.34 | 0.000 | safe, regresses |
| pg17-v074 latent 375000 independent untrusted scope-3 k20 warm | safe | regresses | 96.7 | 96.4 | 1.00 | 1.35 | 0.000 | safe, regresses |
| pg17-v087 latent 15000 independent untrusted type-50 k20 warm | safe | regresses | 161.2 | 181.1 | 1.12 | 1.17 | 0.043 | safe, regresses |
| pg17-v087 latent 15000 independent untrusted type-50 k50 warm | safe | regresses | 69.5 | 92.4 | 1.33 | 0.94 | 0.131 | safe, regresses |
| pg17-v087 latent 15000 independent untrusted date-50 k50 warm | safe | regresses | 72.0 | 92.6 | 1.29 | 1.13 | 0.128 | safe, regresses |
| pg17-v087 latent 15000 independent untrusted where-50 k20 warm | safe | regresses | 61.9 | 116.8 | 1.89 | 1.10 | 0.062 | safe, regresses |
| pg17-v087 latent 15000 independent untrusted where-50 k50 warm | safe | regresses | 70.8 | 88.5 | 1.25 | 1.17 | 0.119 | safe, regresses |
| pg17-v087 latent 15000 clustered untrusted type-50 k20 warm | safe | regresses | 55.1 | 99.6 | 1.81 | 0.98 | 0.060 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted type-20 k20 warm | safe | regresses | 94.2 | 168.2 | 1.79 | 0.92 | 0.013 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted where-20 k20 warm | safe | regresses | 87.8 | 165.7 | 1.89 | 0.98 | 0.010 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted type-50 k20 warm | safe | regresses | 96.8 | 25.0 | 0.26 | 1.31 | 0.000 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted where-50 k20 warm | safe | regresses | 82.1 | 23.5 | 0.29 | 1.61 | 0.001 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted type-20 k20 cold | safe | regresses | 380.4 | 2200.7 | 5.78 | 1.37 | 0.008 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted date-20 k20 cold | safe | regresses | 382.8 | 317.0 | 0.83 | 1.60 | 0.002 | safe, regresses |
| pg17-v087 latent 75000 independent untrusted where-20 k20 cold | safe | regresses | 359.1 | 2100.9 | 5.85 | 1.40 | 0.005 | safe, regresses |
| pg17-v087 latent 75000 clustered untrusted type-20 k20 warm | safe | regresses | 97.8 | 190.9 | 1.95 | 0.98 | 0.019 | safe, regresses |
| pg17-v087 latent 75000 clustered untrusted where-20 k20 warm | safe | regresses | 94.4 | 195.5 | 2.07 | 1.01 | 0.012 | safe, regresses |
| pg17-v087 latent 75000 clustered untrusted type-50 k20 warm | safe | regresses | 92.0 | 22.1 | 0.24 | 1.34 | 0.000 | safe, regresses |
| pg17-v087 latent 75000 clustered untrusted where-50 k20 warm | safe | regresses | 77.6 | 22.0 | 0.28 | 1.67 | 0.001 | safe, regresses |
| pg17-v087 latent 375000 independent untrusted type-20 k20 cold | unresolved | neutral | 891.0 | 534.6 | 0.60 | 2.72 | -0.018 | not re-run |
| pg17-v087 latent 375000 independent untrusted where-20 k20 cold | loss | neutral | 884.8 | 575.6 | 0.65 | 3.57 | -0.042 | loss, regresses |
| pg15-v087 latent 375000 independent untrusted type-20 k20 cold | unresolved | neutral | 977.4 | 569.3 | 0.58 | 3.15 | -0.018 | not re-run |
| pg15-v087 latent 375000 independent untrusted where-20 k20 cold | loss | neutral | 1007.4 | 602.8 | 0.60 | 3.36 | -0.040 | loss, regresses |
| pg15-v087 latent 75000 independent untrusted type-20 k20 warm | safe | regresses | 104.5 | 190.4 | 1.82 | 0.90 | 0.014 | safe, regresses |
| pg15-v087 latent 75000 independent untrusted where-20 k20 warm | safe | regresses | 97.3 | 187.0 | 1.92 | 0.97 | 0.011 | safe, regresses |
| pg15-v087 latent 75000 independent untrusted type-50 k20 warm | safe | regresses | 112.0 | 22.1 | 0.20 | 1.15 | 0.001 | safe, regresses |
| pg15-v087 latent 75000 independent untrusted where-50 k20 warm | safe | regresses | 94.2 | 21.0 | 0.22 | 1.41 | 0.001 | safe, regresses |
| pg15-v087 latent 75000 independent untrusted type-20 k20 cold | safe | regresses | 433.0 | 2130.0 | 4.92 | 1.27 | 0.017 | safe, regresses |
| pg15-v087 latent 75000 independent untrusted date-20 k20 cold | safe | regresses | 424.2 | 348.6 | 0.82 | 1.44 | 0.000 | safe, regresses |
| pg15-v087 latent 75000 independent untrusted where-20 k20 cold | safe | regresses | 404.7 | 2098.2 | 5.18 | 1.28 | 0.007 | safe, regresses |
| pg15-v087 latent 75000 clustered untrusted type-20 k20 warm | safe | regresses | 102.4 | 193.0 | 1.89 | 0.86 | 0.020 | safe, regresses |
| pg15-v087 latent 75000 clustered untrusted where-20 k20 warm | safe | regresses | 92.5 | 194.0 | 2.10 | 0.98 | 0.016 | safe, regresses |
| pg15-v087 latent 75000 clustered untrusted type-50 k20 warm | safe | regresses | 107.5 | 19.4 | 0.18 | 1.17 | 0.000 | safe, regresses |
| pg15-v087 latent 75000 clustered untrusted where-50 k20 warm | safe | regresses | 93.4 | 20.1 | 0.21 | 1.48 | 0.001 | safe, regresses |
| pg16-v087 latent 375000 independent untrusted type-20 k20 cold | unresolved | neutral | 894.1 | 536.6 | 0.60 | 3.43 | -0.020 | not re-run |
| pg16-v087 latent 375000 independent untrusted where-20 k20 cold | loss | neutral | 890.2 | 576.4 | 0.65 | 3.67 | -0.048 | loss, regresses |
| pg16-v087 latent 75000 independent untrusted type-20 k20 warm | safe | regresses | 96.8 | 189.3 | 1.96 | 1.01 | 0.012 | safe, regresses |
| pg16-v087 latent 75000 independent untrusted where-20 k20 warm | safe | regresses | 90.6 | 190.5 | 2.10 | 1.14 | 0.015 | safe, regresses |
| pg16-v087 latent 75000 independent untrusted type-50 k20 warm | safe | regresses | 105.6 | 22.2 | 0.21 | 1.27 | 0.000 | safe, regresses |
| pg16-v087 latent 75000 independent untrusted where-50 k20 warm | safe | regresses | 88.1 | 22.4 | 0.25 | 1.59 | 0.000 | safe, regresses |
| pg16-v087 latent 75000 independent untrusted type-20 k20 cold | safe | regresses | 408.6 | 1983.5 | 4.85 | 1.26 | 0.007 | safe, regresses |
| pg16-v087 latent 75000 independent untrusted date-20 k20 cold | safe | regresses | 380.3 | 321.5 | 0.85 | 1.28 | 0.000 | safe, regresses |
| pg16-v087 latent 75000 independent untrusted where-20 k20 cold | safe | regresses | 368.8 | 1883.8 | 5.11 | 1.26 | 0.007 | safe, regresses |
| pg16-v087 latent 75000 clustered untrusted type-20 k20 warm | safe | regresses | 95.9 | 197.2 | 2.06 | 1.00 | 0.018 | safe, regresses |
| pg16-v087 latent 75000 clustered untrusted where-20 k20 warm | safe | regresses | 87.2 | 200.8 | 2.30 | 1.06 | 0.015 | safe, regresses |
| pg16-v087 latent 75000 clustered untrusted type-50 k20 warm | safe | regresses | 99.1 | 21.6 | 0.22 | 1.30 | 0.000 | safe, regresses |
| pg16-v087 latent 75000 clustered untrusted where-50 k20 warm | safe | regresses | 87.5 | 21.3 | 0.24 | 1.63 | 0.001 | safe, regresses |
| pg18-v087 latent 375000 independent untrusted type-20 k20 cold | unresolved | neutral | 900.0 | 573.0 | 0.64 | 3.60 | -0.020 | not re-run |
| pg18-v087 latent 375000 independent untrusted where-20 k20 cold | loss | neutral | 883.9 | 589.3 | 0.67 | 3.81 | -0.052 | loss, regresses |
| pg18-v087 latent 75000 independent untrusted type-20 k20 warm | safe | regresses | 92.9 | 189.2 | 2.04 | 1.03 | 0.012 | safe, regresses |
| pg18-v087 latent 75000 independent untrusted where-20 k20 warm | safe | regresses | 86.9 | 187.9 | 2.16 | 1.12 | 0.014 | safe, regresses |
| pg18-v087 latent 75000 independent untrusted type-50 k20 warm | safe | regresses | 101.3 | 20.4 | 0.20 | 1.28 | 0.001 | safe, regresses |
| pg18-v087 latent 75000 independent untrusted where-50 k20 warm | safe | regresses | 87.7 | 20.4 | 0.23 | 1.60 | 0.000 | safe, regresses |
| pg18-v087 latent 75000 independent untrusted type-20+date-50 k20 warm | safe | regresses | 141.1 | 120.0 | 0.85 | 1.15 | 0.086 | safe, regresses |
| pg18-v087 latent 75000 independent untrusted type-20 k20 cold | safe | regresses | 385.7 | 1939.0 | 5.03 | 1.24 | 0.007 | safe, regresses |
| pg18-v087 latent 75000 independent untrusted where-20 k20 cold | safe | regresses | 353.6 | 1900.3 | 5.37 | 1.24 | 0.005 | safe, regresses |
| pg18-v087 latent 75000 clustered untrusted type-20 k20 warm | safe | regresses | 93.9 | 199.2 | 2.12 | 0.97 | 0.018 | safe, regresses |
| pg18-v087 latent 75000 clustered untrusted where-20 k20 warm | safe | regresses | 87.7 | 198.6 | 2.26 | 1.10 | 0.013 | safe, regresses |
| pg18-v087 latent 75000 clustered untrusted type-50 k20 warm | safe | regresses | 97.4 | 19.2 | 0.20 | 1.33 | 0.000 | safe, regresses |
| pg18-v087 latent 75000 clustered untrusted where-50 k20 warm | safe | regresses | 82.9 | 19.8 | 0.24 | 1.69 | 0.001 | safe, regresses |
| pglite latent 15000 independent untrusted date-20 k20 warm | safe | regresses | 49.5 | 64.8 | 1.31 | 1.28 | 0.145 | safe, regresses |
| pglite latent 15000 independent untrusted where-20 k20 warm | safe | regresses | 49.8 | 62.2 | 1.25 | 1.24 | 0.140 | safe, regresses |
| pglite latent 15000 independent untrusted type-50 k20 warm | safe | regresses | 144.0 | 260.1 | 1.81 | 1.64 | 0.054 | safe, regresses |
| pglite latent 15000 independent untrusted where-50 k20 warm | safe | regresses | 59.1 | 144.9 | 2.45 | 1.64 | 0.067 | safe, regresses |
| pglite latent 15000 clustered untrusted type-20 k20 warm | safe | regresses | 49.1 | 59.2 | 1.21 | 1.26 | 0.137 | safe, regresses |
| pglite latent 15000 clustered untrusted date-20 k20 warm | safe | regresses | 53.4 | 65.0 | 1.22 | 1.22 | 0.137 | safe, regresses |
| pglite latent 15000 clustered untrusted where-20 k20 warm | safe | regresses | 48.2 | 55.5 | 1.15 | 1.02 | 0.131 | safe, regresses |
| pglite latent 15000 clustered untrusted type-50 k20 warm | safe | regresses | 53.2 | 133.6 | 2.51 | 1.58 | 0.060 | safe, regresses |
| pglite latent 15000 clustered untrusted where-50 k20 warm | safe | regresses | 61.4 | 152.2 | 2.48 | 1.62 | 0.064 | safe, regresses |
| pglite latent 75000 clustered untrusted type-20 k20 warm | safe | regresses | 128.7 | 274.2 | 2.13 | 0.97 | 0.020 | safe, regresses |
| pglite latent 75000 clustered untrusted where-20 k20 warm | safe | regresses | 129.1 | 272.3 | 2.11 | 0.90 | 0.011 | safe, regresses |
| pglite latent 75000 clustered untrusted type-50 k20 warm | safe | regresses | 148.4 | 23.9 | 0.16 | 1.36 | 0.000 | safe, regresses |
| pglite latent 75000 clustered untrusted where-50 k20 warm | safe | regresses | 145.5 | 23.1 | 0.16 | 1.36 | 0.001 | safe, regresses |
| pglite latent 75000 independent untrusted type-20 k20 warm | safe | regresses | 137.0 | 271.2 | 1.98 | 0.90 | 0.011 | safe, regresses |
| pglite latent 75000 independent untrusted where-20 k20 warm | safe | regresses | 137.8 | 260.6 | 1.89 | 0.92 | 0.010 | safe, regresses |
| pglite latent 75000 independent untrusted type-50 k20 warm | safe | regresses | 155.0 | 24.5 | 0.16 | 1.30 | 0.000 | safe, regresses |
| pglite latent 75000 independent untrusted where-50 k20 warm | safe | regresses | 146.9 | 24.0 | 0.16 | 1.33 | 0.001 | safe, regresses |
| pglite latent 75000 independent untrusted type-20 k20 cold | safe | regresses | 377.2 | 1059.1 | 2.81 | 0.79 | 0.008 | safe, regresses |
| pglite latent 75000 independent untrusted where-20 k20 cold | safe | regresses | 364.3 | 943.8 | 2.59 | 0.72 | 0.003 | safe, regresses |
| pg17-v074 latent 375000 clustered untrusted type-5 k20 warm | safe | regresses | 431.3 | 255.0 | 0.59 | 1.40 | 0.000 | safe, regresses |

## Re-runs

| cell | first run | re-run | result |
|---|---|---|---|
| pg17-v074 latent 375000 clustered untrusted where-5 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v074 latent 375000 clustered untrusted scope-3 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v074 latent 375000 independent untrusted scope-3 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 independent untrusted type-1 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 15000 independent untrusted type-1 k50 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 15000 independent untrusted date-20 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 15000 independent untrusted where-20 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 15000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 independent untrusted type-50 k50 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 independent untrusted date-50 k50 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 independent untrusted where-50 k50 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 independent untrusted scope-1 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 15000 clustered untrusted type-20 k20 warm | safe, regresses | safe, improves | disagrees; takes the re-run's state |
| pg17-v087 latent 15000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 15000 clustered untrusted where-50 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 75000 independent untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 independent untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 independent untrusted type-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 independent untrusted date-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 independent untrusted where-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 clustered untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 clustered untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 75000 clustered untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 latent 1500000 clustered untrusted where-1 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 1500000 independent untrusted where-20 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 1500000 independent untrusted none k50 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 latent 375000 independent untrusted where-20 k20 cold | loss, neutral | loss, regresses | agrees |
| pg15-v087 latent 375000 independent untrusted where-20 k20 cold | loss, neutral | loss, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted where-1 k20 cold | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg15-v087 latent 75000 independent untrusted type-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted date-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 independent untrusted where-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 clustered untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 clustered untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg15-v087 latent 75000 clustered untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 375000 independent untrusted where-20 k20 cold | loss, neutral | loss, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted type-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted date-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 independent untrusted where-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 clustered untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 clustered untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg16-v087 latent 75000 clustered untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v074 latent 75000 independent untrusted type-20 k20 cold | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v074 latent 75000 independent untrusted where-20 k20 cold | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg18-v087 latent 375000 independent untrusted where-20 k20 cold | loss, neutral | loss, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted type-20+date-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted type-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 independent untrusted date-20 k20 cold | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg18-v087 latent 75000 independent untrusted where-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 clustered untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 clustered untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pg18-v087 latent 75000 clustered untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 independent untrusted date-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 independent untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 clustered untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 clustered untrusted date-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 clustered untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 15000 clustered untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 clustered untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 clustered untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 clustered untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 clustered untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 independent untrusted type-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 independent untrusted where-20 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 independent untrusted type-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 independent untrusted where-50 k20 warm | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 independent untrusted type-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pglite latent 75000 independent untrusted where-20 k20 cold | safe, regresses | safe, regresses | agrees |
| pg17-v074 latent 375000 clustered untrusted type-5 k20 warm | safe, regresses | safe, regresses | agrees |
| pg17-v087 wiki 375000 clustered trusted scope-3 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |
| pg17-v087 wiki 375000 independent untrusted date-0.1 k20 warm | safe, regresses | safe, neutral | disagrees; takes the re-run's state |

## Searches gbrain flagged incomplete

| cell | C incomplete | T incomplete | C pages (median, incomplete) | T pages (median, incomplete) | recall C | recall T | recall state |
|---|---|---|---|---|---|---|---|
| pg17-v074 latent 375000 clustered untrusted scope-50 k20 warm | 0 of 1500 | 1 of 1500 | n/a | 10 | 0.994 | 0.993 | safe |
| pg17-v074 latent 375000 independent untrusted type-20 k20 cold | 30 of 30 | 30 of 30 | 5 | 5 | 0.235 | 0.235 | safe |
| pg17-v074 latent 375000 independent untrusted date-20 k20 cold | 30 of 30 | 30 of 30 | 5 | 5 | 0.237 | 0.237 | safe |
| pg17-v074 latent 375000 independent untrusted where-20 k20 cold | 30 of 30 | 30 of 30 | 5 | 5 | 0.220 | 0.220 | safe |
| pg17-v087 latent 1500000 clustered untrusted type-20+date-50 k20 warm | 3 of 750 | 0 of 750 | 19 | n/a | 0.947 | 0.947 | safe |
| pg17-v087 latent 1500000 independent untrusted date-1 k50 warm | 705 of 750 | 0 of 750 | 38 | n/a | 0.560 | 0.982 | safe |
| pg17-v087 latent 1500000 independent untrusted type-20+date-50 k20 warm | 49 of 750 | 0 of 750 | 17 | n/a | 0.902 | 0.918 | safe |
| pg17-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 2 of 30 | n/a | 17 | 0.955 | 0.937 | unresolved |
| pg17-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 15 | 0.953 | 0.912 | loss |
| pg15-v087 latent 375000 independent untrusted date-1 k20 cold | 5 of 30 | 0 of 30 | 12 | n/a | 0.602 | 1.000 | safe |
| pg15-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 3 of 30 | n/a | 17 | 0.932 | 0.913 | unresolved |
| pg15-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 17 | 0.958 | 0.918 | loss |
| pg16-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 3 of 30 | n/a | 17 | 0.928 | 0.908 | unresolved |
| pg16-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 16 | 0.953 | 0.905 | loss |
| pg17-v074 latent 375000 independent untrusted date-1 k20 cold | 30 of 30 | 3 of 30 | 0 | 11 | 0.008 | 0.957 | safe |
| pg18-v087 latent 375000 independent untrusted type-20 k20 cold | 0 of 30 | 3 of 30 | n/a | 17 | 0.907 | 0.887 | unresolved |
| pg18-v087 latent 375000 independent untrusted where-20 k20 cold | 0 of 30 | 5 of 30 | n/a | 14 | 0.928 | 0.877 | loss |
| pg17-v087 wiki 375000 independent untrusted type-20 k20 cold | 0 of 30 | 1 of 30 | n/a | 19 | 0.985 | 0.983 | safe |

## Stage 1b

PASS: 38 flip-side cells, 17 improve, 0 block.

| cell | recall | latency | p50 T/C | p95 T/C | recall interval low end |
|---|---|---|---|---|---|
| pg17-v087 latent 375000 clustered untrusted date-0.1 k20 warm | safe | neutral | 1.08 | 0.99 | 0.000 |
| pg17-v087 latent 375000 clustered untrusted date-1 k20 warm | safe | improves | 0.25 | 0.10 | 0.265 |
| pg17-v087 latent 375000 clustered untrusted date-5 k20 warm | safe | improves | 0.14 | 0.18 | 0.006 |
| pg17-v087 latent 375000 clustered untrusted date-20 k20 warm | safe | improves | 0.09 | 0.06 | 0.000 |
| pg17-v087 latent 375000 clustered untrusted date-50 k20 warm | safe | improves | 0.04 | 0.02 | 0.000 |
| pg17-v087 latent 375000 clustered untrusted type-20+date-50 k20 warm | safe | improves | 0.14 | 0.37 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-0.1 k20 warm | safe | neutral | 0.79 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-0.1 k50 warm | safe | neutral | 1.00 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-1 k20 warm | safe | improves | 0.29 | 0.38 | 0.284 |
| pg17-v087 latent 375000 independent untrusted date-1 k50 warm | safe | improves | 0.07 | 0.07 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-5 k20 warm | safe | improves | 0.14 | 0.11 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-5 k50 warm | safe | improves | 0.11 | 0.10 | 0.059 |
| pg17-v087 latent 375000 independent untrusted date-20 k20 warm | safe | improves | 0.08 | 0.06 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-20 k50 warm | safe | improves | 0.06 | 0.05 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-50 k20 warm | safe | improves | 0.03 | 0.03 | 0.000 |
| pg17-v087 latent 375000 independent untrusted date-50 k50 warm | safe | improves | 0.03 | 0.02 | 0.000 |
| pg17-v087 latent 375000 independent untrusted type-20+date-50 k20 warm | safe | improves | 0.12 | 0.10 | 0.000 |
| pg17-v087 latent 375000 independent untrusted type-20+date-50 k50 warm | safe | improves | 0.63 | 0.77 | 0.007 |
| pg17-v087 latent 375000 independent untrusted date-1 k20 cold | safe | improves | 0.25 | 0.25 | 0.208 |
| pg17-v087 latent 375000 independent untrusted date-20 k20 cold | safe | improves | 0.62 | 0.50 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-0.1 k20 warm | safe | neutral | 0.98 | 0.99 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-1 k20 warm | safe | neutral | 1.00 | 1.00 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-5 k20 warm | safe | neutral | 1.02 | 0.98 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-20 k20 warm | safe | neutral | 1.00 | 1.03 | 0.000 |
| pg17-v087 latent 375000 clustered trusted date-50 k20 warm | safe | neutral | 0.98 | 0.99 | 0.000 |
| pg17-v087 latent 375000 clustered trusted type-20+date-50 k20 warm | safe | neutral | 1.03 | 0.99 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-0.1 k20 warm | safe | neutral | 1.01 | 1.02 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-0.1 k50 warm | safe | neutral | 1.01 | 0.99 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-1 k20 warm | safe | neutral | 1.01 | 0.98 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-1 k50 warm | safe | neutral | 1.01 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-5 k20 warm | safe | neutral | 1.04 | 1.01 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-5 k50 warm | safe | neutral | 0.99 | 1.01 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-20 k20 warm | safe | neutral | 0.99 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-20 k50 warm | safe | neutral | 1.01 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-50 k20 warm | safe | neutral | 1.00 | 1.02 | 0.000 |
| pg17-v087 latent 375000 independent trusted date-50 k50 warm | safe | neutral | 1.00 | 1.00 | 0.000 |
| pg17-v087 latent 375000 independent trusted type-20+date-50 k20 warm | safe | neutral | 1.02 | 1.05 | 0.000 |
| pg17-v087 latent 375000 independent trusted type-20+date-50 k50 warm | safe | neutral | 1.02 | 1.00 | 0.000 |
