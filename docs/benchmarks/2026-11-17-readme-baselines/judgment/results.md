# No-gbrain baselines for README's judgment rows: contradictions, timeline events, memory pages

Measured 2026-11-17. Each row pairs a plain-prompt baseline with the published gbrain records for that row. The baseline uses the same model, the same inputs and the same scorer, and no gbrain code runs in it. No gbrain arm was run again. Plan: [analysis-plan.md](analysis-plan.md), written and pushed before any paid call, under [the preregistration](../../../plans/2026-11-17-readme-baselines/PREREG.md).

## Takeaways

- **We learned that gbrain's contradiction prompt is what keeps cheaper judges from flagging false conflicts. You should keep using it with Haiku- or Luna-class judges.** Asked plainly "do these two dated notes contradict?", Claude Haiku 4.5 still caught every planted conflict (150 of 150). It also called 24 of 40 changes over time and 29 of 51 compatible pairs contradictions. With gbrain's prompt it called 0 and 4 (paired exact McNemar on the 241 planted pairs, p = 7e-11). GPT-6 Luna and Claude Sonnet 5.5 show the same pattern at a smaller size. Most of their errors were pairs where two different people hold different opinions.
- **We learned that frontier judges don't need the prompt on this test. You can pick GPT-6.1 Sol or Claude Opus 5.5 without gbrain's prompt and get the same verdicts here.** Plain Sol got all 741 pairs right, and plain Opus got 740. Both are at the ceiling, so there is no measurable difference. That reflects how easy this synthetic world is, and it is not evidence that the prompt hurts.
- **We learned that gbrain's memory pages keep more of a session than a plain "write a memory page" prompt, but the plain pages make fewer unsupported claims. You should use gbrain's distillation for recall and still check its claims.** Judged recall was 87.3% for gbrain and 79.7% for plain Sonnet 4.6 on the same 165 paired items (sign test p = 0.005, difference -7.6 points, 95% interval -14.4 to -0.6). Evidence-verified recall showed no measurable difference (-5.8 points, p = 0.29). Plain pages had 2.7% unsupported claims against gbrain's 7.0%.
- Timeline events: the plain prompt wrote 16 planned follow-ups as events (premature) across two runs, and gbrain wrote 0. It wrote 0.45 wrong events per labeled page, against gbrain's 0.04, and it fails the 0.20 gate that gbrain passes. Even so, the preregistered page-level sign test can't reject at 28 pages (5 pages worse, 0 better, p = 0.0625), so this row is **no measurable difference at this sample size**.

## Results

Classification rule: gbrain is ahead and the preregistered paired test rejects at 0.05 two-sided = **win**; the baseline is ahead and it rejects = **loss**; otherwise **no measurable difference** (not a claim that the two are equal).

| README row | Model, judge | gbrain (published records) | Plain baseline (same inputs) | Paired test | Result |
|---|---|---|---|---|---|
| Contradiction finding, Haiku 4.5 (gbrain `77cf8e111`) | claude-haiku-4-5 (matches the row; not a model under test today) | conflicts 146/150, dated changes 0/40, compatible 4/51 | conflicts **150/150**, dated changes **24/40**, compatible **29/51** | McNemar on 241 planted pairs: gbrain right on 49 the baseline missed, baseline right on 4; p = 7.1e-11 | **win** |
| Contradiction judging, GPT-6 Luna (`c5fb0201`) | gpt-6-luna | 150/150, 0/40, 0/251 | 150/150, 1/40, 27/251 | McNemar on 741 pairs: 28 vs 0; Holm p = 3.0e-8 | **win** |
| same, Claude Sonnet 5.5 | claude-sonnet-5-5 (matches the row) | 150/150, 0/40, 0/251 | 150/150, 2/40, 13/251 (1 unparseable reply) | 15 vs 0; Holm p = 1.8e-4 | **win** |
| same, GPT-6.1 Sol | gpt-6.1-sol | 150/150, 0/40, 0/251 | 150/150, 0/40, 0/251 | 0 vs 0; p = 1 | no measurable difference (ceiling) |
| same, Claude Opus 5.5 | claude-opus-5-5 | 150/150, 0/40, 0/251 | 149/150, 0/40, 0/251 | 1 vs 0; p = 1 | no measurable difference (ceiling) |
| Timeline events from meetings and chats (`5a44025`, merged as `b9ee931`) | claude-sonnet-4-6 extractor (matches the row; not a model under test today) | recall 37 and 38 of 38; 0.04 wrong per labeled page (0 premature, 1 false per run) | recall **33 and 36** of 38; **0.54 and 0.36** wrong per labeled page (10 and 6 premature, 5 and 4 false) | sign test over 28 labeled pages, wrong events (mean of two runs): 5 pages worse, 0 better, p = 0.0625; difference +0.41 per page, bootstrap 95% +0.09 to +0.79 | no measurable difference |
| Useful material kept from a session (`079941d2`) | claude-sonnet-4-6 writer and judge (matches the row; same family judges both arms, as in the gbrain row) | judged 88.1% macro (87.3% on the 165 paired items), evidence-verified 74.9% | judged **80.3%** macro [74.2 to 86.4] (79.7% paired), evidence-verified **68.5%** | sign test on 165 items, judged credit: gbrain higher on 33, baseline on 13, p = 0.0045; -7.6 points [-14.4, -0.6] | **win** (judged); no measurable difference (evidence-verified, p = 0.29) |

**Contradiction rows, more detail.** Haiku with the plain prompt raised 21 false alerts on the 2,439 other pairs, against gbrain's 38 (the baseline was better there, p = 0.016). It also caught the 4 conflicts gbrain's prompt misses (p = 0.125). So the plain prompt flags more readily on the planted same-topic pairs, which costs it most on dated changes and compatible pairs, and less often on the unrelated pairs. The current-model numbers pool the 51 original compatible pairs with the 200 fresh ones (251), as the published row does. Luna's 27 compatible false alarms were 21 fresh and 6 original pairs. Typically one note says "Kira thinks the market is overcrowded" and another says "Dmitri thinks the market is wide open", and Luna answers "Yes." Under N2's rules, Luna fails with the plain prompt (compatible upper bound 15.3%, over the 10% rule) and Sonnet 5.5 passes (8.7%).

**Timeline row, more detail.** Both arms found every calendar event (20 of 20). The plain prompt's misses and wrong events are all on meeting pages:
- The premature events date planned follow-ups to their future day, for example "Halfway Capital to begin Series B diligence (late August)" dated 2026-08-01.
- The false events put a quarter's result on the meeting day, for example "CarbonLoop Q1 revenue came in at $2.1M".

Slack: 0 false in each preregistered 25-event sample (gbrain: 1 and 0), and 0 premature. No control page was read in either arm.

**Memory-page row, more detail.**

| Measure | gbrain (`079941d2`) | Plain baseline |
|---|---|---|
| Judged recall, macro over signal transcripts | 88.1% (20 transcripts) | 80.3% (19; one excluded for a judge failure) |
| Evidence-verified recall | 74.9% | 68.5% |
| Claim hallucination | 7.0% (45/645) | **2.7%** (11/410) |
| Distractor leakage | 1.2% (1/86) | 0% (0/86) |
| Quote fidelity | 82.7% (115/139) | 33% (4/12) |
| Usability (judged) | 90.8% (109/120) | 50.7% (71/140) |
| Attribution hazards violated | 0 of 2 | 0 of 2 |

The judge model matches the gbrain run, but the judge prompt doesn't. The gbrain run used Cat 35 judge prompt `2026-08-16-v1` at the provider's default temperature. The runner now has only `2026-09-28-v2` (the same rubric with escaped, fenced documents) at temperature 0, and gbrain's `079941d2` pages are not committed, so they can't be re-judged. As a control, the committed August 25 gbrain pages were re-judged under v2. They scored 0.9 points higher than under v1 on the same 165 items (p = 0.45), and 1.8 points lower on evidence-verified credit (p = 1.0). The judge change is about a point, which can't account for a 7.6-point gap. The usability rows have different denominators (the gbrain lane writes no page for routine sessions), so read them as descriptive.

## Why null?

- **Contradictions, GPT-6.1 Sol and Claude Opus 5.5.** Both models used the dates and told attributed opinions apart without being told to. N2's synthetic pairs are clean enough that the plain prompt already hits 100% (Opus missed one conflict). There is no headroom, so the test can't show what the prompt adds for frontier judges. Verdict: **KEEP** the prompt, since it carries the cheaper judges gbrain defaults to, and **FIX-METHOD** for frontier judges. A harder world with messier notes is the honest attempt to raise the ceiling.
- **Timeline events.** The effect is large but sits on 5 of 28 labeled pages. An exact sign test needs at least 6 one-sided pages to reach p < 0.05, so this design could not reject unless the plain prompt went wrong on 6 or more pages. The plain prompt does what gbrain's date-quality fix was built to stop: it writes plans as dated future events. Verdict: **KEEP**, and **FIX-METHOD**: label more meeting pages (the 20 calendar pages can't separate the arms), or preregister events rather than pages as the unit.
- **Memory pages, evidence-verified recall.** A 5.8-point gap with a 95% interval from -16.3 to +4.7 over 19 transcripts. The sample is too small to separate the arms on the stricter measure. The plain pages also quote less (12 quoted spans against 139), and that weighs on this measure.

## What we could not verify

- **Reviews.** The chronicle review of plain events (86 events: 36 unmatched on labeled pages and 50 sampled Slack events) was done by this agent, using the original rubric and the gbrain rerun's own review as the precedent for borderline cases ([chronicle/review.json](chronicle/review.json)). It is an independent reader in that it didn't write gbrain's review, but no person reviewed either one. Five plain events were classed false, four as quarter results without a reporting verb and one as a plan written as done. A lenient reading that calls all five supported still leaves 0.36 and 0.21 wrong per page, and both still miss gbrain's 0.20 gate.
- **Cat 35 judge.** See the judge-prompt mismatch above. Also, one transcript (`startup-ideation-02`, 8 items) had a coverage-judge failure in the baseline run and in the control, so it is out of the pairing and out of the baseline macro.
- **Reply parsing.** 7 Haiku replies began "# Answer: No" and 1 Sonnet 5.5 reply answered without yes or no. All 8 are counted as no contradiction, as gbrain's judge errors are. The 7 Haiku replies were all No on unplanted pairs, so scoring them as No changes nothing. The Sonnet one is a fresh compatible pair, where no contradiction is the correct verdict.
- **Single sample per pair.** Every verdict is one sample at provider-default sampling. The Haiku gbrain row itself moved from 149 to 146 between two runs.
- Sonnet 4.6, Haiku 4.5 and Sonnet 5.5 appear here only because they are the published row's model. None of them is a model under test today.

## Reproduce

From the repository root at this branch, with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and a budget ledger (`L`):

```bash
D=docs/benchmarks/2026-11-17-readme-baselines/judgment
PR=docs/plans/2026-11-17-readme-baselines/PREREG.md
# Row 1: the 2,680 pairs from the committed capture, then the plain Haiku judge (about 6 min)
bun eval/runner/n2-judge-replay.ts select --population --capture docs/benchmarks/2026-10-06-n2-judges/capture-20261001.json.gz --output population.json
bun eval/runner/n2-judge-replay.ts judge --prompt plain --model anthropic:claude-haiku-4-5 --selection $D/n2-haiku/population.json.gz \
  --preregistration $PR --budget-ledger $L --budget-usd <cap> --output $D/n2-haiku/n2-plain-haiku.json
bun eval/runner/n2-judge-replay.ts compare --selection $D/n2-haiku/population.json.gz --baseline $D/n2-haiku/n2-plain-haiku.json \
  --reference docs/benchmarks/2026-10-11-wave14-repin/n2-paid/receipt-paid-77cf8e111.json
# Row 2: per model (openai:gpt-6-luna, anthropic:claude-sonnet-5-5, openai:gpt-6.1-sol, anthropic:claude-opus-5-5), 2 to 4 min each
bun eval/runner/n2-judge-replay.ts judge --prompt plain --model <provider:model> --selection docs/benchmarks/2026-10-06-n2-judges/selection.json \
  --preregistration $PR --budget-ledger $L --budget-usd <cap> --output out.json
bun eval/runner/n2-judge-replay.ts compare --pooled --selection docs/benchmarks/2026-10-06-n2-judges/selection.json --baseline out.json \
  --reference docs/benchmarks/2026-10-06-n2-judges/judge-<model>.json
# Row 3: two plain runs (about 1.5 min), then keyless scoring with the committed review
bun eval/runner/chronicle-lift.ts plain --out <dir> --arms plain-a,plain-b --model claude-sonnet-4-6 --budget-ledger $L --budget-usd <cap>
bun eval/runner/chronicle-lift.ts score --out $D/chronicle --review $D/chronicle/review.json
# Row 4: write the pages (about 1.5 min), judge them (about 5 min), and the judge-drift control on the committed Aug 25 pages
bun eval/runner/plain-baseline.ts cat35-write --out <docs> --receipt <writer-receipt.json> --model anthropic:claude-sonnet-4-6 --budget-ledger $L --budget-usd <cap>
CAT35_FULL=1 CAT35_JUDGE_MODEL=claude-sonnet-4-6 CAT35_HARD_STOP_USD=20 bun eval/runner/cat35-transcript-distill.ts --lanes none --external-lane plain \
  --external-dir <docs> --external-writer-receipt <writer-receipt.json> --preregistration $PR --budget-ledger $L --budget-usd <cap>
# (control: the same with --external-lane gbrain-aug25 --external-dir <a folder of the committed artifacts/*.dream.md renamed to <id>.md>)
# Keyless paired analysis of rows 3 and 4 from committed files
bun $D/pair.ts > $D/paired.json
```

Files: `n2-haiku/` (population, every verdict and reply, compare output), `n2-current/` (per model), `chronicle/` (replies, events, builds, review, scores), `cat35/` (writer receipt, the 24 plain pages, judged receipts and artifacts for the baseline and the control), `paired.json`, `logs/`. Code: gbrain-evals `443427ff5` for every paid run (each receipt records it). Bun 1.4.4. No gbrain code wrote, extracted or judged anything in a baseline arm. The Cat 35 harness imports the pinned gbrain package as it always does, and the budget ledger reads that package's model price table to price requests.

After the runs, machine-local paths in the raw receipts were rewritten (`<work>/` for the run machine's scratch folder, `<vm>/` for the run VM, and repo-relative paths for the checkout) so the repository's receipt checks pass; no other field changed.

## Disclosures

gbrain is Garry Tan's own project.

Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
