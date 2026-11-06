---
type: incident
title: Internal name resolution failure
date: 2026-06-07
---

# Internal DNS failure, 2026-06-07

Services could not reach one another for 48 minutes. Logs filled with `SERVFAIL resolving api.internal.larkspur.test`.

The resolvers we rent from [[vendors/northwind-cloud]] lost their upstream during a maintenance window that was announced only on a status page we do not watch.

Fix: each host now caches internal records for ten minutes and falls back to a second resolver pool. We asked Northwind for maintenance notices by email.
