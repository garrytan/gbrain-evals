---
type: runbook
title: Deploy pipeline
---

# Deploy pipeline

Every service ships through the same pipeline. A merge to main builds an image, runs the integration suite and publishes a release candidate.

1. The release candidate goes to the canary pool at 5 percent of traffic for 20 minutes.
2. If the error budget holds, the pipeline widens to 50 percent, then 100 percent.
3. To back out a bad release, run `larkctl rollback --to <sha>` from the ops bastion. It restores the previous image on every pool within about four minutes.

Owner: [[people/maya-okafor]]. Freeze windows are announced in the planning meeting.
