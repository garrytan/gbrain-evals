# Model Ladder (Cat 40): does gbrain help agents finish company-knowledge tasks, and does that hold as models improve?

Measured 2026-10-02 and 2026-10-03. The protocol is in
[2026-10-02-model-ladder-protocol.md](2026-10-02-model-ladder-protocol.md), and the reasons for the experiment are in
[the knowledge-layer plan](../plans/2026-10-01-knowledge-layer/PLAN.md).

> **Correction, 2026-10-04: gbrain's AI search was partly switched off in every gbrain run below.**
> The old budget ledger stalled the runner's event loop, and the same loop carries gbrain's embedding requests
> through the metering proxy. When those requests stalled, gbrain quietly fell back to keyword-only search.
> Evidence:
> - Replaying a recorded search on the same build (`51a30c1`), brain and arguments returns different results
>   today. With embeddings made unreachable, it returns exactly the recorded results.
> - Rerunning the 30 dev-world renewal-brief cells (family E) of `51a30c1` under the fixed ledger scored 4 of 30,
>   against 14 of 30 in the fix-wave ladder.
>
> So the gbrain results in this report measure gbrain with vector search often degraded, and its comparisons with
> plain files are not comparisons of gbrain as configured. Comparisons between gbrain builds within one run shared
> the condition. The plain-file, memory-tool and oracle arms make no provider calls through the proxy. The pg arm
> embeds its queries inside the runner, which waits rather than falls back. The ledger fix is gbrain-evals v0.10.16.
> Runs since then are in [the cost wave section](#cost-wave-v060440-measured-on-the-fixed-harness). gbrain against
> plain files has not been re-measured under the fixed harness.

## The finding

**At release v0.60.27.0, gbrain did not help agents.** An agent with plain Markdown files and `grep` finished more
tasks than the same agent using gbrain's MCP server. Across 11 models, gbrain was 8 points lower pooled
(95% CI −13 to −4; 7,624 runs, no output cap). It also leaked finance-only data more often than any other setup:
64 of 330 permission runs, against 17 for plain files. On a 52,000-document version of the same company, the gap
was 16 points (CI −24 to −10). Grep kept up at that scale.

**A wave of read-path fixes changed the result.** The fixes are the gbrain PR that accompanies this report, measured
on the development world at gbrain `51a30c1`. On the same tasks, gbrain went from 423 to 494 of 550 runs and passed plain files at 455.
Pooled across the 11 models, it is now 7 points ahead of the best simple setup (CI +3 to +9). It leads on 8 models,
ties on 1 and trails on 2. It leaks nothing (0 of 110 permission runs, against 6 for files), and it ties or leads
files in every task family.

**The fixes held up on a world nobody looked at while fixing.** A second world, generated from a new seed, was
run with 6 models and 2 repeats against the build that ships (`77dcf414`). There the fixed gbrain beat the release by
17 points (CI +10 to +24, better on 29 of 50 tasks and worse on 10). It finished 6 points more tasks than plain files,
but that interval runs from −0.2 to +12, so on unseen tasks gbrain with the fixes is at least level with grep, not
proven ahead of it. It leaked nothing in 120 permission runs; plain files leaked 9 times.

**Two costs and one open question remain.**
- Price: a gbrain run costs 2.5 to 4 times a file run ($0.19 against $0.054 per task here, $0.13 against $0.032 on
  the held-out world), mostly because 33 tool definitions ride along on every turn.
- Speed: in the harness, gbrain calls looked several times slower after the fixes. That is a harness artifact (see
  [cost and speed](#cost-and-speed)). Replayed alone, the fixed build's searches are as fast as the release's.
- The slope: the experiment cannot say whether gbrain's advantage grows with model capability. The strongest models
  already score 96–100% with every setup, so there is no room left to see a slope.


## The concrete case

Here is an invented example of the kind of question this benchmark asks. "What payment terms are currently in force
with Murari Logistics?"
- The master agreement, signed in 2025, says Net 45.
- An executed amendment changed that to Net 30, but the amendment names the customer only by its account code,
  MULI.
- A later internal email guesses wrong.
- An agent-written note summarizes the original contract.

To get it right, an agent has to find the amendment, notice that it is executed and not a draft, and prefer it over
the other three sources.

## The experiment

**The world.** Acme Example Inc., a fictional company with 100 customers and 3,973 documents: contracts, amendments,
CRM records, about 1,900 emails, 900 meetings (a fifth of them long transcripts), 600 tickets, agent notes, finance
memos and auto-generated digests. Documents are filed by system (`mail/2026-03/...`, `tickets/...`), not by customer.
They name customers by full name, by account code or, in routine chatter, by an ambiguous first word that 25 pairs of
customers share. A ledger generates the world before any prose, so the answer key never comes from reading documents
back (`eval/generators/model-ladder-gen.ts`, seed 20261002).

**50 tasks, 10 per family.** The agent works for an account manager who is not in finance.

| Family | What it tests |
|---|---|
| A. Authority | Which source governs a contract term: executed amendments versus drafts, emails and agent guesses |
| B. True now | Current and as-of account owners across a handoff, a future-dated change said mid-transcript, and reversals |
| C. Permissions | Answer when allowed. Refuse a finance-only discount, including when an unlabeled digest repeats it |
| E. Evidence | A five-part renewal brief spread over CRM, contracts, tickets, mail and a long transcript |
| F. Write-back | Record a correction in one session, then use it in a fresh one |

**The arms.** One agent loop runs every arm, with the same prompt, the same `submit_answer` tool, 16 turns and no
tool-output cap. Only the tools differ.

| Arm | Tools |
|---|---|
| `oracle` | The task's documents in the prompt (minus finance-only material), no tools; the capability index |
| `fs` | `list_dir`, regex `grep`, `read_file`, `write_file` over the Markdown files |
| `fs-acl` | `fs` with finance-only files removed (permissions family only) |
| `memory` | Anthropic's memory tool over the same files |
| `pg` | Plain Postgres full-text and pgvector search, get and save document |
| `gbrain` | gbrain's MCP server over stdio, `--surface starter` (33 tools), with its server instructions |

gbrain's own provider calls go through a metering proxy and count toward each run's cost. Writes go to per-run
overlays, and gbrain brains are restored after every run, so no run sees another's notes.

**The models.** Two ladders, plus extra rungs:
- Anthropic: Haiku 4.5, Sonnet 4.6, Sonnet 5, Sonnet 5.5, Opus 5.5.
- OpenAI: GPT-5.4-mini, GPT-5.4, GPT-5.5, GPT-6 Sol, GPT-6.1 Sol, GPT-6 Astra.

All run with provider defaults.

**Scoring.** A run succeeds when the submitted value matches the ledger and names none of the task's wrong values. For
briefs, all five fields must match. A finance-only string in the answer is a leak and fails the run. A write to a
contract fails the run. A fixed judge (`gpt-5.4-mini`) counts unsupported claims but never decides success.

## Results

### Release v0.60.27.0: grep beats gbrain

Uncapped, 11 models, two to three repeats, 7,624 runs ([folder](2026-10-02-model-ladder/baseline-uncapped/)):

| Model | oracle | fs | pg | memory | gbrain | gbrain − best simple arm [95% CI] |
|---|---|---|---|---|---|---|
| Haiku 4.5 | 100% | 58% | 53% | 51% | 55% | −3 [−17, 6] |
| Sonnet 4.6 | 96% | 61% | 65% | 60% | 55% | −10 [−23, −1] |
| Sonnet 5 | 96% | 82% | 62% | 62% | 71% | −11 [−20, −2] |
| Sonnet 5.5 | 99% | 92% | 82% | 78% | 82% | −10 [−18, −2] |
| Opus 5.5 | 98% | 97% | 89% | 78% | 91% | −6 [−12, −1] |
| GPT-5.4-mini | 97% | 63% | 55% | 50% | 34% | −29 [−41, −18] |
| GPT-5.4 | 99% | 69% | 59% | 58% | 52% | −18 [−30, −6] |
| GPT-5.5 | 100% | 91% | 81% | 72% | 89% | −2 [−12, 8] |
| GPT-6 Sol | 100% | 96% | 88% | 73% | 94% | −2 [−7, 4] |
| GPT-6.1 Sol | 100% | 97% | 91% | 91% | 99% | +2 [−2, 6] |
| GPT-6 Astra | 100% | 100% | 97% | 85% | 98% | −2 [−6, 0] |

Pooled: −8 points [−13, −4]. On the slope against capability (+3.3, CI −0.05 to 12.3), gbrain does relatively better
on stronger models, but the interval includes zero. Finance-only leaks in answers per 330 runs: fs 17, fs-acl 37,
pg 29, memory 15, gbrain 64.

The 52,028-document world, at the same release with 4 models, is in
[scale-tier/](2026-10-02-model-ladder/scale-tier/). Plain files stayed the best simple arm for every model, and gbrain
trailed by 16 points pooled [−24, −10], by between 4 points (GPT-6.1 Sol) and 26 points (Sonnet 5.5) per model.

The first pilot capped each tool result at 20,000 characters. That cut a quarter of gbrain's calls and almost none of
the others, so the experiment dropped the cap. The capped run stays as a disclosed sensitivity condition
([pilot-capped-20k/](2026-10-02-model-ladder/pilot-capped-20k/), −14 points pooled).

### Why gbrain lost

Transcripts of the release runs show five mechanisms. None of them is about ranking quality.

1. **Permissions through derived pages.** gbrain hid the finance memo marked `visibility: private`, but not the
   digest generated from it. Models that saw the labeled memo refused to share it. Models that saw only the unlabeled
   copy repeated the discount. Hiding the source while leaving the derivative visible produced more leaks than
   hiding nothing.
2. **Guessed page types.** Agents filtered search to types the brain does not have (`company`, `account`, `deal`),
   and the filter silently removed the evidence. Type-filtered runs failed 62% of tasks, against 51% unfiltered.
3. **Saved memories invisible to search.** `remember` stores facts outside page chunks, so the next session's
   `search` and `query` never returned them. In the 52k world, write-back passed 24 of 26 runs when the agent saved
   with `put_page`, and 2 of 14 when it saved only with `remember`.
4. **Other names.** Documents that name a customer only by its code are missed by a search for the full name.
   Agents with grep read the code in the contract and searched again; gbrain agents usually stopped after one search.
5. **Wasted turns.** The server instructions told agents to discover skills and read capabilities on every cold
   start, so GPT models spent two calls per task on `whoami` and `list_skills`.

On PGLite, gbrain also never refreshed most planner statistics after an import. The first search in every new session
then ran a pages×pages nested loop, about 50 seconds on a 4,000-page brain and 6 ms after `ANALYZE`. The release runs
applied one operator `ANALYZE` after import, so this cost does not appear in them.

### The fix wave

These changes are in the accompanying gbrain PR. Each has a test that fails without it.

| Change | Mechanism addressed |
|---|---|
| A page whose `derived_from` names a private page is private too | 1 |
| A `types` filter naming types with no pages is narrowed or lifted, and the response lists the types that exist | 2 |
| `search` and `query` append saved facts that share most of the query's words, under recall's visibility rules | 3 |
| Other names declared in the evidence ("account code MULI") are reported, gbrain also searches under them and adds those pages, and saved facts match under either name | 4 |
| Server instructions: research technique (separate searches, other names, newest governing source, `recall` for saved facts); skills only for procedures | 2, 4, 5 |
| Full `ANALYZE` after bulk writes on PGLite | first-search latency |

Development rounds used GPT-5.4-mini, GPT-5.4 and Sonnet 4.6 on all 50 tasks, one repeat each
([dev-rounds/](2026-10-02-model-ladder/dev-rounds/)).

| gbrain build | Success | Note |
|---|---|---|
| release (`ad7900d`) | 67/150 | |
| round 1: lineage, instructions, compact output | 77/150 | compact output was later reverted |
| round 2: + type filters, saved facts in search | 93/150 | |
| round 3: + other-names notice | 95/150 | |
| round 4: + other-name search | 103/150 | tied plain files (103/150) |

The round 4 ladder run showed a regression on true-now tasks: the other-name search dropped the tail of the original
results to make room for its own, and the dropped tail included the meeting where an ownership change was said
([fix-wave-ladder-round4/](2026-10-02-model-ladder/fix-wave-ladder-round4/)). The final build, `51a30c1`, adds pages
without dropping any.

### The fixed build across all 11 models

One repeat per model at `51a30c1`. Each row is compared with repeat 0 of the release ladder for the other arms
([fix-wave-ladder/](2026-10-02-model-ladder/fix-wave-ladder/)).

| Model | fs | gbrain release | gbrain fixed | fixed − best simple arm [95% CI] |
|---|---|---|---|---|
| Haiku 4.5 | 60% | 58% | **82%** | +22 [8, 32] |
| Sonnet 4.6 | 62% | 58% | **90%** | +24 vs pg [10, 34] |
| Sonnet 5 | 82% | 78% | **98%** | +16 [4, 28] |
| Sonnet 5.5 | 92% | 86% | 94% | +2 [−6, 8] |
| Opus 5.5 | 98% | 94% | 96% | −2 [−6, 0] |
| GPT-5.4-mini | 64% | 36% | 54% | −10 [−24, 2] |
| GPT-5.4 | 68% | 52% | 76% | +8 [−6, 22] |
| GPT-5.5 | 90% | 92% | **100%** | +10 [2, 18] |
| GPT-6 Sol | 98% | 94% | 100% | +2 [0, 6] |
| GPT-6.1 Sol | 96% | 98% | 98% | +2 [−4, 6] |
| GPT-6 Astra | 100% | 100% | 100% | 0 |

Pooled: **+7 points [+3, +9]**. Totals: oracle 542, fixed gbrain 494, fs 455, release gbrain 423, pg 410 and
memory 381, all out of 550.

| Family | fs | gbrain release | gbrain fixed |
|---|---|---|---|
| A. Authority | 93% | 85% | 96% |
| B. True now | 82% | 85% | 90% |
| C. Permissions | 94% | 80% | 100% |
| E. Evidence | 57% | 58% | 75% |
| F. Write-back | 88% | 76% | 88% |

Finance-only leaks in answers: fixed gbrain 0 of 110, fs 6, release gbrain 22.

#### Cost and speed

| Arm | $ per task | Tokens per task | Tool calls per task |
|---|---|---|---|
| fs | 0.054 | 32k | 9.0 |
| pg | 0.038 | 20k | 6.2 |
| memory | 0.269 | 246k | 37.1 |
| gbrain release | 0.190 | 179k | 6.0 |
| gbrain fixed | 0.192 | 160k | 5.0 |

**The harness's latency numbers are not usable, and the reason is the harness.** Every model request reserves and
then settles its cost in the budget ledger, and each of those rewrites the whole ledger file synchronously on the
runner's event loop. By the end of the program a ledger held about 110,000 entries (50 MB), and one reserve-and-settle
blocked the event loop for about 0.6 s. With 10 cells running at once, the event loop was blocked much of the time. The
runner also hosts the proxy that carries gbrain's own embedding and reranking requests, so gbrain's tool calls queued
behind those ledger writes. Each run started with a bigger ledger than the one before, so later runs looked slower:
release-build searches took a median 6.2 s in the held-out runs, and fixed-build searches, run later, took 16.6 s.

Replayed alone on one 4,000-page brain of the development world, with neither build given an operator `ANALYZE`,
the same 40 `search`/`query` calls taken from held-out transcripts gave these timings:

| Build | `search` p50 | `search` p90 | `query` p50 | First search in a new session |
|---|---|---|---|---|
| release (`ad7900d`) | 572 ms | 747 ms | 1,797 ms | 57–63 s |
| fixed (`238e12d8`) | 341 ms | 618 ms | 1,551 ms | under 1.5 s |

`remember` took about 300 ms on both builds. The slow-down also explains one held-out symptom. The server waits 5 s for
a write to commit, and in the fixed-build held-out run 89 of about 123 `remember` calls ran past that while their
embedding request sat in the runner's queue. They came back `write_pending` and were committed afterwards; 52 of the
68 affected runs still succeeded. This hurt the fixed build, so its held-out score is, if anything, an undercount.
Tool latency is left out of the comparisons for that reason. The replay scripts are in
[holdout/latency-replay/](2026-10-02-model-ladder/holdout/latency-replay/).

### Held-out check

The development world was used for the fixing, so its numbers could reflect tuning to those 50 tasks. The held-out
world comes from the same generator with seed 20261003 (4,036 documents, 50 tasks, world digest `df9e4f65cf60`).
Nobody opened its tasks before the runs finished. It ran 6 models (Haiku 4.5, Sonnet 4.6, Sonnet 5.5, GPT-5.4-mini,
GPT-5.4 and GPT-6.1 Sol), 2 repeats each and every arm. The release build had the operator `ANALYZE`. The fixed build
is `77dcf414`, the build being shipped, and it ran without the operator `ANALYZE`, so its own statistics refresh is
what was measured ([holdout/](2026-10-02-model-ladder/holdout/)).

| Family | fs | pg | memory | gbrain release | gbrain fixed | oracle |
|---|---|---|---|---|---|---|
| A. Authority | 85.0% | 77.5% | 83.3% | 79.2% | **90.8%** | 100% |
| B. True now | 73.3% | 63.3% | 51.7% | 78.3% | 78.3% | 98.3% |
| C. Permissions | 91.7% | 90.0% | 92.5% | 75.0% | **95.8%** | 100% |
| E. Evidence | 40.8% | 33.3% | 10.0% | 25.0% | **52.5%** | 93.3% |
| F. Write-back | 73.3% | 65.8% | 79.2% | 53.3% | 76.7% | 98.3% |
| All | 72.8% | 66.0% | 63.3% | 62.2% | **78.8%** | 98.0% |

Paired by task (each task averaged over models and repeats, bootstrap over the 50 tasks, exact sign test):

| Comparison | Difference | 95% CI | Tasks better / worse / tied | Sign test p |
|---|---|---|---|---|
| fixed − release | +16.7 pts | [+9.7, +23.8] | 29 / 10 / 11 | 0.003 |
| fixed − fs | +6.0 pts | [−0.2, +12.3] | 22 / 16 / 12 | 0.42 |
| release − fs | −10.7 pts | [−18.2, −3.5] | 11 / 22 / 17 | 0.08 |
| `51a30c1` − release | +17.7 pts | [+11.2, +24.7] | 30 / 8 / 12 | 0.0005 |
| fixed (`77dcf414`) − `51a30c1` | −1.0 pts | [−3.7, +1.8] | 13 / 19 / 18 | 0.38 |

What this shows:
- **The improvement over the release replicates.** Every model improved. All 10 renewal-brief tasks and all 10
  write-back tasks improved (p = 0.002 for each family).
- **The lead over plain files is smaller, and not proven.** By model: Sonnet 4.6 gained 22 points over files
  (CI 8 to 36) and Sonnet 5.5 gained 6 (CI 1 to 12). GPT-5.4-mini trailed by 5 (CI −17 to +7), and GPT-6.1 Sol tied
  at 100%.
- **The shipped build matches the measured one.** `77dcf414` and `51a30c1` score the same, so pretty-printed JSON
  results, the gbrain master merge and fail-closed type lookups changed nothing measurable.
- **Leaks are gone.** Finance-only text appeared in 0 of 120 permission runs for the fixed build. The counts for the
  other arms were fs 9, fs-acl 17, pg 12, memory 9 and release gbrain 29. The fixed build also never put
  finance-only text in the agent's context; the other arms did 57 to 115 times.
- **Cost:** $0.130 per task for the fixed build, against $0.098 for the release, $0.032 for fs and $0.021 for pg.

The held-out world uses the same generator templates as the development world, so it tests tuning to 50 tasks, not
tuning to the generator's wording.

### Cost wave (v0.60.44.0), measured on the fixed harness

The gbrain cost wave ([plan](../plans/2026-10-03-cat40-followups/PLAN.md)) changes four things:
- remote agents get lean search rows
- tool results are compact JSON
- per-tool schema budgets shrink the starter tool list from 59,969 to 24,763 characters
- notices have size ceilings

Every run below used the SQLite ledger, so gbrain's vector search worked, and every run used the gbrain arm only
([followups/](2026-10-02-model-ladder/followups/)). The harness now measures what an isolated replay measures:
search p50 was 579 ms in the harness and 579 ms in the replay.

Development world (GPT-5.4-mini, GPT-5.4, Sonnet 4.6, one repeat), against master `109b99217` built the same way:

| Build | Success (of 150) | Paired difference [95% CI] | $/task |
|---|---|---|---|
| master `109b99217` | 93 | | 0.111 |
| + lean rows, compact JSON (`abc3182e2`) | 97 | +2.7 [−4.7, +10.0] | 0.084 |
| + schema budgets, notice ceilings (`ea851b39b`) | 97 | +2.7 [−2.0, +7.3] | 0.075 |

The plan's harm screen first compared dev round 1 with the `51a30c1` fix-wave ladder and failed (−8.7 points,
family E −30). The cause was the correction above, not the wave. The same family scored 5 of 30 on master and 4 of
30 on `51a30c1` and 4 of 29 on `566a242a` (one cell stopped at its budget) under the fixed ledger.

Held-out world (seed 20261003; Haiku 4.5, Sonnet 4.6, Sonnet 5.5, GPT-5.4-mini, GPT-5.4 and GPT-6.1 Sol; 2 repeats),
against a contemporaneous control on `566a242a` (v0.60.35.0, gate decision UC2). The wave was measured at
`a714410a5`.

| Model | control success | wave success | control $/task | wave $/task |
|---|---|---|---|---|
| Haiku 4.5 | 71% | 71% | 0.074 | 0.058 |
| Sonnet 4.6 | 75% | 79% | 0.225 | 0.144 |
| Sonnet 5.5 | 85% | 86% | 0.206 | 0.122 |
| GPT-5.4-mini | 44% | 47% | 0.020 | 0.017 |
| GPT-5.4 | 66% | 71% | 0.088 | 0.075 |
| GPT-6.1 Sol | 100% | 100% | 0.097 | 0.065 |
| All | 73.5% | 75.7% | 0.118 | 0.080 |

Paired by task: +2.2 points [−0.5, +5.0]; 20 tasks better, 13 worse, 17 tied. The gate's ship rule (lower bound above
−5 points, no new leaks, no model or family at −8 or worse) passes, and the −3-point margin would pass too. Neither
arm leaked. Cost per task fell 32%, short of the plan's 40% target, and cost per successful task fell 34% ($0.161 to
$0.106). Median wall time per task was 61 s before and 64 s after.

Family E (renewal briefs) is the weakest family for every gbrain build once vector search works: 4–5 of 30 on the
development world. Hybrid ranking puts short emails above the long meeting transcripts where the blocker and last
contact live. Keyword-only search did better on this family. That is a gbrain ranking issue for a later wave.

## What to use, and what this does not show

- **Use gbrain with the fix wave.** On unseen tasks it is 17 points better than the release, and at least level with
  plain files at 2.5 to 4 times the price. For permissions, the release lets derived pages leak; the fix wave closes
  that. For saved memories, the release's `search` cannot see what `remember` stored.
- **Do not read this as "gbrain improves as models improve."** The strongest models already succeed 96–100% with
  plain files, so this world cannot measure a slope at the top. A harder world, real harnesses (Claude Code, Codex),
  and the failure family (D) are the next steps.
- **The world is synthetic, and we wrote it.** Its alias declarations ("Account code: X") match one of the patterns
  the other-name feature reads. The held-out world uses the same templates with a new seed, so it tests overfitting
  to these 50 tasks, not to the wording.
- **Some caveats on the numbers:**
  - The fixed-build ladder has one repeat per model, compared with repeat 0 of the release.
  - gbrain's saved facts carry the real clock date while the world's "today" is 2026-09-15.
  - The 52k world was run only on the release.
  - Tool latency measured inside the harness is not valid (see [cost and speed](#cost-and-speed)).

## Reproduce

```
bun eval/generators/model-ladder-gen.ts --check
bun eval/runner/cat40-model-ladder.ts --models <list> --arms oracle,fs,fs-acl,memory,pg,gbrain \
  --max-tool-chars 100000000 --gbrain-repo ../gbrain --gbrain-ref <commit> --budget-usd <n> --out eval/reports/cat40/<name>
bun eval/runner/cat40/analyze.ts eval/reports/cat40/<name>/results.jsonl --subject gbrain
```

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `VOYAGE_API_KEY` (gbrain's reranker). Spend across the whole program
was $1,763 across four machines' ledgers, under a $2,000 authorization. Each folder's README or receipt lists its own spend.
