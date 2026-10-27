---
title: "SUP-3920: reefer sensor feed gap, Tacoma"
type: note
date: 2025-08-12
---
# SUP-3920: reefer sensor feed gap, Tacoma

| Field | Value |
| :--- | :--- |
| **Ticket ID** | SUP-3920 |
| **Account** | Tamsin Cold Chain (TCC) |
| **Site** | Tacoma Distribution Facility |
| **Product** | Pemberline Dock — Yard Telemetry Module |
| **Created** | 8/12/25 |
| **Status** | Resolved |

### Update Log

**8/12/25 06:45 PT**
Night-shift yard lead Derek Vance at Tamsin Cold Chain reported that the reefer temperature-sensor feed for the Tacoma yard stopped updating in Pemberline Dock at approximately 00:15 PT. Yard clerks on the early morning shift had to manually check pulp temperatures at Doors 14 through 28 for eleven staged trailers before clearing outbound dairy loads.

**8/12/25 07:20 PT**
Escalated to Tier 2 Integrations. Telemetry logs confirm the incoming webhook from the Tacoma gateway went silent at 00:14 PT on 8/12/25 and resumed at 06:18 PT, resulting in an approximately 6-hour gap in sensor readings across the north staging lot.

**8/12/25 09:50 PT**
Integrations identified a stalled worker process on ingestion node `us-west-2b` that failed to rotate credentials after TCC's scheduled local firewall maintenance. The worker was restarted at 06:17 PT, which restored the live stream, and cached payloads from the local Tacoma collector have now been backfilled into the historical temperature compliance report (`RPT-TEMP-774`).

**8/12/25 11:30 PT**
Confirmed with Derek Vance that all staged trailers in Tacoma are displaying live telemetry and the backfilled 00:15–06:18 PT intervals appear cleanly on their audit export. Closing ticket.
