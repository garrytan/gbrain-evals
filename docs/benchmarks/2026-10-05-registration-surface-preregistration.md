# Registration surface cell (T1): preregistration

Written 2026-10-05, before any cell of this experiment ran.

## The question

gbrain's MCP server can expose three tool surfaces: `verbs` (the seven memory
verbs), `starter` (the verbs plus page reads and writes, timeline writes,
skills and the agent lane, about 35 tools) and `full` (every operation, about
130 tools). The installers in gbrain used to register different surfaces
depending on which command an agent ran. The agent-operator follow-up wave
makes every stdio registration gbrain writes use one surface, `starter`, and
lets a session widen itself with `request_tools {"surface":"full"}`.

Does an agent complete company-knowledge and memory-loop tasks as well on
`starter` as on `full` and `verbs`? The winner sets `REGISTRATION_SURFACE` in
gbrain; an inconclusive result keeps `starter`.

## The comparison

- **Harness:** the Cat 40 agent loop (`eval/runner/cat40-model-ladder.ts`), gbrain
  arm only, whole tool results (`--max-tool-chars none`), 16 turns, no claims
  judge (`--judge none`).
- **Arms:** the same gbrain build and the same slot brains, served with
  `--surface verbs`, `--surface starter` and `--surface full`. Labels
  `gbrain-verbs`, `gbrain-starter`, `gbrain-full`.
- **gbrain build:** branch `capy/aow-fu-lane1` of the follow-up wave (the commit
  is recorded in each run's `experiment.json`).
- **World:** `eval/data/model-ladder-v1/world.json` (the development world).
- **Tasks:** ten, two per family, chosen by variant before running: A01
  (contract holds), A04 (amended), B01 (current owner), B02 (owner as of a past
  date), C01 (answerable, a derived digest exists), C06 (restricted question),
  E01 and E02 (renewal briefs), F01 and F02 (write-back: a correction told in
  one session, used in a fresh one).
- **Models:** the newest frontier model of each family: `claude-opus-5-5`,
  `gpt-6.1-sol`, `claude-sonnet-5-5`, `claude-fable-5-1`. One repeat.
- **Sample:** 10 tasks × 4 models × 3 surfaces = 120 cells.
- **Budget:** a $150 cap in the SQLite budget ledger, slot builds included.

The evaluator change for this cell: the slot write probe uses `put_page`, which
the `verbs` surface does not serve, so the probe is skipped on a surface
without `put_page`. Fable 5.1's list price is added to the price table.

## Measurements

- **Task success** (primary), scored by Cat 40's scorer.
- **Tool-selection errors:** tool calls whose result is an error (unknown tool,
  invalid parameters), per cell.
- **Tokens and cost** per cell, gbrain's internal provider calls included.
- **`request_tools` widenings:** calls to `request_tools` with a `surface`
  argument, from the recorded transcripts.

## Decision rule

Pool the four models. For each alternative surface X (`full`, `verbs`), compute
the paired success difference X − `starter` over task × model pairs, with a 95%
interval from 2,000 bootstrap resamples of tasks.

- Switch to X only if its interval lies wholly above zero.
- Otherwise keep `starter`. An interval that includes zero is inconclusive and
  keeps `starter`.

Safety counts (output leaks, context exposures) are reported per surface and
never averaged into success. A model at 100% on every surface is reported as a
ceiling: it cannot show a difference.
