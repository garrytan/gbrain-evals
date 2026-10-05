# The takes-bootstrap classifier did not graduate; its autopilot stays manual

**Measured by gbrain on October 4, 2026; mirrored into this repository on October 5, 2026. This mirror reruns nothing.**

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. One of its optional jobs, takes-bootstrap, reads a person's briefing and writing pages with a chat model and records the claims it finds as typed rows: a **fact**, a **take** (an opinion the page holder holds), a **bet** (a prediction with stakes) or a **hunch**. gbrain runs it only when an operator asks (`manual_only`). Its own rule (TODOS TODO-E) keeps it that way until a live run of a 100+-case eval "graduates".

## The finding

The first live graduation run did not graduate, so **the takes-bootstrap autopilot tier stays `manual_only`**. With `anthropic:claude-haiku-4-5` as the classifier, 75 of 123 test pages came out fully right. Facts and bets were too often wrong: fact precision 0.714 (50 of 70 predicted facts correct) and bet precision 0.545 (18 of 33), against a bar of 0.80. Three times the classifier credited a press claim to the page's owner, which the rule forbids outright.

This is gbrain's measurement, reported in [garrytan/gbrain#6013](https://github.com/garrytan/gbrain/pull/6013) (merge commit `d37fab68e95e66347ba661e913cdafca330ae5a2`, v0.60.59.0). The source text is copied unchanged into [`upstream/`](2026-10-04-takes-bootstrap-verdict/upstream/), and every number below is in [`verdict.json`](2026-10-04-takes-bootstrap-verdict/verdict.json).

## What was measured

**The eval.** `evals/takes-bootstrap/` in gbrain: 41 hand-written page archetypes, each in 3 variants that keep the same labels, 123 pages in all. Some pages contain a mix of claims. Others are traps: pages with nothing to extract, someone else's opinion that must never be recorded as the page holder's, prompt injection and pasted JSON. Each page goes through gbrain's real extraction path (`extractTakesFromPages`) on a throwaway brain.

**The bar** (scorer version 1): for each kind, precision at least 0.80 and recall at least 0.70, with no unparseable output and no forbidden attribution. Precision is the share of predicted claims of that kind that are correct. Recall is the share of labeled claims that were found. A page passes when every labeled claim is matched, every prediction is correct and nothing forbidden fires.

**The run.** October 4, 2026, `anthropic:claude-haiku-4-5`, all 123 pages, estimated at $0.23 under a hard $1 cap; it cost $0.0935.

| Kind | Labeled / found | Predicted / correct | Precision (bar: 0.80) | Recall (bar: 0.70) | Passes |
|---|---|---|---|---|---|
| fact | 42 / 32 | 70 / 50 | **0.714** | 0.762 | no |
| take | 33 / 32 | 47 / 42 | 0.894 | 0.970 | yes |
| bet | 24 / 18 | 33 / 18 | **0.545** | 0.750 | no |
| hunch | 18 / 12 | 16 / 12 | **0.750** | **0.667** | no |

Overall: 75 of 123 pages pass; precision 0.735 (122 of 166 predictions), recall 0.803 (94 of 117 labeled claims); 0 unparseable outputs; **3 forbidden attributions** (press claims credited to the page holder). Hunches also miss both bars, which a summary naming only facts and bets would leave out.

gbrain's record splits the misses into two causes. Some are classifier defects: bio facts, quotes and panel attributions return no claims, press attribution leaks, and one strong take is typed as a bet. The rest come from incomplete labels: valid claims the archetypes do not list count as imprecise, so measured precision is lower than true precision. gbrain's next step is to complete the labels, fix bio-fact recall and press-claim attribution, and rerun.

## What to use and what to avoid

- **Run takes-bootstrap only when you ask for it and review its output**, which is what `manual_only` means. Takes come out well (0.894 precision, 0.970 recall). Facts and bets need checking, and any claim attributed to the page holder from quoted press needs a second look.
- **Do not cite this as a property of the feature in general.** It is one run of one model.

## Limits of this result

- **An older model.** The classifier was Claude Haiku 4.5, the harness default. Under the eval model-selection rule in the gbrain project instructions (run the newest frontier model of each family, Opus, GPT, Sonnet and Fable; Haiku 4.5 is named as an older generation; proposed for this repository's `CLAUDE.md` in open PR #63), a rerun on current frontier models may be needed before anyone cites this as a model-independent result. gbrain's own extraction path uses the configured chat model, which defaulted to `anthropic:claude-sonnet-4-6` at `d37fab68e`, not Haiku. So this run does not measure the default configuration either. The rerun is a TODOS item here.
- **No re-scoreable receipt.** gbrain's protocol asks for the predictions JSONL to be committed with the run that flips the tier. This run did not flip it, and no predictions file is in the repository at `d37fab68e`, so the per-kind table cannot be recomputed from public files. This mirror copies the reported numbers; it does not verify them.
- **Labels are partly incomplete**, by gbrain's own account, which biases precision down.

## Reproduce and inspect

In a gbrain checkout at `d37fab68e` with an Anthropic key (about $0.10 to $0.25):

```bash
bun evals/takes-bootstrap/harness.mjs --out results.jsonl --model anthropic:claude-haiku-4-5 --max-usd 1   # live run
bun evals/takes-bootstrap/harness.mjs --replay results.jsonl                                              # re-score at $0
```

Exit 0 means graduated; 1 prints the failing bars. Sources: gbrain `TODOS.md` (TODO-E), `docs/test-audit/2026-10-04/implementation/lane-c.md` ("Takes-bootstrap graduation run (D-6)") and `evals/takes-bootstrap/README.md`, all unchanged on gbrain master `8c9a8e9a4` (checked October 5, 2026).
