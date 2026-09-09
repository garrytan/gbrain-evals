# BrainBench Cat 34: remembering something without being asked

Published under the June 12, 2026 corpus-freeze date. The first run finished June 13 at 17:44 UTC on gbrain 0.44.0.0. A September 1 rerun tested gbrain 0.47.8.0 on a larger corpus.

A memory system can have excellent search and still be unhelpful. The agent may never think to search. This test asks whether gbrain puts a useful memory into the agent's context at the right moment, stays quiet when it should, saves supplied facts correctly, and carries them into another session.

The June run found a specific defect: lowercase names and surname-only mentions caused nine missed retrieval triggers. The same misses appeared through all three integration shapes because they shared the same entity resolver. That gave us a concrete fix to make. Gbrain v0.46.15.0 fixed those cases; the September rerun recorded zero missed triggers and zero false triggers on its expanded corpus.

## What is being measured

BrainBench's memory suite lives in the gbrain repository. This repository calls it through a subprocess and a JSON contract. It tests gbrain's memory layer under three ways an agent can receive context; it does not rank three competing agents' intelligence.

A “pointer” is a short reference to a stored page. If a user mentions three people and the integration allows only one pointer, even a resolver that recognizes every name may leave useful pages out. “Push recall” measures how much expected memory was supplied. “Push precision” asks how much supplied memory was appropriate.

“Know to ask” measures whether a turn triggers retrieval when it should. A false fire is the opposite mistake: adding memory to a turn that should stay quiet. Write-back tests saving supplied facts with provenance. Continuity tests whether another session can retrieve what a previous session saved. Isolation checks whether a source receives another source's content.

## The first run

These tables and charts preserve the original June measurements.

| harness (seam) | know-to-ask failure ↓ | false fire ↓ | push recall ↑ | push precision ↑ | write-back fidelity ↑ | continuity ↑ | isolation violations |
|---|---|---|---|---|---|---|---|
| **openclaw (production)** | **0.150** | **0.000** | **0.809** | **1.000** | **1.000** | **1.000** | **0** |
| claude-code (contract) | 0.150 | 0.023 | 0.660 | 1.000 | 1.000 | 1.000 | 0 |
| codex (contract) | 0.150 | 0.000 | 0.447 | 1.000 | 1.000 | 1.000 | 0 |

![June push recall by integration](2026-06-12-brainbench-memory/push-recall.svg)

The chart shows the first run's 0.809 / 0.660 / 0.447 recall. It has not been redrawn with September values.

All three rows use `extractCandidates` followed by `resolveEntitiesToPointers`. The OpenClaw row exercised the production context-engine path: up to three pointers and suppression of material already in the conversation. The Claude Code row modeled the hook contract with two pointers and only the current prompt. The Codex row modeled a static entity index plus one per-turn fragment. Index slugs did not count as retrieved memories.

These constraints explain why the rows differ, but this is not a pure budget-only experiment: suppression and the available conversation state also change. In June, the Claude Code and Codex rows were contract simulations, not measurements of live third-party applications.

| System | k/budget | n (gold turns) | LLM in loop? | know-to-ask fail | push R / P | write-back | continuity | Source |
|---|---|---|---|---|---|---|---|---|
| **gbrain reflex via openclaw (production)** | 3 pointers | 146 kta / 94 push | no | **0.150** | **0.809 / 1.000** | **1.000** | **1.000** | this run |
| gbrain via claude-code hook contract | 2 pointers | 146 / 94 | no | 0.150 | 0.660 / 1.000 | 1.000 | 1.000 | this run |
| gbrain via codex fragments contract | 1 fragment | 146 / 94 | no | 0.150 | 0.447 / 1.000 | 1.000 | 1.000 | this run |

## Where it failed

![June suite results](2026-06-12-brainbench-memory/suite-matrix.svg)

This chart also preserves the June run. The detailed counts were:

| harness | kta failed/gold | push failed/gold | write-back failed/gold | continuity failed/gold |
|---|---|---|---|---|
| openclaw | 9/146 | 18/94 | 0/58 | 0/12 |
| claude-code | 11/146 | 32/94 | 0/58 | 0/12 |
| codex | 9/146 | 52/94 | 0/58 | 0/12 |

The know-to-ask denominator needs care. The 146 turns contain 60 that should retrieve and 86 that should stay silent. Nine missed positive turns give a failure rate of 9/60 = 0.150. The Claude Code contract also fired on two silent turns: 2/86 = 0.023. Its combined failure count is therefore 11/146. Dividing nine by 146 would answer a different question.

The shared nine misses involved deliberately difficult lowercase or surname-only references. The two extra Claude Code failures were repeated injections that conversation-aware suppression would have prevented. These are actionable findings: improve name resolution and carry enough context to avoid reminding the agent of something it already has.

The original push results also make a product tradeoff visible. A smaller context allowance can reduce clutter, but it can omit useful memories. A budget should be chosen with the expected task in mind.

## How much context it adds

| harness | avg injected tokens/turn (kta) | continuity |
|---|---|---|
| openclaw | 33.8 | 75.3 |
| claude-code | 30.9 | 75.3 |
| codex | 40.7 | 150.9 |

The Codex contract's static preamble is included in these token counts. Its lower per-turn fragment allowance did not automatically mean a smaller total context bill: in continuity conversations, the reported average was 150.9 tokens, compared with 75.3 for the other two shapes.

| Adapter | full run wall | per-fixture | LLM calls | cost |
|---|---|---|---|---|
| all three, full suite | ~7–10 s | ~60 ms | 0 | $0 |

These were local, deterministic runs with in-memory PGLite, no embeddings, and no model calls. The write pipeline received perfect, supplied extractions. A 1.000 write-back score means that this pipeline preserved those inputs and their provenance. It does not mean a model extracted every real-world fact correctly.

## The September rerun

On September 1, a keyless run at gbrain `2a56b51236850f6abcbf2f1ea71981bb9630f6fe` (v0.47.8.0) reproduced that release's committed baseline in about 22 seconds at $0 API cost. The corpus had grown to 149 know-to-ask turns and 96 push turns.

Missed-trigger and false-fire rates were both zero for all three integrations. Push recall was 0.9063 for OpenClaw, 1.000 for Claude Code, and 0.5521 for Codex, with precision 1.000 throughout. Write-back and continuity remained 1.000, with zero recorded isolation violations. Claude Code's integration was now labeled production; Codex remained a contract row.

These are two release snapshots on different corpora, not a paired experiment that isolates one change. The September run reproduces its own baseline; it cannot authenticate the June run merely by agreeing with a later expected result.

Its receipt says `verdict: fail`. That is consistent with the numbers. This repository's foreign runner demands zero failed gold items in every cell. OpenClaw still missed 9/96 push items and Codex 43/96. Gbrain's own CI instead checks for regression against a committed baseline, which this run matched exactly. Passing a regression check and achieving perfect recall are different standards.

## What these results establish

The suite gives gbrain a repeatable test of when and how to offer memory. It caught a shared name-resolution problem and makes context-budget losses visible. It also checks that supplied facts survive the write path and that the tested sources remain isolated.

It does not measure whether a live answering model reads or uses the injected memory. The agent-in-the-loop replay described as `--live` was not implemented for these runs. The paid `--llm` extraction path was not run. Determinism removes run-to-run randomness from this plumbing test; it does not establish robustness to model variation.

The suite contains 141 fictional conversation fixtures and 241 annotated turns across seven categories, generated with Mulberry32 seed 42. The published June gate uses 118 fixtures; 23 holdout fixtures are excluded. Read-only suites share a seeded brain across adapters. Write/continuity cases reset state between fixtures, and continuity tests persist facts across ordered writer/reader pairs.

There is also a trust limit: this repository grades counters reported by the system under test. It does not independently rescore sealed gold. The receipts show what gbrain's evaluator reported. An independently implemented scorer would provide a stronger check.

## Reproduction and evidence

These are the original reproduction commands. Check out the cited release first when reproducing a historical result; cloning today's default branch tests different software.

```bash
# 1. gbrain checkout carrying BrainBench (Cathedral 2 release, > v0.42.40.0)
git clone https://github.com/garrytan/gbrain && cd gbrain && bun install

# 2. the run this scorecard reports (from the gbrain repo)
bun src/cli.ts eval brainbench --harness all --suite all --json --out /tmp/bb.json

# 3. or through this repo's runner (imports no gbrain internals)
cd ../gbrain-evals
GBRAIN_REPO=../gbrain bun eval/runner/cat34-brainbench-memory.ts
# receipts: eval/reports/cat34-brainbench-memory/{receipt,result}.json and scorecard.md
```

The deterministic corpus can be rebuilt with `bun evals/brainbench/generator/gen.ts` in gbrain. Its June SHA-256 is `76f201590dd3ad7a929e2e12efc9bf1406627b10ef4edbcfe7caf379aafd4090`; the larger September corpus is `509fd20d7cda693350030393b6d54154e2685516d30f017ca219bd25e92c0e57`.

The [evidence directory](2026-06-12-brainbench-memory/) contains both runs, with separate `receipt`, `result`, and `scorecard` files:

- `2026-06-12-published` records gbrain `15a9019788d11619329284c3f0bcbc3b7db045df`, zero seed failures, and 786 per-turn result rows.
- `2026-09-01-v0.47.8.0-rerun` records the later release and expanded corpus. Its counters match `evals/brainbench/baselines/main.json` at that pin.

The foreign runner is `eval/runner/cat34-brainbench-memory.ts`. The underlying fixtures, schemas, metrics, and CI baseline live in gbrain's `evals/brainbench/` and `src/eval/brainbench/`; metric definitions are in its `docs/eval/BRAINBENCH.md` and `docs/eval/METRIC_GLOSSARY.md`.
