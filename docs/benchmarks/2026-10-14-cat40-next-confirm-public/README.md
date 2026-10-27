# Cat 40 next wave confirmation: public generator (P1, P2)

Counted, preregistered (`docs/plans/2026-10-11-cat40-next-wave/PREREG.md`). This directory holds the public half of
the confirmation. The sealed worlds (S1, S2) have not run, so the general claim, which needs both generators, and the
pooled four-world D3 test are not decided here. Every number below comes from `next_confirm_analysis.py` at the frozen
harness `06a46d95` (`public-analysis.txt`, `public-analysis.json`).

## Result

| Endpoint | Δ pp | 95% interval | Counts |
|---|---:|---|---|
| **Primary, public: wave − fs** | **+12.50** | [+9.17, +15.83] | 499 vs 424 of 600 (ahead) |
| P1 alone | +11.33 | [+6.67, +16.33] | 243 vs 209 |
| P2 alone | +13.67 | [+9.33, +18.33] | 256 vs 215 |
| Wave − baseline, success | +4.00 | [+1.33, +6.83] | 499 vs 475 |
| Wave − baseline, wrong values (D3, public only) | −3.50 | [−5.67, −1.33] | 22 vs 43 |
| Wave − baseline, wrong submitted | −4.00 | [−6.83, −1.33] | 31 vs 55 |
| Wave − baseline, not submitted | 0.00 | [−1.50, +1.50] | 70 vs 70 |
| Wave − baseline, turn cap | −0.17 | [−1.67, +1.33] | 69 vs 70 |

Interval: nested task bootstrap, 10,000 resamples, `random.Random(1)`, seeds fixed. The fewer wrong values do not come
from more non-answers (non-submission is level).

- **Per family, wave − baseline success:** H4 +16.67 [+10.0, +24.17] (H4 `+long` +20.2 [+12.1, +28.3], not-long 0.0);
  H1 +2.5, H2 0.0, H3 0.0, H5 +0.83 (H5 at 120/120 vs 119/120 is a ceiling). Wave − fs is positive in every family:
  H1 +19.2, H2 +4.2 [−4.2, +12.5], H3 +21.7, H4 +5.0, H5 +12.5.
- **Per model, wave − baseline:** Sonnet success +8.0 [+3.0, +13.0] and wrong values −7.0 [−12.0, −2.0]; Opus +3.0
  [−1.5, +7.5] and −3.5 [−6.5, −1.0]; GPT-6.1 Sol +1.0 [−2.0, +4.0] and 0.0 (Sol is near ceiling: 175 vs 173 of 200).
- **Sol watch:** 2 wrong-value cells under wave vs 2 under baseline; not flagged.

## Run

- **Builds.** Wave gbrain `4e10136b4` (Part 1 with F5 restored, `src/` identical to `e67dcc9f8`), all-on config plus
  `mentions.owner_phrases=true` at slot build. Baseline `09d21554d`, no config.
- **Gates.** Both worlds pass `check-world` against the recorded digests. Model freshness exited 0 on 2026-10-14.
  Oracle: P1 298/300, P2 295/300 (gate ≥ 95% passes). All 20 slots pass the write, restore and rerank probes with 0
  queued effects. Wave slots read back the full all-on config and hold 18,055 (P1) and 18,629 (P2) owner-phrase
  links; baseline slots read back `{}` with 0 links.
- **Cells.** 300 canonical cells in each of 8 arm runs (oracle, baseline, wave, fs × 2 worlds), 0 harness errors, one
  attempt per cell.
- **Firing.** Wave: names rows 3,363 / 2,707 with records on 2,824 / 2,235, known_as 122 / 73, page_status 0; served
  instructions `3bb1d6aafd23…`, the same as development all-on. Baseline: no record rows (no F1), instructions
  `8876e6f1a486…`. Names-call p50/p99: wave 269/1,197 ms (P1) and 248/1,144 ms (P2); baseline 217/1,116 and 197/935.
- **Spend** (public ledger, cap $1,700): $1,316.96 committed. Arm runs: oracle $27.19 / $25.01; P1 baseline $166.56,
  wave $144.39, fs $305.36; P2 baseline $154.27, wave $141.97, fs $284.74 (caps $252 gbrain, $364 fs, $32 oracle).
  Slot builds are the rest, including $12.91 lost to the first attempt (below). Projection after each world's first
  counted arm: $1,454 then $1,374 (+10% under the cap both times; `projection.jsonl`).

## Deviations from the plan's execution (no cell affected)

1. **First slot-build attempt failed.** All 20 slot builds were started at once, one process per slot. Together they
   exceeded the OpenAI embedding rate limit (10,000 requests per minute), and every build's `gbrain embed` step hit
   the runner's 1-hour kill at 43–76%. The driver stopped both worlds before any counted cell. Logs:
   `drive.attempt1.log`, receipts in `p?/slots-*.attempt1/`. Cost $12.91, from the retry reserve.
2. **Relaunch.** Same VM, harness, argv and ledger; at most 5 slot builds at a time (P1's first), each from a fresh
   slot directory. Oracles, check-world and freshness were not rerun (their results stand).
3. **Per-slot processes and parallel worlds.** Each `slots-*` step ran as five `--build-slot-ids i` processes with one
   allowance each (as in development), and P1 and P2 ran side by side on one VM (`drive.py`). The plan's argv is
   otherwise exact.

VM: `ubirun-gbra39pub-1791928207-96180a31` (eu-central-h1, standard-60, owner tag `gbra39pub`), destroyed after the
outputs were copied.

## Added 2026-10-14: F5 will not ship, and what that means for these numbers

F5's ship condition failed on `messy-company-v1` (6 links, all correct, against the 22 required; Wilson lower bound
0.610; recall 3.0% dev and 6.9% held-out vs 99.8% on World M). The shipped Part 1 excludes F5, so the wave measured
here is not the build that ships.

- The wave − baseline gain (+4.0 pp success, −3.5 pp wrong values, concentrated in H4) depends on F5. Development
  round 3 measured the no-F5 configuration as level with control, and F5's links fire on generator-written ownership
  text but almost never on independently written prose. So the H4 gain probably does not transfer to real brains.
- The wave − fs gap for the shipped build is unknown. The closest evidence is round 3 (no-F5 ≈ control) plus the
  baseline arm's own lead over files.

**Descriptive secondary, not preregistered: baseline − fs** (same cells and procedure,
`public-baseline-vs-fs.json`): **+8.50 pp [+4.83, +12.33]** (475 vs 424 of 600); P1 +9.67 [+4.33, +14.67], P2 +7.33
[+2.0, +13.0].
