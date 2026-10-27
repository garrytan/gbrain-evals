# Preregistration: the regression check for the re-pin from gbrain v0.60.126.0 to the wave 14 release (2026-10-11)

Frozen on October 11, 2026, in its own commit, before any run at the new pin. Nothing below changes after a run; a
later change is a dated amendment at the end.

## The question

gbrain-evals pins gbrain master `8a3eedeacb6e52da5b413502019692db80c5cc5d` (v0.60.126.0). The pin moves to the gbrain
release published after wave 14 lands, v0.60.169.0. That release does not exist yet, so the check runs now against
gbrain master `3001fd9a57e3603f1fd3bee3e5d74e0b7b27cbb2` (v0.60.166.0), 1,010 commits and 40 first-parent merges after
the pin. The range includes memory trust (#6396), the verbatim-probe fixes (#6391), scoped vector search (#6380), the
content-repair lane (#6384), the memory proof wave integration (#6066), efficiency waves 5 to 11, and waves 13 and 14 so
far. The full list is `git log --first-parent 8a3eedeac..3001fd9a5` in gbrain.

Does anything this repository measures get worse, and which merge is responsible when it does? Evidence class:
regression check.

**Before** is gbrain `8a3eedeac`. **After** is gbrain `3001fd9a5`. Both are the installed dependency (`package.json`
pin), on Bun 1.4.2, with the same gbrain-evals tree apart from `package.json` and `bun.lock`. That tree removes `held`
from the memory trust rules (Cats 37 to 39), as `eval/registry.ts` asks the re-pinning commit to do, so those three
categories gate at both pins. The test suite and one N12 run on the Capy machine at `3001fd9a5`, used to bring the
harness up to the new pin (a renderer for gbrain's new `plain-role-no-time` conversation pattern and four tests that
assumed the old pin), are development runs and are not counted.

## What is rerun, and why

README's results table says the correctness rows "come from keyless checks on synthetic worlds with generated answer
keys, rerun at every pin". Those rows, and how each is rerun here:

| README row | Rerun |
|---|---|
| Serving the new value after an update (N1) | full N1, PGLite and Postgres, every interface (step 8); N1-ci in the offline tier |
| Nothing left behind after `forget` (N5) | full N5, PGLite and Postgres, every interface (step 8); N5-ci in the offline tier |
| Private pages reaching agent or remote callers (N6, N8, N6 on Postgres over HTTP) | N6 and N8 in the offline tier and attested against their gate preregistration (step 10); N6 on Postgres over real HTTP with its negative control (step 9) |
| Keeping speaker and time across chat export formats (N12) | N12 at seed 12 in the offline tier and at seed 7 (step 2) |
| The bug-ledger sentence | every ledger repro (step 3), the memory trust repros (step 7) |
| Known limits: Cat7-1 | Cat 7 in the offline tier and the Cat7-1 repro (steps 1, 3, 6) |

The offline tier, the ledger repros and the preregistered checks also run, as at every earlier re-pin. Rows that need
provider calls (LongMemEval, concept search, relationship paraphrases, PrecisionMemBench, the contradiction judge, the
takes classifier, Cat 40, Cat 41, fence repair, slug-conflict judgment, Cat 35, timeline extraction) keep the commits
they were measured at and are not rerun. The N2 row's 149 of 150 comes from a paid judge arm (about $10 at the
default judge model); it is listed for approval, not run.

## What runs

On two identical Ubicloud `standard-16` VMs started together in the same location, one per pin, each with a fresh copy
of the tree, `bun install --frozen-lockfile`, Docker with the digest-pinned `pgvector/pgvector` image of the N6 Postgres
report, and no provider key in the environment (`2026-10-11-wave14-repin/vm/setup.sh`, `vm/run.sh`):

1. The offline tier, `GBRAIN_REPO=node_modules/gbrain bun eval/runner/all.ts --tier offline`.
2. N12 at seed 7.
3. Every command in `2026-10-03-wave8-f1-repin/repros-109b992.txt`, the Cat7-1 repro and the N1-7 repro
   (`2026-10-06-followups-repin/run-repros.ts`).
4. The wave 8 and Foundations 1 checks (`2026-10-03-wave8-f1-repin/checks/run-all.ts`).
5. The 2026-10-04 operator-wave checks and the consented `embed-budget-stop` variant, which is the one that counts.
6. The Cat7-1 repro three more times.
7. The fixed memory trust repros 37-1, 37-2 and 37-5 (`eval/runner/memory-trust/repro.ts`) against the installed
   gbrain.
8. Full N1 and N5 on PGLite and Postgres, every interface, at their default seeds.
9. N6 on Postgres over real HTTP, attested against its preregistration, and its negative control.
10. N8 and N6 attested against the N8 privacy gate preregistration.

No corpus is regenerated. No paid tier, no sealed set.

## What counts as a regression

The rules of the [2026-10-04 regression check](2026-10-04-operator-wave-repin-preregistration.md#what-counts-as-a-regression)
apply unchanged, with `8a3eedeac` as before and `3001fd9a5` as after:

1. A category whose promotion rules pass at `8a3eedeac` fails them at `3001fd9a5`, or a category that completed errors,
   times out or skips.
2. A deterministic keyless metric moves away from gold. A move a gbrain CHANGELOG line for v0.60.127.0 to v0.60.166.0
   describes as intended is still reported, and counts as a regression if it breaks a rule.
3. A repro or check that passed at `8a3eedeac` fails at `3001fd9a5`. For steps 8 to 10: a rule that passes at
   `8a3eedeac` fails at `3001fd9a5`, or a count of leaks, stale values, lost writes or prohibited outputs rises.
4. Latency (Cat 7, Cat 28): a gate failure; a p50 slowdown above 25% with both runs inside the gate is a suspected
   regression and counts only if a paired rerun on fresh identical VMs (`vm/cat7-repeat.sh`) repeats it.

Expected moves named in advance, which are not regressions: Cats 37 to 39 fail at `8a3eedeac`, where the feature they
test does not exist, and must pass at `3001fd9a5`; the memory trust repros cannot pass at `8a3eedeac`; Cat 12 and N6
count new operations; N12 may register new conversation patterns.

## Cat7-1

The ledger entry stays open under its frozen closure rule
([2026-10-04 coverage preregistration](2026-10-04-operator-wave-repin-coverage-preregistration.md)): it closes as fixed
only when Cat 7's `get_timeline` p50 at 1,000 pages on the after VM is within 25% of the 0.045 ms pre-Foundations-1
baseline (at most 0.056 ms), and the repro passes.

## What happens to a regression

A keyless repro under `2026-10-11-wave14-repin/repros/` that exits 1 while it reproduces, a bisection over the
first-parent merges in `8a3eedeac..3001fd9a5`, and a ledger entry naming the merge. No paid arm.

## What changes on README

A row moves to the new pin only when its rerun passes its rules at the new pin. A changed number replaces the old one,
with its reason in the report and the changelog. Rows not rerun keep their commits. A feature merged after `8a3eedeac`
(memory trust, the verbatim-probe fixes, scoped vector search, the memory proof wave) enters "What gbrain does" or
"Current results" only on evidence measured at a recorded commit inside the new pin's history, or on a keyless rerun at
the new pin.

## The final SHA

When v0.60.169.0 is published, an amendment names its commit before any run there. Steps 1 to 10 then run on two
identical VMs started together, one at `3001fd9a5` and one at the release, under the same rules with `3001fd9a5` as
before. The pin, README and the report name the release only if nothing regresses.

## Budget

None: no paid request. The VMs are compute only.

## Amendments

### 2026-10-11: two harness defects and the Postgres steps, before the second paired run

The first paired run (both VMs at gbrain-evals `ca624e95`) found three problems in this repository, none in gbrain.
Its receipts are kept under `2026-10-11-wave14-repin/run1/`. Nothing above changes. Frozen before the second run:

1. **N6-4.** At `3001fd9a5`, N6 reported 60 existence-oracle probes, all on `delta`. `delta`'s `next_cursor.cursor` is
   base64 JSON that echoes the caller's own `since_slug`, so a protected and a ghost call differed only in the slug the
   caller sent, encoded where the target mask could not reach it. The runner now decodes such cursors and compares
   their content masked; a cursor that differs in anything else still counts.
2. **39-8.** At `3001fd9a5`, Cat 39 counted 4 purged claims as recovered through `query`. Each was a fact row from
   gbrain's new query facts arm (#6066) for the page where the claim is preregistered to remain (another subject's
   fence copy). The runner read a row's page from `slug` or `entity_slug` only, and fact rows name it in `page_slug`.
   It now reads `page_slug` too; a fact row on a purged page still counts.
3. Steps 8 and 9 reached no Postgres (the VM user could not reach Docker), so N1 and N5 ran their PGLite cells only
   and N6 on Postgres did not run. `vm/run.sh` now runs Docker with `sudo`.

The second run repeats steps 1 to 10 on two fresh identical `standard-16` VMs started together, one per pin, at the
commit that carries these fixes, followed on each by `vm/cat7-repeat.sh`, the preregistered paired repeat for the
suspected Cat 7 slowdown the first run showed (`traverse_paths_d1` at 1,000 pages, p50 1.37 to 1.78 ms, +30%). The
second run's receipts are the counted ones; a difference between the runs is reported.

### 2026-10-11: the final target is v0.60.169.0 (`77cf8e111`), before any run there

GBRA-40 set the target: gbrain v0.60.169.0, master `77cf8e1116e9af67c1983adcbb3223b96f0991a5` (the merge of #6447,
memory-proof wave 2 W1, after wave 14's #6480 and #6481). It descends from `3001fd9a5`. Frozen before any run at
`77cf8e111`:

1. **After** becomes `77cf8e111` everywhere above. **Before** stays `8a3eedeac`. Per GBRA-40, the counted pair is
   `8a3eedeac` against `77cf8e111` on two fresh identical `standard-16` VMs started together, running steps 1 to 10 and
   then `vm/cat7-repeat.sh`, at the commit that carries the previous amendment's fixes. This replaces "The final SHA"
   section's `3001fd9a5`-against-release pair and the previous amendment's second `3001fd9a5` run, which was cancelled
   before it finished; no output of it was read.
2. The first run at `3001fd9a5` stays recorded as development evidence (`2026-10-11-wave14-repin/run1/`). The regression
   rules are judged on the counted pair only.
3. Expected moves add v0.60.168.0's timezone conversion of time-only chat timestamps (pages that declare `timezone:`)
   and v0.60.169.0's `recall` `question` parameter.

### 2026-10-11: a third harness defect and a host check, after the counted pair and before any further run

The counted pair (gbrain-evals `301474d1`, before `8a3eedeac`, after `77cf8e111`) finished. Two results break a rule
at `77cf8e111`, and both point at something other than gbrain. Nothing above changes, and the counted pair's receipts
stay the counted ones. Frozen before the next run:

1. **N6-5.** N6 on Postgres over HTTP fails its coverage rule at `77cf8e111`: `recall` is not covered for the scoped
   and owner principals (153 of 155 mandatory cells), with 0 leaks and 0 oracles. The in-process N6 shows the same
   thing as `recall` signal 164 to 0. v0.60.169.0 gives `recall` an optional `question` parameter. The runner filled it
   with the target's query word on every call, alongside `include_expired` and `supersessions`, and gbrain refuses
   that combination by design (`parseQuestionParam`, `invalid_params` with the corrected call as its fix), so every
   `recall` probe was a refusal. Leaving `question` out restores `recall` signal to 224 on the Capy machine. The
   runner now leaves an optional `question` out of the base call and adds a `question` variant that passes it without
   the widening flags. A required `question` (`think`) is filled as before. No operation at `8a3eedeac` has an optional
   `question`, so every probe at the old pin is unchanged.
2. **Host speed.** At `77cf8e111`, every Cat 7 operation at both scales ran 1.3 to 2.7 times slower than at
   `8a3eedeac`, including `putPage_single`, in the offline tier and in all three `vm/cat7-repeat.sh` runs, and the
   Cat7-1 repro failed (p50 0.078 to 0.120 ms against its 0.075 ms limit; 0.055 to 0.060 ms at `8a3eedeac`). Every
   offline-tier category also took longer on the after VM. The first run's after VM at `3001fd9a5` showed none of
   this (Cat 7 within 25% apart from `traverse_paths_d1`; Cat7-1 p50 0.059 to 0.061 ms), and on the Capy machine the
   Cat7-1 repro interleaved three times gives 0.060 ms at `3001fd9a5`, 0.060 ms at `77cf8e111` and 0.057 to 0.084 ms
   at `8a3eedeac`. A two-VM pair cannot separate a slower host from a slower gbrain, so the next run puts both pins on
   each host.

3. **E2 check.** The operator-wave check `edit-page-diff-order` failed at both pins in the counted pair, and at
   `8a3eedeac` in the first run. It is a parse defect in the check, at both pins: the check joined every text block of
   the `edit_page` reply and parsed it as one JSON value, and gbrain sometimes appends a `first_run_decisions` notice as
   a second block, so the parse failed and the check saw an empty diff. The reply's own diff was correct each time. The
   check now reads the first block only; on the Capy machine it passes 10 of 10 runs at each pin. It broke no rule
   (it failed at the old pin too) and is rerun below.

The next run uses two fresh identical `standard-16` VMs started together. Each holds two copies of this tree, one per
pin, differing only in `package.json` and `bun.lock`, and runs `vm/round4.sh`: steps 9 and 10 and the operator-wave checks at both pins, then
three rounds of Cat 7 and the Cat7-1 repro alternating which pin goes first. It is judged as follows:

- Steps 9 and 10 and the operator-wave checks under the rules above, at both pins, on each VM.
- For each Cat 7 operation and scale, the median of the three p50s at `77cf8e111` against the median at `8a3eedeac`
  on the same VM. A slowdown above 25% on both VMs is a confirmed regression and is bisected over the first-parent
  merges, on one VM with both ends interleaved. A slowdown on neither VM means the counted pair's slowdown came from
  the host.
- Cat7-1 counts as a regression if its repro fails at `77cf8e111` and passes at `8a3eedeac` on the same VM.

The report gives the counted pair's results as they are, with this run beside them.

### 2026-10-11: the paid N2 judge arm, approved after round 4 and before it runs

Garry approved the paid N2 contradiction-judge arm at `77cf8e111` with a $30 cap. Frozen before the run:

1. **Same judge and configuration as the measurement README's N2 row reports** (149 of 150, measured at gbrain
   `48ed5e8` in the [wave 7 re-pin](2026-10-03-wave7-repin.md); the row named `739e5cc`, the pin it was carried to).
   That is the runner's fixed judge model `anthropic:claude-haiku-4-5-20251001`, gbrain's judge prompt (version 4 at
   both `48ed5e8` and `77cf8e111`), the $10 probe budget split over 4 concurrent probe runs, and the same world and
   queries. If the model is unavailable, the run stops and no other model is substituted.
2. **Spend** goes through the budget ledger: a program cap of $30 and one budget run of $30. A refused 4xx request
   settles at $0. The wave 7 run cost $7.04.
3. **What it decides.** The N2 report's three decision rules apply as written: recall on offered conflicts at least
   0.80, false contradictions on offered dated changes at most 0.10, and on offered compatible pairs at most 0.10.
   The row's number is the count of the 150 planted same-time conflicts the judge calls contradictions. The judge
   samples once per pair, so a difference from 149 is reported with the wave 7 repeat control's spread as context
   (prompt version 3 gave 132 and then 129 at one commit). It is a regression only if recall on offered conflicts
   falls below 0.80 or a false-contradiction rule that held at `48ed5e8` fails. README moves the row to `77cf8e111`
   with whatever number this run gives.
