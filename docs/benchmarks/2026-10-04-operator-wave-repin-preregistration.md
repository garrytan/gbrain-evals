# Preregistration: the regression check after gbrain v0.60.38.0 to v0.60.46.0 (2026-10-04)

Frozen on October 4, 2026, in its own commit, before any category run at gbrain `739e5cc` and before the matching run at `109b992`. Nothing below changes after a run; a later change gets a new dated file. The checks for this range's new behavior (the Cat7-1 fix, the empty-grant hint, the `edit_page` diff order, the per-page segment gap and the `auto_chronicle` receipt) get their own preregistration before they are measured, and the `auto_chronicle` OFF versus ON experiment gets a third one.

## The question

gbrain master moved from `109b992172e1f49107f9de9841758c1d043a2668` (v0.60.37.0, the pin of gbrain-evals v0.10.13 to v0.10.16) to `739e5cc89ca43b9b9351f0f203c7b12a7c0c571c` (v0.60.46.0). The range holds seven merges on gbrain's first-parent history:

| Merge | gbrain commit | Release | What it changes that a category here can see |
|---|---|---|---|
| [#5985](https://github.com/garrytan/gbrain/pull/5985) | `7ff802134` | v0.60.38.0 | the managed writer guard takes tags, timeline entries and takes from their page (#5983); migration v197 |
| [#5987](https://github.com/garrytan/gbrain/pull/5987) | `f4739fff2` | v0.60.39.0 | `gbrain repair failed-writes`; `sources refresh` waits for an in-progress save |
| [#5982](https://github.com/garrytan/gbrain/pull/5982) | `8d8093975` | v0.60.40.0 | publication-refusal diagnostics, additive drift classification in `sources reconcile`; migration v198 |
| [#5992](https://github.com/garrytan/gbrain/pull/5992) | `101799f1f` | v0.60.41.0 | a relaxed keyword top grades `moderate` when the top five corroborate it (#5919); per-page `conversation_segment_gap_minutes` (#5918) |
| [#5995](https://github.com/garrytan/gbrain/pull/5995) (Cat 40 cost wave) | `e6d6dda7b` | v0.60.44.0 | lean search rows and compact JSON for remote callers, a smaller starter tool list, capped notices, a cheaper saved-fact check in search |
| [#5993](https://github.com/garrytan/gbrain/pull/5993) | `8b5ed04c6` | v0.60.45.0 | `auto_chronicle` restored and on by default as a `chronicle` cycle phase; migration v199 |
| [#5991](https://github.com/garrytan/gbrain/pull/5991) (agent-first operator wave) | `739e5cc89` | v0.60.46.0 | one error envelope with `code` and `fix`, consent stops (exit 3), status-only `serve`, notices on MCP results, the unscoped `get_timeline` lookup (Cat7-1), the empty-grant fix naming the token by `--id`, `edit_page` diffs listing removed lines first |

Does anything this repository measures get worse, and which merge is responsible when it does?

**Before** is gbrain `109b992`. **After** is gbrain `739e5cc`. Both are the installed dependency (`package.json` pin), on Bun 1.4.2, with the same gbrain-evals code: the after run uses the re-pin commit `bf5fa53` plus this preregistration; the before run uses the same tree with `package.json` and `bun.lock` restored to `109b992` in one local commit. Nothing else differs between the two trees.

## What runs

1. **The offline tier**, `bun eval/runner/all.ts --tier offline`, once at each pin, on two identical Ubicloud `standard-16` VMs started at the same time in the same location, each with a fresh copy of the tree and `bun install --frozen-lockfile` (`docs/benchmarks/2026-10-04-operator-wave-repin/vm/`). This dispatches every registry category of tier H, which is the hermetic arm of every gated category: Cats 1, 2, 3, 4, 6, 7, 10, 11, 12, 19, 22, 23, 24, 27, 28, 34, 36 (smoke), N1-ci, N2 (hermetic), N3, N4, N5-ci, N6, N7, N8 (report-only), N9 (hermetic, report-only), N12, N13 (report-only), A4 (hermetic) and SO (record). Provider keys are not passed to the VMs, so every arm is keyless. `BRAINBENCH_CONCURRENCY` stays at its default of 2. One change from v0.10.13: `GBRAIN_REPO` points at the installed `node_modules/gbrain`, which ships `evals/brainbench/`, so Cat 34 runs inside the tier at each pin instead of separately against a checkout.
2. **The ledger repros**: every command in [`2026-10-03-wave8-f1-repin/repros-109b992.txt`](2026-10-03-wave8-f1-repin/repros-109b992.txt) plus the Cat7-1 repro, at both pins on the same VMs, keys stripped and a fresh `GBRAIN_HOME` each (`run-repros.ts`).
3. **The nine wave 8 and Foundations 1 checks** (`2026-10-03-wave8-f1-repin/checks/run-all.ts`) at both pins on the same VMs.
4. **N12 at seed 7** at both pins on the same VMs.
5. **The Cat7-1 repro** three more times at each pin on the same VMs, for its p50 spread.

N1 and N5 full runs, the paid tier and the sealed confirmation sets are not run. No corpus is regenerated.

## What each result is compared against

Each category is compared on the metrics its registry row names as its headline and on every metric a promotion rule reads, with the denominator stated.

- gbrain-evals v0.10.13 committed receipts at `109b992` for every offline-tier category ([`2026-10-03-wave8-f1-repin/offline-tier/109b992/`](2026-10-03-wave8-f1-repin/offline-tier/109b992/)), Cat 34, N12 at seed 7, the nine checks and the 27 repros. Those receipts are the preregistered before. The VM run at `109b992` is reported beside them as a check that the two `109b992` measurements agree; for latency, where VMs differ, the paired VM run is the comparison.

## What counts as a regression

A regression is any one of these at `739e5cc`:

1. A category whose promotion rules pass at `109b992` fails them at `739e5cc`, or a category that ran to completion at `109b992` errors, times out or skips.
2. A deterministic keyless metric (a count against generator gold: recall, precision, accuracy, leaks, typed edges, resolved edges, closed loops, grade counts) moves away from gold. A move that a line in gbrain's CHANGELOG for v0.60.38.0 to v0.60.46.0 describes as intended is still reported, and it is a regression if it breaks a rule; it is classified by the ledger rules (a deliberate behavior change that breaks a category's or check's encoded expectation is a category matter, not a gbrain bug).
3. A ledger repro that exited 0 at `109b992` exits non-zero at `739e5cc`, or one of the nine checks that passed at `109b992` fails at `739e5cc`.
4. For the latency categories (Cat 7, Cat 28): a gate failure. A p50 slowdown of more than 25% on an operation, with both runs inside the gate, is reported as a suspected regression and counts as a regression only if a second paired run on fresh identical VMs repeats it.

A metric that moves toward gold is reported as an improvement, with the CHANGELOG line that explains it when there is one. Expected moves named in advance: A4's answerable natural questions graded `moderate` (40 of 120 at `109b992`; gbrain #5992 reports 100 of 120) with unanswerable `moderate` staying at 0 of 120; Cat 12 and N6 counting new or removed operations; Cat 7's `get_timeline` at 1,000 pages getting faster.

## What happens to a regression

Each regression gets a keyless repro (a script under `docs/benchmarks/2026-10-04-operator-wave-repin/repros/` that exits 1 while the regression reproduces), a bisection over the seven merges above (run the repro at merge commits through `GBRAIN_ROOT` or `--gbrain <checkout>@<sha>` where the runner takes one), and a ledger entry naming the most likely responsible commit range. No paid arm is planned for the regression check.

## Gates

No threshold moves. A gate changes only where a rule in `eval/registry.ts` or a frozen hold says so. Before any run, no promotion rule names a change from this range.
