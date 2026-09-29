# LongMemEval answers without the answer key: 439/500, and the evidence budget matters more than the prompt

Published 2026-09-29. Measured 2026-09-29 on gbrain [PR 5676](https://github.com/garrytan/gbrain/pull/5676) at `a7cb37b7884ca4a6dba8bb82a4cd430e6a6e806f` (v0.59.13.0), since squash-merged to gbrain master as `b80cad6`.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. [LongMemEval](https://arxiv.org/abs/2410.10813) asks questions about long histories of old conversations. A memory system first has to find the right conversations. Then a language model (the "reader") has to answer from what was found, and a second model (the "judge") grades the answer against the dataset's reference.

## The finding

**With the answer key hidden, gbrain's house reader answered 439 of 500 questions correctly (87.8%).** In this configuration the reranker is off and the reader takes notes before answering (`notes` mode, 1,024 output tokens). The question denominator is all 500 questions of the cleaned `_s` split, including the 30 whose correct response is to say the information is not available.

**Swapping in a GPT-4o reader with LongMemEval's own reading prompt, on exactly the same retrieved sessions, gave 430/500 (86.0%).** Paired question by question, GPT-4o won 21 and lost 30 (exact McNemar p = 0.26). That is not a demonstrated difference between the two readers.

**How much evidence reaches the reader matters far more than how the reader is prompted.** On a fixed random 100 questions, the house reader scored 89/100 when it read the full retrieved conversations. It scored 65/100 when it saw only the five retrieved text chunks. Holding those five chunks fixed, three prompts tied:

- gbrain's production reader prompt: 65/100;
- a plain one-message retrieval prompt: 65/100;
- `gbrain think`'s synthesis prompt: 64/100.

**This is not the published configuration, and it does not measure the leak.** The historical 433/500 (September 6) came from a different setup in three ways:

1. It used the Voyage reranker. This run had no Voyage key, so the reranker was off.
2. It used the older `direct` reader with a 512-token limit.
3. Its reader could see LongMemEval session ids. Every labeled evidence session's id starts with `answer_`, so that reader could tell which conversations were the labeled ones.

With three changes at once, 439 versus 433 says nothing about how much the leak helped. The 433/500 figure stays in the record as historical and invalid.

**Answer accuracy is still not a matched comparison with vendor self-reports.** The GPT-4o arm uses the same reader model and official prompts as several published rows, but retrieval, context size and judges still differ. We claim no ranking on answers in either direction.

## The concrete case

*Invented example.* A user once told the assistant they had started a pottery class, and weeks later, in another conversation, that they had missed two sessions. The question: "How many pottery sessions have I attended so far?"

Answering needs both conversations, plus the dates to know which came first. gbrain returns its top five text chunks. The house reader then reads the whole conversation behind each distinct chunk; here that was about 4.9 conversations and 15,800 input tokens on average. The five chunks alone were about 3,400 tokens.

Questions like this, which combine facts from several conversations, are where the chunks-only readers lost most. On the 100-question subset, multi-session questions went from 18/19 correct with full conversations to 7/19 with the production prompt over chunks. Temporal-reasoning questions went from 20/23 to 12/23.

## The experiment

### Shared retrieval

Every arm used one retrieval run and one embedding cache:

- the cleaned `_s` dataset, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`;
- gbrain's own `gbrain eval longmemeval` harness, run unmodified;
- settings `--mode balanced --reranker off --autocut off --top-k 5 --no-trajectory`, no query expansion;
- OpenAI `text-embedding-3-large` at 1,536 dimensions, from a single embedding cache shared by all arms.

Session ids are opaque. Each session is imported as `chat/s-<10 hex>`, a per-question hash, so no slug, title or prompt carries the raw id.

We checked every saved reader prompt in every arm: 1,300 prompts in all (500 for arm a, 500 for arm b, and 100 for each chunk arm). None contains `answer_` or any retrieved raw session id.

Strict retrieval on these rows was 435/470 `recall_all@5` (92.55%). A question counts only when every labeled evidence session is among the first five chunk rows. September 6's reranker-off arm A1 scored 439/470. Paired against it, this run gained 1 question and lost 5 (exact McNemar p = 0.22). The code differs (v0.48.4.0 against v0.59.13.0, with page-grain fusion and opaque ids), so this is context, not a controlled test.

### Arms

| Arm | Reader | What the reader saw | Prompt |
|---|---|---|---|
| a | `anthropic:claude-sonnet-4-6`, provider-default temperature, 1,024 output tokens | full text of the distinct sessions behind the top-5 chunks (mean 4.91 sessions, 64,700 characters) | gbrain house reader, `notes` mode: data-boundary framing, abstention instruction, brief notes then a concise answer |
| b | `gpt-4o-2024-08-06`, temperature 0, 800 output tokens | the same sessions, sorted by date | LongMemEval's official `run_generation.py` reading prompt as its README recommends: JSON history, both speakers, "answer step by step" (`con`, which sets `--cot true`). Our TypeScript builder matched a Python reimplementation of `prepare_prompt` byte for byte on the 24 of 24 questions checked. |
| c1 | same as a | the same top-5 chunk texts, each with its session date and opaque id, plus the question date | gbrain's production LongMemEval reader prompt (notes, `<chat_session>` framing, sanitizer) |
| c2 | same as a | same as c1 | one plain user message: excerpts, current date, question |
| c3 | same as a | same as c1 | `gbrain think`'s production synthesis prompt and `<pages>` renderer, JSON output; answer plus gaps as the CLI prints them |

The component arms ran on a fixed random subset of 100 questions: `random.Random(20260929).sample(sorted(question_ids), 100)`. The ids are in `subset100_seed20260929.txt`. By type the subset has 23 temporal-reasoning, 21 knowledge-update, 19 multi-session, 16 single-session-user, 12 single-session-assistant, 5 single-session-preference and 4 abstention questions.

The harness rows do not store chunk text. To get it, we re-ran retrieval for those 100 questions with gbrain's own functions against the same cache. All 100 matched arm a's recorded list of chunks, with 0 cache misses, and the cache file's hash was unchanged afterwards.

Three deviations in c3 kept its evidence equal to c1 and c2:

- `think` has no question-date input, so the question was sent as `(Current date: X) <question>`, and each chunk carried a `date:` line.
- The excerpt limit was raised above the longest chunk, so nothing was cut. The production default is 2,400 characters per page for five pages.
- `think`'s own search, takes and graph were not used. The private `inferIntent` helper was copied verbatim.

This makes c3 a test of think's answering prompt, not of production think end to end.

### Judges

Each answer was graded twice, by two judges:

- **gbrain judge.** gbrain's `judge.ts`, using LongMemEval's official grading instructions inside a data-boundary wrapper; `openai:gpt-4o`, temperature 0, 16 tokens.
- **Official judge.** The verbatim `evaluate_qa.py` prompt through chat completions; `gpt-4o-2024-08-06`, temperature 0, 10 tokens, verdict = "yes" appears in the lowercased reply.

The two judges agreed on 490/500 answers in arm a, 492/500 in arm b, and 98, 97 and 98 of 100 in c1, c2 and c3. A reader error or judge error would count as incorrect. There were none.

## Results

### Full dataset (500 questions)

| Arm | Correct, gbrain judge | Correct, official judge |
|---|---|---|
| a, house reader over full sessions | **439/500 (87.8%)** | 443/500 (88.6%) |
| b, GPT-4o with official prompt over the same sessions | **430/500 (86.0%)** | 432/500 (86.4%) |

| Paired, b against a | GPT-4o better | House reader better | Exact McNemar p |
|---|---|---|---|
| gbrain judge | 21 | 30 | 0.26 |
| official judge | 16 | 27 | 0.13 |

By type, gbrain judge:

| Type | a | b |
|---|---|---|
| single-session-assistant | 55/56 | 55/56 |
| single-session-user | 62/64 | 62/64 |
| knowledge-update | 67/72 | 67/72 |
| temporal-reasoning | 108/127 | 108/127 |
| multi-session | 95/121 | 87/121 |
| single-session-preference | 24/30 | 23/30 |
| abstention | 28/30 | 28/30 |

Almost all of the difference between a and b sits in multi-session questions. When every labeled session had been retrieved (435 of the 470 answerable questions), arm a answered 403 correctly and arm b 395 (gbrain judge). With the official judge, the counts are 407 and 399.

### Component study (100 questions)

| Arm | Evidence | Correct, gbrain judge | Correct, official judge |
|---|---|---|---|
| a on the subset (reference) | full sessions, about 15,500 tokens | 89/100 | 90/100 |
| c1 production reader prompt | five chunks, about 3,400 tokens | 65/100 | 65/100 |
| c2 plain retrieval prompt | same five chunks | 65/100 | 64/100 |
| c3 think synthesis prompt | same five chunks | 64/100 | 64/100 |

| Paired comparison (gbrain judge) | Gains | Losses | Exact McNemar p |
|---|---|---|---|
| c2 against c1 | 3 | 3 | 1.0 |
| c3 against c1 | 3 | 4 | 1.0 |
| c1 against a | 4 | 28 | 1.9e-5 |
| c2 against a | 5 | 29 | 3.9e-5 |
| c3 against a | 3 | 28 | 4.6e-6 |

The official judge gives the same picture. c2 against c1 and c3 against c1 are both +3/−4 (p = 1.0), and every chunk arm against a has p below 1e-5.

At this sample size the three prompts are indistinguishable. That means no demonstrated difference, not proof that they are equal. The large, clear effect is the evidence budget: give the reader the whole retrieved conversations, not just the matching passages.

## What to use and what to avoid

- **Give the reader whole retrieved conversations when you can afford the tokens.** On this benchmark, full sessions cost about 4.6 times the input tokens of five chunks and bought 24 more correct answers per 100 questions.
- **Do not expect prompt wording to rescue thin evidence.** gbrain's reader prompt, `think`'s prompt and a plain prompt tied on chunks.
- **Reader choice is second order here.** Sonnet 4.6 with notes and GPT-4o with the official step-by-step prompt were within noise on the same evidence. GPT-4o was cheaper per question ($0.039 against $0.051 for the reader call) and faster (3.2 s against 7.1 s median).
- **Limits:**
  - This is one benchmark, whose retrieval configuration was chosen on these same 470 questions.
  - The reranker was off.
  - The component study has 100 questions.
  - The house reader ran at provider-default temperature, so repeat runs can differ slightly.
  - Arm c3 tests think's prompt, not its full retrieval path.

## Tokens, latency, failures and cost

Input tokens are the provider-reported counts for each reader call, so they measure what the model actually received.

| Arm | Input tokens mean / median / p95 | Output tokens mean | Reader latency p50 / p95 |
|---|---|---|---|
| a | 15,798 / 16,080 / 19,655 | 269 | 7.1 s / 12.2 s |
| b | 14,775 / 15,003 / 18,529 | 241 | 3.2 s / 7.7 s |
| c1 | 3,439 / 3,503 / 3,947 | 187 | 5.8 s / 11.6 s |
| c2 | 3,220 / 3,281 / 3,725 | 116 | 5.0 s / 10.8 s |
| c3 | 3,892 / 3,956 / 4,397 | 309 | 8.4 s / 14.9 s |

Arm a took 29.4 s per question end to end at the median and 36.3 s at p95 (500 questions). That covers import, embedding about 116,000 haystack tokens with a cold cache, search, reader and judge. Embedding took about 16 s of it.

Failures:

- Reader provider failures: 0 in every arm (500 + 500 + 300 calls, no retries).
- Judge failures: 0.
- Output-limit truncations: 0.

### Incidents

These are infrastructure problems, kept separate from provider failures.

- The cloud machine running arm a restarted after 114 of 500 questions. The rows file and embedding cache were intact. The run resumed on a Ubicloud VM from the same rows file and the same cache.
- The harness process then stalled at 100% CPU four times, roughly once every 100 questions of a single process. The first stall was on question `6c49646a`, which runs cleanly on its own. Each stall happened while a question's conversations were being imported and embedded, never during a reader call.
- Each time, a watchdog killed the process and resumed. The killed question's embeddings rolled back and were redone. No reader call was ever repeated: 500 calls for 500 questions.
- The pattern matches gbrain #5092: in-memory database memory grows with each question until a long single-process run stalls near questions 90 to 120. gbrain master fixed this after this run by replacing the benchmark database every 40 questions.

The log is in [`logs/a-watchdog.txt`](2026-09-29-longmemeval-opaque-qa/logs/a-watchdog.txt).

### Cost

Paid API cost is computed from provider-reported usage at list prices: Sonnet 4.6 $3 / $15 per million input / output tokens, GPT-4o $2.50 / $10, `text-embedding-3-large` $0.13.

| Item | USD |
|---|---|
| a reader, 500 calls | 25.55 |
| a embeddings, 58.37M tokens, including the pilot and re-embedding after the four kills | 7.59 |
| a judges (gbrain + official) | 1.03 |
| b reader | 19.67 |
| b judges | 1.08 |
| c1 / c2 / c3, including both judges | 1.49 / 1.28 / 1.82 |
| smoke tests outside the arms | about 0.07 |
| **Total** | **about 59.6** |

A 20-question pilot (drawn from the seeded subset, cost $1.38) projected about $66 before the full run. The pilot rows are part of arm a, since the run resumed from them. Ubicloud compute (one 4-vCPU VM for about 6.2 hours) is not included.

## Reproduce and inspect

Receipts are in [`2026-09-29-longmemeval-opaque-qa/`](2026-09-29-longmemeval-opaque-qa/):

- `summary.json`: every metric and paired test.
- `per_question.csv`: correctness for every question, arm and judge.
- `a/rows.ndjson`: arm a's harness rows and summary.
- `a/official-judge.ndjson`: the official judge over arm a.
- `a/calls.ndjson.gz`: every paid call of arm a, with full reader prompts and answers and full judge prompts.
- `b/rows.ndjson.gz`: arm b's prompts, answers and both judges.
- `c/c1.ndjson`, `c/c2.ndjson`, `c/c3.ndjson`: the component arms.
- `c/chunks.ndjson`: the chunk texts with the match check.
- `logs/`: run logs.
- `scripts/`: the executed scripts.
- `provenance.json`: code, dataset and cache identities, prices, compute, and the SHA-256 of each executed script.

The dataset and the 945 MB embedding cache are not committed; their hashes are in `provenance.json`. Committed scripts and logs differ from the executed ones only in machine-local paths: the run directory becomes `$M6_DIR` and the gbrain checkout becomes `GBRAIN_DIR`.

gbrain-judge prompts for arms b and c are not stored verbatim. They follow deterministically from `buildJudgePrompt` in gbrain's `src/eval/longmemeval/judge.ts` and the stored answer.

A keyless recount checks the saved verdicts, the paired tests, the strict recall count and the prompt leak check against `summary.json`:

```bash
python3 scripts/verify-longmemeval-opaque-qa.py
```

To re-run, use gbrain v0.60.6.0 master. It contains PR 5676 plus later changes to hybrid search and the harness (including the #5092 fix), so expect close but not identical numbers. Keys needed: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Replace `GBRAIN_DIR` in the scripts with the gbrain checkout path, and download the dataset from the link above into `$M6_DIR/data/`.

```bash
git clone https://github.com/garrytan/gbrain.git && (cd gbrain && git checkout v0.60.6.0 && bun install)
export M6_DIR=$PWD/m6 GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large GBRAIN_EMBEDDING_DIMENSIONS=1536
mkdir -p $M6_DIR/data && cp docs/benchmarks/2026-09-29-longmemeval-opaque-qa/scripts/* docs/benchmarks/2026-09-29-longmemeval-opaque-qa/*.txt $M6_DIR/
sed -i "s#GBRAIN_DIR#$PWD/gbrain#g" $M6_DIR/*.ts && ln -s $PWD/gbrain/node_modules $M6_DIR/node_modules
cd $M6_DIR
./run-a-full.sh                     # arm a, about 4 hours sequential on a cold cache
bun arm-b.ts --rejudge-a            # official judge over arm a
bun arm-b.ts                        # arm b
bun c-retrieve.ts                   # chunk texts for the subset; never while another LongMemEval process uses the cache; resumes if re-run
bun arm-c.ts c1 && bun arm-c.ts c2 && bun arm-c.ts c3
python3 analyze.py
```

`c-retrieve.ts` keeps one in-memory database for all 100 questions, so it can hit the #5092 stall; re-running it resumes where it stopped. Arm a with the house configuration alone, through gbrain's CLI:

```bash
gbrain eval longmemeval longmemeval_s_cleaned.json --top-k 5 --no-trajectory --mode balanced --reranker off --autocut off \
  --model anthropic:claude-sonnet-4-6 --judge --judge-model openai:gpt-4o --by-type --output rows.ndjson
```

## Open questions

- **A reranker-on house number** needs a Voyage key. The historical release configuration used `voyage:rerank-2.5`.
- **The leak's own effect.** Isolating it needs the old `direct` 512-token reader with opaque ids and the reranker matched to the September 6 run.
- **Production `think` end to end,** with its own search over the benchmark brain.
- **Cheaper ways to deliver more evidence,** since that is where the accuracy is. Examples: expanding chunk hits to their sessions, or more chunks at an equal token budget.
- **The September 25 reading-notes transfer result (308/361 to 324/361)** was not re-run here and remains pending.
