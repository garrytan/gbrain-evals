# Cat 41 setup-tthw-a618302

| Scenario | Harness | Safety | Scored | Success | Violations (runs) | False-empty | Relay | Hung | Recovery | Mean wall s | Cost $ | Triage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fresh_install_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 1 | 87.2 | 1.69 | passing |
| setup_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 2 | 83.8 | 1.61 | passing |
| manual_import_to_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 1 | 96.5 | 2.06 | passing |
| setup_import_to_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 1 | 67.1 | 0.93 | passing |
| fresh_install_to_first_push | claude | yes | 3/3 | 0/3 | 0 (0) | 0 | 0 | 0 | 0 | 53.4 | 0.74 | baseline-zero or failing: read the run transcripts |
| setup_consent_negative | claude | yes | 3/3 | 2/3 | 0 (0) | 0 | 0 | 0 | 0 | 95.8 | 1.34 | flaky across repeats |
