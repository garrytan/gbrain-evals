#!/usr/bin/env python3
# Synthetic name-lookup eval corpus for #7471 (placeholder names only).
import json, os, sys, random
out = sys.argv[1]
random.seed(7471)
os.makedirs(out + '/brain/people', exist_ok=True)
os.makedirs(out + '/brain/archive', exist_ok=True)
os.makedirs(out + '/brain/notes', exist_ok=True)
os.makedirs(out + '/brain/companies', exist_ok=True)
os.makedirs(out + '/late', exist_ok=True)
groups = [('Matthew','Matt'),('Robert','Bob'),('William','Bill'),('Elizabeth','Liz'),('James','Jim'),('Katherine','Kate'),
          ('Michael','Mike'),('Christopher','Chris'),('Jennifer','Jen'),('Thomas','Tom'),('Richard','Rick'),('Susan','Sue')]
rare = ['Quorvant','Zelbrick','Marrowfen','Thistlecombe','Vandermeer','Oxleigh','Pellworth','Kindrick','Halvorsen','Ashgrove','Brenlow','Corrigal']
common_sur = ['Alder','Birch','Cedar','Dunmore','Ellery','Fairley','Garnet','Holloway','Ingram','Jasper','Keswick','Lowell','Marlow','Norwood','Oakley']
def page(path, typ, title, body):
    with open(path, 'w') as f:
        f.write('---\ntype: %s\ntitle: %s\n---\n%s\n' % (typ, title, body))
qs = []
for gi, ((formal, short), sur) in enumerate(zip(groups, rare)):
    sl = sur.lower()
    # half the targets are titled with the formal name, half with the short form
    title_form, other_form = (formal, short) if gi % 2 == 0 else (short, formal)
    tslug = 'people/%s-%s' % (title_form.lower(), sl)
    page('%s/late/%s.md' % (out, tslug.split('/')[1]), 'person', '%s %s' % (title_form, sur), '%s %s leads partnerships at Example Org %d. Based in the north office.' % (title_form, sur, gi))
    for cs in common_sur:
        page('%s/brain/people/%s-%s.md' % (out, short.lower(), cs.lower()), 'person', '%s %s' % (short, cs), '%s %s works in sales.' % (short, cs))
    for cs in common_sur[:5]:
        page('%s/brain/people/%s-%s.md' % (out, formal.lower(), cs.lower()), 'person', '%s %s' % (formal, cs), '%s %s works in finance.' % (formal, cs))
    for i in range(10):
        page('%s/brain/archive/%s-%s-mail-%d.md' % (out, short.lower(), sl, i), 'email', 'Re: request %d-%d' % (gi, i), 'Thanks, %s %s. Following up on request %d.' % (short, sur, i))
    page('%s/brain/companies/example-org-%d.md' % (out, gi), 'company', 'Example Org %d' % gi, 'Team: %s %s (partnerships), also known around the office as %s %s.' % (formal, sur, short, sur))
    qs.append({'family': 'other-given-form', 'query': '%s %s' % (other_form, sur), 'expect': tslug})
    qs.append({'family': 'title-given-form', 'query': '%s %s' % (title_form, sur), 'expect': tslug})
    qs.append({'family': 'surname-only', 'query': sur, 'expect': tslug})
    qs.append({'family': 'titled-name', 'query': 'Dr %s %s' % (other_form, sur), 'expect': tslug})
# rare-word OR fallback: no title holds both words
for i, (common, rw) in enumerate([('Acme','Quokka'),('Globex','Pangolin'),('Initech','Narwhal'),('Umbrella','Axolotl')]):
    for n in range(40):
        page('%s/brain/notes/%s-sync-%d.md' % (out, common.lower(), n), 'note', '%s weekly sync %d' % (common, n), '%s sync %d notes.' % (common, n))
    page('%s/late/%s.md' % (out, rw.lower()), 'note', '%s' % rw, 'Field notes about the %s.' % rw.lower())
    qs.append({'family': 'rare-word-or-fallback', 'query': '%s %s' % (common, rw), 'expect': 'notes/%s' % rw.lower(), 'late_slug': 'notes/%s' % rw.lower()})
# non-name controls, incl. queries that open with a nickname word
controls = [('Art history reading list','art history reading'),('Bill payment schedule','bill payment schedule'),('Frank feedback notes','frank feedback notes'),
            ('Rich text editor spec','rich text editor'),('Will and estate planning','will estate planning'),('Pat on the back awards','pat awards'),
            ('Acme weekly sync 12','Acme weekly sync 12'),('Quarterly budget review','quarterly budget review'),('Hiring plan 2026','hiring plan'),
            ('Offsite logistics','offsite logistics'),('Sue the vendor memo','sue vendor memo'),('Al fresco dining guide','al fresco dining')]
for t, q in controls:
    slug = 'notes/' + '-'.join(t.lower().split())
    if not os.path.exists('%s/brain/%s.md' % (out, slug)):
        page('%s/brain/%s.md' % (out, slug), 'note', t, 'Details for %s.' % t.lower())
    qs.append({'family': 'non-name-control', 'query': q, 'expect': slug})
with open(out + '/queries.jsonl', 'w') as f:
    for q in qs: f.write(json.dumps(q) + '\n')
print(len(qs), 'queries')
