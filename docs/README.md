# Learn, evaluate, and extend gbrain

This index lists every published report by the question it answers. It describes the repository as it stands:
gbrain-evals v0.10.37, with gbrain master `c5fb0201` (v0.60.95.0) as the product under test. Results measured at
other gbrain commits name that commit in their report. Everything above [Changelog](#changelog) is current; the
changelog at the bottom records how this index changed.

Start with [what gbrain does today](../README.md), then follow the route that fits what you are trying to do.

| Your question | Read this |
|---|---|
| How do words, vectors, and relationships work together? | [Retrieval lessons](retrieval-lessons.md) |
| Which setup should I evaluate for my application? | [Settings by workload](settings.md) |
| What does the current pin change, category by category? | [October 6 re-pin at gbrain `c5fb0201`](benchmarks/2026-10-06-followups-repin.md) ([preregistration](benchmarks/2026-10-06-followups-repin-preregistration.md)) |
| What did the October 2026 follow-up round measure, and why? | [Follow-up round plan and its reviews](plans/2026-10-06-followups-round/PLAN.md) |
| Does gbrain help an agent finish real tasks, and do agents operate it safely? | [Model Ladder (Cat 40)](benchmarks/2026-10-02-model-ladder.md), [agent operator outcomes (Cat 41)](benchmarks/2026-10-03-agent-operator.md) |
| How do I run the benchmarks? | [Evaluation guide](../eval/README.md), [troubleshooting](../eval/RUNBOOK.md) |
| How do I get a dev or held-out verdict for a gbrain change? | [Decision kit](decisions.md) (`bun run eval:decide`) |
| Where does gbrain master start, and which feature ideas won or lost their held-out tests? | [October 5 nine-plan held-out program: starting line, verdicts and scorecard](benchmarks/2026-10-05-heldout-program.md); [October 6 BEAM-1M rerun with every session dated](benchmarks/2026-10-06-beam-1m-dates.md) |
| Which agent-written labels has a person checked? | [October 6 review packets and their rules](benchmarks/2026-10-06-w11-review/README.md) ([preregistration](benchmarks/2026-10-06-w11-review-preregistration.md)): awaiting human review |
| How can I contribute a competing system, new questions or a category? | [Contributor guide](../eval/CONTRIBUTING.md) |
| Which outside scores are actually comparable? | [Cross-system comparison](comparison-systems.md) |
| What is the plan for improving gbrain and proving it? | [September 28 plan and audits](plans/2026-09-28-gbrain-10x/README.md) |
| What will the next categories measure, and what does gbrain implement for each of them? | [October 1 eval-category wave plan](plans/2026-10-01-eval-category-wave/README.md), [capability and entrypoint matrix](benchmarks/2026-10-01-capability-matrix.md) |

## Retrieval experiments

A report's date identifies an experiment. Each table lists the reports that
describe current behavior first, then the older work behind a decision.

| Engineering question | Report |
|---|---|
| Does gbrain's automatic whole-conversation delivery hold up on the sealed held-out set? | [September 30 auto v2 release check](benchmarks/2026-09-30-evidence-auto-v2.md) |
| Does it hold up on a harder held-out set where chunks fall short? | [October 2 sealed v2 release decision 1](benchmarks/2026-10-02-sealed-v2-decision-1.md) ([preregistration](benchmarks/2026-10-02-sealed-v2-decision-1-preregistration.md)) |
| Should an agent get neighbor chunks, sections or whole pages instead of bare chunks, and at what token cost? | [September 30 evidence-delivery study](benchmarks/2026-09-30-evidence-delivery.md) |
| Do the published LongMemEval retrieval and reading-notes numbers hold with opaque session ids, and what does a frontier reader score on gbrain's retrieval? | [October 4 opaque-id follow-ups and frontier reader](benchmarks/2026-10-04-longmemeval-opaque-followups.md) ([preregistration](benchmarks/2026-10-04-longmemeval-opaque-followups-preregistration.md)) |
| With the answer key hidden, how accurate are gbrain's answers, and does the reader prompt or the amount of evidence matter more? | [September 29 opaque-id answer re-run](benchmarks/2026-09-29-longmemeval-opaque-qa.md) |
| Does taking brief notes before answering help when the original conversations remain available? | [September 25 reading-notes comparison](benchmarks/2026-09-25-reading-notes.md) |
| Does gbrain link Korean names without matching inside longer words? | [October 5 Hangul mention boundaries](benchmarks/2026-10-05-hangul-mention-boundaries.md) |
| Does relationship retrieval still help when the question is reworded? | [September 29 paraphrase check](benchmarks/2026-09-29-relational-paraphrase.md) |
| How do the corrected baselines, relationship switch, source preference, and return caps behave? | [September 9 refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| What improved conversation retrieval, and which proposed fixes failed? | [September 6 ranking experiments](benchmarks/2026-09-06-longmemeval-ranker-wave.md) |
| Can a system retrieve every conversation needed to answer a question? | [LongMemEval history and rescoring](benchmarks/2026-05-07-longmemeval-s.md) |
| How does limiting returned facts change precision and recall? | [PrecisionMemBench](benchmarks/2026-05-29-precisionmembench.md) |
| Can curated notes stay visible among longer imported chats? | [Source-swamp experiment](benchmarks/2026-04-25-brainbench-cat13b-source-swamp.md) |
| Can search find concepts described in different words? | [Original concept experiment](benchmarks/2026-04-23-brainbench-cat13-conceptual.md), [October 2 matched comparison with the same reranker on vectors and gbrain](benchmarks/2026-10-02-concept-vector-rerank.md) |
| How did the specialized relationship adapter compare with search baselines? | [April four-adapter comparison](benchmarks/2026-04-19-brainbench-multi-adapter.md) |
| What did the original graph extraction change? | [BrainBench v1](benchmarks/2026-04-18-brainbench-v1.md) |
| How did subsequent gbrain versions behave on those earlier tests? | [v0.11 versus v0.12](benchmarks/2026-04-19-brainbench-v0_11-vs-v0_12.md), [v0.13](benchmarks/2026-04-19-knowledge-runtime-v0.13.md), [v0.20](benchmarks/2026-04-23-brainbench-v0.20.0.md), [v0.40 snapshot](benchmarks/2026-05-23-v0.40.6.0-snapshot.md) |

Earlier scorecards sometimes use a corrected-later harness or lack their raw
output. Those reports explain the limitation. In particular, the historical
relationship table compares several differences between adapters; its precision
gap does not isolate the effect of a graph alone.

## Saving, using, and improving memory

| Engineering question | Report |
|---|---|
| Does the index stay correct after moves, renames, corrections, forgetting, an embedding outage and a restart? | [September 29 lifecycle experiment](benchmarks/2026-09-29-lifecycle.md) |
| Does important material from a working session survive into saved pages? | [Transcript distillation](benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) |
| Does useful memory arrive at the right moment in a conversation? | [Memory conformance](benchmarks/2026-06-12-brainbench-memory.md) |
| Where does a small decision model (TypeSafe Jev) help gbrain triage, rerank, prune, abstain or spot contradicting facts, and where does it hurt? | [September 30 System One v1 slots](benchmarks/2026-09-30-system-one-jev.md) |
| Which embedder and reranker should a gbrain brain use, and what does each cost and send off the machine? | [October 6 embedding-provider matrix](benchmarks/2026-10-06-embedding-matrix.md) ([preregistration](benchmarks/2026-10-06-embedding-matrix-preregistration.md)) |
| Does code search find a function from a description that never names it, and does a code embedder help? | [October 6 Cat 21 paraphrase questions](benchmarks/2026-10-06-cat21-paraphrase.md) ([preregistration](benchmarks/2026-10-06-cat21-paraphrase-preregistration.md)) |
| On today's frontier models, does the takes-bootstrap classifier avoid attributing someone else's claims to the page holder? | [October 6 frontier rerun](benchmarks/2026-10-06-takes-bootstrap-frontier.md) ([preregistration](benchmarks/2026-10-06-takes-bootstrap-frontier-preregistration.md)) |
| Are brainstorm ideas weak, or was the judge harsh? | [October 6 Cat 20 with four judges and stored reasons](benchmarks/2026-10-06-cat20-judges.md) ([preregistration](benchmarks/2026-10-06-cat20-judges-preregistration.md)) |
| Did gbrain's takes-bootstrap classifier (facts, takes, bets and hunches from a person's pages) pass its graduation bar for running on autopilot? | [October 4 graduation verdict, mirrored from gbrain #6013](benchmarks/2026-10-04-takes-bootstrap-verdict.md) |
| What did gbrain fix wave 9 cost on fact inserts, and can takes-quality receipts from before and after it be compared? | [October 5 fix wave 9 mirror, from gbrain #6111](benchmarks/2026-10-05-fix-wave-9-mirror.md): pinning `search_path` makes bulk fact inserts about 10-13% slower with fingerprints unchanged; takes-quality protocol 1 and 2 receipts are dissimilar inputs |
| Can a skill improve on held-out tasks, and can the judge detect cheating? | [Skill optimization](benchmarks/2026-06-03-skillopt.md) |
| Can the system distinguish kinds of claims and sensible confidence? | [Calibration and proposed takes](benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md) (the advice result was retracted on September 28, 2026), [October 2 blind rerun of the advice test](benchmarks/2026-10-02-cat14-rerun.md) |
| When gbrain fails, refuses or needs a decision, do real agents (Claude Code, Codex) ask the user before spending money or destroying data, and do they recover from the errors they can fix? | [Agent operator outcomes (Cat 41): what it measures and its gate](benchmarks/2026-10-03-agent-operator-protocol.md), [runs: v0.60.35.0 baseline, gate passed at `b3f4e8b`](benchmarks/2026-10-03-agent-operator.md) |
| Does gbrain help an agent finish company-knowledge tasks better than grep, a memory tool or plain Postgres, and does that hold as models improve? | [Model Ladder (Cat 40): what it measures](benchmarks/2026-10-02-model-ladder-protocol.md), [results](benchmarks/2026-10-02-model-ladder.md) |
| Which MCP tool surface should gbrain register for agents: seven verbs, `starter` or `full`? | [October 5 registration-surface cell](benchmarks/2026-10-05-registration-surface.md) ([preregistration](benchmarks/2026-10-05-registration-surface-preregistration.md)) |
| What happens when tweet ingestion becomes parallel? | [Tweet ingestion](benchmarks/2026-04-18-tweet-ingestion.md) |
| What did the earlier ingestion worker comparisons measure? | [Subagent comparison](benchmarks/2026-04-18-minions-vs-openclaw-subagents.md), [production comparison](benchmarks/2026-04-18-minions-vs-openclaw-production.md) |

## Correctness and access checks (keyless, synthetic worlds)

| Engineering question | Report |
|---|---|
| Does gbrain answer "where did she work on that date?" and "when did I last see him?" from valid time, not from when a note was written? | [September 30 temporal and as-of check (N3)](benchmarks/2026-09-30-n3-temporal-asof.md) |
| Does a nickname, handle or former name reach the right person without merging two people who share a name? | [September 30 entity-resolution check (N4)](benchmarks/2026-09-30-n4-entity-resolution.md) |
| Can an agent-facing caller read private pages, held Takes, private Facts or another source through any read operation? | [September 30 visibility leak fuzz (N6)](benchmarks/2026-09-30-n6-visibility-fuzz.md), [October 6 on Postgres over the real HTTP transport](benchmarks/2026-10-06-n6-postgres-http.md) ([preregistration](benchmarks/2026-10-06-n6-postgres-http-preregistration.md)) |
| Does proactive recall keep private pages away from remote callers and the turn block, as a CI gate? | [October 6 N8 privacy gate](benchmarks/2026-10-06-n8-privacy-gate.md) ([preregistration](benchmarks/2026-10-06-n8-privacy-gate-preregistration.md)) |
| Which models can gbrain's contradiction judge run on, and what is the cheapest that passes N2? | [October 6 N2 judges on current models](benchmarks/2026-10-06-n2-judges.md) ([preregistration](benchmarks/2026-10-06-n2-judges-preregistration.md)) |
| Does "who attended" work when meetings list attendees the way gbrain documents? | [October 6 attendance world](benchmarks/2026-10-06-attendance-world.md) ([preregistration](benchmarks/2026-10-06-attendance-world-preregistration.md)) |
| Does the Jev answerability signal (S4) make a reader abstain on unanswerable questions without refusing answerable ones? | [October 6 A4 with S4 on](benchmarks/2026-10-06-a4-s4-on.md) ([preregistration](benchmarks/2026-10-06-a4-s4-on-preregistration.md)) |
| When the same conversation arrives as a Claude Code, Codex, ChatGPT or WhatsApp export (any of the 27 formats gbrain registers), does gbrain keep who said what and when, and admit what it cannot parse? Does a meeting page tell attendees from people only mentioned? (gates since 2026-10-02, when gbrain's fix for N12-1 was verified) | [October 1 ingestion format fidelity (N12)](benchmarks/2026-10-01-n12-format-fidelity.md) |
| Are gbrain's six code-intelligence operations ready to use on a real TypeScript repository, and where do their documented limits show? | [October 1 code-intelligence readiness scout (N13)](benchmarks/2026-10-01-n13-code-intelligence.md) |
| Does "who is waiting on me" open, close and mute Gmail loops the way the guide says, and where does a reply closing a loop differ from the work being done? | [October 1 open loops on Gmail-shaped threads (N7)](benchmarks/2026-10-01-n7-open-loops-email.md) |
| Does the brain volunteer the right page when someone is mentioned, without false alarms, and does it keep private pages out of what it pushes? (report-only) | [October 1 unsolicited recall at final delivery (N8)](benchmarks/2026-10-01-n8-proactive-recall.md) |
| Does relationship retrieval help questions that chain two or three relations, in wording the parser never saw, and does it still help reworded one-hop questions at the current pin? | [October 1 multi-hop check (N9)](benchmarks/2026-10-01-n9-multi-hop.md), [multi-relation planner preregistration](benchmarks/2026-10-04-p7-multi-hop-planner-preregistration.md) |
| After a value changes, does gbrain serve the new value everywhere and keep the old one as history, across transports, restarts, reimports and concurrent writes? | [October 1 knowledge update and supersession (N1)](benchmarks/2026-10-01-n1-knowledge-update.md), [October 2 CI slice](benchmarks/2026-10-02-ci-slices.md) |
| After `forget`, is the claim gone from every active recall surface, and only that claim, even after reimport, restart and concurrent writes? | [October 1 forgetting residue (N5)](benchmarks/2026-10-01-n5-forget-residue.md), [October 2 CI slice](benchmarks/2026-10-02-ci-slices.md) ([preregistration](benchmarks/2026-10-02-ci-slices-preregistration.md)) |
| When two notes disagree about the same fact, does gbrain find the pair, call it a contradiction rather than a change over time, and propose a safe fix? | [October 1 contradiction-surfacing check (N2)](benchmarks/2026-10-01-n2-contradiction-surfacing.md), [N2 and A4 preregistration](benchmarks/2026-10-01-n2-a4-preregistration.md) |
| Does gbrain's confidence grade tell an answerable question from an unanswerable one, and does a fixed reader on gbrain's retrieval say "I don't know" without refusing answerable questions? | [October 1 abstention check (A4)](benchmarks/2026-10-01-a4-abstention.md) |
| Which gbrain bugs, feature gaps and category defects has the October 1 eval-category wave found? | [Wave bug ledger](benchmarks/2026-10-01-wave-bugs.md) |
| After gbrain fix waves 5 and 6, which of those bugs are really fixed, and what changed in each category's numbers? | [October 2 rerun at gbrain `d44296c`](benchmarks/2026-10-02-wave-repin.md) |
| After gbrain fix wave 7, which ledger gaps did it close, and what changed in N2, N7, N9, N12, N13 and A4? | [October 3 rerun at gbrain `48ed5e8`](benchmarks/2026-10-03-wave7-repin.md) ([preregistration](benchmarks/2026-10-03-wave7-repin-preregistration.md), [N7 oracle amendment](benchmarks/2026-10-03-n7-oracle-amendment.md)) |
| After gbrain fix wave 8 and Foundations 1, did any category get worse, and what do the unpriced-model refusal, ignored-directory import and embed budget stop look like? | [October 3 re-pin at gbrain `109b992`](benchmarks/2026-10-03-wave8-f1-repin.md) ([regression preregistration](benchmarks/2026-10-03-wave8-f1-repin-preregistration.md), [checks preregistration](benchmarks/2026-10-03-wave8-f1-coverage-preregistration.md)) |
| After gbrain v0.60.38.0 to v0.60.46.0, did any category get worse, and do the empty-grant hint, `edit_page` diff order, per-page segment gap and Cat7-1 fix work? | [October 4 re-pin at gbrain `739e5cc`](benchmarks/2026-10-04-operator-wave-repin.md) ([regression preregistration](benchmarks/2026-10-04-operator-wave-repin-preregistration.md), [checks preregistration](benchmarks/2026-10-04-operator-wave-repin-coverage-preregistration.md)) |
| Does automatic event extraction (`auto_chronicle`) write accurate timeline events, at what cost, and does an agent answer date questions better with it on? | [October 4 off-versus-on experiment](benchmarks/2026-10-04-auto-chronicle-lift.md) ([preregistration](benchmarks/2026-10-04-auto-chronicle-lift-preregistration.md)), [rerun on gbrain #6010](benchmarks/2026-10-04-auto-chronicle-rerun.md) ([preregistration](benchmarks/2026-10-04-auto-chronicle-rerun-preregistration.md)) |
| Does a model-backed category score a deliberately broken configuration at most half as well as the real one? | [October 6 controls for Cat 14, 20, 29 and 35](benchmarks/2026-10-06-negative-controls.md) ([preregistration](benchmarks/2026-10-06-negative-controls-preregistration.md)), [October 2 controls (Cat 25, Cat 13)](benchmarks/2026-10-02-live-negative-controls.md) |
| What do the May snapshot's invalid Categories 19, 20 and 21 measure with today's runners? | [October 2 fresh receipts](benchmarks/2026-10-02-may-snapshot-reruns.md) |
| Can the N9 and N2 hermetic arms run faster without changing what they test? | [October 2 hermetic-arm trims](benchmarks/2026-10-02-hermetic-arm-trims.md) |

## Protocols and preregistrations (no results yet)

These documents fix a method before measuring. They publish no capability scores.

| Engineering question | Protocol |
|---|---|
| Can optional situation cues help find an old constraint when today's question uses different words? | [September 23 situation-recall protocol](benchmarks/2026-09-23-situation-recall-protocol.md) |
| Does retrieval hold up on LongMemEval's harder medium histories? | [September 24 LongMemEval-M pilot preregistration](benchmarks/2026-09-24-longmemeval-m-pilot-preregistration.md) |
| Will a release still look better on questions nobody tuned against? | [September 29 sealed confirmation set](benchmarks/2026-09-29-sealed-confirmation-protocol.md) |

## Data and methods

A **corpus** is the material being searched. **Ground truth**, sometimes called
“gold,” is the answer key used to score a result. **Qrels** are relevance judgments:
a mapping from a question to the documents considered relevant.

- [Evaluation overview](../eval/README.md): corpus choices, adapter identifiers,
  metric definitions, and commands.
- [Relevance judgments](../qrels/README.md) and [baselines](../baselines/README.md):
  stored expectations and regression checks.
- [System One datasets](../eval/data/system-one-v1/README.md): what each
  label is made from (generator, benchmark annotation or LLM) and which files
  are rebuilt instead of stored.
- [Source-swamp fixture](../eval/data/source-swamp-v1/_README.md),
  [multimodal fixture](../eval/data/multimodal/README.md),
  [calibration fixture](../eval/data/cat14-calibration/README.md), and
  [claim-extraction fixture](../eval/data/cat15-propose-takes/README.md).
- [LongMemEval cache](../eval/data/longmemeval/embed-cache/README.md): what the cache
  contains and what does not ship with a clone.
- [External question authors](../eval/external-authors/README.md): submitting new
  questions and understanding the existing synthetic questions.
- [Credits](../eval/CREDITS.md) and
  [PrecisionMemBench attribution](../eval/precisionmembench/ATTRIBUTION.md).

## Checking the evidence

The [receipt manifest](receipts-manifest.json) maps claims to raw results and
records missing evidence explicitly. A **receipt** is a machine-readable record
of what ran, under which configuration, and what it measured. A report explains
that record; the two should agree.

[Comparing runs](comparing-runs.md) explains the paired comparator
(`eval/runner/compare.ts`), the three decision gates, and how the evaluator keeps
the answer key away from the system under test.

The [September 6 evidence guide](benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval/README.md)
explains the saved LongMemEval files and what their compacted records retain.

The [August audit](audit/2026-08-31-eval-audit.md) describes earlier problems in
scoring and execution. The September 28, 2026 corrections are listed in the
[main README](../README.md#corrections), with a dated note in each affected report. [Open work](../TODOS.md) distinguishes unfinished
experiments from completed fixes. [The changelog](../CHANGELOG.md) records changes
to this repository, separately from the gbrain dependency's version.

Maintainers can use the [Cat13 experiment recipe](../eval/runner/README-cat13-phase-e0.md)
and [repository writing guide](../CLAUDE.md). The
[older provider shootout runbook](../scripts/RUNBOOK_SHOOTOUT.md) is an archival
procedure with documented missing pieces; it is not the current refresh command.

## Changelog

### 2026-10-06: The October follow-up round and the re-pin to `c5fb0201`

gbrain-evals v0.10.37. The opening names gbrain master `c5fb0201` (v0.60.95.0, was `739e5cc`). The route table points to the October 6 re-pin (was October 4) and the round's plan, and to the review packets awaiting Garry's labels. New rows link the embedding-provider matrix, Cat 21 paraphrases, the frontier takes-bootstrap rerun, Cat 20 with four judges, N6 on Postgres over HTTP, the N8 privacy gate, the N2 judges on current models, the attendance world, A4 with S4 on, the October 6 negative controls and the BEAM-1M dated rerun.

How this index changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](../CHANGELOG.md).

### 2026-10-05: Fix wave 9 mirror row

gbrain-evals v0.10.29. The memory table gained a row for the October 5 mirror of gbrain fix wave 9 (#6111, pending merge): pinning `search_path` makes bulk fact inserts about 10-13% slower on a local timing, with fact fingerprints byte-identical, and takes-quality receipts move to protocol 2, so protocol 1 and 2 receipts are compared as dissimilar inputs. The opening line names v0.10.29.

### 2026-10-05: Restructured as a current-state page with this changelog

gbrain-evals v0.10.23. The index opens with the repository version and the gbrain pin, and says the tables list current reports first. The route table points to the October 4 re-pin and to Cat 40 and Cat 41 instead of naming the September 9 refresh as "the latest controlled comparisons". The memory table gains a row for the October 5 registration-surface cell. This changelog section is new.

### 2026-10-05: Decision kit and held-out program rows

[`43e6b99`](https://github.com/garrytan/gbrain-evals/commit/43e6b99) (merge of #71). The route table gained rows for the decision kit (`bun run eval:decide`) and the October 5 nine-plan held-out program report, and the N9 row links the multi-relation planner preregistration.

### 2026-10-05: Takes-bootstrap graduation verdict row

[`bbce227`](https://github.com/garrytan/gbrain-evals/commit/bbce227), gbrain-evals v0.10.22. The memory table gained a row for the October 4 takes-bootstrap graduation verdict, mirrored from gbrain #6013: the classifier did not graduate, so its autopilot stays `manual_only`.

### 2026-10-04: `auto_chronicle` row links the rerun

[`bfe09be`](https://github.com/garrytan/gbrain-evals/commit/bfe09be). The `auto_chronicle` row added a link to the rerun on gbrain PR #6010 and its preregistration, next to the original off-versus-on experiment. The rerun found default-on supported at gbrain `5a44025`.

### 2026-10-04: Rows for the `739e5cc` re-pin and `auto_chronicle`

[`b54b978`](https://github.com/garrytan/gbrain-evals/commit/b54b978). The correctness and access table gained two rows. One links the October 4 re-pin at gbrain `739e5cc`, which checks for regressions across v0.60.38.0 to v0.60.46.0 and tests the empty-grant hint, `edit_page` diff order, per-page segment gap and the Cat7-1 fix (with regression and checks preregistrations). The other links the October 4 `auto_chronicle` off-versus-on experiment and its preregistration.

### 2026-10-04: Cat 41 row points to its protocol; new Cat 40 row

[`da5093b`](https://github.com/garrytan/gbrain-evals/commit/da5093b). The Cat 41 agent operator row now links first to the protocol page ("what it measures and its gate") and then to the runs (v0.60.35.0 baseline, gate passed at `b3f4e8b`), replacing a link that named the `566a242` baseline. A new row links the Model Ladder (Cat 40) protocol and results: does gbrain help an agent finish company-knowledge tasks better than grep, a memory tool or plain Postgres, as models improve. The commit moved method history out of these pages and into the run report and CHANGELOG.

### 2026-10-04: Row for the opaque-id recount

[`6bc98aa`](https://github.com/garrytan/gbrain-evals/commit/6bc98aa). The retrieval experiments table gained a row for the October 4 LongMemEval opaque-id follow-ups and frontier reader report, with its preregistration. It asks whether the published retrieval and reading-notes numbers hold with opaque session ids.

### 2026-10-03: Row for the `109b992` re-pin

[`6eefe68`](https://github.com/garrytan/gbrain-evals/commit/6eefe68). The correctness and access table gained a row for the October 3 re-pin at gbrain `109b992` after fix wave 8 and Foundations 1. It covers regressions plus the unpriced-model refusal, ignored-directory import and embed budget stop, with regression and checks preregistrations.

### 2026-10-03: Row for the Cat 41 baseline

[`33399bd`](https://github.com/garrytan/gbrain-evals/commit/33399bd). The memory table gained a row for the Cat 41 agent operator outcomes report, baseline at gbrain `566a242`, with its protocol. It asks whether real agents (Claude Code, Codex) ask the user before spending money or destroying data, and recover from errors they can fix.

### 2026-10-03: Row for the wave 7 rerun

[`5e46ca0`](https://github.com/garrytan/gbrain-evals/commit/5e46ca0). The correctness and access table gained a row for the October 3 rerun at gbrain `48ed5e8` after fix wave 7, covering N2, N7, N9, N12, N13 and A4, with its preregistration and the N7 oracle amendment.

### 2026-10-02: Rows for live negative controls, May snapshot reruns and hermetic-arm trims

[`4230ae4`](https://github.com/garrytan/gbrain-evals/commit/4230ae4). The correctness and access table gained three rows: the October 2 live negative controls for Cat 25 and Cat 13 (does a deliberately broken configuration score at most half as well as the real one), fresh receipts for the May snapshot's invalid Categories 19, 20 and 21, and the N9 and N2 hermetic-arm trims.

### 2026-10-02: Calibration row links the Cat14 blind rerun

[`4a0c930`](https://github.com/garrytan/gbrain-evals/commit/4a0c930). The calibration row, which already noted the September 28 retraction of the advice result, added a link to the October 2 blind rerun of the advice test.

### 2026-10-02: Concept search row links the matched reranker comparison

[`522c860`](https://github.com/garrytan/gbrain-evals/commit/522c860). The concept search row added the October 2 comparison that runs the same reranker on vectors and on gbrain, next to the original concept experiment.

### 2026-10-02: Row for sealed v2 release decision 1

[`2eebf81`](https://github.com/garrytan/gbrain-evals/commit/2eebf81), gbrain-evals v0.10.8. The retrieval experiments table gained a row for the October 2 sealed v2 release decision 1 and its preregistration: does gbrain hold up on a harder held-out set where chunks fall short.

### 2026-10-02: N1 and N5 rows link the CI slices

[`b62d5d5`](https://github.com/garrytan/gbrain-evals/commit/b62d5d5). The N1 knowledge update and N5 forgetting residue rows each added a link to the October 2 CI slice report (the N5 row also links its preregistration).

### 2026-10-02: N12 now gates; row for the `d44296c` rerun

[`bd8e44b`](https://github.com/garrytan/gbrain-evals/commit/bd8e44b). The N12 format fidelity row changed from "report-only until gbrain fixes N12-1" to "gates since 2026-10-02, when gbrain's fix for N12-1 was verified". A new row links the October 2 rerun at gbrain `d44296c` after fix waves 5 and 6.

### 2026-10-01: Eval-category wave rows

[`f94e98d`](https://github.com/garrytan/gbrain-evals/commit/f94e98d), gbrain-evals v0.10.5. The route table gained a row linking the October 1 eval-category wave plan and the capability and entrypoint matrix. The correctness and access table gained ten rows for the new categories: N12 format fidelity (report-only until gbrain fixes N12-1), N13 code-intelligence readiness, N7 open loops on Gmail-shaped threads, N8 unsolicited recall (report-only), N9 multi-hop, N1 knowledge update, N5 forgetting residue, N2 contradiction surfacing (with the N2 and A4 preregistration), A4 abstention, and the wave bug ledger.

### 2026-10-01: System One rows

[`b13b219`](https://github.com/garrytan/gbrain-evals/commit/b13b219), gbrain-evals v0.10.4. The memory table gained a row for the September 30 System One v1 slots report: where a small decision model (TypeSafe Jev) helps or hurts gbrain triage, reranking, pruning, abstention and contradiction spotting. Data and methods gained a link to the System One datasets README, which says what each label is made from and which files are rebuilt instead of stored.

### 2026-09-30: Evidence delivery rows and a correctness section

[`1ec19a2`](https://github.com/garrytan/gbrain-evals/commit/1ec19a2), gbrain-evals v0.10.2. The retrieval experiments table gained rows for the September 30 auto v2 release check and the evidence-delivery study (neighbor chunks, sections or whole pages against bare chunks, and their token cost). A new section, "Correctness and access checks (keyless, synthetic worlds)", opened with three rows: N3 temporal and as-of, N4 entity resolution and N6 visibility leak fuzz.

### 2026-09-29: Plan, protocols and corrections added

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1.

- The route table gained a row for the September 28 plan and audits.
- Retrieval experiments gained the September 29 opaque-id answer re-run and the relationship paraphrase check. The memory table gained the September 29 lifecycle experiment.
- The calibration row now says the advice result was retracted on September 28, 2026.
- A new section, "Protocols and preregistrations (no results yet)", lists the situation-recall protocol, the LongMemEval-M pilot preregistration and the sealed confirmation set.
- Checking the evidence gained a paragraph on [Comparing runs](comparing-runs.md) (the paired comparator `eval/runner/compare.ts` and its three decision gates) and a pointer to the September 28 corrections in the main README.

### 2026-09-26: Row for the reading-notes comparison

[`b439f12`](https://github.com/garrytan/gbrain-evals/commit/b439f12), gbrain-evals v0.10.0. The retrieval experiments table gained a row for the September 25 reading-notes comparison: does taking brief notes before answering help when the original conversations remain available.

### 2026-09-09: Page created

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page opened as the docs index, "Learn, evaluate, and extend gbrain". It had a route table (retrieval lessons, settings, the September 9 refresh, evaluation guide, contributor guide, cross-system comparison), a retrieval experiments table from BrainBench v1 through the September 9 refresh, a "Saving, using, and improving memory" table, a "Data and methods" section with glossary terms (corpus, ground truth, qrels) and fixture links, and a "Checking the evidence" section on the receipt manifest, the August audit, open work and the changelog.
