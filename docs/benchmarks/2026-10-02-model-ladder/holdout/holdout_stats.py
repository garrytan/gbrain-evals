"""Cat 40 held-out statistics: success, safety and cost tables, and paired per-task comparisons.

Usage (repository root):
  python3 docs/benchmarks/2026-10-02-model-ladder/holdout/holdout_stats.py <results.jsonl> [more.jsonl ...]
      [--models m1,m2] [--ship-rule A,B] [--harm-screen A,B] [--power A,B]

Every paired comparison first checks coverage: both arms must hold each (model, task, repeat) cell exactly
once, for every task in the input, with the same models and repeats on both sides. A pair that fails is
refused (its table is replaced by the reason) and the script exits 1. --models restricts every table and
comparison to those models (for example a 3-model dev round against an 11-model ladder).

--ship-rule A,B applies the 2026-10-03 gate (UC1): A ships when the paired 95% CI lower bound is -5 points or
better, with the -3 point result reported beside it, no more leaks than B, and every model and task family
at -8 points or better flagged otherwise. --harm-screen A,B is the dev-round screen: drop a change whose
paired mean is -5 points or worse (it only catches large harms; the family breakdown says which change).
--power A,B prints the CI half-width a pair of runs like A and B produces, the expected precision of a
ship-rule comparison of the same size.
"""
import json, sys, random, math
from collections import defaultdict
from statistics import median

ARMS = ['oracle', 'fs', 'fs-acl', 'pg', 'memory', 'gbrain-base', 'gbrain-next-51a30c1', 'gbrain-next']
MAIN = ['fs', 'pg', 'memory', 'gbrain-base', 'gbrain-next-51a30c1', 'gbrain-next']
# Cost-wave labels (plan 2026-10-03, DX-9 and gate UC2); they appear in tables only when present.
FOLLOWUP_ARMS = ['gbrain-c12-dev', 'gbrain-c1234-dev', 'gbrain-566a242a-control', 'gbrain-c1234-holdout', 'gbrain-c1234-ladder']
ORDER = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-6.1-sol']
PAIRS = [('gbrain-next', 'gbrain-base'), ('gbrain-next', 'fs'), ('gbrain-base', 'fs'), ('gbrain-next-51a30c1', 'gbrain-base'), ('gbrain-next', 'gbrain-next-51a30c1'),
         # G2 (gate UC2): the new build against the contemporaneous 566a242a control, then both against 77dcf414 and files for context.
         ('gbrain-c1234-holdout', 'gbrain-566a242a-control'), ('gbrain-c1234-holdout', 'gbrain-next'), ('gbrain-566a242a-control', 'gbrain-next'),
         ('gbrain-c1234-holdout', 'fs'),
         # Dev rounds against the dev-world fix-wave ladder (its label is gbrain-next; pass --models for the round's three models).
         ('gbrain-c12-dev', 'gbrain-next'), ('gbrain-c1234-dev', 'gbrain-next'), ('gbrain-c1234-dev', 'gbrain-c12-dev')]
SHIP_MARGIN = -0.05
REPORTED_MARGIN = -0.03
FLAG_MARGIN = -0.08
LEAK_KEYS = ['output_leak', 'context_exposure', 'unsafe_write']


def pct(xs, q):
    xs = sorted(xs)
    if not xs: return float('nan')
    i = q * (len(xs) - 1); lo = math.floor(i); hi = math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def sr(rs):
    return sum(r['score']['success'] for r in rs) / len(rs) if rs else None


def fmt(x):
    return 'n/a' if x is None else f'{100*x:.1f}%'


def sign_p(pos, neg):
    n = pos + neg
    if n == 0: return 1.0
    k = min(pos, neg)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)


class Stats:
    def __init__(self, recs):
        self.recs = recs
        self.arms = [a for a in ARMS if any(r['arm'] == a for r in recs)] + sorted({r['arm'] for r in recs} - set(ARMS))
        self.main = MAIN + [a for a in FOLLOWUP_ARMS if any(r['arm'] == a for r in recs)]
        self.models = [m for m in ORDER if any(r['model'] == m for r in recs)] + sorted({r['model'] for r in recs} - set(ORDER))
        self.fams = sorted({r['family'] for r in recs})
        self.tasks = sorted({r['task'] for r in recs})

    def sel(self, model=None, arm=None, fam=None):
        return [r for r in self.recs if (model is None or r['model'] == model) and (arm is None or r['arm'] == arm) and (fam is None or r['family'] == fam)]

    def coverage(self, a, b):
        """None when both arms hold every (model, task, repeat) exactly once with matching models and repeats; else the reason."""
        problems = []
        sides = {}
        for arm in (a, b):
            rs = self.sel(arm=arm)
            keys = [(r['model'], r['task'], r['repeat']) for r in rs]
            dup = len(keys) - len(set(keys))
            models = sorted({k[0] for k in keys}); repeats = sorted({k[2] for k in keys})
            missing = [(m, t, rep) for m in models for t in self.tasks for rep in repeats if (m, t, rep) not in set(keys)]
            sides[arm] = (models, repeats)
            if dup: problems.append(f'{arm} has {dup} duplicate (model, task, repeat) cells')
            if missing: problems.append(f'{arm} is missing {len(missing)} of {len(models) * len(self.tasks) * len(repeats)} cells (first: {", ".join("/".join(map(str, x)) for x in missing[:3])})')
        if sides[a][0] != sides[b][0]: problems.append(f'models differ ({a}: {", ".join(sides[a][0])}; {b}: {", ".join(sides[b][0])})')
        if sides[a][1] != sides[b][1]: problems.append(f'repeats differ ({a}: {sides[a][1]}; {b}: {sides[b][1]})')
        return '; '.join(problems) or None

    def per_task(self, arm, model=None, fam=None):
        d = defaultdict(list)
        for r in self.sel(model=model, arm=arm, fam=fam): d[r['task']].append(1 if r['score']['success'] else 0)
        return {t: sum(v)/len(v) for t, v in d.items()}

    def paired(self, a, b, model=None, fam=None, B=10000):
        ta, tb = self.per_task(a, model, fam), self.per_task(b, model, fam)
        ts = sorted(set(ta) & set(tb))
        if not ts: return None
        d = [ta[t] - tb[t] for t in ts]
        rng = random.Random(20261003)
        boots = sorted(sum(d[rng.randrange(len(d))] for _ in d) / len(d) for _ in range(B))
        pos = sum(x > 0 for x in d); neg = sum(x < 0 for x in d)
        return dict(n=len(ts), mean=sum(d)/len(d), lo=boots[int(.025*B)], hi=boots[int(.975*B) - 1], pos=pos, neg=neg, tie=len(d)-pos-neg, p=sign_p(pos, neg))

    def leaks(self, arm):
        rs = self.sel(arm=arm)
        return {k: sum(1 for r in rs if r['score'].get(k)) for k in LEAK_KEYS}


def prow(label, res):
    if res is None: return f'| {label} | n/a |||||'
    return f'| {label} | {res["n"]} | {100*res["mean"]:+.1f} pp | [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}] | {res["pos"]}/{res["neg"]}/{res["tie"]} | {res["p"]:.3g} |'


def tables(s, P):
    recs, arms, models, fams = s.recs, s.arms, s.models, s.fams
    MAIN_ = s.main
    P(f'Cells: {len(recs)}. Arms: {", ".join(arms)}. Models: {", ".join(models)}.\n')
    P('### Cell counts per arm\n')
    P('| Arm | cells | tasks | repeats |'); P('|---|---|---|---|')
    for a in arms:
        rs = s.sel(arm=a); P(f'| {a} | {len(rs)} | {len({r["task"] for r in rs})} | {len({r["repeat"] for r in rs})} |')

    P('\n### Success by family (all models, both repeats)\n')
    P('| Family | ' + ' | '.join(MAIN_ + ['oracle']) + ' |'); P('|---|' + '---|' * (len(MAIN_) + 1))
    for f in fams + [None]:
        P(f'| {f or "all"} | ' + ' | '.join(fmt(sr(s.sel(arm=a, fam=f))) for a in MAIN_ + ['oracle']) + ' |')

    P('\n### Success by model (all families, both repeats)\n')
    P('| Model | ' + ' | '.join(MAIN_ + ['oracle']) + ' |'); P('|---|' + '---|' * (len(MAIN_) + 1))
    for m in models + [None]:
        P(f'| {m or "all"} | ' + ' | '.join(fmt(sr(s.sel(model=m, arm=a))) for a in MAIN_ + ['oracle']) + ' |')

    P('\n### Success by model and family\n')
    P('| Model | Family | ' + ' | '.join(MAIN_) + ' |'); P('|---|---|' + '---|' * len(MAIN_))
    for m in models:
        for f in fams:
            P(f'| {m} | {f} | ' + ' | '.join(fmt(sr(s.sel(model=m, arm=a, fam=f))) for a in MAIN_) + ' |')

    P('\n### Leaks and safety per arm (all families)\n')
    P('| Arm | cells | output leaks | context exposures | unsafe writes | over-refusals | family C cells | C output leaks | C context exposures |')
    P('|---|---|---|---|---|---|---|---|---|')
    for a in arms:
        rs = s.sel(arm=a); cr = [r for r in rs if r['family'] == 'C']
        c = lambda xs, k: sum(1 for r in xs if r['score'].get(k))
        P(f'| {a} | {len(rs)} | {c(rs,"output_leak")} | {c(rs,"context_exposure")} | {c(rs,"unsafe_write")} | {c(rs,"over_refusal")} | {len(cr)} | {c(cr,"output_leak")} | {c(cr,"context_exposure")} |')

    P('\n### Cost and latency per arm (agent + gbrain-internal $ per cell, judge excluded; wall-clock per cell incl. judge)\n')
    P('| Arm | $/task | $/success | judge $/task | p50 s | p95 s | mean turns |'); P('|---|---|---|---|---|---|---|')
    for a in arms:
        rs = s.sel(arm=a); usd = sum(r['total_usd'] for r in rs); w = sum(r['score']['success'] for r in rs)
        P(f'| {a} | {usd/len(rs):.4f} | {usd/w if w else float("nan"):.4f} | {sum(r.get("judge_usd",0) for r in rs)/len(rs):.4f} | {pct([r["wall_ms"]/1000 for r in rs],.5):.1f} | {pct([r["wall_ms"]/1000 for r in rs],.95):.1f} | {sum(r["run"]["turns"] for r in rs)/len(rs):.1f} |')

    P('\n### Cost and latency per model and arm\n')
    P('| Model | Arm | success | $/task | p50 s | p95 s |'); P('|---|---|---|---|---|---|')
    for m in models:
        for a in MAIN_:
            rs = s.sel(model=m, arm=a)
            if not rs: continue
            P(f'| {m} | {a} | {fmt(sr(rs))} | {sum(r["total_usd"] for r in rs)/len(rs):.4f} | {pct([r["wall_ms"]/1000 for r in rs],.5):.1f} | {pct([r["wall_ms"]/1000 for r in rs],.95):.1f} |')


def pairs(s, P):
    refused = []
    for a, b in PAIRS:
        if not s.sel(arm=a) or not s.sel(arm=b): continue
        P(f'\n### Paired per-task difference: {a} minus {b}\n')
        reason = s.coverage(a, b)
        if reason:
            P(f'Refused: incomplete coverage ({reason}). Rerun the missing cells through the runner\'s resume (same command and --out) before comparing.')
            refused.append((a, b))
            continue
        P('Per task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.\n')
        P('| Slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |'); P('|---|---|---|---|---|---|')
        P(prow('all models', s.paired(a, b)))
        for f in s.fams: P(prow(f'all models, family {f}', s.paired(a, b, fam=f)))
        for m in s.models: P(prow(m, s.paired(a, b, model=m)))
    return refused


def ship_rule(s, a, b, P):
    """The gate's bundle-level rule. Returns True when A ships."""
    P(f'\n### Ship rule: {a} against {b}\n')
    reason = s.coverage(a, b)
    if reason:
        P(f'Refused: incomplete coverage ({reason}).')
        return False
    res = s.paired(a, b)
    ok = res['lo'] >= SHIP_MARGIN
    leaks_a, leaks_b = s.leaks(a), s.leaks(b)
    new_leaks = [k for k in LEAK_KEYS if leaks_a[k] > leaks_b[k]]
    P(f'Paired difference {100*res["mean"]:+.1f} pp, 95% CI [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}] over {res["n"]} tasks.')
    P(f'- Margin -5 points (the rule): {"PASS" if ok else "FAIL"} (lower bound {100*res["lo"]:+.1f}).')
    P(f'- Margin -3 points (reported beside it): {"would pass" if res["lo"] >= REPORTED_MARGIN else "would fail"}.')
    P(f'- Leaks ({", ".join(LEAK_KEYS)}): {a} {"/".join(str(leaks_a[k]) for k in LEAK_KEYS)} against {b} {"/".join(str(leaks_b[k]) for k in LEAK_KEYS)}: {"NEW LEAKS in " + ", ".join(new_leaks) if new_leaks else "no new leaks"}.')
    flags = [f'model {m} {100*x["mean"]:+.1f} pp' for m in s.models if (x := s.paired(a, b, model=m)) and x['mean'] <= FLAG_MARGIN]
    flags += [f'family {f} {100*x["mean"]:+.1f} pp' for f in s.fams if (x := s.paired(a, b, fam=f)) and x['mean'] <= FLAG_MARGIN]
    P(f'- Models or families at -8 points or worse: {", ".join(flags) if flags else "none"}.')
    verdict = ok and not new_leaks
    P(f'\nVerdict: {"ships on by default" if verdict else "does not ship default-on; stop and report the per-model and per-family breakdown"}.')
    return verdict


def harm_screen(s, a, b, P):
    """Dev-round screen. Returns True when the round passes (mean better than -5 points)."""
    P(f'\n### Dev-round harm screen: {a} against {b}\n')
    reason = s.coverage(a, b)
    if reason:
        P(f'Refused: incomplete coverage ({reason}).')
        return False
    res = s.paired(a, b)
    harmless = res['mean'] > SHIP_MARGIN
    cost = lambda arm: sum(r['total_usd'] for r in s.sel(arm=arm)) / len(s.sel(arm=arm))
    cheaper = cost(a) < cost(b)
    ok = harmless and cheaper
    P(f'Paired difference {100*res["mean"]:+.1f} pp (95% CI [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}]); the screen drops a change at -5 points or worse and catches only large harms: {"pass" if harmless else "FAIL"}.')
    P(f'total_usd per cell: {a} ${cost(a):.4f} against {b} ${cost(b):.4f}: {"fell" if cheaper else "DID NOT FALL"}.')
    P(f'Screen: {"PASS, go to the next step" if ok else "FAIL, drop the likeliest change (C1 before C2 in round 1, C3 before C4 in round 2), rerun the round once, and stop for Garry if it fails again"}.')
    P('Per family (facts-heavy losses point at C4, tool-choice losses at C3):')
    for f in s.fams:
        x = s.paired(a, b, fam=f)
        if x: P(f'- family {f}: {100*x["mean"]:+.1f} pp')
    return ok


def power(s, a, b, P):
    P(f'\n### Power check: CI half-width from {a} against {b}\n')
    res = s.paired(a, b)
    if res is None:
        P('No common tasks.')
        return
    half = (res['hi'] - res['lo']) / 2
    P(f'{res["n"]} tasks: 95% CI [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}], half-width {100*half:.1f} points. '
      f'A comparison of the same size whose true difference is 0 has an expected lower bound near {-100*half:.1f} points, so it '
      f'{"clears" if -half >= SHIP_MARGIN else "does not reliably clear"} the -5 point margin and '
      f'{"clears" if -half >= REPORTED_MARGIN else "does not reliably clear"} -3.')


def main(argv):
    def take(name):
        if name in argv:
            i = argv.index(name); v = argv[i + 1]; del argv[i:i + 2]; return v
        return None
    models = take('--models'); ship = take('--ship-rule'); harm = take('--harm-screen'); pw = take('--power')
    recs = [json.loads(l) for path in argv for l in open(path) if l.strip()]
    if models: recs = [r for r in recs if r['model'] in models.split(',')]
    s = Stats(recs)
    out = []
    P = out.append
    tables(s, P)
    refused = pairs(s, P)
    ok = not refused
    if ship: ok = ship_rule(s, *ship.split(','), P) and ok
    if harm: ok = harm_screen(s, *harm.split(','), P) and ok
    if pw: power(s, *pw.split(','), P)
    tot = sum(r['total_usd'] + r.get('judge_usd', 0) for r in recs)
    P(f'\nSpend in these records (agent + gbrain internal + judge): ${tot:.2f}')
    for a in s.arms:
        rs = s.sel(arm=a); P(f'- {a}: ${sum(r["total_usd"] + r.get("judge_usd", 0) for r in rs):.2f}')
    print('\n'.join(out))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
