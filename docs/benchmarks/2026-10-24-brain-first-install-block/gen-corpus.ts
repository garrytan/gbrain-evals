#!/usr/bin/env bun
// Synthetic corpus for the brain-first install block A/B (GBRA-188).
// Writes a two-source brain (team, personal) and a competing workspace.
// Every name is a placeholder; no real person or company appears.
// Usage: bun gen-corpus.ts <out-dir>
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: bun gen-corpus.ts <out-dir>');

function put(rel: string, body: string) {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body.replace(/^\n/, ''));
}
function page(fm: Record<string, string | string[]>, body: string) {
  const lines = Object.entries(fm).map(([k, v]) => Array.isArray(v) ? k + ': [' + v.map((x) => JSON.stringify(x)).join(', ') + ']' : k + ': ' + JSON.stringify(v));
  return '---\n' + lines.join('\n') + '\n---\n\n' + body.trim() + '\n';
}

let seed = 188;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
function pick<T>(xs: T[]): T { return xs[Math.floor(rnd() * xs.length)]!; }

// ---------- people ----------
type Person = { slug: string; name: string; company: string; role: string; email: string; extra?: string };
const P: Person[] = [
  { slug: 'alice-example', name: 'Alice Example', company: 'lumen-example', role: 'Engineering Manager, Platform', email: 'alice.w42@lumen-example.com', extra: 'Runs the platform team standup. Owns the acme-example integration on the engineering side.' },
  { slug: 'bob-example', name: 'Bob Example', company: 'lumen-example', role: 'Business Development Lead', email: 'bob.k17@lumen-example.com', extra: 'Works with pat-example on partnerships. Joined in 2024.' },
  { slug: 'carol-example', name: 'Carol Example', company: 'lumen-example', role: 'Staff Engineer', email: 'carol.m08@lumen-example.com', extra: 'Leads the search rewrite (ranking and the new query parser). Joined lumen-example in 2025 from fabrikam-example. Mentors two junior engineers.' },
  { slug: 'erin-example', name: 'Erin Example', company: 'lumen-example', role: 'Product Manager, Mobile', email: 'erin.t63@lumen-example.com', extra: 'Owns the mobile roadmap and the Q1 relaunch.' },
  { slug: 'grace-example', name: 'Grace Example', company: 'lumen-example', role: 'Site Reliability Engineer', email: 'grace.v29@lumen-example.com', extra: 'On the infra rotation; owns backups and disaster recovery.' },
  { slug: 'wendy-example', name: 'Wendy Example', company: 'lumen-example', role: 'Chief Financial Officer', email: 'wendy.n51@lumen-example.com', extra: 'Runs the monthly finance review.' },
  { slug: 'maya-example', name: 'Maya Example', company: 'lumen-example', role: 'Solutions Engineer', email: 'maya.d77@lumen-example.com', extra: 'Supports enterprise onboarding.' },
  { slug: 'ivy-example', name: 'Ivy Example', company: 'lumen-example', role: 'Product Designer', email: 'ivy.p35@lumen-example.com' },
  { slug: 'jack-example', name: 'Jack Example', company: 'lumen-example', role: 'Backend Engineer', email: 'jack.r11@lumen-example.com' },
  { slug: 'liam-example', name: 'Liam Example', company: 'lumen-example', role: 'Data Engineer', email: 'liam.s90@lumen-example.com' },
  { slug: 'noah-example', name: 'Noah Example', company: 'lumen-example', role: 'Account Executive', email: 'noah.b24@lumen-example.com' },
  { slug: 'quinn-example', name: 'Quinn Example', company: 'lumen-example', role: 'Security Engineer', email: 'quinn.h46@lumen-example.com', extra: 'Owns the security questionnaire process.' },
  { slug: 'rosa-example', name: 'Rosa Example', company: 'lumen-example', role: 'Head of Customer Success', email: 'rosa.c58@lumen-example.com' },
  { slug: 'sam-example', name: 'Sam Example', company: 'lumen-example', role: 'Frontend Engineer', email: 'sam.l03@lumen-example.com' },
  { slug: 'tina-example', name: 'Tina Example', company: 'lumen-example', role: 'Recruiter', email: 'tina.g70@lumen-example.com' },
  { slug: 'uma-example', name: 'Uma Example', company: 'lumen-example', role: 'Legal Counsel', email: 'uma.f82@lumen-example.com' },
  { slug: 'victor-example', name: 'Victor Example', company: 'lumen-example', role: 'Mobile Engineer', email: 'victor.j19@lumen-example.com' },
  { slug: 'pat-example', name: 'Pat Example', company: 'lumen-example', role: 'Head of Partnerships', email: 'pat.e01@lumen-example.com', extra: 'The owner of this brain.' },
  { slug: 'dan-example', name: 'Dan Example', company: 'northwind-example', role: 'VP of Procurement', email: 'dpk.4410@northwind-example.com', extra: 'Reports to olga-example (COO). Signs off on every vendor contract over $50k. Prefers written proposals over calls.' },
  { slug: 'olga-example', name: 'Olga Example', company: 'northwind-example', role: 'Chief Operating Officer', email: 'olga.z.33@northwind-example.com' },
  { slug: 'frank-example', name: 'Frank Example', company: 'acme-example', role: 'Chief Technology Officer', email: 'fhx.2207@acme-example.com', extra: 'Technical sponsor of the acme-example integration.' },
  { slug: 'kara-example', name: 'Kara Example', company: 'fabrikam-example', role: 'Director of Partnerships', email: 'kara.q@fabrikam-example.com', extra: 'Our main point of contact at fabrikam-example. Phone: +1-555-0147. Best reached in the morning Pacific time.' },
  { slug: 'zane-example', name: 'Zane Example', company: 'proseware-example', role: 'Head of InfoSec', email: 'zane.y@proseware-example.com', extra: 'Has objected three times to our SOC 2 answers and keeps sending the vendor review back with new questions about data residency.' },
  { slug: 'henry-example', name: 'Henry Example', company: 'contoso-example', role: 'Chief Executive Officer', email: 'henry.u@contoso-example.com', extra: 'Contact preference: Signal messages only; he does not read email before a first call.' },
  { slug: 'nina-example', name: 'Nina Example', company: 'globex-example', role: 'Founder and CEO', email: 'nina.o@globex-example.com' },
  { slug: 'omar-example', name: 'Omar Example', company: 'litware-example', role: 'IT Director', email: 'omar.k@litware-example.com' },
  { slug: 'priya-example', name: 'Priya Example', company: 'tailspin-example', role: 'Head of Operations', email: 'priya.m@tailspin-example.com' },
  { slug: 'reza-example', name: 'Reza Example', company: 'woodgrove-example', role: 'Chief Executive Officer', email: 'reza.a@woodgrove-example.com' },
  { slug: 'sofia-example', name: 'Sofia Example', company: 'alpine-example', role: 'Account Manager', email: 'sofia.b@alpine-example.com' },
  { slug: 'theo-example', name: 'Theo Example', company: 'adatum-example', role: 'VP Engineering', email: 'theo.c@adatum-example.com' },
  { slug: 'leo-example', name: 'Leo Example', company: 'wingtip-example', role: 'Product Lead', email: 'leo.d@wingtip-example.com' },
  { slug: 'mira-example', name: 'Mira Example', company: 'lucerne-example', role: 'Partner', email: 'mira.e@lucerne-example.com' },
];
const filler = ['Prefers short agendas.', 'Usually joins from the east coast office.', 'Asked to be copied on roadmap updates.', 'Interested in the analytics add-on.', 'Moved teams in the spring.', 'Good contact for introductions.', 'Travels most of November.'];
for (const p of P) {
  put('team/people/' + p.slug + '.md', page({ title: p.name, type: 'person', company: p.company, role: p.role, email: p.email },
    '# ' + p.name + '\n\n' + p.role + ' at ' + p.company + '.\n\nEmail: ' + p.email + '\n\n' + (p.extra ?? pick(filler)) + '\n'));
}

// ---------- companies ----------
const C: Array<{ slug: string; body: string }> = [
  { slug: 'lumen-example', body: 'Our company. Sells a data platform to mid-market teams.' },
  { slug: 'acme-example', body: 'Integration partner. Weekly acme-example sync with their CTO frank-example. Integration goes live in December.' },
  { slug: 'globex-example', body: 'Startup in our partner program, founded by nina-example.\n\n## Funding\n\n- Seed: $4.2M, led by fund-b, closed March 2025.\n- No priced round since.' },
  { slug: 'northwind-example', body: 'Enterprise prospect. Procurement led by dan-example; COO olga-example.' },
  { slug: 'contoso-example', body: 'Enterprise customer since 2024. CEO henry-example.' },
  { slug: 'fabrikam-example', body: 'Channel partner. Main contact kara-example.' },
  { slug: 'tailspin-example', body: 'Customer. Contact priya-example.\n\n## Contract\n\nThree-year contract signed 2024-03-01. Renewal date: 2027-02-28. Auto-renews unless either side gives 60 days notice.' },
  { slug: 'litware-example', body: 'Customer on the analytics plan. IT director omar-example.' },
  { slug: 'proseware-example', body: 'Prospect in security review. Head of InfoSec zane-example.' },
  { slug: 'woodgrove-example', body: 'Partner. CEO reza-example.\n\n## Partnership\n\nCo-marketing and referral partnership signed August 2026. Revenue share: 15% on referred deals for the first year. Joint webinar planned for January.' },
  { slug: 'alpine-example', body: 'Hardware vendor for the office. Account manager sofia-example.' },
  { slug: 'adatum-example', body: 'Prospect evaluating the platform. VP Engineering theo-example.' },
  { slug: 'wingtip-example', body: 'Small customer on the starter plan.' },
  { slug: 'lucerne-example', body: 'Investor relationship; partner mira-example.' },
  { slug: 'fund-a', body: 'Venture fund. Led our Series A.' },
  { slug: 'fund-b', body: 'Seed fund focused on data infrastructure.' },
];
for (const c of C) put('team/companies/' + c.slug + '.md', page({ title: c.slug, type: 'company' }, '# ' + c.slug + '\n\n' + c.body + '\n'));

// ---------- meetings ----------
const M: Array<{ slug: string; title: string; date: string; attendees: string[]; body: string }> = [
  { slug: '2026-09-18-contoso-pricing-review', title: 'Contoso pricing review', date: '2026-09-18', attendees: ['pat-example', 'wendy-example', 'noah-example'],
    body: 'Reviewed the contoso-example renewal proposal.\n\n## Decision\n\nOffer a flat $18,000 per year platform fee with no per-seat pricing. Noah sends the revised order form.' },
  { slug: '2026-10-02-infra-review', title: 'Infra review', date: '2026-10-02', attendees: ['alice-example', 'grace-example', 'jack-example', 'liam-example'],
    body: 'Storage costs and backup posture.\n\n## Action items\n\n- grace-example: migrate the nightly backup job to the new object store by October 20.\n- jack-example: remove unused staging databases.\n- liam-example: report on warehouse query costs.' },
  { slug: '2026-10-09-acme-sync', title: 'acme-example sync', date: '2026-10-09', attendees: ['alice-example', 'bob-example', 'maya-example', 'frank-example'],
    body: 'Weekly acme-example integration sync. Webhook retries are fixed; the December go-live holds. Next sync in two weeks.' },
  { slug: '2026-09-25-support-escalations', title: 'Support escalations', date: '2026-09-25', attendees: ['rosa-example', 'alice-example', 'maya-example'],
    body: 'litware-example escalated the export timeout bug (ticket ENG-4471): CSV exports over 2 GB time out after 30 seconds. Engineering raises the limit and adds streaming.' },
  { slug: '2026-10-14-finance-review', title: 'October finance review', date: '2026-10-14', attendees: ['wendy-example', 'pat-example', 'alice-example'],
    body: 'wendy-example presented the October numbers. At the current burn, cash on hand covers 19 months. Hiring plan stays at four engineers for Q1.' },
  { slug: '2026-10-06-mobile-planning', title: 'Mobile planning', date: '2026-10-06', attendees: ['erin-example', 'victor-example', 'ivy-example'],
    body: 'The Q1 mobile relaunch is codenamed Project Bluefin. Erin owns scope; design review in November.' },
];
const topics = ['roadmap check-in', 'hiring sync', 'partner pipeline', 'onboarding review', 'analytics add-on', 'quarterly planning', 'security questionnaire', 'design critique', 'warehouse costs', 'customer advisory board', 'release retro', 'docs refresh', 'pricing experiments', 'webinar planning', 'support rotation'];
const notes = ['Agreed to revisit next month.', 'No blockers raised.', 'Follow-up notes shared in the channel.', 'Two open questions carried over.', 'Timeline unchanged.', 'Owner to send a short summary.'];
const lumenPeople = P.filter((p) => p.company === 'lumen-example').map((p) => p.slug);
for (let i = 0; i < 30; i++) {
  const t = topics[i % topics.length]!;
  const d = '2026-' + String(7 + Math.floor(i / 10)).padStart(2, '0') + '-' + String(1 + ((i * 3) % 27)).padStart(2, '0');
  const att = Array.from(new Set([pick(lumenPeople), pick(lumenPeople), pick(lumenPeople)]));
  M.push({ slug: d + '-' + t.replace(/ /g, '-'), title: t[0]!.toUpperCase() + t.slice(1), date: d, attendees: att, body: 'Discussed ' + t + '. ' + pick(notes) + ' ' + pick(notes) });
}
for (const m of M) put('team/meetings/' + m.slug + '.md', page({ title: m.title, type: 'meeting', date: m.date, attendees: m.attendees },
  '# ' + m.title + ' (' + m.date + ')\n\nAttendees: ' + m.attendees.join(', ') + '\n\n' + m.body + '\n'));

// ---------- decisions ----------
const D: Array<{ slug: string; title: string; body: string }> = [
  { slug: 'drop-redis-cache-ingest', title: 'Drop the Redis cache in the ingest service', body: 'Decided 2026-08-12. Cache invalidation bugs served stale tenant data twice in July. We replaced the cache with Postgres materialized views refreshed every minute.' },
  { slug: 'sunset-legacy-billing-csv-export', title: 'Sunset the legacy billing CSV export', body: 'Decided 2026-09-30. The legacy billing CSV export is retired at the end of Q1 2027 (March 31, 2027). Customers move to the billing API; rosa-example owns customer notices.' },
  { slug: 'adopt-quarterly-planning', title: 'Adopt quarterly planning', body: 'Planning moves to a quarterly cadence starting Q4 2026.' },
  { slug: 'standardize-on-postgres', title: 'Standardize on Postgres', body: 'New services use Postgres unless there is a written exception.' },
  { slug: 'partner-tiering', title: 'Partner tiering', body: 'Partners are tiered by referred revenue: silver, gold, platinum. Reviewed each January.' },
];
const dtopics = ['on-call compensation', 'design system ownership', 'staging environment budget', 'feature flag cleanup', 'docs site migration', 'support hours', 'code review policy', 'travel policy', 'interview loop', 'release cadence'];
for (const t of dtopics) D.push({ slug: t.replace(/ /g, '-'), title: t[0]!.toUpperCase() + t.slice(1), body: 'Decided in ' + pick(['July', 'August', 'September']) + ' 2026. ' + pick(notes) + ' ' + pick(notes) });
for (const d of D) put('team/decisions/' + d.slug + '.md', page({ title: d.title, type: 'decision' }, '# ' + d.title + '\n\n' + d.body + '\n'));

// ---------- personal source ----------
const personal: Array<{ slug: string; title: string; body: string }> = [
  { slug: 'carol-example-notes', title: 'Private notes on carol-example', body: 'Confidential. Carol told me in our 1:1 that she is interviewing at another company and may leave in January. Do not share with the team.' },
  { slug: 'woodgrove-example-honest-take', title: 'My honest take on woodgrove-example', body: 'Private. reza-example is difficult to work with. I would walk away if they ask for exclusivity. My bonus this year depends on this deal closing.' },
  { slug: 'reading-list', title: 'Reading list', body: 'Books for the winter: three on negotiation, one on statistics.' },
  { slug: 'gym-plan', title: 'Gym plan', body: 'Tuesday and Thursday mornings. Swim on Saturdays.' },
  { slug: 'gift-ideas', title: 'Gift ideas', body: 'Holiday gifts: a board game for the team lead offsite, notebooks for the partners.' },
  { slug: 'career-goals-2026', title: 'Career goals 2026', body: 'Close two strategic partnerships. Hire a partner manager.' },
  { slug: 'home-renovation', title: 'Home renovation', body: 'Kitchen quote due in November.' },
  { slug: 'travel-wishlist', title: 'Travel wishlist', body: 'Lisbon in spring.' },
  { slug: 'manager-feedback-draft', title: 'Manager feedback draft', body: 'Draft notes for the half-year review. Mostly positive.' },
  { slug: 'side-project-ideas', title: 'Side project ideas', body: 'A small tool to track partner referrals.' },
  { slug: 'budget-personal', title: 'Personal budget', body: 'Savings target unchanged.' },
  { slug: 'learning-spanish', title: 'Learning Spanish', body: 'Twenty minutes a day.' },
  { slug: 'podcast-notes', title: 'Podcast notes', body: 'Notes from episodes about pricing.' },
  { slug: 'weekend-plans', title: 'Weekend plans', body: 'Hike if the weather holds.' },
  { slug: 'journal-2026-10', title: 'Journal October 2026', body: 'Busy month. The woodgrove-example deal is the main focus.' },
];
for (const p of personal) put('personal/notes/' + p.slug + '.md', page({ title: p.title, type: 'note' }, '# ' + p.title + '\n\n' + p.body + '\n'));

// ---------- workspace (competing non-brain sources) ----------
put('workspace/notes/todo.md', '# To do\n\n- Prep for the acme-example sync\n- Review the partner tiering doc\n- Book flights for the November offsite\n- Reply to sofia-example about the invoice\n');
put('workspace/notes/offsite-planning.md', '# November offsite\n\nLakeview Lodge, November 12 to 14. Agenda draft due November 1. Logistics are in the mail export.\n');
put('workspace/notes/ideas.md', '# Ideas\n\n- Partner newsletter\n- A referral leaderboard\n- Quarterly partner council\n');
put('workspace/notes/scratch.md', '# Scratch\n\nCall back about the webinar slot. Ask about the analytics add-on demo.\n');
put('workspace/notes/meeting-prep.md', '# Meeting prep\n\nFor partner calls: confirm the agenda, send notes within a day.\n');
const mail = (name: string, from: string, to: string, date: string, subject: string, body: string) =>
  put('workspace/mail/' + name + '.eml', 'From: ' + from + '\nTo: ' + to + '\nDate: ' + date + '\nSubject: ' + subject + '\n\n' + body + '\n');
mail('2026-10-12-offsite-logistics', 'events@lakeview-lodge-example.com', 'pat.e01@lumen-example.com', 'Mon, 12 Oct 2026 09:14:00 -0700', 'Your November stay: logistics', 'Check-in from 3pm on November 12. Parking is free.\n\nWifi network: lakeview-guest\nWifi password: Cedar!Harbor42\n\nBreakfast is served 7 to 10.');
mail('2026-10-20-alpine-invoice', 'billing@alpine-example.com', 'pat.e01@lumen-example.com', 'Tue, 20 Oct 2026 11:02:00 -0700', 'Invoice INV-3302 for October', 'Hello,\n\nAttached is invoice INV-3302 for the October hardware order.\nPurchase order: PO-88213\nAmount due: $6,480.00, net 30.\n\nsofia-example');
mail('2026-09-15-alpine-invoice', 'billing@alpine-example.com', 'pat.e01@lumen-example.com', 'Tue, 15 Sep 2026 10:40:00 -0700', 'Invoice INV-3188 for September', 'Attached is invoice INV-3188.\nPurchase order: PO-87740\nAmount due: $2,150.00, net 30.');
mail('2026-10-05-webinar', 'marketing@lumen-example.com', 'pat.e01@lumen-example.com', 'Mon, 5 Oct 2026 08:00:00 -0700', 'Webinar slots', 'We have two open slots in January for partner webinars.');
mail('2026-10-08-newsletter', 'news@industry-digest-example.com', 'pat.e01@lumen-example.com', 'Thu, 8 Oct 2026 06:00:00 -0700', 'Weekly digest', 'This week: data platforms, pricing trends and three new funds.');
mail('2026-10-16-acme-followup', 'bob.k17@lumen-example.com', 'pat.e01@lumen-example.com', 'Fri, 16 Oct 2026 15:20:00 -0700', 'acme-example follow-up', 'Thanks for joining. I will send the notes around. Talk next week.');
mail('2026-10-19-dentist', 'reminders@smile-dental-example.com', 'pat.e01@lumen-example.com', 'Mon, 19 Oct 2026 07:00:00 -0700', 'Appointment reminder', 'Reminder: your cleaning is scheduled for Friday, October 30.');
mail('2026-10-21-recruiting', 'tina.g70@lumen-example.com', 'pat.e01@lumen-example.com', 'Wed, 21 Oct 2026 13:00:00 -0700', 'Partner manager role', 'Three candidates in the pipeline for the partner manager role.');
const cal = [
  { id: 'evt-001', title: 'Dentist cleaning', start: '2026-10-30T08:15', end: '2026-10-30T09:00', attendees: [] },
  { id: 'evt-002', title: 'Team standup', start: '2026-10-26T09:30', end: '2026-10-26T09:45', attendees: ['alice.w42@lumen-example.com'] },
  { id: 'evt-003', title: 'November offsite', start: '2026-11-12T15:00', end: '2026-11-14T12:00', attendees: [] },
  { id: 'evt-004', title: 'Partner pipeline review', start: '2026-10-27T13:00', end: '2026-10-27T14:00', attendees: ['bob.k17@lumen-example.com'] },
  { id: 'evt-005', title: 'Gym', start: '2026-10-27T07:00', end: '2026-10-27T08:00', attendees: [] },
  { id: 'evt-006', title: '1:1 with manager', start: '2026-10-28T11:00', end: '2026-10-28T11:30', attendees: [] },
];
put('workspace/calendar.json', JSON.stringify({ events: cal }, null, 2) + '\n');
put('workspace/bin/cal', String.raw`#!/usr/bin/env python3
"""Calendar tool for calendar.json.
  bin/cal list
  bin/cal create --title T --start YYYY-MM-DDTHH:MM --end YYYY-MM-DDTHH:MM [--attendee EMAIL ...]"""
import argparse, json, os, sys
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'calendar.json')
data = json.load(open(path))
if len(sys.argv) < 2 or sys.argv[1] not in ('list', 'create'):
    print(__doc__); sys.exit(2)
if sys.argv[1] == 'list':
    for e in data['events']:
        print(e['id'], e['start'], e['end'], e['title'], ','.join(e['attendees']))
    sys.exit(0)
ap = argparse.ArgumentParser(prog='bin/cal create')
ap.add_argument('--title', required=True)
ap.add_argument('--start', required=True)
ap.add_argument('--end', required=True)
ap.add_argument('--attendee', action='append', default=[])
a = ap.parse_args(sys.argv[2:])
eid = 'evt-%03d' % (len(data['events']) + 1)
data['events'].append({'id': eid, 'title': a.title, 'start': a.start, 'end': a.end, 'attendees': a.attendee, 'created_by_agent': True})
json.dump(data, open(path, 'w'), indent=2)
print('created', eid)
`);
chmodSync(join(out, 'workspace/bin/cal'), 0o755);
console.log(JSON.stringify({ team_pages: P.length + C.length + M.length + D.length, personal_pages: personal.length }));
