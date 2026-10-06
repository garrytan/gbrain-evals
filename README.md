# gbrain-evals

[gbrain](https://github.com/garrytan/gbrain) is a memory system for AI agents. gbrain-evals is its public test
suite: the data, the comparison systems, the scoring code and every published result. Use it to see what gbrain
does well, check any claim against its saved records, or run the same tests on another system.

This page has three parts: [what gbrain does](#what-gbrain-does), [its current results](#current-results) and
[how it compares with other memory systems](#how-gbrain-compares). Everything above [Changelog](#changelog)
describes gbrain as this repository pins it today; the changelog at the bottom records how this page changed.

## The gbrain under test

| Item | Value |
|---|---|
| Pinned product | gbrain master [`739e5cc`](https://github.com/garrytan/gbrain/tree/739e5cc89ca43b9b9351f0f203c7b12a7c0c571c) (v0.60.46.0), declared as `gbrain` in `package.json` |
| Newer gbrain builds also measured | v0.60.49.0 (`b9ee931`), v0.60.60.0 (multi-relation planner) and v0.60.62.0 (`51f865d78`, entity recall). Results from them say so. |
| Fixed-purpose aliases | `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`), used only by the experiments that name them |
| This repository | gbrain-evals v0.10.29 (`VERSION`) |

This repository installs gbrain master `739e5cc`. Some results below were measured at earlier commits; each names
its commit. The search modes have been identical since v0.48.4.0, so retrieval results from those commits describe
the installed modes.

## What gbrain does

gbrain keeps your notes, conversations and documents as Markdown files you own, and builds a database index over
them (Postgres or embedded PGLite). An agent such as Claude Code or Codex uses it through a CLI or an MCP server to
save, find, update and forget what it knows. The parts that matter for an agent:

- **Hybrid retrieval.** Every search combines word matching (for exact names and phrases), meaning-based vector
  search (for vague recollections and synonyms) and an optional reranker that rereads the candidates against the
  question. [How the pieces work together](docs/retrieval-lessons.md).
- **Relationships as evidence.** gbrain stores typed links between pages ("works at", "invested in", "attended") and
  follows them for questions like "who invested in Acme?", where the answer page may never mention the question's
  words.
- **Whole conversations for the reader.** Search ranks short passages, then hands the agent the whole conversation
  behind each hit, within a token budget, so a question that needs two old chats gets both.
- **Memory that stays correct.** An updated value replaces the old one everywhere and keeps it as history; `forget`
  removes a claim from every recall surface; private pages stay out of what agent callers can read.
- **Built to be run by an agent.** Every error and notice tells the agent what to do next and whether it must ask
  the user first, so agents do not spend money or repair data without consent.
- **A write path you can measure.** Agent sessions become readable memory pages, and timeline events are extracted
  from meetings and chats.

## Current results

| What we measure | Result | gbrain | Report |
|---|---|---|---|
| Finding every conversation a question needs (LongMemEval, strict `recall_all@5`) | **451 of 470 (95.96%)** | `109b992` | [Recount](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md) |
| Answer accuracy on LongMemEval, house reader with reranker | **453 of 500 (90.6%)** | v0.59.13.0 | [Re-run](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md) |
| Answer accuracy with a frontier reader (`gpt-5.4`) on gbrain's retrieval | **447 of 500 (89.4%)** | v0.59.13.0 retrieval | [Frontier reader](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md#2-a-frontier-reader-on-gbrains-retrieval) |
| Whole-conversation delivery against bare chunks, sealed held-out set | **192 vs 132 of 200** (+60/−0) | `d44296c` | [Sealed decision](docs/benchmarks/2026-10-02-sealed-v2-decision-1.md) |
| Concept questions in different words, target ranked first (with reranker) | **130 of 181** | `d44296c` | [Matched comparison](docs/benchmarks/2026-10-02-concept-vector-rerank.md) |
| Relationship retrieval on reworded one-hop questions, recall at five | **0.411 → 0.537**, 19 better, 0 worse | `3a284ae` | [N9](docs/benchmarks/2026-10-01-n9-multi-hop.md) |
| Questions chaining two or three relations (multi-relation planner) | **24 better, 0 worse** held-out; +27 points strict all-hit@10 | v0.60.60.0 | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md) |
| Returning only the right facts (PrecisionMemBench, tight adaptive + reranker) | **0.586 precision**, 0.825 recall | `2efaaf8f` | [Refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md) |
| Serving the new value after an update | **388 of 388** probes, never stale | `739e5cc` | [N1](docs/benchmarks/2026-10-01-n1-knowledge-update.md) |
| Nothing left behind after `forget` | **0** prohibited outputs, 6 of 6 reinstatements | `739e5cc` | [N5](docs/benchmarks/2026-10-01-n5-forget-residue.md) |
| Private pages reaching agent callers or remote callers | **0** (N6, N8) | `739e5cc` | [N6](docs/benchmarks/2026-09-30-n6-visibility-fuzz.md), [N8](docs/benchmarks/2026-10-01-n8-proactive-recall.md) |
| Keeping speaker and time across chat export formats | **27 of 27** formats | `739e5cc` | [N12](docs/benchmarks/2026-10-01-n12-format-fidelity.md) |
| Finding contradicting notes | **149 of 150** conflicts | `739e5cc` | [N2](docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md) |
| Real agents (Claude Code, Codex) spending or destroying data without consent | **0** violations in 66 safety sessions; 96 of 102 tasks finished | v0.60.46.0 | [Cat 41](docs/benchmarks/2026-10-03-agent-operator.md) |
| Company-knowledge tasks on five frontier models | **95.6%** success; **0 of 100** finance-only leaks into context | `51f865d78` | [Cat 40](docs/benchmarks/2026-10-02-model-ladder.md) |
| Timeline events extracted from meetings and chats | **37 and 38 of 38**, 0.04 wrong per page | `b9ee931` | [`auto_chronicle`](docs/benchmarks/2026-10-04-auto-chronicle-rerun.md) |
| Managed Postgres catch-up 57 ms from the database (10,000-file backlog) | **152.8 pages/min** steady, about **1.2 h** for the backlog (was 3.4 pages/min, about 49 h) | v0.60.73.0 | [Catch-up](docs/benchmarks/2026-10-05-managed-sync-catchup.md) |
| Useful material kept when a session becomes a memory page | **88.1%** judged; 74.9% with quoted evidence | Cat 35 run | [Cat 35](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) |

All 28 reproductions in the [bug ledger](docs/benchmarks/2026-10-01-wave-bugs.md) pass at `739e5cc`, and moving to
that pin cost no category any accuracy ([re-pin report](docs/benchmarks/2026-10-04-operator-wave-repin.md)). The
correctness rows come from keyless checks on synthetic worlds with generated answer keys, rerun at every pin.

Settings that change these numbers are in [settings by workload](docs/settings.md). Two matter most: keep autocut off
for questions that need several conversations (451 against 384 of 470), and leave query expansion off, since it adds
a model call without a measured gain.

## How gbrain compares

Other systems publish different metrics on different protocols, so these comparisons use only numbers we can put on
the same footing, and say so where we cannot. This page describes the other systems by kind; their names, versions,
sources and every row we could not match are in [comparisons and their protocols](docs/comparison-systems.md).

**Finding all the evidence: gbrain leads every system we can score strictly.** A question counts only if every
required session is in the top five.

| System | Strict `recall_all@5` on LongMemEval | Source |
|---|---|---|
| **gbrain**, `balanced` with Voyage reranker | **95.96% (451/470)** | our run, opaque session ids |
| gbrain, same without the reranker | 92.34% (434/470) | our run, opaque session ids |
| A verbatim-session memory system, hybrid search + LLM rerank | 90.0% (423/470) | our strict recount of its saved rankings |
| A token-native retrieval system + embedding fusion | 87.45% (411/470) | self-reported, its own harness |
| The same verbatim-session system, raw vector search | 85.7% (403/470) | our strict recount of its saved rankings |

Many headline LongMemEval "R@5" scores of 95% to 100% count a question as found when any one required session
appears; on that looser metric gbrain finds at least one for 470 of 470. Limits: gbrain returns five chunks while
the verbatim-session system returns five whole sessions, the configuration was chosen on these 470 questions, and embedders and
chunking differ, so this compares pipelines, not components.

**Answer accuracy: close to the published systems that use the same reader.** With `gpt-5.4` as the reader,
gbrain's retrieval answers 89.4%; a temporal knowledge-graph service publishes 90.2% and a database-backed memory
system 84.97% with the same reader model. Judges,
prompts and retrieval budgets differ, so this is context, not a ranking. Published results across systems range from
81.6% to 96.1%.

**Returning only what matters: gbrain's tight mode is more precise than every memory product in the
PrecisionMemBench table except the benchmark author's own belief store.** Its mean precision is 0.586, against 0.22,
0.09 and 0.06 for three hosted memory products listed upstream; the author's belief store scores 1.00. Upstream rows may use different
denominators and machines.

**Concept search: level with a vector store, when both are reranked.** gbrain 130 of 181, vectors with the same
reranker 128.

**Agent tasks: as good as plain files at the frontier, safer with restricted data, ahead of the alternatives on
mid-tier models.** On five frontier models gbrain and plain Markdown files with `grep` both finish 95.6% of tasks,
at the ceiling (the oracle scores 97.6%). gbrain puts finance-only text into the agent's context in 0 of 100
permission runs; files do in 100, and plain Postgres in 97 (with 4 leaked answers). gbrain costs about twice as much
per task as files. On the earlier six-model set, gbrain finished 75.7% against 72.8% for files, and was clearly
ahead of plain Postgres (+9.7 points) and a model provider's built-in memory tool (+12.3).

## Known limits

- At the pin, a timeline read on a 1,000-page brain takes about 0.075 ms against 0.045 ms before the Foundations 1
  release (ledger entry Cat7-1, open).
- At the pin, `auto_chronicle` (on by default) writes planned follow-ups as events on their future dates; turn it
  off there, or use v0.60.49.0 or later.
- Open loops cover Gmail only, and a commitment fulfilled by reply does not close.
- There is no corpus-wide contradiction scanner; the judge compares notes that search returns together.
- Associative recall, which gbrain does not claim, scores 0 of 240.
- Several retrieval settings were chosen on the same LongMemEval questions they are scored on; held-out
  confirmation exists for evidence delivery, not yet for the retrieval configuration.

## Where to read next

| Question | Where to start |
|---|---|
| When do words, vectors or relationships find the right answer? | [Retrieval lessons](docs/retrieval-lessons.md) |
| Which configuration should I try? | [Settings by workload](docs/settings.md) |
| Every report, grouped by the question it answers | [Documentation index](docs/README.md) |
| How do retrieval scores differ from answer accuracy? | [What the scores mean](docs/retrieval-lessons.md#what-the-scores-mean) |
| How are new gbrain defaults decided? | [Held-out program](docs/benchmarks/2026-10-05-heldout-program.md), [decision kit](docs/decisions.md) |
| Can I reproduce a result or test my own system? | [Run the suite](eval/README.md), [contribute an adapter or a category](eval/CONTRIBUTING.md) |
| What is still unfinished? | [Open work](TODOS.md) |

## Try a small experiment

Install [Bun](https://bun.sh/) and clone this repository:

```sh
git clone https://github.com/garrytan/gbrain-evals.git
cd gbrain-evals
bun install --frozen-lockfile

# No provider calls: rank the committed documents by matching words.
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only

# Check the committed corpus and question files.
bun eval/runner/validate-data.ts
bun run eval:query:validate
```

To compare all four retrieval adapters, set `OPENAI_API_KEY` in your environment:

```sh
BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --queries all
```

The run writes a scorecard and individual rankings to `eval/reports/multi-adapter/receipt.json`, using the fictional
corpus already in the repository. Vector and hybrid adapters make paid embedding calls; this runner does not ship a
warm embedding cache.

The agent benchmarks run like this:

**Cat 40 Hard** asks the same agents harder questions about a larger, messier
company: sets and counts over 10 to 40 accounts, values that changed several
times with backdated corrections, customers with look-alike names, documents
that disagree by authority, and facts that must survive five conversations.
It is tuned on plain files until frontier models finish about half, then
measured on a held-out world at about 4,000 and about 50,000 documents.
[Operator guide](docs/benchmarks/cat40-hard/RUNBOOK.md),
[world and scoring contract](docs/benchmarks/cat40-hard/WORLD_SCHEMA.md).

```sh
# Cat 41: a candidate gbrain commit, its gate, and the Cat 40 instruction check
# (Docker, ANTHROPIC_API_KEY, OPENAI_API_KEY; about $80 for both)
eval/runner/cat41/after-pass.sh <gbrain checkout> <commit>

# Cat 40 v1 without spending: the scripted, hermetic arms
bun eval/runner/cat40-model-ladder.ts --scripted --arms fs,memory,oracle --out $(mktemp -d)

# Cat 40 Hard without spending: every family through the scripted arms, plus the freeze-rule table
scripts/cat40-hard.sh hello
```

For the full pinned configuration matrix, prerequisites, output paths and spending controls, follow the
[refresh report](docs/benchmarks/2026-09-09-retrieval-refresh.md). To evaluate your own application, choose
representative questions and their relevant documents before comparing systems; the
[contributor guide](eval/CONTRIBUTING.md) explains the question and adapter formats.

## Corrections

These published numbers are invalid or overstated. Each affected report keeps its original figures, labeled,
beside a dated correction (audit of September 28, 2026, plus later follow-ups):

- **LongMemEval answer accuracy 433/500 (86.6%) is invalid:** the answer model saw `answer_` session ids that mark
  the evidence. With the leak removed, the same configuration scores 432/500 (+15/−16 paired), so the leak made no
  measurable difference, but 433 stays invalid. Retrieval numbers recounted with opaque ids are confirmed.
  [Report](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md),
  [recount](docs/benchmarks/2026-10-04-longmemeval-opaque-followups.md).
- **The reading-notes gain 308/361 to 324/361** was measured with the same leak; with opaque ids it is 304/361 to
  320/361 (+25/−9). [Report](docs/benchmarks/2026-09-25-reading-notes.md).
- **Query expansion "hurts retrieval"** described the September 6 code (255/470); at current gbrain it scores
  436/470 against 434/470 without it, so that finding no longer describes gbrain.
- **The May calibration result (75% wins) is invalid:** the judge saw the expected behavior and knew which answer
  was which. [Report](docs/benchmarks/2026-05-18-brainbench-cat14-cat15-calibration.md).
- **The April relationship precision at five (39.2% to 44.7%)** used a lenient denominator; divided by five slots it
  is 29.9% to 35.4%. Its alias recall falls from 31.0% to 13.75%, and with attendance edges pointed the right way
  link type accuracy is 74.7% (109/146).
  [Report](docs/benchmarks/2026-04-18-brainbench-v1.md),
  [September 29 re-run](docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The April and May relationship tables' `gbrain` row (49.1% precision)** came from a regular-expression parser of
  the four question templates, now named `graph-oracle-parse`; it is not a product score.
  [Report](docs/benchmarks/2026-04-19-brainbench-multi-adapter.md).
- **Cat 35's 88.1%** is judge-only; evidence-verified retention is 74.9%.
  [Report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md).
- **The May snapshot's Category 18b to 29 rows** came from runners written before the August audit; Cat 29's +4.00
  synthesis lift also scored the same single-answer call twice.
  [Report](docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

## Inspect or extend the work

- `eval/data/` contains public fixtures and answer keys. The adapter boundary strips answer-key fields before passing
  content to the system being tested.
- `eval/runner/` contains runners and the shared scoring functions; `eval/registry.ts` lists every category with its
  gate rules.
- `eval/reports/` holds temporary output. Published records live beside their reports in `docs/benchmarks/`.
- `test/eval/` contains tests for the harness; `.github/workflows/ci.yml` runs the checks that do not need provider
  credentials.

External adapters and independently written questions are welcome. The
[August audit](docs/audit/2026-08-31-eval-audit.md) explains earlier scoring and harness errors. The
[receipt manifest](docs/receipts-manifest.json) maps published claims to saved records and records missing evidence
explicitly. [CHANGELOG.md](CHANGELOG.md) records each release of this repository.

Code is MIT licensed. Dataset and vendored benchmark attribution is recorded in [the credits](eval/CREDITS.md) and
[PrecisionMemBench attribution](eval/precisionmembench/ATTRIBUTION.md).

## Changelog

How this page changed, newest first. Measurement history lives in the dated reports and in
[CHANGELOG.md](CHANGELOG.md); this section records what this page said and why it changed.

### 2026-10-05: Managed Postgres catch-up speed added to current results

gbrain-evals v0.10.26. New row: a managed Postgres brain 57 ms from its database catches up at 152.8 pages per minute in steady state with gbrain v0.60.73.0 (a 10,000-file backlog in about 1.2 h), mirrored from gbrain's own bench in [the catch-up report](docs/benchmarks/2026-10-05-managed-sync-catchup.md). The page had no write-throughput row before.

### 2026-10-05: Other systems described by kind, not by name

The "How gbrain compares" section and the changelog entries below describe other memory systems by kind (a verbatim-session memory system, a token-native retrieval system, a temporal knowledge-graph service, hosted memory products, a model provider's memory tool) instead of naming them. Their names, versions and sources stay in [comparisons and their protocols](docs/comparison-systems.md), which this page links. No number changed.

### 2026-10-05: Rewritten as what gbrain does, current results and how it compares

gbrain-evals v0.10.23. The page now has three parts above the changelog, replacing a run of dated findings and "Update, October 2/3/4" blocks:

- **What gbrain does:** the capabilities in plain words (hybrid retrieval, relationships, whole-conversation delivery, correctness, the agent operator contract, the write path), with a table naming the gbrain under test (pin `739e5cc`, v0.60.46.0, its aliases and the newer builds also measured).
- **Current results:** one table of every headline number with its gbrain commit and report, including results the page had not carried: Cat 40 on five frontier models (95.6%, 0 of 100 finance leaks), the multi-relation planner's held-out pass (24 better, 0 worse) and PrecisionMemBench precision (0.586).
- **How gbrain compares:** strict LongMemEval retrieval against other systems' saved rankings (now led by the 451/470 opaque-id recount instead of the September 6 449/470), answer accuracy beside published systems with the same `gpt-5.4` reader, PrecisionMemBench against the upstream table, concept search against reranked vectors, and Cat 40 against files, Postgres and a built-in memory tool.
- **Known limits** replace the October 1 wins-and-losses lists: Cat7-1, `auto_chronicle` at the pin, Gmail-only open loops, no corpus-wide contradiction scanner, associative recall and the missing held-out check of the retrieval configuration.
- The narrative of each re-pin, fix wave and correction now lives in the entries below, the dated reports and Corrections.

### 2026-10-04: `auto_chronicle` verdict updated for the fix rerun

[`bfe09be`](https://github.com/garrytan/gbrain-evals/commit/bfe09be). The October 4 `auto_chronicle` paragraph now limits "default-on is contradicted" to `739e5cc` and adds a rerun at gbrain PR #6010 (`5a44025`, not yet merged), which drops events dated after their page. That rerun found 0 such events, 0.04 wrong events per page and recall of 37 and 38 of 38, so default-on is supported there. A link to the rerun report joins the two existing links.

### 2026-10-04: October 4 re-pin update and the `auto_chronicle` off-versus-on test

[`b54b978`](https://github.com/garrytan/gbrain-evals/commit/b54b978). A new "Update, October 4" block reports the offline tier at `109b992` against `739e5cc` (gbrain v0.60.46.0). No category's accuracy changes except A4's: keyless `query` grades 100 of 120 answerable questions `moderate` (was 40). All 28 ledger repros pass, refusals now name the exact command, and N6 moved to one session per probe after a once-per-session notice tripped three probes. The block also reports the first off-versus-on test of `auto_chronicle`: it found 35 and 37 of 38 labeled events and raised "who did I meet that day" from 60% to 100%, but it wrote planned follow-ups as events on future dates (0.96 wrong events per page against a 0.20 gate), so default-on was contradicted under the preregistered rule.

### 2026-10-04: Cat 41 result names the shipped release

[`94cf3ac`](https://github.com/garrytan/gbrain-evals/commit/94cf3ac). The Cat 41 paragraph now credits gbrain v0.60.46.0 (the operator wave, measured at candidate `b3f4e8b`) instead of "candidate release `b3f4e8b` (v0.60.38.0)". The numbers are unchanged.

### 2026-10-04: New section on agents operating gbrain (Cat 40 and Cat 41)

[`da5093b`](https://github.com/garrytan/gbrain-evals/commit/da5093b). A new "When an agent operates gbrain" section describes both categories as they stand. Cat 41 runs pinned Claude Code and Codex CLI sessions through 17 risky requests. The candidate passes its gate with 0 consent violations across 66 safety sessions, 0 false "no notes" answers and token overhead of at most +5.9%, and it finishes 96 of 102 sessions. Released v0.60.35.0, for comparison, has 25 violating steps in 12 safety sessions and finishes 78 of 102. Cat 40 (Model Ladder) swaps only the memory (files with `grep`, a model provider's memory tool, plain Postgres, gbrain's MCP server) across 50 company-knowledge tasks. The section adds run commands (about $80 for both), and the "What should you learn here?" table gains a row for each category.

### 2026-10-04: Re-pin to gbrain `739e5cc`

[`bf5fa53`](https://github.com/garrytan/gbrain-evals/commit/bf5fa53). The installed-pin sentence moves from `109b992` (v0.60.37.0) to `739e5cc` (v0.60.46.0), which carries the Cat 40 cost wave, `auto_chronicle` and the agent-first operator wave. `src/core/search/mode.ts` is byte-identical, so the search-mode claim stands. The October 4 recount sentence now calls `109b992` "the pin at the time".

### 2026-10-04: LongMemEval recounted with opaque session ids

[`6bc98aa`](https://github.com/garrytan/gbrain-evals/commit/6bc98aa). Every published retrieval arm was recounted at `109b992` with opaque session ids, so the `answer_` prefix never reaches gbrain. The page changes in several places:

- "Where gbrain stands" adds the recount (451/470, 95.96%, paired +2/−0 against 449/470). The strict `recall_all@5` table gains two rows: 451/470 with the reranker and 434/470 (92.34%) without.
- A frontier-reader result joins the answer-accuracy paragraph. `gpt-5.4` on the GPT-4o arm's official prompts answered 447/500 (89.4%), winning 33 and losing 16 against GPT-4o (p = 0.021).
- The reading-notes study, re-run with opaque ids, still favors notes: 304/361 to 320/361 (+25/−9, p = 0.009).
- The trimming claim adds the recount values (384/470 to 451/470). "Query rewrites hurt retrieval" is now dated to September 6, because the recount shows 436/470 against 434/470, so expansion stays off only for its extra model call.
- The Corrections entry replaces "pending a re-run" with these outcomes.

### 2026-10-03: Wave 8 and Foundations 1 re-pin update

[`6eefe68`](https://github.com/garrytan/gbrain-evals/commit/6eefe68). A new "Update, October 3" block for gbrain `109b992` says fix wave 8 and Foundations 1 change no category's accuracy: 30 of 30 categories reach the same verdicts and all 27 ledger repros pass. It lists what the nine new checks show: unpriced models refused under a user cap, `gbrain import` of an ignored folder (3 of 3, was 0) and typed edges at 128 right and 43 wrong (was 125 and 52). It also reports one regression, a timeline read going from 0.05 ms to 0.10 ms on 1,000 pages.

### 2026-10-03: Re-pin to gbrain `109b992`

[`f321afb`](https://github.com/garrytan/gbrain-evals/commit/f321afb). The installed-pin sentence moves from `48ed5e8` (v0.60.32.0) to `109b992` (v0.60.37.0, fix wave 8 plus Foundations 1). The System One sentence is reworded from "That release adds" to "Its System One decision slots stay off".

### 2026-10-03: Fix wave 7 rerun update

[`5e46ca0`](https://github.com/garrytan/gbrain-evals/commit/5e46ca0). A new "Update, October 3" block reports gbrain `48ed5e8` closing eight more ledger gaps. The N2 contradiction judge (prompt v4) found 149 of 150 conflicts (was 132), but it called 6 of 51 compatible pairs contradictions, above the 10% limit, so the page drops the word "separates". The block also covers N7 open loops, N9 one-hop seeds (unresolved fell from 45 to 6 of 435), N12 `Participants:` lines (5 of 5, was 0) and A4 grades (all 120 unanswerable now `weak`).

### 2026-10-02: Re-pin to gbrain `48ed5e8`

[`c8350c5`](https://github.com/garrytan/gbrain-evals/commit/c8350c5). The installed-pin sentence moves from `d44296c` (v0.60.30.0) to `48ed5e8` (v0.60.32.0, fix wave 7). Mode bundles are unchanged.

### 2026-10-02: Concept-search claim rewritten around a matched reranked comparison

[`522c860`](https://github.com/garrytan/gbrain-evals/commit/522c860). The concept-search paragraph had said vector search with a reranker was untested. It now reports that run at gbrain `d44296c`: vector search with the same Voyage reranker scored 128/181 against gbrain's 130/181, with 8 wins and 10 losses for gbrain, so the two are level. The unreranked gbrain cell moves from 102 to 99 of 181, and the reranker's gain is now +40/−9 (was +37/−9). The advice changes to "rerank both" when comparing with a vector store. The September 9 cells (102, 118, 130) stay linked as older-pin history.

### 2026-10-02: Sealed v2 release decision for `auto` evidence delivery

[`2eebf81`](https://github.com/garrytan/gbrain-evals/commit/2eebf81), gbrain-evals v0.10.8. The evidence-delivery paragraph adds the first preregistered decision on the harder sealed v2 set (200 questions, histories of about 143,000 tokens). At gbrain `d44296c`, `auto` with a 24,000-token budget answered 192 of 200 against 132 for chunks (+60/−0, 95% interval +24 to +36 points), so the check passed. The cost is about four times the reader input.

### 2026-10-02: All 20 October 1 bugs verified fixed

[`bd8e44b`](https://github.com/garrytan/gbrain-evals/commit/bd8e44b). A new "Update, October 2" block reports the rerun at gbrain `d44296c` with the same runners and seeds. N1 current-value accuracy went from 288/388 to 388/388, N5 prohibited outputs from 2 to 0, N8 private-page leaks to 0, and N12 now gates CI. The N2 judge found 132 of 150 conflicts, and false contradictions fell from 109 to 26. N9 multi-hop planning is still open, and A4 was not rerun.

### 2026-10-02: Re-pin to gbrain `d44296c`

[`adffe95`](https://github.com/garrytan/gbrain-evals/commit/adffe95). The installed-pin sentence moves from `3a284ae` (v0.60.26.0) to `d44296c` (v0.60.30.0), which contains fix waves 5 and 6. Mode bundles are unchanged.

### 2026-10-01: October 1 category wave results

[`f94e98d`](https://github.com/garrytan/gbrain-evals/commit/f94e98d), gbrain-evals v0.10.5. A new block summarizes eleven keyless or cheap categories run at gbrain `3a284ae`. It lists where gbrain held up (N4, N6, N7 at 45/45, N12, N1, N5) and where it failed: `volunteer_context` leaked 4 private pages (N8), `ontology_propose` refusals cost 100 of 388 probes (N1), the contradiction judge found 105 of 150 (N2), and there was no multi-relation plan (N9). Of 20 bugs, 8 were in fix wave 5 and 10 were scheduled for wave 6. The installed pin moves from `6c8373c` (v0.60.13.0) to `3a284ae` (v0.60.26.0), with a note that its System One slots stay off without a TypeSafe key.

### 2026-10-01: New section on System One (Jev)

[`b13b219`](https://github.com/garrytan/gbrain-evals/commit/b13b219), gbrain-evals v0.10.4. A new "Where a small decision model helps" section reports matched pairs for nine Jev (`jev-1.13.0`) decision slots. Jev helped dream triage (0 of 18 buried items missed, against 10, but 57 of 109 transcripts sent to the page writer instead of 21) and contradiction proposals (94 of 97 updated facts, against none). Reranking, evidence trimming and abstention regressed, so `gbrain decide enable --recommended` turns on two slots only. The "What should you learn here?" table gains a System One row.

### 2026-09-30: Evidence delivery and reranker-on answer accuracy

[`1ec19a2`](https://github.com/garrytan/gbrain-evals/commit/1ec19a2), gbrain-evals v0.10.2. The answer-accuracy paragraph adds two reranker-on results: the notes reader at 453/500 (90.6%, +31/−17, p = 0.059), and the published configuration without the leak at 432/500 against the invalid 433/500 (+15/−16). A new evidence-delivery block reports that whole pages answered 361 of 400 held-out questions against 253 for chunks (p = 6e-27). Neighbor chunks closed only 30% to 36% of the gap, short of the preregistered 60%. The block also reports that the `auto` v2 release check failed on the sealed set (149 against 147 of 150). The Corrections entry and pin follow suit: `608a174` becomes "the previous pin" and the installed pin moves to `6c8373c` (v0.60.13.0).

### 2026-09-29: "Where gbrain stands" comparison and a Corrections section

[`88d0b19`](https://github.com/garrytan/gbrain-evals/commit/88d0b19), gbrain-evals v0.10.1. This release reworked the page after the September 28 audit:

- A new "Where gbrain stands" section adds a strict `recall_all@5` table. gbrain shows 449/470 with the reranker and 439/470 without. Other systems, from our strict recounts of saved rankings, show 423/470, 376/424 and 403/470, and one self-reports 411/470. Limits and an answer-accuracy paragraph follow; the paragraph gives the leak-free 439/500 (87.8%) and says we claim no answer ranking.
- The 433/500 claim is marked invalid because the answer model saw `answer_` session ids. A new paragraph shows full sessions beat chunks (89/100 against 65/100).
- The concept claim now states that gbrain without a reranker (102/181) trails vector search (118/181). The relationship claim widens to 145 questions (first-place hits 14% to 24%) and adds the paraphrase check: 0.411 in both arms at `b80cad6`, and 33 of 145 triggered at `608a174`.
- The write-side paragraph adds evidence-verified retention (58.2% to 74.9%) and an in-sample caveat. A new Corrections section lists the invalid or overstated numbers, including the 49.1% `graph-oracle-parse` row and the May calibration result.
- The pin text now separates the measured pin `2efaaf8f` (v0.48.4.0) from the installed `608a174` (v0.60.10.0), and a lifecycle row joins the table.

### 2026-09-26: Reading-notes study added

[`b439f12`](https://github.com/garrytan/gbrain-evals/commit/b439f12), gbrain-evals v0.10.0. A new shortlist paragraph reports the September 24 matched reading study: brief notes before answering raised judged correct answers from 308/361 to 324/361 on fixed retrieved sessions. It is labeled as answer reading, not a retrieval gain. The pinned gbrain link moves from `2efaaf8f` to `939232f1`.

### 2026-09-09: Rewritten as a guide to retrieval evidence

[`9238ec8`](https://github.com/garrytan/gbrain-evals/commit/9238ec8), gbrain-evals v0.8.0. The page was rewritten from scratch, removing 258 lines. Gone are the "beats the field" head-to-head table, the "three things nobody else does" list, the PrecisionMemBench section, the area table, the corpus and layout sections and the per-benchmark run commands. The new page opens with the different kinds of retrieval problem and points to `docs/retrieval-lessons.md`, `docs/settings.md` and `docs/README.md`. A "Why put gbrain on your shortlist?" section makes five evidence-linked claims: 449/470 (95.53%) LongMemEval strict retrieval with 433/500 answers, 130/181 against 118/181 on concept questions, investor first-place hits from 9/39 to 21/39, trimming off raising retrieval from 379/470 to 449/470, and an inspectable pipeline pinned at gbrain `2efaaf8f`. The rest is a question-to-document table, a keyless `grep-only` quick experiment, a write-side summary (70.2% to 88.1% retention, 7.0% hallucination) and an "Inspect or extend" section.

### 2026-09-02: LongMemEval rows updated for the v0.48.2.0 re-run

[`4ceb7f9`](https://github.com/garrytan/gbrain-evals/commit/4ceb7f9), gbrain-evals v0.6.1. Both LongMemEval rows replace 83.4% with the September 2 re-run on the cleaned Sept-2025 revision: 93.19% `recall_all@5` reranker off (438/470) and 95.32% with `voyage:rerank-2.5` (448/470), plus per-type figures. The comparison cell now uses our strict recounts of another system's saved rankings (85.7% raw, 90.0% with LLM rerank) and a third system's self-reported 87.45%. The run commands switch to the cleaned dataset URL, `VOYAGE_API_KEY` and the five published arms. Several cells drop their "first run scored 61.5%" and audit narrative in favor of present-tense statements, and the "benchmarks that bite back" bullet now names the committed gates.

### 2026-09-01: Outside-review remediation and claim hygiene

[`29e9ac9`](https://github.com/garrytan/gbrain-evals/commit/29e9ac9), gbrain-evals v0.6.0. The LongMemEval head-to-head row now says these are retrieval-component numbers, not QA accuracy. It records another system's 96.6% as any-hit and adds a third system's self-reported 84.3% and 87.45% All@5, so it claims no `recall_all` lead. Cat 35 leakage changes from "zero" to 1.2% (1/86), and the Cat 34 rows gain links to committed receipts and the 0.552 codex seam. The PrecisionMemBench 0.582 becomes an upper bound (the best hosted product now 0.22 upstream), the default precision moves from 0.076 to 0.075, and the relational 97.9%/49.1% row is flagged as pre-audit.

### 2026-09-01: LongMemEval erratum resolved at 83.4%

[`91d2af8`](https://github.com/garrytan/gbrain-evals/commit/91d2af8), gbrain-evals v0.5.1. Both LongMemEval rows replace "re-measurement pending" with the official `recall_all@5` of 83.4% (n=470), recomputed at $0 from the May run's raw rows. The rows keep 97.6% any-hit as a diagnostic (488/500) and name multi-session (71.9%) and temporal (69.3%) as the source of the loss.

### 2026-08-31: Eval audit and the head-to-head section

[`bd5ba0d`](https://github.com/garrytan/gbrain-evals/commit/bd5ba0d), gbrain-evals v0.5.0 (per `CHANGELOG.md`; the commit subject says BrainBench v0.3.0). A new "Where gbrain beats the field" table compares five arenas (LongMemEval 97.6%, Cat 35 88.1%, Cat 34, PrecisionMemBench 0.582 against a hosted product's 0.43, relational 49.1% P@5). A "three things nobody else does" list cites the 35-agent audit (239 findings, 236 fixed). "Where gbrain lands today" is renamed "The numbers, report by report", and the LongMemEval row gains an any-hit erratum. The page now describes what CI actually runs and adds a keys note for `eval:run` (`OPENAI_API_KEY`, about $2 first run), `--top-k 5` in the commands and the exact-SHA pin in reproduce steps.

### 2026-08-31: Cat 35 republished at 88.1% and Cat 34 row added

[`d101b01`](https://github.com/garrytan/gbrain-evals/commit/d101b01), gbrain-evals v0.4.0. The Cat 35 row moves from 61.5% to 88.1% salient-unit recall with all 20 sessions emitting, after the gbrain v0.47.8.0 fix wave (hallucination halved to 7%, quote fidelity 45% to 83%). A new Cat 34 memory-conformance row reports 0 know-to-ask failures, push precision 1.0 and recall 0.91 across 149 gold turns.

### 2026-08-30: Cat 35 transcript distillation added

[`d5b94c7`](https://github.com/garrytan/gbrain-evals/commit/d5b94c7), gbrain-evals v0.3.0. The results table gains a Cat 35 row (61.5% salient-unit recall, 85% usable, 0% noise leakage, against a 93.1% judge ceiling). The corpora list adds the 24 fictional agent sessions (173 salient units, 86 distractors). The layout gains `generators/` and `scripts/`, and a note explains that Cat 35 deep-imports `gbrain/src` internals, which is why the dependency is pinned to an exact SHA.

### 2026-06-03: Plain-English rewrite and SkillOpt result

[`565b807`](https://github.com/garrytan/gbrain-evals/commit/565b807). The page was rewritten in plain English as "the test suite for gbrain". It gained a "How these benchmarks work" explainer (corpus, sealed answers, score; recall and precision) and a "Where gbrain lands today" table with a plain-English column. The table adds a SkillOpt row (4/4 skills 0 to 1.00). A "We report the bad numbers too" section frames the PrecisionMemBench 0.076 default. The Cat catalog becomes an area table, and the corpus, layout and contributing sections are simplified.

### 2026-05-30: Streamlined around LongMemEval and PrecisionMemBench added

[`8fa09ff`](https://github.com/garrytan/gbrain-evals/commit/8fa09ff), gbrain-evals v0.2.0. A "Headline result" quote puts LongMemEval 97.60% R@5 against another system's 96.6% at the top, and the results table adds PrecisionMemBench (#2, 0.582 precision with the opt-in gate). A new PrecisionMemBench section reports the 0.076 default, the 0.582 adaptive result and the narrow-probe caveat, with run commands. The page drops the Cat 2 catalog row, the paid `eval:brainbench` commands and the design-doc section, condenses the layout and contributing sections, and lists `VERSION` and `CHANGELOG.md`.

### 2026-05-24: v0.40.6.0 snapshot headline

[`9ecc5b2`](https://github.com/garrytan/gbrain-evals/commit/9ecc5b2). "Latest results" now leads with the gbrain v0.40.6.0 comprehensive snapshot and three headline claims: LongMemEval 97.60% R@5 against another system's 96.6%, BrainBench 49.1% P@5 (38 points over vector RAG), and zero retrieval regression across 20 releases. The table gains snapshot and Cat 14+15 calibration rows, and one comparator is removed from the comparison mentions.

### 2026-05-07: LongMemEval result and public-benchmark family

[`c2d26e6`](https://github.com/garrytan/gbrain-evals/commit/c2d26e6). The intro now covers two families, BrainBench and public benchmarks. A "Latest results" section leads with LongMemEval `_s` at 97.60% R@5 (+1.0 point over another system's raw retrieval) and a dated table of reports. The quickstart splits into LongMemEval (dataset download, keys, batch runner, about $2 first run) and BrainBench. A "Public benchmarks" table lists the LongMemEval splits, ConvoMem and LoCoMo, and the layout adds the LongMemEval runner files, the embed cache and `docs/comparison-systems.md`.

### 2026-04-23: Adapters renamed to plain English

[`8dab7f7`](https://github.com/garrytan/gbrain-evals/commit/8dab7f7). Adapter names in the intro, layout and subpath list change: `ripgrep-bm25` becomes `grep-only`, `vector-only` becomes `vector` and `hybrid-nograph` becomes `vector-grep-rrf-fusion`.

### 2026-04-21: Created with the BrainBench v1 extraction

[`5bd8848`](https://github.com/garrytan/gbrain-evals/commit/5bd8848). The first README presented BrainBench as a benchmark for personal knowledge agent stacks. It scored four adapters on a 240-page fictional corpus, with a headline of gbrain P@5 49.1% and R@5 97.9% (+31.4 points over its graph-disabled variant). It covered why the repo is separate from gbrain, a quickstart, the Cat 1 to 12 catalog with thresholds, the world-v1 and amara-life-v1 corpora, the repo layout, three contributor paths, methodology, the license and the `gbrain/*` subpath exports it consumes.
