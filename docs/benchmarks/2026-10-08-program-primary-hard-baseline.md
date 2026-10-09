# The program primary, harder workload (T0b): baseline on gbrain v0.60.106.0

## The finding

On October 8, 2026 we ran the T0b development baseline on the frozen release, gbrain v0.60.106.0 (`7aa2caa0`). T0b
is the harder successor to the [T0 workload](2026-10-08-program-primary-baseline.md), which was at its ceiling. The
task: a fresh session asks the agent to reply to a customer's champion and "our procurement lead", or to prep for
that call, in a 919-page founder brain. The facts that matter sit in mail threads and call notes, not on the pages
that name the customer.

**The frozen release fails 74 of 144 runs (51.4%, persona-clustered 95% interval 44.5% to 58.3%).** That is a
baseline a 10x reduction can be measured against. The readers split sharply:

| Reader | Runs | Failures | 95% interval |
|---|---:|---:|---|
| Opus 5.5 | 48 | 38 (79.2%) | 64.7% to 93.6% |
| Sonnet 5.5 | 48 | 35 (72.9%) | 58.1% to 87.7% |
| gpt-6.1-sol | 48 | 1 (2.1%) | 0% to 7.0% |

gpt-6.1-sol is near its ceiling on this workload, so a failure reduction can be measured only on the two Claude
readers. The most common failure greets the wrong person. The champion's dated mail says procurement moved to someone
new "starting October 6", but the company page still lists the old contact, and Opus 5.5 addressed that old contact
in 36 of 48 runs.

Both mutants fail 24 of 24 runs for every reader, so the primary detects lost and stale memory. Turning gbrain's
push context off moves Sonnet 5.5 up and Opus 5.5 down. Neither change is significant, so whether push matters here
is unresolved.

Spend: $78.19 of the $110 budget-ledger cap ($10.84 calibration, $67.35 baseline). Ledger run
`t0b-program-primary-2026-10-08T23-30-25-746Z-d7a1d492`.

## The concrete case

This is persona 20261101, task 1. Everything in it is invented.

- **In the brain.**
  - The deal page says "70 seats at $22 per seat per month; next step: pilot kickoff on Thursday, October 22."
  - An October 11 mail from Elodie Udeh ("Elo") asks to push the kickoff to Tuesday, October 27, and the user agreed.
  - An October 12 call note says "the right number is $29 per seat; the $22 in the quote was a typo."
  - A September 23 mail says "starting October 6, Tobin Morales takes over vendor procurement from Wren."
  - An October 5 technical review with an engineer, which Elodie did not attend, says "send YAR a sandbox account
    before the pilot kickoff."
  - Another Elodie works at Yarithe Foods (the account is Yarithe Retail) and has her own deal and promise.
- **Session 1.** "Give me a short checklist for preparing a board deck. Also, please note in my brain that I promised
  Elodie Udeh I'd send the SOC 2 bridge letter."
- **Session 2, the next day.** "Elodie Udeh emailed me: 'quick one before our pilot kickoff: can you confirm when
  we're meeting, where the numbers landed, and what we're still waiting on from you? I've looped in our procurement
  lead.' Draft my reply to both of them."

A correct reply names October 27, $29 per seat, Tobin, the bridge letter and the sandbox. Opus 5.5 wrote "Hi Elodie,
hi Wren ... The pilot kickoff is on Thursday, October 22", while citing the $29 correction correctly. That run
fails twice: a stale date and a superseded contact.

## The experiment and results

**Setup.** The workload, carrier, delivery contract, arms and statistics are frozen in the
[T0b preregistration](2026-10-08-program-primary-hard-preregistration.md) (commit `b355a8df`, after calibration and
before any baseline cell).
- **Data.** 8 development personas (seeds 20261101 to 20261108), 3 tasks each, 919 pages per brain.
- **Carrier.** gbrain's own SessionStart and UserPromptSubmit hooks, injected at Claude Code's points, with
  `gbrain serve --surface starter` over stdio and up to 20 model turns per session.
- **Scoring.** Deterministic, `t0b-score-v1`.
- **Runs.** Each counted reader ran 2 repeats on the baseline arm and 1 repeat on each other arm.

**Calibration.** Three rounds ran on seeds 20261109 to 20261114, recorded in the preregistration.
- When session 1 mentioned the second promise in passing, every run failed: no reader saved a promise it was not
  asked to save (0 of 18 session-1 runs wrote anything).
- With an explicit save request, 14 of 36 runs failed (38.9%). The knobs were frozen there.
- The baseline seeds came out higher, at 51.4%, slightly above the 20% to 50% target. The preregistration does not
  allow retuning after that.

**What fails.** These counts cover the baseline arm. One run can fail on several items.

| Failure | Opus 5.5 | Sonnet 5.5 | gpt-6.1-sol |
|---|---:|---:|---:|
| Superseded procurement contact named or addressed, current one absent | 36 | 19 | 1 |
| Stale seat count or price stated, corrected one absent | 2 | 20 | 0 |
| Old meeting date stated, new one absent | 17 | 16 | 1 |
| The hop commitment (from the technical review) missed | 1 | 10 | 0 |
| The session-1 commitment missed | 0 | 0 | 0 |
| A namesake's value claimed | 2 | 0 | 0 |

Every session-1 run saved the promise (144 of 144), and every session-2 run received gbrain's push context: the
contact pointer and, from SessionStart, the saved promise as "hot memory". Opus 5.5 usually finds the correction and
the reschedule. It trusts the company page for the procurement contact. Sonnet 5.5 more often stops at the deal page.
gpt-6.1-sol reads more pages per run (15.3 tool calls in session 2, against 10.9 for Opus and 9.9 for Sonnet) and
states each correction as a correction.

Repeats agree on 52 of 72 task and reader pairs, so a single run is a noisy measurement, and the clustered intervals
above carry that noise.

**Mutants.** Each reader ran each mutant once on all 24 tasks.

| Arm | Opus 5.5 | Sonnet 5.5 | gpt-6.1-sol | Detected |
|---|---:|---:|---:|---|
| `mutant-forced-drop` (no item arrives) | 24/24 | 24/24 | 24/24 | yes, every reader |
| `mutant-stale-correction` (corrections never land) | 24/24 | 24/24 | 24/24 | yes, every reader |

The registry rules pass on this run: both mutants are detected and 100% of cells were scored.

**Push-off ablation.** This arm ran with hook output dropped in both sessions. It is paired with each reader's
baseline repeat 1, and the difference is push off minus push on, with a persona-clustered 95% interval.

| Reader | Failures, push off | Failures, push on (repeat 1) | Difference |
|---|---:|---:|---|
| Opus 5.5 | 13/24 | 19/24 | −25.0 points (−60.7 to +10.7) |
| Sonnet 5.5 | 23/24 | 17/24 | +25.0 points (−3.8 to +53.8) |
| gpt-6.1-sol | 1/24 | 0/24 | +4.2 points (−5.7 to +14.0) |

No interval excludes zero, and the two Claude readers move in opposite directions. Without push, Opus 5.5 ran more
searches (4.8 against 3.4 per session) and Sonnet 5.5 fewer tool calls overall. A larger ablation would be needed to
say whether push helps or hurts here.

**Scorer audit.** We drew 30 baseline deliverables with a seed (10 per reader) and read them by hand. The scorer's
failed-or-not verdict agreed on 30 of 30
([scorer-audit.json](2026-10-08-program-primary-hard/scorer-audit.json)). Two Opus cells that fail for real also
carry a false `unsupported` kind. Their disambiguations ("a different account", "not Yarithe Retail") fall outside
the v3 cue list.

**Resource envelope of the baseline.** The preregistered limits are multipliers of these numbers.

| Reader | Session-2 wall time p50 / p95 | Reader tokens per run (input / output) | Dollars per run |
|---|---|---|---|
| Opus 5.5 | 29.4 s / 40.1 s | 188,360 / 3,371 | $0.292 |
| Sonnet 5.5 | 18.2 s / 23.2 s | 142,643 / 3,219 | $0.133 |
| gpt-6.1-sol | 28.6 s / 41.0 s | 97,263 / 1,373 | $0.075 |

**Power.** The preregistered sample-size rule is recomputed at the measured pooled rate (51.4%), with 3 tasks per
persona, 3 readers and 2 repeats. A candidate whose true factor is 20 reaches `10x` with probability 0.815 at 32
personas. So the held-out comparison runs at 32 personas, or at the most the custodian mints if that is fewer. The
calculation assumes the three readers share a rate. With gpt-6.1-sol near zero, a reader-stratified analysis is the
honest one, and the T0b candidate preregistration should state it before any candidate cell runs.

## What to use and what to avoid

Use T0b as the program primary's baseline for the two Claude readers. Three things make it hard: the facts live in
mail threads and call notes, the company page is stale, and the reply goes to a person the user did not name. Those
are ordinary features of a founder's brain, and two frontier readers fail most runs at this release.

Do not read gpt-6.1-sol's 2% as a gbrain advantage on that reader. It is a ceiling, as Sonnet and GPT were on T0.

Do not read the push ablation as evidence either way. Its intervals are wide and its two Claude readers disagree in
sign.

The calibration's first round is a finding of its own. At this release, no reader saved a promise the user mentioned
without asking, and gbrain's opt-in ambient writeback (the Stop hook) is outside this carrier's delivery contract.

## Reproduce and inspect

```bash
# keyless hermetic slice: scripted saver and oracle, one persona, all four arms, $0
bun eval/runner/t0b-program-primary.ts --gbrain <gbrain checkout>@7aa2caa0 --output eval/reports/t0b-program-primary/hermetic

# paid baseline (ANTHROPIC_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY)
bun eval/runner/budget-ledger.ts open --runner t0b-program-primary --budget-usd 110
R="bun eval/runner/t0b-program-primary.ts --gbrain <gbrain checkout>@7aa2caa0 --output <dir> --concurrency 4 --paid --budget-run-id <id>"
$R --arms baseline --repeat 2
$R --arms mutant-forced-drop,mutant-stale-correction
$R --arms ablation-push-off
bun eval/runner/t0/analyze.ts <dir>/results.jsonl
```

Code identities:
- gbrain `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802` (v0.60.106.0), copied into a verified overlay.
- gbrain-evals: preregistration commit `b355a8df` on branch `capy/t0b-program-primary`.
- Generator `program-primary-hard-v1`, world digest `dccafc6f`.
- Bun 1.4.2.

Receipts are in [`2026-10-08-program-primary-hard/`](2026-10-08-program-primary-hard/):
- `baseline/results.jsonl.gz`: every cell, including deliverables, hook outputs and tool calls;
- `baseline/usage.jsonl.gz`: every model call in `usage-receipt/v1`;
- `baseline/receipt.json` and `summary.json`;
- `calibration/round-{1,2,3}/`, `hermetic/` and `scorer-audit.json`.

| Ledger spend | Dollars |
|---|---:|
| Calibration, 3 rounds, 54 cells | 10.84 |
| Baseline repeat 1, 72 cells | 12.10 |
| Mutants, 144 cells | 29.99 |
| Baseline repeat 2, 72 cells | 12.60 |
| Push-off ablation, 72 cells | 12.66 |
| **Total** | **78.19** |
