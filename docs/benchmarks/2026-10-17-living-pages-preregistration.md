# Preregistration: should gbrain build living pages? The read/write break-even (W9) and what follows for W10 (2026-10-17)

Frozen on October 17, 2026, before the owner's request-log counts are known, together with the classifier [`eval/runner/living-pages-breakeven.ts`](../../eval/runner/living-pages-breakeven.ts) and its test. Nothing here changes after the counts arrive; a later change gets a new dated file.

## The question

Living pages (gbrain 10x memory plan, wave 4b, row W9) would keep an entity page's summary block refreshed when its evidence changes. A zero-LLM trigger notices the change, a model writes a new block with a citation behind every sentence, and the owner accepts or rejects it as a proposal (propose mode, off by default). The plan builds W9 **only if the cheaper designs lose**: entity-anchored retrieval at read time (shipped in pinned refresh as `retrieveEvidence`), pinned questions, and a no-refresh control. Anchoring already took stale-wrong answers from 11.6% to 0% at equal tokens, so the open question is cost: a refresh is paid once per change and pays back on every later read, so the answer depends on how often an entity's content is read per change.

This preregistration fixes, before the owner's numbers are seen:

1. the break-even reads per change above which a refreshed page is cheaper per correct answer than anchored retrieval (**r\***);
2. how the owner's request log is turned into an observed ratio (**r_obs**);
3. the build decision for W9 and, under each outcome, for W10.

It measures nothing about any person. The only owner data it uses are aggregate counts: operation names with call counts, and one number of changed page-days.

## The cost model

Per correct fresh answer, at r reads per change:

- refreshed page: (C_change / r + c_read,refreshed) / accuracy_refreshed
- anchored retrieval: c_read,anchored / accuracy_anchored

where C_change = refresh cost + review minutes × price per review minute. A refreshed page is cheaper exactly when

**r > r\* = C_change / (c_read,anchored × accuracy_refreshed / accuracy_anchored − c_read,refreshed)**

and never, when the bracket is zero or negative.

### The inputs (priors, with their sources)

The closest measured analogue is pinned questions: a cited answer refreshed when its evidence changes, with no review step. [C4 run 3](2026-10-05-memory-proof-wave-gbrain-verdicts/c4-pinned-questions/verdict.json) (gbrain `1384a0db`, reader `claude-sonnet-5-5`, 72 reads and 72 refreshes per seed at 1 read per write, means of seeds 42, 7 and 1234) gives:

| Input | Value | From |
|---|---|---|
| c_read,anchored (equal-token anchored reader) | $0.001469 per read | `anchored_reader` read_usd / reads |
| accuracy_anchored | 0.968 | `anchored_reader` |
| c_read,refreshed | $0.000778 per read | `pinned` (Sonnet 5.5 refresh) read_usd / reads |
| accuracy_refreshed | 0.995 | `pinned` (Sonnet 5.5 refresh) |
| cheapest measured refresh | $0.006023 per refresh | `pinned` (Sonnet 5.5) lifecycle_usd / 72 |
| living-page refresh | $0.017 per refresh | the plan's W9 estimate on Sonnet 5.5 (a whole cited summary block, not one answer) |
| review minutes per proposal | 0.5 | prior; not measured (see "What this does not settle") |
| price of a review minute | $2.00 ($120 an hour) | prior |

The comparator is the equal-token anchored reader, the plan's named cheaper design and the cheapest correct design C4 measured without stale-wrong answers ($0.00152 per correct answer; the full-evidence reader costs $0.00284). Pinned questions refresh at the same rate as living pages with no review, so a living page that needs review is never cheaper than a pin for a question that has one; its only advantage is answering questions nobody pinned. That advantage is what the paid gate below measures, if the build gate is passed.

### The thresholds

| Threshold | C_change | r\* (reads per change) |
|---|---|---|
| **r\*_floor**: cheapest measured refresh, free review | $0.006023 | **8.2** |
| living-page refresh, free review | $0.017 | 23.2 |
| **r\*_prior**: living-page refresh, 0.5 review minutes at $2.00 | $1.017 | **1,387** |

Review time dominates. With the $0.017 refresh, r\* by review minutes per proposal (rows) and price per minute (columns):

| minutes \\ $/min | 0.50 | 1.00 | 2.00 | 5.00 |
|---|---|---|---|---|
| 0.25 | 194 | 364 | 705 | 1,728 |
| 0.5 | 364 | 705 | **1,387** | 3,433 |
| 1 | 705 | 1,387 | 2,751 | 6,843 |
| 2 | 1,387 | 2,751 | 5,479 | 13,663 |

## The observed ratio

The owner (the brain host's operator) runs two read-only aggregate queries over the same 30-day window and returns only their results: operation names and counts, and one number. No params, token names, slugs or content leave the machine.

**Query A, reads by operation:**

```sql
SELECT operation, count(*) AS calls, count(*) FILTER (WHERE status = 'success') AS ok,
       min(created_at) AS first_at, max(created_at) AS last_at
FROM mcp_request_log WHERE created_at > now() - interval '30 days'
GROUP BY operation ORDER BY calls DESC;
```

**Query B, changes as page-days:**

```sql
SELECT (SELECT count(*) FROM (SELECT DISTINCT page_id, date_trunc('day', snapshot_at)
          FROM page_versions WHERE snapshot_at > now() - interval '30 days') e)
     + (SELECT count(*) FROM pages WHERE created_at > now() - interval '30 days') AS page_days;
```

A refresh is triggered by a change, and a nightly trigger refreshes a page at most once a day however many writes it took, so the denominator is changed page-days, not write calls. `page_versions` holds one preimage per replacing write from every path, sync included, and a creation has no preimage, so creations are added. `mcp_request_log` misses writes that arrive by sync, which is why write calls from query A are not used.

**reads** = the sum of `ok` over the frozen read set: `assemble_evidence`, `context_pack`, `entity`, `get_chunks`, `get_page`, `query`, `recall`, `search`, `synthesize`, `think`, `volunteer_context`. Every other operation is listed in the result as unknown and not counted. These calls read any page, not only entity summaries, so **r_obs = reads / page_days** is an upper bound on reads of a refreshed summary per refresh. That bias favours building W9.

## Decision rule

`bun eval/runner/living-pages-breakeven.ts --ops <query A as CSV or psql output> --page-days <query B>` applies it:

| Result | W9 | W10 |
|---|---|---|
| r_obs ≥ r\*_prior (1,387) | **Built**, propose mode, `dream.page_refresh.mode` off by default; its default is decided by the paid `living-pages` category below | Built after W9 with its $0 gate as the plan states it |
| r_obs < r\*_prior | **Not built**: the cheaper designs win at this brain's ratio. Recorded as out of V1 with r_obs and r\* | **Dropped with W9**: without refreshed blocks it has nothing to render or undo |
| query B missing | Indicative only; no decision | Pending |

The result also reports whether r_obs is below r\*_floor (8.2). Below the floor, W9 loses even if review were free and a refresh cost as little as a pinned answer; that would close the question for future waves as well.

Per-page targeting (refreshing only pages read often enough to pass r\* on their own) can win where the brain-wide ratio loses. It needs per-slug counts, which this preregistration does not collect; it is a candidate for a later wave, not part of this decision.

## If W9 is built: the paid `living-pages` category

Written here so it cannot be shaped by the build. Synthetic brains with placeholder entities only; capped at $40 (the plan's $15 to $40), on the wave 4 eval ledger; newest model of each family, no Fable, no older generations.

- **Arms**: living pages (propose mode, every proposal accepted for the measurement); entity-anchored retrieval with the same triggers and evidence; pinned questions; a no-refresh control.
- **Primary**: dollars per correct fresh task at the observed r_obs, with review minutes priced at the measured minutes per proposal × $2.00. Living pages pass only if they are cheaper per correct fresh task than every cheaper arm in at least 2 of 3 seeds and no seed shows a leak.
- **Measured inputs that replace the priors**: refresh dollars per proposal; read dollars per answer on each arm; review minutes on 50 blinded proposals, timed by a person the owner names (the owner's consent is required before anyone is asked).
- **Bars**: unsupported-sentence rate ≤ 2% (checked by `synthesize-verify.ts`); unchanged sentences preserved; rejection rate and invalidation lag reported.
- **Lifecycle tests ($0)**: proposal → human edit → accept is rejected as stale; accept → human edit → undo reverts only the block; a revoked approval; an evidence purge before acceptance withdraws the proposal.
- **Secondary**: Cat 40 family E (renewal briefs, 4 to 5 of 30 today), reported.

If living pages fail the primary, W9 stays off by default and the result is recorded beside this file. Keeping or removing the code is a separate decision.

## W10 under each outcome

W10 renders per-sentence provenance and undoes one refreshed block by an inverse patch (not `revert_version`, which restores a whole page). It has a consumer only if W9 is built. Built: its $0 gate is as written in the plan (provenance survives sync and reimport, no duplicate links, held-file count unchanged, undo after an unrelated human edit keeps that edit). Not built: W10 is dropped and recorded beside W9.

## What this does not settle

- **The review minutes and their price are priors, not measurements.** At 0.5 minutes and $2.00 a minute they set r\*_prior; the table shows how far the threshold moves. If the owner's r_obs lands between 194 and 13,663, the decision depends on these priors, and the report says so beside the outcome. The paid gate measures the minutes before any default is chosen.
- **The refresh and read costs come from pinned questions, a close analogue measured on 6 entities at the accuracy ceiling.** A living-page block is longer than one answer; the plan's $0.017 estimate prices that, and r\*_floor shows the result with the analogue's own refresh cost.
- **The ratio is brain-wide.** It is one owner's 30 days. Another owner's ratio needs its own counts.

## Changes

- 2026-10-17, after freezing, before any count: **decided on prior, with no owner data.** The owner declined to supply production-brain counts, so queries A and B were not run and r_obs is unknown. The rule above is unchanged. On the prior, W9 is **not built in V1** and W10 is **dropped with it**: the build threshold is 1,387 reads per changed page-day, and nothing known about a personal brain's read rate comes close. Reopen if aggregate telemetry from a hosted brain shows r_obs at or above the threshold, measured with queries A and B or their hosted equivalents. Verdict: [`2026-10-17-living-pages/verdict.json`](2026-10-17-living-pages/verdict.json).
