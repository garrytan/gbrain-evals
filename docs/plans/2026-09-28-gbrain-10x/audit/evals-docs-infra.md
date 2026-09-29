# gbrain-evals audit: publication integrity and infrastructure

Auditor scope: README.md, docs/ (README, retrieval-lessons, settings, comparison-systems, benchmarks/*, audit/), eval/README.md, CHANGELOG.md, TODOS.md, docs/receipts-manifest.json, CI, package scripts, dependency pins, postinstall/patches, typecheck, test runtime, first-time-visitor experience.

Repo state audited: `gbrain-evals` at `b439f12` (v0.10.0). gbrain master at `6bb88d1` (v0.59.3.0). All experiments were run in scratch copies under `audit/scratch-docsinfra/` (read-only on both repos; no paid API calls).

Severity: **P0** wrong published number / broken measurement, **P1** real bug or misleading, **P2** hygiene.

## Executive summary

1. **No P0 found on headline numbers.** Every headline number in README.md and docs/README.md recomputes exactly from committed receipts (table below), and all 101 manifest entries' SHA-256 hashes match. The receipts discipline is genuinely strong.
2. **The dependency pin matches neither the product nor the evidence (P1).** `package.json` pins gbrain `939232f` (v0.55.0.0), which lives only on the unmerged branch `capy/situation-aware-recall`. `gbrain-reader` pins `a9de062`, which is on **no** branch at all. The retrieval numbers in README were produced at `2efaaf8f` (v0.48.4.0). Meanwhile `docs/settings.md:10` and `docs/comparison-systems.md:28` still say v0.48.4.0 / `2efaaf8f` is "the library installed by this repository". That's false.
3. **Re-pinning to gbrain master breaks 21 tests, plus 1 unhandled error** (1889 pass, 7 skip). Five causes: Cat36 and the LongMemEval-M pilot import `src/core/memory-cues/*`, which does not exist on master; the ZeroEntropy provider was removed; the default embedder changed; a test hook was removed; and 10+ tests hard-code the exact pin SHA. `tsc` also reports 7 new repo-file errors. **The suite cannot currently benchmark gbrain master.**
4. **README comparisons are favorable-by-construction in three places (P1).** (a) The concept claim compares gbrain *with a reranker* (130/181) against vector search *without* one (118/181); without reranking, gbrain scores 102/181, below vectors. (b) The relationship claim quotes only the best template (investors 9→21/39). Overall first-place hits went 14%→24%, and attendance stayed at 0/50. (c) The 95.53% LongMemEval config was chosen on the same 470 questions, with no held-out check. Cat35's 88.1% is also in-sample after tuning. The detailed reports disclose these points; README does not.
5. **A first-time visitor cannot tell in 2 minutes why gbrain is SOTA, because the repo never makes that case.** The one matched-metric comparison where gbrain leads is buried in comparison-systems.md: strict recall_all@5 of 95.53%, versus 90.0% and 85.7% (our strict recomputations of MemPal's saved rankings) and ContextFit's self-reported 87.45% All@5. Conversely, gbrain's 86.6% answer accuracy is *below* several vendor self-reports (93–94%), and there is no matched-reader run. CLAUDE.md forbids "best" claims unless a comparison establishes them, so the README is hedge-first.
6. **CI is real but has gaps (P1).**
   - 77 bun tests under `eval/`, 25 Python unittests, and three validators never run in CI or `bun run test` (all pass today).
   - The CI steps for Cat 2 (type-accuracy) and Cat 3 (identity) cannot fail on a score regression; they fail only on a crash.
   - The job uses 682 s of a 900 s timeout.
7. **Dead infrastructure (P2).**
   - `patches/postgres@3.4.9.patch` is never applied. There is no `patchedDependencies`, and I verified unpatched code on a fresh frozen install. CHANGELOG 0.10.0 claims otherwise.
   - The pglite postinstall symlink is no longer needed at either pin (verified with connect + initSchema without it).
8. **Typecheck is part of the gate, but only for repo files.** The 94–100 `tsc` errors are all in `node_modules/gbrain*`. They come from missing ambient types (DOM `RequestInfo`/`BodyInit`, `@types/js-yaml`/`express`, and Bun `*.md`/`*.wasm` text imports). About five lines of config would fix them.
9. **Test runtime: 685 s for the full suite.** 127 tests longer than 1 s account for 653 s of the 694 s summed test time (94%). The dominant cost is building a fresh PGLite brain and running 160 migrations per test (120 migration runs in one suite pass). A pre-migrated snapshot plus sharding should cut this to about 2–3 min.
10. **TODOS and GitHub hygiene.**
    - The SkillOpt export TODO is already done upstream; code comments still claim it isn't.
    - The ZeroEntropy items are obsolete (provider sunset 2026-09-04 and deleted on master).
    - Two published protocol reports are missing from the docs index.
    - Five open issues and eight open PRs are stale or already fixed. They include PRs carrying pre-erratum numbers.

---

## A. Headline numbers: verification

All recomputed from committed files with independent Python (scripts in scratch; not the repo's own recount code).

| Claim (location) | Source artifact | Recomputed | Status |
|---|---|---|---|
| 449/470 = 95.53% strict recall_all@5 (README:23, docs/comparison-systems.md:7, retrieval-lessons.md:11, settings.md:7) | `docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval/FINAL-release-config-…ndjson` (also A2, D1) | 449/470 (95.53%) in FINAL, A2, and D1; A2 and FINAL have identical retrieved sessions on 500/500 rows | ✅ |
| 433/500 = 86.6% answer accuracy (README:26) | `D1-judged-release-config-sonnet46-reader-gpt4o-judge.ndjson` | 433/500 `judge_correct`; abstention 29/30 | ✅ |
| Autocut off raises 379/470 → 449/470 (README:51, retrieval-lessons "Returning less") | A4 vs A2 ndjson; run_config differs only in `autocut` | 379 → 449; 70 gains / 0 losses | ✅ |
| Reranker: 439 → 449, 18 gained / 8 lost (comparison-systems.md:30) | A1 vs A2 | 18 / 8; any-hit 464 → 469 | ✅ |
| 53 complete-but-wrong, 13 incomplete-and-wrong (retrieval-lessons "What the scores mean") | D1 | 53 / 13 | ✅ |
| Expansion 255/470, budget 0.25 → 394/470, tokenmax 436/470 | A3, A3prime, TMXR | 255, 394, 436 | ✅ |
| Reading notes 308/361 → 324/361, 9 truncated (README:31) | `2026-09-25-reading-notes/reading-notes-transfer.ndjson` | 308 → 324; notes truncated 9, baseline 0; discordant 22 vs 6, exact McNemar p = 0.0037 | ✅ |
| Concept held-out exact-first 130/181 vs 118/181 (README:38) | `2026-09-09-retrieval-refresh/summary.json` | concept-rerank gbrain p1_strict 0.7182×181 = 130; vector 0.6519×181 = 118 | ✅ number, ⚠ framing (B2) |
| Investor first-place 9/39 → 21/39 (README:47) | `summary.json` relationships.by_template.invested_in | 0.2308 → 0.5385 per seed | ✅ number, ⚠ framing (B3) |
| Gate 53.0 → 57.8, vector 60.5 (retrieval-lessons) | `2026-09-06…/cat13/E0-V1`, `E3-V1` report.json | 0.5296 → 0.578; vector 0.6054 | ✅ |
| Cat35 70.2% → 88.1%, 20/20, 7.0% hallucination (README:108) | cat35 receipts via manifest expected values | manifest test pins 0.7017 / 0.8814 / 20 / 0.0698 | ✅ number, ⚠ framing (B5) |
| PrecisionMemBench 0.5859 / 0.8250 (settings.md, comparison-systems.md) | `summary.json` precision | 0.5859 / 0.825 | ✅ |

Manifest integrity: all 101 entries in `docs/receipts-manifest.json` resolve, and every declared `artifact_sha256` matches (hash check script in scratch). Four entries are honestly marked `disclosed-gap`.

Python verifiers not run in CI (see C6) also pass today:
- `scripts/verify-published-longmemeval.py`: 0 mismatches across all arms.
- `scripts/verify-documentation-refresh.py`: `errors: []`.
- `test/retrieval_refresh_orchestrator_test.py`: 25 OK.

---

## B. Publication integrity findings

### B1 (P1). Version and pin claims are wrong or contradictory across docs

Evidence:
- `docs/settings.md:10`: "These recommendations refer to **gbrain v0.48.4.0, commit `2efaaf8f`**, the library installed by this repository."
- `docs/settings.md:3-4`: "At this repository's pinned version, it combines search methods…"
- `docs/comparison-systems.md:28`: "Gbrain v0.48.4.0 is pinned at `2efaaf8f8a817b5b82e023383618fdcdb1cc5f7d`."
- `package.json:38`: `"gbrain": "github:garrytan/gbrain#939232f1746381b4e932d620d6c709e29198f14c"`, i.e. v0.55.0.0, changed in v0.9.0 (commit `70bf934`; `git log -p package.json` shows `2efaaf8f` → `939232f`).
- `README.md:62-64`: "See the [pinned gbrain implementation](…/tree/939232f…)". This sits in the paragraph that presents results produced at `2efaaf8f` (Sep 6/9), `a9de062` (reading notes) and `079941d2` (Cat35).
- `CHANGELOG.md` 0.10.0: "Keep the established `gbrain` pin for historical runners". But the historical runners' results came from `2efaaf8f`, not the current pin.
- `docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval/ranker-wave-arms.json` labels the release arm "v0.48.3.0", while the report says v0.48.4.0. This is disclosed in the report (receipts came from pre-squash branch `fd7e7fd9`), but the JSON label remains.

Why it matters: a reader who runs `bun install` and follows settings.md gets v0.55 code from an unmerged branch, not the code measured. The balanced-mode bundle is identical across `2efaaf8f`, `939232f` and master (verified by diffing `src/core/search/mode.ts`), so the *recommendations* still hold. The identity statement is simply false.

Fix:
1. Add a "Code identity" column or table to README: per headline, name the gbrain commit and version that produced it (2efaaf8f / fd7e7fd9, a9de062, 079941d2).
2. Change settings.md and comparison-systems.md to "measured at `2efaaf8f`; the repository currently installs `<pin>`".
3. Make a test assert that every doc mentioning "installed by this repository" names the actual `package.json` pin. `verify-documentation-refresh.py` is the natural home.

### B2 (P1). README concept claim compares gbrain+reranker against vectors without a reranker

Evidence: `README.md:36-41`: "gbrain put an exact target first on **130/181**, versus **118/181** for vector search alone. That configuration used a reranker…". From `docs/benchmarks/2026-09-09-retrieval-refresh.md:260-267` and `summary.json`, held-out exact-first:

| Config | Held-out exact-first |
|---|---|
| vector | 118 |
| gbrain lexical gate | 102 |
| hybrid | 102 |
| BM25 | 101 |
| gbrain ungated | 87 |
| gbrain + rerank | 130 |

There is no vector+rerank cell.

Why it matters: the comparison mixes an extra model stage into one arm only. On a like-for-like basis (no reranker), gbrain's hybrid *loses* to vector-only by 16 questions (paired p1: 22 gains / 6 losses for vector over gbrain, `concept_pairs/2`). Source-swamp shows the same pattern: vector top-1 is 0.967 vs gbrain 0.900 (`summary.json` source_swamp). The README mentions the reranker but not that gbrain without it trails vectors. That is the fact an engineer needs.

Fix: add a `vector + voyage rerank-2.5` cell (cheap: 548 queries, Voyage rerank only). Until then, README should say: "with reranking 130/181; without it gbrain scored 102/181 versus 118/181 for vectors alone".

### B3 (P1). The relationship headline quotes only the best template

Evidence: `README.md:43-50` quotes investors 9/39 → 21/39. `summary.json` relationships:
- Overall hit@1 0.1425 → 0.2391 (145 questions).
- works_at hit@1 unchanged at 0.1167.
- attended hit@1 0 → 0 (0/50).
- advises 0.4375 → 0.5625.

Relationship retrieval fired on only 47 of 145 questions per seed. README does disclose that attendance did not improve.

Why it matters: "relationships as evidence" is a core differentiator, but overall first-place accuracy with the stage on is 24%. The single best template overstates the capability.

Fix: lead with the overall numbers (R@5 0.663 → 0.724, hit@1 14% → 24%, 45 gains / 0 losses), then the investor example. Separately, fix the `attended` link-direction mismatch (fixture `meeting → person` vs parser `person → meeting`). That is a free win for the product and the benchmark.

### B4 (P1). The 95.53% LongMemEval config was selected on the test set; README omits this and the missed pre-registration

Evidence:
- `2026-09-06-longmemeval-ranker-wave.md:34-38` arm table: A4 (autocut on) is the "decision baseline". The autocut-off release config was chosen after comparing A2 and A4 on the full 470-question decision set. Only the expansion-budget sweep used the 40-question dev slice. A2 and FINAL produce identical retrievals on 500/500 rows (verified), so the headline is literally the arm chosen on the test questions.
- Same report line 174: "The pre-registered prediction of at least 92% was missed" (QA accuracy 86.6%).
- The reader sees "the full text of each distinct session represented by the first five retrieved chunks, subject to a 60,000-character cap per session" (line 187). README:23 frames retrieval as "within five returned text chunks", which is true for scoring, but the reader consumes up to five whole sessions.

Why it matters: a single binary knob chosen on the test set is mild, but it is still test-set selection. LongMemEval-S has no official dev split, so a held-out confirmation (e.g. LongMemEval-M, or a fresh 50/450 split) is the honest remedy. The missed pre-registered target is material context for the 86.6%.

Fix: add one README sentence ("configuration chosen on these 470 questions; no held-out confirmation yet; the pre-registered ≥92% answer-accuracy target was missed") and run the preregistered LongMemEval-M pilot to completion.

### B5 (P1). Cat35 88.1% is an in-sample result after tuning; README omits this

Evidence: `docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill.md:115`: "The later fixes were informed by its failures, so the same-corpus improvements are regression evidence, not untouched holdout generalization." `TODOS.md:51` confirms that held-out transcripts are still missing, and the manifest note on `cat35-prewave-receipt` says "regression evidence after tuning on this corpus". `README.md:104-111` says "The recorded repair improved retention from 70.2% to 88.1%" with only the judge-calibration caveat. It is also a single run (`TODOS.md:49`).

Fix: add "tuned on this same 24-session corpus; single run; no held-out set yet" to README, and prioritize TODOS:51 (about $3).

### B6 (P1). First-time visitor: the SOTA case is absent, and the QA gap is unaddressed

What a visitor sees in 2 minutes: an essay-style README ("Why put gbrain on your shortlist?") with six bold-lede paragraphs, each hedged. There is no table, no competitor numbers, and no single "where gbrain stands" line. The strongest comparative fact lives 30 lines into `docs/comparison-systems.md`:
- gbrain 95.53% strict recall_all@5, 5 chunks (≤5 sessions, mean 4.89 distinct).
- MemPal hybrid v4 + LLM rerank: 90.0% strict, *our recomputation from their committed rankings*.
- MemPal raw: 85.7%.
- ContextFit fusion: 87.45% All@5 (self-reported, own harness).
- LongMemEval paper Stella: 0.706 R@5 on `_m` (not matched).

Two things are confusing or missing:
1. **No matched leaderboard.** `CLAUDE.md:15` ("Avoid claims such as 'only system,' 'best,' or 'beats the field' unless the comparison actually establishes them") is the right rule. But the strict-recall comparison against recomputed rankings *does* establish a narrow claim, and README never states it.
2. **End-to-end QA is not SOTA and not matched.** From comparison-systems.md:50-62:

   | System | QA accuracy | Reader |
   |---|---|---|
   | gbrain | 86.6% | Sonnet 4.6 |
   | Mem0 (self) | 94.4% | GPT-4o |
   | Mastra | 93.6% | gpt-5-mini |
   | Mastra | 84.8% | gpt-4o |
   | ByteRover | 92.8% | own |
   | Hindsight | 91.4% | Gemini-3 |
   | Zep | 90.2% | gpt-5.4 |
   | Supermemory | 81.6% | gpt-4o |

   gbrain has never been run with a gpt-4o reader, which would give a matched comparison to Mastra/Supermemory, or with a frontier reader, which would give a comparison to the 90%+ systems. README's 86.6% invites exactly the unfavorable comparison the repo warns against, without the data to answer it.

Other confusions for a newcomer:
- The adapter name `gbrain` in the multi-adapter runner means a *graph-template-only* adapter (eval/README.md "The four retrieval adapters"). It is not the product's hybrid search, so "gbrain vs vector" tables in historical reports compare a specialized parser, not the product.
- "Cat" numbering (Cat 2 … Cat 36) with gaps and letter suffixes; 36 categories, but README exposes about 5.
- Two different "relationship off" baselines for investors in the same doc section (B9).
- README's "Try a small experiment" works keylessly (verified: `BRAINBENCH_N=1 bun eval/runner/multi-adapter.ts --adapter grep-only` finishes in 0.6 s), but it runs only the BM25 baseline. There is no keyless way to see *gbrain* do anything in under a minute.

Fix:
1. Add a top-of-README "Where gbrain stands (matched protocols only)" table:
   - LongMemEval-S strict recall_all@5, gbrain vs strict recomputations and self-reported All@5 rows, with k-unit and LLM-in-loop columns.
   - A QA row labeled "not matched" with the reader named.
2. Run gbrain retrieval with gpt-4o and a frontier reader (plus notes-first, per the Sep 25 study) to get matched QA numbers. This is the single experiment most likely to move the headline.
3. Add a keyless 30-second gbrain demo (hash embeddings or the stub path) that shows hybrid vs BM25 on the fictional world, clearly labeled as plumbing.

### B7 (P2). Docs index omits two published reports

Evidence: `docs/benchmarks/2026-09-23-situation-recall-protocol.md` and `docs/benchmarks/2026-09-24-longmemeval-m-pilot-preregistration.md` are linked only from CHANGELOG (grep over README.md and docs/README.md returns 0 hits). docs/README.md positions itself as the full index.

Fix: add a "Protocols and preregistrations (no results yet)" table to docs/README.md.

### B8 (P2). "Externally authored" label on synthetic questions

Evidence:
- `eval/runner/multi-adapter.ts:103`: `splitByGold('externally-authored', getTier5_5SyntheticQueries())`.
- `eval/runner/types.ts:74`: `'externally-authored'; // T5.5: outside-researcher queries`.
- `eval/README.md`: "All applicable families: relational, fuzzy and externally authored."
- But `eval/external-authors/README.md`: "The existing Tier 5.5 synthetic placeholders are labeled `synthetic-outsider-v1`; that label does not mean a human external contributor wrote them."
- `eval/external-authors/` has no contributor directory. Every scorecard prints an "externally-authored" row (verified in the quick run: "externally-authored: P@5 19.6%, R@5 85.1%").

Fix: rename the family to `synthetic-outsider` in output (keep the old id as an alias for historical receipts).

### B9 (P2). retrieval-lessons.md puts two different "off" baselines side by side

Evidence: in `docs/retrieval-lessons.md`, section "A text reranker can lose an answer found through a relationship":
- "restored first-place relationship hits from 3/39 to 21/39" (Sep 6, reranker on, pin off → on).
- Two paragraphs later: "first-place hits rose from 9/39 to 21/39" (Sep 9, reranker off, relational retrieval off → on).

Both end at 21/39, from different starting points and settings. A reader will assume a typo.

Fix: state each arm's reranker/pin/relational settings inline.

### B10 (P2). Superseded, invalid PrecisionMemBench row still bold in the comparison table

Evidence: `docs/comparison-systems.md` PrecisionMemBench table: `| **gbrain adaptive (tight)** | **0.582** (May result with flawed seeding; superseded) | ~270ms |`. It is bold, ranked second, and positioned above competitors, although the text calls it invalid. The corrected Sep 9 value (0.5859 / 0.8250) is only in prose. Issue #26 item 5 raised the same class of problem.

Fix: replace the row with the Sep 9 corrected row (label it with its own date and protocol), and move the May row to a strike-through or footnote.

### B11 (P2). Machine-local paths in committed receipts

Evidence: `ranker-wave-arms.json` FINAL/TMXR `run_config.expansion_replay`: `/home/vercel-sandbox/gbrain-lme-receipts/A3.ndjson`. It is harmless, but it leaks runner environment details and is not resolvable.

Fix: normalize to repo-relative paths in `compact-harness-rows.py`.

### B12 (P2). Links

- **Relative links:** all 547 Markdown links were checked (path and heading anchor) across the repo, excluding `node_modules`. Every relative doc link and anchor resolves. The only "misses" are wiki-style slugs inside test fixtures (`eval/data/amara-life-v1/**`, `cat35…/artifacts/*.dream.md`), which are corpus content, not doc links.
- **External links:** all 63 fetched. 62 return 200; `medium.com/@matrixorigin-database/…` returns 403 (bot block, not dead; a dev.to mirror is also cited).
- comparison-systems.md already discloses that two Supermemory URLs redirect to the homepage.

No action needed beyond adding a link check to CI (C6).

---

## C. Infrastructure findings

### C1 (P1). Pins point at commits outside gbrain master; one is on no branch

Evidence (in `gbrain`):
- `git merge-base --is-ancestor 939232f master` → not an ancestor. `git branch -a --contains 939232f` → only `origin/capy/situation-aware-recall` and `origin/capy/answer-evidence-packet`. Commit message: "test(memory): match evidence vectors to the initialized descriptor", 2026-09-24, VERSION 0.55.0.0.
- `git branch -a --contains a9de062` → **no branches** (a merge commit "Merge origin/master attendance and recall release", VERSION 0.59.0.0). It is reachable only through PR refs, if at all. Master's v0.59.0.0 is a different commit (`e78f1c38b`).

Why it matters: if `capy/situation-aware-recall` is deleted or force-pushed, or the PR ref is GC'd, `bun install --frozen-lockfile` stops working for everyone. The lockfile has a sha512, but GitHub must still serve the tarball. The benchmark suite is also pinned to code the product never shipped.

Fix: pin only to commits on gbrain master, ideally release tags. If the situation-recall work must stay experimental, isolate it behind a third alias (`gbrain-cue`) like `gbrain-reader`. Or merge it upstream and re-pin.

### C2 (P1). Re-pinning to gbrain master: 21 fails + 1 unhandled error

Method: `rsync` the repo (minus `node_modules`) to scratch, run `bun add gbrain@github:garrytan/gbrain#master` (resolves `6bb88d1`, VERSION 0.59.3.0), then run `bun test test/eval/` with no `DATABASE_URL`/OpenAI/Anthropic env. Result: **1889 pass, 7 skip, 21 fail, 1 error, 685.5 s** (the pinned suite gives 1925 pass, 0 fail). Log: `scratch-docsinfra/master-test.log`.

Root causes:

| Cause | Failing tests / evidence | Nature |
|---|---|---|
| `src/core/memory-cues/{windows,providers,evidence,types}.ts` do not exist on master (situation-aware recall unmerged) | Cat36 production raw-five, separate native operation replay, PGLite snapshot, LME retained evidence, C1 SDK wire, LME-M pilot snapshot/replay, v5 C0/C1 construction; **unhandled error**: `Cannot find module …/memory-cues/providers.ts` (`longmemeval-m-pilot-v5-stage.test.ts`) | Harness depends on unshipped product code |
| ZeroEntropy recipe deleted on master (`src/core/ai/recipes/` has no zeroentropy) | `cat18b-embedding-rerank-matrix.test.ts:111` gets verdict `partial` instead of `pass`: "cell openai-1536+rerank query q1: reranker did not run (fail-open)". Cells hard-code `reranker: 'zeroentropyai:zerank-2'` (`eval/runner/cat18b-embedding-rerank-matrix.ts:112-116`). Also the Cat18b native-observation test. | Provider retired (sunset 2026-09-04); open PR #35 addresses this |
| Default embedder changed from `zeroentropyai:zembed-1`@1280 (939232f `src/core/ai/defaults.ts:26`) to `voyage:voyage-4`@1024 (master `:15`) | `test/eval/longmemeval-metrics.test.ts:583`: `expect(getEmbeddingModel()).toBe('zeroentropyai:zembed-1')` | Test hard-codes a product default |
| Test hook `__setSunsetClockForTests` removed from `gateway.ts` | `eval/runner/cat36-production.ts:209` (tsc TS2339 and runtime TypeError) | Harness uses a private test seam |
| Exact-pin identity assertions | `reading-notes-requests.test.ts:24` (expects `#939232f…`); "current v5 consumer is the exact Git-installed 939 package"; 6× `situation-recall-openrouter` ("live profile needs exact product SHA"); Cat36 grounded-answer ("exact live product identity required") | By design, but the SHA is duplicated across many files, so any re-pin is a multi-file edit |

`tsc --noEmit` against master: 100 errors, **7 in repo files** (vs 0 at the pin): 5× TS2307 memory-cues, 1× TS2339 `__setSunsetClockForTests`, 1× TS2345 `extractPageLinks` signature (`test/eval/situation-native-evidence-2-4-6.test.ts:95`). Log: `scratch-docsinfra/tsc-master.log`.

What still works at master: all historical retrieval runners' tests (Cat13/13b/LongMemEval metrics except the default-embedder assertion, precision, multi-adapter), the balanced-mode bundle (identical fields), and PGLite init.

Fix plan:
1. Put the exact pin in one exported constant (e.g. `eval/runner/pins.ts`) and read it in every test.
2. Land PR #35 (retire ZeroEntropy cells).
3. Replace the hard-coded default-embedder assertion with a comparison to `gbrain`'s exported `DEFAULT_EMBEDDING_MODEL`.
4. Gate memory-cues-dependent tests behind a capability probe, or move them to the `gbrain-cue` alias (C1).
5. Add a weekly CI job that installs gbrain master and runs the suite as non-blocking canary. The drift would have surfaced immediately.

### C3 (P2). `patches/postgres@3.4.9.patch` is inert; CHANGELOG claims otherwise

Evidence:
- `package.json` has no `patchedDependencies`, and `bun.lock` contains no "patch" entry (`grep -n patch bun.lock` → none).
- Bun applies only the root project's `patchedDependencies`, so gbrain-reader's own `patchedDependencies` (`node_modules/gbrain-reader/package.json:199`) is ignored when it is installed as a dependency.
- Verified on a fresh `git clone` + `bun install --frozen-lockfile`: `grep -rl cancelResolve node_modules/postgres/` → no match (the patch adds `cancelResolve`).
- `CHANGELOG.md:41-43` (0.10.0): "Retain its required `postgres@3.4.9` patch at the repository root so Bun's frozen lockfile install can resolve the transitive patch from a clean checkout." That did not happen.

Impact: low today (the suite uses PGLite, not the postgres driver), but any Postgres-backed run through gbrain-reader uses the unpatched driver the reader was written against.

Fix: add `"patchedDependencies": {"postgres@3.4.9": "patches/postgres@3.4.9.patch"}` and re-lock, or delete the file and correct the CHANGELOG.

### C4 (P2). The postinstall pglite symlink hack is no longer needed

Evidence: `scripts/postinstall-pglite-link.ts` exists because gbrain once reached PGLite's WASM through a repo-relative `node_modules` path. gbrain's `src/core/pglite-embedded-assets.ts` now uses a tiered resolver (at both 939232f and master). Verified: after deleting `node_modules/gbrain/node_modules/@electric-sql/pglite`, `new PGLiteEngine().connect({}); initSchema()` succeeds on both the pinned fresh clone and the master copy ("160 migration(s) applied … connect+schema ok").

Fix: remove the postinstall (keep a one-line smoke `bun -e "await import('gbrain/pglite-engine')"` in CI). Mark as "verified for connect/initSchema; other asset paths (e.g. vector extension bundles) not exhaustively tested".

### C5 (P2). The 94–100 tsc errors: typecheck *is* gated, but only by grep filtering

Evidence: `.github/workflows/ci.yml:33-47` runs `bunx tsc --noEmit` and fails only on lines not starting with `node_modules/`, plus a crash guard (tested in `test/eval/ci-typecheck-filter.test.ts`). At the pin, I get 94 errors, all in `node_modules/gbrain*` (roughly half in each of `gbrain` and `gbrain-reader`, since both ship near-identical sources). Causes:

| Code | Count | Cause |
|---|---|---|
| TS2307 | 34 | Bun text imports `./sample/*.md` in `company-brain/sample.ts`; `@jsquash/avif/*.wasm` |
| TS7016 | 14 | No `@types/js-yaml`, `@types/express`; `heic-decode` untyped |
| TS2304 / TS2552 | 21 | `RequestInfo`, `BodyInit`, `HeadersInit` (DOM lib not in `tsconfig.json` `lib: ["ESNext"]`) |
| TS2339 | 19 | Provider recipe typings (minimax/deepseek) |

`skipLibCheck` does not help because gbrain ships `.ts` sources, not `.d.ts`.

Fix: in `tsconfig.json`, add `"lib": ["ESNext","DOM"]` and `"types": ["bun"]`. Add a `types/ambient.d.ts` with `declare module '*.md' { const s: string; export default s }` and `declare module '*.wasm'`. Add `@types/js-yaml` and `@types/express` as devDependencies. That should drop the count to about 19 (recipe typings), which should be fixed upstream in gbrain. Then remove the grep filter.

The CI comment at `ci.yml:6` says "bun is pinned to the version in package.json engines", but `package.json` has no `engines` field. Fix the comment or add `"engines": {"bun": "1.3.13"}`.

### C6 (P1). Tests and validators that never run

Evidence: `package.json` `"test": "bun test test/eval/"`, and CI runs the same path. These exist and pass, but run nowhere automated (I verified each passes in the pinned scratch copy):

| File | Result |
|---|---|
| `eval/runner/queries/validator.test.ts` | 34 pass |
| `eval/generators/world-html.test.ts` | 16 pass |
| `eval/runner/adapters/grep-only.test.ts` | 11 pass |
| `eval/runner/adapters/vector.test.ts` | 7 pass |
| `eval/runner/eval-adapter-config.test.ts` | 9 pass |
| `test/retrieval_refresh_orchestrator_test.py` (named as `golden_test` in the manifest entry `retrieval-refresh-2026-09-09-summary`) | 25 OK |
| `scripts/verify-published-longmemeval.py` (README's LongMemEval recount) | 0 mismatches |
| `scripts/verify-documentation-refresh.py` (doc links, anchors, protected bytes) | `errors: []` |
| `bun run eval:query:validate` (README tells users to run it) | "All 80 queries valid" |

Why it matters: the manifest names the Python test as golden coverage, yet nothing enforces it. A regression in the validator or adapters would ship silently.

Fix: `"test": "bun test test/eval/ eval/"` (or move the files), plus a CI step `python3 test/retrieval_refresh_orchestrator_test.py && python3 scripts/verify-published-longmemeval.py && python3 scripts/verify-documentation-refresh.py && bun run eval:query:validate`. Total cost under 10 s.

### C7 (P1). Two "hermetic runner" CI steps can't fail on a score regression

Evidence:
- `eval/runner/type-accuracy.ts:508-513`: the only `process.exit(1)` is in `main().catch`. There is no threshold.
- `eval/runner/identity.ts:183`: the same.

The CI log for the main run `36282796771` shows type-accuracy printing "Overall strict F1 (triple match): 48.1%" and a `mentions` row at 0.0% type accuracy, and the step passes. By contrast, before-after, temporal, cat6, adversarial and mcp-contract do gate. The August audit's own lesson ("a printed threshold did not affect the exit code", `docs/audit/2026-08-31-eval-audit.md`) still applies here.

Fix: add floors against a committed baseline (e.g. `baselines/cat2.json`, `baselines/cat3.json`) and exit 1 on regression beyond a tolerance, following `cat6-prose-scale.ts:110-113`'s pattern.

### C8 (P2). The CI budget is nearly exhausted

Evidence: `ci.yml` has `timeout-minutes: 15`, and its comment says "enforces the <10 min budget". The latest main run (`gh run view 36282796771`) took 682 s for the job, of which 589 s was unit tests. PR runs ranged from 7 to 48 minutes of wall time. That is 76% of the timeout, and each release adds slow tests (Cat36, the pilots).

Fix: see C9. Shard `bun test` across a 3–4 job matrix, and fix the comment.

### C9 (P2). Test runtime: where the ~10 minutes go

Full suite at the pin: 685 s wall (same order at master). Per-file isolation run: 104 files, 1925 pass, 973 s summed. This was partly contended; each file also pays about 0.3 s of Bun startup.

- **Concentration:** in the full-suite log, 127 tests longer than 1 s account for **653 of 694 s** (94%) of summed test time. 51 of 104 files take under 2 s each.
- **Root cause:** most slow tests build a fresh in-memory PGLite brain and run the full schema. The log shows "Setting up brain schema (v165)… 160 migration(s) applied" **120 times** in one suite run, each taking several seconds under WASM.

Slowest files (isolated, seconds):

| File | s | Tests |
|---|---:|---|
| test/eval/situation-recall-openrouter.test.ts | 63.8 | 8 |
| test/eval/search-observations.test.ts | 47.5 | 10 |
| test/eval/situation-native-evidence-18-24.test.ts | 41.3 | 12 |
| test/eval/cat13-conceptual.test.ts | 38.6 | 46 |
| test/eval/agent-adapter.test.ts | 38.4 | 25 |
| test/eval/cat14-calibration.test.ts | 34.7 | 18 |
| test/eval/cat28-federated-sync-latency.test.ts | 34.5 | 8 |
| test/eval/situation-recall-regression.test.ts | 32.8 | 75 |
| test/eval/cat13-kacf-calibrate.test.ts | 30.1 | 17 |
| test/eval/cat13-gap-localize.test.ts | 29.5 | 15 |
| test/eval/longmemeval-metrics.test.ts | 27.7 | 53 |
| test/eval/cat18b-embedding-rerank-matrix.test.ts | 26.2 | 6 |
| test/eval/cat13b-source-swamp.test.ts | 25.6 | 18 |

Slowest single tests (full-suite log):

| Test | Time |
|---|---:|
| "a single fallback invalidates the conceptual receipt…" | 44.9 s |
| "cat13 Phase E0 receipt (hermetic) > gbrain arm at voyage:voyage-4…" | 44.3 s |
| "runCat28 hermetic > small run…" | 28.0 s |
| kacf calibration e2e | 20.7 s |
| gap localization e2e | 18.8 s |
| cat13b runner e2e | 14.5 s |
| identity keyword fixtures | 13.7 s |
| C1 construction ceiling | 13.5 s |

Fix, largest win first:
1. Create a pre-migrated PGLite data directory once per process (PGLite `dumpDataDir`/`loadDataDir`, or a cached tarball keyed by gbrain version and schema version) and clone it per test instead of running 160 migrations each time.
2. Split out end-to-end runner tests (`*-e2e`, "hermetic matrix") into a `test:slow` tier that CI runs in parallel shards.
3. Shrink stub corpora in the Cat13 tests. The Phase E0 test runs a full probe set with stub embeddings.

The target is under 3 min per shard.

### C10 (P2). Data validator warns about hash mismatches instead of failing

Evidence: `bun eval/runner/validate-data.ts` prints "⚠ content_sha256 does not match whole-file hash of calendar.ics (per-slice hash?)", and the same for `inbox/emails.jsonl` and `slack/messages.jsonl` (amara-life-v1), yet exits 0 ("all referential-integrity checks passed"). Either the manifest hashes are stale or the hash scheme is undocumented.

Fix: define the hash scheme in the manifest and make mismatches fatal.

### C11 (P2). Stale GitHub state contradicts the repo

Evidence (`gh issue list`, `gh pr list`, `git ls-remote`):

Open issues:
- **#2 / #19** (Cat 2 and Cat 10 `extractPageLinks` drift): both runners pass in CI on main today.
- **#3** (`eval:fetch-multimodal` missing): per `docs/audit/2026-08-31-findings.json:1097`, the phantom references were removed and fixtures committed.
- **#26** (outside verification): items 1, 2 and 5 appear addressed by later work (raw rows committed and manifest-covered; the PMB row is relabeled). Item 4 (movable judge alias) is disclosed, not fixed. Item 3 still stands.

Open PRs:
- **#13, #18:** they carry pre-erratum README numbers (per #26).
- **#7, #11, #17:** API-drift fixes that were superseded.
- **#8:** a draft from May.
- **#32 and #28:** outside contributions with no response.
- **#35:** v0.9.1 provider retirement, CI green since Sep 24 and unmerged.

Remote branches: `phoenix-v1`, `mumbai-v1` and `salvador-v1` hold pre-resolution README tables (per #26).

Fix: close the fixed issues with a pointer to the fixing commit, close or label the superseded PRs, merge or decide #35, respond to #28 and #32, and delete or archive the stale branches (or add a banner commit).

---

## D. TODOS.md review

| Item (line) | Status | Evidence |
|---|---|---|
| "Export a public SkillOpt import path" (`TODOS.md:39`) | **Done upstream; code not updated** | `node_modules/gbrain/package.json` exports `./core/skillopt` → `src/core/skillopt/index.ts`, exporting `runSkillOpt`, `scoreSkillOnTasks` and `loadHeldOut` (present at 939232f and master). But `eval/runner/cat30-skillopt-improvement.ts:56-61` still deep-imports `../../node_modules/gbrain/src/core/skillopt/*.ts` with the comment "gbrain's export map has no skillopt subpath yet". Cat31–33 are the same. |
| "Repeat the embedding-provider matrix" (`:19`) | **Obsolete as written** | The ZeroEntropy sunset date (2026-09-04) has passed, and master removed the zeroentropy recipe (C2). Cat18/18b cells still hard-code `zeroentropyai:zerank-2` / `zembed-1`. Rewrite this as "rebuild the matrix on supported providers (voyage-4, openai-3-large, local)". |
| "Export gbrain's version" (`:41`) | Still open | Master exports only `./pglite-engine`, `./core/skillopt` and `./pglite-lock` among the relevant subpaths; there is no `./version`. |
| "Finish the answer-label stubs" (`:25`) | Still open | The validator still reports 6 single-example stubs. |
| Cat35 human calibration, repeats, held-out transcripts (`:47-51`) | Open and **high leverage** | Directly qualifies a README headline (B5). |
| "Bring Cat35 missing-prerequisite receipts…" (`:35`) | Open; "135 passing tests at v0.47.6.0" is stale context | — |

Missing TODOs that should exist:
- Re-pin gbrain to a master commit or tag, and make the suite pass against master (C1, C2).
- Complete the LongMemEval-M pilot. It is preregistered (Sep 24), 4 of 28 B cases are done, and C0/C1 are not run.
- Complete the Cat36 live capability run. The protocol only is published (Sep 23).
- Run matched-reader QA (gpt-4o and a frontier model; notes-first) (B6).
- Add a vector+rerank concept cell (B2).
- Fix the Cat 2 relationship-fixture link direction for `attended` (B3).
- Run the orphaned tests and validators in CI (C6); add score gates to Cat 2 and Cat 3 (C7).
- Speed up the test suite with a PGLite snapshot and sharding (C9).
- Fix the patch file (C3) and remove the postinstall (C4).

---

## E. Prioritized fix list

1. **P1, docs, same day:** B1 version/pin statements; B2/B3/B4/B5 README framing sentences; B10 PMB row.
2. **P1, infra, 1–2 days:** C1 pin to master or tag with a separate alias for cue work; C2 centralize the pin constant, land #35, fix the default-embedder assertion, gate memory-cues tests; C6 run the orphaned tests and validators in CI; C7 score gates for Cat 2 and Cat 3.
3. **P1, evidence, paid but cheap:**
   - Vector+rerank concept cell (under $1 of Voyage rerank).
   - Cat35 held-out transcripts (about $3).
   - Matched-reader LongMemEval QA with gpt-4o and a frontier reader, notes-first (about $40–80, based on the Sep 25 study's $79 for about 6k calls).
   - Finish the LongMemEval-M pilot.
4. **P2:** C3 patch, C4 postinstall, C5 tsconfig, C8/C9 runtime and sharding, C10 hash validator, C11 GitHub cleanup, B7/B8/B9/B11, TODOS rewrite.
5. **Front page:** a "Where gbrain stands (matched protocols)" table plus a keyless 30-second gbrain demo (B6).

## Appendix: scratch artifacts

All under `audit/scratch-docsinfra/`:

| File | Contents |
|---|---|
| `evals-master/` | Repo copy re-pinned to gbrain master |
| `master-test.log` | Full-suite run at master (21 fail + 1 error) |
| `tsc-master.log` | tsc output at master |
| `evals-pinned/` | Repo copy at the current pin |
| `pinned-timing.tsv` | Per-file timings at the pin |
| `tsc-pinned.log` | tsc output at the pin |
| `fresh/` | Fresh clone + frozen install (patch and postinstall checks) |
| `linkcheck.py`, `ext.json` | Link audit script and external link list |
| `ci-main.log` | GitHub Actions log for main run 36282796771 |
| `readme-quick.log` | README quick-experiment output |
