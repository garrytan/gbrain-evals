# Preregistration: the head-to-head memory scoreboard (2026-10-06)

**Status: draft.** The design below is fixed. A few values are still open and are marked OPEN: the frozen gbrain
commit, the campaign hash, the power-simulation result, the engine rule's measured inputs and the per-reader token
calibration. They are filled by the freezing commit, before any counted cell reserves a lease. After the first counted
cell runs, nothing here changes; a later change is a dated amendment at the end of this file, written before any cell
it affects. Changes to a bar or a family need the program owner's approval first.

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
reranker, expansion, embedder, internal models) is published beside its hash. OPEN: frozen gbrain commit (gbrain
master on the freeze date).

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

  Sessions over 24,000 tokens are counted and reported.
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
- **Per answer.** `answers.ndjson` stores `hedge` (verdict and classifier version) and `delivered_tokens` (the packed
  context's per-tokenizer counts on component arms, the reader's total input tokens on whole-system arms).
  `bun eval/runner/scoreboard.ts check` recomputes every verdict from the stored text and fails on a mismatch.
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
- **Power rule.** OPEN: the simulated minimum detectable difference. If it exceeds 10 points for most Family 1
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

- OPEN: gbrain commit; campaign hash, covering the git tree of every executed file and images by digest; resolved
  gbrain configuration and its hash; power result; engine rule inputs; token calibration factors; the cell manifest
  and its re-priced total; the S1 subset ids; Family 1 membership if shrunk; the hedge classifier's dev-smoke
  validation.

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

## Changelog

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
