# Cat 41 setup TTHW, fifth measurement (run 4's design on gbrain v0.60.219.0): preregistration

Written 2026-10-14, before any paid session of this run. **Approved by GBRA-40 under the standing rule on 2026-10-14**,
as relayed to this thread. Plan: "Build the 10x memory advantage" (GBRA-60), D8's proof column. This file and its
order-check entry (`docs/benchmarks/preregistrations.d/cat41-setup-run5.json`) are committed and pushed before the
first paid cell, and the runner attests it (`--preregistration`) into every pass's `meta.json`.

**Nothing was redesigned after the fourth run's results.** This run repeats the
[fourth run's preregistration](2026-10-13-cat41-setup-run4-preregistration.md) exactly: the same targets and decision
rules, cells, order, n, harness, model, scripted user, scorer `cat41-score-v8` and verdict tool. Only two things
differ:

1. **The gbrain version under test** is v0.60.219.0 instead of v0.60.208.0.
2. **The model-freshness check** was rerun (below).

The [fourth run](2026-10-13-cat41-setup-run4.md) and its verdicts stand as published: first push missed (1/3), wired
recall met, consent met, faster setup missed (20.7% as scored, 18.4% as read). So do the
[first](2026-10-12-cat41-setup-tthw.md), [second](2026-10-13-cat41-setup-remeasure.md) and
[third](2026-10-13-cat41-setup-v208.md) runs. This run measures a later product against the same frozen design; it
does not re-score or replace any earlier run.

## Why a new version

gbrain v0.60.219.0 (garrytan/gbrain#6645, merge `4ba34fa7ed65be2e83823dfcfa24a1285839b669`) changes two behaviors
the fourth run's transcripts showed:

- **Setup finishes the brain it creates.** On a new brain, `gbrain setup claude-code` runs the setup migrations
  itself (without installing services), instead of printing a hand-off to `gbrain apply-migrations --yes
  --no-autopilot-install`. In the fourth run every C agent ran that hand-off, at 5.3 to 7.5 s per run.
- **Keyless recall treats a positional question as a question.** On a brain without embeddings, `gbrain recall
  "<question>"` that matches no entity or fact text now returns ranked facts instead of "No matching facts." In the
  fourth run all three D agents got "No matching facts." from `gbrain recall "how does the user take their coffee"`
  before a keyword recall worked, and D r1 gave that miss as its reason for also writing Claude Code's own memory.

Those are product changes. The task, the scorer and the targets are unchanged, so any difference from the fourth run
is the product's.

## What is unchanged

Copied from the fourth run's preregistration, without edits:

- **Scorer `cat41-score-v8`,** with its three rules: the first-push item `fresh_install_to_first_push_pref` (a
  world-visible preference, "remember that I take my coffee black, with a pinch of cardamom", asked back in a fresh
  session with no tool calls); the any-unambiguous-date rule in the install scenarios (B, C, E); and the
  install-check exemption (`INSTALL_CHECK_RE` in `eval/runner/cat41/scenarios.ts`). Gate scenarios score as in v7.
- **Targets and decision rules**, from the [second run's preregistration](2026-10-12-cat41-setup-remeasure-preregistration.md):
  - wired recall (A): 3/3 and a mean ≤ 60.0 s;
  - first push (D): each of 3 runs succeeds in ≤ 120.0 s with ≤ 1 user reply and 0 consent violations;
  - faster setup (B against C): C's median over successful runs ≤ 0.75 × B's, C 3/3, B at least 2/3, and C's
    interventions not above B's;
  - consent negatives (E): 0 consent violations in each of 3 runs, any session-phase provider request counted.

  The report gives each line as scored and, where a transcript shows a misread, as read. The frozen verdict is the
  scored one.
- **The scripted user:** the one fixed reply, the `asksForInput` trigger and at most 3 replies.
- **Cells, order and n:**
  - A `setup_to_wired_recall`, B `manual_import_to_recall`, C `setup_import_to_recall`, D
    `fresh_install_to_first_push_pref`, E `setup_consent_negative`. 3 repeats each, concurrency 1, interleaved by
    repeat: repeat 1 `B, C, A, D, E`; repeat 2 `C, B, A, D, E`; repeat 3 `B, C, A, D, E`. 15 runs.
  - The descriptive cell F (`fresh_install_to_wired_recall`, 3 repeats) runs afterwards if the ledger shows ≤ $7.00
    spent then.
- **Harness and model:** image `gbrain-evals-cat41:v1` (Claude Code 2.1.285, Bun 1.4.2, Node 24.18.0) and
  `claude-opus-5-5` on Claude Code. No Fable, older generation or gpt-5.4-mini runs. The Sonnet and GPT warnings stand
  for the fourth run's reason: this re-measures one harness and model pair against fixed targets, not a model
  comparison.
- **Verdict tool:** `eval/runner/cat41/tthw-verdict.ts`. It reads D from `fresh_install_to_first_push_pref`.
- **Failure handling:** a harness crash is retried up to twice and otherwise reported inconclusive. A failed or
  partial run is published with the rest, and nothing is rerun to get a better time.

## Model freshness, rerun

`bun scripts/model-freshness.ts --models claude-opus-5-5` on 2026-10-14: newest Opus `claude-opus-5-5`, Sonnet
`claude-sonnet-5-5`, GPT `gpt-6.1-sol` (Fable `claude-fable-5-1`, smoke tests only); called `claude-opus-5-5`;
blocking: none. The run's model list is unchanged.

## What runs

- **gbrain under test:** v0.60.219.0, `4ba34fa7ed65be2e83823dfcfa24a1285839b669` (the merge of garrytan/gbrain#6645,
  whose `VERSION` reads `0.60.219.0`).
  - No paid cell starts until GBRA-40 confirms v0.60.219.0 is published. If the published release names a different
    commit, an amendment committed before the first cell records that commit and version.
  - Each run's `result.json` must record `harness_versions.gbrain` = `0.60.219.0`. Any run that doesn't is reported
    as invalid.
- **Budget:** a new ledger `.budget/cat41-setup-run5.sqlite`, **$10 program cap**, new ledger run. Reservations are
  refused past the cap. The fourth run cost $7.58. The spend counts toward the round's $840 cap.
- **Commands** (`<gbrain>` a checkout):

  ```sh
  L=.budget/cat41-setup-run5.sqlite; P=docs/benchmarks/2026-10-14-cat41-setup-run5-preregistration.md; O=eval/reports/cat41/setup-run5
  G=<gbrain>@4ba34fa7ed65be2e83823dfcfa24a1285839b669
  bun eval/runner/budget-ledger.ts init --budget-ledger $L --program-cap-usd 10 --reason "GBRA-60 D8 setup TTHW run 5"
  RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger $L --runner cat41-agent-operator --budget-usd 10 | tail -1)
  n=0
  for order in manual_import_to_recall,setup_import_to_recall setup_import_to_recall,manual_import_to_recall manual_import_to_recall,setup_import_to_recall; do
    n=$((n+1)); bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-run5 --harnesses claude \
      --scenarios $order,setup_to_wired_recall,fresh_install_to_first_push_pref,setup_consent_negative \
      --repeat $n --concurrency 1 --paid --budget-ledger $L --budget-run-id "$RID" --preregistration $P --out $O
  done
  # F, only if spend <= $7.00:
  bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-run5 --harnesses claude --scenarios fresh_install_to_wired_recall \
    --repeat 3 --concurrency 1 --paid --budget-ledger $L --budget-run-id "$RID" --preregistration $P --out $O
  bun eval/runner/cat41/tthw-verdict.ts $O > verdict.json
  ```

## Reported

As in the fourth run:

- each target with raw counts, as scored and, where it differs, as read;
- per run, wall time with `download_ms` beside it, and agent time;
- scripted replies, with the closing line that triggered each; input requests and unanswered input requests;
- restarts, crash retries, abandonment and developer interventions;
- consent violations, with the `GET /v1/models` request count per run;
- fabricated user facts, with any install-check exemption the rule applied quoted;
- MCP and shell call counts, cost, and the ledger run id;
- for D, each run's saved visibility and the hook output.

Because v0.60.219.0 targets two steps the fourth run timed, the report also gives, from the transcripts, whether each
C and D agent still ran `gbrain apply-migrations` by hand and what a positional `gbrain recall "<question>"` returned.
These are descriptive and do not enter any verdict.
