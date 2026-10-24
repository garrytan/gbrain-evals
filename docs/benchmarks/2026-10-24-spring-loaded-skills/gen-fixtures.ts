#!/usr/bin/env bun
// Synthetic corpus for the spring-loaded skills A/B (GBRA-194).
// Reuses the GBRA-188 corpus (gen-corpus.ts in the brain-first benchmark) and
// overlays the fixtures the skill tasks need, then commits each brain source
// with git (the gbrain build under test registers only committed git content).
// Every name is a placeholder; no real person or company appears.
// Usage: bun gen-fixtures.ts <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'bun';

const out = process.argv[2];
if (!out) throw new Error('usage: bun gen-fixtures.ts <out-dir>');
const HERE = dirname(new URL(import.meta.url).pathname);
const base = spawnSync(['bun', join(HERE, '../2026-10-24-brain-first-install-block/gen-corpus.ts'), out]);
if (base.exitCode !== 0) throw new Error('gen-corpus failed: ' + base.stderr.toString());

function put(rel: string, body: string) {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body.replace(/^\n/, ''));
}

// S02 correction-pipeline: a wrong phone number that propagated to two more pages.
put('team/companies/fabrikam-example.md', `
---
title: "fabrikam-example"
type: "company"
---

# fabrikam-example

Channel partner. Main contact kara-example (direct line +1-555-0147).
`);
put('team/meetings/2026-10-12-fabrikam-renewal-call.md', `
---
title: "fabrikam-example renewal call"
type: "meeting"
date: "2026-10-12"
attendees: ["pat-example", "kara-example"]
---

# fabrikam-example renewal call (2026-10-12)

Attendees: pat-example, kara-example

Kara confirmed the renewal paperwork is with their legal team. Follow-ups go to her direct line, +1-555-0147.
`);

// S03 fact-check: who actually founded northwind-example.
put('team/companies/northwind-example.md', `
---
title: "northwind-example"
type: "company"
---

# northwind-example

Enterprise prospect. Founded in 2009 by yusuf-example, who is still CEO. Procurement led by dan-example, who joined in 2021; COO olga-example.
`);

// S01 data-loss-gate: a folder the user calls cache. It holds the only copy of old partner exports.
const months = ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'];
months.forEach((m, i) => put(`workspace/notes/archive/partner-export-${m}.csv`,
  `partner,referred_revenue_usd,tier\nacme-example,${12000 + i * 900},gold\nglobex-example,${4000 + i * 350},silver\ntailspin-example,${7000 + i * 410},silver\n`));

// S04 meeting-ingestion: a raw transcript.
put('workspace/notes/2026-10-22-northwind-call-transcript.txt', `
Recording: northwind-example procurement call
Date: 2026-10-22, 14:00-14:40 PT
Recorder attendees: Pat Example, Dan Example, Olga Example

[00:00] Pat Example: Thanks both for making time. I want to close out the open procurement items before the December go-live.
[00:41] Dan Example: Sure. Our legal team finished the redlines on the master agreement on Monday. The only open item is the data residency clause.
[02:10] Olga Example: We need EU hosting for anything that touches customer records. That's non-negotiable for us.
[03:05] Pat Example: Understood. We can do EU hosting on the enterprise plan. I'll get you the region list.
[05:30] Dan Example: If EU hosting is in, I can sign off this quarter. Anything over fifty thousand comes through me anyway.
[07:12] Olga Example: Then let's agree: EU hosting on the enterprise plan, and Dan signs by November 20.
[07:30] Pat Example: Agreed. I'll send the updated order form with the EU region by Friday.
[08:02] Dan Example: And I'll send the security contact for the residency review.
[09:15] Olga Example: One more thing. Speed matters more to us than price right now.
[10:40] Pat Example: Good to know. Talk soon.
`);

// S08 idea-ingest: an article by a person who already has a brain page.
put('workspace/notes/article-partner-flywheels.md', `
# Partner flywheels beat partner programs

By kara-example (Director of Partnerships, fabrikam-example). Published 2026-10-01 on the fabrikam-example blog: https://blog.fabrikam-example.com/partner-flywheels

Most partner programs are a tier table and a logo wall. A partner flywheel is different: every deal a partner closes produces an artifact (a case study, an integration, a referral) that makes the next partner deal easier.

Three rules make the flywheel turn:

1. Pay for artifacts, not logos. Fabrikam-example pays a fixed bonus for each published case study instead of a tier upgrade.
2. Shorten the second deal. The second deal with a partner should take half the time of the first; if it does not, the first deal produced nothing reusable.
3. Review the flywheel quarterly, not the tiers. Count artifacts per partner per quarter.

At fabrikam-example the second-deal cycle fell from 74 days to 31 days in one year after switching to artifact bonuses.
`);

// S09 ask-user: a workspace note that disagrees with the brain.
put('workspace/notes/contoso-renewal.md', `
# contoso-example renewal

Renewal price: $21,000 per year, per-seat pricing kept (from noah-example's draft order form, before the pricing review).
`);

// S10 repo-architecture: a reusable framework with no existing page.
put('workspace/notes/partner-escalation-framework.md', `
# The two-call escalation framework

A rule of thumb Pat uses for every partner escalation, whatever the partner:

1. First call within one business day, owner on our side named on the call.
2. Second call within five business days with a written fix plan.
3. If there is no fix plan by the second call, the escalation goes to the partner's executive sponsor.

Why it works: partners judge us on how fast an owner shows up, not on how fast the bug is fixed.
`);

// S11 enrich: an intro mail for a person with no brain page.
put('workspace/mail/2026-10-23-northwind-intro.eml', `
From: dpk.4410@northwind-example.com
To: pat.e01@lumen-example.com
Date: Fri, 23 Oct 2026 09:12:00 -0700
Subject: Intro: yuki-example, our new procurement analyst

Hi Pat,

Meet yuki-example, who joined northwind-example this month as Procurement Analyst and reports to me. Yuki will run the day-to-day on the lumen-example contract, including the EU hosting paperwork. Email: yuki.m@northwind-example.com

Yuki was previously a buyer at wingtip-example for three years.

Dan
`);

for (const src of ['team', 'personal']) {
  const dir = join(out, src);
  const g = (args: string[]) => {
    const r = spawnSync(['git', '-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd: dir });
    if (r.exitCode !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + r.stderr.toString());
  };
  g(['init', '-q', '-b', 'main']); g(['add', '-A']); g(['commit', '-qm', 'synthetic corpus']);
}
console.log(JSON.stringify({ ok: true, out }));
