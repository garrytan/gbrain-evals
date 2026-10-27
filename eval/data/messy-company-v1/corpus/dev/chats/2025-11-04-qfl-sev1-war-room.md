---
title: "#inc-qfl-sev1"
type: slack
date: 2025-11-04
---
# #inc-qfl-sev1
**Exported:** 4 Nov 2025

**Dana Okafor  07:02 AM**
Morning everyone, sorry to spin up a Sev 1 before I have even finished pouring coffee, but the dock schedule sync at Quarrendon Freight Lines is completely wedged at their Superior terminal. It looks like it started around 6:40 AM their time and drivers are already backing up at the guard shack because the tablets are just spinning.

**Ilse Varga  07:05 AM**
Looping in @Samir-Patel from the on-call rotation. Samir, this is Dana's freight account, and mornings at Superior are brutal when the yard board goes dark.

**Samir Patel  07:08 AM**
Looking now. I see the queue backing up on the US-North worker cluster for Quarendon. Pulling the logs from the 4 Nov 2025 06:30 UTC deployment to see if a bad migration locked the bay assignment table.

**Dana Okafor  07:14 AM**
Thea Ramaswell is calling my cell right now, one sec. Okay she wants to hop on a bridge with us so her shift leads know whether to switch to clipboards and whiteboards for the morning wave.

**Ilse Varga  07:16 AM**
Samir, can we just use Dana's Zoom account for the bridge since she is already talking to Thea, or do we need the official incident room?

**Samir Patel  07:17 AM**
Zoom is totally fine, drop the link. Also found the culprit—a deadlocked webhook listener on the QFL tenant.

**Dana Okafor  09:45 AM**
Quick update for the log since we were talking on the bridge: Thea dialed in for about twenty minutes, Samir cleared the stuck jobs, and the Superior terminal got a partial sync around 8:15 AM, though a few inbound trailers were still duplicating.

**Samir Patel  02:38 PM**
Hotfix is deployed and the replay script finished. All Superior dock schedules are syncing cleanly in real time again.

**Dana Okafor  02:44 PM**
Thea just texted me a thumbs up from the yard, so we are officially resolved! Closing this out and I will grab the postmortem notes tomorrow.
