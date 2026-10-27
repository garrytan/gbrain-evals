"""Applies DECISION-RULE.md (sha256 in DECISION-RULE.sha256) to results/outputs.json."""
import json, re, sys, collections
O = json.load(open('results/outputs.json'))
C = json.load(open('cases.json'))
cases, hidden, statuses = C['cases'], C['hidden'], C['statuses_E']

def leading_json(t):
    t2 = t.lstrip()
    if not t2 or t2[0] not in '[{': return None
    dec = json.JSONDecoder()
    try: return dec.raw_decode(t2)[0]
    except Exception: return None

def objs(v):
    if isinstance(v, dict):
        yield v
        for x in v.values(): yield from objs(x)
    elif isinstance(v, list):
        for x in v: yield from objs(x)

def surfaces(run, cid):
    s = dict(run['cases'][cid])
    pack = s.pop('S3S4')
    j = leading_json(pack)
    s['S3'] = json.dumps({k: v for k, v in j.items() if k != 'text'}) if isinstance(j, dict) else pack
    s['S4'] = j.get('text', '') if isinstance(j, dict) else ''
    return s

fails = collections.defaultdict(list)
found = {}
for key, run in O.items():
    b, cond = key.split('-')
    for c in cases:
        s = surfaces(run, c['id'])
        for sname, text in s.items():
            found[(key, c['id'], sname)] = {'page': c['deciding_page'] in text, 'passage': ('deciding_passage' in c and c['deciding_passage'] in text)}
            for h in hidden:
                if h['slug'] in text or h['marker'] in text: fails['R2'].append(f"{key} {c['id']} {sname}: hidden page served")
            j = leading_json(text) if sname != 'S4' else None
            for o in objs(j) if j is not None else []:
                if 'page_status' in o:
                    if cond == 'O': fails['R3'].append(f"{key} {c['id']} {sname}: page_status {o['page_status']!r} on {o.get('slug')} in O")
                    elif statuses.get(o.get('slug')) != o['page_status']: fails['R3'].append(f"{key} {c['id']} {sname}: page_status {o['page_status']!r} on {o.get('slug')}, frontmatter {statuses.get(o.get('slug'))!r}")
            if sname != 'S4' and j is None and re.search(r'"page_status"', text): fails['R3'].append(f"{key} {c['id']} {sname}: page_status in unparsed output")
# R1
for cond in ['O', 'E']:
    for c in cases:
        k = f'W-{cond}'
        if not any(found[(k, c['id'], s)]['page'] for s in ['S1', 'S2', 'S3', 'S4', 'S5']): fails['R1'].append(f"{k} {c['id']}: deciding page in none of S1-S5")
        if c.get('passage') and not found[(k, c['id'], 'S5')]['passage']: fails['R1'].append(f"{k} {c['id']}: deciding passage not in S5")
# R4
for c in cases:
    for s in ['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S8', 'S9']:
        bf, wf = found[('B-O', c['id'], s)], found[('W-O', c['id'], s)]
        if bf['page'] and not wf['page']: fails['R4'].append(f"{c['id']} {s}: base surfaces the deciding page, wave does not")
        if c.get('passage') and s in ('S5', 'S7', 'S8', 'S9') and bf['passage'] and not wf['passage']: fails['R4'].append(f"{c['id']} {s}: base surfaces the deciding passage, wave does not")

table = []
for c in cases:
    row = {'case': c['id']}
    for key in ['W-O', 'W-E', 'B-O', 'B-E']:
        ss = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'] if key.startswith('W') else ['S1', 'S2', 'S3', 'S4', 'S5', 'S7', 'S8', 'S9']
        row[key] = ''.join((s[1] if found[(key, c['id'], s)]['page'] else '.') + ('p' if found[(key, c['id'], s)]['passage'] else '') for s in ss)
    table.append(row)
# draft-first share (reported)
def draft_first(key):
    c = next(x for x in cases if 'draft_page' in x)
    s = surfaces(O[key], c['id']); out = {}
    for sn in ['S1', 'S2', 'S3']:
        t = s[sn]; i, j = t.find(c['draft_page']), t.find(c['deciding_page'])
        out[sn] = 'draft-first' if i >= 0 and (j < 0 or i < j) else ('executed-first' if j >= 0 else 'neither')
    return out
report = {'verdict': 'PASS' if not any(fails.values()) else 'FAIL', 'failures': {k: v for k, v in fails.items()}, 'found_table': table,
          'draft_first': {k: draft_first(k) for k in O}, 'owner_phrases': {k: O[k]['owner_phrases'] for k in O}, 'instructions_sha256': {k: O[k]['instructions_sha256'][:12] for k in O},
          'builds': {k: {'commit': O[k]['commit'], 'config': O[k]['config'], 'build_config': O[k]['build_config']} for k in O}}
json.dump(report, open('results/report.json', 'w'), indent=2)
print(report['verdict']); print(json.dumps(report['failures'], indent=1)[:4000])
print('legend: digit = surface Sn has the deciding page; p = deciding passage present')
for r in table: print(f"{r['case']:38s} W-O {r['W-O']:14s} W-E {r['W-E']:14s} B-O {r['B-O']:12s} B-E {r['B-E']}")
print(json.dumps(report['draft_first'])); print(report['owner_phrases'])
