# LongMemEval without gbrain: plain hybrid search, the whole history and no memory

Measured 2026-11-17 against [the preregistration](../../../plans/2026-11-17-readme-baselines/PREREG.md). No gbrain arm was run again: every baseline below pairs, question by question, with gbrain's committed records at the commit README names.

## Takeaways

- **We learned that gbrain finds every needed conversation more often than plain hybrid search does: 451 against 414 of 470 in the top five.** On the same 470 answerable LongMemEval-S questions, gbrain's release retrieval (gbrain `109b992`) found all the labelled evidence conversations in its top five on 37 more questions than plain Postgres full-text plus pgvector search fused by reciprocal rank. gbrain alone got 45 questions and plain hybrid alone got 8 (exact McNemar p = 2.4e-7; gbrain ahead by 7.9 points, 95% interval 4.9 to 10.8). **You should use gbrain's retrieval, not plain hybrid search, when a question needs several conversations:** the gap is in multi-session (112 against 100 of 121) and temporal-reasoning questions (117 against 101 of 127).
- **We learned that plain hybrid search already finds a quoted message.** Asked for the first 300 characters of a saved message word for word, plain hybrid returned the right conversation first for 491 of 500 questions and in its top 10 for 499. gbrain returned it among its cited conversations for all 500, so there's no measurable difference on this probe. **You don't need gbrain to look up an exact quote;** full-text search does that. The one plain-hybrid miss is a message with a long run of dashes that overflows Postgres's full-text query parser. gbrain had the same bug and fixed it in gbrain#6391.
- **We learned that what gbrain retrieves gives a reader more right answers than plain hybrid search's top five, at the same reader cost.** Sonnet 5.5 answered 468 of 500 from gbrain's retrieval and 445 from plain hybrid's top five conversations (gbrain alone 41, plain hybrid alone 18, p = 0.004). Opus 5.5 answered 474 from gbrain's saved results and 445 from plain hybrid's (43 against 14, p = 0.0002). The reader pays about the same per question either way, $0.023 (Sonnet) and $0.048 (Opus). **You should put gbrain, not a plain hybrid index, in front of a reader** when the answers depend on old conversations.
- **We learned that pasting the whole history scores as well as gbrain, at about 7.4 times the reader cost per question.** Sonnet 5.5 with all of each question's roughly 50 conversations (about 171,000 input tokens) answered 471 of 500, against 468 with gbrain. That's no measurable difference (14 against 17, p = 0.72; gbrain minus whole history −0.6 points, 95% interval −2.8 to +1.6). The reader cost $0.172 per question with the whole history and $0.023 with gbrain, at batch prices with one question per history and no prompt-cache reuse. **You should use the whole history when a history fits the window and is asked only a few questions; use gbrain when cost per question or history size matters.**
- **Without any memory, Sonnet 5.5 gets 58 of 500,** and 30 of those are the 30 questions whose right answer is "that was never mentioned." Every gain above comes from what the reader is shown.

## Results

### Every needed conversation in the top five (README row: 451 of 470)

| | gbrain `109b992` (release config: `balanced`, Voyage reranker, autocut off) | plain hybrid (`PlainHybridSystem`) |
|---|---:|---:|
| Strict `recall_all@5`, 470 answerable | **451** (96.0%) | **414** (88.1%, 95% CI 84.8% to 90.7%) |
| Questions only this system got | 45 | 8 |
| Paired test | exact two-sided McNemar p = 2.4e-7: **gbrain win** | |

By type (strict hits at five):

| Type | n | gbrain | plain hybrid |
|---|---:|---:|---:|
| single-session-user | 64 | 64 | 61 |
| single-session-assistant | 56 | 56 | 56 |
| single-session-preference | 30 | 30 | 25 |
| knowledge-update | 72 | 72 | 71 |
| multi-session | 121 | 112 | 100 |
| temporal-reasoning | 127 | 117 | 101 |

Plain hybrid found at least one evidence conversation in its top five for 453 of 470 questions, and all of them in its top ten for 451 of 470.

### Verbatim probe and strict recall at ten (README row: a search that quotes a saved message)

The probe is the one in the [verbatim-probe preregistration](../../2026-10-09-verbatim-probe-preregistration.md): the first 300 characters of the longest turn of the last conversation saved. Strict recall@10 counts a question only when every labelled evidence conversation is in the first ten, over all 500 questions.

| | gbrain (`fecc7827`, verdict file arm B) | plain hybrid |
|---|---:|---:|
| Probe: target conversation at rank 1 | not recorded | 491 / 500 |
| Probe: target in the top 10 | not recorded | 499 / 500 |
| Probe: target among the returned conversations (gbrain's "found", up to 50) | 500 / 500 | 499 / 500 |
| Strict recall@10 on the question | 496 / 500 | 480 / 500 (95% CI 93.9% to 97.4%) |
| Strict recall@5 on the question | 474 / 500 | 438 / 500 |

The verbatim verdict file holds counts only, with no per-question records, so these rows are **unpaired**. Two consequences:

- **Probe:** gbrain found every target, so the pairing is determined anyway: one discordant question, the dash overflow (`36580ce8`), and no measurable difference (p = 1).
- **Strict recall@10:** gbrain's four misses aren't named. Every possible placement of them gives a **gbrain win**: between 16 and 20 questions only gbrain got, and between 0 and 4 only plain hybrid got, with exact McNemar p from 3.1e-5 to 0.00154.

**Why null on the probe?** The probe asks for a passage copied word for word, which keyword search matches almost by definition. Both systems are at the ceiling, so there's no headroom left to separate them.

### Right answers with a Sonnet 5.5 reader (README row: 468 of 500)

Every arm uses the same house notes prompt (`gbrain-lme-reader-v4-notes-fullsessions`, SHA-256 `3db7ccbb…`). Every arm uses the same reader settings as W10a's gbrain row: `claude-sonnet-5-5`, `output_config.effort: "low"`, 3,500 output tokens, Anthropic Message Batches. Every arm uses the same judge, LongMemEval's official `evaluate_qa.py` prompt on `gpt-4o-2024-08-06` at temperature 0. Sonnet 5.5 is the reader here only because it is the reader of the gbrain row this pairs with. It is not a model under test. The gbrain side is W10a's 500 committed verdicts at gbrain `c5fb0201` ([report](../../2026-10-07-longmemeval-w10a-current-pin.md)).

| Arm | Correct (official judge) | gbrain only / arm only | Exact McNemar p | gbrain minus arm, points (95% CI) | Verdict | Mean input tokens | Reader $ per question | Reader $ per correct answer |
|---|---:|---:|---:|---|---|---:|---:|---:|
| gbrain `c5fb0201` (W10a) | **468** | | | | | 22,167 | 0.023 | 0.025 |
| (a) whole history in the prompt | **471** | 14 / 17 | 0.72 | −0.6 (−2.8 to +1.6) | no measurable difference | 171,232 | 0.172 | 0.183 |
| (b) plain hybrid's top five conversations | **445** | 41 / 18 | 0.004 | +4.6 (+1.6 to +7.6) | gbrain win | 22,012 | 0.023 | 0.026 |
| (c) the question alone | **58** | 412 / 2 | 4e-120 | +82.0 (+78.5 to +85.5) | gbrain win | 295 | 0.001 | 0.008 |

Reader dollars are the batch lane's settled per-row cost from provider usage at batch prices (50% of list). The smallest difference these pairs could detect with 80% power, at the observed discordance, is 3.1 points for (a), 4.3 for (b) and 11.4 for (c).

By type, official judge (gbrain / whole history / plain hybrid top five / question alone):

| Type | n | gbrain | (a) | (b) | (c) |
|---|---:|---:|---:|---:|---:|
| single-session-user | 64 | 62 | 63 | 60 | 9 |
| single-session-assistant | 56 | 56 | 56 | 56 | 11 |
| single-session-preference | 30 | 30 | 28 | 25 | 1 |
| knowledge-update | 72 | 71 | 70 | 68 | 0 |
| temporal-reasoning | 127 | 118 | 119 | 108 | 2 |
| multi-session | 121 | 103 | 107 | 100 | 5 |
| abstention | 30 | 28 | 28 | 28 | 30 |

**Two provider refusals.** In arm (a), Sonnet 5.5 returned `stop_reason: "refusal"` with no text for two questions, `5025383b` and `gpt4_7f6b06db`. Both had a whole history of about 170,000 tokens, and each refusal was billed for its input. They count as wrong, as every reader error does in W10. That makes the count 471 of 500, or 471 of the 498 answered. No other arm had a reader error, and no arm hit the output limit.

**Why null on the whole history?** Did the reader use what it got? Yes. It is 413 questions above the question-alone arm. Do the tasks fit? A LongMemEval-S history is about 171,000 Sonnet input tokens and fits Sonnet 5.5's window, so the whole history leaves nothing out. That is the ceiling a retrieval system is trying to reach, not a weak control. Were there enough samples? At 500 pairs the test could detect about 3.1 points, and the observed difference is −0.6. Headroom: both arms are near the top of what this judge credits (468 and 471 of 500). Same as W10c on 150 questions (144 against 139), the whole history's small edge sits in multi-session questions (107 against 103). That's where an answer is spread over more conversations than five. Verdict for README: **KEEP**. gbrain matches the whole history's accuracy at about one seventh of the reader cost per question. It doesn't beat it on accuracy.

### A newer reader, Opus 5.5, on saved results (README row: 474 of 500)

Same prompt, same judge, and the W10b Opus arm's settings: `claude-opus-5-5`, effort low, 4,096 output tokens. gbrain's side is W10b's `w10b-opus55-notes` rows: gbrain's retrieval at `a7cb37b`, saved on 2026-09-29 ([report](../../2026-10-07-longmemeval-w10b-reader-replay.md)).

| Arm | Correct (official judge) | gbrain only / arm only | Exact McNemar p | gbrain minus arm, points (95% CI) | Verdict | Reader $ per question |
|---|---:|---:|---:|---|---|---:|
| gbrain's saved results (W10b) | **474** | | | | | 0.048 |
| plain hybrid's top five conversations | **445** | 43 / 14 | 0.0002 | +5.8 (+2.9 to +8.7) | gbrain win | 0.048 |

By type (gbrain / plain hybrid): single-session-user 64 / 60, single-session-assistant 55 / 55, single-session-preference 30 / 25, knowledge-update 70 / 69, temporal-reasoning 117 / 110, multi-session 109 / 98, abstention 29 / 28.

### How the reader prompts were built

Every reader prompt was rendered with the renderers of gbrain `c5fb0201`: the page renderer, the `<chat_session>` framing at 60,000 characters per conversation and the house reader request builder. That's the build whose harness wrote W10a's prompts. This is prompt formatting only, with no gbrain retrieval. A check (`scripts/render-check.ts`) rebuilds all 500 of W10a's captured prompts and all 500 of W10b's saved prompts from their own conversation lists, and gets them byte for byte. The pinned gbrain renders 91 of W10c's 150 whole-history prompts differently: an old sanitizer at `c5fb0201` rewrites a few phrases such as "system (…)". That's why the arms pin `c5fb0201` instead. Retrieved conversations appear in rank order, as gbrain's harness shows them, and the whole history appears in haystack order, as in W10c. No prompt carries the question's own `answer_` conversation ids.

W10c's 150 committed whole-history rows were not reused: they ran at 4,096 output tokens, while the W10a row ran at 3,500. All 500 questions ran fresh.

## The baseline

`PlainHybridSystem` (`eval/runner/systems/baselines.ts`, the scoreboard's `baseline-hybrid`) is the simplest search a team would build. It stores one row per conversation in Postgres (PGlite) and runs two searches. One is full-text search (`websearch_to_tsquery`, `ts_rank_cd`). The other is pgvector cosine search over OpenAI `text-embedding-3-large` at 1,536 dimensions, with embedding input cut at 24,000 characters. It fuses the two top-50 lists by reciprocal rank (k = 60). No gbrain code runs in it.

`eval/runner/lme-plain-hybrid.ts` gives each question its own namespace. It fills the namespace through the scoreboard's sanitizer (opaque source ids, conversations in event-time order) and asks two things at k = 50: the question and the probe. Dataset: LongMemEval-S cleaned, Hugging Face `xiaowu0162/longmemeval-cleaned` at `98d7416c`, SHA-256 `d6f21ea9…`, verified by the repository's fetcher.

## What we could not verify

- gbrain's verbatim-probe and recall@10 numbers have no committed per-question records, so they are unpaired (see above). gbrain's probe rank is not recorded either, so we can't compare rank 1.
- The gbrain rows ran gbrain's own harness (`gbrain eval longmemeval`, chunk retrieval with a reranker). The baseline ran this repository's runner on the same questions, dataset file and metric. The scorer is the same definition: every `answer_session_ids` entry among the first k distinct conversations.
- Thirteen haystacks repeat a conversation id. Plain hybrid keeps one row per id (the later copy), so a repeated conversation is searched once.
- One question (`36580ce8`) failed its first pass because the probe's full-text query errored. It was re-run with a runner change that records a failed probe as a probe miss without failing the question (commit `f71f2e7b`). Its question retrieval is unaffected. Both receipts are saved.

## Reproduce

```sh
bun install --frozen-lockfile
bun run eval:decide fetch --benchmark lme-s
bun eval/runner/budget-ledger.ts init --budget-ledger <ledger> --program-cap-usd <cap>
bun eval/runner/lme-plain-hybrid.ts --out <dir> --budget-usd <cap> --budget-ledger <ledger> --concurrency 6 --embed-cache <dir>/embed-cache.json
python3 docs/benchmarks/2026-11-17-readme-baselines/longmemeval/scripts/analyze-retrieval.py <dir>/rows.ndjson <datasets>/longmemeval/longmemeval_s_cleaned.json
```

Reader arms (needs `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; a gbrain checkout at `c5fb0201`):

```sh
git clone https://github.com/garrytan/gbrain.git <gbrain> && git -C <gbrain> checkout c5fb0201 && ln -s "$PWD/node_modules" <gbrain>/node_modules
export RB_GBRAIN_DIR=<gbrain> LME_DATASET=<datasets>/longmemeval/longmemeval_s_cleaned.json W10_STATE_DIR=<state> \
  W10_MANIFEST_DIR=docs/benchmarks/2026-11-17-readme-baselines/longmemeval/manifests RB_LEDGER=<reader ledger>
bun eval/runner/budget-ledger.ts init --budget-ledger $RB_LEDGER --program-cap-usd <cap>
for a in rb-sonnet55-full rb-sonnet55-hybrid5 rb-sonnet55-none rb-opus55-hybrid5; do bun eval/runner/batch/w10.ts build $a; done
bun eval/runner/batch/w10.ts run rb-sonnet55-none --budget-ledger $RB_LEDGER --budget-usd <cap>   # opens the run; the first batch per model is a 10-question pilot
bash docs/benchmarks/2026-11-17-readme-baselines/longmemeval/scripts/drive-readers.sh            # every arm, then the official judge, one batch at a time
for a in rb-sonnet55-full rb-sonnet55-hybrid5 rb-sonnet55-none rb-opus55-hybrid5; do bun eval/runner/batch/w10.ts export $a docs/benchmarks/2026-11-17-readme-baselines/longmemeval/arms/$a --budget-ledger $RB_LEDGER; done
python3 docs/benchmarks/2026-11-17-readme-baselines/longmemeval/scripts/analyze-readers.py docs/benchmarks/2026-11-17-readme-baselines/longmemeval/arms > summary-readers.json
```

With `--parallel` on `run` and `judge`, an RB-LME batch can open while others are still unsettled. The ledger's caps still bound the sum. We used it for the whole-history batch and the first two judge passes while the Opus batch waited in Anthropic's queue. The reader and judge batches ran on 2026-11-17 from 07:49 to 12:21 UTC. The Opus 5.5 batch of 490 took 2 hours 53 minutes, after a 72-minute pilot. The Sonnet whole-history batch took 4 minutes. Outputs:

- `arms/<arm>/rows.ndjson`: answer, usage, settled cost and official verdict per question.
- `arms/<arm>/receipt.json`: manifest hash, batch ids and the preregistration attestation at `b9a4094b`.
- `manifests/` and `summary-readers.json`.

Retrieval needs `OPENAI_API_KEY`. The run took about four minutes on an 8-vCPU Ubicloud VM at concurrency 6 (`scripts/vm-setup.sh` bootstraps it). The committed outputs are `retrieval/rows.ndjson.gz` (one row per question, the last row of each question from `rows-raw.ndjson.gz`, both ranked lists), `retrieval/receipt-*.json` (settings, code identity, ledger usage) and `retrieval/summary-retrieval.json`.

After the runs, machine-local paths in the raw receipts were rewritten (`<work>/` for the run machine's scratch folder, `<vm>/` for the run VM, and repo-relative paths for the checkout) so the repository's receipt checks pass; no other field changed.

## Disclosures

gbrain is Garry Tan's own project.
