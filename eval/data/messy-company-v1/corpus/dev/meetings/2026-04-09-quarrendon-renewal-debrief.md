---
title: "Quarrendon call: renewal debrief"
type: meeting
date: 2026-04-09
---
# Quarrendon call: renewal debrief

**Date:** Thursday, Apr 9th  
**Attendees:** Thea Ramaswell (Quarrendon Freight Lines), me

Quick post-renewal check-in with Thea. She was calling from the La Crosse yard—loud background noise, switchers moving trailers off doors 14–18 after the overnight ice storm.

**Commercials & billing**
- Paperwork all squared away. New per-seat price is $1,920/yr.
- The discount stays at 12% under the new term.
- Next renewal is March 31, 2027.
- Thea asked for the updated vendor remittance sheet from Stoneharrow Billing. Their AP clerk kicked back the first draft invoice because the PO box line looked different from last spring. Need June Osei-Lark or Felix Duarte to send the clean PDF over so QFL can cut the check on their Friday run.

**Ops / Product notes**
- Duluth terminal: second shift gate clerks are still forgetting to flip bobtail arrivals to "departed" when drivers drop paperwork at the window instead of the kiosk. Messing up the `Yard Dwell > 4h` report every Wednesday morning.
- Ticket #8841 (carrier portal timeout when uploading CSV manifests over 600 rows). Thea says it happened again Tuesday the 7th around 05:30 CT. Not a blocker, they split the file in half, but annoying for her lead dispatcher, Greg.
- Door 9 sensor integration at Green Bay: they swapped out the physical dock lock hardware last week. Need to update the webhook endpoint in Pemberline Dock settings so the red/green status light syncs properly on the dispatch board.
- She wants a 20-min refresher training for two new night-shift yard spotters starting Monday the 20th. Doesn't need full admin walkthru, just tablet view, trailer moves, and spotting queue.

**Action items**
- [ ] **Me:** Ping June Osei-Lark to get the clean Stoneharrow Billing remittance form over to QFL AP today.
- [ ] **Me:** Check status on #8841 with support—see if eng pulled the logs from Tuesday the 7th.
- [ ] **Thea:** Send me the new webhook URL from their Green Bay IT guy by Friday the 10th.
- [ ] **Me:** Send calendar hold for Monday the 20th (afternoon CT, before second shift starts) for the spotter tablet walkthrough.
