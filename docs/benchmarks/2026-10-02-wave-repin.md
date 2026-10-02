# The October 1 categories after gbrain fix waves 5 and 6 (2026-10-02)

## The finding

All 20 gbrain bugs that the October 1 eval-category wave recorded are fixed at gbrain master `d44296c` (v0.60.30.0), and a rerun here verified each one. We re-ran eight categories with the same runners, seeds and settings as the October 1 runs and compared them to the October 1 numbers at `3a284ae` (v0.60.26.0). In those eight categories, every safety contract that failed on October 1 now passes, and so does every utility floor that failed.

[gbrain](https://github.com/garrytan/gbrain) is a memory system for agents. It stores notes as Markdown and builds a database index for search and relationships. The two fix waves are [garrytan/gbrain#5839](https://github.com/garrytan/gbrain/pull/5839) (fix wave 5, v0.60.28.0) and [garrytan/gbrain#5845](https://github.com/garrytan/gbrain/pull/5845) (fix wave 6, v0.60.30.0). Most of their eval-related fixes were written against this repository's [bug ledger](2026-10-01-wave-bugs.md).

What changed for a user:

- **Updates (N1).** `gbrain ontology-add` now works on a brain made by `gbrain init`. Current-value accuracy went from 288/388 to 388/388 probes and history retained from 168/385 to 385/385. N1 now passes all five of its preregistered rules.
- **Forgetting (N5).** A running server no longer serves a forgotten fact from its 30-second cache. Prohibited outputs after `forget` went from 2 to 0. Retained-neighbor recall went from 738/750 to 750/750, and the first corrected `remember` after a forget is accepted (6/6, was 4/6). N5 now passes all seven of its rules.
- **Contradictions (N2).** With the new judge prompt (version 3), gbrain's judge called 132/150 planted same-time conflicts contradictions, up from 105/150. False contradictions on unrelated pairs fell from 109/1,977 to 26/1,968. All three preregistered decision rules now hold, so the report may say the judge "separates same-time conflicts from dated changes" on this world. This is a paid arm and reports only; it never gates.
- **Transcripts (N12).** A short status note with bold labels no longer parses as a chat. N12 now passes all six of its rules on two seeds, so its hold was removed as the hold itself prescribed. **N12 now gates CI.**
- **Proactive recall (N8).** `volunteer_context` and the turn-context block delivered 0 private pages, down from 4 and 4. N8 stays report-only.
- **Code intelligence (N13).** `code_def` found 49 of 50 top-level functions, up from 40. The `resolved` flag is true on 76 of 91 caller edges, up from 0 of 81.
- **Multi-hop (N9).** No change. Composed two- and three-hop questions still never produce a multi-relation plan, which is a documented feature gap. "Who attended <meeting>?" questions now resolve the meeting as their seed. They still never fire, for a reason explained below.

Measured on 2026-10-02 at gbrain `d44296cf4d6481a10eb85562d3179e38cfd02c43`, through a copied overlay, with provider keys stripped except where a paid arm names one, and System One off. Paid spend was $6.37.

## What one of these fixes looks like

N5 checks the documented promise of `forget`: a withdrawn fact leaves every active recall surface and stays gone. On October 1 the storage side kept that promise. One surface did not. An MCP server keeps a 30-second cache of the ten most recent facts. It uses that cache to build `context_pack` and the `_meta.brain_hot_memory` block attached to every tool response, and `forget` never cleared it. So for half a minute after an agent forgot "Hazel Example keeps bees" (a fictional claim), the server could still hand the claim to the next tool call. In the October 1 run, 108 PGLite and 304 Postgres remote responses carried a forgotten fact in `_meta` after its forget returned.

gbrain `3b1d238c` clears the cache after every write and re-checks the withdrawal ledger on every cache hit. In the rerun, 0 responses on either engine carried a forgotten fact. The `context_pack` tier had a forgotten fact witnessed before the forget in 14 pairs, and served it in none.

## The experiment and results

**What was rerun.** We reran every category that owns a fixed bug, which is all nine wave categories except A4. A4 had no bug in either fix wave, and its paid reader is the expensive part, so it was not rerun. Each runner used the command in its October 1 report, with `--gbrain <gbrain checkout>@d44296cf4d6481a10eb85562d3179e38cfd02c43` in place of `@3a284ae`. Seeds, generators, world files, top-k, judge model, probe budgets, engines and transports were unchanged. All 24 minimal repros from the ledger were also rerun against the new pin. Every one exits 0, which means the bug no longer reproduces; the gap repros, whose gaps are still open, exit 0 either way ([output](2026-10-02-wave-repin/repros-d44296c.txt)).

**Two differences from the October 1 setup.**

1. **Bun 1.4.2 instead of 1.3.14.** gbrain v0.60.27.0 ([#5838](https://github.com/garrytan/gbrain/pull/5838)) refuses to run on Bun below 1.4.0, so the CLI-spawning N1 and N5 cells cannot run on the old runtime. We used 1.4.2, the version gbrain's own CI uses, and moved this repository's CI to it as well.
2. **One new N2 probe.** The fix for N2-2 changed how gbrain's CLI marks a source the user did not choose, a flag that only gbrain's own `makeContext` sets. N2's existing probe imitates the October 1 CLI context and is kept unchanged. A new `local_bare_cli` probe asks `makeContext` for the context and so measures what a bare `gbrain find-contradictions` returns. N2's receipt now also reads the judge prompt version from gbrain instead of hard-coding "2".

**Results, October 1 (`3a284ae`) against October 2 (`d44296c`).** "Gating" means a preregistered rule in [`eval/registry.ts`](../../eval/registry.ts). Rules were not changed.

| Category | Measurement | Denominator | Oct 1 | Oct 2 |
|---|---|---|---:|---:|
| N1 knowledge update | Stale values served (gating, target 0) | 773 current-value and history probes, PGLite cells | 0 | 0 |
| N1 | Current-value accuracy (gating, floor 1) | 388 current-value probes, PGLite cells | 288 (74.2%) | **388 (100%)** |
| N1 | History retained (gating, floor 1) | 385 history probes, PGLite cells | 168 (43.6%) | **385 (100%)** |
| N1 | Private values in remote responses (gating, target 0) | every stdio and HTTP response; exposure probes with signal | 0 (24 of 32 with signal) | 0 (32 of 32 with signal) |
| N1 | Acknowledged writes lost (gating, target 0) | chains with an acknowledged last write | 0 | 0 |
| N1 | Postgres cells (report-only) | same probes | current 288/388, history 168/385 | current 388/388, history 385/385 |
| N1 | In-process ontology arm (exploratory) | 18 current-value probes; remote leaks | 17/18, 1 stale, 2 leaks | 18/18, 0 stale, 0 leaks |
| N1 paid arm | Value changes superseded implicitly (exploratory) | 10 value changes | 0 | 0 |
| N5 forgetting residue | Prohibited active outputs after forget (gating, target 0) | 146 witnessed forgotten (canary, tier) pairs over 5 checkpoints, PGLite | **2** | **0** |
| N5 | Reactivations, collateral expirations, unauthorized forgets, private leaks (gating, target 0 each) | per the N5 report | 0, 0, 0, 0 | 0, 0, 0, 0 |
| N5 | Retained-neighbor recall (gating, floor 1) | 750 witnessed retained pairs, PGLite | 738 (98.4%) | **750 (100%)** |
| N5 | Reinstatement of a corrected claim (gating, floor 1) | 6 corrected claims, PGLite | 4 (66.7%) | **6 (100%)** |
| N5 | Remote responses with a forgotten fact in `_meta` (reported) | stdio and HTTP responses after forget | 108 PGLite, 304 Postgres | 0, 0 |
| N5 | Postgres cells (report-only) | same denominators | 12 prohibited; 750/750; 6/6 | 0 prohibited; 750/750; 6/6 |
| N2 contradiction surfacing | Candidate recall (gating, floor 0.5) | 150 planted same-time conflicts | 150 | 150 |
| N2 | Probe changed a page; judge error read as a verdict (gating, target 0) | 825 pages; judge calls | 0; 0 | 0; 0 |
| N2 | Undated pages shown to the judge with a date (bug N2-1) | 190 undated planted pages offered | 190 | 0 |
| N2 | Bare CLI `find-contradictions` (bug N2-2) | stored findings (limit 100) | 0 of 210 | 100 of 190 |
| N2 paid | Conflicts called contradictions, end to end (decision rule, at least 0.80) | 150 planted same-time conflicts | 105 (70.0%) | **132 (88.0%)** |
| N2 paid | False contradictions on dated changes (decision rule, at most 0.10) | offered dated changes | 0 of 60 | 0 of 40 |
| N2 paid | False contradictions on compatible negatives (decision rule, at most 0.10) | offered compatible pairs | 2 of 51 (3.9%) | 3 of 50 (6.0%) |
| N2 paid | False contradictions on unplanted pairs | distinct unplanted pairs judged | 109 of 1,977 (5.5%) | 26 of 1,968 (1.3%) |
| N2 paid | Judged-pair precision | pairs called contradictions | 105 of 216 (48.6%) | 132 of 161 (82.0%) |
| N2 paid | Acceptable resolution proposals | findings | 159 of 210 (75.7%) | 172 of 190 (90.5%) |
| N12 format fidelity | Fabricated turns on non-conversation input (gating, target 0) | 16 negative items, seed 12 (seed 7 matches) | **3** | **0** |
| N12 | Noise leaks, invented timestamps, false attendance (gating, target 0 each) | per the N12 report | 0, 0, 0 | 0, 0, 0 |
| N12 | Control conversation recovered; `## Attendees` recall (gating, floors 1) | 27 formats; listed attendees | 27/27; 100% | 27/27; 100% |
| N12 | Round-trip timestamps exact (exploratory) | 266 adapter turns (16 with offset stamps) | 250 (0 of 16 offset) | 266 (16 of 16) |
| N12 | Mentioned-only people typed attended with no schema pack (exploratory, gap N12-7) | 24 mentioned-only people | 24 | 0 |
| N8 proactive recall | Private pages delivered to remote callers; into `turn_context` (report-only) | seeded sessions | 4; 4 | 0; 0 |
| N8 | Alias and title recall; false alarms on innocuous and no-mention turns | 42 trigger turns; 68 turns | 42; 0 | 42; 0 |
| N13 code intelligence | `code_def` top-1 right (report-only) | 50 top-level functions | 40 (9 empty) | 49 (0 empty) |
| N13 | `resolved` flag true | gbrain caller edges | 0 of 81 | 76 of 91 |
| N13 | Same-file calls found | 42 compiler-checked calls | 39 | 42 |
| N7 open loops | Planted-loop recall; closure; counterparty (gating floors) | 45 loops; 39 closures; 45 loops | 45; 39; 45 | 45; 39; 45 |
| N7 | Backfill nudges detected (exploratory, bug N7-1) | 6 inbound, 4 outbound follow-ups | 0, 0 | 6, 4 |
| N9 multi-hop | Strict all-hit at 10, relationship retrieval on (report-only) | 375 runs per wording, keyword path | canonical 10, paraphrase 5 | canonical 10, paraphrase 5 |
| N9 | Arm fired on composed questions | 750 runs per search path | 0 | 0 |
| N9 | One-hop "who attended" seeds resolved | 150 template runs | 0 | 150 |
| N9 paid | Strict all-hit at 10, hybrid search | 375 runs per wording | 3, 3 | 3, 3 |
| relational-ab paid | Paraphrase recall at five, off to on | 435 runs | 0.4109 to 0.5368 | 0.4109 to 0.5368 |
| relational-ab paid | Template first-place hit, off to on | 435 runs | 27.8% to 42.8% | 27.6% to 42.8% |

Several denominators moved, for one reason. At `d44296c`, undated pages reach N2's judge undated, so the date pre-filter now skips the 20 dated changes whose dates appear only in their text. Those pairs are no longer judged, and they no longer produce a finding. That shrinks offered dated changes from 60 to 40, stored findings from 210 to 190 and proposals from 210 to 190. This is the behavior N2-1 asked for. N13's edge counts grew from 81 to 91 because merged arrow functions now keep their own chunks (N13-1). The one-run change in the relational-ab template baseline (121 to 120 of 435 first-place hits with retrieval off) comes from the paid embedding path, not from a code change on the off arm.

**N2 per variant.** Judge prompt version 3 fixed most same-day conflicts and every mixed-date conflict. It did not change undated conflicts:

| Same-time conflict variant (50 each) | Oct 1 called contradiction | Oct 2 called contradiction |
|---|---:|---:|
| Both pages dated the same day | 29 | 46 |
| Both pages undated | 36 | 36 |
| One dated, one undated with that date in its text | 40 | 50 |

When neither page has a date, the judge still calls 14 of 50 real conflicts "temporal." The prompt now says a temporal verdict needs two different times, so this is a remaining quality gap of the judge. We do not treat it as a new bug against a stated contract, because the preregistered rules hold. It is listed as follow-up work.

**N2 cost and the probe cap.** The version 3 prompt is longer. The paid arm cost $6.24 against $5.74 on October 1, with the same probe budget ($6 split over 4 concurrent runs). One of the four runs hit its $1.50 cap. Its last query (13 pairs) was never judged, so the paid arm judged 2,667 of the 2,680 pairs the hermetic arm offered. All 150 planted conflicts were judged; the unjudged pairs were 1 compatible pair and unplanted pairs. On October 1 no run hit its cap. Capped pairs stay in every end-to-end denominator, as the runner requires.

**Why "who attended" still does not fire on world-v1.** Fix wave 6 fixed the three attendance bugs. With a documented attendance form, such as an `## Attendees` list, the repro stores attendance person to meeting, and the relationship arm finds both attendees. World-v1's meeting pages are older generated prose. They write "Ian attended in person" or "Chris dialed in from Singapore" next to a Markdown link. On October 1, under the legacy schema pack, every person linked from a meeting page was typed `attended`, even people only mentioned (N12-7). At `d44296c`, attendance needs evidence under every pack, and prose is not a documented evidence form (gap N12-6). So those links are now `mentions`, and the arm has no attended edges to follow. A four-page check of one world-v1 meeting at `d44296c` shows exactly that: three `mentions` links, no `attended` link. The seed now resolves (150 of 150 runs, up from 0), but the arm still fires 0 of 150 times, and recall did not change. This is the evidence gate working as designed. To test attendance retrieval end to end, the corpus needs attendee lists in a documented form.

## Gates

The preregistered rules decide every gate change. We moved no threshold.

- **N12 now gates.** On October 1 its rules were frozen and held, with this condition: "re-pin to a gbrain master that contains it, rerun N12, and remove this hold to make the row gate as preregistered" (`eval/registry.ts`, N12 `held.reason`). Master `d44296c` contains the N12-1 fix (`7f723e45`). The rerun passes all six rules on seed 12 and seed 7, and the ledger records N12-1 as fixed and verified. The hold was removed in the re-pin commit, as the `held` field's documentation requires.
- **N1 and N5 already have gate status, and now pass.** Both carry preregistered rules and are listed rather than dispatched, because their CLI cells take minutes and their Postgres cells need Docker. Their rules now pass on PGLite and on Postgres. They still do not run in CI. That needs a CI-sized slice, which is open work.
- **N8 stays report-only.** Its contracts now hold, but the plan keeps it report-only until people review its associative labels.
- **N9 and N13 stay report-only.** Neither has a gating rule. Composed multi-hop is a feature gap, and N13 is a readiness scout until independent call-graph gold exists.
- **Paid arms never gate.** The N2 decision rules decide only what this report may say.

## The bug ledger after the rerun

The [ledger](2026-10-01-wave-bugs.md) keeps each finding as it was found: the failing gbrain commit, the expected result and the actual result. A new `review` field records the 2026-10-02 check: the gbrain commit checked, the evidence and the receipts. Fixed bugs also gain `fixing_pr` and `fixing_commit`.

| Status on 2026-10-02 | Count |
|---|---:|
| Bugs fixed and verified by a rerun here | 20 |
| Bugs fixed upstream but not re-verified | 0 |
| Bugs still open | 0 |
| Feature gaps closed by gbrain (N12-7, legacy-pack attendance) | 1 |
| Feature gaps still open, rechecked by a rerun | 25 |
| Feature gaps not rechecked (A4-1, A4-2; A4 was not rerun) | 2 |
| Category defects, unchanged (A4-3 open; A4-4 and N2-6 deferred; N1-5, N1-6, N5-7 and N12-8 not-a-bug) | 7 |

Fix wave 5 squash-merged as master `0588aea6`. Fix wave 6 then merged its lane commits, including wave 5's eval-lane commits, as a merge commit. So each `fixing_commit` names the original lane commit, which is an ancestor of `d44296c`:

| Bugs | gbrain PR | Fix commit |
|---|---|---|
| N7-1 | #5839 | `1842c749` |
| N8-1, N8-2 | #5839 | `bb4e9970` |
| N12-1 | #5839 | `7f723e45` |
| N12-2 | #5839 | `e437fe3d` |
| N13-1 | #5839 | `02b0d0f4` |
| N13-2, N13-3 | #5839 | `bf087a04` |
| N1-1, N1-2, N1-3 | #5845 | `982a77eb` |
| N5-1 | #5845 | `3b1d238c` |
| N5-2, N5-3 | #5845 | `9eaab73f` (the N5-2 lock wait is `5a550533`) |
| N2-1 | #5845 | `7d70363e` |
| N2-2 | #5845 | `e833e93d` |
| N2-3 | #5845 | `89a4f8a9` |
| N9-2, N9-3, N9-4 (and gap N12-7) | #5845 | `81755f5b` |

Two of the verifications rest on repros rather than on a category run. N9-2 concerns schema-pack frontmatter relations, which world-v1 pages do not carry. N13-3 concerns a name defined in two languages, which the vendored N13 repository does not contain. Both repros now pass.

No new gbrain bug was found. The findings above that are not bugs (undated conflicts called temporal, prose attendance typed as mentions, the probe cap) are recorded as follow-up work in `TODOS.md`.

## What to use and what to watch

- If your agent updates facts through the ontology (`ontology-add`, `ontology_propose`) on a managed brain, v0.60.30.0 is the first version where that works. Reverts to an earlier value now record a new interval, and private observations stay private to remote callers.
- If you rely on `forget` in a long-running MCP server, upgrade. The 30-second window in which the server could still hand out a forgotten fact is closed on both engines.
- If you surface contradictions, judge prompt version 3 calls far fewer false contradictions. Watch undated notes: 14 of 50 real conflicts between undated notes were still called changes over time.
- If you want "who attended" questions to use relationship retrieval, write attendees in a documented form, such as an `## Attendees` list, frontmatter `attendees` or bold `Attendees:`. Since v0.60.30.0, names mentioned in meeting prose are typed as mentions under every schema pack. Existing brains re-derive Markdown attendance on `extract --stale`. Frontmatter relations need one `gbrain extract links --source db --include-frontmatter --source-id <id>` per source (see gbrain's v0.60.30.0 release notes).
- All of this is synthetic data with generator gold, and these worlds were inspected during the fix wave. The N2 world is the one the judge bug was found on. None of this is a held-out result. The sealed confirmation sets were not touched.

## Reproduce and inspect

From the repository root, with a gbrain checkout at `d44296cf4d6481a10eb85562d3179e38cfd02c43` and Bun 1.4.2 or later:

```bash
bun install --frozen-lockfile
G=<gbrain checkout>@d44296cf4d6481a10eb85562d3179e38cfd02c43
PG=postgres://postgres@127.0.0.1:55432/postgres   # docker run -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 pgvector/pgvector:pg16
bun eval/runner/n12-format-fidelity.ts --gbrain $G                     # 13 s, $0
bun eval/runner/n12-format-fidelity.ts --gbrain $G --seed 7 --output <dir>
bun eval/runner/n13-code-intelligence.ts --gbrain $G                   # 7 s, $0
bun eval/runner/n7-open-loops-email.ts --gbrain $G                     # 7 s, $0
bun eval/runner/n8-proactive-recall.ts --gbrain $G                     # 36 s, $0
bun eval/runner/n5-forget-residue.ts --gbrain $G --engines pglite,postgres --pg-url $PG   # 10 min, $0
bun eval/runner/n1-knowledge-update.ts --gbrain $G --engines pglite,postgres --pg-url $PG # 6 min, $0
bun eval/runner/n2-contradiction-surfacing.ts --gbrain $G --output <dir>                   # 73 s, $0
bun eval/runner/n9-multi-hop-paraphrase.ts --gbrain $G --output <dir>                      # 108 s, $0
bun eval/runner/budget-ledger.ts open --runner <name> --budget-usd 60
bun eval/runner/n2-contradiction-surfacing.ts --gbrain $G --paid --budget-run-id <id> --output <dir>  # 37 min, $6.24, ANTHROPIC_API_KEY
bun eval/runner/n9-multi-hop-paraphrase.ts --gbrain $G --paid --budget-run-id <id> --output <dir>     # 8 min, $0.065, OPENAI_API_KEY
bun eval/runner/relational-ab.ts --gbrain $G --paid --budget-run-id <id> --output-dir <dir>           # 8 min, $0.065, OPENAI_API_KEY
bun eval/runner/n1-knowledge-update.ts --gbrain $G --paid --budget-run-id <id>                         # 21 s, $0.000006, OPENAI_API_KEY
```

The repros are listed in [`repros-d44296c.txt`](2026-10-02-wave-repin/repros-d44296c.txt), each with its command. Times are from a 4-core cloud machine. The N1 and N5 runs shared it with the N2 paid run.

**Receipts** (all in [`2026-10-02-wave-repin/`](2026-10-02-wave-repin/)): N1 [`n1-n5/n1-receipt-d44296c.json`](2026-10-02-wave-repin/n1-n5/n1-receipt-d44296c.json) and the [paid arm](2026-10-02-wave-repin/n1-n5/n1-paid-receipt-d44296c.json); N5 [`n1-n5/n5-receipt-d44296c.json`](2026-10-02-wave-repin/n1-n5/n5-receipt-d44296c.json); N2 [hermetic](2026-10-02-wave-repin/n2/receipt-hermetic-d44296c.json) and [paid](2026-10-02-wave-repin/n2/receipt-paid-d44296c.json); N12 [seed 12](2026-10-02-wave-repin/n12/receipt-pin-d44296c.json) and [seed 7](2026-10-02-wave-repin/n12/receipt-pin-d44296c-seed7.json); N13 [receipt](2026-10-02-wave-repin/n13/receipt-pin-d44296c.json); N7 [receipt](2026-10-02-wave-repin/n7/receipt-pin-d44296c.json); N8 [receipt](2026-10-02-wave-repin/n8/receipt-pin-d44296c.json); N9 [hermetic](2026-10-02-wave-repin/n9/n9-hermetic-d44296c.receipt.json), [paid](2026-10-02-wave-repin/n9/n9-paid-d44296c.receipt.json) and the [one-hop rerun](2026-10-02-wave-repin/n9/relational-ab-d44296c-paid.receipt.json). Per-question and per-pair rows are inside each receipt. Spend, by model and by receipt, is in [`ledger-summary.json`](2026-10-02-wave-repin/ledger-summary.json): one budget run capped at $60, 5,035 paid requests, $6.37, every request reconciled to provider-reported usage.

Before commit, machine-local paths in the receipts were rewritten with the repository's `scrubMachinePaths` (home directory to `~`, temporary directory to `<tmp>`), as the receipt path rule requires. No number changed. The October 1 receipts stay where they were, next to their reports.

**Code identities.** Every receipt records gbrain `d44296c` as both declared pin and loaded commit (`execution.product`), and the overlay tree hash was verified. The gbrain-evals working tree recorded in `execution.source_tree` differs by run. N12 ran on `f94e98d` with only the re-pin edits uncommitted. The other runs name `b3bc904` (N13, N7, N8) or `721f7c4` (N1, N5, N2, N9). Those were local commits, rewritten before push into `adffe95` and `09fd860`. Against `09fd860`, `721f7c4` differs only in the path scrub of the two N12 receipts. `b3bc904` also lacks the N12 hold removal and the N2 prompt-version label, neither of which affects N13, N7 or N8. The N1, N5, N2 and N9 runs also had the ledger edits that this release commits, uncommitted.
