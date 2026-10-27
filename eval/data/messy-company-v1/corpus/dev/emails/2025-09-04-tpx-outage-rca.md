---
title: "RCA: carrier API outage (Sept 3)"
type: email
date: 2025-09-04
---
# RCA: carrier API outage (Sept 3)

**From:** Priyanka "Pree" Sundaram <psundaram@pemberline.com>
**To:** Lev Arkadin <larkadin@tansleyparcel.com>
**Cc:** Hollis Mbeki <hmbeki@pemberline.com>
**Date:** 4 Sep 2025, 09:42 CDT
**Subject:** Re: RCA: carrier API outage (Sept 3)

Hi Lev,

Hope you are surviving the Thursday morning rush! And more importantly, hope the Tulsa yard is back to breathing normally today after yesterday's chaos. I promised I would get you the root-cause write-up from our platform folks as soon as they finished their post-mortem coffee, so here is the full scoop on what happened on 3 Sep 2025.

Basically, at 06:14 CDT yesterday, a routine worker node patch in our US-Central cluster introduced a bad retry loop on the carrier webhook listener inside Pemberline Dock. Whenever an inbound manifest ping timed out—which happens plenty during the 6am shift change—instead of backing off, the service fired immediate duplicate retries. That flooded the queue and locked up the live gate check-in screen for Tansley Parcel until engineering rolled the patch back at 07:48 CDT (ticket #INC-8841). 

I know that ninety-four minutes right at morning dispatch meant your guards at Doors 12 through 18 had to go back to clipboards and radio checks while five linehaul rigs backed up onto the service road. Nobody wants to be out in that humidity squinting at paper BOLs. To make sure this doesn't bite us again, engineering has already capped retry concurrency and split the webhook queue off from the main dock board service.

Because we obviously dropped the ball during your peak window, Hollis and I spoke with June Osei-Lark on our side this morning, and we want to put a goodwill service credit on your next invoice. Just reply with a quick thumbs-up if you are good with us applying that credit, and I will have June get it squared away with Stoneharrow Billing today.

Let me know if your ops director wants to hop on a fifteen-minute call to grill our engineers on the fix—happy to set that up!

Best,
Pree

---

> **From:** Lev Arkadin <larkadin@tansleyparcel.com>
> **To:** Priyanka "Pree" Sundaram <psundaram@pemberline.com>
> **Date:** 3 Sep 2025, 16:15 CDT
> **Subject:** Carrier API outage (Sept 3)
>
> Pree,
>
> Screens are finally green again at Tulsa, but my morning shift lead is still digging out from the gate backlog. Send over the actual RCA when you have it, plus whatever you guys are doing to make this right on the billing side.
>
> —Lev
