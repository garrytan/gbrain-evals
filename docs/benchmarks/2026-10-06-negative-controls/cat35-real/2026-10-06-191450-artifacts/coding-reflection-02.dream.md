During a flaky-test investigation on 2026-08-01 (see [[wiki/personal/reflections/2026-08-01-flaky-test-toolchain-drift-0a844d]]), the user proposed a dashboard that ranks tests by retry rate. The aim is to triage flaky tests systematically instead of chasing them one at a time. The user floated it as a possible follow-up project.

## The idea
The user said: "a little dashboard ranking tests by retry rate would pay for itself." The user also said: "We keep chasing these flakes one by one, but a leaderboard would let us triage smarter." The user framed it as "Maybe a follow-up project."

## Assistant's sketch
The assistant agreed and suggested that a quick script could scrape CI logs and emit a retry count per test name. That would surface the worst offenders. It proposed prototyping this as a weekend task. No prototype or schedule was committed in the transcript.

## Why it matters
QL-4512 failed about one run in five and took the user about a month of frustration to trace to toolchain drift. A ranked view of retry rates could show which tests deserve attention first, and could help spot environment-wide causes shared across several tests. That second point is an inference, not something either party said.

On 2026-08-01 the user debugged QL-4512, a flaky test on the snapshot loader that failed about one run in five. The cause appeared to be a mismatch between the wasm toolchain version CI pulls automatically and the one in the user's local lockfile. The user chose to pin the toolchain and quarantine the test until the pin lands. The follow-up dashboard idea is captured in [[wiki/originals/ideas/2026-08-01-test-retry-rate-leaderboard-0a844d]].

## What happened
- The user reported that QL-4512 fails "about one run in five" and said it is "driving me up the wall".
- A local run of 10 with seed 99821 gave 2 failures (runs 3 and 7). Both failed with an assertion mismatch at loader.rs:417, expected 7 and got 0. The other eight passed in roughly 308-315 ms.
- The assistant suspected the variance came from the wasm build rather than the test itself and suggested comparing toolchain versions.
- The user diffed them. CI grabs 0.9.14-rc2 automatically, while the local lockfile was stuck on 0.9.12.

## Decisions
- The user decided to pin the wasm toolchain to one blessed version. The assistant recommended 0.9.12, since it behaved consistently locally.
- The user decided to quarantine QL-4512 until the pin lands, then re-enable it once CI and local toolchains match.
- The assistant marked the quarantine in `test_manifest.yaml` under the snapshot_loader section. It pushed a draft pin commit to the branch `fix/wasm-pin-4512`. The user had not yet reviewed it in this conversation.
- The user killed an index rebuild at roughly forty percent so the fans could stop. A full rebuild takes about four hours on that laptop, and the user judged that killing it early was the right call.
- The user planned to ask Casper which wasm version his team pinned, to stay aligned across repos. The assistant noted Casper's team may have hit similar drift last quarter. The answer from Casper is not in the transcript, so the final version choice remains open between staying on 0.9.12 and matching his team's version.

## Reflection
The user said they felt "a bit sheepish for cursing the test suite all month when the real culprit was toolchain drift". The assistant replied that flaky tests feel like the test is lying until the environmental cause is found. The takeaway is that when a failure is intermittent under the same seed, fixture and machine, the first thing to check is environment and toolchain version drift, not the test logic.

## Context
The user also mentioned distractions: a neighbor's barking dog, a browser restart that lost forty tabs, and leftover noodles for lunch. The user described this as "my life this week, basically". These are incidental details.

## Open items
- Review the pin commit on `fix/wasm-pin-4512`.
- Get Casper's pinned version.
- Re-enable QL-4512 once the toolchains match.