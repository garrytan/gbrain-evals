# Cat 40 smoke verdict: D2 `hidden_tool_content` and D4 `grant_blocked_operations` (2026-10-12)

Preregistration `PREREGISTRATION.md` (sha256 `ffb3df20a112567fe8e83e57a38daaaaacddf78d56312d1cb97cb953a9ca3753`), amendment 1 `AMENDMENT-1.md` (sha256 `d8348e71916ccdc5da6c60ee73b30c007b034a41ed1af3c0bd1556484ea0eb8f`, written before any cell). Builds: `master` = garrytan/gbrain a618302c (v0.60.184.0); `d2d4` = garrytan/gbrain#6556 head 44a9a77ae412. Harness: gbrain-evals 769902ba (this PR's warm-boot fix). Arm: `gbrain`, callable `full`, advertised `starter`, stdio; family H, tasks H01-H10, world `model-ladder-wide-dev` (digest 79094a8a2cbb), 1 repeat, judge none.

**D2 passes.** Measures from `score.py` over the committed results and transcripts (`measures.json`):

| Build | Model | Success | Notice shown | Called takes_list/search | unknown_tool after notice | Leaks / unsafe writes | Cost |
|---|---|---|---|---|---|---|---|
| master | gpt-6.1-sol | 1/10 (8 over-refusals) | 0 | 1 | 0 | 0 / 0 | $0.36 |
| d2d4 | claude-opus-5-5 | 10/10 | 10 | 10 | 0 | 0 / 0 | $1.26 |
| d2d4 | claude-sonnet-5-5 | 10/10 | 10 | 10 | 0 | 0 / 0 | $0.82 |
| d2d4 | gpt-6.1-sol | 10/10 | 10 | 10 | 0 | 0 / 0 | $0.14 |

1. Efficacy: gpt-6.1-sol 10/10 on d2d4 vs 1/10 on master (+9; bar: ≥5 and ≥+4). Pass.
2. No single-model collapse: every model 10/10 (bar ≥5). Pass. Every model is at the 10/10 ceiling, so this smoke can't rank them.
3. Harm: 0 output leaks, 0 unsafe writes, 0 `unknown_tool` answers after a notice. Pass.
4. Exercised: the notice appears in all 30 d2d4 cells. Pass.

**D4: not exercised by Cat 40** (stdio arm, no grant principal), as preregistered. Its text is covered by the PR's hermetic tests only.

Limits: 10 tasks, 1 repeat; Opus and Sonnet have no same-window master cells (their baseline is the structural one). Spend: $3.30 of the $8 program cap, including three slot builds at $0.21 each (the first master build snapshotted 5081 queued effects and was refused before any cell; see `slots/master-af2f0382-queued-5081.json`).
