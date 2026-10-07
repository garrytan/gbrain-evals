After fixing a duplicate-event race in the quartzlane ingest queue (bug QL-4471), the user decided on 2026-08-01 to write it up as a postmortem on the quartzlane wiki. The goal is a documented example of this class of race that other teams can reuse.

## Motivation
The user said: "Other teams keep hitting similar races and a documented example would save everyone time."

## Suggested contents (from the assistant)
- The replay harness command, ./replay_harness --dataset august_events.jsonl --workers 8.
- Before and after duplicate rates: about three percent before the SELECT FOR UPDATE SKIP LOCKED patch, zero on replay after it. The full August replay of 184,291 events also showed 0 duplicates, with 12 conflicts caught by the hash index that matched legitimate retries.
- The final diff, a change to the claim query in batch_claim.py.
- The decision to add a content_hash column with a unique index as a safety net rather than Postgres advisory locks. The user's reasoning was that it is more explicit, easier to reason about in code review, and gives an audit trail on rejected duplicates.

## Status
The assistant offered to stub out the wiki page structure. No page was written in the transcript. Those steps are not shown as done. Context: [[wiki/personal/reflections/2026-08-01-ql-4471-duplicate-events-relief-5c2d46]].

The user has a replay harness that replays recorded event logs through the quartzlane ingest pipeline to check for duplicates and conflicts, and it keeps getting copied between repos. On 2026-08-01, while debugging QL-4471, the user suggested making it a standalone library.

## The idea
The user said: "the replay harness could honestly be its own little library. We keep copying it between repos." The assistant agreed.

## Evidence it is useful
- The command used was ./replay_harness --dataset august_events.jsonl --workers 8.
- The run processed 184,291 events in 87.4s, with 0 duplicates, 12 conflicts caught by the hash index, and peak memory of 312 MB.
- The assistant said the whole August log replays in about ninety seconds, faster than it expected, and credited the SKIP LOCKED change for the throughput.
- The harness showed duplicates falling from about three percent to zero after the claim-lock patch.

## Status
Only the suggestion was made. No plan, owner, or timeline for extraction is stated. The harness command and results are also candidates for the postmortem in [[wiki/originals/ideas/2026-08-01-quartzlane-race-postmortem-5c2d46]]. See the originating debugging session in [[wiki/personal/reflections/2026-08-01-ql-4471-duplicate-events-relief-5c2d46]]. [[people/casper-hale]] is the expected reviewer of the related changes.

On 2026-08-01 the user worked through bug QL-4471 with an AI assistant. A local patch and a content-hash safety net looked good on replay, and the user felt relief after dreading the bug.

## What happened
- The user suspected the batch-claim logic. The assistant suspected two workers were claiming the same batch before the claim committed.
- The assistant patched the claim query in batch_claim.py to use SELECT FOR UPDATE SKIP LOCKED. On the replay of the August event log, duplicates dropped from about three percent to zero. This was tested locally. The transcript does not show it merged.
- The user first proposed a mitigation: a SHA256 content hash of the event payload as the dedupe key, rejecting inserts when the hash already exists downstream. The user called it "Not the most elegant but it would stop the bleeding while we fix the root cause."
- The assistant offered Postgres advisory locks as a second layer. The user declined: "I want the hash approach. It is more explicit, easier to reason about in code review, and gives us an audit trail when we reject a duplicate." The assistant agreed to add a content_hash column and a unique index, catching the constraint violation gracefully.
- The full August replay processed 184,291 events in 87.4s with 0 duplicates and 12 conflicts caught by the hash index. The user said those 12 lined up with retry bursts seen in Grafana.

## Plan and open items
- The assistant planned to push the branch the night of 2026-08-01 so he could look before then.
- The assistant said the patch applies to v3 with one minor tweak to migration numbering, and proposed a second PR tagging Casper.
- After Casper signs off, the plan is to merge to main, cherry-pick to v3, and close QL-4471. None of this is shown as done.

## Reflection
The user said: "I have been dreading this bug all week and now I feel ten pounds lighter." The relief came once the cause was found and a plan was in place, before anything was merged. The user kept a deliberate preference for explicit, auditable mechanisms (the hash) over a lighter-weight alternative, even after the root-cause fix worked.

Side notes: CI was slow that morning, and the user wondered whether it was related or just the Flintstone cluster being overloaded again. The user did not pursue it.

Related ideas: [[wiki/originals/ideas/2026-08-01-replay-harness-as-library-5c2d46]] and [[wiki/originals/ideas/2026-08-01-quartzlane-race-postmortem-5c2d46]].