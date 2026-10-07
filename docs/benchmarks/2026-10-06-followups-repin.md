# Re-pin to gbrain v0.60.104.0 (`a865f8f`): N1-7 fixed, nothing else moved; the v0.60.95.0 step brought relationship and multi-hop gains

**Finding, 2026-10-07.** This repository pins gbrain `a865f8f` (v0.60.104.0). The round first moved the pin from `739e5cc` (v0.60.46.0) to `c5fb0201` (v0.60.95.0), 78 merges that include the nine held-out-program plans. That step brought one regression, ledger entry **N1-7**: under CPU contention, gbrain's maintenance sweep made acknowledged ontology observations unreadable. gbrain #6265 fixed it, and the pin moved again to `a865f8f`, nine merges later, under a dated [amendment](2026-10-06-followups-repin-preregistration.md#2026-10-07-re-pin-to-a865f8f-for-the-n1-7-fix) committed before the reruns. At `a865f8f`:

- **N1-7 is fixed.** Its keyless repro passes, and N1-ci passes unpinned and pinned to one core (0 acknowledged writes lost, 64 of 64 current values, 0 stale values served), as well as in GitHub CI.
- **Nothing else this repository measures moved.** On paired 16-core VMs, every offline-tier category reports the same verdict and the same numbers at `c5fb0201` and `a865f8f`. The exceptions are timing and N6, whose harness needed one more fix ([below](#a865f8f-the-n6-oracle-probes-on-open_loops-were-the-harness-again)). All 28 ledger repros and every preregistered check pass at both pins. Cat 7 ran slower on the first `a865f8f` VM, but the preregistered paired repeat reversed it (`a865f8f` was 13% to 44% faster on every operation), so it is not a regression.

The `739e5cc` to `c5fb0201` step improved two categories sharply, as the plans predicted:

- **Composed multi-hop questions (N9).** With relationship retrieval on, gbrain now answers 61.9% of 375 composed two- and three-hop question runs with every needed page in the top ten, against 2.7% before (222 runs better, 0 worse). This is the P7 multi-relation planner, on by default since v0.60.60.0.
- **Dated relationships (temporal edges).** Current-employer precision rose from 0.34 to 1.00 and the trap score (investments and alumni meetings that must not change who someone works for) from 0.45 to 1.00. This is P1, on by default since v0.60.57.0.

The `get_timeline` latency regression from Foundations 1 (ledger entry Cat7-1) stays open under its frozen closure rule: Cat 7's `get_timeline` p50 at 1,000 pages ranged from 0.071 to 0.115 ms across this round's VMs at `c5fb0201` and `a865f8f`, against a 0.056 ms bar.

Evidence class: regression check, $0 of provider spend. The `739e5cc` and `c5fb0201` runs were at gbrain-evals `6155609`. The `c5fb0201` and `a865f8f` runs were at `bd748cb` and `7cfca65` (the same tree apart from `package.json` and `bun.lock`), each pair on two identical Ubicloud `standard-16` VMs started together, with no provider key ([preregistration](2026-10-06-followups-repin-preregistration.md), committed before the runs). The paid results of the round were measured at `c5fb0201` and are not rerun. None of them uses the ontology together with the maintenance sweep, the path N1-7 broke.

## N1-7: acknowledged ontology writes lost after a maintenance sweep (fixed in `a865f8f`)

**Fixed.** gbrain [#6265](https://github.com/garrytan/gbrain/pull/6265), merged as `a865f8f` (v0.60.104.0), stops the sweep from fencing and retiring ontology observations. At `a865f8f` the repro passes ([output](2026-10-06-followups-repin/n1-7/repro-a865f8f.json)), and N1-ci passes on this 4-core machine both unpinned and pinned to one core: 0 writes lost, 64 of 64 current values, 0 stale, history retained 1.0 ([unpinned](2026-10-06-followups-repin/n1-7/n1-ci-a865f8f-unpinned.json), [one core](2026-10-06-followups-repin/n1-7/n1-ci-a865f8f-contended.json)). It also passes in GitHub CI's `checks` job. The ledger entry is closed as fixed. The rest of this section records the bug as found at `c5fb0201`.

**What happens.** `gbrain serve` runs a maintenance sweep after about 3 seconds without input. Since gbrain `7007ba60` ([#6024](https://github.com/garrytan/gbrain/pull/6024), v0.60.53.0) the sweep's facts reconcile first moves every fact row without a row number onto its entity page's `## Facts` table. Ontology observations (`ontology_propose`, such as "Alder's location is Viseu from 2021") are stored as fact rows without a row number, so the sweep moves them too: their source becomes the page, and they now belong to the page's table. The next ordinary rewrite of that page, which doesn't list them, plus one more sweep, retires them, and `ontology_get` returns nothing.

**Why the VMs missed it.** N1-ci writes its ledger as fast as the machine allows. On an unloaded machine no 3-second gap opens between writes, so the sweep never runs mid-ledger. On GitHub's 4-core runner, with another category running beside it, gaps open and N1-ci loses 1 acknowledged write and fails its current-value and history floors, on both CI runs of this branch. Pinned to one core here, it loses 1 to 3 per run at `c5fb0201` and none at `739e5cc` (two runs each).

**Evidence.**
- Keyless repro [`repros/n1-7-sweep-fences-ontology.ts`](2026-10-06-followups-repin/repros/n1-7-sweep-fences-ontology.ts): one observation, `gbrain sweep --once`, a page rewrite, another sweep. It passes at `739e5cc` and `1da881a3` and fails at `7007ba60`, `c5fb0201` and gbrain master `5b58910` (v0.60.102.0). [Outputs](2026-10-06-followups-repin/n1-7/).
- Bisection with N1-ci pinned to one core, two runs per commit, over gbrain's first-parent history and then inside #6024 and its lane D: last good `1da881a3`, first bad `7007ba60`, "fix(facts): the extract_facts cycle phase fences row_num-NULL facts itself (#5299)". [Every run](2026-10-06-followups-repin/n1-7/bisect-summary.txt).
- The failing GitHub CI receipt and the contended receipts at each end are in [`n1-7/`](2026-10-06-followups-repin/n1-7/).

**A second symptom, same cause.** In 5 of the 24 contended bisection runs at commits that contain `7007ba60`, and in none of the 40 runs without it, N1-ci also served a superseded `## Facts` value: 6 stale current-value probes on chain `fence-5-employer`, through `recall` and `search`. It shows only where the sweep runs, and 0 stale values are served at `a865f8f`, so the ledger records it under N1-7, not as a separate entry.

N1-ci kept gating throughout; nothing in its rules changed.

## What the check covers

gbrain is a memory system for agents: notes stay Markdown files, and a database index answers searches, relationships and timelines. This repository pins one gbrain commit in `package.json`, and every current-state number names the commit it was measured at. A re-pin moves that commit, so the first job is to show nothing measured here got worse.

The offline tier (`bun eval/runner/all.ts --tier offline`) runs every keyless category: 31 categories and CI slices, from search quality and provenance through privacy fuzzing, temporal reasoning, open loops and latency. The same tree ran at both pins on paired VMs, together with the 28 repros of past ledger bugs, the wave 8 and operator-wave checks, N12 at a second seed and three extra runs of the Cat7-1 repro.

## Results

The first pair of columns is the October 6 VM pair. The second pair is the October 7 VM pair (gbrain-evals `bd748cb` and `7cfca65`), which also carries the N6, N8, N12 and N7 harness changes made in between.

| Check | `739e5cc` | `c5fb0201` | `c5fb0201` (Oct 7) | `a865f8f` |
|---|---|---|---|---|
| Offline tier, categories passing their rules | 31 of 31 | 30 of 31 as run; 31 of 31 after the N6 harness fix | 31 of 31 | 30 of 31 as run; 31 of 31 after the N6 `as_of` fix |
| Ledger repros exiting 0 | 28 of 28 | 28 of 28 | 28 of 28 | 28 of 28 |
| N1-7 repro | pass | fail | fail | pass |
| N1-ci on one core | pass | fail | fail | pass |
| Wave 8 and Foundations 1 checks | pass | pass | pass | pass |
| Operator-wave checks (2026-10-04) | pass | pass | pass | pass |
| Consented embed-budget check (check C with `--yes`) | pass | pass | pass | pass |
| N12 at seed 7 | pass | pass | pass | pass |

The N1-7 repro on the October 7 VMs exited 127 because `vm/run.sh` had already left the checkout; the repro results above are from this machine ([outputs](2026-10-06-followups-repin/n1-7/)).

### From `c5fb0201` to `a865f8f`: the offline-tier diff

The verdict and every numeric field of each category's receipt were compared between the paired VMs, leaving out latency, cost and timing fields. Only two categories differ:

| Category | What differs | `c5fb0201` | `a865f8f` |
|---|---|---|---|
| N6 visibility fuzz | verdict; exposed probes (open_loops became a targeted op); oracle probes | pass; 6,490; 0 | fail as run; 6,938; 144. Pass after the harness fix: 6,938; 0 |
| Cat 28 federated sync | single-thread interleaving ratio (a timing ratio, inside its rule) | 0.311 | 0.256 |

Every other category, N1 to N13, the temporal, type-accuracy, MCP-contract and graph categories included, reports identical numbers. gbrain's search-mode definitions (`src/core/search/mode.ts`) are byte-identical at both commits. Against the recorded October 6 `c5fb0201` receipts, the other differences (N12 28 of 28, N8 privacy-gate fields, N7's `as_of` ordering flag, N9 attendance seeds) come from this repository's own harness changes and appear at both October 7 pins.

**Cat 7.** On the first pair, ten of the eleven 1,000-page operations were 18% to 35% slower on the `a865f8f` VM (`get_timeline` 0.115 against 0.094 ms). The 10,000-page ones were within 14%. That counts as a suspected regression, so the preregistered repeat (`vm/cat7-repeat.sh`, three Cat 7 runs each on two fresh identical VMs) ran. It reversed the direction: medians at `a865f8f` were 13% to 44% lower on all 22 operations (`get_timeline` at 1,000 pages 0.073 against 0.092 ms). No gbrain change between the two pins touches these read paths, so neither gap is a property of the code, and there is no Cat 7 regression ([repeat receipts](2026-10-06-followups-repin/cat7-repeat-a865f8f/), [paired](2026-10-06-followups-repin/cat7-repeat-c5fb020-paired/)).

### `a865f8f`: the N6 oracle probes on `open_loops` were the harness again

gbrain fix wave 10 ([#6217](https://github.com/garrytan/gbrain/pull/6217), v0.60.97.0) gave `open_loops` an `id` parameter, so N6 now probes it as a targeted operation, once with a private target and once with a ghost. Both answers are empty and identical, except for `as_of`, the wall-clock reference time the operation echoes, which differs by a millisecond. N6's comparison did not treat `as_of` as volatile, so it counted 142 to 156 oracle probes. The fix adds `as_of` to the volatile keys. A unit test fails before the fix and passes after ([commit `d6b4aac`](https://github.com/garrytan/gbrain-evals/commit/d6b4aac), ledger entry N6-3, a category defect in this repository). Rerun at `a865f8f`: 0 content leaks, 0 existence leaks and 0 oracle probes over 6,938 exposed probes, every rule passing ([after](2026-10-06-followups-repin/n6-a865f8f-as-of-mask.json), [before](2026-10-06-followups-repin/n6-a865f8f-before-as-of-mask.json)). Nothing private was returned.

### `c5fb0201`: the N6 failure was the harness, not gbrain

As run, N6 (the visibility fuzz, which asks every read operation about private pages as each kind of caller) reported 14 "existence oracle" probes on `entity`: responses about a private page and about a page that doesn't exist differed. At `c5fb0201` the `entity` tool returns its JSON in one content block and a `mention_index` notice in a second. The harness joined the blocks before parsing, so the parse failed, the response stayed a raw string, and the one field the comparison is built to ignore, `latency_ms` (7 against 9 ms), made the two responses look different. Nothing private was returned.

The fix parses the first content block as the response and still compares the notice blocks, so a notice that differs between a private and a missing page would still count ([commit `3894363`](https://github.com/garrytan/gbrain-evals/commit/3894363), ledger entry N6-2, a category defect in this repository). Rerun at `c5fb0201`: 0 content leaks, 0 existence leaks and 0 oracle probes over 6,490 exposed probes, every rule passing ([receipt](2026-10-06-n8-privacy-gate/n6-receipt-c5fb0201.json)). The failing run's receipt is kept: [`offline-tier/c5fb020/n6-visibility-fuzz/receipt.json`](2026-10-06-followups-repin/offline-tier/c5fb020/n6-visibility-fuzz/receipt.json).

### Metrics that moved from `739e5cc` to `c5fb0201`

Every other category reported identical numbers at both pins apart from these, all within their rules:

| Category | Metric | `739e5cc` | `c5fb0201` | Why |
|---|---|---|---|---|
| N9 composed, relationship retrieval on | strict all-hit at 10 (375 runs) | 2.7% | 61.9% | P7 planner (gbrain #6019) |
| N9 composed, on vs off | runs better / worse | 0 / 0 | 222 / 0 | same |
| Temporal edges | now-precision | 0.343 | 1.000 | P1 dated relationships (#6018) |
| Temporal edges | traps passed | 0.446 | 1.000 | same |
| Temporal edges | as-of exact | 0.212 | 0.933 | same |
| Temporal edges | during-year F1 | 0.594 | 0.921 | same |
| Type accuracy | overall type accuracy | 0.747 | 0.753 | link typing changes in P1 and P5 |
| Cat 6 prose scale | mean links per page | 5.73 | 5.67 | gazetteer mention links (entity-recall wave) |
| N12 | formats registered / rendered | 27 / 27 | 28 / 27 (28 / 28 with the new renderer) | gbrain's new `email-thread-heading` pattern |
| MCP contract | handlers walked | 156 | 160 | new operations (P1, P5, P8) |
| Cat 7 | `get_timeline` p50 at 1,000 pages | 0.075 ms | 0.078 ms | within the 25% rule |

N4 (entity resolution) fails its exploratory F1 rule at both pins, unchanged; it is report-only by design.

### Cat7-1

On October 6 the repro's median stayed under its frozen 0.075 ms limit in all three runs at each pin (0.053 to 0.061 ms at `739e5cc`, 0.058 to 0.062 ms at `c5fb0201`). On October 7 it ranged from 0.055 to 0.078 ms across four VMs at both pins, crossing the limit on whichever VM was slower, so the limit sits inside VM-to-VM variance. The closure rule also asks Cat 7 itself to come within 25% of the 0.045 ms pre-Foundations-1 baseline, at most 0.056 ms. It measured 0.078 ms on October 6, and on October 7 0.088 to 0.094 ms at `c5fb0201` and 0.071 to 0.115 ms at `a865f8f` (the first VM pair plus the repeat). The entry stays open.

## What changed in this repository with the re-pin

- `package.json` pins gbrain `a865f8f8b7c95b9f8c30690702797bafcfef537a` (was `c5fb0201d1960a0a5a81c35d77718311b03154b7` from October 6 to 7); `gbrain-cues` and `gbrain-reader` are unchanged. `@types/bun` moved to 1.4.2 and `@types/js-yaml` to 4 (the new pin uses js-yaml 4). Three type shims in `types/` cover gbrain's `.jsonl` asset imports, `process.threadCpuUsage`, and the old aliases' js-yaml 3 calls (each alias installs its own js-yaml 3 at runtime).
- The N7 runner names N7-2 and N7-5 only when its measurement shows them: an acknowledgement-only reply closing a loop, and a ranking that moves with the clock even with `as_of` pinned. At `c5fb0201` it names only the open N7-3 and N7-4.
- The Cat 40 and Cat 41 protocols move new runs and the F1/F10 instruction check to `claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5` and `claude-fable-5-1`, amended before any new cell.
- `scripts/model-freshness.ts` lists each provider's models, names the newest of each family the eval rules use, and blocks a run whose models have no price.
- N12 gains a renderer for gbrain's new `email-thread-heading` pattern (the Gmail thread page shape, one `## <From> · YYYY-MM-DD HH:MM` heading per message), so every registered format is rendered again: 28 of 28 at seeds 12 and 7, every rule passing ([seed 12](2026-10-06-followups-repin/n12-email-thread-heading-seed12.json), [seed 7](2026-10-06-followups-repin/n12-email-thread-heading-seed7.json)). The VM runs above predate it and show 28 registered, 27 rendered.
- N6 treats `as_of` as volatile (N6-3, above). The takes-bootstrap refusal test uses a synthetic unpriced model, because gbrain `a865f8f` prices `gpt-6.1-sol`.
- Session-id audit: N6 is the only runner that sends gbrain MCP tool calls and compares two responses, and it now gives every probe its own session and parses notice blocks separately. No other runner needed a change.

## What to use and what to avoid

Use the new pin. N1-7 is fixed in `a865f8f`, and nothing else this repository can see got worse since `739e5cc`. The round's paid results were measured at `c5fb0201`. If you serve a brain with `gbrain serve` at a commit between `7007ba60` (v0.60.53.0) and `a865f8f`, it can lose ontology observations after a page rewrite. The composed-question and dated-relationship gains are development evidence on synthetic worlds this project has inspected; their held-out verdicts are in [the held-out program report](2026-10-05-heldout-program.md).

## Reproduce and inspect

Keyless, $0: every receipt is committed under [`2026-10-06-followups-repin/`](2026-10-06-followups-repin/), one folder per pin under `offline-tier/` (`c5fb020-paired` is the October 7 run beside `a865f8f`), with `repros-<pin>.txt`, `checks-*-<pin>.json`, `cat7-1-repro-<pin>.txt` and `tree-<pin>.txt` (tree, pin, installed version, CPU count and Bun version). To rerun one pin:

```sh
bun install --frozen-lockfile
GBRAIN_REPO="$PWD/node_modules/gbrain" bun eval/runner/all.ts --tier offline
bash docs/benchmarks/2026-10-06-followups-repin/vm/run.sh      # everything above, output in ~/out
```

On Ubicloud: `UBI_OWNER=<owner> ubi-runner.sh run --setup docs/benchmarks/2026-10-06-followups-repin/vm/setup.sh --pull out:<dir> -- 'bash docs/benchmarks/2026-10-06-followups-repin/vm/run.sh'`, from a standalone clone (a worktree's shared `.git` can change while it is copied). Each VM took 12 to 14 minutes after setup. The before tree is the same commit with `package.json` and `bun.lock` restored to the earlier pin. N1-ci on one loaded core: `taskset -c 0 bun eval/runner/n1-knowledge-update.ts --slice ci --output <dir>`.
