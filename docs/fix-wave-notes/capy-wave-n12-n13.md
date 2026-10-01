# Eval-category wave, lane N12 and N13 (branch `capy/wave-n12-n13`)

Scope: amendment 9 of the [wave plan](../plans/2026-10-01-eval-category-wave/PLAN.md). N12 is a narrow format-fidelity category that enumerates formats from gbrain's registries at run time. N13 is a code-intelligence readiness scout only. The branch is based on `capy/eval-wave-step0` (`8eb51d3`). VERSION and CHANGELOG are untouched; the integrator writes the wave's version entry.

## Commits, in order

1. `57a9bbb` preregisters the promotion rules for `format-fidelity` (N12) and `code-intelligence` (N13) in `eval/registry.ts`, before any run. The runner files in that commit are placeholders that refuse to run.
2. `39e9177` adds the N12 runner, generator, renderers and tests.
3. `93143f2` adds the N13 runner, the vendored and hash-checked pathe snapshot, the TypeScript compiler gold and tests.
4. A final commit adds the reports, receipts, bug-ledger entries, repros, docs rows and these notes.

## What was built

- **N12** (`eval/runner/n12-format-fidelity.ts`). Formats come from `transcriptAdapters()` (7) and `BUILTIN_PATTERNS` (20). Renderers for all 27 live in `eval/generators/n12-format-renderers.ts`; a registered format without one is a coverage miss.
  - Stages: adapters, the adapter-to-page-to-parser round trip, the parser with and without a page date, honesty on non-conversation input, and attendance as its own stage.
  - Attendance writes meeting pages through `put_page` and reads attended edges back through `get_links` and `get_backlinks` on PGLite. The schema pack is the one `gbrain init` writes (`gbrain-base-v2`), and an exploratory arm leaves `schema_pack` unset.
  - Gold comes from the seeded ledger (`eval/generators/n12-format-fidelity-gen.ts`) plus what each renderer wrote.
- **N13** (`eval/runner/n13-code-intelligence.ts`). The corpus is unjs/pathe at `bc7477a` (MIT), vendored with `.txt` suffixes under `eval/data/n13-code-scout/` and checked against `manifest.json` (`bun eval/generators/n13-code-scout-vendor.ts --check` re-downloads and compares).
  - Gold is `ts-gold.json` from TypeScript 5.9.3 (`eval/generators/n13-ts-gold.ts`), rebuilt byte-identically by a test.
  - The scout covers readiness per op through `handleToolCall`, remote refusal, and narrow definition, reference and caller checks. It is report-only, with no gating rule.
- Both runners use `withHermeticEnv`, take `--gbrain`, `--output` and (N12) `--seed`, and write receipts v2 listing the gbrain internals they import. Both have mutation suites built on `assertScorerRejectsFakeSystems`. N12's fakes are graded by its preregistered rules.

## Results at gbrain `3a284ae` (copied overlay)

- **N12** verdict `fail`: safety 3 of 4 and quality floors 2 of 2. The failing contract is `no-fabricated-turns`: a 26-line status note with three bold labels parses as 3 turns (N12-1).
  - Adapters: role 266 of 266 turns, timestamp exact 266 of 266, turn-count error 0 over 56 files, detection 56 of 56.
  - Noise leaks 0; invented timestamps 0.
  - Round trip: timestamps 250 of 266 at minute precision. All 16 misses are the offset-stamped source (N12-2).
  - Parser: speaker 760 of 760 turns, minute-exact timestamps 532 of 532 timed turns.
  - Attendance: documented forms 20 of 20 attendees, 0 false attendance. The legacy-pack arm had 24 false attendances (N12-7).
  - Run time 10.6 s.
- **N13** (report-only) verdict `pass`: 6 of 6 ops answer the trusted call and 6 of 6 refuse remote callers.
  - `code_def` top-1 is right for 40 of 50 functions; the 9 that return nothing are merged arrow functions (N13-1).
  - `resolved` is false on 81 of 81 edges (N13-2).
  - A shared Go and Python name blocks `code_blast` (N13-3).
  - Run time 6.3 s.
- **Bug ledger.** 16 entries in `docs/benchmarks/2026-10-01-wave-bugs.json`:
  - 5 bugs: N12-1, N12-2, N13-1, N13-2, N13-3. Each has a repro script under `docs/benchmarks/2026-10-01-n1{2,3}-*/repros/` that exits 1 while the bug reproduces.
  - 10 feature gaps.
  - 1 category defect: N12-8, the first development run measured the legacy schema pack.
- **Spend.** No paid arm ran. Spend was $0 of this lane's $3 cap.

## Notes for the integrator

- N12 gates (four safety contracts and two utility floors). Its verdict is `fail` at the pin until N12-1 is fixed, so `all.ts --tier offline` reports N12 as failing. That is the preregistered rule working. Whether the wave PR lands the row as `gate` now, or the fix wave lands first, is the integrator's call; the rule values must not change to make it pass.
- The bug ledger file is shared: this lane added only `N12-*` and `N13-*` ids. Re-render the Markdown view after merging other lanes' entries (`bun eval/runner/bug-ledger.ts render --out docs/benchmarks/2026-10-01-wave-bugs.md`).
- `test/eval/all-and-budget.test.ts` lists N12 and N13 in its category catalog tripwire, which every new category must update. The offline dispatch list there gains both ids too.
- `docs/README.md` gained three rows (N12, N13, and the bug ledger view). Drop the ledger row if another lane already added one.
- The fix wave's mechanism-level directions are in each report's "gbrain bugs found" section. N12-2 and N13-2 are small. N12-1 needs a gate that does not depend on page length (labels that each occur once are not a conversation). N13-1 needs merge protection for function-valued `const` declarations.

## Verification

- `bun run typecheck` was clean.
- `bun run test` was green: 4 shards with 2660 pass, 6 skip and 0 fail; the Python tests and validators passed.
- `bun eval/runner/all.ts --tier offline --only N12,N13`: N13 PASS (no gating rule). N12 FAIL on `no-fabricated-turns`, as reported above.
- Every repro script exits 1 on the pin.
