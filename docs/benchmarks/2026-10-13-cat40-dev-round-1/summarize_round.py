"""Round 1 per-arm results on World M: canonical cells (last harness-clean attempt per key), paired with control on the arm's tasks,
plus the recorded #93 M fs and gbrain cells as references. Counts only; no world values."""
import json, collections, os, random
import sys
RND = sys.argv[1] if len(sys.argv) > 1 else 'r1'
R = os.path.expanduser(f'~/.capy/work/devprep/{RND}-out/{RND}')
REF = os.path.expanduser('~/.capy/work/confirm/main/cells/attempts.jsonl')
MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']
def canon(rows):
    out = {}
    for r in rows:
        if r['stop'] == 'harness_error': continue
        out[(r['model'], r['task'])] = r
    return out
def load(arm): return canon(json.loads(l) for l in open(f'{R}/{arm}/attempts.jsonl'))
arms = [a for a in ['control', 'all-on', 'f5', 'f1', 'f1-no-names-row', 'f2', 'f4'] if os.path.exists(f'{R}/{a}/attempts.jsonl')]
A = {a: load(a) for a in arms}
ref_rows = [json.loads(l) for l in open(REF)]
REFS = {'fs (#93)': canon(r for r in ref_rows if r['arm'] == 'fs'), 'gbrain (#93, 3e4ff61c)': canon(r for r in ref_rows if r['arm'] == 'gbrain-hard')}
def stats(cells, keys):
    c = [cells[k] for k in keys if k in cells]
    n = len(c); s = sum(r['score']['success'] for r in c); w = sum(bool(r['score'].get('said_wrong')) for r in c)
    ns = sum(not r['score'].get('submitted', True) for r in c); usd = sum(r.get('total_usd', 0) for r in c)
    return {'n': n, 'success': s, 'wrong_value': w, 'not_submitted': ns, 'usd': round(usd, 2)}
def boot(a_cells, b_cells, keys, iters=4000, seed=7):
    tasks = sorted({k[1] for k in keys}); rnd = random.Random(seed)
    by = collections.defaultdict(list)
    for k in keys: by[k[1]].append(k)
    def diff(ts):
        ks = [k for t in ts for k in by[t]]
        return (sum(a_cells[k]['score']['success'] for k in ks) - sum(b_cells[k]['score']['success'] for k in ks)) / len(ks) * 100
    point = diff(tasks); ds = sorted(diff([rnd.choice(tasks) for _ in tasks]) for _ in range(iters))
    return round(point, 1), round(ds[int(.025 * iters)], 1), round(ds[int(.975 * iters)], 1)
out = {}
for a in arms:
    keys = sorted(A[a].keys())
    fam = lambda f: [k for k in keys if A[a][k]['family'] == f]
    longk = [k for k in keys if A[a][k]['family'] == 'H4' and '+long' in A[a][k]['variant']]
    row = {'all': stats(A[a], keys), 'by_model': {m: stats(A[a], [k for k in keys if k[0] == m]) for m in MODELS},
           'by_family': {f: stats(A[a], fam(f)) for f in ['H1', 'H2', 'H3', 'H4', 'H5'] if fam(f)},
           'H4_long': stats(A[a], longk), 'H4_not_long': stats(A[a], [k for k in fam('H4') if k not in longk]),
           'control_same_tasks': stats(A['control'], keys), 'control_H4_long': stats(A['control'], longk),
           'fs93_same_tasks': stats(REFS['fs (#93)'], keys), 'gbrain93_same_tasks': stats(REFS['gbrain (#93, 3e4ff61c)'], keys)}
    if a != 'control':
        row['vs_control_pp'] = boot(A[a], A['control'], keys)
        row['vs_control_wrong'] = row['all']['wrong_value'] - row['control_same_tasks']['wrong_value']
        row['vs_control_by_model_success'] = {m: row['by_model'][m]['success'] - stats(A['control'], [k for k in keys if k[0] == m])['success'] for m in MODELS}
    row['vs_fs93_pp'] = boot(A[a], REFS['fs (#93)'], keys)
    out[a] = row
json.dump(out, open(os.path.expanduser(f'~/.capy/work/devprep/{RND}-summary.json'), 'w'), indent=1)
print(f"{'arm':16s} {'scope':6s} {'succ':>9s} {'ctrl':>9s} {'d_ctrl pp [95%]':>22s} {'wrong':>5s} {'ctrlW':>5s} {'nosub':>5s} {'H4long':>8s} {'ctlH4L':>7s} {'fs93':>8s} {'d_fs93 pp':>20s} {'usd':>7s}")
for a, r in out.items():
    n = r['all']['n']
    print(f"{a:16s} {'full' if n == 300 else 'H2-H4':6s} {r['all']['success']:4d}/{n:<4d} {r['control_same_tasks']['success']:4d}/{n:<4d} {str(r.get('vs_control_pp', '')):>22s} {r['all']['wrong_value']:5d} {r['control_same_tasks']['wrong_value']:5d} {r['all']['not_submitted']:5d} "
          f"{r['H4_long']['success']:3d}/{r['H4_long']['n']:<4d} {r['control_H4_long']['success']:3d}/{r['control_H4_long']['n']:<3d} {r['fs93_same_tasks']['success']:4d}/{n:<3d} {str(r['vs_fs93_pp']):>20s} {r['all']['usd']:7.2f}")
print()
for a, r in out.items(): print(a, 'by model success', {m.split('-')[1] if 'claude' in m else 'sol': f"{v['success']}/{v['n']} w{v['wrong_value']}" for m, v in r['by_model'].items()}, 'vs control', r.get('vs_control_by_model_success'))
print()
for a, r in out.items(): print(a, 'by family', {f: f"{v['success']}/{v['n']} w{v['wrong_value']}" for f, v in r['by_family'].items()})
