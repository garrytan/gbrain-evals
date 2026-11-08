# Offline skill ranker eval: Step 1 fails on the no-skill gate, though ranking beats static lists (GBRA-377 Step 1)

Written 2026-11-07 for GBRA-377 (GST-1860), the plan for a general-purpose skill resolver in [gbrain](https://github.com/garrytan/gbrain). Agents now carry hundreds of skills (written procedures they can load before acting), but harnesses show the model only a short list, and some cut that list alphabetically. The plan is a per-turn resolver: a prebuilt word index ranks the harness's skills against each user message, shows the top 5 in a small block, and shows nothing when no skill applies. This offline eval was to decide whether that resolver gets built and to freeze its constants. Plan and decision rule: [the preregistration](2026-11-07-skill-ranker-offline-preregistration.md) (its four amendments win where they differ from the text above them). Raw results: [2026-11-07-skill-ranker-offline/](2026-11-07-skill-ranker-offline/).

**Finding: as preregistered, Step 1 fails. No deployable arm passes, so PR A should not start as planned.** The failure is the "no skill applies" gate, not the ranking. With the gate off, word matching over name, description and a 4 KB slice of the skill body (arm A5) puts an acceptable skill in its top 5 on 48%, 52% and 58% of skill-seeking turns at 250, 750 and 1,500 skills, against 33%, 28% and 18% for the best static list of the same size (about 200 tokens). But the preregistered gate turned out to be inverted (it favours short messages, and the no-skill turns are short), so it suppressed every skill turn and every arm scored 0. A repaired gate fixed after the dev run and before any test cell (raw top score) still fails: it keeps false suggestions under 20% only by hiding most correct blocks, it drops almost every terse request such as "Audit this repo's dependencies and CI configuration", and its false-suggestion rate climbs from 2% to 18% as the catalog grows. Even a threshold tuned on the test set itself tops out at 27 to 32% gated hit@5 for the deployable arms.

**Verdict (R48): FIX-METHOD.** The ranker earns its keep: at matched tokens it beats every static list by 14 to 40 points of hit@5 with the gate off. The word-matching no-skill gate is a **CUT-CANDIDATE**: on this evidence it does not need to exist in v1, and with it the resolver cannot pass the preregistered bars. That decision (ship the ranker with no gate and let the behaviour eval police false suggestions, redesign the gate, or stop) goes to GBRA-108.

## The concrete case

Invented example from the test set (placeholders only). The user writes: "Meeting with nora-example at 2. Pull together a quick brief from my notes, calendar and email: who she is, why we're talking, what we promised last time, and anything I still owe her." The judge, reading all 1,500 skills, accepts gbrain's `briefing`, `daily-task-prep` and `google-loops`. At 750 skills, A5 ranks `briefing` first. The alphabetical cut with descriptions (83 skills, 7,743 tokens) contains none of the three, and of the 200-token static lists only the usage-ordered one, built from dev turns of this same set, contains one.

Now take "What's the difference between a company's valuation and its annual revenue?". No skill applies, but the message shares words with sales and finance skills, so a word ranker returns candidates. Its top score, divided by the most it could score given the message's words (the preregistered normalization), is 0.20, while the brief request above scores 0.10, because a long request leaves many of its words unmatched. A gate on that number lets the near miss through and stops the real request.

## The experiment

**Catalog.** 1,500 public skills: gbrain's 71 bundled skills and gstack's 61 (the only ones with `triggers:`), plus 1,368 from 17 permissively licensed repositories, each pinned to a commit ([SOURCES.md](2026-11-07-skill-ranker-offline/SOURCES.md)). Only names, descriptions, triggers, routing rows and the first 4 KB of each body are stored. Sizes are nested: 250 (all gbrain and gstack skills plus 118 public ones), 750 and 1,500. Step 0, which measures where each harness's listing truncates, runs in parallel, so catalog size stands in for "everything visible" against "truncated".

**Variants.** D, description-only (primary, since most harness catalogs have no triggers): name, description and, for A5, the body. T, with triggers: adds triggers and gbrain's RESOLVER.md routing rows where the source has them (132 of 1,500 skills).

**Turns.** 300, written by `gpt-6.1-sol` from 45 hand-written task areas (for example "a code change is ready and the user wants it tested, versioned, described and put up for merge"); the writer never saw a skill name or description. Per area: 5 skill-seeking turns and 1 near miss; plus 30 generic no-skill turns. Labels come from `claude-opus-5-5`, a different model family, reading the whole 1,500-skill catalog (189K tokens, cached) with no arm output in view: each turn gets its acceptable skills (2.3 on average) or none. 87 turns ended up no_skill_needed. Split: 60 dev turns (the only data used to tune anything) and 240 test turns, frozen by sha256 before any arm ran. Amendment 2 added a 100-turn gate-stress set (terse skill requests and long no-skill messages) after dev showed the length confound; 20 of those joined dev for the repaired gate only.

**Arms.**

| Arm | What reaches the model | Kind |
|---|---|---|
| A0 | alphabetical first 11% with full descriptions (the cut ratio of a large real install) | static |
| A1 | every skill name, alphabetical | static |
| A1u | skills ordered by how often dev turns needed them | static |
| A1s | gbrain's spring index (71 bundled skills with triggers) | static |
| A2 | today's `scoreSkillMatch` (src/core/skill-catalog.ts), vendored verbatim; 450,000 score comparisons against gbrain ff11cb91, 0 mismatches | per turn |
| A3 | BM25F (a standard word-ranking formula, here weighting name and description) | per turn |
| A4 | A3 plus triggers and routing rows (equals A3 in variant D) | per turn |
| A5 | A4 plus the first 4 KB of the body | per turn |
| A6 | A4 fused with local embeddings (`nomic-embed-text` on Ollama, localhost) | diagnostic |
| A7 | A4 fused with OpenAI `text-embedding-3-small` | diagnostic |

Static arms are scored by whether any acceptable skill is in the list, at a matched budget of 200 tokens (bytes/4), the size of a 5-line per-turn block. Per-turn arms are scored by hit@1, hit@3, hit@5 and MRR over their ranking, by gated hit@5 (a turn whose block the gate hides counts as a miss), and by false-suggestion rate (FSR): the share of no_skill_needed turns that get a block. Only A0 to A5 could win; A6 and A7 size the gap to embeddings.

## Results

### Ranking, gate off (variant D, test split)

| Skills | Skill turns | A2 hit@5 | A3 hit@5 | A5 hit@5 | A6 hit@5 | A7 hit@5 | Best static at 200 tokens | A5 minus best static (95% CI) |
|---|---|---|---|---|---|---|---|---|
| 250 | 81 | 38.3% | 46.9% | 48.1% | 53.1% | 71.6% | 33.3% (A1, 45 names) | +14.8 (-1.2 to +29.6) |
| 750 | 141 | 29.8% | 44.7% | 51.8% | 50.4% | 63.1% | 27.7% (A1u, 6 lines) | +24.1 (+12.8 to +36.2) |
| 1,500 | 170 | 28.2% | 52.9% | 58.2% | 55.3% | 63.5% | 18.2% (A1u, 6 lines) | +40.0 (+29.4 to +50.0) |

The gap grows with the catalog because a static list of fixed size covers a shrinking share of it. Today's `scoreSkillMatch` is the weakest ranker on description-only catalogs and loses ground as the catalog grows; it also takes 25 ms per turn at 1,500 skills (p50; it re-tokenizes every skill per query), against 0.23 ms for A3 and 1.1 ms for A5 with a prebuilt index.

hit@1 and MRR follow the same order (750 skills: A3 25.5% and 0.33, A5 31.9% and 0.41, A7 34.8% and 0.47). The full table, variant T included, is in [arms-test.json](2026-11-07-skill-ranker-offline/results/arms-test.json).

Static lists at their natural size, for reference: the alphabetical 11% cut (A0) contains an acceptable skill on 3.7%, 8.5% and 10.0% of skill turns while costing 2,642, 7,743 and 14,419 tokens. The spring index (A1s) reaches 40.7% at 250 skills for 1,313 tokens, because the 250-skill catalog holds every gbrain skill. A names-only full list (A1) shows every name for 990, 3,405 and 7,008 tokens; whether a model picks well from names alone is a behaviour question this eval cannot answer.

### The preregistered verdict (gate on)

Every per-turn arm, deployable or not, scores **0% gated hit@5 at every size**: the gate chosen on dev to keep false suggestions at or under 15% hides every skill turn. The tie rule then makes A2 the chosen arm. Bar 1 fails at every size (0.0 against 33.3%, 27.7% and 18.2%), so the verdict is FAIL; bars 2 and 3 are moot. No embedding arm passes either, so this is not a "no deployable winner" case: nothing passes.

Cause: the preregistered gate divides the top score by how much of the message could match (summed idf for BM25F, token count for A2). Short messages score high. The writer produced long skill requests (dev median about 45 content words) and short near misses (about 6), so the gate is inverted. Probe: [scripts/_probe.ts](2026-11-07-skill-ranker-offline/scripts/_probe.ts).

### The repaired gate (Amendment 2, secondary, fixed before any test cell)

Three gate features were added, all tuned on dev plus stress-dev: the raw top score, a length-free "how much does the top hit stand out" ratio, and a length-only control that ignores the catalog. The chosen pair was A3 with the raw top score (threshold 9.25).

| Skills | Gated hit@5, test + stress | Best static | Difference (95% CI) | FSR | Gated hit@5, stress-set skill turns |
|---|---|---|---|---|---|
| 250 | 12.9% | 34.7% | -21.8 (-33.7 to -9.9) | 1.8% | 5.0% |
| 750 | 22.0% | 27.2% | -5.2 (-14.5 to +4.0) | 8.9% | 3.1% |
| 1,500 | 30.3% | 17.8% | +12.5 (+3.8 to +20.7) | 17.9% | 5.3% |

It fails bar 1 at 250 and 750 and bar 3 (FSR spread 16.1 points against at most 5). A raw score grows with message length and with catalog size, so it mostly measures length: the stress set's skill requests, mostly terse, get through 3 to 5% of the time, and long no-skill messages are flagged 14% to 31% of the time at the two larger sizes on the stress set. The ratio feature reaches at most 6% gated hit@5 (A3 5.9%, 1.7% and 0.5%; A5 4.0%, 0.6% and 1.0% at 250, 750 and 1,500 skills). Even the best threshold picked on the test set itself, which is not a valid estimate, reaches only 27 to 32% gated hit@5 for A3 and A5 at FSR at most 20% (A7: 36 to 41%).

### Arm cuts (variant D, 750 skills, gate off)

- Bounded body: A5 beats A3 by 7.1 points (0.0 to 14.2). Kept (bar: 2).
- Local embeddings: A6 beats A3 by 5.7 points (0.7 to 11.3), so it clears the 3-point bar, but it does no better than A5, which needs no model. In variant T it adds 2.8 points over A4 and is cut there.
- Provider embeddings: A7 beats A3 by 18.4 points (10.6 to 25.5) and A5 by 11.3. That clears the plan's 5-point line for asking Garry about provider embeddings, a new data flow in which every user message goes to the vendor. Diagnostic only, and the gate problem applies to it too.
- Triggers (variant T): A4 against A3 is +2.5, -0.7 and +1.2 points at 250, 750 and 1,500. Only 132 skills carry triggers, so this says little about trigger-rich catalogs.

### Labels

A second, independent judge pass gives a mean Jaccard of 0.79 per turn and agrees on "some skill" against "no skill" for 97.7% of turns. Scored on pass-2 labels, the ranking result holds (A5 51%, 49% and 56% against 32%, 26% and 18% for the best static list), and the preregistered verdict is still a FAIL.

## Why null? (R48)

- **Exposure.** The ranker does expose the right skill: with the gate off, A5's block contains an acceptable skill 14 to 40 points more often than any static list of the same size. The gate is what removes it.
- **Task fit.** The target case is right (description-only catalogs, 250 to 1,500 skills, requests across 45 areas). The gate's job is not: telling "needs a procedure" from "a quick question about the same topic" depends on intent, not on vocabulary. The near-miss turns share words with skills by design, and real users do write both.
- **Power and saturation.** 81 to 170 skill turns per size and 70 no-skill turns; intervals are about plus or minus 11 to 15 points. No ceiling: the best static list is at 18 to 35% and the best deployable ranker below 60%. The gate failure is far outside the noise (preregistered bar 1 intervals are -44 to -12).
- **Frontier model without it.** The judge, Opus 5.5 reading all 1,500 descriptions (189K tokens), is a frontier model doing the job without a resolver, and it does it well and consistently. That costs 189K tokens per turn, so it is no substitute in a harness. A names-only full list (990 to 7,008 tokens) is the cheap middle ground; the cross-harness behaviour eval (HARN-52) can measure whether a model chooses well from names.

**Verdict: FIX-METHOD**, with the word-matching no-skill gate as a CUT-CANDIDATE.

## What to use and what to avoid

- **Use the ranker, not the gate.** If GBRA-108 and Garry accept a resolver without a gate, the constants to ship (variant D, frozen on dev) are A5: BM25F with k1 = 1.6, b = 0.75, field weights name 2, description 1, body 0.2 (first 4 KB), top 5, hint cut at 120 characters; blocks average 166 to 183 tokens when shown. With triggers present (variant T): k1 = 0.9, b = 0.75, name 1, description 1, triggers 3, routing 3, body 0.2. The preregistered normalized gate threshold for A5 was 0.342, and it must not ship: it hides every skill turn. The repaired raw-score threshold (9.53 for A5, 9.25 for A3) fails bars 1 and 3 and should not ship either. Without a gate, a block appears on every turn, so false suggestions are 100% of no-skill turns at about 180 tokens each; gbrain's session dedupe and "empty when unchanged" rules limit how that piles up, and the behaviour eval's "false suggestions read" bar (at most 10% of turns) is the right place to judge whether it hurts.
- **Retire `scoreSkillMatch` for large catalogs.** It is 9 to 25 points of hit@5 behind BM25F on description-only catalogs, falling further behind as the catalog grows, and about 100 times slower at 1,500 skills.
- **If a static list has to do the job (a config-only fix).** Under the preregistered gate every static list beats the resolver, and under the repaired gate the names-only list (A1) still beats it at 250 skills. The cheapest real fix is in harness config, not in gbrain: replace the alphabetical cut with descriptions (A0: 4 to 10% coverage for 2,600 to 14,400 tokens) with a names-only list of every skill (100% of names for 990 to 7,008 tokens), or, for gbrain's own skills, the spring index. Whether a model then picks the right skill from a bare name needs the behaviour eval.
- **Avoid reading this as agent behaviour.** It measures whether an acceptable skill reaches the list, judged by a model, on model-written turns. It does not show that an agent loads or follows the skill.

## Limits

- Synthetic turns and model labels. Turns were written per area; the judge saw descriptions, not bodies. Labels are moderately stable (Jaccard 0.79).
- The main turn set has the length confound described above; the 100-turn stress set addresses it only for the secondary analysis.
- A1u's order comes from dev turns drawn from the same distribution as test, which flatters it.
- Triggers exist only on gbrain and gstack skills, all inside the 250-skill core.
- Catalog size stands in for harness truncation until Step 0 reports.

## Reproduce and inspect

From the repository root, with bun 1.4.4, a gbrain checkout at `ff11cb91`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` (paid steps only) and Ollama with `nomic-embed-text` (A6):

```bash
cd docs/benchmarks/2026-11-07-skill-ranker-offline
gunzip -kf data/catalog.jsonl.gz                 # or rebuild: bun scripts/dump-gbrain.ts <gbrain> > data/gbrain-bundled.json && bun scripts/build-catalog.ts <clone-root> data/gbrain-bundled.json --clone > data/catalog.jsonl
bun scripts/embed.ts openai && bun scripts/embed.ts local   # about $0.01 and 4 minutes; cached under cache/
bun scripts/check-a2.ts <gbrain>                 # vendored scoreSkillMatch equals gbrain's
bun scripts/score.ts                             # free and deterministic, about 1 minute
```

`score.ts` refuses to run if the test or stress-test file differs from the hash frozen in the preregistration. The paid steps (`gen-turns.ts`, `judge.ts 1|2`, `gen-stress.ts`, `judge-stress.ts`) are written once and refuse to overwrite their output. Results: [verdict.json](2026-11-07-skill-ranker-offline/results/verdict.json) (bars, cut rules, diagnostics, label stability, latency), [secondary.json](2026-11-07-skill-ranker-offline/results/secondary.json), [calibration.json](2026-11-07-skill-ranker-offline/results/calibration.json), [arms-test.json](2026-11-07-skill-ranker-offline/results/arms-test.json), [per-turn-test.jsonl](2026-11-07-skill-ranker-offline/results/per-turn-test.jsonl) (750 skills, variant D) and the spend ledger [spend.jsonl](2026-11-07-skill-ranker-offline/results/spend.jsonl).

Cost: $11.07 of the $50 cap, from provider-reported usage: judge $10.62 (140 calls, 26.1M cached input tokens), writer $0.44 (92 calls), embeddings $0.005. Local embedding took about 4 minutes on a 4-CPU machine with no GPU.

## Disclosures

gbrain is Garry Tan's own project.

gstack is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
