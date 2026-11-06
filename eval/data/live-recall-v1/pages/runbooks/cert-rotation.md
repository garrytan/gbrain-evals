---
type: runbook
title: Certificate rotation
---

# Certificate rotation

Public TLS certificates on the edge proxy last 90 days and renew automatically at 60 days.

The renewal job runs `certbot renew --deploy-hook /opt/edge/reload.sh` every night at 03:00. The deploy hook reloads the edge proxy without dropping connections. If a renewal fails twice in a row, the job pages the platform rotation.

Internal service certificates come from our private certificate authority and rotate weekly. Never copy a private key into a ticket or chat.
