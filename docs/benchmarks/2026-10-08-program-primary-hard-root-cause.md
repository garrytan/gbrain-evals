# Why the T0b program primary fails, what current master changes, and the smallest fixes

## The finding

On the [T0b development baseline](2026-10-08-program-primary-hard-baseline.md), gbrain v0.60.106.0 failed 74 of 144
runs. We traced every failed item back to the tool calls the reader made, re-executed those calls on rebuilt brains, and
inspected the brains themselves. This report uses only the eight development personas (seeds 20261101 to 20261108);
no sealed seed was opened.

**The correction was almost never in front of the reader.** T0b has three stale-value failure classes: greeting the
procurement contact who handed off, quoting the old seat count or price, and giving the old meeting date. Together they
account for 112 failed items. In 111 of them, no tool result in the session contained the correcting page or its
decisive sentence. In one, the correcting mail came back at the very end of a 12,000-character search result. The
session's pushed context never carried a stale value. Background fact extraction never ran on the 919 imported pages,
so no fact superseded anything.

**The cause is where the corrections are reachable from.** The handoff mail and the reschedule mail each link to
exactly one page, the champion's person page, through a name mention (24 of 24 tasks). The call note with the
corrected figure links to nothing; it names the customer only by its short code ("Call with JOF"). Every reader opens
with `context_pack`, and its cards are built without the list of pages that mention the entity, so they show the
company page's stale procurement line and the deal page's stale terms and date. The `entity` card does include that
list, newest first, with a preview that contains the decisive sentence. In the 78 runs where the reader called
`entity` on the champion, 0 runs failed on the contact or the date. In the 66 runs without that call, 56 failed on the
contact and 34 on the date. gpt-6.1-sol makes that call in 46 of 48 runs, Sonnet 5.5 in 29, Opus 5.5 in 3. That is
most of the gap between the readers.

**Current master does not move it.** Candidate 0 is gbrain master `fc548317` (v0.60.122.0), measured on the frozen
protocol as a measurement, not a tuned candidate ([amendment 1](2026-10-08-program-primary-hard-preregistration.md),
commit `46d9ca77`). It failed 67 of 144 runs against 74: factor 1.10, 95% interval for the failure-risk ratio 0.64 to
1.28, verdict `inconclusive`. No product change on master touches this path. Its failures follow the same rule: every
contact and date failure is in a run that never called `entity` on the champion.

**A harness defect affects part of the frozen baseline.** Restored brains reranked against a dead port in every
invocation after the one that built them, so the baseline's repeat 2, its push-off ablation and part of its mutants ran
with search reranking failed. Repeat 1 ran with reranking. Failure counts barely differ between the repeats (Opus 19
and 19, Sonnet 17 and 18), so the headline stands, but the ablation's comparison mixes the two conditions. The fix is a
few lines in `GbrainSlot.restore`.

**The smallest fix most likely to work** puts the newest dated pages that mention an entity on the cards readers
already receive (`context_pack` cards and the per-turn pointer). On the baseline's own runs, readers that saw that
list never failed on the contact or the date. If the change works as well as the `entity` call did, at most 29 of the
74 baseline failures remain; adding short-code aliases for the call note brings the bound to 13. These are upper
bounds from observed behaviour, not measurements.

Spend: $53.19 of the $60 budget-ledger cap ($0.17 replay, $24.24 Candidate 0 baseline arm, $28.78 its mutants).

## The concrete case

Persona 20261104, task 1 (invented data). The brain holds:

- the company page: "Also called JOF in my notes ... Procurement: [[Arjun Ivers]] (Senior Buyer)";
- the deal page: "12 seats at $11 per seat per month ... Next step: pilot kickoff on Friday, October 23";
- a September 26 mail from the champion, Kofi Aziz (JOF): "starting Wednesday, October 7, Yusuf Lindqvist takes over
  vendor procurement from Arjun";
- an October 9 mail: "Could we push the pilot kickoff to Friday, October 30?";
- an October 10 note, "Call with JOF": "the right number is $26 per seat; the $11 in the quote was a typo."

Opus 5.5 called `context_pack` on the champion and the company, `get_backlinks` on the company, opened the kickoff
meeting, the technical review, the deal and the call note, then searched twice. It wrote "Hi Kofi, hi Arjun ... Our
pilot kickoff is Friday, October 23", with the corrected $26 from the call note. The replayed calls show why. The
`context_pack` company card lists "Procurement: Arjun Ivers". `get_backlinks` on the company returns six wikilinked
pages and neither mail, because the mails mention "Kofi Aziz (JOF)" and "JOF" is not an indexed name of the company.
Neither search returned either mail. The same reader's `entity` call on "Kofi Aziz" would have returned both mails in
its `referenced_by` list, each with a preview containing "Yusuf Lindqvist takes over vendor procurement" and "push the
pilot kickoff to Friday, October 30".

## The experiment and results

### Root cause: method

- **Receipts.** The committed T0b baseline (`baseline/results.jsonl.gz`, `usage.jsonl.gz`). The usage receipts carry
  every tool call's name and arguments; the parsed calls match the cells' recorded call sequences in 144 of 144 runs.
  They do not carry tool results.
- **Replay.** The baseline brains were rebuilt from the same generator, seeds and gbrain commit (`7aa2caa0`), and every
  recorded session-1 and session-2 call was re-executed in order on a restored brain. Repeat 1 was replayed with
  reranking on, as it ran; repeat 2 with the Voyage endpoint pointed at a dead port, as it ran (see the harness defect
  below). Search results reproduce to within 2 characters in 174 of 230 repeat-1 calls and 205 of 259 repeat-2 calls;
  `get_page` reproduces in 726 of 805 calls. `context_pack` and `entity` results differ by tens of characters in most
  calls (timestamps and notices), not in the pages listed.
- **Brain inspection.** Facts rows, queued jobs and every link touching a correction page, read from each persona's
  post-build snapshot.
- **Classification.** For each failed item, did any session-2 tool result contain the correcting page (A: never
  returned), list it without its decisive sentence (B: returned but outranked or truncated), or carry the decisive
  sentence or the opened page (C: present, the reader kept the stale page's value)? D, the stale value pushed by the
  session's hooks, is checked separately.

### Root cause: classification of every failed item

| Failure class | Opus 5.5 | Sonnet 5.5 | gpt-6.1-sol | Label |
|---|---:|---:|---:|---|
| Superseded procurement contact | 36 | 19 | 1 | all A, never returned |
| Stale seat count or price | 2 | 20 | 0 | all A |
| Old meeting date | 17 | 16 | 1 | 33 A; 1 C (Sonnet, the mail at the end of a long search result, replay not byte-exact) |
| Hop commitment missed | 1 | 10 | 0 | not a correction; the review note was not opened |
| Namesake's value | 2 | 0 | 0 | false flags on two cells that fail for other reasons (scorer audit) |
| **A / B / C / D over the 112 correction items** | | | | **111 / 0 / 1 / 0** |

No session-2 push, in any of the 144 runs, carried a stale contact, stale terms or an old date. The SessionStart hook
pushed the saved promise as hot memory; the UserPromptSubmit hook pushed the champion's pointer and the promise.

### Root cause: why the corrections never came back

1. **The correction pages are reachable only through the champion or through search.** In all 24 tasks the handoff
   mail and the reschedule mail carry one link each, a `mentions` link to the champion's person page. The call notes
   carry no links. The old procurement contact's page gets no link from the handoff, which names him by first name only.
   ([brain-inspection.json](2026-10-08-program-primary-hard/root-cause/brain-inspection.json))
2. **The company's short code is not one of its names.** The company page says "Also called JOF in my notes", but the
   card's `aka` list is empty, so "JOF" in a mail or a note title never links to the company. `get_backlinks` on the
   company (Opus called it in 33 runs) returns only wikilinked pages.
3. **The first call every reader makes omits the list that has the corrections.** 141 of 144 runs open with
   `context_pack`. Its cards are built with `includeReferences` off (`src/core/verbs/entity-card.ts:127-130`, called
   from `src/core/context/turn-context.ts:533` at v0.60.106.0), so they show only wikilink edges: the company card's
   "Procurement: Arjun Ivers" and the deal card's terms and next step. The `entity` verb computes `referenced_by`, every
   page linking here grouped by type and newest first (`entity-card.ts:272`, `src/core/mentions/referrers.ts:192`),
   and its preview carries the decisive sentence of both mails.
4. **Search finds the call note more often than the mails.** The call note reached the reader in 120 of 144 runs
   (search matches its pricing or seat words), so terms failures are rare for readers that search for the numbers.
   Sonnet 5.5 searches least (2.6 searches per session) and accounts for 20 of the 22 terms failures. Long multi-topic
   queries miss the mails: Opus's "YAR Yarithe kickoff reschedule moved sandbox SOC 2 bridge letter sent" (limit 10)
   returned old notes and daily pages and not "Re: pilot kickoff".

The `entity` call decides the contact and date outcomes:

| Reader | Runs with `entity` on the champion | Contact or date failures in them | Runs without | Contact failures | Date failures |
|---|---:|---:|---:|---:|---:|
| Opus 5.5 | 3 | 0 | 45 | 36 | 17 |
| Sonnet 5.5 | 29 | 0 | 19 | 19 | 16 |
| gpt-6.1-sol | 46 | 0 | 2 | 1 | 1 |

### Root cause: why gpt-6.1-sol almost never fails

It is the route, not a reading of dates. gpt-6.1-sol calls `entity` on the champion in 46 of 48 runs (and on the
company 51 times), makes 15.5 tool calls per session against 11.6 for Opus and 9.4 for Sonnet, asks search for 19 rows
on average against about 10, and opens 6.7 pages against 5.4 and 4.7. It opened the handoff, the call note and the
reschedule mail in 47 of 48 runs each; Opus opened the handoff in 4 runs and Sonnet in 26. Its one failed run is one
of the two runs where it skipped `entity` on the champion. Once a reader has the dated mail in front of it, every reader
uses it: no reader in the 78 `entity` runs kept the stale contact or date.

### Root cause: facts extraction

Facts extraction recorded neither the handoff nor the corrected figure. Each of the eight baseline brains had 0 facts
rows and 0 queued jobs after the build. At this release a page's facts are queued only after an MCP page write
(`src/core/persistence/effect-facts.ts:147`) and drained by `gbrain serve` (`src/commands/serve.ts:553`), or extracted
by the dream cycle, which the T0b carrier does not run. Imported mail and notes never reach it. The only facts in any
session were the promises the readers saved in session 1. Master's snapshot is the same: 0 facts rows after the
build, with Haiku 5.5 as the default extraction model.

### Harness defect: reranking failed after the first invocation

`GbrainSlot.build` writes the metering proxy's port into the snapshot's `provider_base_urls.voyage`
(`eval/runner/cat40/gbrain-arm.ts:217` on main), the proxy listens on a fresh port in each process
(`eval/runner/metering-proxy.ts:169`), and `restore()` never rewrote the URL. In any invocation after the one that
built a slot, gbrain's search rerank calls went to a dead port and searches returned
`degraded_recall (rerank_failed)` in fused order. In the T0b baseline, repeat 1 ran in the building invocation; repeat
2, the ablation and the base-brain sessions of the mutants did not. Replaying persona 20261101's repeat-2 searches with
a live reranker reproduces 1 of 29 result sizes; with a dead Voyage port, 22 of 29.

What it changes: the baseline failure counts are nearly equal across repeats, so the baseline rate stands. The push-off
ablation (dead reranker) was paired with repeat 1 (live reranker), so its two-direction result is not interpretable.
Candidate 0's baseline arm ran in a single invocation with reranking, so its repeat 2 differs from the frozen repeat 2
in reranker state; the repeat-1-only comparison below has the same condition on both sides. This branch rewrites the URL on
every restore (`refreshProviderBaseUrls`, with a unit test; GBRA-39 fixed it the same way on gbrain-evals #76) and
brings #76's fail-closed rerank probe: before any cell, one search per slot must reach a reranker through this
process's proxy, in Cat 40 and in T0b paid runs. The restore fix was saved while Candidate 0's stale-correction mutant
invocation was running; the forced-drop mutant invocations after it loaded the fixed code.

**Other committed results.** Any runner that restores a `GbrainSlot` in a process other than the one that built it had
the same defect; the Cat 40 runner builds slots in a separate `--build-slots` step. Two receipt signals show it: cells
whose metered gbrain calls include a rerank request (a dead port never reaches the metering proxy), and the
`rerank_failed` notice in tool results on gbrain builds that emit it. The per-run counts are in
[restore-audit.json](2026-10-08-program-primary-hard/root-cause/restore-audit.json). These receipts are not rewritten.

| Results (all Cat 40 runner unless noted) | Cells with a rerank request | Note |
|---|---|---|
| `2026-10-02-model-ladder/holdout` | 1691 of 1800 | reranker live |
| `2026-10-02-model-ladder/baseline-uncapped`, `pilot-capped-20k` | 362 of 1456; 185 of 300 | mixed within the run |
| `2026-10-02-model-ladder/dev-rounds`, `fix-wave-ladder`, `fix-wave-ladder-round4`, `scale-tier`, `followups/*` (7 runs) | 0 | no reranking in any cell |
| `2026-10-02-model-ladder/entity-recall/*` (dev-frontier master, round1, round2; holdout wave and new-models; uc3 master and kwonly) | 0 | notice in most cells where the build emits it |
| `2026-10-02-model-ladder/p8-hidden-tool-dev-smoke/*`, `2026-10-04-p8-dev/cat40/*` | 0 | P8 |
| `2026-10-03-agent-operator/f1f10-instruction-ab/runs/*` (9 runs) | 0 | all arms alike |
| `2026-10-03-agent-operator/f1f10-cat40-base-same-window-b3f4e8b` | 0 of 300 | its comparison runs `after-7d16702`, `after-b3f4e8b` and `baseline-master` reranked 300 of 300, so that comparison mixes conditions |
| `2026-10-05-registration-surface/*` | 0 | all arms alike |
| `2026-10-07-wave11-agent-smoke/*`, `2026-10-07-wave12-agent-smoke/*` | 0 | all arms alike |
| `2026-10-08-program-primary/baseline` (T0 runner) | 94 of 96 in repeat 1; 0 in repeat 2, mutants and ablation | same pattern as T0b |
| `2026-10-08-program-primary-hard/baseline` (T0b) | not metered per model | repeat 2, ablation and mutants' base sessions, shown by replay above |

Where every arm lacked reranking, comparisons between arms still hold for a gbrain without its reranker, but absolute
gbrain numbers understate the shipped read path. The wave 1 evidence pilot does not use `GbrainSlot` and is outside
this defect. The Cat 40 Hard results live on gbrain-evals #76, which already carries a caveat.

### Candidate 0: current master on the frozen protocol

Preregistered as amendment 1 (`46d9ca77`) before any of its cells: frozen generator, knobs, scorer, delivery contract
and starter surface, the eight development seeds, the three counted readers, baseline arm, 2 repeats, each cell paired
with the v0.60.106.0 cell of the same task, reader and repeat. Statistics are PW's frozen conditional-binomial
interval for the failure-risk ratio R (candidate over baseline failures), persona clusters, decision rule unchanged.

| Reader | v0.60.106.0 failures | Master failures | Factor 1/R | 95% interval for R | Risk difference (95%) | Verdict |
|---|---:|---:|---:|---|---|---|
| Sonnet 5.5 | 35/48 | 29/48 | 1.20 | 0.49 to 1.40 | −12.5 pts (−38.0 to +13.0) | inconclusive |
| Opus 5.5 | 38/48 | 36/48 | 1.05 | 0.58 to 1.54 | −4.2 pts (−18.6 to +10.3) | inconclusive |
| gpt-6.1-sol | 1/48 | 2/48 | 0.60 | 0.00 to very large | +2.1 pts (−9.5 to +13.7) | inconclusive (near ceiling) |
| **Pooled** | **74/144** | **67/144** | **1.10** | **0.64 to 1.28** | **−4.9 pts (−14.3 to +4.6)** | **inconclusive** |

Repeat 1 only, where both sides ran with reranking: Opus 19 to 18, Sonnet 17 to 14, gpt-6.1-sol 0 to 2 (`ceiling`),
pooled 36 to 34 (factor 1.06, interval 0.57 to 1.55, `inconclusive`). This is a post-hoc sensitivity check, not the
preregistered comparison.

What moved and why. Sonnet's date failures fell from 16 to 5 and its contact failures from 19 to 13. Sonnet called
`entity` on the champion in 35 runs on master against 29 on the baseline, and every contact and date failure on master
is again in a run without that call (Opus 35 contact and 17 date failures, all inside its 47 runs without the call;
Sonnet 13 and 5; gpt-6.1-sol 1 and 0). The difference is the reader's route on these runs, not a product change: master's
pushed context carries the same items, its `context_pack` cards are still built without `referenced_by`, the
correction pages carry the same single link, and master's brains also have 0 facts rows. Sonnet's stale-terms failures
fell from 20 to 13 and its hop misses from 10 to 8, inside run-to-run noise (the baseline's repeats agreed on 52 of 72
task and reader pairs). Namesake flags rose from 2 to 5; the scorer audit found that cue list too narrow for some
disambiguations.

Resource envelope against the baseline, per reader (limits 1.2x p95 session-2 latency, 1.5x mean tokens, 1.5x mean
dollars): Opus 1.03x, 0.93x, 0.94x; Sonnet 1.04x, 1.08x, 1.07x; gpt-6.1-sol 0.96x, 1.00x, 1.01x. All inside.

Mutants on master (validity check, one repeat, 144 cells): the forced-drop and stale-correction mutants each failed
24 of 24 runs for every reader, against master's repeat-1 failures of 18 (Opus), 14 (Sonnet) and 2 (gpt-6.1-sol) of
24. Both are detected for every reader under the frozen rule, and 288 of 288 Candidate 0 cells were scored, so the run
counts. The stale-correction invocation ran before the restore fix; the three forced-drop invocations ran with it.

## What to use and what to avoid

Use the classification to aim the fix: on T0b, gbrain's failures are retrieval-route failures, not reader judgement
failures. Readers that saw the dated correction used it every time. Do not spend the next candidate on read-time
precedence alone; at this release it would act on 1 of 112 items.

Do not read Candidate 0 as a regression or an improvement. Its interval spans both, and the one reader that moved
moved through a change in its own call pattern.

Do not reuse the frozen baseline's push-off ablation as evidence about push. It compared a dead-reranker arm with a
live-reranker baseline.

### Candidate designs, ranked by evidence (no build yet)

**1. Newest dated mentions on the cards readers already get.** When `context_pack` builds a card, and when the
per-turn pointer names a person, add the newest few pages that mention the entity and are dated after the entity page
itself, each with its date, title and preview, the rows `entity` already returns in `referenced_by`.
- Files: `src/core/verbs/entity-card.ts` (an ambient option that reuses `readReferrerGroups` from
  `src/core/mentions/referrers.ts`, capped at 3 to 5 rows and filtered to referrers newer than the card page),
  `src/core/context/turn-context.ts` (`assembleContextPack`, `renderCardLine`, and the pointer line of `render`),
  `src/core/ops/facts.ts` (`context_pack` budget packing prices the new lines), `docs/mcp/TOOL_REFERENCE.md`.
- Migration: none. The referrer query already runs for `entity` (its card reports about 200 to 360 ms latency on these
  brains); the per-turn hook path has a 400 ms server deadline (`resolve-ipc.ts`), so the pointer variant must stay
  inside it or degrade to the card variant only.
- Overlap: #6271 (GBRA-39) edits `entity-card.ts` and adds `entity-card-identity.ts`; #6066 (GBRA-52) adds
  `pinned_questions` and `withheld` to `context_pack`; GBRA-58's trust labels would render on the new lines.
  Sequence after #6271 or rebase onto it.
- Expected effect: the contact and date classes (Opus 53 items, Sonnet 35). On the baseline's runs, the readers that
  saw this list had 0 contact or date failures in 78 runs. If the cards do as well, failing runs fall at most to Opus 4,
  Sonnet 25 and gpt-6.1-sol 0 (74 to 29 pooled, a factor of about 2.6). Terms stay: the call note mentions nobody by
  full name. The hop commitment may also improve, because the company card would list the technical review.
- Risk: on a busy brain the newest mentions of a champion can be routine mail; the "newer than the entity page" filter
  and the cap keep it short, and a precision check on a large brain belongs in the gate.

**2. Short codes declared in prose become names of the entity.** #6271's alias grammar already treats "also called" as
a cue, so "Also called JOF in my notes" captures `JOF`, but `aliasRejection` drops names under 4 characters
(`src/core/mentions/aliases.ts:60` and `:249` on the #6271 branch). Allow a 2 to 3 character all-capitals code only
when the entity's own page declares it with a cue or a label, match it case-sensitively as a whole token, and add
common acronyms (`CEO`, `SSO`, `API`, `SOC`) to the generic list.
- Files: `src/core/mentions/aliases.ts`, `test/mentions-policy-aliases.test.ts`, `docs/designs/ALIAS_CONVENTIONS.md`,
  all on #6271's branch; no migration beyond #6271's own (the mention pass re-runs).
- Overlap: it is an amendment to #6271 F1 and should land there with GBRA-39's agreement, not as a second PR.
- Expected effect: the call note, the handoff and the reschedule mail link to the company, so `get_backlinks` on the
  company (Opus, 33 runs), the company's `entity` card and search's alias fan-out all reach them. With candidate 1 the
  company card would carry the call note, which addresses Sonnet's 20 terms failures. Combined upper bound: 13 failing
  runs pooled (Opus 3, Sonnet 10, gpt-6.1-sol 0), a factor of about 5.7, with the hop misses left.
- Risk: a three-letter code collides with ordinary acronyms; the own-page cue requirement and the generic list carry
  the precision, and #6271's calibration must re-run.

**3. Newer dated evidence takes precedence over a page's compiled truth at read time.** When `get_page`,
`context_pack` or a card returns a line that states a role, terms or a date, and a page dated after it mentions the
entity with change language ("takes over ... from", "push ... to", "the right number is"), mark the line with the
newer page's slug and date. Two routes: a lexical change cue recorded by the mention pass (a new derived link type,
which needs a migration), or facts extraction over imported pages plus cross-page supersession.
- Overlap: the facts route depends on #6066's per-model supersession thresholds; this harness embeds with
  `text-embedding-3-large`, which #6066 leaves uncalibrated, so pairs would go to conflict review rather than
  supersede. GBRA-58's labels raised the rate of giving the current value when a source contradicted the notes in its
  own eval, which is the presentation half of this design. #6066's dated evidence header (`search.evidence_date_header`)
  is the smallest piece and would put dates on search blocks.
- Expected effect on T0b today: 1 of 112 items, because the correction is almost never present. It becomes the next
  lever after candidates 1 and 2 put the stale page and the dated mail side by side.

**Measurement for each candidate.** Run the frozen T0b protocol on the eight development seeds with the restore fix,
paired against both the frozen v0.60.106.0 cells and Candidate 0 (master, the candidate's base), per reader first,
with a preregistration amendment that names the candidate before any cell (about $25 for 144 cells). Report the
mechanism next to the count: how often the correcting page reached the reader, by class. Then confirm on a fresh
custodian-minted seed set at the preregistered 32 personas, reader-stratified, with Opus 5.5 and Sonnet 5.5 as the
readers that can show a reduction.

## Reproduce and inspect

```bash
# root cause ($0.17 of embeddings and query calls): rebuild the baseline brains and replay the recorded calls
bun eval/runner/budget-ledger.ts open --runner t0b-root-cause-replay --budget-usd 1.5
bun docs/benchmarks/2026-10-08-program-primary-hard/root-cause/replay.ts --gbrain <gbrain checkout> --ref 7aa2caa0 --label frozen --budget-run-id <id>
bun docs/benchmarks/2026-10-08-program-primary-hard/root-cause/replay.ts --gbrain <gbrain checkout> --ref 7aa2caa0 --label frozen --dead-voyage --repeat-only 2 --budget-run-id <id>
python3 docs/benchmarks/2026-10-08-program-primary-hard/root-cause/classify.py

# Candidate 0 (ANTHROPIC_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY)
bun eval/runner/budget-ledger.ts open --runner t0b-program-primary --budget-usd 59.8
R="bun eval/runner/t0b-program-primary.ts --gbrain <gbrain checkout>@fc548317f628f25c6708049e17af22ee6b4e28ad --output <dir> --concurrency 4 --paid --budget-run-id <id>"
$R --arms baseline --repeat 2
$R --arms mutant-stale-correction
$R --arms mutant-forced-drop --readers gpt-6.1-sol    # then claude-sonnet-5-5, then claude-opus-5-5
bun eval/runner/t0/paired.ts --baseline docs/benchmarks/2026-10-08-program-primary-hard/baseline/results.jsonl.gz --candidate <dir>/results.jsonl
bun eval/runner/t0/paired.ts --baseline docs/benchmarks/2026-10-08-program-primary-hard/baseline/results.jsonl.gz --candidate <dir>/results.jsonl --repeats 1
bun eval/runner/t0/analyze.ts <dir>/results.jsonl
```

Code identities: frozen gbrain `7aa2caa0` (v0.60.106.0); Candidate 0 gbrain `fc548317f628f25c6708049e17af22ee6b4e28ad`
(v0.60.122.0, tree `cee82bc1`), verified overlays; gbrain-evals `af69d465` plus amendment 1 (`46d9ca77`); Bun 1.4.2;
generator `program-primary-hard-v1`, world digest `dccafc6f`.

Receipts in [`2026-10-08-program-primary-hard/`](2026-10-08-program-primary-hard/):
- `root-cause/replay-live.jsonl.gz`, `root-cause/replay-dead-reranker-repeat2.jsonl.gz`: every replayed call with its
  result and the original result's size;
- `root-cause/brain-inspection.json`, `root-cause/gold.json`, `root-cause/classification.json`,
  `root-cause/classify.py`, `root-cause/replay.ts`;
- `candidate-0-master/`: `results.jsonl.gz`, `usage.jsonl.gz`, `summary.json`, `receipt.json`, `paired.json`,
  `paired-repeat1.json`, cost receipts and the last invocation's `experiment.json`.

| Ledger spend | Dollars |
|---|---:|
| Replay of recorded calls (three runs) | 0.17 |
| Candidate 0 baseline arm, 144 cells | 24.24 |
| Candidate 0 mutants, 144 cells | 28.78 |
| **Total** | **53.19** |
