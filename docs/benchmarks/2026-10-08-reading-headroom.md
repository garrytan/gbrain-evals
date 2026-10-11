# Reading headroom on LongMemEval: 41% of what the reader gets is the answer's own sessions, and 4 to 6% of answers commit to a wrong value

Recounted 2026-10-08 from committed receipts. Status: **recount** (exploratory, $0, no model calls, not
preregistered). Evidence class: development (LongMemEval-S was used to tune gbrain's retrieval). Inputs: the
[W10a current-pin run](2026-10-07-longmemeval-w10a-current-pin.md) (gbrain `c5fb0201`, v0.60.95.0, 500 captured
reader requests, `claude-sonnet-5-5` reader) and the [W10b reader replay](2026-10-07-longmemeval-w10b-reader-replay.md)
(`claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol` reading the same 500 frozen requests). Nothing here is a
new measurement of gbrain; it recounts what those runs already recorded.

[gbrain](https://github.com/garrytan/gbrain) is a Markdown-first memory system for agents. On
[LongMemEval](https://arxiv.org/abs/2410.10813), a benchmark of questions about long histories of old
conversations, gbrain retrieves the five best-matching conversations and gives a reader model their full text.
That scores 468 of 500 with Sonnet 5.5, at about 22,000 reader tokens per question. This recount asks how much of
that text the answer needed, how much a reader writes down when it extracts what matters, and how often a wrong
answer states a wrong value instead of saying it does not know. Those are the three numbers a smaller evidence
brief has to beat.

## The finding

**The sessions that hold the answer are 41% of what gbrain delivers.** Across the 500 W10a requests, the reader
received a mean of 15,823 tokens of conversation text (ceil(characters / 4); 13,574 cl100k tokens), of which the
answer's own sessions were 6,490 (5,574 cl100k). A retriever that delivered only the sessions behind the answer,
and delivered them whole, would still send about 6,500 tokens, and about 8,980 on multi-session questions. So a
2,000-token budget cannot be reached by choosing better sessions: it needs about 3x compression inside the answer's
sessions, and about 4.5x on multi-session questions.

**A frontier reader's own notes are about 140 to 150 tokens.** Sonnet 5.5's visible notes plus answer average 138.5
tokens (p95 316.5), Opus 5.5's 150.8 (p95 343.6), and `gpt-6.1-sol`'s 62.5 (p95 188.2). What the reader extracts is
two orders of magnitude smaller than what it reads, which is why a model-written brief is plausible where every
deterministic shrink measured so far lost accuracy (audit A of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97), section 2.3).

**Most wrong answers commit to a value.** Of the 470 answerable questions, Sonnet 5.5 (W10a) got 30 wrong and 25 of
those stated a wrong value; Opus 5.5 got 25 wrong and 19 committed. On the same W10b text, Sonnet 5.5 committed 29 of
35 and `gpt-6.1-sol` 24 of 33. Adding the unanswerable questions a reader answered anyway, the committed-wrong rate
over all 500 is 5.4% (Sonnet 5.5, W10a), 4.0% (Opus 5.5), 6.4% (Sonnet 5.5, W10b) and 5.4% (`gpt-6.1-sol`). These
counts rest on an agent's labels of which wrong answers commit; no person has reviewed them.

## The concrete case

*From the data.* Question `e47becba` asks "What degree did I graduate with?" (answer: Business Administration).
gbrain delivered five conversations, 13,567 tokens in all. The answer is in one of them, a 4,509-token
conversation about organizing the user's routine, in one sentence: "I graduated with a degree in Business
Administration, which has definitely helped me in my new role." The other four conversations, 9,058
tokens, are what a better selector could drop; the 4,509 are what only compression inside the conversation can
shrink.

Two wrong answers show the difference between committing and declining. For `852ce960` ("What was the amount I was
pre-approved for when I got my mortgage from Wells Fargo?", answer $400,000), both conversations that mention the
pre-approval reached the reader, and Sonnet 5.5 answered "$350,000", noting the later $400,000 figure but going
with the earlier one. That is a committed wrong value. For `61f8c8f8` ("How much faster did I finish the 5K run
compared to my previous year's time?"), W10a's retrieval found one of the two conversations it needed, and all four
readers (W10a and W10b) said they could not work out the difference without the new time. That is wrong, but declined.

## The experiment

- **Delivered text.** Each W10a capture holds the exact reader request gbrain built. The recount splits it into
  its `<chat_session>` blocks, maps each block to its LongMemEval session through the harness row's retrieved
  slugs, and marks it gold when the session is one of the question's `answer_session_ids`. Sizes are
  ceil(characters / 4) of each trimmed block, the rule memory-qa's `approxTokens` uses, and gbrain's cl100k count
  beside it. The question, the prompt frame and the system prompt are not counted, so 15,823 is below W10a's
  22,167 Claude provider tokens per request.
- **What "gold" covers.** Only the answer sessions that reached the reader. Retrieval missed at least one answer
  session for 25 of the 500 questions and all of them for 1, so for those questions the true size of the answer's
  sessions is larger than counted here. The full haystack is not committed, so the recount cannot measure them.
- **Notes length.** ceil(characters / 4) of each stored answer (the reader's visible notes plus its answer), with
  cl100k and the provider's output tokens (which include hidden reasoning) beside it.
- **Commitment.** For every answerable question an arm got wrong under the official judge, a label says whether the
  answer commits to a value ([`commitment-labels.json`](2026-10-08-reading-headroom/commitment-labels.json)). An
  answer is **declined** when it gives no value for what was asked and disclaims any fact it mentions. Anything
  else is **committed**, however hedged: a conditional value ("0 days, assuming the visit was MoMA"), a candidate
  ("it may have been Target"), a partial value ("6 weeks for two of the three books") or generic advice for a
  preference question. A wrong answer to an unanswerable question (the judge found it answered instead of
  abstaining) counts as committed. The labels were written by the GBRA-60 wave 0 builder agent from the answer
  text, with the judge verdicts visible.

## Results

### What the reader receives, by question type (W10a, 500 requests)

| Question type | n | Delivered (chars/4) | Answer's sessions (chars/4) | Share | Answer's sessions (cl100k) | p95 answer's sessions (chars/4) |
|---|---|---|---|---|---|---|
| All | 500 | 15,823 | 6,490 | 41.0% | 5,574 | 13,109 |
| multi-session | 133 | 16,750 | 8,981 | 53.6% | 7,704 | 15,337 |
| temporal-reasoning | 133 | 16,183 | 7,759 | 47.9% | 6,631 | 14,102 |
| knowledge-update | 78 | 15,940 | 7,036 | 44.1% | 6,096 | 8,916 |
| single-session-preference | 30 | 17,422 | 4,601 | 26.4% | 4,011 | 6,132 |
| single-session-user | 70 | 15,355 | 3,622 | 23.6% | 3,108 | 4,847 |
| single-session-assistant | 56 | 12,330 | 1,393 | 11.3% | 1,200 | 2,631 |

Question types follow LongMemEval's labels, so the 30 unanswerable questions sit inside their types (12 in
multi-session). "Share" is the ratio of the two means.

### What the reader writes (notes plus answer)

| Reader | Run | Mean (chars/4) | Median | p95 | Mean (cl100k) | Mean provider output tokens |
|---|---|---|---|---|---|---|
| `claude-opus-5-5` | W10b | 150.8 | 130.0 | 343.6 | 152.6 | 294 |
| `claude-sonnet-5-5` | W10a | 138.5 | 119.5 | 316.5 | 138.3 | 203 |
| `claude-sonnet-5-5` | W10b | 137.8 | 117.5 | 317.1 | 138.1 | 203 |
| `gpt-6.1-sol` | W10b | 62.5 | 42.0 | 188.2 | 58.3 | 110 |

### Wrong answers that commit to a value

| Reader | Run | Answerable correct | Wrong | Declined | **Committed wrong** | Unanswerable answered | Committed wrong, all 500 |
|---|---|---|---|---|---|---|---|
| `claude-opus-5-5` | W10b | 445 / 470 | 25 | 6 | **19** | 1 / 30 | 4.0% |
| `claude-sonnet-5-5` | W10a | 440 / 470 | 30 | 5 | **25** | 2 / 30 | 5.4% |
| `claude-sonnet-5-5` | W10b | 435 / 470 | 35 | 6 | **29** | 3 / 30 | 6.4% |
| `gpt-6.1-sol` | W10b | 437 / 470 | 33 | 9 | **24** | 3 / 30 | 5.4% |

W10a and W10b differ in retrieval: W10a is gbrain `c5fb0201`'s own requests, W10b replays the 2026-09-29 requests,
so compare readers within W10b and compare the two Sonnet rows only as a check on retrieval. The receipts record no
reader errors and no `max_tokens` finishes in these arms.

## What to use and what to avoid

- **Use 6,500 and 9,000 as the floor for whole-session delivery.** Any arm that claims a smaller budget at the same
  accuracy has compressed inside the answer's sessions, not just selected better. A budget arm should report its
  size against these numbers.
- **Use the committed-wrong counts as the baseline for a brief's risk.** A brief that drops a later correction or a
  number turns a correct answer into a committed wrong one; the bar to beat is 19 to 29 per 470 answerable
  questions, by reader.
- **Do not treat these counts as a preregistered result.** The commitment labels are an agent's reading, the rule
  was written while reading the answers, and the declined/committed line has judgment calls (a candidate value
  counts as committed). The versioned outcome instrument planned as A10 replaces this recount for any gate.
- **Do not read "gold" as the full oracle.** For the 25 questions where retrieval missed an answer session, the
  answer's sessions are larger than counted.
- **Audit A's figures.** Audit A of the [10x memory advantage plan](https://github.com/garrytan/gbrain-evals/pull/97)
  quoted 6,489, 15,822 and 8,981 (these means truncated to integers), 138 to 150 for notes length and 25 and 19
  committed wrong; this recount reproduces them. Its p95 of 326 to 356 used an interpolating quantile that lands
  across a gap in the sorted lengths (the 475th and 476th of Sonnet's 500 sorted answer lengths are 316 and 327 tokens); this report
  uses the repository's `percentile`, which gives 316.5 and 343.6.

## Reproduce and inspect

```bash
bun eval/runner/reading-headroom.ts           # recompute and compare with the committed headroom.json
bun eval/runner/reading-headroom.ts --write   # rewrite headroom.json
bun test test/eval/reading-headroom.test.ts
```

- **Code.** [`eval/runner/reading-headroom.ts`](../../eval/runner/reading-headroom.ts); cl100k counts come from the
  installed gbrain's `src/core/chunkers/token-estimate.ts` (`@dqbd/tiktoken`, cl100k_base), and the run refuses to
  start when that encoder does not load.
- **Inputs.** The W10a capture (`capture/captures.ndjson.gz`, `capture/harness-rows.ndjson.gz`), the four arms'
  `rows.ndjson`, and the labels; their SHA-256 hashes are in the receipt.
- **Receipt.** [`headroom.json`](2026-10-08-reading-headroom/headroom.json), with per-type sizes, notes lengths,
  commitment counts and the declined question ids per arm.
- **Cost and time.** $0, no API keys, about 10 seconds.
