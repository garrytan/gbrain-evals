# Which MCP tool surface should gbrain register? (T1 cell)

**Finding (2026-10-05).** On ten company-knowledge and memory tasks, agents on gbrain's `starter` tool surface
succeeded as often as on the `full` surface (40 of 40 both) while sending 36% fewer tokens, and more often than on
the seven-verb `verbs` surface (37 of 40). By the preregistered rule gbrain keeps `starter` as the surface every
stdio registration it writes pins. The result is a keep, not a proof that `starter` is better than `full`: every
model reached 100% on both, so this cell cannot show a difference between them.

Preregistration: [2026-10-05-registration-surface-preregistration.md](2026-10-05-registration-surface-preregistration.md).
Raw results: [2026-10-05-registration-surface/](2026-10-05-registration-surface/).

## The question

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. An agent harness (Claude Code, Codex,
opencode) talks to it through an MCP server, and the server can expose three tool surfaces:

| Surface | What the agent sees |
|---|---|
| `verbs` | The seven memory verbs: `recall`, `remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta` |
| `starter` | The verbs plus page search, reads and writes, timeline writes, skills, the agent lane and `request_tools` (about 35 tools) |
| `full` | Every operation (about 130 tools) |

gbrain's installers used to register different surfaces depending on which command an agent ran. The
agent-operator follow-up wave makes every registration pin one surface. A bigger list gives the agent more tools but
costs tokens on every turn and gives it more ways to pick the wrong one; a smaller list can strand a task that needs
a tool it lacks. This cell measures that trade on real tasks.

## The concrete case

A typical task: "What payment terms are currently in force with a customer?" The knowledge base holds the contract,
an internal email that misstates the terms, an unreviewed agent note that guesses them, and sometimes an executed
amendment that changes them. The agent has to search, read the governing document and submit the value. A
write-back task tells the agent a billing-contact correction in one session and asks it to use the correction in a
fresh session, so the agent must save it in a form a later session finds.

## The experiment

- **Harness:** the Cat 40 agent loop (`eval/runner/cat40-model-ladder.ts`) on the development world
  (`eval/data/model-ladder-v1`, a fictional company with 3,973 documents), gbrain arm only, whole tool results,
  16 turns, no claims judge.
- **gbrain build:** `c72d6ffa308c` on branch `capy/aow-fu-lane1` (v0.60.49.0 plus the follow-up wave's Items 1 and 2).
  Three slot brains built once (`slots/`, $0.29 of embeddings), served with `--surface verbs|starter|full`.
- **Tasks:** A01, A04 (which contract term governs), B01, B02 (who owns the account now or on a date), C01, C06
  (permissions: an answerable question and a restricted one), E01, E02 (five-part renewal briefs), F01, F02
  (write-back across sessions).
- **Models:** the newest frontier model of each family: Claude Opus 5.5, GPT-6.1 Sol, Claude Sonnet 5.5,
  Claude Fable 5.1. One repeat. 120 cells.

## Results

| Surface | Success | Tool calls | Tool errors | `request_tools` calls | Tokens | Cost |
|---|---|---|---|---|---|---|
| `starter` | 40/40 | 334 | 0 | 0 | 7.92M | $14.17 |
| `full` | 40/40 | 310 | 0 | 0 | 12.31M | $15.39 |
| `verbs` | 37/40 | 244 | 0 | 0 | 7.35M | $14.37 |

By model (success out of 10):

| Model | `starter` | `full` | `verbs` |
|---|---|---|---|
| Claude Sonnet 5.5 | 10 | 10 | 9 |
| GPT-6.1 Sol | 10 | 10 | 9 |
| Claude Opus 5.5 | 10 | 10 | 9 |
| Claude Fable 5.1 | 10 | 10 | 10 |

Paired against `starter` over task × model pairs, with a 95% interval from 2,000 bootstrap resamples of tasks:

| Alternative | Difference | 95% interval | Rule |
|---|---|---|---|
| `full` − `starter` | 0.0 points | [0.0, 0.0] | interval not above zero: keep `starter` |
| `verbs` − `starter` | −7.5 points | [−20.0, 0.0] | interval not above zero: keep `starter` |

What the numbers mean:

- **`full` matches `starter` at a higher price.** The full tool list is re-sent on every turn, so the same 40 tasks
  used 55% more tokens. Prompt caching absorbed most of it: cost rose 9%.
- **`verbs` lost three renewal briefs.** All three failures are family E (GPT-6.1 Sol on E01, Sonnet 5.5 and Opus 5.5
  on E02): each model submitted a brief with a field the scorer marked wrong. The `verbs` surface has no `search`
  or `get_page`, so the agent assembles a five-part brief from `recall` and `entity` results; family E is already the
  hardest family for gbrain on every surface.
- **No model widened its surface.** Nothing in these tasks needed a tool outside `starter`, and no agent on `verbs`
  called `request_tools` (it is not on that surface). The loop sends a fixed tool list, so this cell does not
  measure how a harness handles `tools/list_changed`.
- **Ceiling.** Every model scored 100% on `starter` and `full`. A harder task mix is needed to tell those two apart.
- **Safety.** No output leaks, context exposures or unsafe writes on any surface.

## What to use

Use `starter` for agent registrations: it carries the page and timeline tools agents use for company knowledge and
write-back, at the token cost of the smallest surface. Use `full` when an agent needs maintenance or administration
tools; on stdio a session can add them with `request_tools {"surface":"full"}`. Use `verbs` for a memory-only
client that never reads or writes pages.

## Reproduce and inspect

```
bun eval/runner/cat40-model-ladder.ts --build-slots --gbrain-repo ../gbrain --gbrain-ref c72d6ffa308cb8431964936b9a66dbc4f8c536a6 \
  --slots 3 --slot-build-allowance-usd 3 --budget-usd 12 --program-cap-usd 150 --budget-ledger <ledger> --out eval/reports/cat40/t1-slots
for s in starter full verbs; do
  bun eval/runner/cat40-model-ladder.ts --models claude-opus-5-5,gpt-6.1-sol,claude-sonnet-5-5,claude-fable-5-1 --arms gbrain \
    --tasks A01,A04,B01,B02,C01,C06,E01,E02,F01,F02 --surface $s --gbrain-label gbrain-$s --judge none --max-tool-chars none \
    --transcripts --gbrain-repo ../gbrain --gbrain-ref c72d6ffa308cb8431964936b9a66dbc4f8c536a6 --slots 3 --concurrency 3 \
    --budget-usd 50 --program-cap-usd 150 --budget-ledger <ledger> --out eval/reports/cat40/t1-$s
done
bun docs/benchmarks/2026-10-05-registration-surface/analyze.ts
```

Keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`. Spend: $43.93 in agent cells plus $0.29 of slot
builds, about 32 minutes of agent time on one machine. Each surface folder holds `results.jsonl`, the
`experiment.json` binding, the budget receipt, the served tool list and instructions, the run log and gzipped
transcripts; `summary.json` is the analysis output. Machine paths are redacted to `<evals>`, `<gbrain>`, `<work>`
and `<home>`.
