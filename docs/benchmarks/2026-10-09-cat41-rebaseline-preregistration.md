# Cat 41 re-baseline, fresh install to wired recall: preregistration

Written 2026-10-09, before any session of this run. Plan: "Build the 10x memory advantage" (GBRA-60), D8's proof
column ("TTHW, re-baselined") and section 6's fixed slot. This file is committed before the paid cells it governs.

## Question

How long does a real agent take to go from a clean machine to a fact recalled through its own MCP tools on the current
gbrain release, and how does that compare with the two published measurements of the same scenario?

The answer becomes the comparator for wave 2's `gbrain setup <harness>` work. It is a measurement, not a gate: no
result here passes or fails a release.

## What runs

- **Scenario:** Cat 41 `fresh_install_to_wired_recall`, unchanged (`eval/runner/cat41/scenarios.ts`, SHA-256
  `8f9bd3ac0c7817fbf456482e1bce46665d9bcb063194b4faaf747d596549f879` at gbrain-evals `8cbc61f7`). The user asks the
  agent to install gbrain with `bun install -g github:garrytan/gbrain#<commit>`, set it up keyless, connect it to the
  agent as an MCP server and remember that their favorite tea is genmaicha, asking at most one question. A scripted
  reply ("Use the defaults you recommend and go ahead.") follows when the agent asks or has not registered gbrain; then
  a new session asks "What's my favorite tea? Use your gbrain memory tools."
- **gbrain under test:** `dda603ac9e152be45afd6f4edd3789bc11e000b8`, master at v0.60.130.0, the newest release on
  2026-10-09. The install-relevant files (`AGENTS.md`, `INSTALL_FOR_AGENTS.md`, `README.md`, `src/mcp/`,
  `src/commands/bootstrap.ts`, `src/core/bootstrap/`, `src/core/mcp-registration.ts`, `src/commands/init.ts`) are
  byte-identical to gbrain-evals' `package.json` pin `8a3eedeac` (v0.60.126.0); only `package.json`'s version differs.
- **Harnesses and models:** image `gbrain-evals-cat41:v1` (Claude Code 2.1.285 with `claude-opus-5-5`, Codex CLI
  0.160.0 with `gpt-6.1-sol`, Bun 1.4.2, Node 24.18.0), the same pins and models as both published passes. This is a
  re-baseline of two fixed harness and model pairs, not a model comparison, so the model list stays the one the
  baselines used; adding a third model would add a cell with no baseline.
- **Repeats:** 3 per harness, 6 sessions in all, concurrency 1 (one container at a time). The published passes ran 4
  containers at once alongside other scenarios; the report notes this when it compares wall times.
- **Command:**

  ```sh
  bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat41-rebaseline.sqlite --program-cap-usd 30 --reason "GBRA-60 D8 Cat 41 re-baseline cap"
  RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger .budget/cat41-rebaseline.sqlite --runner cat41-agent-operator --budget-usd 30 | tail -1)
  bun eval/runner/cat41-agent-operator.ts run --gbrain <gbrain checkout>@dda603ac9e152be45afd6f4edd3789bc11e000b8 \
    --label rebaseline-dda603a --scenarios fresh_install_to_wired_recall --repeat 3 --concurrency 1 \
    --paid --budget-ledger .budget/cat41-rebaseline.sqlite --budget-run-id "$RID" --out eval/reports/cat41/rebaseline-dda603a
  bun eval/runner/cat41-agent-operator.ts overhead --gbrain <gbrain checkout>@dda603ac9e152be45afd6f4edd3789bc11e000b8 --out eval/reports/cat41/rebaseline-dda603a
  ```

- **Budget:** $30 ledger cap. Expected spend about $3.20 (the two published passes spent $3.20 and $3.32 on this
  scenario).

## Reranker probe

The fail-closed rerank probe from gbrain-evals #109 (`rerankProbe` in `eval/runner/cat40/gbrain-arm.ts`) checks gbrain
slots that call real providers through the metering proxy. This scenario has no slot and no provider: the user asks
for a keyless brain, and the container sends gbrain's model calls to a fake provider. Reranking is off on purpose,
as in both baselines, which is the probe's documented exception ("turn reranking off on purpose and say so in the
preregistration"). The report checks the fake provider's request log and states whether any rerank request appeared.

## What the report states

Per harness, per run and as the mean of 3:

1. **Wall time:** the sum of the agent sessions' wall time, the number both published tables report (`Mean wall s`).
2. **Agent time:** wall time minus `download_ms` (the runner's `install.agent_ms`).
3. **`download_ms`:** a cold `bun install -g` of the same package as root, before the agent starts, reported
   separately.
4. **User replies:** scripted conversational round trips between the first prompt and the recall session.
5. **Consent violations** (scorer v5 rules, as published) and **fabricated user facts**.
6. **Success:** the recall session made a successful gbrain MCP call and answered genmaicha, with no extra user facts.
7. **Cost**, from the ledger.

Beside them: `566a242` (v0.60.35.0) 93.4 s Claude Code / 437.9 s Codex and `b3f4e8b` (v0.60.38.0, the passed
confirmation build) 96.7 s / 121.7 s, n = 3 per cell, from the published `scores.jsonl` files.

## Attribution

Wave 0 changed two things an installing agent meets: new registrations pin `--surface full` (143 tools on a keyless
brain) where the `b3f4e8b` docs showed `--surface verbs`, and the discovery behavior (`request_tools`, the hidden-tool
sentence). A change in wall time or tool behavior is attributed only from the transcripts, by counting for each run
in this pass and in the `b3f4e8b` archive: the registration command and surface the agent used, the number of shell
commands and gbrain MCP calls per session, the tools the recall session called, and the per-session wall time. With
n = 3 and a published Codex range of 101 to 138 s on `b3f4e8b`, a difference inside the two passes' combined range is
reported as no measured change. The token overhead (`initialize` instructions plus `tools/list` bytes per surface) is
measured for the pin and set beside `b3f4e8b`'s.

## Wave 2 targets (restated from the plan, not judged here)

D8 freezes these for the wave 2 preregistration: wired recall at Claude Code ≤ 60 s and Codex ≤ 120 s with
`download_ms` reported beside them, and a separate `fresh_install_to_first_push` cell at Claude Code ≤ 120 s and
Codex ≤ 180 s. The report says where the current release stands against the wired-recall numbers so the setup work
starts from a measured gap. No faster-setup claim follows from this run.

## Errors

A harness crash is retried up to twice by the runner and otherwise reported inconclusive. A failed or partial run is
published with the rest; nothing is rerun to get a better time.
