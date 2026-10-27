# W11: sealed confirmation of gbrain W4 (weekly belief diff): preregistration (2026-10-17)

Frozen before any held-out cell runs, in a commit separate from every result. The custodian mints the material and runs every cell on Garry's Dyson Sphere, inside `~/Private/gbrain-heldout-custody/`. The implementer never sees the held-out phrasing, the seeds before the run, or row-level output. No held-out text appears in this file, and no data from any production brain is used.

## Question

gbrain W4 (10x memory plan, wave 4a, gbrain [#6866](https://github.com/garrytan/gbrain/pull/6866), v0.60.273.0) answers "what changed this week" from the belief ledger, through `delta {beliefs: true}` and `gbrain beliefs <entity>` (`gbrain beliefs changes`): a netted diff of facts, takes, links and pages over a recorded-time window, each change with its before, after, cause and evidence pointer. W4 passed its plan gate on development data: weekly-change probes from the ledger, set-F1 at or above 0.95 on a synthetic brain (gbrain `test/belief-ledger-weekly-probes.test.ts`, seed 20261016, F1 1.0 on PGLite and Postgres). Does the same bar hold on a fresh seed and on belief lines worded in a way development never saw?

W3 and W9 left V1 (W3 missed its retrieval gate; W9 was decided on a prior), so W11 is this confirmation of W4 alone.

## Evidence class

Held-out confirmation on fresh synthetic material minted by the custodian: new generator seeds and new wording for every belief-changing line. The development evidence is the W4 probe above and gbrain's weekly-diff cells (`test/belief-ledger-weekly-diff.test.ts`), run at $0 by the implementer, plus the development run of this harness listed under "Development check".

## Builds

- **gbrain:** release v0.60.289.0, tag commit `15b1595140d02edb3581be0b510c183295c79288`, the newest release on 2026-10-17 and a descendant of the W4 merge (`6c3e6fe05`, v0.60.273.0). The custodian checks that the tag resolves to that commit and records it in the verdict (the runner does this: `build`, `build_version`). No other build is measured.
- **gbrain-evals:** the merge commit of the pull request that adds this file, `eval/runner/belief-weekly-probes.ts` and `eval/generators/belief-weekly-gen.ts`. The runner records its own commit in `harness` and attests this file against `origin` before the first page is written.

## Harness

`eval/runner/belief-weekly-probes.ts` runs gbrain's W4 acceptance probe on the build under test: the same seeded generator (ported to `eval/generators/belief-weekly-gen.ts`, with the random draws in the probe's order), gbrain's own test helper for an activated managed brain on in-memory PGLite, writes through `put_page`, and `beliefChanges` over each week's recorded-time window. The one change is that every belief-changing line comes from a phrasing template, so the custodian can supply fresh wording (`--phrasing-file`). With development phrasing `W4` it writes the probe's own lines.

The harness is deterministic and calls no model. It runs inside the shared hermetic environment, which strips every provider key, so a model call could not succeed.

## Material (custodian instructions)

1. **Seeds.** Pick three fresh seeds, non-negative integers that are not 20261016 (the development seed; the runner refuses it in custodian mode) and not used by any earlier W4 run. Pick them inside custody before running; do not share them before the verdict is published.
2. **Phrasing.** Write a new file `~/Private/gbrain-heldout-custody/w11-w4/phrasing.json` of the form `{ "id": "<set id>", "templates": { "seed_fact", "seed_take", "fact", "take", "transient" } }`. Each template words one kind of belief-changing line: a starting page's facts and take (`seed_fact`, `seed_take`; placeholders `{i}`, `{title}`, `{slug}`, `{n}`), facts and takes added during a week (`fact`, `take`; `{title}`, `{slug}`, `{n}`), and the fact written and reverted inside one week (`transient`; same placeholders). Rules:
   - The wording must be new: not the development wording (`Company {i} fact {n}`, `{slug} take {n}` and so on), not copied from gbrain tests or fixtures, and not seen by the implementer.
   - Each template must contain `{n}` (it keeps lines distinct), stay on one line of at most 200 characters with no surrounding whitespace, and avoid `|` and `<!--` (they would break the facts and takes tables). The runner refuses a template that breaks these rules, or a set that renders the same line twice, before any page is written.
   - Use invented placeholder entities only (for example `acme-example`). Write the lines yourself: take nothing from Garry's production brain or any real person, company or fund.
3. **Custody.** The phrasing file, the run's output (`--output`) and its working directory (`--work`, where the brains and the hermetic home live) all stay under `~/Private/gbrain-heldout-custody/w11-w4/`, outside every git checkout (the runner refuses paths inside one). Opening the phrasing file appends a line to `access-log.jsonl` beside it. Nothing from custody goes through Capy Drive.
4. **What leaves custody.** Only `verdict.json`, the aggregate the runner writes beside the receipt: build, harness, the phrasing file's SHA-256 and set id, the seeds, the gate counts and the token counts. It contains no line of the phrasing; a harness error is recorded there only as "recorded in the custody receipt". Before publishing, the custodian checks that it quotes no held-out line.

## Gates

Per seed, four weeks of ten edits on six company pages, as in the W4 probe. A change is (kind, page, belief, change); link transitions are outside the set, as in the probe.

- **G1, set-F1 (W4's own bar):** each week's reported diff against the generator's gold, pooled over the seed's four weeks. Passes when set-F1 is **at least 0.95 for every seed**.
- **G2, before and after:** every gold re-score (a fact's confidence, a take's weight) is reported as `changed` with its exact before and after values, and no other re-score is reported. Passes with **0 wrong or missing and 0 extra** over all seeds.
- **G3, cause:** every reported change names op `put_page` (the only writer in this harness) and the event type of the ledger event its evidence points at. Passes when **every** reported change is correct.
- **G4, evidence pointer:** every reported change's evidence names a ledger event of the brain's source, on the change's page, recorded inside the week, at the `recorded_at` it states. Passes when **every** reported change is correct.

These are the checks the W4 harness already scores: G1 and G2 are the probe's assertions, and G3 and G4 apply the weekly-diff cells' cause and evidence assertions to every change the probe reports. No other check is made, so no multiple-comparison correction applies.

**Reported, not gated:** for each week, the belief diff's tokens beside the tokens of `delta`'s page list for the same window, with the page count.

**Engine:** PGLite only. W4's development probe also ran on Postgres; the custody machine runs no test Postgres, and this confirmation is about the diff, not the engine.

**Harness errors** void a seed. A seed with a harness error is rerun once with the same seed; a second failure leaves the run **invalid**, not passed.

## Decision rule and what each outcome changes

| All four gates pass | G1 fails | G2, G3 or G4 fails | Invalid |
|---|---|---|---|
| W4 is confirmed on sealed material: `delta {beliefs: true}` and `gbrain beliefs` keep shipping as they are, and W11 closes. | The diff misses or invents changes on wording it was not built on. W4 is fixed on development data, and a new confirmation needs fresh seeds and fresh phrasing (this set is spent). | The diff is right about what changed but wrong about its values or provenance. Same path: fix on development data, confirm on fresh material. | No verdict is drawn; the custodian reports the error class and the run is repeated after the harness is fixed. |

## Budget

$0 expected: no model or embedding call is made, and the run takes about 20 seconds per seed on PGLite. The cap is $1, a buffer that a run with no provider keys cannot reach; the run is not joined to the paid budget ledger because nothing in it can spend.

## Command (custodian, on the Dyson Sphere)

```
cd <gbrain-evals checkout at the merge commit>
bun install --frozen-lockfile
bun eval/runner/belief-weekly-probes.ts --gbrain <gbrain checkout>@v0.60.289.0 \
  --seeds <s1>,<s2>,<s3> \
  --phrasing-file ~/Private/gbrain-heldout-custody/w11-w4/phrasing.json \
  --decision-id w11-w4-heldout-<date> --purpose "W11 sealed confirmation of gbrain W4" \
  --output ~/Private/gbrain-heldout-custody/w11-w4/out --work ~/Private/gbrain-heldout-custody/w11-w4/work \
  --preregistration docs/benchmarks/2026-10-17-w11-w4-sealed-confirmation-preregistration.md
```

Then publish `~/Private/gbrain-heldout-custody/w11-w4/out/verdict.json` as `docs/benchmarks/2026-10-05-heldout-verdicts/w11-w4-heldout-<date>.json` (the results glob in [`preregistrations.d/w11-w4-sealed-confirmation.json`](preregistrations.d/w11-w4-sealed-confirmation.json)). The receipt (per-week counts and any error text) stays in custody.

## Development check

The harness run on the pinned build with development phrasing and seed 20261016 (`bun eval/runner/belief-weekly-probes.ts --gbrain <gbrain>@v0.60.289.0 --output <dir>`) passes every gate: set-F1 1.0 (37 of 37 gold changes, 0 false), 10 of 10 re-scores exact with none extra, and 37 of 37 causes and evidence pointers correct. Its per-week gold counts (10, 8, 9, 10) and token counts match gbrain's own W4 probe on the same build exactly, so the port measures what the probe measures.

## Amendments

None yet.
