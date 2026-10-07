# Preregistration: open-source memory shootout, update and forget (lifecycle-lite) (draft, 2026-10-06)

**Status: Draft.** Report-only, with no inferential family. Nothing here is frozen, and no counted cell may run until a
freezing commit records the code hashes and the campaign hash. Garry decided the first draft's open questions on
2026-10-06 (see "Decisions"): the reader-judged answer is the update headline, as-of probes stay report-only, the
survivor floor is 1.0, leases are 1.15 times the estimates, and the Mem0 cell waits up to four hours for `/finish`.
The campaign is written (`2026-10-06-oss-memory-shootout-lifecycle-lite/manifests/`), and every vendor shim passed a
keyless restart check.

Plan: [docs/plans/2026-10-05-oss-memory-shootout/PLAN.md](../plans/2026-10-05-oss-memory-shootout/PLAN.md), row P2 and
phase 6 ("seeded generator from N1 chains and N5 canaries, presence check before delete, survivor floor, restart,
mutation kit; registered report-only; gate: mutation suite rejects every fake"), and review decision 8 (update and
forget is its own lane). The memory-QA and PrecisionMemBench preregistration
([2026-10-06-oss-memory-shootout-preregistration.md](2026-10-06-oss-memory-shootout-preregistration.md)) says update and
forget gets its own preregistration; this is it. Registry entry: `lifecycle-lite` in
[eval/registry.ts](../../eval/registry.ts), `report-only`.

## The question

An agent's memory has to keep facts current and forget on request. Two cases:

1. **A correction.** In March the user says "Alder Example lives in Lisbon"; in November, "Alder has moved and now lives
   in Porto." Asked "Which city does Alder Example live in now?", does the memory system serve Porto, and does it stop
   serving Lisbon as the current answer? Asked the same question as of a date in between, does it serve Lisbon?
2. **A delete.** The user said "Hazel Example keeps bees" in one conversation and later asks for that conversation to be
   deleted through the system's public API. Is the claim gone from what the system returns, right after the delete and
   after the system restarts, while other facts about Hazel and everyone else are still there?

Corrections arrive as ordinary dated sessions through the system's normal ingestion; there is no `update()` call that
would tell the system which fact changed (plan decision 9). Deletes go through the protocol's `/delete_source`.

## What runs

### Systems

Every system runs behind the shim protocol v1 ([eval/systems/PROTOCOL.md](../../eval/systems/PROTOCOL.md)) at its
**common** configuration (extraction `gpt-4.1-mini`, embedder `text-embedding-3-large` at 1,536 dimensions wherever
settable), pinned exactly as in the memory-QA preregistration's systems table, plus gbrain-shootout in process at two
builds. Letta has no passive memory API at 0.34.4 and is out of scope, as in P1.

| System | Pin | Delete capability (capability record) | Time | Provenance |
|---|---|---|---|---|
| Basic Memory | `basic-memory==0.23.2` | native | in text | exact |
| Mem0 (OSS) | `mem0ai[nlp]==2.2.1` | public-api-composition (list the source's memories, delete each) | in text | partial |
| Graphiti (OSS) | `graphiti-core==0.30.2` | native (`remove_episode`; the pilot found residue, see below) | native | partial |
| Hindsight | server and client 0.10.2 | native | native | exact |
| Cognee | `cognee==1.6.2` | native | in text | partial |
| gbrain-shootout, repository pin | `739e5cc` (v0.60.46.0) | native (`deletePage`) | native | exact |
| gbrain-shootout, frozen master | `c5fb0201d1960a0a5a81c35d77718311b03154b7` (v0.60.95.0), `--gbrain` overlay | native (`deletePage`) | native | exact |

gbrain-shootout is the recipe the memory-QA preregistration describes (gbrain's own search defaults, Voyage reranker
on), with the common embedder. For lifecycle-lite its PGLite brain is kept on disk for the run so it can restart.

The Phase 2 pilot found that Graphiti's `remove_episode` deletes an edge only when the removed episode first created
it, so text from a deleted session can survive in an entity summary or in a fact first stored from another session.
lifecycle-lite measures that residue; the shim does not repair it.

### Data: seeded histories with an independent oracle

`eval/generators/lifecycle-lite-gen.ts` (`lifecycle-lite-gen@1`) builds one synthetic chat history per seed, one
namespace per history. **Seeds: 1, 2, 3, 4, 5** (`LIFECYCLE_LITE_SEEDS`). Each history has 67 short user and
assistant sessions, about 6,800 characters in all, each dated:

- **12 correction chains** from the N1 fence chains for the same seed
  ([n1-knowledge-update-gen.ts](../../eval/generators/n1-knowledge-update-gen.ts)): six fictional people, a home city and
  an employer each, update depth 1 to 4 three times each, three chains that revert to an earlier value. Each value is
  one session on its N1 date ("For your notes: Alder Example lives in Lisbon.", then "Update: Alder Example has moved and
  now lives in Porto."). N1's labels repeat across chains, so each distinct value gets a fresh label unique in the
  history; depth, kind, revert position and dates are N1's.
- **17 canaries** from the N5 ledger for the same seed
  ([n5-forget-residue-gen.ts](../../eval/generators/n5-forget-residue-gen.ts)): four fictional people with hobby claims
  ("By the way, Hazel Example keeps bees."), one claim per session. The 10 forgotten and late-forgotten canaries are the
  delete targets; the 7 retained canaries are survivors. N5's same-text twins, paraphrases, corrected claims and
  concurrent round depend on its `remember` verb and are left out.
- **8 filler sessions** of ordinary assistant chores that mention no person, value or hobby.

Gold is lexical and never comes from a system: each value has a whole-word pattern of its label, and each canary has
word-start patterns of its hobby (`beekeep` catches "beekeeper" as well as "bees"). The generator test proves that no
pattern matches any session except its own fact's, and that no label contains another.

Ids are opaque through the shootout sanitizer (`ns-…`, `src-…`); probe ids, probe kinds and session ids are forbidden
markers that the HTTP client refuses to send.

### Procedure per system and seed

`eval/runner/lifecycle-lite.ts` (core in `eval/runner/lifecycle-lite/run.ts`, `lifecycle-lite-run@1`), in one
namespace, strictly in this order:

1. `reset`, then ingest every session in event-time order, then wait for the system's quiescence signal (`/finish`).
2. **witness**: every probe once.
3. For each delete target, in ledger order: its probe again (**pre_delete**, the presence check right before the
   delete), then `/delete_source` on its session.
4. A second quiescence wait, then every probe (**after_delete**).
5. Restart the system with its state kept, then every probe (**after_restart**). A shim restarts with
   `bash eval/systems/bootstrap.sh restart --system <name>` (`docker compose restart`: processes start fresh, volumes and
   container file systems stay), after which the runner waits for `/health`. gbrain-shootout closes its on-disk brain
   and opens it again.
6. **Reader and judge** (on in every counted cell, `--qa reader`): each after_restart probe is answered by the fixed
   reader from the system's own items, then checked by the fixed judge against the ledger.

Retrieval uses the `fixed-evidence` policy, sending exactly the capability record's `settings` for that mode, and scores
every returned item (no token packing). Per system: 335 sessions ingested, 50 deletes, 5 restarts, 665 retrievals
(41 probes at witness, after_delete and after_restart, plus 10 pre_delete checks, per seed) and 205 reader and judge
pairs.

### Probes

Per seed, 41 probes, each a question with a query date:

| Probe | Count | Question and date | Correct |
|---|---:|---|---|
| `update_current` | 12 | "Which city does Alder Example live in now?" or "Where does Alder Example work now?", the day after the last session | headline: the reader answers with the final value and presents no earlier value as current; retrieval (report-only): the final value is in an active item and no value that was current earlier is |
| `update_asof` | 12 | the same question asked midway between the chain's first and second dates (report-only) | the first value is in an item active at that date, and no later value is; the reader's answer is reported too |
| `forget_target` | 10 | "Does Hazel Example keep bees?", the day after the last session | present at witness and pre_delete (signal), then in no item after the delete or the restart |
| `survivor` | 7 | the same form for a retained canary | present at witness and still present afterwards |

An item is **active** at a query date when the system dates it no later than that date (or not at all) and has not
marked it superseded by then (`valid_to` unset or later). A stale value returned only in superseded items is history,
not stale, the way a struck fence row is history in N1.

## Measures

All counts have named denominators and are reported per system, overall and per seed, at the final checkpoint
(after_restart) and per checkpoint.

- **Update (headline)**: `update_current` probes the reader answered correctly, of 60, as the judge decided. A failed
  retrieval is a wrong answer.
- **Update retrieval (report-only, a design choice)**: `update_current` probes whose items serve the new value with no
  earlier value active, of 60. Beside it: new value served (in an active item), an earlier value still active, earlier
  values returned only as superseded history, and probes where one active item carries both values. A system that keeps
  every session as written (gbrain-shootout, Basic Memory) still returns the earlier session after a correction; that
  is how it is built, not a failure, and the report says so. The headline asks whether the evidence it returns leads a
  reader to the current value.
- **As-of (report-only)**: `update_asof` probes correct on retrieval, of 60, the number with a later value active at the
  earlier date, and the reader's correct answers.
- **Forgotten**: witnessed delete targets absent at every later checkpoint, of the targets with signal. A target the
  system never surfaced at witness or right before its delete is **no-signal**: counted, never scored as a forget. Beside
  it: residue after the delete, residue after the restart, reactivations (absent after the delete, back after the
  restart), targets lost before their own delete, the delete statuses (`deleted`, `partial`, `unsupported`, `error`),
  and the witnessed targets whose deleted claim the reader did not affirm.
- **Survivor retention**: of the survivors present at witness (retained canaries, and each chain's final value), the
  share still present at the worst later checkpoint; and the witnessed retained canaries the reader confirmed.
- **Restart**: survivors present after the deletes and missing after the restart (lost), and reactivated targets.
- **Latency**: the shim's `service_ms` per retrieval and per delete; restart time per seed.

### Report-only contract checks

Each system gets six checks, reported as `pass`, `fail`, `no_signal`, `unsupported`, `not_run` or `incomplete`. None
gates anything; the category is report-only. The overall verdict covers the four headline checks; the two report-only
checks are printed beside it and never change it:

| Check | Kind | Pass when |
|---|---|---|
| update | headline | the reader answers every `update_current` probe correctly at the final checkpoint |
| forget | headline | every witnessed delete target is gone at every later checkpoint (`no_signal` if none was witnessed) |
| survivors | headline | survivor retention is **1.0**: every witnessed survivor is still present at every later checkpoint (`no_signal` if none was witnessed) |
| restart | headline | nothing lost and nothing reactivated by the restart |
| update_retrieval | report-only | every `update_current` probe serves the new value with no earlier value active |
| asof | report-only | every `update_asof` probe serves the then-current value with no later value active |

Overall is `pass` when every headline check that ran passes. A check that did not run (no reader, no restart) is
`not_run` and left out; every counted cell runs both.

### Outcomes

One canonical row per probe and checkpoint, from a frozen manifest and an append-only attempt log, with memory-QA's
outcome names (`eval/runner/memory-qa/outcomes.ts`): `scored`; product failures kept in the denominator as misses
(`retrieval_error`, `unsupported`, `ingest_degraded`, the last keeping its scores: more than 1% failed sessions or a
`/finish` that is not ready); harness failures that make a system's result incomplete, never a product loss
(`harness_invalid`, `budget_not_run`, and with the reader `reader_error`, `judge_error`). A restart that fails is a
harness failure for the after_restart rows. Deletes change state, so a resume reruns a whole seed from `reset`.

### Systems that cannot delete

A system whose `/delete_source` answers `unsupported` for every target (or whose capability record says
`delete: unsupported`) is reported as **delete unsupported**: the forget column shows "unsupported" with no rate, the
forget check is `unsupported`, and overall never passes. Its update, as-of and survivor measures are still reported. A
single target answered `unsupported` among others leaves the forget denominator and is counted. A delete answered
`partial`, or one that errors, is scored like any other by residue, with its status reported. `public-api-composition`
deletes (Mem0) are scored the same as native ones, with the capability printed beside the numbers. None of the five
vendors or gbrain declares `unsupported` today.

### Reader and judge

On in every counted cell (`--qa reader`); off by default on the command line so keyless runs stay keyless. The pair is
the memory-QA preregistration's LoCoMo pair (amendment A1): reader **`openai:gpt-4o-mini`**, judge
**`openai:gpt-4o-2024-08-06`**, temperature 0, one run, reader output up to 1,024 tokens, judge output up to 10 tokens.
The reader sees each after_restart probe with the system's own items (native context), rendered and packed to 8,000
tokens by the shootout renderer (`shootout-render-v1`, `eval/runner/systems/render.ts`): items in rank order, whole,
each printed as `- (<rank>, <type>[, superseded]) [valid <from> to <to>] <text>`, where the window appears when the
system dates the item. The reader prompt is the renderer's native template, byte for byte as P1 uses it, with the
probe's query date as the current date:

> I will give you items a memory system returned from past chats between you and a user, in the order the memory
> system ranked them. Some items carry the dates the memory system recorded for them; an item marked superseded was
> later replaced. Please answer the question based on these items. Answer the question step by step: first extract all
> the relevant information, and then reason over the information to get the answer.
>
> Memory Items:
>
> {items}
>
> Current Date: {date}
> Question: {question}
> Answer (step by step):

The judge prompts (`judgePrompt` in `eval/runner/lifecycle-lite/run.ts`) are new; no official benchmark prompt covers
these probes. The judge's first three words decide yes or no, as in P1 (`judgeYes`).

- `update_current` and `update_asof` (correct when yes):

  > I will give you a question, the correct answer at the question date, {outdated answers that were true earlier |
  > answers that only became true after the question date}, and a response from a model. Answer yes if the response
  > gives the correct answer and does not present any of the other answers as the answer at the question date.
  > Otherwise answer no.
  >
  > Question: {question}
  > Question date: {YYYY-MM-DD}
  > Correct answer: {value}
  > Other answers: {values separated by "; ", or none}
  >
  > Model Response: {response}
  >
  > Answer yes or no only.

- `forget_target` (correct when no):

  > I will give you a question, a statement that was deleted from a memory system, and a response from a model. Answer
  > yes if the response states or implies that the deleted statement is true. Otherwise answer no.
  >
  > Question: {question}
  > Deleted statement: {name} {claim}.
  >
  > Model Response: {response}
  >
  > Answer yes or no only.

- `survivor` (correct when yes): the same with "a statement that is true", "Answer yes if the response confirms the
  statement." and "True statement: {name} {claim}."

A reader or judge failure is a harness failure (`reader_error`, `judge_error`): the system's result is incomplete,
never a product loss. The renderer marks any item with an end date as superseded even when the question date comes
before that end; its printed window still shows the item was valid then. This touches only the report-only as-of
reader numbers and is left as P1 froze it.

## The phase gate: the mutation suite rejects every fake

`eval/runner/lifecycle-lite/fakes.ts` holds an honest reference memory (a temporal fact store that supersedes a fact
when a later-dated fact with the same person and relation arrives) and nine fakes that each cheat one way. The test
`test/eval/lifecycle-lite.test.ts` runs the real runner and scorer over each, on seeds 1 and 2 with a restart and with
a keyless scripted reader and judge standing in for the models (it answers from the latest-dated valid item that
matches the question, and judges lexically; it says nothing about a real reader). It requires the honest reference to
pass all six checks and each fake to fail the check its cheat trips:

| Fake | Cheat | Fails | Overall |
|---|---|---|---|
| never-deletes | answers "deleted", removes nothing | forget | fail |
| deletes-everything | one delete empties every namespace | survivors, update | fail |
| deletes-namespace | one delete empties its namespace | survivors, update | fail |
| stale-value | drops a later value for a known fact | update, update_retrieval | fail |
| serves-both | never supersedes: old and new values both active, both dated | update_retrieval (report-only) | pass |
| forgets-on-restart | a restart loses all state | restart, survivors, update | fail |
| ignores-dates | drops event and query dates; the latest arrival wins | asof (report-only) | pass |
| empty | stores nothing | update, forget and survivors (no signal) | fail |
| always-refuse | every retrieval fails | update, asof, forget and survivors | fail |

Result on 2026-10-06: every fake rejected by its check, the honest reference passing all six, also over protocol v1
HTTP. Two fakes are caught only by report-only checks, as the decisions intend: serves-both dates both values, so the
reader still answers with the new one (the test asserts the reader is right on all 24 of its update probes while the
retrieval check reports 24 stale values), and ignores-dates is caught by the as-of probes alone. Without the restart
checkpoint, forgets-on-restart passes, so every counted cell keeps the restart.

## Keyless end-to-end checks (harness evidence, not product results)

Run on 2026-10-06 on this branch without any provider key, before the reader became the headline, so they show the
retrieval measures only. These prove the plumbing; the keyword fake and hash vectors say nothing about memory quality.

| Run | update retrieval | as-of | forget | survivors | restart |
|---|---|---|---|---|---|
| Honest reference, five seeds, CLI | 60 of 60 | 60 of 60 | 50 of 50 | 95 of 95 | 0 lost |
| In-repo fake shim, Docker stack, five seeds, `bootstrap.sh restart` (about 12.5 s per restart) | 3 of 60 | 44 of 60 | 50 of 50 | 95 of 95 | 0 lost |
| gbrain-shootout at the pin, hash vectors, local rerank stub, five seeds, on-disk restart (32 s) | 0 of 60 | 0 of 60 | 50 of 50 | 95 of 95 | 0 lost |
| gbrain-shootout at frozen master `c5fb0201` (overlay tree verified), same setup (36 s) | 0 of 60 | 0 of 60 | 50 of 50 | 95 of 95 | 0 lost |

The fake shim and gbrain keep every session as written, so each correction leaves the earlier session retrievable and
not marked superseded: the retrieval check counts that as an earlier value served, which is why it is a report-only
design-choice measure and the reader's answer is the headline. gbrain-shootout's items carry no dates, so the as-of
check counts later values as active at the earlier date. The reading lane itself runs keyless in the tests and through
the CLI with `--qa scripted`, a lexical stand-in that is never counted.

## Keyless restart check per vendor shim

Run on 2026-10-06 with `bash eval/systems/restart_check.sh <system>` on two to three standard-8 Ubicloud VMs, without
any provider key. Each system came up at its common configuration through `bootstrap.sh up`, with a fake provider on
the proxy port, ran seed 1 through lifecycle-lite with the restart done by `bootstrap.sh restart`, and came down. The
question is narrow: does a restart lose state for shim reasons? With canned provider answers, the update, as-of and
forget numbers say nothing about the products and are not reported here.

| System | Keyless provider | Survivors witnessed | Present after the deletes | Present after the restart | Delete targets reactivated | Restart time |
|---|---|---:|---:|---:|---:|---:|
| Basic Memory | shared fake provider (`eval/systems/_shim/fake_provider.py`) | 19 | 19 | 19 | 0 | 19.2 s |
| Mem0 | Mem0's own `eval/systems/mem0/fake_provider.py` | 19 | 19 | 19 | 0 | 12.9 s |
| Graphiti | shared fake provider | 19 | 19 | 19 | 0 | 16.9 s |
| Hindsight | Hindsight's built-in mock LLM (`HINDSIGHT_LLM_PROVIDER=mock`), shared fake provider for embeddings | 19 | 19 | 19 | 0 | 14.9 s |
| Cognee | shared fake provider | 19 | 19 | 19 | 0 | 17.2 s |

No shim lost state on a restart, and no deleted claim came back. Every run completed with all 133 rows `scored`.

A first pass ran Mem0 and Hindsight against the shared fake provider. They returned no items at all, before and after
the restart, so the "nothing lost" result had no signal. The cause is the stand-in, not the shims: Mem0 made one
extraction call per session (67) and stored nothing from the shared provider's canned answer, and Hindsight's
`retain` extracted zero facts from it (its recall logged "0 facts, 0 chunks"; the `fixed-evidence` settings exclude
chunks). With each vendor's own keyless stand-in, as their conformance runs use, both witnessed all 19 survivors and
kept them. Mem0's run used the shim's default `MEM0_CHUNK_TURNS` (2); its counted cell sets 1.


## What the report may say

Descriptive only: five seeded histories are one synthetic workload, not a sample of users, and support no ranking.

- Headline: "On five seeded histories, with the same reader and {system}'s own evidence, the reader gave the corrected
  value for {a} of 60 corrections."
- Retrieval, beside it: "For {b} of them {system} also returned an earlier value without marking it superseded{, as a
  system that keeps every conversation as written does}." Never framed as a failure.
- "After {n} explicit deletes through its public API, {system} no longer returned {f} of the {w} deleted claims it had
  returned before the delete; {r} were still returned after the delete{, and {x} came back after a restart}."
- "{system} kept {s} of the {t} other facts it had returned before the deletes."
- As-of, report-only: "Asked as of an earlier date, {system} returned the value current then for {c} of 60."
- A system with `unsupported` deletes: "{system} has no public delete; forgetting was not measured."
- Graphiti's residue, if seen: the residue count and the pilot's explanation, never repaired by the shim.

Never "forgets correctly" or "keeps facts current" without the counts and the lexical-oracle caveat.

## Budget

Phase line in the plan: about $20. Estimates from the Phase 2 pilots (`eval/systems/<name>/PILOT.md`), common
configuration, per system for five seeds (335 sessions, 665 retrievals, 205 reader and judge pairs). Ingest uses each
pilot's LoCoMo cost per session (28 sessions, about 80,000 characters), an upper bound, because these sessions are
about 30 times shorter; priced per character instead, the same pilots put all five vendors' ingest under $1. Reader
and judge: $0.0027 per probe, the LoCoMo native-context reader and judge cost the pilots measured with the same pair
(Graphiti $0.0026, Hindsight $0.0027 per question), so $0.55 per system. Leases are 1.15 times each estimate.

| System | Ingest basis | Ingest | Query basis | Query | Reader and judge | Estimate | Lease |
|---|---|---:|---|---:|---:|---:|---:|
| Basic Memory | $0.0033 per LoCoMo conversation (embeddings) | $0.01 | embeddings | $0.00 | $0.55 | $0.56 | $0.65 |
| Mem0 | $0.968 per 675 `add` calls, one per turn pair | $0.48 | embeddings | $0.01 | $0.55 | $1.04 | $1.20 |
| Graphiti | $0.46 per 28 sessions | $5.50 | cross-encoder, 5 times vendor-default's $0.0013 (the pilot's own assumption for `fixed-evidence`) | $4.32 | $0.55 | $10.37 | $11.93 |
| Hindsight | $0.096 per 28 sessions | $1.15 | under $0.0001 | $0.07 | $0.55 | $1.77 | $2.04 |
| Cognee | $0.369 per 28 sessions | $4.41 | $0.000003 | $0.00 | $0.55 | $4.96 | $5.71 |
| gbrain-shootout, pin | embeddings | $0.01 | about $0.001 per retrieval (the Phase 4 retrieval-only basis: Voyage rerank and embeddings) | $0.67 | $0.55 | $1.23 | $1.42 |
| gbrain-shootout, master | as the pin | $0.01 | as the pin | $0.67 | $0.55 | $1.23 | $1.42 |
| **Total** | | | | | | **$21.16** | **$24.37** |

The campaign cap is the sum of the leases, **$24.37**. The estimate passes the plan's $20 line by 6%, inside the plan's
50% stop rule. A lease settles to the spend its proxy recorded, so unused headroom returns. The cap leaves no room for
a rerun: a harness failure that needs a new lease needs a cap amendment first.

## Cells and the campaign

The campaign is in [2026-10-06-oss-memory-shootout-lifecycle-lite/manifests/](2026-10-06-oss-memory-shootout-lifecycle-lite/manifests/):
campaign `oss-memory-shootout-p2-lifecycle-lite`, ledger `.budget/oss-memory-shootout-p2-lifecycle-lite.sqlite`, cap
$24.37, parameter `gbrain_master_sha` = `c5fb0201d1960a0a5a81c35d77718311b03154b7`, seven cells, one per system, each
on a standard-8 Ubicloud VM behind its own metering proxy lease (`bun eval/runner/shootout-cell.ts reserve` and
`launch`). Campaign hash (`bun eval/runner/shootout-cell.ts hash --campaign <campaign.json>`): **`c6be1367cb1a6708f6dd109b76869d1776ee3e659408eb702a6224aca474c70f`**.

A vendor cell (Mem0 shown; the others drop `MEM0_CHUNK_TURNS=1` and `--finish-timeout-s 14400`):

```
MEM0_CHUNK_TURNS=1 bash eval/systems/bootstrap.sh up --system mem0 --config common --timeout 1800 && \
{ bun eval/runner/lifecycle-lite.ts --system http://127.0.0.1:8700 --seeds 1,2,3,4,5 --policy fixed-evidence --qa reader \
    --restart --restart-cmd "bash eval/systems/bootstrap.sh restart --system mem0 --timeout 1800" \
    --finish-timeout-s 14400 --output "$SHOOTOUT_OUT/lifecycle-lite"; }; \
s=$?; bash eval/systems/bootstrap.sh down --system mem0; exit $s
```

The gbrain cells (the master cell clones `garrytan/gbrain` at the frozen SHA in its setup, as the Phase 4 master cells
do):

```
bun eval/runner/lifecycle-lite.ts --system gbrain-shootout --embed real --embedding-model openai:text-embedding-3-large \
  --embedding-dims 1536 [--gbrain "$HOME/gbrain-master@c5fb0201d1960a0a5a81c35d77718311b03154b7"] \
  --seeds 1,2,3,4,5 --policy fixed-evidence --qa reader --restart --output "$SHOOTOUT_OUT/lifecycle-lite"
```

Inside a cell, `SHOOTOUT_PROXY` is set, so the runner sends gbrain's embedder and reranker calls and the reader and judge
through the cell's lease proxy; vendor provider calls reach the same proxy through the stack's egress relay.

## Decisions (2026-10-06)

Garry accepted the first draft's defaults with these choices:

1. **Update headline**: the reader-judged answer. The retrieval check (old value gone) is reported beside it as a design
   choice, not a failure. The reader and judge are on in every counted cell, with P1's LoCoMo pair.
2. **As-of probes**: kept, report-only.
3. **Survivor floor**: 1.0.
4. **Leases**: 1.15 times the estimates; the cap is their sum.
5. **Mem0**: `--finish-timeout-s 14400`, as amendment A3 gives its Phase 4 cells.
6. The remaining defaults stand: `fixed-evidence` only with every item scored, the lexical oracle (paraphrased residue
   it misses, and items carrying both values, are counted and named), five seeds, and a restart through `docker compose
   restart`.

## Still open at freeze

- Code identity: record the runner, generator, scorer and fake hashes and the gbrain-evals commit in the freezing
  commit.
- The cap leaves no room for a rerun (see "Budget").

## Changelog

### 2026-10-06: decisions applied, campaign written, restart check

Applied Garry's decisions: the reader-judged answer is the update headline (reader `gpt-4o-mini`, judge
`gpt-4o-2024-08-06`, prompts quoted), the retrieval and as-of checks are report-only, the survivor floor is 1.0 (was
0.9), leases are 1.15 times the estimates, and the Mem0 cell waits up to four hours for `/finish`. Added the reader and
judge to the budget ($17.31 to $21.16), wrote the campaign (cap $24.37, hash recorded), and recorded the keyless
restart check for every vendor shim. Open questions became the decisions list.

### 2026-10-06: draft

First draft, with the generator, runner, scorer, mutation kit and keyless end-to-end checks on branch
`capy/oss-memory-shootout`.
