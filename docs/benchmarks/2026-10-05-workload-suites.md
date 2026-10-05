# Workload suites for the memory proof wave (B1 to B4)

Four seeded question sets test what an agent memory does with ordinary chat: recall a detail mentioned once, apply a correction, track how relationships change over time, and keep track of who believes what. Each suite generates the same raw conversations for gbrain and for the comparator (an extract-first memory server that calls a model on every write to pull out facts), so both systems are measured on identical records.

**Status, October 5, 2026 (interim).** The paid runs are in progress. B2, B3 and B4 are fully answered and scored with the fixed reader and the frontier sweep. In B1, gbrain's fact-extraction lane has answered 250 of its 400 questions, and the sweep has not yet re-read the B1 comparator and gbrain fact lanes. The results below are interim until this line says otherwise. Every suite passes its offline checks: a stub reader answers every question from the gold conversations and answers none without memory (apart from questions whose correct answer is "none"), and the full history never makes a question ambiguous.

| Suite | Command | Questions | Isolation units | Conversation tokens | Manifest digest |
|---|---|---|---|---|---|
| B1 passing details | `bun run eval:passing-details` | 400 | 40 histories | ~1.11M (~28k per history) | `fdbf8b23e52aa766` |
| B2 corrections | `bun run eval:corrections` | 300 (100 corrections × 3 checkpoints) | 100 | ~0.33M base, plus 500 writes | `f85a396b485750a5` |
| B3 time and relationships | `bun run eval:time-relationships` | 374 | 2 | ~0.23M | `600c9ad4fbcbda58` |
| B4 beliefs | `bun run eval:beliefs` | 150 | 25 histories | ~0.54M (~22k per history) | `bb6dea9648f4f59d` |

Token counts are characters divided by four. Digests are the first 16 characters of the `digest` field in `eval/data/workload-suites/<version>.manifest.json`.

## Results (interim)

Both systems ran from the same raw records through the harness providers, behind the metering proxy, at a delivered-context target of 8,000 cl100k tokens. Answers came from the fixed reader (`anthropic:claude-sonnet-5-5`), and a hash-chosen quarter of each category's questions was re-read by `anthropic:claude-opus-5-5`, `openai:gpt-6-astra` and `anthropic:claude-fable-5-1`. The builds were gbrain `e8e1f66b` (capy/mpw-integration) and the comparator's pinned release (0.10.2). The comparator used its own extraction model, gpt-4o-mini. Its fact and chunk budgets were tuned retrieval-only on each suite's smoke store to reach the target. gbrain's fact extraction (`extract-conversation-facts`, its default `anthropic:claude-sonnet-4-6`) ran in the pipeline, and its spend is counted. Deterministic scoring decides every answer except those that name the gold value together with a stale or distractor value; the fixed judge (`openai:gpt-6.1-sol`) decides those. The receipts are in [2026-10-05-workload-suites/](2026-10-05-workload-suites/): scored rows, ingest and presence receipts, B2 arm runs, spend by label and run manifests.

### B2 corrections (complete)

Fixed reader, 100 corrections per arm:

| Arm | Before the correction | Corrected after 1 write | Stale after 1 write | Corrected after 5 writes | Stale after 5 writes |
|---|---:|---:|---:|---:|---:|
| gbrain edit + sync | 100 | 100 | 0 | 100 | 0 |
| gbrain forget + remember | 100 | 0 | 91 | 0 | 89 |
| gbrain append | 100 | 100 | 0 | 100 | 0 |
| comparator edit/invalidate | 100 | 0 | 14 | 0 | 12 |
| comparator re-retain | 100 | 100 | 0 | 100 | 0 |
| comparator append | 100 | 100 | 0 | 100 | 0 |

`gbrain-remember-replaces` did not run: `remember` has no `replaces` parameter at `e8e1f66b`. Four arms are at the ceiling, so the useful signal is which paths fail.

- **gbrain forget + remember fails.** The raw lane has no facts to forget, so the conversation page still states the old value. `query` returns the remembered statement only when it shares three quarters of the question's words, and "Which bank does Apex use?" does not match "Apex banks with Tidewell Bank." The reader therefore sees only the old value.
- **comparator edit/invalidate fails.** The comparator's memory PATCH rewrites the extracted fact, but the raw chunk still quotes the old value. The reader sees both and does not commit to the corrected value; most of these answers are hedges the judge rejects.

The frontier sweep agrees: Opus, Astra and Fable score every passing arm at 100% and both failing arms at 30% to 43%, which is close to the share of pre-correction probes in the subset.

### B4 beliefs (complete)

| Arm | Fixed reader | Opus / Astra / Fable (38-question subset) | Delivered tokens (mean / p95) |
|---|---:|---:|---:|
| gbrain (pages plus extracted facts) | 139/150 (92.7%) | 35 / 35 / 35 | 7,866 / 7,898 |
| comparator (facts plus chunks) | 108/150 (72.0%) | 28 / 28 / 28 | 7,823 / 7,999 |

By category (fixed reader), holder questions score 50/50 for gbrain and 42/50 for the comparator, weight change 50/50 and 38/50, resolved-one 20/25 and 20/25, and resolved-set 19/25 and 8/25. gbrain is at the ceiling on holder and weight-change questions. The gap is on the questions whose evidence is spread over several conversations: every confidence statement, or a prediction and its later outcome. That is consistent with gbrain delivering those conversations as whole pages while the comparator delivers extracted facts and the chunks attached to them; the receipts keep every delivered context for checking this per question.

### B3 time and relationships (complete)

| Arm | Fixed reader | Opus / Astra / Fable (95-question subset) | Delivered tokens (mean / p95) |
|---|---:|---:|---:|
| gbrain (pages plus extracted facts) | 222/374 (59.4%) | 60 / 71 / 62 | 8,029 / 8,157 |
| comparator (facts plus chunks) | 228/374 (61.0%) | 55 / 68 / 55 | 7,027 / 10,739 |

| Family (fixed reader) | gbrain | comparator |
|---|---:|---:|
| as-of employer | 64/104 | 67/104 |
| one-hop relationships | 106/145 | 108/145 |
| composed multi-hop | 52/125 | 53/125 |

The two systems are within two points with the fixed reader. Astra scores both about ten points higher than the other readers. Neither system's pipeline turns these conversations into a relationship graph a reader can walk: multi-hop questions whose answers span many pages (portfolio peers, founders' meetings) score near zero for both. The comparator's p95 delivered context (10,739 tokens) exceeds the target by more than 10%, because its recall overshoots the fact and chunk budgets on world-v1 pages. Its first run, at the budgets tuned on B4, averaged 13,310 tokens. That run was discarded, and the arm was re-answered at the lower budgets.

### B1 passing details (interim)

| Arm | Fixed reader | Delivered tokens (mean / p95) |
|---|---:|---:|
| gbrain raw (pages only) | 350/400 (87.5%) | 4,333 / 5,493 |
| gbrain pages plus extracted facts | 246/250 so far (98.4%) | 7,891 / 7,931 |
| comparator facts plus chunks | 353/400 (88.3%) | 7,966 / 8,173 |
| comparator facts only | 345/400 (86.3%) | 4,295 / 4,464 |

gbrain's raw lane under-delivers. `query` returns about ten page blocks (roughly 4,300 tokens) whatever the token budget, so it competes at about half the comparator's context. The comparator's facts-only recall returns at most about 4,300 to 4,500 tokens of facts, whatever its budget. These lanes cannot run at the measured builds: a gbrain facts-only lane (no query-ranked fact retrieval; `recall` lists facts by entity, session or time) and a comparator raw-only lane (chunks come only attached to the facts they came from). The miss classes and the remaining gbrain fact-lane questions arrive with the final update.

### Spend

The proxy ledger (`.budget/workload-suites.sqlite`, cap $720) had committed $262.28 when this interim update was written. That covers smokes, full runs, sweeps and judging for all four suites, including the discarded B3 comparator run and gbrain's and the comparator's extraction. Per-suite spend by proxy label is in each suite's `spend.json`.

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

Because gold values are unique tokens within a history, "the context contains the value" means the answer-bearing detail was delivered, not a look-alike. The function is `classifyMiss` in `eval/workload-suites/passing-details.ts`. B1 runs three lanes per system: raw conversations only, extracted facts only, and both.

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

`eval/workload-suites/run-config.ts` holds the model configuration. Its ids are placeholders until the preregistration freezes them.

- One fixed reader for every cell: the newest frontier Sonnet (`anthropic:claude-sonnet-5-5`).
- A preregistered quarter of each category's questions, chosen by hash order of query id, re-read by the newest frontier Opus, GPT, Sonnet and Fable models (`anthropic:claude-opus-5-5`, `openai:gpt-6-astra`, `anthropic:claude-sonnet-5-5`, `anthropic:claude-fable-5-1`). The sweep re-reads the contexts saved by the fixed-reader run, so it adds no retrieval or ingest.
- One fixed judge (`openai:gpt-6.1-sol`) for answers the deterministic scorer marks ambiguous.
- No older generation and no `gpt-5.4-mini`; `modelRuleViolations` fails the entry point if one is configured.
- The no-memory control calls the reader with an explicit placeholder context, so an empty-context guard cannot skip the call.

`bun run eval:<suite>:dry` prints the paid-run volume without spending. At an 8,000-token delivered-context target:

| Suite | Arms | Fixed-reader calls | Sweep calls | Reader input tokens |
|---|---|---|---|---|
| B1 | 6 | 2,400 | 1,818 | ~35M |
| B2 | 6 (plus the optional arm) | 1,800 | 1,350 | ~26M |
| B3 | 2 | 748 | 570 | ~11M |
| B4 | 2 | 300 | 228 | ~4M |

That is about 76M reader input tokens before ingest and judging, which is more than the plan's $200 line for B suites buys at frontier input prices. The A0 spend ledger prices the plan; a smaller sweep fraction or a lower delivered-context target are the levers if it does not fit.

## Limits

- The conversations are template text. Filler topics repeat across sessions and histories, and asides are inserted into unrelated turns. The suites test whether a memory keeps and finds stated details, not how it handles natural dialogue.
- B2 units and the B3 as-of history fit inside common delivered-context targets; those questions measure storage and reading more than retrieval.
- B3's one-hop and multi-hop gold come from world-v1 `_facts`. World-v1 prose was model-written and may state relationships the facts omit; the explicit "For the record" lines are what the gold and the stub reader rely on.
- The deterministic scorer matches answer values as whole normalized tokens. Answers that name the gold value and a stale or distractor value are left to the judge.

## Reproduce

From the repository root, with `bun install --frozen-lockfile` done and no keys:

```sh
bun run eval:workload-suites          # all four suites, about 5 seconds
bun run eval:passing-details:smoke    # 3 histories, 30 questions
bun run eval:corrections:dry          # paid-run volume, no spend
bun test test/eval/workload-suites.test.ts
```

Output lands in `eval/reports/workload-suites/<version>/` (ignored by Git): the record streams, `manifest.json` and `check-receipt.json` with every check result, the model configuration and the arms. `--seed N` generates another instance; `--output DIR` writes elsewhere. The generator code lives in `eval/workload-suites/`; the committed manifests in `eval/data/workload-suites/` pin the default-seed bundles byte for byte.
