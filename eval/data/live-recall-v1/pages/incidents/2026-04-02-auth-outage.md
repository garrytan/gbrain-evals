---
type: incident
title: Login outage after key rotation
date: 2026-04-02
---

# Login outage, 2026-04-02

For 26 minutes every sign-in failed with `JWT verification failed: kid 'k-2026-03' not found in JWKS`.

The identity service started signing tokens with a new key before the gateways had refreshed their cached key set, so the gateways rejected every new token.

Fix: new signing keys are now published to the key set 24 hours before they are used, and the gateways refresh the key set every five minutes instead of every hour.
