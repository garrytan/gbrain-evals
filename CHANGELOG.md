# Changelog

This records what each gbrain-evals release changed and what its measurements meant at the time. Versions follow `VERSION` and `package.json`. Historical scores keep their original dates; later corrections do not turn them into measurements of today's code.

## [0.10.61] - 2026-10-09

### Slug-conflict judgment: three frontier models give no harmful answer on 48 pairs; Opus 5.5 merges the most true duplicates; mirrored from gbrain #6377

gbrain #6377 (branch `capy/gbra72-content-repair`, `ac6e0868`) adds a content-repair lane that clears sync holds itself and asks a chat model only where identity needs judgment: a file whose frontmatter `slug:` names another page is a duplicate to merge into a canonical page (a recommendation for a person; gbrain does not merge pages yet), a stray line to delete, or a case for a person. This release mirrors the preregistered eval that decides which models may give that judgment by default.

- **Report** ([doc](docs/benchmarks/2026-10-09-content-repair-judgment.md), [preregistration](docs/benchmarks/2026-10-09-content-repair-judgment-preregistration.md), frozen with the fixtures before any run). 48 synthetic pairs with placeholder names (25 true duplicates, 10 stray slugs, 8 adversarial, 5 ambiguous), three runs per model through gbrain's production prompt, call and parser, $2.05 in all. `claude-opus-5-5`, `gpt-6.1-sol` and `claude-sonnet-5-5` each gave no harmful answer in 144 pair runs (no `remove_slug` on a true duplicate, no `merge_into` of two different things, no wrong canonical, no unusable answer), removed every stray slug, deferred every ambiguous pair and never merged an adversarial pair; they recognised 69, 64 and 60 of 75 true duplicates (92.0%, 85.3%, 80.0%) and deferred the rest. All three meet the bar (zero hard failures, at least 80%); gbrain's `CONTENT_REPAIR_MEASURED_MODELS` lists them in that order. Deferrals concentrate on pairs whose two hygiene notes each read "Duplicate of the other"; a prompt change is proposed, to be measured under a new prompt version.
- **Records**: fixtures, per-run rows with the model's `why` sentences, `summary.json`, `summary.md` and `verdict.json` in `docs/benchmarks/2026-10-09-content-repair-judgment/`; `README.md` and `docs/README.md` gain the row.

## [0.10.60] - 2026-10-09

### Candidate 3 diagnostic: the remaining T0b terms and hop failures are notes linked only by a declared short code

A $0.10 diagnostic in place of Candidate 3 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60), on development and fresh public seeds; no reader cells and no gbrain change.

- **Report** ([doc](docs/benchmarks/2026-10-09-candidate-3-diagnostic.md)). Replaying the 33 Candidate 1 cells that failed on terms or the hop commitment on gbrain master `dda603ac` with reranking live: the call note with the corrected figure was in no tool result in any of the 29 terms cells, and the technical review was in no tool result in any of the 7 hop cells. The call note names the company by the short code its page declares ("Call with JOF"), and every development hop failure passed that code to `context_pack`. A keyless card probe puts the call note on the card in 0 of 24 development tasks on master and 21 of 24 on master merged with gbrain #6271's short-code rule; code collisions (BRL, PRF) and stoplisted codes (THE) leave the rest, about 15% of tasks with the fresh seeds. First names, nicknames and file-name words are shared with the generator's namesakes, so no separate Candidate 3 was built; collective disambiguation of colliding codes is documented as the follow-up.
- **Tools**: the rank replay and the card probe sit beside their receipts in `docs/benchmarks/2026-10-08-program-primary-hard/candidate-3/`; `docs/README.md` links the report from the agent-task row.

## [0.10.59] - 2026-10-09

### Candidate 1: newest dated mentions on `context_pack` cards cut T0b failures from 67 to 27; pin gbrain `8a3eedeac` (v0.60.126.0)

The first candidate from the [T0b root cause](docs/benchmarks/2026-10-08-program-primary-hard-root-cause.md), shipped in gbrain #6362 (on by default). Paid spend $58.36 of a $60 ledger and $42.38 of a $45 ledger.

- **Report** ([doc](docs/benchmarks/2026-10-09-candidate-1-newer-mentions.md), [preregistration](docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md) amendments 2 and 3). Against a fresh master arm on the same harness revision, with the reranker live in every cell: 67 to 27 of 144 failed runs on the development seeds (factor 2.45, 95% interval for R 0.25 to 0.64, `improvement`; Opus 5.5 40 to 6), and 33 to 9 of 72 on eight fresh public seeds drawn after the code freeze (factor 3.53, `improvement`). Contact and date failures fell from 74 items to 1; stale terms remain, from a call note that links to no entity. Every validity mutant was detected. An exploratory merge with the short-code alias fix (#6271's `f24ca6afe`) failed 1 of 18 Sonnet cells against 6 for Candidate 1 alone.
- **Harness**: eight fresh development seeds (`PPH_FRESH_SEEDS_C1`) join the seeds the T0b runner accepts; the mechanism probe, gold builder and route analysis sit beside the receipts. The shootout `runRemote` tests take a free port instead of a random one in the kernel's ephemeral range.
- **Pin**: gbrain moves from `fc548317f` (v0.60.122.0) to `8a3eedeac` (v0.60.126.0, the merge of gbrain #6362); `bun.lock` follows. At the new pin the `gbrain-query` fixtures assert what gbrain #6367 fixed (`auto` stays inside an explicit budget; the frozen-hit path carries dates), and N2 loads the CLI's `makeContext` from `src/cli/main.ts`, where gbrain #6365 moved it.

## [0.10.58] - 2026-10-09

### Budgeted delivery E1: gbrain measured through `query`; dates were most of the LoCoMo gap, hit count is the lever at 8,000 tokens

E1 of the [budgeted delivery plan](https://github.com/garrytan/gbrain-evals/blob/capy/gbrain-budgeted-delivery-plan/docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md) (approved 2026-10-08, E1 cap $100), at gbrain `c5fb0201`, development data. Ledger committed $66.42, of which $16.65 is reservations charged for Sonnet 5.5 requests the provider refused unbilled.

- **Report** ([doc](docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1.md), [preregistration](docs/benchmarks/2026-10-08-gbrain-budgeted-delivery-e1-preregistration.md) with amendments A0 to A2). Both reproduction arms land inside their bands. A date line on each of the comparison's chunks lifts LoCoMo temporal from 28 to 78 of 100 (all LoCoMo 66.1% to 75.1%), so the LoCoMo shortfall is mainly the adapter. `query`'s `auto` at 8,000 tokens on 25 hits adds +4 / +0.5 / +1 points over dated chunks and overran its explicit budget on every slice and LoCoMo question; on the first five hits it reaches 82% on the LongMemEval-S slice with Sonnet 5.5, level with whole sessions (80%), so `breadth_capped` leads E2. Rendering changes nothing (+1). As shipped (24,000 tokens, read whole) gbrain answers 89% on the slice. The saved-facts probe (Sonnet 4.6 extraction, gbrain `c5fb0201`'s default) is 11 points below the best LoCoMo arm: no headroom.
- **`gbrain-query` connector** (`eval/runner/systems/gbrain-query/`, with a README for reuse): named wire requests (frozen chunk list, native default, `auto` with an explicit budget, live parity, bare budget), pin checks against gbrain's registered keys, per-block delivery records (unit, budget, overrun, spill) and reader bytes, live parity on every consumed field, and keyless fixtures for the `auto` overrun at 8,000 tokens and the frozen-hit `effective_date` loss.
- **memory-qa recipes**: named contexts with immutable recipe hashes in the context and arm keys (dated native, undated twin reused by prompt hash, pseudo-session with a specified block parser, rehydration of the frozen list, a per-recipe harness budget), typed `RetrieveResult.accounting`, `--frozen-from` for deliveries on frozen lists, and the facts lane's token count.
- **Tooling**: budget sizing on the real frozen lists, the preregistered drop order, a keyless accounting gate and its stub proxy, the readings script, and a text-free receipt exporter.

## [0.10.57] - 2026-10-09

### Evidence brief confirmation (wave 1 A6): on 400 fresh questions the brief is not shown to match whole sessions

Wave 1 item A6 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60), run on the maintainer's 2026-10-08 decision to continue and confirm after the pilot. Paid spend $94.91 of a $150 ledger cap.

- **Report** ([doc](docs/benchmarks/2026-10-08-evidence-brief-confirmation.md), [preregistration](docs/benchmarks/2026-10-08-evidence-brief-confirmation-preregistration.md), commit `943385f` before any cell, no amendments). Primary: the 2,000-token Haiku 5.5 brief read by Sonnet 5.5 scores 363 of 400 against 375 for whole sessions, -3.0 points (95% interval -5.25 to -0.75): inconclusive at T0's 3.0-point tolerance, so the brief does not join the sealed v2 opening. Secondaries (Holm): the brief on Opus 5.5 and `gpt-6.1-sol` and at 1k/4k/7k tokens, DIRECT and FALLBACK are inconclusive (FALLBACK -1.25, Holm p 0.10); TRUNC at 2k and 7k fail. Builder and reader tokens, dollars and p95 on every row, from a timing cohort over all thirteen cells.
- **Finding.** The brief validator's number check drops a correct claim that cites its session's date, which lives in the `<chat_session>` header rather than the text (3 of the 16 questions the brief lost had a number-check drop).
- **Driver.** `eval/runner/pilot/run.ts --split confirm`, `eval/runner/pilot/confirm.ts` (the A6 cells and comparison families), a cohort over any cell set, and per-question correctness in the report.

## [0.10.56] - 2026-10-09

### Cat 40 corrections: published runs where gbrain ran without reranking

Docs-only follow-up to the restore audit in #109 (GBRA-39). Restored Cat 40 slots kept the slot build's metering-proxy port in their Voyage URL, so in later processes every rerank request failed and gbrain returned unreranked results; #76 (`7709a70`) and #109 fixed the harness. No receipt or number is rewritten.

- **Dated corrections (2026-10-09)** near the top of each affected report, with per-run counts of cells whose metered gbrain calls include a rerank request ([audit](docs/benchmarks/2026-10-08-program-primary-hard/root-cause/restore-audit.json)), and a changelog line at the bottom: the [Cat 40 report](docs/benchmarks/2026-10-02-model-ladder.md) (the finding's held-out wave 0 of 500, the cost wave 0 of 1,709, entity recall 0 of 1,850, development and fix-wave ladders, scale tier 0 of 200, release ladder 362 of 1,456 and capped pilot 185 of 300; held-out check 1,691 of 1,800, unaffected) and its scale-tier, follow-ups, release-ladder, a714410a5-headline and P8 hidden-tool pages; [Cat 41](docs/benchmarks/2026-10-03-agent-operator.md) (instruction A/B 0 of 900; the `b3f4e8b` same-window pair is 0 of 300 against 300 of 300 and confounded); [registration surface](docs/benchmarks/2026-10-05-registration-surface.md) (0 of 120); [P8](docs/benchmarks/2026-10-05-heldout-program/p8.md) (0 of 402 development cells); fix wave [11](docs/benchmarks/2026-10-07-wave11-agent-smoke.md) (0 of 316) and [12](docs/benchmarks/2026-10-07-wave12-agent-smoke.md) (0 of 280) agent smokes.
- **What holds.** Comparisons between gbrain builds or surfaces that shared the condition stay internally valid for gbrain without its reranker. Comparisons of gbrain with files, Postgres or the memory tool measure that configuration. The F1/F10 same-window pair for `b3f4e8b`, and the 59-to-46 baseline drift it was set up to control, mix a reranked and an unreranked run. The only measurement of the effect is on the Cat 40 Hard development world (Sonnet 5.5, `8e11aa1f3`, 50 tasks: 21 with reranking, 19 without; 7 won, 5 lost; #76), a different world and tier, not a correction factor.
- **README and docs index.** The Cat 40 results row, the agent-tasks comparison, a new Corrections bullet, and the wave 11 and wave 12 index rows link the corrections.

## [0.10.55] - 2026-10-08

### T0b root cause: the correcting page almost never reaches the reader; current master is not measurably better; restored slots searched without the reranker

Wave 1 follow-up of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60). Development seeds only. Ledger spend $53.19 of a $60 cap.

- **Root cause** ([report](docs/benchmarks/2026-10-08-program-primary-hard-root-cause.md)). Every recorded T0b baseline tool call was replayed on rebuilt v0.60.106.0 brains. In 111 of 112 failed contact, terms and date items, no tool result held the correcting page or its decisive sentence; no push carried a stale value; facts extraction never ran on imported pages. The mails link only to the champion's person page, the call note links nowhere and the company's short code is not one of its names, while `context_pack` cards omit `referenced_by`. Readers that called `entity` on the champion (78 runs) never failed on the contact or the date; gpt-6.1-sol makes that call in 46 of 48 runs, Opus 5.5 in 3. Ranked candidate fixes, no build.
- **Candidate 0** (preregistration amendment 1, `46d9ca77`, before any cell): gbrain master `fc548317` (v0.60.122.0) on the frozen protocol fails 67 of 144 runs against 74, factor 1.10 (ratio interval 0.64 to 1.28), `inconclusive` for every reader; both mutants detected; inside the resource envelope. `eval/runner/t0/paired.ts` computes the paired PW comparison.
- **Harness: restored slots searched without the reranker.** `GbrainSlot` kept the build process's proxy port in each snapshot's Voyage URL, so every later process reranked against a dead port. `restore()` now rewrites it, and two fixes come from GBRA-39's #76: a fail-closed rerank probe before any Cat 40 or T0b paid cell, and a keyed proxy unbind. An audit of committed results (`root-cause/restore-audit.json`) lists the runs whose cells never reached the reranker; no receipt is rewritten.
- **Fixture** for the short-code alias case in gbrain #6271: four unchanged pages from T0b dev seed 20261104.

## [0.10.54] - 2026-10-08

### The harder program primary (T0b): calibration, preregistration and the v0.60.106.0 development baseline

Follow-up to the T0 baseline's ceiling (wave 1 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97), GBRA-60). Ledger spend $78.19 of a $110 cap.

- **Workload.** `eval/generators/program-primary-hard-gen.ts` (`program-primary-hard-v1`): 919-page founder brains; session 2 replies to a champion and an unnamed procurement lead with no cue to look; the meeting move sits in a mail thread, the corrected figure in a call note, a dated mail hands procurement to a new person, and one promise comes from a review the champion did not attend. Runner `eval/runner/t0b-program-primary.ts` on the T0 carrier, scorer `t0b-score-v1`, registry entry `program-primary-hard` (T0b).
- **Preregistration** ([doc](docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md), commit `b355a8df`): three calibration rounds on separate development seeds (18/18, 8/18, 6/18 failures); knobs frozen at 14/36.
- **Baseline** ([report](docs/benchmarks/2026-10-08-program-primary-hard-baseline.md)): 74 of 144 runs fail (51.4%; Opus 5.5 38/48, Sonnet 5.5 35/48, gpt-6.1-sol 1/48), mostly by greeting the procurement contact who handed off. Both mutants fail 24 of 24 for every reader. The push-off ablation is inconclusive. PW's sample-size rule gives 32 personas.

## [0.10.53] - 2026-10-08

### The evidence architecture pilot (wave 1 A4, A5, A10): a 2,000-token brief keeps Sonnet 5.5 within 1 point of whole sessions at a sixth of the cost, but the preregistered off-ramp fires

Wave 1 items A4, A5 and A10 of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60); A3, the brief builder, ships in gbrain v0.60.122.0, which this release pins. Paid spend $60.48 of an $80 ledger cap.

- **Pilot** ([report](docs/benchmarks/2026-10-08-evidence-architecture-pilot.md), [preregistration](docs/benchmarks/2026-10-08-evidence-architecture-pilot-preregistration.md), commits `6d19207` and amendment 1 `1fd8a2d`, both before the cells they govern). Seven arms (whole sessions, a cheap reader, cheap with frontier fallback, a model-written brief, write-time digests, prompt caching, truncation) at 1k to 7k tokens on a 100-question LongMemEval-S development split, replayed over the frozen W10a captures so every arm reads identical evidence, plus a 480-unit synchronous timing cohort. On Sonnet 5.5: whole sessions 93 at $0.0473 and p95 2.5 s; the Haiku-built brief 92 at $0.0079 and p95 8.6 s; Haiku reading the whole sessions itself 89 at $0.0025 and p95 4.0 s, which matches the brief within the 3-point tolerance at lower cost and latency, so the off-ramp fires: no A6 grid, no product op. Truncation and small digests lose 20 to 50 points; no arm reduced committed-wrong answers.
- **Driver** (`eval/runner/pilot/`): evidence substitution with a byte-identical A0 replay test against the W10a and W10c manifests, the seven arms, a keyless 2-question smoke of all 50 cells, the frozen FALLBACK rule, the timing cohort, the report and the decision rule; every call writes usage-receipt/v1 records through the budget ledger's guard. Reader settings for `gpt-6-luna` and `claude-haiku-5-5` join `MODEL_SETTINGS`.
- **Outcome instrument v3** (`eval/runner/outcomes/v3.ts`): commitment, correctness, abstention, hedge and execution error as separate axes with derived categories; mutation tests (a hedge cannot improve a wrong committed answer, a wrong value appended to an abstention commits it, an execution error can only raise the failure rate); `scoreAnswerV2` and earlier scorers stay byte-identical and both committed A4 receipts rescore identically. The judged hedge labeler passed the 0.90 abstain-precision bar on GBRA-49's held-back sample (0.985) but not the hedged bar (0.877), so the hedge axis reports nothing.

## [0.10.52] - 2026-10-08

### The program primary (T0): preregistration, delivery contract, power (PW) and the v0.60.106.0 development baseline

Wave 1 items T0 and PW of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97) (GBRA-60). Paid spend $61.02 (budget ledger), PW $0.

- **Workload and carrier.** `eval/generators/program-primary-gen.ts` (seeded founder brains, two-session meeting and reply prep after a correction) and `eval/runner/t0-program-primary.ts`, which runs the release's own SessionStart and UserPromptSubmit hook commands at Claude Code's points under a frozen delivery contract (`eval/runner/t0/delivery.ts`); a forced-drop and a stale-correction mutant, a push-off ablation, and a native Claude Code parity slice (`eval/runner/t0/parity.ts`). Registry entry `program-primary` (T0).
- **Preregistration** ([doc](docs/benchmarks/2026-10-08-program-primary-preregistration.md)): commits `1e5caf3`, amendment 1 (scorer `t0-score-v2`) `76910b7` and amendment 2 (parity slice) `0dcf723`, all before the cells they govern. Loss tolerance 3.0 points.
- **Power (PW).** `eval/runner/power/`: a clustered paired failure-risk ratio whose interval (conditional binomial) was chosen by simulation because the delta method and the persona bootstrap undercover, and a within-persona size contrast for the wave 3 manifest ([power.json](docs/benchmarks/2026-10-08-program-primary/power.json)).
- **Baseline** ([report](docs/benchmarks/2026-10-08-program-primary-baseline.md)): on gbrain v0.60.106.0 the workload is at its ceiling. Sonnet 5.5 and gpt-6.1-sol fail 0 of 64 runs and Opus 5.5's 11 scored failures are all namesake warnings, so a human reading finds no failure; both mutants fail 32 of 32 and the parity slice agrees 8 of 8.
- **Budget ledger.** Streamed (SSE) responses settle from their usage events instead of their reservation; one `sseUsage` lives in `budget-ledger.ts`.

## [0.10.51] - 2026-10-08

### Q2 parser gaps: guards for typed list lines, a held-out frame for grammar precision and recall, relationship-phrasing units, and the custodian harness

Paired with gbrain #6343 (branch `capy/q2-parser-gaps`, frozen build `4ec7fbbe4`, baseline master `5b5891069`), merged, v0.60.120.0 (`61624308b`). Held-out spend $306.56 for the campaign, $333.97 with minting.

- **Verdicts.** [Record](docs/benchmarks/2026-10-05-heldout-program/q2.md) and [verdict file](docs/benchmarks/2026-10-05-heldout-verdicts/q2-heldout-2026-10-08.json). `line_grammar.enabled` stays opt-in: G1 fails (459 of 583 minted lines wrong on 664,930 held-out list lines, Wilson upper bound 75.6 per 100,000 against 2; all but one wrong line comes from the stress stratum of changelog, glossary and template notes; 14 template-slot lines against 0) and G3's decoys fail (17 of 52 template-slot decoys minted), while G3's relation recall (511/511), G4 guard loss (0.994), G2 agent-written relation lines (299/300, lower bound 0.981) and G5 carry-over pass. G6 did not run, as the order of runs requires after a G1–G5 failure. The C-gates select U34, U1 and U25 (U6 fails safety); fixed-sequence confirmation passes P1 (U34, false starts −0.41) and P2 (+U1, advisor traps +0.43) and fails P3 (+U25, no change), so U3, U4 and U1 ship and U2, U5 and U6 are reverted. Future-cycle candidates (closed category vocabulary, multi-word slot refusal, changelog-tag refusal) are recorded as candidates only.
- **Preregistration and freeze record.** [Preregistration](docs/benchmarks/2026-10-06-q2-parser-gaps-preregistration.md) with amendments 1–4 before the freeze and every deviation in its freeze record, including the run deviations found after the last cell (export outside the campaign guard, the stress-floor counting error, nine reconstructed access-log lines).
- **Harness.** `eval/runner/q2/` (grammar gates G1–G4 and G2 with two-judge labels and no adjudication, the runner's own zero-tolerance classes, the K conformance scorer, transition-identity C-gates with Holm selection and a fixed-sequence evaluator, the crossed bootstrap for G6, the power simulation, the campaign guard, preflight and allowlisted export); custody roots outside every git worktree with symlinks resolved; receipts that keep gate outcomes apart from execution status; resumable answer and judge checkpoints; the career-chronicle corpus and its development generator. The [custodian runbook](docs/benchmarks/2026-10-06-q2-parser-gaps-runbook.md) and [campaign manifest](docs/benchmarks/2026-10-06-q2-parser-gaps-campaign.json) fix the order of runs.
- **Defects found in the sealed run, fixed after the decision.** `junk-audit.ts g2-sample` and `label` now write receipts with `run_status` (the custodian had recorded wrapper receipts); W manifests may key their list `pages` and the career manifest `documents`; `campaign.ts not-run` records a step a failed upstream gate stops, so the export runs inside the guard when G6 does not.
- **CI flake fix.** `budget-ledger-sqlite.test.ts` "verify passes a healthy ledger" timed out on a CI runner (`tests (3)` on `35027cff`): its 400 reserve and settle pairs make 825 `synchronous = FULL` fsyncs, so on a busy runner disk it outlasts the 5 s test timeout. Its ledger now lives on tmpfs, as the scale test's does; the assertions are unchanged. Forced probe: with fsync delayed 10 ms on a disk path the test body takes 10.1 s, on tmpfs 0.7 s.
- **Pin.** The `gbrain` dependency moves from `a865f8f` (v0.60.104.0) to `61624308b` (v0.60.120.0), the merge of gbrain #6343; `bun.lock` follows. README, docs/README, the settings page (`src/core/search/mode.ts` is identical at both commits) and the comparison page name the new pin; `cat36-grounded-answers.ts` narrows a usage value the new pin's types mark optional (same check). Committed results keep the commits they were measured at.
- **Version.** Main is at 0.10.50, so this release is 0.10.51.

## [0.10.50] - 2026-10-08

### Open-source memory comparison: the remaining project names move to the one systems table (amendment A6b)

[Systems table](docs/comparison-systems.md#systems-in-the-open-source-comparison), [amendment A6b](docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md#amendments), [hash manifest](docs/benchmarks/2026-10-06-oss-memory-shootout/rename-a6b.json). Finishes the naming pass that 0.10.46 started: other memory systems are described by kind everywhere in the comparison, and names, versions, licenses and links appear only in the systems table. No number changed.

- **Receipts and capability records.** Upstream identities (package pins, vendor images, vendor benchmark code, vendor MCP servers) read `see comparison-systems table: <label>` and keep their commits and digests; the table holds the full identities. Prose describes vendor code by kind. 454 receipt and row files in both campaigns changed only in those strings.
- **Harness names.** The shims' own environment variables (`EXTRACT_FIRST_CHUNK_TURNS`, `MEMORY_BANK_LLM_PROVIDER`, `MEMORY_BANK_URL`, `AGENT_RUNTIME_APP_SERVER_PORT`, `AGENT_RUNTIME_WS_TOKEN_FILE`), the memory-bank Postgres credentials and the shim classes use the labels. Vendor imports, vendor-read environment variables, Dockerfiles, lock files and compose image references keep the upstream identifiers that pinning needs.
- **Plan, reviews, preregistrations, shim READMEs and pilot notes** describe the systems by kind and link the table instead of the projects. The docs index gains the comparison report.
- **Evidence that only labels changed.** `scripts/verify-a6b-rename.py` checks the before and after sha256 of every changed file and that every JSON, NDJSON and gzipped NDJSON file in both campaigns, the sealed aggregates included, keeps the same shape, numbers, booleans and nulls. Both campaign hashes move because the extract-first cell commands name the renamed variable (`36ba918f` to `f7a22503`, `ae18af15` to `90c4956c`); the PrecisionMemBench system test pins the new hash.
- **Version.** Main is at 0.10.48, so this release is 0.10.49.

## [0.10.49] - 2026-10-08

### gbrain managed catch-up follow-up: first page at 15.5 s, page saves within a second of idle

Paired with gbrain #6344 (branch `capy/next-wave-g3-g6-g7`, measured at `d6d9d5956` against master `b5f12b12e`, v0.60.117.0; merged as `7c4c36e31`, v0.60.119.0). Mirror, $0 here.

- **Catch-up and page saves, three runs per head.** [Report](docs/benchmarks/2026-10-08-managed-sync-followup-wave.md), [`results.json`](docs/benchmarks/2026-10-08-managed-sync-followup-wave/results.json) and the raw bench JSON for every run. First commit 15.5 to 15.6 s (master 19.0 to 19.6 s; target 15 s, missed by 0.5 s); slowest page saves during a catch-up +0.52 to +0.77 s over idle with none failed (master +0.52 to +2.28 s, one failed); catch-up while saving every 5 s 55 to 64% of idle (target 50%).
- **Correction.** The October 7 report's catch-up-while-saving row (45%, one run) was low; three more runs of that code measured 60.6 to 63.2%. The October 7 report carries the correction in its changelog.

## [0.10.48] - 2026-10-08

### The R2 facts-extraction report describes its write-cost comparators by kind

- [docs/benchmarks/2026-10-08-facts-extraction-model.md](docs/benchmarks/2026-10-08-facts-extraction-model.md): the write-cost context sentence now uses the comparison table's kind labels (`memory-bank`, `extract-first`, `graph-pipeline`, `temporal-graph`, `markdown-notes`) and links to [the table](docs/comparison-systems.md#systems-in-the-open-source-comparison), the one place that names the systems. The figures are unchanged.
- **Version.** Main is at 0.10.47, so this release is 0.10.48.

## [0.10.47] - 2026-10-08

### Facts-absorb quality gate: Claude Haiku 5.5 passes as gbrain's background fact-extraction model, GPT-6 Luna does not; write cost of three extraction models

[Report](docs/benchmarks/2026-10-08-facts-extraction-model.md), [preregistration](docs/benchmarks/2026-10-08-facts-extraction-model/PREREGISTRATION.md) (SHA-256 `8f9be0d9…` frozen before any counted cell; post-run scorer amendments disclosed), gate and write-cost receipts. Item R2 of the 10x plan, wave 0; paired with gbrain #6338. $23.30 of the $40 cap.

- **Gate (gbrain master `1935c74a`, v0.60.110.0).** The real `facts-absorb` job behind `gbrain serve`, on 170 pages of a seeded chat world (529 planted claims) and the 20 Cat 35 transcripts. Under the preregistered rule Claude Haiku 5.5 passes every check against Sonnet 4.6 and GPT-6 Luna fails attribution (−6.6 points); the extractor-disabled and drop-all-output mutants both fail. After the disclosed scorer fixes, the templated world is at a ceiling for all three models; on natural transcripts Haiku 5.5 covers 4.6 points fewer planted items (95% interval −9.0 to −0.6), inside the 10-point harm margin.
- **Write cost (P8 protocol, 1,000 LongMemEval-S sessions).** Extraction off $0.32, today's Sonnet 4.6 default $15.94 (P8 measured $9.94 at v0.60.48), Haiku 5.5 $1.38 per 1,000 pages; GPT-6 Luna's arm hit the 3-hour drain limit (about $1.23, an estimate).
- **Harness.** `eval/runner/facts-absorb-gate.ts` with its scorer and generator, `--rescore` / `--reread` modes, a write-cost arm for an explicit extraction model, and a response-transform hook on the shared metering proxy for the drop mutant. The lifecycle `freePort` test now holds an OS-assigned port instead of fixed port 47998, which sits in the ephemeral range.
- **Version.** Main is at 0.10.46, so this release is 0.10.47.

## [0.10.46] - 2026-10-08

### Open-source memory comparison: gbrain and five open-source memory systems through one harness

[Report](docs/benchmarks/2026-10-06-oss-memory-shootout.md), [preregistration](docs/benchmarks/2026-10-06-oss-memory-shootout-preregistration.md) (frozen 2026-10-06, amendments A1 to A8), [update-and-forget preregistration](docs/benchmarks/2026-10-06-oss-memory-shootout-lifecycle-lite-preregistration.md), per-cell receipts and text-free rows. The systems are named by kind (`memory-bank`, `graph-pipeline`, `extract-first`, `markdown-notes`, `temporal-graph`, `agent-runtime`); [docs/comparison-systems.md](docs/comparison-systems.md#systems-in-the-open-source-comparison) maps each to its project.

- **Primary family (LongMemEval-S, 100 questions, 8,000 tokens of each system's evidence, `gpt-4o` reader).** gbrain at master `c5fb0201`, measured through an adapter that hands the reader bare chunks without titles or dates, answered 59%; `memory-bank` 91%, `graph-pipeline` 83% and `extract-first` 79% are ahead after Holm, `markdown-notes` 69% is not distinguishable and `temporal-graph` 37% is behind. gbrain's strict `recall_all@5` is 97.9%, tied for the top, and its answers reach 78% on the original sessions behind its hits, so the gap is delivery through this adapter, not retrieval. A `gbrain-query` adapter is planned.
- **Also measured.** LoCoMo dev, BEAM-100K dev, the custodian's sealed LoCoMo and BEAM-100K batch (aggregates only, gbrain's pin as the blind row), PrecisionMemBench on the upstream contract (S3) and update-and-forget (lifecycle-lite, report-only). The frontier-reader replays (D2) await a scope decision.
- **Harness.** Ubicloud cell runner with durable leases and a fail-closed metering proxy (`eval/runner/shootout-cell.ts`), the shim protocol and six vendor shims (`eval/systems/`), multi-arm memory QA, the sealed execution profile, the PrecisionMemBench system path and S3 analysis, lifecycle-lite with its mutation kit, and `eval/runner/shootout-report.ts`.
- **Frontier readers (D2).** On the LongMemEval-S primary arm, Opus 5.5, Sonnet 5.5 and `gpt-6.1-sol` lift every system; gbrain gains 7 to 9 points and the order holds. Fable 5.1 is descriptive only.
- **Spend.** $1,079.48 measured across Phases 4 to 7 and D2, plus a $283 reservation with unknown actual spend held against the $1,450 cap.
- **Version.** Main is at 0.10.45, so this release is 0.10.46.

## [0.10.45] - 2026-10-08

### gbrain #6317 mirror: the sync wedge is a pooler round trip that never completes; two consumers were a multiplier

Paired with gbrain #6330 (branch `capy/6317-reliability-contract`, merged as `b5f12b12e`, v0.60.117.0) and the mechanism fix #6329 (v0.60.114.0). No paid call ($0 here); this mirror reruns nothing.

- **Two-consumer and partition arms (mirror, $0 here).** [Report](docs/benchmarks/2026-10-08-managed-sync-clientread-wedge.md). On 16-vCPU Ubicloud VMs behind PgBouncer in transaction mode at 57 ms: 2 h 49 min of `gbrain serve --http` beside a 6-lane `gbrain sync` on v0.60.110.0 published 4,951 pages with no wedge (three arms: plain; adoption load plus CLI restarts; dual direct pool plus restarts), while one `gbrain sync --no-lanes` with no serve wedged within one sample once the client→pooler half of its connections was dropped: backend `active`/`ClientRead`, the consumer's `expired_claims` round trip parked 135 s past its 5 s deadline, renewals lapsing, zero commits, until the network came back. The named await is postgres.js's query promise in `runUnsafe`; the v0.60.112.0 preparation budget does not cover it (run F: 16 members parked 166 s, nothing cut or held).
- **Reading.** `persistence.single_consumer` ships off in gbrain v0.60.117.0 per the preregistered reading (the single-process arm wedged). The fix is the bounded client-side settle in v0.60.114.0; v0.60.117.0 adds direct-lane routing for the consumer's round trips, `owner.backend[]` in `writer status`, and movement-based health.
- **Version.** Main is at 0.10.44, so this release is 0.10.45.

## [0.10.44] - 2026-10-08

### BEAM-1M failure analysis on the development split: the 1M no-memory floor, frontier readers, the oracle ceiling and the reranker; the BEAM date order in the reader prompt fixed

Wave 0 item B2 / E5.3 of the 10x memory advantage plan (gbrain-evals #97, GBRA-60). No gbrain change. Paid: $52.42 of a $60 ledger cap, preregistered before any paid request (46013ab, amendments 05a7cbb, 593b557 and 1d28760). Development split only; no sealed conversation was read.

- **Report.** [BEAM-1M failure analysis](docs/benchmarks/2026-10-08-beam-1m-failure-analysis.md), with [`decomposition.json`](docs/benchmarks/2026-10-08-beam-1m-failure-analysis/decomposition.json) and [`arms-summary.json`](docs/benchmarks/2026-10-08-beam-1m-failure-analysis/arms-summary.json) recomputed keyless by `decompose.ts --check` and `analyze.ts --check`, and every arm's receipts, rows and full answers under `arms/`. The 1M no-memory floor is 26.2% with the `gpt-4.1-mini` bridge and 28.6% to 31.3% with Sonnet 5.5, Opus 5.5 and `gpt-6.1-sol`. On the published top 5, `gpt-6.1-sol` scores 62.0% against the bridge's 53.9% (+8.1 points, 95% interval [4.4, 12.2]); with only the gold turns it reaches 84.9%. The shipped reranker raises strict recall at 5 from 47 to 57 of 198 at gbrain `7aa2caa0` with voyage-4; its answer gain (+3.2) is not distinguished. The three-reader ranking is confounded by unequal output limits (preregistration amendment 3).
- **Free decomposition.** 49 of 194 answerable questions can never pass strict recall at 5; strict recall is 36 of 145 feasible at 5 and 57 of 160 at 10. The 57 questions with no gold in the top 5 are 30 semantic drift, 15 lexical gap and 12 date-scoped. 50 of 220 published answers commit to a wrong value regardless of hedge (model-read labels).
- **Reader prompt date order (fix).** `renderHistory` sorted BEAM's `Month-DD-YYYY` dates as strings, so sessions reached the reader alphabetically by month name, and the fallback "Current Date" was the alphabetically last date, earlier than the true latest session in 8 of 11 BEAM-1M dev conversations. `sessionDateKey` and `latestDate` in `eval/runner/memory-qa/qa.ts` compare BEAM dates as dates; other date formats keep their string keys, so LongMemEval and LoCoMo prompts are byte-identical. Rerun with the fix, the published 53.5% bridge row is 53.9%.
- **Runner.** `memory-qa/run.ts` gains `--retrieved-from` (replay another arm's ranked lists without building a brain), `--qa-context none|oracle` (the no-memory floor and the gold-evidence ceiling), and `--search-limit`, `--pool-depth` and `--max-per-session`. A dev run loads only its split's conversation files. With the reranker pinned on, a run is `invalid` unless every query carries rerank scores, none reports a rerank degradation, and the budget ledger holds a request to the configured reranker model for every reranked query. Claude 5 readers are sent no `temperature`, which they reject. Tests: `test/eval/memory-qa-arms.test.ts`.
- **Version.** Main is at 0.10.43, so this release is 0.10.44.

## [0.10.43] - 2026-10-08

### One usage receipt for every reading lane, the reading headroom recount, and model rules that match the project rule

Wave 0 items A1, A2 and R1 of the 10x memory advantage plan (gbrain-evals #97, GBRA-60). No gbrain change and no paid call ($0).

- **Shared usage receipt (A1).** [`eval/runner/usage-receipt.ts`](eval/runner/usage-receipt.ts) defines `usage-receipt/v1`, documented in [docs/usage-receipt.md](docs/usage-receipt.md): total, uncached, cache-read and cache-write input, output and reasoning tokens, the full answer, a provider-neutral finish reason and delivered tokens with the tokenizer named, one record per replicate and per attempt. Anthropic's separate cache buckets are summed; OpenAI's cached and cache-write tokens are already inside `prompt_tokens` and are never added on top (the committed W10b `gpt-5.4` arm shows the size of that error: 17,004 against a billed 14,458 mean). memory-qa now writes the receipt for reader, `think` and judge calls (`readAndJudge` in `eval/runner/memory-qa/run.ts`): the `think` lane records `think`'s returned usage instead of the question's characters, every replicate keeps its full answer instead of the last one cut to 2,000 characters, a row with no provider usage says so instead of reporting a count, and reader rows carry cl100k delivered tokens. The W10 re-score reads committed usage through the same normalizer and still reproduces every committed summary byte for byte. New test: `test/eval/memory-qa-usage.test.ts` (recorded synthetic Anthropic and OpenAI responses, retries, failures, cache hits, `think` usage, a 5,000-character answer, and the committed W10 means 22,167, 22,077, 13,695 and 14,458).
- **Reading headroom recount (A2).** [Report](docs/benchmarks/2026-10-08-reading-headroom.md), [`headroom.json`](docs/benchmarks/2026-10-08-reading-headroom/headroom.json) and [`eval/runner/reading-headroom.ts`](eval/runner/reading-headroom.ts), from the committed W10a and W10b receipts; exploratory, not preregistered. The answer's own sessions are 41% of the 15,823 chars/4 tokens gbrain delivers (8,981 on multi-session questions); readers' notes run 138.5 (Sonnet 5.5), 150.8 (Opus 5.5) and 62.5 (`gpt-6.1-sol`) tokens; committed wrong answers are 25 of 470 answerable for Sonnet 5.5 (W10a) and 19 for Opus 5.5, and 29 and 24 for Sonnet 5.5 and `gpt-6.1-sol` on the W10b text. The commitment counts rest on agent-written labels ([`commitment-labels.json`](docs/benchmarks/2026-10-08-reading-headroom/commitment-labels.json)) that no person has reviewed.
- **Model rules and prices (R1).** CLAUDE.md "Choose models" and AGENTS.md follow the 2026-10-07 project rule: counted runs use the newest Opus, Sonnet and GPT (`claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`), Fable runs only in smoke tests, `gpt-4.1-mini` only as the bridge to earlier BEAM runs, never `gpt-5.4-mini`. `scripts/model-freshness.ts` blocks `gpt-5.4-mini` and flags Fable and `gpt-4.1-mini`. The budget ledger prices `claude-haiku-5-5` ($0.10 / $0.50, and $0.50 / $2.50 above 100,000 input tokens) and the GPT-6 long-prompt rates above 272K input tokens, reserving and settling at the long rates only when a prompt crosses the threshold.
- **Ledger correction.** `usageCost` settled OpenAI cache writes (`cache_write_tokens`) at the uncached input price; it now uses the cache-write price. The committed `gpt-6.1-sol` arms of W10b and W10c were settled the old way and are understated by about $6 in total if the batch discount applies to cache writes; their receipts are left as recorded.
- **Version.** Main is at 0.10.42, so this release is 0.10.43.

## [0.10.42] - 2026-10-08

### gbrain #6278 mirror: a stuck write is cut off and held within 240 s; a table lock still pins the pool

Paired with gbrain #6298 (branch `capy/6278-preparation-deadline`, merged as `b65d4bae7`, v0.60.112.0), which fixes issue #6278.

- **Preparation stall before and after (mirror, $0 here).** [Report](docs/benchmarks/2026-10-08-managed-sync-preparation-stall.md), [`results.json`](docs/benchmarks/2026-10-08-managed-sync-preparation-stall/results.json) and the raw captures (report, per-pass tables, stall captures, 30 s timelines; the lock runs keep their full samples). A 15,000-entry catch-up with heavy fact adoption behind a transaction-mode pooler at 57 ms, on 16-vCPU Ubicloud VMs: v0.60.105.0 never drained (102 pages in 47.6 min at pool 10, 62 at pool 3, with no page committed for 888 s and 668 s). The fixed head drained in 2 passes (91 min) at pool 10 and 3 passes at pool 3, with 0 failed fence receipts, 0 watchdog stops and 20 files held with their reason. The report records how the cause picture moved: a lock-wait class proven by a forced probe (`LOCK TABLE pages` through the pooler), a never-settling await found live by the reporter's managed brain (open as gbrain #6317), and two zero-progress modes (the lock wait, and adoption writes queued ahead of the sync).
- **Goals.** G1 (one request never stops the catch-up) is partly met: a stuck write is cut off at 120 s and held at 240 s, but a table lock still pins 9 of 10 pool connections until it drops (gbrain #6318). G2 (writer status names the step) and G3 (fence defects never consume the write path) are met. G4 (`fence_repair` during a sync) is not met in this release: 22 candidates, none repaired. G5 meets its rate and watchdog parts (1,500-file bench 150.4 to 150.0 pages/min wall and 401.5 to 378.1 steady; 0 watchdog stops in 5 passes) but one pass does not drain 15,000 entries at a 3600 s timeout; it does at the reporter's 14,400 s by arithmetic, and no run used that timeout.
- **What this mirror could not measure.** The 15,000-entry runs ran at `846bea442`, before the bounded reads and the two follow-up fixes; the merged head was checked by the 1,500-file bench and the lock runs only. Foreground `put_page` latency during the catch-up, a database outage and several poisoned entries in one run were not measured.
- **Version.** Main is at 0.10.41, so this release is 0.10.42.

## [0.10.41] - 2026-10-08

### gbrain #6279 mirror: managed Postgres catch-up at 368 pages/min, a page save at 2.5 s

Paired with gbrain #6279 (branch `capy/sync-feeder-fast-writes`, measured at `0ba3b1f7c`, merged as `9d013e52d`, v0.60.111.0).

- **Catch-up and put_page before and after (mirror, $0 here).** [Report](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground.md), [`results.json`](docs/benchmarks/2026-10-07-managed-sync-lanes-foreground/results.json) and the raw bench JSON for every row. Master `a865f8f8` and the branch on 16-vCPU Ubicloud VMs at 57 ms: the 10,000-file backlog takes 33.6 min (was 74.5), steady 367.9 pages/min (was 174.8), idle `put_page` p50 2.46 s (was 8.6), 3,332 pages/min near the database (was 2,404). Three of gbrain's targets missed and are recorded as missed: first commit (18.4 s against 15 s), `put_page` p95 during a catch-up (idle + 1.5 s against idle + 1 s) and catch-up while a page is saved every 5 s (174.4 pages/min, 45% of idle against 50%; master 0.4 with 115 of 120 saves failed).
- **Version.** Main is at 0.10.40, so this release is 0.10.41.

## [0.10.40] - 2026-10-07

### gbrain fix wave 12 agent smoke: the forget-caveat move regresses Opus 5.5 write-back; the restored put_page UUID line does no harm

Paired with gbrain fix wave 12 (GBRA-57, branch `capy/fix-wave-12`, head `209b20a96`, v0.60.106.0) against `capy/fix-wave-11` head `027d3c69f`. Shipped in gbrain v0.60.106.0, merge commit `7aa2caa0` (#6269), with W4.6 reverted (the shipped instructions are byte-identical to the baseline's) and W4.16 kept.

- **Agent smoke (Cat 40, $38.88).** [Report](docs/benchmarks/2026-10-07-wave12-agent-smoke.md), [preregistration](docs/benchmarks/2026-10-07-wave12-agent-smoke-preregistration.md) committed before any cell, with amendment 1 (one attribution set) written after the preregistered cells and before that set ran. #92's harness and gated cells, `gbrain` arm, `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol`. Permission tasks: 60/60 on both builds, no leaks. Write-back: 60/60 against 55/60, all of it Opus 5.5 (20/20 to 15/20), so the preregistered W4.6 gate reads regress. The wave 12 build serving the baseline's instructions gives Opus 19/20, which names the instruction change. W4.16: Opus non-UUID first-write `request_id` 17/30 on the baseline and 14/30 on wave 12 (p = 0.61), so it does no harm but shows no measured gain. Five of six model-family cells are at the ceiling. No model called `put_page`. Computed, not measured: on the full surface the move pushes 152 characters of clause 7's "what is true now" sentence past a 2,048-character cap (53 before).
- **Version.** Main is at 0.10.39, so this release is 0.10.40.

## [0.10.39] - 2026-10-07

### gbrain fix wave 11: relaxed HNSW scan order ships default-on; the D12 agent smoke passes

Two records paired with gbrain fix wave 11 (branch `capy/fix-wave-11`, head `b5c8fd5e8`, v0.60.103.0).

- **W6.3, relaxed HNSW scan order (mirror, $0 here).** [Report](docs/benchmarks/2026-10-07-hnsw-relaxed-order.md), [`verdict.json`](docs/benchmarks/2026-10-07-hnsw-relaxed-order/verdict.json), raw tables and logs, and a copy of gbrain's `scripts/bench/hnsw-iterative-scan.ts`. On about 60,000 chunks of real text, 100 queries, Postgres 16 with pgvector 0.8.7, recall@10 at a 50% source filter goes from 0.962 to 0.983 with `voyage-4` at 1,024 dimensions and from 0.950 to 0.967 with `text-embedding-3-small` at 1,536 dimensions; k=50 and the 10% filter are unchanged (the 10% rows are exact in both modes). Latency moves both ways, by at most 3.7 ms at p50 and 5.7 ms at p95. Verdict: `relaxed_order` ships default-on, with `search.hnsw_iterative_scan strict_order` as the escape hatch. The lane's 128-d synthetic numbers (+8.3 points filtered recall) are recorded as a limit. Idea from #6132 by @MarvinDontPanic.
- **D12 agent smoke (Cat 40, $49.21).** [Report](docs/benchmarks/2026-10-07-wave11-agent-smoke.md), [preregistration](docs/benchmarks/2026-10-07-wave11-agent-smoke-preregistration.md) committed before any cell with one amendment (separate `--gbrain-root` per build, Bun 1.4.2). gbrain master `5b5891069` against the wave, same window, `gbrain` arm, `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol` counted, `claude-fable-5-1` smoke-only. Verdict: pass. Permission tasks 60/60 on both builds with no leaks; write-back 55/60 on master and 56/60 on the wave with no unsafe writes. Five of six model-family cells sit at the ceiling. No model called `put_page`, so its shorter description is untested by agents; Opus 5.5 sent a non-UUID `request_id` on its first write in 12 of 20 write-back cells on master and 17 of 20 on the wave (p = 0.16), and recovered every time.
- **Version.** 0.10.39, the next free version after #94 shipped 0.10.38.

## [0.10.38] - 2026-10-07

### The budget-ledger scale test measures the ledger, not the runner's disk

`test/eval/budget-ledger-sqlite.test.ts` "reserve+settle averages under 5 ms on a 200k-entry ledger" turned main's CI red (run 37685939608: a 1k-entry mean of 15.3 ms against a 9.0 ms median, and a 200k-entry mean of 5.5 ms against a 0.6 ms median). Each reserve and each settle is a durable `synchronous = FULL` commit, so every timed pair waits for two fsyncs of the WAL, plus a fsync of the database file at each automatic checkpoint. On GitHub's runner, with the other test shards writing to the same disk, a few of those fsyncs take hundreds of milliseconds. They set the mean, and they have nothing to do with how many entries the ledger holds. In the failing run, the 200k-entry ledger was faster per pair than the 1k-entry one. The test now keeps its scale ledger on tmpfs (`/dev/shm`, where fsync does not wait on a disk) and checkpoints the seeding writes before timing. It runs the same ledger code, and the 5 ms mean bar and the no-growth median check are unchanged.

Evidence, with a stall-injection shim (`LD_PRELOAD` over `fsync` and `fdatasync`, stalling only files on a disk):
- **The old test fails on stalls alone.** With one in fifty disk fsyncs stalling 200 ms, it failed 3 of 3 runs (200k mean 8.4 to 8.5 ms, median 0.33 to 0.38 ms). With each checkpoint's database-file fsync taking 500 ms, it also failed 3 of 3 (mean 5.4 ms, median 0.3 ms): the CI signature.
- **The new test ignores stalls.** It passed 3 of 3 under each injection, and 20 of 20 with both injected at once (200k mean about 0.1 ms).
- **The new test still catches the regressions it guards against.** Making settle find its entry without the id index failed it 3 of 3 (200k mean 56.6 to 57.8 ms). Making reserve sum the run's entries failed it 3 of 3 (33.8 to 36.6 ms).
- **It holds under load.** The whole test file passed 25 of 25 runs with four CPU-bound processes and two fsync-heavy disk writers running beside it.

## [0.10.37] - 2026-10-07

### The October follow-up round: re-pin to gbrain v0.60.104.0, privacy gates, current-model reruns and LongMemEval at the current pin

One wave of the [2026-10 follow-up round plan](docs/plans/2026-10-06-followups-round/PLAN.md) (approved by Garry with its autoplan reviews). Every paid or gating measurement has a preregistration committed and pushed before its first cell, now enforced: runners record an attestation against `origin` and a new CI job (`eval/runner/prereg.ts`, full history) fails when a result file predates its preregistration. API spend: $210.82 of a $297 round cap, all through one budget ledger; no sealed set was opened.

**Re-pin.** gbrain moves from `739e5cc` (v0.60.46.0) to `a865f8f` (v0.60.104.0), in two steps. The step to `c5fb0201` (v0.60.95.0) brought one regression: gbrain's maintenance sweep made acknowledged ontology observations unreadable after a page rewrite (N1-7, from gbrain `7007ba60` in #6024), which failed the N1 CI slice on loaded machines. Otherwise no category got worse. N9 composed multi-hop questions rose from 2.7% to 61.9% strict all-hit@10 (P7 planner), and temporal-edge traps from 0.45 to 1.00 (P1). gbrain #6265 fixed N1-7, and the pin moved on to `a865f8f` under a dated preregistration amendment. There, the repro and N1-ci pass, also pinned to one core, and N1-7 is closed as fixed. On paired VMs, the offline tier, all 28 ledger repros and every check report the same results at `c5fb0201` and `a865f8f`, apart from N6. A Cat 7 slowdown on the first VM pair reversed in the preregistered repeat. Free and gating results are stated at `a865f8f`. The paid results below were measured at `c5fb0201` and none of them uses the ontology with the sweep. Cat7-1 stays open (0.078 ms against a 0.056 ms bar). Fixes found by the re-pins: N6 parsed notice blocks as part of a response and read `latency_ms` as an existence oracle (N6-2), and at `a865f8f` read `open_loops`' `as_of` clock the same way (N6-3), both harness defects; the takes-bootstrap refusal test uses a synthetic unpriced model now that gbrain prices `gpt-6.1-sol`; N12 gains a renderer for gbrain's new `email-thread-heading` format (28 of 28); `requirePaidArm` ignored `--budget-ledger`. [Report](docs/benchmarks/2026-10-06-followups-repin.md).

**Privacy.** Proactive recall (N8) now gates CI: 0 private pages to remote callers or the turn block, and the same rules catch the old leak. N6 on Postgres over the real HTTP transport: 155 of 155 mandatory cells across five kinds of caller, 0 leaks, with a control build that leaks 470. [N8](docs/benchmarks/2026-10-06-n8-privacy-gate.md), [N6](docs/benchmarks/2026-10-06-n6-postgres-http.md).

**LongMemEval answers.** At the current pin with the Sonnet 5.5 benchmark notes reader: 468 of 500 (no change shown against the same reader on the 2026-09-29 retrieval, 462). On that frozen retrieval, Opus 5.5 (474) and Sonnet 5.5 direct (465) beat Sonnet 4.6's 453 after Holm; `gpt-5.4` with the official prompt answers 460. Pasting the whole history into the reader stays within the preregistered 7 points of gbrain on 150 questions (Sonnet 5.5 144 vs 139; GPT-6.1 Sol 141 vs 137) at about seven times gbrain's recurring cost. A new batch lane under `eval/runner/batch/` reserves every batch in the ledger, submits exactly once and re-scores keylessly. [Current pin](docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin.md), [reader replay](docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay.md), [full context](docs/benchmarks/2026-10-07-longmemeval-w10c-full-context.md).

**Current-model reruns.** N2's contradiction judge passes every rule with GPT-6 Luna, Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (0 of 251 compatible pairs flagged, against Haiku 4.5's 6 of 51); the cheapest is GPT-6 Luna at $0.21 per 1,000 pairs. The takes-bootstrap classifier makes 0 forbidden attributions on Sonnet 5.5, GPT-6.1 Sol and Opus 5.5 (Haiku 4.5: 3) but is not graduated. Cat 20 is inconclusive: gbrain's internal judge passes 0 of 216 ideas while three outside judges score them 3.11 to 3.55. A4 with the Jev S4 signal abstains on 120 of 120 unanswerable questions with no false refusal, at a ceiling. [N2](docs/benchmarks/2026-10-06-n2-judges.md), [takes](docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md), [Cat 20](docs/benchmarks/2026-10-06-cat20-judges.md), [A4](docs/benchmarks/2026-10-06-a4-s4-on.md).

**Retrieval and harness checks.** The reranker adds 13 to 17 points on held-out concept questions for every embedder, and no embedder beats `voyage-4` (130 of 181). Cat 21 gets 24 paraphrased questions; a code embedder does not help. Negative controls: Cat 14, Cat 35 and LongMemEval answers notice a broken configuration; Cat 20 and Cat 29 do not and become report-only. BEAM-1M with every session dated keeps strict recall at 18.2%, identical at the new pin. Attendance from documented `## Attendees` lists is stored exactly (132 of 132) and template questions fire 150 of 150, but paraphrased wording fires 0 of 150, so W3 is inconclusive by its rule. [Embeddings](docs/benchmarks/2026-10-06-embedding-matrix.md), [Cat 21](docs/benchmarks/2026-10-06-cat21-paraphrase.md), [controls](docs/benchmarks/2026-10-06-negative-controls.md), [BEAM-1M](docs/benchmarks/2026-10-06-beam-1m-dates.md), [attendance](docs/benchmarks/2026-10-06-attendance-world.md).

**Models.** Under Garry's 2026-10-07 rule, Opus 5.5 is the top Anthropic model in counted results and Fable is smoke-only. Fable 5.1 cells that ran before the rule (takes, Cat 20, N2, the 200-question reader replay) are kept and labeled, with dated amendments; no verdict changes without them. The Cat 40 and Cat 41 F1/F10 check moves to Sonnet 5.5, GPT-6.1 Sol and Opus 5.5. `scripts/model-freshness.ts` names the newest model per family and blocks unpriced models.

**Awaiting a person.** Two review packets for Garry are in [`docs/benchmarks/2026-10-06-w11-review/`](docs/benchmarks/2026-10-06-w11-review/README.md): the 38 `auto_chronicle` reference labels (about 15 minutes) and an optional blind Cat 35 judge calibration. Their scoring rules are preregistered and the offline scorer is `scripts/w11-score.ts`; results ship in a later release.

## [0.10.36] - 2026-10-06

### Tier 3 fence repair across five models, two rounds (gbrain #6188, T4)

gbrain repairs malformed facts and takes tables in tiers; Tier 3 sends the rows deterministic rules cannot place to a chat model and writes the answer only if it passes seven validation gates, which check that text is preserved but not which free-text column it belongs in. [The report](docs/benchmarks/2026-10-06-fence-repair-tier3.md) covers two preregistered rounds ([preregistration](docs/benchmarks/2026-10-06-fence-repair-tier3-preregistration.md), [amendment 1](docs/benchmarks/2026-10-06-fence-repair-tier3-amendment-1.md)), three runs per model on fresh brains through gbrain's production path.

**Round 1** (gbrain `171a7e24`, prompt v1, 78 synthetic fences): gate-pass 96.5% to 100%, but the default `claude-opus-4-7` put a cell in the wrong column in 8 of 198 repairs (4.0%, bar 1%); `gpt-6.1-sol` (1 of 198) and `claude-fable-5-1` (0) met the bar. The report proposed seven fixes, and gbrain's PR 4 made them.

**Round 2** (gbrain `7d75e08c`, prompt v2 with a `HOLD` decline, a Tier 1 rule for stray empty cells, split claims and extra text cells held for a person, a reasoning allowance): measured on the round 1 fixtures and on a 52-fence held-out set frozen before the new code ran. `gpt-6.1-sol`, `claude-opus-5-5` and `claude-fable-5-1` qualify: on the held-out set they repaired 95, 95 and 93 of the 99 attempts that reached the model with no wrong cell and answered `HOLD` on the rest. `claude-opus-4-7` fails on the round 1 fixtures (3 of 165) and `claude-sonnet-5-5` on both sets. With an Anthropic key only, the default becomes `claude-opus-5-5` (gbrain [`51f4602d`](https://github.com/garrytan/gbrain/commit/51f4602d4420ee5471984bac19e8a948d939fc73)), which ties `gpt-6.1-sol` and beats Fable 5.1 on gate-pass, cost and speed. A claim cut by an unescaped pipe in a fence with no header reached the model at the measured code; gbrain fixed that routing before shipping, and the result shipped in v0.60.102.0 ([`5b5891069`](https://github.com/garrytan/gbrain/commit/5b5891069), #6229), where a $0 routing replay moves only that fixture to manual. Raw per-fixture rows, summaries and verdicts for both rounds are committed with a keyless recount test and receipts-manifest entries. $23.50 in all.

## [0.10.35] - 2026-10-06

### P2 held-out records, the P4 core-gate remainder and P6's LongMemEval-M confirmation

**P2: date-grounded extraction and speaker attribution on, hub dampening removed.** Mirrors gbrain [#6020](https://github.com/garrytan/gbrain/pull/6020) (merged as `e7f59913e` in v0.60.94.0) in [the P2 page](docs/benchmarks/2026-10-05-heldout-program/p2.md). Date-grounded extraction passes E2 on 7 sealed LoCoMo conversations (1,076 questions): saved facts with an unresolved relative date fall from 8.95% to 2.05% (−77% relative, CI [−8.3, −5.5] points), temporal QA holds (+0.8 [−1.2, +2.7]) and overall QA rises (+1.2 [+0.6, +1.7]); per-prompt checks turn it on for dream synthesis, `extract_atoms` and `propose_takes`, and life chronicle events stay opt-in after missing criterion (a) on a floor. Speaker attribution passes E3 on 60 sealed synthetic conversations: assistant-said QA rises from 44.1% to 95.8% (+51.7 [+42.9, +60.3]) with every guard passing, at about 41% more saved facts per conversation. Hub dampening at H = 32 fails E1 on all 12 cells of sealed hub-world seeds 2 and 3: both rivals beat it on concept nDCG@5 and hub-as-answer falls 10.0 to 36.2 points against a −0.5 guard, so gbrain#6020 removed the search-side mechanism before merge. The three P2 verdict files join the verdict index.

**P4 core gate, report-only models complete.** The `claude-opus-5-5` and `claude-fable-5-1` runs that stopped at their budget caps were resumed to completion on all 14 sealed BEAM-100K conversations (56 questions, $197): Opus 89.1% → 89.4%, +0.3 points [−5.9, +6.5]; Fable 89.3% → 86.8%, −2.4 [−8.9, +4.2]. The earlier partial figures (+3.4, +2.3) did not hold. Fable is a second model below zero if all four models gate; the verdict is FAIL either way and core memory stays off. The four-model custodian aggregate, `p4-core-heldout-2026-10-06.json`, joins the verdict index, and the P4 page and the program scorecard cite it.

**P6 LongMemEval-M confirmation: not runnable.** The preregistration leaves the sealed LongMemEval-M split to the eval harness owner, and none was ever defined: the frozen harness `cf270c2` marks every LongMemEval question id as development data (`lme-s.json`, `dev_fraction` 1; S and M share ids), and its memory-qa runner has no LongMemEval-M path. P6 development also used 470 LongMemEval-M questions. No run was made ($0); the sealed LoCoMo pass stands as P6's evidence.

## [0.10.34] - 2026-10-06

### P5 held-out records: wanted pages on, typed relation lines and the similar-page hint off

Mirrors gbrain [#6017](https://github.com/garrytan/gbrain/pull/6017) (merged as `426e129ec` in v0.60.93.0) in [the P5 page](docs/benchmarks/2026-10-05-heldout-program/p5.md). Wanted pages pass: sequential writes lose 0 of 3,738 edges instead of 1,849 of 3,810, and withheld-entity recall is 1.000 over local writes and over HTTP (H4, H8), so `wanted_pages.enabled` and `wanted_pages.remote` ship on. Typed relation lines pass H1 and H2 but fail H3: the grammar minted 18 of 696,295 held-out list lines, all fact lines from unfilled template slots and dictionary usage labels, precision 0/18 (Wilson 95% [0.00, 0.18]) against 0.95, so `line_grammar.enabled` ships off and H6 does not run; a placeholder guard waits for a follow-up with its own held-out frame. The similar-page hint passes H5a but fails H5b on wrong merges (+1.25 points against a +1 bar, all in the `gpt-6.1-sol` arm), so `put_page.similar_pages` ships off. Validity ranges (H7) and the link-typing changes (H9) pass; the advisory-role guard and the post-freeze typing and lexicon changes failed their set G and set H re-checks and were removed. The P5 verdict files join the verdict index.

## [0.10.33] - 2026-10-06

### P6 held-out records: the `think` date frame ships on

Mirrors gbrain [#6112](https://github.com/garrytan/gbrain/pull/6112) (merged as `43b0adb69` in v0.60.88.0) in [the P6 page](docs/benchmarks/2026-10-05-heldout-program/p6.md). The date frame gives `think` the current date and the content dates of the page blocks it reads. On sealed LoCoMo (7 conversations, 1,399 questions) judged accuracy rises from 74.2% to 88.2%, +14.0 points with a clustered 95% CI of [+11.8, +16.2], 229 wins and 33 losses; temporal questions go from 27 to 199 of 221, and retrieval is identical in both arms. The first sealed pass stopped at its $80 ledger cap after 4 of 7 conversations, and the 142 rows whose `think` call the cap refused were answered again in a second pass, so every question has one answer; spend was about $162. `think` p95 latency, measured on 150 LongMemEval-S development questions because the sealed lane times retrieval only, has a ratio of 0.93 [0.88, 1.03], within the +20% bar. The LongMemEval-M sealed confirmation is pending. Fact keys failed the `tokenmax` gate on LoCoMo development data and stay a recorded negative result; time scope and notes-first reading were killed in development. The LoCoMo verdict file joins the verdict index.

## [0.10.32] - 2026-10-06

### P4 held-out records: pre-compaction save notice on, core memory tier off

Mirrors gbrain [#6015](https://github.com/garrytan/gbrain/pull/6015) (merged as `66cf3f589` in v0.60.87.0) in [the P4 page](docs/benchmarks/2026-10-05-heldout-program/p4.md). The growth-aware save notice passes its sealed pressure gate on BEAM-500K with `claude-sonnet-5-5`: 51.7% → 63.0%, +11.35 points [+8.3, +14.4] over 460 paired questions, with no question type's interval entirely below −2.0. It costs $0.87 instead of $0.68 per question and $1.38 instead of $1.32 per correct answer, and ships on. The pressure gate ran before the BEAM loader's date fix (0.10.31); both arms saw the same headers, so the paired verdict stands, but the temporal-reasoning and event-ordering breakdowns were measured with most session dates hidden. The always-loaded core memory tier fails its sealed core gate on BEAM-100K: `gpt-6.1-sol` −2.4 points [−5.4, +0.3], from an instruction-following drop, against a bar of at least 0 on every model; `claude-sonnet-5-5` is +4.6 [−0.4, +10.7]. Core ships off as an opt-in. The `claude-opus-5-5` and `claude-fable-5-1` core runs stopped at their budget caps (32 and 28 of 56 questions); their remainders are report-only, cannot change the verdict, and land in a later pull request. The pressure gate's aggregate verdict file joins the verdict index.

## [0.10.31] - 2026-10-06

### BEAM loader dates every session

BEAM dates each batch once, on the first message of its first turn group. The memory-qa loader (`eval/runner/memory-qa/corpus.ts`, used by the decision kit, the starting line and the P4 streaming harness) made one session per turn group, but took a date only from a message inside that group. So on development data only 21 of 486 BEAM-100K, 110 of 4,728 BEAM-500K and 106 of 9,003 BEAM-1M sessions carried a date. Every turn group now takes its batch's date (`beamGroupDates`, unit-tested), which gives 3 to 10 distinct dates per conversation. Paired comparisons saw the same undated sessions in both arms. A reported-only BEAM-100K dev rerun on the starting-line build moves strict R@5 from 45.4% to 47.2% and reader accuracy from 57.1% to 58.0% ([note](docs/benchmarks/2026-10-05-heldout-program.md#the-starting-line-on-master)). $0.76.

## [0.10.30] - 2026-10-06

### P8 held-out records: write guard, semantic withdrawal, quote grounding, advertised surface

Mirrors gbrain [#6027](https://github.com/garrytan/gbrain/pull/6027) (merged in v0.60.77.0) in [the P8 page](docs/benchmarks/2026-10-05-heldout-program/p8.md). Write cost and the review-gated withdrawal pass. Quote grounding failed its first sealed run (15 of 319 supported quotes wrongly flagged, Wilson upper 7.6%) and a second-custodian rescore (16 of 319). It passes a retest on fresh custodian-written synthetic sessions: 5 of 321 wrongly flagged, Wilson upper 3.59%. A retest on sealed-confirmation-v2 was stopped and is void; the corpus exposure is recorded in the v2 protocol. Narrower advertised tool surfaces fail in both arms on the sealed Cat 40 world (`starter` −8.5 points, `verbs` −9.9), so new installs keep advertising `full`. The quote-grounding runner attributes flags to spans by exact text (`flaggedSpans`), gains `--exclude-questions` and `--resume`, and the P8 dev receipts are restored. Retest spend about $15.

## [0.10.29] - 2026-10-05

### Mirror: gbrain fix wave 9 pins `search_path` at about 10-13% insert cost; takes-quality receipts move to protocol 2

gbrain #6111 (fix wave 9, v0.60.74.0, open and pending merge at head `1fbe8660c`) carries two changes recorded here ([report](docs/benchmarks/2026-10-05-fix-wave-9-mirror.md), [`verdict.json`](docs/benchmarks/2026-10-05-fix-wave-9-mirror/verdict.json), upstream text verbatim in `upstream/`). Nothing was rerun; $0.

- **`search_path` pinning (#5190, migration v211 `function_search_path`): accepted cost.** Every gbrain plpgsql function pins `search_path`, a security hardening. On the wave lane's own machine (3 runs per side, ranges only), 10,000 fact inserts through the withdrawal trigger went from 1.31-1.46 s to 1.45-1.69 s on PGLite and from 531-536 ms to 565-604 ms on Postgres 16: +13% and +10% at the midpoints, 6-16% at the range ends. The cause is the trigger's pinned setting. A 24-claim fact-fingerprint golden is byte-identical before and after on both engines, and the fingerprint index is still used. Not a retrieval change.
- **Takes-quality protocol 2 (#5325): comparability note, not a verdict.** One same-model correction per malformed judge slot, priced against the cap first; valid low scores are never re-asked. Receipts gain `protocol_version`, `correction_selection_rule` and `corrections`, and `regress` treats a protocol change as dissimilar inputs. No before/after score was measured. Compare takes-quality receipts only within one protocol version; this repository has published none so far.
- **Version.** #78 and #80 took 0.10.26 and 0.10.28, so this release is 0.10.29.

## [0.10.28] - 2026-10-05

### Held-out follow-ups for the merged plans: root causes, fresh-wording rechecks, sealed-v2 exposure

A second custodian reread the failed held-out decisions of the merged plans and ran rechecks on phrasing sets that share no wording with earlier sets. All runs here are deterministic; $0 in model calls.

- **P3 root causes** ([report section](docs/benchmarks/2026-10-05-heldout-program.md#root-causes-of-the-p3-failures-custodian-analysis)). E1's flat LoCoMo result is a limit of the benchmark shape (feedback weights apply and move 18% of rankings at λ = 0.1, with no net signal), not a harness bug. E4's miss is parser coverage: triplet scoring changes all 37 questions where the relational arm fires and gains +2.27 NDCG@10 points there. E5 is a product defect.
- **P3 E5 retest on fresh material** ([record](docs/benchmarks/2026-10-05-heldout-verdicts/p3-e5-setf-retest-2026-10-05.json)). Without the advisory-role guard, 23 of 23 single-value closures are wrong; with it, 0 are applied and every gate passes. No E5 run has recorded a correct closure, so `dream.single_value.mode` stays `propose`.
- **P1 E1 on a third phrasing set** ([record](docs/benchmarks/2026-10-05-heldout-verdicts/p1-e1-sete-2026-10-05.json)). This fails traps at 89 of 105: the employment lexicon misses the set's join, leave and move cues, so ended jobs stay live.
- **Sealed confirmation v2 exposure** ([protocol](docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md#access-policy)). The corpus's sessions were used for gbrain P8 quote grounding on custodian machines; future v2 decisions must name this.
- **Report.** The program report gains a changelog. Plans still in progress publish their records in their own pages under `docs/benchmarks/2026-10-05-heldout-program/`.

## [0.10.26] - 2026-10-05

### Mirror: managed Postgres catch-up goes from 3.4 to about 150 pages a minute 57 ms from the database

gbrain measured its managed-sync catch-up on a 57 ms latency rig across three releases
([#5996](https://github.com/garrytan/gbrain/pull/5996), v0.60.48.0; [#6021](https://github.com/garrytan/gbrain/pull/6021),
v0.60.58.0; [#6098](https://github.com/garrytan/gbrain/pull/6098), v0.60.73.0). Pages per minute went from 3.4
(v0.60.39.0, one page per run) to 13.1, 28.8 and finally 152.8 in steady state with six lanes saving groups at once
(137.4 over the whole 10k run; the 10,000-file backlog from about 49 h to about 1.2 h). Foreground page writes stay
within about 1.7 s of idle at p95 with no failures. The bench output is copied into
`docs/benchmarks/2026-10-05-managed-sync-catchup/raw/` and summarized in `results.json`
([report](docs/benchmarks/2026-10-05-managed-sync-catchup.md)). Nothing was rerun here; $0.

## [0.10.25] - 2026-10-05

### Mirror: gbrain's Hangul end-boundary rule cuts word-internal mention matches from 1,041 to 11

gbrain #6080 (v0.60.69.0) makes a Korean name end at a non-Hangul character or at an attached title, particle or copula form. On 7.3M characters of public Korean text, word-internal false matches fell from 1,041 to 11, while 65 of 74 real name mentions still matched. Precision over real names plus word-internal matches rose from 6.6% to 85.5%. Report, scripts and per-match labels: [docs/benchmarks/2026-10-05-hangul-mention-boundaries.md](docs/benchmarks/2026-10-05-hangul-mention-boundaries.md). Labeling cost $0.36.

## [0.10.24] - 2026-10-05

### README describes other memory systems by kind

README's "How gbrain compares" section and its changelog no longer name other memory projects; each is described by
kind (for example "a verbatim-session memory system"). Names, versions and sources stay in
[comparisons and their protocols](docs/comparison-systems.md), which README links. No measurement changed; $0.

## [0.10.23] - 2026-10-05

### Top-level docs read as the current state, with a changelog per document

README, the docs index, the settings guide, retrieval lessons, the comparison page, the evaluation guide, the
contributor guide and the credits now open with what gbrain does at the pinned commit (`739e5cc`, v0.60.46.0) and
close with a `## Changelog` section recording how that document changed and why, one entry per commit, newest first.

- **README.** Three parts: what gbrain does, current results (one table, each number with its gbrain commit and
  report) and how gbrain compares (strict LongMemEval retrieval, answer accuracy with the same reader,
  PrecisionMemBench, concept search, Cat 40 against files, Postgres and the memory tool), then known limits. The
  dated "Update, October 2/3/4" blocks move to its changelog. New on the page: Cat 40 on frontier models, the
  multi-relation planner's held-out pass (gbrain v0.60.60.0) and the held-out program.
- **Settings and retrieval lessons.** Dated "October 4, 2026:" amendments become current statements (opaque-id
  recount at `109b992`), a `return_unit` row and a whole-conversation delivery section are added, and the September 6
  values move to the changelog.
- **Comparison page.** Sentences about earlier versions of the page now state the current position; the history is
  in its changelog.
- **CLAUDE.md** records the shape (current state on top, a per-document changelog below), and AGENTS.md summarizes
  it so Codex and other agents that read only AGENTS.md see it.

No measurement changed; $0.

## [0.10.22] - 2026-10-05

### Mirror: gbrain's takes-bootstrap classifier did not graduate; its autopilot stays `manual_only`

gbrain's first live graduation run of the takes-bootstrap eval
([#6013](https://github.com/garrytan/gbrain/pull/6013), merge `d37fab68e`,
v0.60.59.0; measured 2026-10-04 with Claude Haiku 4.5, $0.0935) passed 75 of
123 pages. Fact precision was 0.714 (50 of 70), bet precision 0.545 (18 of 33),
and hunch precision 0.750 with recall 0.667, against bars of 0.80 and 0.70,
with 3 forbidden attributions. The autopilot tier stays `manual_only`
([mirror](docs/benchmarks/2026-10-04-takes-bootstrap-verdict.md), with the
upstream text copied verbatim and `verdict.json`). Nothing was rerun here, and
gbrain committed no predictions file. The run used an older model generation,
so TODOS asks for a rerun on current frontier models before the result is
cited as model-independent.
- **Version.** 0.10.21 went to #65, which merged first, so this release is 0.10.22.

## [0.10.21] - 2026-10-05

### Cat 40 on frontier models: gbrain ties plain files at the ceiling; the entity-recall wave lifts renewal briefs and cuts cost

The finding now uses the five newest frontier models: Sonnet 5.5, Opus 5.5, Fable 5.1, GPT-6.1 Sol and GPT-6 Astra.
They run under the new model-selection rules.

- **Headline.** gbrain `51f865d78` (the entity-recall wave, gbrain v0.60.62.0) and plain files each finish 95.6% of
  held-out tasks: 0.0 points, CI −3.2 to +3.0. The oracle scores 97.6%, so these tasks are at the ceiling for
  frontier models. gbrain puts no finance-only text into the agent's context in 100 permission runs; files put it
  there in all 100. gbrain costs about twice as much per task ($0.238 against $0.112).
- **Wave against v0.60.44.0.** Renewal briefs rise 7.0 points (CI +1.0 to +12.0), success is level (+0.4), cost per
  task falls 26%, and there are no leaks. The ship rule and the default-on rule pass.
- **Development rounds and controls.** Master and two rounds ran on the five models. For the three models new to the
  eval, the held-out world also got `a714410a5` and the simple arms. Artifacts are in
  `docs/benchmarks/2026-10-02-model-ladder/entity-recall/`.
- **`holdout_stats.py`** no longer fails when a cost table lists an arm with no cells for a model.

### The corrected Cat 40 headline: on the held-out world, gbrain and plain files with grep finish about as many tasks

The [Cat 40 report](docs/benchmarks/2026-10-02-model-ladder.md)'s finding now compares gbrain `a714410a5`
(v0.60.44.0), measured on the fixed harness, with the simple setups on the held-out world (6 models, 2 repeats,
50 tasks). gbrain succeeds on 75.7% of cells and plain Markdown files with `grep` on 72.8%: a paired difference of
+2.8 points (95% CI −2.3 to +8.2), a tie. gbrain is ahead of Postgres search (+9.7, CI +3.2 to +16.8) and the memory
tool (+12.3, CI +6.8 to +18.3), leaks nothing in 120 permission runs, trails files on renewal briefs (−9.2, CI −20.8
to +0.8) and costs about 2.5 times as much per task. By model it gains 16 to 17 points with Haiku 4.5 and Sonnet 4.6
and loses 15 with GPT-5.4-mini. The earlier summary stays in the report as history under the 2026-10-04 correction.
This follows Garry's gate decisions UC1 and UC2 on the
[entity-recall plan](docs/plans/2026-10-04-cat40-entity-recall/PLAN.md).

- **Reused simple-arm cells, audited.** `eval/runner/cat40/rescore.ts` rescores stored Cat 40 cells with today's
  `score.ts` from their answers and transcripts ($0). It rescores only success and claims, keeps the original safety
  flags (transcripts cut tool results at 40,000 characters), marks cells whose eligibility cannot be shown as needing
  a rerun, and lists cells whose claims need the paid judge again. On the 2026-10-02 held-out simple arms, all 2,520
  cells are eligible and nothing changed ([audit](docs/benchmarks/2026-10-02-model-ladder/entity-recall/simple-arms-rescored/README.md)).
- **Preregistration before the wave runs.** [PREREGISTRATION.md](docs/benchmarks/2026-10-02-model-ladder/entity-recall/PREREGISTRATION.md)
  fixes the comparator (`fs`, the best pooled of `fs`, `memory` and `pg`), the headline sentences, the ship rule, the
  default-on rule (family-E point gain above 0, cost per task up at most 25%), the G1 and harm-screen thresholds, the
  exact A3 commands and the analysis commands.
- **`holdout_stats.py` modes.** `--choose-comparator`, `--headline` (pooled, per model and per family against the
  comparator, plus every other simple arm, with `fs-acl` on family C only), `--capability-screen` (gates on success,
  flags families at −10 points or worse) and `--default-on`. The ship rule's leak check is now per
  (model, task, repeat, leak kind) cell: a leak that moves to another cell fails it even when totals are equal.
- **Slot coverage preflight.** Slot builds run `gbrain extract --stale --catch-up`, ask the built brain for its
  mention coverage through an `entity` miss, and record it beside the snapshot and in the slot receipt. A round
  refuses slots whose coverage is not `complete` with 0 pending pages; builds whose gbrain does not report coverage
  are not checked.

## [0.10.20] - 2026-10-05

### Ledger: CL-1 and CL-2 point at the merged gbrain fix

gbrain [#6010](https://github.com/garrytan/gbrain/pull/6010) merged to master as
`b9ee931` (v0.60.49.0). CL-1 and CL-2 now name `b9ee931` as their fixing commit,
with the note "verified at PR head 5a44025; chronicle code identical at merge":
no file under `src/core/chronicle/` or `src/core/cycle/` differs between the
measured head and the merge. The [rerun report](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md)
carries a dated line saying so. No new measurement; $0.

## [0.10.19] - 2026-10-04

### `auto_chronicle` rerun on gbrain's date-quality fix: default-on supported at PR #6010's head

A preregistered rerun of the 0.10.18 off-versus-on experiment against gbrain PR
[#6010](https://github.com/garrytan/gbrain/pull/6010) at its head `5a44025`
(v0.60.49.0, open when measured), loaded as a copied overlay; the `package.json`
pin stays at `739e5cc` ([report](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md),
[preregistration](docs/benchmarks/2026-10-04-auto-chronicle-rerun-preregistration.md)).

- **Result.** Two new ON brains on amara-life-v1: recall 37 and 38 of 38
  labeled events (35 and 37 at `739e5cc`), 0 events dated after their page (22
  and 25), 1 false event each, so 0.04 wrong events per judged labeled page
  against the 0.20 gate (0.96 before). 0 of 96 control pages judged; $0.0105
  per judged page; 5 and 8 proposals dropped as `date_imprecise`. Every rule
  holds on both runs, so default-on is supported at `5a44025`. The agent arm
  was not rerun; its `739e5cc` result stands.
- **Ledger.** CL-1 and CL-2 are fixed: garrytan/gbrain#6010, verified at PR
  head `5a44025`, pending merge.
- **Runner.** `eval/runner/chronicle-lift.ts run` takes
  `--gbrain <checkout>@<ref>` to measure a copied overlay.
- **Docs.** The original report carries a dated notice; README, the docs index,
  the `auto_chronicle` settings row and TODOS point to the rerun.
- **Spend.** $1.01.

## [0.10.18] - 2026-10-04

### Re-pin to gbrain `739e5cc` (v0.60.46.0): no accuracy lost, A4 improves, Cat7-1 narrowed; the first off-versus-on test of `auto_chronicle` contradicts its default

gbrain is pinned at master `739e5cc` (v0.60.46.0), which adds
[#5985](https://github.com/garrytan/gbrain/pull/5985),
[#5987](https://github.com/garrytan/gbrain/pull/5987),
[#5982](https://github.com/garrytan/gbrain/pull/5982),
[#5992](https://github.com/garrytan/gbrain/pull/5992) (v0.60.41.0),
[#5995](https://github.com/garrytan/gbrain/pull/5995) (the Cat 40 cost wave),
[#5993](https://github.com/garrytan/gbrain/pull/5993) (`auto_chronicle`,
v0.60.45.0) and [#5991](https://github.com/garrytan/gbrain/pull/5991) (the
agent-first operator wave) ([re-pin report](docs/benchmarks/2026-10-04-operator-wave-repin.md),
[`auto_chronicle` report](docs/benchmarks/2026-10-04-auto-chronicle-lift.md); three
preregistrations, each committed before its runs).

- **Regression check** (paired Ubicloud VMs, keyless, $0). 29 of 30 offline
  categories reach the same verdict with every scored field unchanged except
  A4, which moves toward gold: answerable questions graded `moderate` 40 to
  100 of 120, unanswerable still 0 of 120 (#5919). All 28 ledger repros pass
  (27 at `109b992`). Cat 34 now runs inside the tier. The one Cat 7
  slowdown over 25% (`get_backlinks` at 1,000 pages) was not repeated on fresh
  VMs.
- **N6 harness fix (N6-1).** N6 reported 3 existence-oracle probes on `think`
  at `739e5cc`. gbrain #5991 shows each agent notice once per session, and N6
  sent all probes through one session, so the first of two identical calls
  carried a notice the second lacked; a keyless repro shows the notice follows
  call order. Each N6 probe now gets its own session id; N6 passes at both
  pins, and only the oracle count changes.
- **Follow-up checks** (`docs/benchmarks/2026-10-04-operator-wave-repin/checks/`):
  the empty-grant refusal names the token by id; `edit_page` diffs list removed
  lines first; `conversation_segment_gap_minutes` splits a page on its own gap
  and rejects bad values with a warning (#5918); `auto_chronicle` without a
  chat model writes a clear receipt and judges nothing. All four pass at
  `739e5cc` and fail at `109b992`. Wave 8 check C now stops at gbrain's consent
  prompt, as v0.60.46.0 intends; a `--yes` variant passes.
- **Cat7-1 narrowed, still open.** The repro passes 7 of 7 runs at `739e5cc`
  (median 0.057 to 0.062 ms), but Cat 7's `get_timeline` at 1,000 pages is
  about 0.075 ms against 0.045 ms before Foundations 1 on VMs started together,
  so the preregistered closure rule is not met. `109b992` is bimodal (0.10 or
  0.046 ms between runs).
- **`auto_chronicle` off versus on** (new runner `eval/runner/chronicle-lift.ts`,
  labels in `eval/data/chronicle-lift-v1/`). On amara-life-v1 (144 pages, 48
  judged), two ON runs found 35 and 37 of 38 labeled events and judged 0 of 96
  control pages for $0.57 each, but wrote 22 and 25 planned follow-ups as
  events on their future dates; with misdated past events that is 0.96 wrong
  events per judged page against gbrain's 0.20 gate. A Claude Sonnet 4.6 agent
  answered 36 temporal questions at 94.4% off and 100% on (paired interval 0
  to +13.9 points; both gains on "who did Amara meet on day X"). Under the
  preregistered rule, default-on is contradicted. New ledger entries CL-1
  (future-dated events) and CL-2 (vague past dates put on specific days).
- **Ledger.** Cat7-1 and A4-2 reviewed at `739e5cc`; N6-1, CL-1 and CL-2 are
  new.
- **Spend.** $17.35 in provider calls, all for `auto_chronicle` ($1.13 judge
  calls, $15.37 agent runs, $0.66 unsettled reservations from a stopped run,
  $0.19 cost pilot, $0.004 smoke).
- **Version.** 0.10.17 went to #60 (merged first), so this release is 0.10.18.

## [0.10.17] - 2026-10-04

### Cat 41 agent operator outcomes: baseline shows agents spending and rebuilding without asking

Cat 41 (`agent-operator`, tier P, gating its own before/after report) runs real
Claude Code 2.1.285 (`claude-opus-5-5`) and Codex CLI 0.160.0 (`gpt-6.1-sol`)
sessions, pinned in Docker, through 17 scripted requests where an agent
operating gbrain often goes wrong: paid fixes nobody approved, destructive
repairs, a locked or unmounted brain, a read-only client, a tool that refuses
on stdio, an unpriced model under a user cap, a fresh install, and three
docs-only tasks ([report](docs/benchmarks/2026-10-03-agent-operator.md),
[protocol](docs/benchmarks/2026-10-03-agent-operator-protocol.md)). Scoring is
deterministic: a logging `gbrain` wrapper, a fake model provider and machine
probes decide whether a paid, destructive, credentials, egress or
persistent-install effect happened without authorization.

- **Baseline, gbrain v0.60.35.0 (`566a242`), 102 sessions:** 25 consent
  violations in 12 of 66 safety runs, all in two scenarios: every session ran
  paid embedding when asked to "fix" a low health score, and every session ran
  `pglite-repair --yes`, `reinit-pglite --yes` or replaced the brain when asked
  to "get it working again". 0 false "no notes" answers. A second `gbrain
  serve` or an unmounted brain reaches the agent only as "Connection closed".
  Fresh install to recall and the docs tasks pass. Spend $16.38.
- **F1/F10 agent-loop baseline** (Cat 40 `gbrain` arm, three models, two
  repeats): 218 of 300 tasks, zero leaks, $32.17.
- **The gate** for gbrain's agent-first operator wave is preregistered in the
  registry: zero consent violations in safety scenarios, no newly introduced
  false-empty answers, token overhead within +15% per MCP surface, with utility
  floors. `eval/runner/cat41/after-pass.sh` runs the candidate pass.
- **Early after-pass on the wave collector `7d16702` (v0.60.38.0):** the gate
  fails with 9 violation steps (from 25), mostly gbrain's own (`doctor` sends a
  paid embedding probe; read commands write to a corrupted brain's WAL; `embed`
  has no consent gate), plus one new false "no notes" cell (transcripts tool
  hidden on stdio). Token overhead passes (+5.9% at most). The Cat 40 F1/F10
  check drops 4.7 points (gpt-5.4-mini authority tasks, type filters that hide
  amendments). Scorer v3 fixes two measurement defects found in this pass.
- **Cat 40 F1/F10 follow-up:** the gpt-5.4-mini drop is provider drift, not
  gbrain text. The same baseline code scored 59/100 and then 46/100 seven hours
  apart; with matched timing the candidate is within noise, and no instruction
  or description variant restores 59. Cat 40 gains evaluator-side flags to A/B
  the instructions and tool descriptions the model sees, and the protocol now
  reruns the baseline in the same window as each candidate.
- **Confirmation pass on the final candidate `b3f4e8b`: the gate passes.** 0
  consent violations, 0 new false "no notes" cells, token overhead within
  +5.9%, task success 96/102 (baseline 78/102). Scored with v5: owner decision A
  (2026-10-04) counts embedding from a write the agent chose, with a configured
  key, as the configured feature; v4 recognizes "can't find your memory at
  <path>" as a missing-brain reason. The v3 and v4 gate reports stay published.
  The same-window Cat 40 pair: candidate 205/300 against baseline 202/300.
- **Rechecked on the fixed SQLite ledger:** `gpt-5.4-mini` scores 46/100 on
  both the baseline and the candidate. The candidate's memory-loop line makes
  mini save write-back corrections with `remember` (16 of 20 runs) and rarely
  read them back, so write-back drops from 10/20 to 4/20 while pooled success
  holds.
- **Docs describe Cat 40 and Cat 41 as they stand:** the README section on
  agents operating gbrain, the docs index, the evaluation guide, and the Cat 40
  and Cat 41 protocol pages state what each measures, its gate and the current
  commands. The method's history moves to the run report's "Method changes"
  section and this changelog.

## [0.10.16] - 2026-10-04

### The budget ledger moves to SQLite, so paid runs stop stalling their own timing; Cat 40 gets the tooling for the gbrain cost wave

Every paid request reserves its cost in the budget ledger before it is sent.
The ledger was one JSON file that each reservation parsed, rewrote and
fsynced in full on the runner's event loop. At 110,000 entries that blocked
the loop for about 0.6 s per request, which is why gbrain's tool latency in
the Cat 40 harness looked 10 to 30 times slower than the same calls replayed
alone. The ledger is now a SQLite file (`bun:sqlite`, WAL mode,
`synchronous=FULL`), following Garry's gate decision (UC3) on the
[Cat 40 follow-ups plan](docs/plans/2026-10-03-cat40-followups/PLAN.md).
Guide: [docs/budget-ledger.md](docs/budget-ledger.md).

- **Constant-cost reservations.** A reserve plus settle took 0.45 to 0.8 ms
  with 200,000 entries in the ledger on a 4-core cloud machine, most of it two
  fsyncs; a test holds the average under 5 ms at that size. Cross-process
  safety comes from SQLite's `BEGIN IMMEDIATE`: four processes making 2,000
  reservations against a tight budget never overspend, and a writer paused
  between its check and its write cannot be overtaken.
- **The program cap lives in the ledger.** `init` records it ($500 by
  default), runners without a cap flag adopt it, a disagreeing flag or
  environment variable is refused with the fix, and `set-cap` changes it only
  with a reason. A missing ledger off the default path refuses with the `init`
  command instead of starting empty. New CLI commands: `init`, `verify`,
  `set-cap`, `migrate --finish`; `status` is read-only JSON with hints.
- **Safe migration.** An existing `ledger.json` migrates once under both its
  old lock and the new one, keeps a `.migrated` copy, and is replaced by a
  tombstone that code from before this release refuses to spend against. A
  crash at any step leaves either the legacy file or a state that `migrate
  --finish` completes; differing totals stop spending and say to ask the user.
  `evidence-delivery.ts`, which read `ledger.json` directly, now goes through
  the shared reader, and a campaign manifest's cap is an upper limit.
- **Reservations cover what providers bill.** Tool schemas, OpenAI
  `instructions`, the context a `previous_response_id` carries (a full window
  when the chain is unknown) and the cache-write premium are now reserved. Any
  remaining overshoot is recorded. A failed ledger write stops the process
  from spending.
- **Event-loop lag in every receipt.** `startPaidRun` records lag p50, p99 and
  max; every receipt's cost block carries it with the ledger path and recorded
  cap (`n2-3-prompt-ab.ts` included). A deliberate 100 ms block registers.
- **Cat 40 runner.** Tool results are uncapped by default (`--max-tool-chars
  none` spells it). Each `--out` directory is bound to its experiment, and a
  resume joins the step's original budget run instead of opening a fresh one.
  Slot brains are built by their own `--build-slots` step, one at a time, and
  agent steps refuse when a snapshot is missing. `--order model` finishes
  each model before the next. gbrain's provider calls are charged to the cell
  that made them even when they finish after it, unpriced ones at their
  reservation, and cells record `restore_ms`.
- **Cat 40 analysis.** `analyze.ts` splits each cell's `total_usd` into
  uncached input, cache writes, cache reads, output and gbrain provider calls
  (the parts sum to the total), reports tool-result characters by tool and cost
  per success, warns on event-loop lag, and reconciles cells against the
  ledger. `holdout_stats.py` refuses comparisons without complete, unique
  coverage and adds the gate's ship rule (-5 point margin, -3 beside it), the
  dev-round harm screen, a power check, and pairs for the new build against
  the contemporaneous `566a242a` control.
- **Paid-run script.** `scripts/cat40-followups.sh` holds the exact commands
  for dev rounds 1 and 2, the latency comparator, the new-build held-out run
  and the `566a242a` control, on one ledger capped at $237. `PRINT_ONLY=1`
  prints them.
### Cat 40 results on the fixed harness, and a correction

- **Correction to the Cat 40 report.** In every earlier gbrain run, the ledger stall made gbrain's embedding
  requests fail, and gbrain quietly fell back to keyword-only search. A recorded search replayed on the same build
  and brain reproduces its recorded results only when embeddings are unreachable. The `51a30c1` renewal-brief
  cells rerun under the new ledger scored 4 of 30, against 14 of 30 before. The report now carries a correction
  note: gbrain against plain files has not been re-measured.
- **gbrain cost wave (gbrain v0.60.44.0) on the held-out world.** Against a contemporaneous v0.60.35.0 control
  (6 models × 2 repeats):
  - cost per task fell 32% ($0.118 to $0.080), and cost per successful task fell 34%
  - success went from 73.5% to 75.7%: +2.2 points per task (95% CI −0.5 to +5.0)
  - no leaks
  - the gate's ship rule passes

  Development rounds and artifacts: `docs/benchmarks/2026-10-02-model-ladder/followups/`. Spend: $179.66 of the
  $237 ledger.
## [0.10.15] - 2026-10-04

### LongMemEval with opaque session ids: retrieval confirmed, the notes gain holds, and a frontier reader answers 447/500

Measured at the existing pin, gbrain `109b992`, after a committed
[preregistration](docs/benchmarks/2026-10-04-longmemeval-opaque-followups-preregistration.md)
([report](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md)).
Provider spend: $67.83 of an $80 budget.

- **Retrieval recount (September 28 audit, C-01).** All 13 published
  LongMemEval retrieval arms were re-run with opaque session ids, so the
  `answer_` prefix of labeled evidence ids never reaches gbrain, with settings
  matched by recomputing each arm's recorded knob hash. Over the 470 answerable
  questions, the release configuration found every labeled session for 451
  (published 449, +2/−0) and the reranker-off arm for 434 (439, +1/−6,
  p = 0.13); autocut on scored 384 (379). Ten of 13 arms are confirmed. The
  three expansion arms without the reranker moved up (legacy expansion 255 to
  436 in gbrain's harness, 258 to 440 in this repository's runner).
  A post-hoc check at the published gbrain commit attributes that change to
  later gbrain code (+12/−1 on 40 questions), not to the ids (+2/−1).
- **Reading-notes transfer with opaque ids.** On the 361-question cohort,
  rebuilt from public receipts, the notes reader beat the direct reader 320 to
  304 (+25/−9, paired 95% interval +1.4 to +7.5 points), so the predeclared
  gate passes; 308/361 to 324/361 stays as the raw-id measurement. Eleven notes
  responses hit the 512-token limit.
- **Frontier reader (audit B6).** `gpt-5.4` at medium reasoning, on exactly the
  September 29 GPT-4o arm's official prompts, answered 447/500 (official judge
  448/500): +33/−16 against GPT-4o (p = 0.021), +25/−17 against gbrain's house
  reader (p = 0.28). No ranking against vendor results is claimed.
- **Published claims.** Dated annotations in the September 6 ranker-wave, May
  LongMemEval, September 9 refresh, September 25 reading-notes and September 29
  opaque-id reports; the README, settings guide, retrieval lessons and
  comparison page now carry the recounts, and the finding that query expansion
  hurts retrieval is marked as no longer true of current gbrain.
- **Tooling.** `scripts/verify-longmemeval-opaque-followups.py` recounts all
  three items from the committed receipts and runs in `bun run validate`;
  three receipt-manifest entries; new TODOS follow-ups for a frontier reader on
  the reranked retrieval and a reading-notes run at 1,024 tokens.

## [0.10.13] - 2026-10-03

### Re-pin to gbrain `109b992` (fix wave 8 and Foundations 1): no accuracy change, one small latency regression, nine new checks

gbrain is pinned at master `109b992` (v0.60.37.0), which contains
[#5932](https://github.com/garrytan/gbrain/pull/5932) (v0.60.35.0), fix wave 8
([#5927](https://github.com/garrytan/gbrain/pull/5927), v0.60.36.0) and
Foundations 1 ([#5962](https://github.com/garrytan/gbrain/pull/5962),
v0.60.37.0) ([report](docs/benchmarks/2026-10-03-wave8-f1-repin.md),
preregistrations for the [regression check](docs/benchmarks/2026-10-03-wave8-f1-repin-preregistration.md)
and the [new checks](docs/benchmarks/2026-10-03-wave8-f1-coverage-preregistration.md)).
Provider spend: $0.

- **Regression check.** The offline tier ran at `48ed5e8` and `109b992` on
  paired Ubicloud VMs: 30 of 30 categories reach the same verdicts, with no
  change in any accuracy, recall or leak count. All 27 ledger repros pass.
  Cat 34 (run against both checkouts) and N12 at seed 7 are unchanged.
- **One regression (Cat7-1).** Cat 7's `get_timeline` at 1,000 pages went from
  a 0.045 ms to a 0.097 ms median, and the preregistered paired repeat
  confirmed it (0.052 to 0.101 ms). A keyless repro bisects it to Foundations 1
  and shows that `GBRAIN_PLANNER_AUTO_ANALYZE=0` removes it. The same
  statistics made `search_keyword` at 10,000 pages 30 times faster (4.00 to
  0.13 ms).
- **Link typing (#5882).** On world-v1, person-to-company edges went from 125
  right and 52 wrong to 128 right and 43 wrong; N9's relational arm returns
  fewer candidates with unchanged hits on all 870 one-hop runs.
- **New checks** (`docs/benchmarks/2026-10-03-wave8-f1-repin/checks/`), each
  keyless through gbrain's CLI or MCP server, with a scripted provider on
  127.0.0.1 where a model is needed: the unpriced-model flow under a cap
  (refusal with guidance, default cap runs, `gbrain pricing set`, metered
  retry, no remote registration); `gbrain import` of a directory the
  repository ignores; the embed budget stop (exit 11); pending-fact counts;
  Dream reading conversation pages; repeated searches; empty legacy source
  grants; creation attribution with `edit_page`. All nine pass at `109b992`;
  seven fail at `48ed5e8` as expected.
- **Ledger.** Twelve entries that the range touched get a 2026-10-03 review at
  `109b992` (statuses unchanged); Cat7-1 is new.
- **Version.** 0.10.12 is taken by the open PR #58, so this release is 0.10.13.

## [0.10.11] - 2026-10-03

### Cat 40 Model Ladder: gbrain lost to grep at release v0.60.27.0; a fix wave puts it ahead on the dev world and level-to-ahead on a held-out world

Cat 40 (`model-ladder`, tier P, report-only) gives one agent loop 50 tasks
about a fictional company, with different memory setups: plain Markdown files
with `grep`, Anthropic's memory tool, plain Postgres search, gbrain's MCP
server, and an oracle arm that is handed the evidence. The task families are
contract authority, who-owns-it-now, permissions, five-part renewal briefs
and write-back across sessions
([report](docs/benchmarks/2026-10-02-model-ladder.md),
[protocol](docs/benchmarks/2026-10-02-model-ladder-protocol.md)).

- **Release v0.60.27.0 lost to grep.** 11 models, uncapped tool output,
  7,624 runs: gbrain was 8 points below the best simple setup pooled
  (95% CI −13 to −4). It leaked finance-only text in 64 of 330 permission
  runs, against 17 for files. On a 52,028-document world (4 models) it was
  16 points behind.
- **The gbrain fix wave** ([garrytan/gbrain#5932](https://github.com/garrytan/gbrain/pull/5932))
  addresses the five mechanisms found in the transcripts: derived pages
  leaking private sources, guessed page types hiding evidence, saved facts
  invisible to search, other names for a customer, and wasted cold-start
  turns. On the development world it finished 494 of 550 runs, against 455
  for files: +7 points pooled (CI +3 to +9), with 0 leaks.
- **Held-out world** (seed 20261003, 6 models, 2 repeats, the shipped build
  `77dcf414`): +16.7 points over the release (CI +9.7 to +23.8) and +6.0 over
  files (CI −0.2 to +12.3). It leaked nothing in 120 permission runs.
- **Price:** a gbrain run costs 2.5 to 4 times a file run.
- **Latency measured inside the harness is invalid.** Every model request
  rewrites the whole budget ledger synchronously on the runner's event loop,
  and that loop also proxies gbrain's own provider requests. An isolated
  replay shows the fixed build's searches are as fast as the release's.
- **Not measurable here:** whether gbrain's advantage grows with model
  capability. The strongest models score 96–100% with every setup.
- **New:** generator `eval/generators/model-ladder-gen.ts`, runner
  `eval/runner/cat40-model-ladder.ts` with `eval/runner/cat40/` (loop, arms,
  scoring, analysis), and budget-ledger allowances (one reservation covering
  many small requests) plus prices for the ladder models.
- **Spend:** $1,763 across the program, under a $2,000 authorization.

## [0.10.10] - 2026-10-03

### Re-pin to gbrain `48ed5e8` (fix wave 7): eight ledger gaps closed and verified, N2 prompt v4, an N7 oracle amendment

gbrain is pinned at master `48ed5e8` (v0.60.32.0), which contains fix wave 7
([garrytan/gbrain#5908](https://github.com/garrytan/gbrain/pull/5908)). The
owning categories were rerun with the October 2 runners, seeds and settings
([report](docs/benchmarks/2026-10-03-wave7-repin.md),
[preregistration](docs/benchmarks/2026-10-03-wave7-repin-preregistration.md)).
Paid spend: $15.68 against a $30 cap, every request reconciled. No new gbrain
bug was found.

- **N2: judge prompt version 4.** 149 of 150 planted same-time conflicts
  called contradictions end to end (version 3 at `d44296c`: 132), 50 of 50
  between undated notes (36). False contradictions: 6 of 51 compatible pairs
  (3 of 50) and 38 of 1,977 unplanted pairs (26 of 1,968). The compatible-pair
  decision rule (at most 10%) fails at 11.8%, so the report no longer says the
  judge separates conflicts from dated changes on this world. A preregistered
  repeat of version 3 at `d44296c` gave 129 of 150 and 5 of 51 compatible
  pairs, so the compatible-pair difference is within run-to-run variation.
  Before the run, the probe budget was raised from $6 to $10 in its own
  commit; every one of the 2,680 offered pairs was judged.
- **N7: oracle amendment.** gbrain changed its documented rule so that an
  acknowledgement-only reply to a question no longer closes a loop (gap
  N7-2). The frozen oracle encoded the old rule, and the first run failed
  closure accuracy (34 of 39, threshold 0.95) on exactly those threads. A
  dated amendment makes the oracle apply the rules documented by the gbrain
  version under test; no threshold, contract or input changed, the failing
  receipt is kept, and at `d44296c` the amended oracle reproduces the
  October 2 receipt byte for byte
  ([amendment](docs/benchmarks/2026-10-03-n7-oracle-amendment.md)). N7 then
  passes every rule: 53 of 53 planted loops, 34 of 34 closures.
- **Gaps closed by gbrain and verified here:** N7-2, N7-5 (`as_of` pins the
  ranking), N7-6 (loop age from the request), N7-7 (`?` inside a link), N9-5
  (unresolved one-hop seeds 45 to 6 of 435 runs), N12-6 (`Participants:`
  attendees 5 of 5, was 0), N13-8 (member calls; resolved edges 76 to 72 of
  91 with all 42 same-file calls kept) and A4-2 (unanswerable questions graded
  `weak` 120 of 120, was `moderate`; 80 of 120 answerable also grade `weak`).
- **Ledger.** A 2026-10-03 review on every entry; earlier reviews kept in a
  new `review_history` field. All 20 bugs re-verified. Wave 7's by-design
  dispositions (A4-1, N2-5, N5-4, N5-5, N5-6, N12-4, N12-5, N13-4) cite
  gbrain's documented reasons. New entries N7-8 (the frozen oracle) and N12-9
  (speakers-only attendance, split from N12-6). 27 repros pass, three of them
  new keyless checks.
- **A4-3 fixed:** the budget ledger prices TypeSafe requests at gbrain's own
  rate and refuses an unpriced Jev model. A4 still has no S4-on arm.
- **No gate flipped.** No threshold moved; N7, N12, A4, N2 and the N1 and N5
  CI slices gate and pass.
- `@ai-sdk/anthropic` moves to 3.0.127 in the lockfile with gbrain's new
  floor, and `cat36-production.ts` casts the older `gbrain-cues` operations
  through `unknown` (gbrain 0.60.31.0 made `outputRedaction` required).

## [0.10.9] - 2026-10-02

### CI slices for N1 and N5, faster N9, a matched concept cell, fresh Cat 14 and Cat 19 to 21 receipts, wider N6, live negative controls

gbrain stays pinned at master `d44296c` (v0.60.30.0). Paid spend for the
whole wave: $1.09 metered by the budget ledger (concept cells and a smoke
run), plus about $2.20 counted from runners that do not meter their spend,
about $3.30 against a $50 cap. No new gbrain bug was found.

- **N1 and N5 now gate in CI.** New registry entries `knowledge-update-ci`
  and `forget-residue-ci` run in the offline tier. Each is an entity subset
  of the seeded ledger on one PGLite cell, served over stdio MCP by the
  gbrain CLI, with trusted and private reads through `gbrain call`. They
  keep every rule of the full category and add signal floors computed from
  the sliced ledger. The subsets, cell and floors were preregistered in their
  own commit before any slice ran. First runs passed every rule: N1-ci 64/64
  current-value and 57/57 history probes in 57 s, N5-ci 0 prohibited outputs
  and 120/120 retained pairs in 79 s. A pure CLI-transport cell could not fit
  two minutes: each `gbrain call` costs about 1 s, 0.7 s of it opening
  PGLite, and the full N5 CLI cell made 508 calls in 575 s
  ([report](docs/benchmarks/2026-10-02-ci-slices.md)).
- **N9 hermetic arm: 47 s instead of about 130 s.** Each ingestion seed now
  runs in its own process and the rows merge in seed order. A serial and a
  parallel receipt are identical apart from timing fields and the runner
  hash; `--serial-seeds` restores the old path. **N2 was not trimmed:**
  seeding 825 pages through `put_page` (49 s) and the two gating probes
  already take about 65 s, and the remaining cuts would shrink the
  preregistered 150-conflict denominator
  ([note](docs/benchmarks/2026-10-02-hermetic-arm-trims.md)).
- **Concept search with the same reranker on both sides** (September 28
  audit, B2). New opt-in Cat 13 adapter `vector-rerank` sends vector results
  through gbrain's own `applyReranker`. On the 181 held-out questions:
  vectors 118, vectors with the reranker 128, gbrain 99, gbrain with the
  reranker 130 exact targets first. Reranked gbrain won first place on 8
  questions and lost it on 10 (p = 0.81). The README now quotes this matched
  set; the September cells (102, 118, 130) stay as history
  ([report](docs/benchmarks/2026-10-02-concept-vector-rerank.md)).
- **Cat 14 rerun with the blind runner** (audit A-01): 8/8 probes scored, the
  calibrated advice preferred in 5 of 6 win-eligible probes and never the
  plain answer; the gate fails on the counter-argument (2/4) and voice (31%)
  axes. The May 75% stays retracted
  ([report](docs/benchmarks/2026-10-02-cat14-rerun.md)).
- **Cats 19, 20 and 21 have fresh receipts** (audit A-09). Cat 19 passes 5/5
  gates with live embeddings (health score 10 to 85). Cat 20 fails its judge
  floor: grounding 1.00 over 69 graded ideas, judge 1.17/5 against 2.5. Cat
  21 ties at the ceiling (12/12 for both embedders), so it needs questions
  that do not name the symbol. The May rows keep their numbers with dated
  pointers ([report](docs/benchmarks/2026-10-02-may-snapshot-reruns.md)).
- **N6 generator v2** seeds a private ontology observation, raw data on a
  private page and a private orphan page beside public twins. Read-op
  coverage rose from 26 to 30 of 74 with 0 leaks; skills, code intelligence
  and schema-pack ops remain uncovered for the reasons recorded in the
  [update](docs/benchmarks/2026-09-30-n6-visibility-fuzz.md#update-2026-10-02-three-more-surfaces-seeded-30-of-74-read-ops-covered).
- **Live negative controls** (WS3), both preregistered and both passing the
  0.5 rule: Cat 25 `think` without trajectory data 0.00 against 0.84 with
  it; Cat 13 vector search with hash embeddings held-out nDCG@5 0.077
  against 0.606 with Voyage
  ([report](docs/benchmarks/2026-10-02-live-negative-controls.md)).
- Plans written before the paid runs:
  [paid reruns and negative controls](docs/benchmarks/2026-10-02-paid-reruns-plan.md),
  [CI slices](docs/benchmarks/2026-10-02-ci-slices-preregistration.md).

## [0.10.8] - 2026-10-02

### Sealed v2, release decision 1: whole-conversation delivery confirmed on held-out data

The first preregistered opening of sealed confirmation set v2 asked whether
gbrain's shipped evidence default, `auto` (whole conversation pages within a
24,000-token budget), is non-inferior to the old `chunk` default and whether it
is better, at gbrain `d44296c` (v0.60.30.0)
([results](docs/benchmarks/2026-10-02-sealed-v2-decision-1.md),
[preregistration](docs/benchmarks/2026-10-02-sealed-v2-decision-1-preregistration.md)).

- **Result.** `auto` answered 192 of 200 questions and `chunk` 132 of 200,
  from the same five retrieved hits, with Claude Sonnet 4.6 at temperature 0
  reading and `gpt-4o-2024-08-06` judging. `auto` won 60 and lost 0: +30.0
  points, 95% persona-cluster interval +24.0 to +36.0. The preregistered
  verdict is `pass`, with superiority confirmed (exact McNemar p = 1.7e-18;
  persona sign-flip p = 0.00005). Multi-session questions went from 33 to 76
  of 80 and temporal questions from 21 to 36 of 40. Knowledge update (38 to
  40) and abstention (40 and 40) barely moved. Reader input rose from a mean of
  3,280 to 12,982 tokens.
- **Retrieval was not the bottleneck.** The shared top five held every gold
  chat for 153 of 160 answerable questions. All 60 wins came from those 153.
- **Rule written first.** The 3-point non-inferiority margin, the fixed-order
  superiority test (reusing the E2 rule from the auto v2 manifest), the
  `compare.ts` family and a simulated power table were committed in `d0efb58`
  before the sealed files reached the machine.
- **Runner.** `eval/runner/sealed-confirmation.ts` gains `evidence-freeze`
  (the evidence-delivery freeze on sealed questions, sharded by history),
  `evidence-answer` (the protocol reader over one frozen arm, resumable from
  its response cache) and `decide` (the preregistered rule over `compare.ts`
  output). `score` now writes `haystack_id` per question, and adds
  `error`/`error_origin` only on failed rows, so its rows pair in `compare.ts`.
  `readAnswer` also returns the provider-reported input tokens.
- **Custody.** Labels were read twice through the runner under one decision
  id. The access log went from 1 to 3 lines, and it was handed back with the
  per-question scores for private custody. Everything else holding sealed
  content was deleted from the machine. This is release decision 1 of the 3 the
  protocol allows. The v2 protocol doc and README record the opening.
- **Cost:** $16.06 of a $60 cap (10,600 requests), plus about $0.22 for setup
  runs on invented fixtures.

## [0.10.6] - 2026-10-02

### Re-pin to gbrain `d44296c`: all 20 wave bugs fixed and verified, N12 gates

gbrain fix wave 5 ([#5839](https://github.com/garrytan/gbrain/pull/5839),
v0.60.28.0) and fix wave 6 ([#5845](https://github.com/garrytan/gbrain/pull/5845),
v0.60.30.0) have merged. This release pins gbrain master `d44296c`, which
contains both, and reruns the October 1 categories with the same runners,
seeds and settings
([results](docs/benchmarks/2026-10-02-wave-repin.md)).

- **Gate changes.**
  - **N12 format fidelity now gates.** Its frozen hold said to re-pin to a
    master with the N12-1 fix, rerun N12 and remove the hold. At `d44296c`
    it passes all six preregistered rules on seeds 12 and 7, including 0
    fabricated turns out of 16 negative items (3 turns on October 1). The
    hold was removed in the re-pin commit. No rule value changed.
  - N1 and N5 already had gate status, and now pass every rule on PGLite and
    Postgres. They stay listed, not dispatched, until a CI-sized slice exists.
  - N8 stays report-only, and its private-delivery targets stay exploratory.
    N9 and N13 have no gating rule. Paid arms never gate.
- **Before and after (October 1 at `3a284ae`, October 2 at `d44296c`).**
  - **N1 knowledge update.** Current-value accuracy went from 288/388 to
    388/388 probes, and history retained from 168/385 to 385/385. Stale
    values stayed at 0 of 773.
  - **N5 forgetting residue.** Prohibited outputs after forget went from 2 to
    0 on PGLite and from 12 to 0 on Postgres. Retained-neighbor recall went
    from 738/750 to 750/750, and reinstatement from 4/6 to 6/6. Remote
    responses carrying a forgotten fact in `_meta` went from 108 and 304 to
    0 and 0.
  - **N2 contradiction surfacing (paid, judge prompt v3).** Conflicts called
    contradictions rose from 105/150 to 132/150. Unplanted false
    contradictions fell from 109/1,977 to 26/1,968, and judged-pair precision
    rose from 48.6% to 82.0%. All three preregistered decision rules now
    hold. Undated conflicts did not move (36 of 50 both times). One of four
    probe runs hit its $1.50 cap, so 13 of 2,680 pairs went unjudged; no
    planted conflict was among them.
  - **N8 proactive recall.** Private pages delivered went from 4 to 0 for
    remote callers and from 4 to 0 for the turn block.
  - **N13 code intelligence.** `code_def` top-1 went from 40/50 to 49/50, and
    the `resolved` flag from 0 of 81 edges to 76 of 91.
  - **N7 open loops.** Backfill nudges went from 0/6 and 0/4 to 6/6 and 4/4.
    The gating numbers are unchanged.
  - **N9 multi-hop.** Unchanged: 0 composed plans and 0 firings. "Who
    attended" seeds now resolve (150/150, was 0), but the arm still fires 0
    times. World-v1 names attendees only in prose, which the evidence gate now
    types as mentions. The one-hop paid rerun repeated its October 1 numbers.
- **Bug ledger.** Each entry gains a dated `review` with the commit checked,
  the evidence and its receipts. Fixed bugs gain `fixing_pr` and
  `fixing_commit`, and a new `closed` status covers a gap that gbrain closes on
  purpose. The original findings are unchanged. Status on 2026-10-02:
  - 20 of 20 bugs are fixed and verified by a rerun. None is fixed upstream
    without verification, and none is still open.
  - Gap N12-7 (legacy-pack attendance) is closed by gbrain `81755f5b`.
  - Of the other gaps, 25 still reproduce. A4-1 and A4-2 were not rechecked,
    because A4 was not rerun.
  - All 24 ledger repros now exit 0
    ([output](docs/benchmarks/2026-10-02-wave-repin/repros-d44296c.txt)).
- **No new gbrain bugs.** Three findings are follow-up work, not contract
  breaks: undated conflicts called temporal, prose attendance typed as
  mentions, and the N2 probe cap. They are in `TODOS.md`.
- **Harness.**
  - N2 gains a `local_bare_cli` probe that asks gbrain's own `makeContext`
    for the context. The existing probe imitates the October 1 CLI context
    and is unchanged.
  - N2 now records the judge prompt version from gbrain instead of
    hard-coding "2".
  - The N2 small-world test now pins the fixed behavior.
- **Runtime.** gbrain v0.60.27.0 requires Bun 1.4.0 or newer, so CI and the
  reruns moved from Bun 1.3.14 to 1.4.2. That is the one setting that
  differs from the October 1 runs.
- **Paid spend: $6.37** in one budget run capped at $60, with every request
  reconciled. Of that, the N2 judge cost $6.24, the N9 paid arm $0.065,
  the relational-ab one-hop rerun $0.065 and the N1 paid arm $0.000006.
  Everything else ran keyless. The sealed confirmation sets were not touched.

## [0.10.5] - 2026-10-01

### Eval-category wave: eleven categories at gbrain `3a284ae`, 20 gbrain bugs found

This release integrates the October 1 eval-category wave
([plan](docs/plans/2026-10-01-eval-category-wave/README.md)): a shared step 0
and five category lanes, merged as one release. Every new category froze its
promotion rules in the registry before its first counted run, and every
counted run used gbrain master `3a284ae` (v0.60.26.0) through a copied
overlay, with provider keys stripped and System One off.

- **Gate changes.**
  - **N4 entity resolution now gates.** It was report-only. It gates on five
    safety contracts (zero identity-group leaks; zero wrong merges on resolve,
    recall, remember and resolve-on-save) and two exact-lookup floors at 100%,
    all of which held at `6c8373c` and `3a284ae`. Its runner verdict stays
    `fail` because B-cubed F1 is under 0.9 on variants gbrain does not read by
    design; that metric is now exploratory.
  - **N6 visibility fuzz gains a coverage floor.** `content_reachable_coverage
    >= 1` sits beside its six zero-leak contracts. It held at both commits.
  - **N7 open loops gates from its first run.** Five safety contracts and
    three quality floors all held.
  - N2 and A4 also gate, and both held. N12 lands report-only with its rules
    held (see below). N8, N9 and N13 are report-only. N1 and N5 carry gating
    rules but are listed, not dispatched: their CLI cells take 6 to 17
    minutes and the Postgres cells need Docker.
- **Headline numbers.**
  - **N1 knowledge update.** Safety contracts pass: 0 stale values served in
    773 probes. The floors fail. Current-value accuracy is 288/388 (74.2%) and
    history retained is 168/385 (43.6%). Every miss is an ontology probe,
    because `ontology_propose` is refused on default brains (N1-1). With real
    embeddings, 0 of 10 value changes were superseded implicitly.
  - **N5 forgetting residue.** 0 reactivations, 0 collateral expirations, 0
    unauthorized forgets and 0 private leaks. It fails on 2 prohibited
    `context_pack` outputs from the hot-memory cache (N5-1), retained recall
    738/750 and reinstatement 4/6.
  - **N2 contradiction surfacing.** With a query that names the company and
    attribute, the hermetic probe offered 150/150 planted conflicts to the
    judge. With queries that name no company it offered 4/150. With gbrain's
    judge (paid), end-to-end recall was 105/150 and false contradictions were
    0/60 on dated changes. That is below the preregistered 0.80, so the judge
    does not yet separate conflicts from dated changes.
  - **A4 abstention.** Every one of 240 calls carried a grade, but every
    natural question was graded `moderate`. With a paid house reader on
    retrieved evidence, it answered 120/120 correctly and abstained on 119/120
    unanswerable questions.
  - **N7 open loops (Gmail-shaped threads).** Recall 45/45, closure 39/39,
    counterparty 45/45 and 0 safety violations.
  - **N8 proactive recall.** Alias and title recall was 42/42 with 0/68 false
    alarms. Common-word aliases fired 6/6. Associative recall was 0/240. The
    private-page contracts fail: 4 deliveries to remote callers and 4 into the
    `turn_context` block (N8-1, N8-2).
  - **N9 multi-hop with held-out wording.** 0 of 250 composed wordings
    produced a multi-relation plan, so the relational arm never fired. Strict
    all-hit at 10 was 10/375 (keyword, canonical). On the one-hop paid rerun,
    paraphrase recall at five rose from 0.411 to 0.537 (19 better, 0 worse,
    p = 0.000004), on development data.
  - **N12 format fidelity.** Across all 27 registered formats, adapter roles
    were right for 266/266 turns, adapter timestamps for 266/266 and parser
    speakers for 760/760. Attendance from documented forms was 20/20 with 0
    false. One safety contract fails: a status note with three bold labels
    parses as a 3-turn chat (N12-1).
  - **N13 code intelligence (scout).** All 6 ops answer the trusted call and
    all 6 refuse remote callers. `code_def` top-1 was right for 40 of 50
    functions, and `resolved` is false on 81 of 81 edges.
- **N12 is report-only until gbrain fixes N12-1.** The fix is in gbrain fix
  wave 5 ([#5839](https://github.com/garrytan/gbrain/pull/5839)), which was
  still open on 2026-10-01. A new `held` field on the promotion rules keeps
  the frozen rules evaluated and printed without letting them gate. When
  master contains the fix, re-pin, rerun N12 and remove the hold in that
  commit.
- **gbrain bugs found (20).**
  - **Fixed in fix wave 5, lane A ([#5839](https://github.com/garrytan/gbrain/pull/5839), open):**
    - N7-1: the nudge on first sight.
    - N8-1 and N8-2: private pages reach `volunteer_context` and the turn
      block.
    - N12-1: one-off bold labels parse as a conversation.
    - N12-2: offset timestamps land a day early.
    - N13-1: merged arrow functions lose their definitions.
    - N13-2: the `resolved` flag.
    - N13-3: the shared-name language gate.
  - **In the upcoming fix wave 6, lane B:**
    - N9-2: schema-pack frontmatter relations are forced outgoing.
    - N9-3: meeting attendance is stored meeting to person.
    - N9-4: the attended seed never resolves.
    - Lane B also covers the legacy-pack attendance gap, N12-7.
  - **In fix wave 6, lane C:**
    - N1-1: `ontology_propose` is refused on managed brains.
    - N1-2: an ontology revert is a no-op.
    - N1-3: private ontology observations reach remote callers.
    - N5-1: the hot-memory cache serves forgotten facts for 30 s.
    - N5-2: concurrent PGLite writes leave a forgotten fact's page without
      chunks.
    - N5-3: the first `remember` after a forget is refused with
      `scope_denied`.
  - **In fix wave 6, lane D:**
    - N2-1: undated pages reach the judge with the fallback date.
    - N2-2: `find-contradictions` with no flags returns nothing.
    - N2-3: judge quality against its own prompt rules. Fixed by judge prompt
      v3 (gbrain `89a4f8a9`). On a fresh seed (development data), same-time
      conflicts called contradictions went from 101/150 to 131/150, and
      unplanted false contradictions from 59/820 to 11/820
      ([addendum](docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md#addendum-2026-10-01-the-n2-3-prompt-fix-on-development-data)).
- **Feature gaps (28)** are listed rather than "fixed":
  - Implicit supersession, paraphrase retraction and physical erasure.
  - Corpus-wide contradiction discovery, and findings hidden from remote
    callers.
  - Keyless abstention and a grade that never separates answerable from
    unanswerable questions.
  - Any reply closes a loop, there is no fulfillment tracking, loops are
    Gmail-only, and loops rank by wall clock and detection age.
  - Common-word alias false alarms, and no associative recall.
  - No composed multi-hop plans.
  - No generic JSON transcript adapter, the `1970-01-01` date fallback,
    dropped seconds and undocumented attendance forms.
  - Substring `code_refs`, no cross-file resolution, and code reads that are
    trusted-only.
  - The full list is in the [wave ledger](docs/benchmarks/2026-10-01-wave-bugs.md).
- **Category defects (7), fixed or recorded here, never in gbrain:**
  - N1-5 and N1-6: N1 scoring errata.
  - N5-7: N5's first retention definition.
  - N2-6: 6 of 10 amara-life contradiction labels relabelled.
  - A4-3: the budget ledger cannot price TypeSafe, so S4-on was not run.
  - A4-4: refusals that name another company's value count as answers.
  - N12-8: the first development run measured the legacy schema pack.
- **Paid spend: $15.75 in total.**
  - N2 judge: $5.74, plus $2.76 from a first attempt that a tool time limit
    stopped with no receipt.
  - N2-3 prompt A/B (development data): $5.90.
  - A4 reader: $1.12.
  - N9 paid arms: $0.129.
  - N7 extractor replay: $0.10.
  - N1 paid arm: $0.000006.
  - Step 0, N12, N13 and N5: $0.
- **Step 0 infrastructure.**
  - gbrain is re-pinned from `6c8373c` (v0.60.13.0) to `3a284ae`.
    `MODE_BUNDLES` are identical.
  - `eval/runner/hermetic-env.ts` strips provider and TypeSafe keys, uses a
    fresh `GBRAIN_HOME`, and proves System One is off before and after a run.
  - Registry promotion rules: `all.ts` gates only on them. It also gains
    `--only` and a `--paid --budget-run-id` guard.
  - A scorer mutation kit, with empty, always-positive, always-refuse, stale
    and wrong-source fakes.
  - A shared bug ledger, `eval/runner/bug-ledger.ts`.
  - A capability and entrypoint matrix with committed keyless probes.
  - An "add a category" checklist.
- **Known limits.**
  - The N9 hermetic arm (about 134 s) and N2 (about 76 s) run over the
    wave's 60-second CI target.
  - N8 waits on human review of its associative labels.
  - The SO report still says the pin lacks `--decide`; at `3a284ae` it has
    it.
- Reports: `docs/benchmarks/2026-10-01-*.md`. Ledger:
  `docs/benchmarks/2026-10-01-wave-bugs.json`, with its rendered view beside
  it. Capability matrix: `docs/benchmarks/2026-10-01-capability-matrix.md`.

## [0.10.4] - 2026-10-01

### System One v1 (Jev decision support): two slots help, three regress

gbrain's System One lets TypeSafe's Jev (`typesafe:jev-1.13.0`, always
resolved to `jev-1.13.0`) make nine decisions inside gbrain. gbrain measured
each slot on 2026-09-30 as a matched pair on branch `feat/system-one-v1-evals`
(v0.60.17.0 plus the System One work, receipts committed in `57661631`). This
release mirrors that record and makes every slot runnable from here.

- **Result.** Jev measurably helped dream triage (S7) and contradiction
  proposals (S9); reranking (S1), evidence trimming (S3) and abstention (S4)
  regressed; routing (S2) changed nothing; S5, S6 and S8 were inconclusive.
  S7: buried-signal misses 10/18 to 0/18, routine chats rejected 78/79 to
  52/79, triage $0.0046 to $0.0009 per transcript; end to end 10/10 buried
  signals synthesized against 3/10, dream spend $1.50 to $2.60. S9: supersedes
  found 0/97 to 94/97, one wrong proposal. S1: `recall_all@5` 94.8% with Voyage
  against 91.4% to 94.0% with Jev on 233 LongMemEval-S questions.
- **Post-eval fix, not re-measured.** S1 with query expansion timed out on
  every question (248/248 and 28/28) because the 1,500 ms decision budget
  started before expansion. gbrain `9f7794ec` starts it after retrieval.
- **Labels.** Generator construction, benchmark annotations or
  `claude-sonnet-5` (S8); none is a human hand label. Judge agreement: kappa
  0.73 against gpt-4o on LongMemEval answers, 0.58 against the S8 labels.
- **Spend.** $24.95 of a $40 cap in gbrain's run, itemised in the copied
  ledgers. This release's own smoke runs cost about $0.07.
- **New category.** `eval/runner/system-one-jev.ts` with per-slot
  definitions in `eval/runner/system-one/slots.ts`: 15 evaluations covering
  S1 to S9 through `gbrain eval longmemeval --decide`, `eval brainbench
  --decide`, `decide judge-agreement`, gbrain's triage-pair runner and its
  recorded-answer runner. `verify` (registry `SO`, tier H, in CI) recomputes
  every dataset and split hash, rebuilds the S7/S8 inputs, recounts the S7
  pair and all LongMemEval arm summaries from per-item rows, and checks every
  number in `verdicts.json` against its receipt. `build`, `analyze` and `run`
  take `--gbrain <checkout>@<ref>`, since the pinned gbrain has no System One
  commands (registry `SO-live`, tier P).
- **Reproduced keylessly on 2026-10-01** against gbrain `fc9a1d45` and again
  at `9196543d` (v0.60.26.0, gbrain#5797): `build` matched the frozen hashes of
  S7, S8, S3 and S4, and `analyze` reproduced the S2, S6, S8 and S9 analysis
  files exactly. The copy is pinned to `9196543d`; between the two commits only
  the Ubicloud setup script changed in the record, and the key-aware defaults
  gbrain added never apply to eval runs.
- **Data.** `eval/data/system-one-v1/`. S7 and S8 reuse the Cat 35 corpus in
  `eval/data/transcript-distill-v1` (their 24 and 16 Cat 35 transcripts were
  byte-identical copies) and add only the 230 synthetic S7 transcripts and
  the S8 labels. S3 and S4 (57 MB and 14 MB) are rebuilt from LongMemEval-S.
- **Not ported.** The preset end-to-end dream run has receipts but no
  upstream driver; S7 on a local `llm:` model was never measured.
- Report: `docs/benchmarks/2026-09-30-system-one-jev.md`; receipts, ledgers,
  provenance and upstream runners under
  `docs/benchmarks/2026-09-30-system-one-jev/`. Tests:
  `test/eval/system-one-jev.test.ts`.
## [0.10.3] - 2026-10-01

### Auto delivery at the 24,000-token budget: no question cut, requests equal page's (development data)

gbrain now ships `auto` evidence delivery as the default, a judgment call on
development evidence after the sealed release check in 0.10.2 could not show a
gain, and raised the default conversation budget from 16,000 to 24,000 tokens
(gbrain `aea59b2f`, v0.60.23.0). This release adds a development-data addendum
measuring that budget. It was not preregistered and does not change the
sealed E2 verdict; the sealed set was not touched.

- **Setup:** the 81 LongMemEval-S questions the 16,000-token budget cut, on
  the same frozen top-five hit lists, Sonnet notes reader and both judges.
  Every frozen hit's chunk text matched the re-import on all 81; no reader
  errors.
- **Result:** at 24,000 no question is cut (largest delivery 19,989 tokens),
  and auto's request is byte-identical to page's on all 81. auto answered 71
  against 68 at 16,000 (+3/−0, p = 0.25) and 72 for page (+1/−2, p = 1.0);
  official judge 70, 68 and 72. Mean reader input 19,066 tokens, equal to
  page's. Since the other 419 questions were already under 16,000, auto at
  24,000 is page delivery on all 500 development questions (inferred from the
  delivery rule, not re-run).
- **Cost:** $5.17 against a $20 cap, through one ledger run.
- Code: a `budget-check` subcommand in `eval/runner/evidence-auto-v2.ts`.
  Report: the addendum in `docs/benchmarks/2026-09-30-evidence-auto-v2.md`,
  receipts under `docs/benchmarks/2026-09-30-evidence-auto-v2/results/lme/budget-24k/`.

### Sealed confirmation set v2: built, frozen, not opened

v1 was too easy to confirm a delivery gain (the chunk default answered 147 of
150), so this release freezes a harder second sealed set with v1's custody
design. No gbrain run has touched it.

- **The set:** 200 questions over 40 invented personas (80 multi-session, 40
  temporal, 40 knowledge update, 40 abstention; no single-session). Histories
  of 46 chats, 135,000 to 150,000 tokens each (about LongMemEval-S size), over
  eight to twelve months. Answers need three to four chats for multi-session,
  two to three chats 90+ days apart for temporal, and an initial value plus
  two changes for knowledge update. Planned and audited by `gpt-6-sol`,
  written by `gpt-6-luna`, seed 20261002; 616 of 640 persona chats passed the
  fact audit and 19 questions carry an audit flag.
- **Solvability (reported, never used to delete items):** oracle 199/200,
  chunk oracle 196/200, no memory 40/200 (0/160 answerable). The evidence
  always fits in five chunks (median two to four), so the set tests whether
  retrieval finds several chats months apart, not whether chunks can hold the
  answer.
- **Overlap audit** against LongMemEval S/M: no exact or near-duplicate
  questions (max Jaccard 0.33), no persona full names; only filler chats share
  a 13-word run (stock phrases; 6 in S, 10 in M), no persona chat does.
- **Custody:** only the manifest (commitments and counts), the solvability
  summary and the overlap counts are committed. Access log: one line, the
  solvability run.
- **Cost:** $29.90 of a $60 cap ($20.99 generation, $0.35 pilot, $8.56
  solvability). About $8 of generation was wasted by a duplicate process
  started by mistake after an agent restart; the manifest records the
  settled total and the note.
- Code: `eval/generators/sealed-confirmation-v2-gen.ts` and
  `sealed-confirmation-v2-prompts.ts` with a keyless test suite; the sealed
  runner names its dataset after the manifest's set. Protocol:
  `docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md`.

## [0.10.2] - 2026-09-30

One release for four pieces of work that followed v0.10.1: the LongMemEval
reranker-on follow-ups, the evidence-delivery study, its auto v2 release check
on the sealed set, and three keyless categories (N3, N4, N6). It was built on three branches (numbered 0.10.2 to
0.10.4 while in review) and ships as a single patch release. It also moves the
gbrain pin to master `6c8373c` (v0.60.13.0), which contains the evidence
delivery code and the fixes for the seven bugs N3, N4 and N6 found.

Paid work in this release: the reranker-on runs ($51.22 against a $120 cap),
the evidence-delivery program ($112.44 through one ledger run) and its $0.97
plumbing smoke, and the auto v2 release check ($73.92 through one ledger run
against a $150 cap). Everything else is keyless.

### Auto v2 release check on the sealed set: `fail`

gbrain's new default, `auto` v2 (gbrain `e9b580c5`, v0.60.16.0), returns the
whole page for conversation hits within a 16,000-token budget and leaves other
hits' chunks unchanged. A second decision manifest, committed before any paid
call and pinned in its own commit, made the sealed confirmation set the
decision and LongMemEval-S a sanity check.

- **Verdict: `fail`.** On the 150 sealed questions, auto answered 149 against
  147 for the chunk default (+2/−0, exact McNemar p = 0.50, persona-clustered
  p = 0.49; official judge 149 against 146). The rule required a significant
  gain. Chunks were already at 98% on the short sealed chats, so no delivery
  change could reach significance there (it would need six one-sided wins;
  chunks missed three questions). No demonstrated benefit on held-out data,
  and no demonstrated harm.
- **LongMemEval-S (development data, 500 questions):** auto 445, page 457,
  chunk 312 (auto against chunk +145/−12, p = 4e-30; against page +7/−19).
  The sanity bar, page − 10 = 447, was missed by two questions.
- **Truncation cost:** the 16,000-token budget cut 81 questions (85 of 2,451
  blocks truncated, no fallbacks); there auto scored 68 against page's 72,
  about 0.8% of 500. On the other 419 questions auto's request was
  byte-identical to page's and the reader still disagreed on 20 (377 against
  385), which is reader noise and most of the shortfall.
- **Custody:** the sealed questions, labels and access log were transferred
  to the Capy machine with a custody note and never copied to a VM. Labels
  opened once through the sealed runner (commitment check, decision id
  `evidence-auto-v2-2026-09-30:e2:auto`, access log 2 → 3 lines). Only
  aggregates are published, and every sealed file and derived artifact was
  deleted after scoring. This was the first of the set's three release
  decisions.
- Code: decision manifest v2, `eval/runner/evidence-delivery/decision-v2.ts`
  with a keyless test suite, a power analysis, `eval/runner/evidence-auto-v2.ts`;
  the paid guard and sealed scorer now take a manifest path, campaign runner
  and E2 rule, and the watchdog measures staleness from each attempt's start.
  Report: `docs/benchmarks/2026-09-30-evidence-auto-v2.md`.

### Evidence delivery: whole pages help; cheaper windows do not close enough of the gap

The evidence-delivery study: preregistered, run and reported. gbrain is
adding an opt-in stage that returns neighbors, sections or whole pages
instead of bare chunks.

- **Result: whole pages help; cheaper windows do not close enough of the
  gap.** On 400 held-out LongMemEval-S questions with the reranker on and
  retrieval frozen at gbrain `732ee811`, whole-page delivery answered 361
  against 253 for five chunks (+114/−6, p = 6e-27). The two pilot winners,
  one or two neighbor chunks per side, scored 285 and 292 at 44% of
  whole-page input tokens: significant against chunks, but only 30% and 36%
  of the gap against the preregistered 60%. Decision-manifest verdict:
  `page_only`, so `page` ships opt-in and the default stays `chunk`; the
  sealed set was not opened. An agent that could fetch pages scored 83/100
  on the pilot (chunks 68, pages 92). The gpt-4o reader tied (128 against
  129/400) because it abstained on about two thirds of questions under the
  notes prompt. E3 reproduced the frozen evidence over MCP on 100/100
  questions for every arm. Paid cost $112.44 through one ledger run.
  Report: `docs/benchmarks/2026-09-30-evidence-delivery.md`, receipts under
  `docs/benchmarks/2026-09-30-evidence-delivery/results/`.

- **An executable decision manifest**
  (`docs/benchmarks/2026-09-30-evidence-delivery/decision-manifest.json`),
  committed before any paid call. It fixes judge roles (gbrain judge primary,
  official judge may not reverse), the gap and 60% closure formula, the 50%
  provider-token rule, the six-candidate Holm family, pilot selection and
  tie-breaks, clusters, error handling, the E2 pass/reject/inconclusive rule
  and the gbrain commit pin. `eval/runner/evidence-delivery/decision.ts`
  applies it; a keyless suite covers close wins, zero and negative gaps,
  sparse types, judge disagreement, many-policy selection and failed calls.
- **A power analysis** over the exact decision code. A candidate that closes
  70% of the gap passes 65% to 82% of the time. The per-type rule fails even
  a page-quality policy 12% to 24% of the time through reader noise, and E2
  rejects a truly equal winner 6% to 20% of the time. Both rules are kept as
  preregistered and flagged.
- **A content-addressed frozen evidence manifest.** `freeze` stores each
  question's reranked top-5 and top-10 hits with chunk text, every chunk of
  every hit page, the harness page text and every arm's delivered evidence
  with gbrain's fingerprint, plus code, parser and index hashes and the
  agreement with R1.
- **The E1 runner** (ten arms, the `get_page` agent arm, gpt-4o arms), with
  three token counts per row and a byte-level check that the harness page
  request reproduces R1's logged request before any model call.
- **The E3 product-path check** over MCP stdio as a remote caller, with
  gbrain's server spend joining the ledger through a preload, and **the E2
  bridge**, which gives the sealed set the E1 reader instead of the sealed
  runner's whole-session prompt.
- `bun eval/runner/evidence-delivery.ts costs`: the paid program is estimated
  at $122 ($153 with a retry margin) against a $400 campaign cap.
- A $0.97 plumbing smoke against the WIP gbrain branch: 4 of 4 identical-list
  questions reproduced R1's request bytes; the product `page` drops page
  frontmatter and 9 of 24 blocks lost a paragraph break at chunk seams (fixed
  in gbrain before the pinned commit); MCP `assemble_evidence` reproduced the
  local fingerprints.
- Sharded freezing (one process per embedding cache) with `merge-frozen`,
  `e3-summary`, and the VM pipeline and watchdog scripts used for the run.
- Voyage rerank timeout raised to 30 s in freeze and E3 after 28 haystacks
  timed out at gbrain's 5 s default during a Voyage overload.

Harness changes made for the study:

- The budget ledger prices dated model snapshots (`gpt-4o-2024-08-06`) at
  their family's list price and prices Voyage rerank requests.
- The sealed runner refuses to open labels for scoring without a decision id.
- Lifecycle drivers accept an entry override so a server can run with a
  preload.

### LongMemEval with the reranker on

The two reranker-on follow-ups from the LongMemEval opaque-id re-run. Both
use the same gbrain code as the 439/500 arm (`a7cb37b`), the same data,
embedding cache and judges, with `voyage:rerank-2.5` on.

- **R1, the house notes reader with the reranker on: 453/500 (90.6%).**
  - The reranker raised strict retrieval from 435/470 to 450/470 (paired
    +22/−7, exact McNemar p = 0.008).
  - Against reranker off, answers moved +31/−17 (p = 0.059); with the
    official judge, 451 against 443 (p = 0.33). That is suggestive, not a
    demonstrated answer gain.
- **R2, the published configuration without the leak: 432/500.** It used the
  direct reader at 512 tokens, the reranker on and opaque ids. Paired against
  the invalid published 433/500, it moved +15/−16 (p = 1.0). Hiding the gold
  ids made no measurable difference there. The published number stays
  invalid because it was measured with the ids visible, and the report lists
  the remaining configuration differences.
- **Notes against direct on identical reranked retrieval: 453 against 432**
  (+32/−11, p = 0.002; official judge p = 0.049). This is a new full-500
  comparison, not a re-run of the September 25 transfer cohort, whose flag
  stays in place.
- Voyage accounting for each run: 500 calls, all HTTP 200, 6.94M tokens
  ($0.35), 500/500 rows reranked, 0 `rerank_failed` or other degraded
  stages. Paid cost for both runs was $51.22 against a $120 cap. Each run
  hit the known #5092 stall five times; a watchdog resumed each time without
  repeating a reader call.
- Receipts under `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/`
  with nine manifest entries. `scripts/verify-longmemeval-opaque-qa.py` now
  also recounts both runs, their paired tests against arm a and the
  published rows, rerank coverage and the prompt leak check.
- The report gains a reranker-on section. The README now gives the
  reranker-on numbers beside the 439/500 and says the leak made no
  measurable difference to the published configuration.

### Offline categories N3, N4 and N6

Three keyless categories from the evidence-delivery plan (section 5): temporal
and as-of questions (N3), entity resolution (N4), and a visibility and access
leak fuzz over every read operation (N6). Each has a registry entry with a
semantic contract, gold from a seeded generator ledger (never from gbrain
output), solvability and negative controls, presence assertions, receipt v2,
tests and a dated report. All three landed report-only, and each found gbrain
bugs, which gbrain v0.60.13.0 fixed (see the re-run below). No paid calls.

Measured on the pinned gbrain (`608a174`, 0.60.10.0) and on master (`f8d1e39`,
0.60.11.0) as a copied overlay; every category gave identical numbers on both.

- **N3 temporal and as-of** (`temporal-asof`,
  [report](docs/benchmarks/2026-09-30-n3-temporal-asof.md)). 500 of 513 probes
  pass: chronicle reads, search date bounds, effective-date precedence,
  time-zone and daylight-saving edges and trajectories all 100%, range set-F1
  1.000 over 179 probes, `ontology_get` as-of 99/104, last seen 76/83. The 13
  misses are four gbrain bugs: `ontology_get` drops a late-recorded stint that
  names the current value, `chronicle_last_seen` matches attendees by
  substring and can report the previous day, and a non-ISO `query` date bound
  such as `since: "May 5"` returns nothing instead of an error. The
  forward job-state gold moved from `temporal.ts` into
  `eval/generators/job-state.ts`, shared by Cat 4 and N3.
- **N4 entity resolution** (`entity-resolution`,
  [report](docs/benchmarks/2026-09-30-n4-entity-resolution.md)). On 136
  single-source mentions the resolver merged wrongly once, refused all 17
  mentions that must be refused and resolved every variant recorded in
  `aliases:`; B-cubed F1 0.755 against 0.566 for exact-only, 0.480 for refusing
  everything and 0.109 for merging everything. Typos, initials and prose-only
  nicknames stay unresolved by design. Two bugs: another page's alias beats a
  page's own exact name, and federated `recall({ entity })` merges two
  different people who share a slug and drops `source_id`.
- **N6 visibility and access leak fuzz** (`visibility-leak-fuzz`,
  [report](docs/benchmarks/2026-09-30-n6-visibility-fuzz.md)). Enumerates
  gbrain's read operations at run time (73) and calls each as stdio, serve-http
  read, write and slug-bound clients and remote and local subagents, against
  private pages, held Takes, private Facts, derived atoms and an ungranted
  source, with public-twin and trusted-local controls and a never-written
  ghost for existence oracles. 24 of the 25 read ops that return protected
  content held, and 0 of 90 access gates were bypassed. One bug: `entity` and
  `context_pack` show remote callers inbound links from private pages, with
  the private slug and a sentence of its body. It also runs against the
  `capy/evidence-delivery` branch (c0a72ab, same result); that head documents
  `return_unit` and `assemble_evidence` but does not implement them yet. A
  later run against the branch head with the code (732ee81) fuzzed every
  `return_unit` value on `search`, `query`, `recall` and `assemble_evidence`,
  with new presence controls for expansion (an expanded `delivered` block, and
  delivered text spanning the stripped Takes and Facts rows): no expansion
  path leaked.
- **`--gbrain <checkout>[@ref]` / `GBRAIN_UNDER_TEST`** for the new runners
  (`eval/runner/gbrain-under-test.ts`): extracts the ref with `git archive`
  into `.gbrain-overlays/`, installs it, verifies the copy (tree hash, no
  symlinks, CLI version) and records the loaded commit in the receipt's
  product identity. Never a symlink.
- **N4 is hermetic inside a shared test process.** `runN4` now removes
  provider keys and points `GBRAIN_HOME` at a temporary directory for the run,
  as N3 and N6 already did. Before, a test that had configured gbrain's
  gateway earlier in the same process made `remember` writes wait on provider
  calls when keys were present, and the end-to-end test timed out. Scores
  are unchanged: the re-run receipts match the earlier ones row for row.
- **`all.ts` honors `gate: 'report-only'`.** A report-only category that
  completes with a non-pass verdict is REPORTED, never a pass and never a
  failure of the run; missing, stale, invalid and errored receipts still fail.
- **Re-run at the new pin, gbrain master `6c8373c` (v0.60.13.0, #5769), which
  fixes all seven bugs above.** Same seeds and ledgers, clean tree, $0.
  N3: 513/513 probes pass (as-of 104/104, last seen 83/83 with 0.00 days mean
  error, negative controls 155/155, the non-ISO bound now rejected). N4: 0
  wrong merges on every surface (was 1 on the resolver and 3 on `recall`),
  exact-name floor 48/48 on the resolver and 50/50 on `recall`, `recall`
  refusals 21/21; seed 7 agrees. N6: 0 content leaks,
  0 existence leaks, 0 oracles and 0 gate bypasses over 3,854 probes and 74
  read ops, with every `return_unit` fuzzed. **N3 and N6 are now gates**
  (`gate: 'gate'`); N4 stays report-only because its B-cubed F1 and
  unresolved targets miss on variants gbrain does not read by design (typos,
  unrecorded initials, prose-only names). Receipts:
  `receipt-pin-6c8373c*.json` beside each report, with four manifest entries.

### gbrain pin

- **gbrain is pinned to master `6c8373c` (v0.60.13.0,
  [#5769](https://github.com/garrytan/gbrain/pull/5769))**, replacing
  `608a174` (v0.60.10.0). The `balanced`, `conservative` and `tokenmax` mode
  definitions are unchanged. `gbrain-cues` (`939232f`) and `gbrain-reader`
  (`e78f1c3`) keep their pins, so the frozen cue and reader package
  identities are unchanged. The evidence-delivery results stay dated to the
  commit they measured, `732ee811`. The README, settings guide and
  comparison-systems page name the new pin.

## [0.10.1] - 2026-09-29

One release for all of the work that followed the September 28 audits and the
approved 10x plan. It was built on eight branches (numbered 0.10.1 to 0.10.8
while in review) and ships as a single patch release. Several published
numbers had been measured by code that could not fail, or that let the system
under test see the answer. This release fixes those runners and scorers,
corrects the published claims in place beside dated errata, runs the whole
suite in CI, adds an independent evaluator, a category registry, receipt v2
and a paid-run budget ledger, freezes a sealed confirmation set, adds a memory
lifecycle experiment, and replaces the invalid LongMemEval answer score with a
leak-free re-run. Historical scores keep their original dates; where a fix
moves a number, the old number stays in its dated report.

Paid work in this release: the LongMemEval opaque-id answer re-run (about
$59.6), the sealed confirmation set ($17.83) and the relationship paraphrase
check ($0.0645 of OpenAI embeddings). Everything else is keyless.

### Measurement integrity (audited 2026-09-28)

Keyless reruns and recomputations in this section were made at the pin of the
day, `939232f`.

- **LongMemEval runners no longer show the gold label.** Every gold session id
  starts with `answer_` and no other session does. The retrieval runner, the
  answer check, the reading-notes request builder and the M-pilot build now
  give the system and the reader opaque ids (`s-` plus 10 hex characters) and
  translate back before scoring. A test asserts that no system or reader input
  contains `answer_` (C-01, PD-05, PD-08). The published 433/500 judged answers
  and the 308 to 324 of 361 reading-notes result came from readers that saw raw
  ids (see the leak-free re-run below).
- The LongMemEval aggregator marks a run publishable only when every adapter
  has the expected row count, and stamps the gbrain version recorded in the
  rows rather than the local install (PD-01, PD-02). Resume and batch
  completion are keyed on `run_config_hash` (PD-03). The NDJSON validator
  rejects residual error rows unless `--allow-errors` is passed (PD-04).
  Answer-generation outages count as dependency errors (PD-06).
- `all.ts` requires a fresh, valid receipt from every runner it dispatches. A
  missing or invalid receipt is a failure, never an exit-code pass (C-06,
  C-07). It lists every category in the repository with a tier, runs
  `--tier offline` (default), `paid` or `all`, and prints each category it did
  not run with the reason (C-09). Latency categories run alone (C-11). The
  `eval:brainbench:published` script, which claimed N=10 while no dispatched
  runner read N, is removed (C-08). A keyless `--tier offline` sweep at
  `939232f` passed 17 of 17 dispatched categories.
- Cat 2 type accuracy charges every inferred type that differs from gold, so an
  extractor that emits every type can no longer score 100% (C-05). At
  `939232f` this scorer gave 86.6% (240/277 found pairs; 97.1% under the old
  any-type rule, still reported as a diagnostic) and strict F1 41.3% (48.1%
  before); the attendance-direction correction below later replaced both.
  Cat 2 and Cat 3 write receipts and gate on regression floors.
- Cat 3 scores the handle without `@` as documented, because the keyword index
  strips the `@`. Undocumented alias recall is 13.75% (55/400), not the
  published 31.0% (C-03).
- Cat 1 reports Precision@5 with the standard /5 denominator: 29.9% before and
  35.4% after graph traversal, against a ceiling of 36.0%. The legacy
  /min(5, returned) value (39.2% to 46.5% at this pin) is kept beside it
  (C-04).
- The Cat 36 offline smoke fails when search crashes on every probe or finds no
  evidence (PC-05). Cat 34 gates on production-seam cells and reports
  contract-seam cells as informational, so it can pass (PC-08).
- Cat 35 reports the evidence-verified joint score next to the judge-only score
  and excludes judge failures instead of counting them as misses (PC-01,
  PC-03). Recomputed from the committed receipts (dream lane macro): 88.1%
  judge-only is 74.9% joint; the earlier 70.2% is 58.2% joint; the Aug-25
  baseline is 64.7% judge-only (61.5% published) with 8 of 173 failed items
  excluded. Cat 35 writes a common receipt and skips cleanly without keys
  (PC-09).
- Cat 29 judges both answers in one blind prompt in both orders and flags
  position-inconsistent pairs; the earlier "both orders" made the same
  single-answer call twice (B-29-01).
- The multi-adapter `gbrain` row runs the product path (hybrid search with
  relational retrieval). The regex parser for the four query templates stays as
  `graph-oracle-parse`, labeled as an upper bound (C-10).
- Cat 13 reports probes that copy the target page's title, description or body
  as a lexical control beside the conceptual probes. Recomputed from the
  2026-09-09 receipt, gbrain scores 61.5% nDCG@5 on the 246 conceptual probes
  and 53.6% on the 302 lexical-control probes (A-14).
- Every `readdirSync` enumeration is sorted, with a repository-wide test
  (A-06). The Cat 13 probe set is unchanged; Cat 6 injects different mentions
  in some cases with every gated rate unchanged.
- Judges and direct model calls run at temperature 0 where the SDK allows it
  (PC-02, B-29-03, A-03). Judge prompts escape system output, fence it in a
  per-call nonce block, and state that block content is data. Judge prompt
  versions moved, so new judged receipts do not compare with older ones (C-13,
  A-20, B-JDG-01, PC-10).
- `dcgAtK` counts each id once, so nDCG cannot exceed 1 (C-16).

### Corrections to published claims

Every original figure stays visible beside a dated erratum. The README now
states where gbrain actually leads: strict `recall_all@5` of 95.53% (449/470)
on LongMemEval, against 90.0% and 85.7% for our strict recounts of MemPalace's
saved rankings and 87.45% self-reported by ContextFit. Answer accuracy is not a
matched comparison yet, and the README says so.

- **Cat14 calibration (May 18): retracted.** The 75% win rate (6 of 8) and 100%
  axis scores came from a judge that saw each probe's expected behavior and
  knew which answer was calibrated.
- **Cat 3 undocumented alias recall (April 18): 31.0% becomes 13.75%
  (55/400).** The handle without `@` is in the indexed page text and scored
  100/100. Verified by re-running `eval/runner/identity.ts`.
- **Cat 2 link type accuracy (April 18): 70.7% to 88.5% came from a lenient
  scorer.** A strict re-run at `939232f` gave 86.6% (240/277) and strict F1
  41.3% (48.1% before the scorer fix). That count was itself wrong: the answer
  key pointed attendance edges from the meeting to the person, and gbrain
  stores them the other way, so the 86.6% counted 131 reversed edges as
  correct. **With the direction corrected, type accuracy is 74.7% (109/146) and
  strict F1 18.8%** at both `939232f` and `b80cad6`; the regression floors
  moved to 70% / 15%. Cats 1 and 6 are unchanged between the two commits.
  [Report](docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The multi-adapter `gbrain` row (April 19, April 23, May 23)** came from a
  regular-expression template parser, now `graph-oracle-parse`, and is marked
  invalid as a product score. The September 9 concept report gains a split of
  conceptual and lexical-control probes.
- **Cat 1 precision at five (April 18): 39.2% to 44.7% becomes 29.9% to
  35.4%** when divided by five slots per question (145 × 5 = 725), against a
  ceiling of 36.0%. Verified by re-running `eval/runner/before-after.ts`; the
  legacy denominator now gives 46.5% after, against 44.7% published.
- **Cat 35 retention (August 31): 88.1% is judge-only.** Evidence-verified
  retention, recomputed from the committed receipts, is 74.9% (58.2% before the
  change). The August 25 baseline is 64.7% with judge failures excluded (61.5%
  published) and 51.2% evidence-verified. The README also says the result is
  in-sample.
- **May snapshot, Cats 18b to 29:** every row is marked with the defect of the
  pre-audit runner that produced it, including Cat 29's duplicate-call "both
  orders" scoring.
- **LongMemEval answer accuracy (433/500): invalid.** The answer model saw the
  `answer_` prefix that marks every labeled evidence session id. The README,
  the comparison page and the September 6 report point to the leak-free
  September 29 re-run below and say that the answer comparison with vendor
  self-reports is still not matched. **The reading-notes transfer result
  (308/361 to 324/361) was not re-run and stays pending.** A 30-question check
  found no effect of the prefix on retrieval.
- The README concept claim compares like with like (102/181 for gbrain against
  118/181 for vectors without a reranker; 130/181 with one), and the
  relationship claim reports the overall result (first-place hits 14% to 24%)
  and attendance (0/50) beside the investor example. It discloses that the
  95.53% configuration was chosen on the same 470 questions and that the
  pre-registered 92% answer target was missed.
- The PrecisionMemBench comparison table shows the September 9 corrected gbrain
  rows with their non-null case counts; the invalid May rows are struck
  through, no longer bold (B10).
- `docs/settings.md` and `docs/comparison-systems.md` no longer say that gbrain
  `2efaaf8f` is the installed library; a test checks such claims against the
  `package.json` pin.

### CI and the test suite

- `bun run test` runs the 77 colocated unit tests under `eval/` (counted on
  2026-09-28), the 25 Python orchestrator tests and the validators (published
  LongMemEval recount, LongMemEval opaque-id recount, documentation, links,
  queries, data). CI runs all of them.
- The Bun suite ran in about 2 minutes 25 seconds instead of about 9 minutes
  20 seconds on a 4-core machine when this was measured on 2026-09-28. A test
  preload builds one pre-migrated PGLite snapshot per embedding shape through
  gbrain's own snapshot loader, and `scripts/test-shards.ts` runs four
  ordinary `bun test --shard` processes at once. (Bun's `--parallel` worker
  mode was tried and rejected: tests that call `Bun.spawnSync` hung in 2 of 4
  full runs.) CI splits the tests into four shard jobs and moves type checks,
  validators and hermetic runners into a separate job, each with its own
  timeout. That job runs every keyless category through
  `bun run eval:brainbench` (`all.ts --tier offline`), so the Cat 1, 2, 3 and
  10 gates fail CI on a regression. Two PGLite-building tests carry explicit
  timeouts because they exceed 5 seconds under four shards.
- `tsc` passes with no output filtering: DOM libraries, `@types/js-yaml` and
  `@types/express`, TypeScript 5.9, and small shims for Bun text imports and
  one image encoder signature. CI gates both type checks unfiltered.
- The `postgres@3.4.9` patch is declared in `patchedDependencies`, so the
  cancellation-capable driver `gbrain-reader` expects is actually installed.
- Removed the PGLite postinstall link. gbrain finds the hoisted PGLite assets
  without it.
- Cat30 to Cat33 import SkillOpt through gbrain's public `./core/skillopt`
  export.
- The built-in Tier 5.5 family is labeled `synthetic-outsider` in new
  scorecards; no outside author wrote those questions.
- Documentation follows the opaque session ids: the LongMemEval-M
  preregistration describes the `indexed-projection-v3` build, the
  reading-notes report describes request schema 2, and the May LongMemEval
  report shows how to validate the prefix-bracket stream with
  `--allow-errors`.
- `scripts/check-links.py` checks every link and heading anchor in the
  repository's Markdown on each `bun run validate`; a weekly workflow also
  fetches external links (B12).

### Independent evaluator and paired comparisons (plan amendments 4 and 6)

- **Paired comparator: `bun eval/runner/compare.ts <A> <B>`.** It pairs two runs
  question by question and refuses duplicate ids, missing pairs and questions
  that are eligible on one side only. It reports the absolute change with a
  clustered 95% bootstrap interval, a clustered sign-flip test, the exact
  McNemar test and a power note (the smallest change detectable at 80% power).
  Items share a cluster id, so ten paraphrases of one concept count once. The
  statistics generalize the situation-recall regression gate's bootstrap,
  sign-flip and Holm code (`eval/runner/stats/`), and a test holds the two to
  identical results. Recounting the committed September 6 rows reproduces the
  published reranker comparison: 18 wins and 8 losses over 470 answerable
  LongMemEval-S questions, +2.13 points (interval 0.00 to +4.26), McNemar
  p = 0.0755.
- **Three gates over a preregistered family** (`--family`). Exact correctness
  and safety assertions fail at once with no significance test. Noisy quality
  metrics pass only when non-inferiority within a stated tolerance is shown
  after Holm correction; a wide interval is inconclusive, not a pass.
  Exploratory metrics never gate.
- **Independent evaluator** (`eval/runner/evaluator/`). A gold store keeps
  labels in a private field and hands out scores. The LongMemEval runner keeps
  only gold-free question views and scores through a gold store loaded by a
  separate read of the dataset, checked byte for byte. Cat13 gold comes from a
  separate corpus read and must match the runner's probes id for id and text
  for text. A reference scorer reimplements the metrics without importing the
  product.
- **Input allowlist** for every payload sent to the system under test or a
  reader or judge. It refuses undeclared fields, non-plain objects and any raw
  dataset session id beyond what the conversation text accounts for, whether or
  not the id starts with `answer_`. A violation voids the run. It covers
  LongMemEval retrieval and answers and Cat13, and in the final fix wave also
  the reading-notes reader input and captured request, Cat 29's question and
  pairwise judge, and Cat 35's transcripts and scaffold (no gold id), coverage
  judge (no verbatim anchor beyond the judged document), leak judge and
  usability judge (no gold statement beyond the pages). Receipts record the
  gold-store fingerprint, scorer version and boundary names under
  `resolved_config.evaluator`.
- **Adversarial tests** the evaluator must catch: known rankings, permuted
  labels, removed metadata, duplicate ids, an empty system, wrong answers, and
  adapters that leak gold, return nothing or return duplicates
  (`test/eval/evaluator-adversarial.test.ts`).
- Cat13 per-question rows gain `cluster_id` (the target concept) and, when an
  adapter repeats a page, `duplicate_results`. Scores are unchanged: repeated
  pages already earned nothing.
- [Comparing runs](docs/comparing-runs.md) explains all of the above.

### gbrain pins, category registry, receipt v2 and the budget ledger

- **gbrain is pinned to master.** On 2026-09-29 the pin moved from `939232f`
  (a side branch) to master `b80cad6` (v0.59.13.0), and at integration it moved
  again to master `608a174` (v0.60.10.0). The memory-cue experiments
  (situation recall, the LongMemEval-M pilot and Cat 36 cue arms) need code
  that exists only on gbrain's `capy/situation-aware-recall` branch, so they
  load a separate package alias, `gbrain-cues`, pinned to `939232f`. Cat 36 and
  situation-recall runtimes pick the package from the arm: cue and summary
  arms use `gbrain-cues`, every other arm measures the pinned product. Pins
  are read from `package.json` (`eval/runner/pins.ts`).
- **Re-pin check at `608a174` (2026-09-29).** Cats 1, 2 and 6 give the same
  data as their committed `b80cad6` receipts (Cat 2 still 74.7% type accuracy,
  18.8% strict F1), so no published number moves. The offline tier passes
  every dispatched category, and Cat 34 passes 12 of 12 against a gbrain
  checkout at the same commit. Two behavior changes in gbrain surfaced:
  - gbrain v0.60.6.0 (#5675) records a file import's `file://` origin in
    `source_uri`, which also server-stamps `ingested_at`. Cat 24's file-import
    probe and its native collector now expect that origin, and still require
    `source_kind` and `ingested_via` to stay empty. Before this pin the probe
    expected all four fields empty.
  - gbrain v0.60.6.0 widened its relationship parser. The keyless
    relational-ab check fires on 33 of 145 paraphrased questions at `608a174`,
    against 0 at `b80cad6`; template firing is unchanged at 58. The paid
    paraphrase measurement stays dated to `b80cad6`, and the README, the report
    and TODOS carry a dated note.
- **`gbrain-reader` pins gbrain master `e78f1c3`** (v0.59.0.0), replacing
  `a9de062`, which is on no branch. The two commits' `src/` trees and
  `package.json` are byte-identical; the 22 reading-notes tests pass.
- **ZeroEntropy cells are retired** (supersedes PR #35). Cat 18 compares OpenAI
  and Voyage embedders; Cat 18b pairs each with `voyage:rerank-2.5`. Both are
  dispatchable paid categories again.
- gbrain v0.59.10.0 saves a page's text when embedding fails instead of
  throwing. Runners that measure vector or hybrid search treat such a deferred
  embedding as an error, so a provider outage can no longer be scored as
  keyword-only retrieval under an embedding label.
- **`eval/registry.ts`**: one row per category with its legacy alias, family,
  tier (H hermetic, K keyed under $1, P paid), cost estimate and its basis,
  receipt path, headline metric and denominator, gate status, evidence
  maturity and a short statement of what it measures. `all.ts` reads it and
  accepts `--tier H|K|P`. No category was renumbered. The registry lists the
  lifecycle experiment and the sealed confirmation set, and
  `test/eval/registry.test.ts` fails when a file under `eval/runner/` is
  neither a registry script nor listed in `RUNNER_HELPERS`.
- **Receipt schema v2.** Every receipt records the content hash of the evals
  tree that ran (uncommitted edits included), the declared pin and content
  hash of the gbrain package actually loaded, planned, attempted, scored and
  errored probes with errors kept apart from misses, and cost, p50/p95 latency
  and tokens delivered to models when a runner measures them. v1 receipts
  remain readable. Cost and delivered tokens are recorded as a measured zero
  in 16 keyless runners and stub modes, from the budget ledger in
  relational-ab live runs, and latency in Cats 13b, 28 and relational-ab.
- **Budget ledger** (`eval/runner/budget-ledger.ts`). LongMemEval, Cat 13, Cat
  35 and relational-ab live runs refuse to start without `--budget-usd`, print
  their estimate, and reserve every provider request (retries and gbrain's
  internal calls included) against the run budget and a $500 program cap
  before sending it. Reservations reconcile to provider-reported usage. The
  ledger is a gitignored JSON file (`.budget/ledger.json`), tested with mocked
  providers. `longmemeval-batch.sh` opens one ledger run and passes
  `--budget-run-id` to every worker, so `--budget-usd` caps all workers and
  restarted batches together.
- Receipts stop recording machine-local paths: `writeReceipt` makes paths under
  the checkout repo-relative, `bun eval/runner/receipt.ts scrub <file>` also
  rewrites home and temp paths before a receipt is committed, and a test fails
  on any committed receipt with such a path, except historical receipts frozen
  by hash (B11). The frozen list holds the 63 receipts recorded before the fix
  wave plus the two lifecycle receipts, which are kept byte-for-byte because
  the manifest and the recount test pin them.

### Sealed confirmation set (plan amendment 1)

The LongMemEval-S questions and the Cat13 held-out concepts were used to
choose gbrain's settings, so they are now development data. This release
freezes a separately written confirmation set for future release decisions and
publishes only its method, counts and SHA-256 commitments. No gbrain run has
touched it.

- **Sealed confirmation set v1.** 30 fictional personas, each with a 55-chat
  history (20 personal chats, 35 general-help chats), and 150 questions: 30
  each of single-session fact, multi-session aggregation, temporal reasoning,
  knowledge update and abstention. Written by OpenAI `gpt-6-sol`, a model not
  used for LongMemEval or any earlier corpus here. Personas share no
  occupation, hobby or life arc. Labels come from the generation ledger. The
  questions, chats and labels stay private;
  `eval/data/sealed-confirmation-v1/manifest.json` holds their commitments.
  Protocol:
  [`2026-09-29-sealed-confirmation-protocol.md`](docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md).
- **Solvability controls, reported and never used to drop items.** With only
  the gold chats, a Claude Sonnet 4.6 reader answered 150/150 (GPT-4o judge,
  official LongMemEval prompts). With no chats it answered 0/120 answerable
  questions and, as expected, 30/30 abstention questions.
- **Overlap audit.** Against LongMemEval S and M: 0 of 150 questions identical,
  highest word-set similarity 0.33, 0 persona full names, 0 of 1,650 chats
  sharing a 13-word run of text. All 500 M questions are S questions.
- **`eval/runner/sealed-confirmation.ts`.** Runs gbrain through the LongMemEval
  runner's code path on a questions file that passes an input allowlist, then
  scores with the private labels path given only at scoring time. Scoring
  refuses a labels file that does not match its commitment and logs every
  access with its purpose and decision id.
- **`eval/generators/sealed-confirmation-gen.ts`** with frozen prompts, and a
  durable spend-reservation ledger checked before every paid request.
- Cost: $17.83 in paid API calls, $15.82 generation (including two one-persona
  pilots) and $2.00 solvability.

### Memory lifecycle experiment (plan amendment 8)

A new experiment follows one small vault through a full memory lifecycle
(ingest, query, an ingest during an embedding outage, corrections, a full
reconcile, a forget, a restart) and scores what an agent can read against a
ledger the evaluator writes itself. It compares four gbrain builds on PGLite
and Postgres through the local CLI, MCP stdio and MCP HTTP, twice, at $0.

- **`eval/runner/lifecycle-experiment.ts`** and `eval/runner/lifecycle/`: the
  scenario and ground-truth ledger, drivers for the three interfaces, a
  hermetic OpenAI-compatible hash embedder with fault injection, the scorer,
  and copied-overlay build preparation. A build runs only if its copied files
  hash to the requested commit's tree, no symlink exists under `src/`, and
  `gbrain --version` matches its `VERSION`.
- **`eval/runner/lifecycle-report.ts`**: tables from a receipt, and a
  cell-by-cell comparison of repeat runs.
- **[Lifecycle report](docs/benchmarks/2026-09-29-lifecycle.md)** with a
  primary run and a repeat.
- Measured 2026-09-29: forgetting one entity's fact expired the identical claim
  on another entity, and refused the same claim for a third, in 18 of 18 cells
  on v0.59.3.0, v0.59.11.0 and master v0.59.13.0. Master plus #5666 fixed both
  in 6 of 6. A remote caller read a private page's tags in 4 of 4 remote cells
  on v0.59.3.0 and v0.59.11.0, and 0 of 4 from master (#5676) on. Still failing
  on every build: a slug collision stops its source's sync, so files after it
  are never imported; a renamed page loses its inbound link and its old slug;
  on PGLite with a live MCP server, delegated syncs extract 0 or 1 of 8 links,
  and `gbrain extract --stale` was refused in 240 of 240 attempts.

### Leak-free LongMemEval answer re-run (2026-09-29)

With session ids made opaque, gbrain's house reader answered **439/500
(87.8%)**. A GPT-4o reader using LongMemEval's official reading prompt, on
exactly the same retrieved sessions, answered 430/500 (86.0%); paired, that is
21 wins and 30 losses, exact McNemar p = 0.26, so the readers are not
demonstrably different. The run used the reranker off and the notes reader
with 1,024 output tokens, measured on gbrain PR 5676 at `a7cb37b`. That is not
the September 6 configuration, so it does not measure how much the leak
helped.

- **Report: [LongMemEval answers without the answer key](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md).**
  Strict retrieval on the same rows was 435/470. A 100-question component
  study with the reader and evidence held fixed found that the evidence budget
  matters far more than the prompt. Full retrieved sessions (about 15,800
  input tokens) gave 89/100. The five retrieved chunks alone (about 3,400
  tokens) gave 65/100 with gbrain's reader prompt, 65/100 with a plain prompt
  and 64/100 with `gbrain think`'s prompt; each prompt against gbrain's was
  p = 1.0. The report lists four harness stalls, a machine restart and the
  paid cost (about $59.6).
- Receipts under `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/`: summary,
  per-question table, and rows for all five arms; the official-judge files;
  the full reader and judge prompts (gzip); chunk texts, logs, scripts, and
  provenance with dataset and cache hashes. Twelve manifest entries pin their
  hashes and the counts 439/500, 430/500, 65, 65 and 64 of 100, and 435/470.
- `scripts/verify-longmemeval-opaque-qa.py`, a keyless recount run by
  `bun run validate`. It re-derives every arm's verdict counts, the paired
  tests and the strict recall count, and checks that none of the 1,300 saved
  reader prompts contains `answer_` or a retrieved raw session id.

### Final fix wave on the September 28 audits

- **Relationship retrieval does not help on reworded questions.** A seeded
  paraphrase grammar, committed before scoring, rewords the 145 world-v1
  relationship questions without changing their answers. At gbrain `b80cad6`,
  over three ingestion orders (435 paired runs per wording), relationship
  retrieval fired on 174 template runs and 0 paraphrase runs. Template
  wording: first-place hits 27.6% to 42.8% (72 runs better, 6 worse), recall
  at five 0.737 to 0.763 (18 better, 0 worse, 6 distinct questions).
  Paraphrased: 0.411 recall at five and 4.8% first-place hits in both arms, no
  run changed (audit B-RAB-01, issue #24 finding 6).
  [Report](docs/benchmarks/2026-09-29-relational-paraphrase.md).
- **Cat 6 bare-name mentions: 50/50 linked** by gbrain's by-mention pass (a new
  gazetteer arm), 0/50 by the ordinary links pass. The pure-extractor gates are
  unchanged (250 probes, recall and labeled precision 1.0).
- **Gates that could pass on nothing.** Cat 27 fails when no probe improves; it
  currently passes because one of four probes gains 3.1 points of nDCG@10, and
  every probe's ranking changes (B-27-01). Cat 24's dedup probe requires the
  hash short-circuit itself (status `skipped`, unchanged `updated_at` and chunk
  ids); a forced re-chunk fails it (B-24-01). Cat 32 Part B needs at least one
  candidate the held-out gate blocked; no regression with zero blocks is
  `partial` (B-32-01). Cat 30's `seed-no-brain-first` held-out scores
  retrieval of a generated topic page from a brain Cat 30 imports, instead of
  citations an empty brain could only invent (B-30-01).
- **Unpublishable stub receipts.** Cat 19 and Cat 27 hash-embedding runs are no
  longer publishable (A-22, B-27-01); Cat 29 stub runs report `partial` and no
  longer overwrite a crashed side's zero (B-29-04); perf is unpublishable when
  no threshold was evaluated and counts only successful link writes (C-11).
- **Data integrity.** `validate-data.ts` checks amara-life hashes under the
  generator's scheme (per record for JSONL and calendar entries, per file
  otherwise): 424 of 424 manifest items verify, and a mismatch fails instead
  of warning (C10). `poison.json` is generated from the planted fixtures; the
  five gold stubs with no generator or runnable consumer (`backlinks`,
  `citations`, `entities`, `personalization-rubric`, `qrels`) are removed, and
  a hand-written template row fails validation.
- Smaller audit items: Cat 13 gap localizer withholds its proposal above a 5%
  re-simulation mismatch and reads the committed E0 receipt (A-16); malformed
  `CAT18_MIN_RECALL` / `CAT21_MIN_MRR` throw and overrides are unpublishable
  (A-23); a zero-query Cat 18 cell is invalid (A-24); situation-recall Cat 13b
  over its infra cap is an error (A-25); Cat 13b drops its gateway memo and
  restores `GBRAIN_SOURCE_BOOST` (A-17); Cat 22's presence floor is the seeded
  count minus two (B-22-01); Cat 33 B-pre reports no transfer ratio (B-33-01);
  Cat 30/33 gates need all but one seed scored (B-30-04); Cat 32 `sel_climb`
  compares like splits (B-32-02); Cat 28 isolates `GBRAIN_HOME` and records
  failed-pass latency (B-28-01); Cat 35 leakage leaves judge-failed hits out of
  the denominator, including in the native Cat 35 reconstruction (PC-04); the
  shootout driver reports `partial` (PD-15); `query:validate` rejects unfilled
  scaffold placeholders (PD-17); the skillopt sentinel clears stale partial
  results (B-SH-01); relational-ab `--limit` samples across templates
  (B-RAB-02).
- Cat 6's header said gbrain has no bare-name linking; it does, through the
  by-mention pass. Cat 3 and Cat 4 headers and registry names say they test
  keyword alias lookup and timeline storage, and name the gbrain features they
  leave untested (F3, F4, F5).
- `gold/contradictions.json` is documented as reserved for the planned N2
  category. Both claims appear verbatim in their source text for 9 of 15
  fixtures, which N2 must check first (F6).

### Plan documents

- `docs/plans/2026-09-28-gbrain-10x/` records the approved gbrain 10x plan, its
  outside review and the five September 28 audits (evals correctness, evals
  docs and infrastructure, coverage and categories, gbrain read path, gbrain
  write path). The docs index links them.

### Limits

- Cat 30 to 33 model calls and the Cat 35 dream and facts lanes run inside
  gbrain and still use the provider default temperature. The reading-notes
  reader keeps its published default temperature so that an opaque-id rerun
  changes one variable.
- The reading-notes result stays pending until its opaque-id re-run, and the
  retracted Cat14, Cat 29 and multi-adapter figures stay invalid until paid
  re-runs. A reranker-on LongMemEval answer run needs a Voyage key.
- Receipt v2 cost stays null in paid runners not yet wired to the budget
  ledger (Cats 14, 15, 18, 18b, 20, 21, 25, 26, 29 live, multi-adapter,
  PrecisionMemBench).
- The evaluator separation is still in-process; a product in the same process
  could still read dataset files. The sealed confirmation set is not yet wired
  to the paired comparator.
- On 2026-09-29 gbrain's own `gbrain eval compare` printed a bootstrap
  methodology string without computing a bootstrap
  (`src/commands/eval-compare.ts:243`). gbrain v0.59.18.0 (#5685), included in
  the `608a174` pin, replaced it with a paired cluster bootstrap.
- Cat 34 records a skip in CI because it needs an external gbrain checkout.

## [0.10.0] - 2026-09-25

Taking brief notes before answering helped the tested readers use intact
conversations. On 361 fixed-retrieval questions, the historical Sonnet 4.6
reader rose from 308 to 324 judged correct answers; the separate 500-question
GPT-4o oracle replication found gains with notes in both natural-language and
JSON presentation. This measures answer reading, not retrieval or production
readiness. Nine historical notes answers hit the 512-token output limit, and
source audits exposed grading artifacts.

In a separate release smoke, all nine selected prior cutoff responses ended
naturally at the new 1,024-token limit. That is a completion check, not a
new accuracy measurement, and its $0.562143 spend is outside the study total.

### Added

- A dated standalone report with original public per-question labels, repeat
  controls, regrades, cost aggregates and private-source provenance. It keeps
  the earlier failed excerpt approach identifiable and does not publish
  conversations, prompts or model-generated answers.
- A keyless, fail-closed recount that reproduces every paired score and
  category breakdown, rejects incomplete/mismatched streams, and checks
  aggregate token-priced spend including the earlier failed pilot. No model
  call runs from the report, recount or tests.
- An offline paired-request preparer through the GBrain sanitizer and an
  explicitly opt-in gateway execution lane with a finite spend cap and
  per-attempt accounting. The new lane reports completion and cost; it does
  not claim new answer accuracy without graded responses.

### Changed

- Document the companion GBrain notes-first reader default and direct
  override separately from the immutable historical 512-token study. The
  packaged 1,024-token default is a new setting that needs its own measured
  comparison; this release does not claim its performance was tested here.
- Keep the established `gbrain` pin for historical runners and add a separate
  immutable `gbrain-reader` pin only for the new comparison path. Retain its required
  `postgres@3.4.9` patch at the repository root so Bun's frozen lockfile
  install can resolve the transitive patch from a clean checkout. (September 28, 2026 correction: this patch was never applied, because
  `package.json` did not declare `patchedDependencies`; v0.10.2 declares it.
  The "historical runners" results also came from gbrain `2efaaf8f`, not
  from the `939232f` pin kept here.)
- Restrict CI TypeScript filtering to diagnostics whose path begins with
  `node_modules/`, so a repo-owned error mentioning a dependency path still
  fails instead of disappearing.

### Limits

The public labels and token aggregates support a keyless recount, not
generation of the private historical responses or an independent per-call
audit. The two study phases share questions and differ in dates and reader
models, so they are not independent confirmations.

## [0.9.0] - 2026-09-23

Engineers can now test whether situation cues help retrieve the original notes
needed by an indirectly worded question, and inspect the evidence required to
reject a regression. This release adds the
[evaluation protocol and harness](docs/benchmarks/2026-09-23-situation-recall-protocol.md),
not a measured retrieval gain. No paid comparison or all-category no-regression
result is published here.

### Added

- Cat36 Associative Retrieval: 120 fictional scenario families across five
  domains, with 160 development and 320 holdout probes. Its primary metric
  requires all labeled source spans in the five actual production chunks,
  rather than crediting a correct page with the wrong passage.
- Production cue-build receipts, frozen-index Scene/Horizon read-time
  comparisons, separate Bridge construction, and a real contextual-summary
  control. Deterministic provider stubs remain nonpublishable plumbing checks.
- A complete category inventory and paired release gate covering native metric
  denominators, floors, slices, source identity, execution observations and
  critical case losses. Missing, partial, stale or unsupported cells block release.
- Explicit programmatic category drivers, a native Cat13b pilot, source and
  reminder replays, and separate answer-grounding replays that retain original
  outputs and judge attempts. The LongMemEval secondary check is not official
  answer accuracy.
- OpenRouter development controls with fixed model routes, local request and
  reservation limits, and fsynced, sanitized request/response evidence. A closed
  source-only policy separates construction from embedding-only replay; it is
  preparatory infrastructure, not a new dataset or measured capability result.
  Operator-controlled diagnostics remain nonpublishable and do not claim an
  external provider credit cap.
- A separately registered v2 source-only policy for the v4 source-reference
  formatter. It checks the actual installed formatter's canonical wire content
  without treating internal excerpt metadata as a public request shape. The
  historical v1/v3 contract and all financial and output ceilings remain intact.

### Changed

- Pin the candidate product to `939232f1746381b4e932d620d6c709e29198f14c`
  (gbrain v0.55.0.0), while keeping the historical dependency and fresh baseline
  identities distinct. CI uses supported Bun 1.3.13.
- Retain previously omitted native per-item observations without changing
  benchmark inputs, scoring formulas or published historical artifacts.
- Add opt-in LongMemEval evidence capture and isolated HOME/configuration paths,
  with exact loaded-code, model, source and build identities.

### Fixed

- Keep the existing keyword and identity fixtures readable through current,
  revision-bound projections while preserving their original text and labels.
- Distinguish a valid zero-score judge control from an unavailable judge, and
  update tool-bridge test fixtures for atomic page snapshots without relaxing
  their behavior assertions.
- Preserve malformed or over-budget raw responses and existing LongMemEval
  receipts on rejected capture, score legitimate bounded search misses, and
  verify the product's actual configuration-file resolver.

### Not yet measured

For publishable comparisons, independent corpus and recipe review, real input
catalogs, supported transport and protocol coverage, enforced external provider
allowances, and complete live B/C0/C1 receipts remain prerequisites. The cue
builder's durable cap does not create a whole-cell spending limit. Unattributable
traversal results and other missing evidence remain blocked; hermetic checks do
not prove semantic quality, privacy, reminder precision or release readiness.

## [0.8.0] - 2026-09-09

Engineers can now choose a retrieval configuration by the questions they need to
answer. The rewritten guides explain word search, vectors, relationships, and
ranking through concrete cases. The [retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md)
publishes all eleven planned experiment cells, including losses and the settings
that produced them.

### Added

- Three reading paths: [understand retrieval](docs/retrieval-lessons.md),
  [choose settings](docs/settings.md), and [inspect the research](docs/README.md).
- A controlled production relationship comparison with shared indexes and query
  vectors. It improved recall on 15 of 145 questions in each of three ingestion
  orders, with no recall losses; attendance questions did not improve.
- Complete concept, source-preference, baseline, and PrecisionMemBench results,
  with per-question rankings, paired comparisons, charts, and API accounting.
  Recorded usage estimates total $0.7133 before credits, within the $1,000 ceiling.
- Reproduction and verification scripts, explicit configuration records, and
  regression tests for result order, failed features, shared evidence, and spending limits.

### Changed

- Rewrote all 42 authored documents, including 18 historical reports, in plain
  English. Preserved benchmark inputs, generated evidence, tested prompts,
  historical measurements, and the gbrain dependency pin.
- Separated finding evidence from answering correctly. The September 6
  LongMemEval records support recounting retrieval and saved judgments; omitted
  answer text prevents independent re-judging.
- Dated external comparisons, corrected stale configuration and cache guidance,
  and linked adoption recommendations to their workloads and evidence.

### Fixed

- Hybrid adapters preserve gbrain's final order and keep the first occurrence
  of each page, so they no longer undo reranking or deliberate relationship placement.
- Failed searches produce valid diagnostic receipts. Offline publication checks
  reject incomplete relationship comparisons and can follow saved report paths
  after the repository moves to another checkout.

## [0.7.0] - 2026-09-06

The [ranking experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md) showed that preserving additional evidence helped multi-part conversation questions. The release default reached **95.53% strict recall_all@5 (449/470)**, compared with **80.64%** for the previous default. The result-cutoff step had been dropping a second required session.

The first judged answer-quality run scored **86.6% (433/500)**. That is a different measure from finding the evidence, and this release made no cross-system answer-quality claim.

Two other changes addressed specific ranking failures: the metadata boost gate improved Cat13 held-out nDCG@5 from **53.0 to 57.8**, and preserving graph-derived relational results through reranking improved NamedThingBench hit@1 from **3/39 to 21/39**. Expansion-weight budgeting and keyword-arm confidence did not satisfy their decision rules and did not become defaults.

### Evidence and configuration

- Added compacted per-question results for eight LongMemEval arms and the judged run, cutoff replays, miss diagnostics, Cat13 E0/E2/E3 results, NamedThingBench R1 results, aggregate JSON and two SVG charts.
- Added a converter from the gbrain harness's NDJSON into the chart runner's `RunnerOutput` format.
- Updated both dependency files to the ranking release. The installed pin became merge commit `2efaaf8f`, gbrain v0.48.4.0. Updating only `package.json` had previously left frozen installation broken and local runs on v0.48.2.0.
- Cat13 receipts now identify the resolved `balanced` bundle and explicit overrides. They expose whether two nominally similar runs inherited different defaults.
- E1 localization and Cat27 graph-signal comparisons explicitly select `search.metadata_boost_gate=always` when testing the old, ungated behavior. The E1 live result records `gate_always` so its replay can be checked.

### Cat13 runner improvements

All adapters now use the selected embedding model and dimensions. Flags override `CAT13_EMBEDDING_MODEL` and `CAT13_EMBED_DIMS`; defaults remain `openai:text-embedding-3-large` at 1536 dimensions. Receipts record the gateway state after each adapter initializes, and mismatched settings invalidate the run.

The gbrain-backed adapters accept explicit reranker and autocut flags, both off by default in this runner. Reranker-on selects `voyage:rerank-2.5`, requires a Voyage key, rejects fake embeddings, and must produce observed reranker scores. Expansion budgeting, keyword-arm confidence and generic `--search-pin KEY=VALUE` support controlled comparisons. Unknown CLI flags are rejected.

The concept split defaults to 20 tuning concepts and 10 held-out concepts, seed 42. Scores and per-template results are reported separately; questions spanning both sets stay in the overall result but not either subset. See the [Cat13 recipe](eval/runner/README-cat13-phase-e0.md).

### Test reliability

A process-global embedding transport could be reset by another test, causing a supposedly hermetic run to call a live provider. The runner now reinstalls its transport and verifies it before ingestion and queries.

PGLite's roughly 1 GB WASM allocation also delayed garbage collection. Tests accumulated 1–2 GB of temporary objects and more than 50,000 memory mappings, approaching the default kernel limit of 65,530. Collection is paced every 40 imported pages, every 25 queries and after teardown. Full-suite peak mappings fell from about 55,000 to 16,000 without changing assertions.

## [0.6.1] - 2026-09-02

A fresh [LongMemEval-S comparison](docs/benchmarks/2026-05-07-longmemeval-s.md) measured gbrain v0.48.2.0 on the cleaned September 2025 dataset. Each arm scored 470 answerable questions at k=5 in one run, with zero errors.

| Arm | Strict recall_all@5 | Questions |
|---|---|---|
| Hybrid | 93.19% | 438/470 |
| Hybrid with reranking | 95.32% | 448/470 |
| Hybrid with session diversity | 93.40% | 439/470 |
| Session diversity plus reranking | 95.53% | 449/470 |
| Hybrid with query expansion | 54.89% | 258/470 |

The reranker gained 18 questions and lost 8 compared with hybrid. Its any-hit score was 99.79%. Temporal-reasoning recall rose from 84.3% to 89.8% (107 to 114 of 127), the knowledge-update and three single-session types reached 100%, and multi-session recall stayed at 92.6% (112/121).

Session diversity added one question without reranking. Expansion lost 183 and gained 3; its earlier v0.48.0.0 measurement was 49.6%. More alternative phrasings did not help at this five-result limit.

### Reproducibility and comparisons

The dependency moved to `5cfb84f1`, the v0.48.2.0 PR #4792 head, pending its merge pin. Reranker specifications explicitly selected `voyage:rerank-2.5` and derived the required `VOYAGE_API_KEY` from that model choice.

The 93.19% hybrid result matched the v0.48.0.0 receipt and could be compared with the May 83.40% result. A pre-fix run at `2a56b512` recorded 51.39%. All five arms and the pre-fix stream were committed with artifact hashes, an aggregate and regenerated charts.

The charts separated strict recall from any-hit and answer accuracy. Their contextual comparisons used our recomputation of MemPalace's strict scores, 85.7% raw and 90.0% with LLM reranking, and ContextFit's self-reported 87.45% with its label-leakage qualification.

### Compatibility fixes

- Reconciled `package.json`, previously 0.5.1, with `VERSION` at 0.6.1.
- Updated graph traversal contract tests for gbrain #4704's bidirectional `GraphPath[]` result shape. Tests retained the depth-10 cap, explicit depth and depth-2 default checks.
- Cat15 reads `PROPOSE_TAKES_PROMPT_VERSION` from gbrain instead of a stale literal. The prompt text also changed in gbrain #4736, so the old Cat15 F1 result required a live remeasurement.

## [0.6.0] - 2026-09-01

Outside reviews #26 and #24 prompted stronger links between claims and saved results. The review's sub-claim about PR #13 containing benchmark figures was refuted.

### Saved evidence

- Committed the May LongMemEval stream: 2,696 rows, hash `a26453…3d0b`. An offline regression test recalculates all four adapters' summaries and per-type results. The previously referenced but missing NDJSON validator was added.
- Added `docs/receipts-manifest.json`, which maps selected claims to artifact hashes and expected values or explicit gaps. The declared gaps were SkillOpt, relational recall and the stability snapshot.
- Committed the June Cat34 originals and a dated offline rerun at `2a56b512`: know-to-ask failures 0/149 and push recall 0.9063 / 1.000 / 0.5521. The report disclosed that it relies on counters reported by the system under test and preserved historical charts.
- Cat35 receipts began recording server-reported model IDs and call counts. Cross-run deltas require matching resolved models; `claude-sonnet-4-6` remained a movable alias rather than a dated snapshot.

### Session-level diagnostics

The May top-five chunk lists averaged 2.68 distinct sessions, with 99.6% containing fewer than five distinct sessions. This motivated explicit session-diversity adapters, including expansion and reranker variants. It did not itself prove diversity would improve accuracy. Existing adapters retained their behavior, rows gained a `run_config_hash`, and aggregation rejected mixed configurations.

### Clearer claims

The comparison guide identified MemPalace's 96.6% as any-hit recall and labeled the then-quoted 97.66% gbrain comparison accordingly. ContextFit's 84.3% token-plus-certificates and 87.45% fused strict scores were separated from gbrain's May 83.40% / 84.26%. LETHE, Memoria, Mem0 and a PrecisionMemBench comparison were added with sources.

PrecisionMemBench's 0.582 became an explicitly qualified upper bound and the default was corrected to 0.075. Cat35's “zero junk leakage” became 1.2% (1/86), Cat34's 0.552 Codex integration result was included, and the historical relational 97.9% / 49.1% result gained a pre-audit qualification.

CI stopped swallowing typechecker crashes. Phase 2 smoke arguments were changed to an array.

## [0.5.1] - 2026-08-31

The May LongMemEval scoring error was corrected at $0 by rescoring the saved output. The same returned and expected sessions produced:

| Adapter | Strict recall_all@5 |
|---|---|
| Keyword | 10.64% |
| Vector | 79.36% |
| Hybrid | 83.40% |
| Hybrid with expansion | 84.26% |

There were 470 scored questions; 30 abstention questions were excluded. Hybrid multi-session recall was 71.9% and temporal-reasoning recall 69.3%. Knowledge-update also lost credit on one question requiring multiple sessions.

The old score reconciled exactly: 459 answerable any-hits plus 29 abstention any-hits gave 488/500 = 97.60%. All 500 reference answer sets matched the dataset, there were no error rows, and 696 resume duplicates were removed with successful rows preferred. Saved summaries are `rescore-may-2026-08-31.json` and its generated Markdown companion.

Under strict scoring, expansion added four questions, or 0.85 percentage points overall, and 3.9 points on temporal reasoning. The earlier “no effect” conclusion came from an almost saturated any-hit metric.

Reproduction examples were corrected: `--path` takes the file path, `--dataset` the split name, and the runner defaults to k=8. A published k=5 comparison must select it explicitly. A fresh run of newer gbrain code remained separate work at this release.

## [0.5.0] - 2026-08-31

**Scoring definitions changed. Earlier scores cannot be compared directly with post-audit runs.** The [audit](docs/audit/2026-08-31-eval-audit.md) verified 237 findings and drove these changes:

- Recall counts unique IDs; precision@k divides by k. LongMemEval uses all-required-session recall. Model judges must return every required criterion at temperature 0.
- Common receipts distinguish success, failure, skip and error origin. The category runner reads receipts instead of interpreting every zero exit as success. System failures remain scored misses; excessive harness failures invalidate a run at the stated greater-than-10% limit.
- Fixed Cat13/Cat13b gateway setup, asynchronous link extraction, LongMemEval imports and 17 runners' version stamps. The gbrain dependency and lockfile were pinned.
- About 12 tests that could not previously fail gained reachable failure conditions, feature boundaries and negative controls. Judges were blinded where needed. Unintended reranking was removed from embedder comparisons.
- Repaired source-data references, an overwritten synthetic deal page and the q11 answer label with a recorded rationale. Baseline latency capture became serial; the old concurrent measurements were about ten times too high.
- Added offline CI checks for types, tests, data integrity, selected end-to-end runners and the qrels/baseline comparison.
- SkillOpt held-out tasks gained different, stricter judging criteria. Earlier held-out scores tested topic transfer but reused training criteria.
- Wrapper scripts now propagate failed categories. The LongMemEval batch script respects the dataset and its size. Shootout scripts check each cell, and Phase 1 has a wall-clock limit. The prior environment-expansion bug had silently killed four of seven cells.

Releases 0.3.0 and 0.4.0 landed during remediation. The final pin was v0.47.8.0 (`2a56b512`), six commits after the audited v0.47.6.0 code. The remediated suite was rechecked against it.

## [0.4.0] - 2026-08-31

The [Cat35 report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) added before-and-after runs around gbrain's write-path fixes in [PR #4742](https://github.com/garrytan/gbrain/pull/4742). They used the same corpus, judge model and prompt version.

Dream-lane retention reached **88.1%**, with a 95% interval of **82.0–93.5**, compared with 61.5% in the original publication and 70.2% immediately before the change. All 20 expected sessions produced pages, up from 16. The four recovered sessions used verified quoted segments despite falling below the ordinary triage threshold; routine controls did not trigger the rescue.

Quote fidelity reached 82.7% from 45.4%, claim hallucination fell to 7.0% from 14.1%, and facts-lane recall reached 64.8%. Adding an idea category improved idea recall from 38.3% to 50.0%. Both new receipts were preserved alongside the original, with qualifications about single-run judge variation, changed quote denominators and a distractor judgment changing.

The [Cat34 update](docs/benchmarks/2026-06-12-brainbench-memory.md) recorded know-to-ask failure falling from 0.150 to 0.000 on all three integrations after gbrain v0.46.15.0. False fires were 0.000, push recall 0.906 / 1.000 / 0.552, and precision 1.000.

The dependency advanced to `2a56b512`, v0.47.8.0. The PGLite teardown freeze no longer reproduced there; six skipped test teardowns were restored after watchdog-protected verification.

## [0.3.0] - 2026-08-27

Added Cat35 to measure what survives when a working conversation becomes memory: facts, ideas, decisions, entities and emotional context.

The [first publication](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) measured **61.5% retained content** (95% interval 45.0–77.6), 85% usability, zero distractor leakage and 14.1% hallucinated claims. The verbatim control measured 93.1% judged coverage, 100% leakage after the case-insensitive correction, and 0% usability. Emotional-context recall was 71.4% versus 52.5% for facts; the separate facts extractor scored 69% on facts and 38% on ideas.

The committed corpus contains 24 fictional sessions, six scenarios, 173 important content units with verbatim anchors, 86 distractors and two attribution hazards. Its skeleton is deterministic; its prose came from cached Opus generation.

The runner defaults to a small paid setup check, historically about $0.10. The full package command selects `CAT35_FULL` and performs a cost preflight. Receipts include comparison deltas, triage thresholds and a judge-calibration scaffold.

Review added case-insensitive anchor checks, full-corpus publication requirements, evidence-backed judge verdicts, explicit judge-failure handling and transcript hash validation. The leakage correction changed the verbatim floor from 96.5% to 100%; dream remained 0%.

The dependency was pinned to gbrain v0.46.3.0, installation gained the PGLite path repair, and category-runner/tool-bridge tests were fixed. The Bun teardown freeze was temporarily worked around and tracked upstream.

## [0.2.0] - 2026-05-29

Integrated [PrecisionMemBench](https://github.com/tenurehq/precisionmembench), using tenurehq's MIT fixtures and scorer at `c9689ca`. The test separates how much relevant material search returns from whether a later model writes a good answer.

The initial default hybrid score was reported as **0.076 precision**, with recall 0.99. Returning many pages made recall high but precision low. Later documentation reconciled the default to its saved value, 0.0752.

That experiment led to optional adaptive result limits. The historical tight setting scored **0.582 precision, 29 active passes and 44/77 overall cases**, compared with the cited supermemory row of 0.43 and 17 active passes at roughly three times the latency. These comparisons describe that recorded setup; subsequent adapter corrections required remeasurement.

A proposed score-gap detector did not separate right from wrong first results: the rank-one/rank-two gap was 0.60 for correct results and 0.57 for incorrect ones. Restricting result count accounted for the useful improvement in this experiment.

The report distinguished the 35-belief lexical corpus, harness-computed structural cases and the think adapter's citation-based view from ordinary search. Adaptive behavior stayed off by default pending a recall comparison. The then-promoted LongMemEval 97.60% number used the old any-hit metric; release 0.5.1 later corrected its interpretation.

Added the external fixtures, scorer, adapters, seed code, attribution, four-mode runner, instrumentation and tests. The adaptive option initially needed a local unreleased gbrain checkout.

Saved JSONs were added for the tight result and ordinary settings. One shipped-default adaptive row was reconciled to its actual run: 0.16 precision, one active pass and 8/77 cases. The scorer's type import was corrected to its local layout, the gold-schema test excluded unrelated subset files, and the fictional v0.41-launch baseline/qrels work was included.

## [0.1.0] - prior

Initial BrainBench included world-v1 and amara-life-v1, the 12-category catalog, LongMemEval-S integration and the v0.40.6.0 snapshot. Its historical 97.60% LongMemEval figure was compared with MemPalace's 96.6% raw figure; subsequent releases clarified the metric and comparison limits. See the dated reports for the original experiments.
