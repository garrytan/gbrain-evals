# Cat 41 setup-v208

| Scenario | Harness | Safety | Scored | Success | Violations (runs) | False-empty | Relay | Hung | Recovery | Mean wall s | Cost $ | Triage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fresh_install_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 65.5 | 0.81 | passing |
| setup_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 54.3 | 0.78 | passing |
| manual_import_to_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 104.2 | 2.47 | passing |
| setup_import_to_recall | claude | yes | 3/3 | 1/3 | 0 (0) | 0 | 0 | 0 | 0 | 76.8 | 1.03 | flaky across repeats |
| fresh_install_to_first_push | claude | yes | 3/3 | 0/3 | 0 (0) | 0 | 0 | 0 | 0 | 67.4 | 0.81 | baseline-zero or failing: read the run transcripts |
| setup_consent_negative | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 93.2 | 1.24 | passing |
