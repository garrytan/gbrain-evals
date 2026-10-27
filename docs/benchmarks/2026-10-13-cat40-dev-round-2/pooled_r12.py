"""Pooled rounds 1+2 for the full-family arms (control, all-on, f5) on World M. Each arm-vs-control difference pairs cells
by (round, model, task); intervals are percentile bootstraps resampling tasks (all rounds and models of a task move
together), 4,000 resamples. Per-item arms stay single-round (round 1 record). Counts only."""
import json, os, random, collections, sys
BASE = os.path.expanduser('~/.capy/work/devprep')
ROUNDS = [r for r in ('r1', 'r2') if os.path.exists(f'{BASE}/{r}-out/{r}/control/attempts.jsonl')]
ARMS = ['control', 'all-on', 'f5']; MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']; FAMS = ['H1', 'H2', 'H3', 'H4', 'H5']
def canon(path):
    out = {}
    for l in open(path):
        r = json.loads(l)
        if r['stop'] != 'harness_error': out[(r['model'], r['task'])] = r
    return out
C = {(rd, a): canon(f'{BASE}/{rd}-out/{rd}/{a}/attempts.jsonl') for rd in ROUNDS for a in ARMS}
fam = {k[1]: r['family'] for k, r in C[(ROUNDS[0], 'control')].items()}
def cells(a, sel):
    return {(rd, m, t): C[(rd, a)][(m, t)] for rd in ROUNDS for (m, t) in C[(rd, a)] if sel(m, t)}
def metric(r, what): return r['score']['success'] if what == 'success' else int(bool(r['score'].get('said_wrong')))
def compare(a, sel, what, iters=4000, seed=11):
    A, B = cells(a, sel), cells('control', sel); keys = sorted(set(A) & set(B))
    by = collections.defaultdict(list)
    for k in keys: by[k[2]].append(k)
    tasks = sorted(by); rnd = random.Random(seed)
    def d(ts):
        ks = [k for t in ts for k in by[t]]
        return (sum(metric(A[k], what) for k in ks) - sum(metric(B[k], what) for k in ks)) / len(ks) * 100
    pt = d(tasks); bs = sorted(d([rnd.choice(tasks) for _ in tasks]) for _ in range(iters))
    return {'n': len(keys), 'arm': sum(metric(A[k], what) for k in keys), 'control': sum(metric(B[k], what) for k in keys),
            'delta_pp': round(pt, 1), 'ci95': [round(bs[int(.025 * iters)], 1), round(bs[int(.975 * iters)], 1)]}
out = {'rounds': ROUNDS, 'per_round_success': {f'{rd}:{a}': sum(r['score']['success'] for r in C[(rd, a)].values()) for rd in ROUNDS for a in ARMS}}
for a in ('all-on', 'f5'):
    o = out[a] = {}
    for what in ('success', 'wrong_value'):
        o[what] = {'all': compare(a, lambda m, t: True, what)}
        for m in MODELS: o[what][m] = compare(a, lambda mm, t, m=m: mm == m, what)
        for f in FAMS: o[what][f] = compare(a, lambda m, t, f=f: fam[t] == f, what)
json.dump(out, open(f'{BASE}/pooled-r12.json', 'w'), indent=1)
print('rounds', ROUNDS, out['per_round_success'])
for a in ('all-on', 'f5'):
    for what in ('success', 'wrong_value'):
        print(f'{a} {what}:')
        for k, v in out[a][what].items(): print(f"  {k:18s} n{v['n']:4d} arm {v['arm']:4d} ctl {v['control']:4d}  d {v['delta_pp']:+5.1f} pp [{v['ci95'][0]:+.1f}, {v['ci95'][1]:+.1f}]")
