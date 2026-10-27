# `gbrain setup claude-code`, time to a working memory on a clean machine (Cat 41, wave 2)

## The finding

On 2026-10-12 we measured `gbrain setup claude-code` on gbrain master `a618302c9` (v0.60.184.0) with real Claude Code
sessions (`claude-opus-5-5`, Claude Code 2.1.285) on clean containers, three runs per cell, against the targets frozen
in the [preregistration](2026-10-12-cat41-setup-tthw-preregistration.md) before any paid session. `setup` creates a
keyless brain when there is none, registers gbrain as an MCP server in Claude Code, installs two read-only hooks and
tests the wiring, all in one command.

| Target (frozen) | Result | Verdict |
|---|---|---|
| Wired recall: 3/3, mean wall time ≤ 60 s | 3/3, **83.8 s** (median 77.6 s; `download_ms` 3.6 s) | **missed** |
| First push: each run succeeds in ≤ 120 s with ≤ 1 reply and 0 consent violations | **0/3**: no run's fresh session had the remembered item without a tool call | **missed** |
| Faster setup: `setup` median ≥ 25% below the by-hand path, interventions not higher | **65.3 s against 100.5 s (35% lower)**; scripted replies 0 against 3 | **met as scored**, with the caveat below |
| Consent negatives: 0 consent violations in each of 3 runs | 0 capture, 0 unrequested fact writes, 0 paid requests; but every run sent one unbilled `GET /v1/models` to the provider | **not met as written** (met under the scorer's paid-request rule) |

**`setup` makes the install session shorter and cheaper.** Told to import a notes folder and connect gbrain, agents
using `setup` finished the install session in a median 55.8 s against 76.6 s by hand, and the whole cell cost $0.93
against $2.06. All six runs of that pair recalled the imported notes correctly in a fresh session.

**The faster-setup margin rests partly on the scripted user.** In both arms the agent wired gbrain first and then
asked about search mode and automatic saving, a question that does not block recall. The scripted user answers when
the agent's last message matches a fixed pattern; the three by-hand runs phrased it "should I save…?" and got the
reply, while the three `setup` runs phrased it "should agents save…" or "Reply 'defaults'…" and did not. With the
non-blocking reply session left out of both arms, the medians are 84.9 s by hand and 65.3 s with `setup`, 23% lower,
just under the 25% threshold, and both arms asked the user the same one question. The preregistered rule, as scored,
allows the faster-setup claim; we state it with this caveat beside it and do not round it up.

**The wired-recall target is missed for the same reason, plus slack.** Every `setup_to_wired_recall` run got the
scripted reply (each install session ended asking the user to confirm a setting), and the reply session took 13 to 33 s while
the agent applied a setting the fresh session did not need. Without it the three runs average 59.0 s; with it, the
measured 83.8 s misses the 60 s target. The comparator, the documented path on v0.60.130.0, was 98.8 s
([re-baseline](2026-10-09-cat41-rebaseline.md)).

**Push does not reach a fresh Claude Code session yet.** `setup` installs a SessionStart hook that prints recent
facts ("Hot memory") into a new session, but only when it can reach a running gbrain MCP server. In a fresh session
the hook runs while Claude Code is still starting that server, so it printed nothing in every run; the
UserPromptSubmit hook found nothing to add for "What's my locker code?". This matches gbrain's own capability table,
which labels Claude Code push `native-pending`.

**Consent holds on what gbrain writes and spends.** With an OpenAI key in the environment, capture declined and
`memory.auto_writeback off` already set, no run installed a capture hook, ingested the conversation, wrote a fact the
user did not ask for, or made a paid request. Each run did send one unbilled `GET /v1/models` with the user's key,
from `gbrain doctor`, which every agent ran as a health check. The preregistration counts any request to the
provider, so the target is not met as written.

Spend: $8.37 of the $25 ledger cap (18 runs). gbrain's own model calls went to a fake provider and cost nothing.

## The concrete case

The user types one request into a fresh container that has Claude Code and Bun but no gbrain. For the `setup` arm of
the import pair it reads (the commit is the gbrain under test):

> I want you to have long-term memory. Install gbrain for me with `bun install -g github:garrytan/gbrain#a618302c9…`,
> then run `gbrain setup claude-code` (its instructions for agents: …/AGENTS.md). Keep it keyless with no API keys, and
> import my notes from ~/notes. Ask me at most one question if you need to.

The by-hand arm is the same request with "set it up by hand … create the brain, import my notes from ~/notes, and
connect it to this agent (Claude Code) as an MCP server yourself. Don't use `gbrain setup`." The notes are six
fictional pages (a warehouse migration, two people, a vendor decision). Then a new Claude Code session, loading only
Claude Code's own configuration, is asked "When is the Zephyr migration cutover, and who owns its budget? Use your
gbrain memory tools." The correct answer is 2026-11-14 and Alice Example, read through gbrain's MCP tools.

The other cells change the request: remember a favorite tea (A, the comparator's task), remember a random locker code
and then ask for it with tools forbidden (D, push), or keep an existing brain, decline capture and providers with an
OpenAI key in the environment, and then mention a new dentist in passing (E, consent).

## The experiment and results

**Setup.** gbrain `a618302c901d0f63d646a3de531efb94d22bec51` (v0.60.184.0, master on 2026-10-12; gbrain-evals pins
v0.60.169.0, and the setup code and install docs are identical in both). Image `gbrain-evals-cat41:v1`: Claude Code
2.1.285, Bun 1.4.2, Node 24.18.0. One container at a time on one Capy cloud machine (4 vCPU), cells interleaved by
repeat, all in one window (20:40 to 21:09 UTC). Scorer `cat41-score-v6`. Only Claude Code: `setup` supports no other
harness yet, and D8's Codex targets are not measured here. One model, because this re-measures the comparator's
harness and model pair rather than comparing models.

**Wall time** is the sum of the agent sessions, from the install instruction to the fresh session's answer, the
number the comparator reports; it includes the agent's own `bun install -g`. `download_ms` is that install measured
on its own before the agent starts.

| Cell | Success | Wall mean | Wall median (range) | Agent time mean | `download_ms` mean | User replies | Cost |
|---|---|---|---|---|---|---|---|
| A `setup_to_wired_recall` | 3/3 | 83.8 s | 77.6 s (77.5 to 96.2) | 80.2 s | 3.6 s | 1, 1, 1 | $1.61 |
| B `manual_import_to_recall` (by hand) | 3/3 | 96.5 s | 100.5 s (85.4 to 103.7) | 91.1 s | 5.4 s | 1, 1, 1 | $2.06 |
| C `setup_import_to_recall` | 3/3 | 67.1 s | 65.3 s (64.4 to 71.4) | 63.2 s | 3.9 s | 0, 0, 0 | $0.93 |
| D `fresh_install_to_first_push` | 0/3 | 53.4 s | 52.9 s (45.0 to 62.2) | 49.8 s | 3.6 s | 1, 0, 0 | $0.74 |
| E `setup_consent_negative` | 2/3 scored (3/3 on reading) | 95.8 s | 74.3 s (69.2 to 144.0) | 92.2 s | 3.7 s | 0, 0, 0 | $1.34 |
| F comparator prompt, unchanged (descriptive) | 3/3 | 87.2 s | 84.7 s (54.6 to 122.4) | 81.0 s | 6.3 s | 0, 1, 1 | $1.69 |

Per run, seconds per session (install, reply if sent, fresh session):

| Cell | r1 | r2 | r3 |
|---|---|---|---|
| A | 55.6 + 13.3 + 8.6 = 77.5 | 56.5 + 32.6 + 7.2 = 96.2 | 42.8 + 28.4 + 6.3 = 77.6 |
| B | 76.6 + 18.8 + 8.3 = 103.7 | 60.1 + 15.5 + 9.7 = 85.4 | 81.1 + 9.7 + 9.7 = 100.5 |
| C | 60.4 + 11.0 = 71.4 | 53.7 + 10.7 = 64.4 | 55.8 + 9.6 = 65.3 |
| D | 45.4 + 12.8 + 3.9 = 62.2 | 40.7 + 4.3 = 45.0 | 48.7 + 4.2 = 52.9 |
| E | 59.8 + 9.4 = 69.2 | 63.6 + 10.6 = 74.3 | 131.8 + 12.3 = 144.0 |
| F | 46.3 + 8.3 = 54.6 | 63.3 + 14.3 + 7.2 = 84.7 | 87.9 + 27.2 + 7.3 = 122.4 |

**Reported separately, every cell.** Approval taps: not measured (the harness runs with permissions bypassed, as in
the comparator). Restarts beyond the one fresh session the design requires: 0. Crash retries: 0. Abandonment: no
session timed out; the runs that ended without success are D r1 to r3 and E r2 (below). Developer interventions during
the passes: 0. Before the passes the operator made the gbrain build copy readable inside the container
(`chmod -R a+rX` on `.gbrain-overlays/`, whose installed packages had mode 0600); that copy only seeds cell E's
existing brain and reads probe results, never the gbrain the agent installs.

**The faster-setup pair (B against C).** The frozen rule: C's median at most 0.75 times B's, C 3/3, at least 2/3 B
successes, C's interventions (scripted replies plus crash retries plus developer interventions) not above B's. As
scored: 65.3 / 100.5 = 0.65, 3/3 and 3/3, interventions 0 against 3, so the claim condition holds
([`verdict.json`](2026-10-12-cat41-setup-tthw/verdict.json)). What the transcripts add:

- Every B and C run wired gbrain in the install session (B ran `claude mcp add` and `gbrain import` there, C ran
  `gbrain setup claude-code` and `gbrain import`), then ended by asking the user about search mode and automatic
  saving. In no run did the fresh session need the answer.
- The scripted reply fires when the last message matches `ASK_RE` (`eval/runner/cat41/scenarios.ts`) or gbrain is not
  registered. B's three runs asked "should I save…?", which matches; C's asked "should agents save…", "should gbrain
  save…? gbrain recommends…" and "Reply 'keep as is'…", which do not. The comparator's report already noted one such
  miss.
- Like-for-like, the install session alone: median 76.6 s by hand, 55.8 s with `setup` (27% lower). Install plus
  fresh session, leaving the non-blocking reply out of both arms: 84.9 s and 65.3 s (23% lower). Fresh-session recall
  itself is the same (8 to 11 s in both).
- `setup` runs used fewer tokens: $0.31 per run against $0.69 by hand.

**First push (D).** In r1 and r2 the agent saved the code in gbrain ("The user's locker code is 3018-ZU."), opened
nothing else, and the fresh session answered that it did not know the code and offered to look it up. Claude Code's
transcript shows the SessionStart hook ran and returned an empty output; gbrain's hook heartbeat recorded
`session-start ok` and `user-prompt ok, empty_block`. In r3 the agent saved the code to Claude Code's own memory
folder (`~/.claude/projects/…/memory/user-locker-code.md`, marked sensitive) and only an install-check fact to gbrain,
so the run fails on the "outside the brain" rule as well. Why the hook was empty, from a $0 check in the same image
and commit: after `setup` and `remember`, `gbrain hook session-start` prints nothing when no gbrain server is running,
and prints `## Hot memory (recent facts)` with the item when `gbrain serve` is up. The hook reads its context pack
from the running server over a local socket (`src/commands/hook.ts`, SessionStart step 6) and skips silently when it
cannot reach one; in a fresh Claude Code session the server is the MCP server Claude Code is still starting. The
UserPromptSubmit hook's turn context returned an empty block for the locker-code question in r1 and r2 and in the
check.

**Consent negatives (E).**

| Check | r1 | r2 | r3 |
|---|---|---|---|
| Capture hooks (`Stop`, `SessionEnd`) installed | none | none | none |
| Brain pages after the session (seed 6) / phrase in search | 6 / no | 6 / no | 6 / no |
| Phrase in the transcript corpus | no | no | no |
| Facts written the user did not ask for | 0 | 0 | 0 |
| Paid provider requests | 0 | 0 | 0 |
| Unbilled provider requests (`GET /v1/models`) | 1 | 1 | 1 |
| Recalled 2026-10-20 through MCP in the fresh session | yes | yes | yes |

Every run ran `gbrain doctor` with the user's `OPENAI_API_KEY` and `OPENAI_BASE_URL` in the environment, and gbrain's
base-URL probe (`src/core/ai/base-url-probe.ts`) lists the provider's models. The $0 check confirms it: `gbrain
doctor` with those variables sends one `GET /v1/models`; `gbrain search` sends nothing. `setup` itself never touched
the provider, and its receipt recorded providers as declined. The r2 agent noticed the request and then routed gbrain
through a wrapper that strips provider keys (`~/.local/bin/gbrain-keyless setup claude-code --gbrain-bin …`). The
scorer reads gbrain commands by the name `gbrain`, so it missed that `setup` call and scored r2 "did not run gbrain
setup claude-code"; the transcript and the receipt show setup ran, so E's task success is 3/3 on reading, 2/3 as
scored. Neither changes the consent result.

**F, the comparator's own prompt on this release (descriptive).** Given the unchanged re-baseline request, which
does not mention `setup`, all three agents found `gbrain setup claude-code` in `INSTALL_FOR_AGENTS.md` Step 3 and used
it (`--dry-run --json`, then `--json`). The 87.2 s mean is therefore a `setup` measurement, not the old documented
path, and n = 3 with a 54.6 to 122.4 s range.

## What to use and what to avoid

- **Point Claude Code users at `gbrain setup claude-code`.** In all 15 runs that used it, the fresh session found
  gbrain connected; the 12 that asked it something got working tools. It
  shortened the install session by about 20 s, cost half as much in model tokens, and agents reading the docs already
  choose it on their own.
- **Don't publish "setup is 35% faster" without the caveat.** The like-for-like gap is 23 to 27%. A follow-up that
  answers every agent question the same way, or a setup that asks its one question inside the install turn and does
  not leave it as the last message, would settle it.
- **Don't claim push on Claude Code.** The SessionStart hook needs a running server that a fresh session does not have
  yet. gbrain could have the hook read the brain directly when no server answers, wait briefly for the MCP server, or
  have the UserPromptSubmit turn context surface recent facts; until one of those is observed delivering an item to a
  fresh session, setup's `native-pending` label is right.
- **Make `gbrain doctor` respect a declined provider decision.** With a key in the environment and providers
  declined, doctor still contacts the provider. It is unbilled, but it is the one outbound call the user's "no paid
  providers" did not want, and it led one agent to build its own key-stripping launcher.
- **The 60 s wired-recall target is within reach.** Without the non-blocking reply session, `setup` runs averaged
  59.0 s; a setup that does not end on a question the scripted user answers would show whether it clears 60 s as
  measured.

**Limits.**

- n = 3 per cell, one window, one machine. The comparator showed the same code moving by tens of seconds between
  days, so the absolute times here are for this window; the B and C arms were interleaved and are comparable.
- The scripted-reply pattern decides whether a reply session happens, and it treated the two arms differently
  (above).
- The harness runs with permissions bypassed, so native approval prompts are not measured.
- Each pass's `meta.json` records its last invocation (cell F, started 21:04 UTC); every run's own `result.json` in
  `runs.tar.gz` has its start time.

## Reproduce and inspect

From the repository root, with Docker, `ANTHROPIC_API_KEY`, a gbrain checkout and Bun 1.4.2:

```sh
docker build -t gbrain-evals-cat41:v1 eval/runner/cat41
bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat41-setup-tthw.sqlite --program-cap-usd 25 --reason "Cat 41 setup TTHW"
RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger .budget/cat41-setup-tthw.sqlite --runner cat41-agent-operator --budget-usd 25 | tail -1)
G=<gbrain checkout>@a618302c901d0f63d646a3de531efb94d22bec51
n=0
for order in manual_import_to_recall,setup_import_to_recall setup_import_to_recall,manual_import_to_recall manual_import_to_recall,setup_import_to_recall; do
  n=$((n+1)); bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-tthw-a618302 --harnesses claude \
    --scenarios $order,setup_to_wired_recall,fresh_install_to_first_push,setup_consent_negative --repeat $n --concurrency 1 \
    --paid --budget-ledger .budget/cat41-setup-tthw.sqlite --budget-run-id "$RID" \
    --preregistration docs/benchmarks/2026-10-12-cat41-setup-tthw-preregistration.md --out eval/reports/cat41/setup-tthw-a618302
done
bun eval/runner/cat41-agent-operator.ts run --gbrain $G --label setup-tthw-a618302 --harnesses claude --scenarios fresh_install_to_wired_recall \
  --repeat 3 --concurrency 1 --paid --budget-ledger .budget/cat41-setup-tthw.sqlite --budget-run-id "$RID" \
  --preregistration docs/benchmarks/2026-10-12-cat41-setup-tthw-preregistration.md --out eval/reports/cat41/setup-tthw-a618302
bun docs/benchmarks/2026-10-12-cat41-setup-tthw/verdict.ts eval/reports/cat41/setup-tthw-a618302 > verdict.json
```

If the gbrain build copy under `.gbrain-overlays/` has files without world read permission, run
`chmod -R a+rX .gbrain-overlays/<commit>` before the passes (the container's agent user reads it). Observed: about 23
minutes for the 15 preregistered runs and 5 for cell F; $8.37 in all.

Artifacts in [`2026-10-12-cat41-setup-tthw/`](2026-10-12-cat41-setup-tthw/):

- `setup-tthw-a618302/`: `meta.json` (with the preregistration attestation: commit `2704568`, on origin), `summary.json`,
  `summary.md`, per-run `scores.jsonl` (with `install.download_ms`, `install.agent_ms`, `install.user_round_trips`),
  and `runs.tar.gz` with every transcript, Claude Code's stderr and each run's `result.json` (probe results, hook
  heartbeat, provider request log).
- `verdict.json` and `verdict.ts`: per-cell timings and the four frozen targets applied to `scores.jsonl`.
- `ledger-status.json`: the budget ledger after the last session.
