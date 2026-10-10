# Preregistration: does packing for depth beat the shipped cap on held-out questions? H1 of the budgeted delivery plan (2026-10-10)

This is a preregistration, not a result. It fixes, before the sealed files are copied into the custody root, the
question, the arms, the readers, the judge, the metric, the decision rule, the spending cap and what each outcome means
for gbrain's default. The results will be published in a separate report, `2026-10-10-gbrain-budgeted-delivery-h1.md`.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. When an agent searches its memory with a
token budget, gbrain ranks short passages (chunks) and then decides how much of each matching conversation to hand
back inside that budget. That second step is packing, set by `search.auto_packing`. gbrain
[#6367](https://github.com/garrytan/gbrain/pull/6367) made an explicit budget a hard cap and shipped `cap_only` as the
packing for explicit budgets: today's order, with the budget enforced. A caller that passes no budget is not affected
by any packing.

## The question

[E2](2026-10-09-gbrain-budgeted-delivery-e2.md) compared the packings on development data. On all 500 LongMemEval-S
questions, read by Claude Sonnet 5.5 at an 8,000-token reader budget, `depth_first` (whole conversations in rank order,
each if it fits) scored 79.4% against 67.4% for the shipped `cap_only`, +12.0 points (+8.2 to +15.8). By E2's
preregistered rule `depth_first` goes to the held-out decision. E2's central caveat carries over: on multi-session
questions `depth_first` gained only 4 points over `cap_only` and trailed `breadth_capped`, and the held-out set is
mostly multi-session.

This decision asks, at gbrain `8a3eedeac` (v0.60.126.0), with an explicit budget: **does `depth_first` answer more
held-out questions than `cap_only`, without losing a question kind or abstention?**

Garry approved H1 on 2026-10-10 with option A: `cap_only` stays the explicit-budget default unless `depth_first` passes
here, and the sealed files are handled only on his Mac.

## What is fixed

Machine-readable form: [`decision.json`](2026-10-10-gbrain-budgeted-delivery-h1/decision.json), the comparison family
[`family.json`](2026-10-10-gbrain-budgeted-delivery-h1/family.json), the descriptive family
[`family-descriptive.json`](2026-10-10-gbrain-budgeted-delivery-h1/family-descriptive.json), the arms files in
[`manifests/arms/`](2026-10-10-gbrain-budgeted-delivery-h1/manifests/arms/) and the campaign in
[`manifests/campaign.json`](2026-10-10-gbrain-budgeted-delivery-h1/manifests/campaign.json). Where this text and those
files disagree, the files win.

| Item | Value |
|---|---|
| Decision id | `sealed-v2-decision-2-2026-10-10:depth-first-vs-cap-only` |
| Sealed set | `sealed-confirmation-v2`, manifest [`eval/data/sealed-confirmation-v2/manifest.json`](../../eval/data/sealed-confirmation-v2/manifest.json); questions `8d29e92d…`, labels `83bf52d1…`. 200 questions over 40 invented personas: 80 multi-session, 40 temporal, 40 knowledge update, 40 abstention |
| Release decision | The second of the three openings the [protocol](2026-10-01-sealed-confirmation-v2-protocol.md) allows. One candidate, so no joint opening: the 10x plan's evidence brief did not qualify (gbrain-evals#111). The third opening stays in reserve. |
| gbrain commit | `8a3eedeacb6e52da5b413502019692db80c5cc5d` (v0.60.126.0), the `package.json` pin, loaded as a copied `--gbrain` overlay of a checkout at that commit, as in E2 |
| Candidate | `depth_first`: `search.auto_packing = depth_first` per call, budget 5,500 gbrain tokens |
| Control | `cap_only`: the shipped explicit-budget default at this commit (`DEFAULT_AUTO_PACKING`, gbrain#6367), same budget |
| References (descriptive) | `off` (the behavior before #6367: the budget is not a cap) at the same budget, and `off` on the first five hits |
| Retrieval | One `query` call per question freezes the ranked list every arm shares: `limit: 25`, no expansion, `return_unit: 'chunk'`, no budget, `openai:text-embedding-3-large` at 1,536 dimensions, gbrain's default reranker, E2's query-path pins. A list without rerank scores is retried up to three times, then kept and counted. |
| Delivery | Every arm through `assembleEvidenceForHits` with `return_unit: 'auto'`, the explicit budget and a per-call `auto_packing`, after a hash-vector re-import with the reranker off in which every frozen chunk's text is checked (`stage=deliver`, `deliver_set=h1`) |
| Budget | `B_pseudo = 5,500` gbrain tokens for an 8,000-token reader budget |
| Rendering | E2's pseudo-session rendering: memory-qa's LongMemEval reader template over the delivered blocks rebuilt as sessions, in date order, each with its chat's date, packed whole in rank order while the history fits 8,000 harness tokens (characters / 4); cuts are counted. Recipe hashes are E2's (`pseudo-depth_first` `b1e6c55c…`, `pseudo-cap_only` `3edcd166…`, `pseudo-off` `ad213143…`, `pseudo-off-l5` `689c5565…`) |
| Primary reader | `anthropic:claude-sonnet-5-5`, at most 1,024 output tokens, no temperature sent (Claude 5 models reject it) |
| Descriptive readers | `anthropic:claude-opus-5-5` and `openai:gpt-6.1-sol` on the candidate and control contexts |
| Judge | `gpt-4o-2024-08-06`, temperature 0, LongMemEval's per-kind prompts with the unanswerable prompt for abstention, through `sealed-confirmation.ts score --judge --decision-id`, which checks the labels commitment and logs the open before it parses them |
| Metric | `answer_correct` (the judge says yes) over all 200 questions. A reader error or an empty answer counts as wrong. |
| Pairing | By question; clusters are the 40 personas (5 questions each) |
| Comparison | `depth_first − cap_only`, persona-clustered bootstrap (20,000 draws, seed 20261010) and the exact two-sided McNemar test, computed by [`compare.ts`](../../eval/runner/compare.ts) with `family.json` |
| Verdict | `decideH1` in [`eval/runner/budgeted-delivery/h1.ts`](../../eval/runner/budgeted-delivery/h1.ts) over the gate, the comparison and the two primary score reports |

## Why these choices

**The control is the shipped default, not the plan's `off`.** The plan, written before #6367 shipped, compared the
candidate with "today's `auto`", which then meant `off`. At the pin, an explicit budget already gets `cap_only`, so
the question a default change has to answer is `depth_first` against `cap_only`. This is a deviation from the plan,
disclosed here. `depth_first` against `off`, and the `off`-on-five-hits arm, are read descriptively, with no
multiplicity correction, because they decide nothing.

**The pin, not E2's commit.** E2 ran at `ca2c447bd`. Between it and the pin, the only file that feeds retrieval,
packing or token counting and changed is `src/core/chunkers/token-estimate.ts`: `estimateTokens`, the cl100k count
gbrain uses for chunking, for the reranker's document cut and for delivery's budget recount, now sums memoized counts
per pre-token instead of encoding the whole text. It is meant to give the same counts, but a change to counting is a
relevant change, so H1 measures at the pin and discloses it. On the invented fixture of the keyless dry run, both
commits froze the same 60 ranked lists and delivered byte-identical evidence for every arm and question
([receipt](2026-10-10-gbrain-budgeted-delivery-h1/receipts/dry-run/dry-run-summary.json), `parity`).

**5,500 tokens.** The sealed text cannot be replayed for sizing, so H1 takes the most conservative of E2's sizings for
an 8,000-token reader budget: LongMemEval-S's 5,500 (the highest ratio of rendered harness tokens to gbrain's
`budget_used`, 1.409), against 6,400 on LoCoMo dev and 6,000 on BEAM-100K dev. Sealed v2's histories are
LongMemEval-style user and assistant chats with LongMemEval timestamps, and 5,500 is the budget E2 measured
`depth_first` at. If a `depth_first` context still does not fit 8,000 harness tokens on the sealed set (guard 4), that
is a terminal fail, never a retune.

**memory-qa's renderer, not decision 1's.** Decision 1 rendered evidence with `sealed-confirmation.ts` and read it
with Sonnet 4.6. H1 uses the renderer and reader template E2 measured, so the held-out readers see exactly the bytes
E2's renderer produces for the same blocks. `render.ts`, `qa.ts`, `arms.ts` and `sanitize.ts` are byte-identical to
E2's (hashes in `decision.json`), and the gate re-renders every context from its recorded delivery and compares the
hash with the prompt the reader got.

**Readers.** Sonnet 5.5 decides, as in E2. Opus 5.5 and gpt-6.1-sol, the other current frontier models, replay the
candidate and control contexts and decide nothing. Fable runs only in smoke tests, so it is not here; the plan's
"three other frontier readers" are these two.

**The judge.** The same model and prompts as decision 1. `judgePrompt` in `sealed-confirmation-lib.ts` gives the same
text as memory-qa's judge for all four sealed kinds (checked while preparing this preregistration).

## The decision rule

Computed in this order. Steps 1 and 2 run before any label is read; `h1.ts gate` refuses once a score line for this
decision is in the access log.

1. **Gate after delivery** (`gate-deliver.json`, before any reader call). Guard 1: without a budget, every packing's
   evidence bytes equal `off`'s, on every question. Guard 3: every `depth_first` delivery's `budget_used` is at most
   5,500 and the delivery reports its packing. Guard 5: every arm reads one frozen list, and every variant is
   delivered for every question. Every delivery ran at 5,500.
2. **Final gate** (`gate.json`, after the readers). Guard 4: every `depth_first` reader context fits 8,000 harness
   tokens with zero cuts. The control's cuts are counted, not held to a guard. Every context carries E2's recipe hash
   and renderer version and re-renders to the bytes the reader got. Every arm has one row per question.
3. **Primary comparison.** `depth_first − cap_only` over the 200 paired questions.
4. **Verdict.**
   - **`pass`** needs all of: both gates pass; the difference is above zero, with the persona-clustered 95% interval
     above zero and the exact two-sided McNemar p below 0.05; guard 6 (exact by guard 1); guard 7: no question kind
     down by more than max(1 question, 2% of the kind), counted as the paired sum of score changes, so multi-session
     may lose at most 1.6 questions and every other kind at most 1; guard 8: the abstention score not below
     `cap_only`'s.
   - **`fail`** when a gate fails (a guard 4 overflow is terminal), when guard 7 or guard 8 fails, or when the whole
     95% interval is below zero.
   - **`inconclusive`** otherwise: superiority not shown, a blocked comparison (a missing or duplicated row), or more
     than 3 reader errors in either primary arm after the resume passes.
5. **Guard 9 (latency)** is carried from E2's dev reading: 1,200 live `query` calls on the LongMemEval-S slice put the
   `depth_first` handler's p95 at 1.04 times `off`'s, within the +20% limit. H1 makes no live sealed calls.

## Power, computed before custody

[`scripts/power.ts`](2026-10-10-gbrain-budgeted-delivery-h1/scripts/power.ts) simulates 1,000 sealed-shaped sets (40
personas, each with two multi-session, one temporal, one knowledge-update and one abstention question) by drawing each
question's (`cap_only`, `depth_first`) pair from E2's committed Sonnet rows of the same kind, and runs each set
through the committed family and `decideH1` (bootstrap draws lowered to 2,000 for speed). The output is
[`power.json`](2026-10-10-gbrain-budgeted-delivery-h1/power.json).

E2's pairs per kind (LongMemEval-S, Sonnet 5.5):

| Kind | E2 questions | `cap_only` | `depth_first` | Difference | Discordant pairs |
|---|---:|---:|---:|---:|---:|
| Multi-session | 121 | 52.1% | 56.2% | +4.1 | 29% |
| Temporal | 127 | 55.1% | 70.1% | +15.0 | 24% |
| Knowledge update | 72 | 69.4% | 88.9% | +19.4 | 25% |
| Abstention | 30 | 93.3% | 93.3% | 0 | 0% |

If those effects carry over, the sealed mix gains about 17 questions (8.5 points). Results:

| Scenario | P(pass) | P(fail) | P(inconclusive) | Most common cause of failure |
|---|---:|---:|---:|---|
| E2's effects carry over | 65% | 17% | 19% | guard 7 on multi-session (16%) |
| Multi-session has E2's discordance but no gain | 36% | 41% | 23% | guard 7 on multi-session (41%) |
| Multi-session behaves as `cap_only`'s breadth helped it in E2 (E2's `breadth_capped` pairs) | 1% | 97% | 2% | guard 7 on multi-session (97%) |
| No effect in any kind | 1.9% | 74% | 24% | guard 7 (false-pass rate of the whole rule) |

The honest reading: even if E2 transfers, the chance of a `pass` is about two in three, and most of the risk is guard
7 on multi-session, where 80 questions with E2's discordance can easily lose two questions by chance. If sealed v2's
multi-session questions reward breadth (they need two to four chats months apart), `depth_first` is very unlikely to
pass, which is the caveat E2 named. With no true effect the rule passes 1.9% of the time. Pairs are drawn
independently within a persona; a persona effect would widen the interval somewhat.

## What each outcome means for the default

| Outcome | gbrain default |
|---|---|
| `pass` | Recommend a gbrain pull request that makes `depth_first` the explicit-budget default (`search.auto_packing`). Callers that pass no budget see no change (guard 1). |
| `fail` | `cap_only` stays the explicit-budget default. The set is not reopened for `depth_first`, and nothing is tuned on it. |
| `inconclusive` | The same as `fail`. |

Each arm is answered once. No other packing, budget, unit, reader, prompt or judge is tried on the sealed set under
this decision.

## What gets measured besides the decision

Each is reported and decides nothing:

- `depth_first` against `off`, `off` on five hits against `cap_only`, and `depth_first` against `off` on five hits
  (Sonnet), with `family-descriptive.json`.
- `depth_first` against `cap_only` under Opus 5.5 and gpt-6.1-sol.
- Packed recall: every gold chat among the chats the reader saw, over the 160 answerable questions (`packed_recall_all`
  in `family.json`). A correct cap can deliver fewer chats, so this is not a guard.
- Per arm and kind: scores, delivered tokens and blocks, sessions delivered, cuts, reader tokens and reader errors.
- Spend per step against its estimate (`ledger/summary.json`).

## How the run handles failures

A crashed step is rerun on the same output: memory-qa keeps finished rows, identical reader requests are served from
the custody QA cache, frozen questions are never retrieved again, and the score step skips arms already scored. At
most three resume passes per step. After them, a question with no answer is judged wrong and stays in the
denominator; a question missing from either primary arm blocks the comparison (`inconclusive`). A lease cell that
fails keeps its spend in the ledger; a rerun reserves a new lease from what is left of the cap.

## Custody

The whole chain runs on Garry's Mac under one root, `~/gbrain-heldout-custody/h1-sealed-v2/`, through
[`h1-run.sh`](../../eval/runner/budgeted-delivery/h1-run.sh):

1. Bun 1.4.2 (the CI pin) is installed inside the root when the host has another version (the Mac has 1.3.10).
2. `questions.json`, `labels.json` and `access-log.jsonl` are copied from the owner's private directory into
   `<root>/sealed/`.
3. `custody-check` checks both files against the manifest (the labels are hashed, never parsed) and the access log
   against the six lines `decision.json` records: one solvability line, decision 1's two score lines and the three
   P8 open lines. Any other line, or any later line that is not this decision's, stops the run. `labels.json` is then
   mode 000 until the score step and again after it.
4. `corpus` writes a label-free memory-qa corpus (no kind, gold chat or answer), logging the open first.
5. The freeze, delivery and reader cells and the score step run as local lease cells of the H1 campaign, with the
   campaign state, each lease proxy's ledger and usage log, every memory-qa output, the QA and embedding caches and
   `TMPDIR` inside the root. memory-qa refuses an output or cache outside the root, and `sealed-confirmation.ts score
   --custody-root` refuses a report, spend ledger or response cache outside it before the labels are opened.
6. `export` writes aggregates only to `<root>/export/` and refuses to write anything if any file names a question,
   chat or persona id of the corpus, or the root's path.
7. The access log goes back to the owner's directory only if the owner's copy is its prefix and every added line is
   this decision's.

Only `<root>/export/` and the access log leave the root. No sealed text goes to a Capy machine, Capy Drive or the
repository.

**Disclosures the protocol requires.** On 2026-10-04 and 2026-10-05 the chat text (not the questions or `labels.json`)
of 34 of the 40 histories was imported into throwaway brains and sent to model providers for gbrain P8 quote grounding.
No label or ledger was read, and nothing in evidence delivery, packing or this decision was tuned on that text. The
access log's state above was verified on the custody machine on 2026-10-10.

**Keyless dry run.** [`h1-dry-run.sh`](../../eval/runner/budgeted-delivery/h1-dry-run.sh) runs the whole chain on an
invented fixture shaped like sealed v2 ([`h1-fixture.ts`](../../eval/runner/budgeted-delivery/h1-fixture.ts): 12
personas, 60 questions in the sealed mix, 144 chats of about 3,300 tokens), with dummy keys, hash vectors and the
reranker off in the freeze, and every lease proxy pointed at a stub that answers per prompt. Receipts are in
[`receipts/dry-run/`](2026-10-10-gbrain-budgeted-delivery-h1/receipts/dry-run/): the export exactly as a custodian
would copy it, and `dry-run-summary.json`. It showed:

- Both gates passed on frozen evidence before any label read: guard 1 on 60 of 60 questions, guard 3 with no
  `depth_first` delivery over 5,500, guard 4 with no `depth_first` cut, and every one of the 480 reader contexts
  carrying E2's recipe hash and re-rendering to the bytes the reader got.
- The labels were read 8 times, once per arm, all after the final gate, and `labels.json` was mode 000 at the end.
- Nine refusal probes, each refused with no access-log line added: a score report, spend ledger or custody root
  outside the root or inside the repository; a memory-qa output outside the root; the gate after a label read; an
  export outside the root; a foreign access-log line; a tampered questions file; and returning a log with a foreign
  line.
- No fixture text or id outside the custody root and the owner's directory (repository, `~/.cache`, `/tmp`).
- Byte-identical frozen lists and evidence at `ca2c447bd` and `8a3eedeac`.

The dry run's verdict, answers and dollar figures mean nothing. It did not exercise the real freeze (real embeddings
and the Voyage reranker, which E2's freeze cell ran on the same code), and this machine already had Bun 1.4.2, so the
in-root install was checked separately.

**Harness changes since E2.** H1 adds `deliver_set=h1` (the four variants above, each delivered exactly as E2
delivered it), reader-only arms (`judge: "none"`), the questions file's hash on memory-qa's custody open line,
`--custody-root` on the sealed score command, the `OPENAI_BASE_URL` override in the sealed runner's judge client (so
the lease proxy meters it; the judge text is unchanged), a keyless upstream for local lease cells, and the stub's
`/responses` route and `--vary` mode. `sealed-confirmation-lib.ts` is listed in the v2 manifest's generator hashes;
it had already changed since generation before this preregistration, and no test pins it.

## Budget

Estimated from E2's measured token means at list prices: Sonnet 5.5 and gpt-6.1-sol $2 and $10, Opus 5.5 $4 and $20
per million input and output tokens.

| Step | Basis | Estimate | Lease cap |
|---|---|---:|---:|
| Freeze | 40 histories of about 143,000 tokens embedded once (about $0.75) and about 240 reranked queries (about $0.15), with headroom | $1.50 | $5 |
| Deliver | No provider call expected | $0 | $0.50 |
| Sonnet 5.5 readers | 800 calls (4 contexts × 200) at about 9,300 to 11,000 input and 400 to 440 output tokens, about $0.023 each | $19 | $57 |
| Opus 5.5 and gpt-6.1-sol readers | 400 Opus calls at about $0.047 and 400 gpt-6.1-sol calls at about $0.015 | $24.50 | $74.50 |
| Judge | 1,600 gpt-4o calls at about $0.0012 (decision 1 measured 400 for $0.47) | $2 | $8 |
| **Total** | | **$47** | **$145** |

The cap is $145, about three times the estimate (Garry), held by one campaign ledger whose program cap is the H1 cap,
with one lease per step. A step past twice its estimate keeps running and the report names it. The budgeted delivery
program's cap is $1,500; E1 spent about $50 and E2 $178.46. The plan's earlier estimate of about $85 assumed three
frontier replay readers and a reader for the 5-hit pair; H1 replays two readers and reads `off` on five hits with
Sonnet only.

## Commands (repository root, on the custody machine)

```bash
git fetch origin && git checkout <this registration's commit> && bun install --frozen-lockfile
git -C ~/gbrain-master fetch origin 8a3eedeacb6e52da5b413502019692db80c5cc5d
# keys in the environment: ANTHROPIC_API_KEY (readers), OPENAI_API_KEY (embeddings, gpt-6.1-sol, judge), VOYAGE_API_KEY (reranker)
H1_SEALED_SRC=<owner's private directory> \
  bash eval/runner/budgeted-delivery/h1-run.sh all ~/gbrain-heldout-custody/h1-sealed-v2 ~/gbrain-master
cp -r ~/gbrain-heldout-custody/h1-sealed-v2/export docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/results
```

The keyless dry run, anywhere outside the repository:

```bash
bash eval/runner/budgeted-delivery/h1-dry-run.sh <out dir> <gbrain checkout> \
  docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/receipts/dry-run
bun docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/scripts/power.ts > docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/power.json
```

## Changelog

### 2026-10-10: registered

First version, with `decision.json`, the families, the arms files, the campaign, the power simulation and the keyless
dry-run receipts, before any sealed file was copied into the custody root.
