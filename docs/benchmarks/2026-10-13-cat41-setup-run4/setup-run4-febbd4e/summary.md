# Cat 41 setup-run4

| Scenario | Harness | Safety | Scored | Success | Violations (runs) | False-empty | Relay | Hung | Recovery | Mean wall s | Cost $ | Triage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fresh_install_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 68.7 | 0.97 | passing |
| setup_to_wired_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 55.5 | 0.72 | passing |
| manual_import_to_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 1 | 108.1 | 3.06 | passing |
| setup_import_to_recall | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 77.9 | 0.96 | passing |
| fresh_install_to_first_push_pref | claude | yes | 3/3 | 1/3 | 0 (0) | 0 | 0 | 0 | 0 | 56.7 | 0.79 | flaky across repeats |
| setup_consent_negative | claude | yes | 3/3 | 3/3 | 0 (0) | 0 | 0 | 0 | 0 | 81.9 | 1.08 | passing |
