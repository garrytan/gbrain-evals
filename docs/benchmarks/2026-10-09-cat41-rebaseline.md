# Fresh install to wired recall, re-baselined on gbrain v0.60.130.0 (Cat 41)

## The finding

On 2026-10-09 we ran the unchanged Cat 41 scenario `fresh_install_to_wired_recall` on gbrain master `dda603ac9`
(v0.60.130.0). In that scenario a real agent installs gbrain on a clean machine, sets it up with no API keys, connects
it to itself as an MCP server, saves one fact, and then recalls the fact in a new session. We ran Claude Code and the
Codex CLI, six times each, and every one of the 12 runs succeeded with no consent violations.

| Harness | Wall time, mean (median, range) | Agent time, mean | `download_ms`, mean | User replies | Success | Consent violations |
|---|---|---|---|---|---|---|
| Claude Code (`claude-opus-5-5`) | **98.8 s** (103.8 s, 68.6 to 111.5) | 90.6 s | 8.1 s | 1 in 5 of 6 runs, 0 in 1 | 6/6 | 0 |
| Codex CLI (`gpt-6.1-sol`) | **161.9 s** (173.5 s, 98.6 to 187.7) | 156.6 s | 5.3 s | 1 in 6 of 6 runs | 6/6 | 0 |

These n = 6 means are the comparator for wave 2's `gbrain setup <harness>` work. The first three runs per harness,
the cell as first preregistered, gave 91.2 s and 171.8 s.

**The current release is not measurably slower than the build that passed the October gate.** Codex's published time
on `b3f4e8b` (v0.60.38.0) was 121.7 s, but the same `b3f4e8b` code took 175.4 s when we ran it again today, interleaved
with the new release (Claude Code: 107.0 s, against 96.7 s published). Measured in the same window, the new release
is a little faster on both harnesses (98.8 s against 107.0 s, and 161.9 s against 175.4 s), but the middle halves of
the two sets of runs overlap, so this is no measured difference. The gap to the published 121.7 s is the day the runs
happened, not the code.

**The wave 0 surface change reached every agent and costs about 3 s in Codex's recall session.** All 12 runs
registered gbrain with `--surface full` (143 tools) because gbrain's install docs now say to; every `b3f4e8b` run
registered `--surface verbs` (7 tools). Codex loads the whole tool list, so its recall session reads about 32,000
more input tokens (84K against 52K) and takes 10.6 s against 7.6 s. Claude Code's recall session grew by about 6,000
tokens and 0.5 s. The install and reply sessions show no slowdown.

**Where the release stands against wave 2's targets.** D8 freezes wired recall at Claude Code ≤ 60 s and Codex ≤ 120 s.
The current release needs to lose about 39 s on Claude Code and 42 s on Codex to get there. The Codex target was set as
"no regression from 121.7 s", a number the same code does not reach today, so wave 2 should judge `setup` against a
same-window rerun of this release, not against any published number.

Spend: $14.09 of the $30 ledger cap (24 sessions). gbrain's own model calls went to a fake provider and cost nothing.

## The concrete case

The user types one request into a fresh container:

> I want you to have long-term memory. Install gbrain for me with `bun install -g github:garrytan/gbrain#<commit>`
> (its instructions for agents: `<docs>/AGENTS.md`), set it up keyless with no API keys, connect it to this agent
> (Claude Code) as an MCP server, and remember that my favorite tea is genmaicha. Ask me at most one question if you
> need to.

The agent reads gbrain's `AGENTS.md` and `INSTALL_FOR_AGENTS.md`, installs the package, runs `gbrain init --pglite
--no-embedding`, registers `gbrain serve --surface full` with its harness (`claude mcp add` or `codex mcp add`) and
saves the fact. gbrain's first-run instructions ask the user two things in one reply: a search mode (conservative,
balanced or tokenmax) and whether agents may save facts without being asked. The script answers "Use the defaults you
recommend and go ahead." Then a new session asks "What's my favorite tea? Use your gbrain memory tools." and must
answer from a gbrain MCP call.

The two harnesses spend that one reply differently. Claude Code finishes the wiring first and asks at the end (5 of
6 runs; in run 2 it ended its question with a phrase the scorer's question detector does not match, so no reply was sent). Codex stops
before registering and asks for the search mode first, so registration waits for the reply session in every run:

> Setup is waiting on your one search-mode choice above. After that, I'll connect Codex CLI and save and verify that
> your favorite tea is genmaicha. (Codex, run 6)

## The experiment and results

**Harness.** Each session runs in a fresh Docker container, image `gbrain-evals-cat41:v1`: Claude Code 2.1.285 with
`claude-opus-5-5`, Codex CLI 0.160.0 with `gpt-6.1-sol`, Bun 1.4.2, Node 24.18.0, permission prompts bypassed. These
are the pins and models of both published passes. This is a re-baseline of two fixed harness and model pairs, not a
model comparison, so no third model was added. The scenario file is unchanged (`eval/runner/cat41/scenarios.ts`,
SHA-256 `8f9bd3ac…f549f879`, gbrain-evals `8cbc61f7`). The full harness and scoring rules are in the
[Cat 41 protocol](2026-10-03-agent-operator-protocol.md).

**Builds.** `dda603ac9e152be45afd6f4edd3789bc11e000b8` (v0.60.130.0, master on 2026-10-09) and, as a same-window
control, `b3f4e8ba5935004066b4715bdc19bc9de4721b81` (v0.60.38.0, the published confirmation build). The files an
installing agent reads or runs (`AGENTS.md`, `INSTALL_FOR_AGENTS.md`, `README.md`, `src/mcp/`, the bootstrap and
registration code, `src/commands/init.ts`) are byte-identical between `dda603ac9` and gbrain-evals' `package.json` pin
`8a3eedeac` (v0.60.126.0), so these numbers also describe the pin.

**Measures.** Wall time is the sum of the agent sessions' wall time, the number both published tables report. Agent
time is wall time minus `download_ms`. `download_ms` is a cold `bun install -g` of the same package, run as root before
the agent starts and reported separately. A user reply is a scripted conversational round trip between the first
prompt and the recall session. Success needs a successful gbrain MCP call in the new session, the answer "genmaicha"
and no invented user facts in the brain.

**Order.** One container at a time, 06:35 to 07:39 PT. First three `dda603a` runs per harness, then three `b3f4e8b`
runs per harness, then repeats 4 to 6 alternating between the builds (both harnesses each step). The published passes
ran four containers at once alongside other scenarios.

**Preregistration.** [Preregistration](2026-10-09-cat41-rebaseline-preregistration.md), committed before the first
session (`8655d2f`), with two amendments committed before the cells they added: the same-window control (`ff54526`,
after the first six sessions showed Codex 50 s slower than published) and repeats 4 to 6 on both builds (`c2e8cd1`,
after the control's ranges overlapped). The reading rule for a measured difference: the two n = 6 sets' middle halves
(25th to 75th percentile) do not overlap.

### Wall time by build

| Build | Claude Code mean | Claude Code middle half | Codex mean | Codex middle half | Runs |
|---|---|---|---|---|---|
| `566a242` (v0.60.35.0), published 2026-10-03 | 93.4 s | n/a | 437.9 s | n/a | 3 + 3 |
| `b3f4e8b` (v0.60.38.0), published 2026-10-04 | 96.7 s | n/a | 121.7 s | n/a | 3 + 3 |
| `b3f4e8b`, rerun 2026-10-09 (control) | 107.0 s | 103.0 to 113.8 | 175.4 s | 159.6 to 197.3 | 6 + 6 |
| **`dda603a` (v0.60.130.0), 2026-10-09** | **98.8 s** | 95.9 to 109.7 | **161.9 s** | 157.8 to 182.3 | 6 + 6 |

Per run (wall seconds, in run order):

| Build | Harness | r1 | r2 | r3 | r4 | r5 | r6 |
|---|---|---|---|---|---|---|---|
| `dda603a` | Claude Code | 94.3 | 68.6 | 110.6 | 100.7 | 106.9 | 111.5 |
| `b3f4e8b` today | Claude Code | 114.0 | 113.2 | 86.7 | 115.6 | 99.8 | 112.5 |
| `dda603a` | Codex | 183.9 | 177.7 | 153.9 | 187.7 | 169.4 | 98.6 |
| `b3f4e8b` today | Codex | 171.3 | 156.7 | 111.7 | 238.4 | 206.0 | 168.2 |

The control drifted within the hour: its Codex runs 4 to 6 averaged 204.2 s against 146.6 s for runs 1 to 3. Single
Codex runs range from 99 s to 238 s on one build, which is why three runs were not enough to compare builds.

### Where the time goes

Means per session from the transcripts ([`attribution.json`](2026-10-09-cat41-rebaseline/attribution.json), made by
[`attribution.ts`](2026-10-09-cat41-rebaseline/attribution.ts)). "Install" is the first session, "reply" the session
after the scripted answer, "recall" the new session.

| Build | Harness | Registered surface | Install session | Reply session | Recall session | Recall input tokens |
|---|---|---|---|---|---|---|
| `dda603a` | Claude Code | `full` 6/6 (143 tools offered) | 75.7 s | 17.2 s | 8.8 s | 58K |
| `b3f4e8b` today | Claude Code | `verbs` 6/6 (7 tools offered) | 76.3 s | 22.3 s | 8.3 s | 52K |
| `dda603a` | Codex | `full` 6/6 | 109.3 s | 42.0 s | 10.6 s | 84K |
| `b3f4e8b` today | Codex | `verbs` 6/6 | 121.3 s | 46.6 s | 7.6 s | 52K |
| `b3f4e8b` published | Codex | `verbs` 3/3 | 89.4 s | 25.8 s | 6.4 s | 52K |

What changed between the builds, and what it did:

- **Registration surface.** gbrain's install docs and `REGISTRATION_SURFACE` (`src/core/mcp-registration.ts:24` at
  `dda603ac9`) now say `--surface full`; at `b3f4e8b` they said `--surface verbs`. Every agent followed the docs. The
  full surface's `tools/list` is 118,032 bytes (143 tools), against 6,140 for `verbs`
  ([`overhead.json`](2026-10-09-cat41-rebaseline/rebaseline-dda603a/overhead.json)). Codex's recall session reads about
  32K more input tokens and takes 3.0 s longer; Claude Code's grew by 6K tokens and 0.5 s. The
  recall session is the only one where the new release is consistently slower.
- **Docs size.** `AGENTS.md` grew from 15,743 to 19,005 bytes and `INSTALL_FOR_AGENTS.md` from 37,529 to 38,576.
  Install-session input grew by 47K tokens (Claude Code) and 65K (Codex) on average, with no matching slowdown: the
  install session is 0.6 s faster on Claude Code and 12 s faster on Codex.
- **Discovery behavior.** No recall session needed discovery: every one called `recall` (Codex sometimes added
  `context_pack`, Claude Code once added `search`) on its first or second tool call. No run called `request_tools`.
- **Reranker.** Off on purpose. The scenario is keyless and the fake provider recorded no requests at all in the 24
  runs, so none was a rerank request. This is the documented exception to gbrain-evals #109's fail-closed rerank probe,
  which checks provider-backed gbrain slots that this scenario does not have.

**Token overhead per surface** (keyless brain, `initialize` instructions plus `tools/list`):

| Surface | `b3f4e8b` tools | `b3f4e8b` bytes | `dda603a` tools | `dda603a` bytes |
|---|---|---|---|---|
| `verbs` | 7 | 16,860 | 7 | 8,560 |
| `starter` | 34 | 65,406 | 35 | 30,586 |
| `full` | 139 | 152,336 | 143 | 122,037 |

Tool descriptions shrank on every surface, so a `full` registration today costs 20% fewer bytes than a `full`
registration on `b3f4e8b`, but 7 times the 16,860 bytes of the `verbs` registration agents chose then.

## What to use and what to avoid

- **Use the n = 6 `dda603a` means (98.8 s and 161.9 s) as wave 2's comparator, and rerun this release in the same
  window as every `setup` measurement.** The same code moved by 54 s on Codex between two days and by 58 s between two
  halves of one hour. A wave 2 claim against a published number would mostly measure the provider's day.
- **The surface choice is a small part of setup time.** `full` adds about 3 s to Codex's recall session and almost
  nothing to Claude Code's. The Codex gap to the 120 s target is in the install and reply sessions: reading docs,
  installing, asking for the search mode before registering, and verifying with extra shell commands (6.8 per reply
  session).
- **Codex spends a session waiting for the first-run decision.** It asks before registering, so the reply session does
  the wiring (42 s on average). Claude Code wires first and asks last. A setup command that registers before asking, or
  asks inside the first turn, would remove most of Codex's reply session.
- **`download_ms` is small and stable**: 3.8 to 11.9 s per run, 3 to 8% of mean wall time.

**Limits.**

- n = 6 per cell, three of them interleaved. A difference between builds smaller than about 25 s would not show.
- The "Recovery" column in the runner's `summary.md` (2 and 4 for `dda603a`, 0 for the control) is not a gbrain
  signal. In this scenario the agent installs gbrain itself, so the container's call log is empty and the scorer parses
  gbrain calls out of shell commands, giving each one the exit code of the whole compound command
  (`eval/runner/cat41/classify.ts:150`). The "errors" are `rg` or `ls` failures in the same command line as a
  `gbrain ... --help`. We checked `gbrain remember --help` and `gbrain recall --help` directly on `dda603ac9`: both exit
  0. `gbrain recall --help` prints only "run gbrain --help for the full command list", while `remember --help` lists
  its options; Codex ran `recall --help` in all 12 of its runs across both builds.
- Whether the scripted reply is sent depends on a regular expression over the agent's last message (`ASK_RE`) or a
  missing registration. One Claude Code run ended its decision bundle without a phrase the expression matches, so its
  wall time (68.6 s) has no reply session. All other runs got exactly one reply.
- Each pass's `meta.json` records the last of its four invocations (repeat 6 started 07:29 PT and 07:33 PT); each run's
  own `result.json` in `runs.tar.gz` has its start time.

## Reproduce and inspect

From the repository root, with Docker, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, a gbrain checkout and Bun 1.4.2 as
`/usr/local/bin/bun`:

```sh
docker build -t gbrain-evals-cat41:v1 eval/runner/cat41
bun eval/runner/budget-ledger.ts init --budget-ledger .budget/cat41-rebaseline.sqlite --program-cap-usd 30 --reason "Cat 41 re-baseline"
RID=$(bun eval/runner/budget-ledger.ts open --budget-ledger .budget/cat41-rebaseline.sqlite --runner cat41-agent-operator --budget-usd 30 | tail -1)
for n in 3 4 5 6; do  # repeats 1-3 first, then 4-6 alternating; the runner skips repeats already scored
  for b in dda603ac9e152be45afd6f4edd3789bc11e000b8:rebaseline-dda603a b3f4e8ba5935004066b4715bdc19bc9de4721b81:control-b3f4e8b; do
    bun eval/runner/cat41-agent-operator.ts run --gbrain <gbrain checkout>@${b%%:*} --label ${b##*:} \
      --scenarios fresh_install_to_wired_recall --repeat $n --concurrency 1 \
      --paid --budget-ledger .budget/cat41-rebaseline.sqlite --budget-run-id "$RID" --out eval/reports/cat41/${b##*:}
  done
done
bun eval/runner/cat41-agent-operator.ts overhead --gbrain <gbrain checkout>@dda603ac9e152be45afd6f4edd3789bc11e000b8 --out eval/reports/cat41/rebaseline-dda603a
bun docs/benchmarks/2026-10-09-cat41-rebaseline/attribution.ts dda603a=eval/reports/cat41/rebaseline-dda603a/runs control-b3f4e8b=eval/reports/cat41/control-b3f4e8b/runs
```

Observed: about 15 minutes per three-run pass per build, $14.09 in all (Claude Code $7.74, Codex $6.34).

Artifacts in [`2026-10-09-cat41-rebaseline/`](2026-10-09-cat41-rebaseline/):

- `rebaseline-dda603a/` and `control-b3f4e8b/`: `meta.json`, `summary.json`, `summary.md`, per-run `scores.jsonl`
  (with `install.download_ms`, `install.agent_ms`, `install.user_round_trips`), and `runs.tar.gz` with every
  transcript and `result.json`. `rebaseline-dda603a/overhead.json` has the token overhead.
- `attribution.json` and `attribution.ts`: per-session counts for all four passes (the two published archives
  included).
- `ledger-status.json`: the budget ledger after the last session.

The published baselines are in [`2026-10-03-agent-operator/`](2026-10-03-agent-operator/) (`baseline-master-566a242/`
and `after-b3f4e8b/`), described in the [Cat 41 report](2026-10-03-agent-operator.md).
