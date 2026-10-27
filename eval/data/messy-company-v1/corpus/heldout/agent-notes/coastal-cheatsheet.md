---
title: "Moss: Coastal cheat sheet"
type: note
---
# Coastal Team Cheat Sheet

Prepared for: Ruth Calloway  
Subject: Standing operational reference and recent delta for the Coastal team (led by Bettina Kroll).

## Standing Roster & Operational Notes

**Team Structure**
* **Bettina Kroll:** Coastal team lead. Currently focusing on cross-dock workflow configurations and gate kiosk hardware stability across regional terminals.
* **Sofia Marchetti:** Account manager. Reviewing custom CSV export requests and carrier portal permissions.
* **Kwame Adjei-Rowe:** Account manager. Coordinating with support on handheld scanner latency tickets and driver SMS localization.

**Active Customer Footprint (Coastal)**
* **Pellucid Harbor Logistics (PHL):** Port drayage and terminal logistics, Gulf Coast. Primary friction point is chassis pool validation at Gate 4 during shift change. Ticket #4419 remains open regarding the `Yard_Dwell_Summary` report timing out when filtered by container length.
* **Driftmoor Marine Freight (DMF):** Marine freight and barge operator, Puget Sound. Utilizing Pemberline Dock for slip and ramp scheduling. Tide-table import macro failed on Terminal B; engineering provided a manual CSV patch for the night dispatcher.
* **Saltmarsh Provisions (SMP):** Regional grocery distributor, Lowcountry. Main contact is Corinne Ashdown, VP Operations. Cold-storage bays (Doors 12–18) require strict pre-cooling check-ins before reefers are assigned a dock door. Corinne Ashdown requested an alert whenever a carrier misses a reefer temp check on Sofia's grocery account.
* **Covey & Lark Retail (Covey / CLR / PHL):** Home goods retailer, Mid-Atlantic. Note: internal systems occasionally collide on the "PHL" code between Covey & Lark Retail and Pellucid Harbor Logistics; verify org ID before running bulk seat audits.

## What Changed

* **Hosting & Infrastructure:** Odile Brandt at Carrowmere Cloud notified engineering of a brief packet-loss event on the US-East database cluster. No data loss occurred, though webhook delivery to carrier portals queued for fourteen minutes.
* **Deal Desk & Finance:** June Osei-Lark updated the redline intake form in the shared drive. As a reminder, Anselm Grieve must approve any discount over 10% prior to document generation.
* **Pipeline & Escalation Notes:** 
  * A steering committee call is being scheduled for Kwame's biggest account to review executive dashboard adoption and QBR slide decks.
  * Support flagged a minor SSO certificate mismatch on the account Sofia runs, which was resolved by re-uploading the metadata XML file.
  * Bettina Kroll left a voice memo in the channel: *"Tell Moss to keep the Orlavene Health notes out of the Coastal folder—they never signed and it confuses the new BDRs."*
  * Warehouse mgrs at Driftmoor Marine Freight requested a bulk-clear button for departed barges; logged as feature req #882.
