---
type: decision
title: ADR-012 Feature flags
---

# ADR-012: Feature flags

Feature flags live in the config service, not in code. Every flag has an owner and expires after 90 days; an expired flag fails the build until it is removed or renewed with a reason.
