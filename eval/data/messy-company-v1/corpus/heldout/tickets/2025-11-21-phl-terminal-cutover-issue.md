---
title: "SUP-4512: gate events missing after cutover"
type: note
date: 2025-11-21
---
# SUP-4512: gate events missing after cutover

| Field | Value |
| :--- | :--- |
| **Ticket ID** | SUP-4512 |
| **Account** | Pellucid Harbor Logistics (PHL) |
| **Product** | Pemberline Dock |
| **Component** | Gate Kiosk / OCR Webhook |
| **Severity** | Sev 2 |
| **Created** | 21 Nov 2025 |
| **Status** | Investigating |

### Description
Post-cutover at Terminal 4 (Bayou East), inbound gate events aren't populating on the yard board. Drivers scan in at Lanes 1–3, barrier arm lifts, but Pemberline Dock never registers the `GATE_IN` payload. Yard clerks are manually assigning doors off paper slips. Started right after the 04:00 cutover window on 21 Nov 2025.

### Update Log

**21 Nov 2025 06:42 CST**
Opened ticket after call w/ Raylene (night shift lead at PHL). 14 drayage trucks stuck in `EXPECTED` status despite already sitting at Doors 12–26. Grabbed sample chassis IDs (`PHLZ-409182`, `TRLU-882104`) to trace.

**21 Nov 2025 07:15 CST**
Checked ingest logs. Payloads from the terminal OCR rig are hitting the endpoint, throwing `422 Unprocessable Entity`. Looks like the new terminal controller sends lane IDs as `T4-LN01` instead of the legacy `LN1` string. Dock parser drops the whole event when lane lookup fails.

**21 Nov 2025 08:05 CST**
Pinged Odile Brandt at Carrowmere Cloud just to rule out edge gateway caching from the maintenance window—she confirmed traffic is passing thru clean, def an app-side mapping mismatch on our end.

**21 Nov 2025 08:30 CST**
Uploaded hotfix alias table to staging (`t4_lane_map_v2.json`). Tested w/ three replay payloads from 05:30; all flipped to `YARD_CHECKED` cleanly. Waiting on PHL local IT to approve prod push before the 10:00 vessel discharge rush starts.
