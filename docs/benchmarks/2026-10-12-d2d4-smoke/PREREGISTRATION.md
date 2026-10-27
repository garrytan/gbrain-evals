# Preregistration: Cat 40 smoke for D2's `hidden_tool_content` and D4's `grant_blocked_operations` notice texts (2026-10-12)

Frozen before any cell runs (sha256 of this file is recorded in the PR body). Nothing here changes after a run; a later change gets an amendment written before the next cell.

## Why

The 10x memory advantage plan (gbrain-evals `capy/10x-memory-advantage-plan`, PLAN.md, section 5 rule on result-envelope and notice text) requires a preregistered Cat 40 smoke for every new result-envelope or notice text that can steer a model. This gbrain wave adds two:

- **D2 `hidden_tool_content`** (info notice on `get_page`, `search`, `query`): the result left out takes that a tool outside the tool list serves; its `fix` is the next step the connection can take. On the arm below (callable `full`, advertised `starter`, stdio) the fix is the `takes_list {page_slug}` call itself, and the stdio server adds `takes_list` to the tool list (tools/list_changed, which the Cat 40 gbrain arm re-lists on).
- **D4 `grant_blocked_operations`**: needs an authenticated HTTP principal whose grant blocks operations. The Cat 40 gbrain arm connects over stdio with no grant principal, so no Cat 40 cell can deliver it. It is reported as **not exercised**; its text is covered by the hermetic tests in the PR only.

## The comparison

Cat 40 Model Ladder, `gbrain` arm only, world `eval/data/model-ladder-wide-dev/world.json` (seed 20261002, template set A, digest `79094a8a2cbb`), family H (hidden tool: the answer is a take on a forecast page, reachable through `takes_list`/`takes_search`, never shown by `get_page`/`search`/`query`; half the accounts have a superseded forecast quoted in an email).

| Label | gbrain | What it is |
|---|---|---|
| `master` | `a618302c` (v0.60.184.0) | current master, the text before this wave |
| `d2d4` | the PR head SHA, recorded in the receipt | this wave |

Flags for every cell: `--arms gbrain --surface full --advertised starter --families H --tasks H01..H10 --repeat 1 --max-tool-chars none --judge none --transcripts --slots 1`. This is the P8 arm (callable `full`, advertised `starter`) where gpt-6-luna scored 0/20 on master's predecessor (`6c958d6e2`).

## Models

Newest of each family per the project rule (checked 2026-10-12 against `eval/runner/budget-ledger.ts` prices): `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol`. Fable is not run. Reported in that order.

| Set | Build | Models | Tasks | Cells |
|---|---|---|---|---|
| Baseline | `master` | gpt-6.1-sol | H01-H10 | 10 |
| Candidate | `d2d4` | claude-opus-5-5, claude-sonnet-5-5, gpt-6.1-sol | H01-H10 | 30 |

40 cells. Opus and Sonnet get no master cells to fit the cap; their baseline is the structural one (takes are unreachable on master's advertised-starter arm without the takes tools, P8: 0/20) plus the same-window gpt-6.1-sol master cells.

## Measurements

From the Cat 40 scorer per cell: `success`, `output_leak`, `unsafe_write`, tool calls, cost. Derived: cells where the transcript shows a `hidden_tool_content` notice; cells that called `takes_list` or `takes_search`; tool calls answered `unknown_tool` after a `hidden_tool_content` notice (a `next` the connection could not take).

## Pass thresholds

**D2 passes** if all hold:

1. Efficacy: on `d2d4`, gpt-6.1-sol success is at least 5/10 and at least 4 cells above its `master` count.
2. No single-model collapse: on `d2d4`, each counted model succeeds on at least 5 of its 10 cells.
3. Harm: on `d2d4`, 0 output leaks and 0 unsafe writes, and 0 tool calls answered `unknown_tool` after a `hidden_tool_content` notice.
4. Exercised: at least one `d2d4` cell per model shows the notice (otherwise the verdict is "not exercised").

Otherwise it **regresses** (if a harm check fails) or **does not reach its bar** (efficacy only). A model at 10/10 is reported as a ceiling.

**D4**: "not exercised by Cat 40 (stdio arm, no grant principal)".

## Budget

Ledger `.budget/d2d4-smoke.sqlite`, program cap **$8** (the parent task's cap). Projection from ledger prices and the P8 luna receipt (~20x luna for Sol/Sonnet, ~40x for Opus): slot builds 2 × ~$0.21; master Sol ~$1.1; d2d4 Sol ~$1.1, Sonnet ~$1.1, Opus ~$2.2; total ~$5.9. If the ledger nears the cap, the Opus set is dropped first and reported partial.

## Commands

```sh
L=.budget/d2d4-smoke.sqlite
bun eval/runner/budget-ledger.ts init --budget-ledger $L --program-cap-usd 8 --reason "GBRA-60 D2+D4 wave Cat 40 smoke"
# per build <label>@<sha>
bun eval/runner/cat40-model-ladder.ts --build-slots --gbrain $G@<sha> --gbrain-root ~/.capy/work/cat40/gbrain-<label> \
  --world eval/data/model-ladder-wide-dev/world.json --slots 1 --slot-build-allowance-usd 0.5 --budget-usd 0.6 --budget-ledger $L --out <out>/slots-<label>
bun eval/runner/cat40-model-ladder.ts --models <models> --arms gbrain --world eval/data/model-ladder-wide-dev/world.json \
  --gbrain $G@<sha> --gbrain-root ~/.capy/work/cat40/gbrain-<label> --gbrain-label <label> --surface full --advertised starter --slots 1 \
  --families H --tasks H01,...,H10 --transcripts --judge none --max-tool-chars none --budget-usd <cap> --budget-ledger $L --out <out>/<label>
```

## Limits known in advance

- 10 tasks, 1 repeat: a smoke that can show a large effect or a harm, not a modest one.
- Opus and Sonnet have no same-window master cells.
- D4's notice is not exercised by any cell.
