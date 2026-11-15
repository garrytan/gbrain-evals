# With no embedding key, gbrain search now adds pages that hold only some of the question's words: LongMemEval recall_all@10 goes from 80.64% to 91.06%

- **We learned that keyless gbrain now finds every conversation a question needs far more often.** [gbrain#9414](https://github.com/garrytan/gbrain/pull/9414), merged to gbrain master as `23a163fc` on 2026-11-15, lets `search` and `query` add pages that hold only some of the question's words when the first page of results comes back short, on a brain with no embedding provider. On LongMemEval S (470 scored questions), asked through gbrain's `query` operation, recall_all@10 rose from 80.64% (379) to 91.06% (428): +10.43 points, 95% interval +7.87 to +13.19, with 49 questions better and none worse. 45 of those 49 need two or more conversations, and 44 already had at least one of them in the top 10, so most of the gain completes evidence that search had only partly found. If your agents use gbrain without an embedding key, you should move to the first gbrain release that contains `23a163fc`. The newest release today, v0.60.724.0, does not.
- **We learned that nothing gbrain returned before moves, so ranking barely changes.** On all 500 questions the rows master returned came back first, unchanged in page, chunk, conversation, rank and score, and none of the 451 questions with a gold row in the top 10 saw it ranked lower. The new rows only fill empty places after them. MRR@10 went from 0.8726 to 0.8770 (+0.0044, 95% interval +0.0011 to +0.0086): it can rise only on questions where master had no gold row in the top 10, and it did on 6 of them, where the gold row arrived at rank 2 to 9. You should read this as a recall fix, not a ranking fix. An agent that reads only the first row gains nothing.
- **It costs a median 73 to 83 ms per question through `query` on our machine, and only when rows are added.** That happened on 103 of 500 questions. Those took a median 73 ms longer (p95 114 ms) in one pair of runs and 83 ms (p95 125 ms) in the other, and the other 397 questions changed by a median of 2 ms or less. On the gbrain team's slower machine the same 103 questions took a median 125 ms longer (p95 210 ms). You should expect the extra time only on questions whose first page comes back short.

The gbrain team ran the first measurement of this change and shared its raw rows. gbrain-evals reproduced it on 2026-11-15 on its own machine, keyless, on the same pair of commits (`4244fd77` against `b0529e73`) and on the merge that landed on master against its parent (`0a4ed211` against `23a163fc`). Every recall and MRR figure matches the gbrain team's to the digit, and the two pairs give identical figures. This check was not preregistered: it confirms a measurement that already existed. The change is on gbrain master and in no release yet. We recommend it for keyless use. gbrain says brains with embeddings take another search path and are unchanged; we did not test them.

## The case

gbrain stores notes as Markdown pages and searches them. With an embedding provider (an API key for a model that turns text into vectors), search can match meaning. Without one, which is how gbrain installs by default, it uses only its keyword index. Whenever at least one page contained every word of the question, that index returned only such pages, so a page missing even one word never came back. gbrain's release note gives a small example: "SSO Starter plan" found the pricing and decisions pages and never the call notes that mention SSO and Starter.

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) tests memory over long chat histories. Each question comes with about 50 earlier chat sessions, and the answer sits in one or more of them. Here is one of the 49 questions that improved (`gpt4_6ed717ea`), quoted from the dataset:

> Which item did I purchase first, the dog bed for Max or the training pads for Luna?

The answer needs two conversations, one about each purchase. Before the change, keyless search returned a single row, from one of them. After it, search added pages holding some of the words, and the other conversation came back at rank 2.

What the change does, from gbrain's release note and code: when the first page of results comes back shorter than its limit, search asks the keyword index once more for pages that hold some of the words, scores them below the lowest row already returned, and appends them up to the limit. They never repeat a page and carry `keyword_fill: true`. Only the `search` and `query` operations (the CLI commands and MCP tools of those names) add these rows. Features that call search internally, such as think and recall, get the rows they got before. In this run, master had returned at most 4 rows on every question where rows were added.

## The experiment

- **Data.** The cleaned LongMemEval S release ([dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned), MIT licence), 500 questions, file sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. The 30 abstention questions, whose answer is not in the history, stay out of the scores, as the harness does by default, which leaves 470.
- **Brain.** For each question, gbrain's own LongMemEval harness imports that question's sessions into a new PGLite brain (gbrain's embedded Postgres) with no embedding provider. It then asks the question through gbrain's `query` operation, as an agent would over MCP, with query expansion off, and scores the top 10 rows.
- **Arms.** Four gbrain commits in two pairs:

  | Arm | gbrain commit | What it is |
  |---|---|---|
  | Before, pair 1 | `4244fd77` | master before the change, the gbrain team's base |
  | After, pair 1 | `b0529e73` | a commit on the pull request's branch, the one the gbrain team measured |
  | Before, pair 2 | `0a4ed211` | master just before the merge (the merge's parent) |
  | After, pair 2 | `23a163fc` | the merge of #9414 on master |

  Pair 1 carries more than this change. `b0529e73` is not the pull request's final head: `b6884dd0d` came later, with master merges and release-note, changelog and test commits. Since `4244fd77`, the branch had also merged work from other pull requests that was not yet on master. Pair 2 isolates the change: `23a163fc` is #9414's squash merge, `0a4ed211` is its only parent, and merging the final head into `0a4ed211` gives exactly `23a163fc`'s tree.

- **No keys.** Every provider key was unset and each arm got a new, empty `GBRAIN_HOME`. Every row of every arm records that vector search was off for lack of a provider, and no arm made a model call.
- **Command,** run from each gbrain checkout:

  ```
  bun run src/cli.ts eval longmemeval longmemeval_s_cleaned.json --retrieval-only --top-k 10 --no-trajectory --mode balanced --reranker off --autocut off --by-type --via-operation query --op-expand off --output <arm>.jsonl
  ```

- **Machine.** One cloud machine with 4 vCPUs and 15 GiB of memory, Ubuntu 24.04, bun 1.4.4. The two arms of each pair ran side by side, so they shared the same load. Each arm ran once and took 6.4 to 7 minutes.
- **Measures.**
  - *recall_all@10*: every gold conversation appears among the conversations of the top 10 rows. It is the complete-evidence rate a reader needs.
  - *recall_all@5*: the same within the top 5 rows.
  - *MRR@10*: 1 divided by the rank of the first row from a gold conversation in the top 10, or 0 if none.
  - *Intervals*: paired bootstrap over the 470 questions, taken in the order their rows appear in each pair's before-arm file, 10,000 resamples, seed 7, 2.5th and 97.5th percentiles. Resampling the questions in another order can move a bound slightly.
  - *Unchanged rows*: the after arm's first rows equal every row the before arm returned, field by field and in order.

## Results

| Measure (470 scored questions) | Before | After | Difference | 95% interval | Better / worse |
|---|---|---|---|---|---|
| recall_all@10 | 80.64% (379) | 91.06% (428) | +10.43 points | +7.87 to +13.19 | 49 / 0 |
| recall_all@5 | 72.13% (339) | 81.06% (381) | +8.94 points | +6.60 to +11.70 | 42 / 0 |
| MRR@10 | 0.8726 | 0.8770 | +0.0044 | +0.0011 to +0.0086 | 6 / 0 |
| Questions with a gold row in the top 10 | 451 | 457 | +6 | | 6 / 0 |

The table holds for both pairs. `0a4ed211` returned the same rows as `4244fd77` on 500 of 500 questions, and `23a163fc` the same rows as `b0529e73` on 500 of 500, so the 19 master commits between the two bases changed nothing here, and the merge behaves exactly like the branch the gbrain team measured.

- **Earlier rows unchanged:** 500 of 500 questions in each pair.
- **Rows added:** on 103 questions (100 of them scored), 1,575 rows in all, always after master's rows.
- **Ranked lower:** 0 of the 451 questions where master had a gold row in the top 10.

recall_all@10 by question type:

| Question type | Questions | Before | After |
|---|---|---|---|
| temporal-reasoning | 127 | 90 (70.87%) | 112 (88.19%) |
| knowledge-update | 72 | 58 (80.56%) | 70 (97.22%) |
| multi-session | 121 | 90 (74.38%) | 101 (83.47%) |
| single-session-preference | 30 | 23 (76.67%) | 26 (86.67%) |
| single-session-user | 64 | 62 (96.88%) | 63 (98.44%) |
| single-session-assistant | 56 | 56 (100.00%) | 56 (100.00%) |

Where the 49 better questions come from, by how many gold conversations each needs: 4 need one, 36 need two, 6 need three, 2 need five and 1 needs six. In 44 of the 49, master had already found at least one gold conversation, and the added rows supplied the rest.

**Latency.** Time for each question's `query` call, one sample per question:

| Pair and machine | Before, median / p95 | After, median / p95 | Added on the 103 questions with new rows, median / p95 | Added on the other 397, median |
|---|---|---|---|---|
| Pair 1, our machine | 137 / 184 ms | 144 / 193 ms | +73 / +114 ms | -2 ms |
| Pair 2, our machine | 140 / 195 ms | 153 / 204 ms | +83 / +125 ms | +1 ms |
| Pair 1, gbrain team's machine | 251 / 342 ms | 268 / 368 ms | +125 / +210 ms | 0 ms |

Each median and p95 is the sorted value at 0-based position floor(0.5 × n) or floor(0.95 × n), as `analyze.py` computes them. With 500 questions that is one place above the nearest-rank figures in the harness's summary line at the end of each row file, so some of those differ by 1 or 2 ms.

The `query` operation costs more than one extra keyword lookup because it runs its later steps twice, once without the added rows and once with them, and returns the second result only when every other row, the confidence grade and the delivered text are the same. That check is what guarantees the unchanged rows. The gbrain team also timed the search function alone, with a timing harness that was not committed ([`bench4.jsonl.gz`](2026-11-15-keyless-partial-match-search/gbrain-team/bench4.jsonl.gz)): the extra lookup added a median 37.8 ms (p95 55.3 ms) on the 103 questions where it ran and 0.3 ms on the others. We did not reproduce that figure. Each arm ran once, so the 10 ms gap between our two pairs is not a measured difference between the branch and the merge, whose rows are identical.

## How this compares with the gbrain team's measurement

- **Recall and MRR match exactly.** Every recall, MRR, better and worse, unchanged-row, added-row and ranked-lower figure in the gbrain team's report is the same in ours. The gbrain team's own analysis script, run on each of our two pairs, prints the same figures.
- **The rows match question by question.** On both commits, the pages, chunks, conversations and order agree with the gbrain team's rows on 500 of 500 questions. Scores differ in their last printed digit (0.06232 against 0.06233, for example) on 5 questions at `4244fd77` and 6 at `b0529e73`. The gbrain team found that gbrain's scores carry a small clock-dependent term, so two live runs can differ this way; we did not check that.
- **Latency differs with the machine.** Their machine was slower across the board (master's median `query` call took 251 ms there and 137 ms here), and the added time scales with it: +125 ms median there, +73 and +83 ms here.

## What to use and what to avoid

- **Use it if your agents run gbrain without an embedding key.** An agent calling `search` or `query` gets the complete evidence for 49 more of these 470 questions and loses nothing it had. Take the first gbrain release that contains `23a163fc`.
- **Don't expect better ranking.** The added rows always sit below the rows search already returned.
- **Features that search internally don't get it.** gbrain's release note says think, recall, enrichment and other internal callers get the rows they got before. We did not test them.
- **Limits of this result.** One dataset of chat histories. PGLite only; Postgres was not measured here. Retrieval only: no answers were generated or judged, so the effect on answer accuracy is unmeasured. One run per arm, so each latency figure is a single sample per question. Not preregistered.

## Reproduce and inspect

Get the dataset from the [cleaned LongMemEval release](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) and check its sha256 above. Then, for each of the four commits:

```bash
git clone https://github.com/garrytan/gbrain.git gbrain && cd gbrain
git worktree add --detach ../gbrain-23a163fc 23a163fc5150397f931defc93a724e6a5d23b161
cd ../gbrain-23a163fc && bun install --frozen-lockfile
unset OPENAI_API_KEY ANTHROPIC_API_KEY VOYAGE_API_KEY GEMINI_API_KEY   # and every other provider key; provenance.json lists the ones we unset
export GBRAIN_HOME="$(mktemp -d)"
bun run src/cli.ts eval longmemeval /path/to/longmemeval_s_cleaned.json --retrieval-only --top-k 10 --no-trajectory --mode balanced --reranker off --autocut off --by-type --via-operation query --op-expand off --output landed-23a163fc.jsonl
```

Each arm took about 7 minutes on a 4-vCPU machine with two arms running side by side. The harness exits with status 1 at the end because every row was scored without vector search; for a keyless run that is the expected condition, and the run itself reports 0 errors.

Recount every number on this page from the committed rows, in a few seconds, with Python 3's standard library:

```bash
python3 docs/benchmarks/2026-11-15-keyless-partial-match-search/analyze.py           # prints the recount
python3 docs/benchmarks/2026-11-15-keyless-partial-match-search/analyze.py --check   # compares it with summary.json
```

Files in [`2026-11-15-keyless-partial-match-search/`](2026-11-15-keyless-partial-match-search/):

- `rows/`: our four runs, one row per question plus the harness's summary line. Each row keeps the question id and type, gold conversation ids, every returned row (page, chunk, conversation, rank, score), the hit flags, the search metadata and the `query` latency. The dataset's question, answer and retrieved text fields were removed; [`provenance.json`](2026-11-15-keyless-partial-match-search/provenance.json) records the sha256 of each full output.
- `gbrain-team/`: the gbrain team's rows for `4244fd77` and `b0529e73`, unchanged, and their search-function timing rows.
- [`analyze.py`](2026-11-15-keyless-partial-match-search/analyze.py) and [`summary.json`](2026-11-15-keyless-partial-match-search/summary.json): the recount and its output.
- [`provenance.json`](2026-11-15-keyless-partial-match-search/provenance.json): commits, dataset, command, keys unset, machine, run times and file hashes.

## Notes on the run

- gbrain-evals tracks this reproduction as GST-2789. gbrain tracks the change as GST-2762, and its team's measurement as GBRA-535.
- The gbrain team's files are named as they shared them (`base-query4`, `branch-query4`, `bench4`).

## Disclosures

gbrain is Garry Tan's own project.
