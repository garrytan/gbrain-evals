# Cat 41 setup TTHW, third measurement on gbrain v0.60.208.0: preregistration

Written 2026-10-13, before any paid session of this run. Plan: "Build the 10x memory advantage" (GBRA-60), D8's proof
column. Garry approved the run through GBRA-40, about $7. This file and its order-check entry
(`docs/benchmarks/preregistrations.d/cat41-setup-v208.json`) are committed and pushed before the first paid cell, and
the runner attests it (`--preregistration`) into every pass's `meta.json`.

**It supersedes nothing.** The [first run](2026-10-12-cat41-setup-tthw.md) and the
[second run](2026-10-13-cat41-setup-remeasure.md) stand as published.

## Why measure again

The second run (gbrain v0.60.203.0) missed wired recall (67.8 s), first push (0/3) and consent (2 of 3 runs sent an
unbilled `GET /v1/models`). Its faster-setup claim passed as scored (26.5%) and failed on reading (18.9%), because
the frozen date rule missed one correct day-first date. garrytan/gbrain#6612, released as v0.60.208.0, addresses two
of those findings:

- **#6606 (first push):** `gbrain --help` gains a MEMORY section that lists `remember` as world-visible. Setup prints a
  `Memory:` line naming `gbrain remember`. A private CLI `remember` now says the fact is not pushed into new sessions.
- **#6607 (consent):** OpenAI model discovery runs just before the first OpenAI-routed call instead of on engine
  connect, so `gbrain doctor` on a keyless brain sends nothing.

## What is unchanged (frozen)

Everything in the [second run's preregistration](2026-10-12-cat41-setup-remeasure-preregistration.md) applies
unchanged, including its Amendment 1 edge note:

- **Targets and decision rules**, from its "Frozen targets and decision rules" section:
  - wired recall (A): 3/3 and a mean ≤ 60.0 s;
  - first push (D): each of 3 runs succeeds in ≤ 120.0 s with ≤ 1 user reply and 0 consent violations;
  - faster setup (B against C): C's median over successful runs ≤ 0.75 × B's, C 3/3, B at least 2/3, and C's
    interventions not above B's;
  - consent negatives (E): 0 consent violations in each of 3 runs, any session-phase provider request counted.
- **Scoring:** scorer `cat41-score-v7` and the scenario success rules exactly as at main `1ad2370c`. The `cat41`
  runner, scorer and scenarios are unchanged since `da9864cf` (#140). That includes the B and C success rule that
  accepts only "2026-11-14" or "November 14" and so rejected "14 November 2026" in the second run. Nothing here is
  changed after seeing results.
- **The scripted user:** the one fixed reply, the `asksForInput` trigger and at most 3 replies.
- **Cells, order and n:**
  - A to E, 3 repeats each, concurrency 1, interleaved by repeat: repeat 1 `B, C, A, D, E`; repeat 2 `C, B, A, D, E`;
    repeat 3 `B, C, A, D, E`. 15 runs.
  - The descriptive cell F (`fresh_install_to_wired_recall`, 3 repeats) runs afterwards if the ledger shows ≤ $7.00
    spent then.
- **Harness and model:** image `gbrain-evals-cat41:v1` (Claude Code 2.1.285, Bun 1.4.2, Node 24.18.0) and
  `claude-opus-5-5` on Claude Code, as in both earlier runs.
- **Verdict tool:** `eval/runner/cat41/tthw-verdict.ts`. The report gives each target as scored and, where a
  transcript shows the scorer misread a run, as read too, beside it. The frozen verdict is the one as scored.

## What runs

- **gbrain under test:** `febbd4ebcd60e2bef02b41e7dc693b4d81cf5387`, **v0.60.208.0** on `master`, the merge of
  garrytan/gbrain#6612 (fixes #6606 and #6607). Before the first paid cell:
  - The release `v0.60.208.0` is published on garrytan/gbrain, and its tag resolves to this commit. GBRA-40
    confirms the release. No paid cell runs before then, and none against a source checkout.
  - The agent installs exactly this commit (`bun install -g github:garrytan/gbrain#febbd4ebc…`, the same install form
    as both earlier runs). Each run's `result.json` records the installed version (`harness_versions.gbrain`), and
    any run whose installed version is not `0.60.208.0` is reported as invalid.
  - The `.gbrain-overlays/` copy of the same commit only seeds cell E's existing brain and reads probe results, as
    before.
- **Models, against the project's eval model rules** (`bun scripts/model-freshness.ts --models claude-opus-5-5`,
  2026-10-13):
  - Newest per family: Opus `claude-opus-5-5`, Sonnet `claude-sonnet-5-5`, GPT `gpt-6.1-sol`. Blocking: none.
  - `claude-opus-5-5` is the newest Opus. No Fable, older generation or gpt-5.4-mini runs, so the model set breaks
    no rule and does not change.
  - The Sonnet and GPT warnings stand as in both earlier runs. This is a re-measure of one harness and model pair
    against fixed targets, not a model comparison. `setup` is measured on Claude Code only, and adding a model would
    leave no earlier run to compare it with.
- **Budget:**
  - New ledger `.budget/cat41-setup-v208.sqlite`, **$10 program cap**, new ledger run. Reservations are refused past
    the cap.
  - The approval is about $7: the first run cost $8.37 and the second $6.65.
  - The spend counts toward the round's $840 cap, of which $444.60 was spent before this run.
- **Commands** (`<gbrain>` a checkout):

  ```sh
  L=.budget/cat41-setup-v208.sqlite; P=docs/benchmarks/2026-10-13-cat41-setup-v208-preregistration.md; O=eval/reports/cat41/setup-v208
  G=<gbrain>@febbd4ebcd60e2bef02b41e7dc693b4d81cf5387
  bun eval/runner/budget-ledger.ts init --budget-ledger $L --program-cap-usd 10 --reason "GBRA-60 D8 setup TTHW on v0.60.208.0 (Garry via GBRA-40, about \$7)"
  RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger $L --runner cat41-agent-operator --budget-usd 10 | tail -1)
  n=0
  for order in manual_import_to_recall,setup_import_to_recall setup_import_to_recall,manual_import_to_recall manual_import_to_recall,setup_import_to_recall; do
    n=$((n+1)); bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-v208 --harnesses claude \
      --scenarios $order,setup_to_wired_recall,fresh_install_to_first_push,setup_consent_negative \
      --repeat $n --concurrency 1 --paid --budget-ledger $L --budget-run-id "$RID" --preregistration $P --out $O
  done
  # F, only if spend <= $7.00:
  bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-v208 --harnesses claude --scenarios fresh_install_to_wired_recall \
    --repeat 3 --concurrency 1 --paid --budget-ledger $L --budget-run-id "$RID" --preregistration $P --out $O
  bun eval/runner/cat41/tthw-verdict.ts $O > verdict.json
  ```

- **$0 checks, done on this commit before writing this file:**
  - All six scenarios' setups, downloads and probes run clean in the image with no harness key. The installed CLI
    reports `gbrain 0.60.208.0`.
  - `gbrain --help` lists `remember "<fact>" --entity <slug>  Save a fact the user stated, with --provenance;
    world-visible`.
  - On a keyless brain, `gbrain doctor` with `OPENAI_API_KEY` and `OPENAI_BASE_URL` pointing at a local listener
    sends 0 requests. The same listener logged 1 request from a control `curl`.

## Reported

As in the second run:

- each target with raw counts, as scored and, where it differs, as read;
- per run, wall time with `download_ms` beside it, and agent time;
- scripted replies, with the closing line that triggered each; input requests and unanswered input requests;
- restarts, crash retries, abandonment and developer interventions;
- consent violations, with the `GET /v1/models` request count per run;
- fabricated user facts, MCP and shell call counts, cost, and the ledger run id.

A harness crash is retried up to twice and otherwise reported inconclusive. A failed or partial run is published with
the rest, and nothing is rerun to get a better time.

## Amendment 1 (2026-10-13, after repeats 1 and 2, before repeat 3)

- **What happened:** the runner refused the third A–E invocation before it started any session. It printed
  `PaidArmRefusal: cat41 agent sessions spends money (estimate $7.50), but run … has only $5.73 left of its $10.00
  budget`. The runner's preflight estimate counted every run of `--repeat 3`, $0.50 each, including the 10 runs
  repeats 1 and 2 had already finished and that the runner skips. Only the 5 runs of repeat 3 were left to do, about
  $2.10 at repeats 1 and 2's rate.
- **The change:** the preflight estimate in `eval/runner/cat41-agent-operator.ts` now counts only runs without a
  finished first attempt (`-a0/result.json`). The ledger reservation per session ($2.50, refused past the cap), the
  $10 cap, the cells, the order, the scorer, the scenarios, the scripted user and the targets are unchanged.
- **Why it is not a measurement change:** no file that runs inside the container, scores a run or computes the
  verdict changed. The change is made after seeing repeats 1 and 2, so it is recorded here and pushed before repeat
  3 starts. Repeat 3 runs as preregistered, followed by F if the ledger then shows ≤ $7.00 spent.
