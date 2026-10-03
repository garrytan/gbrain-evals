import json, sys, random, math
from collections import defaultdict
from statistics import median

path = sys.argv[1]
recs = [json.loads(l) for l in open(path) if l.strip()]
ARMS = ['oracle', 'fs', 'fs-acl', 'pg', 'memory', 'gbrain-base', 'gbrain-next-51a30c1', 'gbrain-next']
MAIN = ['fs', 'pg', 'memory', 'gbrain-base', 'gbrain-next-51a30c1', 'gbrain-next']
arms = [a for a in ARMS if any(r['arm'] == a for r in recs)] + sorted({r['arm'] for r in recs} - set(ARMS))
ORDER = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-6.1-sol']
models = [m for m in ORDER if any(r['model'] == m for r in recs)] + sorted({r['model'] for r in recs} - set(ORDER))
fams = sorted({r['family'] for r in recs})
out = []
P = out.append

def pct(xs, q):
    xs = sorted(xs)
    if not xs: return float('nan')
    i = q * (len(xs) - 1); lo = math.floor(i); hi = math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)

def sr(rs):
    return sum(r['score']['success'] for r in rs) / len(rs) if rs else None

def fmt(x):
    return 'n/a' if x is None else f'{100*x:.1f}%'

by = defaultdict(list)
for r in recs: by[(r['model'], r['arm'], r['family'])].append(r)
def sel(model=None, arm=None, fam=None):
    return [r for r in recs if (model is None or r['model'] == model) and (arm is None or r['arm'] == arm) and (fam is None or r['family'] == fam)]

P(f'Cells: {len(recs)}. Arms: {", ".join(arms)}. Models: {", ".join(models)}.\n')
P('### Cell counts per arm\n')
P('| Arm | cells | tasks | repeats |'); P('|---|---|---|---|')
for a in arms:
    rs = sel(arm=a); P(f'| {a} | {len(rs)} | {len({r["task"] for r in rs})} | {len({r["repeat"] for r in rs})} |')

P('\n### Success by family (all models, both repeats)\n')
P('| Family | ' + ' | '.join(MAIN + ['oracle']) + ' |'); P('|---|' + '---|' * (len(MAIN) + 1))
for f in fams + [None]:
    P(f'| {f or "all"} | ' + ' | '.join(fmt(sr(sel(arm=a, fam=f))) for a in MAIN + ['oracle']) + ' |')

P('\n### Success by model (all families, both repeats)\n')
P('| Model | ' + ' | '.join(MAIN + ['oracle']) + ' |'); P('|---|' + '---|' * (len(MAIN) + 1))
for m in models + [None]:
    P(f'| {m or "all"} | ' + ' | '.join(fmt(sr(sel(model=m, arm=a))) for a in MAIN + ['oracle']) + ' |')

P('\n### Success by model and family\n')
P('| Model | Family | ' + ' | '.join(MAIN) + ' |'); P('|---|---|' + '---|' * len(MAIN))
for m in models:
    for f in fams:
        P(f'| {m} | {f} | ' + ' | '.join(fmt(sr(sel(model=m, arm=a, fam=f))) for a in MAIN) + ' |')

P('\n### Leaks and safety per arm (all families)\n')
P('| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |')
P('|---|---|---|---|---|---|---|---|---|')
for a in arms:
    rs = sel(arm=a); cr = [r for r in rs if r['family'] == 'C']
    c = lambda xs, k: sum(1 for r in xs if r['score'].get(k))
    P(f'| {a} | {len(rs)} | {c(rs,"output_leak")} | {c(rs,"context_exposure")} | {c(rs,"unsafe_write")} | {c(rs,"over_refusal")} | {len(cr)} | {c(cr,"output_leak")} | {c(cr,"context_exposure")} |')

P('\n### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)\n')
P('| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |'); P('|---|---|---|---|---|---|---|')
for a in arms:
    rs = sel(arm=a); usd = sum(r['total_usd'] for r in rs); w = sum(r['score']['success'] for r in rs)
    P(f'| {a} | {usd/len(rs):.4f} | {usd/w if w else float("nan"):.4f} | {sum(r.get("judge_usd",0) for r in rs)/len(rs):.4f} | {pct([r["wall_ms"]/1000 for r in rs],.5):.1f} | {pct([r["wall_ms"]/1000 for r in rs],.95):.1f} | {sum(r["run"]["turns"] for r in rs)/len(rs):.1f} |')

P('\n### Cost and latency per model and arm\n')
P('| Model | Arm | success | $/task | p50 s | p95 s |'); P('|---|---|---|---|---|---|')
for m in models:
    for a in MAIN:
        rs = sel(model=m, arm=a)
        if not rs: continue
        P(f'| {m} | {a} | {fmt(sr(rs))} | {sum(r["total_usd"] for r in rs)/len(rs):.4f} | {pct([r["wall_ms"]/1000 for r in rs],.5):.1f} | {pct([r["wall_ms"]/1000 for r in rs],.95):.1f} |')

def per_task(arm, model=None, fam=None):
    d = defaultdict(list)
    for r in sel(model=model, arm=arm, fam=fam): d[r['task']].append(1 if r['score']['success'] else 0)
    return {t: sum(v)/len(v) for t, v in d.items()}

def sign_p(pos, neg):
    n = pos + neg
    if n == 0: return 1.0
    k = min(pos, neg)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)

def paired(a, b, model=None, fam=None, B=10000):
    ta, tb = per_task(a, model, fam), per_task(b, model, fam)
    ts = sorted(set(ta) & set(tb))
    if not ts: return None
    d = [ta[t] - tb[t] for t in ts]
    rng = random.Random(20261003)
    boots = sorted(sum(d[rng.randrange(len(d))] for _ in d) / len(d) for _ in range(B))
    pos = sum(x > 0 for x in d); neg = sum(x < 0 for x in d)
    return dict(n=len(ts), mean=sum(d)/len(d), lo=boots[int(.025*B)], hi=boots[int(.975*B) - 1], pos=pos, neg=neg, tie=len(d)-pos-neg, p=sign_p(pos, neg))

def prow(label, res):
    if res is None: return f'| {label} | n/a |||||'
    return f'| {label} | {res["n"]} | {100*res["mean"]:+.1f} pp | [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}] | {res["pos"]}/{res["neg"]}/{res["tie"]} | {res["p"]:.3g} |'

for a, b in [('gbrain-next', 'gbrain-base'), ('gbrain-next', 'fs'), ('gbrain-base', 'fs'), ('gbrain-next-51a30c1', 'gbrain-base'), ('gbrain-next', 'gbrain-next-51a30c1')]:
    if not sel(arm=a) or not sel(arm=b): continue
    P(f'\n### Paired per-task difference: {a} minus {b}\n')
    P('Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.\n')
    P('| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |'); P('|---|---|---|---|---|---|')
    P(prow('all models', paired(a, b)))
    for f in fams: P(prow(f'all models, family {f}', paired(a, b, fam=f)))
    for m in models: P(prow(m, paired(a, b, model=m)))

tot = sum(r['total_usd'] + r.get('judge_usd', 0) for r in recs)
P(f'\nSpend in these records (agent + gbrain internal + judge): ${tot:.2f}')
for a in arms:
    rs = sel(arm=a); P(f'- {a}: ${sum(r["total_usd"] + r.get("judge_usd", 0) for r in rs):.2f}')
print('\n'.join(out))
