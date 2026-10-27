---
title: "Central weekly 9/8"
type: note
date: 2025-09-08
---
# Central weekly 9/8

**Author:** Hollis Mbeki  
**Date:** September 8, 2025  

### Carrier-API Outage Escalation (September 3, 2025)
* On September 3, 2025, an upstream certificate change broke the carrier-API webhook for Pree's parcel account, halting automated gate check-ins across their South Central cross-docks during the Wednesday twilight sort.
* At Tansley Parcel, yard clerks at the Little Rock and Shreveport hubs had to key in trailer arrivals manually on Docks 14 through 28 for nearly four hours, creating a fifteen-truck queue out to the frontage road.
* Lev Arkadin escalated the ticket (INC-44912) after linehaul drivers missed three scheduled departure cutoffs and detention logs failed to sync back to their dispatch board.
* Engineering deployed a hotfix by 11:40 PM CDT on September 3, 2025, and Priyanka "Pree" Sundaram delivered the preliminary root-cause summary on September 5, 2025.
* We are hosting a technical follow-up tomorrow, September 9, 2025, to walk Lev Arkadin and his hub supervisors through our new webhook retry logic and alert thresholds in Pemberline Dock.

### Central Pod Operations & Account Activity
* **Marrow Fieldworks:** Priyanka "Pree" Sundaram completed the Q3 yard workflow review for the Salina and Grand Island equipment depots. Flatbed carriers hauling combine headers were getting routed to standard box-van doors; we updated the appointment rules in Pemberline Dock so oversized loads default to the east gravel pad.
* **Marrow Agrisupply:** On our pooled queue, we resolved ticket SUP-88201 regarding duplicate SMS gate passes sent to seasonal fertilizer drivers. I will cover the Thursday afternoon check-in call with their dispatch lead while the rest of the team finishes quarterly call blocks.
* **QBR Preparation:** Tobias Rendle has finalized the slide deck and dock-utilization exports for the account Tobias runs, and we will review the executive summary together on Wednesday afternoon before the customer presentation on September 12, 2025.

### Internal Systems & Cross-Functional Items
* **Stoneharrow Billing:** Felix Duarte joined our sync on September 4, 2025, to troubleshoot why PO numbers were truncating at twelve characters on automated PDF invoices. A patch is scheduled for September 11, 2025, which June Osei-Lark confirmed will clear the current backlog of manual invoice edits.
* **Carrier Directory Cleanup:** Several regional dispatchers accidentally selected Quarendon Freightways in the carrier dropdown last week instead of the intended active carrier profile. Support is hiding the inactive look-alike entry in the master lookup table so gate clerks stop sending appointment confirmations to an unmonitored address.
* **Executive Reporting:** Ruth Calloway asked for a clean rollup of all third-quarter API incidents across the regions by Friday, September 12, 2025. Moss already scraped the initial incident timelines from the engineering channel, and I am editing the Central section today to ensure the operational impact notes are accurate before Anselm Grieve and Ruth Calloway review the packet.
