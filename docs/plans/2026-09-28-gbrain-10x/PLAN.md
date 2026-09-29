<!-- /autoplan restore point: "(restore point, not committed)" -->
## Implementation plan
# gbrain 10x plan: make the memory better, and make gbrain-evals the proof

Date: 2026-09-28. Scope: gbrain (master 0.59.3.0, `6bb88d128`) and gbrain-evals (v0.10.0,
`b439f12`).
Inputs: five audits run on 2026-09-28 (about 200 verified findings), stored with the
plan as `audit/*.md`, plus the list of 60 open gbrain PRs (`audit/gbrain-open-prs.txt`).
Review: gstack /autoplan ran on 2026-09-28 (CEO, DX and eng phases; design skipped
because the plan has no UI). Every change it made, and why, is in the Review record at
the end of this file.


## Amendments from the independent cross-model review (accepted; they override conflicting text below)

An independent reviewer from a different model family (GPT-6 Astra) read this plan after autoplan. The full review is in `outside-review.md`. All ten of its amendments are accepted. Where the text below disagrees, this section wins.

1. **Holdout honesty.** Data we have already inspected cannot become a holdout by re-splitting it. That covers the LongMemEval-S 470 answerable questions, whose configuration was chosen on all of them, and the Cat13 held-out concepts, which were reused to pick defaults. All of it is relabeled development/regression data, and §4 item 9's 94/376 split is withdrawn. Before any further tuning, we freeze a separately authored, access-controlled confirmation set, split by source history, entity or concept. It is used only at preregistered release decisions, with an access and selection log. LongMemEval-M is a distractor/scale stress test, not an independent confirmation: all 28 pilot ids also appear in S.
2. **A falsifiable 10x.** "10x" attaches to one preregistered outcome: a tenfold reduction in end-to-end failures on a fixed set of memory-dependent agent tasks, compared with a frozen previous release, within fixed latency, token and cost limits, and with no violation of the critical safety contracts. We publish the measured factor whatever it is, and "inconclusive" is an allowed result. The scoreboards in §2 become supporting dashboards: task quality, lifecycle safety (hard constraints), efficiency, and evidence maturity (regression-only, synthetic production-path, independently labeled held-out, or externally replicated). Their numeric targets stay as named stretch goals. The strict LongMemEval-S metric stays unchanged even though three questions need six sessions and can never pass strict all-hit@5; a feasible-subset diagnostic is reported separately.
3. **Fusion is an experiment, not a promised win.** Page-grain fusion alone is measured against unchanged ranking, with corrected evaluation on both arms. Data, embeddings, candidate budgets, output units and reranker treatment are held fixed. We record selected chunk ids, strict session hits, evidence-span recall within the returned tokens, and downstream answers. The full G1 wave is measured separately. Existing qrels and gate thresholds stay immutable during the comparison, and any baseline migration is approved on its own. "Mechanically correct but flat" is a publishable result. (The G1 task was told this on 2026-09-28.)
4. **Real statistics.** `gbrain eval compare` prints aggregate metrics and only claims to bootstrap. Reuse the cluster bootstrap / sign-swap plus Holm code in gbrain-evals `situation-recall-regression.ts` and add proper paired, clustered intervals with a preregistered family of comparisons. There are three separate gates:
   - exact correctness and safety assertions fail immediately, and significance is never needed to fail them;
   - noisy quality metrics use a non-inferiority test with a stated tolerance;
   - exploratory dashboards gate nothing.
5. **Match the whole comparison.** A shared reader and judge is necessary but not enough. Two experiments are published separately:
   - a component ablation with the same reader, prompt, evidence budget and index;
   - a whole-system accuracy / cost / latency frontier under equal resource caps.

   Report the tokens actually delivered to the model (full sessions, not five snippets), memory build tokens, storage, indexing time, cold/warm p50/p95 and provider failures. Include strong lexical, vector-plus-reranker and single-shot RAG baselines. An external harness run counts as "independently specified", not "independently operated".
6. **Independent evaluator.** Ingestion and product invocation are shared, but gbrain-evals keeps its own reference scorer and a gold store the product cannot reach. The leak check is an input allowlist, not a search for the substring `answer_`. Receipts save replayable prompts, answers and judgments (where licensing allows) and the executed source-tree hash, including dirty files. `verify` states which check it did: artifact integrity, deterministic recount, or semantic rejudging.
7. **Grounding goes first.** Synthesis currently strips the quotation marks from an unverified quote and keeps the text as ordinary prose (`synthesize-verify.ts:441-444`, reproduced by the reviewer). Unsupported derived claims are to be quarantined or marked unverified, excluded from authoritative recall, and tracked by claim-to-source-span and speaker provenance. This work joins the first product milestone, and a repeated-consolidation experiment (invented claims, lost valid facts, wrong attribution) runs before any large paid hallucination benchmark.
8. **Production lifecycle matrix.** N14, N5 and N6 grow into an end-to-end lifecycle: ingest → query → correct → reconcile → forget → restart → query. Critical cases run on both engines (PGLite and Postgres) and through local CLI, stdio and HTTP, including a new harness session. The matrix injects:
   - provider outages and interruption between the DB, file and projection steps;
   - duplicate delivery, concurrent edit/sync/forget, and stale checkpoint replay;
   - migration and full backup/restore;
   - grant revocation, and same-slug data across sources.

   A zero on the 200-edit fuzzer is a regression result, not a reliability rate.
9. **Category semantics first.** Each new category writes its semantic contract before anything is built.
   - A4 scores CRAG calibration separately from actual answer abstention, using risk-coverage curves.
   - N3 uses an independent temporal ledger with explicit as-of semantics.
   - N5 specifies withdrawal identity, authority and reinstatement, and treats semantically close retained claims as hard negatives.
   - N4 reports fragmentation and unresolved rates next to wrong merges, so that refusing everything cannot win.
   - Solvability controls are reported, never used to delete items.
10. **A smaller first milestone.** It contains five things:
    - urgent safety fixes (Phase 0);
    - measurement and claim repair;
    - one controlled retrieval experiment (item 3);
    - one end-to-end memory-lifecycle experiment, current release vs fixed (item 8);
    - a cheap, genuinely independent confirmation pilot, together with a clean small matched study (reader vs plain RAG vs production think) that tests whether complete evidence turns into correct answers.

    Deferred until that milestone reports: broad category renumbering, the `category:new` scaffold, release dispatch and automatic receipt PRs, the every-release scorecard, full code intelligence, the frontier-reader showcase, and the 10M-token sweep. Keep `--why` miss traces now. The $500 cap is enforced by a durable reservation ledger checked before every paid request, including retries and write-side work, with costs estimated from a measured cold-cache pilot. Human calibration is blinded, stratified and adjudicated, and its time budget is sized from the actual label counts.

**Revised build order (replaces §11 where they conflict).**

| Order | Work | Exit condition |
|---|---|---|
| Now | Phase 0 fix wave; retract or qualify misleading claims; preserve old code, data and receipts | Each safety repro fails on the old version and passes on the fix |
| Before any new quality claim | Leak and scoring fixes on both arms; evaluator-side scorer; paired comparator with clustered intervals; freeze the sealed confirmation set | Deliberately broken adapters fail; no gold reaches the system |
| First bounded experiments | Fusion-only vs unchanged; full-wave regression; clean reader / plain-RAG / think pilot; lifecycle run, current vs fixed | Gains, losses, errors, contexts and costs published, win or not |
| Next product work | Grounding/provenance, crash/retry durability, withdrawal, remote lifecycle, temporal and abstention contracts; then chase the largest measured error class | Task success improves with no safety or resource regression |
| Independent confirmation | Sealed-set release decision; one outside-protocol pilot (AMB or matched QA); fresh transcript and lifecycle tasks | Matched and held-out evidence agree, or the gap is investigated |
| After that | Remaining new categories, publication automation, LongMemEval-M/BEAM scale, HaluMem | Automation publishes sound evidence |



**Status update, 2026-09-29.** Phase 0 shipped as five PRs:
- gbrain #5668 (merged, v0.59.11.0);
- gbrain #5666 (v0.59.12.0);
- gbrain #5676 (v0.59.13.0);
- gbrain-evals #37 and #38.

The isolated fusion experiment (amendment 3) came out flat. On the `halfA430` LongMemEval-S split (215 questions, reranker off, shared embeddings), page-grain fusion scored 202/215 against master's 203/215: +0/−1, exact McNemar p = 1.0. It fixes a reproduced ranking defect but is not a measured retrieval win, and it does not explain hybrid trailing vector-only on LongMemEval. The next suspects, per §4 item 0, are the strict-AND keyword arm and expansion weighting. Cat13 still needs its own before/after. Scoreboard 0 stays at zero measured wins.

## 1. Where we are today (evidence, not vibes)

**gbrain has real strengths.** Strict LongMemEval-S retrieval is 449/470 (95.53%)
`recall_all@5`, the best strict, LLM-free retrieval number we know of. Our strict
recomputations of other systems' saved rankings range from 84% to 90%. gbrain also
ships roughly 67 capabilities (hybrid search, typed graph, takes, facts, withdrawal,
temporal ops, open loops, proactive recall, code intelligence, and more).

Two caveats travel with the 95.53%: the configuration was chosen on the same 470
questions (there is no held-out confirmation), and the number came from gbrain's own
harness at gbrain `2efaaf8f`, not from the evals repo's runner.

**But the proof covers a small corner of the product, and some of it is wrong.**

- About 17 of those ~67 capabilities have solid public evidence. About 30 have none.
  gbrain's clearest differentiators have zero coverage: contradictions, knowledge
  update, native temporal queries, the real entity resolver, forgetting, private
  visibility, open loops and code intelligence.
- Five published eval numbers are wrong or unproven:
  - LongMemEval answer accuracy (433/500): the answer model could see gold labels
    (`answer_` session ids).
  - Cat14 calibration (75% wins): the judge saw the expected answers.
  - Cat3 undocumented alias recall: 31% should be 13.75%.
  - Cat1 P@5: 39→45% should be 30→35%.
  - Cat35 distillation: 88.1% is judge-only; the evidence-verified score is 74.9%.
- Three README comparisons are favorable by construction. The concept claim compares
  gbrain with a reranker (130/181) against vector search without one (118/181);
  without the reranker gbrain scores 102/181. The relationship claim quotes only the
  best template (overall first-place hits went 14% → 24%). Cat35's 88.1% is in-sample
  after tuning on the same 24 sessions.
- gbrain's own README still quotes a relationship headline (P@5 49.1%, "+31.4
  points") that the evals repo retired on Sep 9.
- The "published" sweep (`all.ts`) runs 15 of about 40 categories. It includes none
  of the headline benchmarks, and some of its gates always pass or can never pass.
- There are two LongMemEval harnesses: gbrain's `src/eval/longmemeval/` (which
  produced the headlines) and the evals repo's `eval/runner/longmemeval.ts` (a second
  implementation with its own rendering, reset and scoring). No parity test exists,
  so a fix in one copy does not reach the other.
- The evals repo pins a gbrain commit that is not on master, so it cannot benchmark
  the product users install. Re-pinning to master breaks about 20 tests today.

**gbrain itself has quality ceilings and data-loss bugs the evals never caught.**

- Hybrid fusion keys on chunks while each arm votes for pages, so keyword and vector
  agreement gets split instead of added. This is the likely cause of the recorded
  "hybrid loses to vector-only" results. Every published hybrid number carries it.
- The reranker's order gets thrown away after the alias tier.
- "Who is X" queries hide timeline content.
- Trajectories report a stale "latest" value.
- On the write path: identity is guessed instead of recorded, derived data only ever
  grows, retry state is mixed up with content state, operations succeed silently
  when they did nothing, and dates depend on the host timezone. Seven P0s were
  reproduced (moved files deleted, renamed chats losing messages, `forget` wiping
  other people's facts and the whole source index, and others).

**The work is crowded.** gbrain has 60 open PRs, and at least ten touch the same code
as Phase 0 (overlap table in §3).

## 2. What "10x" means (measurable)

We define 10x as five scoreboards. Every number comes from a dated receipt at a
single gbrain SHA. Scoreboard 0 comes first because it is the one users feel.

0. **Measured wins.** The count of gbrain changes that shipped with a matched
   before/after receipt showing a gain on a named category, with its losses listed
   next to it. Target: the first (page-grain fusion) in week 1, at least 8 by week 8.
   A change with no measured gain is reported as "no demonstrated benefit", never as
   a win.
1. **Proof coverage 10x.** Every shipped capability either has a category or is
   explicitly labeled "not measured". Capabilities with solid public evidence go
   from about 17 to 55 or more, and zero-coverage capabilities go from about 30 to 0.
   The capability inventory lives in the category registry, so these counts are
   computed, not hand-typed.
2. **Failures on the things we already measure: 10x fewer where the ceiling allows.**
   Targets, not predictions:
   - LongMemEval-S strict misses: re-baseline first (page-grain fusion changes the
     449/470 number), then 21/470 → 5 or fewer, judged only on the held-out slice
     frozen in §4 item 9 (at most 4 misses on its 376 questions) and confirmed on
     LongMemEval-M. Tuning on the full 470 does not count.
   - Concept-search top-1 misses (Cat13): 51/181 → 20 or fewer, with hybrid at
     least matching vector-only in both the no-reranker and the reranker arms.
   - Write-path invariant violations under a seeded 200-commit edit fuzzer:
     measured in Phase 1 (expected to be hundreds) → 0.
   - Collateral damage from `forget`: → 0.
3. **Neutral comparisons.** gbrain appears in at least three third-party or matched
   comparisons: Agent Memory Benchmark (AMB) results produced with its fixed
   prompts, a matched gpt-4o reader/judge LongMemEval QA arm, and HaluMem. It also
   has a scale track (LongMemEval-M, BEAM 1M/10M) with an accuracy × tokens ×
   latency frontier.
4. **Trust.** Every headline is reproducible from one command. Every paid category
   has a solvability check, a negative control and a cost/latency receipt. Every
   LLM-judged headline has a 50-item human calibration sample. Every headline states
   the set its configuration was chosen on and whether a held-out check exists.

## 3. Phase 0: fix wave (in flight today)

Five parallel fixes, each shipped as its own PR. Version numbers are not fixed in
advance: each PR takes the next free patch version when it ships, per the
release-renumbering rule in CLAUDE.md and AGENTS.md.

| PR | Repo | What it fixes |
|---|---|---|
| G1 read path | gbrain | page-grain fusion (P0), reranker order, soft entity-intent filter, newest-first trajectories, reranker-failure visibility, title-in-query boost, filter parity, multimodal column, eval vector baseline, NamedThingBench error counting, dedup order, distinct backlinks, private tags; opaque LongMemEval ids; retire the stale P@5 49.1% README claim; patch-release rule in CLAUDE.md and AGENTS.md. Page-grain fusion changes the ranking default for every user, so the PR carries the matched before/after receipts from §4 item 0 before it merges, and regenerates the `gbrain eval gate` baselines (`test/fixtures/eval-baselines/`) in the same PR under the regression contract in §15. |
| G2 identity | gbrain | frontmatter-id dedup (moved files, shared ids), slug collisions, text-before-embedding, image retry, link/timeline replace-on-sync, strict entity resolution, rename aliases, timezone-stable dates |
| G3 memory ops | gbrain | subject-scoped non-destructive `forget`, poison-page isolation in `extract_facts`, synthesis never overwriting human pages, phantom redirect safety, connector checkpoints per source and per item, durable synthesis "done" state |
| E1 integrity | evals | opaque LongMemEval ids, honest `all.ts` (receipts required, real gates, tiers), scorer fixes (type spam, nDCG ≤ 1, Cat29, aggregator), template-leak removal, determinism, judge hardening |
| E2 claims + CI | evals | dated errata for the five numbers, honest README framing (reranker-matched concept claim, overall relationship numbers, in-sample labels) plus a "Where gbrain stands" section, pin-claim fixes, CI running every test, validator and tsc unfiltered, dead infra removed, suite under 4 minutes |

**Overlap check before building.** These open gbrain PRs touch the same code. Resolve
each row before the matching Phase 0 PR starts; a PR that merges first becomes the
base, and one that stalls gets absorbed with credit.

| Open PR | Overlaps | Action |
|---|---|---|
| #5649 preserve exact recorded identities on sync | G2 (A1, A2) | Review first; G2 builds on it or absorbs it |
| #5648 preserve pages when deleting unowned files | G2 (A1 reconcile delete) | Same |
| #5624 collapse hyphen runs in `normalizeBasename` | G2 slug collisions (A3) | Same |
| #5562 dated wiki headings as timeline entries | G2 timeline replace (A5) | Rebase G2's timeline work on it |
| #5651 scope withdrawal invalidation | G3 `forget` (B2) | Review first; G3 builds on it or absorbs it |
| #5658 preserve memory across maintenance operations | G3 (C2, C3, C12) | Diff its finding list against G3 before starting |
| #5652, #5653, #5654, #5655 search dedup, fusion, rescore, titles perf | G1 fusion and dedup (read-path #1, #11); Phase 4 item 7 | G1 lands page-grain fusion first; the perf PRs rebase and must show no ranking change on qrels |
| #5656 keyword strict/OR fallback | Phase 4 item 4 | Measure it as the first step of item 4 |
| #5640 relational arm spans every source | read path; N6 | Add the relational arm to N6's op matrix |
| #5639 `take_contradictions` dream phase | Phase 4 item 14; N2 | N2 measures it; item 14 builds on it |

Acceptance: all five PRs green in CI, each finding marked fixed, covered by an open
PR, or deferred with a reason, and every overlap row resolved.

## 4. Phase 1: evaluation foundation (weeks 1-2)

The goal is that one command reproduces every headline, and that gbrain's CI can
tell when a change makes memory worse.

0. **First measured win (days 1-3).** Before the registry work, measure page-grain
   fusion (G1) as a matched before/after at one gbrain SHA pair on Cat13 (adding a
   vector + reranker cell so the reranker comparison is matched), LongMemEval-S
   retrieval and NamedThingBench. Publish it as the first receipt in the v2 format
   (item 4). If hybrid still trails vector-only, test the next suspects in order:
   the strict-AND keyword arm (Phase 4 item 4), then expansion weighting (item 5).
1. **Pin to master, then to releases.** Move `memory-cues` experiments to a
   `gbrain-cues` package alias pinned to `capy/situation-aware-recall` (it exists
   only there). Ship `memory-cues` to gbrain master only after its preregistered
   pilot shows a measured gain. Remove the dead-provider reranker cells (subsuming
   evals PR #35), replace the removed `__setSunsetClockForTests` hook, and
   regenerate frozen package identities. Fix the `attended` link-direction mismatch
   in the relationship fixture (fixture says meeting → person, the parser expects
   person → meeting). Re-baseline Cats 1, 2 and 6 as new dated measurements. After
   that, the pin tracks gbrain releases.
2. **One LongMemEval harness.** gbrain exports only `./eval/longmemeval/reader`
   today; the harness entry (`runEvalLongMemEval(args: string[])` in
   `src/commands/eval-longmemeval.ts`) is a CLI function. Add a gbrain package
   export `./eval/longmemeval` with a typed `runLongMemEval(options)` that returns
   per-question rows in a stable NDJSON schema. Make `eval/runner/longmemeval.ts` a
   thin wrapper over it and delete the duplicated rendering, reset and scoring
   code. A 25-question parity test asserts identical `retrieved_session_ids` from
   the CLI and the wrapper. Opaque ids are then fixed once, in gbrain.
3. **Category registry.** Add `eval/registry.ts` recording ID, family, tier (H =
   hermetic/CI, K = keyed under $1, P = paid publication), script, cost estimate,
   receipt path, headline metric, minimum gbrain version, gate status (report-only
   or gate), CI time budget in seconds, the old Cat number as an alias, the
   capability ids it covers, the gbrain source paths it exercises (globs used for
   diff-aware selection), and a regression tolerance per headline metric.
   `all.ts` reads it. `--tier H` becomes the CI gate and `--tier P` the true
   publication sweep. Every category declares what it proves,
   its denominator, its tuning set and its held-out set. A test fails when a runner
   file under `eval/runner/` is neither registered nor listed as a helper.
4. **Receipts v2.** Extend the existing `eval/runner/receipt.ts` (schema v1 already
   records run status, verdict, failure origin, errors, `publishable`, gbrain
   version and pin, resolved config and judge provenance). v2 adds:
   - the gbrain SHA, and the SHA of the gbrain code actually loaded;
   - cost (USD, tokens), p50/p95 latency and `returned_tokens` counted with
     `@dqbd/tiktoken` (already a gbrain dependency) under a pinned encoding that the
     receipt names;
   - an error count kept separate from misses;
   - a solvability check (oracle-memory run passes, no-memory run fails);
   - a negative control, with a presence assertion so an empty system can't pass;
   - a judge prompt version and temperature 0;
   - the configuration-selection set (`tuned_on`) and whether the scored set is
     held out.
   The aggregate refuses to mix gbrain SHAs unless `--allow-mixed-sha` is passed,
   `publishable` requires a completed run, and duplicate probe ids fail the run
   instead of being merged silently.
5. **Scorecard page, regenerated on every gbrain release.** A generated
   `docs/SCORECARD.md` shows one headline per family, today's value, the target, the
   receipt link and the receipt's age. The README links to it. Numbers are never
   hand-typed. When gbrain tags a release, its release workflow sends a
   `repository_dispatch` to gbrain-evals (a fine-grained token scoped to that one
   repository). gbrain-evals runs the H and K tiers against that SHA and opens a PR
   with the dated receipts and regenerated docs. The PR is labeled ready when
   `bun run verify` passes and no headline drops beyond its registry tolerance, and
   flagged when a headline drops. A human merges every receipt PR (no auto-merge);
   a loss is still published. The nightly and
   release workflows share one concurrency group so they never write receipts at the
   same time.
6. **gbrain CI hook.** Build on what gbrain already has: `gbrain eval gate`
   (fail-closed regression and correctness gate) and the nightly cron in
   `.github/workflows/e2e.yml`. gbrain PRs that touch `src/core/search`,
   `import-file`, `facts`, `cycle` or `connectors` run the gbrain-evals hermetic tier
   against the PR head (diff-aware), with gbrain-evals pinned to a specific commit so
   an evals change cannot break unrelated gbrain PRs. This job needs no secrets, so
   fork PRs run it too. A nightly job runs the hermetic tier plus a small keyed tier
   against gbrain master with a per-run spend cap, and opens one issue per regressed
   category and metric (updated, not duplicated, on repeat) with the receipt diff
   attached. A regression means a paired test at p < 0.05 (McNemar for per-question
   pass/fail, paired bootstrap from `gbrain eval compare` for continuous metrics)
   and a drop larger than the registry tolerance, so provider noise does not open
   issues.
7. **Brain invariants: `gbrain doctor --invariants`.** Do not call it "integrity":
   `gbrain integrity` already exists and repairs citations. It extends the existing
   doctor checks (`child_table_orphans`, `dangling_aliases`, `embed_staleness`,
   `content_hash_duplicates`, `effective_date_health`) with the missing invariants:
   - every file maps to one page;
   - DB links match the links derivable from the text, and the same for the
     timeline;
   - chunks cover the body and embedding hashes match;
   - no active fact belongs to a deleted page;
   - no withdrawn claim appears active.
   It is read-only by default, prints a count per invariant (`--json` for machines),
   and is shared by the evals and by users checking their own brains. On brains
   above 20,000 pages the derivable-links and timeline checks run on a seeded
   sample unless `--full` is passed; `--source` limits the scan, and the output
   states the sample size. These checks prove the database agrees with gbrain's own
   extraction of the current files (sync drift). They do not prove the extraction is
   right; N14's generator ledger is the correctness ground truth.
8. **Measure the write path today.** Run the seeded 200-commit edit fuzzer against
   master with item 7 and publish the violation count as a dated baseline, so
   scoreboard 2 has a real starting number before G2 and G3 land.
9. **Held-out discipline.** Freeze a seeded split of the 470 answerable
   LongMemEval-S questions into a 94-question tuning slice and a 376-question
   held-out slice, stratified by question type (the 30 abstention questions are
   scored separately by A4), before any Phase 4 tuning; tuning decisions use only
   the tuning slice. `docs/TUNING_LOG.md` records each configuration choice, the
   set it was chosen on and the date. The registry
   carries the same split for every headline category.
10. **Keyless demo and offline verification.** Two commands in gbrain-evals, neither
    needing an API key:
    - `bun run verify` recomputes every number on the README and scorecard from the
      committed raw receipts, checks the manifest hashes, and prints one line per
      headline with the gbrain SHA that produced it. Under 30 seconds. It regenerates
      the generated docs in memory with the same publish module that writes them and
      fails on any difference, then runs the verifiers that already exist
      (`scripts/verify-published-longmemeval.py`,
      `scripts/verify-documentation-refresh.py`, the manifest hash check). CI runs it
      on every PR.
    - `bun run demo` runs gbrain hybrid vs BM25 vs vector (hash embeddings) on
      world-v1 in under 60 seconds. It prints a table labeled "plumbing check, not a
      quality result" and the one command that runs the keyed version.
    Both start with a preflight that checks the Bun version and the installed gbrain
    pin, and prints the fix when either is wrong. §14 has the full journey.
11. **Paid-run guard.** Every paid runner prints a cost estimate before spending and
    refuses to start without `--budget-usd`. A generated `docs/SPEND.md` totals
    receipt costs against the §9 cap.
12. **Port gbrain's in-repo evals.** Wrap NamedThingBench, whoknows, the
    conversation parser, chronicle, trajectory and takes-quality suites through the
    Cat34 subprocess contract, one registry entry each.

## 5. Phase 2: new categories that prove shipped-but-untested capabilities (weeks 1-3)

The taxonomy: 9 families with stable IDs, with old Cat numbers kept as aliases.
R retrieval, W write path and graph, T knowledge over time, A answering, I agent
integration, S trust and forgetting, O operations, K skills, M modalities.

Merges and retirements:
- Cat1 moves into R5 relational.
- Cats 2, 6 and 10 merge into W1 link extraction, which adds a gazetteer/NER arm.
- Cats 13b, 26 and 27 become one R6 ranking-ablation harness with a paired-delta
  scorer.
- Cats 18, 18b and 21 are relabeled R7 provider guidance.
- Cat4 becomes a storage unit check.
- Cat3 is renamed alias keyword recall.
- Cats 5, 8 and 9 are made runnable or retired.

New categories, in build order. Every one gets its gold from generator ledgers or
external labels, never from gbrain output. Each is expected to find gbrain bugs;
fixes flow back into gbrain PRs. Before a category is built, its registry PR carries
a one-page spec: metric, denominator, gold source, controls, tier and CI time budget.

| ID | Category | Proves | Data | Headline metric | Tier / cost |
|---|---|---|---|---|---|
| N3 (T) | Temporal & as-of | chronicle ops, date bounds, effective date, as-of state, think temporal window | seeded event ledger; LME temporal subset | as-of accuracy, range set-F1, last-seen MAE (days) | H, $0 |
| N4 (W) | Entity resolution | resolver cascade, save-time resolution, exact-lookup floor, cross-source identity, ambiguity refusal | world-v1 people/companies with nickname, typo, handle and namesake variants | B³ F1 plus wrong-merge rate (reported separately) | H, $0 |
| N6 (S) | Visibility & access leak fuzz | private pages unreachable remotely across every read op; grants and scopes compose | ops auto-enumerated from `operations` × caller × scope | leaks = 0 with presence controls; op coverage % | H, $0 |
| N12 (W/M) | Ingestion format fidelity | every transcript/meeting format keeps speakers, times, turns and attendance | Cat35 canonical turns rendered into each format, plus parser fixtures | speaker accuracy, timestamp EM, attended-vs-mentioned F1 | H, $0 |
| N14 (W) | Vault churn & edit-stream fidelity | identity survives moves, renames and collisions; derived data tracks edits | scripted git histories plus a 200-commit fuzzer, checked with `gbrain doctor --invariants` | bijection violations = 0, edge/timeline P/R = 1.0 | H, $0 |
| N1 (T) | Knowledge update & supersession | the current value wins, history is kept, reverts work | planted value changes on amara-life-v1; LME knowledge-update subset | current-value accuracy, stale-served rate | H + K, <$2 |
| N2 (T) | Contradiction surfacing | detects real conflicts and doesn't flag holder disagreement or dated change | contradictions gold scaled to 150 plus 100 hard negatives; WikiContradict; optional MemoryAgentBench conflict-resolution subset | pair P/R, false-contradiction rate | K, ~$3 |
| N5 (S) | Forgetting residue | `forget` removes a claim from every derived tier and resists reimport, with no collateral damage | 100 canaries propagated through the dream cycle, 50 forgotten; optional MemoryAgentBench selective-forgetting subset | residue per tier = 0, collateral = 0, retained recall | H, $0 (live ~$1) |
| N7 (T/I) | Open loops | "who is waiting on me" detection, closure, due dates | amara-life-v1 inbox/slack/calendar plus planted commitments | loop P/R, closure accuracy, `waiting` nDCG | H + K, ~$1 |
| N8 (I) | Proactive recall (merges Cat36 + Cat34 push) | the brain volunteers the right memory without being asked, with low false alarms | associative-recall-v1 (480 probes) plus a TriggerBench-style set | proactive recall vs false-alarm rate, tokens/turn | H, $0 |
| N9 (R/A) | Multi-hop with held-out wording | graph retrieval helps beyond parser templates | world-v1 chains plus a frozen paraphrase grammar; HotpotQA/2Wiki/MuSiQue samples | strict supporting-fact all-hit@k, template vs paraphrase delta | K, ~$6 |
| N13 (M) | Code intelligence | `code_def`, `code_refs`, `code_callers`, `code_blast`, two-pass structural search | pinned OSS TS and Python repos with SCIP gold | def top-1, refs P/R, blast recall | H, $0 (+$1) |
| A4 | Abstention | CRAG gate says "I don't know" on unanswerable questions | LME `_abs`, synthetic negatives | abstain precision/recall | H, $0 |

## 6. Phase 3: external credibility (weeks 2-5)

1. **Re-run LongMemEval QA with opaque ids** (house reader, notes-first), plus a
   matched arm with a gpt-4o reader, a gpt-4o judge and the official prompts, plus a
   frontier-reader arm for comparison with the 90%+ self-reported rows. This replaces
   the suspect 433/500 and makes QA comparable to published gpt-4o rows. About $30
   for the matched arm, about $30 for the frontier arm.
2. **AMB results.** Implement AMB's provider interface (`ingest`, `retrieve`,
   optional `direct_answer`) and run LongMemEval-S, LoCoMo, PersonaMem, LifeBench and
   BEAM under AMB's fixed prompts. Publish the receipts in gbrain-evals. AMB already
   lists a plain hybrid-search baseline at 74.0% on LME-S, so gbrain's delta becomes
   visible in a neutral place. AMB's harness generates and judges with its own fixed
   model (a Gemini key is required), so that cost is part of the estimate. Start
   with AMB's `--oracle` mode (a solvability check) and a `--query-limit 20` smoke
   per dataset before full runs. Submitting to AMB's public leaderboard is a one-way
   step: it happens after a human reviews the results and says go. About $20-60.
3. **Scale track (N10).** Full LongMemEval-M (500 questions, about 1.5M tokens each)
   and BEAM 1M/10M, with an accuracy × tokens × latency frontier across gbrain
   modes. Compute costs from unique-session token counts before running. Estimate
   $50-150.
4. **HaluMem adapter (N11).** Covers extraction, update and memory hallucination on
   a benchmark where three competing memory systems publish per-stage numbers and a
   fourth cannot be scored on extraction at all. Measure one user first. Estimate
   $15-40.
5. **LoCoMo, on the audited answer key only,** at k ≤ 10 with session counts
   disclosed.
6. **Human calibration.** 50 human-labeled items for each LLM-judged headline (Cat35
   first: 24 pairs, about 45 minutes, already prepared).
7. **Cat35 held-out transcripts.** Generate a fresh held-out transcript set and
   score the current distiller on it, so the 74.9% evidence-verified number has an
   out-of-sample companion. About $3.

## 7. Phase 4: make gbrain 10x better, driven by the new evals (weeks 2-8)

Each item names the category that must move. Nothing ships as a ranking default
without a matched before/after receipt, and tuning uses only tuning slices (§4
item 9).

**Retrieval (R family, LongMemEval, Cat13, N9)**
1. Page-grain fusion (Phase 0), then re-run Cat13 and LME. Expect hybrid ≥ vector.
2. Query-side entity linking: a title or alias named inside the query gets a bounded
   boost, or its page is injected.
3. Give the reranker title + heading + chunk; keep its order through all tiers.
4. BM25-style keyword arm: an OR query with normalized rank, titles and headings in
   the tsvector, and graded weight instead of dropping relaxed rows. Helps keyless
   installs too. Start by measuring open PR #5656.
5. Balanced expansion fusion (variant budget 1.0, keyword arm on variants).
6. Fusion weights calibrated on captured queries; source boosts become opt-in per
   brain instead of hardcoded vault paths. Captured queries are real user queries:
   calibration runs on the owner's machine, and only the learned weights and a
   synthetic replay set are committed, never the queries. A CI check fails when a
   committed file under the calibration output path contains raw query text.
7. Latency pass: parallel query embedding, one enrichment CTE, one config load per
   request. Target about 7 round-trips per query instead of about 19.
8. Think evidence upgrade: hydrate graph neighbors as evidence and make round 2
   gap-driven (proved by N9 and Cat29 at n ≥ 60).

**Write path (W and S families, N14, N5, N1, N2)**
9. A recorded `page_identity` table: a move is never a skip or a delete. G2 fixes
   the frontmatter-id skip tactically; this item replaces the guess with a recorded
   identity. gbrain migrations are forward-only, so the migration only adds a table
   (backfilled from current pages) and drops nothing; code tolerates the table
   being empty, so reverting the code is the rollback.
10. Replace semantics for every derived projection (links, timeline, tags, atoms,
    takes) per origin page in one transaction, generalizing the existing
    `replaceDerivedLinks`.
11. Text persists first; embedding and OCR are queued, retried and reuse vectors for
    unchanged chunks (a one-line edit stops re-embedding the whole page).
12. Subject-scoped, paraphrase-aware withdrawal that swaps chunks instead of
    deleting them.
13. Idempotent dream: an existence and authorship check before every synthesized
    write, a durable done-state and a hard USD gate.
14. A contradiction-resolution flow that uses the takes-vs-facts distinction:
    holders may disagree, dated changes are updates, and only true same-time
    conflicts are contradictions. Builds on open PR #5639.

**Knowledge over time and agent behavior (T and I families)**
15. As-of queries in think and search (N3), newest-first trajectories with a
    truncation flag.
16. Proactive recall threshold tuned on N8's recall-vs-false-alarm curve.

## 8. Phase 5: publish the case (continuous)

- The README opens with "Where gbrain stands": the scorecard, the matched
  comparisons and the losses, all linked to receipts.
- Every release note that touches retrieval or the write path links its
  before/after receipt; the release workflow in §4 item 5 adds the scorecard link
  automatically.
- `docs/plans/` keeps this plan and its review record; research postmortems go in
  gbrain `docs/`.

## 9. Decisions and budget (resolved 2026-09-28)

- **Paid-run budget for Phases 3-4:** a cap of $500 in total, spent through the
  paid-run guard (§4 item 11). Any single run estimated above $50 names its
  estimate in the PR or issue that starts it.
- **AMB:** build the adapter and publish results in gbrain-evals, losses included.
  The public leaderboard submission waits for a human go after the results exist.
- **`memory-cues`:** side package alias now; master only after a measured gain.
- **Nightly regression automation:** on, opening deduplicated issues.
- **Human calibration labeling:** needs a person, about 45 minutes for Cat35 and
  about 2 hours in total. Scheduled in week 3.

## 10. Risks

- **New categories will expose bugs faster than we can fix them.** Mitigation:
  hermetic categories land as report-only first and become gates once the gbrain
  fix lands. The registry's gate-status field makes the switch one line.
- **Fusion changes can shift published numbers.** Mitigation: matched before/after
  on LME, Cat13 and NamedThingBench before any default flips, and historical numbers
  are kept.
- **gbrain has 60 open PRs touching the same areas.** Mitigation: the overlap table
  in §3; small PRs; auto-renumber versions.
- **Benchmark overfitting.** Mitigation: the frozen tuning/held-out split, a tuning
  log, paraphrase grammars, solvability checks and external datasets for every
  headline.
- **CI time.** The evals suite already uses 682 s of a 900 s budget. Mitigation:
  per-category time budgets in the registry, a pre-migrated PGLite snapshot, and
  sharding.
- **Cross-repo coupling.** A gbrain PR could fail because of an evals change.
  Mitigation: gbrain CI pins a gbrain-evals commit and bumps it deliberately.
- **Private data leaking into public artifacts.** Mitigation: generated corpora
  only, captured queries never committed, machine-local paths scrubbed from
  receipts.

## 11. Build order and exit gates

| Week | Work | Exit gate |
|---|---|---|
| 1 | Phase 0 PRs; overlap rows; first measured win (§4 item 0); `memory-cues` alias and re-pin; one LME harness | Five PRs green; fusion before/after receipt published; evals suite green on master pin; parity test passing |
| 1-2 | Registry, receipts v2, invariants, write-path baseline, held-out split, `bun run verify` and keyless demo, paid-run guard | `all.ts --tier H` reads the registry; baseline violation count published; split frozen and committed |
| 2 | Scorecard + release workflow; gbrain CI hook; in-repo eval ports; N3, N4, N6, N12, N14 (report-only) | First generated scorecard; gbrain PR job runs H tier; five new categories have receipts |
| 2-3 | N1, N2, N5, N7, N8, A4; human calibration | Each category has solvability, negative and presence controls |
| 2-5 | Phase 3 external runs; N9, N13 | Matched QA arm, AMB results, one HaluMem user, first scale-track frontier |
| 2-8 | Phase 4 product items, each tied to a category | Scoreboard 0 at 8 or more measured wins; scoreboard 2 targets checked on held-out slices |

## 12. What already exists (reuse map)

| Need | Existing code | Plan |
|---|---|---|
| Receipts | `eval/runner/receipt.ts` (schema v1, atomic writes, three-part outcome) | Extend to v2 |
| Aggregation | `eval/runner/all.ts` (hand-kept list of 15 categories) | Reads the registry |
| Artifact integrity | `docs/receipts-manifest.json` (101 hash-checked entries) | Scorecard links manifest entries |
| CI gate in gbrain | `gbrain eval gate`, `gbrain eval brainbench`, nightly cron in `e2e.yml` | Reuse for the CI hook |
| Paired statistics | `gbrain eval compare` (paired bootstrap), evals situation-recall comparator | Reuse for R6 and before/after receipts |
| LongMemEval | gbrain `src/eval/longmemeval/` | Single harness; evals wraps it |
| Brain checks | `gbrain doctor` categories | Extend with `--invariants` |
| Replace semantics | `replaceDerivedLinks` (`src/core/derived-links.ts`) | Generalize in Phase 4 item 10 |
| Subprocess contract | Cat34 (`cat34-brainbench-memory.ts`) | Wrap in-repo evals |
| Corpora | world-v1, amara-life-v1, associative-recall-v1, contradictions gold | Seed N1-N8 |
| Captured queries | `gbrain eval export` / `replay` | Phase 4 item 6, local only |

## 13. NOT in scope (deferred, with reasons)

- **Multilingual retrieval category.** Useful but outside the five scoreboards'
  first pass; revisit after N-series gates are on.
- **Consolidation and drift quality category.** Needs the idempotent dream (Phase 4
  item 13) first.
- **DolphinBench action-based arm.** Large ($20-50) and depends on N8.
- **Multimodal memory category.** Waits for text-in-multimodal-space work in gbrain.
- **LongMemEval-V2 (agent trajectories) entry.** High value later; the scale track
  (N10) comes first because its data and harness already exist.
- **Physical erasure guarantees.** gbrain promises withdrawal, not erasure; N5
  measures withdrawal.
- **A third-party npm memory test tool that can drive any MCP server.** gbrain
  could run it through `gbrain serve` almost for free, but it is small and not a
  recognized benchmark. Revisit after AMB.
- **A hosted results viewer, Windows support, and a prebuilt artifact for an
  under-2-minute first run.** Outside DX POLISH scope.

**TODOS.md entries to add when this plan lands** (both repositories were read-only
during the review, so these are not yet written). Each is P3 unless noted.

| Repo | What | Why | Depends on |
|---|---|---|---|
| evals | Multilingual retrieval category (MIRACL / Mr.TyDi subsets) | Keyword folding and CJK paths are untested | Registry |
| evals | Consolidation and drift quality category | Dream consolidation is unmeasured | Phase 4 item 13 |
| evals | DolphinBench action-based arm for N8 | Action memory is where the field is moving | N8 |
| evals | Multimodal memory category | Image evidence is unmeasured | gbrain text-in-multimodal-space work |
| evals | LongMemEval-V2 entry (P2) | Open leaderboard with few entries | N10 |
| evals | npm MCP-driven memory test run | Nearly free extra comparison | AMB results |
| evals | `--why <question-id>` flag printing each arm's rank for a miss | Faster miss debugging | Receipts v2 |
| evals | Errata entries link the fixing commit | Traceability | E2 |
| evals | Measure human first-visit time (observed sessions) | CI timing is not a human | Demo |
| evals | Adapter interface so other memory systems can run the system-agnostic categories | Platform potential | Registry labels |

## 14. Developer experience requirements

Two developers use what this plan builds. The primary one is an engineer who builds
agents and is deciding whether to trust gbrain's claims; they read the README, want
matched comparisons, and give a repository about five minutes. The secondary one is
a gbrain contributor who must show that a change helped before it merges.

**Golden path for the evaluating engineer (target: under 5 minutes from clone, no
API key).**
```sh
git clone https://github.com/garrytan/gbrain-evals.git && cd gbrain-evals
bun install --frozen-lockfile
bun run verify      # every published number recomputed from raw receipts (<30 s)
bun run demo        # gbrain hybrid vs BM25 vs vector on the fictional corpus (<60 s)
```
The README's first screen shows the generated "Where gbrain stands" table, and each
row has a copy-paste "reproduce this number" block: the exact command, the keys it
needs, the estimated cost and the time it took last run.

**Golden path for the contributor.**
```sh
bun eval/runner/all.ts --tier H --gbrain ../gbrain            # hermetic tier vs a local checkout
bun eval/runner/all.ts --category r2-conceptual --gbrain ../gbrain --budget-usd 2
bun run receipts:diff <before-receipt> <after-receipt>        # paired gains and losses
```
`--gbrain <path>` (or `GBRAIN_UNDER_TEST`) runs any category against a local gbrain
checkout, and the receipt records both the declared pin and the code actually
loaded. It must not rely on a symlinked overlay: the audits found that Bun resolves
symlinked files back to the pinned copy, which silently tested the wrong code. The
runner compares the loaded code's SHA with the requested checkout and fails on a
mismatch. `receipts:diff` reuses the paired-delta scorer. `bun run category:new <id>`
scaffolds a runner, a registry entry with the one-page spec, and a test file with
the negative, presence and solvability controls stubbed in.

**Error messages.** Every runner, the aggregate, the paid-run guard and
`gbrain doctor --invariants` report problem, cause and fix in that order, plus the
command to run next. Examples the implementation must match in substance:
- Missing key: "SKIPPED r2-conceptual (live arm): OPENAI_API_KEY is not set. This arm
  makes paid embedding calls (estimated $0.40). Set the key, or run
  `bun eval/runner/all.ts --tier H` for keyless categories." Skipped categories are
  shown as SKIPPED with the reason, never as FAIL.
- Mixed SHAs: "Refusing to aggregate: r2-conceptual was measured at gbrain 939232f,
  w1-links at 6bb88d1. Re-run r2-conceptual at 6bb88d1, or pass --allow-mixed-sha
  (the report will be labeled mixed)."
- Paid-run guard: "Estimated $12.40 for LongMemEval-S retrieval (500 questions, cold
  embedding cache). Pass --budget-usd 15 to run."
- Invariant violation: "file_page_bijection: 2 files map to no live page
  (notes/a.md, notes/b.md). Likely cause: a moved file that carries a frontmatter
  id. Nothing was changed. Fix: run `gbrain sync --full`, then re-run
  `gbrain doctor --invariants`."

**Docs.** `docs/CATEGORIES.md` is generated from the registry: for each category,
what it proves, its denominator, tier, cost, command, and whether it can run
against any memory system through an adapter or only against gbrain. The scorecard
and README tables are generated too. Hand-written docs explain; generated docs
carry numbers.

**Upgrades.** Receipts v1 stay readable; the scorecard labels them "legacy schema".
Old Cat numbers resolve through registry aliases (`--category cat13` works). The
gbrain CHANGELOG for page-grain fusion says rankings change and shows how to compare
before and after on your own brain with `gbrain eval replay --against`. The
`page_identity` migration ships with an upgrade note and runs through
`gbrain apply-migrations`.

**Measuring it.** A CI job in gbrain-evals times a clean clone through
`bun run verify` and `bun run demo` in a fresh container and writes the times to the
scorecard (report-only, not a gate). This measures automated execution time, not a
human's first visit.

## 15. Architecture, tests and rollout

**Components and dependencies.**
```
 gbrain                                                gbrain-evals
 ------                                                ------------
 search/hybrid.ts (page-grain RRF, G1)                 eval/registry.ts ---------------------+
 import/sync/facts/cycle (G2, G3)                        |  ids, tiers, budgets, globs,        |
 export ./eval/longmemeval  <---- wraps ----------------- eval/runner/longmemeval.ts           |
 doctor --invariants        <---- calls ----------------- N14 / N5 runners                     |
 eval gate + qrels baselines                              eval/runner/all.ts --tier/--category |
 .github/workflows                                        eval/runner/receipt.ts (v2) <--------+
   test.yml  PR job ------ H tier, pinned evals SHA ---->   |
   e2e.yml   nightly ----- H + small K, spend cap ------>   v
   release   repository_dispatch --------------------->  eval/publish/ (one receipt loader)
                                                            |-> docs/SCORECARD.md, README table
                                                            |-> docs/CATEGORIES.md, docs/SPEND.md
                                                            '-> bun run verify (regenerate + diff)
                                                         .github/workflows
                                                           publish.yml: receipts PR, concurrency
                                                           group "receipts-publish"
```
New moving parts: the registry, receipts v2, one publish module, three workflows
(gbrain PR job, nightly, release dispatch plus the evals publish workflow), the
LongMemEval export, and `doctor --invariants`. Everything else extends code that
exists.

**Regression contracts (must hold before each PR merges).**
- *Page-grain fusion (G1).* Preserve: exact-title and alias lookups (NamedThingBench
  hit@1 no worse), `gbrain eval gate` qrels `expected_top1` no worse. Intended change:
  pages that several arms agree on rank higher; Cat13 hybrid ≥ vector-only.
  Acceptance: the before/after receipts in §4 item 0 plus the fusion probe from the
  read-path audit as a unit test (page A, first in both arms, must beat page B,
  second in both).
- *Identity and sync (G2).* Preserve: files without a frontmatter id sync exactly as
  before; incremental and full sync give the same pages. Intended change: moved or
  retitled files keep one live page and all messages. Acceptance: each audit repro
  (A1, A2, A3, C1) becomes a regression test, plus the invariant counts at 0 on the
  vault-churn fixtures.
- *Forget and dream (G3).* Preserve: forgetting a claim on one entity removes it from
  active memory. Intended change: an identical claim on another entity stays active,
  re-remembering works, other pages keep their chunks, and embedding calls scale with
  affected pages. Acceptance: B1, B2, B3, C2, C3 repros as regression tests.

**Test requirements by component.**

| Component | Unit | Integration / E2E | Eval |
|---|---|---|---|
| Registry | load, alias resolve, unregistered runner fails, glob selection | `all.ts --tier H` on the registry | n/a |
| Receipts v2 | v1 and v2 validate; mixed SHA refused; incomplete not publishable; duplicate probe id fails | aggregate over real runner output | n/a |
| Publish module + verify | each generator from fixture receipts; stale age; mixed labels | `bun run verify` fails on a hand-edited number | n/a |
| Demo + preflight | wrong Bun version and wrong pin produce the fix message | keyless run in CI under 60 s | n/a |
| Paid-run guard | refuses without flag; refuses over budget; estimate printed | n/a | n/a |
| `--gbrain <path>` | loaded-SHA mismatch fails | run against a copied checkout | n/a |
| LME export + wrapper | row schema; no input contains `answer_` | 25-question parity test | LME-S held-out |
| Page-grain fusion | fusion probe; display-chunk choice; cosine blend per page | qrels gate | Cat13, LME, NamedThingBench [EVAL] |
| `doctor --invariants` | positive and negative fixture per invariant; sampling | vault-churn fixtures, 200-commit fuzzer | N14 |
| Judge hardening (E1) | untrusted-output fencing | n/a | re-run judged categories on a fixed set [EVAL] |
| Dream write guards (G3, Phase 4 item 13) | existence and authorship check | 3-run idempotence fixture | Cat35 + dream idempotence [EVAL] |
| Workflows | n/a | dispatch dry run; concurrency group; nightly dedupe | n/a |
The full list is in `test-plan.md`.

**Parallel lanes.**

| Step | Modules touched | Depends on |
|---|---|---|
| G1 read path | gbrain `src/core/search`, `src/eval` | overlap rows for #5652-#5656 |
| G2 identity | gbrain import, sync, links, timeline | overlap rows for #5649, #5648, #5624, #5562 |
| G3 memory ops | gbrain facts, cycle, connectors | G2 (shares import and facts paths) |
| E1 integrity | evals `eval/runner`, scorers | none |
| E2 claims + CI | evals docs, CI | E1 |
| Foundation (registry, receipts v2, publish, verify, demo) | evals `eval/registry`, `eval/publish`, `eval/runner/receipt.ts` | E1 |
| LME export | gbrain `src/eval/longmemeval`, `package.json` exports | G1 (opaque ids) |
| Categories N-series | evals `eval/runner`, `eval/generators` | Foundation |
| Workflows | both repos' `.github/workflows` | Foundation |
Lane A: G1 → LME export. Lane B: G2 → G3. Lane C: E1 → E2 and Foundation → Workflows
and categories (categories split by family once Foundation lands). Launch A, B and C
together; merge E1 before Foundation; categories fan out after Foundation. Conflict
flag: G1 and the LME export both touch `src/eval`; keep them sequential in lane A.

**Rollout and rollback.**
- gbrain ranking change (G1): ships in one patch release with the CHANGELOG note from
  §14; rollback is a revert of that PR plus the baseline files it regenerated.
- `page_identity` (Phase 4 item 9): forward-only additive migration; rollback is a
  code revert, and the unused table is harmless.
- New categories: enter report-only; a registry change makes one a gate, and the
  same one-line change demotes it if it flaps.
- Workflows: the release dispatch can be disabled by removing the token secret;
  receipts land through PRs, so nothing publishes without `bun run verify` passing.

## 16. Implementation tasks (aggregated across review phases)

P1 blocks the phase it belongs to; P2 lands in the same phase; P3 is follow-up.
Effort is shown for a human team and for CC+gstack (ratios: features ~30x, tests
~50x, architecture ~5x). Source JSONL: `tasks/`.

- [ ] **ceo-T3 (P1, human: ~1d / CC: ~1h) — both repos** — Resolve every open-PR overlap row before the matching Phase 0 PR starts
  - Surfaced by: CEO 0A premise 4
- [ ] **ceo-T8 (P1, human: ~3d / CC: ~3h) — gbrain doctor** — gbrain doctor --invariants (read-only, per-invariant counts, --json)
  - Surfaced by: CEO 0G E10
- [ ] **ceo-T1 (P1, human: ~3d / CC: ~3h) — gbrain search** — Page-grain RRF fusion with matched before/after receipts
  - Surfaced by: CEO S9 / read-path #1
- [ ] **ceo-T9 (P1, human: ~1d / CC: ~1h) — gbrain-evals** — Publish write-path violation baseline from the seeded 200-commit fuzzer
  - Surfaced by: CEO spec review completeness
- [ ] **ceo-T5 (P1, human: ~4h / CC: ~20min) — gbrain-evals** — Freeze stratified 94/376 LME-S tuning/held-out split and start TUNING_LOG
  - Surfaced by: CEO 0A premise 2
- [ ] **ceo-T6 (P1, human: ~2d / CC: ~2h) — gbrain-evals** — Category registry read by all.ts, CI and generated docs
  - Surfaced by: CEO S5 DRY
- [ ] **ceo-T2 (P1, human: ~2d / CC: ~2h) — gbrain-evals** — First measured win: Cat13 (+vector+reranker cell), LME-S, NamedThingBench at one SHA pair
  - Surfaced by: CEO 0G E3/E6
- [ ] **ceo-T4 (P1, human: ~1d / CC: ~1h) — gbrain-evals** — Move memory-cues experiments to a gbrain-cues alias and re-pin to master
  - Surfaced by: CEO 0A / audit pin bump
- [ ] **ceo-T7 (P1, human: ~2d / CC: ~2h) — gbrain-evals** — Receipts v2 extending receipt.ts (SHA, cost, latency, tokens, controls, selection set)
  - Surfaced by: CEO S4
- [ ] **eng-T1 (P1, human: ~1d / CC: ~1h) — gbrain eval** — Export ./eval/longmemeval programmatic API; evals wraps it; 25-question parity test
  - Surfaced by: Eng F-E1 (package.json exports only ./eval/longmemeval/reader)
- [ ] **eng-T2 (P1, human: ~4h / CC: ~30min) — gbrain eval gate** — Regenerate eval gate baselines inside G1 under the fusion regression contract
  - Surfaced by: Eng F-E2
- [ ] **eng-T3 (P1, human: ~2d / CC: ~2h) — gbrain tests** — Turn audit repros A1, A2, A3, C1, B1, B2, B3, C2, C3 into regression tests
  - Surfaced by: Eng regression rule
- [ ] **devex-T3 (P1, human: ~1d / CC: ~1h) — gbrain-evals** — Error standard: problem, cause, fix, next command; SKIPPED never FAIL
  - Surfaced by: DX Pass 3 / audit C-18
- [ ] **devex-T2 (P1, human: ~1d / CC: ~1h) — gbrain-evals** — bun run demo with Bun/pin preflight, keyless, under 60 s
  - Surfaced by: DX Pass 1
- [ ] **devex-T1 (P1, human: ~1d / CC: ~1h) — gbrain-evals** — bun run verify: regenerate docs from receipts, diff, run existing verifiers
  - Surfaced by: DX 0D magical moment
- [ ] **ceo-T13 (P2, human: ~2d / CC: ~2h) — gbrain CI** — PR H-tier job (pinned evals SHA, no secrets) and nightly with deduplicated issues
  - Surfaced by: CEO S1/S3/S8
- [ ] **ceo-T15 (P2, human: ~1d / CC: ~1h) — gbrain search** — Fusion-weight calibration runs locally; commit weights and synthetic replay only
  - Surfaced by: CEO S3
- [ ] **ceo-T14 (P2, human: ~3d / CC: ~3h) — gbrain-evals** — Phase 3 runs: matched + frontier QA arms, Cat35 held-out, AMB (oracle and smoke first)
  - Surfaced by: CEO 0G E8/E9; AMB
- [ ] **ceo-T12 (P2, human: ~2d / CC: ~2h) — gbrain-evals** — Scorecard regenerated per gbrain release with receipt age
  - Surfaced by: CEO 0G E5
- [ ] **ceo-T10 (P2, human: ~1d / CC: ~1h) — gbrain-evals** — Paid-run guard (--budget-usd) and generated docs/SPEND.md
  - Surfaced by: CEO 0G E18
- [ ] **ceo-T11 (P2, human: ~2d / CC: ~2h) — gbrain-evals** — Wrap NamedThingBench, whoknows, parser, chronicle, trajectory, takes-quality via Cat34 contract
  - Surfaced by: CEO 0G E13
- [ ] **eng-T5 (P2, human: ~1d / CC: ~1h) — both repos CI** — Release repository_dispatch with scoped token; receipts land by PR; shared concurrency group
  - Surfaced by: Eng F-E5/F-E11
- [ ] **eng-T7 (P2, human: ~4h / CC: ~30min) — gbrain doctor** — Invariant sampling above 20k pages; --full and --source
  - Surfaced by: Eng F-E8
- [ ] **eng-T10 (P2, human: ~1d / CC: ~1h) — gbrain migrations** — page_identity as forward-only additive migration; code tolerates empty table
  - Surfaced by: Eng F-E3
- [ ] **eng-T4 (P2, human: ~1d / CC: ~1h) — gbrain-evals** — One publish module (single receipt loader) behind scorecard, categories, spend, verify
  - Surfaced by: Eng F-E10 structure
- [ ] **eng-T6 (P2, human: ~4h / CC: ~30min) — gbrain-evals** — Regression = paired test p<0.05 and drop beyond registry tolerance
  - Surfaced by: Eng F-E6
- [ ] **eng-T8 (P2, human: ~2h / CC: ~10min) — gbrain-evals** — Duplicate probe ids fail the run
  - Surfaced by: Eng F-E14 / audit PC-14
- [ ] **eng-T9 (P2, human: ~1d / CC: ~1h) — gbrain-evals CI** — Shard CI, pre-migrated PGLite snapshot, diff-aware selection from registry globs
  - Surfaced by: Eng F-E12
- [ ] **devex-T8 (P2, human: ~4h / CC: ~20min) — both repos** — Upgrade notes: v1 receipts legacy, Cat aliases, CHANGELOG ranking-change replay check
  - Surfaced by: DX Pass 5
- [ ] **devex-T4 (P2, human: ~1d / CC: ~1h) — gbrain-evals** — --gbrain <path> / GBRAIN_UNDER_TEST with loaded-SHA check
  - Surfaced by: DX Pass 2
- [ ] **devex-T6 (P2, human: ~4h / CC: ~20min) — gbrain-evals** — category:new scaffold with controls stubbed
  - Surfaced by: DX Pass 2 (taste #53)
- [ ] **devex-T5 (P2, human: ~4h / CC: ~20min) — gbrain-evals** — receipts:diff using the paired-delta scorer
  - Surfaced by: DX Pass 2
- [ ] **devex-T7 (P2, human: ~4h / CC: ~20min) — gbrain-evals** — Generate docs/CATEGORIES.md from the registry with system-agnostic labels
  - Surfaced by: DX Pass 4/7
- [ ] **devex-T9 (P3, human: ~4h / CC: ~20min) — gbrain-evals CI** — Report-only CI job timing clean clone → verify → demo
  - Surfaced by: DX Pass 8

## Review record

This section records the /autoplan review. The Implementation plan above is the
plan; everything below explains what changed and why. The byte-exact original is
at the restore path on line 1.

### Run conditions (Capy adaptations)

- Harness: Capy task agent. No Skill tool, so each gstack SKILL.md and section file
  was read from disk. Hooks are not enforced.
- Outside voice: unavailable. Neither the `codex` nor the `claude` CLI is installed
  (`CODEX_MODE: not_installed`). No cross-model review ran.
- Native fresh-context reviewer: a reviewer task was drafted with the snapshot
  tool's dispatch prompt but could not start (the parent thread was at its 8-task
  limit). In its place, each phase has an **independent adversarial pass by the
  primary reviewer**, labeled as such. It is the same model with the same context,
  so it is weaker than a true outside voice.
- Decisions: The owner's standing instruction for this run was "accept all
  recommendations". Every decision point took the recommended option, except
  one-way steps, where the conservative option was taken and noted.
- Storage: only this file and scratch under `` were written. The
  restore point, CEO plan archive, test plan and task lists live there instead of
  `~/.gstack/projects/`. The snapshot tool's exact-replacement amendment records were
  not used, because they would duplicate the whole rewritten plan as escaped JSON;
  the restore file is the byte-exact baseline for diffing. Review logs, spec-review
  metrics and telemetry were not written (telemetry is off and stays off).
- Scope detection: UI terms 0 matches, so the design phase was skipped. DX terms 13
  matches (threshold 2), and gbrain is a developer tool, so the DX phase ran.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | Intake | Skip /office-hours prerequisite | Mechanical | P6 | Plan plus five audits already state problem, evidence and approach | Run /office-hours first |
| 2 | Intake | Skip design phase | Mechanical | Skill rule | 0 UI term matches | Run design review |
| 3 | Intake | Run DX phase | Mechanical | Skill rule | 13 DX term matches; developer tool | Skip DX |
| 4 | CEO 0E | Mode: SELECTIVE EXPANSION | Taste | Autoplan override + owner's stance | Autoplan fixes the mode; the raw file-count rule (>15 files) would have recommended SCOPE REDUCTION | SCOPE REDUCTION, HOLD SCOPE |
| 5 | CEO | Review depth: implementation-ready for Phases 0-1, capability-level for Phases 2-5 | Mechanical | P5 | Program plan; each category gets its own spec before build | Implementation-ready everywhere |
| 6 | CEO 0A | Add scoreboard 0 "Measured wins" | Mechanical | P1 | Coverage counts reward measuring, not improving; wins are what users feel | Keep four scoreboards |
| 7 | CEO 0A | LME target judged on a frozen held-out slice, after re-baseline | Mechanical | P1 | The 95.53% config was chosen on the test set; tuning to 5 misses on the same 470 would overfit | Target on full 470 |
| 8 | CEO 0A | Add "one LongMemEval harness" with parity test | Mechanical | P4 | Headlines came from gbrain's harness; evals has a second copy | Keep two harnesses |
| 9 | CEO 0A | Drop hardcoded version numbers from Phase 0 | Mechanical | P3 | Open PRs already claim 0.59.3.2 to 0.60.0.0; renumber at ship | Keep 0.59.5-0.59.7 |
| 10 | CEO 0A | Add open-PR overlap table to Phase 0 | Mechanical | P2 | Ten open PRs touch Phase 0 code | Generic "overlap checks" risk line |
| 11 | CEO 0A | `memory-cues` → side package alias now, master after a measured gain | Mechanical | P3, P5 | Unblocks the re-pin in hours; no quality result exists yet | Ship to master now |
| 12 | CEO 0A | AMB: build and publish results; public leaderboard submission after human go | Mechanical (conservative) | One-way-door rule | Public submission is hard to reverse | Submit publicly as part of the plan |
| 13 | CEO 0A | Paid budget as a $500 cap spent through a guard | Mechanical | P1 | The plan gave a range; spend needs a hard ceiling | Open range |
| 14 | CEO 0G | Accept E1 single LME harness | Mechanical | P4 | Gap in "one command reproduces" | Defer |
| 15 | CEO 0G | Accept E2 held-out discipline + tuning log | Mechanical | P1 | Overfitting risk named in plan but not mitigated | Defer |
| 16 | CEO 0G | Accept E3 first measured win in week 1 | Mechanical | P6 | The owner prefers measured benefit before infrastructure | Wins only in Phase 4 |
| 17 | CEO 0G | Accept E4 keyless 60-second demo | Mechanical | P2 | Small; no keyless way to see gbrain work today | Defer |
| 18 | CEO 0G | Accept E5 release-triggered scorecard | Taste | P1 | M effort, cross-repo workflow; makes the scorecard stay fresh | Manual scorecard refresh |
| 19 | CEO 0G | Accept E6 vector + reranker cell for Cat13 | Mechanical | P1 | Makes the concept claim matched; about $1 | Keep unmatched claim |
| 20 | CEO 0G | Accept E7 `attended` fixture direction fix | Mechanical | P2 | Free win flagged by the docs audit | Defer |
| 21 | CEO 0G | Accept E8 frontier-reader QA arm | Mechanical | P1 | Needed to compare with 90%+ self-reported rows; about $30 | gpt-4o arm only |
| 22 | CEO 0G | Accept E9 Cat35 held-out transcripts | Mechanical | P1 | $3; turns an in-sample number into a checked one | Defer |
| 23 | CEO 0G | Accept E10 user-facing `gbrain doctor --invariants` | Mechanical | P4 | Same code protects real brains | Evals-only checker |
| 24 | CEO 0G | Accept E13 port in-repo evals via Cat34 contract | Mechanical | P4 | Cheap coverage from suites that already exist | Defer |
| 25 | CEO 0G | Accept E17 MemoryAgentBench arms for N2/N5 as optional | Taste | P1 | External check on the two strongest stories; adds dataset work | Internal gold only |
| 26 | CEO 0G | Accept E18 paid-run guard and spend ledger | Mechanical | P1 | Budget has no enforcement today | Trust per-run judgment |
| 27 | CEO 0G | Defer E11 multilingual category | Mechanical | P3 | Outside blast radius | Add now |
| 28 | CEO 0G | Defer E12 consolidation/drift category | Mechanical | P3 | Depends on Phase 4 item 13 | Add now |
| 29 | CEO 0G | Defer E14 DolphinBench arm | Mechanical | P3 | L effort, depends on N8 | Add now |
| 30 | CEO 0G | Defer E15 multimodal memory category | Mechanical | P3 | Depends on unshipped gbrain work | Add now |
| 31 | CEO 0G | Defer E16 LongMemEval-V2 entry | Taste | P3 | High value but N10 has data and harness ready first | Add now |
| 32 | CEO 0G | HOLD check: keep all 13 categories in scope, gated by build order | Mechanical | P1 | The owner's 10x stance; sequencing gates control risk | Defer N7, N8, N12, N13 |
| 33 | CEO S1 | gbrain CI pins a gbrain-evals commit | Mechanical | P5 | Prevents cross-repo breakage | Float on evals main |
| 34 | CEO S3 | Captured queries never leave the owner's machine | Mechanical | P1 | Contributor-mode queries are real user data | Commit captured queries |
| 35 | CEO S3 | H-tier CI job uses no secrets | Mechanical | P5 | Fork PRs can run it; no key exposure | Keyed PR job |
| 36 | CEO S4 | Aggregate refuses mixed gbrain SHAs; `publishable` requires completion | Mechanical | P1 | Audit found one sweep spanning two revisions and partial runs marked publishable | Warn only |
| 37 | CEO S5 | Name the checker `gbrain doctor --invariants`, not "fsck"/"integrity" | Mechanical | P5 | `gbrain integrity` already exists with a different meaning | New top-level command |
| 38 | CEO S5 | Registry is the single source for `all.ts`, CI, scorecard and coverage counts | Mechanical | P4 | Three hand lists would drift | Separate lists |
| 39 | CEO S7 | Per-category CI time budget in registry | Mechanical | P1 | Suite at 682 s of 900 s before new categories | No budget |
| 40 | CEO S8 | Nightly issues deduplicated per category and metric | Mechanical | P5 | Prevents issue floods | One issue per failure |
| 41 | CEO S9 | G1 carries matched before/after receipts before merge | Mechanical | P1 | Page-grain fusion changes every user's ranking | Merge first, measure later |
| 42 | CEO | Replace competitor company names with generic descriptions | Mechanical | Privacy rule | Run instruction: no real people or company names | Keep names |
| 43 | DX 0 | Product type: developer tool (benchmark harness + CLI), docs secondary | Mechanical | P6 | Plan centers on runner commands, CLI flags and published docs | Library/SDK |
| 44 | DX 0A | Primary persona: engineer evaluating gbrain's claims; secondary: gbrain contributor | Mechanical | P6 | gbrain-evals CLAUDE.md: "write for the engineer deciding whether to try gbrain" | External memory-system author as primary |
| 45 | DX 0B | Empathy narrative accepted as written | Mechanical | P6 | Grounded in README lines 82-104 and the docs audit | n/a |
| 46 | DX 0C | TTHW target: Competitive (under 5 min from clone) | Mechanical | P5 | `bun install` of two git-pinned gbrain copies makes under 2 min unlikely without a prebuilt artifact | Champion (<2 min) |
| 47 | DX 0D | Magical moment vehicle: `bun run verify` (offline recount of every published number) plus `bun run demo` | Mechanical | P5 | Uses verifiers that already exist; lowest effort that reaches the target | Hosted results viewer |
| 48 | DX 0E | Mode: DX POLISH | Mechanical | Autoplan override | Enhancement to an existing product | DX EXPANSION, DX TRIAGE |
| 49 | DX P1 | Preflight in verify/demo checks Bun version and installed pin | Mechanical | P1 | Install drift (pre-modified `bun.lock`, inert patch) is the likeliest first failure | Document only |
| 50 | DX P1 | README "reproduce this number" block per headline | Mechanical | P2 | Delight item from CEO scan; generated with the scorecard | None |
| 51 | DX P2 | `--gbrain <path>` / `GBRAIN_UNDER_TEST` on every runner | Mechanical | P5 | Contributors need one consistent way to test a local checkout; evals CLAUDE.md already requires recording loaded code | Per-runner flags |
| 52 | DX P2 | `receipts:diff` command | Mechanical | P4 | Reuses the paired-delta scorer | Manual comparison |
| 53 | DX P2 | `category:new <id>` scaffold | Taste | P2 | 13+ new categories; the scaffold enforces controls, but it is new tooling in POLISH mode | Copy an existing runner |
| 54 | DX P3 | Error message standard (problem, cause, fix, next command) with four required examples | Mechanical | Override: always problem + cause + fix | Audit C-18 shows skipped categories printed as FAIL | Leave messages to implementers |
| 55 | DX P4 | Generate `docs/CATEGORIES.md` from the registry | Mechanical | P4 | Single source for category docs | Hand-written index |
| 56 | DX P5 | Receipts v1 readable; registry aliases for old Cat numbers; CHANGELOG notes for ranking change and migration | Mechanical | P1 | Upgrades must not orphan published receipts or old commands | Break v1 |
| 57 | DX P7 | Mark each category as system-agnostic or gbrain-only in the generated docs | Mechanical | P5 | External adapter authors need to know what they can run | None |
| 58 | DX P8 | CI job timing clean clone → verify → demo, report-only | Mechanical | P1 | Makes TTHW a measured number; not a gate | No measurement |
| 59 | DX 0C | AMB needs a Gemini key and has an oracle mode; plan updated | Mechanical | P1 | Found in AMB's README during benchmarking | Leave cost estimate unchanged |
| 60 | DX | Defer the npm MCP-driven memory test tool | Mechanical | P3 | Cheap but low credibility; AMB first | Add now |
| 61 | Eng 0 | Complexity gate: keep the full feature list (override: never reduce) | Mechanical | P2 | Autoplan eng override | Cut categories |
| 62 | Eng 0 | Structure: smaller arrangement (one publish module; verify = regenerate and diff) | Mechanical | P4, P5 | Same features and contracts with fewer moving parts | Separate generators and verifier |
| 63 | Eng 0 | Add gbrain export `./eval/longmemeval` with typed `runLongMemEval` | Mechanical | P5 | Only `./eval/longmemeval/reader` is exported today; a thin wrapper needs an API, not a CLI | Subprocess the CLI; deep imports |
| 64 | Eng 0 | G1 regenerates `eval gate` baselines under a written regression contract | Mechanical | Regression rule | The ranking change will trip the existing qrels gate | Leave baselines stale |
| 65 | Eng 0 | `page_identity` is a forward-only additive migration; rollback = code revert | Mechanical | P5 | `migrate.ts` has no down path | Down-migration (not supported) |
| 66 | Eng 0 | Real tokenizer = existing `@dqbd/tiktoken`, pinned encoding recorded | Mechanical | P4 | Already a gbrain dependency | New tokenizer dependency |
| 67 | Eng S1 | Release dispatch with a token scoped to gbrain-evals; receipts land by PR; a human merges after verify passes (Capy never auto-merges) | Mechanical | P5 | Direct pushes of numbers skip review; losses still published | Direct commit to main |
| 68 | Eng S1 | Shared concurrency group for nightly and release publishing | Mechanical | P5 | Two writers to one receipts tree | Unserialized |
| 69 | Eng S1 | Regression = paired test p<0.05 and drop beyond registry tolerance | Mechanical | P1 | Keyed runs are noisy; issues must mean something | Any drop |
| 70 | Eng S1 | Invariants sample above 20,000 pages; `--full`, `--source` | Mechanical | P3 | Derivable-links check re-parses every page | Always full scan |
| 71 | Eng S1 | Invariant checker = sync-drift consistency; N14 ledger = correctness | Mechanical | P5 | Avoids circular evidence | One check for both |
| 72 | Eng S1 | Keep the edit-fuzzer and ground truth in gbrain-evals; checker in gbrain with unit tests per invariant | Taste | P5 | Independence of ground truth vs fast in-repo tests; the adversarial pass raised hosting fixtures in gbrain | Host fuzzer in gbrain |
| 73 | Eng S2 | Duplicate probe ids fail the run | Mechanical | P1 | Audit PC-14 silent merge | Merge silently |
| 74 | Eng S2 | `--gbrain` refuses symlinked overlays via loaded-SHA check | Mechanical | P1 | Audit found Bun resolving symlinks back to the pin | Trust the flag |
| 75 | Eng S3 | Regression contracts for G1, G2, G3 written into §15 | Mechanical | Regression rule | Existing behavior at risk in all three | Implicit |
| 76 | Eng S3 | Audit repros become regression tests (A1, A2, A3, C1, B1, B2, B3, C2, C3) | Mechanical | P1 | Repro code exists in the audit scratch | New tests from scratch |
| 77 | Eng S3 | Eval scope: judged categories re-run after judge hardening; dream idempotence + Cat35 after write guards; N2 after contradiction flow | Mechanical | P1 | Prompt and LLM-path changes need evals | Unit tests only |
| 78 | Eng S3 | LME held-out split stratified by type; abstention scored by A4 | Mechanical | P1 | Unstratified split can drop whole types | Random split |
| 79 | Eng S4 | CI: shard, pre-migrated PGLite snapshot, registry globs for diff-aware selection, 60 s budget per PR-tier category | Mechanical | P1 | 160 migrations per test dominate; 682 s of 900 s used | Raise the timeout |
| 80 | Eng | TODOS.md entries listed in §13 (repos read-only, not written) | Mechanical (conservative) | Run instruction | Cannot edit either repository | Write TODOS.md |
| 81 | Gate | Final approval gate: auto-approve (option A) | Mechanical | Run instruction | Owner: accept all recommendations | Overrides, revise, reject |
| 82 | Gate | Review logs, spec-review metrics and task JSONL kept out of `~/.gstack`; written under `` or not persisted | Mechanical (conservative) | Run instruction | Only the plan and plan scratch may change | Write to `~/.gstack/projects` |

### CEO phase

**Pre-review system audit.** gbrain master `6bb88d128` (v0.59.3.0), clean tree, 60
open PRs, `TODOS.md` 8,116 lines. gbrain-evals `b439f12` (v0.10.0); `bun.lock` was
already modified before the audits ran. Recurring problem areas: published numbers
drifting from receipts (the Sep 9 errata already retired one headline), duplicated
harnesses, and hand-kept category lists. Good patterns to copy:
`eval/runner/receipt.ts` (three-part outcome, atomic writes), `gbrain eval gate`
(fail-closed), `docs/receipts-manifest.json` (hash-checked). Patterns to avoid: the
hand-kept `CATEGORIES` list in `all.ts`, and the multi-adapter "gbrain" row that is a
parser for four templates. Landscape check: reused from the coverage audit §3
(web sources accessed the same day); no new searches were needed.

**0A. Premise challenge.** The real problem is trust in two directions: users need
gbrain not to lose or corrupt memory, and a skeptical engineer needs to verify
gbrain's position in minutes. The plan attacks both directly, not through a proxy,
with four premise problems:

1. *"10x" measured by coverage counts.* Counting categories rewards measuring, not
   improving. Fix: scoreboard 0 (measured wins). Accepted (#6).
2. *"21 → 5 LongMemEval misses".* The configuration was chosen on those same 470
   questions, and page-grain fusion will move the baseline. Chasing 5 misses on the
   test set is overfitting. Fix: re-baseline, then judge on a frozen held-out slice
   plus LongMemEval-M. Accepted (#7).
3. *"One command reproduces every headline."* Not achievable while the headline
   comes from a different harness than the evals runner. Fix: one harness plus a
   parity test. Accepted (#8).
4. *"Phase 0 at 0.59.5/6/7."* Open PRs already hold 0.59.3.2 through 0.60.0.0, and
   ten of them overlap Phase 0 code. Fix: renumber at ship and an overlap table.
   Accepted (#9, #10).

Do-nothing cost: the five wrong numbers stay public, the P0 data-loss bugs stay in
users' brains, and the evals cannot benchmark what users install.

**0B. Existing code leverage.** See the reuse map (Implementation plan §12). Nothing
in the plan needs a rebuild; every foundation item extends existing code. The one
place the plan implied new infrastructure (the gbrain CI hook) now reuses
`gbrain eval gate` and the existing nightly cron.

**0C. Dream state.**
```
  CURRENT STATE                 THIS PLAN                        12-MONTH IDEAL
  17/67 capabilities proven     registry + receipts v2 +         every release publishes a
  5 wrong public numbers   ---> 13 categories + fix wave +  ---> dated scorecard at its SHA;
  7 P0 data-loss bugs           external matched runs +          every capability measured;
  2 LME harnesses, off-master   measured product wins            neutral leaderboard rows;
  pin, no keyless demo                                           invariants = 0 on every PR;
                                                                 users run the same checks
```

**0D. Approach.** A) the plan as written, B) the minimum: fix wave, honest numbers,
registry and invariants only, C) the plan plus accepted expansions. C chosen (P1,
the owner's stance). B would leave the differentiators unmeasured, which is the problem
the plan exists to solve.

**0E. Mode.** SELECTIVE EXPANSION, set by the autoplan override. The file-count rule
alone (well over 15 changed files across two repos) would have recommended SCOPE
REDUCTION; that disagreement is surfaced as a taste decision (#4).

**0F/0G. Cherry-pick ceremony.** 18 candidates (E1-E18). Accepted 13, deferred 5
(rows #14-#31). HOLD checks: the plan touches far more than 8 files and adds several
new pieces (registry, receipts v2, scorecard generator, CI hook, invariants, 13
categories). The minimum set for the goal is Phase 0 plus Phase 1; Phases 2-5 are
deferrable without blocking it. Recommendation kept all of them, with the week-by-week
gates in §11 controlling risk (#32).

Delight scan (adjacent small improvements): a per-headline "reproduce this number"
block in the README; a receipts diff command that prints paired gains and losses; a
receipt-age column on the scorecard; errata entries that link the fixing commit; a
`--why <question-id>` flag that prints each arm's rank for a miss. The first three are
folded into DX and eng changes below; the last two are listed as follow-ups.

Platform potential: registry plus receipts v2 turn gbrain-evals into a harness other
memory systems could run, the mirror image of the AMB adapter. Not in this plan.

**0H. CEO plan archive and spec review.** Archive written to
`ceo-plan.md`. Spec review loop: the fresh-context reviewer could
not start, so the primary reviewer ran one adversarial pass over the amended plan
against the five dimensions:
- Completeness: PASS after adding item 8 (write-path baseline before G2/G3 land).
- Consistency: one issue fixed. The Risks section said "more than 60 open PRs"; the
  PR list has exactly 60.
- Clarity: one issue fixed. "fsck" was used for two different things; now one name.
- Scope: PASS. Every addition traces to an audit finding or an owner instruction.
- Feasibility: one concern kept open for eng: running 13 new hermetic categories in
  CI without breaking the 900 s budget.
Score: 8/10 (single reviewer, not independent). Metrics not persisted.

**0I. Temporal interrogation.**
- Hour 1: the implementer needs the open-PR overlap table and the `memory-cues`
  decision before touching the pin.
- Hours 2-3: the ambiguity is which LongMemEval harness is canonical; settled
  (gbrain's).
- Hours 4-5: the surprise is that page-grain fusion moves every hybrid number,
  including the headline. The first measured win doubles as the re-baseline.
- Hour 6+: they will wish the held-out split existed before any tuning; it is now a
  week-1 deliverable.
Effort, human team vs CC+gstack: Phase 0 about 2 weeks vs 2 days; Phase 1 about 3
weeks vs 3 days; Phase 2 about 6 weeks vs 1 week; Phases 3-4 about 8 weeks vs 2-3
weeks plus paid-run wall time.

**Section 1, Architecture.** Findings: (1) two LongMemEval harnesses, CRITICAL,
fixed by §4 item 2; (2) cross-repo coupling between gbrain CI and gbrain-evals,
fixed by pinning an evals commit (#33); (3) `memory-cues` blocks the re-pin, fixed
(#11). Rollback posture: evals changes revert cleanly; the gbrain ranking change
(G1) rolls back by reverting one PR, and the `page_identity` migration (Phase 4 item
9) is the one schema change and needs a down-migration (eng phase). [Superseded in eng phase: migrations are forward-only, so it is additive and a code revert is the rollback.]
```
  gbrain repo                                  gbrain-evals repo
  +------------------------------+             +-------------------------------+
  | src/core/search (G1)         |   package   | eval/registry.ts (new)        |
  | import/sync/facts (G2, G3)   |<----pin-----| eval/runner/* (40 + 13 new)   |
  | src/eval/longmemeval (canon) |<--wraps-----| longmemeval.ts (thin wrapper) |
  | doctor --invariants (new)    |<--calls-----| N14/N5 categories             |
  | eval gate, e2e.yml nightly   |---runs H--->| all.ts --tier H               |
  | release workflow             |---tag------>| receipts v2 -> SCORECARD.md   |
  +------------------------------+             +-------------------------------+
```

**Section 2, Error & Rescue Map.** Capability-level (strategy depth for this phase;
eng phase adds codepath rows). See the Error & Rescue Registry below. Two gaps
found and fixed in the plan: a paid run could overspend with no guard (#26), and a
nightly failure could open duplicate issues (#40).

**Section 3, Security & Threat Model.**

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| Judge prompt injection from system-under-test output | Med | High (wrong published numbers) | Yes, E1 judge hardening |
| Private pages leaking to remote callers | Med | High | Yes, N6 plus Phase 0 private tags |
| Captured user queries committed to the public evals repo | Med | High | Yes, now (#34) |
| API keys exposed to fork PRs | Low | High | Yes, H tier needs no secrets (#35) |
| Machine-local paths in committed receipts | High | Low | Yes, scrub rule in Risks |
| Third-party harness (AMB) receiving user data | Low | High | Yes, only public benchmark data is ever sent |

**Section 4, Data flow & edge cases.** Receipt flow:
`runner -> receipt (atomic) -> registry aggregate -> SCORECARD.md`. Shadow paths:
missing receipt (counts as not_run), partial run (not publishable, #36), mixed
gbrain SHAs (refused, #36), stale receipt older than the pin (scorecard shows age),
duplicate probe ids (audit PC-14; eng phase). Async ordering: the nightly job and
the release job can both commit receipts; eng phase adds a single concurrency group.

**Section 5, Code quality.** DRY: one registry feeds every consumer (#38); receipts
v2 extends v1 instead of adding a second schema; paired deltas reuse existing
bootstrap code. Naming collision with `gbrain integrity` fixed (#37). Over-engineering
watch: family aliases live only in the registry.

**Section 6, Test review.** Every new category must ship with: a scorer unit test on
hand-computed fixtures, a negative control, a presence control and a solvability
check (already in plan §4 item 4). Added: a registry completeness test and a
scorecard-matches-receipts test. The eng phase owns the full diagram. The plan
touches LLM prompts (dream, contradiction flow, judges), so the gbrain CLAUDE.md
rule on prompt changes applies: run the affected eval suites before and after.

**Section 7, Performance.** The CI budget is the binding constraint (682 s of 900 s
today). Fixed with per-category time budgets (#39); eng phase sizes the shards.
gbrain-side latency item 7 already has a target (about 19 → 7 round-trips).

**Section 8, Observability.** Added deduplicated nightly issues (#40), receipt age on
the scorecard, and a spend ledger (#26). Reranker failure visibility is in G1.

**Section 9, Deployment & rollout.** G1 now carries its receipts before merge (#41).
Phase 4 item 9's schema migration needs a backfill and a down-migration (eng phase) [superseded: forward-only additive migration, see eng phase].
Categories enter as report-only and become gates through the registry field.

**Section 10, Long-term trajectory.** Reversibility 4/5: docs, categories and CI
config revert easily; the AMB public submission and the `page_identity` migration
are one-way. Debt removed: the duplicate LongMemEval harness. Debt added: old-number
aliases, bounded to the registry. What comes next: the release-triggered scorecard
makes every later feature pay for its own evidence.

**Section 11, Design & UX.** SKIPPED (no UI scope).

**CEO dual voices, consensus table.**
```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                             Subagent  Codex  Consensus
  1. Premises valid?                    N/A       N/A    N/A
  2. Right problem to solve?            N/A       N/A    N/A
  3. Scope calibration correct?         N/A       N/A    N/A
  4. Alternatives sufficiently explored? N/A      N/A    N/A
  5. Competitive/market risks covered?  N/A       N/A    N/A
  6. 6-month trajectory sound?          N/A       N/A    N/A
Subagent: could not start (task limit). Codex: not installed. No cell is CONFIRMED.
```
**Independent adversarial pass (primary reviewer, not an outside voice).**
- Right problem? Mostly. The sharpest reframing: the plan is proof-first, but users
  feel data loss before they read a scorecard. Phase 0 G2/G3 already carry that, so
  no reorder, but scoreboard 0 now forces product wins into week 1.
- 6-month regret: publishing a new LongMemEval headline tuned on the test set, again.
  Mitigated by the held-out split.
- Dismissed alternative: putting the hermetic invariant fixtures inside gbrain's own
  test suite, with gbrain-evals wrapping them. Raised with the eng phase.
- Competitive risk: other memory systems already sit on AMB; each week without a
  neutral row lets their numbers define the comparison. The AMB adapter stays in
  weeks 2-5.

<!-- autoplan-accepted:ceo -->
- Scoreboard 0 "Measured wins": count of shipped changes with matched before/after receipts showing a gain; first by end of week 1, 8 or more by week 8; verified by receipts linked from the scorecard.
- LongMemEval-S target judged only on a frozen seeded 94/376 tuning/held-out split created before Phase 4 tuning, after re-baselining for page-grain fusion, and confirmed on LongMemEval-M; verified by the committed split file and `docs/TUNING_LOG.md`.
- One LongMemEval harness: evals `longmemeval.ts` wraps gbrain's `gbrain eval longmemeval`; verified by a 25-question parity test asserting identical `retrieved_session_ids`.
- Phase 0 PRs take the next free patch version at ship time; every open-PR overlap row in §3 resolved before the matching PR starts.
- G1 merges only with matched before/after receipts on Cat13 (with a vector + reranker cell), LongMemEval-S retrieval and NamedThingBench.
- `memory-cues` experiments move to a `gbrain-cues` package alias; `memory-cues` reaches gbrain master only after a measured gain.
- Registry fields include minimum gbrain version, gate status, CI time budget, old-number alias, capability ids, tuning set and held-out set; a test fails on any unregistered runner.
- Receipts v2 extend `receipt.ts` with gbrain SHA, cost, latency, real-tokenizer `returned_tokens`, separate error count, solvability, negative and presence controls, judge prompt version at temperature 0, and selection set; aggregation refuses mixed SHAs without `--allow-mixed-sha`; `publishable` requires completion.
- Scorecard regenerated on every gbrain release tag from receipts at that SHA, with receipt age shown; gbrain release notes link it.
- gbrain CI hook reuses `gbrain eval gate` and the `e2e.yml` nightly cron, pins a gbrain-evals commit, runs the H tier with no secrets, and opens deduplicated nightly issues with receipt diffs under a per-run spend cap.
- `gbrain doctor --invariants`: read-only by default, per-invariant counts, `--json`, extends existing doctor checks with the five listed invariants.
- Write-path violation baseline from the seeded 200-commit fuzzer published in Phase 1.
- Keyless `bun run demo` in gbrain-evals under 60 seconds with a "plumbing check" label.
- Paid-run guard: estimate printed, `--budget-usd` required, `docs/SPEND.md` generated against a $500 cap.
- In-repo gbrain evals (NamedThingBench, whoknows, conversation parser, chronicle, trajectory, takes-quality) wrapped via the Cat34 contract.
- Phase 3 adds a frontier-reader QA arm and Cat35 held-out transcripts; AMB results are published in gbrain-evals, with public leaderboard submission only after a human go.
- Captured queries for fusion calibration never leave the owner's machine; only weights and a synthetic replay set are committed.
- Competitor companies are described generically in the plan and in public artifacts derived from it.
<!-- /autoplan-accepted:ceo -->

**Error & Rescue Registry (capability level).**

| Capability / boundary | What can go wrong | Rescue in plan | User sees | Verification owner |
|---|---|---|---|---|
| Category runner | crash before receipt | aggregate marks `not_run` | FAIL (not PASS) in report | evals, E1 |
| Receipt validation | invalid or partial receipt | treated as fail; `publishable=false` | explicit failure line | evals, E1 |
| LLM judge | refusal, malformed JSON, timeout | counted as judge error, separate from misses | error count on receipt | evals, receipts v2 |
| Paid provider | outage, rate limit | retry with backoff, then error rows excluded from denominator and counted | error count; run not publishable | evals |
| Paid run | spend beyond estimate | guard refuses without `--budget-usd` | refusal with estimate | evals, §4 item 11 |
| gbrain CI hook | evals repo broken | pinned evals commit | gbrain PR unaffected | gbrain CI |
| Nightly job | regression | one deduplicated issue with receipt diff | issue in gbrain | gbrain CI |
| Scorecard generator | mixed SHAs or stale receipts | refuses to mix; shows age | stale badge | evals |
| `doctor --invariants` on a real brain | false positive | read-only; reports counts, no repair | warning with invariant name | gbrain |
| G2 identity fix | migration on user brains | backfill; additive forward-only migration (corrected in eng) | none if correct | gbrain, eng phase |
| AMB adapter | harness error on a dataset | error counted; dataset row marked incomplete | incomplete row, not a zero | evals |

**Failure Modes Registry (capability level).**
```
  CAPABILITY            | FAILURE MODE                     | RESCUED? | TEST?   | USER SEES?        | LOGGED?
  ----------------------|----------------------------------|----------|---------|-------------------|--------
  all.ts aggregation    | gate passes on crash-free no-op  | Y (E1)   | Y (E1)  | FAIL               | Y
  LME headline          | tuned on test set                | Y (split)| Y       | selection set shown| Y
  LME harness           | two copies drift                 | Y        | Y parity| n/a                | Y
  Page-grain fusion     | ranking regression for users     | Y        | Y (G1)  | receipts in PR     | Y
  Nightly regression    | issue flood                      | Y        | unknown | one issue          | Y
  Paid runs             | overspend                        | Y        | unknown | refusal            | Y
  CI budget             | H tier exceeds 900 s             | partial  | N       | CI timeout         | Y
  Captured queries      | committed publicly               | Y        | N       | Silent             | N
```
The captured-queries row has TEST=N and would be silent if it happened. It is
treated as a **CRITICAL GAP** until the eng phase adds a check (it did; see eng
phase). The CI-budget row is handed to eng.

**Dream state delta.** After this plan: most capabilities measured, honest public
numbers, P0 data loss fixed, a scorecard that refreshes itself per release, and
neutral external rows. Still short of the 12-month ideal: LongMemEval-V2 and action
benchmarks (deferred), multimodal memory, and other systems running gbrain-evals.

**CEO completion summary.**
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION (autoplan override)     |
  | System Audit         | 60 open PRs, 10 overlap Phase 0; 2 LME      |
  |                      | harnesses; off-master pin                   |
  | Step 0               | 4 premise fixes, 18 proposals, 13 accepted  |
  | Section 1  (Arch)    | 3 issues found (1 critical, fixed)          |
  | Section 2  (Errors)  | 11 error paths mapped, 2 GAPS (fixed)       |
  | Section 3  (Security)| 6 issues found, 4 High severity (mitigated) |
  | Section 4  (Data/UX) | 5 edge cases mapped, 1 unhandled (to eng)   |
  | Section 5  (Quality) | 3 issues found                              |
  | Section 6  (Tests)   | Diagram deferred to eng, 2 gaps             |
  | Section 7  (Perf)    | 1 issue found                               |
  | Section 8  (Observ)  | 3 gaps found (fixed)                        |
  | Section 9  (Deploy)  | 2 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 11 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 8 total, 1 CRITICAL GAP (closed in eng)     |
  | TODOS.md updates     | 5 items proposed (repos read-only; §13)     |
  | Scope proposals      | 18 proposed, 13 accepted                    |
  | CEO plan             | written (ceo-plan.md)     |
  | Outside voice        | codex: unavailable (not installed)          |
  | Lake Score           | 13/13 recommendations chose complete option |
  | Diagrams produced    | 3 (architecture, dream state, receipt flow) |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```

### DX phase (Phase 2.5)

Product type: developer tool (a benchmark harness driven from the command line,
plus gbrain CLI flags), with published docs as a secondary surface. Mode: DX POLISH
(autoplan override). Prior DX reviews: none on record.

**Target developer persona.**
```
TARGET DEVELOPER PERSONA
========================
Who:       an engineer building an agent who is choosing a memory system
Context:   lands on the gbrain or gbrain-evals README from a comparison thread
Tolerance: about 5 minutes and zero paid API calls before deciding
Expects:   a matched comparison table, a way to check the numbers, one command to see it run
```
Secondary persona: a gbrain contributor who needs a before/after receipt for a PR.

**Developer empathy narrative (today, grounded in README lines 82-104).**
"I clone gbrain-evals because the gbrain README says it is the evidence. The README
opens with six paragraphs of hedged prose and no table, so I still don't know where
gbrain stands. Under 'Try a small experiment' I run the keyless command. It finishes
in under a second, but it ranks documents by matching words; gbrain never ran. To see
gbrain I need an OpenAI key and paid embedding calls, and even then the 'gbrain' row
in that runner is a parser for four question templates, not the product's search. I
want to check the 95.53% number. The README links a refresh report, which says the
per-question files came from a harness in the other repository. There are Python
verifiers in `scripts/`, but nothing tells me they exist. After ten minutes I have
learned how BM25 does on a fictional corpus and I still can't confirm a single
headline myself." Observed: README content and runner behavior from the audits.
Predicted: the reader's conclusions.

**Competitive DX benchmark.**

| Tool | Start → result | Time + evidence type | DX choice | Source |
|---|---|---|---|---|
| AMB harness | clone → first scored run | unknown; needs Python 3.11, `uv`, a Gemini key | `uv run amb run ... --query-limit 20`, oracle mode, `amb view` browser | AMB GitHub README |
| npm memory test tool | `npx` → score | reported as one command; in-memory baseline needs no key | MCP provider, badge output | tool's GitHub README |
| gbrain-evals today | clone → see gbrain's retrieval against baselines | estimated: not possible without a key; about 5-10 min with one | multi-adapter runner | README, docs audit B6 |
| gbrain-evals after plan | clone → verify + demo tables | target under 5 min; verify under 30 s, demo under 60 s | `bun run verify`, `bun run demo` | this plan §14 |
Boundaries differ across rows (a hosted viewer shows numbers without running
anything), so only the DX choices are compared, not the times.

**TTHW assessment.** Current: the documented keyless path never runs gbrain, and no
documented path verifies a headline, so the first useful result is unreachable
without a key (Red Flag). Target: Competitive, under 5 minutes from `git clone` to
the verify and demo tables, keyless.

**Magical moment specification.** "Every number in the README recomputes from the
raw receipts on my laptop, offline, in under 30 seconds, and each line names the
gbrain commit that produced it." Vehicle: `bun run verify`, wrapping the existing
verifiers and manifest hash check, followed by `bun run demo`. Requirements: no API
key, no network after install, non-zero exit on any mismatch, output that names the
receipt file for each number.

**Developer journey map.**
```
STAGE           | DEVELOPER DOES                       | FRICTION POINTS                          | STATUS
----------------|--------------------------------------|------------------------------------------|--------
1. Discover     | reads README top                     | no "where gbrain stands" table (B6)      | fixed (§8, generated table)
2. Install      | clone, bun install --frozen-lockfile | lockfile drift, inert patch, postinstall | fixed (E2 cleanup + preflight)
3. Hello World  | runs the keyless command             | runs BM25 only, never gbrain             | fixed (verify + demo)
4. Real Usage   | tries to reproduce a headline        | headline came from another harness       | fixed (one harness, reproduce blocks)
5. Debug        | a category fails or skips            | skipped shown as FAIL (C-18)             | fixed (error standard)
6. Upgrade      | re-runs after a gbrain release       | pin off master; stale receipts           | fixed (release scorecard, v1 readable)
```

**First-time developer confusion report (today).**
```
FIRST-TIME DEVELOPER REPORT
============================
Persona: agent engineer choosing a memory system
Attempting: gbrain-evals getting started
CONFUSION LOG:
T+0:00  Reads README. Prose, no table. Unsure what the headline claim is.
T+1:00  Clones and installs. Install time unknown (two git-pinned gbrain copies).
T+2:30  Runs the keyless command. A BM25 table appears in under a second. Unclear why gbrain is absent.
T+3:30  Reads that the other adapters need OPENAI_API_KEY. Stops or pays.
T+5:00  Looks for how to check 95.53%. Finds a refresh report pointing at gbrain's repo. Gives up on verifying.
```
Addressed: T+0 (generated table), T+2:30 (demo), T+3:30 (verify is keyless),
T+5:00 (reproduce blocks and one harness). Install time stays unmeasured until the
CI timing job exists.

**DX dual voices, consensus table.**
```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Subagent  Codex  Consensus
  1. Getting started < 5 min?          N/A       N/A    N/A
  2. API/CLI naming guessable?         N/A       N/A    N/A
  3. Error messages actionable?        N/A       N/A    N/A
  4. Docs findable & complete?         N/A       N/A    N/A
  5. Upgrade path safe?                N/A       N/A    N/A
  6. Dev environment friction-free?    N/A       N/A    N/A
Subagent: not run (task limit). Codex: not installed. No cell is CONFIRMED.
```
**Independent adversarial pass (primary reviewer, not an outside voice).** As a
developer comparing three memory systems: the plan fixed the evidence but first had
no keyless way to watch gbrain work and no way to check a number without trusting
the author. `bun run verify` is the strongest answer a benchmark repo can give a
skeptic, and it costs little because the verifiers exist. The residual risk is
install time, which nobody has measured.

**Pass 1, Getting Started: 3 → 8.** Before: the keyless path never runs gbrain. After:
four commands, keyless, with verify and demo. Not 10 because install time is
unmeasured and two git-pinned gbrain installs may be slow.

**Pass 2, API/CLI design: 5 → 7.** Before: `BRAINBENCH_N` is read by only some
runners, category names are `catNN` with gaps and letters, and there is no standard way
to point a runner at a local gbrain. After: registry IDs with aliases, `--tier`,
`--category`, `--gbrain`, `--budget-usd`, `--allow-mixed-sha`, and
`gbrain doctor --invariants` following the existing doctor shape. Not higher because
`BRAINBENCH_N` semantics remain per-runner until each runner is migrated.

**Pass 3, Error messages: 3 → 7.** Traced three paths. (1) Missing key: today a
skipped category prints "✗ FAIL" (C-18); after, SKIPPED with reason, cost and next
command. (2) Mixed SHAs: today silently mixed (F7); after, a refusal naming both SHAs
and the fix. (3) Paid overspend: today no guard; after, an estimate and a required
flag. The invariant checker's message names the invariant, the files, the likely
cause and states nothing changed. Score stays at 7 until messages exist in code.

**Pass 4, Documentation: 4 → 8.** Generated scorecard, README table, reproduce blocks
and `docs/CATEGORIES.md` from the registry. The two protocol reports missing from
the docs index (B7) are covered by E2.

**Pass 5, Upgrade path: 4 → 7.** Receipts v1 readable, Cat aliases, CHANGELOG notes
for the ranking change (with a replay command users can run on their own brain) and
for the `page_identity` migration. Not higher: there is no automated check that old
receipts still validate after a schema bump; the eng phase adds it.

**Pass 6, Developer environment: 5 → 7.** `--gbrain <path>`, the H tier runs without
secrets in CI, a pre-migrated PGLite snapshot speeds tests, and `receipts:diff`
shortens the contributor loop. Windows is untested and out of scope.

**Pass 7, Community & ecosystem: 5 → 6.** MIT license and `eval/CONTRIBUTING.md`
exist. The generated docs now say which categories any memory system can run. Other
systems running gbrain-evals as a harness is deferred (platform potential in CEO).

**Pass 8, DX measurement: 2 → 7.** A report-only CI job times clean clone → verify →
demo and writes the result to the scorecard. Human first-visit time stays
unmeasured.

**DX scorecard.**
```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
|----------------------|--------|--------|--------|
| Getting Started      |  8/10  |  3/10  | +5 ↑   |
| API/CLI/SDK          |  7/10  |  5/10  | +2 ↑   |
| Error Messages       |  7/10  |  3/10  | +4 ↑   |
| Documentation        |  8/10  |  4/10  | +4 ↑   |
| Upgrade Path         |  7/10  |  4/10  | +3 ↑   |
| Dev Environment      |  7/10  |  5/10  | +2 ↑   |
| Community            |  6/10  |  5/10  | +1 ↑   |
| DX Measurement       |  7/10  |  2/10  | +5 ↑   |
+--------------------------------------------------------------------+
| TTHW                 | <5 min target | unreachable keyless today    |
| Competitive Rank     | Competitive (target)                         |
| Magical Moment       | designed via `bun run verify` + `bun run demo`|
| Product Type         | Developer tool (CLI harness) + docs          |
| Mode                 | POLISH                                       |
| Overall DX           |  7/10  |  4/10  | +3 ↑   |
+====================================================================+
| DX PRINCIPLE COVERAGE                                               |
| Zero Friction      | covered (keyless verify + demo)                |
| Learn by Doing     | covered (demo, reproduce blocks)               |
| Fight Uncertainty  | covered (error standard)                       |
| Opinionated + Escape Hatches | covered (tiers default; --allow-mixed-sha, --gbrain) |
| Code in Context    | covered (contributor golden path)              |
| Magical Moments    | covered (offline recount)                      |
+====================================================================+
```
No dimension is below 6.

**DX implementation checklist.**
```
DX IMPLEMENTATION CHECKLIST
============================
[ ] Time from clone to verify + demo tables < 5 min, keyless (CI timing job)
[ ] Install is `bun install --frozen-lockfile` and succeeds on a clean clone
[ ] `bun run verify` recomputes every published number offline in < 30 s, exits non-zero on mismatch
[ ] `bun run demo` shows gbrain hybrid vs BM25 vs vector in < 60 s with the plumbing label
[ ] Every runner error and skip prints problem + cause + fix + next command
[ ] Registry IDs guessable; old Cat numbers work as aliases
[ ] `--tier H` is the default for all.ts with no keys set
[ ] README reproduce blocks copy-paste and run as written
[ ] `docs/CATEGORIES.md` generated from the registry, with system-agnostic labels
[ ] Receipts v1 still validate; scorecard labels them legacy
[ ] gbrain CHANGELOG explains the ranking change and the replay check
[ ] H tier runs in CI with no secrets
[ ] Paid runs refuse without --budget-usd
[ ] CHANGELOG entries in both repos for every user-visible change
```

**What already exists (DX).** `eval/CONTRIBUTING.md` (adapter format), the keyless
BM25 run in the README, `scripts/verify-published-longmemeval.py`,
`scripts/verify-documentation-refresh.py`, the receipt manifest hash check, and gbrain
`doctor` output conventions. The plan reuses all of them.

**NOT in scope (DX).** A hosted results viewer; Windows support; a prebuilt artifact
to reach the under-2-minute tier; the npm MCP-driven tool (§13).

<!-- autoplan-accepted:dx -->
- Golden path for the evaluating engineer: clone, `bun install --frozen-lockfile`, `bun run verify`, `bun run demo`; keyless; under 5 minutes; verify under 30 seconds and demo under 60 seconds; verified by a report-only CI timing job in a fresh container.
- `bun run verify` wraps the existing verifiers and manifest hash check, names the gbrain SHA per headline, needs no network after install, and exits non-zero on any mismatch; CI runs it.
- Verify and demo start with a preflight that checks the Bun version and installed gbrain pin and prints the fix.
- Every README headline row has a generated "reproduce this number" block with command, keys, estimated cost and last run time.
- Every runner accepts `--gbrain <path>` / `GBRAIN_UNDER_TEST`; receipts record the declared pin and the loaded code.
- `bun run receipts:diff A B` prints paired gains and losses using the paired-delta scorer.
- `bun run category:new <id>` scaffolds runner, registry entry with spec, and a test file with negative, presence and solvability controls (taste decision #53).
- Error standard: problem, cause, fix and next command for runner skips and failures, mixed-SHA refusal, paid-run guard refusal and invariant violations; skipped categories never print as FAIL.
- `docs/CATEGORIES.md` generated from the registry, including a system-agnostic or gbrain-only label per category.
- Receipts v1 remain readable and are labeled legacy; old Cat numbers work as registry aliases; gbrain CHANGELOG documents the page-grain ranking change with a `gbrain eval replay --against` check and the `page_identity` migration with its upgrade note.
- AMB runs start with `--oracle` and `--query-limit 20` smoke per dataset; the Gemini key and its cost are part of the estimate.
<!-- /autoplan-accepted:dx -->

### Eng phase (Phase 3, runs last)

Target: the Implementation plan as amended by the CEO and DX phases. Test framework:
`bun test` in both repositories (gbrain `package.json` scripts; gbrain-evals
`"test": "bun test test/eval/"`). Retrospective: gbrain-evals history shows the
same classes of issue recurring (the August audit, the Sep 9 errata, now five more
wrong numbers), which is why the plan leans on generated docs and verify. Search
check: done for AMB during DX; no other new infrastructure pattern needed research
(GitHub Actions concurrency groups and `repository_dispatch` are standard).

**Scope Challenge A: findings.** Each quotes the code that motivates it.
1. `[P1] (confidence: 9/10) gbrain package.json exports` — the only eval export is
   `'./eval/longmemeval/reader'`, and the harness entry is
   `export async function runEvalLongMemEval(args: string[], runOpts: RunOpts = {})`
   (`src/commands/eval-longmemeval.ts:602`), a CLI function. The plan's "thin
   wrapper over the public entry" had nothing to wrap. Fixed: new export and typed
   API (§4 item 2, decision #63).
2. `[P1] (confidence: 9/10) src/core/search/hybrid.ts:2952-2955` —
   `` return `${source}:${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`; ``
   confirms chunk-grain fusion. Changing it moves the existing qrels baselines in
   `test/fixtures/eval-baselines/qrels-search.json`, which `gbrain eval gate` checks.
   Fixed: G1 regenerates them under a regression contract (#64).
3. `[P1] (confidence: 8/10) src/core/migrate.ts` — migrations are forward-only; no
   down path exists. The CEO phase's "down-migration" wording was wrong. Fixed:
   additive table, code revert is the rollback (#65).
4. `[P2] (confidence: 9/10) gbrain package.json:149` — `"@dqbd/tiktoken": "^1.0.22"`
   is already a dependency. Receipts v2 use it rather than adding one (#66).
5. `[P2] (confidence: 8/10) gbrain-evals .github/workflows/ci.yml:19` —
   `timeout-minutes: 15` with per-step timeouts of 180-300 s and a suite already at
   682 s. Thirteen more hermetic categories do not fit without sharding and budgets
   (#79).
6. `[P2] (confidence: 8/10) audit evals-correctness "Pin bump" section` — "Bun
   realpaths symlinked test files, so most imports silently resolved back to the
   pin". The `--gbrain <path>` flag would repeat that failure. Fixed: loaded-SHA
   check (#74).
Complexity: well over 8 files and more than 2 new services. Feature list kept
(override: never reduce, #61). Structure: the smaller arrangement was chosen (#62).
Scope record: feature answers #61; structure B (#62); accepted scope: the CEO and
DX accepted blocks plus this phase's block; pending remedies: none.

**Eng dual voices, consensus table.**
```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Subagent  Codex  Consensus
  1. Architecture sound?               N/A       N/A    N/A
  2. Test coverage sufficient?         N/A       N/A    N/A
  3. Performance risks addressed?      N/A       N/A    N/A
  4. Security threats covered?         N/A       N/A    N/A
  5. Error paths handled?              N/A       N/A    N/A
  6. Deployment risk manageable?       N/A       N/A    N/A
Subagent: a second reviewer task was drafted and refused (task limit). Codex: not
installed. No cell is CONFIRMED.
```
**Independent adversarial pass (primary reviewer, not an outside voice).** Hidden
complexity sits in three places: the cross-repo release loop (tokens, concurrency,
merge policy), the claim that one command reproduces every headline (only true
after the LongMemEval export exists), and CI time. All three now have concrete
remedies. The weakest remaining assumption is that keyed nightly runs are cheap
and stable enough to gate on; the plan keeps keyed categories report-only until
their tolerance is calibrated.

**Section 1, Architecture.** Diagram in §15. Findings: (a) cross-repo release
publishing needs a scoped token and PR landing (#67); (b) two writers to the receipts
tree need a concurrency group (#68); (c) nightly regression needs a noise-aware
definition (#69); (d) the invariant checker and the N14 ledger answer different
questions and must not be cited for each other (#71); (e) invariants on large brains
need sampling (#70). One realistic failure per integration: the gbrain release
dispatch fires while gbrain-evals `main` is red, and the publish PR fails verify; the
PR stays open with the failure visible, nothing is published, and the next release
retries. Distribution: no new packages are published; the new gbrain export ships
inside the existing npm/Bun install.

**Section 2, Code quality.** Shared-code opportunity accepted: one receipt loader
behind four generators and verify (existing callers: `all.ts` aggregation and the
receipt manifest test both parse receipts today; proposed callers: scorecard,
categories, spend, verify). Estimated implementation lines: about 150 added for the
loader, about 200 saved against four separate readers; tests may make the total
grow. Rejected extraction: merging `gbrain eval compare` bootstrap code into
gbrain-evals; it stays in gbrain and is called, not copied. Error-handling gaps
fixed: duplicate probe ids (#73), symlink overlays (#74). Stale diagram audit: the
CEO-phase architecture diagram is superseded by §15's diagram (it lacked the publish
module and workflows); no diagrams exist in files this plan touches yet.

**Section 3, Test review.**
```
CODE PATHS                                              USER FLOWS
[+] gbrain-evals eval/registry.ts (new)                 [+] Evaluating engineer golden path
  ├── [GAP] load + alias resolve                           ├── [GAP] [→E2E] clone → verify → demo < 5 min
  ├── [GAP] unregistered runner fails                      └── [GAP] reproduce block runs as written
  └── [GAP] glob-based diff selection                   [+] Contributor loop
[+] eval/runner/receipt.ts (v1 → v2)                      ├── [GAP] --gbrain local run records loaded SHA
  ├── [★★ TESTED] v1 validation (existing tests)          └── [GAP] receipts:diff paired output
  ├── [GAP] mixed-SHA refusal                           [+] Error states
  ├── [GAP] publishable requires completion                ├── [GAP] missing key → SKIPPED + next command
  └── [GAP] duplicate probe id fails                       ├── [GAP] paid guard refusal with estimate
[+] eval/publish/ + verify (new)                           └── [GAP] invariant violation message
  ├── [GAP] each generator from fixture receipts
  └── [GAP] verify fails on hand-edited number
[+] eval/runner/longmemeval.ts → gbrain export
  ├── [GAP] 25-question parity
  └── [GAP] no input contains "answer_"
[+] gbrain src/core/search/hybrid.ts (page-grain RRF)
  ├── [GAP] fusion probe (A beats B) — probe exists in audit scratch
  ├── [★★ TESTED] qrels gate (existing, baselines regenerated)
  └── [GAP] [→EVAL] Cat13 / LME held-out / NamedThingBench before-after
[+] gbrain doctor --invariants (new)
  ├── [GAP] positive + negative fixture per invariant
  └── [GAP] sampling above 20k pages
[+] gbrain import/sync/facts/cycle (G2, G3)
  └── [GAP] audit repros A1 A2 A3 C1 B1 B2 B3 C2 C3 (repro code exists in audit scratch)
[+] Workflows (PR job, nightly, release dispatch, publish)
  └── [GAP] [→E2E] dispatch dry run, concurrency, nightly issue dedupe
LLM integration: [GAP] [→EVAL] judge hardening re-run; dream write guards (Cat35 +
idempotence); contradiction flow (N2)

COVERAGE: 2/31 paths tested today (all new work is unbuilt) | every GAP has a named test in §15 and test-plan.md
QUALITY: ★★:2 | GAPS: 29 (3 E2E, 3 eval)
```
Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke check. Every gap is
a required test for work that does not exist yet, not a missing test for shipped
code. The regression rule applies to G1, G2 and G3; their contracts are in §15
(#75, #76). Test plan artifact: `test-plan.md`.

**Section 4, Performance.** (a) `doctor --invariants` full scans are O(pages) with a
re-parse each; sampled above 20,000 pages (#70). (b) Evals CI time (#79). (c)
LongMemEval-M ingest: reuse the existing content-addressed embedding cache
(`eval/runner/longmemeval-cache.ts`) and compute unique-session tokens before
running (already in §6). (d) N6's op × caller × scope matrix grows multiplicatively;
generate pairwise combinations plus every op with each caller, which keeps it
linear in ops. (e) Page-grain fusion adds one group-by over at most a few hundred
candidates per query; no measurable cost expected, and latency item 7 measures it.

**Failure modes registry (eng, codepath level).**
```
  CODEPATH                    | FAILURE MODE                          | RESCUED? | TEST?        | USER SEES?             | LOGGED?
  ----------------------------|---------------------------------------|----------|--------------|------------------------|--------
  hybrid.ts page-grain RRF    | ranking regression on exact lookups   | Y revert | Y contract   | CHANGELOG + receipts   | Y
  eval gate baselines         | stale baselines after G1              | Y        | Y            | CI failure             | Y
  LME export + wrapper        | harness drift                         | Y        | Y parity     | CI failure             | Y
  receipt.ts v2               | mixed SHAs aggregated                 | Y refuse | Y            | refusal message        | Y
  receipt.ts v2               | duplicate probe ids merged            | Y fail   | Y            | failure message        | Y
  publish module              | generated doc drifts from receipts    | Y verify | Y            | CI failure             | Y
  --gbrain overlay            | tests pinned code, not local          | Y SHA    | Y            | mismatch error         | Y
  doctor --invariants         | slow on huge brain                    | Y sample | Y            | sample size shown      | Y
  release dispatch            | fires while evals main is red         | Y PR     | Y dry run    | open PR, nothing pub.  | Y
  nightly                     | flaky keyed metric opens issues       | Y tol.   | Y            | one issue, updated     | Y
  captured-query calibration  | real queries committed publicly       | Y        | Y (below)    | CI failure             | Y
  page_identity migration     | revert leaves table                   | Y        | Y            | nothing                | Y
```
The CEO phase's CRITICAL GAP (captured queries could be committed silently) is
closed here: gbrain-evals CI adds a check that fails when any committed file under
the calibration output path contains raw query text rather than weights or the
synthetic replay set. No critical gaps remain.

**What already exists.** See Implementation plan §12 and the DX list. Additions
from this phase: `@dqbd/tiktoken` (tokenizer), `longmemeval-cache.ts` (embedding
cache), `test/fixtures/eval-baselines/qrels-search.json` (existing regression
baseline), and the audit repro sources under `audit/scratch-*`.

**NOT in scope.** See §13 (including the TODOS.md entries, all phases). Nothing
further was deferred in this phase.

**Suppressed findings (confidence below 5, appendix).**
- (4/10) The 20,000-page sampling threshold is a guess; measure the full-scan time
  on a 100K-page Postgres brain before fixing the number.
- (4/10) The CI timing job may be noisy on shared runners; treat single runs as
  indicative.

<!-- autoplan-accepted:eng -->
- gbrain adds package export `./eval/longmemeval` with typed `runLongMemEval(options)` returning per-question rows in a stable NDJSON schema; evals `longmemeval.ts` wraps it; a 25-question parity test asserts identical `retrieved_session_ids` versus the CLI.
- G1 regenerates `gbrain eval gate` baselines in the same PR and satisfies the §15 regression contract: NamedThingBench hit@1 and qrels `expected_top1` no worse, Cat13 hybrid ≥ vector-only, LME held-out recall_all@5 not lower, fusion probe as a unit test.
- G2 and G3 satisfy their §15 regression contracts, with audit repros A1, A2, A3, C1, B1, B2, B3, C2, C3 as regression tests.
- `page_identity` ships as a forward-only additive migration; code tolerates an empty table; rollback is a code revert.
- Receipts v2 count tokens with `@dqbd/tiktoken` under a pinned encoding named in the receipt, record the loaded gbrain SHA, and fail runs with duplicate probe ids.
- Registry carries gbrain source globs for diff-aware selection and a regression tolerance per headline metric.
- One publish module with a single receipt loader writes the scorecard, README table, `docs/CATEGORIES.md` and `docs/SPEND.md`; `bun run verify` regenerates them in memory and fails on any difference, then runs the existing verifiers.
- Release publishing: `repository_dispatch` with a token scoped to gbrain-evals; receipts land through a PR that is labeled ready only when verify passes and no headline drops beyond tolerance; a human merges it (no auto-merge); nightly and release share the `receipts-publish` concurrency group.
- Nightly regression requires a paired test at p < 0.05 and a drop beyond the registry tolerance; keyed categories stay report-only until their tolerance is calibrated.
- `doctor --invariants` samples derivable-links and timeline checks above 20,000 pages unless `--full`; supports `--source`; prints sample size; documented as a sync-drift check, with N14's ledger as correctness ground truth.
- `--gbrain <path>` fails when the loaded code's SHA differs from the requested checkout; symlinked overlays are not used.
- LongMemEval-S split is stratified by question type over the 470 answerable questions; abstention is scored by A4.
- gbrain-evals CI is sharded, uses a pre-migrated PGLite snapshot, gives PR-tier categories a 60-second budget each, and fails when committed calibration output contains raw query text.
- Eval runs required by LLM-path changes: judged categories re-run on a fixed set after judge hardening; Cat35 and the dream idempotence fixture after dream write guards; N2 after the contradiction flow.
<!-- /autoplan-accepted:eng -->

**Eng completion summary.**
- Step 0: Scope Challenge — scope accepted as-is (feature list kept); smaller file
  arrangement chosen for publishing.
- Architecture Review: 5 issues found.
- Code Quality Review: 3 issues found (1 accepted extraction, 2 error-handling gaps).
- Test Review: diagram produced, 29 gaps identified (all for unbuilt work; each has a
  named test).
- Performance Review: 5 issues found.
- NOT in scope: written (§13).
- What already exists: written (§12 plus this phase).
- TODOS.md updates: 10 items proposed (listed in §13; not written, repos read-only).
- Failure modes: 0 critical gaps flagged (1 inherited from CEO, closed).
- Unresolved decisions: 0 in this review.
- Outside voice: codex, unavailable (not installed).
- Parallelization: 3 lanes, 3 parallel at launch / categories fan out after
  Foundation.
- Lake Score: 14/14 choices took the complete option.

### Cross-phase themes

- **One source of truth for numbers.** CEO (registry feeds every consumer), DX
  (`bun run verify`, generated docs) and eng (one publish module, verify as
  regenerate-and-diff) all pushed the same way.
- **Reproducibility breaks at repository boundaries.** CEO (two LongMemEval
  harnesses), DX (headline not checkable from the evals repo) and eng (no export to
  wrap; symlink overlays test the wrong code).
- **Noise and overfitting.** CEO (held-out split), eng (stratified split, paired
  regression tests with tolerances).

### Final approval gate (auto-decided)

Plan summary: fix gbrain's seven P0 data-loss bugs and five wrong public numbers,
then build a registry-driven eval foundation, 13 new categories and neutral external
comparisons, and drive measured gbrain improvements through them, with every number
regenerated from receipts at one SHA.

Decisions made: 82 total (76 mechanical, 3 of them conservative choices on one-way
or out-of-bounds steps; 6 taste choices; 0 user challenges).

User challenges: none. With no outside voice, no change to the owner's stated direction
could be confirmed by two models, and no premise was clearly wrong; every premise
fix was additive.

Taste choices a human should glance at:
1. **Mode (#4).** SELECTIVE EXPANSION per the autoplan override and the owner's stance.
   The raw file-count rule would have said SCOPE REDUCTION. Alternative: cut to
   Phases 0-1 first; that ships trust fixes sooner but leaves the differentiators
   unmeasured for weeks.
2. **Release-triggered scorecard (#18).** Keeps evidence fresh; costs a cross-repo
   workflow and a token. Alternative: refresh the scorecard by hand per release.
3. **MemoryAgentBench arms for N2 and N5 (#25).** External checks on the strongest
   stories; adds dataset work. Alternative: internal gold only at first.
4. **LongMemEval-V2 deferred (#31).** Alternative: enter early while its
   leaderboard is nearly empty, at the cost of delaying the scale track.
5. **`category:new` scaffold (#53).** New tooling in a POLISH-mode review; it
   enforces controls on 13+ categories. Alternative: copy an existing runner.
6. **Where the edit fuzzer lives (#72).** In gbrain-evals for independent ground
   truth, with the checker in gbrain. Alternative: host it in gbrain for faster
   in-repo tests.
Also worth a glance (classified mechanical, but they set policy):
- **AMB public submission held for a human go (#12).** Conservative because it is
  one-way. Alternative: submit as soon as results exist.
- **Receipts land by PR with a human merge (#67, amended by the parent after review).**
  The autoplan pass chose auto-merge on verify; Capy's standing rule forbids enabling
  auto-merge without an explicit request, so a human merges every receipt PR.

Auto-decided: 82 decisions (see Decision Audit Trail). Gate: option A, approve
as-is (#81).

Review scores:
- CEO: SELECTIVE EXPANSION, 18 proposals, 13 accepted, 5 deferred; subagent
  unavailable, codex unavailable, consensus N/A.
- Design: skipped (no UI scope).
- DX: 4/10 → 7/10, TTHW unreachable keyless → under 5 min target; subagent
  unavailable, codex unavailable, consensus N/A.
- Eng: 13 issues, 0 critical gaps; subagent unavailable, codex unavailable,
  consensus N/A.

Deferred to TODOS.md: 10 items listed in §13 (not written; both repositories were
read-only).

Pre-gate verification: CEO outputs present (premise challenges, Sections 1-10 plus
11 skipped, registries, NOT in scope, What already exists, dream state delta,
completion summary, consensus table). Design recorded as skipped. DX outputs present
(8 scores, journey map, empathy narrative, TTHW, checklist, consensus table). Eng
outputs present (scope challenge with code quotes, architecture diagram, test
diagram, test plan on disk at `test-plan.md` instead of
`~/.gstack/projects/`, NOT in scope, What already exists, failure modes, completion
summary, consensus table). Every auto-decision has a row. Known deviations: the
native subagent passes did not run, the snapshot tool's amendment and close-packet
steps were not used, and review logs were not written; each is listed under Run
conditions.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via /autoplan) | Scope & strategy | 1 (not persisted to review log) | CLEAR | 18 proposals, 13 accepted, 5 deferred |
| Outside Review | codex via /autoplan | Independent 2nd opinion | 0 | unavailable | codex CLI not installed; no completed external review. Native subagent also unavailable (task limit); primary reviewer ran a labeled adversarial pass per phase |
| Eng Review | `/plan-eng-review` (via /autoplan) | Architecture & tests (required) | 1 (not persisted to review log) | CLEAR | 13 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope (0 UI term matches) |
| DX Review | `/plan-devex-review` (via /autoplan) | Developer experience gaps | 1 (not persisted to review log) | CLEAR | score: 4/10 → 7/10, TTHW: unreachable keyless → under 5 min |

- **OUTSIDE COVERAGE:** codex, CEO phase: unavailable (not installed). codex, DX
  phase: unavailable. codex, eng phase: unavailable. Design phase: skipped. No phase
  has completed external coverage.
- **VERDICT:** CEO + DX + ENG CLEARED by a single reviewer — ready to implement,
  with no outside-model confirmation. Prior review history: `gstack-review-read` was
  not run and no review log was written, per the run's instruction to change only
  the plan and its scratch directory.

NO UNRESOLVED DECISIONS
