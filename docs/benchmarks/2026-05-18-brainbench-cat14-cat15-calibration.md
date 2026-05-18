# BrainBench Cat 14 + Cat 15 — Calibration Loop (v0.36.1.0)

**Date:** 2026-05-18
**gbrain commit:** `04dbab44` (branch `garrytan/asuncion`, v0.36.1.0 Hindsight calibration wave)
**gbrain-evals commit:** `5e179c6` (branch `cat14-calibration`)
**Datasets:**
  - cat14: 8 hand-authored probes (`eval/data/cat14-calibration/probes.jsonl`)
  - cat15: 8 synthetic pages + 48 hand-labeled claims (`gbrain/test/fixtures/calibration/`)
**Hardware:** Apple Silicon M-series, single-threaded (LLM calls dominate wallclock)
**Run cost:** ~$0.15 total (cat14 ~$0.05 + cat15 ~$0.10) — both runs in under 5 minutes wallclock

## 1. Headline

**gbrain v0.36.1.0 ships the first published benchmark for personal-AI calibration loops — measuring whether an AI that knows the user's track record actually produces better advice than one that doesn't.**

- **cat14 (advice quality):** `think --with-calibration` wins 75% of probes against baseline, **0% baseline wins**, 25% ties. Voice gate 100%, force-fit prevention 100%.
- **cat15 (claim extraction):** propose_takes prompt scores **0.952 F1 on training, 0.922 F1 on holdout**, with a 0.03 train-holdout gap (no overfitting signal).

Both gates pass on first live run against the v0.36.1.0 prompt set. No prior baseline exists in the published-personal-AI-benchmark space — the [Hindsight skill](https://github.com/rayan-arya/hindsight-skills) introduced the calibration-loop concept but did not publish quantified evaluation. cat14 + cat15 stake out a measurable category: AI memory systems that don't just recall facts but reason about the user's own past wrongness.

| Configuration | cat14 win rate (calibrated vs baseline) | cat15 F1 (train/holdout) | Cost / 100 probes |
|---|---|---|---|
| **gbrain v0.36.1.0 (this wave)** | **75% / 0% / 25% tie** | **0.952 / 0.922** | ~$1.50 |
| baseline `think` (no calibration) | reference | n/a | n/a |
| Hindsight skill (prior art) | not published | not published | n/a |

The 75% win rate is the load-bearing number. It means: **on questions where the user has a relevant track record, the calibration-aware AI is preferred to plain `think` three times out of four, and is never preferred to it when it's wrong.** Baseline never outright beats calibrated; the 25% ties are cases where both answers were judged equally useful.

## 2. What is the calibration loop

**The premise:** AI memory systems today store facts but don't reason about the user's own bias patterns. If you've been wrong about geography 60% of the time at high conviction, your AI assistant has no idea — it gives you confident geography advice anyway.

**gbrain v0.36.1.0's calibration loop closes this gap with four chained components:**

1. **Extract** (`propose_takes` cycle phase) — LLM scans markdown prose for gradeable claims: predictions, judgments, bets. Output is structured `{claim, kind, domain, conviction}` rows pending operator review. **Measured by cat15.**
2. **Resolve** (`grade_takes` cycle phase + manual review) — judge model verdicts unresolved takes against later evidence. Auto-resolve OFF by default; operator confirms first batch before opting in.
3. **Aggregate** (`calibration_profile` cycle phase) — generates 2-4 plain-English pattern statements like "You called early-stage tactics well — 8 of 10 held up. Geography is your blind spot — 3 of 3 high-conviction geography calls missed." Voice-gated against academic phrasing.
4. **Apply** (`think --with-calibration` flag) — injects the profile into the AI's system prompt with anti-bias rewrite rules. The AI surfaces relevant biases as counter-priors. **Measured by cat14.**

cat14 measures the output side (does step 4 actually improve advice?). cat15 measures the input side (does step 1 find the claims at all?). Together they validate the loop end-to-end.

**What gbrain v0.36.1.0 ships:** all four phases plus the schema migrations (v68-v73 stamping `wave_version='v0.36.1.0'` on every row), a `gbrain calibration` CLI, a `get_calibration_profile` MCP op with cross-brain semantics, an admin SPA Calibration tab with server-rendered SVG charts, four new doctor checks (`abandoned_threads`, `calibration_freshness`, `grade_confidence_drift`, `voice_gate_health`), and the `--undo-wave v0.36.1.0` reversal command for clean rollback.

## 3. Cat 14 — Calibration A/B (advice quality)

### What it measures

For each probe: build two parallel system prompts (baseline vs calibrated), call the same model (Sonnet) on the same user question, send both answers to a Haiku judge with structured tool-use rubric. Score on five axes:

1. `mentions_relevant_bias_tag` — when the question's domain matches a profile bias, does the calibrated answer surface it?
2. `presents_counter_prior` — when a bias is mentioned, are both priors named transparently?
3. `changes_recommendation_meaningfully` — does the calibrated recommendation differ from baseline in a domain-appropriate way?
4. `voice_conversational` — friend-not-doctor language across the whole answer? No "your Brier in domain X" leakage?
5. `doesnt_force_fit_irrelevant_bias` — does the calibrated answer correctly NOT mention an irrelevant bias?

### Probe taxonomy

| Category | n | What it tests |
|----------|---|---------------|
| `calibration-pattern-relevant` | 2 | Bias is relevant; calibrated answer should de-rate the gut prior |
| `calibration-pattern-confidence-boost` | 2 | Track record is positive; calibrated answer should reinforce without manufacturing counter-prior |
| `calibration-empty-profile` | 1 | Cold brain; calibrated must behave identically to baseline |
| `calibration-bias-irrelevant` | 1 | Question's domain doesn't match profile bias; calibrated must NOT mention it |
| `calibration-multi-bias` | 1 | Question touches multiple domains; triage which bias applies |
| `calibration-voice-stress` | 1 | Emotional/hard-call question; voice must stay friend-not-doctor |

### Scorecard

| Axis | Pass rate | Gate threshold |
|------|-----------|----------------|
| mentions_relevant_bias_tag | **100%** | — |
| presents_counter_prior | 75% | — |
| changes_recommendation_meaningfully | 75% | — |
| voice_conversational | **100%** | ≥95% |
| doesnt_force_fit_irrelevant_bias | **100%** | ≥90% |
| **overall win rate (calibrated)** | **75%** | **≥55%** |

The two soft-axis misses (counter_prior 75%, recommendation_change 75%) are both confidence-boost probes where the v1 prompt's "name BOTH priors" rule fires unconditionally and manufactures a fake counter-prior on cases where the track record is *confirming* the gut, not contradicting it. Filed as v0.37 follow-up; not a gate failure.

### The iteration loop closed in practice

Documented in `eval/data/cat14-calibration/iteration-log.md`: three prompt variants were tested same-day on the same probe set. The eval caught two distinct regressions before either could ship:

| Prompt | Win | Voice | Force-fit | Gate |
|--------|-----|-------|-----------|------|
| v1 (original, 5 rules) | 75% | 100% | 100% | **PASS** |
| v2 (split bias direction) | 63% | 88% | 100% | FAIL (voice) |
| v3 (epistemic humility) | 75% | 75% | 75% | FAIL (voice + force-fit) |

v2 and v3 were attempts to fix v1's confidence-boost misses by adding detail to the prompt. Both *regressed* because longer prompts caused the model to leak meta-language into the answer. The 95% voice gate and 90% force-fit gate caught the regressions; v1 was reverted; the iteration log preserves the loop as evidence that the failure-loop methodology produces actionable diagnostic signal — not just metrics.

## 4. Cat 15 — propose_takes F1 (extraction quality)

### What it measures

For each probe: read a fixture page from the synthetic corpus, call the `EXTRACT_TAKES_PROMPT` against the page body via Sonnet, parse the JSON output. Load hand-labeled ground truth (`.gradeable-claims.json`). Send (extracted, ground_truth, page_body) to a Haiku matcher judge with structured tool-use. Judge labels each ground-truth claim as TP/FN (recall side) and each extracted claim as TP/FP (precision side, including duplicates).

Compute precision/recall/F1 per probe; aggregate per split.

### Fixture corpus

8 hand-authored synthetic pages at `gbrain/test/fixtures/calibration/`, modeled on the genre mix observed in a real personal brain (~$5K LOC across `concepts/`, `meetings/`, `daily/`, `writing/`, `people/`):

| Split | n | Genre mix |
|-------|---|-----------|
| training | 3 | concept-with-timeline, meeting-notes, daily-journal |
| holdout | 5 | concept-with-timeline, meeting-notes, daily-journal, essay-on-self-calibration, people-page |

**Privacy:** every fixture uses canonical placeholder names (`alice-example`, `acme-example`, `widget-co`, `fund-a/b/c`) per the CLAUDE.md placeholder allow-list. Privacy CI guard (`scripts/check-synthetic-corpus-privacy.sh`) scans for explicit dollar amounts + verifies placeholder presence per page. Zero real-name leakage; zero PII.

**Ground truth:** 48 hand-labeled claims total (21 training + 27 holdout), each tagged with `claim_text`, `kind`, `domain`, `conviction`, `since_date`, plus a `rationale` field explaining why a tuned prompt should infer that conviction value from the prose.

### Scorecard

| Split | Probes | Avg Precision | Avg Recall | Avg F1 | Target | Gate |
|-------|--------|---------------|------------|--------|--------|------|
| training | 3 | 0.917 | 1.000 | **0.952** | ≥0.85 | **PASS** (+10pt) |
| holdout | 5 | 0.920 | 0.931 | **0.922** | ≥0.80 | **PASS** (+12pt) |

**Train-holdout gap: 0.03** (well below the 0.10 overfitting threshold).

### Per-genre breakdown

| Genre | Split | F1 | n |
|-------|-------|----|----|
| concept-with-timeline | training | 1.000 | 1 |
| concept-with-timeline | holdout | 1.000 | 1 |
| meeting-notes | training | 0.857 | 1 |
| meeting-notes | holdout | 1.000 | 1 |
| daily-journal | training | 1.000 | 1 |
| daily-journal | holdout | 0.889 | 1 |
| essay-on-self-calibration | holdout | 0.923 | 1 |
| people-page | holdout | 0.800 | 1 |

The people-page genre is the hardest (F1 0.80) — claims about third parties have softer hedging signal than claims about your own predictions. Concept-with-timeline and meeting-notes are the easiest because they carry explicit conviction language and (in meetings) often a literal `## Takes` section.

### The tuned prompt back-ports cleanly to gbrain

The cat15 runner uses an extract-takes prompt that scored 0.92+ F1 on first live run. That prompt back-ports verbatim to `src/core/cycle/propose-takes.ts:EXTRACT_TAKES_PROMPT` in gbrain commit `04dbab44`, replacing the v0.36.1.0 stub. `PROPOSE_TAKES_PROMPT_VERSION` bumped `v0.36.1.0-stub` → `v0.36.1.0-tuned-cat15`. The next gbrain release ships a real extractor.

## 5. What changes

1. **The calibration wave is no longer aspirational.** Before cat14, "does `think --with-calibration` actually help?" was an article of faith. After cat14: 75% win rate, 0% baseline wins. The feature isn't theater.

2. **The propose_takes phase is no longer stub-gated.** Before cat15, the v0.36.1.0 docs warned that the extractor prompt was a placeholder and shouldn't be relied on. After cat15: a tuned prompt validated against 48 hand-labeled claims at F1 0.92, back-ported into gbrain at commit `04dbab44`.

3. **The failure-loop methodology is reproducible.** The cat14 iteration log proves the eval doesn't just measure — it diagnoses. Three prompt variants tested same-day, two regressions caught by gates before either could ship. Per-probe JSON dumps with judge rationales drive prompt iteration; the README's fix-mapping table converts axis failures into specific file:line targets in gbrain source.

4. **The category is now measurable.** Hindsight introduced the calibration-loop concept; cat14 + cat15 make it benchmarkable. Any future "AI memory system that applies user track records at advice time" should report on this scorecard.

## 6. Methodology

### cat14 reproduction

```bash
cd ~/git/gbrain-evals
git checkout cat14-calibration
bun install

# Live (~$0.05, ~2 min wallclock)
ANTHROPIC_API_KEY=... bun eval/runner/cat14-calibration.ts

# Hermetic smoke (no API key)
bun test eval/runner/cat14-calibration.test.ts

# Single probe (debugging)
CAT14_PROBES=cat14-pos-1-geography ANTHROPIC_API_KEY=... bun eval/runner/cat14-calibration.ts
```

### cat15 reproduction

```bash
cd ~/git/gbrain-evals
git checkout cat14-calibration
bun install

# Live (~$0.10, ~3 min wallclock)
ANTHROPIC_API_KEY=... \
  CAT15_CORPUS_DIR=~/path/to/gbrain/test/fixtures/calibration \
  bun eval/runner/cat15-propose-takes.ts
```

### Models

- Extractor (cat15): `claude-sonnet-4-6`
- Calibrated/baseline answer generator (cat14): `claude-sonnet-4-6`
- Matcher / scoring judge: `claude-haiku-4-5-20251001`

### Determinism + variance

LLM stochasticity is real but bounded by the structured tool-use output. The cat14 iteration log shows three back-to-back runs of the v1 prompt converged to within ±2 percentage points on each axis. The cat15 F1 numbers reproduced within ±0.02 across two runs of the same prompt. Bigger probe counts would tighten the bound; 8 probes per category is enough for go/no-go gating but not for ranking minor prompt variants — that's why the iteration log emphasizes per-probe rationale-reading over single-percentage chasing.

### Synthetic corpus design choices

The cat15 corpus is intentionally synthetic, not real-brain extract. Three reasons:

1. **Privacy.** A real-brain corpus committed to a public eval repo leaks the user's network forever. The CI privacy guard exists to prevent that.
2. **Ground-truth knowability.** Synthetic pages have known gradeable-claim labels by construction (hand-authored alongside the prose). Real-brain pages would require labor-intensive labeling against a moving target.
3. **Genre coverage by design.** The synthetic corpus covers 5 distinct prose genres on purpose. A real-brain extract would over-sample the user's dominant writing style.

A v2 shadow eval against an anonymized real-brain export is the natural follow-up — flagged in the cat14 README under "v2 follow-up."

## 7. SOTA framing

To the author's knowledge:

- **No prior published benchmark** measures whether an AI memory system applies user track records at advice time. Hindsight introduced the concept as a skills demo without quantified evaluation. AI memory benchmarks like LongMemEval measure recall accuracy, not bias-aware reasoning quality.

- **gbrain v0.36.1.0 + cat14 + cat15 stake out the category.** 75% calibrated-vs-baseline win rate is the baseline future systems will publish against; 0.92 F1 on prose-claim extraction is the baseline future extractors will publish against.

- **The honest comparison set is small.** Hindsight didn't publish numbers. Personal-AI projects like Mem0, MemPalace, and Notion AI don't ship a calibration loop. Academic work on AI calibration (Lichtenstein/Fischhoff 1977 onward) covers human forecaster calibration, not memory-system implementations.

The category is open. cat14 + cat15 are an invitation to other personal-AI builders: publish your numbers.

## 8. Known gaps to close in v2

1. **Hindsight-style bias-tag taxonomy is informal.** cat14 probes use ad-hoc tags (`over-confident-geography`, `well-calibrated-tactics`). A formal taxonomy with stable IDs would let cross-implementation comparison work. v0.36.1.0's `src/core/calibration/canonical-patterns.ts` is the seed — extending to ~30 named patterns with worked examples per pattern is the v2 surface.

2. **Probe count is small.** 8 cat14 probes is enough for go/no-go gating but not for ranking minor prompt variants. 30+ probes would let iteration log distinguish judge variance from real regression. Cost: ~$0.20 per full run at that scale.

3. **No real-brain shadow eval.** Synthetic corpus validates that *the pipeline works*; an anonymized real-brain run would validate that *it works on real prose*. The v0.36.1.0 corpus-build workflow at `~/.claude/plans/system-instruction-you-are-working-rippling-knuth.md` documents the privacy-preserving real-brain export process; running cat15 against that output is a v2 follow-up.

4. **Judge variance unbounded.** Same probe + same model + same judge model produces slightly different scores across runs. Mitigation: structured tool-use bounds the variance to ±2pp on each axis empirically. Tightening further would require multi-judge consensus (judge ensemble), which the gbrain wave's E2 multi-judge ensemble grading substrate already implements — wiring it into the eval runner is straightforward and a v2 follow-up.

5. **propose_takes prompt is tuned against a single model (Sonnet).** F1 0.92 reproduces on Sonnet; cross-model behavior (Opus, Haiku, gpt-4o) is unmeasured. The gbrain gateway abstraction means the prompt is portable, but each model has its own quirks. v2 expands cat15 to a 4-model matrix.

6. **calibration_profile narrative quality is not benchmarked.** cat14 measures the *output* of the calibration loop (does the AI use the profile?). It does not measure whether the profile *itself* accurately describes the data. A cat16 narrative-quality eval — judge scores whether the LLM-generated 2-4 sentence pattern statement actually matches patterns present in the resolved takes — is the next eval to build. Same matcher-judge pattern as cat15.

7. **Voice gate measured at output, not at narrative-generation.** Voice axis in cat14 measures whether the *answer* stays conversational. The upstream voice gate in `src/core/calibration/voice-gate.ts` runs on the profile *narrative* before it reaches `think`. A direct eval of the voice-gate rubric — feed 20 pinned exemplars (10 conversational, 10 academic) and verify rubric pass rate — would close the upstream gap. ~2 hours of work.

## Run timestamps + per-probe data

Per-probe JSON dumps with full prompts, answers, and judge rationales:

- cat14: `eval/reports/cat14-calibration/cat14-*.json` (8 files + `_summary.json`)
- cat15: `eval/reports/cat15-propose-takes/cat15-*.json` (8 files + `_summary.json`)

These dumps are the load-bearing artifact for the failure-feedback loop. When a gate fails in a future run, the dumps + the README's fix-mapping table give an actionable next-step: which file:line in gbrain to edit, what shape the regression took, what the judge specifically flagged.
