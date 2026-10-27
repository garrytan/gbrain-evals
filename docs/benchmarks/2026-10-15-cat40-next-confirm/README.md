# Cat 40 next wave: confirmation report

Counted and preregistered in `docs/plans/2026-10-11-cat40-next-wave/PREREG.md`, with Amendment 1 (2026-10-14) and a
cap note (2026-10-15). Public worlds P1 and P2 ran on 2026-10-13/14. Sealed worlds S1 and S2 ran on 2026-10-14/15.

## Bottom line

Neither generator tested the build that ships. The two generators ended up testing two different builds, and
neither of them is the one that ships:

- **Public generator, build with F5:** gbrain beats files, +12.50 pp [+9.17, +15.83] ("ahead"). It also beats the
  baseline, +4.00 pp [+1.33, +6.83], with fewer wrong values (−3.50 pp [−5.67, −1.33]). Almost all of that is H4,
  and it depends on F5.
- **Sealed generator, build without F5:** gbrain beats files, +10.67 pp [+7.00, +14.50] ("ahead"). It does **not**
  beat the baseline: success −1.17 pp [−4.33, +2.00], wrong values −0.67 pp [−2.67, +1.33]. D3 fails here.
- **F5 failed its ship condition** on independently written prose (6 links found, 22 required), so Part 1 ships
  without it. On the evidence here, the wave's gain over the baseline doesn't reach the build that ships. That
  matches development round 3, where all-on without F5 measured level with the control.
- **The baseline alone also beats files on both generators** (descriptive, not preregistered): +8.50 pp
  [+4.83, +12.33] on public and +11.83 pp [+8.00, +15.83] on sealed. So gbrain's lead over files holds on both
  generators even without the wave. On sealed, the no-F5 wave measured about where the baseline did, and below it
  as a point estimate.

Because no single build ran on both generators (Amendment 1), the preregistered "both generators pass" general claim
isn't made. Each build is reported on its own generator.

## What ran

| | Public (P1 seed 20262041, P2 seed 20262051) | Sealed (S1, S2; seeds in owner custody) |
|---|---|---|
| Wave build | gbrain `4e10136b4`, all-on keys, **F5 on** (`mentions.owner_phrases=true` at slot build) | gbrain `4e10136b4`, all-on keys, **F5 off** (Amendment 1) |
| Baseline | `09d21554d`, no config | same |
| fs, oracle | as #93 | same |
| Models, judge | Opus 5.5, Sonnet 5.5, GPT-6.1 Sol; judge GPT-6.1 Sol | same |
| Harness | gbrain-evals `06a46d95` (detached) | same |
| Cells | 4 arms × 300 per world, 0 harness errors | same |

`src/` at `4e10136b4` is identical to the development build `a798de1f` and to `e67dcc9f8`.

**Why the sealed wave has F5 off.** On every sealed F5-on slot, F5 found 0 owner-phrase links (670 windows per S1
slot). On public, the same build found 18,055 links on P1 and 18,629 on P2. Gate 3 refused those slots. Garry
approved Amendment 1 ("yes", 2026-10-14), which runs the sealed wave without F5. That is development round 3's
configuration and the shipped behavior. The decision was made before any sealed wave cell ran, and after the public
results had been seen.

## Results

Every interval below is the preregistered nested task bootstrap: 10,000 resamples, `random.Random(1)`, with tasks
nested in seeds and seeds held fixed. Δ is in pp.

### Primary: wave − fs, per generator

| Generator (build) | Δ | 95% interval | Successes | Wording |
|---|---:|---|---|---|
| **Public (F5 on)** | **+12.50** | [+9.17, +15.83] | 499 vs 424 of 600 | ahead |
| P1 | +11.33 | [+6.67, +16.33] | 243 vs 209 | |
| P2 | +13.67 | [+9.33, +18.33] | 256 vs 215 | |
| **Sealed (F5 off)** | **+10.67** | [+7.00, +14.50] | 382 vs 318 of 600 | ahead |
| S1 | +13.33 | [+8.00, +18.67] | 195 vs 155 | |
| S2 | +8.00 | [+3.00, +13.33] | 187 vs 163 | |

### Wave − baseline (secondary 1 and D3), per generator

| | Public (F5 on) | Sealed (F5 off) |
|---|---|---|
| Success | **+4.00 [+1.33, +6.83]** (499 vs 475) | −1.17 [−4.33, +2.00] (382 vs 389) |
| Wrong values (D3) | **−3.50 [−5.67, −1.33]** (22 vs 43): **passes** | −0.67 [−2.67, +1.33] (38 vs 42): **fails** |
| Wrong submitted | −4.00 [−6.83, −1.33] | −1.17 [−3.50, +1.17] |
| Not submitted | 0.00 [−1.50, +1.50] | +2.33 [−0.33, +5.17] |
| Turn-cap stops | −0.17 [−1.67, +1.33] | +2.33 [−0.33, +5.17] |

D3 is tested per generator, as Amendment 1 requires: wave − baseline ≤ −2.0 pp, with the upper bound below 0. On
public, the drop in wrong values doesn't come from answering less, because non-submission is level.

### Baseline − fs (descriptive, not preregistered; same cells and procedure)

| Generator | Δ | 95% interval | Per world |
|---|---:|---|---|
| Public | +8.50 | [+4.83, +12.33] (475 vs 424) | P1 +9.67 [+4.33, +14.67], P2 +7.33 [+2.00, +13.00] |
| Sealed | +11.83 | [+8.00, +15.83] (389 vs 318) | S1 +13.00 [+8.00, +18.33], S2 +10.67 [+5.33, +16.33] |

This is the closest measurement here to the build that ships, because Part 1 without F5 measured near the baseline
on sealed and near the control in round 3. It is not a measurement of the shipped head itself.

### By family, wave − baseline success

| Family | Public (F5 on) | Sealed (F5 off) |
|---|---|---|
| H1 | +2.5 [−5.0, +10.0] | 0.0 [−5.0, +5.0] (11 vs 11 of 120: floor) |
| H2 | 0.0 [−5.8, +5.0] | −4.2 [−10.0, +1.7] |
| H3 | 0.0 [−4.2, +4.2] | +1.7 [−6.7, +9.2] |
| **H4** | **+16.7 [+10.0, +24.2]** (`+long` +20.2) | **−6.7 [−15.8, +2.5]** (the sealed generator has no `+long` variants) |
| H5 | +0.8 (120 vs 119: ceiling) | +3.3 [−0.8, +7.5] |

The public gain is H4, the family F5 targets. Without F5 on sealed, H4 moves the other way. Wave − fs is positive in
every public family. On sealed it is positive in H1 (+9.2), H3 (+37.5) and H2/H4 (intervals cross 0), and level in
H5 (−0.8, a ceiling).

### By model, wave − baseline (people-facing models first)

| Model | Public success | Public wrong values | Sealed success | Sealed wrong values |
|---|---|---|---|---|
| Claude Sonnet 5.5 | **+8.0 [+3.0, +13.0]** | **−7.0 [−12.0, −2.0]** | 0.0 [−6.5, +6.5] | −3.5 [−8.5, +1.5] |
| Claude Opus 5.5 | +3.0 [−1.5, +7.5] | −3.5 [−6.5, −1.0] | −3.5 [−8.5, +1.5] | +1.5 [−1.0, +4.0] |
| GPT-6.1 Sol | +1.0 [−2.0, +4.0] | 0.0 | 0.0 [−3.5, +3.5] | 0.0 |

Sol sits near its ceiling on public (175 vs 173 of 200). **Sol watch:** 2 vs 2 wrong-value cells on public and 1 vs 1
on sealed, so it isn't flagged. On sealed, wave − fs by model is Opus +14.5, Sol +14.5 and Sonnet +3.0
[−4.0, +10.0].

### Draft-first (secondary 6, public only)

This uses `draft_first.py`'s settled definition (`public/confirm_draft_first.py`, adapted only for the world path and
arm directories).

- **Firing:** the wave served draft-first names rows on 40 of 60 H4 cells in each public world.
- **Harm:** on draft-led tasks the wave had 0 wrong values against the baseline's 5 (P1, 45 cells) and 8 (P2, 51
  cells). On the cells actually served a draft-first row, it had 0 against 7 and 0 against 8. That matches the
  expected sign (≤ 0).
- **Sealed:** not computed. The definition needs the world's documents, and the custody VM was destroyed after a
  seed-redacted copy without documents was taken.

### Firing, cost and latency (secondary 7)

| | Public wave | Public baseline | Sealed wave | Sealed baseline |
|---|---|---|---|---|
| Names rows (with records) | 6,070 (5,059) | 5,917 (0) | 2,770 (988) | 1,998 (0) |
| known_as rows | 195 | 0 | 0 | 0 |
| Served instructions | `3bb1d6aa…` (= dev all-on) | `8876e6f1…` | `3bb1d6aa…` | `8876e6f1…` |
| Names-call p50 (ms) | 269 / 248 | 217 / 197 | 276 / 277 | 222 / 226 |
| $ per successful cell | 0.53 | 0.63 | 0.98 | 0.94 |
| Median seconds per cell | 145.9 | 148.6 | 180.2 | 155.8 |

For comparison, fs costs $1.35 per success on public and $1.77 on sealed, with medians of 72 and 68 seconds. The
rerank check passed on every slot.

## F5's ship condition and what it means here

- **F5 failed** on `messy-company-v1`, under a rule hashed before the run (`6ca46ba4…0b11`), on gbrain `4e10136b`,
  both splits, 226 pages. It found 6 owner-phrase links, all 6 correct, but 22 are required: Wilson lower bound
  0.610, which fails on volume. Recall was 3.0% (dev) and 6.9% (held-out), against 99.8% on World M, with 0 links
  where the gold labels say not to link. **The shipped Part 1 excludes F5.**
- **The public wave − baseline gain depends on F5.** Development round 3 measured all-on without F5 as level with the
  control (−0.5 pp [−3.8, +2.8]) and clearly worse than all-on with F5. The sealed generator, which gives F5 nothing
  to link, shows the same pattern: wave without F5 ≈ baseline.
- **F5 fires on generator-written ownership text** (about 18k links per public world) and almost never on
  independently written prose (messy-company-v1) or on the sealed generator (0). So the public H4 gain probably
  doesn't transfer to real brains.
- **The shipped build's gap to files is unknown.** The evidence above bounds it: the shipped Part 1 is, in effect,
  the sealed wave configuration (all-on keys without F5), which beat files by +10.67 pp on sealed. The baseline beat
  files by +8.50 and +11.83. None of these was measured on the shipped head.

## Integrity

- **Gates.** Every world passes `check-world` against its recorded digest. Sealed worlds were checked by sha256 on
  the Mac, on the transit machine and on the custody VM, and the transit copies were deleted.
- **Model freshness:** exit 0 on 2026-10-14.
- **Oracle:** P1 298, P2 295, S1 287 and S2 287 of 300, all passing the ≥95% gate.
- **Slots.** Every slot used for cells passed the write, restore and rerank probes with 0 queued effects. Readback
  matched each recipe. Public wave slots held about 18k owner-phrase links; every other family held 0.
- **Cells.** 16 arm runs × 300 canonical cells, 0 harness errors, one attempt per cell.
- **Sealed custody.** Seeds never left Garry's Mac, and `world.json` crossed one Capy machine in transit. Outputs
  were pulled with the seed redacted on the VM (76 files redacted, 0 left holding a seed). Only aggregates are
  published here: `sealed/`.

## Spend

| Ledger | Committed | Cap |
|---|---:|---:|
| Public (`cat40-next-confirm-public`) | $1,316.96 | $1,700 |
| Sealed (`cat40-next-confirm-sealed`) | $1,546.29 | $2,000 (raised from $1,700, cap note 2026-10-15) |
| **Program** | **$2,863.25** | $3,400 approved |

Every arm finished under its cap: gbrain arms $141.97–$199.88 (cap $252), fs $275.99–$305.36 (public cap $364,
sealed cap $420), oracle $25.01–$27.85 (cap $32). Waste included in those totals:

- $12.91 on the first public slot attempt, which hit the embedding rate limit.
- About $42 on F5-on sealed wave slots that were never used.

## Deviations, all recorded in PREREG

1. **Public slot builds, first attempt.** All 20 builds started at once, hit the OpenAI embedding rate limit, and
   failed before any cell. The relaunch built at most 5 at a time.
2. **Slot builds ran one process per slot, and both worlds of a generator ran side by side on one VM**
   (`drive.py` in `docs/benchmarks/2026-10-14-cat40-next-confirm-public/`).
3. **Amendment 1:** the sealed wave arm ran with F5 off, and the analysis is per build and per generator.
4. **Cap note:** the sealed ledger cap was raised to $2,000 and the sealed fs arm cap to $420. This was done after the
   sealed baselines and before any sealed wave or fs cell, when the projection check stopped the run as
   preregistered.

## Limitations

- **No build was tested on both generators**, and neither tested build is exactly the head that ships.
- **The sealed wave arm was chosen after the public results were seen** (Amendment 1). F5 had already failed its
  ship condition when the sealed configuration was fixed.
- **Intervals are conditional on two worlds per generator.** Seeds are not resampled.
- **The sealed generator can't test F5** (0 links) and has no H4 `+long` variants. Sealed H1 is near the floor for
  every gbrain arm (11 of 120).
- **Draft-first was computed on public only.**

## Files

- Public cells, receipts, transcripts and analysis: `../2026-10-14-cat40-next-confirm-public/`.
- Public draft-first: `public/`.
- Sealed aggregates: `sealed/`, containing the analysis, baseline − fs, firing counts, ledger runs, driver logs and
  projections. No sealed cells or transcripts are published.
