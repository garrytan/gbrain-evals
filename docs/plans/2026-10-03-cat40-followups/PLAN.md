<!-- /autoplan restore point: "/home/user/.gstack/projects/garrytan-gbrain-evals/plan-cat40-followups-autoplan-restore-20261003-150322.md" -->
## Implementation plan
# Cat 40 follow-ups: a ledger that doesn't stall the harness, and a cheaper gbrain per task

Status: draft for autoplan, 2026-10-03.
Context: the Cat 40 Model Ladder report (`docs/benchmarks/2026-10-02-model-ladder.md`) and the gbrain fix wave
(garrytan/gbrain#5932, v0.60.35.0, merged).

## Gate decisions (Garry, 2026-10-03: "Approve")

These override any conflicting text below.

- **UC1 (approved change).** The ship rule is one bundle-level rule on the held-out paired comparison with a
  −5-point margin, preceded by a power check (expected CI half-width from the existing held-out runs). The −3-point
  result is reported next to it. Dev rounds are a harm screen only: drop a change whose dev-round paired difference
  is −5 points or worse, and use the family breakdown to pick which one.
- **UC2 (approved change).** Instead of the 11-model ladder, spend about $80 on a contemporaneous held-out control:
  rerun gbrain at `566a242a` (master, v0.60.35.0) on the held-out world under the new ledger, with the same models,
  repeats and argv as the new build's held-out run. G2 compares against that control. The 11-model ladder runs only
  with money left over. CEO-T2 is dropped, because the control subsumes it.
- **UC3 (approved change).** Ledger storage is `bun:sqlite` in WAL mode instead of a custom JSONL journal. Every
  accepted requirement still holds:
  - the cap is stored in the ledger, and a missing cap flag stays null
  - the CLI provides `init`, `status`, `verify`, `set-cap` and `migrate --finish`
  - conservative reservations
  - durability failures stop spending
  - migration with a tombstone and a `.migrated` copy
  - refusal messages
  - receipts and the lag monitor

  Requirements that were specific to the journal (byte offsets, torn tails, `O_APPEND`) are replaced by SQLite
  transactions (`BEGIN IMMEDIATE`) and `synchronous=FULL`.
- **UC4 (direction kept).** Lean rows are the default for remote callers, with `fields: "full"` per call and
  `mcp.result_rows: full` per host as escape hatches.
- **T1 approved:** if per-tool budgets cannot reach 25k, move the skill-admin and write-request ops behind
  `request_tools`. **T3:** keep C4 with whole-item truncation. **T4:** defer the verbs-surface arm.
- **Budget:** dev round 1 about $18, dev round 2 about $18, new-build held-out about $85, control about $80; total
  about $201 of the $237 left. No other paid work runs concurrently against this cap.

## Why

Two problems were left open when Cat 40 shipped.

1. **The harness distorts its own timing.** Every paid model request reserves its cost in the budget ledger and then
   settles it. Each step takes a file lock, parses the whole `.budget/ledger.json`, rewrites it and fsyncs it,
   synchronously on the runner's event loop. At 110k entries (50 MB), one reserve plus settle blocks the loop for
   about 0.6 s, measured on 2026-10-03. The same loop runs the metering proxy for gbrain's own provider calls and
   reads the MCP pipes. As a result:
   - gbrain tool latency in the harness looked 10–30 times higher than the same calls replayed alone. Search p50 was
     16.6 s in the harness against 0.34 s alone.
   - Later runs looked slower than earlier ones, because the ledger kept growing.
   - 89 of about 123 `remember` calls in the held-out fixed-build run ran past gbrain's 5 s write wait and returned
     `write_pending`.

   Cat 40 cannot publish latency, and every future paid category in this repo inherits the same stall.

2. **gbrain costs 2.5 to 4 times as much per task as plain files.** Held-out world, shipped build `77dcf414`. Here $/task is the session-2 agent cost; the cell total, which adds family F's first session and gbrain's own provider calls, is $0.130 fixed, $0.098 release, $0.032 fs and $0.021 pg:

   | Arm | $/task | Input tokens/task | Turns | Tool calls | Tool-result chars/task |
   |---|---|---|---|---|---|
   | fs | 0.028 | 29k | 4.7 | 8.7 | 16k |
   | pg | 0.019 | 16k | 3.7 | 5.6 | 11k |
   | gbrain release | 0.088 | 127k | 3.6 | 4.9 | 72k |
   | gbrain fixed | 0.121 | 163k | 3.5 | 4.4 | 115k |

   Two things drive it, measured on the `--surface starter` server (33 tools). Results are the larger: on Anthropic models about 80% of a gbrain task's cost is cache writes, roughly 15k tokens of tool list and 34k tokens of tool results per task; on OpenAI models it is uncached input, mostly each turn's new tool results.
   - **Tool results.** A `search` returns about 23 rows and 29k characters. Each row averages 1.2k characters, but its
     `chunk_text` is only about 200–460 of them. The rest is diagnostics an agent rarely uses: `page_id`, `chunk_id`,
     `chunk_index`, `chunk_source`, `keyword_hit`, `cosine`, `base_score`, `evidence`, `create_safety`, `delivered`,
     `modality`, `id`, and pretty-printing whitespace (compact JSON is 22.6k against 28.7k). Search and query
     produced 65.5M of the fixed arm's 68.6M result characters. Each result stays in context and is re-sent on every
     later turn.
   - **Tool definitions.** The 33 tool schemas are 57k characters, about 14k tokens, plus 4k characters of server
     instructions, re-sent on every turn. `query` alone is 11.3k characters; then `recall` 4.7k, `search` 4.5k,
     `remember` 3.1k, `capture` 2.8k and `put_page` 2.7k. Prompt caching softens this, but caching is up to the
     harness, and every turn still pays the cached rate. The default stdio surface is `full`, with even more tools.

## Goals

- **G1 (evals).** A reserve or a settle costs under 5 ms on average on a 250k-event journal (headroom: today's
  111k-entry ledger migrates to about 111k events). The ledger guarantees stay unchanged: no
  spend past a run budget or the program cap, crash-safe, safe across concurrent processes. Harness tool latency
  then matches the isolated replay within 2x.
- **G2 (gbrain).** Cut gbrain's per-task cost on Cat 40 by at least 40%: on the held-out world the cell total (`total_usd`: every agent session plus gbrain's own provider calls, judge excluded) drops from $0.130 to $0.078 or less,
  with task success not measurably lower: the paired per-task difference against the current build has a 95% CI lower
  bound of −3 points or better. Zero new leaks.

Non-goals: changing ranking, changing Cat 40 tasks or scoring, changing other arms, and caching inside the harness's
agent loop (provider prompt caching stays as it is for every arm).

## Item 1: append-only budget ledger (gbrain-evals)

**Design.**
- **Journal.** Replace the rewrite-the-world JSON file with `.budget/ledger.jsonl`, one event per line:
  `ledger_open` (program cap), `set_cap`, `run_open`, `run_close`, `reserve`, `settle`, and `legacy_entry` (migration
  only). An event is one `write` of one line plus an `fsync`, under the
  existing lock file.
- **Incremental reads.** Each process keeps an in-memory fold of the ledger (per-run committed, program committed,
  open reservations) and the byte offset it has read up to. Under the lock it reads only the bytes appended since that
  offset, folds them in, checks the caps and appends. This preserves the cross-process guarantee: concurrent runners
  and `BudgetRun.join` participants see each other's events.
- **Crash safety.** A torn last line (no trailing newline) is ignored on read and truncated on the next locked write.
  A line that fails to parse anywhere else refuses to spend, as an unreadable ledger does today.
- **Migration.** On first open, an existing `ledger.json` is converted to events in one locked pass and renamed to
  `ledger.json.migrated`. `budget-ledger.ts status`, `ledgerTotals`, receipts and the per-run summary read the fold,
  so their output is unchanged.
- **Event-loop lag.** `startPaidRun` records event-loop lag (p50, p99 and max) for every paid runner, and
  `receiptCost` writes it into each receipt's cost block, so a future timing artifact shows up in the receipt instead
  of in a report.

**Tests.**
- Existing `test/eval/budget-ledger.test.ts` and `all-and-budget.test.ts` pass with their assertions unchanged; only
  their file-reading helper moves from parsing `ledger.json` to the fold.
- New tests:
  - cross-process concurrency: 4 processes × 500 reserves under a tight cap never overshoot
  - recovery from a torn tail
  - migration from a legacy `ledger.json`
  - a perf test where 1,000 reserve+settle pairs on a 250k-event journal average under 5 ms per operation
- Confirm in dev round 1 (Item 2's first paid run: gbrain arm, 3 models) that harness tool p50 is within 2x of an
  isolated replay of calls from that round, replayed at the harness's per-slot concurrency under its own small
  ledger budget.

## Item 2: gbrain cost wave (gbrain)

One gbrain PR (fix-wave convention). Changes are measured in two steps on the dev world (C1+C2, then C3+C4 on top)
before the held-out run.

- **C1. Lean result rows for remote MCP callers.** `search` and `query` rows for remote callers keep `slug`, `title`,
  `type`, `chunk_text`, `score`, `effective_date`, `source_id`, `chunk_id`, `stale` only when true, and
  `delivered.truncated` only when a non-chunk return unit was requested. A new
  `fields: "full"` parameter returns today's rows (`detail` is taken: `query.detail` already means low/medium/high). The trusted local CLI (`remote=false`) keeps full rows. Before cutting a field,
  check whether any agent in the Cat 40 transcripts reads it (`chunk_id` stays because `assemble_evidence` takes
  `{source_id, slug, chunk_id}` from search and query rows). Thin clients parse `content[0]`, so verify the thin-client path in `docs/architecture/thin-client.md` and its
  tests and keep any field it consumes.
- **C2. Compact JSON in MCP tool results.** `content[0]` goes back to `JSON.stringify(result)`, which is 21% smaller
  on search. It was reverted to pretty JSON in `77dcf414` to keep tests stable, not for agents. The held-out run already measured
  it: `51a30c1` (compact) against `77dcf414` (pretty) is −16% cost per task, success −1.0 points (CI −3.7 to +1.8). Update the tests that
  pin pretty output.
- **C3. Tool-description diet.** Give every starter-surface tool a schema budget (its description plus its parameter descriptions)
  sized so the served starter list reaches the target. Caps of 1,200 characters per description and 200 per parameter
  description stay as hard upper limits, but alone they save only about 8k of 61k characters (measured 2026-10-03). Long guidance is cut from the schemas. It moves into a bundled skill only where `get_skill` is
  served (it is gated by `mcp.publish_skills`, which Cat 40 does not enable); moving it into the server instructions
  saves nothing, so the instructions get their own ceiling at their current size. `query` drops from 11.3k characters. Target: the starter surface's schemas at 25k characters or less,
  down from 57k. A test pins the ceiling so it does not creep back.
- **C4. Leaner saved-facts and other-names blocks.** These stay, but have hard character ceilings (facts 1,500
  characters, other-names notice 400).
- **Not doing:** lowering the default `limit`. Fewer rows risks the evidence tasks (family E), and C1 already cuts
  per-row cost about 3x. Revisit only if the measurements say so.

**Measurement (paid, ledger-guarded).** The remaining program authorization is about $237 of $2,000.
1. Dev rounds: 3 models (GPT-5.4-mini, GPT-5.4, Sonnet 4.6), gbrain arm only, 1 repeat, about $16 per round. Run
   C1+C2 first, then add C3+C4. The other arms come from the existing dev-round results.
2. Held-out confirmation (the G2 gate, run before the ladder so an overrun cannot starve it): seed 20261003,
   6 models × 2 repeats, gbrain arm only, about $80 at today's rates. The paired comparison is against the `77dcf414`
   held-out run.
3. Final: the 11-model dev ladder on the gbrain arm only, 1 repeat, budgeted with what is left (about $106 at today's
   rates, less after the cuts). The comparison is against the `51a30c1` ladder.

Total about $218 at today's rates if the ladder runs in full, less once the cuts land; the ladder takes what
remains of $237. This needs Item 1 first so latency is measured honestly in the same runs. Every paid run uses one
ledger journal opened with `--program-cap-usd 237` (the remaining authorization) and runs uncapped
(`--max-tool-chars 100000000` until the runner's default is uncapped). Stop and ask before
exceeding $2,000 total.

**Ship rule** (eval-driven defaults): changes that hold success while cutting cost ship on by default. Any change
whose paired CI lower bound is below −3 points is dropped from the wave, and the report says so.

## Order

1. Item 1 in gbrain-evals: PR, CI, merge by Garry. Item 2's code and tests may be written meanwhile; its paid runs
   wait for this merge.
2. Item 2 in gbrain on branch `cat40-cost-wave`: C1–C4 with tests, dev rounds, the held-out run, then the final ladder.
   Then one gbrain PR (patch version) and one gbrain-evals PR adding the results to the Cat 40 report.

## Risks

- **Clients that read the dropped fields.** Lean rows are a contract change for remote callers. Mitigations: the
  `fields: "full"` escape hatch, a CHANGELOG note for agents, and a check of the thin-client parser.
- **Description cuts that hurt tool choice.** Measured by the dev rounds. If success drops, raise that tool's schema
  budget, or re-measure and re-pin the ceiling with a recorded reason.
- **Journal migration on machines with an old ledger.** Covered by the migration test. The old file is kept as
  `.migrated`.

<!-- autoplan-accepted:ceo -->
- G2's cost metric is the Cat 40 cell `total_usd` (all agent sessions plus gbrain's own provider calls through the metering proxy, judge excluded). Baseline: $0.130 per task, held-out world, `77dcf414`. Target: $0.078 or less (−40%). The report states the metric by name next to every cost number. Verify: `analyze.ts` prints it per arm and model.
- C1 lean rows keep `chunk_id` (required by `assemble_evidence`). The escape-hatch parameter is named `fields` (`"lean"` default for remote callers, `"full"` returns today's rows); it must not reuse `detail`. Verify: a test that a lean `search` row passed to `assemble_evidence` resolves, and a schema test that `query.detail` still means low/medium/high.
- C3 mechanism: a per-tool schema budget (description plus parameter descriptions); the 1,200 / 200 caps stay as hard upper limits, but they are not the mechanism. Starter membership does not change in this wave unless Taste decision CEO-T1 is approved. Verify: a ceiling test on the served list.
- E1: the Cat 40 runner's default is no per-tool-result cap (`--max-tool-chars` defaults to unlimited); the receipt keeps recording `max_tool_chars`. Verify: a runner test that a 100k-character tool result reaches the model unmodified by default, and the existing explicit-cap test still truncates.
- E2: `eval/runner/cat40/analyze.ts` reports, per arm and per model, dollars split into uncached input, cache write, cache read and output, plus tool-result characters per task by tool name. Verify: a fixture-based test of the split on two hand-built cells (one Anthropic, one OpenAI).
- E3: gbrain CI pins the serialized size of a canonical `search` and `query` result for remote callers on a fixture brain, beside C3's schema ceiling, so a change like `77dcf414` (+24% result characters) fails a test. Verify: the tests fail when pretty-printing is reintroduced.
- E4: `startPaidRun` starts an event-loop lag monitor; `RunSummary` carries its p50, p99 and max in milliseconds and `receiptCost` writes them into every receipt's cost block (Cat 40 included). A calibration test proves a deliberate 100 ms synchronous block registers at least 80 ms max on Bun. Verify: that test plus the Cat 40 receipt field.
- Budget enforcement: every remaining paid run in this plan goes through one ledger journal whose program cap equals the remaining authorization (`--program-cap-usd 237` on the fresh journal `.budget/cat40-followups.jsonl`), so the $2,000 program limit is enforced by the ledger. Each run passes `--budget-usd` for its own step. Verify: `budget-ledger.ts status --budget-ledger .budget/cat40-followups.jsonl` before each run shows the recorded $237 cap and the remaining dollars.
- Item 1's latency check runs inside dev round 1 (gbrain arm, 3 models): harness `search` and `query` p50 within 2x of the isolated replay comparator defined below, and the receipt's lag p99 under 50 ms. No separate paid agent run; the replay costs under $1 of embeddings.
- Item 2 code and tests may start while Item 1 is in review; Item 2's paid runs start only after Item 1 merges.
- Program cap persistence: the journal's first event records the program cap (`ledger_open` with `program_cap_usd`). A reserve refuses when an explicitly passed program cap disagrees with the recorded cap (see the event rules below); changing it takes an explicit `budget-ledger.ts set-cap` event. The remaining paid runs of this plan use a fresh journal `.budget/cat40-followups.jsonl` created with a cap of $237. Verify: tests for cap mismatch refusal and `status` reporting the recorded cap.
- Migration mapping: each legacy run becomes one `run_open` event (plus `run_close` when finished), and each legacy entry becomes one `legacy_entry` event carrying `id`, `run_id`, `description`, `reserved_usd`, `actual_usd`, `status`, token counts, timestamps and `participant`. Open legacy reservations stay committed at their reserved amount and can still be settled by id. `--budget-ledger` / `BRAINBENCH_BUDGET_LEDGER` paths ending in `.json` map to the sibling `.jsonl` journal; a legacy file at the given path migrates once under the lock and is renamed `.json.migrated`. Verify: migration test on a fixture with open reservations, a joined participant and an unfinished run; totals before and after match to the cent.
- Latency check failure path: if dev round 1 shows harness `search`/`query` p50 above 2x the comparator or receipt lag p99 of 50 ms or more, no further paid run starts until the cause is fixed and dev round 1 is rerun. The comparator is defined under Contingency below; the report's `238e12d8` dev-world replay (341 ms / 1,551 ms) stays as context.
- The 2x latency target assumes one runner process per journal; the lock wait stays synchronous because the journal holds the lock for one append. The report states the assumption.
- C1 scope: lean projection applies to the rows in `content[0]` for remote callers. `_meta.retrieval` (structured, not shown to the model by Cat 40's client) is unchanged. Per-row `delivered` is dropped in lean rows except `delivered.truncated` when a non-chunk return unit was requested. gbrain's own thin client keeps full rows (see the thin-client rule below). Verify: a thin-client routed `gbrain search` test against a lean-default host shows full rows.
- C3 baseline figures for context: draft 33 tools / 57k plus 4k instructions; `buildToolDefs` on all 38 starter ops gives 61,328 (4 of them gated by `mcp.publish_skills`). The ceiling test pins served schemas at 25k or less and instructions at their recorded size or less, so moving text into the instructions does not count as a saving.
- C4 targets: the model-visible notice blocks built by `retrievalNoticeBlocks` in `src/mcp/dispatch.ts`. Saved facts: whole facts newest first up to 1,500 characters, then a `(+N more; recall returns them)` marker. Other-names notice: whole alias pairs up to 400 characters, then `(+N more)`. Verify: unit tests at the boundary.
- E1 records uncapped as `max_tool_chars: null` in the receipt. E3 ceilings are measured size plus 5% on a deterministic fixture brain (no embedding key in CI). E1, E2 and E4 ship in the Item 1 gbrain-evals PR.
- G2 statistics: `docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py` method: per task, averaged over models and repeats, bootstrap over the 50 tasks, exact sign test. The report discloses that the `77dcf414` baseline ran under the ledger stall (89 `write_pending` results), which biases the comparison toward the new build.
- Paid-run order and budgets at today's rates: dev round 1 (C1+C2) about $16, dev round 2 (+C3+C4) about $16, T2 re-baseline about $11 if approved, held-out about $80, then the 11-model ladder with whatever remains. Each step passes its own `--budget-usd`.
- CEO-T1 is decided by Garry at the final gate as a conditional pre-approval: if per-tool budgets cannot bring the served starter schemas to 25k, the implementer may move the skill-admin and write-request ops behind `request_tools`; without that approval the implementer reports the achieved size instead. Arithmetic for the decision (spec review round 3): of 61,289 characters on 38 ops, 15,258 is schema structure, so on about 33 served tools only about 11k is left for all descriptions, about 330 characters per tool, against 46k today.
- Journal events and fields: `ledger_open {program_cap_usd, created_at}`; `set_cap {program_cap_usd, at}`; `run_open {run_id, runner, budget_usd, estimate_usd, started_at}`; `run_close {run_id, finished_at}`; `reserve {id, run_id, description, reserved_usd, created_at, participant?}`; `settle {id, run_id, actual_usd, status, input_tokens, output_tokens, settled_at}`; `legacy_entry {every LedgerEntry field}`. Migration and fresh journals write `ledger_open` with the explicitly passed cap, or $500 (`DEFAULT_PROGRAM_CAP_USD`) when none is passed; the legacy file's `program_cap_usd` is ignored because it only records the last writer's flag. Raising the cap takes `set-cap`. When `--program-cap-usd` and `BRAINBENCH_PROGRAM_CAP_USD` are both absent, a caller adopts the recorded cap; only an explicit value that disagrees is refused. Verify: tests for adopt-on-omit and refuse-on-explicit-mismatch.
- If a legacy `.json` file and its `.jsonl` journal both exist and the legacy file is not renamed `.migrated`, the ledger refuses to spend and names both paths. The existing unreadable-ledger test writes its corrupt line into the journal instead of `ledger.json`; that setup change is the one exception to "assertions unchanged". Verify: a both-files-present refusal test.
- The fold holds, per run and per participant: reserved, committed and actual dollars, request count, `charged_reservations`, input and output tokens; program committed dollars; the open-reservation map (id to entry) and the set of settled ids, so `settle` still reports "unknown" versus "already settled". The read offset advances only to the last complete newline, so lock-free readers (`status`, `summary`) never consume a torn tail.
- E2 buckets sum to `total_usd` per cell: scored-session and session-1 dollars split into uncached input, cache write, cache read and output (both sessions carry usage in the cell), plus a "gbrain provider calls" bucket from `gbrain_internal.usd`. The fixture test asserts the sum to the cent.
- Exact paid-run commands. All runs happen on one machine, share `--max-tool-chars 100000000 --arms gbrain --surface starter --gbrain-repo ../gbrain --budget-ledger .budget/cat40-followups.jsonl --program-cap-usd 237 --transcripts`, set a fixed `--out eval/reports/cat40/followups-<label>` so a timed-out run resumes, and record the journal path in the receipt. Dev rounds and the ladder match the `51a30c1` fix-wave ladder's argv (operator ANALYZE on, `--slot-ref ad7900d --slots 5 --concurrency 6`): dev round 1 `--models gpt-5.4-mini,gpt-5.4,claude-sonnet-4-6 --gbrain-ref <C1+C2 commit> --gbrain-label gbrain-c12 --budget-usd 18`; dev round 2 the same with `--gbrain-ref <C1-C4 commit> --gbrain-label gbrain-c1234 --budget-usd 18`; ladder `--models claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5,claude-sonnet-5-5,claude-opus-5-5,gpt-5.4-mini,gpt-5.4,gpt-5.5,gpt-6-sol,gpt-6.1-sol,gpt-6-astra --gbrain-ref <final commit> --gbrain-label gbrain-c1234-ladder --budget-usd <remaining>`. Held-out and T2 match the `77dcf414` held-out receipt's argv (`--world <seed-20261003 world.json> --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10`): held-out `--models claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4-mini,gpt-5.4,gpt-6.1-sol --gbrain-ref <final commit> --gbrain-label gbrain-next2 --budget-usd 85`; T2 `--models claude-haiku-4-5,gpt-5.4-mini --gbrain-ref 77dcf414 --gbrain-label gbrain-next-rebase --budget-usd 12`. `holdout_stats.py` gains the pairs `gbrain-next2` vs `gbrain-next` and `gbrain-next-rebase` vs `gbrain-next` (same two models).
- Dev-round decision rule: each round is compared with the same three models' cells from the `51a30c1` fix-wave ladder on the dev world. Go to the next step unless the round's paired success difference is −5 points or worse or its `total_usd` per task did not fall; the original ship rule still applies at held-out unless the gate changes it.
- CEO-T2 (Taste, provisional include): after the dev rounds and before held-out, rerun `77dcf414` on the held-out world for Haiku 4.5 and GPT-5.4-mini, 2 repeats, about $11, under the new ledger. The report compares that subset with the same subset of the original `77dcf414` run to size the stall's effect, and states it next to the G2 comparison; the G2 comparison itself stays against the full original run.
- Contingency: a failed latency check costs one more dev round 1 (about $16) plus the isolated replay's embedding calls (under $1); a G1 miss produces a follow-up gbrain-evals PR before any further paid run. The latency comparator replays 40 `search`/`query` calls sampled from dev round 1's own transcripts against the same build and world, at the harness's per-slot concurrency (2 agents per slot), under `startPaidRun` with `--budget-usd 1` on the same journal.
- Gate failures. A dev round that fails its harm screen: drop the change most likely to have caused it (C3 before C4 in round 2; C1 before C2 in round 1), rerun that round once (about $16), and stop for Garry if it fails again. A held-out run that holds success but misses the 40% cost target: the wave still ships on by default (it saves cost without losing success) and the report says the target was missed. A held-out success failure under the ship rule: nothing ships default-on; stop and report to Garry with the per-model and per-family breakdown.
- Base commit: Item 2 builds on gbrain master `566a242a` (v0.60.35.0), which differs from `77dcf414` by an alias-matching change in `src/core/ops/search.ts`. The report discloses that the G2 comparison includes it.
- E4 also adds `receiptCost` (or its lag fields) to `eval/runner/n2-3-prompt-ab.ts`, the one paid runner that calls `startPaidRun` without it.
- If the 25k schema target is not reached and CEO-T1 is not approved, the ceiling test pins the achieved size with the reason recorded beside it. E3's pinned size covers the full model-visible text: `content[0]` plus the notice blocks C4 changes.
- C4 edge case: facts and alias pairs are never cut inside an item, so provenance stays intact. When the first fact alone exceeds 1,500 characters (or the first alias pair exceeds 400), it is shown whole and the ceiling applies from the second item on, followed by the marker. Verify: boundary tests.
- "Zero new leaks" means `output_leak`, `context_exposure` and `unsafe_write` counts in `holdout_stats.py` are not above the `77dcf414` baseline's.
- C3 target, one statement with two pinned numbers: the served starter tool schemas (Cat 40 configuration, recorded with its config at implementation start) are 25k characters or less, and the initialize instructions are no larger than their recorded size. In the Cat 40 configuration `get_skill` is not served, so long guidance is cut, not moved.
- C1 also keeps these sparse safety and provenance fields whenever they are present: `injection_suspected`, `injection_p`, `unverified`, `content_flag`, `status`, `superseded`, `superseded_by`, `modality` (when not text), `message_id`, `thread_id`, `source_subject`. Each dropped field is checked against in-repo consumers (grep of gbrain `src/`, skills and docs) as well as the Cat 40 transcripts; the field list is final unless a consumer turns up, and the PR records the check. Third-party remote clients that read dropped fields get lean rows after upgrading the host; the CHANGELOG tells them to pass `fields: "full"`. gbrain's own thin client keeps full rows (CEO-A1).
- E4 lifecycle: `startPaidRun` returns the lag monitor with the run; `BudgetRun.close()` stops it and puts the stats in that process's `RunSummary`. A joined participant reports its own process's lag in its own summary (in memory, not in the ledger).
- Thin client (CEO-A1): the host serves full rows by default to sessions whose MCP `clientInfo.name` is `gbrain-remote-cli` (gbrain's own thin client, `src/core/mcp-client.ts`), so old and new CLIs keep `--explain` and renderers without sending `fields`; the thin client never sends `fields`, so hosts with `mcp.strict_params=reject` are unaffected. Every other remote session gets lean rows unless it passes `fields: "full"`. Verify: a test per client identity, and a reject-mode test.
- E3's fixture uses stubbed deterministic embeddings (or proves the keyword fallback first), so CI needs no key.
- Migration crash safety: migration writes the converted events to a temporary journal, fsyncs and renames it to the `.jsonl` path, and only then renames the legacy file to `.json.migrated`; a crash before the journal rename leaves the legacy file as the only ledger and the next open retries. Verify: a test that kills migration between the two renames.
- Report additions (CEO-A2, A3): the Cat 40 cost-wave report shows, beside the pooled G2 comparison, the paired difference per model and per task family, and flags any model or family at −8 points or worse; `analyze.ts` prints cost per successful task (`total_usd / success`) per arm and model. Cat 40 scoring is unchanged.
- Partial ladder rule (CEO-A4): if the 11-model ladder cannot run in full within the remaining budget, run complete models (all 50 tasks each) in the listed order until the budget is spent, and label the ladder partial with the models it covers.
- Receipts record the journal path and its recorded program cap. The ledger header comment and `status` output carry two runbook lines: "both files present" (check totals, keep the journal, rename the stale legacy file) and "cap mismatch" (`set-cap` only with Garry's authorization). The `budget-ledger.ts` header comment is rewritten for the journal; gbrain `docs/architecture/thin-client.md` gains one line on CEO-A1.
- C1's projection lives in the shared search/query output path in `src/core/ops/search.ts` (after evidence delivery), not in `dispatch.ts`; the fold is the single source for `ledgerTotals`, `ledgerStatus`, `summary` and `close`.
- Deferred to TODOS.md: E5 (journal compaction command) and E6 (`gbrain-verbs` cost-floor arm on the 7-verb surface).
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- DX-1 (supersedes CEO-A1's clientInfo-only rule): gbrain's thin client sends `X-Gbrain-Client: gbrain-remote-cli/<version>` on every HTTP request; the host serves full rows to requests carrying it and to stdio sessions whose `clientInfo.name` is `gbrain-remote-cli`. CLIs older than this release cannot be detected and get lean rows unless the host sets `mcp.result_rows: full`; the CHANGELOG says so. Verify: identity tests over stateless HTTP and over stdio.
- DX-2: host config `mcp.result_rows` (`lean` default, `full` restores today's rows for every remote caller); `_meta.retrieval.rows` reports `"lean"` or `"full"`; the `search` and `query` descriptions name `fields: "full"` in one sentence inside C3's budget. Verify: config test and schema test.
- DX-3: `bun eval/runner/budget-ledger.ts init --budget-ledger <path> --program-cap-usd <n>` creates a journal (cap $500 when omitted); a reserve against a missing journal refuses and prints the `init` command; `status` is read-only and never creates or migrates. The plan's first paid step is `init --budget-ledger .budget/cat40-followups.jsonl --program-cap-usd 237`. Verify: tests for each.
- DX-4: `budgetOptionsFrom` leaves `programCapUsd` null when neither `--program-cap-usd` nor `BRAINBENCH_PROGRAM_CAP_USD` is set; a runner without either adopts the journal's recorded cap. Verify: a runner with no cap flag against a $237 journal reserves and `status` shows $237.
- DX-5: every runtime reader of the ledger file goes through the shared fold reader (inventory with `rg 'ledgerPath|ledger\.json'`; known: `eval/runner/evidence-delivery.ts:123`). Migration replaces `ledger.json` with a tombstone `{"schema_version": 2, "migrated_to": "<journal path>"}` (old code refuses to spend on it) and keeps the legacy copy as `ledger.json.migrated`. The upgrade procedure is: stop all runners, pull, run `status` then one runner. Verify: an old-code worker against a migrated directory refuses; a migrated campaign-open and join flow works in `evidence-delivery.ts`.
- DX-6: refusal messages, each naming the journal path: cap mismatch (recorded cap, requested cap, and whether it came from the flag or the environment variable; says to unset an environment override, or to run `set-cap` after the user approves); both real ledgers present (both paths and totals; "interrupted migration, totals match: run `budget-ledger.ts migrate --finish`" or "legacy file has newer spending: stop and ask the user"); unparseable line (line number, byte offset, `verify` command); missing journal (the `init` command). `set-cap --budget-ledger <path> --program-cap-usd <n> --reason <text>` records `{program_cap_usd, reason, by: user@host, at}`, refuses a cap below committed spend, and appears in the usage string and `--help`. `status` stays one JSON object on stdout with a `hints` array. Verify: CLI tests asserting each message's command text.
- DX-7: `budget-ledger.ts verify --budget-ledger <path>` (read-only) prints the first bad line and byte offset and the totals up to it; `docs/budget-ledger.md` documents the recovery (copy the journal, truncate at the offset, compare totals, ask the user before spending again). Verify: test on a journal with a corrupt middle line.
- DX-8: `scripts/cat40-followups.sh <init|dev1|dev2|rebase|holdout|ladder>` assembles the exact commands in the CEO block, validates `GBRAIN_C12_REF`, `GBRAIN_C1234_REF` and `GBRAIN_FINAL_REF`, regenerates the held-out world with `bun eval/generators/model-ladder-gen.ts --seed 20261003 --out eval/reports/cat40/holdout` and refuses unless its digest starts `df9e4f65cf60` (the world is not committed; the baseline receipt used that path), runs `status` first, and takes the ladder's budget from `status`'s `remaining_usd`. Verify: `bash -n` and a dry print mode (`PRINT_ONLY=1`).
- DX-9: run labels are `gbrain-c12-dev`, `gbrain-c1234-dev`, `gbrain-77dcf414-rerun`, `gbrain-c1234-holdout` and `gbrain-c1234-ladder`; these replace `gbrain-c12`, `gbrain-c1234`, `gbrain-next-rebase`, `gbrain-next2` and the ladder label in the CEO block, and `holdout_stats.py` pairs use them.
- DX-10: `--max-tool-chars none` is the explicit uncapped spelling (receipt `max_tool_chars: null`); once E1 lands the paid commands omit `--max-tool-chars`. Verify: runner test.
- DX-11: receipts carry `cost.event_loop_lag_ms: {p50, p99, max}`, or `null` plus `event_loop_lag_unavailable: <reason>`; `analyze.ts` prints a warning when p99 is 50 ms or more. Verify: analyze fixture test.
- DX-12: gbrain-evals `docs/budget-ledger.md`, linked from `eval/README.md`, covers init, status, verify, set-cap, migration, the upgrade and downgrade procedure, recovery, a free hermetic smoke run and the cost-wave runbook. gbrain `docs/mcp/README.md` gains lean and full request/response examples and a client compatibility table; the full pre-cut tool guidance moves to a human MCP tool reference doc linked from the CHANGELOG.
- DX-13 (supersedes the CEO rule "only when a non-chunk return unit was requested"): lean rows keep `delivered.truncated: true` whenever delivery truncated, whether the unit came from the call, the config or `auto`. Verify: tests for omitted, configured and explicit `return_unit`.
- DX-14: every starter tool keeps, within its C3 budget: purpose; required inputs; consequential defaults (for `search`: exact tokens and top-K; for `query`: expanded and ranked; when to fetch surrounding evidence); a cost note where relevant; the recovery action. The PR carries the per-tool table; dev round 2 is the behavioral check.
- DX-15: lean rows keep `id` (the deep-research `fetch` key, `docs/protocol/DEEP_RESEARCH_IDS_v1.md`). Verify: a lean `search` row's `id` resolves through `fetch`.
- DX-16: version-skew tests: old and new thin client against old and new host, over stdio and HTTP, including `mcp.strict_params=reject`.
- DX-17: downgrading Item 1 is allowed only while `verify` reports no event appended after migration; otherwise the journal stays. Documented in `docs/budget-ledger.md`.
- DX-18: time the operator path (merged Item 1 → first guarded paid run started) once from a clean checkout and record the minutes in the Item 1 PR; the target is under 5 minutes and 3 commands.
- Paths: when a `.json` path is remapped to its `.jsonl` journal or migrated, the CLI prints one notice line on stderr; `status` and every receipt show the resolved journal path.
- Supersessions in the CEO block: the migration step "renamed to `ledger.json.migrated`" now also leaves the DX-5 tombstone at `ledger.json`; a tombstone is not a second ledger, so the both-files refusal applies only to a real (schema 1) legacy file beside a journal, and DX-6's two cases (totals match: finish the migration; legacy has newer spending: stop and ask) replace the runbook line "keep the journal, rename the stale legacy file".
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- E-1 reservation completeness: `priceRequest` counts `tools` (schemas) and OpenAI `instructions` in the input estimate; for a request with `previous_response_id`, the guard adds the chain's prior reported input and output tokens (kept in memory per response id; an unknown id reserves the model's full context window); when a provider has a cache-write price above the input price, the reservation prices all input at the higher of the two. `settle` records any overshoot (`actual > reserved`) in the fold and `RunSummary` as `overshoot_usd`, and the next reserve counts it. Verify: tests where an Anthropic request with tools and an OpenAI continuation chain report costs that stay within their reservations.
- E-2 owner-checked lock (with N-7): the lock file holds `{pid, host, nonce, created_at}`; a waiter takes over only when the owner is on this host and its pid is gone, or after the stale window when the owner's nonce is unchanged and its pid is gone; release deletes the lock only if the nonce matches. Appends use an `O_APPEND` descriptor; a short write retries the remainder; a failed fsync makes the process refuse further spending; a holder truncates only back to the offset it verified itself; journal creation and migration fsync the directory. Verify: a suspended-writer test (pause between check and append, expire, second writer spends, first resumes) never overshoots; injected short-write and fsync-failure tests.
- E-3 manifest-bound runs: each `--out` directory holds `experiment.json` (gbrain commit, world digest, models, arms, label, every flag except `--budget-usd`, and the budget run id). A rerun with a different manifest refuses; a changed build gets a new `--out`; a resume joins the recorded budget run (`--budget-run-id`) instead of opening a new one, so a timeout restart does not get a fresh step budget. Verify: runner tests for both refusals and for the joined resume.
- E-4 slot builds: the script runs a `slots` step before any agent step (its own `--budget-usd`, `--slot-build-allowance-usd 2`, builds serialized), and every agent step preflights that all slot snapshots for its build and world exist and refuses otherwise. Verify: a cold-start preflight test.
- E-5 coverage: the ladder schedules complete model batches (all 50 tasks of one model before the next; a new `--order model` flag, default unchanged); G2 analysis refuses unless both sides have unique, complete `(model, task, repeat)` coverage; T2's comparison restricts both sides to its two models; cells that failed for non-budget reasons are rerun through resume before analysis; an unfinished batch is reported separately. `holdout_stats.py` enforces the coverage check. Verify: stats tests on an incomplete fixture.
- E-6 cost attribution: proxy meters are keyed by cell id and finalized after the cell's in-flight provider requests drain (after restore); unpriced proxy calls are charged at their reservation and counted; analysis reconciles the sum of cell `total_usd`, judge cost and slot builds against the ledger run's spend and flags a gap over 1%. Verify: a delayed-request attribution test and the reconciliation check in `analyze.ts`.
- E-7: lean rows keep `evidence` and `create_safety` (the duplicate-page guard, `src/core/search/evidence.ts`). Verify: the existing duplicate-prevention cases pass on projected remote rows.
- E-8: the latency comparator replays at one agent per slot with the run's slot count in parallel (five), not two per slot; receipts record per-cell `restore_ms`. Supersedes DX's "2 agents per slot" wording. Verify: replay script option and receipt field.
- N-3 creation rule: `BudgetRun.open` creates a missing journal only when an explicit cap is passed or the path is the default (then $500); `join`, `reserve` and any other missing journal refuse with the `init` command. Test setups that change are listed in the Item 1 PR as exceptions to "assertions unchanged".
- N-4 caps are `number | null` through `budgetOptionsFrom`, `BudgetRun.open/join`, `ledgerStatus`, `requirePaidArm` (`eval/runner/paid-arm.ts:47`) and the CLI; a manifest cap (`evidence-delivery.ts:105`) is an upper limit (refuse when the recorded cap is higher), not a value that must match. The test at `budget-ledger.test.ts:225` asserting `programCapUsd: 500` is a listed exception. Verify: tests for each caller.
- N-5 migration order: the migrator holds both `ledger.json.lock` and the journal lock; it writes and fsyncs the journal (temp then rename), copies the legacy file to `ledger.json.migrated` and fsyncs it, then atomically renames the tombstone over `ledger.json`, so the legacy path is never missing. Supersedes the CEO "rename legacy" wording. Verify: kill-point tests after each step.
- N-6 offset check: under the lock, a process compares the journal's dev, inode and size with its cached state, and checks that the byte before its offset is a newline; on any mismatch it refolds from zero. Verify: tests that replace and truncate the journal under a live process.
- N-8 perf: CI asserts scale invariance (reserve+settle at 250k events within 2x of 1k events, fsync excluded); the 5 ms average is measured and reported on the run machine in the Item 1 PR with fsync time shown separately; `status` reports cold-fold time and hints at compaction above 100 MB.
- N-9: every test file that references `ledger.json` (14 found) is inventoried and its assertions point at the resolved journal path, so none passes vacuously.
- N-10: the reader inventory names its exclusions (`bug-ledger.ts`, `system-one/recount.ts`, `scripts/run-retrieval-refresh.py`); a journal whose first line is not `ledger_open` refuses.
- N-11: C1's projection runs at the end of `evidenceOutput` in `src/core/ops/search.ts`, after capture, response meta and `bumpLastRetrievedAt` have read full rows; an `OperationContext.resultRows` field (`lean` | `full`) is set by both gbrain transports and defaults to lean when unset and `remote !== false`.
- N-12 (supersedes DX-1's stdio clause): the thin client only uses HTTP, so the stdio `clientInfo` branch is dropped; the `X-Gbrain-Client` header is unverified and a code comment says it must never gate anything security-relevant.
- N-13: C3's day-1 measurement includes trimming schema structure (repeated enum, default and nested-object text) and reports the ceiling in tokens as well as characters.
- N-14: held-out step budget $95; a partial held-out run resumes with the same `--out` and recorded run id.
- N-15: `init` records the $237 provenance in its reason ($2,000 authorization minus $1,763 spent across four machines' ledgers, 2026-10-03); no other paid work runs while this plan spends.
- N-16: the dev-round screen is documented as catching only large harms; when it fails, the change to drop is chosen from the per-family breakdown.
- N-17/N-18/N-19: the lag monitor stops in `finally`; `status` reads an unmigrated legacy file read-only; `migrate --finish` has a CLI spec, `--help` entry and tests; a non-schema-1 legacy file beside a journal refuses with a message; C2's error-envelope test churn and an E3 re-pin procedure are documented in the gbrain PR.
- Test plan artifact: `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-followups-eng-review-test-plan-20261003.md` lists every test above with value cards.
- TODOS.md entries 1-5 from the Eng record go into gbrain-evals `TODOS.md` with the Item 1 PR.
- C5 (parent instruction, GBRA-40): search skips each #5932 lookup cheaply when there is nothing to find. (a) Profile first: under the scale harness, time the saved-facts query, the declaration scan and fan-out search, `probeProjectionReadiness` and `hasUnsealedPagesInScope` per search, and record the split in the PR; if a stage other than the two named dominates, report it to Garry and GBRA-40 rather than widening C5. (b) Saved facts: before the `LIKE ANY` query, an indexed `EXISTS` probe for any active fact in the caller's sources (same `expired_at`, `valid_until` and remote-visibility predicates) skips the query when it finds none; a per-process cache of that bit is allowed only with invalidation on every fact write, forget or expiry through the dispatch mutating path and a TTL of at most 2 s for writes from other processes, so a fresh `remember` is never hidden. (c) Fan-out: `aliasDeclarations` runs once per search and its result is reused by the fan-out and the response meta; before the regex it checks the lowercased `chunk_text` of the top 10 rows for any declaration keyword (`account code`, `also known as`, `a.k.a`, `aka`, `short name`, `ticker`, `code name`) and returns no declarations when none appears; the regex still decides when one does. (d) Verify: `bun scripts/scale/run.ts --pages 10000 --seed 1` on the same machine in the same session for v0.60.32.0 and the C5 build; search p50 within 10% of v0.60.32.0 (the harness fixture has no facts or declarations). Unchanged results when they exist: unit tests on a fixture with active facts and declared names show byte-identical `content[0]`, notice blocks and fan-out ordering before and after C5, plus a test that `remember` followed by `search` in the same process and from a second process returns the fact. (e) The harness lives on `capy/fix-wave-8`: if wave 8 merges first, rebase `cat40-cost-wave` onto master and take the next patch version after v0.60.36.0; otherwise run the harness from a fix-wave-8 worktree against this build. Coordinate landing order with the fix-wave-8 thread. (f) C5 ships in the same gbrain PR, lands before dev round 1 (it changes no model-visible output), and costs $0.
<!-- /autoplan-accepted:eng -->
## Review record

Autoplan run 2026-10-03 (/autoplan, "accept all recs"). Phases: CEO, DX, Eng (UI scope: no, so Design is skipped). Every intermediate question was auto-decided with the recommended option; Taste decisions and User Challenges wait for the final gate. Source plan backed up at the restore path above.

### Phase 0 intake

- Base branch: `main` (gbrain-evals, remote `garrytan/gbrain-evals`). Plan branch `plan/cat40-followups`, HEAD `6e5fb1c`, no stashes, plan file untracked.
- gbrain checkout: `/workspace/gbrain`, branch `cat40-cost-wave` = master `566a242a` (v0.60.35.0), clean. `77dcf414` is the "keep pretty JSON tool results" commit inside that release.
- Scope: UI no (no view/rendering terms). DX yes (`dxRequired: true`; gbrain is a developer tool and an AI agent is the primary user of the MCP surface).
- Outside voice: Codex CLI ready (`gpt-6-astra`, API key route). Native reviewers run as Capy subagents on the shared machine (no Claude Code Agent tool on this host).
- Methodology reads: CEO bundle `autoplan-ceo-methodology-pPJtjn/methodology.md` read at ranges 1-531, 532-1201, 1202-1730, 1731-2303, 2304-2550 (EOF, 2,550 lines).

### CEO phase (Phase 1), Step 0

Mode: SELECTIVE EXPANSION (autoplan override; plan adds capability to two existing systems).

#### System audit (evidence gathered before Step 0)

Measured on this machine, 2026-10-03, $0 (existing artifacts and local code only):

1. **Where the gbrain arm's dollars go (held-out run, `docs/benchmarks/2026-10-02-model-ladder/holdout/results.jsonl`).** Per task, all sessions:

   | Arm | uncached input $ | cache-write $ | cache-read $ | output $ | tool-result chars |
   |---|---|---|---|---|---|
   | gbrain fixed (`77dcf414`), Sonnet 4.6 | 0.000 | 0.185 | 0.037 | 0.013 | 136k |
   | gbrain fixed, Sonnet 5.5 | 0.000 | 0.185 | 0.056 | 0.012 | 168k |
   | gbrain fixed, GPT-5.4 | 0.066 | 0 | 0.016 | 0.005 | 78k |
   | gbrain fixed, GPT-6.1 Sol | 0.075 | 0 | 0.013 | 0.004 | 116k |
   | fs, Sonnet 4.6 | 0.000 | 0.029 | 0.007 | 0.015 | 14k |

   On Anthropic models about 80% of a gbrain task's cost is cache writes: new content entering the cached prefix. Tool definitions are written once per session and then read at 10% of the input price; tool results are written once each and then re-read every later turn. At about 49k cache-written tokens per Sonnet 4.6 task, roughly 15k is the tool list and roughly 34k is tool results. On OpenAI models the cost is uncached input, which is mostly each turn's new tool results. **Tool results are the larger lever; definitions are the second.** The report's headline line ("mostly because 33 tool definitions ride along on every turn") overstates definitions.
2. **`search` is 75% of result characters.** Fixed build: 88.6k of 118k result characters per task come from `search` (2.8 calls per task, about 32k characters each), 23k from `query`.
3. **Compact JSON already has a held-out measurement.** `51a30c1` emitted compact JSON; `77dcf414` is `51a30c1` plus a master merge, pretty-printed JSON and fail-closed type lookups. Held-out: 95k against 118k result characters per task, $0.109 against $0.130 per task (all sessions plus gbrain's own provider calls), success difference −1.0 points (95% CI −3.7 to +1.8). So C2 is worth about −16% cost on its own, with success measured flat.
4. **The cost metric in G2 is ambiguous.** The plan's table ($0.121 fixed, $0.088 release, $0.028 fs, $0.019 pg) is the session-2 agent cost only. The report quotes the cell total ($0.130 / $0.098 / $0.032 / $0.021), which adds family F's first session and gbrain's own provider calls. The judge ($0.003 per task) is in neither.
5. **The tool-definition numbers do not match the C3 mechanism.** `buildToolDefs(filterOpsForSurface(operations, 'starter'))` at v0.60.35.0: 38 tools, 61,328 characters of compact JSON. Top-level descriptions total 16,102 characters and only one (`query`, 1,243) exceeds 1,200. Parameter descriptions total 29,900; 43 exceed 200. The JSON with every description removed is still 11,009 characters. Applying C3's caps (1,200 / 200) saves about 8,000 characters, leaving about 53k, not 25k. The plan's 33 tools / 57k figure is the served list in the Cat 40 configuration; either way the caps alone cannot reach the target.
6. **`detail` is already a parameter.** `query.detail` and `assemble_evidence.detail` take `low | medium | high` (chunk selection). C1's `detail: "full"` would collide.
7. **`chunk_id` is load-bearing.** `assemble_evidence` takes `{source_id, slug, chunk_id}` from prior `search`/`query` rows (its description says so). C1 must keep `chunk_id`.
8. **The runner still defaults to capping tool results.** `eval/runner/cat40/loop.ts` `DEFAULT_MAX_TOOL_CHARS = 20_000`; the published runs pass `--max-tool-chars 100000000`. A dev round launched without the flag would cap gbrain's results, against the standing rule that agent-task arms run uncapped.
9. **No single ledger enforces the remaining $237.** Program spend ($1,763) is spread across four machines' ledgers; each ledger's default program cap is $500 (`DEFAULT_PROGRAM_CAP_USD`). Nothing in the plan makes the remaining authorization a hard cap.
10. **The latency verification in Item 1 is a paid run that the $185 estimate omits.**
11. **The ledger lock also blocks the loop.** `withLock` waits with `Atomics.wait` (`sleepSync(25)`), synchronous on the event loop. Within one process reserve/settle are synchronous so they never contend; across processes a waiter blocks its own loop for 25 ms per retry.
12. **Bun's `monitorEventLoopDelay` works but reads low.** Probe on Bun 1.4.2: a 50 ms synchronous block registered as 39.6 ms max (Node: 60 ms). A lag recorder needs a calibration test.
13. **Power of the ship rule.** The held-out comparison of two builds that differ only in JSON formatting (`77dcf414` vs `51a30c1`, 6 models x 2 repeats x 50 tasks) produced a 95% CI of [−3.7, +1.8]: half-width about 2.75 points. A change with zero true effect passes "lower bound ≥ −3" only when its point estimate lands above about −0.25, roughly a coin flip. Per-change decisions on a 3-model, 1-repeat dev round (CI half-width roughly 8 points) cannot pass it at all.

Prior learnings: none recorded for this project. Design doc: none (standard review; /office-hours offer auto-skipped under autoplan). Handoff note: none. Brain context: not used.

Taste calibration. Good patterns to copy: `BudgetAllowance` (in-memory charging inside a ledger-checked sum, `eval/runner/budget-ledger.ts`), the metering proxy's per-slot attribution (`eval/runner/cat40/gbrain-arm.ts`), and gbrain's D8 extra-content-block convention (`src/mcp/dispatch.ts`, thin clients read `content[0]` only, so model-visible notices ride in later blocks). Pattern to avoid: rewrite-the-world persistence on a hot path (`writeLedger`), and silent defaults that contradict a protocol rule (`DEFAULT_MAX_TOOL_CHARS`).

Landscape (web search, 2026-10-03). Layer 1: progressive disclosure of tool schemas (names first, schema on demand: atlassian-labs/mcp-compressor, delta-mcp) and result shaping/compact encoding (delta-mcp reports −17.7% from compact JSON, close to the −21% measured here). Layer 2: proxies that diet schemas 50-78%. Layer 3 (first principles): with provider prompt caching, the schema is paid at full price once per session and at 10% after that, while every new tool result is paid at full price (or cache-write price) once and re-read every turn. For a 4-turn task, result bytes cost more than schema bytes. gbrain already ships the progressive-disclosure primitive (`request_tools`), so the cheapest schema win is already half-built.

#### 0A. Premise challenge

- **Real problem.** (1) Cat 40, and every paid category, cannot publish latency because the harness stalls itself. (2) gbrain costs 4x files per task on the held-out world ($0.130 vs $0.032 cell total), which makes "use gbrain" a harder recommendation even though it now wins on success. Do-nothing cost: latency stays unpublishable, and the cost gap stays the first objection to the Cat 40 result.
- **Directness.** Item 1 attacks the root cause (rewrite-the-world ledger), not a proxy. Item 2 attacks per-task tokens directly; its weakest premise is that definitions are a co-equal driver (finding 1), which only changes priority, and its stated C3 mechanism cannot reach its own target (finding 5).
- **Premises accepted (P6):** the ledger stall explains the latency distortion (isolated replay evidence); results and definitions both matter; lean rows for remote callers with an escape hatch are the right shape; one gbrain PR.
- **Premises corrected as facts (no behavior change):** cost metric definition (finding 4), C3 arithmetic (finding 5), `detail` collision (finding 6), `chunk_id` dependency (finding 7), C2 already measured (finding 3).
- **Premise queued as a possible User Challenge (pending outside voices):** the per-change ship rule "paired CI lower bound below −3 points is dropped" cannot be met by the planned sample sizes (finding 13). Original requirement retained until the gate.

#### 0B. Existing code leverage

| Sub-problem | Existing code | Reuse |
|---|---|---|
| Cross-process budget lock | `withLock` in `budget-ledger.ts` | Reuse unchanged (lock file, stale-lock takeover) |
| Totals, run status, receipts | `ledgerTotals`, `ledgerStatus`, `BudgetRun.summary`, `receiptCost` | Keep signatures; feed them from the fold |
| Many tiny requests | `BudgetAllowance` | Unchanged; still settles through `BudgetRun.settle` |
| gbrain cost attribution | `MeteringProxy` meters | Unchanged |
| Cost analysis | `eval/runner/cat40/analyze.ts` | Extend with a cost-component split (accepted expansion E2) |
| Remote vs local caller | `OperationContext.remote` | C1 keys on it |
| Result envelope | `dispatchToolCall` `content[0]` + D8 extra blocks | C1/C2 change only `content[0]`'s row shape and whitespace |
| Schema ceiling | `buildToolDefs`, `filterOpsForSurface('starter')` | C3's ceiling test measures these |
| Progressive disclosure | `request_tools` meta-op on starter | Lever for Taste decision T1 |

No rebuilds. The journal replaces `readLedger`/`writeLedger` internals only.

#### 0C. Dream state

```
  CURRENT STATE                      THIS PLAN                              12-MONTH IDEAL
  Ledger rewrites 50 MB per   --->   Append-only journal, O(new bytes)  --> Harness overhead is invisible and
  request; latency unusable          per op; lag recorded in receipts       measured in every receipt
  gbrain $0.130/task vs fs           Lean rows, compact JSON, schema        gbrain is the cheapest memory per
  $0.032; cost regressions           diet; size ceilings pinned by tests    correct answer; CI fails a PR that
  ship silently (77dcf414 +19%)      for schema and canonical results       grows tokens per task
```

This plan moves directly toward the ideal; the size-ceiling tests (accepted expansion E3) are the piece that keeps it there.

#### Decision ledger (CEO Step 0)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| CEO-0E mode | autoplan override | n/a | SELECTIVE EXPANSION | approved | autoplan CEO override rule "Mode selection: SELECTIVE EXPANSION" |
| CEO-0D approach, Item 1 | finding 11, ledger code | A) append-only journal (plan) | B) per-cell `BudgetAllowance` in Cat 40 only; C) fresh ledger file per phase | approved A | Auto-decided A (P1 completeness: fixes every paid runner at the root; B and C only shrink the stall). Mechanical. |
| CEO-0D approach, Item 2 | findings 1-3 | C1-C4 as drafted | same, C1+C2 measured first | approved (as drafted) | Auto-decided (P6); priority order already matches finding 1 |
| CEO-F1 cost metric | finding 4 | "$/task" undefined; target "$0.07 or less" | G2 measured on cell `total_usd` (all agent sessions plus gbrain's own provider calls, judge excluded); baseline $0.130 held-out, target ≤ $0.078 (−40%) | approved | Factual correction; keeps the user's −40% requirement. Mechanical (P5). |
| CEO-F2 C1 parameter name | finding 6 | `detail: "full"` | `fields: "full"` (default `"lean"` for remote callers) | approved | Mechanical (P5, avoids a collision with `query.detail`) |
| CEO-F3 C1 keeps `chunk_id` | finding 7 | "chunk_id ... if any" | keep `chunk_id` in lean rows (needed by `assemble_evidence`) | approved | Mechanical (P1) |
| CEO-F4 C3 mechanism | finding 5 | caps 1,200 / 200 | per-tool schema budgets sized to reach ≤ 25k on the served starter list; keep the 25k target | approved | Auto-decided (P1; never weaken the stated target). Mechanism detail goes to Eng. |
| CEO-T1 starter membership | finding 5, `ALWAYS_INCLUDED_STARTER_OPS` | membership unchanged | move rarely used skill-admin and write-request ops behind `request_tools` if budgets alone miss 25k | TASTE (gate) | Provisional auto-decision: do not change membership in this wave; budgets first. |
| CEO-F5 budget enforcement | finding 9 | none | every remaining paid run uses one ledger whose remaining program cap is $237 (fresh journal with `--program-cap-usd 237`) | approved | Mechanical (P1; the user's $2,000 cap must be enforced, not remembered) |
| CEO-F6 latency verification folded into dev round 1 | finding 10 | separate paid replay | measure harness tool latency inside dev round 1 (same runs), compare to the isolated replay | approved | Auto-decided (P4 DRY, saves about $20) |
| CEO-F7 dev in parallel | plan Order | Item 1 then Item 2 | Item 2 code and tests may start while Item 1 is in review; paid runs wait for Item 1's merge | approved | Auto-decided (P6) |
| CEO-UC1 ship rule power | finding 13 | per-change drop if paired 95% CI lower bound < −3 | apply the −3-point margin once, to the whole wave, on the held-out paired comparison; use dev rounds only as a harm screen (drop a change whose dev-round paired difference is −5 points or worse); report the power | pending (gate; User Challenge if the outside voice agrees, else Taste) | Original requirement retained until the gate |
| CEO-E1 uncapped default | finding 8 | default 20,000 | runner default is no cap; receipt records the setting | approved | Expansion in blast radius, < 1 day, 2 files (P2) |
| CEO-E2 cost-component split | finding 1 | none | `analyze.ts` reports $ by uncached input / cache write / cache read / output and result characters by tool, per arm and model | approved | Expansion in blast radius, < 1 day (P2) |
| CEO-E3 size ceilings in gbrain CI | finding 3 (77dcf414 shipped +19% cost silently) | C3 schema ceiling only | also pin the serialized size of a canonical `search` and `query` result (fixture brain) | approved | Expansion in blast radius (C1/C2 tests), < 1 day (P2) |
| CEO-E4 shared lag monitor | Why section ("every future paid category inherits the stall") | Cat 40 only | `startPaidRun` starts the lag monitor; `RunSummary` carries lag stats; Cat 40 writes them to its receipt | approved | Expansion in blast radius (budget-ledger.ts), < 1 day (P2, P4) |
| CEO-E5 journal compaction | none | none | `budget-ledger.ts compact` snapshot command | deferred | Outside need for G1 (200k events parse once at open); TODOS.md (P3) |
| CEO-E6 `gbrain-verbs` cost-floor arm | `--surface verbs` exists (7 tools, 14k chars) | none | extra gbrain arm on the 7-verb surface | deferred | Costs paid budget the plan does not have; TODOS.md (P3) |
| CEO-E7 ledger I/O on a worker thread | none | none | move ledger writes off the loop | skipped | The journal removes the need (P5) |

#### 0F/0G. Expansion framing and HOLD checks (SELECTIVE EXPANSION)

HOLD checks. (1) Complexity: Item 1 touches 3-4 files in gbrain-evals and adds no new service; Item 2 touches more than 8 files in gbrain because tool descriptions live beside each operation, but adds no new class or service. The file count comes from where descriptions live, not from extra moving parts, so no reduction is proposed. (2) Minimum change for the goals: G1 needs the journal and the lag record; G2 needs C1 and C2 (most of the dollars, finding 1) and C3 (second lever); C4 is small and bounded. Nothing is deferrable without missing a goal. (3) Invariants kept: no spend past run budget or program cap, crash safety, cross-process safety, Cat 40 tasks/scoring/baselines untouched, thin-client `content[0]` contract.

10x check: the 10x version is not a cheaper gbrain once; it is a gbrain whose token cost per task cannot regress without a failing test, measured by an eval harness whose own overhead is recorded in every receipt. E3 and E4 are the two cheap pieces of that.

Delight scan (each 30 minutes or less): E1 uncapped default, E2 cost-component split, E3 size ceilings, E4 lag monitor for every paid runner, `budget-ledger.ts status` printing journal events and bytes (folded into Item 1's status output), and a CHANGELOG line that tells agents how to get full rows back. Platform potential: the journal and lag monitor serve every paid category, not just Cat 40.

Cherry-pick ceremony (auto-decided, P2/P3): accepted E1, E2, E3, E4; deferred E5, E6 to TODOS.md; skipped E7. Taste: T1. See the ledger above.

#### 0I. Temporal interrogation

```
  HOUR 1 (foundations):   Journal event schema and fold; how status/receipts read it; served-tools/list
                          measurement for C3; which remote callers (thin client, assemble_evidence) read row fields.
  HOUR 2-3 (core logic):  Incremental read under the lock (offset bookkeeping, truncated or replaced file);
                          torn-tail handling; C1 projection placed after evidence delivery so `delivered` rows stay
                          correct; `fields` param plumbing through search and query.
  HOUR 4-5 (integration): Legacy ledger.json migration on a 50 MB file; BudgetRun.join participants in other processes;
                          thin-client renderers on lean rows; description budgets without losing tool choice.
  HOUR 6+ (polish/tests): Perf test at 200k events; lag-monitor calibration on Bun; size-ceiling fixtures; the
                          CHANGELOG note for agents; the dev-round run commands with --max-tool-chars uncapped.
```

Feasibility blockers: none blocking. Pending for Eng: exact per-tool schema budgets (CEO-F4), fsync policy for settle events, lag sampler choice. Effort: Item 1 human about 2 days / CC about 2 hours; Item 2 code human about 4 days / CC about 4 hours; paid runs about 6 hours wall clock.

#### 0H spec review loop

Launch 1 (Capy subagent, shared machine): FAIL, 5/10. 22 issues across Completeness (5), Consistency (6), Clarity (8), Feasibility (3); Scope PASS. Dispositions (all auto-decided, P1/P5 unless noted):

| # | Finding | Disposition |
|---|---|---|
| C1.1 | Program cap not persisted; `readLedger` takes the caller's cap; local ledger holds $409 of $1,763 | Fixed: `ledger_open` records the cap, mismatch refuses, fresh `.budget/cat40-followups.jsonl` at $237 |
| C1.2 | Migration mapping and post-migration size | Fixed: `legacy_entry` events, open reservations stay committed and settleable; perf target 250k events |
| C1.3 | No failure path for the latency check | Fixed: stop paid runs, fix, rerun dev round 1 |
| C1.4 | Wrapper fields not covered by C1 | Corrected: they live in `_meta.retrieval`, which Cat 40's client never shows the model (it joins text blocks only, `gbrain-arm.ts` `call`); lean applies to `content[0]` rows; `delivered` rule set |
| C1.5 | Held-out baseline ran under the stall | Disclosure accepted. A cheap `77dcf414` re-baseline under the new ledger is Taste T2 |
| C2.1 | Per-change vs pairs | Fixed: two measured steps; ship rule per UC1 |
| C2.2 | Instructions "once per session" vs every turn | Fixed: guidance moves to `get_skill`; ceiling counts tools + instructions |
| C2.3 | 57k vs 61k | Fixed: one denominator, served list recorded at start |
| C2.4 | G1 units | Fixed: per operation on a 250k-event journal |
| C2.5 | Lag defined twice; not in every receipt | Fixed: `receiptCost` carries lag |
| C2.6 | Latency comparator mislabelled | Fixed: fresh isolated replay against the dev-round build; `238e12d8` as context |
| C3.1 | "Tests pass unchanged" impossible | Fixed: assertions unchanged, read helper moves to the fold |
| C3.2-3.8 | E1 null, E3 ceiling form, thin client, PR for E1/E2/E4, C4 targets, stats tool, T1 trigger | Fixed as listed in the accepted block |
| F5.1 | Budget does not protect the gate run | Fixed: held-out before the ladder; per-step budgets at today's rates |
| F5.2 | Ship rule underpowered | Independent agreement with CEO-UC1; stays pending for the gate |
| F5.3 | Lock wait blocks the loop under contention | Fixed: one runner per journal stated as the assumption |

Ledger additions: CEO-T2 (TASTE, gate): rerun `77dcf414` on a held-out subset (Haiku 4.5 + GPT-5.4-mini, 2 repeats, about $11) under the new ledger to size the stall's effect on the baseline. Provisional auto-decision: include if the budget after dev rounds still covers held-out plus $11; otherwise disclose only.

Launch 2: FAIL, 6/10 (25 new issues; none of launch 1's repeated). All fixed by auto-decision: journal event list and cap rules; both-files refusal; fold fields and torn-tail offset; E2 buckets sum to `total_usd`; exact run commands; dev-round decision rule; T2 slot; contingency budget; C4 single-item edge case; named leak counters; one C3 statement; T1 as a conditional pre-approval; comparator from dev round 1's own calls; E4 lifecycle; thin client sends `fields` only when declared (reject-mode hosts); E3 stubbed embeddings. Launch 2 also flagged that C2's own evidence (lower bound −3.7) fails the per-change ship rule; carried to CEO-UC1.

Launch 3 (final; the loop's three-launch cap): FAIL, 6/10 (21 issues; 2 partly repeated: C3 statement and replay wording). Fixed by auto-decision but not re-reviewed: sparse safety and provenance fields kept in lean rows; old thin clients accepted and documented; the cap a journal records is the explicit value or $500; one machine and one journal, replay under the ledger; gate-failure actions; run flags matched to each baseline's argv with fixed `--out` and labels; base commit `566a242a` disclosed; `n2-3-prompt-ab.ts` receipt lag; caps are hard upper limits; ceiling pins achieved size if T1 is not approved. Carried as a reviewer concern: C3's 25k target likely needs CEO-T1 (about 11k characters left for all descriptions on 33 tools). The 2x latency check now replays at per-slot concurrency.

Spec-review metrics: iterations 3, issues found 68, reviewer-confirmed fixed 45, remaining (latest launch) 21, latest score 6/10. Document approval (0H): auto-decided A (approve these documents and continue to 0I) under autoplan; both documents reflect the decisions above.

#### CEO accepted requirements and baseline edits

Baseline edits (factual corrections CEO-F1..F7, applied by `amend-input`):

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"e3a98d5f865090ec290ccd12aad2390c3e830f9d6e8f015601d2be01c4267ea1","replacements":[{"oldText":"Cut gbrain's per-task model cost on Cat 40 by at least 40% (to $0.07 or less on the held-out world),","newText":"Cut gbrain's per-task cost on Cat 40 by at least 40%: on the held-out world the cell total (`total_usd`: every agent session plus gbrain's own provider calls, judge excluded) drops from $0.130 to $0.078 or less,"},{"oldText":"Held-out world, shipped build `77dcf414`:","newText":"Held-out world, shipped build `77dcf414`. Here $/task is the session-2 agent cost; the cell total, which adds family F's first session and gbrain's own provider calls, is $0.130 fixed, $0.098 release, $0.032 fs and $0.021 pg:"},{"oldText":"Two things drive it, measured on the `--surface starter` server (33 tools):","newText":"Two things drive it, measured on the `--surface starter` server (33 tools). Results are the larger: on Anthropic models about 80% of a gbrain task's cost is cache writes, roughly 15k tokens of tool list and 34k tokens of tool results per task; on OpenAI models it is uncached input, mostly each turn's new tool results."},{"oldText":"`type`, `chunk_text`, `score`, `effective_date`, `source_id`, and `stale` only when true. A new `detail: \"full\"`\n  parameter returns today's rows.","newText":"`type`, `chunk_text`, `score`, `effective_date`, `source_id`, `chunk_id`, `stale` only when true, and\n  `delivered.truncated` only when a non-chunk return unit was requested. A new\n  `fields: \"full\"` parameter returns today's rows (`detail` is taken: `query.detail` already means low/medium/high)."},{"oldText":"(`chunk_id` is used by `get_chunk`-style follow-ups, if\n  any)","newText":"(`chunk_id` stays because `assemble_evidence` takes\n  `{source_id, slug, chunk_id}` from search and query rows)"},{"oldText":"It was reverted to pretty JSON in `77dcf414` to keep tests stable, not for agents.","newText":"It was reverted to pretty JSON in `77dcf414` to keep tests stable, not for agents. The held-out run already measured\n  it: `51a30c1` (compact) against `77dcf414` (pretty) is −16% cost per task, success −1.0 points (CI −3.7 to +1.8)."},{"oldText":"Cap every starter-surface tool description at 1,200 characters and every parameter\n  description at 200.","newText":"Give every starter-surface tool a schema budget (its description plus its parameter descriptions)\n  sized so the served starter list reaches the target. Caps of 1,200 characters per description and 200 per parameter\n  description stay as hard upper limits, but alone they save only about 8k of 61k characters (measured 2026-10-03)."},{"oldText":"- Rerun the latency replay with the Cat 40 runner (gbrain arm, 3 models, scripted fallbacks off) and confirm tool\n  p50 is within 2x of the isolated replay.","newText":"- Confirm in dev round 1 (Item 2's first paid run: gbrain arm, 3 models) that harness tool p50 is within 2x of an\n  isolated replay of calls from that round, replayed at the harness's per-slot concurrency under its own small\n  ledger budget."},{"oldText":"Total about $185. This needs Item 1 first so latency is measured honestly in the same runs.","newText":"Total about $218 at today's rates if the ladder runs in full, less once the cuts land; the ladder takes what\nremains of $237. This needs Item 1 first so latency is measured honestly in the same runs. Every paid run uses one\nledger journal opened with `--program-cap-usd 237` (the remaining authorization) and runs uncapped\n(`--max-tool-chars 100000000` until the runner's default is uncapped)."},{"oldText":"1. Item 1 in gbrain-evals: PR, CI, merge by Garry.","newText":"1. Item 1 in gbrain-evals: PR, CI, merge by Garry. Item 2's code and tests may be written meanwhile; its paid runs\n   wait for this merge."},{"oldText":"the\n  `detail: \"full\"` escape hatch","newText":"the\n  `fields: \"full\"` escape hatch"},{"oldText":"One gbrain PR (fix-wave convention). Each change is measured on its own on the dev world before it joins the stack.","newText":"One gbrain PR (fix-wave convention). Changes are measured in two steps on the dev world (C1+C2, then C3+C4 on top)\nbefore the held-out run."},{"oldText":"Move long guidance into `get_skill` content or the server instructions, which are sent once\n  per session.","newText":"Long guidance is cut from the schemas. It moves into a bundled skill only where `get_skill` is\n  served (it is gated by `mcp.publish_skills`, which Cat 40 does not enable); moving it into the server instructions\n  saves nothing, so the instructions get their own ceiling at their current size."},{"oldText":"A reserve or settle costs under 5 ms at 200k entries.","newText":"A reserve or a settle costs under 5 ms on average on a 250k-event journal (headroom: today's\n  111k-entry ledger migrates to about 111k events)."},{"oldText":"a perf test where 1,000 reserve+settle pairs on a 200k-event journal average under 5 ms","newText":"a perf test where 1,000 reserve+settle pairs on a 250k-event journal average under 5 ms per operation"},{"oldText":"- **Event-loop lag.** The Cat 40 runner records event-loop lag (p50, p99 and max) into its receipt, so a future\n  timing artifact shows up in the receipt instead of in a report.","newText":"- **Event-loop lag.** `startPaidRun` records event-loop lag (p50, p99 and max) for every paid runner, and\n  `receiptCost` writes it into each receipt's cost block, so a future timing artifact shows up in the receipt instead\n  of in a report."},{"oldText":"- Existing `test/eval/budget-ledger.test.ts` and `all-and-budget.test.ts` pass unchanged.","newText":"- Existing `test/eval/budget-ledger.test.ts` and `all-and-budget.test.ts` pass with their assertions unchanged; only\n  their file-reading helper moves from parsing `ledger.json` to the fold."},{"oldText":"2. Final: the 11-model dev ladder on the gbrain arm only, 1 repeat, about $70. The comparison is against the\n   `51a30c1` ladder.\n3. Held-out confirmation: seed 20261003, 6 models × 2 repeats, gbrain arm only, about $75. The paired comparison is\n   against the `77dcf414` held-out run.","newText":"2. Held-out confirmation (the G2 gate, run before the ladder so an overrun cannot starve it): seed 20261003,\n   6 models × 2 repeats, gbrain arm only, about $80 at today's rates. The paired comparison is against the `77dcf414`\n   held-out run.\n3. Final: the 11-model dev ladder on the gbrain arm only, 1 repeat, budgeted with what is left (about $106 at today's\n   rates, less after the cuts). The comparison is against the `51a30c1` ladder."},{"oldText":"C1–C4 with tests, dev rounds, the final ladder and the held-out run.","newText":"C1–C4 with tests, dev rounds, the held-out run, then the final ladder."},{"oldText":"Replace the rewrite-the-world JSON file with `.budget/ledger.jsonl`, one event per line:\n  `run_open`, `reserve`, `settle` or `run_close`.","newText":"Replace the rewrite-the-world JSON file with `.budget/ledger.jsonl`, one event per line:\n  `ledger_open` (program cap), `set_cap`, `run_open`, `run_close`, `reserve`, `settle`, and `legacy_entry` (migration\n  only)."},{"oldText":"1 repeat, about $20 per round.","newText":"1 repeat, about $16 per round."},{"oldText":"If success drops, restore the specific\n  guidance into the server instructions.","newText":"If success drops, raise that tool's schema\n  budget, or re-measure and re-pin the ceiling with a recorded reason."}]} -->

<!-- autoplan-accepted:ceo -->
- G2's cost metric is the Cat 40 cell `total_usd` (all agent sessions plus gbrain's own provider calls through the metering proxy, judge excluded). Baseline: $0.130 per task, held-out world, `77dcf414`. Target: $0.078 or less (−40%). The report states the metric by name next to every cost number. Verify: `analyze.ts` prints it per arm and model.
- C1 lean rows keep `chunk_id` (required by `assemble_evidence`). The escape-hatch parameter is named `fields` (`"lean"` default for remote callers, `"full"` returns today's rows); it must not reuse `detail`. Verify: a test that a lean `search` row passed to `assemble_evidence` resolves, and a schema test that `query.detail` still means low/medium/high.
- C3 mechanism: a per-tool schema budget (description plus parameter descriptions); the 1,200 / 200 caps stay as hard upper limits, but they are not the mechanism. Starter membership does not change in this wave unless Taste decision CEO-T1 is approved. Verify: a ceiling test on the served list.
- E1: the Cat 40 runner's default is no per-tool-result cap (`--max-tool-chars` defaults to unlimited); the receipt keeps recording `max_tool_chars`. Verify: a runner test that a 100k-character tool result reaches the model unmodified by default, and the existing explicit-cap test still truncates.
- E2: `eval/runner/cat40/analyze.ts` reports, per arm and per model, dollars split into uncached input, cache write, cache read and output, plus tool-result characters per task by tool name. Verify: a fixture-based test of the split on two hand-built cells (one Anthropic, one OpenAI).
- E3: gbrain CI pins the serialized size of a canonical `search` and `query` result for remote callers on a fixture brain, beside C3's schema ceiling, so a change like `77dcf414` (+24% result characters) fails a test. Verify: the tests fail when pretty-printing is reintroduced.
- E4: `startPaidRun` starts an event-loop lag monitor; `RunSummary` carries its p50, p99 and max in milliseconds and `receiptCost` writes them into every receipt's cost block (Cat 40 included). A calibration test proves a deliberate 100 ms synchronous block registers at least 80 ms max on Bun. Verify: that test plus the Cat 40 receipt field.
- Budget enforcement: every remaining paid run in this plan goes through one ledger journal whose program cap equals the remaining authorization (`--program-cap-usd 237` on the fresh journal `.budget/cat40-followups.jsonl`), so the $2,000 program limit is enforced by the ledger. Each run passes `--budget-usd` for its own step. Verify: `budget-ledger.ts status --budget-ledger .budget/cat40-followups.jsonl` before each run shows the recorded $237 cap and the remaining dollars.
- Item 1's latency check runs inside dev round 1 (gbrain arm, 3 models): harness `search` and `query` p50 within 2x of the isolated replay comparator defined below, and the receipt's lag p99 under 50 ms. No separate paid agent run; the replay costs under $1 of embeddings.
- Item 2 code and tests may start while Item 1 is in review; Item 2's paid runs start only after Item 1 merges.
- Program cap persistence: the journal's first event records the program cap (`ledger_open` with `program_cap_usd`). A reserve refuses when an explicitly passed program cap disagrees with the recorded cap (see the event rules below); changing it takes an explicit `budget-ledger.ts set-cap` event. The remaining paid runs of this plan use a fresh journal `.budget/cat40-followups.jsonl` created with a cap of $237. Verify: tests for cap mismatch refusal and `status` reporting the recorded cap.
- Migration mapping: each legacy run becomes one `run_open` event (plus `run_close` when finished), and each legacy entry becomes one `legacy_entry` event carrying `id`, `run_id`, `description`, `reserved_usd`, `actual_usd`, `status`, token counts, timestamps and `participant`. Open legacy reservations stay committed at their reserved amount and can still be settled by id. `--budget-ledger` / `BRAINBENCH_BUDGET_LEDGER` paths ending in `.json` map to the sibling `.jsonl` journal; a legacy file at the given path migrates once under the lock and is renamed `.json.migrated`. Verify: migration test on a fixture with open reservations, a joined participant and an unfinished run; totals before and after match to the cent.
- Latency check failure path: if dev round 1 shows harness `search`/`query` p50 above 2x the comparator or receipt lag p99 of 50 ms or more, no further paid run starts until the cause is fixed and dev round 1 is rerun. The comparator is defined under Contingency below; the report's `238e12d8` dev-world replay (341 ms / 1,551 ms) stays as context.
- The 2x latency target assumes one runner process per journal; the lock wait stays synchronous because the journal holds the lock for one append. The report states the assumption.
- C1 scope: lean projection applies to the rows in `content[0]` for remote callers. `_meta.retrieval` (structured, not shown to the model by Cat 40's client) is unchanged. Per-row `delivered` is dropped in lean rows except `delivered.truncated` when a non-chunk return unit was requested. gbrain's own thin client keeps full rows (see the thin-client rule below). Verify: a thin-client routed `gbrain search` test against a lean-default host shows full rows.
- C3 baseline figures for context: draft 33 tools / 57k plus 4k instructions; `buildToolDefs` on all 38 starter ops gives 61,328 (4 of them gated by `mcp.publish_skills`). The ceiling test pins served schemas at 25k or less and instructions at their recorded size or less, so moving text into the instructions does not count as a saving.
- C4 targets: the model-visible notice blocks built by `retrievalNoticeBlocks` in `src/mcp/dispatch.ts`. Saved facts: whole facts newest first up to 1,500 characters, then a `(+N more; recall returns them)` marker. Other-names notice: whole alias pairs up to 400 characters, then `(+N more)`. Verify: unit tests at the boundary.
- E1 records uncapped as `max_tool_chars: null` in the receipt. E3 ceilings are measured size plus 5% on a deterministic fixture brain (no embedding key in CI). E1, E2 and E4 ship in the Item 1 gbrain-evals PR.
- G2 statistics: `docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py` method: per task, averaged over models and repeats, bootstrap over the 50 tasks, exact sign test. The report discloses that the `77dcf414` baseline ran under the ledger stall (89 `write_pending` results), which biases the comparison toward the new build.
- Paid-run order and budgets at today's rates: dev round 1 (C1+C2) about $16, dev round 2 (+C3+C4) about $16, T2 re-baseline about $11 if approved, held-out about $80, then the 11-model ladder with whatever remains. Each step passes its own `--budget-usd`.
- CEO-T1 is decided by Garry at the final gate as a conditional pre-approval: if per-tool budgets cannot bring the served starter schemas to 25k, the implementer may move the skill-admin and write-request ops behind `request_tools`; without that approval the implementer reports the achieved size instead. Arithmetic for the decision (spec review round 3): of 61,289 characters on 38 ops, 15,258 is schema structure, so on about 33 served tools only about 11k is left for all descriptions, about 330 characters per tool, against 46k today.
- Journal events and fields: `ledger_open {program_cap_usd, created_at}`; `set_cap {program_cap_usd, at}`; `run_open {run_id, runner, budget_usd, estimate_usd, started_at}`; `run_close {run_id, finished_at}`; `reserve {id, run_id, description, reserved_usd, created_at, participant?}`; `settle {id, run_id, actual_usd, status, input_tokens, output_tokens, settled_at}`; `legacy_entry {every LedgerEntry field}`. Migration and fresh journals write `ledger_open` with the explicitly passed cap, or $500 (`DEFAULT_PROGRAM_CAP_USD`) when none is passed; the legacy file's `program_cap_usd` is ignored because it only records the last writer's flag. Raising the cap takes `set-cap`. When `--program-cap-usd` and `BRAINBENCH_PROGRAM_CAP_USD` are both absent, a caller adopts the recorded cap; only an explicit value that disagrees is refused. Verify: tests for adopt-on-omit and refuse-on-explicit-mismatch.
- If a legacy `.json` file and its `.jsonl` journal both exist and the legacy file is not renamed `.migrated`, the ledger refuses to spend and names both paths. The existing unreadable-ledger test writes its corrupt line into the journal instead of `ledger.json`; that setup change is the one exception to "assertions unchanged". Verify: a both-files-present refusal test.
- The fold holds, per run and per participant: reserved, committed and actual dollars, request count, `charged_reservations`, input and output tokens; program committed dollars; the open-reservation map (id to entry) and the set of settled ids, so `settle` still reports "unknown" versus "already settled". The read offset advances only to the last complete newline, so lock-free readers (`status`, `summary`) never consume a torn tail.
- E2 buckets sum to `total_usd` per cell: scored-session and session-1 dollars split into uncached input, cache write, cache read and output (both sessions carry usage in the cell), plus a "gbrain provider calls" bucket from `gbrain_internal.usd`. The fixture test asserts the sum to the cent.
- Exact paid-run commands. All runs happen on one machine, share `--max-tool-chars 100000000 --arms gbrain --surface starter --gbrain-repo ../gbrain --budget-ledger .budget/cat40-followups.jsonl --program-cap-usd 237 --transcripts`, set a fixed `--out eval/reports/cat40/followups-<label>` so a timed-out run resumes, and record the journal path in the receipt. Dev rounds and the ladder match the `51a30c1` fix-wave ladder's argv (operator ANALYZE on, `--slot-ref ad7900d --slots 5 --concurrency 6`): dev round 1 `--models gpt-5.4-mini,gpt-5.4,claude-sonnet-4-6 --gbrain-ref <C1+C2 commit> --gbrain-label gbrain-c12 --budget-usd 18`; dev round 2 the same with `--gbrain-ref <C1-C4 commit> --gbrain-label gbrain-c1234 --budget-usd 18`; ladder `--models claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5,claude-sonnet-5-5,claude-opus-5-5,gpt-5.4-mini,gpt-5.4,gpt-5.5,gpt-6-sol,gpt-6.1-sol,gpt-6-astra --gbrain-ref <final commit> --gbrain-label gbrain-c1234-ladder --budget-usd <remaining>`. Held-out and T2 match the `77dcf414` held-out receipt's argv (`--world <seed-20261003 world.json> --repeat 2 --no-pglite-analyze --slots 5 --concurrency 10`): held-out `--models claude-haiku-4-5,claude-sonnet-4-6,claude-sonnet-5-5,gpt-5.4-mini,gpt-5.4,gpt-6.1-sol --gbrain-ref <final commit> --gbrain-label gbrain-next2 --budget-usd 85`; T2 `--models claude-haiku-4-5,gpt-5.4-mini --gbrain-ref 77dcf414 --gbrain-label gbrain-next-rebase --budget-usd 12`. `holdout_stats.py` gains the pairs `gbrain-next2` vs `gbrain-next` and `gbrain-next-rebase` vs `gbrain-next` (same two models).
- Dev-round decision rule: each round is compared with the same three models' cells from the `51a30c1` fix-wave ladder on the dev world. Go to the next step unless the round's paired success difference is −5 points or worse or its `total_usd` per task did not fall; the original ship rule still applies at held-out unless the gate changes it.
- CEO-T2 (Taste, provisional include): after the dev rounds and before held-out, rerun `77dcf414` on the held-out world for Haiku 4.5 and GPT-5.4-mini, 2 repeats, about $11, under the new ledger. The report compares that subset with the same subset of the original `77dcf414` run to size the stall's effect, and states it next to the G2 comparison; the G2 comparison itself stays against the full original run.
- Contingency: a failed latency check costs one more dev round 1 (about $16) plus the isolated replay's embedding calls (under $1); a G1 miss produces a follow-up gbrain-evals PR before any further paid run. The latency comparator replays 40 `search`/`query` calls sampled from dev round 1's own transcripts against the same build and world, at the harness's per-slot concurrency (2 agents per slot), under `startPaidRun` with `--budget-usd 1` on the same journal.
- Gate failures. A dev round that fails its harm screen: drop the change most likely to have caused it (C3 before C4 in round 2; C1 before C2 in round 1), rerun that round once (about $16), and stop for Garry if it fails again. A held-out run that holds success but misses the 40% cost target: the wave still ships on by default (it saves cost without losing success) and the report says the target was missed. A held-out success failure under the ship rule: nothing ships default-on; stop and report to Garry with the per-model and per-family breakdown.
- Base commit: Item 2 builds on gbrain master `566a242a` (v0.60.35.0), which differs from `77dcf414` by an alias-matching change in `src/core/ops/search.ts`. The report discloses that the G2 comparison includes it.
- E4 also adds `receiptCost` (or its lag fields) to `eval/runner/n2-3-prompt-ab.ts`, the one paid runner that calls `startPaidRun` without it.
- If the 25k schema target is not reached and CEO-T1 is not approved, the ceiling test pins the achieved size with the reason recorded beside it. E3's pinned size covers the full model-visible text: `content[0]` plus the notice blocks C4 changes.
- C4 edge case: facts and alias pairs are never cut inside an item, so provenance stays intact. When the first fact alone exceeds 1,500 characters (or the first alias pair exceeds 400), it is shown whole and the ceiling applies from the second item on, followed by the marker. Verify: boundary tests.
- "Zero new leaks" means `output_leak`, `context_exposure` and `unsafe_write` counts in `holdout_stats.py` are not above the `77dcf414` baseline's.
- C3 target, one statement with two pinned numbers: the served starter tool schemas (Cat 40 configuration, recorded with its config at implementation start) are 25k characters or less, and the initialize instructions are no larger than their recorded size. In the Cat 40 configuration `get_skill` is not served, so long guidance is cut, not moved.
- C1 also keeps these sparse safety and provenance fields whenever they are present: `injection_suspected`, `injection_p`, `unverified`, `content_flag`, `status`, `superseded`, `superseded_by`, `modality` (when not text), `message_id`, `thread_id`, `source_subject`. Each dropped field is checked against in-repo consumers (grep of gbrain `src/`, skills and docs) as well as the Cat 40 transcripts; the field list is final unless a consumer turns up, and the PR records the check. Third-party remote clients that read dropped fields get lean rows after upgrading the host; the CHANGELOG tells them to pass `fields: "full"`. gbrain's own thin client keeps full rows (CEO-A1).
- E4 lifecycle: `startPaidRun` returns the lag monitor with the run; `BudgetRun.close()` stops it and puts the stats in that process's `RunSummary`. A joined participant reports its own process's lag in its own summary (in memory, not in the ledger).
- Thin client (CEO-A1): the host serves full rows by default to sessions whose MCP `clientInfo.name` is `gbrain-remote-cli` (gbrain's own thin client, `src/core/mcp-client.ts`), so old and new CLIs keep `--explain` and renderers without sending `fields`; the thin client never sends `fields`, so hosts with `mcp.strict_params=reject` are unaffected. Every other remote session gets lean rows unless it passes `fields: "full"`. Verify: a test per client identity, and a reject-mode test.
- E3's fixture uses stubbed deterministic embeddings (or proves the keyword fallback first), so CI needs no key.
- Migration crash safety: migration writes the converted events to a temporary journal, fsyncs and renames it to the `.jsonl` path, and only then renames the legacy file to `.json.migrated`; a crash before the journal rename leaves the legacy file as the only ledger and the next open retries. Verify: a test that kills migration between the two renames.
- Report additions (CEO-A2, A3): the Cat 40 cost-wave report shows, beside the pooled G2 comparison, the paired difference per model and per task family, and flags any model or family at −8 points or worse; `analyze.ts` prints cost per successful task (`total_usd / success`) per arm and model. Cat 40 scoring is unchanged.
- Partial ladder rule (CEO-A4): if the 11-model ladder cannot run in full within the remaining budget, run complete models (all 50 tasks each) in the listed order until the budget is spent, and label the ladder partial with the models it covers.
- Receipts record the journal path and its recorded program cap. The ledger header comment and `status` output carry two runbook lines: "both files present" (check totals, keep the journal, rename the stale legacy file) and "cap mismatch" (`set-cap` only with Garry's authorization). The `budget-ledger.ts` header comment is rewritten for the journal; gbrain `docs/architecture/thin-client.md` gains one line on CEO-A1.
- C1's projection lives in the shared search/query output path in `src/core/ops/search.ts` (after evidence delivery), not in `dispatch.ts`; the fold is the single source for `ledgerTotals`, `ledgerStatus`, `summary` and `close`.
- Deferred to TODOS.md: E5 (journal compaction command) and E6 (`gbrain-verbs` cost-floor arm on the 7-verb surface).
<!-- /autoplan-accepted:ceo -->

#### Step 0.5: CEO dual voices

Fresh voice snapshot: `autoplan-ceo-tmkxTJ/ceo-implementation.md`, SHA-256 `fde630c9…f589b` (Implementation plan only).

**Native CEO reviewer** (Capy subagent on the shared machine, nativeDispatchPrompt sent verbatim; result starts `INPUT: ceo fde630c9154b0930f562f6ffcc4b927641c6e690a3aafa173687e5cf3c4f589b`, matching the snapshot). Completed, 9 findings:
1. CRITICAL: the G2 gate (95% CI lower bound ≥ −3) fails a zero-effect change about 40-45% of the time; C2's own evidence (−3.7) would fail it. Re-specify with a power check: widen to −5, buy precision with more held-out repeats, or pool.
2. HIGH: Item 1 hand-rolls a transactional store; `bun:sqlite` in WAL mode with `BEGIN IMMEDIATE` was never considered.
3. HIGH: the 11-model ladder (about $106) gates nothing; move the money to held-out precision; contingencies exceed headroom.
4. HIGH: −40% still leaves gbrain at 2.4x files; measure the 7-verb surface (E6) and a dedup/top-k variant in a dev round.
5. MEDIUM-HIGH: C3 tunes public descriptions to one benchmark; keep long guidance reachable on demand; decide T1 now.
6. MEDIUM-HIGH: lean rows break installed thin clients; negotiate (client info at initialize) instead.
7. MEDIUM: make T2 mandatory and attribute savings between the ledger fix and C1-C4.
8. MEDIUM: the per-change ship rule and the bundle-level held-out gate disagree.
9. MEDIUM: report cost per successful task as a headline metric; set a parity target next wave.

**Codex CEO voice** (`codex exec`, `gpt-6-astra`, reasoning high, read-only; exit 0, `OUTSIDE_STATUS: completed provider=codex host=claude`). Full output:

```tool-output
CODEX SAYS (CEO, strategy challenge, outside voice):
1. The release gate can approve a regression hidden by the harness fix. The candidate gets the repaired ledger and an
   additional alias change; its control gets neither. Improvements from those changes can offset damage from C1-C4.
   T2 only measures two models on 77dcf414, so it cannot establish noninferiority against the actual starting build
   across six models. Preserve the historical baseline, but fund a contemporaneous control on the actual base commit
   under the repaired harness. Reduce the final ladder to pay for it.
2. The 40% target measures improvement over yourself, not competitiveness. At $0.078, gbrain still costs roughly 2.4x
   files and 3.7x Postgres per task. The held-out results show GPT-6.1 Sol with files at 100% success for $0.0223/task.
   Define the intended advantage (cheaper successful work, cheaper models reaching stronger-model quality, or
   enforceable permissions) and evaluate the corresponding model-plus-stack combinations.
3. "Success preserved" is too broad for the pooled gate. Averaging models before bootstrapping tasks lets one model's
   gain hide another's loss (previous builds: pooled 1 point apart, Haiku 6 and Sonnet 4.6 8). Predeclare how material
   model/family regressions affect shipping; assess the gate's precision with existing repeats before spending.
4. The plan assumes the current tool catalog deserves preservation. It compresses 33 tools toward an arbitrary ceiling
   while deferring the seven-verb alternative; the product's fallback default is `full`, so `starter` results do not
   establish the default experience. CEO-T1's discovery fallback is unvalidated: Cat 40 reads tools/list once and
   freezes the tool list per session.
5. C1 spends compatibility capital for benchmark economics. An escape hatch does nothing for installed clients that do
   not know to request it. Negotiate the response shape or keep legacy behavior for existing clients.
6. C4 cuts mechanisms that created the advantage without a separate estimate of their cost; a "+N more" marker does
   not prove agents recover omitted evidence. Require evidence of meaningful savings, or remove C4 from this wave.
7. Money goes to breadth before decision quality. A partial "whatever remains" ladder is biased: the runner schedules
   tasks before models and the generator groups tasks by family, so exhaustion drops later families. Fund complete
   comparisons; label an incomplete ladder. The fallback that ships any cost cut makes the 40% target aspirational.
8. The custom journal is treated as inevitable. Compare it with the existing allowance mechanism and with isolating
   ledger work from the metering event loop before committing to a new storage protocol.
Recommendation: Revise before implementation because the current gate cannot isolate quality regressions, and the
spending plan does not establish a competitive reason to choose gbrain.
```

(Codex output reproduced in full; wrapped for width and link targets removed, wording unchanged.)

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                             Claude (native)          Codex                     Consensus
  1. Premises valid?                    partly (gate, stall)     partly (gate, baseline)   CONFIRMED concern
  2. Right problem to solve?            yes; target -> parity    yes; target not compet.   CONFIRMED (problem right, target framing weak)
  3. Scope calibration correct?         no (ladder, journal)     no (ladder, C4, journal)  CONFIRMED concern
  4. Alternatives sufficiently explored? no (SQLite, verbs, top-k) no (allowance, verbs)   CONFIRMED concern
  5. Competitive/market risks covered?  no (2.4x line)           no (model+stack choice)   CONFIRMED concern
  6. 6-month trajectory sound?          concerns (journal, compat) concerns (compat, C4)   CONFIRMED concern
CONFIRMED = completed native + completed Codex. 6/6 confirmed; 0 disagreements on direction, differences in remedy.
```

Classification of voice findings (auto-decided per autoplan rules):

| ID | Finding (voices) | Classification | Disposition |
|---|---|---|---|
| CEO-UC1 | Ship rule / G2 gate underpowered; per-change rule unmeasurable (both; spec review too) | USER CHALLENGE | Gate. Original rule stays in the plan until Garry decides. |
| CEO-UC2 | Replace most of the 11-model ladder with a contemporaneous held-out control on the real base commit under the repaired ledger (Codex 1, 7; native 3, 7) | USER CHALLENGE | Gate. Plan keeps the ladder; T2 stays as drafted. |
| CEO-UC3 | Justify the journal against `bun:sqlite` WAL or the existing allowance before building (native 2; Codex 8) | USER CHALLENGE | Gate. Plan keeps the journal. |
| CEO-UC4 | Lean rows only for clients that negotiate them; keep legacy rows for existing clients (native 6; Codex 5) | USER CHALLENGE | Gate. Plan keeps lean-by-default for remote callers, with the gbrain-CLI exception below (auto-accepted, it reduces breakage without changing the direction). |
| CEO-T4 | Pull the 7-verb surface measurement (E6) into dev round 2 (both) | TASTE (outside disagreement with my deferral) | Provisional: stays deferred unless UC2 frees money; then include as a dev-round measurement (about $16). |
| CEO-T3 | Drop C4 unless its savings are shown (Codex 6 only) | TASTE | Provisional: keep C4 (user direction); E2 splits notice-block characters so round 2 shows its size; boundary truncation of a single oversized fact replaced by whole-fact or marker-only. |
| CEO-A1 | gbrain's own thin client (`clientInfo.name = gbrain-remote-cli`, `src/core/mcp-client.ts:303`) always gets full rows, so old and new CLIs keep `--explain` and renderers without sending `fields` | Auto-accepted (P1, P5) | Replaces the "fetch tools/list and send `fields`" thin-client rule |
| CEO-A2 | Per-model and per-family regression reporting beside the pooled gate (Codex 3) | Auto-accepted (P1; reporting only, no change to Cat 40 scoring) | Report flags any model or family whose paired difference is −8 points or worse |
| CEO-A3 | Cost per successful task as a reported metric (native 9; Codex 2) | Auto-accepted (P1, in E2's blast radius) | `analyze.ts` prints `total_usd / success` per arm and model |
| CEO-A4 | A budget-truncated ladder is biased by task order (Codex 7) | Auto-accepted (P1) | If the ladder cannot run in full, run complete models (all 50 tasks each) in a fixed order and label it partial |
| CEO-A5 | T1's discovery fallback cannot be validated in Cat 40 (tool list frozen per session) and `starter` is not the default surface (Codex 4) | Auto-accepted as facts | Recorded in T1's gate text; C3 results are claimed for `starter` only |
| CEO-A6 | Define the intended competitive advantage (Codex 2) and a parity target (native 4, 9) | Deferred | TODOS.md: next wave targets cost per successful task at or below files on at least half the models |

#### CEO review sections (SELECTIVE EXPANSION, implementation-ready depth)

**Current scope (Section 1 preamble).** Mode SELECTIVE EXPANSION (autoplan override). Accepted: Item 1 journal, C1-C4, E1-E4, corrections CEO-F1..F7, spec-review fixes, A1-A4. Deferred: E5, E6, A6. Skipped: E7. Pending at the gate: UC1-UC4, T1-T4.

**Section 1: Architecture.**

```
  gbrain-evals runner process (one per machine)                       gbrain (per slot, child process)
  +--------------------------------------------------------------+    +--------------------------------+
  | cat40-model-ladder.ts                                         |    | gbrain serve --surface starter |
  |   runCell -> loop.ts runAgent --fetch--> delegatingFetch      |    |  dispatchToolCall              |
  |                         |                    |                | MCP|   op.handler (search/query)    |
  |                         |          installPaidRequestGuard    |<-->|   [C1 lean projection if       |
  |                         |            reserve() / settle()     |stdio   remote && client != CLI]   |
  |                         |                    |                |    |   [C2 JSON.stringify compact]  |
  |                         |          +---------v----------+     |    |   retrievalNoticeBlocks [C4]   |
  |                         |          | BudgetRun (fold)   |     |    |  tools/list [C3 budgets]       |
  |                         |          | lock -> read tail  |     |    +---------------+----------------+
  |                         |          | -> check caps      |     |                    | provider calls
  |                         |          | -> append + fsync  |     |    +---------------v----------------+
  |                         |          +---------+----------+     |    | MeteringProxy (same process)   |
  |   lag monitor [E4] ------------------------> RunSummary       |<---+  -> guard -> ledger            |
  +----------------------------------|---------------------------+    +--------------------------------+
                                     v
                    .budget/cat40-followups.jsonl  (ledger_open cap=237, run_open, reserve, settle, ...)
```

Before: every reserve/settle parsed and rewrote the whole JSON file on the runner's loop, which also serves the metering proxy and MCP pipes. After: each operation reads only appended bytes and writes one line. Coupling added: `RunSummary` gains lag stats (E4), `analyze.ts` gains cost buckets (E2); gbrain's dispatch gains a per-session client identity check (A1). Scaling: at 10x cells the journal grows linearly and each process folds it once at open; at 100x (millions of events) open-time fold becomes seconds, which is E5's deferred compaction trigger. Single points of failure: the journal file and its lock (same as today). Security: no new endpoint; the `fields` parameter only widens output to what the local CLI already sees, and the caller's source scope and private-page filtering still apply before projection. Rollback: Item 1 reverts by restoring `ledger.json.migrated` (renamed back) and the old module; Item 2 reverts as one PR, or per-change via `fields: "full"` behavior. Elegance: the journal makes the ledger's invariant (committed spend only grows; settle never undercounts) visible as an event log. Findings: UC3 (store choice) from the voices; nothing else beyond what the accepted block already fixes.

Data flow, reserve (four paths): happy: lock, read tail, fold, cap check passes, append, fsync, unlock. Nil: missing journal is created with `ledger_open` (cap explicit or $500). Empty: zero-byte journal is treated as missing only under the lock; a journal with no `ledger_open` first line refuses. Error: unparseable middle line or cap mismatch refuses with the path named; torn tail is ignored and truncated by the next locked writer.

State machine, reservation: `reserved -> reconciled | charged-reservation`; `legacy_entry` enters in either state. Invalid transitions: settle of a settled id (refused, "already settled"), settle of an unknown id (refused), settle from another run (refused). The settled-id set in the fold prevents them.

**Section 2: Error & Rescue Map.**

```
  METHOD/CODEPATH                 | WHAT CAN GO WRONG                         | EXCEPTION / SIGNAL
  --------------------------------|-------------------------------------------|---------------------------
  journal open / fold             | middle line unparseable                   | Error "unreadable budget ledger"
                                  | first line not ledger_open                | Error (refuse to spend)
                                  | legacy .json and .jsonl both present      | Error naming both paths
                                  | explicit cap != recorded cap              | BudgetExceededError
  BudgetRun.reserve               | run or program cap exceeded               | BudgetExceededError
                                  | lock held > 20 s                          | Error "lock held too long"
                                  | write/fsync fails (ENOSPC, EIO)           | ErrnoException
  BudgetRun.settle                | unknown / already settled id              | Error
  migration                       | 50 MB parse fails mid-way                 | SyntaxError
                                  | crash between write and rename            | partial .jsonl + legacy file
  lag monitor                     | API missing on runtime                    | TypeError at start
  gbrain C1 projection            | row lacks a kept field                    | (none; field omitted)
  gbrain A1 client check          | clientInfo absent (raw HTTP client)       | (none; lean default)
  gbrain C4 notice ceilings       | single item larger than ceiling           | (none; rule below)

  EXCEPTION / SIGNAL           | RESCUED? | RESCUE ACTION                                   | USER SEES
  -----------------------------|----------|-------------------------------------------------|------------------------------
  unreadable ledger            | N (by design) | refuse to spend; message names path and line | runner stops before any request
  both files present           | N (by design) | refuse; message says which file to keep      | runner stops, actionable
  cap mismatch                 | N (by design) | refuse; message names recorded cap, set-cap  | runner stops, actionable
  BudgetExceededError          | Y        | guard sets exhausted; runner stops scheduling   | "budget refused" in run.log
  lock timeout                 | N        | throw                                           | runner fails loudly
  ENOSPC/EIO on append         | N        | throw before the request is sent                | runner fails loudly, no spend
  migration SyntaxError        | N        | legacy file untouched; no journal written       | refuse to spend
  crash mid-migration          | Y        | migration writes to .jsonl.tmp then renames;    | next open retries migration
                               |          | legacy renamed only after the journal rename    |
  lag monitor TypeError        | Y        | receipt records lag: null with reason           | receipt says lag unavailable
```

GAP fixed by auto-decision: migration must write to a temp journal and rename, and rename the legacy file only afterwards (otherwise a crash leaves both files and the both-present refusal fires with no recovery path). Added to the accepted block.

**Section 3: Security & threat model.** New attack surface: one optional parameter (`fields`, enum `lean|full`) on `search` and `query`. Threat: a remote caller asks for full rows to see diagnostics (`cosine`, `base_score`, `create_safety`). Likelihood high, impact low: these are ranking diagnostics, not content; scope and private-page filters run before projection. A1 trusts `clientInfo.name`, which a client can spoof; spoofing only gets full rows, the same as `fields: "full"`, so it grants nothing. The ledger is local, single-user; no secrets added. Injection: C1 keeps `injection_suspected` and `injection_p` (spec review 3), so prompt-injection flags still reach agents. No new dependency (if UC3 picks SQLite, `bun:sqlite` is built in). No findings beyond those.

**Section 4: Data flow & interaction edge cases.**

```
  search request -> validate (fields enum) -> handler (scope, private filter) -> rows -> C1 project
     |                   | bad enum -> invalid_params           | empty -> [] + D8 notice block
     |                   | strict_params=reject unaffected       | rows with sparse safety fields kept
  -> C2 stringify -> content[0] ; C4 notice blocks (ceilings) -> content[1..] ; _meta unchanged
```

Async ordering (shared state: the journal). Invariant: committed program spend never exceeds the recorded cap at any instant, across processes. Schedule A: P1 locks, reads tail to offset 1000, checks, appends at 1000-1100, unlocks; P2 locks, reads 1000-1100, folds P1's reserve, checks, appends. Schedule B (reverse) is symmetric. The mechanism that prevents the violating schedule (both check against stale totals) is the lock spanning read-check-append; the fold advances only inside the lock. A reader without the lock (`status`) may see a stale total, which is allowed (it is read-only). Regression proof: the 4-process x 500-reserve test plus a test that pauses P1 between check and append (injected hook) while P2 waits on the lock. Interaction edge cases: double settle (refused), run closed while a participant still reserves (participant's reserve refused as today), runner killed mid-request (reservation stays committed at its reserved amount: overstate, never understate).

**Section 5: Code quality.** The fold must be the single source for `ledgerTotals`, `ledgerStatus`, `summary` and `close` (DRY; today each re-filters entries). `BudgetAllowance` stays unchanged. In gbrain, C1's projection belongs in one place (the shared `searchOutput` path in `src/core/ops/search.ts`, after evidence delivery), not in `dispatch.ts`, so `assemble_evidence` and future ops share it. Naming: `fields` (not `detail`). Over-engineering risk: the journal's event vocabulary (7 events) is the floor for the guarantees; UC3 asks whether SQLite removes it. Under-engineering risk: none beyond Section 2's migration gap.

**Section 6: Test review.**

```
  NEW CODEPATH                         | TEST TYPE    | HAPPY                    | FAILURE                         | EDGE
  -------------------------------------|--------------|--------------------------|---------------------------------|------------------------------
  journal reserve/settle               | unit         | totals match old ledger  | cap exceeded refuses            | settle twice; unknown id
  cross-process caps                   | integration  | 4x500 never overshoot    | lock timeout surfaces           | pause between check/append
  torn tail                            | unit         | ignored then truncated   | middle bad line refuses         | tail of exactly one byte
  migration                            | integration  | totals equal to the cent | parse error leaves legacy alone | open reservations, participant,
                                       |              |                          | crash mid-migration recovers    | unfinished run; both files present
  cap rules                            | unit         | adopt on omit            | explicit mismatch refuses       | set-cap then reserve
  perf                                 | perf (local) | 1,000 pairs on 250k < 5ms/op | n/a                        | first open fold time reported
  lag monitor (E4)                     | unit         | 100 ms block >= 80 ms    | runtime without API -> null     | joined participant summary
  uncapped default (E1)                | unit         | 100k result unmodified   | explicit cap still truncates    | receipt max_tool_chars: null
  cost buckets (E2)                    | unit         | buckets sum to total_usd | missing session1 -> zero bucket | Anthropic and OpenAI cells
  C1 lean rows                         | unit (gbrain)| kept fields only         | bad `fields` enum rejected      | sparse safety fields kept
  C1 + assemble_evidence               | integration  | lean row resolves        | n/a                             | private page stays hidden
  A1 CLI full rows                     | e2e (gbrain) | gbrain-remote-cli full   | n/a                             | other clientInfo gets lean
  C2 compact                           | unit         | no indentation           | n/a                             | E3 ceiling fails on pretty
  C3 ceilings                          | unit         | served schemas <= 25k    | instructions growth fails       | publish_skills on/off
  C4 notice ceilings                   | unit         | whole facts + marker     | n/a                             | single oversized item
```

Test ambition: the 2 a.m. test is the cross-process overshoot test with the injected pause; the hostile-QA test is a migration of the real 111k-entry ledger copy compared to the cent; the chaos test is `kill -9` of a runner mid-append followed by a second runner opening the journal. Flakiness: the perf and lag tests depend on machine speed; they run with generous margins locally and are tagged so CI can skip them on shared runners. Prompt/LLM change rule: C3 and C4 change model-visible text, so the Cat 40 dev rounds and held-out run are the required eval suites (already planned). No new findings beyond the migration-crash test (accepted).

**Section 7: Performance.** Memory: the fold holds one entry per open reservation plus per-run aggregates; settled entries need only their id in the settled set (about 40 bytes each, 4.4 MB at 111k). Open-time fold of 250k events: one sequential read and parse, estimated under 1 s; measured by the perf test and reported. Slowest new paths: (1) first open of a large journal (one-time, under 1 s), (2) migration of the 50 MB legacy file (one-time, seconds), (3) fsync per reserve (0.4-0.5 ms measured by two spec reviewers). gbrain: C1 projection is O(rows); C2 reduces bytes; no new queries. No findings.

**Section 8: Observability.** The receipt is the operator's dashboard: E4 adds lag p50/p99/max; the journal path and recorded cap go into every receipt (accepted). `budget-ledger.ts status` prints events, bytes, recorded cap, committed and remaining. Debuggability three weeks later: the journal is an audit log with timestamps per event, which the old ledger also had. gbrain: C1/C2 have no runtime signal; E3's size tests are the guard. Runbook entries needed: "ledger refuses: both files present" (rename the stale one after checking totals), "cap mismatch" (use `set-cap` only with Garry's authorization). Accepted: both runbook lines go into the ledger's header comment and `status` output.

**Section 9: Deployment & rollout.** gbrain-evals: merge Item 1 first; the first runner to open the default ledger migrates it. Risk window: two machines' copies of the old module writing a ledger the new module has migrated; the both-files refusal covers the case where an old runner recreates `ledger.json` after migration. gbrain: one PR, patch version; agents see lean rows after upgrade. Post-deploy check (first hour): dev round 1's receipt shows lag p99 under 50 ms and the cap of $237 recorded; `gbrain serve --surface starter` tools/list size equals the pinned number. Feature flag: `fields: "full"` per call is the escape hatch; no global flag (eval winners ship on by default).

**Section 10: Long-term trajectory.** Debt: E5 compaction (deferred), the journal's custom format (UC3). Reversibility: Item 1 4/5 (migration is one-way but the legacy file is kept), C1 3/5 (contract change for third-party clients), C2 5/5, C3 4/5, C4 5/5. Next phase: parity target on cost per successful task (A6), the 7-verb surface experiment (E6). Platform potential: the lag monitor and journal serve every paid runner. Retrospective on cherry-picks: E3 is the load-bearing one; it keeps the 77dcf414-style regression from recurring.

**Section 11: Design & UX.** SKIPPED (no UI scope).

#### CEO required outputs

**NOT in scope.**
- Deferred to TODOS.md (proposed entries, written at implementation; this run commits only the plan file): E5 journal compaction (`budget-ledger.ts compact`; trigger: open-time fold over 1 s); E6 `gbrain-verbs` cost-floor arm on the 7-verb surface (unless T4 pulls it in); A6 a parity goal: cost per successful task at or below files on at least half the models.
- Rejected: E7 ledger I/O on a worker thread (the journal makes it unnecessary); lowering the default `limit` (plan's own non-goal, kept).
- Out of scope by the user's rules: any change to Cat 40 tasks, scoring or baselines.

**What already exists.** `withLock` (reused), `BudgetAllowance` (unchanged; UC3 alternative), `MeteringProxy` (unchanged), `receiptCost` (extended), `analyze.ts` (extended), `holdout_stats.py` (new pairs), `latency-replay/replay.ts` (reused for the comparator), gbrain `OperationContext.remote` (C1 key), D8 notice blocks (C4 target), `request_tools` (T1 lever), `--surface verbs` (E6), `mcp.strict_params` (validation of `fields`).

**Dream state delta.** After this plan: harness overhead recorded in every receipt, gbrain about −40% cost per task, size regressions caught in CI. Still missing against the 12-month ideal: cost parity with files per successful task (gbrain about 2.4x), a default surface (`full`) that is as lean as `starter`, and an eval of real harnesses that defer-load tools.

**Failure Modes Registry.**

```
  CODEPATH                 | FAILURE MODE                         | RESCUED? | TEST? | USER SEES?            | LOGGED?
  -------------------------|--------------------------------------|----------|-------|-----------------------|--------
  journal open             | corrupt middle line                  | refuse   | Y     | clear refusal         | Y
  journal open             | both files present                   | refuse   | Y     | clear refusal         | Y
  reserve                  | cross-process race                   | lock     | Y     | none (correct totals) | Y
  reserve                  | disk full                            | throw    | N->Y  | runner stops          | Y
  migration                | crash mid-way                        | temp+rename | Y  | retry on next open    | Y
  lag monitor              | API missing                          | null     | Y     | receipt says so       | Y
  C1 lean rows             | third-party client reads dropped field | fields:"full" | N | missing field (silent to that client) | N  <- WARNING
  C3 description cuts      | agent picks the wrong tool           | dev rounds | eval | lower success        | eval
  C4 notice ceilings       | agent misses a truncated fact        | marker   | eval  | "+N more" marker      | N
  held-out gate            | false fail of a harmless wave        | UC1      | n/a   | wave not shipped      | report
```

One WARNING, no CRITICAL GAP: the third-party lean-row break is silent to that client by design. Mitigation is the CHANGELOG plus A1 for gbrain's own CLI; UC4 asks Garry whether to negotiate instead.

**Stale diagram audit.** Files this plan touches with diagrams: `budget-ledger.ts` header comment (describes the JSON file and temp-file rename; must be rewritten for the journal: accepted), `gbrain-arm.ts` header (still accurate), gbrain `docs/architecture/thin-client.md` (needs one line on A1: accepted).

**Completion Summary.**

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | results > definitions in $; C2 pre-measured;|
  |                      | C3 caps cannot reach 25k; cap not enforced  |
  | Step 0               | journal approach; 7 corrections; E1-E4 in   |
  | Section 1  (Arch)    | 1 issue (store choice -> UC3)               |
  | Section 2  (Errors)  | 13 error paths mapped, 1 GAP (fixed)        |
  | Section 3  (Security)| 1 issue found, 0 High severity              |
  | Section 4  (Data/UX) | 6 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 2 issues found (fold as single source, C1   |
  |                      | placement)                                  |
  | Section 6  (Tests)   | Diagram produced, 1 gap (migration crash)   |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 2 gaps found (receipt path/cap, runbooks)   |
  | Section 9  (Deploy)  | 2 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 13 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 10 total, 0 CRITICAL GAPS (1 WARNING)       |
  | TODOS.md updates     | 3 items proposed                            |
  | Scope proposals      | 7 proposed, 4 accepted (+ A1-A4 from voices)|
  | CEO plan             | written (ceo-plans/2026-10-03-...md)        |
  | Outside voice        | codex completed; native completed           |
  | Lake Score           | N/A (no coverage-scored questions)          |
  | Diagrams produced    | 4 (architecture, data flow, state, test map)|
  | Stale diagrams found | 2                                           |
  | Unresolved decisions | 8 (UC1-UC4, T1-T4: final gate)              |
  +====================================================================+
```

#### CEO phase close

Close packet `autoplan-ceo-TZYrFL/close-packet.md` (243 lines) read in full; verified against the accepted decisions. Published: Phase 1 complete; Codex completed (8 concerns), native completed (9 issues), consensus 6/6 confirmed, 4 User Challenges and 4 Taste items to the gate.

### Phase 2 (Design): skipped, no UI scope detected. Not a completed review.

### DX phase (Phase 2.5)

Methodology: `autoplan-dx-methodology-011gH6/methodology.md` read at ranges 1-503, 504-1203, 1204-1803, 1804-2175 (EOF, 2,175 lines). DX checkpoint and voice input: `autoplan-dx-mF64bj/dx-implementation.md` (source SHA-256 `41ee98b5…409ec`, review projection `e9b70546…0d575`). Mode: DX POLISH (autoplan override). Product type: MCP server for agents (primary) plus two CLIs (the gbrain-evals budget ledger and gbrain's thin client); auto-decided, no confirmation question under autoplan. Prior DX reviews: none. Prior learnings: none.

#### Step 0: DX investigation

**0A. Persona (auto-decided, P6).**

```
TARGET DEVELOPER PERSONA
========================
Who:       An AI agent operator: an agent (Claude Code, Codex, Capy) driving gbrain over MCP, and the same kind of agent
           running gbrain-evals paid runners and the budget-ledger CLI on Garry's behalf.
Context:   Mid-task. The agent calls search/query hundreds of times per session, or starts a paid run under a
           hard dollar cap and must not stop to ask a human unless a real decision is needed.
Tolerance: Zero silent failures. One refusal it cannot act on stops the program and pages Garry.
Expects:   Every error says what happened, why, the exact next command and when to ask the user; defaults that are
           right; escape hatches that are discoverable from the tool schema or --help.
```

Evidence: gbrain `AGENTS.md` and README address agents first ("Agents: start with AGENTS.md"); the standing rule that GBrain assumes an agent operator; gbrain-evals `CLAUDE.md` addresses the run operator. Secondary persona: a third-party developer whose integration parses `search` rows (ChatGPT deep research, custom MCP clients).

**0B. Empathy narrative (first person, the eval operator agent).** "Item 1 merged. I need to run dev round 1 under the $237 cap. The plan gives me one 600-character bullet with `<C1+C2 commit>`, a world path nobody wrote down and `<remaining>`. I assemble it. The runner opens `.budget/cat40-followups.jsonl`, which does not exist, so whatever I typed first sets its cap forever; I forgot `--program-cap-usd`, so it records $500 (observed in code: `budgetOptionsFrom` turns an absent flag into $500 at parse time, `budget-ledger.ts:597`). Next run, with the flag, refuses: cap mismatch. The message tells me nothing about how to fix it, and the plan says `set-cap` needs Garry. I stop and ask. Meanwhile a gbrain agent on an upgraded HTTP host calls `search` and gets rows without `page_id` or `cosine`; its integration silently reads `undefined`. The gbrain CLI's `--explain` loses its score breakdown, because the host cannot see `clientInfo` on stateless HTTP (`serve-http-mcp.ts:564`, `sessionIdGenerator: undefined`)." Observed facts: the parser default, the stateless HTTP transport, the 20,000 default cap. Predicted: the operator's sequence.

**0C. Competitive benchmark and TTHW (auto-decided target: Competitive, 2-5 minutes, P5).** Clock for the operator: from "Item 1 merged" to "first ledger-guarded paid run started with the right cap". Clock for an agent: from "host upgraded" to "first search result it can use".

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| This plan (operator), as drafted | merged → dev round 1 running | about 7 steps, 10+ min (estimated from the plan text) | manual argv assembly, implicit cap | plan text |
| This plan (operator), after DX fixes | same | 3 steps, under 5 min (estimated) | `init`, `status`, one script step | accepted block below |
| This plan (agent), as drafted | upgrade → usable search | 0 steps; full rows not discoverable | silent lean default | plan text |
| delta-mcp / mcp-compressor (peers) | tools/list → call | reported: names-first schema, compact wire negotiated at initialize | negotiation, not silent change | web search 2026-10-03 (Phase 1 landscape) |
| Stripe API versioning (reference) | upgrade → same response | dated version pins; new shape opt-in | explicit versions | well-known practice |

Target: Competitive (under 5 minutes, 3 commands) for the operator; for agents, zero steps plus a discoverable `fields: "full"`.

**0D. Magical moment (auto-decided, P5 lowest-effort vehicle).** For the operator: `budget-ledger.ts status` prints one JSON object that says the recorded cap, committed, remaining, the journal path and the next safe command. For agents: the same search answer at a third of the characters, with the escape hatch named in the tool description. Vehicle: existing `status` command and the `search`/`query` descriptions (no new surface).

**0E. Mode:** DX POLISH (override).

**0F. Journey trace (DX POLISH: all stages).**

```
STAGE           | DEVELOPER DOES                                  | FRICTION POINTS                                  | STATUS
----------------|-------------------------------------------------|--------------------------------------------------|--------
1. Discover     | reads CHANGELOG / tool description              | `fields` not mentioned in descriptions           | fixed (DX-2)
2. Install      | upgrades gbrain host / pulls gbrain-evals       | old workers alive during ledger migration        | fixed (DX-5 tombstone + drain step)
3. Hello World  | operator: init journal, status, first run       | cap set by first creator; absent flag = $500     | fixed (DX-3 init, DX-4 parser)
                | agent: first search                             | lean rows silent; CLI loses rows over HTTP       | fixed (DX-1 header, DX-2 notice)
4. Real Usage   | dev rounds, held-out, ladder                    | placeholder argv; unreadable labels; 1e8 flag    | fixed (DX-8 script, DX-9 labels, DX-10)
5. Debug        | a refusal, a corrupt line, a lag spike           | refusals lack the fix; no verify; lag unthresholded | fixed (DX-6, DX-7, DX-11)
6. Upgrade      | third-party client on new host; rollback         | silent field loss; no downgrade policy           | partly fixed (DX-2 host config, DX-12 docs); negotiation = UC4
```

**0G. First-time developer confusion report.**

```
FIRST-TIME DEVELOPER REPORT
Persona: eval operator agent
Attempting: dev round 1 under the $237 cap
T+0:00  Reads the plan's command bullet; three placeholders, no world path.        -> DX-8 script
T+0:45  Runs the runner without --program-cap-usd; journal created at $500.         -> DX-3 init, DX-4 parser
T+1:30  Reruns with the flag; "cap mismatch" with no fix in the message.            -> DX-6 actionable refusals
T+2:00  Finds evidence-delivery.ts still parsing ledger.json; another runner breaks. -> DX-5 consumer inventory
T+3:00  Asks Garry about set-cap (a false alarm).                                   -> fixed by DX-3/DX-4/DX-6
```

#### Step 0.5: DX dual voices

**Native DX reviewer** (Capy subagent, nativeDispatchPrompt verbatim; result starts `INPUT: dx e9b705465b687a663c6ae3059d3eb6592d8be9b4f8e0437117bdd3c13020d575`, matching the snapshot). Completed, 11 issues: (1) CRITICAL CEO-A1 cannot see `clientInfo` on the stateless HTTP host, so CLIs get lean rows there (verified: `serve-http-mcp.ts:564`); (2) CRITICAL adopt-on-omit is impossible with today's parser (verified: `budget-ledger.ts:597`); (3) lean rows are silent and lack a host-wide escape hatch; (4) refusals need problem, cause, command and when to ask; `set-cap` underspecified; (5) no recovery for a corrupt middle line (add `verify`); (6) run commands not copy-pasteable, and `--max-tool-chars 100000000` contradicts E1's `null`; (7) first creator sets the cap: add `init`, `status` read-only; (8) `.json` to `.jsonl` remapping surprises; (9) lag field contract and automatic warning; (10) guidance cut by C3 should live in human docs; (11) unreadable run labels.

**Codex DX voice** (`codex exec`, `gpt-6-astra`, exit 0, `OUTSIDE_STATUS: completed provider=codex host=claude`). Full output:

```tool-output
CODEX SAYS (DX, developer experience challenge):
Request changes. The plan improves cost and observability, but leaves breaking upgrades and operator recovery
underspecified. The thin-client exception is useful; it does not resolve compatibility for other MCP clients.
This was a static review of the plan and repository code. I did not read skill files, run paid evaluations, or
measure installation time.
| Criterion | Assessment |
| Time to hello world | Under five minutes is unproven. Roughly six setup actions for MCP search, five for a thin
  CLI with an existing host and credentials, and eight-ten for a fresh paid Cat 40 run. |
| Error messages | Existing budget refusals often explain the cause. New migration and cap errors lack a complete
  recovery contract. |
| API/CLI design | `fields` avoids overloading `detail`, and persisted caps are sensible. Identity-dependent output
  and unspecified command behavior weaken consistency. |
| Docs | The two-minute discovery target is not met for the new ledger workflow. Source comments and a CHANGELOG
  entry are insufficient. |
| Upgrade path | Blocking gaps: third-party result contracts, direct ledger readers, and workers running old code. |
1. P1 - Third-party clients still break on a routine host upgrade. C1 removes fields by default without
   negotiation. Existing consumers receive successful responses with missing data; they get no deprecation period.
   This confirms the queued CEO concern. Telling everyone else to add fields:"full" also creates version skew:
   older strict hosts reject undeclared parameters (src/mcp/dispatch.ts:644). Required change: preserve the existing
   response contract for unnegotiated clients; enable lean rows through explicit capability or parameter
   negotiation. Document schema discovery before sending fields, and test old/new clients against old/new hosts
   over both transports.
2. P1 - The migration misses an existing production consumer of the JSON format. evidence-delivery.ts:123 directly
   reads o.ledgerPath, parses one JSON document, and accesses ledger.runs. Required change: inventory runtime
   consumers of the ledger file and route them through the shared reader. Include a migrated campaign-open/join
   flow in verification.
3. P1 - Upgrading or rolling back with an old worker alive can split accounting. The current reader treats a
   missing ledger as empty (budget-ledger.ts:118). After migration renames ledger.json, an already-running old
   worker can recreate it through reserve (:224). The "both files present" refusal cannot stop that old process.
   Required change: define a coordinated upgrade procedure that drains old workers, plus an explicit downgrade
   policy. Test an old worker across migration. The recovery instruction must distinguish an interrupted migration
   from a legacy file containing newer spending.
4. P1 - The lean-row rule can hide truncation on default calls. C1 preserves delivered.truncated only when a
   non-chunk return unit "was requested." But omitted return_unit defaults to auto (evidence-delivery.ts:180),
   which can deliver conversation pages with truncated evidence (:900). Required change: preserve a model-visible
   truncation indicator whenever delivery actually truncates; test omitted, configured, and explicit return_unit.
5. P2 - C3 measures documentation size without specifying the information that must survive (search vs query,
   top-K vs exhaustive enumeration, when to retrieve surrounding evidence; operations-descriptions.ts:71). Required
   change: define minimum retained guidance per tool (purpose, required inputs, consequential defaults, cost
   implications, recovery actions); validate representative tool-selection and recovery scenarios.
6. P2 - New errors need actionable diagnostics, and status must remain scriptable. A cap mismatch should identify
   the journal, recorded cap, requested cap, and whether the request came from a flag or environment variable.
   Corrupt-journal errors need a line or byte location and a documented recovery route. Current status emits JSON
   on stdout (:632); runbook lines must go to stderr or inside a documented JSON structure. Required change:
   specify set-cap syntax, help, exit behavior and diagnostic examples; verify failure messages through the CLI.
7. P2 - No discoverable, copy-paste-complete first-run path. eval/README.md has no Cat 40 or budget-ledger
   workflow; neither CLI has --help handling; the "exact commands" are fragments. Required change: link one operator
   guide from eval/README.md (free smoke run, ledger init/status, one bounded paid task, expected receipt, resume,
   migration recovery); add lean/full MCP request-response examples and a client compatibility table; time these
   paths from clean prerequisites before claiming the five-minute target.
Compact JSON, retaining safety/provenance fields, protecting the thin CLI, and adding cost-per-success reporting
are sound choices.
Recommendation: Revise before approval because the proposed defaults can break existing MCP clients and the ledger
migration can both strand current runners and split accounting across old and new workers.
```

(Reproduced in full; wrapped for width, link targets shortened to file:line.)

Claims verified on disk: `serve-http-mcp.ts:564` stateless transport; `budget-ledger.ts:597` default at parse time; `eval/runner/evidence-delivery.ts:123` parses the ledger file directly; `evidence-delivery.ts` resolves an omitted `return_unit` to the config unit, else `auto`. Also found by this phase: gbrain `docs/mcp/CHATGPT.md:120` and `docs/protocol/DEEP_RESEARCH_IDS_v1.md` make each `search`/`query` row's opaque `id` the deep-research `fetch` key, so dropping `id` (as the draft's diagnostics list implies) would break ChatGPT deep research.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude (native)            Codex                       Consensus
  1. Getting started < 5 min?          no (7 steps -> 3 w/ fixes)  no (unproven, 8-10 steps)   CONFIRMED gap
  2. API/CLI naming guessable?         yes (`fields`), labels poor  yes (`fields`), identity rule weak  CONFIRMED (fix labels, identity)
  3. Error messages actionable?        no (refusals lack fix)       no (no recovery contract)   CONFIRMED gap
  4. Docs findable & complete?         no (runbook, human docs)     no (operator guide, examples) CONFIRMED gap
  5. Upgrade path safe?                no (silent rows, no hatch)   no (3rd party, old worker, readers) CONFIRMED gap
  6. Dev environment friction-free?    no (init, path remap)        no (status scriptability)   CONFIRMED gap
CONFIRMED = native + outside agree. 6/6 confirmed; 0 disagreements. Single-voice criticals: native 1 and 2 (both verified
in code, both fixed); Codex 2-4 (verified, fixed).
```

Dispositions (auto-decided; P1 for error and upgrade safety, P5 for naming and simplest vehicle):

| ID | Finding | Disposition |
|---|---|---|
| DX-1 | CLI identity invisible on stateless HTTP (native 1) | Fixed: new thin clients send `X-Gbrain-Client: gbrain-remote-cli/<version>` on every request; stdio also honors `clientInfo`; the host serves full rows to either. CLIs older than this release cannot be detected and get lean rows unless the host sets `mcp.result_rows: full` (DX-2); documented. Tests run over stateless HTTP and stdio. Supersedes the clientInfo-only wording of CEO-A1. |
| DX-2 | Silent lean rows, no host-wide hatch (native 3; Codex 1) | Fixed within the user's direction: host config `mcp.result_rows: lean|full` (default `lean`); `_meta.retrieval.rows = "lean"`; the `search` and `query` descriptions name `fields: "full"` in one sentence. Negotiated-only lean rows stay User Challenge CEO-UC4 (now raised by both phases). |
| DX-3 | First creator sets the cap (native 7) | Fixed: `budget-ledger.ts init --budget-ledger <path> --program-cap-usd <n>` creates a journal; reserve on a missing journal refuses with the `init` command; `status` is read-only (never creates or migrates). |
| DX-4 | Absent flag becomes $500 at parse time (native 2) | Fixed: `programCapUsd` stays `null` when neither flag nor env is set; the $500 default applies only inside `init` when no cap is given. |
| DX-5 | Direct ledger readers and old workers (Codex 2, 3; native 8) | Fixed: inventory every reader of the ledger file (`rg 'ledgerPath|ledger\.json'`; known: `eval/runner/evidence-delivery.ts:123`) and route each through the shared fold reader; migration leaves a tombstone `ledger.json` (`{"schema_version": 2, "migrated_to": "<journal>"}`) so an old worker refuses to spend instead of recreating an empty ledger; the full legacy copy is kept as `ledger.json.migrated`; the upgrade procedure says stop all runners, pull, then open once. |
| DX-6 | Refusals lack the fix (native 4; Codex 6) | Fixed: every refusal states problem, cause, the exact next command and whether to ask the user (see accepted block for the four messages). `set-cap` syntax, reason, refusal below committed spend, usage string and `--help`. `status` stays one JSON object on stdout; hints go into a `hints` array. |
| DX-7 | Corrupt middle line has no recovery (native 5) | Fixed: `budget-ledger.ts verify` (read-only) prints first bad line and byte offset plus totals before it; documented recovery. |
| DX-8 | Commands not copy-pasteable (native 6; Codex 7) | Fixed: `scripts/cat40-followups.sh <step>` with steps `init`, `dev1`, `dev2`, `rebase`, `holdout`, `ladder`; build commits come from env vars it validates; `<remaining>` comes from `status`'s `remaining_usd`; held-out world regenerated from seed 20261003 into `eval/reports/cat40/holdout/world.json` and checked against digest `df9e4f65cf60` (the baseline receipt's path; the world is not committed). |
| DX-9 | Unreadable labels (native 11) | Fixed: `gbrain-c12-dev`, `gbrain-c1234-dev`, `gbrain-77dcf414-rerun`, `gbrain-c1234-holdout`, `gbrain-c1234-ladder`. |
| DX-10 | `100000000` contradicts E1's `null` (native 6) | Fixed: `--max-tool-chars none` is the explicit uncapped spelling; after E1 the commands omit the flag. |
| DX-11 | Lag contract and threshold (native 9) | Fixed: receipt `cost.event_loop_lag_ms: {p50, p99, max}` or `null` with `event_loop_lag_unavailable`; `analyze.ts` prints a warning when p99 ≥ 50 ms. |
| DX-12 | Docs: operator guide, MCP examples, human copy of cut guidance (Codex 7; native 10) | Fixed: `docs/budget-ledger.md` in gbrain-evals linked from `eval/README.md` (init, status, verify, set-cap, migration, upgrade/downgrade, recovery, free smoke run, the cost-wave runbook); gbrain docs gain lean/full examples and a client compatibility table in `docs/mcp/README.md`, and the full pre-cut guidance moves to a human MCP tool reference doc linked from the CHANGELOG. |
| DX-13 | Truncation hidden on default calls (Codex 4) | Fixed: lean rows keep `delivered.truncated: true` whenever delivery actually truncated, whatever selected the unit (explicit, config or `auto`). Tests for omitted, configured and explicit `return_unit`. Supersedes the CEO wording "only when a non-chunk return unit was requested". |
| DX-14 | C3 must preserve meaning, not only size (Codex 5) | Fixed: each starter tool keeps a minimum: purpose, required inputs, consequential defaults (search = exact tokens and top-K; query = expanded, ranked; when to fetch surrounding evidence), cost note where relevant, and the recovery action; a table of these per tool goes in the PR; dev round 2 is the behavioral check. |
| DX-15 | `id` is the deep-research fetch key (found by this phase) | Fixed: lean rows keep `id`. |
| DX-16 | Version-skew test matrix (Codex 1) | Fixed: old and new thin client against old and new host, over stdio and HTTP, including `strict_params=reject`. |
| DX-17 | Downgrade policy (Codex 3) | Fixed: downgrading Item 1 is allowed only while no event was appended after migration (`verify` reports it); otherwise stay on the journal. |

#### DX passes (rated before → after)

**Pass 1, Getting started: 3 → 7.** Evidence: 0C/0F. Fixes DX-3, DX-4, DX-8 give a 3-command operator path. Residual: the five-minute claim is an estimate until timed (DX-18 below); full 10 would need a dry-run mode for the paid script, out of scope.

**Pass 2, API/CLI design: 6 → 8.** `fields` is guessable and an enum (validated under `strict_params=reject`); `init`/`status`/`verify`/`set-cap` follow the existing verb style; labels readable (DX-9). Residual: per-identity defaults (DX-1) remain a second rule a reader must learn.

**Pass 3, Errors: 4 → 8.** Three traced paths. (a) Cap mismatch today: none exists; drafted: "cap mismatch" only. After DX-6: "Refusing to reserve: this journal (.budget/cat40-followups.jsonl) records a program cap of $237.00, but BRAINBENCH_PROGRAM_CAP_USD sets $500.00. Unset the variable to use the recorded cap. To raise the cap, run `bun eval/runner/budget-ledger.ts set-cap --budget-ledger … --program-cap-usd <n> --reason …` after the user approves." (b) Both files: names both paths, both totals, and either "interrupted migration: totals match; run `… migrate --finish`" or "the legacy file has newer spending; stop and ask the user". (c) Corrupt line: line number, byte offset, the `verify` command. Tier: Elm-style conversational plus exact command.

**Pass 4, Docs: 3 → 7.** DX-12. Residual: copy-paste examples are written but not timed.

**Pass 5, Upgrade: 3 → 6.** DX-1, DX-2, DX-5, DX-13, DX-15, DX-16, DX-17. Residual: third-party clients still change shape on upgrade (UC4), so this stays below 8 unless Garry picks negotiation.

**Pass 6, Dev environment: 5 → 7.** Scriptable `status`, path-remap notice printed once and the resolved path in receipts (accepted), tombstone protects mixed old/new processes. Residual: the paid script is Linux/macOS bash only (acceptable for this repo).

**Pass 7, Community: 6 → 6.** Open-source repos with CHANGELOGs; no new community surface is in scope. No issues, moving on.

**Pass 8, DX measurement: 2 → 6.** DX-11 lag warning; DX-18 (accepted): time the operator path once from a clean checkout when Item 1 lands and record the minutes in the PR. Residual: no recurring measurement (not proposed; would be a separate policy decision).

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  7/10  |  3/10  |  ↑     |
| API/CLI/SDK          |  8/10  |  6/10  |  ↑     |
| Error Messages       |  8/10  |  4/10  |  ↑     |
| Documentation        |  7/10  |  3/10  |  ↑     |
| Upgrade Path         |  6/10  |  3/10  |  ↑     |
| Dev Environment      |  7/10  |  5/10  |  ↑     |
| Community            |  6/10  |  6/10  |  =     |
| DX Measurement       |  6/10  |  2/10  |  ↑     |
+--------------------------------------------------------------------+
| TTHW (operator)      | <5 min (est.) | ~10+ min (est.) | ↑ |
| Competitive Rank     | Competitive (target)                         |
| Magical Moment       | designed via `status` JSON + tool description |
| Product Type         | MCP server for agents + CLI                  |
| Mode                 | POLISH                                       |
| Overall DX           |  7/10  |  4/10  |  ↑     |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (init + script)                        |
| Learn by Doing     | covered (free smoke run in the guide)          |
| Fight Uncertainty  | covered (refusal messages, verify, lag warning)|
| Opinionated + Escape Hatches | covered (lean default; fields, mcp.result_rows, set-cap, --max-tool-chars none) |
| Code in Context    | covered (lean/full examples)                   |
| Magical Moments    | covered (status)                               |
+====================================================================+
```

No dimension below 6. Upgrade Path (6) is the weakest because UC4 is open.

```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Operator: merged → first guarded paid run in 3 commands, < 5 min (timed once, DX-18)
[ ] `init` is the only way a journal gets its cap; `status` is read-only
[ ] First `status` prints cap, committed, remaining, journal path, hints
[ ] Magical moment: `status` JSON + `search`/`query` descriptions naming `fields: "full"`
[ ] Every refusal: problem + cause + exact command + whether to ask the user
[ ] `fields` enum; labels readable; `--max-tool-chars none`
[ ] Defaults: lean for agents, full for gbrain CLI (header or clientInfo), host override `mcp.result_rows`
[ ] docs/budget-ledger.md with copy-paste commands; gbrain lean/full examples + compatibility table
[ ] Upgrade/downgrade procedure documented; tombstone stops old workers
[ ] Version-skew matrix tested (old/new client × old/new host × stdio/HTTP × strict reject)
[ ] CHANGELOG (gbrain) tells agents what changed and how to get full rows
[ ] Works in CI without keys (stubbed embeddings for E3)
```

**NOT in scope (DX).** A dry-run mode for the paid script (would reach 10 on Pass 1; separate decision), recurring TTHW measurement, versioned response schemas (part of UC4's alternative), a hosted docs site. TODOS.md proposals: none beyond CEO's (DX items were fixed in plan).

**What already exists (DX).** `budget-ledger.ts` usage string and `status` JSON; gbrain `mcp.strict_params` validation and unknown-param warnings; D8 notice blocks; `docs/mcp/*` per-harness guides; `docs/protocol/DEEP_RESEARCH_IDS_v1.md`; `eval/README.md` free checks; `withHermeticEnv` for keyless smoke runs.

<!-- autoplan-accepted:dx -->
- DX-1 (supersedes CEO-A1's clientInfo-only rule): gbrain's thin client sends `X-Gbrain-Client: gbrain-remote-cli/<version>` on every HTTP request; the host serves full rows to requests carrying it and to stdio sessions whose `clientInfo.name` is `gbrain-remote-cli`. CLIs older than this release cannot be detected and get lean rows unless the host sets `mcp.result_rows: full`; the CHANGELOG says so. Verify: identity tests over stateless HTTP and over stdio.
- DX-2: host config `mcp.result_rows` (`lean` default, `full` restores today's rows for every remote caller); `_meta.retrieval.rows` reports `"lean"` or `"full"`; the `search` and `query` descriptions name `fields: "full"` in one sentence inside C3's budget. Verify: config test and schema test.
- DX-3: `bun eval/runner/budget-ledger.ts init --budget-ledger <path> --program-cap-usd <n>` creates a journal (cap $500 when omitted); a reserve against a missing journal refuses and prints the `init` command; `status` is read-only and never creates or migrates. The plan's first paid step is `init --budget-ledger .budget/cat40-followups.jsonl --program-cap-usd 237`. Verify: tests for each.
- DX-4: `budgetOptionsFrom` leaves `programCapUsd` null when neither `--program-cap-usd` nor `BRAINBENCH_PROGRAM_CAP_USD` is set; a runner without either adopts the journal's recorded cap. Verify: a runner with no cap flag against a $237 journal reserves and `status` shows $237.
- DX-5: every runtime reader of the ledger file goes through the shared fold reader (inventory with `rg 'ledgerPath|ledger\.json'`; known: `eval/runner/evidence-delivery.ts:123`). Migration replaces `ledger.json` with a tombstone `{"schema_version": 2, "migrated_to": "<journal path>"}` (old code refuses to spend on it) and keeps the legacy copy as `ledger.json.migrated`. The upgrade procedure is: stop all runners, pull, run `status` then one runner. Verify: an old-code worker against a migrated directory refuses; a migrated campaign-open and join flow works in `evidence-delivery.ts`.
- DX-6: refusal messages, each naming the journal path: cap mismatch (recorded cap, requested cap, and whether it came from the flag or the environment variable; says to unset an environment override, or to run `set-cap` after the user approves); both real ledgers present (both paths and totals; "interrupted migration, totals match: run `budget-ledger.ts migrate --finish`" or "legacy file has newer spending: stop and ask the user"); unparseable line (line number, byte offset, `verify` command); missing journal (the `init` command). `set-cap --budget-ledger <path> --program-cap-usd <n> --reason <text>` records `{program_cap_usd, reason, by: user@host, at}`, refuses a cap below committed spend, and appears in the usage string and `--help`. `status` stays one JSON object on stdout with a `hints` array. Verify: CLI tests asserting each message's command text.
- DX-7: `budget-ledger.ts verify --budget-ledger <path>` (read-only) prints the first bad line and byte offset and the totals up to it; `docs/budget-ledger.md` documents the recovery (copy the journal, truncate at the offset, compare totals, ask the user before spending again). Verify: test on a journal with a corrupt middle line.
- DX-8: `scripts/cat40-followups.sh <init|dev1|dev2|rebase|holdout|ladder>` assembles the exact commands in the CEO block, validates `GBRAIN_C12_REF`, `GBRAIN_C1234_REF` and `GBRAIN_FINAL_REF`, regenerates the held-out world with `bun eval/generators/model-ladder-gen.ts --seed 20261003 --out eval/reports/cat40/holdout` and refuses unless its digest starts `df9e4f65cf60` (the world is not committed; the baseline receipt used that path), runs `status` first, and takes the ladder's budget from `status`'s `remaining_usd`. Verify: `bash -n` and a dry print mode (`PRINT_ONLY=1`).
- DX-9: run labels are `gbrain-c12-dev`, `gbrain-c1234-dev`, `gbrain-77dcf414-rerun`, `gbrain-c1234-holdout` and `gbrain-c1234-ladder`; these replace `gbrain-c12`, `gbrain-c1234`, `gbrain-next-rebase`, `gbrain-next2` and the ladder label in the CEO block, and `holdout_stats.py` pairs use them.
- DX-10: `--max-tool-chars none` is the explicit uncapped spelling (receipt `max_tool_chars: null`); once E1 lands the paid commands omit `--max-tool-chars`. Verify: runner test.
- DX-11: receipts carry `cost.event_loop_lag_ms: {p50, p99, max}`, or `null` plus `event_loop_lag_unavailable: <reason>`; `analyze.ts` prints a warning when p99 is 50 ms or more. Verify: analyze fixture test.
- DX-12: gbrain-evals `docs/budget-ledger.md`, linked from `eval/README.md`, covers init, status, verify, set-cap, migration, the upgrade and downgrade procedure, recovery, a free hermetic smoke run and the cost-wave runbook. gbrain `docs/mcp/README.md` gains lean and full request/response examples and a client compatibility table; the full pre-cut tool guidance moves to a human MCP tool reference doc linked from the CHANGELOG.
- DX-13 (supersedes the CEO rule "only when a non-chunk return unit was requested"): lean rows keep `delivered.truncated: true` whenever delivery truncated, whether the unit came from the call, the config or `auto`. Verify: tests for omitted, configured and explicit `return_unit`.
- DX-14: every starter tool keeps, within its C3 budget: purpose; required inputs; consequential defaults (for `search`: exact tokens and top-K; for `query`: expanded and ranked; when to fetch surrounding evidence); a cost note where relevant; the recovery action. The PR carries the per-tool table; dev round 2 is the behavioral check.
- DX-15: lean rows keep `id` (the deep-research `fetch` key, `docs/protocol/DEEP_RESEARCH_IDS_v1.md`). Verify: a lean `search` row's `id` resolves through `fetch`.
- DX-16: version-skew tests: old and new thin client against old and new host, over stdio and HTTP, including `mcp.strict_params=reject`.
- DX-17: downgrading Item 1 is allowed only while `verify` reports no event appended after migration; otherwise the journal stays. Documented in `docs/budget-ledger.md`.
- DX-18: time the operator path (merged Item 1 → first guarded paid run started) once from a clean checkout and record the minutes in the Item 1 PR; the target is under 5 minutes and 3 commands.
- Paths: when a `.json` path is remapped to its `.jsonl` journal or migrated, the CLI prints one notice line on stderr; `status` and every receipt show the resolved journal path.
- Supersessions in the CEO block: the migration step "renamed to `ledger.json.migrated`" now also leaves the DX-5 tombstone at `ledger.json`; a tombstone is not a second ledger, so the both-files refusal applies only to a real (schema 1) legacy file beside a journal, and DX-6's two cases (totals match: finish the migration; legacy has newer spending: stop and ask) replace the runbook line "keep the journal, rename the stale legacy file".
<!-- /autoplan-accepted:dx -->

#### DX phase close

Close packet `autoplan-dx-eCxkwC/close-packet.md` (265 lines) read in full after one regeneration (added the supersession line); verified. Published: Phase 2.5 complete; DX 7/10; Codex completed (7 concerns), native completed (11 issues), consensus 6/6.

### Eng phase (Phase 3, last)

Methodology: `autoplan-eng-methodology-4NFE57/methodology.md` read at ranges 1-482, 483-1151, 1152-1709, 1710-1801, 1802-2261 (EOF, 2,261 lines). Eng checkpoint and voice input: `autoplan-eng-UDnwwQ/eng-implementation.md` (review projection `6d3d7aa5…174f`). Target: this plan file (autoplan supplies it; no scope-gate question). Test framework: `bun test` (gbrain-evals `package.json` `test` script runs sharded bun tests, Python tests and validators; gbrain likewise bun). Retrospective: `budget-ledger.ts` grew allowances because whole-file rewrites were slow (`BudgetAllowance` comment) and gained the TypeSafe pricing; no reverts. gbrain's `dispatch.ts` flipped compact → pretty in `77dcf414` for test stability: a recurring "result shape vs goldens" tension that E3 now pins.

#### Step 0: Scope challenge

What already solves each sub-problem: `withLock` (lock), `BudgetAllowance` (bulk charging), `MeteringProxy` (gbrain cost), `holdout_stats.py` (paired stats), `latency-replay/replay.ts` (comparator), `OperationContext.remote` and `retrievalNoticeBlocks` (C1/C4 seams), `buildToolDefs` + `filterOpsForSurface` (C3 measurement), `request_tools` (T1). Complexity: about 12 changed files in gbrain-evals (ledger, tests ×3+, runner, loop, analyze, evidence-delivery, paid-arm, n2-3, script, docs) and about 10 in gbrain (search.ts, dispatch.ts, operation description files, mcp-client.ts, serve-http-mcp/http-transport, server.ts, tests, docs), with two new units (journal fold, lag monitor). The gate trips (8+ files). Feature cuts proposed: none (autoplan Eng override: never reduce). Structure question auto-decided: **Original arrangement** (the files are where the behavior lives; no smaller arrangement keeps the accepted contracts). Scope record: feature answers: none asked; structure: A (Original arrangement, autoplan override P2); accepted scope: Implementation plan as amended by CEO and DX; pending remedies: E-1..E-8, N-3..N-19 below. Result: scope accepted as-is. Search check: append-only journal + lock is Layer 1 (JSONL ledgers with lease locks and size-drift checks, web search in Phase 1); `bun:sqlite` WAL is the Layer 1 alternative (UC3). Distribution: no new artifact.

#### Step 0.5: Eng dual voices

**Native Eng reviewer** (Capy subagent, nativeDispatchPrompt verbatim; result starts `INPUT: eng 6d3d7aa5a2a13510088c2afd341d717dd2ea42ea72ac84465c1383ba673d174f`, matching the snapshot). Completed, 20 findings (7 high, 9 medium, 4 low): (1) G2 gate cannot separate harmless from harmful; bootstrap the expected half-width first, one bundle rule; (2) baseline biased for success too; make T2 required with a predeclared gate effect; (3) DX-3 conflicts with `BudgetRun.open` auto-creating a $500 ledger (test line 143); (4) every caller already passes a cap (`open`/`join` defaults, `paid-arm.ts:47`, `evidence-delivery.ts:105` manifest cap, CLI), so adopt-on-omit needs `number | null` everywhere and the manifest cap as an upper limit; (5) migration window: lock name changes and old `readLedger` treats a missing file as empty; hold both locks and rename the tombstone over the path; (6) a replaced or truncated journal breaks cached offsets; check inode/size/newline and refold; (7) mtime-based stale-lock takeover races; with torn-tail truncation it can corrupt the journal; (8) fsync is disk-dependent and the cold fold can stall; test scale-invariance and report fsync separately; (9) about 13 test files reference `ledger.json`, some would pass vacuously; (10) name the other ledgers excluded from the inventory and refuse a foreign `.jsonl`; (11) C1 must run at the very end of `evidenceOutput` with an `OperationContext` field set by both transports; (12) DX-1's stdio branch is dead code (the thin client only speaks HTTP); the header is unverifiable, so it must gate nothing security-relevant; (13) C3 likely needs schema-structure trimming and T1; (14) held-out budget margin 6% is thin; define resume; (15) record the $237 provenance and forbid concurrent paid work; (16) the dev-round harm screen only catches large harms; pick the dropped change by family breakdown; (17) stop the lag monitor in `finally`; (18) `status` must read an unmigrated legacy file read-only, and `migrate --finish` needs a CLI spec; (19) C2 also changes ~8 error envelopes; document an E3 re-pin procedure; (20) keep the lag monitor and contingency.

**Codex Eng voice** (`codex exec`, `gpt-6-astra`, exit 0, `OUTSIDE_STATUS: completed provider=codex host=claude`). Full output:

```tool-output
CODEX SAYS (eng, architecture challenge):
The plan needs revision. I found eight concrete issues beyond the queued CEO decisions. This was a static repository
review; no skill files or paid runs were used.
1. P1 - The existing reservation calculation does not guarantee the spending cap. priceRequest()
   (budget-ledger.ts:434) omits tool schemas and OpenAI `instructions`; reservationUsd() (:456) ignores the
   cache-write premium. OpenAI continuation requests also carry conversation state through previous_response_id.
   Meanwhile, settle() (:250) accepts actual spending above the reservation. These are pre-existing gaps, but
   changing storage cannot establish G1's promised "no spend past" guarantee. Include conservative accounting for
   every billable component and continuation context, with tests where reported cost would otherwise exceed the
   reservation. Refusing settlement after spending is too late.
2. P1 - Reusing the current lock does not establish concurrent journal safety. withLock() (:100) deletes locks
   based solely on age. A writer paused after checking the cap can resume after another process steals its lock and
   spends, then append using stale totals. Its cleanup can also remove the replacement writer's lock. The proposed
   four-process throughput test will not reliably exercise this. Require ownership-safe locking and a
   suspended-writer test. The append protocol also needs explicit handling for short writes, failed fsyncs, and
   directory durability during initialization/migration.
3. P1 - Resume can mix builds and reset the step's spending allowance. main() (cat40-model-ladder.ts:228) opens a
   new budget run on every invocation. Resume keys contain only model, label, task and repeat, not commit, world
   digest or configuration. The prescribed rerun after dropping C1 or C3 can reuse the failed build's completed
   cells. A timeout restart also receives another full step budget. Bind each output directory to an immutable
   experiment manifest, reject incompatible resumes, give changed-build attempts distinct directories, and persist
   the step budget across restarts.
4. P1 - The exact commands cannot initialize five uncached slots within the dev budgets. Slot initialization
   (:262) launches builds concurrently and reserves a default $5 per slot. Five slots require $25 of outstanding
   reservations; the proposed dev budgets are $18 and T2 is $12. --slot-ref selects a snapshot namespace but does
   not guarantee snapshots exist. Specify and validate the cache prerequisite, or serialize initialization/use
   appropriately sized build allowances. Add a cold-start preflight test.
5. P1 - Partial execution can produce an invalid ship-gate comparison. The scheduler (:234) interleaves models
   inside each task, contradicting the complete-model partial-ladder rule. Exhaustion can leave every model
   incomplete. holdout_stats.py (:77) averages whatever cells exist and intersects task IDs without requiring
   matching model/repeat coverage. Non-budget cell exceptions can also be logged and skipped. Require unique,
   complete (model, task, repeat) coverage before evaluating G2; restrict both sides of T2 to its two models.
   Schedule the ladder in complete model batches and report any unfinished batch separately.
6. P1 - total_usd does not yet account for every internal provider call. runCell() (:167) takes the internal meter
   before judging and restoring the slot. Background requests completing afterward enter a replacement meter that is
   discarded when the next cell starts. MeteringProxy (gbrain-arm.ts:65) also increments `unpriced` without adding a
   conservative cost. Attribute requests to immutable cell identities, finalize accounting after their requests
   finish, and reconcile cell totals against ledger spending with explicit setup/judge exclusions.
7. P1 - C1's proposed field list removes an explicit write-safety contract. evidence.ts:2 documents that `evidence`
   and `create_safety` were introduced after an agent used a blended score to create a duplicate page. Preserve
   these fields and test the projected remote response against the existing duplicate-prevention cases.
8. P2 - The latency comparator assumes concurrency the harness does not have, and misses another blocking path.
   GbrainPool.acquire() (gbrain-arm.ts:287) grants each slot exclusively: ten workers on five slots means five
   active agents plus waiters, not two agents per slot. Also, restore() (:265) performs synchronous Git, filesystem
   deletion and tar extraction while other slots can be active. Correct the replay concurrency and measure
   restoration stalls before spending on the first dev round.
The queued UC1-UC4 decisions remain unresolved. In particular, the two-model 77dcf414 rerun cannot isolate the
wave's effect against the actual 566a242a base across six models.
Recommendation: revise before implementation and paid execution because the current plan can exceed its claimed
reservation bounds, reuse incompatible evaluation cells, and make shipping decisions from incomplete or
misattributed measurements.
```

(Reproduced in full; wrapped for width, link targets shortened to file:line.)

Claims verified on disk: `priceRequest` builds chat input from `[b.system, b.messages, b.prompt, b.input]` only (no `tools`, no `instructions`); `reservationUsd` = input estimate × input price + max output × output price (no cache-write premium); `loop.ts:241` sends `previous_response_id`, so prior turns are not in the reserved body; `GbrainPool.acquire` hands out a slot exclusively; `runCell` takes the proxy meter before judging and restoring; `evidence.ts:2-13` documents `evidence`/`create_safety` as the duplicate-page guard; `cat40-model-ladder.ts:262` reserves a $5 allowance per slot build by default; 14 test files reference `ledger.json`.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude (native)              Codex                          Consensus
  1. Architecture sound?               structure yes; migration/lock gaps  lock, resume, attribution gaps  CONFIRMED concern
  2. Test coverage sufficient?         no (vacuous tests, kill points)     no (suspended writer, cold start) CONFIRMED gap
  3. Performance risks addressed?      no (fsync, cold fold)               no (restore stall, comparator)    CONFIRMED gap
  4. Security threats covered?         header unverifiable (ok if documented) no (create_safety contract)  CONFIRMED concern
  5. Error paths handled?              no (lock race, replaced file)       no (short write, fsync, unpriced) CONFIRMED gap
  6. Deployment risk manageable?       no (migration window)               no (resume mixing, partial coverage) CONFIRMED concern
CONFIRMED = native + outside agree. 6/6 confirmed; 0 disagreements. Single-voice criticals: Codex 1 (reservation
undercount, verified) and Codex 3 (resume mixing builds, verified); native 5 (migration window, verified by reading
`readLedger`'s missing-file branch).
```

#### Parent input during Eng: C5 (search latency regression)

Received from the parent mid-phase (GBRA-40 measurement): MCP `search` at 10k pages on PGLite, quiet machine, p50 about 106 ms on v0.60.32.0 against 138 ms on v0.60.35.0 (+30%), attributed to #5932's per-search saved-facts lookup and declared-name fan-out, not yet profiled. Added as requirement C5 (a direct instruction, so recorded as accepted scope, not an auto-decision). Grounding read on disk: `matchingSavedFacts` (`src/core/ops/search.ts:301`) runs a `LIKE ANY` query over `facts` on every search with any query terms; `aliasDeclarations` (`:249`) regex-scans the top 10 rows' `chunk_text` and is called twice per search (fan-out at `:277` and response meta at `:372`); `withDeclaredNameFanOut` runs a second search only when a declaration is found. The harness `scripts/scale/run.ts` exists on `origin/capy/fix-wave-8` (restamped v0.60.36.0, above master), not on `cat40-cost-wave`; it is keyless and in-memory ($0), and its fixture contains no facts and no declaration phrases, so it measures exactly the "nothing to find" case. Eng notes: #5932 also added per-search `probeProjectionReadiness` and `hasUnsealedPagesInScope` queries, so C5 profiles all four stages before changing two; the two lookups get cheap skips, and the "results unchanged when they exist" half is proven by tests, since the harness fixture has neither.

#### Section 1: Architecture

```
                               gbrain-evals (Item 1)                                         gbrain (Item 2)
  +---------------------------------------------------------------------------+      +-----------------------------------+
  | scripts/cat40-followups.sh --> cat40-model-ladder.ts (manifest-bound --out) |      | http-transport / server.ts        |
  |        |                         |  runCell(cellId) --> loop.ts (fetch)     | MCP  |   sets ctx.resultRows from        |
  |        v                         |        |                                 |<---->|   X-Gbrain-Client / mcp.result_rows|
  | budget-ledger.ts CLI             |        v                                 |      | dispatchToolCall (compact JSON C2)|
  |  init|status|verify|set-cap|     |  installPaidRequestGuard                 |      |   op.handler -> search.ts         |
  |  migrate --finish|open|close     |   priceRequest (+tools,+instructions,    |      |     evidenceOutput -> project(C1) |
  |        |                         |    +continuation, cache-write premium)   |      |   retrievalNoticeBlocks (C4)      |
  |        v                         |        |                                 |      |   tools/list (C3 budgets)         |
  |  Journal (new)  <---------------- BudgetRun.reserve/settle                  |      +----------------+------------------+
  |   fold + offset + inode check    |        ^                                 |                       | provider calls
  |   lock (pid/nonce owner)         |  MeteringProxy (per-cell attribution) <-------------------------+
  |   O_APPEND fd, fsync             |  lag monitor (startPaidRun -> RunSummary -> receiptCost)          |
  |        |                         |                                                                    |
  |  .budget/<name>.jsonl  + tombstone ledger.json + ledger.json.migrated                                |
  |  readers: evidence-delivery.ts, paid-arm.ts, all.ts ... -> shared fold reader                         |
  +-------------------------------------------------------------------------------------------------------+
```

Coupling added: `OperationContext.resultRows` (new field, set by both gbrain transports); the journal becomes the single source for every budget reader. Single points of failure: the journal and its lock (unchanged count). Realistic production failures per new path: (a) a runner crashes mid-append: torn tail, handled; (b) the lock holder stalls past the stale window: today another writer steals the lock (E-2 fixes with pid/nonce ownership); (c) an OpenAI continuation request reserves only its new turn and settles at 10x the reservation (E-1); (d) an HTTP gbrain host cannot see the CLI identity (DX-1 header); (e) a resumed run reuses cells from a different build (E-3). Distribution: no new published artifact; the shell script ships in-repo.

Findings and dispositions (auto-decided; Eng tiebreakers P5 explicit, P3 pragmatic; P1 for anything touching the spend cap):
- E-1 [P1] (confidence 9/10) `budget-ledger.ts:434-457`: reservation omits `tools`, OpenAI `instructions`, `previous_response_id` context and the cache-write premium. Accepted: conservative reservation (see accepted block).
- E-2 [P1] (9/10) `budget-ledger.ts:100-113` `withLock`: age-based takeover. Accepted: owner-checked lock (N-7 merged).
- E-3 [P1] (9/10) `cat40-model-ladder.ts:228-233`: resume keys omit build/world/config; each invocation opens a new run. Accepted: manifest-bound output directories and a persisted run id.
- N-5 [P1] (9/10) `budget-ledger.ts:118` `if (!existsSync(ledgerPath)) return {…empty}`: migration window. Accepted: dual-lock migration with tombstone renamed over the path.
- N-6 [P1] (8/10): cached offset after replacement or truncation. Accepted: inode/size/newline check.
- N-11 [P2] (8/10) `search.ts` `evidenceOutput`: projection placement and `OperationContext` field. Accepted.
- N-12 [P2] (9/10) `mcp-client.ts:303`: stdio branch of DX-1 is dead. Accepted: drop it; header documented as non-security.

#### Section 2: Code quality

- The fold is the one source for totals (CEO accepted); `readLedger`'s legacy JSON parser stays only for read-only `status` of an unmigrated file and for migration (N-18).
- N-4 [P1] (9/10): caps flow as `number | null` through `budgetOptionsFrom`, `BudgetRun.open/join`, `ledgerStatus`, `requirePaidArm` (`paid-arm.ts:47`) and the CLI; manifest caps (`evidence-delivery.ts:105`) become upper limits. Accepted.
- N-3 [P1] (8/10): one creation rule. Accepted: `open` creates a missing journal only with an explicit cap or at the default path (cap $500); `join`, `reserve` and a non-default path without a cap refuse with the `init` command. The test-setup exceptions are listed in the PR.
- N-10 [P2] (8/10): the reader inventory excludes `bug-ledger.ts`, `system-one/recount.ts` and the Python ledger in `scripts/run-retrieval-refresh.py` by name; a journal whose first line is not `ledger_open` refuses. Accepted. The Python ledger stays outside the guard (noted in NOT in scope).
- N-17, N-18, N-19 [P3]: lag monitor stops in `finally`; `migrate --finish` gets a CLI spec; C2's error-envelope churn and an E3 re-pin procedure are documented. Accepted.
- E-7 [P1] (9/10) `gbrain/src/core/search/evidence.ts:2-13`: `evidence` and `create_safety` are the duplicate-page guard. Accepted: keep both in lean rows.
- Stale diagrams: the `budget-ledger.ts` header (rewrite, already accepted) and `gbrain-arm.ts` header (still accurate).

#### Section 3: Test review

Coverage diagram (current tests read: `test/eval/budget-ledger.test.ts` 19 tests across pricing, ledger, allowances, shared runs, runner flags, SDK fetch capture; `test/eval/all-and-budget.test.ts` registry and concurrency tests; gbrain dispatch/search tests pin pretty output in several files):

```
CODE PATHS                                                       USER FLOWS (operator / agent)
[+] budget-ledger.ts journal                                     [+] Operator: init -> status -> dev round
  ├── reserve: cap check + append        [★★★ existing tests, ported]   ├── [GAP] init then status shows $237, hints
  ├── settle: unknown/already settled     [★★★ ported]                  ├── [GAP] runner without cap flag adopts $237
  ├── torn tail ignored + truncated       [GAP] new                      ├── [GAP] cap mismatch message names env var
  ├── middle bad line refuses            [★★ ported (corrupt ledger)]   └── [GAP] [→E2E] resume after timeout keeps
  ├── offset invalidation (inode/size)    [GAP] new                          run id and refuses a different build
  ├── owner-checked lock                  [GAP] new [suspended writer]
  ├── short write / failed fsync          [GAP] new (injected fs)        [+] Upgrade
  ├── migration (temp, dual lock, tombstone) [GAP] new [kill points]     ├── [GAP] old-code worker refuses tombstone
  ├── both real ledgers present           [GAP] new                      └── [GAP] migrated campaign flow (evidence-delivery)
  ├── cap rules (null, adopt, mismatch, manifest upper limit) [GAP]
  ├── reservation completeness (tools, instructions, continuation,     [+] Agent (gbrain)
  │    cache-write)                       [GAP] new                      ├── [GAP] lean row keeps id, chunk_id, evidence,
  ├── verify / set-cap / migrate --finish [GAP] new                         create_safety, sparse safety fields
  └── perf: scale invariance; cold fold   [GAP] new (local, tagged)     ├── [GAP] fields:"full" restores today's rows
[+] lag monitor                           [GAP] calibration (100 ms)    ├── [GAP] truncated evidence flag on auto unit
[+] cat40 runner                                                         ├── [GAP] [→E2E] CLI over HTTP gets full rows
  ├── uncapped default / `none`           [GAP]                         ├── [GAP] mcp.result_rows: full
  ├── manifest-bound resume               [GAP]                         └── [GAP] [→E2E] skew matrix incl. strict reject
  ├── per-cell meter attribution          [GAP]
  ├── model-batched ladder order          [GAP]                        LLM/eval: [→EVAL] C3/C4 change tool text and
  └── slot-cache preflight                [GAP]                         notices: Cat 40 dev rounds 1-2 + held-out
[+] analyze.ts buckets, cost per success, lag warning [GAP]             (already the plan's paid runs)
[+] holdout_stats.py complete-coverage check, new pairs [GAP]

COVERAGE: existing ★★★ for core reserve/settle/caps (ported); 27 new paths are GAPs with planned tests below.
```

Regression rule (IRON RULE): the ledger's existing guarantees (no overspend, settle once, join sharing, allowance) are existing behavior at risk; the regression contract is the existing assertions carried over unchanged except the listed setup exceptions (N-3, N-9, DX-4 test at line 225, corrupt-ledger setup). Auto-decided as the regression contract (P1).

Tests to add (value cards in the test-plan artifact): journal torn tail; offset invalidation; suspended writer with owner-checked lock (pause a child between check and append, expire its lock, start a second writer, resume the first: the first must refuse or re-check, never overshoot); short write and failed fsync via an injected fs; migration kill points (after copy, after journal rename, after tombstone rename); old-code worker against the tombstone; both-ledgers refusal; cap rules; reservation completeness for an OpenAI continuation chain and an Anthropic request with tools (reported cost must not exceed the reservation); verify/set-cap/migrate --finish CLI messages; scale-invariance perf (250k vs 1k within 2x excluding fsync) plus a local 5 ms report; lag calibration; runner uncapped default, manifest-bound resume refusal, model-batched order, slot-cache preflight; per-cell meter attribution with a delayed proxy request; analyze buckets summing to `total_usd`; `holdout_stats.py` refusing incomplete coverage. gbrain: lean projection keeps `id`, `chunk_id`, `evidence`, `create_safety` and sparse fields; projected rows still pass the duplicate-prevention cases; `fields` enum under strict reject; truncation flag for omitted/configured/explicit `return_unit`; CLI identity over HTTP; `mcp.result_rows`; skew matrix; E3 size ceilings; C3 served-list ceilings with `publish_skills` on and off; C4 boundaries. Tests made obsolete: the pretty-output pins in gbrain tests (rewritten, not deleted, since output shape is a declared contract).

Test plan artifact: written to `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-followups-eng-review-test-plan-20261003.md` (see accepted block for the path check).

#### Section 4: Performance

- E-8 [P2] (8/10) `gbrain-arm.ts:287` exclusive slots, `:265` synchronous restore: the comparator must replay at one agent per slot with five slots in parallel, and the receipt records per-cell `restore_ms` so a restore stall is visible apart from the ledger. Accepted.
- N-8 [P2] (8/10): fsync cost varies by disk and the cold fold is synchronous. Accepted: CI asserts scale invariance excluding fsync; the 5 ms target is measured and reported on the run machine; `status` prints a compaction hint above 100 MB; cold-fold time is in `status`.
- E-4 [P1] (9/10) `cat40-model-ladder.ts:262`: five concurrent $5 slot-build allowances exceed an $18 step budget. Accepted: a separate `slots` step with its own budget and `--slot-build-allowance-usd 2`, and a preflight that every slot snapshot exists before any agent step.
- E-6 [P1] (8/10) `cat40-model-ladder.ts:167`, `gbrain-arm.ts:65`: provider calls after the meter is taken are lost; unpriced calls cost $0. Accepted: per-cell attribution, finalize after in-flight requests drain, unpriced calls charged at their reservation, and a reconciliation of cell totals plus judge plus builds against ledger spend (within 1%).

#### Remaining planning decisions (Eng)

- E-5 [P1] (9/10) partial coverage and scheduler order: accepted (model-batched ladder, complete-coverage requirement for G2, T2 restricted to its two models on both sides, missing cells rerun via resume before analysis).
- N-14 [P2]: held-out budget $95; resume uses the same `--out` and the persisted run id. Accepted.
- N-15 [P2]: `init`'s reason records the $237 provenance ($2,000 authorization minus $1,763 spent across four machines' ledgers, 2026-10-03) and no other paid work runs during the plan. Accepted.
- N-16 [P2]: the dev-round screen catches only large harms; the change to drop is chosen from the per-family breakdown (facts-heavy families point to C4, tool-choice errors to C3). Accepted.
- N-13: C3 day-1 measurement includes schema-structure trimming and reports the ceiling in tokens as well as characters. Accepted; T1 stays a gate decision (the gate precedes implementation).
- N-1/N-2 and Codex's closing note: reinforce CEO-UC1 and CEO-UC2. Native Eng recommends making T2 required with a predeclared effect on the gate; this upgrades CEO-T2's provisional decision from "include if budget allows" to "include" (Taste, still at the gate).

TODOS.md proposals collected from all phases (autoplan says auto-write; this run commits only the plan file per the task's instructions, so these entries are written here and go into TODOS.md with the Item 1 PR):
1. **Journal compaction** (E5). What: `budget-ledger.ts compact` snapshot. Why: open-time fold grows with the journal. Context: trigger when `status` reports fold over 1 s or file over 100 MB. Depends on: Item 1.
2. **`gbrain-verbs` cost-floor arm** (E6/T4). What: Cat 40 gbrain arm on the 7-verb surface (14k-character tool list). Why: shows the cost floor and whether descriptions are the right lever. Depends on: budget (UC2 money).
3. **Parity target** (A6). What: next wave targets cost per successful task at or below files on at least half the models. Why: −40% still leaves 2.4x.
4. **Python budget ledger** (N-10). What: route `scripts/run-retrieval-refresh.py` spend through the journal or a shared cap. Why: it is outside the guard.
5. **Paid-script dry-run mode** (DX NOT in scope). What: `PRINT_ONLY` already prints; a priced dry run would estimate each step.

#### Eng required outputs

**NOT in scope.** Changing Cat 40 tasks, scoring or baselines; the Python ledger (TODO 4); journal compaction (TODO 1); the verbs arm (TODO 2); negotiated-only lean rows, SQLite storage, contemporaneous control and the ship-rule change (User Challenges UC1-UC4, at the gate); a priced dry run (TODO 5).

**What already exists.** Listed in Step 0; reused unchanged: `withLock` file naming (extended with owner data), `BudgetAllowance`, `MeteringProxy` (extended for attribution), `holdout_stats.py` (extended), `replay.ts`, `retrievalNoticeBlocks`, `buildToolDefs`, `request_tools`.

**Failure modes registry.**

```
  CODEPATH                      | FAILURE MODE                               | RESCUED?          | TEST? | USER SEES?             | LOGGED?
  ------------------------------|--------------------------------------------|-------------------|-------|------------------------|--------
  reserve (OpenAI continuation) | reservation far below actual cost          | E-1 conservative  | Y     | none (cap holds)       | Y
  withLock                      | stale-lock steal while writer paused        | E-2 owner check   | Y     | none (refuse/retry)    | Y
  journal append                | short write / failed fsync                  | refuse further    | Y     | runner stops, message  | Y
  migration                     | crash between steps                         | dual lock + order | Y     | retry on next open     | Y
  old worker after migration    | spends against empty ledger                 | tombstone         | Y     | refusal                | Y
  cached offset                 | journal replaced/truncated                  | inode/size check  | Y     | none (refold)          | Y
  resume                        | different build reuses cells / new budget   | manifest-bound    | Y     | refusal                | Y
  slot builds                   | allowance > step budget                     | slots step        | Y     | preflight message      | Y
  proxy                         | late or unpriced provider call lost          | per-cell + charge | Y     | none                   | Y
  G2 analysis                   | incomplete coverage compared                | coverage check    | Y     | refusal                | Y
  C1 lean rows                  | agent loses create_safety -> duplicate page | E-7 keep field    | Y     | none                   | n/a
  C1 lean rows (3rd party)      | client reads a dropped field                | fields/full config| N     | missing field (silent) | N   <- WARNING (UC4)
```

0 critical gaps (every RESCUED=N row has a test or a visible message, except the third-party row, which is a known contract change behind UC4 and a host-wide escape hatch).

**Worktree parallelization.**

| Step | Modules touched | Depends on |
|---|---|---|
| A. Ledger journal + CLI + readers | gbrain-evals `eval/runner/` (budget-ledger, paid-arm, evidence-delivery), `test/eval/` | — |
| B. Cat 40 runner (resume manifest, attribution, order, uncapped, lag receipt) + analyze + stats | gbrain-evals `eval/runner/cat40*`, `docs/benchmarks/.../holdout/` | A (lag fields, cap API) |
| C. gbrain C1/C2/C4 + identity + result_rows | gbrain `src/core/ops`, `src/mcp`, `src/core/mcp-client`, `src/commands/serve-http-mcp` | — |
| D. gbrain C3 budgets + ceilings + docs | gbrain operation description files, `src/mcp/tool-defs`, `docs/` | C (the `fields` sentence) |
| E. Script + operator docs | gbrain-evals `scripts/`, `docs/` | A, B |

Lanes: Lane 1 A → B → E (gbrain-evals, shared modules, sequential). Lane 2 C → D (gbrain). Launch Lane 1 and Lane 2 together; paid runs start after both merge (Item 1 merged, Item 2 branch ready). Conflict flags: none across lanes (different repos).

**Completion summary.**
- Step 0: Scope Challenge — scope accepted as-is (structure: original arrangement, autoplan override)
- Architecture Review: 7 issues found (E-1, E-2, E-3, N-5, N-6, N-11, N-12)
- Code Quality Review: 6 issues found (N-3, N-4, N-10, E-7, N-17/18/19 grouped, stale header)
- Test Review: diagram produced, 27 gaps identified (all with planned tests)
- Performance Review: 4 issues found (E-4, E-6, E-8, N-8)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 5 items proposed (written in this plan; go into TODOS.md with the Item 1 PR)
- Failure modes: 0 critical gaps flagged (1 warning, tied to UC4)
- Unresolved decisions: 0 in this review (UC1-UC4 and T1-T4 belong to the CEO/DX gate)
- Outside voice: codex (gpt-6-astra) completed; native Capy subagent completed
- Parallelization: 2 lanes, 2 parallel / 3 sequential steps within lane 1
- Lake Score: N/A (no coverage-scored questions were asked; all auto-decided)


<!-- autoplan-accepted:eng -->
- E-1 reservation completeness: `priceRequest` counts `tools` (schemas) and OpenAI `instructions` in the input estimate; for a request with `previous_response_id`, the guard adds the chain's prior reported input and output tokens (kept in memory per response id; an unknown id reserves the model's full context window); when a provider has a cache-write price above the input price, the reservation prices all input at the higher of the two. `settle` records any overshoot (`actual > reserved`) in the fold and `RunSummary` as `overshoot_usd`, and the next reserve counts it. Verify: tests where an Anthropic request with tools and an OpenAI continuation chain report costs that stay within their reservations.
- E-2 owner-checked lock (with N-7): the lock file holds `{pid, host, nonce, created_at}`; a waiter takes over only when the owner is on this host and its pid is gone, or after the stale window when the owner's nonce is unchanged and its pid is gone; release deletes the lock only if the nonce matches. Appends use an `O_APPEND` descriptor; a short write retries the remainder; a failed fsync makes the process refuse further spending; a holder truncates only back to the offset it verified itself; journal creation and migration fsync the directory. Verify: a suspended-writer test (pause between check and append, expire, second writer spends, first resumes) never overshoots; injected short-write and fsync-failure tests.
- E-3 manifest-bound runs: each `--out` directory holds `experiment.json` (gbrain commit, world digest, models, arms, label, every flag except `--budget-usd`, and the budget run id). A rerun with a different manifest refuses; a changed build gets a new `--out`; a resume joins the recorded budget run (`--budget-run-id`) instead of opening a new one, so a timeout restart does not get a fresh step budget. Verify: runner tests for both refusals and for the joined resume.
- E-4 slot builds: the script runs a `slots` step before any agent step (its own `--budget-usd`, `--slot-build-allowance-usd 2`, builds serialized), and every agent step preflights that all slot snapshots for its build and world exist and refuses otherwise. Verify: a cold-start preflight test.
- E-5 coverage: the ladder schedules complete model batches (all 50 tasks of one model before the next; a new `--order model` flag, default unchanged); G2 analysis refuses unless both sides have unique, complete `(model, task, repeat)` coverage; T2's comparison restricts both sides to its two models; cells that failed for non-budget reasons are rerun through resume before analysis; an unfinished batch is reported separately. `holdout_stats.py` enforces the coverage check. Verify: stats tests on an incomplete fixture.
- E-6 cost attribution: proxy meters are keyed by cell id and finalized after the cell's in-flight provider requests drain (after restore); unpriced proxy calls are charged at their reservation and counted; analysis reconciles the sum of cell `total_usd`, judge cost and slot builds against the ledger run's spend and flags a gap over 1%. Verify: a delayed-request attribution test and the reconciliation check in `analyze.ts`.
- E-7: lean rows keep `evidence` and `create_safety` (the duplicate-page guard, `src/core/search/evidence.ts`). Verify: the existing duplicate-prevention cases pass on projected remote rows.
- E-8: the latency comparator replays at one agent per slot with the run's slot count in parallel (five), not two per slot; receipts record per-cell `restore_ms`. Supersedes DX's "2 agents per slot" wording. Verify: replay script option and receipt field.
- N-3 creation rule: `BudgetRun.open` creates a missing journal only when an explicit cap is passed or the path is the default (then $500); `join`, `reserve` and any other missing journal refuse with the `init` command. Test setups that change are listed in the Item 1 PR as exceptions to "assertions unchanged".
- N-4 caps are `number | null` through `budgetOptionsFrom`, `BudgetRun.open/join`, `ledgerStatus`, `requirePaidArm` (`eval/runner/paid-arm.ts:47`) and the CLI; a manifest cap (`evidence-delivery.ts:105`) is an upper limit (refuse when the recorded cap is higher), not a value that must match. The test at `budget-ledger.test.ts:225` asserting `programCapUsd: 500` is a listed exception. Verify: tests for each caller.
- N-5 migration order: the migrator holds both `ledger.json.lock` and the journal lock; it writes and fsyncs the journal (temp then rename), copies the legacy file to `ledger.json.migrated` and fsyncs it, then atomically renames the tombstone over `ledger.json`, so the legacy path is never missing. Supersedes the CEO "rename legacy" wording. Verify: kill-point tests after each step.
- N-6 offset check: under the lock, a process compares the journal's dev, inode and size with its cached state, and checks that the byte before its offset is a newline; on any mismatch it refolds from zero. Verify: tests that replace and truncate the journal under a live process.
- N-8 perf: CI asserts scale invariance (reserve+settle at 250k events within 2x of 1k events, fsync excluded); the 5 ms average is measured and reported on the run machine in the Item 1 PR with fsync time shown separately; `status` reports cold-fold time and hints at compaction above 100 MB.
- N-9: every test file that references `ledger.json` (14 found) is inventoried and its assertions point at the resolved journal path, so none passes vacuously.
- N-10: the reader inventory names its exclusions (`bug-ledger.ts`, `system-one/recount.ts`, `scripts/run-retrieval-refresh.py`); a journal whose first line is not `ledger_open` refuses.
- N-11: C1's projection runs at the end of `evidenceOutput` in `src/core/ops/search.ts`, after capture, response meta and `bumpLastRetrievedAt` have read full rows; an `OperationContext.resultRows` field (`lean` | `full`) is set by both gbrain transports and defaults to lean when unset and `remote !== false`.
- N-12 (supersedes DX-1's stdio clause): the thin client only uses HTTP, so the stdio `clientInfo` branch is dropped; the `X-Gbrain-Client` header is unverified and a code comment says it must never gate anything security-relevant.
- N-13: C3's day-1 measurement includes trimming schema structure (repeated enum, default and nested-object text) and reports the ceiling in tokens as well as characters.
- N-14: held-out step budget $95; a partial held-out run resumes with the same `--out` and recorded run id.
- N-15: `init` records the $237 provenance in its reason ($2,000 authorization minus $1,763 spent across four machines' ledgers, 2026-10-03); no other paid work runs while this plan spends.
- N-16: the dev-round screen is documented as catching only large harms; when it fails, the change to drop is chosen from the per-family breakdown.
- N-17/N-18/N-19: the lag monitor stops in `finally`; `status` reads an unmigrated legacy file read-only; `migrate --finish` has a CLI spec, `--help` entry and tests; a non-schema-1 legacy file beside a journal refuses with a message; C2's error-envelope test churn and an E3 re-pin procedure are documented in the gbrain PR.
- Test plan artifact: `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-followups-eng-review-test-plan-20261003.md` lists every test above with value cards.
- TODOS.md entries 1-5 from the Eng record go into gbrain-evals `TODOS.md` with the Item 1 PR.
- C5 (parent instruction, GBRA-40): search skips each #5932 lookup cheaply when there is nothing to find. (a) Profile first: under the scale harness, time the saved-facts query, the declaration scan and fan-out search, `probeProjectionReadiness` and `hasUnsealedPagesInScope` per search, and record the split in the PR; if a stage other than the two named dominates, report it to Garry and GBRA-40 rather than widening C5. (b) Saved facts: before the `LIKE ANY` query, an indexed `EXISTS` probe for any active fact in the caller's sources (same `expired_at`, `valid_until` and remote-visibility predicates) skips the query when it finds none; a per-process cache of that bit is allowed only with invalidation on every fact write, forget or expiry through the dispatch mutating path and a TTL of at most 2 s for writes from other processes, so a fresh `remember` is never hidden. (c) Fan-out: `aliasDeclarations` runs once per search and its result is reused by the fan-out and the response meta; before the regex it checks the lowercased `chunk_text` of the top 10 rows for any declaration keyword (`account code`, `also known as`, `a.k.a`, `aka`, `short name`, `ticker`, `code name`) and returns no declarations when none appears; the regex still decides when one does. (d) Verify: `bun scripts/scale/run.ts --pages 10000 --seed 1` on the same machine in the same session for v0.60.32.0 and the C5 build; search p50 within 10% of v0.60.32.0 (the harness fixture has no facts or declarations). Unchanged results when they exist: unit tests on a fixture with active facts and declared names show byte-identical `content[0]`, notice blocks and fan-out ordering before and after C5, plus a test that `remember` followed by `search` in the same process and from a second process returns the fact. (e) The harness lives on `capy/fix-wave-8`: if wave 8 merges first, rebase `cat40-cost-wave` onto master and take the next patch version after v0.60.36.0; otherwise run the harness from a fix-wave-8 worktree against this build. Coordinate landing order with the fix-wave-8 thread. (f) C5 ships in the same gbrain PR, lands before dev round 1 (it changes no model-visible output), and costs $0.
<!-- /autoplan-accepted:eng -->

#### Eng Implementation Tasks
(JSONL: `~/.gstack/projects/garrytan-gbrain-evals/tasks-eng-review-20261003-160219.jsonl`; test plan: `~/.gstack/projects/garrytan-gbrain-evals/user-plan-cat40-followups-eng-review-test-plan-20261003.md`)

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** ledger: conservative reservation (tools, instructions, continuation chain, cache-write premium) and overshoot tracking. Verify: reservation tests for an OpenAI chain and an Anthropic request with tools.
- [ ] **T2 (P1, ~1d / ~1h)** ledger: owner-checked lock, `O_APPEND`, short-write and fsync handling, offset invalidation, dual-lock migration with tombstone. Verify: suspended-writer, fault-injection and kill-point tests.
- [ ] **T3 (P1, ~4h / ~30min)** ledger: `number | null` caps through every caller, manifest cap as upper limit, creation rule, 14-file test inventory. Verify: caller tests; no vacuous assertions.
- [ ] **T4 (P1, ~1d / ~1h)** Cat 40 runner: manifest-bound `--out` with persisted budget run, `slots` step and preflight, model-batched order, per-cell attribution and reconciliation, `restore_ms`. Verify: runner tests and cold-start preflight.
- [ ] **T5 (P1, ~2h / ~15min)** `holdout_stats.py` coverage check and new pairs. Verify: incomplete-fixture test.
- [ ] **T6 (P1, ~4h / ~30min)** gbrain: projection at the end of `evidenceOutput` with `OperationContext.resultRows`; keep `evidence`/`create_safety`; drop stdio identity branch. Verify: duplicate-prevention cases on projected rows.
- [ ] **T7 (P1, ~4h / ~30min)** gbrain C5: profile per-search stages; `EXISTS` skip for saved facts; keyword precheck and one `aliasDeclarations` call; harness p50 within 10% of v0.60.32.0. Verify: `bun scripts/scale/run.ts --pages 10000 --seed 1` A/B, byte-identical results with facts and declarations, cross-process remember→search test.
- [ ] **T8 (P2, ~1d / ~1h)** gbrain C3 day-1 measurement including structure trimming; token and character ceilings.
- [ ] **T9 (P2, ~1h / ~10min)** run plan: held-out $95, resume rule, $237 provenance, family-based drop rule.
- [ ] **T10 (P3, ~2h / ~15min)** lag monitor `finally`, read-only legacy `status`, `migrate --finish` spec, C2/E3 maintenance docs.

#### DX Implementation Tasks
(JSONL: `~/.gstack/projects/garrytan-gbrain-evals/tasks-devex-review-20261003-155102.jsonl`)

- [ ] **T1 (P1, human: ~4h / CC: ~30min)** gbrain: CLI identity via `X-Gbrain-Client` (HTTP) and `clientInfo` (stdio); `mcp.result_rows`; `_meta` rows marker. Verify: identity tests on both transports.
- [ ] **T2 (P1, ~4h / ~30min)** ledger: `init`, `verify`, `set-cap`, null cap parsing, actionable refusals, `status` hints. Verify: CLI message tests.
- [ ] **T3 (P1, ~3h / ~20min)** ledger: route every reader through the fold; tombstone migration; old-worker test. Verify: migrated campaign flow in `evidence-delivery.ts`.
- [ ] **T4 (P2, ~2h / ~15min)** `scripts/cat40-followups.sh` with validated refs, world regeneration and digest check, readable labels. Verify: `bash -n`, `PRINT_ONLY=1`.
- [ ] **T5 (P2, ~1h / ~10min)** `--max-tool-chars none`; lag field contract; analyze warning. Verify: unit tests.
- [ ] **T6 (P2, ~4h / ~30min)** docs: `docs/budget-ledger.md` + `eval/README.md` link; gbrain lean/full examples, compatibility table, human tool reference.
- [ ] **T7 (P1, ~2h / ~15min)** gbrain: keep `id`; `delivered.truncated` whenever truncated; per-tool minimum guidance table. Verify: `fetch(id)` test, return_unit tests.
- [ ] **T8 (P1, ~4h / ~30min)** gbrain: version-skew matrix. Verify: matrix tests green.
- [ ] **T9 (P3, ~30min)** time the operator path once; record in the Item 1 PR.

#### CEO Implementation Tasks
Synthesized from the CEO review's findings (JSONL: `~/.gstack/projects/garrytan-gbrain-evals/tasks-ceo-review-20261003-154438.jsonl`).

- [ ] **T1 (P1, human: ~2d / CC: ~2h)** gbrain-evals ledger: append-only journal (events, fold, cap rules, migration via temp + rename). Verify: `bun test test/eval/budget-ledger.test.ts test/eval/all-and-budget.test.ts` plus the new concurrency, torn-tail, migration, cap and perf tests.
- [ ] **T2 (P1, ~4h / ~20min)** lag monitor in `startPaidRun`; lag in `RunSummary` and `receiptCost` (incl. `n2-3-prompt-ab.ts`). Verify: calibration test.
- [ ] **T3 (P1, ~1h / ~5min)** Cat 40 uncapped by default; receipt `max_tool_chars: null`. Verify: runner test.
- [ ] **T4 (P1, ~4h / ~20min)** `analyze.ts` cost buckets summing to `total_usd`, cost per success, chars by tool. Verify: fixture test.
- [ ] **T5 (P1, ~1d / ~1h)** gbrain C1 lean rows + `fields` + sparse safety fields + CLI clientInfo exception. Verify: unit + e2e per client identity.
- [ ] **T6 (P1, ~1h / ~10min)** gbrain C2 compact JSON. Verify: updated tests; E3 ceiling fails on pretty.
- [ ] **T7 (P1, ~2d / ~2h)** gbrain C3 per-tool budgets and served-list ceilings. Verify: ceiling tests (publish_skills on/off).
- [ ] **T8 (P2, ~2h / ~15min)** gbrain C4 notice ceilings, whole items only. Verify: boundary tests.
- [ ] **T9 (P1, ~3h / ~20min)** gbrain E3 result-size ceilings on a deterministic fixture. Verify: fails on reintroduced pretty JSON.
- [ ] **T10 (P1, ~6h wall)** paid runs per the exact commands on `.budget/cat40-followups.jsonl`. Verify: receipts show cap $237, lag p99 < 50 ms.
- [ ] **T11 (P2, ~4h / ~30min)** report: per-model/family flags, stall and base-commit disclosures, new `holdout_stats.py` pairs. Verify: artifact checks.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan rule | other modes |
| 2 | CEO | Skip /office-hours offer | Mechanical | P6 | autoplan runs standard review | run office-hours |
| 3 | CEO | Item 1 approach: append-only journal | Mechanical | P1 | root cause for every paid runner | per-cell allowance; fresh ledger file |
| 4 | CEO | G2 metric = cell `total_usd`, target ≤ $0.078 | Mechanical | P5 | plan table and report used different metrics | "$0.07" undefined |
| 5 | CEO | C1 param `fields`, keep `chunk_id` | Mechanical | P5, P1 | `detail` exists; `assemble_evidence` needs `chunk_id` | `detail: "full"` |
| 6 | CEO | C3 = per-tool budgets, keep 25k target | Mechanical | P1 | caps alone save ~8k of 61k | lower target |
| 7 | CEO | Starter membership unchanged (T1) | Taste | P3 | contract-bearing set; conditional pre-approval at gate | move ops now |
| 8 | CEO | Enforce $237 via one journal's recorded cap | Mechanical | P1 | no ledger enforced the program limit | per-invocation flag |
| 9 | CEO | Latency check inside dev round 1 | Mechanical | P4 | saves ~$20 | separate paid replay |
| 10 | CEO | Item 2 code during Item 1 review | Mechanical | P6 | paid runs still wait | strict serial |
| 11 | CEO | Accept E1 uncapped default | Mechanical | P2 | contradicts no-cap rule; 2 files | keep 20k default |
| 12 | CEO | Accept E2 cost buckets | Mechanical | P2 | attribution of G2 | none |
| 13 | CEO | Accept E3 size ceilings | Mechanical | P2 | 77dcf414 +19% cost shipped silently | none |
| 14 | CEO | Accept E4 shared lag monitor | Mechanical | P2, P4 | every paid runner | Cat 40 only |
| 15 | CEO | Defer E5 compaction, E6 verbs arm | Mechanical | P3 | not needed for G1; no budget | include |
| 16 | CEO | Skip E7 worker thread | Mechanical | P5 | journal removes need | include |
| 17 | CEO | Spec-review launch 1 fixes (22) | Mechanical | P1, P5 | see 0H table | none |
| 18 | CEO | Held-out before ladder; per-step budgets | Mechanical | P1 | gate run protected | ladder first |
| 19 | CEO | T2 re-baseline provisional include | Taste | P1 | baseline ran under the stall | disclose only |
| 20 | CEO | Spec-review launch 2 fixes (23) | Mechanical | P1, P5 | see 0H record | none |
| 21 | CEO | Spec-review launch 3 fixes (applied, not re-reviewed) | Mechanical | P1 | three-launch cap reached | leave open |
| 22 | CEO | 0H document approval A | Mechanical | P6 | autoplan | revise/pause |
| 23 | CEO | Ship-rule power → User Challenge UC1 | User Challenge | n/a | both voices + spec review | auto-decide |
| 24 | CEO | Ladder → contemporaneous control → UC2 | User Challenge | n/a | both voices | auto-decide |
| 25 | CEO | Journal vs SQLite/allowance → UC3 | User Challenge | n/a | both voices | auto-decide |
| 26 | CEO | Negotiated lean rows → UC4 | User Challenge | n/a | both voices | auto-decide |
| 27 | CEO | C4 kept, no cut inside an item (T3) | Taste | P1 | Codex-only challenge | drop C4 |
| 28 | CEO | E6 stays deferred unless UC2 frees money (T4) | Taste | P3 | both voices want it | include now |
| 29 | CEO | A1 gbrain CLI gets full rows by clientInfo | Mechanical | P1, P5 | simpler than tools/list probing | thin client sends `fields` |
| 30 | CEO | A2 per-model/family flags; A3 cost per success; A4 partial-ladder rule | Mechanical | P1 | reporting only | none |
| 31 | CEO | Migration via temp journal + rename order | Mechanical | P1 | Section 2 GAP | rename legacy first |
| 32 | CEO | Defer A6 parity target to TODOS | Mechanical | P3 | next wave | include |
| 33 | DX | Mode DX POLISH; persona agent operator; product type MCP server + CLI | Mechanical | override, P6 | autoplan rules; gbrain docs address agents first | other personas |
| 34 | DX | TTHW target Competitive (< 5 min, 3 commands) | Mechanical | P5 | fewer steps | Champion (needs dry-run mode) |
| 35 | DX | Magical moment via `status` JSON + tool description | Mechanical | P5 | lowest-effort existing vehicle | new surface |
| 36 | DX | DX-1 header-based CLI identity | Mechanical | P5, P1 | stateless HTTP has no clientInfo | clientInfo only |
| 37 | DX | DX-2 `mcp.result_rows` + `_meta` marker + description sentence | Mechanical | P1 | escape hatch principle | per-response notice text (costs tokens) |
| 38 | DX | DX-3/4 `init` and null cap parsing | Mechanical | P1 | false cap-mismatch alarms | adopt from legacy file |
| 39 | DX | DX-5 reader inventory + tombstone | Mechanical | P1 | old workers would split accounting | rename only |
| 40 | DX | DX-6/7 actionable refusals, `verify`, `set-cap` contract | Mechanical | P1 | override rule: problem + cause + fix | runbook-only |
| 41 | DX | DX-8/9/10/11 script, labels, `none` spelling, lag contract | Mechanical | P5 | copy-paste, readable receipts | placeholders |
| 42 | DX | DX-12 docs | Mechanical | P1 | operator guide + examples | CHANGELOG only |
| 43 | DX | DX-13/15 keep truncation flag and `id` | Mechanical | P1 | hidden truncation; deep-research fetch | drop |
| 44 | DX | DX-14 minimum guidance per tool | Mechanical | P1 | size alone is not meaning | size-only |
| 45 | DX | DX-16/17/18 skew matrix, downgrade rule, timed path | Mechanical | P1 | upgrade safety | none |
| 46 | DX | Negotiated-only lean rows stays with UC4 | User Challenge | n/a | Codex DX repeats CEO concern | auto-decide |
| 47 | Eng | Scope accepted as-is; structure original arrangement | Mechanical | P2 override | files are where behavior lives | smaller arrangement |
| 48 | Eng | E-1 conservative reservation (tools, instructions, continuation, cache-write) | Mechanical | P1 | cap could be exceeded | storage-only fix |
| 49 | Eng | E-2/N-7 owner-checked lock, O_APPEND, fsync failure refuses | Mechanical | P1 | lock steal race | age-based takeover |
| 50 | Eng | E-3 manifest-bound runs, persisted budget run | Mechanical | P1 | resume mixed builds and reset budgets | label-only keys |
| 51 | Eng | E-4 slots step + preflight | Mechanical | P1 | $25 allowances vs $18 budgets | implicit cache |
| 52 | Eng | E-5 complete-coverage gate, model-batched ladder | Mechanical | P1 | partial runs gave invalid comparisons | average what exists |
| 53 | Eng | E-6 per-cell attribution + reconciliation | Mechanical | P1 | lost and unpriced calls | take meter early |
| 54 | Eng | E-7 keep evidence and create_safety | Mechanical | P1 | duplicate-page guard | drop |
| 55 | Eng | E-8 comparator at one agent per slot; restore_ms | Mechanical | P5 | pool is exclusive | 2 per slot |
| 56 | Eng | N-3..N-19 creation rule, null caps, migration order, offset check, perf, inventories, placement, stdio drop, C3 trimming, budgets, provenance | Mechanical | P1, P5 | see Eng record | as drafted |
| 57 | Eng | T2 upgraded to "include" (still Taste at gate) | Taste | P1 | both Eng voices | provisional |
| 58 | Eng | TODOS.md entries written in plan, not TODOS.md | Mechanical | task instruction | parent asked for the plan file only | auto-write TODOS.md |
| 59 | Eng | C5 added from parent input (GBRA-40) | Mechanical (directed) | n/a | parent instruction | none |

### Phase 4: Final approval gate (stopped here for Garry)

Pre-gate verification: CEO (premise challenges, Sections 1-10 plus Section 11 skip, Error & Rescue and Failure Modes registries, NOT in scope, What already exists, dream state delta, Completion Summary, consensus table), DX (8 scored dimensions, journey map, empathy narrative, TTHW and target, checklist, consensus table) and Eng (scope challenge, architecture diagram, codepath-to-test diagram, test plan on disk, NOT in scope, What already exists, failure modes, Completion Summary, consensus table) are all present above. Native and Codex voices completed in all three phases. Design was skipped (no UI scope). Every auto-decision has an audit row. Review logs (`gstack-review-log`) are written on approval, so none are written yet.

**Plan summary.** Item 1 replaces the rewrite-the-world budget ledger with an append-only journal (persisted program cap, safe migration, owner-checked lock, lag monitor in every receipt) so harness timing is honest and the $237 left of the $2,000 authorization is enforced by the ledger. Item 2 is one gbrain patch PR (C1 lean rows, C2 compact JSON, C3 schema budgets, C4 notice ceilings, C5 search-latency skips) measured on Cat 40 with a −40% cost target and no measurable success loss.

**Decisions: 59 logged. 48 auto-decided, 4 Taste, 4 User Challenges, 1 directed by the parent (C5).**

**User Challenges (both models disagree with the stated direction; original direction stands unless Garry changes it):**
- **UC1, the ship rule** (CEO; reinforced by Eng and the spec reviewer). You said: drop any change whose paired 95% CI lower bound is below −3 points. Both models recommend: one bundle-level rule at the held-out run, dev rounds as a harm screen only, and a power check on existing per-task data before spending; then a −5 margin or more repeats. Why: the held-out comparison of two builds that differ only in JSON whitespace had CI −3.7 to +1.8, so a harmless wave fails −3 roughly 40% of the time, C2's own evidence fails it, and per-change CIs are never measured. Blind spot: a wider margin admits a real 3-4 point loss. Cost if wrong: either a good wave is blocked by noise (current rule) or a small real loss ships (wider margin). Recommendation: bundle-level rule with a −5 margin, reporting the −3 result beside it.
- **UC2, the 11-model ladder** (CEO; reinforced by Eng). You said: run the 11-model dev ladder (~$106) after the held-out run. Both models recommend: spend that money on a contemporaneous held-out control (base `566a242a`, 6 models × 2 repeats, ~$80, under the new ledger) paired with the candidate, and run the ladder only with what is left, in complete model batches. Why: the `77dcf414` baseline ran under the ledger stall and lacks the master alias change, so the gate compares unlike conditions; the ladder gates nothing. Blind spot: the report loses fresh 11-model dev-world numbers (the published format). Cost if wrong: the G2 verdict rests on a biased baseline. Recommendation: adopt it (it also makes T2 unnecessary).
- **UC3, journal versus SQLite** (CEO; Eng added locking and offset work that strengthens it). You said: an append-only JSONL journal. Both models recommend justifying it against `bun:sqlite` in WAL mode (native) or the existing `BudgetAllowance` (Codex). Why: the journal now needs an owner-checked lock, offset and inode checks, torn-tail rules, a tombstone migration and a deferred compaction; SQLite with `BEGIN IMMEDIATE` provides crash safety and cross-process serialization built in. Blind spot: a binary file is not greppable (the CLI covers it) and SQLite on network filesystems is unsafe (ledgers are local). Cost if wrong: more custom concurrency code to own. Recommendation: switch Item 1's storage to `bun:sqlite` WAL, keeping every accepted CLI, cap, migration-tombstone and test requirement.
- **UC4, lean rows by default** (CEO; reinforced by DX Codex). You said: lean rows for remote callers by default, with `fields: "full"`. Both models recommend negotiated lean rows (opt-in, or legacy rows for existing clients). Why: third-party integrations silently lose fields on a host upgrade. Blind spot: opt-in means default agents, the main remote callers, get no savings, which defeats "eval winners ship on by default". Cost if wrong: an external integration reads `undefined` until it sets `fields` or the host sets `mcp.result_rows: full`. Recommendation: keep your direction (lean default) with the escape hatches already accepted (per-call `fields`, host `mcp.result_rows`, gbrain CLI header).

**Taste decisions (auto-decided provisionally):**
- **T1, starter membership (CEO).** Recommend approving the conditional pre-approval: if per-tool budgets cannot reach the 25k schema target, move the skill-admin and write-request ops behind `request_tools` (P1: the arithmetic leaves ~330 characters per tool otherwise). Alternative: no membership change; the ceiling pins the achieved size. Note: Cat 40 freezes the tool list per session, so it cannot test discovery, but its tasks never use those ops.
- **T2, re-baseline `77dcf414` on a held-out subset (~$11) (CEO, upgraded by Eng).** Recommend include, unless UC2 is approved (then it is moot). Alternative: disclose the bias only.
- **T3, keep C4 (CEO, Codex-only challenge).** Recommend keeping C4 with whole-item truncation (your direction; dev round 2 shows its size via E2). Alternative: drop C4 from this wave.
- **T4, 7-verb surface measurement (CEO).** Recommend defer to TODOS unless UC2 frees money, then include as a dev-round measurement (~$16). Alternative: include now (squeezes the held-out margin).

**Review scores.** CEO: 9 native issues, 8 Codex concerns, consensus 6/6 confirmed concerns. DX: 4/10 → 7/10, TTHW ~10+ min → <5 min (estimated), 11 native, 7 Codex, 6/6. Eng: 20 native, 8 Codex, 6/6; 0 critical gaps, 1 warning (UC4). Design: skipped (no UI scope).

**Cross-phase themes.** (1) Lean-row compatibility: CEO UC4, DX (identity over HTTP, `mcp.result_rows`, `id`), Eng (`evidence`/`create_safety`). (2) Ledger correctness under the cap: CEO spec review (persisted cap), DX (init, null caps, tombstone), Eng (reservation completeness, lock ownership, migration window). (3) Measurement validity: CEO and Eng (underpowered gate, biased baseline, coverage, attribution). (4) C3 feasibility: CEO spec review and Eng (25k likely needs T1).

**Deferred to TODOS.md** (written with the Item 1 PR): journal compaction; `gbrain-verbs` arm; parity target; Python budget ledger under the guard; priced dry run.

#### Implementation Tasks (aggregated across phases)

- [ ] **T3 (P1, human: ~1h / CC: ~5min) — gbrain-evals/cat40** — Uncapped tool results by default; receipt max_tool_chars null
  - Surfaced by: ceo-review — E1
  - Files: eval/runner/cat40/loop.ts, eval/runner/cat40-model-ladder.ts
- [ ] **T4 (P1, human: ~4h / CC: ~20min) — gbrain-evals/cat40** — Cost buckets summing to total_usd, cost per success, tool chars by tool
  - Surfaced by: ceo-review — E2, A3
  - Files: eval/runner/cat40/analyze.ts
- [ ] **T2 (P1, human: ~4h / CC: ~20min) — gbrain-evals/ledger** — Lag monitor in startPaidRun, lag in RunSummary and receiptCost (incl. n2-3-prompt-ab)
  - Surfaced by: ceo-review — E4
  - Files: eval/runner/budget-ledger.ts, eval/runner/n2-3-prompt-ab.ts
- [ ] **T1 (P1, human: ~2d / CC: ~2h) — gbrain-evals/ledger** — Replace ledger.json with the append-only journal (events, fold, cap rules, migration via temp+rename)
  - Surfaced by: ceo-review — Step 0 + spec review: journal design, cap persistence, migration
  - Files: eval/runner/budget-ledger.ts, test/eval/budget-ledger.test.ts, test/eval/all-and-budget.test.ts
- [ ] **T10 (P1, human: ~6h wall / CC: ~6h wall) — gbrain-evals/runs** — Paid runs: dev rounds, T2, held-out, ladder with exact commands on one journal
  - Surfaced by: ceo-review — Measurement, A4
  - Files: 
- [ ] **T7 (P1, human: ~2d / CC: ~2h) — gbrain/mcp** — Per-tool schema budgets; served starter ceiling test; instructions ceiling
  - Surfaced by: ceo-review — C3
  - Files: 
- [ ] **T6 (P1, human: ~1h / CC: ~10min) — gbrain/mcp** — Compact JSON in content[0]; update pretty-output tests
  - Surfaced by: ceo-review — C2
  - Files: src/mcp/dispatch.ts
- [ ] **T5 (P1, human: ~1d / CC: ~1h) — gbrain/search** — Lean rows for remote callers with fields param, sparse safety fields, CLI clientInfo exception
  - Surfaced by: ceo-review — C1, A1
  - Files: src/core/ops/search.ts, src/mcp/dispatch.ts, docs/architecture/thin-client.md
- [ ] **T9 (P1, human: ~3h / CC: ~20min) — gbrain/tests** — Size ceilings for canonical search/query results on a deterministic fixture
  - Surfaced by: ceo-review — E3
  - Files: 
- [ ] **T4 (P1, human: ~1d / CC: ~1h) — gbrain-evals/cat40** — Manifest-bound --out with persisted budget run; slots step and preflight; model-batched order; per-cell attribution and reconciliation; restore_ms
  - Surfaced by: eng-review — E-3, E-4, E-5, E-6, E-8
  - Files: eval/runner/cat40-model-ladder.ts, eval/runner/cat40/gbrain-arm.ts, eval/runner/cat40/analyze.ts
- [ ] **T2 (P1, human: ~1d / CC: ~1h) — gbrain-evals/ledger** — Owner-checked lock, O_APPEND writes, short-write/fsync handling, offset invalidation, dual-lock migration with tombstone
  - Surfaced by: eng-review — E-2, N-5, N-6, N-7
  - Files: eval/runner/budget-ledger.ts
- [ ] **T3 (P1, human: ~4h / CC: ~30min) — gbrain-evals/ledger** — number|null caps through every caller; manifest cap as upper limit; creation rule; test inventory (14 files)
  - Surfaced by: eng-review — N-3, N-4, N-9, N-10
  - Files: eval/runner/paid-arm.ts, eval/runner/evidence-delivery.ts, eval/runner/budget-ledger.ts
- [ ] **T1 (P1, human: ~1d / CC: ~1h) — gbrain-evals/ledger** — Conservative reservation: tools, instructions, continuation chain, cache-write premium; overshoot tracking
  - Surfaced by: eng-review — E-1
  - Files: eval/runner/budget-ledger.ts, test/eval/budget-ledger.test.ts
- [ ] **T5 (P1, human: ~2h / CC: ~15min) — gbrain-evals/stats** — holdout_stats.py complete-coverage check and new pairs
  - Surfaced by: eng-review — E-5
  - Files: docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py
- [ ] **T6 (P1, human: ~4h / CC: ~30min) — gbrain/search** — Projection at end of evidenceOutput with OperationContext.resultRows; keep evidence/create_safety; drop stdio identity branch
  - Surfaced by: eng-review — E-7, N-11, N-12
  - Files: src/core/ops/search.ts, src/core/operations.ts, src/mcp/http-transport.ts, src/mcp/server.ts
- [ ] **T7 (P1, human: ~4h / CC: ~30min) — gbrain/search** — C5: profile per-search stages; EXISTS skip for saved facts; keyword precheck and single aliasDeclarations call; scale harness within 10% of v0.60.32.0
  - Surfaced by: eng-review — C5 (parent, GBRA-40)
  - Files: src/core/ops/search.ts
- [ ] **T2 (P1, human: ~4h / CC: ~30min) — gbrain-evals/ledger** — init/verify/set-cap commands, null cap parsing, actionable refusals, scriptable status
  - Surfaced by: devex-review — DX-3, DX-4, DX-6, DX-7
  - Files: eval/runner/budget-ledger.ts
- [ ] **T3 (P1, human: ~3h / CC: ~20min) — gbrain-evals/ledger** — Route all ledger readers through the fold; tombstone migration; old-worker test
  - Surfaced by: devex-review — DX-5
  - Files: eval/runner/evidence-delivery.ts, eval/runner/budget-ledger.ts
- [ ] **T1 (P1, human: ~4h / CC: ~30min) — gbrain/mcp** — CLI identity by X-Gbrain-Client header (HTTP) and clientInfo (stdio); mcp.result_rows host config; _meta rows marker
  - Surfaced by: devex-review — DX-1, DX-2
  - Files: src/core/mcp-client.ts, src/commands/serve-http-mcp.ts, src/mcp/dispatch.ts, src/core/ops/search.ts
- [ ] **T7 (P1, human: ~2h / CC: ~15min) — gbrain/search** — Keep id and delivered.truncated whenever truncated; per-tool minimum guidance table
  - Surfaced by: devex-review — DX-13, DX-14, DX-15
  - Files: src/core/ops/search.ts
- [ ] **T8 (P1, human: ~4h / CC: ~30min) — gbrain/tests** — Version-skew matrix (client x host x transport x strict reject)
  - Surfaced by: devex-review — DX-16
  - Files: 
- [ ] **T11 (P2, human: ~4h / CC: ~30min) — gbrain-evals/report** — Report: per-model/family flags, stall disclosure, base-commit disclosure, holdout_stats pairs
  - Surfaced by: ceo-review — A2, G2 stats
  - Files: docs/benchmarks/2026-10-02-model-ladder.md
- [ ] **T8 (P2, human: ~2h / CC: ~15min) — gbrain/mcp** — Notice-block ceilings without cutting inside an item
  - Surfaced by: ceo-review — C4, T3
  - Files: src/mcp/dispatch.ts
- [ ] **T9 (P2, human: ~1h / CC: ~10min) — gbrain-evals/runs** — Held-out budget 5, resume rule, 37 provenance in init reason, family-based drop rule
  - Surfaced by: eng-review — N-14, N-15, N-16
  - Files: scripts/cat40-followups.sh
- [ ] **T8 (P2, human: ~1d / CC: ~1h) — gbrain/mcp** — C3 day-1 measurement incl. structure trimming; token and character ceilings
  - Surfaced by: eng-review — N-13
  - Files: 
- [ ] **T6 (P2, human: ~4h / CC: ~30min) — docs** — docs/budget-ledger.md + eval/README link; gbrain lean/full examples, compatibility table, human tool reference
  - Surfaced by: devex-review — DX-12
  - Files: docs/budget-ledger.md, eval/README.md
- [ ] **T5 (P2, human: ~1h / CC: ~10min) — gbrain-evals/cat40** — --max-tool-chars none; lag field contract and analyze warning
  - Surfaced by: devex-review — DX-10, DX-11
  - Files: eval/runner/cat40-model-ladder.ts, eval/runner/cat40/analyze.ts
- [ ] **T4 (P2, human: ~2h / CC: ~15min) — gbrain-evals/runs** — scripts/cat40-followups.sh with validated refs, world regeneration and digest check
  - Surfaced by: devex-review — DX-8, DX-9
  - Files: scripts/cat40-followups.sh
- [ ] **T10 (P3, human: ~2h / CC: ~15min) — gbrain-evals/ledger** — Lag monitor finally; read-only legacy status; migrate --finish spec; C2 envelope churn and E3 re-pin docs
  - Surfaced by: eng-review — N-17, N-18, N-19
  - Files: eval/runner/budget-ledger.ts
- [ ] **T9 (P3, human: ~30min / CC: ~5min) — gbrain-evals/ledger** — Time the operator path once and record it in the Item 1 PR
  - Surfaced by: devex-review — DX-18
  - Files: 

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan) | Scope & strategy | 1 (not persisted: logged on approval) | ISSUES OPEN | 7 proposals, 4 accepted, 2 deferred; 0 critical gaps |
| Outside Review | Codex `gpt-6-astra`, CEO + DX + Eng phases | Independent 2nd opinion | 3 | completed | 23 findings (8 CEO, 7 DX, 8 Eng); all dispositioned; 4 raised to User Challenges |
| Eng Review | `/plan-eng-review` (via /autoplan) | Architecture & tests (required) | 1 (not persisted: logged on approval) | ISSUES OPEN | 17 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped (no UI scope) | — |
| DX Review | `/plan-devex-review` (via /autoplan) | Developer experience gaps | 1 (not persisted: logged on approval) | ISSUES OPEN | score: 4/10 → 7/10, TTHW: ~10+ min → <5 min |

- **OUTSIDE COVERAGE:** codex, CEO phase: completed (8 concerns). codex, DX phase: completed (7 concerns). codex, Eng phase: completed (8 concerns). Design phase: skipped (no UI scope).
- **CROSS-MODEL:** native Capy subagents (model reported as anthropic/claude-opus-5-5) and Codex (`gpt-6-astra`) agreed on all 18 consensus dimensions across the three phases; they differed in remedies (SQLite vs allowance for UC3; full control vs required T2 for UC2).
- **VERDICT:** No review is CLEAR: CEO, DX and Eng carry open User Challenges and Taste decisions for the final gate. Eng review required (re-run after the gate if UC2 or UC3 is approved, since both change the plan).

**UNRESOLVED DECISIONS:**
- UC1 ship rule: bundle-level −5 margin vs the stated per-change −3 rule
- UC2 replace most of the 11-model ladder with a contemporaneous held-out control on `566a242a`
- UC3 `bun:sqlite` WAL instead of the JSONL journal
- UC4 negotiated lean rows instead of lean by default
- T1 conditional pre-approval to move rarely used ops behind `request_tools`
- T2 re-baseline `77dcf414` on a held-out subset
- T3 keep C4 with whole-item truncation
- T4 7-verb surface measurement
