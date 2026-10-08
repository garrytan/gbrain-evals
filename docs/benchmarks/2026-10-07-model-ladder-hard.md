# Cat 40 Hard: gbrain against plain files on a 55,000-document company (2026-10-07)

## The finding

On 100 unseen Hard tasks over a 55,235-document synthetic company, frontier agents using gbrain finished fewer tasks than the same agents using plain files with grep. Pooled over Sonnet 5.5, Opus 5.5 and GPT-6.1 Sol, gbrain finished 62.0% of tasks and plain files 73.3%. The paired difference is −11.3 points, with a task-clustered 95% interval of −16.7 to −6.0. That triggers the preregistered decision sentence 3, "gbrain behind": the next gbrain wave targets retrieval on the weakest family. That family is H1, aggregation over many accounts (−18.3 points, interval −30.0 to −8.3).

gbrain lost on Sonnet 5.5 (−16 points) and Opus 5.5 (−17 points) and tied on GPT-6.1 Sol (−1 point, interval −9 to +7). It also trailed the Postgres search setup by 6.3 points (simultaneous interval −12.5 to −0.2).

The losses come from wrong answers, not from running out of turns. Agents using gbrain submitted a wrong answer 50 times; with plain files they did so 13 times and with Postgres 31 times. Turn-cap stops were nearly equal across setups (64 to 66).

gbrain v0.60.95.0 (`c5fb0201d`), measured 2026-10-06 to 2026-10-07. This is a recommendation to fix gbrain retrieval before using it for this kind of work, not an inconclusive result.

**Caveat found after the run (2026-10-07): the gbrain arm ran without reranking.** The harness rebuilt nothing between the slot build and the cells, and each slot snapshot kept the Voyage base URL of the build process's proxy, whose port was gone when the cells ran. Every rerank call therefore failed fast and gbrain fell back to unreranked results. Search reported this as `rerank_failed` in 230 of 300 cells, but the reason was not recorded. (Per-cell provider metering cannot confirm it either way: a separate harness race, fixed in `f345d58`, charged most gbrain cells' provider calls to the slot instead of the cell; costs are unaffected beyond about $0.01 per cell.) The harness now points every slot start at the current proxy (`gbrain-arm.ts`, with a test that fails before the fix). The numbers above stand as measured: they describe gbrain without its reranker, a configuration a user would reach only with a broken provider endpoint. How much reranking changes the gap is measured in the fix wave's development rounds ([plan](https://github.com/garrytan/gbrain-evals/blob/plan/cat40-hard-fix/docs/plans/2026-10-07-cat40-hard-fix/PLAN.md) on its branch, gbrain-evals #93), not on these held-out tasks.

## The concrete case

The company has accounts, contracts, amendments, tickets, emails, meetings and agent notes. Since generator v2 (amendment A1), most records refer to an account indirectly, by one of three forms:

- an internal code, such as `ZEU8`;
- a nickname, such as "Kumquat Vulture";
- an account manager phrase, such as "Ilse Ishikawa's North America finance account".

Account sheets, CRM records, handoff notes and rename notices connect those forms back to the account's name. Questions still ask by name, and since amendment A2 each H2 to H5 question asks about three or four accounts at once.

A typical H4 question names four accounts and asks for each one's authoritative contract value as of a date. An agent with plain files greps each name, reads the account sheet to learn its code, nickname and manager, greps those, and reads the matching contracts. In a typical miss with gbrain (Sonnet 5.5, H4-01), the agent got three of four accounts right. It never retrieved the account sheet or CRM record for the fourth, so it attributed that account's value from a document about a different account.

H5 tasks are memory tasks: across sessions the agent is told facts and later asked about them. In one Opus 5.5 miss, gbrain recorded all four facts with `remember` but answered only one of four correctly at the end. In other words, recall returned superseded or neighboring facts.

## The experiment and results

- **World.** Seed 20261006, the frozen generator `model-ladder-hard-v2` with `knobs.frozen.json` (round 5), 55,235 documents, 100 tasks: 20 per family.
  - H1: aggregation over 5 to 10 accounts.
  - H2: value history.
  - H3: look-alike accounts.
  - H4: conflicting sources.
  - H5: multi-session memory.

  H2 to H5 ask about 3 or 4 accounts each.
- **Arms.**
  - fs: files with grep and read.
  - pg: Postgres keyword and vector search.
  - gbrain: gbrain's starter MCP surface on a PGLite brain built from the same corpus, with operator ANALYZE.
  - oracle: the evidence handed to the model, as a reference.
- **Run settings.** 16 turns per session, uncapped tool results, Hard tool limits, claims judge `gpt-6.1-sol`, one repeat.
- **Models.** Sonnet 5.5, Opus 5.5 and GPT-6.1 Sol. Fable 5.1 ran in 162 cells before the 2026-10-07 rule that keeps Fable to smoke tests (amendment A6). GPT-6 Astra ran only in calibration (amendment A3). The memory arm did not run: the budget ran out after the pg batch.

| Model | gbrain | fs | pg | oracle |
|---|---|---|---|---|
| Sonnet 5.5 | 44% | 60% | 52% | 98% |
| Opus 5.5 | 62% | 79% | 69% | 97% |
| GPT-6.1 Sol | 80% | 81% | 84% | 99% |
| pooled | 62.0% | 73.3% | 68.3% | 98.0% |

Every oracle is at 97% or above, so the tasks are well posed. GPT-6.1 Sol is above the preregistered 80% held-out bar on fs (81%) and pg (84%), so its comparison has little room to show a difference.

| Family | gbrain | fs | difference | 95% CI |
|---|---|---|---|---|
| H1 aggregation | 8.3% | 26.7% | −18.3 | [−30.0, −8.3] |
| H2 value history | 73.3% | 88.3% | −15.0 | [−26.7, −3.3] |
| H3 look-alikes | 65.0% | 66.7% | −1.7 | [−13.3, +11.7] |
| H4 conflicting sources | 78.3% | 93.3% | −15.0 | [−25.0, −3.3] |
| H5 memory | 85.0% | 91.7% | −6.7 | [−18.3, +3.3] |

| Arm | failures: turn cap | failures: wrong answer | mean turns |
|---|---|---|---|
| fs | 66 | 13 (+1 context overflow) | 10.9 |
| pg | 64 | 31 | 9.5 |
| gbrain | 64 | 50 | 10.1 |

gbrain's per-task tool mix was mostly `search` (5,985 calls), then `get_page`, `remember`, `entity` and `recall`.

**Fable 5.1, descriptive only (A6).** On the cells that finished, gbrain completed 65% (52 of 80) and fs 20% (16 of 82). With plain files Fable runs out of turns: almost every fs failure is a turn-cap stop. It is the one model on which gbrain clearly helped. These cells are not in any interval.

**What the 50k world models.** It models more accounts, more material per account, and indirect references. It does not model answers that change as the company grows. No 4k held-out run exists (amendment A2).

## What to use and what to avoid

For multi-account questions over a large, indirectly referenced corpus, a frontier agent with plain files and grep did better than the same agent with gbrain v0.60.95.0. The gap is in precision. gbrain's search returns plausible records quickly, and agents trust them, but for some accounts in a question it surfaces neither the record that resolves a code, nickname or manager phrase, nor the current value.

The concrete targets for the next gbrain wave, in order:

1. **Alias resolution in search** (H1, H2, H4). When a query names an account, return its account sheet and CRM record, and the documents that refer to it by code, nickname or manager, ranked together.
2. **Current-value preference** (H2, H4). Rank the latest effective value, and corrections, above superseded values for the same account and attribute.
3. **Memory recall across sessions** (H5). Facts recorded with `remember` should be returned for the account asked about, not for a neighboring one.

gbrain was cheaper per task than fs but about 2.5 times slower per task.

## Cost and latency

| Arm | $ per task | p50 seconds per cell | p95 |
|---|---|---|---|
| fs | 0.98 | 68.5 | 141.9 |
| pg | 0.29 | n/a | n/a |
| gbrain | 0.69 | 170.1 | 288.5 |

These cover the three models, agent plus gbrain-internal dollars; judge cost is excluded.

**Setup.** The five gbrain slot builds cost $2.71 each in embeddings and took 83 to 90 minutes each on a 4-core machine. The pg setup embedding cost $2.57.

**Hard ledger.** $2,000.29 committed of the $2,044 cap. Program authorization $4,600 (amendment A5).

## Reproduce and inspect

```bash
D=docs/benchmarks/2026-10-07-model-ladder-hard
grep -hv '"model":"claude-fable-5-1"' $D/cells-50k/results.jsonl > /tmp/primary.jsonl
python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py /tmp/primary.jsonl $D/pg-50k/results.jsonl \
  --hard-headline gbrain-hard,fs --simple fs,pg
```

The output is committed as [holdout-stats.md](2026-10-07-model-ladder-hard/holdout-stats.md); the same analysis with Fable's finished cells included, for the descriptive row, is [holdout-stats-with-fable-descriptive.md](2026-10-07-model-ladder-hard/holdout-stats-with-fable-descriptive.md).

- **Held-out world.** Seed 20261006, file SHA-256 `67cc90b4…bc8c14`, digest `9ea46415…892877`.
- **Frozen settings.** Knob digest `37a16085…27434`.
- **Preregistration.** [PREREGISTRATION.md](cat40-hard/PREREGISTRATION.md), amendments A1 to A6.
- **Calibration record.** [calibration.md](cat40-hard/calibration.md).
- **Sealed validation variant.** Digests recorded in `docs/benchmarks/cat40-hard/SEALED.md` on the sealed branch ([#77](https://github.com/garrytan/gbrain-evals/pull/77)); not run.
- **Keys.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`.
- **Outputs.** [`2026-10-07-model-ladder-hard/`](2026-10-07-model-ladder-hard/): `cells-50k/`, `oracle-50k/` and `pg-50k/`, each with `results.jsonl`, `experiment.json`, receipts, `run.log` and gzipped transcripts; the held-out world as `world-50k.json.gz`.

## Changelog

- 2026-10-07: first version.
- 2026-10-07: caveat added: the gbrain arm ran without reranking (stale Voyage endpoint in restored slots); harness fixed.
