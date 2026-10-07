# Preregistration: open-source memory shootout, memory QA and PrecisionMemBench (2026-10-06)

**Status: Frozen on 2026-10-06**, before any counted cell was reserved. The three open values are filled:
`lme_s_limit` = 100 (the LongMemEval-S slice), `graphiti_beam_recipe` = false (Graphiti's `gpt-5.5` recipe does not run
on BEAM) and `gbrain_master_sha` = `c5fb0201d1960a0a5a81c35d77718311b03154b7` (`garrytan/gbrain` master at the freeze,
v0.60.95.0, resolved with `git ls-remote`). The campaign cap is $1,450 (Garry chose option B on 2026-10-06). Nothing below changes after the first counted cell runs; a later change gets a new
dated amendment at the end of this file, before any cell it affects.

Plan: [docs/plans/2026-10-05-oss-memory-shootout/PLAN.md](../plans/2026-10-05-oss-memory-shootout/PLAN.md) (approved
2026-10-05). This file is its Phase 3. It covers P1 (memory QA, Phase 4 cells and the D1 controls and D2 readers) and P3
(PrecisionMemBench, Phase 5). Update and forget (P2) and the Cat 40 agent tasks (P4) get their own preregistrations.

## The question

When an agent needs memory, an engineer can choose gbrain or an open-source memory system: Graphiti, Cognee, Mem0, Basic
Memory or Hindsight (Letta is in scope only as an agent, in P4, because it has no passive memory API at 0.34.4). For
the same conversations, the same reader and the same amount of evidence, which system returns evidence that lets the
reader answer correctly, how much of the right evidence does it return, and at what cost and latency? The report says
where gbrain loses as plainly as where it wins.

## What runs

### Systems, pinned

Each system runs whole in its own cell on an identical Ubicloud VM class, behind the shim protocol v1
([eval/systems/PROTOCOL.md](../../eval/systems/PROTOCOL.md), sha256 `4484c587…bab963`) and the shared shim base
(`eval/systems/_shim/shim.py`, sha256 `9ba9f737…7e1053`). Every provider call goes through the cell's metering proxy.
The capability record (`eval/systems/<name>/capability.json`) names every model role, the namespace and provenance
mechanism, the readiness signal and every deviation from the vendor's benchmark code; its hash is part of each run's
configuration hash.

| System | Pinned version | Capability record sha256 | Lock sha256 | Provenance | Time | Parallel namespaces |
|---|---|---|---|---|---|---|
| Basic Memory | `basic-memory==0.23.2` | `9bee4c555c01574ab93a9dfcebf9a3560b970286ed1bacf94e5ff661de62df90` | `e1a14a19…ab16807` | exact | in text | no |
| Mem0 (OSS) | `mem0ai[nlp]==2.2.1`, Qdrant 1.19.2 | `6f52b7a4ac246d554359c99b6ade6245b77cb7bcf1a3d305b4ea7d0f6c3f96c8` | `9777b7a8…25680` | partial | in text | yes |
| Graphiti (OSS) | `graphiti-core==0.30.2`, Neo4j 5.26.2 | `d972b84d6d7ea0e137d04e4954e4390d7d34d823c4830ac49b908236b470f5ab` | `4ce9b216…bddd1d13` | partial | native | yes |
| Hindsight | server and client 0.10.2, image `ghcr.io/vectorize-io/hindsight:0.10.2@sha256:d1840062…ab70` | `fe5b7c118722bbabd732c9ce7b0507b646ec6b48a84bcb409e8a564dc262b2f9` | `f54d89df…d6d8` | exact | native | yes |
| Cognee | `cognee==1.6.2` | `bccc141c3cdc6b95078743ae1c45c7179adaac1267fb60dee00475fadd70b8be` | `59af44d5…5a0d7` | partial | in text | no |
| Letta (P4 only) | Letta Code 0.34.4, image `letta/letta:0.34.4@sha256:8ee7fb69…a5c` | `f856cfe1e101df172998f4fc7f888afa328f1cbf5efdd7e0682c97dfac3845a5` | none | unavailable | none | no |
| gbrain, frozen master | `garrytan/gbrain` master at `c5fb0201` (v0.60.95.0), built as a `--gbrain` overlay (`git archive` of the commit, `bun install --frozen-lockfile`, tree verified) | in process | the commit's `bun.lock` | exact | native (shootout recipe) | no |
| gbrain, repository pin | `739e5cc` (v0.60.46.0), `package.json` | in process | `bun.lock` | exact | native (shootout recipe) | no |

Two configurations per system, named for what they control:

- **recipe**: the vendor's documented local or self-hosted install, as its capability record resolves it. Extraction
  and embedding models: Basic Memory local `bge-small-en-v1.5` (384 dims, no provider calls at ingest); Mem0
  `gpt-5-mini` with `text-embedding-3-small`; Graphiti `gpt-5.5` with `gpt-4.1-nano` as small model and reranker,
  `text-embedding-3-small` at 1,024; Hindsight `gpt-4o-mini` with a local `bge-small-en-v1.5` and a local cross-encoder;
  Cognee `gpt-5.6-luna` with `text-embedding-3-large` at 3,072; gbrain `gbrain init` defaults (`voyage:voyage-4` at
  1,024, balanced search with the Voyage `rerank-2.5` reranker).
- **common**: extraction `gpt-4.1-mini` and embedder `text-embedding-3-large` at 1,536 dimensions wherever the system
  lets them be set, and nothing else changed. gbrain's common row keeps its default search (the Voyage reranker stays).

The recipe configuration does not run on LongMemEval-S (cost); it runs on LoCoMo dev and BEAM-100K dev, and on BEAM for
Graphiti only when `graphiti_beam_recipe` is true.

gbrain runs as two named adapters (`eval/runner/systems/gbrain.ts`): **gbrain-shootout**, the counted recipe (native
chunk items from gbrain's own search defaults, limits `vendor-default` = the search mode's own 25 and
`fixed-evidence` = 40, frozen from a keyless LoCoMo check), and **gbrain-legacy**, the existing memory-qa path
(sessions rehydrated, one fixed retrieval) kept as the link to the starting line. Counted gbrain-shootout rows run at
two builds (amendment A2): gbrain master frozen at `gbrain_master_sha`, which the primary contrast uses because the
comparison is between each system's latest release, and the repository pin `739e5cc`, the secondary link to the
starting line and to the pilots. gbrain-legacy runs at the pin only. A keyless fixture check ran both adapters on the
frozen master as an overlay build (`GBRAIN_OVERLAY_SPEC=<checkout>@c5fb0201d1960a0a5a81c35d77718311b03154b7 bun test
test/eval/memory-qa-golden.test.ts`, at the freeze): both completed with every row scored, the overlay's tree matched
the commit, and the legacy path retrieved the same sessions as the pin's golden on every fixture question.

The D1 controls (`eval/runner/systems/baselines.ts`) run behind the same interface: **full-context** (the whole history,
most recent sessions kept first under a budget), **no-memory** (the question alone) and **plain-hybrid** (Postgres
full-text plus pgvector over `text-embedding-3-large`, reciprocal-rank fusion, no gbrain code).

### Cells and the manifest

The cells are in [2026-10-06-oss-memory-shootout/manifests/](2026-10-06-oss-memory-shootout/manifests/): one campaign
file with a $1,450 cap and one ledger, one cell file per system and configuration, and the arms files the cells run.
`bun eval/runner/shootout-cell.ts hash --campaign <campaign.json>` hashes the campaign file, every cell file and every
arms file a cell names.

- Campaign hash at freeze: **`14f684f8145c0ed48d7afed6d259709ff9937af577b98c3021b55e7807ca41f0`** (64 cells,
  leases $1,140).
- Campaign hash after amendment A3: **`c5901391c1516861d666ebdc93e3ca336a1733d354ac6af38d228236eb461ad3`** (64 cells,
  leases $1,140). The ten LoCoMo dev r1 cells that settled before A3 ran under the frozen hash; A3 does not change
  their commands.
- Campaign hash after amendment A4: **`bd60fb49c2f46a520b772b18fa84ca8a8cfb769526b3c33ff8c2604ef4662744`** (72 cells,
  leases $1,156.50). A4 adds the eight PrecisionMemBench cells and changes no Phase 4 cell.

A cell ingests each namespace once, retrieves once per question and policy, and derives every arm from that state
(`memory-qa --arms`). LoCoMo dev is ingested a second time per configuration (`--ingest-replicate 2`, retrieval only)
to measure run-to-run variance.

### Data and selection

| Set | Data | Questions | Clusters | Role |
|---|---|---|---|---|
| LongMemEval-S slice | `longmemeval_s_cleaned.json` at `98d7416c`, sha256 `d6f21ea9…c3a442` | `lme_s_limit`, category-stratified, `--seed 42` | one per question (each has its own haystack) | **inferential** |
| PrecisionMemBench | the vendored upstream fixture and scorer, byte for byte | 77 cases | one per case | **inferential** |
| LoCoMo dev | `locomo10.json` at `3eb6f2c`, dev split (3 conversations) | 587 | 3 | descriptive |
| BEAM-100K dev | BEAM at `b2da22e`, dev split (6 conversations) | 120 | 6 | descriptive |

The sealed splits are not opened here (Phase 7). Namespaces are opaque (`ns-` plus a hash) and so are source ids
(`src-` plus the occurrence id); no dataset id, label, category or abstention marker reaches a system (the sanitizer,
with a tripwire in the client and the proxy). Sessions arrive in event-time order. Undated sessions would get a
disclosed synthetic time one minute after the previous dated session, counted per run, but at this commit no session
needs one: BEAM dates a batch once, on its first message, and the loader gives every turn group its batch's time
anchor (`d263dd8`), so all 1,877 BEAM-100K sessions are dated, sessions in one batch share a time and keep dataset
order. The BEAM pilots ran under the earlier loader, when 1,795 of those 1,877 sessions carried synthetic times; their
BEAM temporal behavior is not comparable with Phase 4. A question with no date (LoCoMo, BEAM) is asked at its
conversation's last event time.

### Readers and judges

The judge is a fixed instrument per benchmark, and so is the main reader. The main readers are the runner's
preregistered readers, which the starting line and the published numbers use (amendment A1): `gpt-4o-2024-08-06` on
LongMemEval-S, `gpt-4o-mini` on LoCoMo, `gpt-4.1-mini` on BEAM. Judges: `gpt-4o-2024-08-06` with LongMemEval's official
per-type prompts on LongMemEval-S and LoCoMo (the temporal off-by-one prompt on LoCoMo temporal questions, the
unanswerable prompt on abstention questions); `gpt-4.1-mini` judging BEAM rubric items yes or no. One run per question,
temperature 0 where the model accepts it, 1,024 reader output tokens.

D2 frontier readers replay the main reader's frozen contexts, unchanged, on a 100-question slice of each benchmark
(`--seed 2026`): `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-sonnet-5-5` and
`anthropic:claude-fable-5-1` (CLAUDE.md, "Choose models"; `gpt-5.4-mini` never runs).

## The arms

An arm is retrieval policy × context mode × reader, from one ingest and one retrieval per policy:

- **Policies.** `vendor-default`: the system's own documented retrieval amount and settings, with no token budget.
  `fixed-evidence`: the record's larger candidate setting, packed to an 8,000-token budget. Each policy sends only its
  capability record's `settings` map.
- **Context modes.** `native`: the item text the system returned, in rank order, each with its validity window and a
  superseded mark when the system sets one. `rehydrated`: the raw sessions behind the items' source ids, selected in
  first-appearance order and shown in date order (the LongMemEval reading prompt, byte for byte the starting line's).
- **Readers.** The main reader on every question; the D2 frontier readers on their slice.

**Packing.** One reader-independent budget unit for every system and reader: 4 characters per token (`approx-chars-div-4`,
recorded in every row). Selection runs in rank order and takes items (or sessions) whole; the first that does not fit
ends the pack. The exact prompt bytes are frozen in the cell's `contexts.ndjson`, and every reader of that arm reads the
same bytes. The full-context control is ranked most recent first and shown oldest first, like a chat window.

## Outcomes, recall and provenance

**Canonical outcomes.** Each expected question has exactly one terminal outcome per arm, from a frozen manifest and an
append-only attempt log (`eval/runner/memory-qa/outcomes.ts`):

- `scored`;
- product failures, kept in the denominator: `retrieval_error`, `unsupported`, and `ingest_degraded` (a conversation
  with more than 1% failed sessions, a finish timeout, or a readiness probe that does not find the last session; its
  questions keep the scores they get);
- harness failures, which make a comparison incomplete and are never a product loss: `reader_error`, `judge_error`,
  `harness_invalid`, `budget_not_run`.

A failed question is retried on resume up to 3 attempts; the last attempt is terminal. A retrieval that fails while the
proxy saw the provider misbehave (a 5xx, a dropped connection, an unparseable 200) is retried once at once; the row
records the first failure and the provider status (`upstream_retry`, `provider.upstream`). A readiness probe that hits a
vendor error is retried once, then counts as a miss.

**QA scores.** *Service quality* (headline): mean judge score with product failures as 0, over questions with no
harness failure on any compared system. *Completed-call quality*: the same mean over `scored` rows only, reported beside
it. Before pairing, a question that has a harness failure on any system in a family is excluded from every system in
that family (`crossSystemExclusion`), and the count is reported.

**Strict recall.** `recall_all@5` and `recall_all@10`: every gold session among the distinct sources the items cite, in
first-appearance order across items in rank order, taken whole item by item until the next item's new sources would
pass K. One item citing every session cannot score 1.0; for one source per item this equals the starting line's
definition. Fan-out (mean and largest number of sources per item) is recorded per row. `recall_any@5` and nDCG@10 are
reported, never combined with `recall_all`. Abstention questions have no gold and no recall.

**Provenance.** A source id must be one the namespace ingested; any other id makes that retrieval a `retrieval_error`.
Items with `provenance_status: unavailable` cite nothing; a system whose items all lack provenance gets "recall not
measurable", never zero. `partial` provenance (Mem0, Graphiti, Cognee) counts for recall and is labeled beside every
number. Shims never query a vendor database privately to manufacture provenance. Recall is not reported for the
full-context and no-memory controls (returning everything is not a ranking).

## The comparisons

### Primary family (inferential, Holm, α = 0.05)

On the LongMemEval-S slice, arm `fixed-evidence.native.b8000.main` (8,000 tokens of native evidence, the main reader),
metric **QA service quality**, each system's common configuration against **gbrain-shootout common at frozen master**:

1. Basic Memory common vs gbrain-shootout common (master)
2. Mem0 common vs gbrain-shootout common (master)
3. Graphiti common vs gbrain-shootout common (master)
4. Hindsight common vs gbrain-shootout common (master)
5. Cognee common vs gbrain-shootout common (master)

Method: rows paired by question id after the exclusion join (`pairObservations`), `clusteredPairedDelta` with the
question as cluster, seed 20261006, 10,000 draws; the two-sided cluster sign-flip p-value (`p_two_sided`), Holm-adjusted
across the five (`holmAdjusted`). The delta is system minus gbrain with a cluster bootstrap 95% interval.

### Secondary families (each Holm-corrected within itself, α = 0.05)

- **S1, strict recall.** The same five pairs and arm on LongMemEval-S, metric `recall_all@5`, for systems whose
  provenance is measurable.
In the secondary families, "gbrain-shootout common" also means the frozen-master build.

- **S2, do I need a memory system at all (D1).** On LongMemEval-S, main reader, QA service quality, gbrain-shootout
  common in the rehydrated context against: full-context under `fixed-evidence` and under `vendor-default` (the whole
  history, where it fits), plain-hybrid under both policies, and no-memory (its one arm, no evidence). Five
  comparisons.
- **S3, PrecisionMemBench (P3).** The upstream contract (the shared evaluator supplies persona, pins and relation
  expansion for every system), cases as clusters: each system's common configuration against gbrain-shootout common
  on the search-only categories' precision and recall (ten comparisons); structural categories reported separately.

### Descriptive (no tests)

Every other arm and set: `vendor-default` and `rehydrated` arms, recipe configurations, LoCoMo dev and BEAM-100K dev
(3 and 6 clusters, too few for the repository's 10-cluster minimum), the second LoCoMo ingest (run-to-run agreement),
gbrain-shootout at the pin against gbrain-shootout at frozen master (what changed in gbrain between the pilots and the
counted run), gbrain-legacy against gbrain-shootout at the pin (a harness link to the starting line), and the D2
frontier readers. These are reported with cluster
counts and ranges, and paired intervals where the clusters allow.

### Minimum detectable differences

Two-sided paired test, 80% power, normal approximation, paired binary outcomes whose disagreement rate between the two
systems is d. The first Holm step uses α/5 = 0.01; the last uses 0.05.

| LongMemEval-S slice | α = 0.01, d = 0.2 / 0.3 / 0.4 | α = 0.05, d = 0.2 / 0.3 / 0.4 |
|---|---|---|
| 50 questions | 21.6 / 26.5 / 30.6 points | 17.7 / 21.7 / 25.1 points |
| 100 questions | 15.3 / 18.7 / 21.6 points | 12.5 / 15.3 / 17.7 points |
| 200 questions | 10.8 / 13.2 / 15.3 points | 8.9 / 10.9 / 12.5 points |
| 500 questions | 6.8 / 8.4 / 9.7 points | 5.6 / 6.9 / 7.9 points |

An exact McNemar test needs at least 8 discordant wins with no losses to reach 0.01, and 6 to reach 0.05. The report
prints each comparison's own detectable difference from its observed cluster-robust standard error (`powerNote`).

## What the report may say

The report uses these sentences and their plain variants, and no stronger claim.

**Primary family**, for each pair after Holm:

- Adjusted p ≤ 0.05, delta > 0: "On the LongMemEval-S slice, with the same reader and 8,000 tokens of each system's own
  evidence, {system} answered more questions correctly than gbrain ({a}% vs {b}%, difference {d} points, 95% interval
  {lo} to {hi})."
- Adjusted p ≤ 0.05, delta < 0: the same sentence with gbrain first.
- Adjusted p > 0.05: "On this slice we could not tell {system} and gbrain apart ({a}% vs {b}%); a difference smaller
  than about {mdd} points would not have been detected." Never "equivalent" or "as good as".
- Both systems at or above 95%: "Both answered nearly every question on this slice; it cannot separate them."
- More than 5% of the slice excluded for harness failures, or any cell of the pair `invalid`: "The comparison is
  incomplete" with the count and cause, and no direction.

**Descriptive sets**: "On LoCoMo dev (three conversations), {system} scored {a}% and gbrain {b}%. Three conversations
describe these systems on these conversations; they cannot rank them." The same for BEAM-100K dev with six.

**Recall**: always named as "strict recall of all gold sessions at 5 (or 10)", with the provenance status beside it;
"not measurable" when provenance is unavailable.

**Costs and latency**: ingest dollars and minutes per conversation or haystack, query dollars per question and reader
tokens come from the metering proxy and the rows; p50 and p95 latency is the shim's own `service_ms` on identical VM
classes. Costs are reported as measured, never as free; cached reader calls are counted separately.

**Overall**: a workload-by-workload finding, not a leaderboard. "Best" or "beats the field" appears only if every
primary comparison favors one system after Holm.

## Known pilot findings, reported as findings

The Phase 2 pilots (`eval/systems/<name>/PILOT.md` on the vendor lane branches) found three product behaviors that the
report states as results, and that this run does not tune away:

1. **Mem0, out of the box.** Mem0 2.2.1 treats only the exact model name `gpt-5` as a reasoning model, so with its own
   default `gpt-5-mini` it sends `temperature=0.1`, and OpenAI rejects every extraction call with HTTP 400: the default
   OSS install stores no memories against the current OpenAI API. The recipe arm sets `is_reasoning_model=True`, Mem0's
   documented override, and says so; the report states both facts.
2. **Graphiti, delete residue.** `remove_episode` deletes an edge only when the removed episode first created it, so text
   from a deleted session can survive in an entity summary or in a fact first stored from another session (31 of 32
   protocol checks pass; the miss is "deleted fact no longer in text"). P2 measures the residue; the shim does not repair
   it.
3. **Basic Memory, common embedder.** Basic Memory's default `semantic_min_similarity` of 0.55 was set for its local
   embedder. With `text-embedding-3-large` the scores run lower, so the common configuration returns fewer notes (8.5 of
   10 on average on the LoCoMo pilot, 9.2 on BEAM), and one probe query returned nothing. The floor stays at its
   default in both configurations.

## Budget and stop rules

- **Cap.** $1,450 for P1 and P3 together (raised from $1,200 when Garry chose option B on 2026-10-06), held in the campaign ledger
  (`.budget/oss-memory-shootout.sqlite`) as
  durable leases: each cell reserves its lease before its VM starts, the VM's metering proxy can spend only that lease,
  and the lease settles to the proxy's recorded spend. A lease is used once; a cell whose VM never reports back keeps
  its full lease until abandoned. Leases are 1.5 times the pilot measurement (the gbrain, D1 and D2 lines are estimates).
  Pilot-based totals: Graphiti about $343 (LongMemEval-S ingest $154; the BEAM recipe about $91 if run), Cognee about $94,
  Mem0 $91, Hindsight $73, Basic Memory $43; Graphiti's BEAM recipe (about $91) does not run. The 64 frozen cells'
  estimates sum to about $740 and their leases to $1,140. Leases are reserved one cell at a time and settle when the
  cell ends; a reservation that would pass the cap is refused rather than run.
- **Phase 4 stops.** If the settled total for Phase 4 heads past $1,000, or any system's measured spend passes 1.5 times
  its pilot estimate, the run stops and is reported before more cells start.
- **Phase stop.** If any phase's measured spend passes its estimate by more than 50%, the phase stops for approval.
- **Harness failures.** A cell that fails for harness reasons is fixed and rerun under a new lease; the failed attempt
  stays in the record.
- **Cell stops.** A cell that ends `invalid` (a sanitizer or proxy tripwire, foreign ids in the manifest) stops that
  system's remaining cells until the cause is found and recorded. A lease that runs out leaves its cell `partial`; the
  rest of the cell runs only on a new lease, and the partial rows stay in the record.
- **Never rerun to improve a number.** Finished cells are not rerun; a retry happens only under the outcome rules above,
  and every attempt stays in the attempt log.

## Amendments

**A1 (2026-10-06), main reader.** The plan's decision D2-A named GPT-4o "as the one historical link on everything".
The main reader per benchmark stays the runner's preregistered reader instead: `gpt-4o-2024-08-06` on LongMemEval-S,
`gpt-4o-mini` on LoCoMo, `gpt-4.1-mini` on BEAM. These are the readers of the starting line and of the published
numbers, so they are the link to earlier results; GPT-4o remains the reader on LongMemEval-S, where the inferential
comparisons run. The four frontier readers are unchanged, with `gpt-6.1-sol` as the newest GPT model. Recorded on
2026-10-06 at the campaign owner's decision.

**A2 (2026-10-06), gbrain identity.** As the approved plan says, counted gbrain-shootout rows run at both the repository
pin `739e5cc` and gbrain master frozen at one SHA by the freezing commit (`gbrain_master_sha`, resolved from
`garrytan/gbrain` `origin/master`). The comparison is between each system's latest release, so the primary contrast
uses frozen master; the pin rows are the secondary link to the starting line and the pilots. Every gbrain number is
labeled with its commit. Recorded on 2026-10-06 at the campaign owner's decision; an earlier draft of this amendment
ran the pin only and was replaced before freezing.

**A3 (2026-10-06), finish wait.** Every Mem0 cell and every vendor LongMemEval-S cell passes `--finish-timeout-s
14400` to the runner, so the runner waits up to four hours for a system's `/finish` instead of the 600-second default.
The reason: `mem0-common-locomo-r1` attempt 1 (lease `a1-757e7284`) timed out on all three conversations' `/finish`
while Mem0's ingest queue drained, so all 587 rows were recorded `ingest_degraded`. The pilot's recipe drain took 185
minutes, and LongMemEval-S haystacks are the longest ingests in the campaign. The flag caps waiting only: it changes no
measurement, scoring, arm, lease or budget. Attempt 1 stays in the record as a harness failure, and the rerun is
attempt 2 under a new lease. Recorded on 2026-10-06, after ten cells had settled and before any other cell was
reserved; the campaign hash changes (see "Cells and the manifest").

**A4 (2026-10-06), PrecisionMemBench cells.** The campaign gains eight Phase 5 cells in `cells/pmb.json`: Basic Memory,
Mem0, Hindsight, Graphiti and Cognee at common, Graphiti at recipe (the plan's risk table allows its recipe on
PrecisionMemBench), and gbrain-shootout common at the pin and at frozen master. They run
`eval/runner/precisionmembench-system.ts`, which sends only `searchText` through the system; the vendored scorer
supplies persona, pins, open questions and relation expansion for every system. The S3 rules (namespaces per user and
scope, disclosed synthetic event times in fixture order, the `vendor-default` policy cut at upstream's limit, items
without provenance not counted against precision with each system's share reported, the scorer's own structural split
of 34 structural and 43 search-only cases, and the pairing with Holm in which a system with no measurable provenance
leaves the family) were accepted by Garry on 2026-10-06 and are stated under S3. Leases sum to $16.50, about $9.27
estimated, $7.42 of it Graphiti's recipe. Recorded before any Phase 5 lease.

## Changelog

### 2026-10-06: gbrain master moved

gbrain master moved to 9cc7c4677 (v0.60.99.0) during Phase 4; keyless retrieval identical on the fixture and one LoCoMo dev conversation; counted rows stay at c5fb0201.

### 2026-10-06: amendment A4

Added A4 (the eight PrecisionMemBench cells) and recorded the new campaign hash.

### 2026-10-06: amendment A3

Added A3 (`--finish-timeout-s 14400` on every Mem0 cell and every vendor LongMemEval-S cell) after Mem0's LoCoMo r1
cell timed out at the 600-second default; recorded the new campaign hash.

### 2026-10-06: main merged

Merged main (gbrain-evals v0.10.35). Its BEAM loader dates every turn group with its batch's time anchor, so BEAM-100K
sessions are all dated and the synthetic fill no longer fires; the BEAM pilots ran under the earlier loader.

### 2026-10-06: frozen

Filled `lme_s_limit` = 100, `graphiti_beam_recipe` = false and `gbrain_master_sha` = `c5fb0201`; cap $1,200 to $1,450
(Garry's option B); capability-record hashes updated to the vendor lanes' final commits (policy knobs under
`settings`, Mem0's queued ingest, Cognee's null event time); overlay fixture check repeated at the frozen SHA; campaign
hash recorded; Phase 4 stop rules added.

### 2026-10-06: draft

First draft, from the approved plan, the pilots and the Phase 4 draft manifests. Open: `lme_s_limit`,
`graphiti_beam_recipe` and `gbrain_master_sha`. Amendment A2 now runs gbrain-shootout at frozen master (primary) and at
the pin (secondary), with the master cells added to the manifests.
