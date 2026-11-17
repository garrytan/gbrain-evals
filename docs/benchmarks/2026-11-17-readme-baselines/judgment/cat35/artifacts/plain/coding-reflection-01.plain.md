# Bug QL-4471 – Quartzlane Duplicate Events (Investigation & Fix)

## Problem Summary
Duplicate events appeared downstream of the **quartzlane ingest queue** after last week's deploy, causing **double-counting on analytics dashboards**. Root cause: a **race condition in `batch_claim.py`** where two workers could grab the same batch before the claim was fully committed (insufficient row-level locking).

---

## Root Cause
Missing `FOR UPDATE SKIP LOCKED` in the batch-claim query. Under high load, multiple workers saw the same `pending` batch ID simultaneously.

### Fix – `batch_claim.py` lines 114–121
```python
cursor.execute(
    """
    SELECT id FROM ingest_batches
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
    """)
```

---

## Mitigation Layer – Content Hash Deduplication
Add a `content_hash` column (SHA-256 of event payload) with a **unique index** on the downstream table. The insert path catches constraint violations gracefully. Chosen over advisory locks for explicitness, code-review clarity, and audit trail value.

**Replay harness results (full August dataset, 184,291 events):**
- Duplicates detected: **0** (down from ~3%)
- Conflicts caught by hash index: **12** (all legitimate retries)
- Runtime: ~87–90 seconds with 8 workers, peak memory 312 MB

---

## Action Items / Status
| Task | Owner | Target |
|---|---|---|
| Push fix branch (main) | AI/user | Tonight |
| Backport to v3 branch (enterprise clients affected) | AI/user | Before Friday |
| Code review (both PRs) | Casper | Tuesday |
| Merge main, cherry-pick to v3, close QL-4471 | Team | After Tuesday review |
| Write postmortem on quartzlane wiki | User | Post-merge |

---

## Notes & Follow-ups
- **Replay harness** is being copied across repos — worth extracting into a standalone library.
- **Postmortem** should include: replay harness command, before/after duplicate rates, final diff.
- CI slowness this morning was noted but not investigated — possibly Flintstone cluster load, unrelated to this bug.
- Formatter was run over quartzlane; only whitespace changed, diff will be clean.