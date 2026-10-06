# Workload suites for the memory proof wave (B1 to B4)

Four seeded question sets test what an agent memory does with ordinary chat: recall a detail mentioned once, apply a correction, track how relationships change over time, and keep track of who believes what. Each suite generates the same raw conversations for gbrain and for the comparator (an extract-first memory server that calls a model on every write to pull out facts), so both systems are measured on identical records.

**Status, October 5, 2026.** All four suites have run for both systems. Every question was answered by the fixed reader, a quarter of each category was re-read by four more frontier readers, and every answer is scored. The offline checks pass: a stub reader answers every question from the gold conversations, answers none without memory (apart from questions whose correct answer is "none"), and never finds a question ambiguous in the full history.

| Suite | Command | Questions | Isolation units | Conversation tokens | Manifest digest |
|---|---|---|---|---|---|
| B1 passing details | `bun run eval:passing-details` | 400 | 40 histories | ~1.11M (~28k per history) | `fdbf8b23e52aa766` |
| B2 corrections | `bun run eval:corrections` | 300 (100 corrections × 3 checkpoints) | 100 | ~0.33M base, plus 500 writes | `f85a396b485750a5` |
| B3 time and relationships | `bun run eval:time-relationships` | 374 | 2 | ~0.23M | `600c9ad4fbcbda58` |
| B4 beliefs | `bun run eval:beliefs` | 150 | 25 histories | ~0.54M (~22k per history) | `bb6dea9648f4f59d` |

Token counts are characters divided by four. Digests are the first 16 characters of the `digest` field in `eval/data/workload-suites/<version>.manifest.json`.

## Results

At a matched delivered context, gbrain answers more questions than the comparator on details mentioned in passing (98.5% against 93.0%) and on beliefs (92.7% against 72.0%), and the two are within two points on time and relationships (59.4% against 61.0%). On corrections, each system has two paths that keep the corrected value through five later writes. gbrain's forget-then-remember path and the comparator's memory-edit path both fail. Several cells are at the ceiling, as noted under each suite.

Both systems ran from the same raw records through the harness providers, behind the metering proxy, at a delivered-context target of 8,000 cl100k tokens.
- **Builds:** gbrain `e8e1f66b` (capy/mpw-integration) and the comparator's pinned release (0.10.2).
- **Structures:** gbrain built its facts in the pipeline with `extract-conversation-facts` (its default extraction model, `anthropic:claude-sonnet-4-6`), and that spend is counted. The comparator extracted with its own default model, gpt-4o-mini. Its fact and chunk budgets were tuned retrieval-only on each suite's smoke store to reach the target.
- **Readers:** every question was answered by the fixed reader, `anthropic:claude-sonnet-5-5`. A hash-chosen quarter of each category was re-read from the saved contexts by `anthropic:claude-opus-5-5`, `openai:gpt-6-astra` and `anthropic:claude-fable-5-1`, and by `openai:gpt-6.1-sol` as the alternate newest GPT.
- **Scoring:** deterministic scoring decides every answer except those that name the gold value together with a stale or distractor value, or every gold name plus others. The fixed judge, `openai:gpt-6.1-sol`, decides those.
- **Receipts:** [2026-10-05-workload-suites/](2026-10-05-workload-suites/) holds the scored rows per reader, ingest and presence receipts, B2 arm runs, spend by proxy label and run manifests.

### B1 passing details

| Arm | Fixed reader (400) | Opus / Astra / Fable / gpt-6.1-sol (101) | Delivered tokens (mean / p95) |
|---|---:|---:|---:|
| gbrain, pages plus extracted facts | 394 (98.5%) | 101 / 101 / 101 / 101 | 7,892 / 7,931 |
| gbrain, pages only | 350 (87.5%) | 89 / 90 / 91 / 89 | 4,333 / 5,493 |
| comparator, facts plus chunks | 372 (93.0%) | 93 / 91 / 93 / 90 | 7,966 / 8,173 |
| comparator, facts only | 366 (91.5%) | 92 / 88 / 92 / 87 | 4,295 / 4,464 |

Where the misses come from (fixed reader):

| Arm | Absent from storage | Stored, not retrieved | Delivered, misread |
|---|---:|---:|---:|
| gbrain, pages plus extracted facts | 0 | 4 | 2 |
| gbrain, pages only | 0 | 49 | 1 |
| comparator, facts plus chunks | 0 | 24 | 4 |
| comparator, facts only | 30 | 0 | 4 |

- **gbrain with extracted facts is at the ceiling for the sweep readers** (101/101 each). Its six fixed-reader misses are four retrieval misses and two misreads.
- **gbrain's pages-only lane loses on retrieval, not storage.** All 49 of its retrieval misses are details the store holds. `query` returns about ten page blocks whatever the token budget, so this lane gets roughly half the comparator's context. Restaurants (16/33) and furniture widths (23/36) suffer most. With extracted facts in the brain, the same `query` fills the budget (7,892 tokens on average) and its retrieval misses drop to 4.
- **The comparator's facts-only lane loses on extraction.** 30 answer values are in no extracted fact in any recognized written form. Its recall returns at most about 4,300 tokens of facts, whatever the budget. Adding raw chunks recovers storage but leaves 24 retrieval misses, concentrated in wifi passwords (26/36) and access codes (26/30).

Two lanes the plan names cannot run at these builds, and they are reported instead of run. gbrain has no facts-only lane: it has no query-ranked fact retrieval, because `recall` lists facts by entity, session or time. The comparator has no raw-only lane: it returns raw chunks only attached to the facts they came from.

### B2 corrections

Fixed reader, 100 corrections per arm:

| Arm | Before the correction | Corrected after 1 write | Stale after 1 write | Corrected after 5 writes | Stale after 5 writes |
|---|---:|---:|---:|---:|---:|
| gbrain edit + sync | 100 | 100 | 0 | 100 | 0 |
| gbrain forget + remember | 100 | 0 | 91 | 0 | 89 |
| gbrain append | 100 | 100 | 0 | 100 | 0 |
| comparator edit/invalidate | 100 | 0 | 14 | 0 | 12 |
| comparator re-retain | 100 | 100 | 0 | 100 | 0 |
| comparator append | 100 | 100 | 0 | 100 | 0 |

`gbrain-remember-replaces` did not run: `remember` has no `replaces` parameter at `e8e1f66b`. Four arms are at the ceiling with every reader, so the result is which paths fail.

- **gbrain forget + remember.** The raw lane holds no facts to forget, so the conversation page keeps the old value. `query` returns a remembered statement only when it shares three quarters of the question's words. "Which bank does Apex use?" does not match "Apex banks with Tidewell Bank.", so the reader sees only the old value. Every sweep reader also fails this arm (24 to 32 of 75, which is the pre-correction probes plus a few).
- **comparator edit/invalidate.** The memory PATCH rewrites the extracted fact, but the raw chunk still quotes the old value. Readers see both and mostly hedge, and the judge rejects the hedges. gpt-6.1-sol commits to the edited value more often (39/75) than the other readers (18 to 24/75).

A unit holds about 3,300 tokens, so each system delivers nearly the whole unit (3,100 to 3,800 tokens). B2 measures what each correction path leaves in the store, not retrieval.

### B3 time and relationships

| Arm | Fixed reader (374) | Opus / Astra / Fable / gpt-6.1-sol (95) | Delivered tokens (mean / p95) |
|---|---:|---:|---:|
| gbrain, pages plus extracted facts | 222 (59.4%) | 60 / 71 / 62 / 70 | 8,029 / 8,157 |
| comparator, facts plus chunks | 228 (61.0%) | 55 / 68 / 55 / 68 | 7,027 / 10,739 |

| Family (fixed reader) | gbrain | comparator |
|---|---:|---:|
| as-of employer | 64/104 | 67/104 |
| one-hop relationships | 106/145 | 108/145 |
| composed multi-hop | 52/125 | 53/125 |

The systems are within two points with every reader. The OpenAI readers score both about ten points higher than the Anthropic readers. Neither pipeline turns these conversations into a relationship graph a reader can walk: multi-hop families whose answers span many pages, such as portfolio peers (1/22 and 0/22) and founders' meetings (0/9 each), score near zero for both. On world-v1 pages the comparator's recall overshoots its fact and chunk budgets, so at the lowest budgets that bring its mean under the target, its p95 (10,739 tokens) is still more than 10% over. Its first run, at the budgets tuned on B4, averaged 13,310 tokens. That run was discarded and the arm re-answered. gbrain's fact extraction on the world-v1 unit exited nonzero after inserting 2,385 facts, and the run used the facts it inserted.

### B4 beliefs

| Arm | Fixed reader (150) | Opus / Astra / Fable / gpt-6.1-sol (38) | Delivered tokens (mean / p95) |
|---|---:|---:|---:|
| gbrain, pages plus extracted facts | 139 (92.7%) | 35 / 35 / 35 / 35 | 7,866 / 7,898 |
| comparator, facts plus chunks | 108 (72.0%) | 28 / 28 / 28 / 28 | 7,823 / 7,999 |

By category (fixed reader):

| Category | gbrain | comparator |
|---|---:|---:|
| holder | 50/50 | 42/50 |
| weight change | 50/50 | 38/50 |
| resolved, one prediction | 20/25 | 20/25 |
| resolved, set of predictions | 19/25 | 8/25 |

gbrain is at the ceiling on holder and weight-change questions. The gap is on questions whose evidence is spread over several conversations: every confidence statement, or a prediction and its later outcome. That fits gbrain delivering those conversations as whole pages while the comparator delivers extracted facts and their chunks. The receipts keep every delivered context, so this can be checked question by question. All five readers agree on the subset, so this suite measures retrieval, not reading.

### What the runs found in each system

- **gbrain `e8e1f66b`:**
  - `remember` has no `replaces` parameter.
  - `extract-conversation-facts` skips plain `role: text` transcripts, which is the format the harness provider writes. It extracts from `**Speaker:**` lines, so the B-suite gbrain pages use that format.
  - `query` returns about ten page blocks whatever the token budget.
  - `query` surfaces a remembered fact only when the fact shares three quarters of the question's words.
  - `extract-conversation-facts` exits nonzero when some pages fail, even after inserting facts.
  - A remembered fact's date header shows when it was written, not when the conversation happened.
- **The comparator (0.10.2):**
  - A memory edit leaves the raw chunk quoting the old value.
  - Facts-only recall stops at about 4,300 tokens.
  - On world-v1 pages, recall overshoots its fact and chunk budgets.
  - Its bank statistics lag a newly retained document by up to a minute, so the bench reads completion from the retain operation instead.
  - It stores long dates in other forms ("October 1, 2029"). The scorer and the presence check accept equivalent date forms; an earlier scoring pass without them counted 19 answers in the comparator's combined lane and 21 in its facts lane as wrong, and was replaced.

### Spend

The proxy ledger (`.budget/workload-suites.sqlite`, cap $720) committed $356.41. That covers the smokes, the full runs, the sweeps, judging, gbrain's and the comparator's extraction, the discarded B3 comparator run and the retrieval-only tuning. By suite, from each run directory: B1 $139.36, B2 $75.17, B3 $91.93, B4 $41.25. The rest is the separate smoke directories.

| Proxy label | B1 | B2 | B3 | B4 |
|---|---:|---:|---:|---:|
| readers (fixed and sweep) | $111.38 | $71.06 | $85.86 | $28.02 |
| gbrain (embeddings, fact extraction) | $25.63 | $0.07 | $5.28 | $12.10 |
| comparator (extraction) | $2.18 | $3.71 | $0.60 | $1.06 |
| judge | $0.17 | $0.33 | $0.19 | $0.07 |

## What each suite asks

All conversations are generated from templates; no model writes them. The examples below are copied from the generated records.

### B1: a detail mentioned once, in passing

A history is 64 chat sessions about everyday topics (trip planning, a budgeting spreadsheet, sleep). Somewhere inside them the user drops a detail as an aside:

> user: The electrician ended up charging me $217, by the way. ...

The same history also says "the plumber ended up charging me $977", "the mechanic ended up charging me $320" and "the roofer ended up charging me $865", and in about 30% of questions an earlier non-final value: "The electrician first quoted me $493 for the job". The question is "How much did the electrician end up charging me?" and the answer is `217`.

Twelve kinds of detail rotate through the histories: a relative's dog's name, repair costs, restaurants, flight numbers, access codes, clinicians, paint colors, expiry dates, people's names, furniture widths, reading picks and wifi passwords. Each history asks about ten of them. Every answer value occurs exactly once in its history, which the generator asserts.

Each miss is classified from the run's receipts:

| Class | Detected when |
|---|---|
| absent from storage | the lane's store probe (presence receipt) finds no stored record holding the gold value |
| stored, not retrieved | the value is stored, but the exact context inserted into the final prompt does not contain it |
| delivered, misread | the delivered context contains the gold value and the graded answer is still wrong |

Because gold values are unique tokens within a history, "the context contains the value" means the answer-bearing detail was delivered, not a look-alike. The function is `classifyMiss` in `eval/workload-suites/passing-details.ts`. B1 runs four lanes: gbrain pages only, gbrain pages plus extracted facts, comparator facts only, and comparator facts plus chunks.

### B2: corrections

Each of 100 isolation units holds four conversations in which the user shares notes on a world-v1 entity (`eval/data/world-v1`): the target and three entities of the same kind. Each conversation mentions the same kind of detail with its own value, for example "the Apex offsite is booked in Port Townsend". Then the value is corrected:

> user: Scratch what I said about Apex's offsite location being Port Townsend, that was a mistake. The Apex offsite is booked in Burlington.

Five unrelated writes follow: two pieces of news about the same entity (another detail), two about other entities and one small-talk session. The question "Where is the Apex offsite booked?" is asked three times: before the correction (to prove the original value was answerable), after the first unrelated write and after the fifth.

Each system applies the correction through its own documented path. The arms are data (`arms.json` in the bundle) and run through one adapter interface, `CorrectionAdapter` in `eval/workload-suites/corrections.ts`:

| Arm | System | Steps |
|---|---|---|
| `gbrain-edit-sync` | gbrain | rewrite the conversation page with the new value, then sync |
| `gbrain-forget-remember` | gbrain | find facts holding the old value, `forget` each, then `remember` the corrected statement |
| `gbrain-remember-replaces` | gbrain | `remember` with `replaces`; runs only if that parameter exists at the measured build, otherwise reported as not run |
| `comparator-edit-invalidate` | comparator | find memories holding the old value; edit them where supported, otherwise invalidate and retain the corrected statement |
| `comparator-reretain` | comparator | re-retain the edited conversation under its original document id |
| `gbrain-append`, `comparator-append` | both | ingest the correction message as a new conversation, identical bytes for both |

The metrics are corrected-value accuracy and stale-answer rate after 1 and after 5 unrelated writes, each over 100 probes per arm. An answer naming only the old value is stale; an answer naming both values goes to the judge. Inspectability (whether an operator can see the old value and when it changed) is reported separately through the adapter's `inspect` step.

A unit's conversations total about 3,300 tokens, so at any delivered-context target of 4,000 tokens or more a system can deliver the whole unit. B2 therefore measures what each correction path leaves in the store and how the reader resolves it, not retrieval.

### B3: time and relationships

B3 renders three existing question sets as conversations, so a memory has to build the timeline and the relationship graph from chat:

- **As-of employer (104 questions).** The N3 ledger (`eval/generators/n3-temporal-gen.ts`, default seed) becomes one conversation per person event, sent on the day the note was recorded. A late-recorded event reads "I just found out that Sybil joined Fernway back on 22 January 2022." in a session dated 2022-02-24. Questions are N3's `asof_facts` probes, such as "Where did Alice work on 12 October 2022?", with N3's valid-time gold. For 41 of them the correct answer is that no job had started yet.
- **One-hop relationships (145 questions).** The world-v1 relational questions in their committed paraphrase wording (`eval/data/relational-paraphrase-v1`), such as "Who holds a stake in Acme?".
- **Composed multi-hop (125 questions).** The committed N9 questions (`eval/data/n9-multihop-paraphrase-v1`) in their paraphrase wording, such as "Which founders have Carol Jackson as an investor in their company?".

Each world-v1 page becomes a conversation in which the user shares the page's notes and ends with a "For the record" list of the relationships that page holds, one per line ("- Carol Jackson invested in Keel."). Links become plain names, so no page slug reaches a model. gbrain builds its typed edges and timeline rows inside the measured pipeline and that spend is counted. B3 compares two external systems on the same records; it does not confirm gbrain's relationship features.

The N9 questions are held-out wording for work on gbrain's relational parser; anyone changing that parser should not read the rendered questions either.

### B4: beliefs

Each of 25 histories has five people and ten propositions about fictional events. Over 48 sessions the user mentions who thinks what ("Anika thinks the Ferrovia rail strike will end within a month."), who doubts it or is undecided, stated confidence that changes ("Lucia puts the odds that Kestrel Air will add a direct route to Reykjavik at 95 percent", later 55), predictions, and outcomes ("It is settled now: the Atlas release shipped by the end of the quarter."). Six questions per history:

| Category | Example | Gold |
|---|---|---|
| holder (50) | Who thinks the Ferrovia rail strike will end within a month? | Anika; Yusuf |
| weight change (50) | How did Lucia's confidence that ... change over time? | from 95 percent to 55 percent |
| resolved set (25) | Which of Lucia's predictions came true? | Lumen Tablet |
| resolved one (25) | Did Lucia's prediction that ... come true? | yes, no or not yet (9 / 12 / 4) |

gbrain extracts and grades takes inside the measured pipeline and that spend is counted.

## Records and format

Every suite writes the same streams so the harness lane runs both systems from identical raw records:

| File | Shape | Seen by models |
|---|---|---|
| `documents.jsonl` | the public agent-memory benchmark harness's `Document`: `id`, `content`, `user_id`, `messages`, `timestamp`, `context` | yes |
| `queries.jsonl` | the harness's `Query`: `id`, `query`, `gold_ids`, `gold_answers`, `user_id`, `meta` (`query_timestamp`, `category`, and `checkpoint` or `hops` where relevant) | the question text only |
| `scorer-labels.jsonl` | structured question, typed gold, needles (the text each answer depends on), distractors | no |
| `frontier-subset.jsonl` | query ids in the four-model sweep | no |
| B2 only: `corrections.jsonl`, `writes.jsonl`, `schedule.jsonl`, `arms.json` | correction materials, unrelated writes, the ordered operation list per unit, the arms | correction and write documents only |

Ids are opaque hashes and carry no role. A test asserts that no id and no label marker appears in any document or question text. Document timestamps are observed session times; an event date stated inside the text is never a document timestamp. The schema for every record is `eval/schemas/workload-suite.schema.json`.

## Offline checks

`bun run eval:<suite>` generates the suite from its seed and runs these checks before writing anything. None calls a provider or reads a key.

| Check | What passes |
|---|---|
| schema | every record matches its definition in the schema |
| presence | every needle is in the named document of the asking user, and every gold and oracle document exists |
| solvability, oracle | the stub reader answers every question from the gold conversations only |
| solvability, full history | the stub reader answers every question from the user's whole history, so distractors never make a question ambiguous |
| solvability, no memory | the stub reader answers no question with an empty context, except questions whose correct answer is "none" |
| B2 schedule | on a reference memory, every arm answers all 300 probes; with no memory none; when corrections are ignored all 200 post-correction probes score stale |
| manifest | the bundle's file hashes match the committed manifest |

The stub reader receives the structured form of a question (what is asked, never the answer) and parses the context with the generator's statement templates. It proves the records are answerable and the scorer works. Its scores say nothing about any memory system.

`storePresenceFailures` in `eval/workload-suites/checks.ts` is the same presence assertion against a real store, for the harness lane to call after ingest and before the first question; a failure makes the cell an error, not a scored miss. Unit tests in `test/eval/workload-suites.test.ts` also run the scorer mutation kit: empty, always-positive, always-refuse, stale and wrong-source fake systems all fail every suite's scorer.

## Readers, judge and paid-run volume

`eval/workload-suites/run-config.ts` holds the model configuration that the runs above used:

- **Fixed reader:** the newest frontier Sonnet, `anthropic:claude-sonnet-5-5`, on every cell.
- **Frontier sweep:** a quarter of each category's questions, chosen by hash order of query id, re-read by `anthropic:claude-opus-5-5`, `openai:gpt-6-astra` and `anthropic:claude-fable-5-1`. `openai:gpt-6.1-sol`, the alternate newest GPT, re-reads the same questions. The sweep re-reads the contexts saved by the fixed-reader run, so it adds no retrieval or ingest.
- **Judge:** `openai:gpt-6.1-sol`, only for answers the deterministic scorer marks ambiguous. It is also the alternate reader, so in B3 it judged 13 of its own answers in gbrain's arm and 9 in the comparator's. It judged none of its own answers in the other suites, because its answers there are terse enough to score deterministically.
- **No older generation and no `gpt-5.4-mini`.** `modelRuleViolations` fails the entry point if one is configured.
- **No-memory control:** it calls the reader with an explicit placeholder context, so an empty-context guard cannot skip the call.

The paid bench is `eval/workload-suites/bench.ts` (phases `answer`, `sweep` and `score`). It reaches the harness providers through `eval/harness-provider/mpw_workload/bridge.py`, and B2 runs through the per-system `CorrectionAdapter` in `eval/workload-suites/correction-adapters.ts`. `bun run eval:<suite>:dry` prints the planned volume without spending. The measured spend is in the Spend table above.

## Limits

- **Template text.** The conversations come from templates. Filler topics repeat across sessions and histories, and asides are inserted into unrelated turns. The suites test whether a memory keeps and finds stated details, not how it handles natural dialogue.
- **Ceilings.** gbrain is at the ceiling on B1 with extracted facts and on B4 holder and weight-change questions. Four B2 arms are at the ceiling for every reader. These cells cannot show a difference between readers.
- **Units that fit the target.** B2 units and the B3 as-of history fit inside the 8,000-token target, so those questions measure storage and reading more than retrieval.
- **Unmatched context in two places.** gbrain's pages-only lane delivers about 4,300 tokens because `query` stops at about ten blocks, and the comparator's B3 p95 is 10,739 tokens. Both are reported, not adjusted.
- **B3 gold.** The one-hop and multi-hop gold comes from world-v1 `_facts`. World-v1 prose was model-written and may state relationships the facts omit; the explicit "For the record" lines are what the gold and the stub reader rely on.
- **Matching rules.** The scorer and the presence check match values as whole normalized tokens, accepting equivalent written forms of a long date. A fact that rewrites a value some other way (for example, a number spelled out) counts as absent.

## Reproduce

From the repository root, with `bun install --frozen-lockfile` done and no keys:

```sh
bun run eval:workload-suites          # all four suites, about 5 seconds
bun run eval:passing-details:smoke    # 3 histories, 30 questions
bun run eval:corrections:dry          # paid-run volume, no spend
bun test test/eval/workload-suites.test.ts
```

The paid runs need the pinned harness (`bun run harness:setup`), the comparator server (`bun run harness:comparator install`), a gbrain checkout at `e8e1f66b`, Bun 1.4 or newer for that checkout (`WORKLOAD_GBRAIN_BUN=<path to bun>`) and provider keys in the environment. Every request goes through the metering proxy against `.budget/workload-suites.sqlite`:

```sh
bun eval/workload-suites/bench.ts beliefs --phase answer --smoke 20 --budget-usd 8   # 20-question paid smoke
bun eval/workload-suites/bench.ts beliefs --phase answer --budget-usd 40             # all arms (or --arms a,b)
bun eval/workload-suites/bench.ts beliefs --phase sweep --budget-usd 40              # frontier readers on the saved contexts
bun eval/workload-suites/bench.ts beliefs --phase score --budget-usd 3               # deterministic scoring plus the judge
bun eval/workload-suites/report.ts --copy docs/benchmarks/2026-10-05-workload-suites
```

Reader and judge calls are cached by prompt hash and ingested stores are reused, so rerunning a phase spends nothing on work already done. Paid output lands in `eval/reports/workload-bench/<suite>/`.

Output of the offline entry points lands in `eval/reports/workload-suites/<version>/` (ignored by Git): the record streams, `manifest.json` and `check-receipt.json` with every check result, the model configuration and the arms. `--seed N` generates another instance; `--output DIR` writes elsewhere. The generator code lives in `eval/workload-suites/`; the committed manifests in `eval/data/workload-suites/` pin the default-seed bundles byte for byte.
