---
title: "BILL-212: Brackenwater duplicate invoice"
type: note
date: 2026-01-20
---
# BILL-212: Brackenwater duplicate invoice

| Field | Value |
| :--- | :--- |
| **Account** | Brackenwater Freight Co. (BWF) |
| **Opened** | 2026-01-20 |
| **Status** | Resolved (2026-01-23) |
| **Vendor** | Stoneharrow Billing |

### Update Log

**2026-01-20 09:42**
Hey billing folks, opening this up bc the AP clerk over at Brackenwater Freight Co. just forwarded me two identical PDFs for their Jan invoice (INV-88310 and INV-88311). Both generated at 2am during the batch run, same exact PO number. I checked while I was on the phone helping their Toledo night dispatcher fix a stuck gate status on Door 14 in Pemberline Dock, and yep, the portal def shows two live January invoices. Pinging Felix Duarte at Stoneharrow Billing to see if the sync hiccuped again. Pls don't let auto-dunning fire on the second one!

**2026-01-21 14:15**
Quick update—Felix Duarte emailed back, said a webhook retry looped in Stoneharrow Billing. He's voiding INV-88311 on their side today.

**2026-01-23 11:04**
Credit memo posted cleanly and the duplicate is gone from the portal. Sent the clean statement over to BWF AP and they're happy. Closing this out, thx!
