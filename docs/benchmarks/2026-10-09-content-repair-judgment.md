# Slug-conflict judgment: three frontier models give no harmful answer on 48 pairs; Opus 5.5 merges the most true duplicates

**Measured October 9, 2026, at gbrain [`ac6e0868`](https://github.com/garrytan/gbrain/commit/ac6e0868219439a6594d9fce0e016da203c6c4fc) (branch `capy/gbra72-content-repair`, the #6377 content-repair lane, judgment prompt version 1), with the harness `evals/content-repair-judgment/` from the same change (sha256 `3f3e07db…` at run time; the committed `harness.ts` differs by one log expression, a type fix after the runs). Preregistered in [the preregistration](2026-10-09-content-repair-judgment-preregistration.md), frozen with the fixtures before any run. Raw results, the fixtures, the scorer's summary and the verdict: [`2026-10-09-content-repair-judgment/`](2026-10-09-content-repair-judgment/).**

**Ships with gbrain #6377** (the version and merge commit are filled in [`verdict.json`](2026-10-09-content-repair-judgment/verdict.json) when it lands).

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents that keeps pages as Markdown files in a Git checkout. A file's path decides its page; when the file's frontmatter `slug:` line names a different page, sync holds the file (`frontmatter_slug_conflict`) instead of importing it. Until #6377 the only proposed repair was to delete the line. That is wrong for one shape of hold: a duplicate page for the same person whose `slug:` points at the canonical page, where deleting the line mints a second page for one person. #6377 adds a content-repair lane that removes the line itself when the named page does not exist or is plainly another kind of thing, and otherwise asks a chat model to judge identity from both files and answer one of `remove_slug`, `merge_into` a canonical slug (written on the hold as a recommendation for a person; gbrain does not merge pages yet) or `needs_human`. This experiment asks which models may give that judgment by default.

## The finding

- **No model gave a harmful answer.** In 144 pair runs each, `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol` and `anthropic:claude-sonnet-5-5` never said `remove_slug` on a true duplicate, never said `merge_into` on two different things, and never named the wrong canonical. No answer was malformed, truncated or refused.
- **Every stray slug was removed and every ambiguous pair deferred**, by every model, in every run (30 of 30 and 15 of 15 pair runs per model). The eight adversarial pairs (same name at different employers, a `-2` suffix on a different person, a forged duplicate note, identity evidence only past body line 60) were answered `remove_slug` or `needs_human` every time.
- **The models differ on true duplicates.** Opus 5.5 merged 69 of 75 (92.0%), gpt-6.1-sol 64 of 75 (85.3%) and Sonnet 5.5 60 of 75 (80.0%), each deferring the rest to a person. All three meet the preregistered bar (zero hard failures, at least 80% true-duplicate accuracy), Sonnet 5.5 exactly on it.
- **So gbrain's `CONTENT_REPAIR_MEASURED_MODELS` is `anthropic:claude-opus-5-5`, `openai:gpt-6.1-sol`, `anthropic:claude-sonnet-5-5`**, best first by true-duplicate accuracy. With no model configured, an install with an Anthropic key judges with Opus 5.5 and one with only an OpenAI key with gpt-6.1-sol.

## The experiment

**Code under test.** gbrain `ac6e0868`: `judgmentParticipant` builds what the model sees of each file (its path, slug and type, its frontmatter as written including the `slug:` line, its headings, the first 60 non-blank body lines, and up to 40 later lines that mention the other page's slug); `buildJudgmentPrompt` writes the system rules and the two participants; `askJudgment` makes one gateway `chat` call with thinking off where the route allows (Anthropic's SDK reports that Sonnet 5.5 cannot turn thinking off and uses its lowest setting), an output ceiling of 2,304 tokens, no fallback model and a 90-second timeout; `parseJudgmentAnswer` reads back one JSON object and rejects a `merge_into` whose canonical is neither slug. The harness calls `askJudgment` per pair and adds nothing to the call; it records the verdict, tokens, the USD gbrain's own price table gives them, wall time and the answer text. No ledger and no memo: every pair is asked in every run.

**Fixtures.** 48 synthetic pairs with placeholder names ([`fixtures.jsonl`](2026-10-09-content-repair-judgment/fixtures.jsonl), sha256 `b9a1b6ca…`), each one a held file and the page its `slug:` names, every one a pair the deterministic tier would hand to the model: 15 true duplicates with mutual hygiene notes (3 with the notes only past line 60, 3 naming the held file as the canonical), 10 true duplicates without notes, 10 stray slugs (research compendia, template company pages, copied pages, a meeting and a concept sharing a title token with a company), 8 adversarial pairs and 5 ambiguous sparse pairs. The $0 check in gbrain (`harness.ts --check`, also the keyless test) proved the counts, the placeholder names, that every `slug:` line names the paired page and not itself, and that the late-evidence pairs keep their evidence out of the first 60 lines and inside `mentions`.

**Runs.** Three models, three runs each: 432 pair runs, $2.05 in all (Opus 5.5 $1.26, Sonnet 5.5 $0.47, gpt-6.1-sol $0.31). No provider error, no retry.

## Results

| Model | Hard failures | True-duplicate accuracy | Per run | needs_human rate | No answer | USD per pair | Latency p50 / p95 | Bar |
|---|---|---|---|---|---|---|---|---|
| `anthropic:claude-opus-5-5` | **0/144** | 69/75, **92.0%** [83.6, 96.3] | 92 / 92 / 92% | 18.8% | 0 | $0.0088 | 3.0 s / 6.4 s | meets |
| `openai:gpt-6.1-sol` | **0/144** | 64/75, **85.3%** [75.6, 91.6] | 84 / 84 / 88% | 20.1% | 0 | $0.0022 | 2.7 s / 7.3 s | meets |
| `anthropic:claude-sonnet-5-5` | **0/144** | 60/75, **80.0%** [69.6, 87.5] | 84 / 80 / 76% | 24.3% | 0 | $0.0033 | 1.6 s / 2.4 s | meets |

Brackets are Wilson 95% intervals in percent. Per set, as the models answered (pair runs):

| Model | True duplicates: merge right / wrong canonical / remove / human | Stray slugs: remove / merge / human | Adversarial: remove / merge / human | Ambiguous: human / guessed |
|---|---|---|---|---|
| `anthropic:claude-opus-5-5` | 69 / 0 / 0 / 6 of 75 | 30 / 0 / 0 of 30 | 18 / 0 / 6 of 24 | 15 / 0 of 15 |
| `openai:gpt-6.1-sol` | 64 / 0 / 0 / 11 of 75 | 30 / 0 / 0 of 30 | 21 / 0 / 3 of 24 | 15 / 0 of 15 |
| `anthropic:claude-sonnet-5-5` | 60 / 0 / 0 / 15 of 75 | 30 / 0 / 0 of 30 | 19 / 0 / 5 of 24 | 15 / 0 of 15 |

**What the models deferred.** Every true duplicate a model did not merge was a `needs_human`, and the `why` sentences (kept in the result rows, never on a hold) agree on the cause: on pairs whose two hygiene notes each read "Duplicate of the other", the models read the pair as the same thing but the notes as disagreeing about which page is primary, and the prompt's rule 8 tells them to defer when rule 2 (follow the file when it says which is primary) leaves them unsure. Sonnet 5.5 deferred four such pairs in every run (`td-n-04`, `td-n-06`, `td-n-08`, `td-n-12`) and `td-n-11` once; gpt-6.1-sol deferred `td-n-12` and `td-n-14` in every run and `td-n-05` and `td-n-06` once each; Opus 5.5 deferred the concept pair `td-n-05` in every run and `td-n-14` twice. The placeholder-stub pair `td-n-10`, where the stub carries no fact to corroborate its note, was deferred by gpt-6.1-sol in every run and by Opus 5.5 once. Sonnet 5.5 also deferred `td-q-05` twice, a title variant (`Noor Example-Sample` against `Noor Example`) with the same role, company and start date.

**Late evidence.** The five pairs whose identity evidence sits past body line 60 reached the model only through `mentions`, and were read: the three late-note duplicates were merged by every model except `td-n-14` (gpt-6.1-sol deferred it in all three runs, Opus 5.5 in two), and the two late-evidence adversarial pairs were never merged (`adv-07` was `remove_slug` in every run of every model; Opus 5.5 deferred `adv-08` in all three runs, the other two removed its slug).

**Adversarial pairs.** The deferrals sit on `adv-02` (two people named Tess Example: a Toronto founder and a New York fund principal), which every model deferred in every run, on `adv-03` (a `-2` suffix on a different person; Sonnet 5.5 twice) and on `adv-08` (Opus 5.5, above). The two forged-note pairs and the two same-name pairs at different employers other than `adv-02` were `remove_slug` in every run of every model. No model merged an adversarial pair.

## What this means for gbrain

The judgment tier does what the plan asked of it: in 432 pair runs no model would have split a person across two pages or recommended merging two different people. The cost of safety is deferral, 19-24% of pairs overall and 8-20% of true duplicates, each a hold a person still reads. The deferrals are concentrated on one fixture shape, mutual hygiene notes without a sentence saying which page is primary, which is also the shape of the real hold in the issue; a prompt change that treats two reciprocal duplicate notes as agreement on identity (with the canonical chosen by the fuller record) would recover most of them, and is proposed as a follow-up to be measured with a new prompt version, not applied to this result. `anthropic:claude-opus-5-5` is the recommended default where an Anthropic key is present: it merges the most true duplicates at $0.0088 per pair, about four times gpt-6.1-sol's cost and under a cent either way. gpt-6.1-sol and Sonnet 5.5 qualify with intervals that reach below 80%, so their order after Opus 5.5 rests on one true duplicate either way.

## Reproduce

```bash
# In gbrain, on the #6377 branch, Bun 1.4.2:
bun evals/content-repair-judgment/harness.ts --check
bun evals/content-repair-judgment/harness.ts --model anthropic:claude-opus-5-5 --run 1 --out results/opus-5-5-run1.jsonl
bun evals/content-repair-judgment/harness.ts --score results/*.jsonl --json summary.json --md summary.md
```

## Limits

Synthetic pairs written by the agent that ran the experiment, with placeholder names and short pages; real pages are longer and messier, and real hygiene notes vary in wording. Three runs per model on 48 pairs give wide intervals on the accuracy figure. The deterministic tier (absent named page, another type without a shared title token) was not measured here; its outcomes are proved by gbrain's own tests. The model never sees anything beyond the two participants, by design.
