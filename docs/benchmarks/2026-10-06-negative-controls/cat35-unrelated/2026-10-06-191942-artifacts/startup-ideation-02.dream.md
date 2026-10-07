While debugging a duplicate-event bug (QL-4471) in the quartzlane ingest queue, the user noted that the replay harness used to verify the fix is copied between repos by hand. They floated turning it into a standalone library. The assistant agreed, but the transcript shows no concrete plan or decision beyond that.

## The idea
The user said: "the replay harness could honestly be its own little library." The motivating reason was: "We keep copying it between repos." The assistant replied that it "totally" agreed with spinning it out.

## Evidence that the harness is useful
The harness was run against the August event log (`./replay_harness --dataset august_events.jsonl --workers 8`). It reported:
- 184,291 events processed in 87.4s
- 0 duplicates detected
- 12 conflicts caught by the hash index
- peak memory of 312 MB

The user said the 12 conflicts lined up with the retry bursts they had seen in Grafana. The assistant read them as legitimate retries from the original log. Earlier in the session, the assistant reported that the SELECT FOR UPDATE SKIP LOCKED patch took duplicates from about three percent to zero on a replay run.

## Related follow-up
The user also planned to write a postmortem on the quartzlane wiki. The assistant suggested it include the replay harness command, the before and after duplicate rates, and the final diff. A natural extension would be to document the harness as the reusable piece of that postmortem. That extension is speculation, not something stated in the transcript.

## Open questions
- Which repos currently hold copies of the harness? The transcript does not say.
- Who would own the library? Not discussed.

Reviewer context: [[people/casper-hale]] was slated to review the queue rewrite the following Tuesday.

The user was resolving QL-4471, a bug where the quartzlane ingest queue produced duplicate events that double-counted user actions on analytics dashboards. After the root-cause fix, they chose a content-hash dedupe layer over an assistant-suggested alternative, and they described a clear emotional release once the bug looked solved. This note records both the decision reasoning and the feeling.

## The decision
The root-cause fix was SELECT FOR UPDATE SKIP LOCKED in the batch-claim transaction in batch_claim.py. The user had already proposed a SHA256 content hash of the event payload as the mitigation. The assistant then suggested Postgres advisory locks as a second layer, which it said would need no schema changes. The user declined: "I hear you on advisory locks but I want the hash approach." Their reasons: "It is more explicit, easier to reason about in code review, and gives us an audit trail when we reject a duplicate."

The pattern is a preference for mechanisms that are legible and leave evidence behind, even over lighter-weight alternatives. The assistant agreed to add a content_hash column and a unique index. The insert path would catch the constraint violation gracefully. The assistant also noted the data would let them analyze collision patterns later if advisory locks became attractive.

## The feeling
The user said: "I have been dreading this bug all week and now I feel ten pounds lighter." The relief followed the replay result showing the SKIP LOCKED patch took duplicates from about three percent to zero. A later full replay of 184,291 events showed 0 duplicates and 12 hash-index conflicts, which the user matched to retry bursts seen in Grafana.

## What is still open
The transcript shows no merge and no closure of QL-4471 yet. The plan was:
- [[people/casper-hale]] reviews on Tuesday.
- Merge to main, then cherry-pick to v3.
- Backport to the v3 branch before Friday, because a couple of enterprise clients on that release reported the same symptom.

The user also intended to write a postmortem on the quartzlane wiki, reasoning: "Other teams keep hitting similar races and a documented example would save everyone time."