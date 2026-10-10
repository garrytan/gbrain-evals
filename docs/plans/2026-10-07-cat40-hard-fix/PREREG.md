# Cat 40 Hard fix wave: confirmation preregistration

Written 2026-10-10, before any confirmation world is generated and before any confirmation cell runs. This document is final once committed. The executor appends values that do not exist yet (world digests, VM names, ledger run ids) under "Recorded before cells" and changes nothing else. Any other change after the first cell gets a dated amendment section with its reason.

## Authorization

- Garry Tan, 2026-10-10, on the development record ([DEV-RECORD.md](DEV-RECORD.md)): "1 approved, 2 yeah that works 3 b".
- (1) Confirmation spend of about $1,300 is approved.
- (2) What a loss means, in Garry's words as accepted: **"we publish it and stop claiming gbrain beats files on hard company questions."**
- (3) Sealed logistics, option (b): the sealed world is generated on Garry's Mac, where its seed stays, then moved straight to one Ubicloud VM named below as the owner-custody machine. All sealed slots and cells run there. Sealed documents and outputs never go to Capy Drive.

## What runs

| | Value |
|---|---|
| gbrain build | `3e4ff61ce1ac553581fb5c1eb905cf48541fe344` (branch `capy/cat40-hard-fix`, gbrain #6271; contains master `d4dc2d4d8`, v0.60.139.0). Full ci:ubicloud gate and GitHub CI green on this exact SHA. Starter surface, no instruction or tool-description overrides. This is the build of development round 5. |
| Harness | gbrain-evals `feat/cat40-hard` with the sealed generator branch (`feat/cat40-hard-sealed`, `36b19ba`) merged in, plus three confirmation commits: register the confirmation seed, register the program steps, and the warm-boot fix below. The SHA is recorded below before cells. |
| Worlds | **M**: main Hard generator (`model-ladder-hard-v2`), seed **20261021** (never generated before), 50k (`--scale large`), frozen knobs `docs/benchmarks/cat40-hard/knobs.frozen.json`. **S**: sealed generator (`hard-sealed-v2`), private seed on Garry's Mac, 50k, the same frozen knobs. |
| Arms | `gbrain` and `fs` (counted); `oracle` (world check only). |
| Models | `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`. Fable is excluded (smoke only, amendment A6). |
| Judge | `gpt-6.1-sol` |
| Tasks | Every task in each world (100: H1–H5, 20 per family), repeat 1. |
| Fixed settings | 16-turn cap, Hard tool limits, 5 gbrain slots per world, concurrency 10. Every setting not named here is identical for both arms and equal to the held-out run (`cells-50k`). |

**Warm-boot fix (harness, gbrain arm only).** The slot build already makes one clean server start before the snapshot, "the way an installed brain has already been opened once" (`gbrain-arm.ts`). Since gbrain #6390 (`c33963d0`), the server answers `initialize` before its startup work finishes, so that start now ends early and the snapshot keeps about 47k queued no-op persistence effects. Every restore then stalls its first tool call for 230–290 s (development round 5, diagnosed 2026-10-10). The fix makes the warm start issue one read-only tool call and wait for its reply before stopping. That restores the documented intent: a brain that has been opened once. The slot receipt records the queued-effect count at snapshot time. This changes no answer and no arm setting; development round 5 scored normally with the stall. The product bug ships separately as a master fix (GBRA-40's call). The report states both.

## Gates before counted cells (per world)

1. The world validates against its generator. **S** only: the regenerated world's digest equals the committed `61870796c34d922daeb2909a5c30e44e1121504054f83319ef8a6307ca570a00`. If code that shapes the world (`schema.ts`, `semantics.ts`, the sealed generator) changed since the digest was recorded, `--digest-only` is run on the Mac first and a new digest is recorded below, with the reason, before generating.
2. Oracle on all 100 tasks with the three models: pooled success ≥ 95%. Below that, stop, report and run no counted cells on that world.
3. Every gbrain slot passes the write probe and the fail-closed rerank probe. Each slot's queued-effect count at snapshot is 0.
4. Projection plus 15% fits the world's ledger.

## Endpoints and decision rule

For each world W in {M, S}, Δ_W is the pooled gbrain − fs success rate over the three models: the mean over models of each model's gbrain rate minus its fs rate, on the same 100 tasks. Its 95% interval comes from a task-clustered bootstrap (10,000 resamples of tasks, seed 1, all three models resampled together).

**Co-primary (UC2):** gbrain has reached parity with or beaten plain files only if **both** Δ_M ≥ 0 **and** Δ_S ≥ 0 (point estimates).

- If either point estimate is below 0, the **kill criterion** fires. We publish the result as it is, stop this wave's tuning on these tasks, and follow Garry's statement above: stop claiming gbrain beats files on hard company questions.
- **Wording:** "parity" only when an interval's lower bound is above −3 points; otherwise "not distinguishable", with the point estimate. "Ahead" only when the lower bound is above 0. A general reliability claim needs both worlds to pass. If M passes and S does not, the result is reported as "parity on the main generator's wording only", and it still counts as a kill.
- No result is dropped, and no cell is rerun except a harness or provider error that the runner's existing retry rules cover.

**Secondary, reported for both worlds:** per-model and per-family rates; the wrong-answer rate; turn-cap stops; cost per successful task; median seconds per cell; the rerank check (cells with a hybrid search show `voyage:rerank-2.5` in metering, and degraded notices are counted); the DX measures from the plan (nickname seen and queried, tool calls to the first alias query). Development results are never pooled with confirmation results.

## Budget

Two ledgers, one per world, because the worlds run on separate machines:

- `.budget/cat40-hard-confirm-main.sqlite`, cap $650;
- `.budget/cat40-hard-confirm-sealed.sqlite`, cap $650.

Estimate per world, from development per-cell costs: about $450 in cells, $25 for the oracle and $15 for slots, so about $490, or $565 with a 15% margin. The two worlds total about $980. A world that would exceed its cap stops and reports; raising a cap needs Garry.

## Hygiene

- No development agent has read the sealed generator's code or any sealed output. The alias grammar spec (`835024150`) predates every calibration document.
- After the confirmation, no gbrain change is tuned on M or S tasks.
- The sealed seed never leaves Garry's Mac. The sealed world crosses one Capy cloud machine in transit, is deleted there once the custody VM holds it, and never touches Capy Drive.
- The custody VM is destroyed after its outputs (results, transcripts, receipts; no world documents) are copied to the report.

## Recorded before cells

(Appended by the executor; no edits above this line.)

- **Harness** (2026-10-10): gbrain-evals `feat/cat40-hard` at `d0057206b6b954d8189a5115f0c13561c8f4647f`. It is `b7002c15` plus the sealed generator merge (`c6b3ab29`, merging `36b19ba`) and three confirmation commits: `c294280d` (seed 20261021 as `HARD_SEEDS.confirmation`; the confirmation and sealed worlds need the frozen generator), `038821e6` (program steps `confirm-world`, `confirm-slots`, `confirm-oracle`, `confirm-cells` per world, one $650 ledger per world, the 95% oracle gate; `gbrain-fs` stays refused) and `d0057206` (the warm-boot fix: the warm start waits for the reply to one read-only `entity` call, at most 3 starts while effects remain, and each slot's coverage record and receipt carry `queued_effects` at snapshot). `bunx tsc --noEmit -p .` is clean and the 266 cat40 tests pass.
- **Freeze check** at that SHA: frozen code changed in `eval/generators/hard/schema.ts` (only the `confirmation` entry added to `HARD_SEEDS`) and `eval/runner/cat40/hard.ts` (the sealed generator's registration from `36b19ba`, `requiresFreeze` covering the confirmation and sealed worlds, and two stop codes). Neither changes a world, a score or an arm. Confirmation steps run with `--accept-freeze-drift "PREREG.md (cat40-hard-fix): harness d0057206 preregistered; drift is seed registration and sealed generator registration only (2026-10-10)"`. `semantics.ts` and the sealed generator are unchanged since `9ca2956`.
- **World M** (2026-10-10, `CONFIRM_WORLD=main scripts/cat40-hard.sh step confirm-world` at `d0057206`): `model-ladder-hard-v2`, seed 20261021, scale large, knob digest `37a16085e0fbf2e92072b2e7cf00468d43451dd4fb35bb1232ebbf79d3027434` (`knobs.frozen.json`). Validates against its generator. World digest `6f08629ed86f8913152d562820088ba914fd6862bb48c7836b866ad363388f78`; `world.json` file SHA-256 `99c53db046c4efa256d39133d6b149f6e557ae8e6cad0664f672434b7b207186`; 55,838 documents, 100 tasks (20 per family). Its 4k base (no cells): digest `84f0614ae35ff28014d5fb815d02dfbc5799488e5ac7d61a0c56c06b1b301c8e`, 13,581 documents. Generated on `ubirun-gbra39s18-1791600323-19a82f1c`, where world M's slots and cells run.
- **World S** (2026-10-10): `--digest-only --scale large --knobs docs/benchmarks/cat40-hard/knobs.frozen.json` on Garry's Mac at `d0057206` printed `61870796c34d922daeb2909a5c30e44e1121504054f83319ef8a6307ca570a00`, equal to the committed digest (only `HARD_SEEDS` gained an entry since `9ca2956`; no world-shaping code changed), so no new digest is recorded. The 50k world was then generated on the Mac (`hard-sealed-v2`, 55,128 documents, 100 tasks, knob digest `37a16085…`); `world.json` (file SHA-256 `61870796…`) and `digest.txt` went Mac → one Capy cloud machine → the custody VM, and the transit copy was deleted once the custody VM's SHA-256 matched. The rendered `docs/` stayed on the Mac. On the custody VM the world validates against its generator and `confirm-world` confirms the digest. Note: `world.json` records its own seed (the runner regenerates the world from it to validate), so the seed travels inside `world.json`; the seed file itself never left the Mac and the seed was never printed.
- **Custody VM** for world S: `ubirun-gbra39-1791649874-6fc77e3a` (Ubicloud eu-central-h1, standard-16, 320 GiB, owner tag `gbra39`).
- **Ledgers** (2026-10-10, `init --program-cap-usd 650 --reason "Garry Tan 2026-10-10 confirmation approval"`): `.budget/cat40-hard-confirm-main.sqlite` on `ubirun-gbra39s18-1791600323-19a82f1c`, `.budget/cat40-hard-confirm-sealed.sqlite` on the custody VM.
- **Oracle gates** (2026-10-10, gate 2): world M 299/300 (99.7%; Opus 100, Sol 100, Sonnet 99); world S 286/300 (95.3%; Opus 99, Sonnet 94, Sol 93). Both pass; no harness errors.
- **Custody VM replaced** (2026-10-10): `ubirun-gbra39-1791649874-6fc77e3a` was destroyed at about 17:30 UTC by another lane's VM cleanup (it took the VM for a leftover of its own `gbra39` tag), before any S slot or counted cell finished. Its first S slot was still building. The first `.budget/cat40-hard-confirm-sealed.sqlite` went with it: it held the S oracle step ($25.77, measured from the cell records) and the lost slot build (at most $8, two slot allowances). A replacement ledger with the same name, cap and reason was opened on the new VM; the $33.77 already spent on S is counted against S's $650 when its projection is checked. The new custody VM is `ubirun-gbra39seal-1791657729-cdfa7ddf` (eu-central-h1, standard-16, 320 GiB, owner tag `gbra39seal`, used by no other lane). The world moved again by the same path from the Mac's copy (file SHA-256 `61870796…`, equal to the recorded digest) and validates there; the transit copy was deleted. The S oracle results stand: they do not depend on the VM, and their records were restored to the new VM from the copy made after the step (seed redacted in that copy).
- **S slot build, second attempt** (2026-10-10): on the new custody VM the step's first slot stopped in `gbrain embed` when the $4.00 per-slot allowance ran out (30.8M embedding tokens, $4.00 charged; the S corpus is about 21% larger than M's 99 MB, whose slots cost $2.74 each). No snapshot was written and no cell ran. The build was rerun with the same runner command and `--slot-build-allowance-usd 6 --budget-usd 35` into `eval/reports/cat40/hard-confirm/sealed/slots-b` (the first attempt's directory holds its receipt). The allowance is a per-slot spending ceiling only; the build and every slot setting are unchanged. S spend before its slots: $33.77 lost with the first VM plus this $4.00.
