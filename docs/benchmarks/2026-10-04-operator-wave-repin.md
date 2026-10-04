# The categories after gbrain v0.60.38.0 to v0.60.46.0 (2026-10-04)

## The finding

Moving this repository from gbrain `109b992` (v0.60.37.0) to gbrain master `739e5cc` (v0.60.46.0) changes no accuracy, recall or leak count except one that improves: A4's keyword-only grade now calls 100 of 120 answerable questions `moderate` instead of 40, and still calls 0 of 120 unanswerable ones `moderate`. All 28 ledger repros pass at `739e5cc`, including Cat7-1's, which failed at `109b992`.

The preregistered rules flagged two things, and neither is a gbrain regression:

- **N6 failed with 3 "existence oracle" probes.** The new agent notices are shown once per session, and N6 sent every probe through one session, so the first of two identical `think` calls carried a notice the second lacked. A repro shows the notice follows call order, not the private page. N6 now gives each probe its own session and passes at both commits. Ledger entry [N6-1](2026-10-01-wave-bugs.md), a defect in this repository.
- **One wave 8 check stopped at a consent prompt.** `gbrain embed --stale` without a terminal now asks before spending, as the v0.60.46.0 release notes say. With `--yes`, the time-budget stop it checks still works.

The `get_timeline` slowdown from Foundations 1 (Cat7-1) is about one third smaller but not gone: about 0.075 ms per call at 1,000 pages against 0.045 ms before Foundations 1. Under the closure rule we froze in advance, the entry stays open. The four follow-ups gbrain shipped for this repository's earlier findings all check out: the empty-grant refusal names the real token id, `edit_page` diffs list removed lines first, a conversation page can set its own segmentation gap, and automatic event extraction writes a clear receipt and refuses to run without a chat model.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It stores notes as Markdown and builds a database index for search and relationships. The range holds seven merges:

| Merge | gbrain commit | Release | What it changes |
|---|---|---|---|
| [#5985](https://github.com/garrytan/gbrain/pull/5985) | `7ff802134` | v0.60.38.0 | the managed writer guard takes tags, timeline entries and takes from their page |
| [#5987](https://github.com/garrytan/gbrain/pull/5987) | `f4739fff2` | v0.60.39.0 | `gbrain repair failed-writes` replays writes the guard refused |
| [#5982](https://github.com/garrytan/gbrain/pull/5982) | `8d8093975` | v0.60.40.0 | refused writes say why; `sources reconcile` classifies additive drift |
| [#5992](https://github.com/garrytan/gbrain/pull/5992) | `101799f1f` | v0.60.41.0 | a relaxed keyword match corroborated by the top five grades `moderate` (#5919); per-page segment gap (#5918) |
| [#5995](https://github.com/garrytan/gbrain/pull/5995) | `e6d6dda7b` | v0.60.44.0 | smaller tool list and search rows for agents (the Cat 40 cost wave) |
| [#5993](https://github.com/garrytan/gbrain/pull/5993) | `8b5ed04c6` | v0.60.45.0 | `auto_chronicle` on by default: meeting, chat and calendar pages become timeline events |
| [#5991](https://github.com/garrytan/gbrain/pull/5991) | `739e5cc89` | v0.60.46.0 | every error and notice tells the agent what to do next and whether to ask the user; the Cat7-1, empty-grant and `edit_page` follow-ups |

Measured on 2026-10-04 (UTC) on Bun 1.4.2, with no provider key in any run and System One off. Provider spend: $0. Three plans were frozen in their own commits before the runs they govern: the [regression check](2026-10-04-operator-wave-repin-preregistration.md), the [follow-up checks](2026-10-04-operator-wave-repin-coverage-preregistration.md) and the separate [`auto_chronicle` experiment](2026-10-04-auto-chronicle-lift-preregistration.md), which has [its own report](2026-10-04-auto-chronicle-lift.md).

## What one of these changes looks like

An agent connected over HTTP holds a legacy token whose source grant was set to "none". At `109b992` its searches were refused with:

```
On the brain host, grant sources with: gbrain auth rescope-token <name> --sources <id,...>
```

The agent had no way to know `<name>`. At `739e5cc` the refusal carries the command with the token's own id, who runs it and what to ask the user:

```json
"fix": {
  "command": "gbrain auth rescope-token --id 59f36d30-1b97-4ade-87c2-138960d69930 --sources '<sources>'",
  "actor": "host_admin",
  "next": "tell_user_to_run",
  "inputs": [{ "name": "sources", "how": "Ask the user which source ids this connection should read ..." }]
}
```

The token and its id were created for the check on a throwaway brain.

## The experiment and results

### Regression check

**What ran.** The whole offline tier (`bun eval/runner/all.ts --tier offline`) once at each commit, on two identical Ubicloud `standard-16` VMs started together, each from a fresh copy of the tree and `bun install --frozen-lockfile`. Both trees hold the same gbrain-evals code; only the gbrain pin differs. This time Cat 34 ran inside the tier against the installed gbrain package. The same VMs then ran every ledger repro, the nine wave 8 checks, N12 at its second seed and the Cat7-1 repro three more times.

**Result.** 29 of 30 categories reach the same verdict at both commits, and the VM run at `109b992` matches v0.10.13's committed `109b992` receipts field for field (timings and paths aside). "Same" below means every scored field is identical.

| Category | 109b992 | 739e5cc | Denominator |
|---|---|---|---|
| Cat 1 relational, graph-first | Recall@5 0.935, Precision@5 0.337 | same | 145 relational questions |
| Cat 2 link types | type accuracy 0.747, strict F1 0.188 | same | 280 gold edges |
| Cat 3 aliases | documented recall 1.00, undocumented 0.138 | same | 800 lookups |
| Cat 4 timeline | 114 of 114 | same | 114 probes |
| Cat 6 prose traps | link precision 1.00, recall 1.00 | same | 250 injection probes |
| Cat 7 latency | gate passes | gate passes; see below | 22 reads and 4 bulk writes at 1,000 and 10,000 pages |
| Cat 10 adversarial | 22 of 22 | same | 22 pages |
| Cat 11 ingestion | 5 of 5 | same | 5 fixtures |
| Cat 12 MCP contract | 24 of 24 | same; 156 operations walked (was 155: `mute_notice`) | 24 assertions |
| Cat 19 remediation | 5 of 5 | same | 5 gates |
| Cat 22 source isolation | 8 of 8, 0 leaks | same | 8 probes |
| Cat 23 phantom redirect | 9 of 9 | same | 9 cases |
| Cat 24 capture provenance | 7 of 7 | same | 7 probes |
| Cat 27 graph signals | 4 of 4 | same | 4 probes |
| Cat 28 federated sync | gate passes; serial median 2,395 ms | gate passes; 2,360 ms | 3 passes per mode |
| Cat 34 memory conformance | 12 of 12 cells, 0 production gold failures | same | 4 suites x 3 harnesses |
| Cat 36 smoke | 4 of 4 | same | smoke subset |
| N1-ci | current 64 of 64, history 57 of 57, 0 private values exposed | same | 64, 57 and 12 probes |
| N2 hermetic | 150 of 150 conflicts offered | same | 150 planted conflicts |
| N3 as-of | as-of accuracy 1.00, range F1 1.00, last-seen error 0 days | same | 104, 179 and 58 probes |
| N4 entity resolution | B-cubed F1 0.762, 0 wrong merges | same (runner verdict "fail" at both; every gating rule passes) | 136 mentions |
| N5-ci | 0 prohibited outputs, 0 reactivations | same | 13 canaries x 7 tiers x 6 checkpoints |
| N6 leak fuzz | 0 content or existence leaks, 0 oracles, 0 gate bypasses | 0 leaks and 0 bypasses, **3 oracles (harness defect, below)**; 0 oracles after the fix | 5,992 probes (6,208 at 739e5cc: `mute_notice` adds a gated operation) |
| N7 open loops | recall, precision and closure accuracy 1.00 | same | 136 threads |
| N8 proactive recall | trigger recall 1.00, false alarms 0 | same | 60 triggers, 80 negatives |
| N9 multi-hop | composed strict all-hit 10 of 375 (template) | same | 125 questions x 3 seeds |
| N12 format fidelity | every rule, seeds 12 and 7 | same at both seeds | 233 scored items per seed |
| N13 code intelligence | 72 of 91 caller edges resolved | same | six `code_*` operations |
| A4 hermetic | answerable graded `moderate` 40 of 120; unanswerable 0 of 120 | **100 of 120**; 0 of 120 | 240 questions |
| SO record | 42 of 42 | same | 42 checks |
| Ledger repros | 27 of 28 exit 0 (Cat7-1 exits 1) | 28 of 28, same output apart from timings | 28 repros |
| Wave 8 checks | 9 of 9 | 8 of 9 (check C stops for consent, below) | 9 checks |

**N6's three oracle probes.** N6 asks every read operation about a private page and about a token no page contains (a "ghost"), as each kind of remote caller, and fails when the two answers differ: a difference would tell an outsider the private page exists. At `739e5cc`, `think` over HTTP answered the private-page question with an extra `[gbrain notice synthesis_keyless]` block. gbrain #5991 shows each notice once per transport, caller and session; N6 called gbrain with no session id and always sent the private-page probe first, so it got the notice and the ghost probe did not. The keyless repro ([`repros/n6-think-notice-order.ts`](2026-10-04-operator-wave-repin/repros/n6-think-notice-order.ts)) runs both orders:

| Order | Notice on the private-page answer | Notice on the ghost answer |
|---|---|---|
| private page first | yes | no |
| ghost first | no | yes |

The notice goes to whichever call comes first, so it reveals nothing about the page. N6 at `8b5ed04c6` (v0.60.45.0) has 0 oracles, which puts the change in #5991. This repository's N6 now gives every probe call its own session id ([receipts](2026-10-04-operator-wave-repin/n6-fixed/)); at both commits only the oracle count changes, from 3 to 0 at `739e5cc`.

**Wave 8 check C.** The check runs `gbrain embed --stale` with a one-millisecond time budget and expects exit 11. At `739e5cc` it gets exit 3 and a consent prompt ("Generating the missing embeddings sends your page text to the embedding provider and costs money ... OK to run it?"), because #5991 makes explicit embedding backfills ask first when no terminal is attached. The same check with `--yes` ([`checks/embed-budget-stop-consented.ts`](2026-10-04-operator-wave-repin/checks/embed-budget-stop-consented.ts), added after the run and not preregistered) passes all four expectations: exit 11, the remaining count, the resume, and exit 0 when drained.

**Latency.** The preregistered rule calls a read a suspected regression when its median (p50) is more than 25% slower, and a regression only if a second paired run on fresh VMs repeats it. One read crossed the line in the tier run, and the repeat did not confirm it:

| Cat 7 read, 1,000 pages | 109b992 | 739e5cc |
|---|---|---|
| `get_backlinks`, tier run | 0.125 ms | 0.220 ms |
| `get_backlinks`, repeat (three runs each) | 0.230, 0.226, 0.227 ms | 0.225, 0.229, 0.227 ms |

So it is reported, not counted. No bulk-write throughput fell. The repeat VMs started together and included a third at `48ed5e8` (v0.60.32.0, before Foundations 1) for Cat7-1, below. Receipts: [`offline-tier/`](2026-10-04-operator-wave-repin/offline-tier/) and [`cat7-repeat/`](2026-10-04-operator-wave-repin/cat7-repeat/).

### Follow-up checks

Four keyless checks under [`checks/`](2026-10-04-operator-wave-repin/checks/), run once at each commit. Receipts: [`checks-739e5cc.json`](2026-10-04-operator-wave-repin/checks-739e5cc.json) and [`checks-109b992.json`](2026-10-04-operator-wave-repin/checks-109b992.json).

| Check | What it shows | 739e5cc | 109b992 |
|---|---|---|---|
| E1. Empty-grant hint (`grant-hint-token-id.ts`) | the refusal for `search` and `get_page` names `rescope-token --id <the token's id>` and no `<name>` placeholder | pass | `<name>` placeholder |
| E2. `edit_page` diff (`edit-page-diff-order.ts`) | a one-line edit lists the removed line, then the added one; a two-line edit lists both removed lines first | pass | added lines first |
| E3. Segment gap #5918 (`segment-gap-5918.ts`) | three message pairs 45 minutes apart: 3 segments by default, 1 with `conversation_segment_gap_minutes: 60`; a quoted `"60"` or `20000` is ignored with a warning naming the range and the rerun command | pass | key ignored silently |
| E4. `auto_chronicle` without a chat model (`chronicle-receipt-keyless.ts`) | a recent meeting's write receipt says `pending: next_cycle`; a note gets no chronicle field; a 120-day-old meeting is skipped as `history` with a paid backfill fix; the phase reports `no_chat_provider` and judges nothing; `auto_chronicle false` skips by choice | pass | no chronicle receipt |
| E5. Cat7-1 repro | exits 0 in at least 3 of 4 runs on the `739e5cc` VM | 7 of 7 runs exit 0 (p50 0.057 to 0.062 ms) | exits 1 in 4 of 4 runs on the first VM |
| E6. A4 grade #5919 | answerable `moderate` about 100 of 120 (90 to 110), unanswerable `moderate` 0 of 120 | 100 and 0 | 40 and 0 |

**Cat7-1 in detail.** #5991 changed the unscoped `get_timeline` lookup to go by source and slug. The repro's median fell below its frozen 0.075 ms limit in every run. The closure rule we froze also asked Cat 7 itself to come within 25% of the pre-regression medians (0.045 and 0.052 ms), and it does not:

| Cat 7 `get_timeline`, 1,000 pages | 48ed5e8 (before Foundations 1) | 109b992 | 739e5cc |
|---|---|---|---|
| Tier run (paired VMs) | n/a | 0.105 ms | 0.076 ms |
| Repeat, three runs each | 0.042, 0.045, 0.047 ms | 0.102, 0.046, 0.047 ms | 0.079, 0.075, 0.074 ms |
| Repro median, repeat VMs | 0.033 to 0.037 ms | 0.037 to 0.039 ms | 0.059 to 0.062 ms |

At `739e5cc` the call is steady at about 0.075 ms, about 0.03 ms slower than before Foundations 1. At `109b992` it is bimodal: two Cat 7 runs and four repro runs took the slow plan, and two Cat 7 runs and three repro runs did not. gbrain's own measurement (0.087 to 0.057 ms) agrees with ours. Cat7-1 stays open with this review; at 0.03 ms per call it is not worth anyone's attention outside this ledger.

**Two smaller observations**, neither a broken contract:

- After a write, `gbrain dream --phase chronicle` printed "chronicle: nothing pending" while `gbrain doctor` reported "1 page(s) pending". The page was inside its 3-minute settle window; the phase summary could say so.
- The time-budget stop's resume hint is `gbrain embed --stale --catch-up` without `--yes`, so an agent that runs it as printed meets the consent prompt again. That is consistent with asking before each paid run.

## What to use and what to avoid

- **Trust keyless `query` grades more.** An answerable question whose wording the brain never uses no longer drops to `weak` when its answer is in the top five, so agents that require `moderate` abstain less on answers they have. Unknown companies and missing attributes still grade `weak`.
- **Expect agents to stop and ask** before paid embedding backfills, destructive commands and installs. Scheduled jobs that backfill on purpose need `--yes` or `--max-usd`, or a preapproval: `gbrain config set consent.preapprove.paid.max_usd_per_run <usd>`.
- **Collectors can set `conversation_segment_gap_minutes`** on chat pages whose cadence is not the 30-minute default.
- **Grant fixes are copy-and-run.** The empty-grant refusal names the token by id.
- **Harness authors: pass a session id.** Notices are shown once per session; a client that sends none shares one session for everything.
- **Limits.** All worlds are synthetic and were inspected during earlier fix waves; none of this is a held-out result. The sealed sets were not touched and no corpus was regenerated. Postgres, the managed writer guard, `repair failed-writes`, `sources reconcile` and status-only `serve` are not checked here; the [follow-up preregistration](2026-10-04-operator-wave-repin-coverage-preregistration.md) says why.

## Reproduce and inspect

From the repository root, with Bun 1.4.2 or later:

```bash
bun install --frozen-lockfile                                                          # gbrain 739e5cc from package.json
GBRAIN_REPO=$PWD/node_modules/gbrain bun eval/runner/all.ts --tier offline             # 6 min on a standard-16 VM, $0
bun eval/runner/n12-format-fidelity.ts --seed 7 --output <dir>                         # 8 s, $0
bun docs/benchmarks/2026-10-04-operator-wave-repin/run-repros.ts docs/benchmarks/2026-10-03-wave8-f1-repin/repros-109b992.txt <out.txt> \
  "bun docs/benchmarks/2026-10-03-wave8-f1-repin/repros/cat7-get-timeline-1k.ts"     # 5 min, $0
bun docs/benchmarks/2026-10-03-wave8-f1-repin/checks/run-all.ts <receipt.json>         # 4 min, $0
bun docs/benchmarks/2026-10-04-operator-wave-repin/checks/run-all.ts <receipt.json>    # 1 min, $0
bun docs/benchmarks/2026-10-04-operator-wave-repin/repros/n6-think-notice-order.ts    # 10 s, exits 1 at 739e5cc
bun eval/runner/n6-visibility-fuzz.ts --gbrain <gbrain checkout>@8b5ed04c6 --output <dir>   # N6 bisect, 35 s
```

The VM scripts are in [`vm/`](2026-10-04-operator-wave-repin/vm/) (`setup.sh`, `run.sh`, `cat7-repeat.sh`). For the `109b992` side, set the `gbrain` dependency in `package.json` back to `109b992172e1f49107f9de9841758c1d043a2668` and restore `bun.lock` from v0.10.16; for `48ed5e8`, take both files from `6e5fb1c`.

**Code identities.** The offline-tier VMs ran gbrain-evals `3ff60f9` (`739e5cc` side) and the unpushed local commit `4c3704a` (`3ff60f9` with the `109b992` lock files). The Cat 7 repeat VMs ran the same trees, plus `3ff60f9` with `6e5fb1c`'s lock files for `48ed5e8`, each with the repeat script untracked. The follow-up checks ran at `8644ada` on this machine, the `109b992` side through `GBRAIN_ROOT`. The N6 bisect and post-fix receipts were written on this machine with the fix uncommitted. Machine paths were rewritten with `scrubMachinePaths`; no number changed.

**Cost and time.** $0 in provider calls. Five Ubicloud `standard-16` VMs: two for about 13 minutes (offline tier and repros), three for about 3 minutes (Cat 7 repeat).
