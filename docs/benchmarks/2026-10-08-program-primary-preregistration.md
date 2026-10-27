# Preregistration: the program primary (T0) and its power (PW)

Frozen on October 8, 2026 (Pacific), in its own commit, before any paid cell of the T0 development baseline. It
implements wave 1 items T0 and PW of the approved plan
[Build the 10x memory advantage](https://github.com/garrytan/gbrain-evals/blob/capy/10x-memory-advantage-plan/docs/plans/2026-10-07-10x-memory-advantage/PLAN.md)
(section 3.1, section 4 wave 1, section 11). Every later wave's candidate is measured against the baseline this
document governs. Changes after this commit are amendments, appended at the bottom with their reason and committed
before any cell they govern.

Code: `eval/generators/program-primary-gen.ts` (workload), `eval/runner/t0-program-primary.ts` (runner),
`eval/runner/t0/{delivery,score,analyze}.ts` (delivery contract, scorer, analysis), `eval/runner/power/` (PW),
registry entry `program-primary` (legacy alias `T0`, rules `PROGRAM_PRIMARY_RULES`). PW's simulation output is
[`2026-10-08-program-primary/power.json`](2026-10-08-program-primary/power.json).

## The question

Does a memory system reduce end-to-end failures on memory-dependent agent tasks, by how much, and within what
resources? The plan binds "10x" to one outcome: a tenfold reduction in end-to-end failures on a fixed set of
memory-dependent agent tasks against the frozen release gbrain v0.60.106.0 (`7aa2caa0`), within fixed latency,
token and cost limits. This document freezes that set, the failure definition, the loss tolerance, the resource
envelope, the statistics and the decision rule, then measures the baseline.

## Target user and workload

**Target user.** An engineer or founder running an agent harness (Claude Code) against a personal brain.

**Workload: cross-session meeting or reply preparation after a correction.** Each task has two sessions.

1. Session 1. The user, just off a call with a contact, tells the agent three things and asks it to update the
   brain: a commitment ("I promised Matteo I'd send the SOC 2 bridge letter before our pricing review"), a dated
   change ("our pricing review moved from Monday, October 26 to Friday, October 30, same time") and a correction
   ("the price in my notes is wrong: we quoted $24 per seat, not $21"). The three lines appear in a seeded order.
2. Session 2, a fresh session the next day, asks for a meeting-prep brief ("Prep me for my next meeting with
   Matteo Brandt: who they are now, when we're meeting, where things stand, and anything I owe them") or a reply
   draft to an email from the contact ("Confirm when we're meeting, restate where things stand, and cover anything
   I owe them"). It never names the commitment, the dates or the corrected value.

**Worlds.** One seeded persona per seed: a founder of an invented startup, 12 people (4 task contacts, a namesake
for each with the same first name at another company, 4 investors, advisors or recruiters), their companies,
deals, upcoming meetings, 30 daily notes and 2 inbox digests, about 73 Markdown pages. The base brain holds every
stale value (person page, deal page, meeting page, a daily note), as an un-updated brain would. Nothing is real.

**Task distribution (frozen).** 4 tasks per persona, 2 `prep` and 2 `reply`. The correction is the contact's role
(prep only), the deal's seat count or its per-seat price; the commitment is drawn from 12 items; the meeting moves 2
to 9 days later at the same time. On the 8 development seeds (`PP_DEV_SEEDS`, 20261008 to 20261015) that gives 32
tasks: 16 prep (6 role, 3 seats, 7 price) and 16 reply (8 seats, 8 price). World digest
`f7e082a38373905e28003298b6f7dc9e8df7baae9e99e90070eb28c8564daf4b`. Phrasing is development template set A (the
only set); a held-out run changes seeds, not phrasing, which is a known limit.

**Held-out seed.** A sealed seed is minted only by the custodian on the maintainer's machine
(`bun eval/generators/program-primary-gen.ts --mint-sealed --custodian-out <dir outside the repository>`), which
writes the seed to a 0600 file in custody and prints only its SHA-256 commitment. The commitment is recorded here as
an amendment before any held-out cell. No sealed seed exists in this repository and none was minted by the author.

## Failure definition (frozen; `eval/runner/t0/score.ts`, `t0-score-v1`)

A run fails when the session-2 deliverable shows any of:

| Kind | Rule |
|---|---|
| `missed_commitment` | none of the commitment's patterns appears |
| `stale_date` | the pre-change meeting date appears outside a change context |
| `stale_correction` | the pre-correction value appears outside a change context |
| `unsupported` | a value only the namesake has appears (their company, meeting date, seat count, price or commitment) |
| `execution_error` | session 2 ended in a provider or harness error, or with no deliverable |

A change context is a cue earlier in the same sentence (within 80 characters: "moved from", "not", "instead of",
"previously", "corrected" and similar) or right after the value ("→", "(old", "moved", "is wrong"), so "moved from
October 26 to October 30" is not stale. An execution error can never improve the failure rate. Omitting the date or
the corrected value is not a failure under the plan's definition; omissions are reported, and `complete`
(commitment, new date and corrected value all present, no failure) is the secondary metric. The scorer's mutation
suite (`test/eval/program-primary.test.ts`) passes the truthful deliverable on all 32 tasks and fails the empty,
everything, refusal, stale and wrong-source fakes.

**Scorer version.** Amendment 1 replaced v1 with `t0-score-v2` before any baseline cell; see the end of this
document.

**Scorer audit (preregistered).** After the baseline, the author reads a random sample of 30 session-2 deliverables
(10 per counted reader, seeded) and labels each as failed or not under the definition above, then reports agreement
with the scorer and every disagreement. The scorer is not changed after seeing baseline outputs; a disagreement is
reported, and a scorer fix becomes `t0-score-v2` with both versions' numbers published.

## Native-event delivery contract (frozen; `eval/runner/t0/delivery.ts`, `t0-delivery-v1`)

The Cat 40 ladder ran the agent loop only, with no hooks, so it never delivered gbrain's pushed context. This
carrier runs the release's own hook commands at the points Claude Code would and injects their output the way
Claude Code renders hook context.

| Item | Frozen value (from gbrain v0.60.106.0) |
|---|---|
| Context source | SessionStart: `gbrain hook session-start` stdout (MEMORY.md digest, push, backup and status notes, `context_pack` over IPC, core memory). UserPromptSubmit: `gbrain hook user-prompt` `additionalContext` (reflex pointers, volunteered pages, hot facts via IPC `turn_context`). Stop and SessionEnd are not fired |
| Timing | per session: `gbrain serve --surface starter` started and MCP `initialize` answered, 4 s settle, SessionStart, UserPromptSubmit for the one prompt, then the model. Hook self-deadlines 1,500 ms and 800 ms; IPC deadlines `turn_context` 600/400 ms, `context_pack` 1,000/600 ms (`resolve-ipc.ts:84-101`); harness timeouts 5 s and 3 s (`CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS`) |
| Byte cap | 10,000 characters of hook output (`CLAUDE_HOOK_OUTPUT_CAP_CHARS`), 3,072-byte MEMORY.md digest, 32 KiB prior-context dedupe input |
| Session reset | new conversation, new `session_id`, new serve process (Claude Code spawns a stdio MCP server per session); no transcript is carried |
| Persistence | the brain (PGLite data directory and vault checkout) persists from session 1 to session 2 unchanged |
| Startup maintenance | serve's own boot sweep and session-cursor GC; no autopilot, dream cycle or extraction drain between sessions; `GBRAIN_SKIP_STARTUP_HOOKS=1` disables only update checks |
| Workspace | an empty non-git directory per session (no MEMORY.md, no bootstrap manifest) |
| Surface | `starter`, the surface `gbrain bootstrap` registers for Claude Code at this release (`REGISTRATION_SURFACE`) |

**Label.** Results from this carrier are an **injected-context component test** of the program primary, not the
end-to-end primary itself, unless a native-harness parity slice (real Claude Code with the hooks registered, a
handful of tasks) agrees with it. If the parity slice is run, its receipt and its agreement rule are added here as
an amendment before it runs; if it is not run, the label stands on every T0 number.

What the hermetic slice already showed (keyless, scripted reader, persona 20261008, 16 cells, $0): at this release
SessionStart injects nothing on a fresh brain without a workspace MEMORY.md, and UserPromptSubmit injects one pointer
to the contact's page with its first sentence and "use get_page before relying on details". Pushed context is a
pointer, not the facts.

## Arms and mutants (frozen)

| Arm | What changes | Purpose |
|---|---|---|
| `baseline` | nothing | the measurement |
| `mutant-forced-drop` | session 1's writes are rolled back (snapshot restore) and session 2's hook output is dropped: the item never arrives | the primary must detect a lost item |
| `mutant-stale-correction` | session 1's writes are rolled back; the harness writes the commitment and the moved meeting to the contact page but not the correction, so memory (push and pull) serves the pre-correction value | the primary must detect a correction that never lands |
| `ablation-push-off` | hook output dropped in both sessions; brain intact | diagnostic: what push adds |

The plan names a "forced-drop push mutant (the pushed item never arrives)". At this release push delivers only a
pointer, and the agent can pull the item through MCP, so dropping push alone is not guaranteed to be an end-to-end
failure. The detection mutant therefore drops the item from every channel; the push-only drop runs as the ablation.

**Detection rule.** Paired with the baseline cells of the same reader, task and repeat, a mutant is detected when
the persona-clustered risk difference (mutant minus baseline failure rate, t on personas minus 1 df) has a 95% lower
bound above 0; the stale-correction mutant must also raise the `stale_correction` count above the baseline's. With
one persona (the hermetic slice) the rule is exact: every baseline pass fails under the mutant. A run counts only
when both mutants are detected and at least 90% of cells are scored (registry rules).

## Readers and settings

Counted readers: `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-sol` (the newest of each family on October 8
by `bun scripts/model-freshness.ts`; Fable is smoke-only and does not run; `gpt-5.4-mini` never runs). Provider
default settings: no extended thinking requested, OpenAI default reasoning effort, at most 8,192 (Anthropic) or 16,000
(OpenAI) output tokens per call, at most 20 model turns per session. gbrain's own provider calls (query embeddings
with `openai:text-embedding-3-large`, anything else the release makes) run through the metering proxy and the
budget ledger and are charged to the cell.

## The frozen release

gbrain v0.60.106.0, commit `7aa2caa0aa2a9f031730cd351cd516cf4f9f5802`, passed explicitly as
`--gbrain <checkout>@7aa2caa0` and copied into a verified overlay (tree `217fa3775c98393698e262d01481017fbf00ca0d`).
`package.json` pins a different commit (v0.60.104.0, `a865f8f8`), which this run does not use.

## Baseline design and budget

| Cells | Count |
|---|---:|
| `baseline`: 32 tasks x 3 readers x 2 repeats | 192 |
| `mutant-forced-drop`: 32 tasks x Sonnet 5.5 x 1 | 32 |
| `mutant-stale-correction`: 32 tasks x Sonnet 5.5 x 1 | 32 |
| `ablation-push-off`: 32 tasks x Sonnet 5.5 x 1 | 32 |

Budget-ledger cap: $80 for all T0 paid work (one ledger run). A setup smoke of 3 cells (task `p20261015-t4`, one
per counted reader, baseline arm) runs first in its own output directory; its cells are excluded from the baseline
and only its cost per cell is used. If the smoke's cost per cell times the remaining cells exceeds what is left of the
cap, cells are dropped in this order until the projection fits: the ablation; then the baseline's second repeat;
then the mutants to the first two tasks of each persona (16 each). If the ledger would still cross the cap, the run
stops and reports.

## Loss tolerance (frozen)

**3.0 points** of pooled failure rate. A candidate that trades failures for something else (fewer tokens, a cheaper
design, a different delivery) is non-inferior only when the upper bound of the persona-clustered 95% interval for
its failure-rate difference against this baseline (candidate minus baseline, same tasks, readers and repeats) is at
most +3.0 points. The value is frozen before the pilot and never widened for power: insufficient power changes the
sample size or yields "inconclusive". A6 and A11 use this value.

## Resource envelope (frozen as multipliers; absolute values come from this baseline)

Per counted reader, a candidate run counts toward the program primary only when, against this baseline:

| Resource | Limit |
|---|---|
| Latency | p95 session-2 wall time (hooks, model and tools) at most 1.2x the baseline's p95 |
| Tokens | mean reader tokens per cell (input total plus output total, `usage-receipt/v1`) at most 1.5x the baseline's mean |
| Dollars | mean dollars per cell (reader plus gbrain's own provider calls) at most 1.5x the baseline's mean |

## Statistics (PW, frozen)

**Estimand.** The pooled failure-risk ratio R = candidate failures / baseline failures over all units (task x
reader x repeat), paired by task and clustered by persona; the factor is 1 / R.

**Estimator.** R_hat = (candidate failures + 0.5) / (baseline failures + 0.5); the half count is the only continuity
correction and keeps R_hat finite when the candidate never fails.

**Interval.** Chosen by the frozen rule in `chooseMethod` from three persona-clustered candidates (delta method with
t, persona bootstrap, conditional binomial with a Pearson design effect), on 2,000 simulations per scenario at the
development design (8 personas x 4 tasks x 3 readers x 2 repeats): keep methods with coverage at least 0.93 in every
scenario with a positive true ratio and a false-10x rate at most 0.05 at the tenfold boundary. Only the conditional
binomial qualified:

| Scenario | delta-t | bootstrap | conditional binomial | false `10x`, conditional binomial |
|---|---:|---:|---:|---:|
| null, 30% baseline | 0.951 | 0.898 | 1.000 | 0.000 |
| null, sparse (5%) | 0.944 | 0.906 | 1.000 | 0.000 |
| null, heterogeneous clusters (unequal sizes) | 0.953 | 0.904 | 1.000 | 0.000 |
| true factor 10 (boundary) | 0.956 | 0.887 | 0.981 | 0.010 |
| true factor 10, sparse | 0.846 | 0.812 | 0.987 | 0.000 |
| true factor 10, heterogeneous | 0.939 | 0.872 | 0.981 | 0.011 |
| true factor 5 | 0.951 | 0.887 | 0.984 | 0.000 |
| true factor 20 | 0.909 | 0.885 | 0.990 | (power 0.141) |
| baseline near ceiling (2%) | 0.899 | 0.870 | 0.995 | 0.000 |
| candidate never fails | n/a | n/a | n/a | (power 0.995) |

Coverage of the two-sided 95% interval for the true ratio. With zero candidate failures the delta method claims
`10x` in every simulated run at the development design, where an exact bound would not, which is why it is not used.
Minimum coverage across scenarios: delta-t 0.846, bootstrap 0.812, conditional binomial 0.981. The delta method and
the bootstrap undercover when the candidate has few failures; the conditional binomial is conservative under the
null (coverage 1.000, so its false-improvement rate is 0), which costs power but never overstates a factor. Missing
units are not imputed (an execution error is a failure; a persona missing from either system is dropped from both).

**Decision rule.** With the conditional-binomial 95% interval [L, U] for R: `ceiling` if the baseline has no
failures (no ratio exists); `10x` if U <= 0.1; `improvement` if U < 1; `worse` if L > 1; otherwise `inconclusive`.
The factor 1 / R_hat and its interval are published whatever they are, including 1.2x.

**What the development design can show.** From power.json (2,000 simulations at the central assumptions):

| Baseline failure rate | Candidate's true factor | P(`10x`) at 8 personas x 2 repeats | P(`10x`) at 32 personas x 2 repeats |
|---|---|---:|---:|
| 30% | 20 | 0.16 | 0.77 |
| 30% | never fails | 1.00 | 1.00 |
| 20% | 20 | 0.10 | 0.60 |
| 20% | never fails | 0.84 | 1.00 |
| 10% | never fails | 0.07 | 1.00 |

So the 8 development personas can establish "10x" only for a candidate that almost never fails, and only when the
baseline fails often. **Sample-size rule for the candidate comparison (frozen):** the held-out comparison uses the
smallest number of personas (4 tasks, 3 counted readers, 2 repeats) at which PW's simulation, at the baseline failure
rate this baseline measures, gives P(`10x`) >= 0.8 for a candidate whose true factor is 20; if that exceeds 32
personas, the comparison runs at 32 and its verdict may be `inconclusive` by design. The baseline report computes
the number.

**System-by-size contrast (for the wave 3 B-man manifest).** The within-persona contrast of two systems' size
slopes uses persona contrasts d_k with a t interval on K - 1 df, complete personas only. Simulated size 4.3% to 5.5%
and coverage 0.94 to 0.96 across central, ceiling, sparse and heterogeneous settings. The minimum detectable
contrast at 80% power is 7.0 points (10 personas x 100 questions x 3 readers, central) and 10.3 points (8 x 50),
above the 3.0-point tolerance in every simulated design, so under these assumptions the 1M-to-10M slope comparison
is descriptive unless the manifest funds more personas or questions. Q1's `eval/runner/q1/power.ts` (branch
`evals/q1-scoreboard`) supports mean-difference claims only and is not used for a ratio or a slope.

## What is reported

Per reader and arm: failures with persona-clustered 95% intervals, failure kinds, complete runs, omissions, capture
diagnostics (which of the three facts session 1's write calls carried), push diagnostics (hook outcomes), and the
envelope (p50 and p95 latency, tokens, dollars), with every model call in `usage-receipt/v1`. The models people use
first (Sonnet 5.5, Opus 5.5) lead the tables. A reader at 0% failures is a ceiling, not a win.

## Amendments

### Amendment 1 (October 8, 2026, before any baseline cell): scorer `t0-score-v2`, execution order

**What the setup smoke showed.** The 3-cell setup smoke (task `p20261015-t4`, baseline arm, one cell per counted
reader, $0.81 in ledger run `t0-program-primary-2026-10-08T21-07-30-319Z-3c3e450c`; receipts in
`2026-10-08-program-primary/smoke/`) produced three deliverables that the author reads as correct: each states the
new meeting date, the corrected seat count and the owed order form. `t0-score-v1` failed two of them. Opus 5.5 wrote
"Your Oct 12 daily note still says 'kickoff Thursday, Oct 22.' That note is out of date", "make sure no 150-seat
figure ends up in the order form" and "Not to be confused with Idris Marchetti (Xerari Analytics)"; v1 scored a stale
date, a stale correction and an unsupported value. gpt-6.1-sol linked a "Meeting record" to `meetings/2026-10-22-...`,
whose page slug carries the old date, and wrote "The meeting page still has October 22 in its filename"; v1 scored a
stale date. Strong readers cite outdated records to warn the user, and v1 counted the warning as the error.

**Change.** `t0-score-v2` replaces v1 as the primary scorer before any baseline cell:

1. The deliverable is read as prose: markdown link targets, code spans and page paths are removed, and emphasis
   markers are dropped.
2. More change cues: "no", "never", "still says/has/lists/shows", "says", "out of date", "stale", "history",
   "earlier notes" before the value; "which is wrong", "out of date", "an error" after it.
3. A stale mention outside a change context fails only when the current value is absent. A deliverable that states
   the new date (or the corrected value) and also cites the old one passes; one that states only the old value
   fails. Known cost: a deliverable that states both as current, contradicting itself, passes v2; the scorer audit
   counts such cases.
4. The namesake's company is no longer an unsupported value (naming it is not a claim about the contact), and a
   namesake value in a sentence that tells the two people apart ("not to be confused with", "different person",
   "namesake") is excused.

Under v2 all three smoke deliverables pass and are complete. Every cell still records `score_v1` beside `score`, and
the baseline report publishes both. The failure definition, the mutants, the detection rule, the tolerance, the
envelope and PW are unchanged. The scorer audit stays as preregistered, on v2.

**Execution order.** Cells run in this order so the budget fallback cuts the right cells: baseline repeat 1 (96
cells), both mutants (64), baseline repeat 2 (96), then the ablation (32). Four personas run in parallel (one serve
per persona), so latency is measured under that load; a candidate's envelope comparison runs under the same
concurrency.

### Amendment 2 (October 8, 2026, before the parity slice runs): the native-harness parity slice

**What runs.** `eval/runner/t0/parity.ts`: the first task of each development persona (`p20261008-t1` to
`p20261015-t1`, 8 tasks: 4 prep, 4 reply), reader Sonnet 5.5, one repeat, through a real Claude Code process
(version 2.1.285, the version Cat 41 pins) with gbrain's SessionStart and UserPromptSubmit hooks registered in its
settings (release default timeouts 5 s and 3 s) and `gbrain serve --surface starter` in its MCP config. Each
session is a separate `claude -p` process, so Claude Code spawns a new MCP server per session on the same brain.
The persona line of the carrier's system prompt (who the user is, today's date) is passed with
`--append-system-prompt`, as a user's CLAUDE.md would. Claude Code keeps its own system prompt and built-in tools.
The deliverable is Claude Code's final result text, scored by `t0-score-v2`. Claude Code's and gbrain's provider
requests go through the metering proxy and the budget ledger; streamed responses now settle from their usage events
(`sseUsage` in `eval/runner/budget-ledger.ts`) instead of at their reservation.

**Agreement rule (frozen).** The comparison is with the baseline's Sonnet 5.5 repeat-1 cells on the same 8 tasks.
The "injected-context component test" label is lifted for Sonnet 5.5 on this workload at this release only when
(a) the native and injected outcomes (failed or not) agree on at least 7 of the 8 tasks and (b) Claude Code recorded
gbrain's UserPromptSubmit context in every native session-2 transcript. Otherwise the label stands for every T0
number. When both arms pass nearly every task, agreement says little about failures; the report says so.

**Execution order.** The parity slice runs after the mutants and before the baseline's second repeat, so the
budget fallback (ablation first, then the second repeat) still applies.
