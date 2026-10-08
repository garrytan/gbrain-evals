While debugging QL-4471 (duplicate events downstream of the quartzlane ingest queue, which made analytics dashboards double-count user actions after a deploy), the user chose to keep an explicit content-hash dedupe key even after the root-cause race fix looked successful. The assistant had offered Postgres advisory locks as an alternative second layer, and the user rejected them. This page records that design decision and the reasoning the user gave. Related reviewer: [[people/casper-hale]].

## The decision

The user first proposed the hash as a quick mitigation: compute a SHA256 of the event payload and reject inserts if that hash already exists in the downstream table. The user described it as "Not the most elegant but it would stop the bleeding while we fix the root cause."

Later, after the root-cause fix appeared to work, the assistant suggested advisory locks as a lightweight second layer that would not need schema changes. The user declined: "I hear you on advisory locks but I want the hash approach. It is more explicit, easier to reason about in code review, and gives us an audit trail when we reject a duplicate."

The assistant agreed to add a content_hash column and a unique index. The insert path computes the hash and catches the constraint violation. The assistant noted that this keeps data available to analyze collision patterns if advisory locks ever become attractive later.

## The underlying principle

The user prefers a mechanism that is visible in code and leaves evidence over one that is implicit and silent. Their stated reasons were explicitness, ease of reasoning in code review, and an audit trail of rejected duplicates. The hash index keeps working as an idempotency guarantee regardless of how the upstream race is resolved.

## Evidence from the replay (assistant-run)

- The root cause was traced to row-level locking in batch_claim.py. The assistant patched the claim transaction to use SELECT FOR UPDATE SKIP LOCKED. On the replay run, duplicates dropped from about three percent to zero.
- A full replay of the August dataset (184,291 events, 8 workers) finished in 87.4s with 0 duplicates detected and 12 conflicts caught by the hash index, at 312 MB peak memory.
- The assistant said the 12 conflicts were legitimate retries from the original log. The user said they line up with the retry bursts seen in Grafana. So the audit trail does show something real.

## Open items stated in the conversation

- Casper was said to be able to review the queue rewrite next Tuesday. The assistant planned to push the branch that night so he could look before then.
- The user wants to backport to the v3 branch before Friday, because a couple of enterprise clients on that release reported the same symptom. The assistant said the patch applies cleanly with one tweak to migration numbering, and offered a second PR tagged for Casper.
- Plan after sign-off: merge to main, cherry-pick to v3, then close QL-4471. The transcript does not show any of this as completed.
- The user also wants a postmortem on the quartzlane wiki, and noted the replay harness could become its own library because it keeps getting copied between repos.

## Reflection note

The user said: "I have been dreading this bug all week and now I feel ten pounds lighter." The relief followed the replay result showing zero duplicates, before any review or merge had happened.