# Changelog

This records what each gbrain-evals release changed and what its measurements meant at the time. Versions follow `VERSION` and `package.json`. Historical scores keep their original dates; later corrections do not turn them into measurements of today's code.

## [0.10.3] - 2026-09-30

The evidence-delivery study: preregistered, run and reported. gbrain is
adding an opt-in stage that returns neighbors, sections or whole pages
instead of bare chunks.

### Added

- **Result: whole pages help; cheaper windows do not close enough of the
  gap.** On 400 held-out LongMemEval-S questions with the reranker on and
  retrieval frozen at gbrain `732ee811`, whole-page delivery answered 361
  against 253 for five chunks (+114/−6, p = 6e-27). The two pilot winners,
  one or two neighbor chunks per side, scored 285 and 292 at 44% of
  whole-page input tokens: significant against chunks, but only 30% and 36%
  of the gap against the preregistered 60%. Decision-manifest verdict:
  `page_only`, so `page` ships opt-in and the default stays `chunk`; the
  sealed set was not opened. An agent that could fetch pages scored 83/100
  on the pilot (chunks 68, pages 92). The gpt-4o reader tied (128 against
  129/400) because it abstained on about two thirds of questions under the
  notes prompt. E3 reproduced the frozen evidence over MCP on 100/100
  questions for every arm. Paid cost $112.44 through one ledger run.
  Report: `docs/benchmarks/2026-09-30-evidence-delivery.md`, receipts under
  `docs/benchmarks/2026-09-30-evidence-delivery/results/`.

- **An executable decision manifest**
  (`docs/benchmarks/2026-09-30-evidence-delivery/decision-manifest.json`),
  committed before any paid call. It fixes judge roles (gbrain judge primary,
  official judge may not reverse), the gap and 60% closure formula, the 50%
  provider-token rule, the six-candidate Holm family, pilot selection and
  tie-breaks, clusters, error handling, the E2 pass/reject/inconclusive rule
  and the gbrain commit pin. `eval/runner/evidence-delivery/decision.ts`
  applies it; a keyless suite covers close wins, zero and negative gaps,
  sparse types, judge disagreement, many-policy selection and failed calls.
- **A power analysis** over the exact decision code. A candidate that closes
  70% of the gap passes 65% to 82% of the time. The per-type rule fails even
  a page-quality policy 12% to 24% of the time through reader noise, and E2
  rejects a truly equal winner 6% to 20% of the time. Both rules are kept as
  preregistered and flagged.
- **A content-addressed frozen evidence manifest.** `freeze` stores each
  question's reranked top-5 and top-10 hits with chunk text, every chunk of
  every hit page, the harness page text and every arm's delivered evidence
  with gbrain's fingerprint, plus code, parser and index hashes and the
  agreement with R1.
- **The E1 runner** (ten arms, the `get_page` agent arm, gpt-4o arms), with
  three token counts per row and a byte-level check that the harness page
  request reproduces R1's logged request before any model call.
- **The E3 product-path check** over MCP stdio as a remote caller, with
  gbrain's server spend joining the ledger through a preload, and **the E2
  bridge**, which gives the sealed set the E1 reader instead of the sealed
  runner's whole-session prompt.
- `bun eval/runner/evidence-delivery.ts costs`: the paid program is estimated
  at $122 ($153 with a retry margin) against a $400 campaign cap.
- A $0.97 plumbing smoke against the WIP gbrain branch: 4 of 4 identical-list
  questions reproduced R1's request bytes; the product `page` drops page
  frontmatter and 9 of 24 blocks lost a paragraph break at chunk seams (fixed
  in gbrain before the pinned commit); MCP `assemble_evidence` reproduced the
  local fingerprints.
- Sharded freezing (one process per embedding cache) with `merge-frozen`,
  `e3-summary`, and the VM pipeline and watchdog scripts used for the run.
- Voyage rerank timeout raised to 30 s in freeze and E3 after 28 haystacks
  timed out at gbrain's 5 s default during a Voyage overload.

### Changed

- The budget ledger prices dated model snapshots (`gpt-4o-2024-08-06`) at
  their family's list price and prices Voyage rerank requests.
- The sealed runner refuses to open labels for scoring without a decision id.
- Lifecycle drivers accept an entry override so a server can run with a
  preload.

## [0.10.2] - 2026-09-30

The two reranker-on follow-ups from the LongMemEval opaque-id re-run. Both
use the same gbrain code as the 439/500 arm (`a7cb37b`), the same data,
embedding cache and judges, with `voyage:rerank-2.5` on.

### Added

- **R1, the house notes reader with the reranker on: 453/500 (90.6%).**
  - The reranker raised strict retrieval from 435/470 to 450/470 (paired
    +22/−7, exact McNemar p = 0.008).
  - Against reranker off, answers moved +31/−17 (p = 0.059); with the
    official judge, 451 against 443 (p = 0.33). That is suggestive, not a
    demonstrated answer gain.
- **R2, the published configuration without the leak: 432/500.** It used the
  direct reader at 512 tokens, the reranker on and opaque ids. Paired against
  the invalid published 433/500, it moved +15/−16 (p = 1.0). Hiding the gold
  ids made no measurable difference there. The published number stays
  invalid because it was measured with the ids visible, and the report lists
  the remaining configuration differences.
- **Notes against direct on identical reranked retrieval: 453 against 432**
  (+32/−11, p = 0.002; official judge p = 0.049). This is a new full-500
  comparison, not a re-run of the September 25 transfer cohort, whose flag
  stays in place.
- Voyage accounting for each run: 500 calls, all HTTP 200, 6.94M tokens
  ($0.35), 500/500 rows reranked, 0 `rerank_failed` or other degraded
  stages. Paid cost for both runs was $51.22 against a $120 cap. Each run
  hit the known #5092 stall five times; a watchdog resumed each time without
  repeating a reader call.
- Receipts under `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/reranker-on/`
  with nine manifest entries. `scripts/verify-longmemeval-opaque-qa.py` now
  also recounts both runs, their paired tests against arm a and the
  published rows, rerank coverage and the prompt leak check.

### Changed

- The report gains a reranker-on section. The README now gives the
  reranker-on numbers beside the 439/500 and says the leak made no
  measurable difference to the published configuration.

## [0.10.4] - 2026-09-30

Three keyless categories from the evidence-delivery plan (section 5): temporal
and as-of questions (N3), entity resolution (N4), and a visibility and access
leak fuzz over every read operation (N6). Each has a registry entry with a
semantic contract, gold from a seeded generator ledger (never from gbrain
output), solvability and negative controls, presence assertions, receipt v2,
tests and a dated report. All three land report-only, and each found gbrain
bugs; they become gates once those are fixed. No paid calls.

Measured on the pinned gbrain (`608a174`, 0.60.10.0) and on master (`f8d1e39`,
0.60.11.0) as a copied overlay; every category gave identical numbers on both.

- **N3 temporal and as-of** (`temporal-asof`,
  [report](docs/benchmarks/2026-09-30-n3-temporal-asof.md)). 500 of 513 probes
  pass: chronicle reads, search date bounds, effective-date precedence,
  time-zone and daylight-saving edges and trajectories all 100%, range set-F1
  1.000 over 179 probes, `ontology_get` as-of 99/104, last seen 76/83. The 13
  misses are four gbrain bugs: `ontology_get` drops a late-recorded stint that
  names the current value, `chronicle_last_seen` matches attendees by
  substring and can report the previous day, and a non-ISO `query` date bound
  such as `since: "May 5"` returns nothing instead of an error. The
  forward job-state gold moved from `temporal.ts` into
  `eval/generators/job-state.ts`, shared by Cat 4 and N3.
- **N4 entity resolution** (`entity-resolution`,
  [report](docs/benchmarks/2026-09-30-n4-entity-resolution.md)). On 136
  single-source mentions the resolver merged wrongly once, refused all 17
  mentions that must be refused and resolved every variant recorded in
  `aliases:`; B-cubed F1 0.755 against 0.566 for exact-only, 0.480 for refusing
  everything and 0.109 for merging everything. Typos, initials and prose-only
  nicknames stay unresolved by design. Two bugs: another page's alias beats a
  page's own exact name, and federated `recall({ entity })` merges two
  different people who share a slug and drops `source_id`.
- **N6 visibility and access leak fuzz** (`visibility-leak-fuzz`,
  [report](docs/benchmarks/2026-09-30-n6-visibility-fuzz.md)). Enumerates
  gbrain's read operations at run time (73) and calls each as stdio, serve-http
  read, write and slug-bound clients and remote and local subagents, against
  private pages, held Takes, private Facts, derived atoms and an ungranted
  source, with public-twin and trusted-local controls and a never-written
  ghost for existence oracles. 24 of the 25 read ops that return protected
  content held, and 0 of 90 access gates were bypassed. One bug: `entity` and
  `context_pack` show remote callers inbound links from private pages, with
  the private slug and a sentence of its body. It also runs against the
  `capy/evidence-delivery` branch (c0a72ab, same result); that head documents
  `return_unit` and `assemble_evidence` but does not implement them yet. A
  later run against the branch head with the code (732ee81) fuzzed every
  `return_unit` value on `search`, `query`, `recall` and `assemble_evidence`,
  with new presence controls for expansion (an expanded `delivered` block, and
  delivered text spanning the stripped Takes and Facts rows): no expansion
  path leaked.
- **`--gbrain <checkout>[@ref]` / `GBRAIN_UNDER_TEST`** for the new runners
  (`eval/runner/gbrain-under-test.ts`): extracts the ref with `git archive`
  into `.gbrain-overlays/`, installs it, verifies the copy (tree hash, no
  symlinks, CLI version) and records the loaded commit in the receipt's
  product identity. Never a symlink.
- **`all.ts` honors `gate: 'report-only'`.** A report-only category that
  completes with a non-pass verdict is REPORTED, never a pass and never a
  failure of the run; missing, stale, invalid and errored receipts still fail.

## [0.10.1] - 2026-09-29

One release for all of the work that followed the September 28 audits and the
approved 10x plan. It was built on eight branches (numbered 0.10.1 to 0.10.8
while in review) and ships as a single patch release. Several published
numbers had been measured by code that could not fail, or that let the system
under test see the answer. This release fixes those runners and scorers,
corrects the published claims in place beside dated errata, runs the whole
suite in CI, adds an independent evaluator, a category registry, receipt v2
and a paid-run budget ledger, freezes a sealed confirmation set, adds a memory
lifecycle experiment, and replaces the invalid LongMemEval answer score with a
leak-free re-run. Historical scores keep their original dates; where a fix
moves a number, the old number stays in its dated report.

Paid work in this release: the LongMemEval opaque-id answer re-run (about
$59.6), the sealed confirmation set ($17.83) and the relationship paraphrase
check ($0.0645 of OpenAI embeddings). Everything else is keyless.

### Measurement integrity (audited 2026-09-28)

Keyless reruns and recomputations in this section were made at the pin of the
day, `939232f`.

- **LongMemEval runners no longer show the gold label.** Every gold session id
  starts with `answer_` and no other session does. The retrieval runner, the
  answer check, the reading-notes request builder and the M-pilot build now
  give the system and the reader opaque ids (`s-` plus 10 hex characters) and
  translate back before scoring. A test asserts that no system or reader input
  contains `answer_` (C-01, PD-05, PD-08). The published 433/500 judged answers
  and the 308 to 324 of 361 reading-notes result came from readers that saw raw
  ids (see the leak-free re-run below).
- The LongMemEval aggregator marks a run publishable only when every adapter
  has the expected row count, and stamps the gbrain version recorded in the
  rows rather than the local install (PD-01, PD-02). Resume and batch
  completion are keyed on `run_config_hash` (PD-03). The NDJSON validator
  rejects residual error rows unless `--allow-errors` is passed (PD-04).
  Answer-generation outages count as dependency errors (PD-06).
- `all.ts` requires a fresh, valid receipt from every runner it dispatches. A
  missing or invalid receipt is a failure, never an exit-code pass (C-06,
  C-07). It lists every category in the repository with a tier, runs
  `--tier offline` (default), `paid` or `all`, and prints each category it did
  not run with the reason (C-09). Latency categories run alone (C-11). The
  `eval:brainbench:published` script, which claimed N=10 while no dispatched
  runner read N, is removed (C-08). A keyless `--tier offline` sweep at
  `939232f` passed 17 of 17 dispatched categories.
- Cat 2 type accuracy charges every inferred type that differs from gold, so an
  extractor that emits every type can no longer score 100% (C-05). At
  `939232f` this scorer gave 86.6% (240/277 found pairs; 97.1% under the old
  any-type rule, still reported as a diagnostic) and strict F1 41.3% (48.1%
  before); the attendance-direction correction below later replaced both.
  Cat 2 and Cat 3 write receipts and gate on regression floors.
- Cat 3 scores the handle without `@` as documented, because the keyword index
  strips the `@`. Undocumented alias recall is 13.75% (55/400), not the
  published 31.0% (C-03).
- Cat 1 reports Precision@5 with the standard /5 denominator: 29.9% before and
  35.4% after graph traversal, against a ceiling of 36.0%. The legacy
  /min(5, returned) value (39.2% to 46.5% at this pin) is kept beside it
  (C-04).
- The Cat 36 offline smoke fails when search crashes on every probe or finds no
  evidence (PC-05). Cat 34 gates on production-seam cells and reports
  contract-seam cells as informational, so it can pass (PC-08).
- Cat 35 reports the evidence-verified joint score next to the judge-only score
  and excludes judge failures instead of counting them as misses (PC-01,
  PC-03). Recomputed from the committed receipts (dream lane macro): 88.1%
  judge-only is 74.9% joint; the earlier 70.2% is 58.2% joint; the Aug-25
  baseline is 64.7% judge-only (61.5% published) with 8 of 173 failed items
  excluded. Cat 35 writes a common receipt and skips cleanly without keys
  (PC-09).
- Cat 29 judges both answers in one blind prompt in both orders and flags
  position-inconsistent pairs; the earlier "both orders" made the same
  single-answer call twice (B-29-01).
- The multi-adapter `gbrain` row runs the product path (hybrid search with
  relational retrieval). The regex parser for the four query templates stays as
  `graph-oracle-parse`, labeled as an upper bound (C-10).
- Cat 13 reports probes that copy the target page's title, description or body
  as a lexical control beside the conceptual probes. Recomputed from the
  2026-09-09 receipt, gbrain scores 61.5% nDCG@5 on the 246 conceptual probes
  and 53.6% on the 302 lexical-control probes (A-14).
- Every `readdirSync` enumeration is sorted, with a repository-wide test
  (A-06). The Cat 13 probe set is unchanged; Cat 6 injects different mentions
  in some cases with every gated rate unchanged.
- Judges and direct model calls run at temperature 0 where the SDK allows it
  (PC-02, B-29-03, A-03). Judge prompts escape system output, fence it in a
  per-call nonce block, and state that block content is data. Judge prompt
  versions moved, so new judged receipts do not compare with older ones (C-13,
  A-20, B-JDG-01, PC-10).
- `dcgAtK` counts each id once, so nDCG cannot exceed 1 (C-16).

### Corrections to published claims

Every original figure stays visible beside a dated erratum. The README now
states where gbrain actually leads: strict `recall_all@5` of 95.53% (449/470)
on LongMemEval, against 90.0% and 85.7% for our strict recounts of MemPalace's
saved rankings and 87.45% self-reported by ContextFit. Answer accuracy is not a
matched comparison yet, and the README says so.

- **Cat14 calibration (May 18): retracted.** The 75% win rate (6 of 8) and 100%
  axis scores came from a judge that saw each probe's expected behavior and
  knew which answer was calibrated.
- **Cat 3 undocumented alias recall (April 18): 31.0% becomes 13.75%
  (55/400).** The handle without `@` is in the indexed page text and scored
  100/100. Verified by re-running `eval/runner/identity.ts`.
- **Cat 2 link type accuracy (April 18): 70.7% to 88.5% came from a lenient
  scorer.** A strict re-run at `939232f` gave 86.6% (240/277) and strict F1
  41.3% (48.1% before the scorer fix). That count was itself wrong: the answer
  key pointed attendance edges from the meeting to the person, and gbrain
  stores them the other way, so the 86.6% counted 131 reversed edges as
  correct. **With the direction corrected, type accuracy is 74.7% (109/146) and
  strict F1 18.8%** at both `939232f` and `b80cad6`; the regression floors
  moved to 70% / 15%. Cats 1 and 6 are unchanged between the two commits.
  [Report](docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
- **The multi-adapter `gbrain` row (April 19, April 23, May 23)** came from a
  regular-expression template parser, now `graph-oracle-parse`, and is marked
  invalid as a product score. The September 9 concept report gains a split of
  conceptual and lexical-control probes.
- **Cat 1 precision at five (April 18): 39.2% to 44.7% becomes 29.9% to
  35.4%** when divided by five slots per question (145 × 5 = 725), against a
  ceiling of 36.0%. Verified by re-running `eval/runner/before-after.ts`; the
  legacy denominator now gives 46.5% after, against 44.7% published.
- **Cat 35 retention (August 31): 88.1% is judge-only.** Evidence-verified
  retention, recomputed from the committed receipts, is 74.9% (58.2% before the
  change). The August 25 baseline is 64.7% with judge failures excluded (61.5%
  published) and 51.2% evidence-verified. The README also says the result is
  in-sample.
- **May snapshot, Cats 18b to 29:** every row is marked with the defect of the
  pre-audit runner that produced it, including Cat 29's duplicate-call "both
  orders" scoring.
- **LongMemEval answer accuracy (433/500): invalid.** The answer model saw the
  `answer_` prefix that marks every labeled evidence session id. The README,
  the comparison page and the September 6 report point to the leak-free
  September 29 re-run below and say that the answer comparison with vendor
  self-reports is still not matched. **The reading-notes transfer result
  (308/361 to 324/361) was not re-run and stays pending.** A 30-question check
  found no effect of the prefix on retrieval.
- The README concept claim compares like with like (102/181 for gbrain against
  118/181 for vectors without a reranker; 130/181 with one), and the
  relationship claim reports the overall result (first-place hits 14% to 24%)
  and attendance (0/50) beside the investor example. It discloses that the
  95.53% configuration was chosen on the same 470 questions and that the
  pre-registered 92% answer target was missed.
- The PrecisionMemBench comparison table shows the September 9 corrected gbrain
  rows with their non-null case counts; the invalid May rows are struck
  through, no longer bold (B10).
- `docs/settings.md` and `docs/comparison-systems.md` no longer say that gbrain
  `2efaaf8f` is the installed library; a test checks such claims against the
  `package.json` pin.

### CI and the test suite

- `bun run test` runs the 77 colocated unit tests under `eval/` (counted on
  2026-09-28), the 25 Python orchestrator tests and the validators (published
  LongMemEval recount, LongMemEval opaque-id recount, documentation, links,
  queries, data). CI runs all of them.
- The Bun suite ran in about 2 minutes 25 seconds instead of about 9 minutes
  20 seconds on a 4-core machine when this was measured on 2026-09-28. A test
  preload builds one pre-migrated PGLite snapshot per embedding shape through
  gbrain's own snapshot loader, and `scripts/test-shards.ts` runs four
  ordinary `bun test --shard` processes at once. (Bun's `--parallel` worker
  mode was tried and rejected: tests that call `Bun.spawnSync` hung in 2 of 4
  full runs.) CI splits the tests into four shard jobs and moves type checks,
  validators and hermetic runners into a separate job, each with its own
  timeout. That job runs every keyless category through
  `bun run eval:brainbench` (`all.ts --tier offline`), so the Cat 1, 2, 3 and
  10 gates fail CI on a regression. Two PGLite-building tests carry explicit
  timeouts because they exceed 5 seconds under four shards.
- `tsc` passes with no output filtering: DOM libraries, `@types/js-yaml` and
  `@types/express`, TypeScript 5.9, and small shims for Bun text imports and
  one image encoder signature. CI gates both type checks unfiltered.
- The `postgres@3.4.9` patch is declared in `patchedDependencies`, so the
  cancellation-capable driver `gbrain-reader` expects is actually installed.
- Removed the PGLite postinstall link. gbrain finds the hoisted PGLite assets
  without it.
- Cat30 to Cat33 import SkillOpt through gbrain's public `./core/skillopt`
  export.
- The built-in Tier 5.5 family is labeled `synthetic-outsider` in new
  scorecards; no outside author wrote those questions.
- Documentation follows the opaque session ids: the LongMemEval-M
  preregistration describes the `indexed-projection-v3` build, the
  reading-notes report describes request schema 2, and the May LongMemEval
  report shows how to validate the prefix-bracket stream with
  `--allow-errors`.
- `scripts/check-links.py` checks every link and heading anchor in the
  repository's Markdown on each `bun run validate`; a weekly workflow also
  fetches external links (B12).

### Independent evaluator and paired comparisons (plan amendments 4 and 6)

- **Paired comparator: `bun eval/runner/compare.ts <A> <B>`.** It pairs two runs
  question by question and refuses duplicate ids, missing pairs and questions
  that are eligible on one side only. It reports the absolute change with a
  clustered 95% bootstrap interval, a clustered sign-flip test, the exact
  McNemar test and a power note (the smallest change detectable at 80% power).
  Items share a cluster id, so ten paraphrases of one concept count once. The
  statistics generalize the situation-recall regression gate's bootstrap,
  sign-flip and Holm code (`eval/runner/stats/`), and a test holds the two to
  identical results. Recounting the committed September 6 rows reproduces the
  published reranker comparison: 18 wins and 8 losses over 470 answerable
  LongMemEval-S questions, +2.13 points (interval 0.00 to +4.26), McNemar
  p = 0.0755.
- **Three gates over a preregistered family** (`--family`). Exact correctness
  and safety assertions fail at once with no significance test. Noisy quality
  metrics pass only when non-inferiority within a stated tolerance is shown
  after Holm correction; a wide interval is inconclusive, not a pass.
  Exploratory metrics never gate.
- **Independent evaluator** (`eval/runner/evaluator/`). A gold store keeps
  labels in a private field and hands out scores. The LongMemEval runner keeps
  only gold-free question views and scores through a gold store loaded by a
  separate read of the dataset, checked byte for byte. Cat13 gold comes from a
  separate corpus read and must match the runner's probes id for id and text
  for text. A reference scorer reimplements the metrics without importing the
  product.
- **Input allowlist** for every payload sent to the system under test or a
  reader or judge. It refuses undeclared fields, non-plain objects and any raw
  dataset session id beyond what the conversation text accounts for, whether or
  not the id starts with `answer_`. A violation voids the run. It covers
  LongMemEval retrieval and answers and Cat13, and in the final fix wave also
  the reading-notes reader input and captured request, Cat 29's question and
  pairwise judge, and Cat 35's transcripts and scaffold (no gold id), coverage
  judge (no verbatim anchor beyond the judged document), leak judge and
  usability judge (no gold statement beyond the pages). Receipts record the
  gold-store fingerprint, scorer version and boundary names under
  `resolved_config.evaluator`.
- **Adversarial tests** the evaluator must catch: known rankings, permuted
  labels, removed metadata, duplicate ids, an empty system, wrong answers, and
  adapters that leak gold, return nothing or return duplicates
  (`test/eval/evaluator-adversarial.test.ts`).
- Cat13 per-question rows gain `cluster_id` (the target concept) and, when an
  adapter repeats a page, `duplicate_results`. Scores are unchanged: repeated
  pages already earned nothing.
- [Comparing runs](docs/comparing-runs.md) explains all of the above.

### gbrain pins, category registry, receipt v2 and the budget ledger

- **gbrain is pinned to master.** On 2026-09-29 the pin moved from `939232f`
  (a side branch) to master `b80cad6` (v0.59.13.0), and at integration it moved
  again to master `608a174` (v0.60.10.0). The memory-cue experiments
  (situation recall, the LongMemEval-M pilot and Cat 36 cue arms) need code
  that exists only on gbrain's `capy/situation-aware-recall` branch, so they
  load a separate package alias, `gbrain-cues`, pinned to `939232f`. Cat 36 and
  situation-recall runtimes pick the package from the arm: cue and summary
  arms use `gbrain-cues`, every other arm measures the pinned product. Pins
  are read from `package.json` (`eval/runner/pins.ts`).
- **Re-pin check at `608a174` (2026-09-29).** Cats 1, 2 and 6 give the same
  data as their committed `b80cad6` receipts (Cat 2 still 74.7% type accuracy,
  18.8% strict F1), so no published number moves. The offline tier passes
  every dispatched category, and Cat 34 passes 12 of 12 against a gbrain
  checkout at the same commit. Two behavior changes in gbrain surfaced:
  - gbrain v0.60.6.0 (#5675) records a file import's `file://` origin in
    `source_uri`, which also server-stamps `ingested_at`. Cat 24's file-import
    probe and its native collector now expect that origin, and still require
    `source_kind` and `ingested_via` to stay empty. Before this pin the probe
    expected all four fields empty.
  - gbrain v0.60.6.0 widened its relationship parser. The keyless
    relational-ab check fires on 33 of 145 paraphrased questions at `608a174`,
    against 0 at `b80cad6`; template firing is unchanged at 58. The paid
    paraphrase measurement stays dated to `b80cad6`, and the README, the report
    and TODOS carry a dated note.
- **`gbrain-reader` pins gbrain master `e78f1c3`** (v0.59.0.0), replacing
  `a9de062`, which is on no branch. The two commits' `src/` trees and
  `package.json` are byte-identical; the 22 reading-notes tests pass.
- **ZeroEntropy cells are retired** (supersedes PR #35). Cat 18 compares OpenAI
  and Voyage embedders; Cat 18b pairs each with `voyage:rerank-2.5`. Both are
  dispatchable paid categories again.
- gbrain v0.59.10.0 saves a page's text when embedding fails instead of
  throwing. Runners that measure vector or hybrid search treat such a deferred
  embedding as an error, so a provider outage can no longer be scored as
  keyword-only retrieval under an embedding label.
- **`eval/registry.ts`**: one row per category with its legacy alias, family,
  tier (H hermetic, K keyed under $1, P paid), cost estimate and its basis,
  receipt path, headline metric and denominator, gate status, evidence
  maturity and a short statement of what it measures. `all.ts` reads it and
  accepts `--tier H|K|P`. No category was renumbered. The registry lists the
  lifecycle experiment and the sealed confirmation set, and
  `test/eval/registry.test.ts` fails when a file under `eval/runner/` is
  neither a registry script nor listed in `RUNNER_HELPERS`.
- **Receipt schema v2.** Every receipt records the content hash of the evals
  tree that ran (uncommitted edits included), the declared pin and content
  hash of the gbrain package actually loaded, planned, attempted, scored and
  errored probes with errors kept apart from misses, and cost, p50/p95 latency
  and tokens delivered to models when a runner measures them. v1 receipts
  remain readable. Cost and delivered tokens are recorded as a measured zero
  in 16 keyless runners and stub modes, from the budget ledger in
  relational-ab live runs, and latency in Cats 13b, 28 and relational-ab.
- **Budget ledger** (`eval/runner/budget-ledger.ts`). LongMemEval, Cat 13, Cat
  35 and relational-ab live runs refuse to start without `--budget-usd`, print
  their estimate, and reserve every provider request (retries and gbrain's
  internal calls included) against the run budget and a $500 program cap
  before sending it. Reservations reconcile to provider-reported usage. The
  ledger is a gitignored JSON file (`.budget/ledger.json`), tested with mocked
  providers. `longmemeval-batch.sh` opens one ledger run and passes
  `--budget-run-id` to every worker, so `--budget-usd` caps all workers and
  restarted batches together.
- Receipts stop recording machine-local paths: `writeReceipt` makes paths under
  the checkout repo-relative, `bun eval/runner/receipt.ts scrub <file>` also
  rewrites home and temp paths before a receipt is committed, and a test fails
  on any committed receipt with such a path, except historical receipts frozen
  by hash (B11). The frozen list holds the 63 receipts recorded before the fix
  wave plus the two lifecycle receipts, which are kept byte-for-byte because
  the manifest and the recount test pin them.

### Sealed confirmation set (plan amendment 1)

The LongMemEval-S questions and the Cat13 held-out concepts were used to
choose gbrain's settings, so they are now development data. This release
freezes a separately written confirmation set for future release decisions and
publishes only its method, counts and SHA-256 commitments. No gbrain run has
touched it.

- **Sealed confirmation set v1.** 30 fictional personas, each with a 55-chat
  history (20 personal chats, 35 general-help chats), and 150 questions: 30
  each of single-session fact, multi-session aggregation, temporal reasoning,
  knowledge update and abstention. Written by OpenAI `gpt-6-sol`, a model not
  used for LongMemEval or any earlier corpus here. Personas share no
  occupation, hobby or life arc. Labels come from the generation ledger. The
  questions, chats and labels stay private;
  `eval/data/sealed-confirmation-v1/manifest.json` holds their commitments.
  Protocol:
  [`2026-09-29-sealed-confirmation-protocol.md`](docs/benchmarks/2026-09-29-sealed-confirmation-protocol.md).
- **Solvability controls, reported and never used to drop items.** With only
  the gold chats, a Claude Sonnet 4.6 reader answered 150/150 (GPT-4o judge,
  official LongMemEval prompts). With no chats it answered 0/120 answerable
  questions and, as expected, 30/30 abstention questions.
- **Overlap audit.** Against LongMemEval S and M: 0 of 150 questions identical,
  highest word-set similarity 0.33, 0 persona full names, 0 of 1,650 chats
  sharing a 13-word run of text. All 500 M questions are S questions.
- **`eval/runner/sealed-confirmation.ts`.** Runs gbrain through the LongMemEval
  runner's code path on a questions file that passes an input allowlist, then
  scores with the private labels path given only at scoring time. Scoring
  refuses a labels file that does not match its commitment and logs every
  access with its purpose and decision id.
- **`eval/generators/sealed-confirmation-gen.ts`** with frozen prompts, and a
  durable spend-reservation ledger checked before every paid request.
- Cost: $17.83 in paid API calls, $15.82 generation (including two one-persona
  pilots) and $2.00 solvability.

### Memory lifecycle experiment (plan amendment 8)

A new experiment follows one small vault through a full memory lifecycle
(ingest, query, an ingest during an embedding outage, corrections, a full
reconcile, a forget, a restart) and scores what an agent can read against a
ledger the evaluator writes itself. It compares four gbrain builds on PGLite
and Postgres through the local CLI, MCP stdio and MCP HTTP, twice, at $0.

- **`eval/runner/lifecycle-experiment.ts`** and `eval/runner/lifecycle/`: the
  scenario and ground-truth ledger, drivers for the three interfaces, a
  hermetic OpenAI-compatible hash embedder with fault injection, the scorer,
  and copied-overlay build preparation. A build runs only if its copied files
  hash to the requested commit's tree, no symlink exists under `src/`, and
  `gbrain --version` matches its `VERSION`.
- **`eval/runner/lifecycle-report.ts`**: tables from a receipt, and a
  cell-by-cell comparison of repeat runs.
- **[Lifecycle report](docs/benchmarks/2026-09-29-lifecycle.md)** with a
  primary run and a repeat.
- Measured 2026-09-29: forgetting one entity's fact expired the identical claim
  on another entity, and refused the same claim for a third, in 18 of 18 cells
  on v0.59.3.0, v0.59.11.0 and master v0.59.13.0. Master plus #5666 fixed both
  in 6 of 6. A remote caller read a private page's tags in 4 of 4 remote cells
  on v0.59.3.0 and v0.59.11.0, and 0 of 4 from master (#5676) on. Still failing
  on every build: a slug collision stops its source's sync, so files after it
  are never imported; a renamed page loses its inbound link and its old slug;
  on PGLite with a live MCP server, delegated syncs extract 0 or 1 of 8 links,
  and `gbrain extract --stale` was refused in 240 of 240 attempts.

### Leak-free LongMemEval answer re-run (2026-09-29)

With session ids made opaque, gbrain's house reader answered **439/500
(87.8%)**. A GPT-4o reader using LongMemEval's official reading prompt, on
exactly the same retrieved sessions, answered 430/500 (86.0%); paired, that is
21 wins and 30 losses, exact McNemar p = 0.26, so the readers are not
demonstrably different. The run used the reranker off and the notes reader
with 1,024 output tokens, measured on gbrain PR 5676 at `a7cb37b`. That is not
the September 6 configuration, so it does not measure how much the leak
helped.

- **Report: [LongMemEval answers without the answer key](docs/benchmarks/2026-09-29-longmemeval-opaque-qa.md).**
  Strict retrieval on the same rows was 435/470. A 100-question component
  study with the reader and evidence held fixed found that the evidence budget
  matters far more than the prompt. Full retrieved sessions (about 15,800
  input tokens) gave 89/100. The five retrieved chunks alone (about 3,400
  tokens) gave 65/100 with gbrain's reader prompt, 65/100 with a plain prompt
  and 64/100 with `gbrain think`'s prompt; each prompt against gbrain's was
  p = 1.0. The report lists four harness stalls, a machine restart and the
  paid cost (about $59.6).
- Receipts under `docs/benchmarks/2026-09-29-longmemeval-opaque-qa/`: summary,
  per-question table, and rows for all five arms; the official-judge files;
  the full reader and judge prompts (gzip); chunk texts, logs, scripts, and
  provenance with dataset and cache hashes. Twelve manifest entries pin their
  hashes and the counts 439/500, 430/500, 65, 65 and 64 of 100, and 435/470.
- `scripts/verify-longmemeval-opaque-qa.py`, a keyless recount run by
  `bun run validate`. It re-derives every arm's verdict counts, the paired
  tests and the strict recall count, and checks that none of the 1,300 saved
  reader prompts contains `answer_` or a retrieved raw session id.

### Final fix wave on the September 28 audits

- **Relationship retrieval does not help on reworded questions.** A seeded
  paraphrase grammar, committed before scoring, rewords the 145 world-v1
  relationship questions without changing their answers. At gbrain `b80cad6`,
  over three ingestion orders (435 paired runs per wording), relationship
  retrieval fired on 174 template runs and 0 paraphrase runs. Template
  wording: first-place hits 27.6% to 42.8% (72 runs better, 6 worse), recall
  at five 0.737 to 0.763 (18 better, 0 worse, 6 distinct questions).
  Paraphrased: 0.411 recall at five and 4.8% first-place hits in both arms, no
  run changed (audit B-RAB-01, issue #24 finding 6).
  [Report](docs/benchmarks/2026-09-29-relational-paraphrase.md).
- **Cat 6 bare-name mentions: 50/50 linked** by gbrain's by-mention pass (a new
  gazetteer arm), 0/50 by the ordinary links pass. The pure-extractor gates are
  unchanged (250 probes, recall and labeled precision 1.0).
- **Gates that could pass on nothing.** Cat 27 fails when no probe improves; it
  currently passes because one of four probes gains 3.1 points of nDCG@10, and
  every probe's ranking changes (B-27-01). Cat 24's dedup probe requires the
  hash short-circuit itself (status `skipped`, unchanged `updated_at` and chunk
  ids); a forced re-chunk fails it (B-24-01). Cat 32 Part B needs at least one
  candidate the held-out gate blocked; no regression with zero blocks is
  `partial` (B-32-01). Cat 30's `seed-no-brain-first` held-out scores
  retrieval of a generated topic page from a brain Cat 30 imports, instead of
  citations an empty brain could only invent (B-30-01).
- **Unpublishable stub receipts.** Cat 19 and Cat 27 hash-embedding runs are no
  longer publishable (A-22, B-27-01); Cat 29 stub runs report `partial` and no
  longer overwrite a crashed side's zero (B-29-04); perf is unpublishable when
  no threshold was evaluated and counts only successful link writes (C-11).
- **Data integrity.** `validate-data.ts` checks amara-life hashes under the
  generator's scheme (per record for JSONL and calendar entries, per file
  otherwise): 424 of 424 manifest items verify, and a mismatch fails instead
  of warning (C10). `poison.json` is generated from the planted fixtures; the
  five gold stubs with no generator or runnable consumer (`backlinks`,
  `citations`, `entities`, `personalization-rubric`, `qrels`) are removed, and
  a hand-written template row fails validation.
- Smaller audit items: Cat 13 gap localizer withholds its proposal above a 5%
  re-simulation mismatch and reads the committed E0 receipt (A-16); malformed
  `CAT18_MIN_RECALL` / `CAT21_MIN_MRR` throw and overrides are unpublishable
  (A-23); a zero-query Cat 18 cell is invalid (A-24); situation-recall Cat 13b
  over its infra cap is an error (A-25); Cat 13b drops its gateway memo and
  restores `GBRAIN_SOURCE_BOOST` (A-17); Cat 22's presence floor is the seeded
  count minus two (B-22-01); Cat 33 B-pre reports no transfer ratio (B-33-01);
  Cat 30/33 gates need all but one seed scored (B-30-04); Cat 32 `sel_climb`
  compares like splits (B-32-02); Cat 28 isolates `GBRAIN_HOME` and records
  failed-pass latency (B-28-01); Cat 35 leakage leaves judge-failed hits out of
  the denominator, including in the native Cat 35 reconstruction (PC-04); the
  shootout driver reports `partial` (PD-15); `query:validate` rejects unfilled
  scaffold placeholders (PD-17); the skillopt sentinel clears stale partial
  results (B-SH-01); relational-ab `--limit` samples across templates
  (B-RAB-02).
- Cat 6's header said gbrain has no bare-name linking; it does, through the
  by-mention pass. Cat 3 and Cat 4 headers and registry names say they test
  keyword alias lookup and timeline storage, and name the gbrain features they
  leave untested (F3, F4, F5).
- `gold/contradictions.json` is documented as reserved for the planned N2
  category. Both claims appear verbatim in their source text for 9 of 15
  fixtures, which N2 must check first (F6).

### Plan documents

- `docs/plans/2026-09-28-gbrain-10x/` records the approved gbrain 10x plan, its
  outside review and the five September 28 audits (evals correctness, evals
  docs and infrastructure, coverage and categories, gbrain read path, gbrain
  write path). The docs index links them.

### Limits

- Cat 30 to 33 model calls and the Cat 35 dream and facts lanes run inside
  gbrain and still use the provider default temperature. The reading-notes
  reader keeps its published default temperature so that an opaque-id rerun
  changes one variable.
- The reading-notes result stays pending until its opaque-id re-run, and the
  retracted Cat14, Cat 29 and multi-adapter figures stay invalid until paid
  re-runs. A reranker-on LongMemEval answer run needs a Voyage key.
- Receipt v2 cost stays null in paid runners not yet wired to the budget
  ledger (Cats 14, 15, 18, 18b, 20, 21, 25, 26, 29 live, multi-adapter,
  PrecisionMemBench).
- The evaluator separation is still in-process; a product in the same process
  could still read dataset files. The sealed confirmation set is not yet wired
  to the paired comparator.
- On 2026-09-29 gbrain's own `gbrain eval compare` printed a bootstrap
  methodology string without computing a bootstrap
  (`src/commands/eval-compare.ts:243`). gbrain v0.59.18.0 (#5685), included in
  the `608a174` pin, replaced it with a paired cluster bootstrap.
- Cat 34 records a skip in CI because it needs an external gbrain checkout.

## [0.10.0] - 2026-09-25

Taking brief notes before answering helped the tested readers use intact
conversations. On 361 fixed-retrieval questions, the historical Sonnet 4.6
reader rose from 308 to 324 judged correct answers; the separate 500-question
GPT-4o oracle replication found gains with notes in both natural-language and
JSON presentation. This measures answer reading, not retrieval or production
readiness. Nine historical notes answers hit the 512-token output limit, and
source audits exposed grading artifacts.

In a separate release smoke, all nine selected prior cutoff responses ended
naturally at the new 1,024-token limit. That is a completion check, not a
new accuracy measurement, and its $0.562143 spend is outside the study total.

### Added

- A dated standalone report with original public per-question labels, repeat
  controls, regrades, cost aggregates and private-source provenance. It keeps
  the earlier failed excerpt approach identifiable and does not publish
  conversations, prompts or model-generated answers.
- A keyless, fail-closed recount that reproduces every paired score and
  category breakdown, rejects incomplete/mismatched streams, and checks
  aggregate token-priced spend including the earlier failed pilot. No model
  call runs from the report, recount or tests.
- An offline paired-request preparer through the GBrain sanitizer and an
  explicitly opt-in gateway execution lane with a finite spend cap and
  per-attempt accounting. The new lane reports completion and cost; it does
  not claim new answer accuracy without graded responses.

### Changed

- Document the companion GBrain notes-first reader default and direct
  override separately from the immutable historical 512-token study. The
  packaged 1,024-token default is a new setting that needs its own measured
  comparison; this release does not claim its performance was tested here.
- Keep the established `gbrain` pin for historical runners and add a separate
  immutable `gbrain-reader` pin only for the new comparison path. Retain its required
  `postgres@3.4.9` patch at the repository root so Bun's frozen lockfile
  install can resolve the transitive patch from a clean checkout. (September 28, 2026 correction: this patch was never applied, because
  `package.json` did not declare `patchedDependencies`; v0.10.2 declares it.
  The "historical runners" results also came from gbrain `2efaaf8f`, not
  from the `939232f` pin kept here.)
- Restrict CI TypeScript filtering to diagnostics whose path begins with
  `node_modules/`, so a repo-owned error mentioning a dependency path still
  fails instead of disappearing.

### Limits

The public labels and token aggregates support a keyless recount, not
generation of the private historical responses or an independent per-call
audit. The two study phases share questions and differ in dates and reader
models, so they are not independent confirmations.

## [0.9.0] - 2026-09-23

Engineers can now test whether situation cues help retrieve the original notes
needed by an indirectly worded question, and inspect the evidence required to
reject a regression. This release adds the
[evaluation protocol and harness](docs/benchmarks/2026-09-23-situation-recall-protocol.md),
not a measured retrieval gain. No paid comparison or all-category no-regression
result is published here.

### Added

- Cat36 Associative Retrieval: 120 fictional scenario families across five
  domains, with 160 development and 320 holdout probes. Its primary metric
  requires all labeled source spans in the five actual production chunks,
  rather than crediting a correct page with the wrong passage.
- Production cue-build receipts, frozen-index Scene/Horizon read-time
  comparisons, separate Bridge construction, and a real contextual-summary
  control. Deterministic provider stubs remain nonpublishable plumbing checks.
- A complete category inventory and paired release gate covering native metric
  denominators, floors, slices, source identity, execution observations and
  critical case losses. Missing, partial, stale or unsupported cells block release.
- Explicit programmatic category drivers, a native Cat13b pilot, source and
  reminder replays, and separate answer-grounding replays that retain original
  outputs and judge attempts. The LongMemEval secondary check is not official
  answer accuracy.
- OpenRouter development controls with fixed model routes, local request and
  reservation limits, and fsynced, sanitized request/response evidence. A closed
  source-only policy separates construction from embedding-only replay; it is
  preparatory infrastructure, not a new dataset or measured capability result.
  Operator-controlled diagnostics remain nonpublishable and do not claim an
  external provider credit cap.
- A separately registered v2 source-only policy for the v4 source-reference
  formatter. It checks the actual installed formatter's canonical wire content
  without treating internal excerpt metadata as a public request shape. The
  historical v1/v3 contract and all financial and output ceilings remain intact.

### Changed

- Pin the candidate product to `939232f1746381b4e932d620d6c709e29198f14c`
  (gbrain v0.55.0.0), while keeping the historical dependency and fresh baseline
  identities distinct. CI uses supported Bun 1.3.13.
- Retain previously omitted native per-item observations without changing
  benchmark inputs, scoring formulas or published historical artifacts.
- Add opt-in LongMemEval evidence capture and isolated HOME/configuration paths,
  with exact loaded-code, model, source and build identities.

### Fixed

- Keep the existing keyword and identity fixtures readable through current,
  revision-bound projections while preserving their original text and labels.
- Distinguish a valid zero-score judge control from an unavailable judge, and
  update tool-bridge test fixtures for atomic page snapshots without relaxing
  their behavior assertions.
- Preserve malformed or over-budget raw responses and existing LongMemEval
  receipts on rejected capture, score legitimate bounded search misses, and
  verify the product's actual configuration-file resolver.

### Not yet measured

For publishable comparisons, independent corpus and recipe review, real input
catalogs, supported transport and protocol coverage, enforced external provider
allowances, and complete live B/C0/C1 receipts remain prerequisites. The cue
builder's durable cap does not create a whole-cell spending limit. Unattributable
traversal results and other missing evidence remain blocked; hermetic checks do
not prove semantic quality, privacy, reminder precision or release readiness.

## [0.8.0] - 2026-09-09

Engineers can now choose a retrieval configuration by the questions they need to
answer. The rewritten guides explain word search, vectors, relationships, and
ranking through concrete cases. The [retrieval refresh](docs/benchmarks/2026-09-09-retrieval-refresh.md)
publishes all eleven planned experiment cells, including losses and the settings
that produced them.

### Added

- Three reading paths: [understand retrieval](docs/retrieval-lessons.md),
  [choose settings](docs/settings.md), and [inspect the research](docs/README.md).
- A controlled production relationship comparison with shared indexes and query
  vectors. It improved recall on 15 of 145 questions in each of three ingestion
  orders, with no recall losses; attendance questions did not improve.
- Complete concept, source-preference, baseline, and PrecisionMemBench results,
  with per-question rankings, paired comparisons, charts, and API accounting.
  Recorded usage estimates total $0.7133 before credits, within the $1,000 ceiling.
- Reproduction and verification scripts, explicit configuration records, and
  regression tests for result order, failed features, shared evidence, and spending limits.

### Changed

- Rewrote all 42 authored documents, including 18 historical reports, in plain
  English. Preserved benchmark inputs, generated evidence, tested prompts,
  historical measurements, and the gbrain dependency pin.
- Separated finding evidence from answering correctly. The September 6
  LongMemEval records support recounting retrieval and saved judgments; omitted
  answer text prevents independent re-judging.
- Dated external comparisons, corrected stale configuration and cache guidance,
  and linked adoption recommendations to their workloads and evidence.

### Fixed

- Hybrid adapters preserve gbrain's final order and keep the first occurrence
  of each page, so they no longer undo reranking or deliberate relationship placement.
- Failed searches produce valid diagnostic receipts. Offline publication checks
  reject incomplete relationship comparisons and can follow saved report paths
  after the repository moves to another checkout.

## [0.7.0] - 2026-09-06

The [ranking experiment](docs/benchmarks/2026-09-06-longmemeval-ranker-wave.md) showed that preserving additional evidence helped multi-part conversation questions. The release default reached **95.53% strict recall_all@5 (449/470)**, compared with **80.64%** for the previous default. The result-cutoff step had been dropping a second required session.

The first judged answer-quality run scored **86.6% (433/500)**. That is a different measure from finding the evidence, and this release made no cross-system answer-quality claim.

Two other changes addressed specific ranking failures: the metadata boost gate improved Cat13 held-out nDCG@5 from **53.0 to 57.8**, and preserving graph-derived relational results through reranking improved NamedThingBench hit@1 from **3/39 to 21/39**. Expansion-weight budgeting and keyword-arm confidence did not satisfy their decision rules and did not become defaults.

### Evidence and configuration

- Added compacted per-question results for eight LongMemEval arms and the judged run, cutoff replays, miss diagnostics, Cat13 E0/E2/E3 results, NamedThingBench R1 results, aggregate JSON and two SVG charts.
- Added a converter from the gbrain harness's NDJSON into the chart runner's `RunnerOutput` format.
- Updated both dependency files to the ranking release. The installed pin became merge commit `2efaaf8f`, gbrain v0.48.4.0. Updating only `package.json` had previously left frozen installation broken and local runs on v0.48.2.0.
- Cat13 receipts now identify the resolved `balanced` bundle and explicit overrides. They expose whether two nominally similar runs inherited different defaults.
- E1 localization and Cat27 graph-signal comparisons explicitly select `search.metadata_boost_gate=always` when testing the old, ungated behavior. The E1 live result records `gate_always` so its replay can be checked.

### Cat13 runner improvements

All adapters now use the selected embedding model and dimensions. Flags override `CAT13_EMBEDDING_MODEL` and `CAT13_EMBED_DIMS`; defaults remain `openai:text-embedding-3-large` at 1536 dimensions. Receipts record the gateway state after each adapter initializes, and mismatched settings invalidate the run.

The gbrain-backed adapters accept explicit reranker and autocut flags, both off by default in this runner. Reranker-on selects `voyage:rerank-2.5`, requires a Voyage key, rejects fake embeddings, and must produce observed reranker scores. Expansion budgeting, keyword-arm confidence and generic `--search-pin KEY=VALUE` support controlled comparisons. Unknown CLI flags are rejected.

The concept split defaults to 20 tuning concepts and 10 held-out concepts, seed 42. Scores and per-template results are reported separately; questions spanning both sets stay in the overall result but not either subset. See the [Cat13 recipe](eval/runner/README-cat13-phase-e0.md).

### Test reliability

A process-global embedding transport could be reset by another test, causing a supposedly hermetic run to call a live provider. The runner now reinstalls its transport and verifies it before ingestion and queries.

PGLite's roughly 1 GB WASM allocation also delayed garbage collection. Tests accumulated 1–2 GB of temporary objects and more than 50,000 memory mappings, approaching the default kernel limit of 65,530. Collection is paced every 40 imported pages, every 25 queries and after teardown. Full-suite peak mappings fell from about 55,000 to 16,000 without changing assertions.

## [0.6.1] - 2026-09-02

A fresh [LongMemEval-S comparison](docs/benchmarks/2026-05-07-longmemeval-s.md) measured gbrain v0.48.2.0 on the cleaned September 2025 dataset. Each arm scored 470 answerable questions at k=5 in one run, with zero errors.

| Arm | Strict recall_all@5 | Questions |
|---|---|---|
| Hybrid | 93.19% | 438/470 |
| Hybrid with reranking | 95.32% | 448/470 |
| Hybrid with session diversity | 93.40% | 439/470 |
| Session diversity plus reranking | 95.53% | 449/470 |
| Hybrid with query expansion | 54.89% | 258/470 |

The reranker gained 18 questions and lost 8 compared with hybrid. Its any-hit score was 99.79%. Temporal-reasoning recall rose from 84.3% to 89.8% (107 to 114 of 127), the knowledge-update and three single-session types reached 100%, and multi-session recall stayed at 92.6% (112/121).

Session diversity added one question without reranking. Expansion lost 183 and gained 3; its earlier v0.48.0.0 measurement was 49.6%. More alternative phrasings did not help at this five-result limit.

### Reproducibility and comparisons

The dependency moved to `5cfb84f1`, the v0.48.2.0 PR #4792 head, pending its merge pin. Reranker specifications explicitly selected `voyage:rerank-2.5` and derived the required `VOYAGE_API_KEY` from that model choice.

The 93.19% hybrid result matched the v0.48.0.0 receipt and could be compared with the May 83.40% result. A pre-fix run at `2a56b512` recorded 51.39%. All five arms and the pre-fix stream were committed with artifact hashes, an aggregate and regenerated charts.

The charts separated strict recall from any-hit and answer accuracy. Their contextual comparisons used our recomputation of MemPalace's strict scores, 85.7% raw and 90.0% with LLM reranking, and ContextFit's self-reported 87.45% with its label-leakage qualification.

### Compatibility fixes

- Reconciled `package.json`, previously 0.5.1, with `VERSION` at 0.6.1.
- Updated graph traversal contract tests for gbrain #4704's bidirectional `GraphPath[]` result shape. Tests retained the depth-10 cap, explicit depth and depth-2 default checks.
- Cat15 reads `PROPOSE_TAKES_PROMPT_VERSION` from gbrain instead of a stale literal. The prompt text also changed in gbrain #4736, so the old Cat15 F1 result required a live remeasurement.

## [0.6.0] - 2026-09-01

Outside reviews #26 and #24 prompted stronger links between claims and saved results. The review's sub-claim about PR #13 containing benchmark figures was refuted.

### Saved evidence

- Committed the May LongMemEval stream: 2,696 rows, hash `a26453…3d0b`. An offline regression test recalculates all four adapters' summaries and per-type results. The previously referenced but missing NDJSON validator was added.
- Added `docs/receipts-manifest.json`, which maps selected claims to artifact hashes and expected values or explicit gaps. The declared gaps were SkillOpt, relational recall and the stability snapshot.
- Committed the June Cat34 originals and a dated offline rerun at `2a56b512`: know-to-ask failures 0/149 and push recall 0.9063 / 1.000 / 0.5521. The report disclosed that it relies on counters reported by the system under test and preserved historical charts.
- Cat35 receipts began recording server-reported model IDs and call counts. Cross-run deltas require matching resolved models; `claude-sonnet-4-6` remained a movable alias rather than a dated snapshot.

### Session-level diagnostics

The May top-five chunk lists averaged 2.68 distinct sessions, with 99.6% containing fewer than five distinct sessions. This motivated explicit session-diversity adapters, including expansion and reranker variants. It did not itself prove diversity would improve accuracy. Existing adapters retained their behavior, rows gained a `run_config_hash`, and aggregation rejected mixed configurations.

### Clearer claims

The comparison guide identified MemPalace's 96.6% as any-hit recall and labeled the then-quoted 97.66% gbrain comparison accordingly. ContextFit's 84.3% token-plus-certificates and 87.45% fused strict scores were separated from gbrain's May 83.40% / 84.26%. LETHE, Memoria, Mem0 and a PrecisionMemBench comparison were added with sources.

PrecisionMemBench's 0.582 became an explicitly qualified upper bound and the default was corrected to 0.075. Cat35's “zero junk leakage” became 1.2% (1/86), Cat34's 0.552 Codex integration result was included, and the historical relational 97.9% / 49.1% result gained a pre-audit qualification.

CI stopped swallowing typechecker crashes. Phase 2 smoke arguments were changed to an array.

## [0.5.1] - 2026-08-31

The May LongMemEval scoring error was corrected at $0 by rescoring the saved output. The same returned and expected sessions produced:

| Adapter | Strict recall_all@5 |
|---|---|
| Keyword | 10.64% |
| Vector | 79.36% |
| Hybrid | 83.40% |
| Hybrid with expansion | 84.26% |

There were 470 scored questions; 30 abstention questions were excluded. Hybrid multi-session recall was 71.9% and temporal-reasoning recall 69.3%. Knowledge-update also lost credit on one question requiring multiple sessions.

The old score reconciled exactly: 459 answerable any-hits plus 29 abstention any-hits gave 488/500 = 97.60%. All 500 reference answer sets matched the dataset, there were no error rows, and 696 resume duplicates were removed with successful rows preferred. Saved summaries are `rescore-may-2026-08-31.json` and its generated Markdown companion.

Under strict scoring, expansion added four questions, or 0.85 percentage points overall, and 3.9 points on temporal reasoning. The earlier “no effect” conclusion came from an almost saturated any-hit metric.

Reproduction examples were corrected: `--path` takes the file path, `--dataset` the split name, and the runner defaults to k=8. A published k=5 comparison must select it explicitly. A fresh run of newer gbrain code remained separate work at this release.

## [0.5.0] - 2026-08-31

**Scoring definitions changed. Earlier scores cannot be compared directly with post-audit runs.** The [audit](docs/audit/2026-08-31-eval-audit.md) verified 237 findings and drove these changes:

- Recall counts unique IDs; precision@k divides by k. LongMemEval uses all-required-session recall. Model judges must return every required criterion at temperature 0.
- Common receipts distinguish success, failure, skip and error origin. The category runner reads receipts instead of interpreting every zero exit as success. System failures remain scored misses; excessive harness failures invalidate a run at the stated greater-than-10% limit.
- Fixed Cat13/Cat13b gateway setup, asynchronous link extraction, LongMemEval imports and 17 runners' version stamps. The gbrain dependency and lockfile were pinned.
- About 12 tests that could not previously fail gained reachable failure conditions, feature boundaries and negative controls. Judges were blinded where needed. Unintended reranking was removed from embedder comparisons.
- Repaired source-data references, an overwritten synthetic deal page and the q11 answer label with a recorded rationale. Baseline latency capture became serial; the old concurrent measurements were about ten times too high.
- Added offline CI checks for types, tests, data integrity, selected end-to-end runners and the qrels/baseline comparison.
- SkillOpt held-out tasks gained different, stricter judging criteria. Earlier held-out scores tested topic transfer but reused training criteria.
- Wrapper scripts now propagate failed categories. The LongMemEval batch script respects the dataset and its size. Shootout scripts check each cell, and Phase 1 has a wall-clock limit. The prior environment-expansion bug had silently killed four of seven cells.

Releases 0.3.0 and 0.4.0 landed during remediation. The final pin was v0.47.8.0 (`2a56b512`), six commits after the audited v0.47.6.0 code. The remediated suite was rechecked against it.

## [0.4.0] - 2026-08-31

The [Cat35 report](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) added before-and-after runs around gbrain's write-path fixes in [PR #4742](https://github.com/garrytan/gbrain/pull/4742). They used the same corpus, judge model and prompt version.

Dream-lane retention reached **88.1%**, with a 95% interval of **82.0–93.5**, compared with 61.5% in the original publication and 70.2% immediately before the change. All 20 expected sessions produced pages, up from 16. The four recovered sessions used verified quoted segments despite falling below the ordinary triage threshold; routine controls did not trigger the rescue.

Quote fidelity reached 82.7% from 45.4%, claim hallucination fell to 7.0% from 14.1%, and facts-lane recall reached 64.8%. Adding an idea category improved idea recall from 38.3% to 50.0%. Both new receipts were preserved alongside the original, with qualifications about single-run judge variation, changed quote denominators and a distractor judgment changing.

The [Cat34 update](docs/benchmarks/2026-06-12-brainbench-memory.md) recorded know-to-ask failure falling from 0.150 to 0.000 on all three integrations after gbrain v0.46.15.0. False fires were 0.000, push recall 0.906 / 1.000 / 0.552, and precision 1.000.

The dependency advanced to `2a56b512`, v0.47.8.0. The PGLite teardown freeze no longer reproduced there; six skipped test teardowns were restored after watchdog-protected verification.

## [0.3.0] - 2026-08-27

Added Cat35 to measure what survives when a working conversation becomes memory: facts, ideas, decisions, entities and emotional context.

The [first publication](docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md) measured **61.5% retained content** (95% interval 45.0–77.6), 85% usability, zero distractor leakage and 14.1% hallucinated claims. The verbatim control measured 93.1% judged coverage, 100% leakage after the case-insensitive correction, and 0% usability. Emotional-context recall was 71.4% versus 52.5% for facts; the separate facts extractor scored 69% on facts and 38% on ideas.

The committed corpus contains 24 fictional sessions, six scenarios, 173 important content units with verbatim anchors, 86 distractors and two attribution hazards. Its skeleton is deterministic; its prose came from cached Opus generation.

The runner defaults to a small paid setup check, historically about $0.10. The full package command selects `CAT35_FULL` and performs a cost preflight. Receipts include comparison deltas, triage thresholds and a judge-calibration scaffold.

Review added case-insensitive anchor checks, full-corpus publication requirements, evidence-backed judge verdicts, explicit judge-failure handling and transcript hash validation. The leakage correction changed the verbatim floor from 96.5% to 100%; dream remained 0%.

The dependency was pinned to gbrain v0.46.3.0, installation gained the PGLite path repair, and category-runner/tool-bridge tests were fixed. The Bun teardown freeze was temporarily worked around and tracked upstream.

## [0.2.0] - 2026-05-29

Integrated [PrecisionMemBench](https://github.com/tenurehq/precisionmembench), using tenurehq's MIT fixtures and scorer at `c9689ca`. The test separates how much relevant material search returns from whether a later model writes a good answer.

The initial default hybrid score was reported as **0.076 precision**, with recall 0.99. Returning many pages made recall high but precision low. Later documentation reconciled the default to its saved value, 0.0752.

That experiment led to optional adaptive result limits. The historical tight setting scored **0.582 precision, 29 active passes and 44/77 overall cases**, compared with the cited supermemory row of 0.43 and 17 active passes at roughly three times the latency. These comparisons describe that recorded setup; subsequent adapter corrections required remeasurement.

A proposed score-gap detector did not separate right from wrong first results: the rank-one/rank-two gap was 0.60 for correct results and 0.57 for incorrect ones. Restricting result count accounted for the useful improvement in this experiment.

The report distinguished the 35-belief lexical corpus, harness-computed structural cases and the think adapter's citation-based view from ordinary search. Adaptive behavior stayed off by default pending a recall comparison. The then-promoted LongMemEval 97.60% number used the old any-hit metric; release 0.5.1 later corrected its interpretation.

Added the external fixtures, scorer, adapters, seed code, attribution, four-mode runner, instrumentation and tests. The adaptive option initially needed a local unreleased gbrain checkout.

Saved JSONs were added for the tight result and ordinary settings. One shipped-default adaptive row was reconciled to its actual run: 0.16 precision, one active pass and 8/77 cases. The scorer's type import was corrected to its local layout, the gold-schema test excluded unrelated subset files, and the fictional v0.41-launch baseline/qrels work was included.

## [0.1.0] - prior

Initial BrainBench included world-v1 and amara-life-v1, the 12-category catalog, LongMemEval-S integration and the v0.40.6.0 snapshot. Its historical 97.60% LongMemEval figure was compared with MemPalace's 96.6% raw figure; subsequent releases clarified the metric and comparison limits. See the dated reports for the original experiments.
