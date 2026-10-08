# Preregistration: the regression check after gbrain v0.60.47.0 to v0.60.95.0 (2026-10-06)

Frozen on October 6, 2026, in its own commit, before any category run at the new pin. Nothing below changes after a run; a later change is a dated amendment at the end. This is the first preregistration of the [2026-10 follow-up round](../plans/2026-10-06-followups-round/PLAN.md), workstream W1.

## The question

gbrain master moved from `739e5cc89ca43b9b9351f0f203c7b12a7c0c571c` (v0.60.46.0, the pin of gbrain-evals v0.10.17 to v0.10.35) to `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0). The range holds 78 merges on gbrain's first-parent history, including the nine held-out-program plans (P1 #6018, P2 #6020, P3 #6014, P4 #6015, P5 #6017, P6 #6112, P7 #6019, P8 #6027), the Cat 40 entity-recall wave (#6035), Foundations 2 (#6024), fix wave 9 (#6111) and about thirty contributor fixes. The full list is `git log --first-parent 739e5cc89..c5fb0201` in gbrain.

Does anything this repository measures get worse, and which merge is responsible when it does? Evidence class: regression check.

**Before** is gbrain `739e5cc`. **After** is gbrain `c5fb0201`, frozen as the pin for the whole round; a later re-pin is an amendment that reruns the affected free checks. Both are the installed dependency (`package.json` pin), on Bun 1.4.2, with the same gbrain-evals code apart from `package.json` and `bun.lock`.

## What runs

On two identical Ubicloud `standard-16` VMs started together in the same location, one per pin, each with a fresh copy of the tree, `bun install --frozen-lockfile`, no provider key in the environment, and `UBI_OWNER=gbra-evalsfollowups` (`vm/setup.sh`, `vm/run.sh`):

1. The offline tier, `GBRAIN_REPO=node_modules/gbrain bun eval/runner/all.ts --tier offline`.
2. N12 at seed 7.
3. Every command in `2026-10-03-wave8-f1-repin/repros-109b992.txt` plus the Cat7-1 repro (`run-repros.ts`).
4. The wave 8 and Foundations 1 checks (`2026-10-03-wave8-f1-repin/checks/run-all.ts`). Check C (`embed-budget-stop`) stops at gbrain's consent prompt since v0.60.46.0 by design, so its consented variant `2026-10-04-operator-wave-repin/checks/embed-budget-stop-consented.ts` also runs and is the one that counts.
5. The 2026-10-04 operator-wave checks (`2026-10-04-operator-wave-repin/checks/run-all.ts`).
6. The Cat7-1 repro three more times, for its p50 spread.

N1 and N5 full runs, the paid tier and the sealed sets are not run. No corpus is regenerated.

## What counts as a regression

The rules of the [2026-10-04 regression check](2026-10-04-operator-wave-repin-preregistration.md#what-counts-as-a-regression) apply unchanged, with `739e5cc` as before and `c5fb0201` as after:

1. A category whose promotion rules pass at `739e5cc` fails them at `c5fb0201`, or a category that completed errors, times out or skips.
2. A deterministic keyless metric moves away from gold. A move a gbrain CHANGELOG line for v0.60.47.0 to v0.60.95.0 describes as intended is still reported, and counts as a regression if it breaks a rule.
3. A repro or check that passed at `739e5cc` fails at `c5fb0201`.
4. Latency (Cat 7, Cat 28): a gate failure; a p50 slowdown above 25% with both runs inside the gate is a suspected regression and counts only if a paired rerun on fresh identical VMs (`vm/cat7-repeat.sh`) repeats it.

Expected moves named in advance: Cat 12 and N6 counting new operations (P1, P5, P8 add tools); N9's composed questions planning multi-relation chains (P7 turns the planner on in `balanced`); A4 grading changes from #6036.

## Cat7-1

The ledger entry stays open under its frozen closure rule ([2026-10-04 coverage preregistration](2026-10-04-operator-wave-repin-coverage-preregistration.md)): it closes as fixed only when Cat 7's `get_timeline` p50 at 1,000 pages on the after VM is within 25% of the 0.045 ms pre-Foundations-1 baseline, and the repro passes.

## What happens to a regression

A keyless repro under `2026-10-06-followups-repin/repros/` that exits 1 while it reproduces, a bisection over the first-parent merges, and a ledger entry naming the likely range. No paid arm.

## Budget

None: no paid request. The VMs are compute only.

## Amendments

### 2026-10-07: re-pin to `a865f8f` for the N1-7 fix

The check at `c5fb0201` found ledger entry N1-7: since gbrain #6024, the serve maintenance sweep fences ontology rows and a later sweep expires them, so N1-ci loses acknowledged writes on a contended runner. gbrain #6265 fixes it and merged as `a865f8f8b7c95b9f8c30690702797bafcfef537a` (v0.60.104.0). The pin moves from `c5fb0201` to `a865f8f`, under the re-pin rule in "The question". Nothing above changes. Frozen before any run at `a865f8f`:

1. **After** becomes `a865f8f` for the free and gating checks. **Before** for the regression rules is `c5fb0201`: a category, metric, repro or check that passes at `c5fb0201` and fails at `a865f8f` is a regression under the same four rules. The `739e5cc` to `c5fb0201` results stand as recorded.
2. Steps 1 to 5 of "What runs" rerun on two identical `standard-16` VMs started together, one at `c5fb0201` and one at `a865f8f`, so latency compares paired VMs. The offline-tier receipts at `a865f8f` are also diffed against the recorded `offline-tier/c5fb020` receipts.
3. Added for N1-7, run on the Capy machine (4 cores): the keyless repro `repros/n1-7-sweep-fences-ontology.ts`, and N1-ci (`eval/runner/n1-knowledge-update.ts --slice ci`) once unpinned and once pinned to one core with `taskset -c 0`. N1-7 closes as fixed only when the repro exits 0 and both N1-ci runs show 0 acknowledged writes lost, 64 of 64 current-value probes correct and 0 stale values served.
4. The paid results of the round stay as measured at `c5fb0201` (W10b retrieval at `a7cb37b`) and are not rerun.
