# QL-4512 Flaky Test — Investigation & Resolution Notes

## Problem Summary
Test **QL-4512** (snapshot loader) was failing roughly **1 in 5 runs** with a consistent assertion mismatch:
```
loader.rs:417 — expected 7, got 0
```
Timing across runs was stable (~310 ms), ruling out performance-related flakiness.

## Root Cause
**Wasm toolchain version drift** between environments:
- CI nodes: auto-pulling `wasm-runtime 0.9.14-rc2`
- Local lockfile: pinned to `wasm-runtime 0.9.12`

The assertion failure was deterministic in *what* it checked but non-deterministic in *when* it tripped because of this environmental mismatch.

## Resolution Steps Taken
1. **Quarantined QL-4512** in `test_manifest.yaml` (snapshot_loader section) so it does not block merges.
2. **Pinned wasm-runtime to `0.9.12`** in `Cargo.lock`; draft commit pushed to branch `fix/wasm-pin-4512`.
3. Plan to **re-enable QL-4512** once CI and local toolchains match on the pinned version.

## Pending Actions
- [ ] Review branch `fix/wasm-pin-4512` before merging.
- [ ] Check with **Casper** which wasm version his team pinned to stay aligned across repos — they hit similar toolchain drift last quarter.
- [ ] Once Casper responds, decide whether to stay on `0.9.12` or bump jointly to their blessed version.
- [ ] **Incomplete index rebuild** was killed at ~40% and left in that state; revisit once the pin lands if still needed. Note: a full rebuild takes ~**4 hours** on this machine.

## Follow-up Idea
A **flaky-test leaderboard** — a script scraping CI logs to rank tests by retry rate — would enable smarter triage instead of chasing flakes one by one. Flagged as a future small project.