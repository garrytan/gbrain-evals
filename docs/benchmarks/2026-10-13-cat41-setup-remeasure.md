# `gbrain setup claude-code` re-measured with a symmetric scripted user (Cat 41, wave 2)

## The finding

On 2026-10-13 we measured `gbrain setup claude-code` again, on gbrain master `449483cc7` (v0.60.203.0). That build
contains garrytan/gbrain#6562 (SessionStart waits for the MCP server a fresh Claude Code session is starting; `gbrain
doctor` honours a declined provider decision) and garrytan/gbrain#6572 (setup relays its first-run settings in the
install reply instead of ending on a question). The scripted user now answers a closing question the same way in
every arm (scorer `cat41-score-v7`). The runs used real Claude Code sessions (`claude-opus-5-5`, Claude Code 2.1.285)
on clean containers, three runs per cell, and the targets were frozen in the
[preregistration](2026-10-12-cat41-setup-remeasure-preregistration.md) before any paid session. It supersedes
nothing: the [first run](2026-10-12-cat41-setup-tthw.md) stands as published.

| Target (frozen) | This run | First run (v0.60.184.0) | Verdict |
|---|---|---|---|
| Wired recall: 3/3, mean wall time ≤ 60 s | 3/3, **67.8 s** (median 72.6 s; `download_ms` 2.5 s), 0 scripted replies | 3/3, 83.8 s, 3 replies | **missed** |
| First push: each run succeeds in ≤ 120 s with ≤ 1 reply and 0 consent violations | **0/3**: no fresh session had the remembered item without a tool call | 0/3 | **missed** |
| Faster setup: `setup` median ≥ 25% below by hand, interventions not higher | **70.3 s against 95.6 s (26.5% lower)**, interventions 0 against 1 | 65.3 s against 100.5 s | **met as scored, not on reading** (caveat below) |
| Consent negatives: 0 consent violations in each of 3 runs, any provider request counted | 2 of 3 runs sent one unbilled `GET /v1/models`; no capture, no unrequested fact, no paid request | 3 of 3 under v7 | **missed** |

**#6572 removed the closing question, and wired recall got 16 s faster but still misses 60 s.** No
`setup_to_wired_recall` run ended on a question, so none got a scripted reply (the first run had one in every run, 13
to 33 s each). The three runs took 58.0, 72.6 and 72.7 s. Almost all of that is the install session (51 to 66 s),
where the agent reads AGENTS.md, installs, runs `setup` (one of three first ran `--dry-run`) and saves the fact; the
fresh-session recall takes 7 to 9 s. The comparator prompt (cell F, descriptive) took 56.2 s on average on this build.

**The faster-setup claim holds only through a scorer miss, so we do not make it.** As scored, by hand succeeded 2 of
3 times, and its successful median of 95.6 s puts `setup` 26.5% lower, which clears the rule. But the by-hand run
that failed, B r1, answered correctly: "Saturday, 14 November 2026" and Alice Example, read through gbrain's MCP tools.
The frozen success rule matches only "2026-11-14" or "November 14", so it missed the day-first date. With that run
counted, the by-hand median is 86.7 s and `setup` is 18.9% lower, below the 25% threshold. Leaving B r1's 12.6 s reply
session out as well gives 17.5%. We report the rule as scored and the claim as not supported on reading. The rule is
not changed after the fact.

**Push still does not reach a fresh Claude Code session.** In all three fresh sessions, Claude Code's transcript
shows the SessionStart hook ran and printed nothing. gbrain's heartbeat recorded `session-start ok` and
`user-prompt ok, empty_block`, as in the first run. Two separate causes show
in the runs:

1. In r2 and r3 the agent saved the code with `gbrain capture` (a page at `user/locker-code`), not as a fact, so
   there was no fact to push. Both agents searched `gbrain --help` for "remember" first. `remember` is not listed in
   `gbrain --help` at this commit, and `capture` is.
2. In r1 the code was a fact in the brain, and the hook still printed nothing. A $0 check in the same image shows the
   hook printing `## Hot memory (recent facts)` with the item in 38 ms when a `gbrain serve` holding its stdin is up.
   Why r1's fresh session got an empty pack is not established here. r1 also saved the code to Claude Code's own
   memory folder, which fails the "outside the brain" rule on its own.

**#6562's doctor fix works, but only once the decline is recorded.** Both violations are a `gbrain doctor` run before
`setup --no-providers` had recorded the decline. In r1 doctor ran first, at 08:49:25 UTC, and setup ran at 08:49:53.
In r2 doctor followed only a `--dry-run`. Doctor runs after the decline sent nothing: r1's second run and r3's only
run. No run installed a capture hook, put the dentist phrase in the brain or the transcript corpus, wrote a fact the
user did not ask for, or made a paid request.

Spend: $6.65 of the $25 ledger cap (18 runs; ledger run `cat41-agent-operator-2026-10-13T08-43-35-261Z-8a7aec62`).
gbrain's own model calls went to a fake provider and cost nothing.

## The concrete case

The prompts, seeds, probes and success rules are those of the first run (its "The concrete case" section). The
scripted user's one reply, "Use the defaults you recommend and go ahead.", goes out when the agent's turn closes by
asking for input or gbrain is not registered yet, at most 3 times, in every install cell. Two runs got it:

- **B r1:** the install session closed on "It's off until you agree; "defaults" turns it on at the recommended
  `salient` level", which matches "until you agree".
- **D r2:** the install session closed on "Tell me which options you want and I'll switch them."

No run closed on the conditional "tell me any time if you want…" that Amendment 1 flagged.

## The experiment and results

**Setup.** gbrain `449483cc7e55bc36afbb388a8cab8346b0022c5b` (v0.60.203.0, master on 2026-10-13, the merge of #6572).
Image `gbrain-evals-cat41:v1`: Claude Code 2.1.285, Bun 1.4.2, Node 24.18.0. One container at a time on one Capy
cloud machine (4 vCPU), cells interleaved by repeat, all in one window (08:43 to 09:10 UTC). Scorer `cat41-score-v7`,
runner and preregistration at `ba3a4d1` (on origin before the first cell). The test covers Claude Code only, with one
model, as in the first run.

**Wall time** is the sum of the agent sessions, from the install instruction to the fresh session's answer.
`download_ms` is the `bun install -g` measured on its own before the agent starts.

| Cell | Success | Wall mean | Wall median (range) | Agent time mean | `download_ms` mean | User replies | Cost |
|---|---|---|---|---|---|---|---|
| A `setup_to_wired_recall` | 3/3 | 67.8 s | 72.6 s (58.0 to 72.7) | 65.2 s | 2.5 s | 0, 0, 0 | $0.90 |
| B `manual_import_to_recall` (by hand) | 2/3 scored (3/3 on reading) | 92.6 s | 95.6 s over successes; 86.7 s all (85.2 to 106.0) | 88.7 s | 3.9 s | 1, 0, 0 | $1.54 |
| C `setup_import_to_recall` | 3/3 | 72.2 s | 70.3 s (65.8 to 80.6) | 69.8 s | 2.4 s | 0, 0, 0 | $1.02 |
| D `fresh_install_to_first_push` | 0/3 | 62.6 s | 58.1 s (53.3 to 76.3) | 60.5 s | 2.0 s | 0, 1, 0 | $0.98 |
| E `setup_consent_negative` | 1/3 | 112.5 s | 108.8 s (94.7 to 134.0) | 108.7 s | 3.8 s | 0, 0, 0 | $1.40 |
| F comparator prompt, unchanged (descriptive) | 3/3 | 56.2 s | 56.3 s (54.9 to 57.5) | 54.1 s | 2.2 s | 0, 0, 0 | $0.80 |

Per run, seconds per session (install, reply if sent, fresh session):

| Cell | r1 | r2 | r3 |
|---|---|---|---|
| A | 65.7 + 6.9 = 72.6 | 51.3 + 6.7 = 58.0 | 64.0 + 8.7 = 72.7 |
| B | 65.1 + 12.6 + 8.9 = 86.7 | 91.1 + 14.9 = 106.0 | 72.7 + 12.5 = 85.2 |
| C | 54.0 + 11.7 = 65.8 | 57.3 + 13.0 = 70.3 | 70.2 + 10.4 = 80.6 |
| D | 54.1 + 4.1 = 58.1 | 47.7 + 21.1 + 7.5 = 76.3 | 45.6 + 7.7 = 53.3 |
| E | 81.7 + 13.0 = 94.7 | 85.1 + 23.7 = 108.8 | 120.4 + 13.6 = 134.0 |
| F | 49.9 + 7.6 = 57.5 | 49.4 + 6.9 = 56.3 | 47.8 + 7.1 = 54.9 |

**Reported separately, every cell.** Approval taps: not measured (permissions are bypassed, as in the comparator).
Restarts beyond the one fresh session the design requires: 0. Crash retries: 0. Unanswered input requests: 0 in
every run. Abandonment: no session timed out; the runs that ended without success are B r1 (scorer miss, above), D r1
to r3, and E r1 and r2. Developer interventions during the passes: 0. Before the passes the operator made the gbrain
build copy readable inside the container (`chmod -R a+rX .gbrain-overlays/<commit>`), as in the first run.

**The faster-setup pair (B against C).** The frozen rule: C's median at most 0.75 times B's (medians over successful
runs), C 3/3, at least 2/3 B successes, and C's interventions (scripted replies plus unanswered input requests plus
crash retries plus developer interventions) not above B's. As scored: 70.3 / 95.6 = 0.735, C 3/3, B 2/3, interventions
0 against 1, so the claim condition holds ([`verdict.json`](2026-10-13-cat41-setup-remeasure/verdict.json)). On
reading, B is 3/3 and the ratio is 0.811 (above). The install session alone, the like-for-like part: median 72.7 s by
hand against 57.3 s with `setup` (21% lower). Fresh-session recall is the same in both arms (9 to 15 s). `setup` runs
cost $0.34 per run against $0.51 by hand.

**First push (D).**

| | r1 | r2 | r3 |
|---|---|---|---|
| How the agent saved the code | gbrain fact, plus Claude Code's memory folder | `gbrain capture` page, no fact | `gbrain capture` page, no fact |
| SessionStart output in the fresh session | empty | empty | empty |
| Heartbeat, fresh session | `session-start ok`, `user-prompt ok, empty_block` | same | same |
| Fresh session's answer | knows a memory file exists, not the code | does not know | does not know |

The $0 check, in the same image at the same commit: after `setup` and `gbrain remember … --provenance …`, the hook
reports `serve_not_ready` after 3.8 s with no server. It prints the fact under `## Hot memory (recent facts)` in
38 ms when `gbrain serve` is running with its stdin held open. With `gbrain serve` started on a closed stdin
(`</dev/null`), the hook still reports `serve_not_ready`.

**Consent negatives (E).**

| Check | r1 | r2 | r3 |
|---|---|---|---|
| Capture hooks (`Stop`, `SessionEnd`) installed | none | none | none |
| Brain pages after the session (seed 6) / phrase in the transcript corpus | 6 / no | 6 / no | 6 / no |
| Facts written the user did not ask for | 0 | 0 | 0 |
| Paid provider requests | 0 | 0 | 0 |
| Unbilled provider requests (`GET /v1/models`) | 1 (doctor before setup) | 1 (doctor after a dry run only) | 0 (doctor after setup) |
| Recalled 2026-10-20 through MCP in the fresh session | yes | yes | yes |

**F, the comparator's own prompt (descriptive).** The prompt does not mention `setup`, and all three agents ran
`gbrain setup claude-code` anyway (`--dry-run --json`, then for real). F's 56.2 s mean is therefore a `setup` measurement, under 60 s
here with n = 3, and not one of the frozen targets.

## What to use and what to avoid

- **Point Claude Code users at `gbrain setup claude-code`.** In all 12 recall runs that used it (A, C, E and F), the
  fresh session recalled through gbrain's MCP tools, and with #6572 none of them needed a reply.
- **Don't claim setup is 25% faster than by hand.** The rule passes only because of a scorer miss; on reading it is
  19%. The install session alone is 21% shorter.
- **Don't claim push on Claude Code.** Agents save the item as a page when `remember` is missing from `gbrain --help`,
  and even a saved fact did not reach r1's fresh session. Listing `remember` in the help, and finding why the fresh
  session's pack was empty, are the next gbrain steps. The label `native-pending` is still right.
- **Make `gbrain doctor` honour "no providers" before setup has recorded it.** Agents run doctor as their first
  health check, and an install request that says "don't use any paid AI provider" arrives before any recorded
  decision.
- **Wired recall is about 8 s from the target.** The remaining time is the agent's own install session, not gbrain's
  download (2.5 s) or the recall (7 to 9 s).

**Limits.**

- n = 3 per cell, one window, one machine, one model. Absolute times move by tens of seconds between days (see the
  comparator); B and C were interleaved and are comparable.
- The frozen date rule misses day-first dates (B r1). Any rule change applies to a later preregistration, not this
  run.
- Permissions are bypassed, so native approval prompts are not measured.
- Each pass's `meta.json` records its last invocation (cell F); `meta-a-to-e.json` records the last A to E invocation
  (repeat 3). Every run's own `result.json` in `runs.tar.gz` has its start time.

## Reproduce and inspect

From the repository root, with Docker, `ANTHROPIC_API_KEY`, a gbrain checkout and Bun 1.4.2, run the commands in the
preregistration's "What runs" section with `<commit>` = `449483cc7e55bc36afbb388a8cab8346b0022c5b`, then:

```sh
bun eval/runner/cat41/tthw-verdict.ts eval/reports/cat41/setup-remeasure > verdict.json
```

Observed: about 22 minutes for the 15 preregistered runs and 3 for cell F; $6.65 in all.

Artifacts in [`2026-10-13-cat41-setup-remeasure/`](2026-10-13-cat41-setup-remeasure/):

- `setup-remeasure-449483c/`:
  - `meta.json` and `meta-a-to-e.json`, both with the preregistration attestation (commit `ba3a4d1`, on origin);
  - `summary.json` and `summary.md`;
  - per-run `scores.jsonl`, with `install.download_ms`, `install.input_requests` and
    `install.unanswered_input_requests`;
  - `runs.tar.gz`, with every transcript, Claude Code's stderr and each run's `result.json` (probe results, hook
    heartbeat, provider request log).
- `verdict.json`: per-cell timings and the four frozen targets, from `eval/runner/cat41/tthw-verdict.ts`.
- `ledger-status.json`: the budget ledger after the last session.

## Changelog

### 2026-10-13: first version

The re-measure on gbrain v0.60.203.0 against the frozen targets of its preregistration.
