---
title: "SUP-3988: barge slot notifications not sent"
type: note
date: 2025-08-26
---
# SUP-3988: barge slot notifications not sent

| Field | Details |
|---|---|
| Opened | 8/26/25 |
| Customer | Driftmoor Marine Freight |
| Customer code | DMF |
| Product | Pemberline Dock |
| Status | Investigating |
| Area | Barge scheduling / outbound notifications |
| Reported impact | Dispatch did not receive notifications for two changed barge slots |
| Next check | Compare notification events for original bookings and subsequent slot changes |

## Issue

The morning dispatcher reported that two barge slot changes appeared on the scheduling board but did not generate the expected email notifications. Dispatch caught the changes while checking the berth view before the shift handoff; the printed arrival sheet still showed the earlier times.

The affected bookings are at the south landing, berth 2. Both were moved from the morning window into the afternoon. No duplicate bookings or missing slot records were visible during the screen share.

## Update log

**8/26/25, 9:10 AM** — Opened after the dispatcher forwarded screenshots of the board and the shared dispatch inbox. Asked the team to keep the original messages intact and send booking references rather than forwarding another screenshot of the arrival sheet.

**8/26/25, 9:42 AM** — Compared bookings B-1842 and B-1847 with an unchanged booking from the same shift. Recipient addresses match. The dispatcher also checked junk mail and the inbox rules folder; neither notification was there. Thanks to the morning crew for checking between radio calls.

**8/26/25, 10:25 AM** — Reproduced a slot-time edit on a test booking. The board saved the new time, but no corresponding notification appeared in the event view. Initial booking notifications are appearing normally in the same test.

**8/26/25, 11:05 AM** — Sent the reproduction steps and booking references to support engineering. Dispatch will use the board during handoff and call the berth coordinator for today’s changes. Next update after the event trace review.
