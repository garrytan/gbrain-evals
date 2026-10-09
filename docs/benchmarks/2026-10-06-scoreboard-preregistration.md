# Preregistration: the head-to-head memory scoreboard (2026-10-06)

**Status: frozen on 2026-10-08** at gbrain-evals commit `cb6119cc3f2279f693945262621b2b318b02a550` (after A8 and A9), before any counted
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
reranker, expansion, embedder, internal models) is published beside its hash. Frozen gbrain commit: `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802`
(master on 2026-10-08, 0.60.106.0).

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

- **gbrain:** `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802` (0.60.106.0), installed in the `gbrain-defaults` image.
  Resolved configuration hash `415dafe5ada70e8ba2ba72126a1af950a04eaab31aec0da4b7cf09f43186ccab` (config file
  `6349524a…0554`, starter tool list `08403fb2…483c58d`): PGLite, `voyage:voyage-4` at 1,024 dimensions, `tokenmax`
  search, `voyage:rerank-2.5`, query expansion on (`claude-haiku-4-5`), `synthesize` and `think` on `claude-opus-4-7`.
- **Campaigns** (`2026-10-06-scoreboard/campaign/`), each hash covering the manifest, the git tree of every file a
  cell executes (159 files at the A9 tree) and the pinned images:
  - `q1-scoreboard-sealed`: S1, BEAM-100K and BEAM-1M sealed, and LoCoMo; 144 launch units; cap $7,200; launched
    from the custodian's host. Hash `9bf88a3f4bb968cc6537abd9f8c0d15e6d5dbecc68470d39d8725521ea40b857`.
  - `q1-scoreboard-public`: LongMemEval-S and -M; 12 launch units; cap $500. Hash
    `52757aab6762ddb7c846fdb8bb5943d98e7aecf1cd7f164dc1acda8e65a5b7e2` at its launch tree (`a22e3d81`, 156 files); it
    renders from that tree (A8).
  - `q1-scoreboard-public-r2`: the two verbatim-session reruns (A9); cap $20. Hash
    `8da287a424a121e2039ff184ab22b493b642082b25c31f86948538ba27ae9d35`.
  - `q1-scoreboard-public-r3`: the S5 verbatim-session rerun with a $13 lease (A9); cap $15. Hash
    `35a0aa45430b8d24f3c4f6424b91102126003130023fe28c25d6572c7096f92a`.
  The four caps plus the $60 spent on the stress pilot and dev smokes stay under the $8,500 program cap.
- **Images:** every upstream image each bundle pulls or builds on, in each campaign's `images` map by bare `sha256`
  digest keyed by bundle (the full references live in the bundles beside `docs/comparison-systems.md`); images the
  bundles build are covered by their Dockerfiles and lockfiles in the hashed tree.
- **Engine:** PGLite (rule result, rechecked at the freeze commit).
- **Token calibration:** Opus 5.5 1.4708 and Sonnet 5.5 1.4524 times `cl100k_base`; GPT-6.1 Sol 1.0009 times
  `o200k_base` (A4).
- **Cell manifest:** `eval/runner/q1/cells/q1-cells.json`, $6,732 in cells (A5 lines).
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
of its hash list: OPEN (relayed by the program owner when minting finishes).

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
baselines' estimate); it resumes from its ingest realization for the missing question. The S5 cell's dataset
download failed in setup before its command ran (closed at $0); it reruns as `q1-scoreboard-public-r3` with a $13
lease and a $15 cap. The sealed campaign's verbatim-session leases are not changed by this; a sealed cell that runs
out of lease is reported partial and resumed under the same rule.

## Changelog

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
