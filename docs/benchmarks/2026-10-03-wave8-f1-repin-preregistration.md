# Preregistration: the regression check after gbrain fix wave 8 and Foundations 1 (2026-10-03)

Frozen on October 3, 2026, in its own commit, before any category run at gbrain `109b992` and before the matching run at `48ed5e8`. Nothing below changes after a run; a later change gets a new dated file. The new coverage for wave 8 and Foundations 1 behavior (pricing, ignored-directory import, the embed time budget and the cheap extras) gets its own preregistration before it is measured.

## The question

gbrain master moved from `48ed5e8233f617479df989998560840747af0425` (v0.60.32.0, the pin of gbrain-evals v0.10.10) to `109b992172e1f49107f9de9841758c1d043a2668` (v0.60.37.0). The range holds three merges on gbrain's first-parent history:

| Merge | gbrain commit | Release | What it changes that a category here can see |
|---|---|---|---|
| [#5932](https://github.com/garrytan/gbrain/pull/5932) | `566a242a6` | v0.60.35.0 | `search` and `query` append saved facts, follow declared other names, lift type filters on missing types; `derived_from` carries private visibility; PGLite runs a full `ANALYZE` after projection refreshes |
| [#5927](https://github.com/garrytan/gbrain/pull/5927) (fix wave 8) | `d82eb2e9e` | v0.60.36.0 | markdown link typing stops using the bundled packs' bare-word verb regexes (#5882); atom pages stop feeding the facts backstop (#5831); pending writes exit 10; `edit_page`; `find_orphans` pages; Postgres pool, Windows and grant fixes; `no_pricing` under an explicit cap and `gbrain pricing` |
| [#5962](https://github.com/garrytan/gbrain/pull/5962) (Foundations 1) | `109b99217` | v0.60.37.0 | PGLite planner-statistics accounting, `get_health` memo, creation attribution, seats, unified grants, worktree refresh, `gbrain import <dir>` inside an ignoring repository, embed budget stop exit 11 |

Does anything this repository measures get worse, and which merge is responsible when it does?

**Before** is gbrain `48ed5e8`. **After** is gbrain `109b992`. Both are the installed dependency (`package.json` pin), on Bun 1.4.2, with the same gbrain-evals code: the before run uses this repository at `6e5fb1c` (main, pinned at `48ed5e8`) plus this preregistration; the after run uses the re-pin commit `f321afb` plus this preregistration. Nothing else differs between the two trees.

## What runs

1. **The offline tier**, `bun eval/runner/all.ts --tier offline`, once at each pin, on two identical Ubicloud `standard-16` VMs started at the same time in the same location, each with a fresh clone and `bun install --frozen-lockfile`. This dispatches every registry category of tier H: Cats 1, 2, 3, 4, 6, 7, 10, 11, 12, 19, 22, 23, 24, 27, 28, 34, 36 (smoke), N1-ci, N2 (hermetic), N3, N4, N5-ci, N6, N7, N8 (report-only), N9 (hermetic, report-only), N12, N13 (report-only), A4 (hermetic) and SO (record). Provider keys are not passed to the VMs, so every arm is keyless. `BRAINBENCH_CONCURRENCY` stays at its default of 2.
2. **The ledger repros**: every command in [`2026-10-03-wave7-repin/repros-48ed5e8.txt`](2026-10-03-wave7-repin/repros-48ed5e8.txt), at `109b992`, keys stripped and a fresh `GBRAIN_HOME`, recorded the same way.
3. **N12 at seed 7**, the second seed the 0.10.10 receipts carry, at `109b992`.

N1 and N5 full runs, the paid tier and the sealed confirmation sets are not run. No corpus is regenerated.

## What each result is compared against

Each category is compared on the metrics its registry row names as its headline and on every metric a promotion rule reads, with the denominator stated.

- Where gbrain-evals v0.10.10 committed a receipt at `48ed5e8` (N2 hermetic, N7, N9 hermetic, N12 seeds 12 and 7, N13, A4 hermetic, N1-ci, N5-ci, in [`2026-10-03-wave7-repin/`](2026-10-03-wave7-repin/)), that receipt is the preregistered before. The before run on the VM is reported beside it as a check that the two `48ed5e8` measurements agree.
- Every other category has no committed `48ed5e8` receipt, so its before is the VM run at `48ed5e8`.

## What counts as a regression

A regression is any one of these at `109b992`:

1. A category whose promotion rules pass at `48ed5e8` fails them at `109b992`, or a category that ran to completion at `48ed5e8` errors, times out or skips.
2. A deterministic keyless metric (a count against generator gold: recall, precision, accuracy, leaks, typed edges, resolved edges, closed loops) moves away from gold. A move that a line in gbrain's CHANGELOG for v0.60.35.0 to v0.60.37.0 describes as intended is still reported, and it is a regression if it breaks a rule; it is classified by the ledger rules (a deliberate behavior change that breaks a category's encoded rule is a category matter, as N7-8 was in wave 7, not a gbrain bug).
3. A ledger repro that exited 0 at `48ed5e8` (a fixed bug, or a closed gap's check) exits non-zero at `109b992`.
4. For the latency categories (Cat 7, Cat 28): a gate failure. A p50 slowdown of more than 25% on an operation, with both runs inside the gate, is reported as a suspected regression and counts as a regression only if a second paired run on fresh identical VMs repeats it.

A metric that moves toward gold is reported as an improvement, with the CHANGELOG line that explains it when there is one.

## What happens to a regression

Each regression gets a keyless repro (a script under `docs/benchmarks/2026-10-03-wave8-f1-repin/repros/` that exits 1 while the regression reproduces), a bisection over the three merges in the table above (run the repro or the category at `566a242a6` and `d82eb2e9e` through a copied overlay, `--gbrain <checkout>@<sha>`, where the runner takes one), and a ledger entry naming the most likely responsible commit range. A paid arm runs only to confirm a suspected regression that no keyless arm can show, inside one budget-ledger run capped at $15.

## Gates

No threshold moves. A gate changes only where a rule in `eval/registry.ts` or a frozen hold says so. Before any run, no promotion rule names a wave 8 or Foundations 1 change.
