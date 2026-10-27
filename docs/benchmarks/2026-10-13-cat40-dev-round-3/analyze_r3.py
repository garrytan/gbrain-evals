"""Round 3 (all-on-no-f5) diagnostic, as declared in docs/benchmarks/2026-10-13-cat40-dev-round-3/DECLARATION.md.
Pairs by (model, task); the reference value per pair is the mean of the round 1 and round 2 cells of the reference arm
(pooled control, pooled all-on). Percentile bootstrap over tasks, 4,000 resamples, seed 11. Counts only."""
import json, os, random, collections, re
BASE = os.path.expanduser('~/.capy/work/devprep')
MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']
def canon(path):
    out = {}
    for l in open(path):
        r = json.loads(l)
        if r['stop'] != 'harness_error': out[(r['model'], r['task'])] = r
    return out
arm = canon(f'{BASE}/r3-out/r3/all-on-no-f5/attempts.jsonl')
ref = {a: [canon(f'{BASE}/{rd}-out/{rd}/{a}/attempts.jsonl') for rd in ('r1', 'r2')] for a in ('control', 'all-on')}
fam = {k[1]: r['family'] for k, r in arm.items()}
var = {k[1]: r['variant'] for k, r in arm.items()}
M = {'success': lambda r: float(r['score']['success']), 'wrong_value': lambda r: float(bool(r['score'].get('said_wrong'))), 'not_submitted': lambda r: float(not r['score'].get('submitted'))}
def comp(refarm, what, sel, iters=4000, seed=11):
    f = M[what]; keys = sorted(k for k in arm if sel(*k) and all(k in c for c in ref[refarm]))
    by = collections.defaultdict(list)
    for k in keys: by[k[1]].append(k)
    tasks = sorted(by); rnd = random.Random(seed)
    a = {k: f(arm[k]) for k in keys}; b = {k: sum(f(c[k]) for c in ref[refarm]) / 2 for k in keys}
    def d(ts):
        ks = [k for t in ts for k in by[t]]; return (sum(a[k] for k in ks) - sum(b[k] for k in ks)) / len(ks) * 100
    pt = d(tasks); bs = sorted(d([rnd.choice(tasks) for _ in tasks]) for _ in range(iters))
    return {'n': len(keys), 'arm': sum(a.values()), 'ref_mean': round(sum(b.values()), 1), 'delta_pp': round(pt, 1), 'ci95': [round(bs[int(.025 * iters)], 1), round(bs[int(.975 * iters)], 1)]}
slices = [('all', lambda m, t: True)] + [(f, lambda m, t, f=f: fam[t] == f) for f in ['H1', 'H2', 'H3', 'H4', 'H5']] + \
         [('H4+long', lambda m, t: fam[t] == 'H4' and '+long' in var[t]), ('H4 not long', lambda m, t: fam[t] == 'H4' and '+long' not in var[t])] + [(m, lambda mm, t, m=m: mm == m) for m in MODELS]
out = {}
for refarm in ('control', 'all-on'):
    for what in M:
        for name, sel in slices: out[f'{refarm}|{what}|{name}'] = comp(refarm, what, sel)
c2 = out['all-on|success|all']; w2 = out['all-on|wrong_value|all']
out['clearly_worse_than_all_on'] = c2['ci95'][1] < 0 or w2['ci95'][0] > 0
json.dump(out, open(f'{BASE}/r3-analysis.json', 'w'), indent=1)
for refarm in ('control', 'all-on'):
    for what in M:
        print(f'== vs pooled {refarm}: {what}')
        for name, _ in slices:
            v = out[f'{refarm}|{what}|{name}']; print(f"  {name:18s} n{v['n']:4d} arm {v['arm']:5.0f} ref {v['ref_mean']:6.1f}  d {v['delta_pp']:+5.1f} [{v['ci95'][0]:+.1f}, {v['ci95'][1]:+.1f}]")
print('clearly worse than all-on:', out['clearly_worse_than_all_on'])

# Draft-first (settled definition, as draft_first.py): draft-led H4 tasks, firing on served names rows, harm vs pooled refs.
w = json.load(open(os.path.expanduser('~/.capy/work/mworld/world/world.json')))
docs = {d['id']: d for d in w['docs']}
forms = collections.defaultdict(lambda: collections.defaultdict(set))
for r in w['references']: forms[r['doc']][r['entity']].add(r['form'])
acc = collections.defaultdict(dict)
for dd, m_ in forms.items():
    if dd in docs and docs[dd]['type'] in ('contract', 'amendment'):
        for a_, fs_ in m_.items(): acc[a_][dd] = fs_
listed = lambda a_: sorted([x for x, fs_ in acc[a_].items() if fs_ & {'name', 'code', 'nickname'}], key=lambda x: (docs[x]['date'], x), reverse=True)
is_draft = lambda d: docs[d]['type'] == 'amendment' and docs[d]['title'].startswith('DRAFT')
draft_tasks = {t['id'] for t in w['tasks'] if t['family'] == 'H4' and any((L := listed(it['account'])) and is_draft(L[0]) for it in t['gold']['items'])}
assert len(draft_tasks) == 15, len(draft_tasks)
ids = {r['attempt_id']: k for k, r in arm.items()}
fire = collections.Counter(); served = set()
for l in open(f'{BASE}/r3-out/r3/all-on-no-f5/transcripts.jsonl'):
    tr = json.loads(l); k = ids.get(tr['attempt_id'])
    if not k or fam[k[1]] != 'H4': continue
    for tool in tr['tools']:
        if tool['name'] != 'entity' or not isinstance(tool['args'].get('names'), list): continue
        try: js = json.loads(tool['result'][:tool['result'].rfind('}') + 1])
        except Exception: continue
        stack = [x for x in js.get('results', []) if isinstance(x, dict)]
        while stack:
            row = stack.pop(); stack += [s for s in row.get('siblings', []) or [] if isinstance(s, dict)]
            flat = [x for g in row.get('records', []) or [] if isinstance(g, dict) for x in g.get('rows', []) or []]
            if not flat: continue
            isd = ['draft' in str(x.get('title', '')).lower() for x in flat]
            fire['rows_with_records'] += 1
            if any(isd):
                fire['rows_with_draft'] += 1
                if isd.index(True) < (isd.index(False) if False in isd else len(isd)): fire['draft_first'] += 1
            if isd[0]: served.add(k)
fire['cells_served_draft_first'] = len(served); fire['served_on_draft_tasks'] = sum(k[1] in draft_tasks for k in served)
out['draft_first'] = {'firing': dict(fire)}
for refarm in ('control', 'all-on'):
    for what in ('wrong_value', 'success'):
        out['draft_first'][f'draft_tasks|{refarm}|{what}'] = comp(refarm, what, lambda m, t: t in draft_tasks)
        out['draft_first'][f'served_cells|{refarm}|{what}'] = comp(refarm, what, lambda m, t: (m, t) in served)
json.dump(out, open(f'{BASE}/r3-analysis.json', 'w'), indent=1)
print('draft-first firing', dict(fire))
for k, v in out['draft_first'].items():
    if k != 'firing': print(' ', k, v)
