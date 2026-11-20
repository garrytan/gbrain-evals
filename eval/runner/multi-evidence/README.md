# Multi-evidence dev loop

Many questions people ask a memory need several pieces of evidence: "which APAC accounts had an open escalated ticket
on March 14" needs every matching ticket, and "how did my vegetable servings change across my updates" needs every
session where the user mentioned them. When gbrain hands over only some of that evidence, the answer comes out
incomplete or wrong. In the nightly check this "partial evidence" is the most common reason gbrain's rows fail.

This loop scores any gbrain build on exactly those questions and says, item by item, how much of the gold evidence
reached the model, where the rest went, and whether the agent ran out of turns first.

## Run it

```sh
# keyless plumbing check (scripted agents, a fake QA system)
bun eval/runner/multi-evidence/dev-loop.ts --out eval/reports/multi-evidence --fake

# the newest gbrain release, paid, with the turn-cap and batch-read arms
bun eval/runner/multi-evidence/dev-loop.ts --out eval/reports/multi-evidence --arms base,cap2x,batch \
  --paid --budget-ledger <ledger.sqlite> --budget-usd <dollars>

# a specific build: a tag, a commit or a branch of the gbrain clone (--gbrain-clone, default ../gbrain)
bun eval/runner/multi-evidence/dev-loop.ts --out eval/reports/multi-evidence --gbrain <tag|sha|branch> --fake

# re-score a finished run directory without calling anything
bun eval/runner/multi-evidence/dev-loop.ts --report eval/reports/multi-evidence/<ref>
```

To compare a build that changes only how pages are read with the newest release, run both on the same brains and score
the pair. `--slots-from` builds the Cat 40 brains with the release and serves the other build on them, so only the
server code differs between the two runs:

```sh
bun eval/runner/multi-evidence/dev-loop.ts --out <dir> --suites cat40-hard-m --gbrain v<release> --cat40-slots 3 ...
bun eval/runner/multi-evidence/dev-loop.ts --out <dir> --suites cat40-hard-m --gbrain <sha> --slots-from v<release> --cat40-slots 3 ...
bun eval/runner/multi-evidence/ship-bar.ts --base <dir>/v<release> --candidate <dir>/<sha> --privacy <ad-sharing-cells.json>
```

`ship-bar.ts` checks the bar set for `get_page` with `slugs` (gbrain#9798): how many cells that need two or more pages
use `slugs`, whether page-read text (every `get_page` result, single or batch) per cell falls by 15% while total
tool-result text doesn't grow, whether correct answers drop by more than 15 points, and whether
`test/eval/sharing-contract.test.ts` passes with its `slugs` reads. Run that test with `AD_REPORT_DIR` and
node_modules/gbrain linked to a clean git checkout of the build: the file it writes names that commit and every
scenario, and `ship-bar.ts` refuses a file from another commit, a dirty tree, a link that changed during the run or a
partial run. It also refuses the
comparison when a pair's gold pages, turn cap or setup differ (each cells dir's world, brains, Hard identity, evaluator
code, served instructions, tool names and cell flags), so rerun `--report` on a run dir made before rows recorded their
setup. Each number is paired by item and agent, with a 95% bootstrap interval over items.

Without --gbrain it measures gbrain's newest release: the highest vX.Y.Z tag on gbrain's master. It needs the
LongMemEval-S and BEAM-1M datasets (`bun run eval:decide fetch --benchmark lme-s`, then `beam-1m`) and, for a
paid run, ANTHROPIC_API_KEY, OPENAI_API_KEY and VOYAGE_API_KEY. Run paid work on a large machine; the Cat 40 brains
take a while to build (scripts/nightly-vm.sh sets up a VM for it).

## The questions

eval/data/multi-evidence/devset-v1.json, built by `select.ts` from the nightly dev set: every item whose gold has two or
more items. 24 Cat 40 Hard world M tasks (a synthetic company with about 50,000 documents; an agent answers through
gbrain's MCP tools), 31 LongMemEval-S questions and 97 public BEAM-1M questions (gbrain ranks a conversation's sessions
and a reader answers from the top ones). LongMemEval and BEAM items are kept only when the answerability check passes
them, so a question whose cited turns don't support its answer is dropped
([why](../../../docs/benchmarks/2026-11-10-beam-item-support.md)).

## Arms

- **base**: the nightly's settings. A 16-turn cap for the agent; the reader gets the top 5 sessions. The 5 is this
  harness's choice (memory-qa's `--qa-sessions` default), not a gbrain setting: gbrain returns a ranked list of
  chunks, and memory-qa groups them by session and hands the reader the first five.
- **cap2x**: twice the budget. A 32-turn cap; the reader gets the top 10 sessions of the same ranked list. If an item
  recovers here, gbrain found the evidence and the budget cut it off.
- **batch**: the base cap, with one paragraph added to gbrain's server instructions telling the agent to read several
  pages in one call (`assemble_evidence` with up to 50 hits, or `query` with `return_unit: "page"`).

On Cat 40, cap2x and batch run only on the items base missed (a wrong answer, or some gold not delivered, for either
agent). That keeps the cost down, but Cat 40's agents aren't deterministic, so a follow-up arm could also lose items
base got right, and this loop doesn't measure those losses. The report shows these arms only as "recovered among base
misses (n)", never as an arm's accuracy or as a difference against base. The QA suites run cap2x on every item. Each
agent row counts its `assemble_evidence` calls, so the batch arm separates "told about batch reads and used them" from
"told and ignored it".

Background work: from v0.60.733.0, an idle `gbrain serve` runs upkeep after 10 to 20 minutes with no request. Upkeep
is left on, as shipped. It can't reach another cell, because each Cat 40 slot has its own `HOME` and `GBRAIN_HOME` and
is restored from its post-build snapshot before the next cell. The LME-S and BEAM arms run no server: each conversation
gets a fresh in-memory brain.

## What it reports

Per item, reader and arm (items.jsonl): the gold items, which were retrieved and delivered, which were cut, turns used
against the cap, tool calls, and whether the answer was right. For an agent, delivered gold is gold that any tool
result names, because gbrain's search rows carry the page's text; for a reader, it is gold in the sessions it was
given, and "cut by packing" is gold gbrain ranked past that cut. why.jsonl has every missed item with each call, what it
returned and each gold item's fate. report.md has the tables, the turn-cap comparison, the cost, and the smallest
change in "all gold delivered" the set can detect between two builds.

## What a run costs and what it can see

The first paid run used gbrain v0.60.733.0 on 2026-11-16. Its costs, from the ledger's usage fields:

- **base arm, all 152 items with both models:** about $69. That's Cat 40's agents at $39.09, building the five Cat 40 brains at $13.68 (embeddings) and the QA readers and judges at $15.94. Building the brains takes about 70 minutes on a 16-vCPU VM.
- **cap2x:** $31.52 on every QA item. On Cat 40 it cost $44.62 for 29 cells, run only on the items base missed.

The set can't see a 5-point change in "all gold delivered" between two builds. The smallest change it detects at 80%
power is 7.3 points pooled, 8.1 on BEAM, 25.3 on LongMemEval and 26.6 on Cat 40. Retrieval is deterministic within one
build, so for the QA suites the limit is the number of items, not run-to-run noise. Cat 40's limit comes from its agents
disagreeing with themselves on 16.7% of trial pairs.

Cat 40 answers are scored by its deterministic scorer; LongMemEval and BEAM answers by a judge from the other model
family than the reader (GPT-6 Astra for Claude, Claude Opus 5.5 for GPT).
