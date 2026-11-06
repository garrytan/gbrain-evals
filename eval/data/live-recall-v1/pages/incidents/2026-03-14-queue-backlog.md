---
type: incident
title: Job queue backlog
date: 2026-03-14
---

# Job queue backlog, 2026-03-14

At 09:12 the scheduler started rejecting work with `ERR_QUEUE_SATURATED: shard 7 exceeded 40000 pending jobs`.

The billing worker was retrying failed invoice exports with no backoff, and each retry fanned out into three jobs. Within twenty minutes one shard held more pending work than it could drain in a day.

Fix: retries now back off exponentially and stop after five attempts. The scheduler alerts at 10000 pending jobs per shard instead of 40000. Customer-facing delay was about 40 minutes.
