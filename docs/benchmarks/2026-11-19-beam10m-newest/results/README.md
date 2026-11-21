# BEAM-10M on gbrain's newest release: results

We measured gbrain v0.60.748.0 (`7f162344652afc725793dd476945716e09d26104`) on BEAM-10M, a set of chat histories of about
10 million tokens each that was never used to tune gbrain. The measurement ran 2026-11-19 to 2026-11-20 under the
[preregistration](../../2026-11-19-beam10m-newest-preregistration.md) and its amendments A1 to A3. The aggregate report
behind every number here is [report.json](report.json).

- **We learned that gbrain's 8,000-token memory answers these long-history questions as well as it did at v0.60.493.0.
  You can upgrade without losing accuracy here.** Gbrain as it ships, read with an 8,000-token budget (arm P), scored
  55.8% across three answer models. With Opus 5.5 reading both builds, the change from v0.60.493.0 is −0.1 points
  (95% interval −3.2 to +3.1). The test could detect a drop of 7.9 points, and the interval rules out any drop
  larger than 3.2 points.
- **We learned that an agent with list, grep and read tools over the raw files still beats gbrain's whole system on
  these histories, and the gap is now clear.** With Opus 5.5 reading both, gbrain's whole system scored 55.2% against
  the file agent's 67.4%, 12.2 points behind (95% interval 6.4 to 18.4 points). In 2026-10's three-model comparison
  we couldn't tell the two apart. **If your agent works over very long chat logs, try a file agent baseline before you
  pick a memory system.**
- The newer chat-text quote fences take about a quarter of arm P's evidence budget (25.7% of 5,500 tokens). Even so,
  accuracy didn't fall, so whatever they cost was won back elsewhere. 10 conversations are too few to say where.

## What was measured

All three arms ran on gbrain v0.60.748.0, gbrain's newest release on master when the counted runs started. Each of the
10 S1 conversations got one brain, built once and shared by all three arms. 199 questions were scored, after the
one question the preregistration excludes (`10m-1:abstention:0`).

- **Arm P:** gbrain as it ships, with an 8,000-token evidence budget. This is README's first BEAM-10M row.
- **Arm A0:** the call shape the 2026-10 scoreboard used for its 8,000-token row.
- **Arm whole:** gbrain's whole system, a native `query` with no limit, reading its own default amount of evidence.
  This is the row README compares with the file agent.

Three answer models read every context: claude-opus-5-5, gpt-6.2-sol and particle-1. The particle-1 answers come from a
re-read of the same frozen contexts. The frontier judge view decides: gpt-6.1-sol judges the Opus and particle-1
answers, and claude-opus-5-5 judges the gpt-6.2-sol answers, so no model judges its own family. The bridge view, with
gpt-4.1-mini judging, links to earlier BEAM runs and is shown beside it. All three judges passed the agreement check
before any number counted (kappa 0.78 to 0.86, amendment A3). Scores are BEAM's graded score (0, 0.5 or 1 per rubric
item, averaged) times 100. Intervals are 95% conversation-cluster bootstraps (10,000 resamples, seed `beam10m-newest`).

The file agent was not re-run. It reads only the raw Markdown files, so no gbrain change can move its score. Its rows
are from the 2026-10 scoreboard, and its stored Opus answers were judged again by gpt-6.1-sol for the frontier view.

## First table: Opus 5.5 and particle-1, frontier view

| Arm | Reader | Score (95% interval) | Questions scored | Answers scoring at least 0.5 | Cost per correct answer |
|---|---|---|---:|---:|---:|
| P | claude-opus-5-5 | 59.1% (53.9 to 64.6) | 199 of 199 | 127 | $0.089 |
| P | particle-1 | 53.6% (50.2 to 57.0) | 199 of 199 | 111 | $0.0076 |
| A0 | claude-opus-5-5 | 55.1% (49.5 to 61.5) | 197 of 199 | 113 | $0.101 |
| A0 | particle-1 | 50.4% (45.2 to 55.7) | 197 of 199 | 104 | $0.0077 |
| whole | claude-opus-5-5 | 55.2% (50.1 to 60.4) | 199 of 199 | 112 | $0.126 |
| whole | particle-1 | 49.9% (44.4 to 55.2) | 199 of 199 | 106 | $0.0079 |

gpt-6.2-sol, judged by claude-opus-5-5: P 54.8% (51.0 to 58.9; $0.031 per correct answer), A0 47.4% (41.9 to 53.6;
$0.037), whole 46.7% (42.3 to 51.1; $0.049).

On arm P, particle-1 scored 5.5 points below Opus 5.5 at about a twelfth of Opus's cost per correct answer. This run
doesn't test that gap; each reader's own interval is shown above. A cost per correct answer counts the reader's own
dollars on the arm plus the arm's gbrain query dollars, at list price from the metering proxy, divided by the reader's
answers scoring at least 0.5 under the frontier view. Judge dollars are left out. The brain build (ingest, extraction
and embeddings) is shared by every arm and reader: about $8.75 per conversation, or about $0.44 per scheduled question,
from the same meters.

## Three-reader means

The mean of claude-opus-5-5, gpt-6.2-sol and particle-1. These are README's figures. They are never compared with the
2026-10 runs, whose readers were different.

| Arm | Frontier view | Bridge view | Opus 5.5 plus GPT-6.2 Sol, frontier |
|---|---|---|---|
| P | 55.8% (52.2 to 59.8) | 58.5% (54.9 to 62.5) | 56.9% (52.9 to 61.4) |
| A0 | 51.0% (46.1 to 56.6), 197 scored | 55.2% (50.6 to 60.2) | 51.3% (46.3 to 57.2) |
| whole | 50.6% (46.0 to 55.4) | 56.4% (52.4 to 60.2) | 51.0% (46.5 to 55.6) |

## The preregistered test: arm P against v0.60.493.0

Each question's Opus score on arm P now, minus F6's Opus score on arm P at v0.60.493.0 (`0ccf2bdd`, measured
2026-11-03), under the same judge. All 199 questions were scored in both runs, across all 10 conversations.

| View | Now | v0.60.493.0 | Change (95% interval) | Smallest detectable difference |
|---|---:|---:|---|---:|
| Frontier (decides) | 59.1% | 59.1% | −0.1 points (−3.2 to +3.1) | 7.9 points |
| Bridge | 60.7% | 60.7% | +0.0 points (−5.0 to +4.3) | 7.0 points |

Outcome 2 of the preregistration applies: no regression is claimed. Both views agree. A question-level bootstrap gives
the same answer (frontier interval −3.4 to +3.4).

particle-1's re-read of arm P, against F6's particle-1 re-read at v0.60.493.0 on the bridge view, moved −0.6 points
(−5.4 to +3.7).

## The whole system against the file agent

Each question's Opus score on the whole arm, minus the file agent's stored Opus score from the 2026-10 scoreboard,
paired on all 199 questions. The file agent's 6 `context_overflow` stops are product failures, so they score 0 and stay
in.

| View | gbrain whole | File agent | Difference (95% interval) | Smallest detectable difference |
|---|---:|---:|---|---:|
| Frontier | 55.2% | 67.4% | −12.2 points (−18.4 to −6.4) | 9.3 points |
| Bridge | 57.4% | 71.3% | −13.9 points (−18.5 to −9.2) | 12.2 points |

Both intervals lie below 0, so README keeps this comparison under "where gbrain loses" with these numbers. Against the
file agent's later F6 rerun (bridge view, 72.2% on Opus) the gap is −14.8 points (−20.5 to −9.8). Ten conversations
describe these two systems on this set; they cannot rank them against the rest of the field.

The 2026-10 scoreboard compared three-reader means (67.6% against 58.9%) with a gpt-4.1-mini judge and couldn't separate
them. This comparison pairs one reader, Opus 5.5, under the same judge, which removes the reader differences between
the runs.

## What changed since the earlier builds, on Opus

These pairs are descriptive and size the changes the preregistration named.

| Pair | View | Change (95% interval) |
|---|---|---|
| Whole now against the 2026-10 scoreboard's whole system (v0.60.138.0) | frontier | −3.9 points (−8.3 to +0.4) |
| Whole now against the 2026-10 scoreboard's whole system | bridge | +1.8 points (−3.7 to +7.4) |
| A0 now against the 2026-10 scoreboard's 8,000-token row | bridge | +1.4 points (−2.9 to +5.8) |
| A0 now against F6's A0 (v0.60.493.0) | bridge | +8.3 points (+3.0 to +13.2) |

The two views disagree in sign on the whole system against v0.60.138.0, and neither interval excludes 0. That covers
the cap of 3 meaning-only pages per query and the quote fences together, so we can't say which way they moved it.

### Quote fences

Measured on every delivered context with cl100k, against gbrain's 5,500-token reference budget:

| Arm | Contexts | Rows per context | Fence tokens per context | Share of budget |
|---|---:|---:|---:|---:|
| P | 200 | 28.5 | 1,416 | 25.7% |
| A0 | 198 | 49.8 | 3,575 | 65.0% |
| whole | 200 | 7.5 | 481 | 8.7% |

Every delivered context matched its arm's retrieval identity (0 overlay mismatches in each arm).

### Per ability, arm P against v0.60.493.0, Opus, frontier view

About 20 questions per ability, so these describe; they don't test.

| Ability | Predicted | Change (95% interval) |
|---|---|---|
| knowledge update | up | −1.3 points (−15.0 to +11.3) |
| temporal reasoning | up | +6.3 points (−3.8 to +17.5) |
| event ordering | up | −0.8 points (−5.3 to +2.9) |
| contradiction resolution | up | +2.5 points (−4.4 to +10.0) |
| multi-session reasoning | down | +0.9 points (−14.1 to +15.4) |
| summarization | down | +1.9 points (−2.0 to +5.7) |
| instruction following | none | −11.3 points (−25.0 to 0.0) |
| preference following | none | −3.8 points (−10.0 to 0.0) |
| abstention (19 questions) | none | +5.3 points (0.0 to +15.8) |
| information extraction | none | 0.0 points (−10.0 to +12.5) |

The dated-fact changes predicted gains on the first four abilities. Two moved up and two moved slightly down, all with
intervals that include 0. Instruction following fell most, and its interval reaches 0.

## What didn't go to plan

- **Ingest was marked degraded on 3 of the 10 conversations** (10m-4, 10m-8 and 10m-9), shared by every arm. F6 at
  v0.60.493.0 had 2 of them, 10m-8 and 10m-9, where gbrain refused its own finish step over a few unparsed pages;
  10m-4 is new at v0.60.748.0. Each of the three skipped its readiness probe, and the receipts don't record why, which
  we didn't investigate further. Those 60 answers are scored and kept, as the preregistration says. Without those 3 conversations, which is descriptive only, arm P's change against v0.60.493.0 is −0.4 points (−4.3
  to +3.6) and the whole system's gap to the file agent is −8.3 points (−13.0 to −3.4) on the frontier view.
- **Two arm A0 questions had no context,** because their stored retrieval failed. These are harness failures, so they
  drop from A0's pairs (197 of 199 scored) and are counted by reason in the report. Every pair still meets the
  completeness rule (at least 9 of 10 conversations and 95% of questions).
- **The particle-1 re-read** first started its three arms on one budget ledger, which holds one open lease at a time.
  Two arms were refused before they sent any request. They ran again under new run ids on their own ledgers, inside
  the same capped window. No request was sent twice.

## How it ran

- Campaign `q1-scoreboard-bn10-newest`, hash `d10688e786203c014c4ed1522fdc1decc9836b948e161eb11148cfab28d6c6cb`
  ([campaign file](../campaign/bn10-campaign.json)): 10 S1 shards, one conversation each, on Ubicloud VMs that were
  destroyed when their shards settled. Every shard finished complete for its 20 questions.
- The sealed data stayed in custody. Only the aggregates in [report.json](report.json) left it. The custody doctor
  (`eval:scoreboard doctor --for sealed`) passed before launch and again after the last cell.
- The pairing report: `bun eval/runner/bn10/pairing.ts report` with the stored F6 and Q1 receipts, the 789 stored
  answers gpt-6.1-sol judged again, the SDDs frozen in A3, the 10 counted cell roots, the three particle-1 re-reads and
  F6's particle-1 re-read, `--measured 2026-11-20 --bridge-status passed`.
- The pilot and dry run are in [dry-run/](../dry-run/README.md).

## Disclosures

- gbrain is Garry Tan's own project.
- Disclosure: Y Combinator, which Garry Tan runs, is an investor in Particle, which makes particle-1.
- Disclosure: OpenAI began through YC Research, which was started by Sam Altman, a former president of Y Combinator. Garry Tan runs Y Combinator.
