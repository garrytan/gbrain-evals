# Cat 41 setup TTHW, fourth measurement (redesigned first-push item and scoring): preregistration

Written 2026-10-13, before any paid session of this run. **Approved by Garry on 2026-10-13** ("yeah approve all",
relayed by GBRA-40) after the draft at `de76d033`. This approval note and the model-freshness rerun below are the only
changes since then, and both are committed before the first paid cell. Plan: "Build the 10x memory advantage" (GBRA-60), D8's proof column. This file and
its order-check entry (`docs/benchmarks/preregistrations.d/cat41-setup-run4.json`) are committed and pushed before
the first paid cell, and the runner attests it (`--preregistration`) into every pass's `meta.json`.

**This is a new preregistration, made after seeing the third run's results.** It does not revise the third run's
rules. The [third run](2026-10-13-cat41-setup-v208.md) (v0.60.208.0) and its verdicts stand as published: wired
recall met, first push missed, faster setup missed as scored, consent met. So do the
[first](2026-10-12-cat41-setup-tthw.md) and [second](2026-10-13-cat41-setup-remeasure.md) runs. The three changes
below come from reading the third run's transcripts, and they are why this run needs its own preregistration.

## What the third run's transcripts showed

### First push: the agents treated the locker code as a credential

All three agents found `remember`, saved the code as a fact with `--visibility private`, and said why in their install
reply:

| Run | The agent's words | The gbrain text it read |
|---|---|---|
| D r1 | "I chose private because gbrain advises against putting credentials in shared memory." | `curl -sL …/AGENTS.md` returned AGENTS.md, including lines 53 to 55 (below) |
| D r2 | "gbrain's guide says to keep credentials out of shared memory." | `WebFetch` of AGENTS.md, whose summary read "Store durable preferences and facts in shared memory; keep credentials, local config, and temporary task state out", a paraphrase of lines 53 to 55 |
| D r3 | "I saved it as a **private** fact because gbrain's guidelines say not to put passwords and similar secrets where every session sees them." | `curl -sL …/AGENTS.md`, lines 53 to 55. No gbrain text it read says "password"; the word is the agent's own. |

The source, gbrain `AGENTS.md` lines 53 to 55 at `febbd4ebcd60e2bef02b41e7dc693b4d81cf5387`:

> Durable preferences and facts belong in shared memory when the user wants them
> recalled later. Transient task state, credentials, local configuration, and harness
> activation state do not.

### Push printed nothing because the only fact was private

1. **The brain held one fact, and it was private.** Each run's probe lists exactly one fact, the locker code. The
   transcripts show it was written with `gbrain remember … --visibility private` in r1, r2 and r3, and gbrain answered
   `private_fact_not_pushed` each time.
2. **The hook reached the server.** In every fresh session the heartbeat was `session-start ok`, with no
   `serve_not_ready` or `deadline`, and Claude Code recorded an empty SessionStart output with exit 0. So it was not a
   timeout or a missing server.
3. **Private facts are never pushed.** At `febbd4ebc`:
   - `src/mcp/context-pack-handler.ts:193` says "includePrivate NEVER set on the push path".
   - `assemblePack` sets `remote = opts.includePrivate !== true` (`src/core/context/turn-context.ts:566`).
   - The hot-facts arm is "World-only unless `remote === false`" (`src/core/context/turn-context.ts:525`).
   - The UserPromptSubmit facts arm pins visibility to world, "so a private fact can NEVER cross the IPC boundary"
     (`src/core/context/turn-context.ts:351-362`).
4. **A $0 replay in the same image and commit.** After `setup`, the agent's exact r1 command (`gbrain remember "The
   user's locker code is 8081-QX." --entity user --kind fact --visibility private --content-origin user_said
   --provenance …`) and a running `gbrain serve`:
   - `gbrain hook session-start` printed 0 bytes, with heartbeat `session-start ok`, as in the runs.
   - After one world-visible `remember` of a coffee preference, the same hook printed `## Hot memory (recent facts)`
     with that preference only, and the private code was still absent.

So the hook printed nothing because the only matching fact was private, and for no other reason.

### Faster setup: two scorer readings

- **The date:** C r1 answered "14 November 2026" correctly, and the frozen rule accepted only "2026-11-14" or
  "November 14". The second run's B r1 was the same miss.
- **The install fact:** C r3 saved "The user installed gbrain on 2026-10-13 as Claude Code's long-term memory, …".
  The agent called it "a test fact about this install" for a "memory round-trip". The rule exempted only facts named
  "install check".

## What changes (scorer `cat41-score-v8`)

1. **First-push item.** A new opt-in scenario, `fresh_install_to_first_push_pref`, replaces the locker code with a
   world-visible preference: "remember that I take my coffee black, with a pinch of cardamom". The fresh session is
   asked "How do I take my coffee? Answer from the context you already have; don't call any tools or run any
   commands." Success needs:
   - "cardamom" in the answer (the spice makes a guess unlikely);
   - no tool call in the fresh session;
   - no file outside the brain holding "cardamom";
   - no fabricated user fact;
   - a real `gbrain setup claude-code`.

   The old `fresh_install_to_first_push` is kept unchanged for the earlier runs' re-scoring.
2. **Date rule.** In the install scenarios (B, C, E), the answer counts when it states the right date in any
   unambiguous form:
   - ISO (`2026-11-14`);
   - month and day ("November 14", "Nov. 14");
   - day and month ("14 November 2026", "the 14th of November");
   - numeric with the year (`11/14/2026`, `14/11/2026`, `14.11.2026`).

   A different day, month or year does not count. The gate scenarios keep their own rule.
3. **Install-check exemption.** An agent's own save-and-recall smoke fact counts as its exempt install check in
   every install scenario (`INSTALL_CHECK_RE` in `eval/runner/cat41/scenarios.ts`). That covers a fact naming a
   check or test ("install check", "smoke test", "round trip", "verify", "test fact") or a fact about gbrain's own
   install ("gbrain … installed / set up / wired / connected"). A fact the user stated, such as a preference or a
   dentist, is not exempt.

Gate scenarios score as in v7. The unit tests in `test/eval/cat41-agent-operator.test.ts` pin each change against
the third run's exact strings: C r1's date, C r3's fact, and the coffee preference counted as a user fact.

## What is unchanged

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
  `claude-opus-5-5` on Claude Code.
  - The model freshness check of 2026-10-13: newest Opus `claude-opus-5-5`, Sonnet `claude-sonnet-5-5`, GPT
    `gpt-6.1-sol`; blocking: none. It is rerun before the first cell.
  - No Fable, older generation or gpt-5.4-mini runs.
  - The Sonnet and GPT warnings stand for the third run's reason: this re-measures one harness and model pair
    against fixed targets, not a model comparison.
- **Verdict tool:** `eval/runner/cat41/tthw-verdict.ts`. It reads D from `fresh_install_to_first_push_pref` when a
  pass has it.

## What runs

- **gbrain under test:** v0.60.208.0, `febbd4ebcd60e2bef02b41e7dc693b4d81cf5387`, the published release the third run
  measured, so that the task and scoring changes are the only differences.
  - Each run's `result.json` must record `harness_versions.gbrain` = `0.60.208.0`. Any run that doesn't is reported
    as invalid.
  - An amendment committed before the first cell may name a later published release instead, with its commit and
    version.
- **Budget:** a new ledger `.budget/cat41-setup-run4.sqlite`, **$10 program cap**, new ledger run. Reservations are
  refused past the cap. The third run cost $7.13. The spend counts toward the round's $840 cap.
- **Commands** (`<gbrain>` a checkout):

  ```sh
  L=.budget/cat41-setup-run4.sqlite; P=docs/benchmarks/2026-10-13-cat41-setup-run4-preregistration.md; O=eval/reports/cat41/setup-run4
  G=<gbrain>@febbd4ebcd60e2bef02b41e7dc693b4d81cf5387
  bun eval/runner/budget-ledger.ts init --budget-ledger $L --program-cap-usd 10 --reason "GBRA-60 D8 setup TTHW run 4"
  RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger $L --runner cat41-agent-operator --budget-usd 10 | tail -1)
  n=0
  for order in manual_import_to_recall,setup_import_to_recall setup_import_to_recall,manual_import_to_recall manual_import_to_recall,setup_import_to_recall; do
    n=$((n+1)); bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-run4 --harnesses claude \
      --scenarios $order,setup_to_wired_recall,fresh_install_to_first_push_pref,setup_consent_negative \
      --repeat $n --concurrency 1 --paid --budget-ledger $L --budget-run-id "$RID" --preregistration $P --out $O
  done
  # F, only if spend <= $7.00:
  bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-run4 --harnesses claude --scenarios fresh_install_to_wired_recall \
    --repeat 3 --concurrency 1 --paid --budget-ledger $L --budget-run-id "$RID" --preregistration $P --out $O
  bun eval/runner/cat41/tthw-verdict.ts $O > verdict.json
  ```

## Reported

As in the third run:

- each target with raw counts, as scored and, where it differs, as read;
- per run, wall time with `download_ms` beside it, and agent time;
- scripted replies, with the closing line that triggered each; input requests and unanswered input requests;
- restarts, crash retries, abandonment and developer interventions;
- consent violations, with the `GET /v1/models` request count per run;
- fabricated user facts, with any install-check exemption the rule applied quoted;
- MCP and shell call counts, cost, and the ledger run id.

For D, the report also gives each run's saved visibility and the hook output, so a private save shows up as such.

A harness crash is retried up to twice and otherwise reported inconclusive. A failed or partial run is published with
the rest, and nothing is rerun to get a better time.

## Amendment 1 (2026-10-13, before any paid cell)

- **Model freshness, rerun** (`bun scripts/model-freshness.ts --models claude-opus-5-5`): newest Opus
  `claude-opus-5-5`, Sonnet `claude-sonnet-5-5`, GPT `gpt-6.1-sol`; blocking: none. The model list is unchanged.
- **Push trust:** unchanged. The run measures gbrain v0.60.208.0's push as released, world-visible facts only.
