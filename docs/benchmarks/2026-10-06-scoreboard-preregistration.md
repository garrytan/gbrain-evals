# Preregistration: the head-to-head memory scoreboard (2026-10-06)

**Status: frozen on 2026-10-08** at gbrain-evals commit `274bf9f6fc5daca09f891a7fdcc82069c47a9c32` (after A12), before any counted
cell reserved a lease. The freeze checklist below fills every value that was open. Nothing below changes after the
first counted cell runs; a later change is a dated amendment at the end of this file, written before any cell it
affects, and a change to a bar or a family needs the program owner's approval first. The D8 reserve's hash-list SHA
(amendment A2) is recorded when it is relayed; Q1's cells do not use the reserve.

Owner: GBRA-49 (the competitor-ideas program). Plan approved by Garry on 2026-10-06, with every recommendation
accepted. This campaign replaces the sealed phase of the open-source comparison (gbrain-evals#73) and reuses its
harness code.

## The question

An engineer adding memory to an agent can use gbrain, another open-source memory system, paste the whole history
into the prompt, or give the agent the history as Markdown files and a grep tool. For the same conversations, the
same answer models and the same amount of evidence, which choice answers more questions correctly? How much of the
right evidence does each return? What does each cost to write and to read, how fast does it answer, and how soon
does a new memory become searchable? At what history size does a memory system start to beat pasting everything or
grepping files?

The report states where gbrain loses as plainly as where it wins.

## Systems

Every system is described by kind (`eval/systems/kinds.json`). Products, versions and sources are on
[comparisons and their protocols](../comparison-systems.md), and nowhere else.

| Public id | Kind | Role |
|---|---|---|
| `gbrain-defaults` | gbrain with its shipped defaults, installed and read the documented way | headline row |
| `gbrain-common-embedder` | the same with `text-embedding-3-large` at 1,536 dimensions | component diagnostic on BEAM-1M sealed only |
| `ext-extract-first` | an extract-first memory server (an LLM extracts and updates facts on every write) | every BEAM set, LoCoMo |
| `ext-memory-bank` | a memory-bank server with background extraction and reflection | every BEAM set, LoCoMo |
| `ext-graph-pipeline` | a knowledge-graph pipeline (an LLM builds a graph per document) | every BEAM set, LoCoMo |
| `ext-temporal-graph` | a temporal knowledge-graph library (bi-temporal edges, LLM extraction per episode) | every BEAM set, LoCoMo |
| `ext-markdown-kb` | a Markdown-file knowledge base (local embedder, no LLM on write) | every set |
| `ext-verbatim-session` | a verbatim-session memory system (whole sessions, vector search, LLM rerank off) | every set |
| `ext-agent-runtime` | a self-editing agent memory runtime | LoCoMo slice, agent cell |
| `baseline-full-context` | the whole history in the prompt | where it fits each reader's window |
| `baseline-recency` | the most recent sessions that fit the token budget | component control |
| `baseline-file-agent` | an agent with list, grep and read tools over the same Markdown files | whole-system baseline |
| `baseline-hybrid` | Postgres full text plus pgvector with reciprocal-rank fusion | control |
| `baseline-none` | the question alone | floor |

**`gbrain-defaults`.** One brain per conversation, from a frozen install recipe that matches the documented install
with provider keys: Bun 1.4.2, `bun install -g github:garrytan/gbrain#<frozen sha>`, `gbrain init --pglite`, scripted
defaults for every first-run question, and the MCP registration gbrain writes (the `starter` surface). It runs as a
sandboxed container with dummy keys; every provider call goes through the metering proxy. Sessions are written
through MCP `put_page` as conversation pages with their session date. Reads use only `starter` ops: `query` for the
component and default-amount rows (its default query expansion is one counted LLM call per question) and
`synthesize` for gbrain's own answer, recorded under the reader `own:<gbrain's resolved model>`. A labeled
full-surface row runs `think` with each reader as `model` and the question date as `reference_date`, in its own cell on
a stack started with `GBRAIN_FULL_SURFACE=1`, so every starter row reads a starter-only stack. No request carries `token_budget`. The resolved configuration (search mode,
reranker, expansion, embedder, internal models) is published beside its hash. Frozen gbrain commit: `f05943e653fd9d938b343b1774a35325ba792271`
(master on 2026-10-09, 0.60.138.0; A14), for the sealed and the public gbrain rows alike (A15). The public-v2 gbrain
cells ran at the earlier pin, `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802` (master on 2026-10-08, 0.60.106.0); their
rows are reported only in the found-and-fixed appendix.

**External configurations.** Each system runs its documented recipe as the headline row where the recipe's measured
ingest fits 48 hours per conversation and its block cap. Otherwise it runs the common configuration (extraction
`gpt-4.1-mini`, embedder `text-embedding-3-large` at 1,536 dimensions wherever settable) and the row says so. The
common configuration also runs for every system on LoCoMo and BEAM-100K sealed as a diagnostic. Where the
shootout's pilots already decided it: the extract-first server and the temporal graph library run common on BEAM and
their recipes on LoCoMo. A system's own answer endpoint, where it has one, joins the whole-system table as a
descriptive row.

## Data, exposure and custody

| Set | Data | Questions | Clusters | Exposure | Role |
|---|---|---|---|---|---|
| S1 BEAM-10M | HF `Mohammadta/BEAM-10M` at `9b209619` (CC BY-SA 4.0) | 199 (200 minus `1_abstention_0`) | 10 | never used to tune gbrain | **headline, inferential** |
| S2a BEAM-100K sealed | P0 split, 14 conversations | 140 (10 per conversation, stratified by ability, seed `q1-beam-100k`) | 14 | used to choose gbrain settings | public row |
| S2b BEAM-1M sealed | P0 split, 24 conversations | 240 (10 per conversation, stratified, seed `q1-beam-1m`) | 24 | used to choose gbrain settings | public row |
| S3 LoCoMo | all 10 conversations | 200, stratified by category with at least 40 adversarial (seed `q1-locomo`) | 10 | used to choose gbrain settings (7) or development data (3) | public row |
| S4 LongMemEval-S | cleaned, `98d7416c` | 500 for gbrain; the shootout's 100-question slice (seed 42) for other systems | per question | gbrain was developed on it | regression row |
| S5 LongMemEval-M | cleaned, `98d7416c` | 100, stratified by type plus abstention (seed `q1-lme-m-v1`) | per question | gbrain was developed on it | scale row |

- **BEAM-10M exposure record.** Before this campaign, another thread's tooling read BEAM-10M's question and document
  counts and token sizes. One exploration script printed the gold answer, rubric, unanswerable note and a public
  comparator outcome for question `1_abstention_0`, and aggregate statistics of the memory-bank server's public 10M
  result file into an agent context. That question is excluded from every confirmatory cohort and reported
  separately. No other question, rubric or chat text was read. The custodian records the audit in
  `exposure.json`.
- **BEAM 100K and 1M sealed.** These were held out from P0's implementers, but gbrain settings have since been chosen
  on them: P4's gates, and the proof wave, whose groups cover every BEAM 100K/500K/1M conversation and whose sealed
  run sets gbrain defaults. They are public rows, descriptive only.
- **BEAM-1M per-question rows.** Another held-out decision (Q2's junk audit) uses 21 BEAM-1M sealed conversations.
  Until that decision is recorded, every BEAM-1M sealed row, answer, judgment and context stays in custody. Only
  pooled aggregates come back: system-level means, intervals and cost and speed columns, with no per-conversation or
  per-question numbers. Per-question rows publish only after Q2's decision is in its record.
- **The newer open-source shootout (gbrain-evals#89).** On 2026-10-08 its sealed batch ran LoCoMo's 7 sealed
  conversations and the 14 BEAM-100K sealed conversations, with only aggregates returned. It did not touch BEAM-10M,
  BEAM-1M or LongMemEval-M. Both sets are already public, descriptive rows here (S2a, S3), so no claim changes (A7).
- **LongMemEval.** It has no sealed split, and gbrain's retrieval configuration was chosen on it. Every LongMemEval
  number carries that sentence.
- **External systems** were also developed against these public benchmarks. "Held out" in this campaign means held
  out from gbrain's development.
- **Custody.** The program's custodian runs S1 and S2 cells from its own host with the repository-owned runner.
  Dataset caches, Docker volumes, logs, row pulls and store snapshots stay on that host. Only aggregates and proxy
  summaries come back before publication, and VM disks are destroyed at teardown. The BEAM-10M loader used before
  questions open is corpus-only and cannot read question files. Sealed text and rows never land on Capy Drive or an
  implementer's machine. The sealed-confirmation-v2 corpus is not used.
- **Opening order for S1.** Custodian structure check (counts only) → corpus ingest → questions. The structure check
  picks the session rule from this decision tree, fixed now:
  1. Turn groups with `time_anchor`: use them.
  2. Groups without dates: inherit batch dates.
  3. Neither: one disclosed synthetic monotone date sequence for every system, with sessions synthesized at
     message-pair boundaries so gold mapping holds.

  A session still undated when the rest of its conversation is dated takes the harness's shared rule: one minute
  after the previous dated session in data order (A7). Sessions over 24,000 tokens are counted and reported.
- **Retirement.** Publishing per-question rows retires S1 (and S2b once Q2 clears). A fresh held-out supply minted by
  the custodian starts before S1 opens.

## Arms

**Component table (matched evidence).** One ingest per system per conversation (an immutable realization with a
stored snapshot) and one retrieval per question. The harness packs each system's ranked items into 2,000, 8,000
and 16,000 tokens:

- **One byte string per arm**, filled until the largest count among the participating readers' tokenizers reaches
  the budget. Counts use local `cl100k_base` and `o200k_base`, each reader with a calibration factor measured on dev
  packs against provider-reported input tokens (measured 2026-10-07 on the dev smokes: Opus 5.5 1.471 and Sonnet 5.5
  1.452 times `cl100k_base`, maximum error about 10%; GPT-6.1 Sol 1.001 times `o200k_base`, maximum error 4.7%); the
  provider count is recorded for every call. The Claude count binds, so an 8,000-token pack holds about 5,450
  `cl100k_base` tokens of evidence. The same counter packs every system, so the error does not favor one system.
- **Cut rule.** An item larger than the remaining budget is cut at its last whole turn, else its last whole line, else
  its last sentence. Packing stops after a cut and never skips to a smaller, lower-ranked item.
- **Packing loss** is reported apart from retrieval loss. Fill rate is a diagnostic beside each cell, not a gate.
- **Coverage.** 8k runs everywhere. The 2k/16k sweep runs on a stratified 100-question S1 subset covering all 10
  conversations (three readers, seed `q1-sweep`), and on S2b with `claude-sonnet-5-5` as a labeled sensitivity view.

gbrain's retrieval request is `query` with `limit: 50` and no `token_budget`; the harness packs from the delivered
pages.

**Whole-system table (as an operator runs each system):**

- every passive system at its own default amount (gbrain: bare `query`, up to 24,000 tokens);
- each external system's own answer endpoint, where it exists;
- gbrain `synthesize` (own answer) and `think` (full surface, each reader);
- the file agent: Markdown laid out by date, uncapped grep in a linear-time regex worker with `files_only`, turn cap
  40, no write tool;
- full context where the history fits the reader's window (otherwise refused and recorded), with per-conversation
  prompt caching;
- the agent runtime on the LoCoMo slice.

Tokens and dollars per question sit beside every accuracy.

## Readers, judges, repeats

- **Readers:** `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol` and `anthropic:claude-sonnet-5-5` (the newest Opus,
  GPT and Sonnet on 2026-10-07), on every judged component and whole-system row of every set. Fable is smoke-test
  only and reads no counted cell (amendment A1). Reasoning effort `medium`, in the request and the cache key. The prompt is LongMemEval's reading
  prompt, byte for byte the starting line's. S4's 500-question gbrain regression uses `claude-sonnet-5-5` only.
- **Canonical judges, one per benchmark:**
  - LongMemEval and LoCoMo: `gpt-4o-2024-08-06` with LongMemEval's official per-type prompts, the unanswerable prompt
    for abstention and LoCoMo adversarial questions, and LoCoMo's temporal off-by-one prompt.
  - BEAM: its rubric judge, `gpt-4.1-mini`, yes or no per rubric item.

  These are measuring instruments with pinned prompts, parsers and hashes in `eval/runner/memory-qa/instruments.ts`.
  A malformed judgment is retried, never scored as a no.
- **Frontier-judge column:** `claude-opus-5-5` and `gpt-6.1-sol` re-judge, with the same prompts and rubrics, every
  S1 `claude-sonnet-5-5` row and every `think` and file-agent row, plus a stratified 300-item sample on every other
  set. Agreement under 90% with the canonical judge on any system's items flags that column.
- **Judge repeats:** 10 further runs at temperature 0 on fixed answers (zero reader calls) for every
  `claude-sonnet-5-5` 8k row and every `think` and file-agent row on S1, S2 and S3. Judges that accept only their
  default temperature are noted. The report gives the judge SD and verdict stability, meaning the share of the 11
  judge runs under which each Family 1 conclusion holds.
- **Reader replicates:** three per question on every S1 component arm (`claude-sonnet-5-5`, 8k).
- **Ingestion replicate:** a second LoCoMo ingest per system, disclosed.

## Metrics

1. **Answer accuracy decides.** Service quality (product failures count 0) and the completed-call mean, under the
   outcome rules in `eval/runner/memory-qa/outcomes.ts`: first attempt plus the bounded retries those rules allow,
   counted in cost and latency. LoCoMo also reports the adversarial abstention rate and the planted-answer repeat
   rate.
2. **Retrieval diagnostics (judge-free):**
   - strict recall of all gold sessions at 5 and 10, recall of any gold session at 10, and nDCG@10, with provenance
     coverage and source fan-out per system;
   - an evidence-delivered audit: the gold span inside the packed context, where span labels exist, otherwise "session
     delivery";
   - partial provenance is labeled and unavailable provenance is "not measurable";
   - the file agent's "evidence opened" is a different measure, labeled as such.
3. **Cost and speed:**
   - p50/p95 retrieval latency, measured server-side inside each container;
   - p50/p95 end-to-end answer latency;
   - delivered and total reader tokens per question;
   - LLM calls and dollars per 1,000 ingested messages and per million ingested tokens;
   - commit versus background split for synchronous systems (ingest-phase total, labeled, for queued systems);
   - write-start-to-queryable p50/p95 (the last session and a fixed 20-session sample per conversation;
     on LongMemEval, whose sets hold one small haystack per question, 50 seeded haystacks per cell are probed);
   - ingest wall time;
   - monthly cost for a personal workload (2,000 messages, 300 questions) and a team workload (50,000 messages,
     10,000 questions).

   Campaign spend, cached-replay spend and projected workload cost are three separate numbers. Projections for a
   system not run on a set are labeled experiment limits.

### Derived columns

Two descriptive columns sit beside accuracy in the full report tables (per cell, and per system and set) and in
`scoreboard.json`. They make no model calls, need no new cells, are not tested and belong to no Holm family. The
README headline keeps its six columns; one line under it gives each system's confident-error rate and
correct-abstention rate on BEAM-10M.

- **Counted answers.** Each promised reader's replicate-0 answer that has a scored canonical judgment, on scheduled
  questions outside the preregistered exclusions. An answer is wrong when its canonical score is below 0.5, every
  instrument's pass threshold (yes/no verdicts score 0 or 1; BEAM's rubric mean and event-ordering score pass at
  0.5).
- **Confident-error rate.** The share of wrong answers that carry no hedge and no abstention, as the classifier
  below labels them.
- **"I don't know" column.** The correct-abstention rate is the share of answers to questions where abstaining is
  right (LoCoMo adversarial, BEAM abstention, LongMemEval `_abs`) that the canonical instrument passes, so each
  benchmark's own abstention judgment decides. It is pooled per system over its sets. Beside it, the false-abstention
  rate is the share of answers to questions with gold evidence that the classifier labels `abstain`.
- **Classifier.** `eval/runner/q1/hedge.ts`, version `hedge-v1`, rule-table sha256
  `3181d1a9963f1c065fd19ca4470062e8f9aba161931289969d15f4cca56c7be7`. It is a deterministic lexical classifier with
  three labels: `abstain`, `hedged` and `confident`. It ignores quoted text and reported speech ("you said you might
  move" reports the user's hedge), and its rules handle negation ("no doubt" and "not mentioned again" are not cues).
  An abstention that goes on to guess, or that only disclaims precision before answering, is `hedged`.
- **Per answer.** `answers.ndjson` stores `delivered_tokens` (the packed context's per-tokenizer counts on component
  arms, the reader's total input tokens on whole-system arms). The classifier version is fixed by amendment before
  render (campaign.json `hedge_classifier`) and computed at render time: `bun eval/runner/scoreboard.ts` writes each
  answer's verdict to `cells/<id>/derived/hedge.ndjson`, and `check` recomputes that file byte for byte.
- **Validation.** Before freeze, `bun eval/runner/q1/hedge.ts sample` draws a 200-answer sample of dev-smoke answers,
  stratified by verdict, with verdicts hidden from the labeler. The sample is hand-labeled, and
  `bun eval/runner/q1/hedge.ts validate` writes per-class precision and recall and the confusion matrix into the
  receipt. If `confident` or `abstain` precision on that sample is under 0.90, the classifier is revised, its version
  bumped and the sample redrawn before freeze; the confident-error column is not published from a classifier that
  missed this bar. A classifier change after that is a new version and is written here before any cell it affects. The
  development fixture (207 invented memory-QA answers, `test/eval/fixtures/hedge/`) scores 147 of 147 on the set the
  rules were written against and 59 of 60 on a holdout written before the rules and not used to tune them.

## Statistics

- **Estimand.** The per-question mean over the three readers' scores, clustered by conversation on S1 to S3 and by
  question on S4 and S5.
- **Family 1 (headline, inferential).** S1, 8k component table, service quality: `gbrain-defaults` against every
  other component row. Restricted wild cluster bootstrap-t with Webb weights (`eval/runner/stats/wild-cluster.ts`),
  two-sided, Holm-adjusted, α = 0.05. Its family-wise error and coverage for this family are re-simulated
  (`power.json`).
- **Family 2.** S1 whole-system rows, the same method, Holm within the family.
- **Family 3 (diagnostic).** Strict recall of all gold sessions at 10 on S1.
- Everything on S2 to S5 is descriptive, with clustered intervals.
- **Power rule.** Simulated minimum detectable difference (`power.json`): 16.0 points with nine comparisons, 13.6
  after the shrink, so Family 1 is descriptive (A1, A4). If it exceeds 10 points for most Family 1
  rows, Family 1 shrinks to `gbrain-defaults` against the four strongest rows on dev data (the three-reader mean at
  8k on the LoCoMo dev smoke, amendment A4), chosen before S1 opens. If power is still inadequate, S1 is published descriptively with
  its detectable difference and no superiority claim.
- **Cohorts.**
  - Each comparison uses its own pairwise cohort. Coverage is measured against the scheduled cohort.
  - A claim needs at least 9 of S1's 10 clusters and at least 95% of the scheduled questions scored.
  - Excluded ids and reasons are published with best-case and worst-case bounds.
  - The all-system exclusion join is a sensitivity view only.

## What the report may say

Each sentence takes the measured numbers in braces and no stronger claim.

- **Holm-adjusted p ≤ 0.05, gbrain ahead:** "On BEAM-10M, with the same three answer models and 8,000 tokens of each
  system's own evidence, gbrain answered more questions correctly than {kind} ({a} vs {b}, difference {d} points, 95%
  interval {lo} to {hi})."
- **Holm-adjusted p ≤ 0.05, gbrain behind:** the same sentence with {kind} first.
- **p > 0.05:** "On BEAM-10M we could not tell gbrain and {kind} apart ({a} vs {b}); a difference smaller than about
  {mdd} points would not have been detected." Never "equivalent".
- **Both systems at or above 0.95:** "Both answered nearly every question; this set cannot separate them."
- **Fewer than 9 clusters or under 95% of the cohort:** "The comparison is incomplete ({n} of {N} questions, cause
  {c})." No direction is stated.
- **Descriptive sets:** "On {set} ({exposure in plain words}), {kind} scored {a} and gbrain {b}." This states a
  measurement, not a ranking.
- **"Leads", "best" or "beats"** only for a Holm-significant comparison. "Beats the field" only if every Family 1
  comparison favors gbrain and every external kind ran on S1.

## Where gbrain loses

The report and README generate this section by rule.

1. List every cell (set × reader × budget, both tables) where a row beats `gbrain-defaults` with an interval excluding
   zero, and every category where gbrain ranks in the bottom half.
2. Classify gbrain's misses on those questions:
   - evidence page not delivered;
   - page delivered, span missing (where span labels exist);
   - span delivered, answered wrong;
   - packing loss.
3. Name the setting or open work that addresses each, or say "no current fix".

README carries the top three by size.

## Engine rule for S1

A BEAM-10M conversation is about 6,000 to 7,000 conversation pages, past gbrain's own `pglite_scale` advice at
1,000 pages. A dev stress pilot writes the 11 BEAM-1M dev conversations into one brain.

- **PGLite** is the S1 headline engine if query p95 is under 10 seconds, with no rerank or evidence-fetch fallbacks,
  and RSS fits the VM. Two delivery fallbacks are gbrain's shipped, content-driven behavior and do not count:
  `redaction_unmapped` (gbrain's secret redactor changed a block's text) and `no_text_chunks` (a page with no text
  chunks). They are recorded per query and reported as counts. Every other fallback (an evidence-fetch timeout or
  failure, `row_limit`, `unsealed_page`, `anchor_not_located`, any unknown reason) counts, and is a harness failure in
  every cell.
- **Otherwise** the S1 row is `gbrain-defaults` on Postgres, following gbrain's own advice, and says so.
- `pglite_scale` is an allowed S1 doctor warning.
- **Result (2026-10-07): PGLite.** On the 11 BEAM-1M dev conversations in one brain (9,003 sessions, about 12M
  tokens; receipt in [`2026-10-06-scoreboard/dev-stress-pilot/`](2026-10-06-scoreboard/dev-stress-pilot/receipt.json)):
  - ingest: 39 minutes with 0 failures; the embedding barrier finished 43 minutes after the last write;
  - query p95 6.0 seconds (p50 4.3) with expansion applied;
  - no rerank or counted delivery fallbacks; 27 of 220 queries carried a shipped-behavior fallback;
  - peak serve memory 0.82 GB, brain 1.07 GB on disk, restart 3.3 seconds.

  Rechecked at the freeze commit (gbrain `7aa2caa0`, 0.60.106.0; receipt in `dev-stress-pilot/freeze-commit/`): query p95
  5.7 seconds (p50 4.1), no rerank or counted delivery fallbacks, 37 shipped-behavior fallbacks on 220 queries, peak
  serve memory 0.80 GB, brain 1.10 GB, restart 3.7 seconds. PGLite stands. Measured spend $1.22.

  Rechecked at the A14 pin (gbrain `f05943e6`, 0.60.138.0; receipt in `dev-stress-pilot/a14-pin/`), from an empty
  brain: ingest 24 minutes with 0 failures, the embedding barrier 94 minutes after the last write, query p95 4.6
  seconds (p50 3.2), no rerank or counted delivery fallbacks, 26 queries carrying shipped-behavior fallbacks (20
  `no_text_chunks`, 13 `redaction_unmapped`) on 220 queries, peak serve memory 0.65 GB, brain 1.05 GB, restart 2.1
  seconds. PGLite stands. Measured spend $1.24.
  Two earlier query phases ran without expansion because of the proxy bug amendment A3 fixes; they are kept as
  `receipt-run1-expansion-refused.json` and do not count. Measured spend: $1.79 (embeddings, rerank and expansion).

## Budget and stop rules

- **Cap.** $8,500 of model and embedding calls for the whole campaign, held in the campaign ledger as per-block runs
  with hard caps at 1.5 times each block's estimate. Ubicloud VM time is billed outside the ledger and reported.
- **Re-pricing.** Before freeze, the dev stress pilot and paid smokes re-price every block from the executable cell
  manifest. If the total exceeds the cap, the campaign stops for the owner's decision before any S1 spend.
- **Order and scope reduction.** S1 (T1) runs and settles before other readers spend. If the cap is reached mid-run,
  scope is cut in this order: S5, S2a, the S2b sweep, S3's agent-runtime cell. T1 is never cut once started.
- **Stops.**
  - Any block passing its estimate by more than 50% stops for a report.
  - A system projecting past 1.5 times its line, or past 48 hours per conversation, runs common or is reported as not
    run, with the projection.
  - A cell that ends `invalid` (sanitizer, proxy or leak tripwire; install drift; calls bypassing the proxy) stops
    that system's cells until the cause is recorded.
- **Never rerun to improve a number.** Retries happen only under the outcome rules, and every attempt stays in the
  log.

## Freeze checklist (filled by the freezing commit)

- **gbrain:** `f05943e653fd9d938b343b1774a35325ba792271` (0.60.138.0, A14), installed in the `gbrain-defaults` image.
  Resolved configuration hash `3c26b4ae2fc319d385e2dbc0180ec19fd01240a4b6ae5202038a42e2b792407b` (config file
  `6349524a…0554`, starter tool list `08403fb2…483c58d`): PGLite, `voyage:voyage-4` at 1,024 dimensions, `tokenmax`
  search, `voyage:rerank-2.5`, query expansion on (`claude-haiku-4-5`), `synthesize` and `think` on `claude-opus-4-7`,
  fact extraction on `claude-haiku-5-5`, content repair on `claude-opus-5-5`; the public gbrain rows rerun at this
  pin (A15). The public-v2 gbrain cells, reported only in the found-and-fixed appendix, ran at `7aa2caa0`
  (0.60.106.0), resolved hash `415dafe5ada70e8ba2ba72126a1af950a04eaab31aec0da4b7cf09f43186ccab` (fact extraction on
  `claude-sonnet-4-6`, no content-repair model).
- **Campaigns** (`2026-10-06-scoreboard/campaign/`), each hash covering the manifest, the git tree of every file a
  cell executes (159 files at the A9, A14, A17, A19 and A20 trees, 160 at A22, A23 and A24) and the pinned images:
  - `q1-scoreboard-sealed`: S1, BEAM-100K and BEAM-1M sealed, and LoCoMo; 149 launch units (A23); cap $8,000 (A23; $7,800 from A20);
    launched from the custodian's host. Hash `a92b06c59ceb0c635c125147263eeacef2b47a88a558def6c8dafef18de987ea` (A24, 160 files)
    for every unit that runs from A24 on, replacing `b13010e1cdab897aab7143231ae005f040c3e19c06dcd8f9210963478ae6bd95`
    (A23), under which the first A23 units started. That replaced `0c4459fc4a0ea6164cedf14b650b5483c603a21150534be40fe46dbb1a4fe169`
    (A22), under which waves 2 and 3 and the wave-1 reruns settled. That replaced
    `43749abd1ebecd8b8e16b3d9f91401647f27e95f247d65339e7819eaedb1cfb6` (A20), which replaced `a1ff43c5` (A19, never
    relayed). Wave 1's settled units ran at
    `eefd1799842105260104532b78283f9d9b5379ddfae6d44bb8f75317bc56424c` (A17), which replaced
    `a7328eed8f77e30523e32a1c4a9756711fabdcfce3118c893dedd006b3877728` (A14), under which nothing was counted.
  - `q1-scoreboard-public`: LongMemEval-S and -M; 12 launch units; cap $500. Hash
    `52757aab6762ddb7c846fdb8bb5943d98e7aecf1cd7f164dc1acda8e65a5b7e2` at its launch tree (`a22e3d81`, 156 files); it
    renders from that tree (A8).
  - `q1-scoreboard-public-r2`: the two verbatim-session reruns (A9); cap $20. Hash
    `8da287a424a121e2039ff184ab22b493b642082b25c31f86948538ba27ae9d35`.
  - `q1-scoreboard-public-r3`: both verbatim-session reruns with $13 leases (A9); cap $30. Hash
    `dbd109d8982ced34cddeb10bc09c9eb54fc852979b56e3c1f11c62d474c1e84b`.
  - `q1-scoreboard-public-r4`: three cells split into haystack shards (A10); 16 launch units; cap $90. Hash
    `41a92703001f703ebd8be683931848e6c65ec0f942a4b9f6ac6488a19c22de94`.
  - `q1-scoreboard-public-r5`: the S5 reruns after A11; 6 launch units; cap $170. Hash
    `83d357e982d3a313be21b7ad18a07393b9107d06011540df1a12b1fa4f9163b3`.
  - `q1-scoreboard-public-v2`: every public cell, rerun after the results were lost (A13); 41 launch units; cap $441.
    Hash `59c00444d1633f50034b35e404e73d209ede8343754db8687fc32a095f19986e` at its launch tree (`4bccbd5a`, gbrain
    `7aa2caa0`); it renders from that tree (A14). It replaces the public campaign and r2 to r5, which are retired with
    nothing counted. Its gbrain-defaults rows move to the found-and-fixed appendix (A15).
  - `q1-scoreboard-public-v3-m`: the four LongMemEval-M gbrain-defaults shards at gbrain `f05943e6` (A15); cap $38.
    Hash `1d119581f9ab9c4cf863cbd9ebff0909a49aa8ddb109420b967e2a0615e20248` at its launch tree (`0518e2fd`); it renders
    from that tree (A17).
  - `q1-scoreboard-public-v3-s`: the two LongMemEval-S gbrain-defaults shards at gbrain `f05943e6` (A15); cap $39.
    Hash `ca729154f25b4d11429a93e810961a8239c928e51e4c11f62fa1209d22a5c612` at its launch tree (`0518e2fd`); it renders
    from that tree (A17).
    Its two VMs were lost at 05:40 UTC on 2026-10-11 and its leases count at their full $35, with nothing reported
    (A18).
  - `q1-scoreboard-public-v3-s2`: the same two LongMemEval-S shards, rerun after v3-s's VMs were lost (A18); cap
    $39. Hash `f34169372ea1818a94882331c3cf720fa5308184842feb1de1908857ee5de64a`.
  The sealed cap ($8,000, A23) and about $418 of spend outside it (A20), about $8,418 together, stay under the $8,500
  program cap.
- **Images:** every upstream image each bundle pulls or builds on, in each campaign's `images` map by bare `sha256`
  digest keyed by bundle (the full references live in the bundles beside `docs/comparison-systems.md`); images the
  bundles build are covered by their Dockerfiles and lockfiles in the hashed tree.
- **Engine:** PGLite (rule result, rechecked at the freeze commit).
- **Token calibration:** Opus 5.5 1.4708 and Sonnet 5.5 1.4524 times `cl100k_base`; GPT-6.1 Sol 1.0009 times
  `o200k_base` (A4).
- **Cell manifest:** `eval/runner/q1/cells/q1-cells.json`, $8,023 in cells (A5 lines, re-priced by A20).
- **S1 sweep subset:** 100 questions stratified by conversation and category, seed `q1-sweep`, drawn by the
  custodian when questions open; question `1_abstention_0` is excluded everywhere.
- **Family 1:** descriptive; shrink comparators `ext-extract-first`, `ext-markdown-kb`, `ext-temporal-graph`,
  `ext-graph-pipeline`.
- **Hedge classifier:** none met the bar; `hedge_classifier: none` (A6).

## Amendments

**A1 (2026-10-07, before freeze): readers drop from four to three.** Program rule from Garry on 2026-10-07: Opus 5.5
is the top Anthropic model in counted runs, and Fable is smoke-test only, never in counted cells, practice rounds or
held-out runs. The readers become `claude-opus-5-5`, `gpt-6.1-sol` and `claude-sonnet-5-5` on every judged row; the
estimand becomes the three-reader mean; the generated claim sentences say "the same three answer models"; the power
simulation is rerun with three readers (`power.json`: central minimum detectable difference 16.0 points with
nine comparisons, 13.6 after the shrink rule, against 15.6 and 13.3 with four readers; Family 1 stays descriptive
unless dev smokes change the inputs); the cell manifest is re-costed ($8,074 to $5,418 in cells). No counted cell had run and
no sealed material had been opened, so nothing measured changes. Fable may read only a separately labeled smoke
cell, which this campaign does not define.

**A2 (2026-10-07): a fresh held-out reserve is being minted.** Under owner custody, the custodian mints a reserve of
10 BEAM-style conversations of about 1M tokens each with BEAM's public generator at `b2da22e`, before BEAM-10M opens,
so later decisions have material no one has used. Q1's cells do not use it. It is referenced here only by the SHA-256
of its hash list: OPEN at A2 (relayed by the program owner when minting finishes); recorded in A16.

**A3 (2026-10-07, before freeze): output caps bind only the harness's own calls.** The dev stress pilot showed the
metering proxy refusing gbrain's query-expansion call, which states a 64,000-token output allowance, because the
proxy's default output cap was 32,768. Every pilot query therefore ran without expansion, which is not gbrain's shipped
behavior. The proxy now applies output caps (inject when absent, refuse when exceeded) only to reader and judge calls.
A system under test's requests pass unmodified, and their reservation is the allowance they state. The pilot's query
phase is rerun on the fixed proxy.

**A4 (2026-10-07, before freeze): settings from the dev smokes.** Paid smokes on LoCoMo dev (one conversation, 20
questions) and BEAM-1M dev ingest probes, $53.75, receipts in
[`2026-10-06-scoreboard/dev-smokes/`](2026-10-06-scoreboard/dev-smokes/README.md), settle these:
- Reader token calibration factors (see Arms). The 3% calibration bar is not met for the Claude readers (error up to
  about 10% per pack). Instead of a per-pack provider count, the tolerance is stated: packs are filled by the
  calibrated local count, and every reader call's provider-reported input tokens are published beside it.
- Readiness probes on LongMemEval cells are capped at 50 seeded haystacks per cell; every other set keeps every
  conversation. A probe still missing after `/finish` reports ready is final; probes no longer poll past the drain.
- The power rule's four strongest dev rows are ranked by the three-reader mean at 8k on the LoCoMo dev smoke (the
  estimand): `ext-extract-first`, `ext-markdown-kb`, `ext-temporal-graph`, `ext-graph-pipeline` (`power.json`).
  Family 1 stays descriptive: the detectable difference is 16.0 points with nine comparisons and 13.6 after the
  shrink.
- BEAM-10M ingest projections per conversation (about 11M tokens): extract-first common $31 and 19 h; memory-bank
  recipe $19 and 26 h; graph-pipeline recipe $39 and 54 h, over 48 h, so its S1 cell runs common ($44, 34 h);
  temporal-graph common $193 and 39 h. The graph pipeline keeps its recipe on BEAM-100K and BEAM-1M sealed.
- Claude 5 readers reject a temperature parameter, so no temperature is sent to them.

**A5 (2026-10-08, before freeze): plan lines reset at the re-price; the graph pipeline runs on BEAM-10M.** The
program owner decided on 2026-10-08 that the block and per-system lines in "Budget and stop rules" are reset to the
re-priced cell manifest (`eval/runner/q1/cells/q1-cells.json`, $6,732 in cells, about $6,990 with shared work,
under the $8,500 cap), and every later stop rule is judged against the new lines. The graph pipeline's recipe setup
projects 54 hours per BEAM-10M conversation, over the 48-hour limit, so under the rule its S1 row runs the common
setup (34 hours and $44 per conversation) and is labeled "common setup" wherever it appears. A field-wide claim
needs every external kind on S1, so it runs.

**A6 (2026-10-08, before freeze): the confident-error column is not published.** The hedge classifier was validated
under the rule in "Derived columns" on three fresh, blind, hand-labeled samples of 200 dev-smoke answers, each by a
different labeler who did not know the system. Abstain precision was 0.42 (`hedge-v1`), 0.881 (`hedge-v2`) and 0.893
(`hedge-v3`, 67 of 75) against the 0.90 bar; confident precision was 0.80, 0.939 and 0.973. No version met the bar, so
the confident-error rate and the classifier-based false-abstention rate are not published (`hedge_classifier: none`
in the campaign). The correct-abstention column stays: it uses each benchmark's own abstention judgment, not the
classifier. Each answer record still carries its delivered tokens. The three validation aggregates are in
[`2026-10-06-scoreboard/dev-smokes/`](2026-10-06-scoreboard/dev-smokes/README.md).

**A7 (2026-10-08, before any counted cell): BEAM-10M manifest, structure rules and pre-cell harness fixes.** No
counted cell had run, public or sealed, and no BEAM-10M question had opened.
- **Dataset manifest.** The custodian filled `eval/decisions/datasets/beam-10m-9b20961.json` on the custody host
  (diff SHA-256 `8d1dbec41172d2c269e0046aa9dc98f1028a915baf2db523bd6ee7b0b9d33c62`, applied unchanged). Shards at
  revision `9b209619`, checked against the hub's LFS hashes: `data/10M-00000-of-00002.parquet` 153,844,664 bytes,
  `31d96fd47ec56221d202e68792f26c00e49467dd4b36ee105c36ebd19ef78ad5`; `data/10M-00001-of-00002.parquet` 189,980,875
  bytes, `a4f13fe25af51d57405ae41008689c31d1421377f3efde56a024b441deb2ee65`. Extraction script
  `eval/runner/q1/beam10m_extract.py` `f579fdde9d38b5ed8b53a6bd48274e64d3c6d6ae7c86f72779aa72d4b82eca75`; each of
  the ten conversations has a pinned corpus file and question file hash. Custody log: one open at
  2026-10-08T07:16:59Z, purpose "beam-10m manifest: extract corpus and question files and hash them", and ten
  corpus-only opens for the structure check. No question text came back.
- **Structure check (counts only).** 6,227 to 9,290 sessions and 9.66M to 13.0M `cl100k` tokens per conversation; no
  sessions synthesized at message pairs. Nine conversations are dated entirely by their own or batch anchors. In
  10m-7, one batch of 93 sessions (of 9,236) carries no anchor. 10m-5 has one session over 24,000 tokens (26,731);
  no other conversation has any. Anchors go backwards somewhere in data order in 10m-1, 10m-3, 10m-4 and 10m-5.
- **Rule: undated sessions inside a dated conversation.** The loader used to give a whole conversation the synthetic
  sequence when any session was undated; for 10m-7 that would discard 9,143 real anchors and leave every time
  question in that conversation without dates for every system. The loader now leaves only the undated sessions
  undated (`date_source: partial`), and the harness's sanitizer, which every dataset already goes through, dates
  each one minute after the previous dated session in data order and counts it as synthetic in the ingest plan.
  The whole-conversation synthetic sequence stays for a conversation with no parseable date. A question without its
  own date gets the conversation's latest event time as its query time, the existing rule.
- **Rule: anchors out of data order.** Sessions are ingested in event-time order, ties in data order, the existing
  harness rule for every dataset; every system gets the same order and each session's event time. 10m-1, 10m-3,
  10m-4 and 10m-5 are disclosed as reordered relative to data order.
- **Rule: the oversized session.** The 26,731-token session in 10m-5 is delivered whole to every system, as every
  session is; nothing splits it. It is counted and reported, as the opening-order rule says.
- **Pre-cell harness fixes, ported from the newer shootout's review (gbrain-evals#89):** one provider usage
  normalizer, so an OpenAI reader's cached input tokens are counted once (OpenAI's input totals include cached
  tokens; Anthropic's do not), with `usage.input` meaning uncached input for every provider and the dev-smoke
  calibration factors unchanged on recompute; the memory-bank kind's Postgres container gets `shm_size: 1g`; and
  gbrain's `/finish` drains or waits out its background job queue and outbox, records `background_liabilities` in
  the result and receipt, and meters calls after the cell's own work as `background_tail` spend per realization.
- **Exposure.** The newer shootout's sealed LoCoMo and BEAM-100K batch is added to the exposure section.

The campaign manifests are regenerated and both hashes change; the new hashes and freeze commit replace the old ones
in the freeze checklist.

**A8 (2026-10-08, before any sealed cell): reader dates follow parsed event time.** Another thread's BEAM-1M failure
analysis (gbrain-evals#100) found that the shared reader prompt orders sessions, and picks the "Current Date" a
question without its own date gets, by sorting raw date strings. Q1's packer used the same path. BEAM-100K and
BEAM-1M write `Month-DD-YYYY`, and LoCoMo writes "1:56 pm on 8 May, 2023", so the reader would have seen S2a, S2b and
S3 sessions in alphabetical order of the month name, with a current date that is often not the latest session (8 of
11 BEAM-1M dev conversations in that analysis). No sealed cell had run.
- Rehydrated packs now order sessions by the event time the ingest plan parses (`eventTimeOf`, whose BEAM parse is
  the same `Month-DD-YYYY` mapping as #100's `sessionDateKey`; Q1 also parses LoCoMo, ISO and undated sessions), with undated
  sessions first and ties in pack order. The fallback current date is the raw date of the latest session by event
  time. A session with no date of its own shows the time the ingest plan gave it, which covers 10m-7's 93 undated
  sessions under A7. Native packs already ordered items by their event time; only their current date changes.
- LongMemEval prompts are unchanged byte for byte. All 96,364 distinct session dates in LongMemEval-S and -M parse,
  their string order equals their event-time order with no ties between distinct strings, and all 1,000 questions
  carry their own date. BEAM-10M's ISO dates already sorted correctly, so apart from 10m-7's undated sessions S1 is
  unchanged too.
- The LoCoMo dev smoke (A4) used the string order. Its reader calibration factors don't depend on order. Its
  ranking of the four shrink comparators, which affected every system the same way, stands as recorded.
- **gbrain-evals main merged before the re-freeze** (v0.10.46: #89 the open-source comparison, #99 usage receipts,
  #100 the BEAM-1M analysis), with conflicts resolved toward this campaign's frozen behavior:
  - Sampling (#100's Claude 5 rule, `sendsTemperature`) replaces Q1's own rule. For all eight models the campaign
    names, the send-or-omit temperature decision is identical; Q1's effort, system message, judge retry and
    null-temperature options are kept, as are the proxy base URLs.
  - Reranker fidelity checks (#100) live in the classic gbrain path of `memory-qa/run.ts`; no Q1 cell runs it
    (gbrain-defaults answers through its shim).
  - Usage receipts (#99): a chat result's `input_tokens` is now the provider's total and the raw usage is kept. Q1
    still writes its answer records with its own normalizer (`q1/usage.ts`), now fed the raw provider usage, which
    gives the same buckets; the test fixtures were rewritten as raw usage objects and expect the same numbers.
    Reconciling `q1/usage.ts` with #99's receipt waits for landing.
  - The shared harness files (`systems/*`, `shootout-cell.ts`, `metering-proxy.ts`, the shims, `bootstrap.sh`) keep
    Q1's versions; #89's later additions are ported where they do not touch Q1 cells (reader policies in arms files,
    `export-cell`, the fake provider's status route, a VM custody root for the open-source comparison's sealed
    cells, never set for Q1). #89's runners now run on these modules (for example the multi-line item renderer), so
    its published numbers reproduce at its merge commit `ccd49e01`.
  - Main's price table adds GPT-6.1 Sol's long-prompt tier (over 272,000 input tokens). No Q1 estimate changes; the
    metering proxy charges such calls at that rate.
  - The executed tree names the `eval/systems` paths Q1 runs (the open-source comparison's own bundles there are
    not Q1's) and adds `usage-receipt.ts` and `openai-judge-shim.ts`, which `qa.ts` now imports. Cells and images
    are unchanged.
- The public campaign (`q1-scoreboard-public`) launched on 2026-10-08 at hash
  `52757aab6762ddb7c846fdb8bb5943d98e7aecf1cd7f164dc1acda8e65a5b7e2` (tree at `a22e3d81`, before this
  amendment). Its LongMemEval prompts are identical under the date rule above, and its reader and judge requests are
  built the same way after the merge, so its cells stand; it renders from its launch tree.
- The sealed campaign's hash changes; the freeze checklist records it.

**A9 (2026-10-08): the verbatim-session shim's open-file limit.** On the public run, `ext-verbatim-session` returned
`retrieval_error` ("Too many open files") for all 100 LongMemEval-S slice questions. The shim keeps one persistent
store per haystack in one container, and a 100-haystack cell holds about 1,000 open files, past the container
default of 1,024; reproduced locally (73 of 120 namespaces failed). The bundle's compose file now sets the shim's
`nofile` limit to 65,536 (300 namespaces, 0 errors). It is a harness limit, not the product's behavior, so the
failed cell is not a counted result. Its S5 cell was stopped during setup, before its command ran, and closed at $0.
Both verbatim-session cells rerun as `q1-scoreboard-public-r2` ($16.96 in leases, $20 cap) at the A8 tree. Sealed
cells use the same bundle, so the sealed campaign carries the fix. On r2 the S4 slice cell answered 99 of 100
questions before its $8.48 lease ran out (this system returns whole sessions, so reading costs more than the
baselines' estimate), and the S5 cell's dataset download failed in setup before its command ran (closed at $0). Both
cells rerun in full as `q1-scoreboard-public-r3`, with $13 leases and a $30 cap; r3's rows replace r2's, and r2's
partial S4 cell ($8.39) is reported as spend only. The sealed campaign's verbatim-session leases are not changed by this; a sealed cell that runs
out of lease is reported partial and resumed under the same rule.

**A10 (2026-10-09): public cells that outran their wall-clock limits.** Three public cells were sized from estimates,
not pilots, and ingest ran far slower: the markdown-kb kind took about 8.5 minutes per LongMemEval-S haystack (92 of
100 ingested when its 13-hour limit stopped it, with no answer spent) and about 88 minutes per LongMemEval-M haystack
(8 of 100 in 12 hours, a projected 148 hours against a 72-hour limit); the in-process hybrid baseline took about 23
minutes per LongMemEval-M haystack (31 of 100 in 12 hours, a projected 38 hours against 14). Each haystack is far
inside the 48-hour per-conversation limit, so no configuration changes. The S5 cells were stopped during ingest,
before any answer, and all three rerun as `q1-scoreboard-public-r4`: the same cells split into haystack shards with
the runner's existing `--shard i/n` (2 for the S4 slice, 10 and 4 for S5), each shard with its own VM, a timeout of
twice its projected hours and a lease of 1.5 times its share (at least $2); $76.96 in leases, $90 cap. Rows from the
shards are pooled per cell, as S1's shards are. Wall-clock time per haystack is reported for every cell.

**A11 (2026-10-09): two harness faults found on LongMemEval-M.**
- **A false leak tripwire.** The request leak scan checks every request body for the corpus's raw ids. LongMemEval's
  question ids are 8 hex digits, and the harness's own opaque source ids are 16 hex digits, so one opaque id
  (`src-1356545bd2b51a59`) happens to contain a question id (`545bd2b5`). Every shim system's ingest of that one session
  on S5 trips the scan, and the cell ends `invalid` (the verbatim-session S5 cell did, after answering 96 questions).
  Nothing leaked: the id is a hash. The scan now skips the harness's own `ns-`/`src-` ids before matching; a raw id in
  the text still refuses. BEAM and LoCoMo ids contain letters outside hex (`1m-16:abstention:0`, `conv-26:q001`,
  `session_1`), so no sealed set can produce this collision.
- **An unbounded write to gbrain's server.** On S5 the gbrain-defaults cell stopped for 9.5 hours at 51 of 100
  haystacks: after committing a session, `gbrain serve` (at the pin) stayed at 100% CPU and stopped reading its input,
  and the shim's next write blocked with no deadline, so the call's own timeout never started. The shim now bounds the
  write by the call's timeout (900 s); a serve that stops reading is killed, the call fails as a timeout (a product
  timeout on that session, counted under the outcome rules), and serve restarts on the same brain for the next
  session. The serve hang itself is gbrain's behavior and is reported to gbrain with the captured brain.
- Both fixes are in the executed tree, so the sealed campaign is re-frozen (its hash below). The affected public cells
  rerun as `q1-scoreboard-public-r5`: gbrain-defaults S5 in 4 haystack shards, verbatim-session S5, and the
  markdown-kb S5 shard that holds the colliding session; $152.48 in leases, $170 cap. The stopped gbrain-defaults S5
  cell and markdown-kb shard 5 had answered nothing.

**A12 (2026-10-09): the gbrain read classifier misread identity-tier grades.** gbrain's confidence grade (CRAG)
decides an exact lookup, an alias hit, an exact title match or a near-identical vector match (`high_vector_match`)
before its rerank branch, so at the pin those grades carry no `top_rerank_score` even though the reranker ran. The
shim treated the absent field as `rerank_missing`, a harness failure. An exact-quote query is the typical trigger:
another thread rebuilt 13 of the 89 LongMemEval-S readiness-probe misses (A11's run) and gbrain returned the target at
rank 1 in all 13; 12 were this misread and one was a real gbrain fault (a passage with a 73-dash line overflows the
keyword query parser, so both lexical arms report a degraded read, which stays a harness failure under the read
contract). The shim now checks for the rerank score only on grades that pass through the rerank branch; a reranker
failure still shows as a degraded stage. The fix is in the executed tree, so the sealed campaign is re-frozen.

**A13 (2026-10-09): the public results were lost and the public sets rerun.** The launching machine's storage was
replaced on 2026-10-09 while public cells ran. Everything pulled to it was lost: the settled public cells' rows,
receipts and lease ledgers (they were not yet committed), and the SSH keys of the 15 VMs still running, which were
destroyed unread. None of those runs is counted or published; what they taught is recorded in A9 to A12, and their
spend (about $150, reconstructed from the reports above because the ledgers were lost) is reported. All public cells
rerun once as `q1-scoreboard-public-v2` at the A12 tree, sized from the measured ingest rates (A10): 41 launch units,
long cells split into haystack shards of about 6 to 8 hours, each with a timeout of twice its hours and a lease of 1.5
times its share (at least $2); verbatim-session keeps A9's $13 lease; $400.80 in leases, $441 cap. The launching host
now pushes each campaign's state (leases, ledgers, rows, receipts; not store snapshots) to the results branch
`evals/q1-scoreboard-results` every 10 minutes (`eval/runner/q1/persist.sh`; public campaigns only), so a lost host
loses only the cells still in flight. `q1-scoreboard-public` and its reruns r2 to r5 are retired. The public block's
$500 line is exceeded: about $150 lost plus up to $441 for v2 (about $250 expected at measured rates), caused by the
lost machine, not by scope. The program owner approved v2 on 2026-10-09; the program total stays under $8,500.

**A14 (2026-10-09, before any sealed cell): gbrain moves to the newest master.** Two gbrain faults found during Q1 are
fixed on gbrain master. Every version before 0.60.133.0 spins `serve` at one full core on a ```` ```lua ```` fence
around non-Lua text (its bundled Lua grammar fails to parse and the chunker loops), and a restarted serve resumes
the stuck job, so every later write in that brain times out; gbrain #6389 (`d79bd1318`, 0.60.133.0) fixes it. The
last-session verbatim misses that A11's readiness probe found had three causes (a dash-rule line overflowing the
keyword query parser, text-only image routing, and a missing rerank score on one confidence grade); gbrain #6391
(`f05943e65`, 0.60.138.0) fixes them, and its paired verdict (gbrain-evals#120) reports the probe's clean rate going
from 429 to 500 of 500 with recall@10 unchanged. The owner approved the change on 2026-10-09. The rule is the newest
gbrain master when this amendment is written, not a version chosen from results: master's head was `f05943e65`
(0.60.138.0), merged 2026-10-09 22:24 UTC.

- **Sealed.** `gbrain-defaults` installs `f05943e653fd9d938b343b1774a35325ba792271`. The reference install resolves
  to hash `3c26b4ae…407b`; the config file and starter tool list hashes are unchanged. Two of gbrain's shipped
  model defaults changed: fact extraction moves from `claude-sonnet-4-6` to `claude-haiku-5-5`, and a content-repair
  model (`claude-opus-5-5`) is now named. They are gbrain's defaults at the pin and are published as such;
  `claude-haiku-5-5` is added to the sealed campaign's priced models. The stress pilot reran at the new pin and
  PGLite stands (engine rule above). A12's shim check stays: it tests for a rerank score only on grades that pass
  through the rerank branch, so #6391's score change does not alter which reads it marks. The sealed campaign is
  re-frozen; no sealed cell ran at an earlier freeze.
- **Public.** `q1-scoreboard-public-v2` keeps the pin it launched with, `7aa2caa0` (0.60.106.0): its results are
  published as they stand and every gbrain row is labeled with that pin. Its gbrain cells are not rerun at the new
  pin. A cell that hits the serve hang is reported as a failure of the pinned version under the outcome rules. On
  2026-10-09 the hang recurred on two LongMemEval-M gbrain shards (`c1` and `c2`); the `c2` capture is on
  `evals/q1-scoreboard-results` under `hangs/v2-s5-gbrain-c2/`, and gbrain's owner confirmed it is the defect #6389
  fixes. The pin sits in v2's executed tree, so v2's hash recomputes at its launch tree `4bccbd5a` and v2 renders from
  that tree, as the first public campaign renders from `a22e3d81` (A8).
- **Report.** The headline (sealed) and public gbrain rows name different gbrain versions; every table states the
  pin beside the row, and no row compares gbrain across the two pins.
- **Custody (Q2).** Q2's decision is recorded (gbrain-evals#88, v0.10.51), so the condition that kept BEAM-1M sealed
  per-question rows in custody is met: when S2b runs, its per-question rows publish under D2.

**A15 (2026-10-10, before the cells it affects): the public gbrain rows rerun at the sealed pin.** A14 left the
public-v2 gbrain cells at `7aa2caa0`, where four of six shards stalled (two confirmed as the hang #6389 fixes, two
LongMemEval-S shards that stalled mid-ingest the same way, likely the same defect, not confirmed), so the public
table would have named two gbrain versions. The owner chose to rerun all six public gbrain-defaults shards
(LongMemEval-S `c0` and `c1`, LongMemEval-M `c0` to `c3`) at A14's pin, `f05943e653fd9d938b343b1774a35325ba792271`
(0.60.138.0), including the two LongMemEval-M shards that scored at `7aa2caa0`, so every gbrain row in the report
names one version.

- **Unchanged.** The arm, its configuration and its executed tree are A14's: PGLite, gbrain's shipped defaults
  (resolved hash `3c26b4ae…407b`), query expansion on, MCP `query` delivery, the packer, readers and judges. The cells
  are v2's gbrain-defaults cells with the same commands, shards and timeouts; only their leases and campaign change.
  The sealed campaign and its tree are untouched, and its hash `a7328eed…7728` recomputes at this commit.
- **Smoke.** One LongMemEval-S run of 33 questions (the cell's `--limit 33`, seed 42, Sonnet anchor arm only),
  chosen so the sample holds a conversation with a ```` ```lua ```` fence (question `3249768e`), ran at the pin on
  one VM on 2026-10-10: every conversation ingested, 63 of 63 readiness probes found, 32 rows `scored` and 1
  `ingest_degraded` (`3249768e` scored), no `deadline_exceeded` in the serve log, $1.25. It counts for nothing.
  An earlier smoke started at a newer gbrain master was stopped before it finished (about $1); it counts for nothing.
- **Campaigns.** `q1-scoreboard-public-v3-m` runs the four LongMemEval-M shards with $9.50 leases (measured $6.95 and
  $7.42 per shard at `7aa2caa0`), cap $38. The two LongMemEval-S shards (projected about $13 each from the smoke and
  v2's partial ingest) run in a second campaign whose cap the owner sets; it is recorded here before it launches.
  The owner's stop for this rerun is $60 including the smokes, unless the owner raises it.
- **Cap raised (2026-10-10, before the LongMemEval-S launch).** The program lead raised the rerun's stop to $80
  including the smokes, under Q1's $8,500 program cap, because the projection (about $57) left the $60 stop no lease
  headroom. `q1-scoreboard-public-v3-s` runs the two LongMemEval-S shards with $17.50 leases, cap $39 ($80 less the
  $38 LongMemEval-M cap and about $2.25 of smokes, rounded down).
- **Appendix.** The public-v2 gbrain-defaults rows stay on `evals/q1-scoreboard-results` and are reported only in a
  found-and-fixed appendix: LongMemEval-M `c1` and `c2` "stalled at pin `7aa2caa0`, fixed in #6389 (0.60.133.0)";
  LongMemEval-S `c0` and `c1` "stalled ingest, likely #6389"; LongMemEval-M `c0` and `c3` scored at `7aa2caa0` and
  are shown there for comparison only. A14's note that public and sealed gbrain rows name different versions no
  longer applies. The other public-v2 rows (external systems and baselines) are unchanged.
- **Stalls.** A rerun shard that stalls is captured (process state and receipts) and reported to the owner before
  any further run.

**A16 (2026-10-11): a sealed launch interrupted before any cell started; the D8 hash list.** On 2026-10-10 at 23:56
UTC the custodian launched wave 1's 32 longest sealed cells from the owner's host at freeze `a7328eed`. About 30
minutes in, while every VM was still receiving the checkout upload, a restart of the launcher sent SIGHUP to the
cell processes, and the VM runner tore down all 32 VMs. Every launch log shows only VM created, ready, upload,
hangup and destroyed: no cell command or metering proxy started, no sealed file was opened and no result was pulled.
API spend was $0. The 32 leases (reserving $2,866.02) are settled at their measured VM cost, each line recorded in the
custodian's ledger, and none is a counted attempt. The custodian's launcher wrapper, outside the hashed tree, now
ignores SIGHUP and derives its vCPU count from running cell processes; uploads use a shallow clone of the identical
tree and are staggered. The relaunch runs on the same freeze; the executed tree is unchanged, and the sealed hash
`a7328eed…7728` recomputes at this commit.

The D8 reserve's hash list (A2) is relayed: SHA-256
`a14e55ced31008846778603eee656696f8a35c123758c814f36653d970a7a19a`, 153 files, held in owner custody on the owner's
host. Q1's cells do not use the reserve.

**A17 (2026-10-11, before any sealed cell reached a question): two sealed launch-path faults fixed; re-freeze.**
The custodian found two faults that stop every sealed cell before its first question. Both are in the harness
that delivers data and carries custody to the VM. No bar, cell, reader, model, lease or scoring rule changes.

- **Fault 1: S1 had no corpus delivery.** Each S1 cell's setup runs `eval:decide fetch --benchmark beam-10m`, and
  BEAM-10M has no download: its files exist only in custody. The launcher had no way to put the custodian's
  verified copy on the VM, so all 85 S1 units stopped in setup. The fix: on the custodian's host,
  `GBRAIN_EVALS_BEAM10M_SOURCE` names the verified dataset root, which must be outside the checkout. Before any VM
  exists, the launcher checks all 20 corpus and question files against the SHA-256 values in the committed manifest
  (`eval/decisions/datasets/beam-10m-9b20961.json`) and refuses on a missing or changed file. Once the VM is ready
  and before setup, the VM runner (`ubi-runner.sh run --push`) copies only those files to `~/custody/datasets`,
  outside the checkout and readable only by the VM user. Setup's fetch hashes each file again against the manifest
  and refuses on a mismatch. The loaders read from there, and the remote command deletes `~/custody/datasets`
  when the cell ends, before the VM disk is destroyed. The opening order is unchanged: structure check, then corpus
  ingest, then questions.
- **Fault 2: Q1 sealed cells ran without custody on the VM.** A Q1 cell's payload never carried `sealed`. So the VM
  created no custody root and set no `GBRAIN_EVALS_CUSTODY_LOG`, and the cell's `--out` sat inside the VM's checkout.
  `q1/cell.ts` refuses a sealed-split cell on either count, so all 144 units would stop before their first
  question. The fix: a sealed cell's payload is sealed. The metering proxy's ledger stays in `~/custody/<lease>`.
  The cell writes under `~/custody/out/<cell>/<lease>`, outside the checkout, and the access log is
  `access-log.jsonl` in that directory, so it comes back with the rows. Rows, checkpoints and store snapshots are
  pulled only into the launch's state directory. A sealed launch now refuses a state directory inside the
  repository. The launcher's default (`eval/reports/scoreboard/<campaign>/state`) is inside the checkout, so the
  custodian passes `--state <custody root>/q1-scoreboard-sealed/state`. A resume from a snapshot stages the
  snapshot in that state directory and pushes it to `~/custody/restore`, which is also deleted at teardown. Before
  this fix, a resume staged the snapshot in the checkout.
- **Doctor.** `doctor --for sealed --campaign <sealed> --state <dir>` adds three error checks that run before any
  lease:
  - `s1-corpus` fails when no BEAM-10M files would be pushed, when `GBRAIN_EVALS_BEAM10M_SOURCE` is unset or inside
    the repository, when any file's SHA-256 differs from the committed manifest, or when a stand-in manifest is set
    (`GBRAIN_EVALS_BEAM10M_MANIFEST` is for dry runs only).
  - `sealed-payload` fails when any sealed cell would launch without a VM custody root and the access log.
  - `sealed-out` fails when a sealed cell would write inside the VM's checkout, or when `--state` is inside the
    repository.
- **Dry runs.** One cell per benchmark ran on a VM from a scratch copy of this tree, through the sealed path:
  sealed payload, VM custody root and access log, output under `~/custody/out`, and rows pulled into a state
  directory outside the checkout. API spend was $0.96 across seven leases, with a few minutes of VM time per VM.
  - **S1** used a synthetic stand-in in BEAM-10M's layout (invented text, never BEAM-10M bytes), named by a stand-in
    manifest. It ran S1's own `c0` command and setup unchanged. The launcher pushed 21 files; setup verified 20 of
    them against the stand-in manifest; `q1/cell.ts` passed its custody gate and logged each opening. gbrain
    ingested one conversation and was snapshotted under `~/custody/out`, and all five arms answered and were judged
    ($0.39).
  - **BEAM-1M (`1m-16`), LoCoMo (`conv-44`) and BEAM-100K (`100k-1`)** ran dev copies of their gbrain-defaults
    sealed cells, with the first 4 sessions ingested on the BEAM sets and one question each. Every arm finished
    complete ($0.25, $0.12 and $0.21).
  - The first launch of those three stopped at its cell schema check because the dev copies had wrong arm ids. That
    error was in the scratch definitions, not in the tree.
  Every VM was destroyed.
- **Freeze.** The sealed campaign is re-frozen at hash `eefd1799842105260104532b78283f9d9b5379ddfae6d44bb8f75317bc56424c`, replacing `a7328eed`, under which
  nothing was counted. The 144 launch units and $6,469.26 in leases are unchanged, so nothing is re-priced; the cap
  stays $7,200. The custodian initializes a fresh state directory at this freeze, outside the checkout. The launch
  code is shared, so this tree hashes the public v3 campaigns to `9ce35e3e` and `54c6c44f`. Their launch hashes,
  `1d119581` and `ca729154`, recompute at their launch tree `0518e2fd`, and they render from that tree, as v2
  renders from `4bccbd5a`.
- **Lease settlement (corrects A16).** Three launch attempts at `a7328eed`, the A16 launch and two relaunches, opened
  62 leases in all. Every lease closed at $0 in the runner because no cell made an API call. The VM time, $2.50 in
  total, is in the custodian's ledger. The custodian's manual stop check counts $2.50 spent plus $6,469.26 in leases
  against the $7,200 cap.

**A18 (2026-10-11, before the cells it affects): the LongMemEval-S rerun's VMs were lost; it reruns as v3-s2.**
The two `q1-scoreboard-public-v3-s` shards were healthy at 04:08 UTC: both were still writing gbrain receipts
(9,059 and 9,126), with no deadline errors. At 05:40 UTC the launching host's 6-hour job limit killed both
launchers, and the VM runner's exit handler destroyed both VMs mid-run. This was not a gbrain stall: both cells
were inside their 14-hour limit (7 expected). No rows had been pulled; the 10-minute pulls copy only checkpoints
and snapshots, and neither shard had written one yet. The metering proxy's ledger was lost with the VMs.

- **Spend.** The two leases are abandoned and counted at their full reservation, $35, as spend. The cause is
  recorded on each lease. Nothing from v3-s is reported.
- **Rerun.** The owner approved raising LongMemEval-S's cap from $39 to $74. The two shards rerun unchanged as
  `q1-scoreboard-public-v3-s2`: the same cells and $17.50 leases, a fresh ledger and cap $39. With the lost $35,
  the public rerun stop is about $101 ($2.25 of smokes, $29.07 for v3-m, $35 lost and $35 of v3-s2 leases), up from
  $80, still under the $8,500 program cap. v3-s2 launches from the A17 tree. A17's changes alter only sealed cells:
  a public cell's payload, output path and pulls are unchanged.
- **Launch.** Each launcher now runs as a long-lived detached process, outside any job limit. The reattach watcher
  and the results persist loop run as watched jobs, renewed before each limit, so they keep the host awake.
- **Measured spend on a lost VM.** Every 10 minutes, even while a launcher holds the VM session, the watcher
  (`eval/runner/q1/reattach.ts`, outside the hashed tree) pulls three things into the lease's
  `results/.../progress/`: the metering proxy's live status (committed dollars, forwarded and refused calls), a
  consistent copy of its lease ledger, and the system's receipt count. Each pull also appends a line to
  `progress.ndjson`. The persist loop pushes these files with the rest of the state. A lost VM then still leaves
  spend measured to within one interval. The sealed hash `eefd1799…` is unchanged.

**A19 (2026-10-11, before the cells it affects): ripgrep, the frontier judge's output cap, Opus verdict calls and the
agent-runtime unit; re-frozen for waves 2 to 5.** Wave 1 started at A17 (`eefd1799`). The custodian found two launch
faults there, and the dry runs below, one per system kind, found two more. Wave 1 keeps running at A17. Waves 2 to 5,
the four file-agent units and the frontier backfill run at this freeze.

- **A. The file agent had no grep.** `bootstrap.sh setup` never installed ripgrep, so the file agent's preflight
  refused, and the S1 file-agent unit (`s1.baseline-file-agent.baseline`, wave 1) exited after 10 seconds with no
  answers. A4's LoCoMo dev smoke of the file agent also recorded 0 of 60 answers. That went
  unnoticed because a partial smoke does not fail the batch, and its error text was not kept. Setup now installs ripgrep. This affects the four
  file-agent units ($518.22 in leases: S1 $245.99, S2b $185.75, S2a $60.19, S3 $26.29). The S1 unit relaunches at
  this freeze as a new attempt of the same unit, and its A17 attempt settles at its measured spend.
- **B. The proxy refused the GPT frontier judge.** The harness sends `gpt-6.1-sol` judge calls with
  `max_completion_tokens` 2,000, the floor every OpenAI reasoning model gets (`memory-qa/qa.ts`). The judge route's
  output cap was 1,024, so the proxy refused every GPT frontier judgment. A refused judgment records nothing and
  does not fail the cell, so wave 1's cells are missing the GPT half of the frontier column. A17's dry runs missed it
  for the same reason: their BEAM-1M cell has Opus and canonical judgments but no GPT ones. This preregistration
  gives no judge output allowance, and A3 says output caps exist to bound the harness's own calls, not to change
  them. So the judge request stays as it is, and the judge route's cap rises from 1,024 to 2,048
  (`metering-proxy.ts` `DEFAULT_ROUTE_CAPS`, and the sealed manifest's `output_caps.judge`).
- **C. Opus verdict calls came back empty.** `claude-opus-5-5` takes only its default temperature and always
  thinks. The thinking counts against `max_tokens`, so a 10-token verdict call can stop before any text. The
  harness retries it, and after three attempts records a `judge_error`, never a no. This hit the Opus frontier judge
  on every short verdict:
  - LongMemEval and LoCoMo verdicts: 11 of 51 errors in the public v2 hybrid cell, and 8 of 12 in A17's LoCoMo dry
    run.
  - BEAM's equivalence calls, which score `event_ordering` items (a tenth of BEAM's questions): A17 code judged a
    correct `event_ordering` answer `judge_error` twice out of two. BEAM's 1,024-token rubric calls finished
    normally (80 of 80 in A17's dry runs).

  Claude models that take only their default temperature now get the same 2,000-token floor on calls under 1,024
  tokens. Rubric calls (1,024) and reader calls (2,048) are sent as asked, and the floored allowance enters the
  response cache key. On the same 51 public answers, the floor gave 51 of 51 scored, and the 40 that had scored
  before kept their verdicts (40 of 40). On the two `event_ordering` answers above it gave 2 of 2 scored. The
  canonical judges (`gpt-4o-2024-08-06`, `gpt-4.1-mini`) and every reader request are unchanged.
- **D. The agent-runtime unit never started its runtime.** `s3.ext-agent-runtime.recipe` (wave 4) is an
  in-process cell. Its adapter drives the bundle's own container, but the launch unit neither built that container
  at setup nor brought it up. The adapter also called `docker` as a user whose docker group membership applies
  only to later logins. Its dry run recorded 0 answers: "permission denied while trying to connect to the docker
  API". The unit now sets up and brings up its stack through `bootstrap.sh`, as a shim cell does
  (`setup --system ext-agent-runtime`, then `up` and `down` around the run). The adapter falls back to
  `sudo docker`, as `bootstrap.sh` does. The lease ($27.84) is unchanged.
- **E. Open, not fixed: the agent runtime cannot use GPT-6.1 Sol.** The runtime calls Sol through
  `/v1/chat/completions` with function tools and a reasoning effort. OpenAI refuses that request: "Function tools
  with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions." The runtime's Sol answers are
  therefore `retrieval_error`, and its Opus and Sonnet answers are unaffected. This is the runtime's own request,
  and changing it changes the system under test, so it is left to the program owner before wave 4. The options:
  report the Sol row as the runtime's failure, drop Sol from this cell, or run the runtime's GPT path at effort
  `none`.
- **Request-versus-cap audit.** Output caps bind only harness routes (A3): `harness` → reader 2,048, `judge` →
  judge 2,048 (was 1,024), `agent` → agent 16,000. System slots (`/<kind>/…`, every memory system's own calls,
  including the agent runtime's 64,000-token turns and gbrain's 64,000-token query expansion) are never capped. Every
  model and slot pair the sealed campaign sends:

  | Slot (cap) | Call | Model | Requested output |
  |---|---|---|---:|
  | reader (2,048) | packed, native-default | `claude-opus-5-5`, `claude-sonnet-5-5` | 2,048 |
  | reader (2,048) | packed, native-default | `gpt-6.1-sol` | 2,048 |
  | reader (2,048) | full context | Opus, Sonnet; Sol | 2,048; 2,048 |
  | judge (2,048) | canonical BEAM rubric; equivalence | `gpt-4.1-mini` | 1,024; 10 |
  | judge (2,048) | canonical LoCoMo verdict | `gpt-4o-2024-08-06` | 10 |
  | judge (2,048) | frontier rubric; verdict | `claude-opus-5-5` | 1,024; 2,000 (was 10, C) |
  | judge (2,048) | frontier rubric; verdict | `gpt-6.1-sol` | 2,000; 2,000 (refused at 1,024, B) |
  | agent (16,000) | file agent turns | Opus, Sonnet; Sol | 8,192; 16,000 |
  | system slot (none) | agent runtime turns | Opus, Sonnet | 64,000 |

  B was the only refusal by request size. No other pair asks for more than its cap. The agent runtime's 64,000-token
  Opus turn reserves about $3.05 and the file agent's first Sol turn about $5.52 (the full window). Both fit their
  sealed leases. They exceeded the small dry-run leases, which is why those two dry runs were rerun with larger
  leases.
- **Frontier backfill for wave 1.** `eval/runner/judge-repeat.ts` gains `--frontier <cell judgments.ndjson>`. It
  judges only answers that already have a replicate-0 frontier judgment in that cell log, which is the arm's
  frontier scope, and records under the frontier instrument id (`<instrument>@<judge>`) and the keys the cell would
  have written:
  - **GPT half.** `--judge openai:gpt-6.1-sol --replicates 1 --frontier <log> --judgments <log>` fills it into each
    wave-1 cell's own log.
  - **Opus errors.** `--redo-errors` re-judges only the answers whose Opus frontier judgment is a `judge_error`
    (C). It writes to a separate file, because a cell log never holds two records under one key. Before any wave-1
    frontier figure is published, the render is changed to use a redo record in place of the logged error under the
    same key, and the report says so.
  - **Custody.** The run happens on the custodian's host, against the pulled cell logs in the custody state
    directory. Every answered conversation is sealed, so it requires `GBRAIN_EVALS_CUSTODY_LOG`, `--decision-id` and
    `--purpose`, and it logs the opening. It calls providers directly, outside any proxy route cap, under a budget
    run in the custodian's ledger.
  - **Tested.** On public dev answers it filled 3 of 3 GPT judgments under `beam-1m@openai:gpt-6.1-sol`, a rerun
    skipped all 3, and a redo turned 2 Opus errors into 2 scored without touching the cell log.
  - **Estimate.** Wave 1 has 4,760 frontier items. The 600 in the S1 file-agent unit are judged in-cell when that
    unit reruns, which leaves 4,160 for the backfill. GPT judge calls measured 1,182 input and 124 output tokens on
    average, $0.0042 per call, and a BEAM item takes 4.2 to 5.6 judge calls (event_ordering ×4). That puts the GPT
    half at $73 to $97, about $87. The Opus redo covers at most the roughly 420 `event_ordering` items, at $0.068
    each, so $28 or less. The budget run is capped at $150 and counts against the sealed cap.
- **Dry runs, one per system kind.** Each of the 13 kinds ran a dev copy of its sealed LoCoMo cell from a scratch
  copy of this tree, on its own VM, through the sealed path: sealed payload, VM custody root, output under
  `~/custody/out`, and rows pulled outside the checkout. Each used conversation `conv-44`, one or two questions and
  both frontier judges on every arm. Results:
  - **Full runs.** gbrain-defaults, ext-memory-bank, ext-graph-pipeline, ext-markdown-kb, ext-verbatim-session,
    baseline-recency, baseline-hybrid and baseline-none each finished complete. In each, all three readers
    answered, and every answer has a canonical judgment and both frontier judgments, scored. The proxy refused 0
    requests.
  - **The file agent** answered with all three readers (rg `/usr/bin/rg`), every answer judged by both frontier
    judges.
  - **The agent runtime** answered with Opus and Sonnet (E covers Sol).
  - **Full context** answered 5 of 6. The sixth was an Opus read refused by the $0.95 dry lease, not by any cap.
  - **ext-temporal-graph** finished complete on a $1.50 lease ($0.67). Its first attempt stopped mid-ingest at the
    $0.95 dry lease.
  - **ext-extract-first** (recipe): the whole-conversation ingest used up the $0.95 dry lease after 49 minutes
    ($0.93). Rerun on the first 5 sessions, it finished complete with all three readers and both frontier judges
    ($0.47).
  - **Spend.** $5.31 of API spend across 18 leases, plus $0.89 for the backfill and Opus-floor checks run from the
    host, $6.20 in all. Ubicloud refused 17 VM creates with HTTP 500, and those leases closed at $0 as unstarted.
    Every VM was destroyed.
- **Freeze.** The sealed campaign is re-frozen at hash `a1ff43c577543e5d08382e9e6d719006ca226d0ac95000147399a928c354ed0c`. This hash governs waves 2 to 5 and the four
  file-agent units; wave 1's other 49 units stay at `eefd1799`. The 144 launch units and $6,469.26 in leases are
  unchanged, and the cap stays $7,200. Only `s3.ext-agent-runtime.recipe`'s setup and command change, along with
  `output_caps.judge`. The custodian opens a fresh state directory at this freeze for the A19 units. The custodian's
  manual stop check counts both ledgers, plus the backfill run and VM time, against $7,200. The launch code is
  shared, so this tree hashes v3-s2 to `82adb645` and v3-m to `19f54054`. Each public campaign renders from its launch
  tree: v3-s2 (`f3416937`) from `3532b1aa`, and v3-m (`1d119581`) from `0518e2fd`.

**A20 (2026-10-11, before the cells it affects): temporal-graph and gbrain leases re-priced from wave 1, the
sealed cap at $7,800, and leases raised in place.** Wave 1 showed two cells running past their leases. The owner
raised the sealed cap from $7,200 to $7,800; the $8,500 program cap is unchanged. This freeze replaces A19's
(`a1ff43c5`, never relayed to the custodian) for waves 2 to 5 and the four file-agent units, and carries A19's fixes
A to D unchanged. Wave 1 keeps running at A17 (`eefd1799`).

- **The temporal graph's ingest.** Its common configuration was priced at the shootout's pilot rate, $17.50 per
  million ingested tokens, which nothing had measured. Wave 1 projects $305 a S1 shard against the $200.80 estimate.
  Of that, $8.30 is reading, judging and probes, so ingest costs 1.541 times the pilot rate: $26.97 per million
  tokens (`ingest_usd_per_mtok`, `ext-temporal-graph:common`). Every common cell is re-priced at that rate. The
  recipe configuration keeps its $90 rate, measured on the LoCoMo dev smokes.
  - S1 (10 shards, wave 1): estimate $305 a shard. The lease is $350 a shard, 15% over the projection, because a
    stop mid-ingest wastes the whole shard.
  - S2b (wave 3): $458.55 to $685.83. S2a (wave 5): $50.94 to $69.88. LoCoMo (wave 4): $21.59 to $24.05.
- **gbrain-defaults' S1 lease.** All six wave-1 shards of `s1.gbrain-defaults.shipped-defaults` used up their
  $18.17 leases while reading. All ten shards now lease $27, including the four in wave 2. Under A17, wave 1's
  shards either have their leases raised in place to $27 or resume under A9 on one further $18.17 lease each
  (+$109.02). The report states each cell's actual spend beside its lease. The custodian's dollars-by-slot split
  will say why the estimate was short. Until it does, gbrain's other leases stay at their estimates: S1 full-surface
  $11.38 a shard; S2b $117, $127.67 and $55.27; S2a $55.06 and $57.75; LoCoMo $20.56, $50.37 and $2.07.
- **How the leases are set.** A cell's lease is its estimate per shard. The exception is a cell in
  `LEASE_OVERRIDES` (`eval/runner/q1/cells/definitions.ts`), whose units take the override's amount and recorded
  reason. Only the two S1 cells above have overrides. Waves follow the estimate as before, so no unit moves to a
  different wave.
- **Raising a running lease.** `eval/runner/q1/raise-lease.ts` lives outside the hashed tree and uses only A17's
  code, so wave 1 keeps `eefd1799`. One command raises both ledgers:
  - It grows the lease's reservation in the campaign ledger, refused past the campaign budget, the ledger cap or
    the lease's block cap.
  - Over `ubi-runner ssh`, it raises the VM lease ledger's run budget and cap in one transaction, then reads them
    back.
  - If the VM step fails, the host reservation is given back. Each raise is appended to `<state>/raises.ndjson`.

  The metering proxy reads its run budget and cap from that ledger before every reservation, so a raise binds from
  its next call without a restart. On the A17 proxy, a $0.05 lease refused its fifth call. After a raise to $0.10,
  the same process admitted the next call and refused again at $0.10. A17's `settle` closes a raised sealed lease at
  its measured spend, because the pulled lease summary carries the launch amount it compares with. A17's proxy
  status page still shows the launch amount, so read headroom with `raise-lease.ts show`. This freeze's proxy shows
  the raised lease.
- **Pulls.** `ubi-runner.sh pull` (outside the hashed tree) takes a lock for each VM, and `run` marks the start of
  its final pull. A periodic pull waits out another pull of the same VM, and one that comes after the final pull
  has begun is skipped.
- **Leases and the cap.** The 144 launch units lease $8,298.24 (A19: $6,469.26): wave 1 $5,271.33 at the raised
  leases and waves 2 to 5 $3,026.91. Block estimates and their 1.5x caps: T1 $5,110.48 and $7,665.72; S2b $1,652.17
  and $2,478.26; S2a $475.21 and $712.82; LoCoMo $521.46 and $782.19. Leases pass the $7,800 cap by $498.24, before
  the backfill run (capped at $150) and any A9 resumes. So the campaign finishes only if settled spend comes in that
  far under the leases; the temporal graph's S1 leases alone hold $450 over its projection. If the ledger reaches
  the cap, the preregistered order of cuts applies.
- **Ledgers.** Wave 1 settles in A17's ledger, whose $7,200 limit A17's code enforces. The units at this freeze run
  in a ledger of their own, opened before `init` at $7,800 minus wave 1's committed spend and the backfill
  (`budget-ledger.ts init --program-cap-usd`). Its cap rises with `set-cap` as wave 1 settles under its leases, so
  one hard cap holds the combined spend. A ledger that A17's campaign still settles in is never set above $7,200;
  A17 refuses such a ledger.
- **Freeze.** The sealed campaign is re-frozen at hash `43749abd1ebecd8b8e16b3d9f91401647f27e95f247d65339e7819eaedb1cfb6`
  (159 tree files, 144 units, $8,298.24 in leases, cap $7,800). Only lease amounts, block estimates and caps, and
  the cap change in the manifest. This tree hashes v3-s2 to `ec59937b` and v3-m to `41df787d`. Each public campaign
  still renders from its launch tree.
- **Spend outside the sealed campaign.** About $418: dev smokes $53.75, the stress pilot about
  $6, about $150 of public spend lost under A13, public v2 $107.95, v3 smokes $2.25, v3-m $29.07, v3-s $35 (lost),
  v3-s2 $27.31, and dry runs $7.16. With the $7,800 sealed cap, that is about $8,218 against $8,500.

**A21 (2026-10-11, text only; no cell, lease or hash changes): repeated session ids in LongMemEval-S, and a
sensitivity row.** Thirteen of LongMemEval-S's 500 haystacks list one session id twice: the same turns under two
different dates, and never a gold session. The S loader keeps the dataset's session ids (`corpus.ts` `loadLmeS`).
The source id is a hash of the conversation and the session id, so both copies reach a system under one source id.
The harness writes sessions in event-time order (`sanitize.ts` `ingestPlan`), so the second write is always the
later-dated copy. Each adapter then keeps exactly one copy; none keeps both:

- **gbrain-defaults** refuses the later copy and keeps the earlier one. Its adapter (`eval/systems/gbrain-defaults/shim.py`)
  answers 409 `invalid_request`: "src-… was already written with different content; a conversation is never partly
  re-ingested". gbrain itself is never called for that write. The harness marks the question `ingest_degraded`.
  v3-s2 records that error once in each of the 13, and public v2's gbrain shards show the same error.
- **ext-markdown-kb** and **ext-verbatim-session** overwrite: the later copy replaces the earlier note or drawer
  under the same source id, with the later date. Their adapters' "replaced an earlier …" warning is not kept by the
  harness.
- **baseline-recency** replaces the earlier copy and places the later one as the most recent session.
  **baseline-hybrid** upserts (`ON CONFLICT … DO UPDATE`), keeping the later copy.
- **baseline-none** stores nothing and is unaffected.

In public v2, the five of the 13 inside the 100-question slice (`18bc8abd`, `1d4da289`, `58bf7951`, `c7dc5443`,
`gpt4_76048e76`) ingest with no failed sessions and every row scored, for every slice system. The 13 are:
`001be529`, `18bc8abd`, `1d4da289`, `1e043500`, `58bf7951`, `91b15a6e`, `caf03d32`, `gpt4_76048e76`, `078150f1`,
`c7dc5443`, `d23cf73b`, `gpt4_4929293b` and `gpt4_c27434e8_abs`.

- **No rerun.** LongMemEval is a regression row, the repeated copy is never gold, and 13 of 500 questions are
  affected.
- **Sensitivity rule.** The report publishes each system's LongMemEval-S score on all of its questions: 500 for
  gbrain, 100 for the slice systems. Beside it, a sensitivity row excludes these 13 question ids for every system:
  487 questions for gbrain, 95 for the slice.
- **LongMemEval-M is unaffected.** 449 of its 500 haystacks repeat a session id: 1,178 ids, all with identical turns
  and different dates, none gold. 85 of S5's 100 questions are among them. The M loader already gives every dated
  copy its own occurrence id (`<id>-occ-<i>`, `lmeConversation`), so every system keeps every copy. In v3-m, gbrain
  ingested all 100 conversations, none degraded. M gets no sensitivity row.
- **Follow-up, outside every current freeze.** Give LongMemEval-S the M loader's occurrence ids. This renames every
  LongMemEval-S source id, so it lands with a later public freeze (TODOS, "Data and benchmark fidelity").

**A22 (2026-10-12, before the cells it affects): harness fixes from sealed wave 1, and a re-freeze for waves 2 to 5
and the wave-1 reruns.** Sealed wave 1 closed at $2,819.81 measured. The custodian listed nine gaps. Each one traces
to the harness, not to a system, and no scored output was damaged. This freeze replaces A20's (`43749abd`) for waves
2 to 5, none of which has started, and for every wave-1 rerun. Wave 1's settled units keep their A17 receipts
(`eefd1799`). A19's fixes A to D and A20's leases, pull lock and in-place raises carry over unchanged. The design
choices below were auto-approved under Garry's standing rule, 2026-10-12.

- **1. Safe pulls.** Overlapping pulls damaged four saved stores: gbrain-defaults c1, c4 and c5, and graph-pipeline
  c2. `scripts/ubicloud/ubi-runner.sh` now sits in the hashed tree.
  - Pulls of one VM never overlap (A20's lock).
  - A pull extracts into a scratch directory beside its target. It moves entries into place only when both ends of
    the stream exit 0, so a cut-short pull keeps the previous copy and logs that it did.
  - Before a resume restores a store, it checks every snapshot file's size and sha256 against the values recorded
    when the store was realized. A file that does not match is never restored. The resume then ingests again and
    keeps the checkpoint's answers (`snapshot_check: damaged: <file> does not match the sha256 recorded when <id>
    was realized`).
- **2. Resume by missing answers.** A resume now asks only the questions that have no answer. Before, it asked the
  questions that had no row. When no usable store was pulled, it ingests again and carries the checkpoint's
  answers, judgments and final retrievals into the new realization.
  - Carried records keep their original realization id. The new realization records `carried_from` and how many
    answers, judgments and retrievals it carried.
  - A question that already has a scored answer is never answered again.
  - A reader error below the attempt limit is retried in the same process before the shard ends.
  - `resume --from-campaign <manifest> --from-state <dir>` resumes an A17 or A20 unit at this freeze, from that
    campaign's state.
- **3. Remote cells run detached from ssh.** temporal-graph c8 and c9 lost about 37 hours when an ssh session dropped
  (exit 141).
  - The cell now runs under `setsid` on the VM and writes its log, exit code and pid there.
  - The launcher follows the log with short ssh polls. While the cell keeps running, a lost session is retried every
    15 seconds for up to an hour.
  - If the follow gives up, the lease stays open for `reattach`.
- **4. Pull before destroy.** On a timeout, the runner stops the cell with SIGTERM and waits for its final checkpoint
  and lease summary. It then pulls, and only after that destroys the VM. Under the old order, baseline-hybrid lost
  its rows. The launcher's own backstop moves from 30 minutes to 4 hours past a unit's timeout, so the runner's
  timeout always acts first. A cell with no restored store no longer copies an old `ingest-complete` marker.
- **5. graph-pipeline's store.** The error `Storage exception: Checksum verification failed, the WAL file is
  corrupted` came from the harness's stop.
  - The shim runs as PID 1 with no SIGTERM handler, so every `docker compose stop` ended in SIGKILL after 10 seconds
    (exit 137). The system's graph store cannot reopen after a kill during a write or a checkpoint.
  - On dev fixtures, 13 of 30 forced kills left checkpoint files that fail to reopen with exactly that error, and 11
    tore the WAL, which the system's recovery deletes, silently dropping writes. A SIGKILL on the real stack while
    `.wal.checkpoint` was present reproduced the sealed symptom: `/health` OK, every retrieval failing.
  - The shim now handles SIGTERM. It lets the request in flight finish (up to 300 seconds), cancels leftover tasks,
    and closes every graph and vector engine, which checkpoints the graph. It then exits 0.
    `stop_grace_period: 420s` leaves room for the whole sequence, and `bootstrap.sh snapshot` warns when a container
    still exits 137. Retrieval code is unchanged.
  - Forced probes sent SIGTERM while `.wal.checkpoint` was present. Four of 4 exited 0 in about 3 seconds with a
    clean store and 0 retrieval errors.
  - Four snapshot, restart, snapshot and restore round trips passed with 0 retrieval errors: LoCoMo `conv-44` and
    BEAM-100K `100k-1` keyless, and `100k-1` and BEAM-1M `1m-16` metered. A seed-pinned run was byte-identical
    through restart and both restores. The metered runs differ only by the embedder's run-to-run noise.
  - **Ingest rate.** Ingest measured $2.57 per million tokens on `100k-1` and $3.95 on `1m-16`, by fifth $3.84,
    $3.67, $4.22, $3.90 and $4.10. That confirms the $3.98 assumption. A S1 shard then needs $50.37 at $3.95 and
    $53.34 at $4.22, against a $50.70 lease that held no margin. Running out at the end of a shard is what nine of
    the ten did. The S1 shards now lease $65 (`LEASE_OVERRIDES`). Write time rose from 2.32 to 3.56 hours per
    million tokens across `1m-16`. The schedule takes 3.56, so a S1 shard expects 40 hours (timeout 62) and S2a's
    common cell 8 (timeout 14).
  - The A17 graph-pipeline realizations are not resumed. Their stores were torn at the stop, so their files match
    their recorded sha256 but do not reopen. All ten S1 shards launch as new attempts.
  - Dev spend: $3.95.
- **6. baseline-hybrid.** The index build was not the cause.
  - PGlite 0.4.3 never returns from the checkpoint Postgres requests itself once about 540 MB of WAL builds up. On a
    S1-shaped synthetic load (80,000 sessions from public BEAM-1M dev text), the old code froze at row 21,525 every
    time, early in the third conversation. No timeout could have let it finish.
  - Every write now ends with an explicit `CHECKPOINT`. Sessions are buffered per namespace (256) and embedded 16
    requests at a time, still one session per request. A multi-session request returns different vectors and
    reorders retrieval: 1,805 of 4,064 ranked lists changed on the dev fixtures. Retrieve, delete and finish write
    the buffer first. A batch lost to an embedding failure makes `finishIngest` report `degraded`. The embedder
    retries 429 and 5xx responses, never a budget refusal.
  - The new code ingested all 80,000 rows in 384 seconds of store time. Retrieval is identical with the same
    vectors: 0 of 4,064 ranked lists differ on LoCoMo, BEAM-100K `100k-1` and BEAM-1M `1m-16`.
  - Ingest projects to about 0.9 hours on S1 and the sequential question phase to about 8. The S1 unit now expects
    9 hours (timeout 16, `HOURS_OVERRIDES`). Its lease and the other hybrid units are unchanged. Dev spend: $0.91.
- **7. `COPYFILE_DISABLE=1`** is set for every tar the runner runs.
- **8. Shard messages.** A shard that settles with gaps in its own share exits 4 under the new code `CELL_PARTIAL`:
  "settled with gaps in its share (exit 4); its rows, answers and judgments are kept". The shard log says "shard i/n
  complete for its share" or "incomplete for its share (gaps …)". A shard whose share is complete exits 0.
- **9. A19's and A20's fixes carry over.** `eval/systems/bootstrap.sh` (apart from the 137 warning),
  `eval/runner/metering-proxy.ts` and `eval/runner/memory-qa` are unchanged since A20.
  - Setup installs ripgrep.
  - The judge route's output cap is 2,048 (`output_caps.judge`, `route_classes.judge` in the manifest).
  - Opus verdict calls keep their 2,000-token floor.
- **Dry runs.** Campaigns `q1-scoreboard-a22-dry` and `-dry2` ran on LoCoMo dev conversation `conv-44` with
  stand-in fixtures, on Ubicloud VMs, under a $25 cap.
  - **Forced ssh drop** (markdown-kb). All traffic to the VM was dropped for 240 seconds, starting when
    `ingest-complete` appeared. The launcher logged the lost session and retried. The cell kept running there: its
    snapshot completed and the stack restarted. The lease settled, exit 0, with 60 answers, and its realization was
    recorded with the snapshot's sha256 ($1.65).
  - **Snapshot round trip** (markdown-kb). The resume verified the snapshot against that sha256 and restored the
    store. It asked nothing, because every answer was present ($0).
  - **Damaged snapshot** (markdown-kb). One byte of the pulled tar was flipped. The resume refused it
    (`snapshot_check: damaged`), ingested again, and carried the 60 answers ($0).
  - **Forced timeout and resume by missing answers** (recency, timeout 0.03 hours). Each attempt exited 124 after
    109 seconds and was pulled before its VM was destroyed. Three resumes each re-ingested and carried the earlier
    answers: 18, then 35, then 52, then 60 of 60. The 60 final answers are unique, every carried answer is unchanged,
    and no question was answered twice ($1.97 over four attempts).
  - **graph-pipeline with the new shim** (recipe smoke). The cell ingested, snapshotted with no exit-137 warning,
    restarted, and answered all 60 with 0 retrieval errors ($1.80). For the restore test, two questions'
    answers, judgments, retrievals and contexts were deleted from the pulled checkpoint. A resume on a fresh VM
    then verified the snapshot, restored the store, retrieved 50 items for each of the two questions, and answered
    and judged only those. The receipt is complete with 60 of 60 scored ($0.14).
    - An earlier attempt deleted the same records but left the two frozen contexts. It ended `invalid` ("no
      longer packs to its frozen bytes"), as it should: the restored store ranks a few items differently. The
      harness never writes a context without its retrieval, so a real checkpoint cannot be in that state ($0.14).
  - **baseline-hybrid with the new code** (smoke). 60 of 60 answers scored, exit 0 ($1.68).
  - **Spend.** The Ubicloud dry runs cost $7.39 and the two fixture investigations $4.86, so $12.25 in total
    against the $25 cap.
- **Manifest.** `bun eval/runner/q1/cell.ts plan --campaign-out <file> --sealed-cap-usd 7800` now writes the sealed
  manifest. Run at A20's tree, the same transform reproduces `43749abd`'s manifest byte for byte. Against A20's
  manifest, only these change:
  - the graph-pipeline S1 leases ($50.70 to $65), hours (34 to 40) and timeouts (53 to 62);
  - S1 hybrid's hours (6 to 9) and timeout (11 to 16);
  - S2a graph-pipeline common's hours (7 to 8) and timeout (13 to 14);
  - the executes list, which adds `scripts/ubicloud/ubi-runner.sh`.

  The 144 units lease $8,441.24: wave 1 $5,414.33 and waves 2 to 5 $3,026.91.
- **What runs at this freeze.** Waves 2 to 5 (94 units) and these wave-1 reruns:
  - `s1.ext-graph-pipeline.common.c0` to `c9`: new attempts.
  - `s1.ext-temporal-graph.common.c8` and `c9`: resumes from A17's state.
  - `s1.gbrain-defaults.shipped-defaults.c1`, `c4` and `c5`: resumes from A17's state. Their damaged snapshots are
    refused, so each re-ingests and answers only what is missing.
  - `s1.baseline-recency.baseline`: resume from A17's state, answering only what is missing.
  - `s1.ext-memory-bank.recipe.c1` and `c3`: resumes from A17's state, missing 6 and 2 question-arms. The store is
    restored if its snapshot verifies, and ingested again if not.
  - `s1.baseline-hybrid.baseline`: a new attempt, since nothing was pulled.
  - `s1.baseline-file-agent.baseline`: a new attempt.
  - The frontier backfill run (A19), capped at $150.

  Each A17 attempt these replace settles at its measured spend.
- **Ledger.** The units at this freeze run in a ledger of their own, opened at $7,800 minus wave 1's settled spend
  and the backfill run's cap. A17's and A20's ledgers are not reused.
- **Price.** Against the remaining ~$4,806 (backfill included):

  | Work | Projected | Leases |
  |---|---:|---:|
  | Waves 2 to 5, 94 units (gbrain's four wave-2 S1 shards at their $27 lease) | $3,026.91 | $3,026.91 |
  | graph-pipeline S1, 10 shards at $53.34 | $533.40 | $650.00 |
  | temporal-graph c8 and c9, at A20's $305 a shard | $610.00 | $700.00 |
  | gbrain-defaults c1, c4 and c5, each at its full lease | $81.00 | $81.00 |
  | baseline-recency, the missing 13% of its reading and judging | $7.16 | $55.07 |
  | baseline-hybrid, in full | $95.10 | $95.10 |
  | baseline-file-agent S1, in full | $245.99 | $245.99 |
  | memory-bank c1 and c3, re-ingest bound (about $1 if both snapshots verify) | $40.00 | $55.20 |
  | Frontier backfill (A19: $87 GPT half, at most $28 of Opus redos) | $115.00 | $150.00 |
  | **Total** | **$4,754.56** | **$5,059.27** |

  The projection is $51.44 under the remaining ~$4,806. That is a margin of about 1%, so a temporal-graph shard
  running past $305 or gbrain re-reading more than its share would use it up. The leases pass the remaining cap by
  $253.27, as A20's did. The ledger cap is the hard stop. If the ledger reaches it, the preregistered order of cuts
  applies:
  1. S5 is not in the sealed campaign; it ran publicly as v3-m.
  2. S2a (wave 5, 17 units, $475.21) is cut first.
  3. Then the S2b sweep, the two Sonnet arms at 2k and 16k tokens, which is about $115 of S2b's reading. S2b's
     ingest stays.
  4. Then S3's agent-runtime cell ($27.84).

  T1 is never cut once started, so the wave-1 reruns run in full.
- **Freeze.** The sealed campaign is re-frozen at hash `0c4459fc4a0ea6164cedf14b650b5483c603a21150534be40fe46dbb1a4fe169` (160 tree files, 144 units, $8,441.24 in leases, cap
  $7,800). At this tree, v3-s2 hashes to `ffefe780` and v3-m to `56c60981`. Each public campaign still renders from
  its launch tree.

**A23 (2026-10-25, before the cells it affects): classification of every sealed group-1 failure, harness fixes, and a
re-freeze.** Sealed Q1 measured $4,998.59. The runner ledgers committed more: $2,273.83 under A22 and $2,909.16 under
A17, $5,182.99 together. That left $2,617.01 under the $7,800 cap, and the plan below projects $2,747.37. The owner
raised the sealed cap to $8,000: "raise the cap do everything" (Garry 2026-10-25 via GBRA-108). Q1's $8,500 program
cap is unchanged. That leaves $2,817.01 on the ledger basis, and that is the figure this amendment prices against. Each failure below is either a harness fault, which is fixed and rerun, or the product's own behavior under
its shipped settings, which counts as the product's failure. No external system's own setting (model, chunking,
prompt, vendor concurrency or retry knob) changed to rescue a score. Only limits the harness imposes and bugs in the
harness or in our own shim adapters changed. Each fix has a test that fails on the A22 code and passes on this tree.
The custodian's evidence (status table sha256 `f8bb7127…e467`) settled each classification. The design choices below
were auto-approved under Garry's standing rule, 2026-10-12, apart from item 11, which Garry decided.

- **1. graph-pipeline S1, all ten shards (0 rows): the product's own behavior. Not run, no rerun.**
  - The product opens its graph store with a hard-coded 32 GiB `max_db_size` and keeps it open for the life of the
    process. On public BEAM dev text a checkpoint then fails after about 2,050 turn pairs (about 1.9M tokens) with
    `Maximum database size of 34359738368 bytes has been reached`, and the store never reopens. Every later write and
    retrieval fails with the WAL-checksum error. The product's incremental `cognify` then re-extracts every failed item on
    each call, so the cost per session climbs (keyless, from 2 to about 60 chat calls within 25 sessions).
  - Sealed evidence: on c2, 4,893 of 6,227 sessions failed. Of the first 200, 175 were the product's `CognifyFailedError`
    (`'float' object has no attribute 'replace'`), 23 the WAL-checksum error, 1 the size limit and 1 an
    `AttributeError`; then all 60 retrievals failed on the WAL error. No graph-pipeline log has an exit 137, so the
    corruption came before any stop, and A22's drain is not involved. Six shards spent their $65 lease on ingest.
    c0, c5 and c8 ingested for 62 hours without finishing.
  - Reported as "not run": three of ten shards measured past the 48-hour limit per conversation, and the store's own
    failures account for the rest. The shards settle at their measured spend.
  - Harness change with no effect on this classification: the shim's memory limit rises from 6g to 12g, because the
    container reached 6g about 30 sessions before the failure and left no headroom.
- **2. temporal-graph S1 c8 and c9 (2,418 and 3,036 failed sessions, 120 rows `ingest_degraded`): harness faults.
  Rerun fresh.**
  - c8's first 200 failed sessions were all `RateLimitError` on the shared key's requests-per-minute limit for
    `text-embedding-3-large`. Of c9's first 200, 186 were `socket connection closed unexpectedly`, the metering proxy's
    error for a connection to the provider that closed before any response, and 14 the same rate limit. On both,
    `/finish` failed the same way, so the readiness probe was skipped and every row was degraded.
  - **Key headroom.** Every lease proxy now reads the provider's own rate-limit headers (OpenAI
    `x-ratelimit-*-requests`, Anthropic `anthropic-ratelimit-requests-*`) for each model. They count the whole key, so
    they include every other VM on it. While a model has 5% or less of its limit left, new requests for it wait for
    the reset the provider names. This applies to every system's cells by the same rule, and it changes no system
    setting.
  - **Transport retry.** A request whose connection to the provider fails before any response is sent again, up to
    twice, after 1 and 4 seconds. Each failed attempt is charged at its reservation. A timeout is never retried.
  - A separate shim fault is also fixed. Each request ran on a new handler thread with empty context variables, so
    pydantic rebuilt its generic-class cache on every call and the shim grew about 2.3 MB a session. Keyless under a
    700 MB limit, the old shim was OOM-killed at session 273; the fixed shim held 125 to 129 MB with 0 failed. No
    temporal-graph setting changed.
  - c0 to c7 keep their A17 results.
- **3. Named volumes for every shim store: a harness fault.**
  - memory-bank's Postgres and temporal-graph's Neo4j kept their data in their images' anonymous volumes.
    `bootstrap.sh snapshot` tars only named volumes, so every temporal-graph tar and every A17 memory-bank tar is empty
    (10,240 bytes, 2 entries). A restore started those stores empty.
  - Both compose files now name their volumes. `bootstrap.sh snapshot` refuses a container with an anonymous volume. A
    resume treats a snapshot that lacks a declared volume as `snapshot_check: incomplete` and ingests again. A test
    checks that every Q1 shim system keeps its store in named volumes.
  - temporal-graph never restored in snapshot mode, so no temporal-graph row came from an empty store.
  - memory-bank restored five times: A17 c0-a2, c1-a2 and c3-a2, and A22 c1-a3 and c3-a2. Everything those restores
    produced is harness-invalid: 11 rows and 45 answers, the 3 scored rows and 15 scored answers among them ($3.24).
    S1 memory-bank c0, c1 and c3 rerun fresh. The other seven shards never restored and keep their results.
  - Those three units run with `--fresh-before 2026-10-26T00:00:00Z` (`FRESH_OVERRIDES`). A realization ingested
    before that instant is invalidated, never restored and never carried from, so each conversation is ingested again
    on a named volume and every row and answer is made again. A resumed fresh run carries only from realizations made
    after the freeze, and a unit that is handed a restored snapshot refuses. A test covers each case.
- **4. markdown-kb S1 (c0 timed out at 11 hours): the product's own behavior. Not run, no rerun.**
  - The sealed c0 shard wrote all 6,228 sessions in 9.0 hours with 0 failures. In the 2.7 hours left before its
    timeout it produced no answered row, because the question phase waits for the reindex. The snapshot stop then
    killed the shim (exit 137).
  - The time goes into the product's own `bm reindex` vector reconcile. It runs a DELETE with a correlated subquery
    over a virtual table, so its cost grows with the square of the chunk count. Keyless, 500 sessions took 690
    seconds and 2,000 took 14,078, of which 11,668 were the reconcile.
  - A BEAM-10M conversation (about 216,000 chunks) projects to about 61 hours, past the 48-hour limit per
    conversation, so no harness timeout could rescue it. Reported as "not run (projected ~61 h > 48 h limit)" with
    this measurement. c1 to c9 never start.
- **5. verbatim-session S1 leases: a harness sizing fault.** The estimate assumed 8,000 tokens per native answer, and
  the product averages 11,799 over 220 dev questions. Its judge calls also cost more than modelled. The S1 shards
  lease $19 (`LEASE_OVERRIDES`). All ten have settled, so this changes no spend.
- **6. gbrain full-surface `whole-think` (237 of 600 answers `harness_invalid`): a harness fault. Answered again.**
  - Every S1 full-surface shard committed $11.15 to $11.36 of its $11.38 lease. gbrain asks for `max_tokens` 16,000
    on its think call, so each call reserves about $0.82, and the proxy refused every think call after that with
    HTTP 402. gbrain turns a 402 on an explicitly chosen model into an `ai_config` error. The shim recorded that as
    `harness_invalid` with zero usage in 0.9 to 3.6 seconds, against a 17.7-second median for a scored answer, and
    the cell did not stop.
  - Public repro, keyless and $0, at gbrain `f05943e6`: one PGLite brain, a stub provider that answers 402, and
    `think {model: anthropic:claude-sonnet-5-5}` over MCP. The stub receives one call (`max_tokens` 16,000, no
    retry), and think returns `isError: true` with `reason: ai_config`, the 402 text and no answer. A paid run on
    public BEAM-100K dev `100k-1` answered 9 of 9 with a $7 lease. So this is gbrain's shipped reply to a refused
    provider call, and the refusal came from the harness.
  - Fixes:
    - A proxy refusal of the system's own provider call now records `budget_not_run` and stops the cell.
    - A `harness_invalid` own answer records the system's error code, reason and message in
      `answer-attempts.ndjson`.
    - The think line is re-priced at the measured $0.20 an answer, net of ingest, probes and judging (1.84 times the
      old line), for every set.
    - The S1 full-surface shards lease $20.
    - Their runs carry `--reanswer-invalid-before 2026-10-26T00:00:00Z`, which answers again every
      `harness_invalid` answer recorded before this freeze. Each affected conversation moves to a new realization
      that carries the 363 valid answers and their judgments.
  - Owner's ruling, 2026-10-16: `whole-synthesize` answering with `claude-opus-4-7` is gbrain's shipped default at the
    pin, so it is the product under test. The report notes it beside the row.
- **7. S2b full-context (20 gpt-6.1-sol `reader_error` at $0): a harness lease-sizing fault. Answered again.**
  - The proxy refused all 60 Sol requests on the $1.37 lease (0 forwarded). The request states 2,048 output tokens,
    within the reader cap. The reservation is the byte-count input bound at the long-context cache-write rate: about
    $5.40 for a conversation that fits Sol's window. Two S2b conversations fit, and the estimate had priced the
    average conversation, which fits no reader. A test pins the reservation's arithmetic.
  - The 32,768 in the custodian's reading is the proxy summary's `max_output_tokens`, the allowance it reserves for a
    request that states none. The reader's requests state 2,048 and reserve that, so the output side was not the
    cause: the input bound alone is about four times the lease.
  - Fixes: that refusal records `budget_not_run` and stops the cell, and the lease is $20. The A22 runner recorded
    each refusal as a `reader_error` after three attempts, and a recorded answer is never read again on resume, so
    the unit runs with `--reanswer-invalid-before 2026-10-26T00:00:00Z --reanswer-outcomes reader_error`. That
    answers again every `reader_error` recorded before the freeze and keeps every other answer. The 20 answers are
    about $11 with prompt caching, plus one reservation.
  - No other full-context cell has this shape: S1 fits no reader, and S2a and S3 were priced as fitting.
- **8. S2b gbrain shipped-defaults (exit 2 after ingest, 0 rows, $8.11): a harness fault. Rerun fresh.** The harness
  read each snapshot file whole into memory to sha256 it, and the multi-GB gbrain snapshot failed with `ENOMEM`. Every
  snapshot and realization hash now reads in 8 MiB chunks through one helper (`sha256File` in
  `eval/runner/sealed-confirmation-lib.ts`). That covers the realization recorded on the VM, the check of a pulled
  realization, the resume's check before a restore, and the BEAM-10M push guard. A test hashes a 1 GiB sparse
  realization under a 600 MB address-space limit. The cell leases $160, because gbrain shipped-defaults measured
  about 1.36 times its estimate on S1. S2b common-embedder runs at this freeze too.
- **9. Shim cells longer than one unit's timeout: a harness fault.** A launch unit's timeout never passes 72 hours.
  The schedule had capped every cell at 48 hours, so the S2b graph-pipeline recipe (119 hours of ingest in one VM)
  and temporal-graph common (85 hours) would have been stopped mid-ingest, although each conversation takes about 5
  and 3.5 hours. A shim cell that projects past 72 hours in one VM now runs as conversation shards of at most 48 hours
  each, as S1's shim cells do: graph-pipeline in 3 shards, temporal-graph in 2, and gbrain full-surface and
  common-embedder in 2 each (both had no hours line of their own and take the shim's 4 hours per million). None of
  these cells had started. The campaign has 149 launch units.
- **10. Runner fixes from the move to the custodian's host.**
  - The final pull is retried (`UBI_PULL_TRIES`, default 3). If it still fails, the VM is kept and the runner exits
    253, which `reattach` treats as a kept VM.
  - A push or sync whose tar fails with `Write error` is retried whole (`UBI_PUSH_TRIES`, default 3).
  - A resume records the realization of a lease pulled after it was abandoned, so a kept VM pulled late still
    restores.
  - `campaign.json` names its ledger relative to the checkout, and an absolute path from another host resolves here.
  - An ssh ControlPath longer than 80 characters moves under `/tmp/ubi-ctl-<uid>/`, inside the 104-byte socket limit.
  - A pull runs in its own process group. An interrupted pull kills the whole group and removes its scratch
    directory and lock.
  - `bootstrap.sh snapshot` warns when a container exited before the snapshot, and tells an OOM kill apart from the
    end of the stop grace period.
  - Real-VM dry run: a forced pull failure exited 253 with the VM kept and no scratch left. A later pull returned
    400 MB intact, and the VM was destroyed.
- **11. Readiness probe (Garry 2026-10-17 via GBRA-108: rec).** verbatim-session c1 was `ingest_degraded` with 0 failed
  sessions. The probe searched for the opening of the last session's longest turn, which can start deep in the
  session. The custodian measured c1's missed probe starting at wordpiece 1,387 of a 2,648-wordpiece session, and
  another miss at 1,125. The 19 found probes started at wordpieces 23 to 46. c5's miss started at 1,294, and its found
  probes at 22 to 132. The product's embedder reads about 256 wordpieces, so a retrieval miss was being reported as an
  ingest failure.
  - The probe now opens the longest turn that starts within the session's first 800 characters. It still proves the
    last session landed, and it no longer measures retrieval depth. The change applies to every system.
  - The decision applies from this freeze on. Rows settled before it keep the degraded flag their receipts record,
    and nothing is recomputed. The report footnotes verbatim-session c1 and c5, and every other settled conversation
    flagged by a probe miss with 0 failed sessions, naming this change and the embedder-window explanation.
- **Dry runs.** About $13.30 in all against the $40 cap: graph-pipeline $1.16, temporal-graph at most $6.64, gbrain
  think $2.63, verbatim $2.85, and the runner's real-VM dry run, which cost pennies. The think repro above cost $0.
- **What runs at this freeze.**
  - T1:
    - temporal-graph c8 and c9, fresh;
    - memory-bank c0, c1 and c3, fresh;
    - the 237 think answers on the ten full-surface shards;
    - gbrain shipped-defaults c4 and c5, with 5 and 14 answers still missing.
  - S2b:
    - the 20 Sol full-context answers;
    - shipped-defaults, fresh;
    - full-surface and common-embedder, 2 shards each;
    - graph-pipeline recipe, 3 shards;
    - temporal-graph common, 2 shards;
    - markdown-kb recipe.
  - S2a (17 units) and S3 (28 units).
  - The frontier backfill (A19), unless it has already run.
- **Price.** Each line is projected from measured spend where the campaign has it:
  - temporal-graph at its highest A17 shard rate;
  - think at its measured rate;
  - gbrain shipped-defaults at 1.36 times its estimate;
  - other kinds at the highest ratio their settled units reached against their leases: recency 1.18, hybrid 1.69,
    file agent 1.12, verbatim 1.24 (S2b), none 0.24, extract-first 0.99, memory-bank 1.01, and the rest 1.0.

  | Work | Projected | Leases |
  |---|---:|---:|
  | temporal-graph S1 c8 and c9, at the highest A17 shard ($186.09) | $372.18 | $700.00 |
  | memory-bank S1 c0, c1 and c3, at the highest A17 shard ($27.91) | $83.73 | $96.00 |
  | gbrain full-surface S1, 237 think answers, re-ingest bound | $90.17 | $200.00 |
  | gbrain shipped-defaults S1 c4 and c5, 19 answers, re-ingest bound | $7.15 | $54.00 |
  | S2b, 12 units | $1,010.94 | $1,260.10 |
  | S2a, 17 units (wave 5) | $513.32 | $499.63 |
  | S3, 28 units | $554.88 | $555.09 |
  | Frontier backfill (A19), if not yet run | $115.00 | $150.00 |
  | **Total** | **$2,747.37** | **$3,514.82** |

  The projection is $69.64 (about 2.5%) under the remaining $2,817.01. Against the $7,800 cap it was $130.36 over,
  and the preregistered cuts would have removed S2a first. The owner raised the cap instead, so the full plan runs
  and no cut is applied. Any projected overrun past $8,000 on the ledger basis stops and goes back to the owner
  through GBRA-108 before it is spent. The ledger cap stays the hard stop.
- **Ledger.** The units at this freeze run in a ledger of their own. A22's ledger takes no new lease and keeps its
  $4,826.81 cap, and A17's ledger is never set above $7,200.
  - The custodian runs `shootout-cell.ts init` for this freeze in a fresh state directory, which creates the ledger at
    the manifest's $8,000 and opens the campaign run.
  - Before any reservation, `budget-ledger.ts set-cap` lowers it to $8,000 minus what the A17 and A22 ledgers have
    committed, minus the backfill run's cap (or its committed spend once it has run). At the A23 evidence that is
    $8,000 - $2,909.16 - $2,273.83 - $150 = $2,667.01, against $2,632.37 projected for this freeze's units.
  - When A17 or A22 leases settle under their reservations, `set-cap` raises the cap to the same formula and never
    above it, so one hard cap holds the combined sealed spend at $8,000.
- **Freeze.** The sealed campaign is re-frozen at hash
  `b13010e1cdab897aab7143231ae005f040c3e19c06dcd8f9210963478ae6bd95` (160 tree files, 149 units, $8,855.86 in leases,
  cap $8,000). This replaces A22's `0c4459fc` for every unit that runs from here. Settled units keep their A17 and
  A22 receipts. At this tree, v3-s2 hashes to `5417b675` and v3-m to `0459384e`. Each public campaign still renders
  from its launch tree.

**A24 (2026-10-26, before the cells it affects): two A23 harness faults, fixed in place, and a re-freeze.** The
custodian's first A23 resumes found two harness faults. Both units stopped before any billed call ($0), and no
record was lost. The fixes keep the 363 valid think answers rather than rerunning those conversations fresh. The price
is unchanged: the re-answers involved (about $108) are already in A23's plan, and the cap and ledger formula stay as
A23 set them. Each fix has a test that fails on the A23 code and passes on this tree.

- **1. A resume refused its own configuration (`RESUME_REFUSED … holds a different configuration`).**
  `runConfigText` (`eval/runner/q1/cell.ts`) wrote the whole cell definition except `estimate` and `arms` into the
  arm's configuration identity, launch-control fields included. A23's new `lease` and `reanswer_invalid_before` on
  `s1.gbrain-defaults.full-surface` and `s2b.baseline-full-context.baseline` therefore no longer matched the
  restored A22 `run-config.json`, and the run stopped.
  - Launch-control fields (`lease`, `reanswer_invalid_before` with its outcomes, `fresh_before`, `shards`,
    `expected_hours`, `snapshot_command`, `restore_command`) are no longer part of the identity. They decide how a
    unit is leased, laid out and resumed, not what the cell measures.
  - Both sides of the comparison drop them, so a file written at A22 or at A23 (with the fields) resumes under this
    freeze, and the units that started at A23 resume cleanly. A written `run-config.json` is kept byte for byte, so
    every `config_sha256` already published stays valid.
  - A change to what the cell measures (an arm, a reader, a budget, the effort, the dataset) is still refused.
- **2. The 19 "missing" shipped-defaults answers on S1 c4 and c5 are recorded `harness_invalid` answers** in the
  component-b8000 arm. A resume counts a recorded answer as answered, and A23's unit carried no reanswer flag, so it
  would have skipped them. `s1.gbrain-defaults.shipped-defaults` now runs with
  `--reanswer-invalid-before 2026-10-26T00:00:00Z --reanswer-outcomes harness_invalid`.
  - Every other unit the A23 price counts as answering again or rerunning fresh was checked, and a test pins each
    flag: the full-surface think answers, the S2b full-context `reader_error` answers, memory-bank c0, c1 and c3.
    temporal-graph c8 and c9, priced as fresh reruns, now also carry `--fresh-before 2026-10-26T00:00:00Z`. Their A17
    realizations hold 120 `ingest_degraded` rows, a final outcome a resume would otherwise carry; a unit already
    ingesting after the freeze keeps its own realization.
- **Ledger.** A24 units run in a ledger of their own, because a state directory frozen at another hash refuses to
  launch. The custodian runs `shootout-cell.ts init` for this freeze in a fresh state directory, then, before any
  reservation, `set-cap` to $8,000 minus what the A17, A22 and A23 ledgers have committed, minus the backfill run's
  cap (or its committed spend once it has run). The A17 ledger is never set above $7,200, and the A22 and A23 ledgers
  take no new lease. As their leases settle under their reservations, `set-cap` raises the A24 cap to the same
  formula and never above it.
- **Freeze.** The sealed campaign is re-frozen at hash
  `a92b06c59ceb0c635c125147263eeacef2b47a88a558def6c8dafef18de987ea` (160 tree files, 149 units, $8,855.86 in leases,
  cap $8,000). This replaces A23's `b13010e1` for every unit that runs from here, including the A23 units that
  resume. At this tree, v3-s2 hashes to `0ecb4a09` and v3-m to `8ac8642b`. Each public campaign still renders from
  its launch tree.

## Changelog

### 2026-10-27: render rulings after the sealed campaign settled (no re-freeze)

The sealed campaign settled: 149 launch units, 114 complete, 8 partial and 27 not run, $7,034.32 on the campaign
ledgers against the $8,000 cap, of which $6,729.26 is measured ($6,626.00 across the four freezes' cells plus $103.26
for the A19 frontier-judge backfill). These rulings are recorded outside the hashed tree; the sealed
campaign stays at `a92b06c5`, and no cell's configuration changes. They replace the 2026-10-26 drafts and interim
figures below.

- **Per-cell not-run reasons.** `publication.json` `not_run` gives each cell that did not run its own reason, used in
  place of the config-wide one: graph-pipeline S1 and markdown-kb S1 as A23 classified them; markdown-kb S2b "projected
  about 60 h > cell wall clock on the pinned VM" (its local reindex embeds about 2.5 hours per conversation on the
  pinned VM, 8 of 24 conversations finished in the 22-hour wall clock, $0 spent; the product's behavior, which
  overrides the custodian log's "harness limit" wording); verbatim-session common on S2a and S3 "the harness has no
  common-config adapter for this system at this freeze (diagnostic config only)", a harness gap, whose adapter goes on
  the F6 list.
- **S2b full-surface `whole-think`: 10 gpt-6.1-sol `harness_invalid` answers are product failures.** Each stopped at
  exactly 4,000 output tokens on c0 or c1. That is `gbrain think`'s own output limit at the pin for a model outside its
  reasoning-model list (`maxOutputTokensFor`: 16,000 for Claude 5, Claude 4.x, gpt-5, the o-series and recipes that
  declare thinking by default; 4,000 otherwise), and gbrain's own path flags the stop `output_truncated`; the shim
  records any status other than an answer as `harness_invalid`. Under the owner's rule (gbrain's own limit, flagged by
  its own path, is product behavior; attributed from that code, the custodian's count of 10 stops at exactly 4,000
  output tokens and a $0 repro of the limit, since the pulled lease logs do not keep the shim's status field), they
  render as product failures, scored 0 and kept in the denominator
  (`product_outcomes`, refused at any other count), with a footnote. They are not grouped with the shipped-defaults
  answers below. gbrain #7421 (2026-10-24, after the pin) extends the 16,000-token limit to OpenAI reasoning models
  from gpt-5 to gpt-9.
- **shipped-defaults S1: the 10 `harness_invalid` answers.** The view `a24-shipped-defaults-harness-invalid` (set S1)
  names its questions by `from_outcomes` (the 8k component arm's `harness_invalid` answers, count 10), and the
  custodian's assembly derives the ids from the sealed answers, so no sealed id is written by hand. The footnote
  carries the custodian's trace of the 10 A22 retrievals behind them.
- **Frontier-judge column.** Agreement is reported per cell and pooled per system on the answers each frontier judge
  scored, with its coverage: 1,960 of 2,140 gpt-6.1-sol frontier judgments (the frozen tool does not judge the 180
  temporal-graph `ingest_degraded` answers) and 194 of 214 Opus redos (2 remain `judge_error`, 18 fall outside a
  published arm). A redo replaces the logged record under the same key and may never hold a canonical judgment.
- **S3 rows.** file-agent's 23 gpt-6.1-sol `reader_error` answers are harness failures. The agent runtime's 200
  gpt-6.1-sol `retrieval_error` answers stand as the runtime's failure (A19, item E): no alternative ran.
- **Receipt.** Every render writes `SHA256SUMS`, with one line per public render target, and its hash is the public
  commitment. `scoreboard.ts check --commit <commit>` reads the published receipt at that results-branch commit and
  refuses a `SHA256SUMS` hash other than the one `publication.json` records; `check --sums <file>` checks the committed
  public tables against it without the receipt, and `check --custody` checks the full receipt where it lives, without
  the size budget. Public files print exclusions as counts by reason, and the renderer refuses a public file that would
  print a sealed set's question id (`publish.ts` marks each held-out set `sealed`). What the results branch receives,
  the full receipt or the aggregates and this commitment, is the owner's call.

### 2026-10-26: publication rulings after A24 (no re-freeze)

Three publication notes, recorded outside the hashed tree. The sealed campaign stays at `a92b06c5`, and no cell's
configuration changes.

- **temporal-graph: option 1** (GBRA-108 2026-10-26, under Garry's "don't bother me, do what makes sense"). The pinned
  `ext-temporal-graph` configuration's reranker and ingest model were retired by their provider, so its calls fail.
  We don't change a competitor's settings, so the configuration stays as pinned and no model is substituted.
  - Every temporal-graph cell that did not settle before the retirement is reported "not run: pinned config calls a
    model its provider retired". The custodian launches no temporal-graph unit from here, S2a and S3 included.
  - The S1 row, with its S1-sweep arms, is shown on the 8 conversations A17 measured validly: c0-c7 (`10m-1`,
    `10m-10`, `10m-2` to `10m-7`). c8 and c9 are not merged. Its comparisons on that subset are descriptive and
    never claim: 8 conversations is under S1's minimum of 9, and the renderer refuses a claim on any subset row.
  - Every system gets a sensitivity row on the same 8 conversations, on S1 and S1-sweep, so the temporal-graph row
    can be read against the rest. The headline rows keep all 10 conversations.
  - temporal-graph is retested at its current release in the follow-up current-master rerun (F6).
  - `publication.json` `retired` records the system, the reason, the cell and the shards. `scoreboard.ts` refuses a
    receipt where a temporal-graph cell on S1 or S1-sweep is off that subset, where any other temporal-graph cell
    that did not run lacks the reason, or where either set lacks the 8-conversation view.
- **shipped-defaults: 10 `harness_invalid` answers (footnote draft).** In S1 shipped-defaults' 8k component arm, 10
  answers (5 on each of c4 and c5), 0.4% of the row's answers, are recorded `harness_invalid`. They failed at 0 ms
  with no usage under A22, and the A24 re-answer carried them forward under their earlier realization instead of
  answering them again. A harness failure already leaves its question out of that row's mean. An exclusion
  sensitivity row (`a24-shipped-defaults-harness-invalid`, set S1) shows every system without those questions; its
  question ids are added when the sealed receipt is assembled. The cause is under diagnosis, and its fix goes into a
  future freeze, not this one.
- **S2b full-context pricing (footnote draft).** A23 priced each gpt-6.1-sol whole-history reading's reservation at
  about $5.40 from its token estimate, but the metering proxy reserves the request's byte count as input tokens,
  about $19.29 a call, so the $20 lease admitted one reading at a time. The custodian raised the lease to $110 inside
  the A24 cap and resumed: about $4.46 an answer, about $89 for the 20, against about $11 projected. These are interim
  figures; the settled ledger figures replace them in the receipt's disclosure and the report when they render.

### 2026-10-26: amendment A24

Two A23 harness faults, both caught at $0 with no record lost, are fixed in place. A resume no longer counts
launch-control fields (lease, reanswer and fresh flags, VM layout) as part of a cell's configuration, on either side
of the comparison, so A22 and A23 run-configs resume. S1 shipped-defaults c4 and c5 answer their 19 recorded
`harness_invalid` answers again, and temporal-graph c8 and c9 carry the fresh flag their price assumed. The price and
the cap are unchanged. Re-frozen at `a92b06c5`, 149 units.

### 2026-10-25: amendment A23

Every sealed group-1 failure is classified. graph-pipeline S1 and markdown-kb S1 are the products' own behavior and
are reported as not run. The rest are harness faults, fixed and rerun:
- temporal-graph c8 and c9 (key headroom and transport retry in the proxy);
- memory-bank's snapshots (named volumes; 11 rows and 45 answers invalid, c0, c1 and c3 fresh);
- whole-think's 237 answers (lease refusals, re-answered);
- S2b full-context (lease; its 20 `reader_error` answers read again);
- S2b shipped-defaults (streamed snapshot hash);
- S2b's long shim cells (sharded under the 72-hour unit limit);
- six runner faults from the host move.

The readiness probe uses an early passage from this freeze on (Garry 2026-10-17 via GBRA-108: rec). Re-frozen at
`b13010e1`, 149 units. The projection of $2,747.37 was over the remaining $2,617.01, so the owner raised the sealed cap
from $7,800 to $8,000: "raise the cap do everything" (Garry 2026-10-25 via GBRA-108). The full plan runs, S2a
included, with $2,817.01 left on the ledger basis; no cut is applied. Any projected overrun past $8,000 stops and goes
back to GBRA-108 before it is spent. Q1's $8,500 program cap is unchanged.

### 2026-10-12: amendment A22

Sealed wave 1 closed at $2,819.81, and the nine harness gaps it showed are fixed:
- Pulls are atomic, and a resume checks each snapshot's sha256 before restoring it.
- A resume answers only questions without an answer and carries every scored answer across a re-ingest.
- Remote cells run detached from ssh, and a timeout pulls before it destroys the VM.
- The graph pipeline's shim checkpoints its store on SIGTERM instead of being killed mid-write.
- The plain hybrid baseline no longer hangs at PGlite's WAL checkpoint, and it embeds 16 sessions at a time.
- `COPYFILE_DISABLE` is set for every tar.
- A shard that settles with gaps says so under `CELL_PARTIAL`.

Each fix was dry-run on `conv-44` with stand-in fixtures for $12.25. The graph pipeline's S1 shards lease $65 from
its measured ingest. Re-frozen at `0c4459fc` for waves 2 to 5 and the wave-1 reruns, replacing A20's `43749abd`; wave 1's
settled units keep `eefd1799`. Projected spend is $4,754.56 against the remaining ~$4,806.

### 2026-10-11: amendment A21

Text only. Thirteen LongMemEval-S haystacks repeat a session id under two dates. Under one source id, gbrain's
adapter refuses the later copy, while markdown-kb, verbatim-session, recency and hybrid keep it; baseline-none
stores nothing. No rerun. The report adds a sensitivity row that excludes the 13 for every system. LongMemEval-M
already keeps each dated copy distinct. Giving LongMemEval-S occurrence ids is a follow-up for a later public freeze.

### 2026-10-11: amendment A20

The owner raised the sealed cap to $7,800. Wave 1 showed the temporal graph's ingest at 1.541 times its pilot rate,
and gbrain's S1 shards used up their $18.17 leases while reading. The temporal graph's common cells are re-priced at
the measured rate; its S1 shards lease $350 and gbrain's S1 shards $27. A running lease can now be raised in place
on both ledgers without a proxy restart (`raise-lease.ts`, outside the hashed tree), and pulls of one VM no longer
overlap. Re-frozen at `43749abd` for waves 2 to 5 and the four file-agent units, replacing A19's `a1ff43c5`, which
was never relayed. Wave 1 stays at `eefd1799`.

### 2026-10-11: amendment A19

Re-frozen for waves 2 to 5 at `a1ff43c5`. Wave 1 keeps running at `eefd1799`. Four faults are fixed:
- Setup installs ripgrep for the file agent.
- The judge route's output cap rises to 2,048, so the GPT frontier judge's 2,000-token request is no longer refused.
- Opus verdict calls get the 2,000-token floor, so they no longer come back empty.
- The agent-runtime unit brings up its own container.

The agent runtime's GPT-6.1 Sol request, which OpenAI refuses, is left to the owner. Wave 1's frontier column is
backfilled from stored answers on the custodian's host: about $87 for the GPT half and up to $28 for Opus redos, with
a $150 budget run. One dry run per system kind passed. Leases are unchanged.

### 2026-10-11: amendment A18

The LongMemEval-S v3 shards were destroyed at 05:40 UTC when the launching host's 6-hour job limit killed their
launchers (not a gbrain stall). The two leases are counted at their full $35. The shards rerun as
`q1-scoreboard-public-v3-s2` (hash `f3416937`, cap $39; LongMemEval-S $74 in all), with detached launchers and
10-minute pulls of the proxy's status, ledger and receipt counts. The sealed hash `eefd1799` is unchanged.

### 2026-10-11: amendment A17

Two sealed launch-path faults are fixed: BEAM-10M is now pushed from the custodian's host and checked against the
manifest on both ends, and a Q1 sealed cell runs with a VM custody root and access log, writes outside the checkout
and is pulled only into a state directory outside the repository. Doctor gains the `s1-corpus`, `sealed-payload` and
`sealed-out` checks. Sealed hash `eefd1799` replaces `a7328eed`; leases are unchanged. A16's lease settlement is
corrected: 62 leases over three attempts, $0 API spend, $2.50 of VM time in the custodian's ledger.

### 2026-10-11: amendment A16

Wave 1's first sealed launch was interrupted during the checkout upload (SIGHUP from a launcher restart): no cell
started, no sealed file opened, $0 API spend, 32 leases settled at VM cost; relaunch on the same freeze. The D8
reserve's hash-list SHA (`a14e55ce`) is recorded.

### 2026-10-10: amendment A15

The six public gbrain-defaults shards rerun at A14's pin `f05943e6`, so the public and sealed gbrain rows name one
version; the `7aa2caa0` rows move to a found-and-fixed appendix. LongMemEval-M runs as `q1-scoreboard-public-v3-m`
(hash `1d119581`) and LongMemEval-S as `q1-scoreboard-public-v3-s` (hash `ca729154`, after the stop was raised to
$80); the sealed hash `a7328eed` is unchanged.

### 2026-10-09: amendment A14

gbrain moves to master `f05943e6` (0.60.138.0), which fixes the serve hang and the verbatim misses; the stress pilot
rechecked (PGLite stands); sealed re-frozen (hash `a7328eed`). Public-v2 stays at `7aa2caa0` and renders from its launch
tree `4bccbd5a`. BEAM-1M sealed per-question rows publish under D2 now that Q2's decision is recorded.

### 2026-10-09: amendments A12 and A13

The gbrain read classifier stops misreading identity-tier confidence grades (sealed re-frozen); the public results
were lost with the launching machine's storage, so every public cell reruns as `q1-scoreboard-public-v2`, with state
pushed to `evals/q1-scoreboard-results` as it runs. Sealed re-frozen at `274bf9f6` (hash `99069170`).

### 2026-10-09: amendment A11

A false leak tripwire (a hex question id inside a hashed source id) and an unbounded shim write to a stalled gbrain
serve fixed; sealed campaign re-frozen at `c0b68a7f` (hash `c39f267c`); S5 reruns as `q1-scoreboard-public-r5`.

### 2026-10-09: amendment A10

Three public cells that outran their time limits rerun in haystack shards as `q1-scoreboard-public-r4`.

### 2026-10-08: amendments A8 and A9

Reader dates follow parsed event time (LongMemEval prompts byte-identical); gbrain-evals main (v0.10.46) merged before
the re-freeze; the verbatim-session shim's open-file limit raised and its two public cells rerun as
`q1-scoreboard-public-r2`. Freeze commit `cb6119cc`; sealed hash `9bf88a3f`; public-r2 hash `8da287a4`; the public
campaign keeps its launch hash `52757aab`.

### 2026-10-08: LongMemEval-M launches as public

The launcher's list of public benchmarks left out LongMemEval-M, so its S5 cells, already marked public in the
campaign, asked for the custodian's host. The launcher (`eval/runner/scoreboard-cli.ts`, outside the hashed tree)
now lists it; the campaign hashes do not change. The launcher's default state directory moves to
`eval/reports/scoreboard/<campaign>/state`, and doctor refuses a state directory whose `campaign.json` would sit
where the budget ledger looks for a legacy ledger file (the first public launch stopped there before any lease).

### 2026-10-08: amendment A7

Freeze commit `9ed3612c`; campaign hashes `f7278f3b` sealed and `52757aab` public. BEAM-10M manifest hashes and
structure findings; undated sessions inside a dated conversation take the sanitizer's
per-session rule; reordered anchors and the oversized session disclosed; usage normalizer, memory-bank `shm_size` and
gbrain background closure ported from gbrain-evals#89; that thread's sealed LoCoMo and BEAM-100K batch disclosed.

### 2026-10-08: frozen

Freeze checklist filled: gbrain `7aa2caa0`, resolved configuration hash, two campaign hashes and caps, images, engine,
calibration, cell manifest, sweep subset rule, Family 1 comparators, hedge classifier none.

### 2026-10-08: amendment A6

The hedge classifier missed its validation bar three times; the confident-error column is not published.

### 2026-10-08: hedge verdicts at render time

Cells no longer stamp a hedge verdict; the scoreboard computes it at render time with the classifier version the
campaign names, so the classifier leaves the cell's executed tree.

### 2026-10-08: amendment A5

Plan lines reset at the re-price; the graph pipeline runs its common setup on BEAM-10M.

### 2026-10-07: amendment A4

Settings from the dev smokes: reader calibration with a stated tolerance, the LongMemEval probe cap, the shrink-rule
ranking, BEAM-10M ingest projections and the graph pipeline's S1 switch to common.

### 2026-10-07: derived columns

Draft edit before freeze: the confident-error rate and the "I don't know" column (correct and false abstention)
join the report as descriptive columns, with the `hedge-v1` classifier and its validation procedure.

### 2026-10-07: amendments A1 and A2

Readers drop to Opus 5.5, GPT-6.1 Sol and Sonnet 5.5 (Fable smoke-only, program rule); the fresh held-out reserve is
recorded; output caps bind only harness calls (A3).

### 2026-10-06: shipped-behavior fallbacks, the full-surface cell

Draft edits before freeze, from the keyless full-scale rehearsal (28 of 220 BEAM queries reported
`redaction_unmapped` and 12 `no_text_chunks`). The engine rule now names the two shipped-behavior delivery fallbacks
that never count against PGLite and are never a harness failure. `synthesize` answers are recorded under
`own:<resolved model>`, and `think` runs in its own cell on a full-surface stack.

### 2026-10-06: draft

First draft, from the approved Q1 plan. It records the BEAM-10M exposure audit (question `1_abstention_0` excluded)
and the custody rule for BEAM-1M rows while Q2's decision is open. Values marked OPEN are filled at freeze.
