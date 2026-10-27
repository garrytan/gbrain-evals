# Model Ladder scale tier: 52,000 documents

Run 2026-10-02 (UTC). Corpus: `model-ladder-v1` at `--scale large`. gbrain under test: master `ad7900d` (v0.60.27.0), `--surface starter`.

## The finding

The plan predicted that plain-file search would stop beating gbrain once the company corpus grew from about 4,000 to about 50,000 documents. On this task set it did not. Searching Markdown files with `grep` was the best baseline for every model tested. gbrain's success rate was 16 points lower, pooled across the four models (95% interval −24 to −10 points).

The gap shrinks as models get stronger. GPT-6.1 Sol scored 92% with gbrain and 96% with files, a difference of −4 points (−12 to +2). The slope of gbrain's advantage on model capability is positive (4.45, interval 0.16 to 11.5). That slope rests on four models whose capability scores sit between 96% and 100%, so treat it as a direction rather than an estimate.

Read this as a measured loss at this scale, not as proof that grep wins everywhere. Each task names its account by a unique name or code, and tool output was uncapped. Those two conditions let an exact `grep` pull the right handful of lines out of 52,000 files. The losses below point at specific gbrain behaviors that can be fixed. Several are about permissions and write-back rather than retrieval.

<a id="correction-2026-10-09"></a>

> **Correction, 2026-10-09: the gbrain arm searched without its reranker.** Each restored slot brain kept the slot build's metering-proxy port in its Voyage URL, and that port was closed when the cells ran, so every rerank request failed and gbrain quietly returned unreranked results (fixed in gbrain-evals #76, commit `7709a70`, and #109). None of the 200 gbrain cells' metered calls include a rerank request ([audit](../../2026-10-08-program-primary-hard/root-cause/restore-audit.json)). The −16-point gap to plain files therefore measures gbrain at release with a failed reranker, on top of the ledger stall the [Cat 40 report correction](../../2026-10-02-model-ladder.md#correction-2026-10-09) also describes; the file, Postgres, memory and oracle arms have no reranker to lose. The original numbers stay as measured. The current measurement at this scale is Cat 40 Hard (gbrain-evals [#76](https://github.com/garrytan/gbrain-evals/pull/76)), whose own held-out gbrain arm also ran without reranking and says so.

## What the agent had to do

The corpus is the fictional Acme Example Inc. from the [protocol](../../2026-10-02-model-ladder-protocol.md). The 50 tasks and their 100 planted accounts are the same as in v1, document for document. The large world adds 1,250 distractor accounts, each with a contract, a CRM record and 28 to 40 routine emails, meetings and tickets, plus 3,000 more team updates. That makes 52,028 documents and 41.5 MB of Markdown. The extra accounts never reuse a value that the v1 world uses. That rule covers gold answers, wrong values, canaries, account base names and account codes, and it is checked by `test/eval/cat40-model-ladder-large.test.ts`.

A typical task: "Prepare a renewal brief for Quormiro Capital: the current account owner, the current contract renewal date, the id of the support ticket that is open now, the date of our most recent email or meeting with them, and the main blocker to renewal." The answers sit in a handoff email, an executed amendment, a reopened ticket and a sentence in the middle of a long meeting transcript, among about 25,000 emails and 12,000 meetings.

## The experiment

- **Models:** `claude-sonnet-4-6`, `claude-sonnet-5-5`, `gpt-5.4`, `gpt-6.1-sol`, provider defaults, one repeat.
- **Arms**, as in the protocol: `oracle` (evidence in the prompt), `fs` (`list_dir`/`grep`/`read_file`/`write_file`), `fs-acl` (fs without finance-only files, family C only), `memory` (Anthropic memory tool semantics), `pg` (Postgres full-text plus pgvector search, `text-embedding-3-large` at 1,536 dimensions), `gbrain` (gbrain's MCP server over stdio).
- **Tool results were uncapped** (`--max-tool-chars 100000000`) for every arm. `fs` grep still returns at most 200 matching lines.
- **Metric:** task success as defined in the protocol: the value is correct, no wrong value is named, nothing leaks and nothing unsafe is written. Judge for unsupported claims: `gpt-5.4-mini`, prompt `cat40-claims-v1`.
- **Coverage:** 960 cells. Every arm ran all 50 tasks for all four models, except `memory`, which ran 30 tasks (6 per family) to stay inside the budget. An uncapped `view /memories` lists about 415,000 characters of paths, so memory cost $1.30 per cell against $0.06 for `fs`. Because its coverage is incomplete, `memory` drops out of the "best baseline" in `analysis.md`. The 30-task table below compares all arms on equal tasks.

### Results

Success rate per model and arm (all 50 tasks; fs-acl is family C only):

| Model | oracle | fs | fs-acl (C) | pg | gbrain | gbrain − best baseline [95% CI] |
|---|---|---|---|---|---|---|
| claude-sonnet-4-6 | 98% | 64% | 70% | 62% | 42% | −22 pts vs fs [−36, −14] |
| claude-sonnet-5-5 | 96% | 94% | 100% | 82% | 68% | −26 pts vs fs [−40, −12] |
| gpt-5.4 | 100% | 66% | 100% | 52% | 52% | −14 pts vs fs [−28, −2] |
| gpt-6.1-sol | 100% | 96% | 100% | 94% | 92% | −4 pts vs fs [−12, +2] |

On the 30 tasks every arm ran:

| Model | oracle | fs | memory | pg | gbrain |
|---|---|---|---|---|---|
| claude-sonnet-4-6 | 97% | 63% | 50% | 63% | 33% |
| claude-sonnet-5-5 | 97% | 90% | 70% | 83% | 63% |
| gpt-5.4 | 100% | 67% | 53% | 50% | 57% |
| gpt-6.1-sol | 100% | 97% | 70% | 93% | 87% |

gbrain minus the best complete baseline (fs for every model), by family, pooled over models:

| Family | What it tests | Advantage | 95% CI |
|---|---|---|---|
| A | Which document governs a contract term | −12 pts | [−23, −2] |
| B | Who owns the account now or on a past date | −7 pts | [−25, +8] |
| C | Finance-only information | −20 pts | [−37, −5] |
| E | Five-part renewal brief | −28 pts | [−35, −20] |
| F | A correction written in one session, needed in the next | −15 pts | [−35, +5] |
| all | | −16 pts | [−23, −9] |

Per-model family rates, safety counts, cost and latency are in [`analysis.md`](analysis.md), produced by `analyze.ts`. Loop time, run endings, the 30-task table and the family bootstrap are in [`extra-tables.md`](extra-tables.md).

### Why gbrain lost, case by case

- **Renewal briefs (E).** gbrain agents missed the open ticket in 18 of 40 briefs, against 2 of 40 with files. They missed the blocker said in a long transcript in 20 of 40, against 13 with files. With files, the agent greps for the account code and `Status: Open` and reads every hit. gbrain's ranked search returns the top results, and the reopened ticket or the transcript was often not among them.
- **Finance-only discounts (C).** gbrain hides the finance memo (`visibility: private`) from remote callers, as designed. But 5 of the 10 accounts also have an auto-generated pipeline digest that repeats the discount without a label. With files, agents saw the memo marked FINANCE ONLY next to the digest and refused. With gbrain they saw only the digest and reported the discount. Output leaks: gbrain 11 of 40 C cells, fs 3, fs-acl 3, pg 3, memory 4 of 24. All 11 gbrain leaks came from the digests. gbrain passed 3 of 12 restricted questions with a digest, against 9 of 12 for every other arm. This is the "permissions that survive derivation" gap the plan lists as W3. Hiding the source without carrying its restriction to derived pages made leaks more likely, not less.
- **Write-back (F).** In session 1, agents that saved the correction with `put_page` passed session 2 in 24 of 26 cells. Agents that saved it only with `remember` passed 2 of 14. The `remember` writes landed, but the fresh session's `search` and `query` did not surface them, so the agent answered with the old billing contact from the CRM record.
- **Authority and ownership (A, B).** These losses are smaller, and for B the interval includes zero. In A, 11 of gbrain's 12 failures and all 7 of the file arm's answered with the original contract value even though an executed amendment had changed it.

### Safety, cost and latency

- Unsafe writes (writing over a contract): 0 in every arm.
- Context exposures (a finance-only string in any tool result): gbrain 17 of 40, fs-acl 19, pg 33, fs 38. gbrain shows the agent less restricted text than the file arms but leaked more of what it showed.
- Spend per cell, including judge and gbrain's internal calls: oracle $0.010, fs-acl $0.021, pg $0.031, fs $0.060, gbrain $0.157, memory $1.30. gbrain's E briefs were the most expensive cells, at $0.17 to $0.60.
- Agent-loop time p50 (model plus tools): gbrain 22 to 26 s, fs 10 to 23 s, pg 11 to 20 s. The `wall_ms` p50 for gbrain in `analysis.md` (136 to 152 s) includes waiting for one of three brain slots, so do not read it as gbrain latency.
- `memory`: 9 cells hit the 16-turn cap and 4 exceeded the model's context window. Both were caused by the uncapped directory listing.

## What to use and what to avoid

- **For lookups keyed by an exact name or code, a file tree and grep stay competitive at 52,000 documents**, provided tool output is not truncated. Strong models used it well.
- **gbrain on this release should not be the only line of defense for finance-only information when derived pages exist.** A digest built from a private memo needs to inherit the memo's restriction.
- **Have agents record corrections with `put_page`**, or make `remember` writes findable by `search` and `query`, before relying on gbrain for write-back.
- **Multi-part briefs need recall, not just top-ranked results.** This is the plan's W5 (evidence sufficiency) item.

## Running gbrain at this size

Building the brain needed workarounds, all in this repository (gbrain itself is unchanged). Each is recorded in the slot-build receipt:

1. `gbrain sources add` refused the 52,000-file checkout: "The verified source manifest exceeds the 1 MiB administration metadata bound" (`src/core/persistence/source-lifecycle.ts:111`). The bound is about 8,000 files. The harness registers the source with the two policy files, then adds the rest.
2. A single `gbrain sync` slowed from more than 7 to 2.3 documents per second by 13,000 pages, because the PGLite planner statistics were stale. A sync is also hard-killed after an hour. The harness syncs in 5,000-document batches with an operator `ANALYZE` after each.
3. `gbrain embed --stale` stops after 30 minutes of wall clock unless `--catch-up` is passed. A dry run then reported 51,910 chunks still unembedded, with no error. The harness passes `--catch-up` and fails the build unless `embed --stale --dry-run` reports 0 stale chunks.
4. `gbrain serve` on the large brain still answers tool calls but takes about 80 seconds to finish booting. Its default 60-second boot deadline made it exit mid-session; the write probe caught this. The harness sets `GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS=0`.
5. On Capy cloud machines `git` is a logging shell wrapper that starts about ten extra processes per call, and sync calls git twice per file. Slot processes get the real binary.
6. The budget ledger rewrote its whole JSON file for every request, which held embedding to about 100 requests a minute per slot. Slot builds now use a ledger allowance: one checked reservation, charged in memory, settled once.

Measured build cost per slot: 86 minutes, with three slots building in parallel on 4 vCPUs. That is 10 sync batches of 5,000 documents at 5.5 to 6 minutes each plus a final 2-minute batch, 10 minutes of `extract` and 14 minutes of `embed`. Embeddings cost $1.18 per slot, 52,043 requests. Each slot snapshot is 1.8 GB, and restoring it between cells takes 75 to 100 seconds. The `pg` arm built in about 3.5 minutes, with $1.26 of embeddings.

`gpt-5.4` sometimes cited gbrain's opaque `gbrain-page:v1:…` ids instead of slugs. Those count as missed evidence in the safety table, but citations do not affect success.

## Reproduce and inspect

From the repository root, with `../gbrain` cloned and Bun 1.4 or later:

```bash
bun eval/generators/model-ladder-gen.ts --scale large    # writes the gitignored world; checks against manifest.json via --check
W=eval/data/model-ladder-v1-large/world.json
M=claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4,gpt-6.1-sol
RUN=$(bun eval/runner/budget-ledger.ts open --runner cat40-model-ladder-scale-tier --budget-usd 248 --program-cap-usd 2000)
bun eval/runner/cat40-model-ladder.ts --world $W --models $M --arms oracle,fs,fs-acl,pg --concurrency 8 --max-tool-chars 100000000 --budget-run-id $RUN --program-cap-usd 2000 --out eval/reports/cat40/scale-tier-baselines
bun eval/runner/cat40-model-ladder.ts --world $W --models $M --arms memory --tasks A01,A02,A03,A04,A05,A06,B01,B02,B03,B04,B05,B06,C01,C02,C03,C06,C07,C08,E01,E02,E03,E04,E05,E06,F01,F02,F03,F04,F05,F06 --concurrency 6 --max-tool-chars 100000000 --budget-run-id $RUN --program-cap-usd 2000 --out eval/reports/cat40/scale-tier-baselines
bun eval/runner/cat40-model-ladder.ts --world $W --models $M --arms gbrain --slots 3 --max-tool-chars 100000000 --gbrain-repo ../gbrain --gbrain-ref ad7900d --budget-run-id $RUN --program-cap-usd 2000 --out eval/reports/cat40/scale-tier-gbrain
cat eval/reports/cat40/scale-tier-{baselines,gbrain}/results.jsonl > results.jsonl
bun eval/runner/cat40/analyze.ts results.jsonl --md analysis.md --json analysis.json
bun docs/benchmarks/2026-10-02-model-ladder/scale-tier/extra-tables.ts results.jsonl
```

The memory arm actually ran in three chunks: a 5-task pilot, then 5 more tasks, then 20 more. Requires `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.

Identities:

- World: digest `e481a619fa64b3a9e9712f2c499c3ebdac6bf87dd1ab8de0b95218eb00c3831f`, seed 20261002, 52,028 docs ([`manifest.json`](../../../../eval/data/model-ladder-v1-large/manifest.json)). The v1 world is unchanged.
- gbrain under test: `ad7900d8dcd2` (0.60.27.0), copied by `git archive` and verified by tree hash in the receipt. The declared dependency in `package.json` resolves to gbrain 0.60.13.0 in `node_modules`. That copy supplies only pricing tables and the PGLite used by the `pg` arm; it is not the gbrain under test.
- gbrain-evals code: commit `c886cdb`. The gbrain cells ran on exactly this code. The baseline cells ran earlier from the same tree before it was committed, without the ledger-allowance and slot-build changes, which do not touch those arms. Their receipts show base `ed2c423` and `evals_dirty: true`.
- Time: baseline pilot 7 minutes, the remaining oracle/fs/fs-acl/pg cells 22 minutes, memory chunks 3 and 8 minutes, gbrain slot builds 86 minutes, and 200 gbrain cells 2 hours 15 minutes, including the first restore and write probe.
- Spend in the budget ledger: $219.25. That is $217.98 for the shared run and $1.26 for the first smoke. The cell records account for $207.92, slot builds for $3.53, and the abandoned first build for $0.28. The rest is requests the guard charges at their reservation: retries, and memory requests the provider refused for context length.

Files here: [`results.jsonl`](results.jsonl) (one line per cell, sha256 `57820388…`), [`analysis.md`](analysis.md), [`analysis.json`](analysis.json), [`extra-tables.md`](extra-tables.md), and [`receipts/`](receipts). The receipts are the slot builds, including the run that stopped at the boot-deadline write probe, the cell runs, the smoke that hit the `sources add` bound, and the run logs. Machine paths are scrubbed.

## Limits

One repeat per cell, and four models clustered near the top of the capability index. The world is synthetic and written by us, and its account names and codes are unique by construction, which helps exact search. The memory arm covers 30 of 50 tasks. Family D (surviving failure) is not in v1.

## Changelog

- 2026-10-09: [Correction](#correction-2026-10-09) added: the gbrain arm ran without reranking in all 200 cells (stale metering-proxy port in restored slots; fixed in gbrain-evals #76 and #109). Original numbers unchanged.
