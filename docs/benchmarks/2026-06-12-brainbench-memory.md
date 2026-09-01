# BrainBench memory conformance — first published run (Cat 34)

> **Update 2026-08-31 (gbrain v0.47.8.0 master, committed CI baseline).**
> The scorecard below is the first published run and is kept as the
> historical record; gbrain's CI has been holding and moving these numbers
> against a committed baseline ever since, and the current baseline reads:
> know-to-ask failure **0.000 on all three seams** (0/149 — the 9 shared
> misses below were fixed upstream in v0.46.15.0), false fire **0.000 on all
> three** (claude-code's 0.023 included), push recall **0.906 (openclaw) /
> 1.000 (claude-code) / 0.552 (codex)** at precision 1.000 everywhere,
> write-back and continuity 1.000, isolation violations 0. The gold corpus
> has also grown since this run (149 know-to-ask / 96 push turns vs 146/94
> here), so the rows are same-suite but not same-denominator. Source:
> `evals/brainbench/baselines/main.json` in the gbrain repo at pin
> `2a56b51236850f6abcbf2f1ea71981bb9630f6fe` (v0.47.8.0). A keyless re-run
> at that exact pin on 2026-09-01 reproduced that committed baseline
> digit-for-digit; artifacts committed next to this report (see Receipts).

**The first run's verdict in one line: gbrain's production push path
volunteered the right memory 81% of the time it should (current baseline:
91% — see the update above), never injected junk (precision 1.0), never
leaked across sources, and lost zero facts through the write path — while
the two contract seams quantified what tighter injection budgets cost at the
time (recall 0.66 at 2 pointers, 0.45 at 1 fragment; both have since moved,
see banner).**

| harness (seam) | know-to-ask failure ↓ | false fire ↓ | push recall ↑ | push precision ↑ | write-back fidelity ↑ | continuity ↑ | isolation violations |
|---|---|---|---|---|---|---|---|
| **openclaw (production)** | **0.150** | **0.000** | **0.809** | **1.000** | **1.000** | **1.000** | **0** |
| claude-code (contract) | 0.150 | 0.023 | 0.660 | 1.000 | 1.000 | 1.000 | 0 |
| codex (contract) | 0.150 | 0.000 | 0.447 | 1.000 | 1.000 | 1.000 | 0 |

![Push recall by harness seam](./2026-06-12-brainbench-memory/push-recall.svg)

*Chart: first published run, 2026-06-12 (gbrain 0.44.0.0), push recall
0.81 / 0.66 / 0.45. The 2026-09-01 re-run at pin `2a56b512` measures
0.906 / 1.000 / 0.552 (see Receipts). The SVG is hand-authored, kept
unmodified as the historical record; the numbers on it are superseded.*

What changed: agent memory now has a per-harness scorecard. Before this run, a
salience or reflex change shipped on vibes; now every gbrain PR must hold or
move the committed baseline (currently the numbers in the update banner above)
that CI compares against main's copy — a PR cannot rewrite the thing it's
graded by.

## What is gbrain

gbrain is a personal-knowledge brain: markdown files as the source of truth,
indexed into embedded Postgres (PGLite) or managed Postgres + pgvector, with
hybrid retrieval (keyword + vector + RRF fusion, source-aware boosts, optional
expansion). Agents reach it over MCP from any harness. The piece under test
here is the memory layer above retrieval: the Retrieval Reflex (deterministic
push of page pointers into context), the conversation→facts write-back
pipeline, and cross-session/cross-harness continuity.
Repo: github.com/garrytan/gbrain.

## What is the benchmark

BrainBench is gbrain's own cross-harness memory conformance suite, shipped in
the gbrain repo (`evals/brainbench/`, methodology `docs/eval/BRAINBENCH.md`)
and driven here through its published foreign-runner contract — this runner
imports zero gbrain internals. Dataset: 141 conversation fixtures / 241
gold-annotated turns across 7 stratified categories (know-to-ask positive +
negative, push-under-budget, write-back, continuity pairs, multi-source,
adversarial), generated deterministically (Mulberry32, seed 42) over a
whole-cloth fictional universe; gold is sealed in separate files and adapters
only ever see sanitized turns. ~15% of fixtures are holdout, excluded from the
gate run reported here. Metrics: failure/false-fire rates, micro-averaged push
precision/recall, write-back fidelity + provenance accuracy, continuity rate,
source-isolation violation count. Why this benchmark: it operationalizes the
four failure modes every agent-memory thesis names — nobody has a push path,
intrusion budgets are unenforced, write is less solved than read, and
continuity dies at the harness hop.

## Adapters tested

All three drive ONE shared pipeline (`extractCandidates` →
`resolveEntitiesToPointers`) with declarative seam configs, so the deltas
between rows are seam constraints, not implementation drift.

**openclaw — seam: production.** The shipped OpenClaw context-engine path
(`src/core/context-engine.ts` → reflex), byte-for-byte: 3-pointer budget,
prior-context suppression, markdown pointer block. This row is what an
OpenClaw user's memory actually does. Result: 0.150 know-to-ask failure /
0.809 push recall / zero false fires.

**claude-code — seam: contract.** The UserPromptSubmit hook wire contract
(`{prompt, session_id, cwd}` → `additionalContext`), 2-pointer budget, and —
the defining constraint — no conversation memory: a hook sees only the current
prompt. Result: identical resolution quality, but 0.023 false-fire rate (it
re-injects what suppression would have held back) and recall capped at 0.660.

**codex — seam: contract.** The fragments model: a static entity-index
preamble computed once (its slugs deliberately don't count as injections —
counting an index would game recall) plus at most one per-turn fragment.
Result: recall 0.447 — a 1-fragment budget simply cannot cover 3-entity turns
— with the preamble's token cost visible in the intrusion diagnostics.

## Results

Head-to-head, gate corpus (118 non-holdout fixtures; counts are gold items):

| System | k/budget | n (gold turns) | LLM in loop? | know-to-ask fail | push R / P | write-back | continuity | Source |
|---|---|---|---|---|---|---|---|---|
| **gbrain reflex via openclaw (production)** | 3 pointers | 146 kta / 94 push | no | **0.150** | **0.809 / 1.000** | **1.000** | **1.000** | this run |
| gbrain via claude-code hook contract | 2 pointers | 146 / 94 | no | 0.150 | 0.660 / 1.000 | 1.000 | 1.000 | this run |
| gbrain via codex fragments contract | 1 fragment | 146 / 94 | no | 0.150 | 0.447 / 1.000 | 1.000 | 1.000 | this run |

No published external system reports these four memory-conformance metrics
today — that absence is the point of shipping the yardstick. The retrieval
layer underneath has its own head-to-heads (see the LongMemEval and
PrecisionMemBench scorecards in this directory); BrainBench rows become
comparable to other memory systems when someone implements an adapter against
the published fixture/result JSON Schemas (`evals/brainbench/schema/`).

## Per-suite breakdown

![Suite matrix](./2026-06-12-brainbench-memory/suite-matrix.svg)

*Chart: first published run (know-to-ask failure 0.15 on every seam). At
pin `2a56b512` the re-run measures 0.000 on all three (see Receipts). Kept
unmodified as the historical record.*

| harness | kta failed/gold | push failed/gold | write-back failed/gold | continuity failed/gold |
|---|---|---|---|---|
| openclaw | 9/146 | 18/94 | 0/58 | 0/12 |
| claude-code | 11/146 | 32/94 | 0/58 | 0/12 |
| codex | 9/146 | 52/94 | 0/58 | 0/12 |

How the know-to-ask denominators worked in this run (the headline 0.150 does
NOT equal 9/146): the 146 kta gold turns split into **60 should-retrieve
turns and 86 stay-silent turns**. The failure rate is misses over the
should-retrieve subset only — 9/60 = 0.150 — and the false-fire rate is fires
over the stay-silent subset — claude-code's 2/86 = 0.023 (formula:
`know_to_ask_failure_rate = missed / shouldRetrieve`, gbrain
`src/eval/brainbench/metrics/know-to-ask.ts`). The failed/gold column above
sums BOTH failure kinds over both subsets, which is why claude-code shows
11/146: 9 misses + 2 false fires. (The 2026-08-31 update banner at the top
reflects the v0.47.8.0 re-run, where the 9 misses are fixed.)

Three patterns worth pulling out. First, the know-to-ask failure rate was
0.150 on every seam — those 9 misses (of the 60 should-retrieve turns) were the same 9 gold turns, the corpus's
deliberately-hard lowercase and surname-only mentions that the v1 reflex's
capitalization-biased extractor could not see (documented limits in
`entity-salience.ts`). That number was the measured roadmap for the next
reflex iteration, not noise — and the iteration happened: gbrain v0.46.15.0's
identity wave fixed exactly these turns (know-to-ask failure now 0.000; see
the update banner). Second, claude-code's two extra know-to-ask failures are
false fires, not misses: with no conversation memory, the hook contract
re-injects pointers production suppression would hold — the bench prices the
missing state, 0.023 per silent turn. Third, push recall is a clean budget
gradient (0.809 → 0.660 → 0.447) at constant precision 1.000: with exact-match
resolution, everything injected is right, and the only question is how much
the seam lets through.

## Intrusion cost (reported, not gated)

| harness | avg injected tokens/turn (kta) | continuity |
|---|---|---|
| openclaw | 33.8 | 75.3 |
| claude-code | 30.9 | 75.3 |
| codex | 40.7 | 150.9 |

codex's static preamble shows up here (its conversation-start index lands on
turn 1), exactly the trade the fragments model makes: cheaper plumbing, double
the context spend on continuity conversations.

## Latency + cost

| Adapter | full run wall | per-fixture | LLM calls | cost |
|---|---|---|---|---|
| all three, full suite | ~7–10 s | ~60 ms | 0 | $0 |

Hermetic by construction: in-memory PGLite, `noEmbed` seeding, deterministic
gold extractor through the production write-back pipeline. The `--llm` mode
(real extractor, budget-capped) is the only paid path and is not part of the
gate.

## Limits & caveats

- **Contract rows are not third-party measurements.** claude-code and codex
  rows grade gbrain's primitives under those harnesses' injection-shape
  constraints; the real integrations land later and flip the seam label with
  continuous numbers. The `seam` column exists so nobody mistakes one for the
  other.
- **Injection conformance, not consumption.** know-to-ask and push score what
  the memory layer surfaced, before any model consumes it. Agent-in-the-loop
  replay is pre-registered (`--live`) and unimplemented.
- **Deterministic ≠ stochastic robustness.** stddev is 0 by construction;
  these numbers say nothing about LLM-extractor variance (that's `--llm`,
  unpublished).
- **write-back 1.000 is a floor check, not a victory.** The deterministic mode
  hands the pipeline perfect extractions; it proves segmentation/insertion/
  provenance lose nothing. Extraction quality itself is the `--llm` metric.
- **push_precision 1.000 is expected to FALL** when fuzzy/semantic resolution
  lands — exact-match arms can't inject junk on this corpus. The pre-registered
  expectation in the methodology doc says so before the fact.
- Holdout fixtures (23) are excluded here; published runs with
  `--include-holdout` will differ slightly.

## Reproduction

```bash
# 1. gbrain checkout carrying BrainBench (Cathedral 2 release, > v0.42.40.0)
git clone https://github.com/garrytan/gbrain && cd gbrain && bun install

# 2. the run this scorecard reports (from the gbrain repo)
bun src/cli.ts eval brainbench --harness all --suite all --json --out /tmp/bb.json

# 3. or through this repo's runner (imports no gbrain internals)
cd ../gbrain-evals
GBRAIN_REPO=../gbrain bun eval/runner/cat34-brainbench-memory.ts
# receipts: eval/reports/cat34-brainbench-memory/{receipt,scorecard,result}.json
```

Wall time ~10 s, zero API keys, zero cost. Corpus rebuild (byte-identical):
`bun evals/brainbench/generator/gen.ts` in the gbrain repo.

## Methodology details

Fixtures hash
`76f201590dd3ad7a929e2e12efc9bf1406627b10ef4edbcfe7caf379aafd4090`
(sha256 over every fixture + sealed gold file; the grown corpus of the
2026-09-01 re-run hashes
`509fd20d7cda693350030393b6d54154e2685516d30f017ca219bd25e92c0e57`).
One in-memory PGLite per run, `TRUNCATE`-reset between fixtures; read-only
suites seed once and replay all three adapters against the same brain;
continuity pairs run per ordered (writer ≠ reader) harness pair with the
writer's decisions persisted through the production
`extract-conversation-facts` pipeline via its injectable-extractor seam.
Counts (failed/gold) are the gate; rates are display. Know-to-ask rates use
split denominators: 146 gold turns = 60 should-retrieve + 86 stay-silent;
failure rate = misses/60, false-fire rate = fires/86, failed/gold sums both. Source isolation gates
at zero unconditionally. Full formula definitions: gbrain
`docs/eval/BRAINBENCH.md`; plain-English metric glossary: gbrain
`docs/eval/METRIC_GLOSSARY.md`.

## Receipts

Both runs' artifacts are committed next to this report, in
`docs/benchmarks/2026-06-12-brainbench-memory/`:

- **Originals (first published run).** `receipt-2026-06-12-published.json`,
  `result-2026-06-12-published.json`, `scorecard-2026-06-12-published.md`:
  pulled unmodified from the machine that ran them. They attest gbrain
  0.44.0.0 (`15a9019788d11619329284c3f0bcbc3b7db045df`), run timestamp
  2026-06-13T17:44Z (the report carries the corpus-freeze date; the run
  finished a day later), fixtures hash
  `76f201590dd3ad7a929e2e12efc9bf1406627b10ef4edbcfe7caf379aafd4090`,
  exit 0, zero seed failures, and exactly the counters in the tables above
  (786 per-turn rows in the result document).
- **Labeled re-run.** `receipt-2026-09-01-v0.47.8.0-rerun.json`,
  `result-2026-09-01-v0.47.8.0-rerun.json`,
  `scorecard-2026-09-01-v0.47.8.0-rerun.md`: a fresh keyless run of
  `eval/runner/cat34-brainbench-memory.ts` on 2026-09-01 against gbrain at
  pin `2a56b51236850f6abcbf2f1ea71981bb9630f6fe` (v0.47.8.0), ~22 s wall,
  $0. It reproduces the committed CI baseline
  (`evals/brainbench/baselines/main.json` at that SHA) digit-for-digit,
  down to `avg_injected_tokens`: know-to-ask failure 0/149 on all three
  harnesses, false fire 0.000, push recall 0.9063 / 1.000 / 0.5521 at
  precision 1.000, write-back and continuity 1.000, isolation violations 0.

Two honesty notes on what the re-run does and does not prove. First, it
cannot authenticate the historical numbers: the June originals ran a
different gbrain (0.44.0.0) on a smaller corpus (146/94 gold vs 149/96)
with a different fixtures hash, and the 0.81 to 0.91 "refresh" happened
upstream in gbrain CI between those two points, not here. The re-run shows
the pin reproduces its own committed baseline today; nothing more. Second,
the trust boundary: this repo's runner grades pass/fail from counters the
SUT itself reports (`cat34-brainbench-memory.ts:330-365`). It has no
independent gold, so a dishonest SUT could misreport and the runner would
not catch it. The receipt records what BrainBench claimed, verbatim.

The re-run receipt says `verdict: fail`, and that label needs a gloss so
nobody reads it as a regression. The foreign runner's gate is strict:
every cell must reach `gold_failed === 0`. Two push cells cannot meet that
by construction (openclaw's 3-pointer budget leaves 9/96 unrecalled,
codex's 1-fragment budget leaves 43/96), the same pointer-budget gradient
this report has always documented. gbrain's own CI gates differently, by
comparing against the committed baseline, and the re-run matches that
baseline exactly. Every counter moved toward better vs June: know-to-ask
misses 9 to 0, push failures 18 to 9 (openclaw), 32 to 0 (claude-code),
52 to 43 (codex), on the grown corpus. One label flipped: claude-code now
runs as seam `production` (its real integration landed upstream), exactly
the seam-label flip the Limits section above said would happen.

## Files

- `eval/runner/cat34-brainbench-memory.ts`: this runner (subprocess contract only)
- `docs/benchmarks/2026-06-12-brainbench-memory/{receipt,result,scorecard}-2026-06-12-published.*`: the original run's artifacts, committed (see Receipts)
- `docs/benchmarks/2026-06-12-brainbench-memory/{receipt,result,scorecard}-2026-09-01-v0.47.8.0-rerun.*`: the labeled 2026-09-01 re-run at pin `2a56b512`
- `eval/reports/cat34-brainbench-memory/`: where fresh runs land (gitignored, transient; the committed copies above are the durable record)
- gbrain: `src/eval/brainbench/`, `evals/brainbench/` (corpus + schemas + committed baseline), `docs/eval/BRAINBENCH.md`. Original run at `15a9019788d1` (v0.44.0.0, Cathedral 2); re-run at pin `2a56b51236850f6abcbf2f1ea71981bb9630f6fe` (v0.47.8.0)
- Read-only disclosure: this run mutates nothing outside `eval/reports/`.
