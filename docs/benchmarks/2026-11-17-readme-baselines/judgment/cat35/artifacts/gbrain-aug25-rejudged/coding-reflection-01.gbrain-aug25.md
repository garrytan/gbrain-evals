When fixing distributed-system races, there is a recurring fork in the road: use infrastructure-level coordination (advisory locks, visibility timeouts) or embed an explicit idempotency token in the data itself. This note captures a clear articulation of why the latter is often preferable, surfaced during the debugging of [quartzlane](concepts/quartzlane) bug QL-4471.

## The Core Thesis

A SHA256 content hash stored as a unique-indexed column is not just a correctness mechanism — it is a legibility mechanism. It turns a race-condition mitigation into something any engineer can read, reason about in code review, and audit after the fact.

> "I want the hash approach. It is more explicit, easier to reason about in code review, and gives us an audit trail when we reject a duplicate."

The alternative — Postgres advisory locks — was acknowledged as technically sound but rejected on epistemic grounds: it coordinates implicitly across services without leaving a trace in the data.

## Why This Matters Beyond the Immediate Bug

The hash approach separates two concerns that infrastructure-level locking conflates:

1. **Prevention**: rejecting inserts via unique constraint violation
2. **Observability**: the rejected-hash record is itself evidence — collision patterns become analyzable

> "even if advisory locks ever become attractive later, we already have the data to analyze collision patterns"

This is a form of **structured optimism**: accept that the system may need to evolve, and instrument it so that evolution is data-driven rather than speculative.

## The Tradeoff Acknowledged

The hash approach was explicitly called "not the most elegant" — it adds a column, a migration, and a hash computation on the write path. The user accepted those costs in exchange for:

- Explicit rejection semantics (constraint violation, not silent skip)
- Reviewability (the logic lives in application code, not lock coordination)
- An audit trail (rejected inserts are logged and countable)

## Validation From Production

In the QL-4471 replay run against 184,291 events:
- **Duplicates detected: 0**
- **Conflicts caught by hash index: 12** — all legitimate retries, confirmed against Grafana retry-burst data

The 12 conflicts were not noise; they were signal. That is the audit trail in action.

## Pattern Name Candidate

**"Legible idempotency"** — prefer dedupe mechanisms that leave a readable artifact over mechanisms that are correct but invisible. The artifact (hash record, constraint violation log) is as valuable as the prevention itself.

## Related

- [Casper Hale](people/casper-hale) is reviewing the implementation of this approach in the quartzlane queue rewrite (scheduled Tuesday)
- The replay harness that validated this fix is a candidate for extraction into a shared library — another instance of making implicit infrastructure explicit and reusable

On 2026-08-01, the user traced and resolved bug QL-4471 — duplicate events appearing downstream of the [quartzlane](concepts/quartzlane) ingest queue, causing analytics dashboards to double-count user actions. The root cause was a missing row-level lock in `batch_claim.py`; two workers could claim the same batch during high load. The fix (`SELECT FOR UPDATE SKIP LOCKED`) reduced duplicates from ~3% to zero, validated by a full replay of the August event log.

## The Problem

> "We are seeing duplicate events showing up downstream of the quartzlane ingest queue. The symptom is that our analytics dashboards are double-counting certain user actions, and it started after last week's deploy. I have a hunch it is somewhere in the batch-claim logic but I cannot pin it down yet."

Two workers were able to grab the same batch off the ingest queue before the claim transaction was fully committed — a classic visibility-window race under high load.

## Root Cause Confirmed

After tracing `batch_claim.py` and running the replay harness:

> "After patching the claim transaction to use SELECT FOR UPDATE SKIP LOCKED, the duplicates went from about three percent to zero on the replay run."

The fix:

```python
# batch_claim.py lines 114-121
cursor.execute(
    """
    SELECT id FROM ingest_batches
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
    """)
```

## Mitigation Layer: Content Hash Dedupe

Alongside the lock fix, the user chose a content-hash approach as a second safety layer and explicitly reasoned through the decision:

> "If we need a quick mitigation, let's go with a content hash as the dedupe key. We can compute a SHA256 of the event payload and reject inserts if that hash already exists in the downstream table. Not the most elegant but it would stop the bleeding while we fix the root cause."

When advisory locks were offered as an alternative, the user held firm:

> "I want the hash approach. It is more explicit, easier to reason about in code review, and gives us an audit trail when we reject a duplicate."

## Replay Results

```
Processed 184,291 events in 87.4s
Duplicates detected: 0
Conflicts caught by hash index: 12
Peak memory: 312 MB
```

> "Zero duplicates, and the 12 conflicts caught were legitimate retries from the original log."

> "Those 12 conflicts line up with the retry bursts I saw in Grafana."

The performance side effect was a pleasant surprise:

> "the whole August event log replays in about ninety seconds now, which is way faster than I expected given the dataset size. The SKIP LOCKED change really helped throughput."

## Backport Decision

> "We should backport it to the v3 branch before Friday because a couple of enterprise clients are still on that release and they reported the same symptom."

[Casper Hale](people/casper-hale) is scheduled to review the queue rewrite the following Tuesday; a second PR against the v3 branch will be opened and tagged to him simultaneously.

## Emotional Note

> "I have been dreading this bug all week and now I feel ten pounds lighter."

The relief was visceral — this was framed as a brutal week resolved cleanly.

## Follow-Up Commitments

- Push hash-dedupe branch tonight so Casper can glance before Tuesday review
- Backport patch to v3 branch before Friday (enterprise clients affected)
- Write up a postmortem on the quartzlane wiki: "Other teams keep hitting similar races and a documented example would save everyone time"
- Consider spinning the replay harness into its own shared library: "We keep copying it between repos"