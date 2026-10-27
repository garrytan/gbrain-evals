# Cat 41 setup TTHW re-measure, symmetric scripted user: preregistration

Written 2026-10-12, before any paid session of this run. Plan: "Build the 10x memory advantage" (GBRA-60), D8's proof
column. This file and its order-check entry (`docs/benchmarks/preregistrations.d/cat41-setup-remeasure.json`) are
committed and pushed before the first paid cell, and the runner attests it (`--preregistration`) into every pass's
`meta.json`.

**It supersedes nothing.** The first measurement ([report](2026-10-12-cat41-setup-tthw.md),
[preregistration](2026-10-12-cat41-setup-tthw-preregistration.md)) stands as published: wired recall 83.8 s
(missed), first push 0/3 (missed), faster setup met as scored (65.3 s against 100.5 s, 35% lower; 23% like-for-like),
consent not met as written. This run measures again with the harness defect that report found fixed, on a gbrain build
that contains the two product fixes it led to.

## Why measure again

1. **The scripted user answered the two arms unequally.** It replied when the agent's last message matched a fixed
   pattern (`ASK_RE`). The three by-hand runs closed with "should I save…?" and got the reply; the three `setup` runs
   closed with "Reply 'defaults'…" or "should agents save…" and did not, so the setup arm skipped a 10 to 19 s reply
   session the by-hand arm paid for.
2. **gbrain changed.** garrytan/gbrain#6562 makes SessionStart wait for the MCP server a fresh Claude Code session is
   starting (the first-push failure) and makes `gbrain doctor` honour a declined provider decision (the consent
   finding). Lane 31's fix addresses the agent ending setup on a trailing question.

## The harness fix (this PR, scorer `cat41-score-v7`)

- **Scripted user.** One fixed reply, "Use the defaults you recommend and go ahead.", sent whenever the agent's turn
  closes by asking the user for input, or gbrain is not registered in Claude Code yet, up to 3 times per run, in every
  install scenario (both arms of the pair, A, D, E and F). "Closes by asking" is `asksForInput`
  (`eval/runner/cat41/scenarios.ts`): the last blank-line-separated block of the turn (the whole trailing list when the
  turn ends in one) contains a sentence ending in "?" outside double quotes, code and URLs, or an explicit request for
  input ("Reply…", "tell me…", "do you want…", "should I…", "until you choose…"); a conditional offer ("tell me if
  you want it") is not a request. The rule is frozen at this commit.
- **Scorer v7.** (a) The install block counts the turns before the fresh session that close asking for input
  (`input_requests`) and whether the last of them went unanswered (`unanswered_input_requests`). (b) `gbrain setup
  claude-code` is read from shell command segments with any launcher whose name contains `gbrain` (the first run's
  E r2 agent ran setup through its own key-stripping wrapper, which v6 missed). (c) In `setup_consent_negative`, every
  session-phase request to the provider counts against consent, an unbilled model list included (effect `egress`),
  which is what the first preregistration's wording said. Gate scenarios score as in v6.
- **The classifier change alone**, on the first run's 18 transcripts
  ([`rescore-v7.json`](2026-10-12-cat41-setup-tthw/rescore-v7.json), made by
  [`rescore-v7.ts`](2026-10-12-cat41-setup-tthw/rescore-v7.ts)): all three `setup` import runs had an unanswered
  closing question, so interventions become 3 by hand and 3 with setup (v6 counted 3 and 0); all three consent runs
  now carry one consent violation for the unbilled `GET /v1/models` (v6: 0), and E r2's setup is now detected; no
  other success or consent result changes. On the two comparator passes of 2026-10-09 (24 runs) v7 changes no
  success or consent result.

## What runs

- **gbrain under test:** the first gbrain master release (a VERSION-stamped commit on `master`) that contains both
  the merge of garrytan/gbrain#6562 and the merge of lane 31's trailing-question fix. Amendment 1 names lane 31's PR,
  the selected commit and its version, and is committed and pushed before the first paid cell; no paid cell runs
  without it. If either fix ships changed in scope, or not at all, the amendment says so before any cell, and a
  change to the targets or cells needs the maintainer's approval first.
- **Harness and model:** unchanged from the first run: image `gbrain-evals-cat41:v1` (Claude Code 2.1.285, Bun
  1.4.2, Node 24.18.0), `claude-opus-5-5`, Claude Code only (setup supports only `claude-code`; D8's Codex targets
  are not measured). `bun scripts/model-freshness.ts --models claude-opus-5-5` is rerun before the first cell and its
  output recorded in Amendment 1; the model list does not change in this run.
- **Cells**, the same five scenarios as the first run, unchanged except the scripted user (prompts, seeds, probes and
  success rules as in the first preregistration's table):
  A `setup_to_wired_recall`, B `manual_import_to_recall` (by hand), C `setup_import_to_recall`,
  D `fresh_install_to_first_push`, E `setup_consent_negative`. 3 repeats each, concurrency 1, interleaved by repeat:
  repeat 1 `B, C, A, D, E`; repeat 2 `C, B, A, D, E`; repeat 3 `B, C, A, D, E`. 15 runs.
- **Descriptive cell F (not a target):** the unchanged comparator prompt `fresh_install_to_wired_recall`, 3
  repeats, after A to E, only if the ledger shows ≤ $18 spent then.
- **Budget:** a new ledger, `.budget/cat41-setup-remeasure.sqlite`, **$25 program cap** (approved by Garry,
  2026-10-12), a new ledger run, reservations refused past the cap. The first run spent $8.37 for 18 runs.
- **Commands** (`<gbrain>` a checkout, `<commit>` from Amendment 1):

  ```sh
  bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat41-setup-remeasure.sqlite --program-cap-usd 25 --reason "GBRA-60 D8 setup TTHW re-measure cap"
  RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger .budget/cat41-setup-remeasure.sqlite --runner cat41-agent-operator --budget-usd 25 | tail -1)
  n=0
  for order in manual_import_to_recall,setup_import_to_recall setup_import_to_recall,manual_import_to_recall manual_import_to_recall,setup_import_to_recall; do
    n=$((n+1)); bun eval/runner/cat41-agent-operator.ts run --gbrain <gbrain>@<commit> --label setup-remeasure \
      --harnesses claude --scenarios $order,setup_to_wired_recall,fresh_install_to_first_push,setup_consent_negative \
      --repeat $n --concurrency 1 --paid --budget-ledger .budget/cat41-setup-remeasure.sqlite --budget-run-id "$RID" \
      --preregistration docs/benchmarks/2026-10-12-cat41-setup-remeasure-preregistration.md --out eval/reports/cat41/setup-remeasure
  done
  # F, only if spend <= $18:
  bun eval/runner/cat41-agent-operator.ts run --gbrain <gbrain>@<commit> --label setup-remeasure --harnesses claude \
    --scenarios fresh_install_to_wired_recall --repeat 3 --concurrency 1 --paid --budget-ledger .budget/cat41-setup-remeasure.sqlite \
    --budget-run-id "$RID" --preregistration docs/benchmarks/2026-10-12-cat41-setup-remeasure-preregistration.md --out eval/reports/cat41/setup-remeasure
  bun eval/runner/cat41/tthw-verdict.ts eval/reports/cat41/setup-remeasure > verdict.json
  ```

- **$0 smokes, done at this commit:** a fake Claude Code that keeps asking gets 3 replies and then the fresh
  session; one that answers "Done." after the first reply gets exactly 1; the five scenarios' setups, downloads and
  probes run clean in the image on gbrain `a618302c9` with no harness key.

## Clocks and what is reported separately

As in the first run: wall time is the sum of the agent sessions from the install instruction to the end of the fresh
session; beside it, per run, `download_ms` and agent time, user replies, input requests and unanswered input
requests, approval taps (not measured: permissions are bypassed), restarts beyond the design's sessions, crash
retries, abandonment and developer interventions, consent violations, fabricated user facts, MCP and shell call
counts and cost.

## Frozen targets and decision rules

The same targets as the first run, judged on the A to E pass as run, never changed after seeing data.
`eval/runner/cat41/tthw-verdict.ts` applies them.

1. **Wired recall (A):** 3/3 runs succeed and the **mean wall time is ≤ 60.0 s**.
2. **First push (D):** **each of the 3 runs** succeeds with a wall time **≤ 120.0 s**, **≤ 1 user reply** and
   **0 consent violations**.
3. **Faster setup (B vs C):** claim setup is faster only if **C's median wall time is at least 25% below B's**
   (C ≤ 0.75 × B, medians over successful runs) **and** C's interventions are not higher than B's, with C at 3/3 and
   at least 2/3 successful B runs. Interventions per arm, over its 3 runs: scripted replies plus unanswered input
   requests plus crash retries plus developer interventions. Otherwise the report describes the arms without a
   faster-setup claim. (Threshold auto-approved under Garry's standing rule, 2026-10-12, as in the first run.)
4. **Consent negatives (E):** **0 consent violations** in each of the 3 runs, counting a capture hook, conversation
   content in the brain or transcript corpus, a fact the user did not ask for (an agent's install check excepted, as
   before), and **any** session-phase provider request, paid or not.

With n = 3, a target met or missed is reported as such, beside the first run's result for the same cell.

## Errors

A harness crash is retried up to twice and otherwise reported inconclusive (it counts against the 3/3 targets). A
failed or partial run is published with the rest; nothing is rerun to get a better time. Every brain is keyless and
reranking is off, as in the first run.

## Amendment 1 (2026-10-13, before any paid cell)

- **gbrain under test:** `449483cc7e55bc36afbb388a8cab8346b0022c5b`, gbrain v0.60.203.0 on `master`, the merge of
  garrytan/gbrain#6572 (lane 31's fix: "first-run settings relayed in the install reply, not a trailing question").
  It contains the merge of garrytan/gbrain#6562 (`0a9813ff1`, shipped in v0.60.197.0). It is the first master
  release containing both. Neither fix changed scope from what this preregistration describes, so targets, cells,
  models and n are unchanged.
- **Model freshness** (`bun scripts/model-freshness.ts --models claude-opus-5-5`, 2026-10-13): newest Opus
  `claude-opus-5-5`, Sonnet `claude-sonnet-5-5`, GPT `gpt-6.1-sol`; blocking: none. The two warnings (Sonnet and GPT
  not in this run) stand as designed: setup supports only Claude Code and this run keeps the first run's model. The
  model list does not change.
- **$0 checks on this build:** the five scenarios' setups, downloads and probes run clean in the image with no
  harness key; a direct `gbrain setup claude-code` there exits 0, wires Claude Code and closes with "Nothing needs
  an answer now; tell me any time if you want to change any of these".
- **A known edge of the frozen trigger, recorded before data:** an agent that relays that line as its own sentence
  ("Tell me any time if you want to change…") triggers a scripted reply, because the conditional-offer exception
  matches only "tell me if you…". The rule is not changed; it applies the same in every arm, and the report lists
  every scripted reply with the closing line that triggered it.
