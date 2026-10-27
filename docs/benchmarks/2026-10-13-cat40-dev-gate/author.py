"""Writes the d4b transfer pages (conditions O and E) and cases.json. Hand-authored text; placeholders only."""
import json, os, hashlib
ROOT = os.path.dirname(os.path.abspath(__file__))
P = []  # (slug, fm dict, body, enrich dict)

def page(slug, title, type_, date, body, enrich=None, **extra):
    fm = {'title': title, 'type': type_}
    if date: fm['date'] = date
    fm.update(extra)
    P.append((slug, fm, body.strip() + '\n', enrich or {}))

# Accounts
for slug, name, desc in [('acme-example', 'Acme Example Freight', 'freight'), ('globex-example', 'Globex Example Health', 'health'),
                         ('initech-example', 'Initech Example Software', 'software'), ('umbrella-example', 'Umbrella Example Labs', 'labs'),
                         ('vandelay-example', 'Vandelay Example Imports', 'imports')]:
    page(f'accounts/{slug}', name, 'company', '2024-11-01',
         f"# {name}\n\n{name} is a customer account ({desc}). Commercial terms live in its contracts and amendments; "
         f"account notes, meetings and email threads reference it by name.")

# C1 partial override (Acme)
page('contracts/acme-msa-2025', 'Acme Example Freight master services agreement', 'contract', '2025-01-20', """
# Acme Example Freight master services agreement

Signed 2025-01-20 between Example Provider Inc. and Acme Example Freight. Effective 2025-02-01.

## Commercial terms

- Licensed seats: 120.
- Payment terms: net 45 days from invoice.
- Liability cap: USD 2,000,000 in aggregate.

## Term

The agreement runs for three years from the effective date and renews annually unless either side opts out in writing.
""", {'status': 'executed', 'effective_date': '2025-02-01'})
page('contracts/acme-amendment-1', 'Acme Example Freight amendment 1', 'amendment', '2025-07-10', """
# Acme Example Freight amendment 1

Amends the Acme Example Freight master services agreement. Signed 2025-07-10. Effective 2025-08-01.

This amendment changes one term only: licensed seats increase from 120 to 180. Every other term of the master services agreement stays as written.
""", {'status': 'executed', 'effective_date': '2025-08-01'})

# C2 future validity (Globex)
page('contracts/globex-order-2025', 'Globex Example Health order form', 'contract', '2025-02-14', """
# Globex Example Health order form

Order form under the platform terms, signed 2025-02-14, effective 2025-03-01.

- Uptime commitment: 99.5% monthly availability.
- Support tier: business hours.
- Seats: 60.
""", {'status': 'executed', 'effective_date': '2025-03-01'})
page('contracts/globex-amendment-2', 'Globex Example Health amendment 2', 'amendment', '2026-09-20', """
# Globex Example Health amendment 2

Amends the Globex Example Health order form. Signed 2026-09-20. The new terms take effect on 2027-01-01, not before.

- Uptime commitment: 99.9% monthly availability (from 2027-01-01).
- Support tier: around the clock (from 2027-01-01).
""", {'status': 'executed', 'effective_date': '2027-01-01'})

# C3 decisive paragraph with no lexical overlap (Initech). The page avoids the words termination, notice and period.
page('contracts/initech-services-agreement', 'Initech Example Software services agreement', 'contract', '2025-04-03', """
# Initech Example Software services agreement

Signed 2025-04-03 by Example Provider Inc. and Initech Example Software; in force from 2025-04-15.

## Fees

- Payment terms: net 30 days from invoice.
- Annual fee: USD 84,000, invoiced each April.

## Ending the arrangement

Either party may bring this arrangement to a close by giving the other ninety days of written warning, delivered to the address on the cover page.

## Data

Customer data is returned in a portable format within thirty days after the arrangement closes.
""", {'status': 'executed', 'effective_date': '2025-04-15'})

# C7 draft without status (Initech): newer page date, proposes changed payment terms, never executed.
page('contracts/initech-amendment-3-draft', 'DRAFT Initech Example Software amendment 3', 'amendment', '2026-08-01', """
# DRAFT Initech Example Software amendment 3

Draft for discussion, not signed. Proposed by the Initech Example Software procurement team on 2026-08-01.

- Proposed payment terms: net 15 days from invoice.
- Proposed annual fee: USD 79,000.
""", {'status': 'draft'})

# C4 summary is the only evidence (Umbrella)
page('meetings/2025-06-12-umbrella-qbr', 'Umbrella Example Labs quarterly business review', 'meeting', '2025-06-12', """
# Umbrella Example Labs quarterly business review (summary)

Attendees: alice-example (account lead), bob-example (Umbrella Example Labs operations).

- Renewal date agreed: 2026-03-31. Both sides confirmed it in the room; no contract document restates it.
- Usage grew 14% quarter over quarter.
- Next review in September.
""")

# C5 long page with repeated irrelevant term words (Vandelay)
boiler = []
topics = ['general liability insurance', 'product liability claims', 'professional liability coverage', 'employer liability',
          'environmental liability', 'cyber liability insurance', 'tax liability of each party', 'liability for subcontractors']
for i in range(1, 12):
    t = topics[(i - 1) % len(topics)]
    paras = []
    for j in range(4):
        paras.append(f"Each party maintains its own {t} as described in this section, and nothing in this section changes the allocation of {t} "
                     f"between the parties. Certificates evidencing {t} are provided on request within ten business days. Any change to the carrier "
                     f"or the limits for {t} is reported to the other party in writing. Clause {i}.{j + 1} applies to {t} only and is not a limit on "
                     f"any other obligation under this agreement.")
    boiler.append(f"## {i}. Insurance and responsibility: {t}\n\n" + "\n\n".join(paras))
decisive = ("## 12. Aggregate cap\n\nThe total amount either party can recover from the other under this agreement, for all claims combined, "
            "is limited: the aggregate cap is USD 750,000, except for breaches of confidentiality and amounts owed for services.")
tail = []
for i in range(13, 20):
    tail.append(f"## {i}. Operational schedule {i - 12}\n\n" + "\n\n".join(
        f"Operational schedule {i - 12} item {k}: deliveries are planned weekly, and each shipment manifest is shared two business days ahead. "
        f"Delays over forty-eight hours are escalated to the named contacts, and recurring delays are reviewed at the monthly operations call." for k in range(1, 6)))
long_body = "# Vandelay Example Imports master agreement\n\nSigned 2025-05-05 between Example Provider Inc. and Vandelay Example Imports, effective 2025-05-15.\n\n" + \
    "\n\n".join(boiler + [decisive] + tail)
page('contracts/vandelay-master-agreement', 'Vandelay Example Imports master agreement', 'contract', '2025-05-05', long_body,
     {'status': 'executed', 'effective_date': '2025-05-15'})

# C6 missing and conflicting metadata
page('notes/acme-billing-contact', 'Acme Example Freight billing contact', 'note', None, """
# Acme Example Freight billing contact

Billing questions for Acme Example Freight now go to carol-example in the shared finance mailbox; dave-example no longer handles them.
""")
page('mail/globex-invoice-dispute', 'Re: Globex Example Health invoice dispute', 'email', '2025-05-01', """
Sent 2025-07-15.

The invoice dispute with Globex Example Health is settled: they pay the March invoice in full and receive a one-time service credit of USD 1,200 on the next invoice.
""")

# C8 hidden page
page('notes/vandelay-board-pricing', 'Vandelay Example Imports board pricing', 'note', '2025-09-01', """
# Vandelay Example Imports board pricing

The board-only discount ladder for Vandelay Example Imports starts at 12% above 400 seats. Do not share outside the board.
""", visibility='private')

# Filler referrers
fill = [
    ('mail/acme-weekly-1', 'Acme Example Freight weekly sync', 'email', '2025-03-04', 'Acme Example Freight asked for a shipment dashboard demo next week.'),
    ('mail/acme-weekly-2', 'Acme Example Freight seat request', 'email', '2025-07-01', 'Acme Example Freight wants more seats before the August onboarding wave.'),
    ('tickets/globex-sso', 'Globex Example Health SSO ticket', 'ticket', '2025-04-11', 'Globex Example Health reports that single sign-on fails for two users.'),
    ('mail/globex-renewal-chat', 'Globex Example Health amendment discussion', 'email', '2026-09-02', 'Globex Example Health accepted a higher availability commitment starting next year.'),
    ('tickets/initech-export', 'Initech Example Software export ticket', 'ticket', '2025-11-20', 'Initech Example Software requested a full data export test.'),
    ('mail/initech-procurement', 'Initech Example Software procurement thread', 'email', '2026-08-03', 'Initech Example Software procurement sent a draft amendment for review; legal has not reviewed it.'),
    ('mail/umbrella-usage', 'Umbrella Example Labs usage report', 'email', '2025-09-18', 'Umbrella Example Labs usage report for Q3 is attached.'),
    ('tickets/vandelay-manifest', 'Vandelay Example Imports manifest ticket', 'ticket', '2025-08-08', 'Vandelay Example Imports manifests arrived late twice this month.'),
    ('mail/vandelay-claims', 'Vandelay Example Imports claim question', 'email', '2025-10-02', 'Vandelay Example Imports asked how much they could recover for the damaged shipment.'),
]
for slug, title, t, d, text in fill:
    page(slug, title, t, d, f"# {title}\n\n{text}")

CASES = [
    {'id': 'C1a-partial-override-amended-term', 'accounts': ['Acme Example Freight'], 'query': 'Acme Example Freight licensed seats', 'deciding_page': 'contracts/acme-amendment-1'},
    {'id': 'C1b-partial-override-unchanged-term', 'accounts': ['Acme Example Freight'], 'query': 'Acme Example Freight payment terms', 'deciding_page': 'contracts/acme-msa-2025'},
    {'id': 'C2-future-validity', 'accounts': ['Globex Example Health'], 'query': 'Globex Example Health uptime commitment', 'deciding_page': 'contracts/globex-order-2025'},
    {'id': 'C3-no-lexical-overlap', 'accounts': ['Initech Example Software'], 'query': 'Initech Example Software termination notice period', 'deciding_page': 'contracts/initech-services-agreement',
     'deciding_passage': 'ninety days of written warning'},
    {'id': 'C4-summary-only-evidence', 'accounts': ['Umbrella Example Labs'], 'query': 'Umbrella Example Labs renewal date', 'deciding_page': 'meetings/2025-06-12-umbrella-qbr'},
    {'id': 'C5-long-page-repeated-terms', 'accounts': ['Vandelay Example Imports'], 'query': 'Vandelay Example Imports liability cap', 'deciding_page': 'contracts/vandelay-master-agreement',
     'deciding_passage': 'the aggregate cap is USD 750,000', 'passage': True},
    {'id': 'C6a-missing-date', 'accounts': ['Acme Example Freight'], 'query': 'Acme Example Freight billing contact', 'deciding_page': 'notes/acme-billing-contact'},
    {'id': 'C6b-conflicting-dates', 'accounts': ['Globex Example Health'], 'query': 'Globex Example Health invoice dispute', 'deciding_page': 'mail/globex-invoice-dispute'},
    {'id': 'C7-draft-without-status', 'accounts': ['Initech Example Software'], 'query': 'Initech Example Software payment terms', 'deciding_page': 'contracts/initech-services-agreement',
     'draft_page': 'contracts/initech-amendment-3-draft'},
]
HIDDEN = [{'slug': 'notes/vandelay-board-pricing', 'marker': 'board-only discount ladder'}]

def yaml_val(v):
    return json.dumps(v) if isinstance(v, str) else str(v)

for cond in ['O', 'E']:
    for slug, fm, body, enrich in P:
        f = dict(fm)
        if cond == 'E': f.update(enrich)
        text = '---\n' + '\n'.join(f'{k}: {yaml_val(v)}' for k, v in f.items()) + '\n---\n' + body
        path = os.path.join(ROOT, 'pages', cond, slug + '.md')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'w').write(text)
json.dump({'cases': CASES, 'hidden': HIDDEN, 'statuses_E': {s: e['status'] for s, _, _, e in P if 'status' in e}}, open(os.path.join(ROOT, 'cases.json'), 'w'), indent=2)
print(len(P), 'pages per condition;', len(CASES), 'cases; long page chars', len(long_body))
