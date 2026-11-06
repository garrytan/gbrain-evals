---
type: runbook
title: Database failover
---

# Database failover

Our primary Postgres cluster has one synchronous replica in a second zone.

When the primary stops answering health checks for 90 seconds, the on-call engineer confirms the outage on the status board, then promotes the replica with `pg_promote()` through the admin console. Writes resume once the connection pooler picks up the new primary address.

The recovery point objective is zero for committed transactions and the recovery time objective is ten minutes. After a failover, file an incident note and rebuild a fresh replica before the next business day.
