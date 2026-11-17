# LongMemEval without gbrain: plain hybrid search, the whole history and no memory

Measured 2026-11-17 against [the preregistration](../../../plans/2026-11-17-readme-baselines/PREREG.md). No gbrain arm was run again: every baseline below pairs, question by question, with gbrain's committed records at the commit README names.

## Takeaways

- **We learned that gbrain finds every needed conversation more often than plain hybrid search does: 451 against 414 of 470 in the top five.** On the same 470 answerable LongMemEval-S questions, gbrain's release retrieval (gbrain `109b992`) found all the labelled evidence conversations in its top five on 37 more questions than plain Postgres full-text plus pgvector search fused by reciprocal rank. gbrain alone got 45 questions and plain hybrid alone got 8 (exact McNemar p = 2.4e-7; gbrain ahead by 7.9 points, 95% interval 4.9 to 10.8). **You should use gbrain's retrieval, not plain hybrid search, when a question needs several conversations:** the gap is in multi-session (112 against 100 of 121) and temporal-reasoning questions (117 against 101 of 127).
- **We learned that plain hybrid search already finds a quoted message.** Asked for the first 300 characters of a saved message word for word, plain hybrid returned the right conversation first for 491 of 500 questions and in its top 10 for 499. gbrain returned it among its cited conversations for all 500, so there's no measurable difference on this probe. **You don't need gbrain to look up an exact quote;** full-text search does that. The one plain-hybrid miss is a message with a long run of dashes that overflows Postgres's full-text query parser. gbrain had the same bug and fixed it in gbrain#6391.
- **The answer rows (Sonnet 5.5 and Opus 5.5 readers) are still running.** This page gets their results when the judges finish.

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
- **Strict recall@10:** gbrain's four misses aren't named. Every possible placement of them gives a **gbrain win**: between 16 and 20 questions only gbrain got, and between 0 and 4 only plain hybrid got, with exact McNemar p from 3.1e-5 to 0.0015.

**Why null on the probe?** The probe asks for a passage copied word for word, which keyword search matches almost by definition. Both systems are at the ceiling, so there's no headroom left to separate them.

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

Needs `OPENAI_API_KEY`. The run took about four minutes on an 8-vCPU Ubicloud VM at concurrency 6 (`scripts/vm-setup.sh` bootstraps it). The committed outputs are `retrieval/rows.ndjson.gz` (one row per question, the last row of each question from `rows-raw.ndjson.gz`, both ranked lists), `retrieval/receipt-*.json` (settings, code identity, ledger usage) and `retrieval/summary-retrieval.json`.

## Disclosures

gbrain is Garry Tan's own project.
