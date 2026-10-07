# Re-pin to gbrain v0.60.95.0: one acknowledged-write regression under load (N1-7); relationship and multi-hop gains show up in the offline tier

**Finding, 2026-10-06, corrected 2026-10-07.** Moving this repository's gbrain pin from `739e5cc` (v0.60.46.0) to `c5fb0201` (v0.60.95.0), 78 merges that include the nine held-out-program plans, brings one regression: under CPU contention, gbrain's serve-resident maintenance sweep makes acknowledged ontology observations unreadable (ledger entry **N1-7**, a gbrain bug from `7007ba60` in #6024, v0.60.53.0, still on gbrain master). The paired 16-core VMs below did not show it, so the October 6 version of this report said "no regression"; GitHub's 4-core CI runner fails N1-ci on it every time. Every other offline-tier category, all 28 ledger repros and every preregistered check pass at the new pin once one harness defect is fixed. Two categories improve sharply, as the plans predicted:

- **Composed multi-hop questions (N9).** With relationship retrieval on, gbrain now answers 61.9% of 375 composed two- and three-hop question runs with every needed page in the top ten, against 2.7% before (222 runs better, 0 worse). This is the P7 multi-relation planner, on by default since v0.60.60.0.
- **Dated relationships (temporal edges).** Current-employer precision rose from 0.34 to 1.00 and the trap score (investments and alumni meetings that must not change who someone works for) from 0.45 to 1.00. This is P1, on by default since v0.60.57.0.

The `get_timeline` latency regression from Foundations 1 (ledger entry Cat7-1) is unchanged: 0.078 ms per call at 1,000 pages, against 0.045 ms before Foundations 1. Under its frozen closure rule the entry stays open.

Evidence class: regression check. Tested at gbrain-evals `6155609`, Bun 1.4.2, on two identical Ubicloud `standard-16` VMs started together, one per pin, with no provider key ([preregistration](2026-10-06-followups-repin-preregistration.md), committed before the runs). Provider spend: $0.

## N1-7: acknowledged ontology writes lost after a maintenance sweep

**What happens.** `gbrain serve` runs a maintenance sweep after about 3 seconds without input. Since gbrain `7007ba60` ([#6024](https://github.com/garrytan/gbrain/pull/6024), v0.60.53.0) the sweep's facts reconcile first moves every fact row without a row number onto its entity page's `## Facts` table. Ontology observations (`ontology_propose`, such as "Alder's location is Viseu from 2021") are stored as fact rows without a row number, so the sweep moves them too: their source becomes the page, and they now belong to the page's table. The next ordinary rewrite of that page, which doesn't list them, plus one more sweep, retires them, and `ontology_get` returns nothing.

**Why the VMs missed it.** N1-ci writes its ledger as fast as the machine allows. On an unloaded machine no 3-second gap opens between writes, so the sweep never runs mid-ledger. On GitHub's 4-core runner, with another category running beside it, gaps open and N1-ci loses 1 acknowledged write and fails its current-value and history floors, on both CI runs of this branch. Pinned to one core here, it loses 1 to 3 per run at `c5fb0201` and none at `739e5cc` (two runs each).

**Evidence.**
- Keyless repro [`repros/n1-7-sweep-fences-ontology.ts`](2026-10-06-followups-repin/repros/n1-7-sweep-fences-ontology.ts): one observation, `gbrain sweep --once`, a page rewrite, another sweep. It passes at `739e5cc` and `1da881a3` and fails at `7007ba60`, `c5fb0201` and gbrain master `5b58910` (v0.60.102.0). [Outputs](2026-10-06-followups-repin/n1-7/).
- Bisection with N1-ci pinned to one core, two runs per commit, over gbrain's first-parent history and then inside #6024 and its lane D: last good `1da881a3`, first bad `7007ba60`, "fix(facts): the extract_facts cycle phase fences row_num-NULL facts itself (#5299)". [Every run](2026-10-06-followups-repin/n1-7/bisect-summary.txt).
- The failing GitHub CI receipt and the contended receipts at each end are in [`n1-7/`](2026-10-06-followups-repin/n1-7/).

**Likely fix in gbrain.** `planUnfencedFacts` should skip rows with a `dimension` (ontology observations belong to the ontology, not to a page table), and the sweep's reconcile should fence only the pages it was given. N1-ci keeps gating; nothing in its rules changed.

## What the check covers

gbrain is a memory system for agents: notes stay Markdown files, and a database index answers searches, relationships and timelines. This repository pins one gbrain commit in `package.json`, and every current-state number names the commit it was measured at. A re-pin moves that commit, so the first job is to show nothing measured here got worse.

The offline tier (`bun eval/runner/all.ts --tier offline`) runs every keyless category: 31 categories and CI slices, from search quality and provenance through privacy fuzzing, temporal reasoning, open loops and latency. The same tree ran at both pins on paired VMs, together with the 28 repros of past ledger bugs, the wave 8 and operator-wave checks, N12 at a second seed and three extra runs of the Cat7-1 repro.

## Results

| Check | gbrain `739e5cc` | gbrain `c5fb0201` |
|---|---|---|
| Offline tier, categories passing their rules | 31 of 31 | 30 of 31 as run; 31 of 31 after the N6 harness fix |
| Ledger repros exiting 0 | 28 of 28 | 28 of 28 |
| Wave 8 and Foundations 1 checks | pass | pass |
| Operator-wave checks (2026-10-04) | pass | pass |
| Consented embed-budget check (check C with `--yes`) | pass | pass |
| N12 at seed 7 | pass | pass |

### The N6 failure was the harness, not gbrain

As run, N6 (the visibility fuzz, which asks every read operation about private pages as each kind of caller) reported 14 "existence oracle" probes on `entity`: responses about a private page and about a page that doesn't exist differed. At `c5fb0201` the `entity` tool returns its JSON in one content block and a `mention_index` notice in a second. The harness joined the blocks before parsing, so the parse failed, the response stayed a raw string, and the one field the comparison is built to ignore, `latency_ms` (7 against 9 ms), made the two responses look different. Nothing private was returned.

The fix parses the first content block as the response and still compares the notice blocks, so a notice that differs between a private and a missing page would still count ([commit `3894363`](https://github.com/garrytan/gbrain-evals/commit/3894363), ledger entry N6-2, a category defect in this repository). Rerun at `c5fb0201`: 0 content leaks, 0 existence leaks and 0 oracle probes over 6,490 exposed probes, every rule passing ([receipt](2026-10-06-n8-privacy-gate/n6-receipt-c5fb0201.json)). The failing run's receipt is kept: [`offline-tier/c5fb020/n6-visibility-fuzz/receipt.json`](2026-10-06-followups-repin/offline-tier/c5fb020/n6-visibility-fuzz/receipt.json).

### Metrics that moved

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

The repro's median stays under its frozen 0.075 ms limit in all three runs at each pin (0.053 to 0.061 ms before, 0.058 to 0.062 ms after). The closure rule also asks Cat 7 itself to come within 25% of the 0.045 ms pre-Foundations-1 baseline, at most 0.056 ms; it measured 0.078 ms. The entry stays open.

## What changed in this repository with the re-pin

- `package.json` pins gbrain `c5fb0201d1960a0a5a81c35d77718311b03154b7`; `gbrain-cues` and `gbrain-reader` are unchanged. `@types/bun` moved to 1.4.2 and `@types/js-yaml` to 4 (the new pin uses js-yaml 4). Three type shims in `types/` cover gbrain's `.jsonl` asset imports, `process.threadCpuUsage`, and the old aliases' js-yaml 3 calls (each alias installs its own js-yaml 3 at runtime).
- The N7 runner names N7-2 and N7-5 only when its measurement shows them: an acknowledgement-only reply closing a loop, and a ranking that moves with the clock even with `as_of` pinned. At `c5fb0201` it names only the open N7-3 and N7-4.
- The Cat 40 and Cat 41 protocols move new runs and the F1/F10 instruction check to `claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-opus-5-5` and `claude-fable-5-1`, amended before any new cell.
- `scripts/model-freshness.ts` lists each provider's models, names the newest of each family the eval rules use, and blocks a run whose models have no price.
- N12 gains a renderer for gbrain's new `email-thread-heading` pattern (the Gmail thread page shape, one `## <From> · YYYY-MM-DD HH:MM` heading per message), so every registered format is rendered again: 28 of 28 at seeds 12 and 7, every rule passing ([seed 12](2026-10-06-followups-repin/n12-email-thread-heading-seed12.json), [seed 7](2026-10-06-followups-repin/n12-email-thread-heading-seed7.json)). The VM runs above predate it and show 28 registered, 27 rendered.
- Session-id audit: N6 is the only runner that sends gbrain MCP tool calls and compares two responses, and it now gives every probe its own session and parses notice blocks separately. No other runner needed a change.

## What to use and what to avoid

Use the new pin with one caveat: until gbrain fixes N1-7, a brain served by `gbrain serve` can lose ontology observations after a page rewrite (facts in page tables and pages themselves are not affected). It is the gbrain the follow-up round measures, and nothing else this repository can see got worse. The composed-question and dated-relationship gains are development evidence on synthetic worlds this project has inspected; their held-out verdicts are in [the held-out program report](2026-10-05-heldout-program.md).

## Reproduce and inspect

Keyless, $0: every receipt is committed under [`2026-10-06-followups-repin/`](2026-10-06-followups-repin/), one folder per pin under `offline-tier/`, with `repros-<pin>.txt`, `checks-*-<pin>.json`, `cat7-1-repro-<pin>.txt` and `tree-<pin>.txt` (tree, pin, installed version, CPU count and Bun version). To rerun one pin:

```sh
bun install --frozen-lockfile
GBRAIN_REPO="$PWD/node_modules/gbrain" bun eval/runner/all.ts --tier offline
bash docs/benchmarks/2026-10-06-followups-repin/vm/run.sh      # everything above, output in ~/out
```

On Ubicloud: `UBI_OWNER=<owner> ubi-runner.sh run --setup docs/benchmarks/2026-10-06-followups-repin/vm/setup.sh --pull out:<dir> -- 'bash docs/benchmarks/2026-10-06-followups-repin/vm/run.sh'`, from a standalone clone (a worktree's shared `.git` can change while it is copied). Each VM took 12 to 14 minutes after setup. The before tree is the same commit with `package.json` and `bun.lock` restored to the `739e5cc` pin.
