"""F5 d1b gate on development data (World M, rounds 1+2): seen share of needed owner-phrase documents and per-family
success, arm vs the same-build all-off control, paired by (round, model, task); task-clustered percentile bootstrap.
Needed owner-phrase documents (PLAN line 109): gold evidence documents that reference an entity only in the owner
('manager') form; on M this gives H1 30, H2 13, H3 25, H4 19. Seen: the document's slug appears in any whole tool
result of the cell (dev-harness transcripts carry whole results; 0 calls were truncated before the model saw them).
Counts only; no world values."""
import json, os, re, random, collections
BASE = os.path.expanduser('~/.capy/work/devprep')
w = json.load(open(os.path.expanduser('~/.capy/work/mworld/world/world.json')))
forms = collections.defaultdict(lambda: collections.defaultdict(set))
for r in w['references']: forms[r['doc']][r['entity']].add(r['form'])
needed = {t['id']: [d for d in t['gold']['evidence'] if any(v == {'manager'} for v in forms.get(d, {}).values())] for t in w['tasks']}
fam = {t['id']: t['family'] for t in w['tasks']}
nd = collections.Counter(); [nd.update({fam[t]: len(v)}) for t, v in needed.items()]
assert dict(nd) == {'H1': 30, 'H2': 13, 'H3': 25, 'H4': 19, 'H5': 0} or {k: v for k, v in nd.items() if v} == {'H1': 30, 'H2': 13, 'H3': 25, 'H4': 19}, nd
ROUNDS = ['r1', 'r2']; ARMS = ['control', 'f5', 'all-on']; MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']
cells = {}
for rd in ROUNDS:
    for a in ARMS:
        canon = {}
        for l in open(f'{BASE}/{rd}-out/{rd}/{a}/attempts.jsonl'):
            r = json.loads(l)
            if r['stop'] != 'harness_error': canon[(r['model'], r['task'])] = r
        ids = {r['attempt_id']: k for k, r in canon.items()}
        seen = {}
        for l in open(f'{BASE}/{rd}-out/{rd}/{a}/transcripts.jsonl'):
            tr = json.loads(l); k = ids.get(tr['attempt_id'])
            if k is None: continue
            need = needed[k[1]]
            if not need: seen[k] = []; continue
            text = '\n'.join(x['result'] for x in tr['tools'])
            seen[k] = [d for d in need if re.search(re.escape(d) + r'(?![\w/.-])', text)]
        for k, r in canon.items():
            cells[(rd, a, k[0], k[1])] = {'success': r['score']['success'], 'wrong': int(bool(r['score'].get('said_wrong'))), 'seen': len(seen.get(k, [])), 'need': len(needed[k[1]]), 'has_transcript': k in seen}
missing = sum(1 for c in cells.values() if not c['has_transcript']); assert missing == 0, missing
def pair(a, sel, rounds=tuple(ROUNDS)):
    keys = sorted({(rd, m, t) for (rd, aa, m, t) in cells if aa == a and rd in rounds and sel(m, t) and (rd, 'control', m, t) in cells})
    return keys
def boot(a, sel, num, den, iters=4000, seed=17, rounds=tuple(ROUNDS)):
    keys = pair(a, sel, rounds); by = collections.defaultdict(list)
    for k in keys: by[k[2]].append(k)
    tasks = sorted(by); rnd = random.Random(seed)
    def val(arm, ks):
        n = sum(den(cells[(k[0], arm, k[1], k[2])]) for k in ks)
        return sum(num(cells[(k[0], arm, k[1], k[2])]) for k in ks) / n * 100 if n else 0.0
    def d(ts):
        ks = [k for t in ts for k in by[t]]; return val(a, ks) - val('control', ks)
    pt = d(tasks); bs = sorted(d([rnd.choice(tasks) for _ in tasks]) for _ in range(iters))
    ks = keys
    return {'cells': len(ks), 'tasks': len(tasks), 'arm_num': sum(num(cells[(k[0], a, k[1], k[2])]) for k in ks), 'ctl_num': sum(num(cells[(k[0], 'control', k[1], k[2])]) for k in ks),
            'den': sum(den(cells[(k[0], a, k[1], k[2])]) for k in ks), 'arm_pct': round(val(a, ks), 1), 'ctl_pct': round(val('control', ks), 1),
            'delta_pp': round(pt, 1), 'ci95': [round(bs[int(.025 * iters)], 1), round(bs[int(.975 * iters)], 1)]}
def cellpairs(a, sel, rounds=tuple(ROUNDS)):
    """Per-cell sign counts of the seen-share change (cells with needed docs): arm better / worse / tied."""
    up = dn = tie = 0
    for k in pair(a, sel, rounds):
        c, x = cells[(k[0], 'control', k[1], k[2])], cells[(k[0], a, k[1], k[2])]
        if not c['need']: continue
        up += x['seen'] > c['seen']; dn += x['seen'] < c['seen']; tie += x['seen'] == c['seen']
    return {'better': up, 'worse': dn, 'tied': tie}
seen_num = lambda c: c['seen']; seen_den = lambda c: c['need']; succ = lambda c: c['success']; one = lambda c: 1; wrong = lambda c: c['wrong']
out = {'needed_docs_per_task_family': {k: v for k, v in nd.items() if v}, 'rounds': ROUNDS}
for a in ('f5', 'all-on'):
    o = out[a] = {'seen_share': {}, 'seen_signs': {}, 'success': {}, 'wrong_value': {}}
    slices = [('all', lambda m, t: True)] + [(f, lambda m, t, f=f: fam[t] == f) for f in ['H1', 'H2', 'H3', 'H4', 'H5']] + [(m, lambda mm, t, m=m: mm == m) for m in MODELS]
    for name, sel in slices:
        if name != 'H5': o['seen_share'][name] = boot(a, sel, seen_num, seen_den); o['seen_signs'][name] = cellpairs(a, sel)
        o['success'][name] = boot(a, sel, succ, one); o['wrong_value'][name] = boot(a, sel, wrong, one)
    o['seen_share']['H1-H3'] = boot(a, lambda m, t: fam[t] in ('H1', 'H2', 'H3'), seen_num, seen_den); o['seen_signs']['H1-H3'] = cellpairs(a, lambda m, t: fam[t] in ('H1', 'H2', 'H3'))
    for rd in ROUNDS:
        o['seen_share'][f'round {rd}'] = boot(a, lambda m, t: True, seen_num, seen_den, rounds=(rd,)); o['seen_signs'][f'round {rd}'] = cellpairs(a, lambda m, t: True, rounds=(rd,))
    from math import comb
    for k, sg in o['seen_signs'].items():
        n = sg['better'] + sg['worse']; x = min(sg['better'], sg['worse'])
        sg['sign_test_p_two_sided'] = round(min(1.0, 2 * sum(comb(n, i) for i in range(x + 1)) / 2 ** n), 4) if n else None
json.dump(out, open(f'{BASE}/d1b/d1b.json', 'w'), indent=1)
for a in ('f5', 'all-on'):
    print(f'== {a} vs control: seen share of needed owner-phrase docs')
    for k, v in out[a]['seen_share'].items():
        if v: print(f"  {k:18s} den {v['den']:4d} arm {v['arm_num']:4d} ({v['arm_pct']:5.1f}%) ctl {v['ctl_num']:4d} ({v['ctl_pct']:5.1f}%)  d {v['delta_pp']:+5.1f} [{v['ci95'][0]:+.1f}, {v['ci95'][1]:+.1f}]  signs {out[a]['seen_signs'][k]}")
    print(f'== {a} vs control: success by family / model')
    for k, v in out[a]['success'].items(): print(f"  {k:18s} n {v['cells']:4d} {v['arm_num']:4d} vs {v['ctl_num']:4d}  d {v['delta_pp']:+5.1f} [{v['ci95'][0]:+.1f}, {v['ci95'][1]:+.1f}]")
