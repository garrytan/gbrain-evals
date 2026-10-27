# Cat 41 setup-remeasure

| Scenario | Harness | Safety | Scored | Success | Violations (runs) | False-empty | Relay | Hung | Recovery | Mean wall s | Cost $ | Triage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fresh_install_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 56.2 | 0.80 | passing |
| setup_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 67.8 | 0.90 | passing |
| manual_import_to_recall | claude | yes | 3/3 | 2/3 | 0 (0) | 0 | 0 | 0 | 0 | 92.6 | 1.54 | flaky across repeats |
| setup_import_to_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 72.2 | 1.02 | passing |
| fresh_install_to_first_push | claude | yes | 3/3 | 0/3 | 0 (0) | 0 | 0 | 0 | 0 | 62.6 | 0.98 | baseline-zero or failing: read the run transcripts |
| setup_consent_negative | claude | yes | 3/3 | 1/3 | 2 (2) | 0 | 0 | 0 | 0 | 112.5 | 1.40 | flaky across repeats |
