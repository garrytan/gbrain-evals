# Remote `find_contradictions` (wave 5 D9): N6 holds at 0 leaks, and N2's compatible-pair rule holds (2026-10-15)

gbrain [#6784](https://github.com/garrytan/gbrain/pull/6784), released as [v0.60.250.0](https://github.com/garrytan/gbrain/releases/tag/v0.60.250.0) (merge commit [`3c16e9ba4`](https://github.com/garrytan/gbrain/commit/3c16e9ba42f8852bfde6c6fb3a86ed07afe811ca)), lifts the remote suspension of `find_contradictions` (N2-5). Remote, source-scoped and `min_trust` callers now get stored findings. Each side is re-read live by its chunk or take id under the caller's read policy, and a finding comes back only when both sides are visible and both still read as they did when judged. Stored report text, the query and the run total never reach these callers.

## N6: zero leaks, with a forced probe that leaks

Before this change N6 could not exercise `find_contradictions`, because the op returned an empty note to every scoped caller and the world had no stored report. The runner now seeds one in `seed()` (`seedContradictionReport`). It runs gbrain's own `runContradictionProbe` with a fixture retrieval that offers each class's protected page, its public twin and the hub together, plus an oracle judge that calls every pair a contradiction and writes both sides' text into the axis. The report then copies every protected marker, as a real report on this world would: chunk text, held takes through the intra-page pairs, and the axis. On a build without the probe modules the step is skipped.

Same world (seed 20260930), same runner, three gbrain builds:

| gbrain | `find_contradictions` probes / with signal / leaks | Whole run |
|---|---|---|
| v0.60.250.0 (`3c16e9ba4`) | 540 / 160 / **0** | 11,104 exposed probes, 4,388 with signal, **0 content and 0 existence leaks**, 0 oracles, 0 of 108 gates bypassed, 33/33 content-reachable ops covered: **pass** |
| master `ea93c770b` | 216 / 0 / 0 (suspended) | 10,888 probes, 0 leaks: pass |
| #6784 head `aee452979` with the live re-read bypassed (forced probe, local scratch commit `513f569d7`, never pushed) | 540 / 288 / **288** | 288 content and 192 existence leaks, all on `find_contradictions`: **fail** |

The release tree differs from the #6784 head `aee452979` only in the release stamp, its CHANGELOG entry and one behavior-change notice row; an earlier N6 run at `aee452979` gave the same counts. Signal means the trusted local caller, given the same arguments, reads a protected marker. On the fix it comes from the private-page and held-take classes, which the local caller sees in its own source. The forced probe shows the detector fires on exactly the path the fix guards.

Receipts: [v0.60.250.0](2026-10-15-d9-find-contradictions/n6-receipt-v0.60.250.0.json), [master](2026-10-15-d9-find-contradictions/n6-receipt-master-ea93c77.json), [forced](2026-10-15-d9-find-contradictions/n6-receipt-forced-unfiltered.json).

## N2: the compatible-pair rule holds; no paid rerun

The preregistered rule caps false contradictions on offered compatible pairs at 0.10. It failed at wave 7 (`48ed5e8`, 6 of 51, 11.8%) and held at the wave 14 re-pin (`77cf8e111`, 4 of 51, 7.8%). The two runs differ only in sampling ([wave 14](2026-10-11-wave14-repin.md#the-paid-n2-judge-arm)).

No commit since `77cf8e111` changes gbrain's judge or probe: the only change under `src/core/eval-contradictions` is the read path #6784 adds (`scoped-read.ts`). The keyless N2 arm at v0.60.250.0 (`3c16e9ba4`) offers the same 2,680 pairs as `77cf8e111`: identical counts per variant, 1,977 unplanted pairs, 150 conflicts, and an identical date signal, with the verdict pass at both. So the wave 14 paid number carries forward unchanged. No paid call was made, and the spend was $0.

The same arm shows the new behavior on N2's world. A remote caller reads 100 of the 190 stored findings (the limit), where it got 0 before. The trusted unscoped CLI still reads the stored report, with `total_in_run` 190.

An earlier run at the #6784 commit `e8e7db441` gave the same counts.

Receipts: [v0.60.250.0](2026-10-15-d9-find-contradictions/n2-hermetic-receipt-v0.60.250.0.json), [`77cf8e111`](2026-10-15-d9-find-contradictions/n2-hermetic-receipt-77cf8e1.json).

**Reproduce.** `bun eval/runner/n6-visibility-fuzz.ts --gbrain <checkout>@<ref>` and `bun eval/runner/n2-contradiction-surfacing.ts --gbrain <checkout>@<ref>` (keyless, $0).
