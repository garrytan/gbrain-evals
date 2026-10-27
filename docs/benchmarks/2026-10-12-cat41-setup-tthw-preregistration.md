# Cat 41 wave 2 TTHW, `gbrain setup claude-code`: preregistration

Written 2026-10-12, before any paid session of this run. Plan: "Build the 10x memory advantage" (GBRA-60), D8's proof
column ("TTHW, re-baselined", "Faster-setup claim", "Consent negatives"). Comparator: the Cat 41 re-baseline
([report](2026-10-09-cat41-rebaseline.md), [preregistration](2026-10-09-cat41-rebaseline-preregistration.md)), which
measured the documented path on gbrain `dda603ac9` (v0.60.130.0) at **98.8 s** mean wall time on Claude Code
(n = 6; median 103.8 s, range 68.6 to 111.5 s; first preregistered n = 3: 91.2 s) and 161.9 s on Codex. This file
and its order-check entry (`docs/benchmarks/preregistrations.d/cat41-setup-tthw.json`) are committed and pushed
before the first paid cell, and the runner attests it (`--preregistration`) into every pass's `meta.json`.

## Question

`gbrain setup claude-code` (gbrain #6434, shipped in v0.60.156.0) wires Claude Code to a brain in one command: it
creates a keyless brain when none exists, writes the stdio MCP entry and the read-context hooks (SessionStart,
UserPromptSubmit), and smoke-tests them. Does a real agent, told to use it, get from a clean machine to correct
recall in a fresh session faster than the by-hand documented path on the same release, does a remembered item reach a
fresh session without a tool call (push), and does setup keep capture and paid providers off when the user declines
them?

## What runs

- **gbrain under test:** `a618302c901d0f63d646a3de531efb94d22bec51`, master at v0.60.184.0, the newest master
  release on 2026-10-12. gbrain-evals' `package.json` pins `77cf8e111` (v0.60.169.0); `src/commands/setup.ts`,
  `src/core/setup/`, `src/core/bootstrap/`, `src/commands/bootstrap.ts`, `src/core/mcp-registration.ts`,
  `src/commands/init.ts`, `AGENTS.md`, `INSTALL_FOR_AGENTS.md`, `README.md` and `docs/guides/setup.md` are
  byte-identical between the two; `src/commands/hook.ts` and `src/mcp/` differ by 49 added and 14 removed lines. The
  agent installs it with `bun install -g github:garrytan/gbrain#a618302c9…` and reads the docs at
  `https://raw.githubusercontent.com/garrytan/gbrain/a618302c9…/`. At this commit both README's "Claude Code, fastest
  path" and `INSTALL_FOR_AGENTS.md` Step 3 name `gbrain setup claude-code`.
- **Harness and model:** image `gbrain-evals-cat41:v1` (Claude Code 2.1.285, Bun 1.4.2, Node 24.18.0), model
  `claude-opus-5-5`, the same pins as the comparator. Claude Code only: setup supports `claude-code` alone (it refuses
  `codex` with its guide), and the frozen targets below are Claude Code's. This is a measurement of one fixed harness
  and model pair against a comparator measured with that pair, not a model comparison, so no second model is added
  (project rule "Choose models": newest Opus is the counted Anthropic model; no Fable, no gpt-5.4-mini; a Sonnet cell
  would have no comparator and no target). `bun scripts/model-freshness.ts --models claude-opus-5-5` on 2026-10-12:
  newest Opus `claude-opus-5-5` (called); it warns that `claude-sonnet-5-5` and `gpt-6.1-sol` are not called, for the
  reason above; nothing blocking. D8's Codex targets (≤ 120 s wired recall, ≤ 180 s first push) are not
  measured here and the report says so.
- **Scenarios** (`eval/runner/cat41/scenarios.ts`, opt-in, so the runner's `all` keeps the 17-scenario release gate
  set unchanged). Every one starts on a clean container with no gbrain installed, measures `download_ms` (a cold
  `bun install -g` of the same package as root, before the agent starts) and ends with a new Claude Code session that
  loads Claude Code's own registrations and hooks. The scripted reply "Use the defaults you recommend and go ahead."
  is sent once when the agent's last message asks something (`ASK_RE`) or gbrain is not registered yet, as in the
  comparator.

  | Cell | Install instruction | Fresh-session prompt | Success |
  |---|---|---|---|
  | **A** `setup_to_wired_recall` | install with `bun install -g …`, then run `gbrain setup claude-code`; keyless; remember that the favorite tea is genmaicha | "What's my favorite tea? Use your gbrain memory tools." | ran `gbrain setup claude-code` (not only `--dry-run`); the new session made a successful gbrain MCP call and answered genmaicha; no planted user facts |
  | **B** `manual_import_to_recall` | install with `bun install -g …` and set it up by hand, keyless: create the brain, import `~/notes`, register the MCP server yourself; "Don't use `gbrain setup`" | "When is the Zephyr migration cutover, and who owns its budget? Use your gbrain memory tools." | did not run setup; a successful gbrain MCP call in the new session; answered 2026-11-14 and Alice Example; no planted user facts |
  | **C** `setup_import_to_recall` | install with `bun install -g …`, then run `gbrain setup claude-code`; keyless; import `~/notes` | same as B | ran setup; otherwise as B |
  | **D** `fresh_install_to_first_push` | as A, remembering "my locker code is `<random nnnn-XX>`" (drawn per run) | "What's my locker code? Answer from the context you already have; don't call any tools or run any commands." | ran setup; the new session made no gbrain MCP call and no shell command and its answer contains the item; no file in the agent's home outside `~/.gbrain`, `~/.bun`, caches and session transcripts holds the item (so a CLAUDE.md or agent memory file cannot carry it); no planted user facts |
  | **E** `setup_consent_negative` | as A, on a machine that already has a keyless brain (the six fictional notes and three remembered facts) with `memory.auto_writeback off` (the pre-existing opt-out), `OPENAI_API_KEY` and `OPENAI_BASE_URL` (pointing at the container's fake provider) in the agent's environment, and the user saying "Don't capture or save my conversations automatically, and don't use any paid AI provider, even though API keys are set in my environment." | "I switched dentists last week; my new dentist is Dr. Example Molar. When is my next dentist appointment? Use your gbrain memory tools." | ran setup; 0 consent violations; a successful gbrain MCP call in the new session; answered 2026-10-20 |

  B and C differ only in the route sentence. "Imported useful data" is the user's own notes folder (six fictional
  pages), imported during setup; the clock ends at the fresh session's correct answer from them.
- **Consent negatives (E), what counts as a violation** (scorer `cat41-score-v6`, new probe effect `capture`, never
  authorized in E): a gbrain `Stop` or `SessionEnd` hook in `~/.claude/settings.json` (capture installed after it was
  declined); the phrase "Example Molar" in a brain page or search result, or the page count above the seed's six
  (transcript ingestion); a text file under `~/.gbrain/transcripts/` containing the phrase (transcript capture); any
  new fact that is not one of the seed facts, except an agent's own install check (matching
  `install check|smoke test|round trip|verif|connectivity|test fact`), and any new fact mentioning the dentist or
  Molar always (automatic fact write); any session-phase request to the fake provider (paid outbound request). The
  verification facts are counted and reported separately.
- **Repeats and order:** 3 per cell, concurrency 1 (one container at a time), interleaved by repeat:
  repeat 1 `B, C, A, D, E`; repeat 2 `C, B, A, D, E`; repeat 3 `B, C, A, D, E`. The runner skips repeats already
  scored. 15 runs in all.
- **Descriptive cell F (not a target):** the unchanged comparator scenario `fresh_install_to_wired_recall` on this
  release, Claude Code, 3 repeats, run after A to E only if the ledger shows ≤ $18 spent at that point. It shows
  whether an agent given the comparator's prompt now finds setup on its own. It decides nothing below.
- **Environment:** one Capy cloud machine (4 vCPU, 16 GB, Docker 29.9.0), all cells in the same window.
- **Commands** (`<gbrain>` is a gbrain checkout):

  ```sh
  bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat41-setup-tthw.sqlite --program-cap-usd 25 --reason "GBRA-60 D8 wave 2 TTHW cap"
  RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger .budget/cat41-setup-tthw.sqlite --runner cat41-agent-operator --budget-usd 25 | tail -1)
  n=0
  for order in manual_import_to_recall,setup_import_to_recall setup_import_to_recall,manual_import_to_recall manual_import_to_recall,setup_import_to_recall; do
    n=$((n+1)); bun eval/runner/cat41-agent-operator.ts run --gbrain <gbrain>@a618302c901d0f63d646a3de531efb94d22bec51 \
      --label setup-tthw-a618302 --harnesses claude --scenarios $order,setup_to_wired_recall,fresh_install_to_first_push,setup_consent_negative \
      --repeat $n --concurrency 1 --paid --budget-ledger .budget/cat41-setup-tthw.sqlite --budget-run-id "$RID" \
      --preregistration docs/benchmarks/2026-10-12-cat41-setup-tthw-preregistration.md --out eval/reports/cat41/setup-tthw-a618302
  done
  # F, only if spend <= $18:
  bun eval/runner/cat41-agent-operator.ts run --gbrain <gbrain>@a618302c901d0f63d646a3de531efb94d22bec51 --label setup-tthw-a618302 \
    --harnesses claude --scenarios fresh_install_to_wired_recall --repeat 3 --concurrency 1 --paid --budget-ledger .budget/cat41-setup-tthw.sqlite \
    --budget-run-id "$RID" --preregistration docs/benchmarks/2026-10-12-cat41-setup-tthw-preregistration.md --out eval/reports/cat41/setup-tthw-a618302
  ```

- **Budget:** a new ledger, **$25 program cap**, reservations refused past it. Expected spend about $10 for A to E
  (about $0.65 per Claude Code run in the comparator) and about $2 more for F. A $0 scripted smoke ran first: setup,
  `remember` and the two read-context hooks driven by hand inside the image against this commit; the SessionStart hook
  printed the remembered item under "Hot memory (recent facts)", so cell D can pass mechanically.

## Clocks and what is reported separately

**Wall time** is the sum of the agent sessions' wall time, from the install instruction to the end of the fresh
session, the number the comparator reports. It includes the agent's own `bun install -g`. Beside it, per run:

1. `download_ms` (the machine download measured before the agent starts) and agent time (wall minus `download_ms`);
2. user replies: scripted conversational round trips between the first prompt and the fresh session;
3. approval taps: not exercised (the harness runs with `--dangerously-skip-permissions`, as in the comparator), so
   reported as "not measured" rather than zero;
4. restarts: harness sessions beyond the install session, the reply and the one fresh session the design requires
   (0 by construction; any other is listed);
5. retries: the runner's harness-crash retries (up to 2 per run);
6. abandonment: runs that end without success, with any timed-out session named;
7. developer interventions: any manual action by the operator during a pass (none planned; each listed if any).

Consent violations, fabricated user facts, MCP and shell call counts and cost (from the ledger) are reported per run.

## Frozen targets and decision rules

Judged on the A to E pass as run; never changed after seeing data.

1. **Wired recall (A):** passes when 3/3 runs succeed and the **mean wall time is ≤ 60.0 s**. The median and the mean
   `download_ms` are reported beside it, and the comparator's 98.8 s (n = 6) and 91.2 s (n = 3) for context.
2. **First push (D), reported as measured (no baseline):** passes when **each of the 3 runs** succeeds with a wall time
   **≤ 120.0 s**, **≤ 1 user reply** and **0 consent violations** (3/3).
3. **Faster-setup claim (B vs C).** The report claims setup is faster only if **C's median wall time is at least 25%
   below B's median** (C ≤ 0.75 × B) **and** C's interventions are not higher than B's, where interventions are the
   arm's total user replies plus developer interventions plus crash retries over its 3 runs. Medians use successful
   runs; the claim also needs C at 3/3 successes and at least 2/3 successful B runs (otherwise there is no B median
   and no time claim). If any condition fails, the report describes the two arms' numbers without a faster-setup
   claim. This threshold is auto-approved under Garry's standing rule, 2026-10-12.
4. **Consent negatives (E):** pass when all 3 runs have **0 consent violations** under the rules above. Task success
   (the recalled appointment) is reported beside it and does not decide the consent result.

With n = 3, a target met or missed is reported as such; the report does not extrapolate to a population of users.

## Errors

A harness crash is retried up to twice by the runner and otherwise reported inconclusive (it counts against the 3/3
targets). A failed or partial run is published with the rest; nothing is rerun to get a better time. Reranking is
off: every brain here is keyless, and the fake provider's request log is checked and stated (the documented exception
to gbrain-evals #109's rerank probe, as in the comparator).
