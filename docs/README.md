# Learn, evaluate, and extend gbrain

Start with [the case for gbrain](../README.md), then follow the route that fits
what you are trying to do.

| Your question | Read this |
|---|---|
| How do words, vectors, and relationships work together? | [Retrieval lessons](retrieval-lessons.md) |
| Which setup should I evaluate for my application? | [Settings by workload](settings.md) |
| What do the latest controlled comparisons show? | [September 9 retrieval refresh](benchmarks/2026-09-09-retrieval-refresh.md) |
| How do I run the benchmarks? | [Evaluation guide](../eval/README.md), [troubleshooting](../eval/RUNBOOK.md) |
| How do I get a dev or held-out verdict for a gbrain change? | [Decision kit](decisions.md) (`bun run eval:decide`) |
| Where does gbrain master start, and which feature ideas won or lost their held-out tests? | [October 5 nine-plan held-out program: starting line, verdicts and scorecard](benchmarks/2026-10-05-heldout-program.md) |
| How can I contribute a competing system or new questions? | [Contributor guide](../eval/CONTRIBUTING.md) |
| Which outside scores are actually comparable? | [Cross-system comparison](comparison-systems.md) |
| What is the plan for improving gbrain and proving it? | [September 28 plan and audits](plans/2026-09-28-gbrain-10x/README.md) |
| What will the next categories measure, and what does gbrain implement for each of them? | [October 1 eval-category wave plan](plans/2026-10-01-eval-category-wave/README.md), [capability and entrypoint matrix](benchmarks/2026-10-01-capability-matrix.md) |

## Retrieval experiments

A report's date identifies an experiment, not necessarily the newest version of
its narrative. Start with the current reports, then follow the historical work
when you want to understand how a decision changed.

| Engineering question | Report |
|---|---|
| Does gbrain's automatic whole-conversation delivery hold up on the sealed held-out set? | [September 30 auto v2 release check](benchmarks/2026-09-30-evidence-auto-v2.md) |
| Does it hold up on a harder held-out set where chunks fall short? | [October 2 sealed v2 release decision 1](benchmarks/2026-10-02-sealed-v2-decision-1.md) ([preregistration](benchmarks/2026-10-02-sealed-v2-decision-1-preregistration.md)) |
| Should an agent get neighbor chunks, sections or whole pages instead of bare chunks, and at what token cost? | [September 30 evidence-delivery study](benchmarks/2026-09-30-evidence-delivery.md) |
| Do the published LongMemEval retrieval and reading-notes numbers hold with opaque session ids, and what does a frontier reader score on gbrain's retrieval? | [October 4 opaque-id follow-ups and frontier reader](benchmarks/2026-10-04-longmemeval-opaque-followups.md) ([preregistration](benchmarks/2026-10-04-longmemeval-opaque-followups-preregistration.md)) |
| With the answer key hidden, how accurate are gbrain's answers, and does the reader prompt or the amount of evidence matter more? | [September 29 opaque-id answer re-run](benchmarks/2026-09-29-longmemeval-opaque-qa.md) |
| Does taking brief notes before answering help when the original conversations remain available? | [September 25 reading-notes comparison](benchmarks/2026-09-25-reading-notes.md) |
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
| Did gbrain's takes-bootstrap classifier (facts, takes, bets and hunches from a person's pages) pass its graduation bar for running on autopilot? | [October 4 graduation verdict, mirrored from gbrain #6013](benchmarks/2026-10-04-takes-bootstrap-verdict.md) |
| Can a skill improve on held-out tasks, and can the judge detect cheating? | [Skill optimization](benchmarks/2026-06-03-skillopt.md) |
| Can the system distinguish kinds of claims and sensible confidence? | [Calibration and proposed takes](benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md) (the advice result was retracted on September 28, 2026), [October 2 blind rerun of the advice test](benchmarks/2026-10-02-cat14-rerun.md) |
| When gbrain fails, refuses or needs a decision, do real agents (Claude Code, Codex) ask the user before spending money or destroying data, and do they recover from the errors they can fix? | [Agent operator outcomes (Cat 41): what it measures and its gate](benchmarks/2026-10-03-agent-operator-protocol.md), [runs: v0.60.35.0 baseline, gate passed at `b3f4e8b`](benchmarks/2026-10-03-agent-operator.md) |
| Does gbrain help an agent finish company-knowledge tasks better than grep, a memory tool or plain Postgres, and does that hold as models improve? | [Model Ladder (Cat 40): what it measures](benchmarks/2026-10-02-model-ladder-protocol.md), [results](benchmarks/2026-10-02-model-ladder.md) |
| What happens when tweet ingestion becomes parallel? | [Tweet ingestion](benchmarks/2026-04-18-tweet-ingestion.md) |
| What did the earlier ingestion worker comparisons measure? | [Subagent comparison](benchmarks/2026-04-18-minions-vs-openclaw-subagents.md), [production comparison](benchmarks/2026-04-18-minions-vs-openclaw-production.md) |

## Correctness and access checks (keyless, synthetic worlds)

| Engineering question | Report |
|---|---|
| Does gbrain answer "where did she work on that date?" and "when did I last see him?" from valid time, not from when a note was written? | [September 30 temporal and as-of check (N3)](benchmarks/2026-09-30-n3-temporal-asof.md) |
| Does a nickname, handle or former name reach the right person without merging two people who share a name? | [September 30 entity-resolution check (N4)](benchmarks/2026-09-30-n4-entity-resolution.md) |
| Can an agent-facing caller read private pages, held Takes, private Facts or another source through any read operation? | [September 30 visibility leak fuzz (N6)](benchmarks/2026-09-30-n6-visibility-fuzz.md) |
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
| Does a model-backed category score a deliberately broken configuration at most half as well as the real one? | [October 2 live negative controls (Cat 25, Cat 13)](benchmarks/2026-10-02-live-negative-controls.md) |
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
