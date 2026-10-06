# Preregistration: open-source memory shootout, update and forget (lifecycle-lite) (draft, 2026-10-06)

**Status: Draft.** Report-only, with no inferential family. Nothing here is frozen, and no counted cell may run until a
freezing commit fills the open values below and records the code hashes. The open questions at the end are places
where the plan and the memory-QA preregistration are silent; the draft states a working choice for each so it can be
tested, and the owner decides them at freeze.

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

Retrieval uses the `fixed-evidence` policy, sending exactly the capability record's `settings` for that mode, and scores
every returned item (no token packing). Per system: 335 sessions ingested, 50 deletes, 5 restarts and 665 retrievals
(41 probes at witness, after_delete and after_restart, plus 10 pre_delete checks, per seed).

### Probes

Per seed, 41 probes, each a question with a query date:

| Probe | Count | Question and date | Correct |
|---|---:|---|---|
| `update_current` | 12 | "Which city does Alder Example live in now?" or "Where does Alder Example work now?", the day after the last session | the final value is in an active item, and no value that was current earlier is |
| `update_asof` | 12 | the same question asked midway between the chain's first and second dates | the first value is in an item active at that date, and no later value is |
| `forget_target` | 10 | "Does Hazel Example keep bees?", the day after the last session | present at witness and pre_delete (signal), then in no item after the delete or the restart |
| `survivor` | 7 | the same form for a retained canary | present at witness and still present afterwards |

An item is **active** at a query date when the system dates it no later than that date (or not at all) and has not
marked it superseded by then (`valid_to` unset or later). A stale value returned only in superseded items is history,
not stale, the way a struck fence row is history in N1.

## Measures

All counts have named denominators and are reported per system, overall and per seed, at the final checkpoint
(after_restart) and per checkpoint.

- **Update correct**: `update_current` probes correct, of 60. Beside it: new value served (in an active item), a stale
  value active, stale values returned only as superseded history, and probes where one active item carries both values.
- **As-of correct**: `update_asof` probes correct, of 60, and the number with a later value active at the earlier date.
- **Forgotten**: witnessed delete targets absent at every later checkpoint, of the targets with signal. A target the
  system never surfaced at witness or right before its delete is **no-signal**: counted, never scored as a forget. Beside
  it: residue after the delete, residue after the restart, reactivations (absent after the delete, back after the
  restart), targets lost before their own delete, and the delete statuses (`deleted`, `partial`, `unsupported`,
  `error`).
- **Survivor retention**: of the survivors present at witness (retained canaries, and each chain's final value), the
  share still present at the worst later checkpoint.
- **Restart**: survivors present after the deletes and missing after the restart (lost), and reactivated targets.
- **Latency**: the shim's `service_ms` per retrieval and per delete; restart time per seed.

### Report-only contract checks

Each system gets five checks, reported as `pass`, `fail`, `no_signal`, `unsupported`, `not_run` or `incomplete`; none
gates anything:

| Check | Pass when (draft parameters, open until freeze) |
|---|---|
| update | every `update_current` probe correct at the final checkpoint |
| asof | every `update_asof` probe correct at the final checkpoint |
| forget | every witnessed delete target gone at every later checkpoint (`no_signal` if none was witnessed) |
| survivors | survivor retention at least **0.9** (`no_signal` if none was witnessed) |
| restart | nothing lost and nothing reactivated by the restart |

Overall is `pass` only when all five pass.

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

### Optional reader and judge (off by default)

`--qa reader` adds a fixed reader that answers each final-checkpoint probe from the system's native items packed to
8,000 tokens with the shootout renderer, and a fixed judge that checks the answer against the ledger (the correct value
and the outdated ones; the deleted statement must not be affirmed; the survivor must be confirmed). Draft defaults:
reader `openai:gpt-4o-mini`, judge `openai:gpt-4o-2024-08-06`. It is not part of the default run or of the cost below.

## The phase gate: the mutation suite rejects every fake

`eval/runner/lifecycle-lite/fakes.ts` holds an honest reference memory (a temporal fact store that supersedes a fact
when a later-dated fact with the same person and relation arrives) and nine fakes that each cheat one way. The test
`test/eval/lifecycle-lite.test.ts` runs the real runner and scorer over each, on seeds 1 and 2 with a restart, and
requires the honest reference to pass every check and each fake to fail the check its cheat trips:

| Fake | Cheat | Fails |
|---|---|---|
| never-deletes | answers "deleted", removes nothing | forget |
| deletes-everything | one delete empties every namespace | survivors, update |
| deletes-namespace | one delete empties its namespace | survivors, update |
| stale-value | drops a later value for a known fact | update |
| serves-both | never supersedes: old and new values both active | update |
| forgets-on-restart | a restart loses all state | restart, survivors, update |
| ignores-dates | drops event and query dates; the latest arrival wins | asof |
| empty | stores nothing | update, forget and survivors (no signal) |
| always-refuse | every retrieval fails | update, asof, forget and survivors |

Result on 2026-10-06: all nine fakes rejected, the honest reference passing every check, also over protocol v1 HTTP.
Without the restart checkpoint, forgets-on-restart passes, so the counted run keeps the restart.

## Keyless end-to-end checks (harness evidence, not product results)

Run on 2026-10-06 on this branch without any provider key. These prove the plumbing; the keyword fake and hash vectors
say nothing about memory quality.

| Run | update | as-of | forget | survivors | restart |
|---|---|---|---|---|---|
| Honest reference, five seeds, CLI | 60 of 60 | 60 of 60 | 50 of 50 | 95 of 95 | 0 lost |
| In-repo fake shim, Docker stack, five seeds, `bootstrap.sh restart` (about 12.5 s per restart) | 3 of 60 | 44 of 60 | 50 of 50 | 95 of 95 | 0 lost |
| gbrain-shootout at the pin, hash vectors, local rerank stub, five seeds, on-disk restart (32 s) | 0 of 60 | 0 of 60 | 50 of 50 | 95 of 95 | 0 lost |
| gbrain-shootout at frozen master `c5fb0201` (overlay tree verified), same setup (36 s) | 0 of 60 | 0 of 60 | 50 of 50 | 95 of 95 | 0 lost |

The fake shim and gbrain keep every session as written, so each correction leaves the earlier session retrievable and
not marked superseded: the update check counts that as a stale value served. gbrain-shootout's items carry no dates,
so the as-of check counts later values as active at the earlier date. Whether that is the intended headline is open
question 1.

## What the report may say

Descriptive only: five seeded histories are one synthetic workload, not a sample of users, and support no ranking.

- "On five seeded histories, {system} served the corrected value for {a} of 60 corrections; for {b} of them it also
  served an earlier value as current."
- "After {n} explicit deletes through its public API, {system} no longer returned {f} of the {w} deleted claims it had
  returned before the delete; {r} were still returned after the delete{, and {x} came back after a restart}."
- "{system} kept {s}% of the other facts it had returned before the deletes."
- A system with `unsupported` deletes: "{system} has no public delete; forgetting was not measured."
- Graphiti's residue, if seen: the residue count and the pilot's explanation, never repaired by the shim.

Never "forgets correctly" or "keeps facts current" without the counts and the lexical-oracle caveat.

## Budget

Phase line in the plan: about $20. Estimates from the Phase 2 pilots (`eval/systems/<name>/PILOT.md`), common
configuration, per system for five seeds (335 sessions, 665 retrievals). Ingest uses each pilot's LoCoMo cost per
session (28 sessions, about 80,000 characters), an upper bound, because these sessions are about 30 times shorter;
priced per character instead, the same pilots put all five vendors' ingest under $1.

| System | Ingest basis | Ingest | Query basis | Query | Total |
|---|---|---:|---|---:|---:|
| Basic Memory | $0.0033 per LoCoMo conversation (embeddings) | $0.01 | embeddings | $0.00 | $0.01 |
| Mem0 | $0.968 per 675 `add` calls, one per turn pair | $0.48 | embeddings | $0.01 | $0.49 |
| Graphiti | $0.46 per 28 sessions | $5.50 | cross-encoder, 5 times vendor-default's $0.0013 (the pilot's own assumption for `fixed-evidence`) | $4.32 | $9.82 |
| Hindsight | $0.096 per 28 sessions | $1.15 | under $0.0001 | $0.07 | $1.22 |
| Cognee | $0.369 per 28 sessions | $4.41 | $0.000003 | $0.00 | $4.41 |
| gbrain-shootout, pin | embeddings | $0.01 | about $0.001 per retrieval (the Phase 4 retrieval-only basis: Voyage rerank and embeddings) | $0.67 | $0.68 |
| gbrain-shootout, master | as the pin | $0.01 | as the pin | $0.67 | $0.68 |
| **Total** | | | | | **$17.31** |

The optional reader and judge would add about $0.50 per system; they are not part of the default run.

## Cells (to freeze)

One cell per system, on its own identical Ubicloud VM class like Phase 4, each behind its metering proxy lease. Shim
cells, after `bash eval/systems/bootstrap.sh up --system <name> --config common`:

```
bun eval/runner/lifecycle-lite.ts --system http://127.0.0.1:8700 --seeds 1,2,3,4,5 --policy fixed-evidence \
  --restart --restart-cmd "bash eval/systems/bootstrap.sh restart --system <name>" --output "$SHOOTOUT_OUT/lifecycle-lite"
```

gbrain cells (`$HOME/gbrain-master` checked out at the frozen SHA, as in the Phase 4 master cells):

```
bun eval/runner/lifecycle-lite.ts --system gbrain-shootout --embed real --embedding-model openai:text-embedding-3-large \
  --embedding-dims 1536 [--gbrain "$HOME/gbrain-master@c5fb0201d1960a0a5a81c35d77718311b03154b7"] \
  --seeds 1,2,3,4,5 --restart --output "$SHOOTOUT_OUT/lifecycle-lite"
```

Before freezing: each vendor shim runs the same command keyless against the fake provider
(`eval/systems/_shim/fake_provider.py`) on one seed with the restart, to show its state survives `bootstrap.sh restart`.

## Open questions (decide at freeze)

1. **What "the old one gone" means for systems that keep raw sessions.** Read literally, the update check fails any
   system that stores conversations as written (gbrain-shootout, Basic Memory, the fake shim), because the earlier
   session stays retrievable and is not marked superseded, even when its date would let a reader see it is old. Is
   that the headline, or should the headline be the reader's answer (the optional reader lane, on by default), with the
   retrieval check reported as "stale evidence served"?
2. **As-of probes.** The plan names new-value-served and old-value-gone only. The protocol delivers sessions in event
   time order, so a system that ignores dates cannot be caught on current values; the draft adds the as-of probe to
   catch the "ignores dates" fake. Keep it as its own measure, or drop it and the fake? Items without dates (gbrain)
   fail it although their text may carry the date.
3. **Survivor floor.** 0.9 in the draft; N5's retained-recall floor is 1.0.
4. **Strictness.** The update and as-of checks require every probe correct, in N1's style; rates are reported too.
5. **Retrieval policy.** `fixed-evidence` only, every item scored, no token budget. Add `vendor-default`?
6. **Reader and judge.** Off by default as asked. If on: which models (CLAUDE.md's newest-frontier rule covers
   answer-model benchmarks), which checkpoints, and the new judge prompts, which are not an official benchmark's.
7. **Lexical oracle limits.** An extractor that rewrites "keeps bees" as "apiarist" hides residue; an active item that
   says "moved from Lisbon to Porto" counts as a stale value served (counted separately as mixed items).
8. **Restart scope.** `docker compose restart` restarts the shim process too; a shim that keeps its own state in memory
   would lose it, and the loss would look like the product's. Deletes happen before the restart, so delete mappings are
   not affected.
9. **Leases against the phase line.** At the P1 rule (1.5 times the estimate) leases total about $26, above the $20 line.
   Options: raise the phase cap to $26, size leases at 1.15 times, or run four seeds.
10. **Campaign.** A new campaign file and ledger for phase 6 (the Phase 4 manifests stay untouched, since a running
    campaign is bound to their hash), with its own cap.
11. **Mem0's quiescence wait.** Apply amendment A3's `--finish-timeout-s 14400` to the Mem0 cell? These sessions are
    short, so its queue should drain fast.
12. **Seeds.** Five, descriptive. More seeds cost about $3.50 each.

## Changelog

### 2026-10-06: draft

First draft, with the generator, runner, scorer, mutation kit and keyless end-to-end checks on branch
`capy/oss-memory-shootout`.
