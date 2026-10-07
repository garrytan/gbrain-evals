# Fix wave 12 agent smoke: moving the forget caveat into the memory clause costs Opus 5.5 write-back cells; the restored put_page UUID line does no harm

**Measured October 7, 2026, on gbrain `capy/fix-wave-11` head `027d3c69f` (baseline) and fix wave 12 head `209b20a96` (GBRA-57), in the same window. Preregistered before any cell ran ([preregistration](2026-10-07-wave12-agent-smoke-preregistration.md), commit `5ee10126`; amendment 1 `c8042a27`, written after the preregistered cells and before the attribution set). Spend $38.88.**

[gbrain](https://github.com/garrytan/gbrain) gives an agent an operating contract (the **initialize instructions**) and a description for every tool when it connects over MCP. Fix wave 12 changes two of those texts:

- **W4.6** moves the `forget` caveat ("`forget` withdraws a fact from active memory; it never erases source material, history or backups.") from a late clause of its own into the memory clause (clause 2), inside the first 2,048 characters some harnesses keep.
- **W4.16** puts "Keep a request_id UUID; retry with identical arguments" back into the put_page description, after the fix wave 11 smoke ([#92](https://github.com/garrytan/gbrain-evals/pull/92)) saw Opus 5.5 send more non-UUID first `request_id`s without it.

This smoke reuses #92's harness and gated cells so the numbers compare.

## The finding

**W4.6: regress, by the preregistered gate.** Permission tasks are unchanged (60/60 on both builds, no leaks, no over-refusals), but Opus 5.5 write-back drops from 20/20 to 15/20, which fails the write-back check and the per-model check (5 cells, limit 3). The preregistered attribution set names the instruction change: the wave 12 build serving the baseline's instructions scores 19/20, closing 4 of the 5 cells.

**W4.16: pass, no harm; the hoped-for improvement is not shown.** The candidate's put_page description carries the UUID line and the baseline's does not. Opus 5.5 sent a non-UUID `request_id` on its first write in 14 of 30 write-back cells on wave 12 and 17 of 30 on the baseline (Fisher two-sided p = 0.61). Sonnet 5.5 and GPT-6.1 Sol never sent one. W4.16's third preregistered condition (the build-level write-back gate) fails, but the attribution set keeps the W4.16 text, reverts only W4.6 and scores 19/20, so that failure belongs to W4.6.

| Check (3 counted models, gated sets) | Baseline | Wave 12 | Rule | Holds |
|---|---|---|---|---|
| Consent (C) success | 60/60 | 60/60 | no more than 3 cells below | yes |
| Consent: output leaks | 0 | 0 | not higher | yes |
| Consent: over-refusals | 0 | 0 | no more than 2 above | yes |
| Write-back (F) success | 60/60 | 55/60 | no more than 3 cells below | **no** |
| Write-back: unsafe writes | 0 | 0 | not higher | yes |
| Write-back: cells with no session-1 write | 0 | 0 | no more than 2 above | yes |
| Per model, C and F | see below | see below | no model more than 3 of 20 below | **no** (Opus F, 5 below) |

How strong the evidence is: within this run, Opus 5.5 write-back with the baseline instruction text scored 48 of 50 (baseline gated 20/20, baseline extra 9/10, attribution 19/20) and with wave 12's text 24 of 30 (Fisher p = 0.047). The baseline's served instructions are byte-identical to #92's wave 11 build (sha256 `8a0a8e9c4061`), where Opus scored 16/20, and #92's master scored 15/20 with a different order. Counting every run with this exact baseline text gives 64/70 against 24/30 (p = 0.18). So the regression is consistent, and the attribution set agrees with the gate, but on its own the smoke cannot rule out a noisy baseline run. The verdict stays the preregistered one.

## Per model

Gated cells, 2 repeats (successes of 20):

| Model | C, baseline | C, wave 12 | F, baseline | F, wave 12 |
|---|---|---|---|---|
| `claude-opus-5-5` | 20 (ceiling) | 20 (ceiling) | 20 | **15** |
| `claude-sonnet-5-5` | 20 (ceiling) | 20 (ceiling) | 20 (ceiling) | 20 (ceiling) |
| `gpt-6.1-sol` | 20 (ceiling) | 20 (ceiling) | 20 (ceiling) | 20 (ceiling) |

Opus 5.5 write-back, all sets, with first-write `request_id`:

| Set | Build | Instructions | Success | Non-UUID first write (all recovered or accepted) |
|---|---|---|---|---|
| Gated, 2 repeats | baseline | baseline | 20/20 | 11/20 |
| Extra, 1 repeat | baseline | baseline | 9/10 | 6/10 |
| Gated, 2 repeats | wave 12 | wave 12 | 15/20 | 9/20 |
| Extra, 1 repeat | wave 12 | wave 12 | 9/10 | 5/10 |
| Attribution, 2 repeats | wave 12 | **baseline** | 19/20 | 11/20 |

**Ceilings.** Five of the six model-family cells are at 100% on both builds. They can show a drop but not a gain. Only Opus 5.5 on write-back sat below the ceiling, as in #92.

## What changed, as the model saw it

The served texts were captured in every set (`served-instructions.txt`, `served-tools.json`). Exactly two things differ between the builds:

- **Instructions** (3,631 → 3,623 characters, starter surface). Clause 2 now ends "… Facts saved with remember are read back with recall (or entity), not search. `forget` withdraws a fact from active memory; it never erases source material, history or backups." The old clause 10 ("`forget` withdraws active memory; it does not promise erasure of source material, history, or backups.") is gone, and every clause after clause 2 moves down by about 99 characters.
- **put_page** description gains the UUID line, and its `content` parameter reads "Complete markdown (get_page include_content:true)." No other tool changed, and no model called `put_page` or `put_pages` in any of the 280 cells.

**Why Opus misses.** Every wave 12 miss is on F01, F07 or F09, the tasks Opus also missed in #92. The mechanism is the one #92 named: Opus saves the correction with `remember`, finds it in session 2, then keeps the older CRM record, for example: "There is also a saved memory fact … I didn't treat it as overriding the records." One reading of the data, not tested here: the new clause 2 sets "facts saved with remember" right next to "source material … never erased", which may strengthen Opus's habit of ranking its own saved facts below records. The answering clause's "agent-written notes do not override records" is unchanged on both builds.

## The 2,048-character cap, computed, not measured

The table is computed from each build's `buildMcpInstructions`. Cat 40 gives the model the whole instructions, so no cell measures it:

| Rendering | "Answering from the brain" clause (characters), baseline → wave 12 | Cut by a 2,048-character cap, baseline → wave 12 |
|---|---|---|
| starter, writeback off (this smoke) | 1,438–1,950 → 1,537–2,049 | nothing → the final "." |
| full, writeback off | 1,589–2,101 → 1,688–2,200 | 53 → 152 characters of the "what is true now" sentence |
| full, writeback private | 1,719–2,231 → 1,818–2,330 | 183 → 282 characters |

The forget caveat itself moves from character 2,583 to 598 (starter) and from 2,734 to 659 (full, off), so it is now inside the cap. In a capped harness on the full surface, the price is that more of clause 7's "for what is true now, prefer the newest governing source …" rule falls outside it.

## What to use and what to avoid

- **Don't ship W4.6 as written** without a fix or a deliberate decision. The cheapest variants that keep the caveat inside 2,048 characters without touching the memory clause are a short clause of its own right after clause 2 or clause 3, or a shorter caveat. Either needs the same Opus write-back check (about $4.5 for 20 cells per variant).
- **W4.16 can ship.** It does no harm, but it did not measurably lower Opus's non-UUID first writes (14/30 against 17/30). Across every run so far, Opus sends a non-UUID first id about half the time with the line and about two-thirds of the time without it (37/70 against 34/50, p = 0.13). Opus recovers every time, so the cost is one extra round trip.
- **Side observation.** In one baseline cell, a batch `remember` (with `items`) accepted the non-UUID top-level `request_id` `7c1e2a9e-5b3f-4d0a-9e61-qul1-20260915`, while single `remember`, `edit_page` and `add_timeline_entry` refuse non-UUID ids. This is worth a look in gbrain's batch path.

Limits:

- **Small.** 20 gated tasks, 2 repeats (3 for Opus write-back), one synthetic world. A smoke, not the full ladder.
- **Ceilings.** Only one model-family cell can move.
- **Uncapped instructions, default config.** The 2,048-character truncation and the ambient-writeback line are not exercised.
- **put_page was not called**, so W4.16 is tested only as text the model reads.

## The experiment

Cat 40 Model Ladder ([protocol](2026-10-02-model-ladder-protocol.md)), `gbrain` arm, published v1 world (seed 20261002, 3,973 documents), gbrain default configuration, starter surface, whole tool results, 16 turns, no claims judge, Bun 1.4.2. Each build got four slot brains from its own commit under its own `--gbrain-root`, and both builds ran at the same time with identical commands. Models, the newest of each family by the OpenAI and Anthropic model lists on 2026-10-07: `claude-opus-5-5`, `claude-sonnet-5-5` and `gpt-6.1-sol` (`gpt-6-astra` is an earlier GPT-6 release). Fable is smoke-only and optional and was left out to save cost. The same three models ran in #92, which links the two runs.

Sets per build: gated C01-C10 and F01-F10 × 2 repeats × 3 models (120 cells), and Opus F01-F10 × 1 extra repeat (10 cells). After the gate tripped, amendment 1 added one attribution set: the wave 12 build serving `baseline-gated/served-instructions.txt` through `--gbrain-instructions-file`, Opus F × 2 (20 cells). #92's sentinel and Fable rows were dropped to keep the smoke under $40.

## Reproduce and inspect

From the repository root, with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and a gbrain checkout at `/workspace/gbrain`. The [preregistration](2026-10-07-wave12-agent-smoke-preregistration.md) has the full commands.

Each set directory in [`2026-10-07-wave12-agent-smoke/`](2026-10-07-wave12-agent-smoke/) holds the experiment binding, receipt, per-cell results, run log, served instructions and tools, compressed transcripts and the `analyze.ts` output: `baseline-gated`, `wave12-gated`, `baseline-opus-f-extra`, `wave12-opus-f-extra`, `wave12-baseline-instructions` (with the `instructions-override.txt` it served; its `served-instructions.txt` is the server's own text, captured before the override), and the slot builds `slots-baseline` and `slots-wave12`. The summary is [`verdict.json`](2026-10-07-wave12-agent-smoke/verdict.json). The first-write `request_id` count reads each F transcript's first write-tool call. Applied to #92's transcripts, the same count gives #92's 12/20 and 17/20.

**Time and cost.** Slot builds took about 22 minutes, both builds in parallel. The 130 cells per build took about 37 minutes in parallel, and the attribution set took 8 minutes. The preregistered cells cost $33.37 (baseline $17.29, wave 12 $16.08), against $32.5 projected. The attribution set cost $4.54, the slot builds $0.77, and other ledger charges not tied to a cell record $0.21. The ledger (program cap $40) reconciles to $38.88 with no open reservations ([`ledger-status.json`](2026-10-07-wave12-agent-smoke/ledger-status.json)). The first cell launch passed `--gbrain-root` with an unexpanded `~`, so it stopped at the slot-snapshot check before any cell or charge; its logs are in `failed-launch/`.
