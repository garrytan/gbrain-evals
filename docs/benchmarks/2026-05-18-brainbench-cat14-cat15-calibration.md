# Using a person's track record when giving advice

**Historical run: May 18, 2026.** gbrain `04dbab44`, branch `garrytan/asuncion`, v0.36.1.0; gbrain-evals `5e179c6`, branch `cat14-calibration`. Apple Silicon M-series, single-threaded. Reported total: under five minutes and about $0.15, split into $0.05 for advice and $0.10 for claim extraction.

An assistant can remember facts and still miss a useful pattern in them. Suppose a user repeatedly dismissed companies outside coastal cities, then watched those companies succeed. When the next similar decision arrives, recalling that track record may improve the advice.

This report tested two parts of that idea. Given a hand-written track-record profile, the assistant's advice was preferred in six of eight cases, tied in two, and lost in none. On a separate claim-extraction test, average held-out F1 was 0.922. That is **not 92.2% answer accuracy**, and these two tests do not validate the complete calibration workflow.

## What “calibration” means here

The intended workflow has four steps: extract predictions from notes; compare them with later outcomes; summarize recurring successes and mistakes; use relevant patterns in future advice. A sentence such as “Acme will reach $5M revenue by Q3” is a prediction that can later be checked.

Category 15 tested extraction. Category 14 tested advice after a profile was supplied. Grading predictions against reality and generating the profile were not directly tested. At publication, automatically applying outcome judgments was off by default.

| Configuration | cat14 win rate (calibrated vs plain) | cat15 F1 (training / unseen) | Cost per 100 test cases |
|---|---|---|---|
| **gbrain v0.36.1.0 (this wave)** | **75% / 0% / 25% tie** | **0.952 / 0.922** | ~$1.50 |
| Plain `think` (no track-record memory) | reference point | not applicable | n/a |
| Other AI memory systems | never published numbers for this metric | never published numbers for this metric | n/a |

The competitor row records the author's May claim about unavailable comparable measurements. It is not a verified statement that no other system has ever published related work. This report makes no priority or state-of-the-art claim.

Precision is the share of extracted claims that the labels consider correct. Recall is the share of labeled claims found. F1 is their harmonic mean, which falls when either is low. There is no universal F1 threshold for usefulness or random chance: both depend on the task and labels.

## Advice with and without a track-record profile

The advice fixture had eight authored questions in `eval/data/cat14-calibration/probes.jsonl`. Each received two answers, one with the profile and one without. A judge compared usefulness and scored specific behaviors.

For example, the Austin seed-round case supplied a history of three incorrect high-confidence geography calls. A useful answer could identify that pattern while still considering team and traction. This is an illustrative case within a synthetic advice test, not a measured recommendation about an actual investment.

| Category | Count | What it tests in plain English |
|----------|---|---|
| Bias relevant to question | 2 | User has a wrongness pattern AND the question is in that domain. Calibrated AI must surface the bias. |
| Track record is positive | 2 | User has been *right* about this domain. Calibrated AI should reinforce confidence, NOT invent a fake "be careful" warning. |
| Empty memory (cold-start) | 1 | User has no track record yet. Calibrated AI must behave identically to plain AI — no fabricated bias. |
| Bias is irrelevant to question | 1 | User has a wrongness pattern but the question is in a different domain. Calibrated AI must NOT force-fit the wrong bias. |
| Multiple biases at play | 1 | Question touches two domains. Calibrated AI must pick the relevant one. |
| Emotional/personal framing | 1 | Tests whether the AI's voice stays friendly or slides into clinical "your Brier score is 0.31" robot-talk. |

The rubric checked five things: using a relevant pattern, explaining the initial belief and contrary evidence, changing advice appropriately, speaking naturally, and leaving irrelevant patterns out.

| Axis | Pass rate | What "passing" means here |
|------|-----------|---------------------------|
| Mentions relevant bias when it should | **100%** | All 8 cases where bias was relevant, the AI surfaced it. |
| Names both gut and counter-prior | 75% | 2 of 8 cases missed — both were "track record is positive" cases where the AI manufactured a fake counter-prior instead of just reinforcing the gut. |
| Recommendation changes meaningfully | 75% | Same 2 cases as above — the manufactured counter-prior changed the recommendation in cases where it shouldn't have. |
| Voice stays friendly | **100%** | No clinical jargon leaked through in any of the 8 answers. |
| Does NOT mention irrelevant bias | **100%** | The "force-fit" failure mode — where the AI shoehorns the wrong bias into an answer — never happened. This is the most important negative-case safety axis. |
| **Overall: calibrated wins vs plain** | **75% (6 of 8)** | Calibrated never lost outright. Remaining 2 cases tied. |

The raw scorecard's phrase “all 8 cases where bias was relevant” is imprecise: the fixture includes empty-memory and irrelevant-bias cases. Read those rows as reported rubric scores across the eight-case test, with applicability handled by the rubric. The two positive-track-record cases exposed a specific problem: the assistant invented a caution when the profile supported confidence.

The preselected gates were at least 55% wins, 95% natural voice, and 90% avoidance of irrelevant bias. The original run passed. Eight cases are too few to establish a stable win rate, a universal quality bar, or the absence of rare harmful advice.

## More prompt instructions did not help

| Prompt version | Win rate | Voice | Force-fit safety | Verdict |
|--------|-----|-------|-----------|------|
| v1 (original, 5 short rules) | 75% | 100% | 100% | **PASS** |
| v2 (more detailed rules) | 63% | 88% | 100% | FAIL (voice slipped) |
| v3 (most detailed rules) | 75% | 75% | 75% | FAIL (voice + force-fit slipped) |

The original five-rule prompt was kept. More detailed versions attempted to fix the positive-track-record cases but introduced worse voice or irrelevant cautions. V2 reported 63% wins and 88% voice; v3 reported 75% wins, 75% voice, and 75% force-fit safety. Their failure is useful: extra instructions can make an answer sound like the rubric rather than a conversation.

The original iteration record is `eval/data/cat14-calibration/iteration-log.md`. These were repeated evaluations on a small development fixture, so the selected version's score is not an untouched test-set estimate.

## Finding predictions in ordinary prose

Category 15 used eight fictional pages with forty-eight hand-labeled claims in gbrain's `test/fixtures/calibration/`: three tuning pages with twenty-one claims, and five held-out pages with twenty-seven. A separate matcher judged whether extracted claims matched labels, added unsupported claims, or missed required ones.

| Split | Pages | Avg Precision | Avg Recall | Avg F1 | Target | Result |
|-------|--------|---------------|------------|--------|--------|------|
| Training (prompt was tuned on these) | 3 | 0.917 | 1.000 | **0.952** | ≥ 0.85 | PASS (+10 points) |
| Holdout (prompt never saw these) | 5 | 0.920 | 0.931 | **0.922** | ≥ 0.80 | PASS (+12 points) |

Training average precision/recall were 0.917/1.000; held-out averages were 0.920/0.931. F1 was 0.952 versus 0.922, a gap of 0.030. The gates were 0.85 and 0.80. The small gap is encouraging, but neither it nor the report's proposed 0.10 gap rule proves absence of overfitting. These are averages over pages, not necessarily pooled claim counts.

| Genre | Training F1 | Holdout F1 | What's hard about this genre |
|-------|----|----|---|
| Concept essay with timeline | 1.00 | 1.00 | Easiest — dated assertions with explicit verbs like "argues / predicts / I bet." |
| Meeting notes | 0.86 | 1.00 | Mid — prose claims + explicit Takes section. The training case lost points due to one over-extraction. |
| Daily journal | 1.00 | 0.89 | Mid — hedging language is the dominant signal ("I think," "I'm skeptical"). |
| Essay on self-calibration | — | 0.92 | Mid — meta-claims about the author's own bias patterns. |
| People page (about a third party) | — | **0.80** | Hardest — claims about someone else carry softer hedging than claims about your own predictions. |

People pages were the weakest genre, at 0.80 F1. Claims about someone else often use less explicit wording than “I predict.” The report's 0.80 value is at the held-out gate, not above it.

Commit `04dbab44` replaced the earlier placeholder extraction prompt with the tested version. The result supports that particular prompt on these examples. Calling it “92% accurate” would erase the distinction between extracting claims and answering questions correctly.

## Models, costs, and reproduction

The tested answer/extraction model was `claude-sonnet-4-6`; the judge was `claude-haiku-4-5-20251001`. Changing either changes the experiment. The historical commands are:

```bash
cd ~/git/gbrain-evals
git checkout cat14-calibration
bun install

# Full run (~$0.05, ~2 min wallclock)
ANTHROPIC_API_KEY=... bun eval/runner/cat14-calibration.ts

# Hermetic smoke test (no API key needed)
bun test test/eval/cat14-calibration.test.ts

# Run a single test case to debug a specific failure
CAT14_PROBES=cat14-pos-1-geography ANTHROPIC_API_KEY=... \
  bun eval/runner/cat14-calibration.ts
```

```bash
cd ~/git/gbrain-evals
git checkout cat14-calibration
bun install

# Full run (~$0.10, ~3 min wallclock)
ANTHROPIC_API_KEY=... \
  CAT15_CORPUS_DIR=~/path/to/gbrain/test/fixtures/calibration \
  bun eval/runner/cat15-propose-takes.ts
```

The original estimate was about $1.50 per hundred test cases, or roughly $0.50 for a larger thirty-plus-case run. These are historical estimates, not current provider quotes. The report also suggested approximately ±2 percentage points of judge variation, but did not publish repeated-run evidence establishing that bound. Structured judge output helps parsing; it does not guarantee stable judgments.

## What remains unmeasured

The profiles were authored, so the test does not establish that gbrain accurately summarizes a user's real history. A proposed next test would compare outcome judgments against thirty human-graded predictions, then test generated profiles separately. Real-note evaluation, broader model coverage, more cases, and a stable vocabulary of roughly thirty calibration patterns were also proposed.

Human forecasting research is relevant background, but this report does not establish a comprehensive survey of it or of competing assistants. Its contribution is a small, inspectable test of two behaviors, with known failures and a rejected prompt change.

Per-case advice output belonged under `eval/reports/cat14-calibration/cat14-*.json`; extraction output under `eval/reports/cat15-propose-takes/cat15-*.json`, each with `_summary.json`. Those paths are ignored run output, so a path alone does not guarantee that a historical receipt is committed. A new report should retain its input, both answers, judge labels, and explanations alongside the published measurements.
