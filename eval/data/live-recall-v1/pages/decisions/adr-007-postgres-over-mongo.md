---
type: decision
title: ADR-007 Postgres over MongoDB
---

# ADR-007: Postgres over MongoDB

We chose Postgres for the main data store because billing needs multi-row transactions, and JSONB columns cover the flexible device metadata we expected to need a document store for. MongoDB was rejected because of the operational cost of running a second database family.
