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

Since the 2026-10-04 entity-recall plan, the ship rule's leak check is per cell: A fails when any
(model, task, repeat, leak kind) cell leaks under A and not under B, even if the totals are equal. Aggregate
counts are still printed. Further modes (plan 2026-10-04-cat40-entity-recall; the preregistration in
docs/benchmarks/2026-10-02-model-ladder/entity-recall/PREREGISTRATION.md names the exact invocations):
  --choose-comparator a,b,c   the preregistered comparator: the arm with the best pooled success, ties broken by
                              lower cost per task (agent plus gbrain-internal dollars, judge excluded)
  --headline A,B              the Cat 40 headline: A against comparator B, pooled, per model and per family, with
                              the preregistered sentence for a win (CI above 0), tie (CI spans 0) or loss (CI below 0);
                              then A against every other simple arm present (fs-acl on family C only) and cost per
                              task and per successful task
  --capability-screen A,B     the dev-round harm screen of gate T2: pass when the pooled paired difference is better
                              than -5 points; families at -10 points or worse are flagged, not gated; cost reported
  --default-on A,B            gate T3: A is default-on when the ship rule passes against B, the family-E paired point
                              difference is above 0 and cost per task rises at most 25%

Cat 40 Hard (plan docs/plans/2026-10-05-cat40-hard/PLAN.md). The script reads v1 records and v2 records
(schema cat40-cell-v2, from attempts.jsonl or results.jsonl). For v2, the cell is the last harness-clean attempt
per key in `attempt` order (a duplicated attempt_id counts once), its total_usd and judge_usd are summed over every
attempt of the key (retries included), and the family is the record's family field. Retries per model and arm and
keys with no harness-clean attempt are printed. On Hard input, models are listed with the ones people use most
first. v1 input is read and reported exactly as before.
  --hard-comparator a,b,c     the Hard comparator (CEO-F10): the best pooled simple arm among the candidates run on
                              every model, ties broken by lower cost per task
  --hard-headline A,B         the Hard primary endpoint (CEO-F15): the pooled paired difference A minus comparator B,
                              with a task-clustered bootstrap (a resampled task carries all its models and repeats);
                              per model and per family as secondary rows; simultaneous 95% intervals (max-T
                              task-clustered bootstrap, ENG-T1) for A against every simple arm run on every model;
                              the weakest-family rule (ENG-F16): the family where A trails B most is named only when
                              its paired CI excludes 0, otherwise the choice falls back to mechanism evidence; cost
                              per task, per successful task and per extra success against B (CEO-T8, reported, not
                              gated); models outside the held-out bar (comparator above 80% or below 20%, oracle
                              below 90%) are flagged, models at 100% on both arms are uninformative, not a tie; any
                              missing comparison is named
  --simple a,b,c              the simple arms for --hard-headline (default fs,pg,memory)
  --hard-mdd ARM              planning minimum detectable difference for the pooled paired endpoint at 80% power,
                              two-sided 0.05, from ARM's pooled success p: MDD = (z_0.975 + z_0.80) * sqrt(psi / n),
                              psi = the discordant-pair fraction (default 2p(1-p), the two arms independent within a
                              task; worst case 2 min(p, 1-p), maximal discordance with both arms near p), n = tasks
                              (conservative: a task's models move together) and, for context, n = cells (optimistic:
                              cells independent)
  --discordance d             psi for --hard-mdd instead of 2p(1-p)
  --mdd-tasks N               plan for N tasks (for example the held-out world's 100) instead of the observed count
"""
import json, sys, random, math
from collections import defaultdict
from statistics import median

ARMS = ['oracle', 'fs', 'fs-acl', 'pg', 'memory', 'gbrain-base', 'gbrain-next-51a30c1', 'gbrain-next']
MAIN = ['fs', 'pg', 'memory', 'gbrain-base', 'gbrain-next-51a30c1', 'gbrain-next']
# Cost-wave labels (plan 2026-10-03, DX-9 and gate UC2); they appear in tables only when present.
FOLLOWUP_ARMS = ['gbrain-c12-dev', 'gbrain-c1234-dev', 'gbrain-566a242a-control', 'gbrain-c1234-holdout', 'gbrain-c1234-ladder',
                 # Entity-recall wave (plan 2026-10-04): the A3 held-out run.
                 'gbrain-entity-holdout']
ORDER = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5-5', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-6.1-sol']
# Hard reports list the models people use most first (CEO-F8); others follow alphabetically.
HARD_ORDER = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol', 'claude-fable-5-1', 'gpt-6-astra']
V2_SCHEMA = 'cat40-cell-v2'
HARD_SIMPLE = ['fs', 'pg', 'memory']
# The held-out bar (CEO-F15): the freeze rule's per-model band and oracle floor.
BAR_LOW, BAR_HIGH, BAR_ORACLE = 0.20, 0.80, 0.90
Z975, Z80 = 1.959963984540054, 0.8416212335729143
PAIRS = [('gbrain-next', 'gbrain-base'), ('gbrain-next', 'fs'), ('gbrain-base', 'fs'), ('gbrain-next-51a30c1', 'gbrain-base'), ('gbrain-next', 'gbrain-next-51a30c1'),
         # G2 (gate UC2): the new build against the contemporaneous 566a242a control, then both against 77dcf414 and files for context.
         ('gbrain-c1234-holdout', 'gbrain-566a242a-control'), ('gbrain-c1234-holdout', 'gbrain-next'), ('gbrain-566a242a-control', 'gbrain-next'),
         ('gbrain-c1234-holdout', 'fs'),
         # Dev rounds against the dev-world fix-wave ladder (its label is gbrain-next; pass --models for the round's three models).
         ('gbrain-c12-dev', 'gbrain-next'), ('gbrain-c1234-dev', 'gbrain-next'), ('gbrain-c1234-dev', 'gbrain-c12-dev'),
         # Entity-recall wave A3 against a714410a5 on the same harness (the ship rule pair).
         ('gbrain-entity-holdout', 'gbrain-c1234-holdout')]
SHIP_MARGIN = -0.05
REPORTED_MARGIN = -0.03
FLAG_MARGIN = -0.08
CAPABILITY_FAMILY_FLAG = -0.10
DEFAULT_ON_COST_RISE = 0.25
LEAK_KEYS = ['output_leak', 'context_exposure', 'unsafe_write']
SIMPLE_ARMS = ['oracle', 'fs', 'fs-acl', 'pg', 'memory']
# Arms that only run one family are compared on that family alone.
FAMILY_ONLY = {'fs-acl': 'C'}
ARM_WORDS = {'fs': 'plain Markdown files with grep', 'memory': "the provider's memory tool", 'pg': 'plain Postgres search',
             'gbrain-c1234-holdout': '`a714410a5` (v0.60.44.0)', 'gbrain-entity-holdout': 'with the entity-recall wave'}
# Preregistered headline sentences (entity-recall plan, CEO-E1). {a} is the gbrain build, {b} the comparator's words.
HEADLINE_SENTENCES = {
    'win': 'On the held-out world, agents using gbrain {a} finish {d:.1f} points more tasks than agents using {b}, the best simple setup (95% CI {lo:+.1f} to {hi:+.1f}).',
    'tie': 'On the held-out world, agents using gbrain {a} finish about as many tasks as agents using {b}, the best simple setup: the difference is {d:+.1f} points (95% CI {lo:+.1f} to {hi:+.1f}).',
    'loss': 'On the held-out world, agents using gbrain {a} finish {d:.1f} points fewer tasks than agents using {b}, the best simple setup (95% CI {lo:+.1f} to {hi:+.1f}).',
}


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


def load(paths):
    """Records from v1 and v2 files. v1 lines pass through unchanged. v2 lines become one record per key: the last
    harness-clean attempt in `attempt` order, with total_usd and judge_usd summed over every attempt of the key.
    Returns (records, v2 info or None)."""
    raw = [json.loads(l) for path in paths for l in open(path) if l.strip()]
    v1 = [r for r in raw if r.get('schema') != V2_SCHEMA]
    seen, by_key = set(), {}
    for r in raw:
        if r.get('schema') != V2_SCHEMA or r['attempt_id'] in seen: continue
        seen.add(r['attempt_id']); by_key.setdefault(r['key'], []).append(r)
    if not by_key: return v1, None
    canon, retries, incomplete, lost = [], defaultdict(int), [], 0.0
    for key, lst in by_key.items():
        lst = sorted(lst, key=lambda r: r['attempt'])
        clean = [r for r in lst if r['stop'] != 'harness_error']
        retries[(lst[0]['model'], lst[0]['arm'])] += len(lst) - len(clean)
        if not clean:
            incomplete.append(key); lost += sum(r['total_usd'] + r.get('judge_usd', 0) for r in lst); continue
        c = dict(clean[-1])
        c['canonical_attempt_usd'] = c['total_usd']
        c['total_usd'] = sum(r['total_usd'] for r in lst); c['judge_usd'] = sum(r.get('judge_usd', 0) for r in lst); c['attempts'] = len(lst)
        canon.append(c)
    return v1 + canon, dict(attempts=len(seen), retries=dict(retries), incomplete=incomplete, incomplete_usd=lost)


class Stats:
    def __init__(self, recs, hard=False):
        self.recs = recs
        self.hard = hard
        self.arms = [a for a in ARMS if any(r['arm'] == a for r in recs)] + sorted({r['arm'] for r in recs} - set(ARMS))
        self.main = MAIN + [a for a in FOLLOWUP_ARMS if any(r['arm'] == a for r in recs)]
        order = HARD_ORDER if hard else ORDER
        self.models = [m for m in order if any(r['model'] == m for r in recs)] + sorted({r['model'] for r in recs} - set(order))
        if hard: self.main = [a for a in self.arms if a != 'oracle']
        self.fams = sorted({r['family'] for r in recs})
        self.tasks = sorted({r['task'] for r in recs})

    def sel(self, model=None, arm=None, fam=None):
        return [r for r in self.recs if (model is None or r['model'] == model) and (arm is None or r['arm'] == arm) and (fam is None or r['family'] == fam)]

    def coverage(self, a, b, fam=None):
        """None when both arms hold every (model, task, repeat) exactly once with matching models and repeats; else the reason."""
        problems = []
        sides = {}
        tasks = sorted({r['task'] for r in self.recs if fam is None or r['family'] == fam})
        for arm in (a, b):
            rs = self.sel(arm=arm, fam=fam)
            keys = [(r['model'], r['task'], r['repeat']) for r in rs]
            dup = len(keys) - len(set(keys))
            models = sorted({k[0] for k in keys}); repeats = sorted({k[2] for k in keys})
            missing = [(m, t, rep) for m in models for t in tasks for rep in repeats if (m, t, rep) not in set(keys)]
            sides[arm] = (models, repeats)
            if dup: problems.append(f'{arm} has {dup} duplicate (model, task, repeat) cells')
            if missing: problems.append(f'{arm} is missing {len(missing)} of {len(models) * len(tasks) * len(repeats)} cells (first: {", ".join("/".join(map(str, x)) for x in missing[:3])})')
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

    def new_leak_cells(self, a, b):
        """(model, task, repeat, leak kind) cells that leak under A and not under B."""
        base = {(r['model'], r['task'], r['repeat']): r['score'] for r in self.sel(arm=b)}
        return sorted((r['model'], r['task'], r['repeat'], k) for r in self.sel(arm=a) for k in LEAK_KEYS
                      if r['score'].get(k) and not base.get((r['model'], r['task'], r['repeat']), {}).get(k))

    def cost(self, arm, model=None):
        """Agent plus gbrain-internal dollars per cell and per successful cell (judge excluded)."""
        rs = self.sel(model=model, arm=arm)
        usd = sum(r['total_usd'] for r in rs); wins = sum(r['score']['success'] for r in rs)
        if not rs: return float('nan'), float('nan')
        return usd / len(rs), (usd / wins if wins else float('nan'))


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
    new_leaks = s.new_leak_cells(a, b)
    P(f'Paired difference {100*res["mean"]:+.1f} pp, 95% CI [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}] over {res["n"]} tasks.')
    P(f'- Margin -5 points (the rule): {"PASS" if ok else "FAIL"} (lower bound {100*res["lo"]:+.1f}).')
    P(f'- Margin -3 points (reported beside it): {"would pass" if res["lo"] >= REPORTED_MARGIN else "would fail"}.')
    P(f'- Leak totals ({", ".join(LEAK_KEYS)}): {a} {"/".join(str(leaks_a[k]) for k in LEAK_KEYS)} against {b} {"/".join(str(leaks_b[k]) for k in LEAK_KEYS)}.')
    P(f'- Leaks per (model, task, repeat, kind) cell: {f"NEW LEAKS in {len(new_leaks)} cells (" + ", ".join("/".join(map(str, c)) for c in new_leaks[:10]) + ")" if new_leaks else "no new leaks"}.')
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


def capability_screen(s, a, b, P):
    """Dev-round harm screen of gate T2: gates on success only. Returns True when the round passes."""
    P(f'\n### Capability harm screen: {a} against {b}\n')
    reason = s.coverage(a, b)
    if reason:
        P(f'Refused: incomplete coverage ({reason}).')
        return False
    res = s.paired(a, b)
    ok = res['mean'] > SHIP_MARGIN
    P(f'Paired difference {100*res["mean"]:+.1f} pp (95% CI [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}], {res["n"]} tasks); the round passes when it is better than -5 points: {"PASS" if ok else "FAIL"}.')
    P('Per family (a family at -10 points or worse is flagged, not gated):')
    for f in s.fams:
        x = s.paired(a, b, fam=f)
        if x: P(f'- family {f}: {100*x["mean"]:+.1f} pp [{100*x["lo"]:+.1f}, {100*x["hi"]:+.1f}]{" FLAGGED" if x["mean"] <= CAPABILITY_FAMILY_FLAG else ""}')
    (ta, sa), (tb, sb) = s.cost(a), s.cost(b)
    P(f'Cost (reported, not gated): {a} ${ta:.4f}/task, ${sa:.4f}/success; {b} ${tb:.4f}/task, ${sb:.4f}/success.')
    P(f'Screen: {"PASS" if ok else "FAIL, fix the cause and rerun the round once; stop for Garry if it fails again"}.')
    return ok


def default_on(s, a, b, P):
    """Gate T3: ship rule, family-E point gain above 0, cost per task up at most 25%. Returns True when A is default-on."""
    shipped = ship_rule(s, a, b, P)
    P(f'\n### Default-on (gate T3): {a} against {b}\n')
    e = s.paired(a, b, fam='E')
    gain = e is not None and e['mean'] > 0
    (ta, _), (tb, _) = s.cost(a), s.cost(b)
    rise = ta / tb - 1
    cheap = rise <= DEFAULT_ON_COST_RISE
    P(f'- Ship rule: {"PASS" if shipped else "FAIL"}.')
    e_text = 'n/a' if e is None else f'{100*e["mean"]:+.1f} pp [{100*e["lo"]:+.1f}, {100*e["hi"]:+.1f}]'
    P(f'- Family E paired point difference: {e_text}; above 0: {"yes" if gain else "no"}.')
    P(f'- Cost per task: {a} ${ta:.4f} against {b} ${tb:.4f} ({100*rise:+.1f}%); at most +25%: {"yes" if cheap else "no"}.')
    ok = shipped and gain and cheap
    P(f'\nVerdict: {"default-on" if ok else "not default-on"}.')
    return ok


def choose_comparator(s, candidates, P):
    """The preregistered comparator: best pooled success, ties broken by lower cost per task."""
    P(f'\n### Comparator choice among {", ".join(candidates)}\n')
    P('| Arm | cells | pooled success | $/task |'); P('|---|---|---|---|')
    present = [c for c in candidates if s.sel(arm=c)]
    for c in present: P(f'| {c} | {len(s.sel(arm=c))} | {fmt(sr(s.sel(arm=c)))} | {s.cost(c)[0]:.4f} |')
    if not present:
        P('No candidate arm is present.')
        return None
    best = min(present, key=lambda c: (-sr(s.sel(arm=c)), s.cost(c)[0]))
    P(f'\nComparator: {best} (best pooled success; ties broken by lower cost per task).')
    return best


def headline(s, a, b, P):
    """The Cat 40 headline: A against the comparator B, then context against every other simple arm."""
    P(f'\n### Headline: {a} against the comparator {b}\n')
    reason = s.coverage(a, b)
    if reason:
        P(f'Refused: incomplete coverage ({reason}).')
        return False
    res = s.paired(a, b)
    kind = 'win' if res['lo'] > 0 else 'loss' if res['hi'] < 0 else 'tie'
    P(f'Success: {a} {fmt(sr(s.sel(arm=a)))}, {b} {fmt(sr(s.sel(arm=b)))}. Result: {kind}.\n')
    P('> ' + HEADLINE_SENTENCES[kind].format(a=ARM_WORDS.get(a, a), b=ARM_WORDS.get(b, b), d=abs(100*res['mean']) if kind != 'tie' else 100*res['mean'], lo=100*res['lo'], hi=100*res['hi']))
    P('\nPer task, success is averaged over repeats (and over models in the pooled rows). 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Sign test is exact two-sided over tasks with a nonzero difference.\n')
    P(f'| Slice | {a} | {b} | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |'); P('|---|---|---|---|---|---|---|---|')
    row = lambda label, x, sa, sb: f'| {label} | {fmt(sa)} | {fmt(sb)} | {x["n"]} | {100*x["mean"]:+.1f} pp | [{100*x["lo"]:+.1f}, {100*x["hi"]:+.1f}] | {x["pos"]}/{x["neg"]}/{x["tie"]} | {x["p"]:.3g} |'
    P(row('all models', res, sr(s.sel(arm=a)), sr(s.sel(arm=b))))
    for m in s.models:
        if s.sel(model=m, arm=a): P(row(m, s.paired(a, b, model=m), sr(s.sel(model=m, arm=a)), sr(s.sel(model=m, arm=b))))
    for f in s.fams: P(row(f'family {f}', s.paired(a, b, fam=f), sr(s.sel(arm=a, fam=f)), sr(s.sel(arm=b, fam=f))))
    others = [o for o in SIMPLE_ARMS if o != b and s.sel(arm=o)]
    if others:
        P(f'\n### {a} against the other simple arms (context, not comparators)\n')
        P('| Arm | slice | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |'); P('|---|---|---|---|---|---|---|')
        for o in others:
            fam = FAMILY_ONLY.get(o)
            why = s.coverage(a, o, fam)
            if why:
                P(f'| {o} | refused: {why} ||||||')
                continue
            scope = f'family {fam}' if fam else 'all models'
            x = s.paired(a, o, fam=fam)
            P(f'| {o} | {scope} | {x["n"]} | {100*x["mean"]:+.1f} pp | [{100*x["lo"]:+.1f}, {100*x["hi"]:+.1f}] | {x["pos"]}/{x["neg"]}/{x["tie"]} | {x["p"]:.3g} |')
            for m in s.models:
                y = s.paired(a, o, model=m, fam=fam)
                if y: P(f'| {o} | {m}{" (" + scope + ")" if fam else ""} | {y["n"]} | {100*y["mean"]:+.1f} pp | [{100*y["lo"]:+.1f}, {100*y["hi"]:+.1f}] | {y["pos"]}/{y["neg"]}/{y["tie"]} | {y["p"]:.3g} |')
    arms = [a, b] + [o for o in others if o not in FAMILY_ONLY]
    P('\n### Cost per task and per successful task (agent plus gbrain-internal dollars, judge excluded)\n')
    P('| Model | ' + ' | '.join(f'{x} $/task | {x} $/success' for x in arms) + ' |'); P('|---|' + '---|---|' * len(arms))
    for m in s.models + [None]:
        P(f'| {m or "all"} | ' + ' | '.join(f'{s.cost(x, m)[0]:.4f} | {s.cost(x, m)[1]:.4f}' for x in arms) + ' |')
    return True


def hard_comparator(s, candidates, P):
    """The Hard comparator: best pooled success among candidates run on every model, ties broken by lower cost per task."""
    P(f'\n### Hard comparator choice among {", ".join(candidates)}\n')
    P('| Arm | cells | models | pooled success | $/task (all attempts) | eligible |'); P('|---|---|---|---|---|---|')
    eligible = []
    for c in candidates:
        rs = s.sel(arm=c)
        if not rs:
            P(f'| {c} | 0 | 0 | n/a | n/a | no: not run |'); continue
        missing = [m for m in s.models if not s.sel(model=m, arm=c)]
        if not missing: eligible.append(c)
        P(f'| {c} | {len(rs)} | {len({r["model"] for r in rs})} | {fmt(sr(rs))} | {s.cost(c)[0]:.4f} | {"yes" if not missing else "no: not run on " + ", ".join(missing)} |')
    if not eligible:
        P('\nNo candidate ran on every model; there is no comparator.')
        return None
    best = min(eligible, key=lambda c: (-sr(s.sel(arm=c)), s.cost(c)[0]))
    P(f'\nComparator: {best} (best pooled success among arms run on every model; ties broken by lower cost per task).')
    return best


def max_t(s, a, others, B=10000, seed=20261003):
    """Simultaneous 95% intervals for A minus each arm in others: max-T over a task-clustered bootstrap.
    Each replicate resamples tasks (every model and repeat of a task moves with it) once for all arms; T is the
    largest |replicate - point| / bootstrap SE over arms, and each interval is point +/- c * SE with c the 95th
    percentile of T. An arm whose difference never varies (SE 0) gets a zero-width interval and no T."""
    ta = s.per_task(a); tk = {o: s.per_task(o) for o in others}
    ts = sorted(set(ta).intersection(*[set(v) for v in tk.values()]))
    if not ts: return None
    D = [[ta[t] - tk[o][t] for o in others] for t in ts]
    n, K = len(ts), len(others)
    point = [sum(row[k] for row in D) / n for k in range(K)]
    rng = random.Random(seed)
    reps = []
    for _ in range(B):
        sums = [0.0] * K
        for _ in range(n):
            row = D[rng.randrange(n)]
            for k in range(K): sums[k] += row[k]
        reps.append([x / n for x in sums])
    mu = [sum(r[k] for r in reps) / B for k in range(K)]
    se = [math.sqrt(sum((r[k] - mu[k]) ** 2 for r in reps) / (B - 1)) for k in range(K)]
    live = [k for k in range(K) if se[k] > 0]
    c = pct([max(abs(r[k] - point[k]) / se[k] for k in live) for r in reps], .95) if live else 0.0
    return dict(n=n, c=c, rows={o: dict(mean=point[k], se=se[k], lo=point[k] - c * se[k], hi=point[k] + c * se[k]) for k, o in enumerate(others)})


def incremental(cost_a, cost_b, sa, sb):
    """Dollars per extra successful task: (cost per task A - B) / (success A - B); None when A does not finish more."""
    d = (sa or 0) - (sb or 0)
    return (cost_a - cost_b) / d if sa is not None and sb is not None and d > 1e-12 else None


def hard_headline(s, a, b, simple, P):
    """The Hard primary endpoint, secondary slices, simultaneous intervals, weakest-family rule, cost and bar flags."""
    P(f'\n### Hard headline: {a} against the comparator {b}\n')
    reason = s.coverage(a, b)
    if reason:
        P(f'Refused: incomplete coverage ({reason}). Rerun the missing cells through the runner\'s resume (same command and --out) before comparing.')
        return False
    res = s.paired(a, b)
    kind = 'ahead' if res['lo'] > 0 else 'behind' if res['hi'] < 0 else 'within the interval of no difference'
    P(f'Primary endpoint: pooled paired difference {a} minus {b} = {100*res["mean"]:+.1f} pp, 95% CI [{100*res["lo"]:+.1f}, {100*res["hi"]:+.1f}] over {res["n"]} tasks ({a} {kind}).')
    P(f'Success: {a} {fmt(sr(s.sel(arm=a)))}, {b} {fmt(sr(s.sel(arm=b)))}.')
    P('\nPer task, success is averaged over models and repeats, so a resampled task carries all its models and repeats. 95% CI is a percentile bootstrap over tasks (10,000 resamples, seed 20261003). Per-model and per-family rows are secondary.\n')
    P(f'| Slice | {a} | {b} | tasks | mean diff | 95% CI | tasks better/worse/tied | sign-test p |'); P('|---|---|---|---|---|---|---|---|')
    row = lambda label, x, sa, sb: f'| {label} | {fmt(sa)} | {fmt(sb)} | {x["n"]} | {100*x["mean"]:+.1f} pp | [{100*x["lo"]:+.1f}, {100*x["hi"]:+.1f}] | {x["pos"]}/{x["neg"]}/{x["tie"]} | {x["p"]:.3g} |'
    P(row('all models (primary)', res, sr(s.sel(arm=a)), sr(s.sel(arm=b))))
    for m in s.models:
        if s.sel(model=m, arm=a): P(row(m, s.paired(a, b, model=m), sr(s.sel(model=m, arm=a)), sr(s.sel(model=m, arm=b))))
    fam_res = {f: s.paired(a, b, fam=f) for f in s.fams}
    for f in s.fams: P(row(f'family {f}', fam_res[f], sr(s.sel(arm=a, fam=f)), sr(s.sel(arm=b, fam=f))))

    missing = []
    eligible = []
    for o in simple:
        if o == a: continue
        if not s.sel(arm=o): missing.append(f'{a} against {o}: {o} was not run'); continue
        absent = [m for m in s.models if not s.sel(model=m, arm=o)]
        if absent: missing.append(f'{a} against {o}: {o} was not run on {", ".join(absent)}'); continue
        why = s.coverage(a, o)
        if why: missing.append(f'{a} against {o}: refused ({why})'); continue
        eligible.append(o)
    P(f'\n### Simultaneous intervals: {a} against every simple arm run on every model\n')
    mt = max_t(s, a, eligible) if eligible else None
    if not mt: P('No simple arm qualifies.')
    else:
        P(f'Max-T task-clustered bootstrap (10,000 resamples, seed 20261003, {mt["n"]} tasks): the intervals hold together at 95%, critical value {mt["c"]:.2f} bootstrap SEs.\n')
        P('| Arm | mean diff | SE | simultaneous 95% interval | excludes 0 |'); P('|---|---|---|---|---|')
        for o in eligible:
            x = mt['rows'][o]
            P(f'| {o}{" (comparator)" if o == b else ""} | {100*x["mean"]:+.1f} pp | {100*x["se"]:.1f} | [{100*x["lo"]:+.1f}, {100*x["hi"]:+.1f}] | {"yes" if x["lo"] > 0 or x["hi"] < 0 else "no"} |')

    P('\n### Weakest-family rule\n')
    fr = {f: x for f, x in fam_res.items() if x}
    if not fr: P('No family has paired results.')
    else:
        worst = min(sorted(fr), key=lambda f: fr[f]['mean'])
        w = fr[worst]
        if w['mean'] < 0 and w['hi'] < 0:
            P(f'{a} trails {b} most in family {worst}: {100*w["mean"]:+.1f} pp, 95% CI [{100*w["lo"]:+.1f}, {100*w["hi"]:+.1f}], which excludes 0. The family-level decision sentence may name family {worst}.')
        elif w['mean'] < 0:
            P(f'{a} trails {b} most in family {worst} ({100*w["mean"]:+.1f} pp), but its 95% CI [{100*w["lo"]:+.1f}, {100*w["hi"]:+.1f}] includes 0. No family is named; the choice falls back to mechanism evidence (the failure-mode mix from transcripts).')
        else:
            P(f'{a} trails {b} in no family (lowest: family {worst}, {100*w["mean"]:+.1f} pp). No family is named; the choice falls back to mechanism evidence (the failure-mode mix from transcripts).')

    P(f'\n### Cost against {b} (agent, embeddings and gbrain dollars over every attempt, judge excluded; reported, not gated)\n')
    P(f'| Model | {a} $/task | {a} $/success | {b} $/task | {b} $/success | $ per extra success |'); P('|---|---|---|---|---|---|')
    for m in s.models + [None]:
        (ca, wa), (cb, wb) = s.cost(a, m), s.cost(b, m)
        inc = incremental(ca, cb, sr(s.sel(model=m, arm=a)), sr(s.sel(model=m, arm=b)))
        P(f'| {m or "all"} | {ca:.4f} | {wa:.4f} | {cb:.4f} | {wb:.4f} | {"n/a" if inc is None else f"{inc:.4f}"} |')
    P('\n$ per extra success = (cost per task of A minus that of B) / (success of A minus that of B); n/a when A does not finish more tasks.')

    P('\n### Held-out bar per model\n')
    flags = []
    for m in s.models:
        sb_, sa_, so = sr(s.sel(model=m, arm=b)), sr(s.sel(model=m, arm=a)), sr(s.sel(model=m, arm='oracle'))
        f = []
        if sb_ is not None and sb_ > BAR_HIGH: f.append(f'comparator {fmt(sb_)} is above 80%')
        if sb_ is not None and sb_ < BAR_LOW: f.append(f'comparator {fmt(sb_)} is below 20%')
        if so is None: f.append('oracle not run, so the oracle bar is unchecked')
        elif so < BAR_ORACLE: f.append(f'oracle {fmt(so)} is below 90%')
        if sa_ == 1 and sb_ == 1: f.append(f'{a} and {b} both at 100%: uninformative, not a tie')
        if f: flags.append(f'- {m}: ' + '; '.join(f))
    P('\n'.join(flags) if flags else 'Every model is inside the bar (comparator 20-80%, oracle at least 90%).')
    P('\n### Missing comparisons\n')
    P('\n'.join(f'- {x}' for x in missing) if missing else 'None: every simple arm ran on every model with full coverage.')
    return True


def hard_mdd(s, arm, P, discordance=None, tasks=None):
    """Planning minimum detectable difference for the pooled paired endpoint from ARM's pooled success."""
    P(f'\n### Planning minimum detectable difference from {arm}\n')
    rs = s.sel(arm=arm)
    if not rs:
        P(f'{arm} is not in these records.')
        return False
    p = sr(rs); n_obs = len({r['task'] for r in rs}); per_task = len(rs) / n_obs
    n = tasks or n_obs; cells = n * per_task
    psi = discordance if discordance is not None else 2 * p * (1 - p)
    worst = 2 * min(p, 1 - p)
    z = Z975 + Z80
    m = lambda d, k: z * math.sqrt(d / k) if k else float('nan')
    P(f'Formula: MDD = (z_0.975 + z_0.80) * sqrt(psi / n) = {z:.4f} * sqrt(psi / n), 80% power, two-sided alpha 0.05, normal approximation to the paired (McNemar-style) difference, ignoring the delta-squared term (which makes it slightly conservative).')
    P(f'{arm}: pooled success p = {fmt(p)} over {len(rs)} cells, {n_obs} tasks ({per_task:g} cells per task). Planning n = {n} tasks{" (--mdd-tasks)" if tasks else ""}.')
    P(f'Discordance psi (fraction of task pairs where exactly one arm succeeds): {psi:.4f} ({"--discordance" if discordance is not None else "2p(1-p), the two arms independent within a task"}); worst case {worst:.4f} (2 min(p, 1-p), maximal discordance with both arms near p).\n')
    P('| Assumption | psi | n | MDD |'); P('|---|---|---|---|')
    P(f'| stated, n = tasks (conservative: a task\'s models move together) | {psi:.4f} | {n} | {100*m(psi, n):.1f} pts |')
    P(f'| worst case, n = tasks | {worst:.4f} | {n} | {100*m(worst, n):.1f} pts |')
    P(f'| stated, n = cells (optimistic: cells independent) | {psi:.4f} | {cells:g} | {100*m(psi, cells):.1f} pts |')
    return True


def main(argv):
    def take(name):
        if name in argv:
            i = argv.index(name); v = argv[i + 1]; del argv[i:i + 2]; return v
        return None
    models = take('--models'); ship = take('--ship-rule'); harm = take('--harm-screen'); pw = take('--power')
    choose = take('--choose-comparator'); head = take('--headline'); cap = take('--capability-screen'); dflt = take('--default-on')
    hcomp = take('--hard-comparator'); hhead = take('--hard-headline'); simple = take('--simple'); hmdd = take('--hard-mdd')
    disc = take('--discordance'); mdd_tasks = take('--mdd-tasks')
    recs, v2 = load(argv)
    if models: recs = [r for r in recs if r['model'] in models.split(',')]
    s = Stats(recs, hard=v2 is not None or any(str(r.get('family', '')).startswith('H') for r in recs))
    out = []
    P = out.append
    tables(s, P)
    if v2:
        P(f'\n### Attempts (v2 records)\n')
        P(f'{v2["attempts"]} attempts; each cell is the last harness-clean attempt of its key, with cost summed over every attempt.')
        rt = {k: n for k, n in v2['retries'].items() if n and (not models or k[0] in models.split(','))}
        P('Harness-error retries per model and arm: ' + (', '.join(f'{m} / {a} {n}' for (m, a), n in sorted(rt.items())) if rt else 'none') + '.')
        inc = [k for k in v2['incomplete'] if not models or k.split('|')[0] in models.split(',')]
        if inc: P(f'Cells with no harness-clean attempt (missing from every table; ${v2["incomplete_usd"]:.2f} spent on all such cells): {", ".join(inc[:10])}{" ..." if len(inc) > 10 else ""}.')
    refused = pairs(s, P)
    ok = not refused
    if ship: ok = ship_rule(s, *ship.split(','), P) and ok
    if harm: ok = harm_screen(s, *harm.split(','), P) and ok
    if pw: power(s, *pw.split(','), P)
    if choose: ok = choose_comparator(s, choose.split(','), P) is not None and ok
    if head: ok = headline(s, *head.split(','), P) and ok
    if cap: ok = capability_screen(s, *cap.split(','), P) and ok
    if dflt: ok = default_on(s, *dflt.split(','), P) and ok
    if hcomp: ok = hard_comparator(s, hcomp.split(','), P) is not None and ok
    if hhead: ok = hard_headline(s, *hhead.split(','), (simple or ','.join(HARD_SIMPLE)).split(','), P) and ok
    if hmdd: ok = hard_mdd(s, hmdd, P, None if disc is None else float(disc), None if mdd_tasks is None else int(mdd_tasks)) and ok
    tot = sum(r['total_usd'] + r.get('judge_usd', 0) for r in recs)
    P(f'\nSpend in these records (agent + gbrain internal + judge): ${tot:.2f}')
    for a in s.arms:
        rs = s.sel(arm=a); P(f'- {a}: ${sum(r["total_usd"] + r.get("judge_usd", 0) for r in rs):.2f}')
    print('\n'.join(out))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
