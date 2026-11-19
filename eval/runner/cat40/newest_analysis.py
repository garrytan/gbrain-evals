#!/usr/bin/env python3
"""Cat 40 Hard newest-build re-measure analysis (docs/benchmarks/2026-11-19-cat40-hard-newest-preregistration.md).

Usage:
  python3 eval/runner/cat40/newest_analysis.py --world N1=<attempts or results.jsonl>[,<more>] --world N2=<...> \
      [--transcripts <transcripts.jsonl>[,<more>]] [--judge-check <report.json>] [--gbrain gbrain-newest] [--fs fs] \
      [--resamples 10000] [--seed 1] [--json out.json]

Canonical cells: the last attempt per (arm, model, task) whose stop is not harness_error; cost sums every attempt.
Headline: Delta = mean over the frontier readers (claude-opus-5-5, gpt-6.2-sol) of (gbrain rate - files rate) over all
tasks of N1 and N2. Interval: tasks nested in worlds, worlds fixed; 10,000 resamples from one random.Random(1) stream;
each resample visits the worlds in name order and draws that world's task count of task ids with replacement
(rng.choice over the world's task ids sorted as strings); a drawn task brings every reader's cells of both arms.
An endpoint whose planned cells are not all present is refused (exit 3 for the headline), never computed on fewer.
Counts and rates only; no world content is read.
"""
import argparse, json, random, re, sys
from collections import defaultdict

FRONTIER = ['claude-opus-5-5', 'gpt-6.2-sol']
PARTICLE = 'particle-1'
FAMILIES = ['H1', 'H2', 'H3', 'H4', 'H5']
TASKS_PER_WORLD = 100
# Preregistered thresholds (Decision rule): published leads and detectable differences, in points.
PUBLIC_HALF, D_PUBLIC = 12.50, 7.2
WORLD_M, D_M = 7.7, 8.9
HOLD_AT = round(PUBLIC_HALF - D_PUBLIC, 1)   # +5.3
RISE_ABOVE = round(WORLD_M + D_M, 1)         # +16.6
HIDDEN_SEARCH_OPTIONS = ('snippet_chars', 'mode', 'token_budget')


def load(paths):
    cells, cost, seen = {}, defaultdict(float), set()
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                aid = r.get('attempt_id')
                if aid in seen:
                    continue
                seen.add(aid)
                cost[(r['arm'], r['model'])] += float(r.get('total_usd') or 0) + float(r.get('judge_usd') or 0)
                if r.get('stop') == 'harness_error':
                    continue
                cells[(r['arm'], r['model'], r['task'])] = r
    return cells, cost


def metric(name):
    if name == 'success':
        return lambda r: 1.0 if r['score'].get('success') else 0.0
    if name == 'wrong_value':
        return lambda r: 1.0 if r['score'].get('said_wrong') else 0.0
    if name == 'wrong_submitted':
        return lambda r: 1.0 if r['score'].get('submitted') and not r['score'].get('success') else 0.0
    if name == 'not_submitted':
        return lambda r: 0.0 if r['score'].get('submitted') else 1.0
    if name == 'turn_cap':
        return lambda r: 1.0 if r.get('stop') == 'turn_cap' else 0.0
    raise ValueError(name)


class Comparison:
    """Arm a minus arm b over the worlds, for the given models, on tasks passing task_filter."""

    def __init__(self, worlds, a, b, what, models, task_filter=None):
        self.worlds, self.models = sorted(worlds), models
        f = metric(what)
        self.tasks, self.diff, self.missing = {}, {}, 0
        self.counts = {'cells': 0, 'a': 0.0, 'b': 0.0}
        for w in self.worlds:
            cells = worlds[w]
            tasks = sorted({t for (arm, m, t) in cells if arm in (a, b) and (task_filter is None or task_filter(cells[(arm, m, t)]))}, key=str)
            for t in tasks:
                per = {}
                for m in models:
                    ka, kb = (a, m, t), (b, m, t)
                    if ka in cells and kb in cells:
                        per[m] = (f(cells[ka]), f(cells[kb]))
                    else:
                        self.missing += 1
                self.diff[(w, t)] = per
                self.counts['cells'] += len(per)
                self.counts['a'] += sum(x for x, _ in per.values())
                self.counts['b'] += sum(y for _, y in per.values())
            self.tasks[w] = tasks

    def delta(self, draw):
        num, den = defaultdict(float), defaultdict(int)
        for key in draw:
            for m, (x, y) in self.diff[key].items():
                num[m] += x - y
                den[m] += 1
        ms = [m for m in self.models if den[m]]
        return sum(num[m] / den[m] for m in ms) / len(ms) * 100 if ms else float('nan')

    def run(self, resamples, seed):
        if not any(self.tasks.values()):
            return {'delta_pp': None, 'ci95': None, 'tasks': 0, 'cells': 0, 'a_count': 0.0, 'b_count': 0.0, 'missing_pairs': self.missing}
        point = self.delta([(w, t) for w in self.worlds for t in self.tasks[w]])
        rng = random.Random(seed)
        stats = []
        for _ in range(resamples):
            draw = []
            for w in self.worlds:
                ids = self.tasks[w]
                if ids:
                    draw.extend((w, rng.choice(ids)) for _ in range(len(ids)))
            stats.append(self.delta(draw))
        stats.sort()
        lo, hi = stats[int(0.025 * resamples)], stats[min(resamples - 1, int(0.975 * resamples))]
        return {'delta_pp': round(point, 2), 'ci95': [round(lo, 2), round(hi, 2)], 'tasks': sum(len(v) for v in self.tasks.values()),
                'cells': self.counts['cells'], 'a_count': self.counts['a'], 'b_count': self.counts['b'], 'missing_pairs': self.missing}


def wording(res):
    lo, hi = res['ci95']
    if lo > 0:
        return 'ahead'
    if hi < 0:
        return 'behind'
    return 'parity' if lo > -3 else 'not distinguishable'


def comparison_label(delta):
    return 'drops' if delta < HOLD_AT else 'rises' if delta > RISE_ABOVE else 'holds'


def outcome_row(res):
    """Precedence (Decision rule): the interval wording first; 'not distinguishable' decides the row on its own."""
    w = wording(res)
    return 'not distinguishable from 0' if w == 'not distinguishable' else comparison_label(res['delta_pp'])


def complete(worlds, arms, models):
    """Planned cells absent per (world, arm, model): every world needs TASKS_PER_WORLD clean cells."""
    gaps = {}
    for w, cells in worlds.items():
        for arm in arms:
            for m in models:
                n = sum(1 for (a, mm, _) in cells if a == arm and mm == m)
                if n != TASKS_PER_WORLD:
                    gaps[f'{w}|{arm}|{m}'] = TASKS_PER_WORLD - n
    return gaps


def claims_summary(worlds, arm, model):
    rows = [r for cells in worlds.values() for (a, m, _), r in cells.items() if a == arm and m == model and r.get('claims')]
    if not rows:
        return None
    bad = [r['claims']['unsupported'] + r['claims']['contradicted'] for r in rows]
    return {'answers_judged': len(rows), 'mean_bad_claims': round(sum(bad) / len(rows), 3), 'share_with_bad_claim': round(sum(1 for b in bad if b) / len(rows), 3)}


def tool_stats(paths, gbrain_label):
    out = defaultdict(lambda: defaultdict(int))
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                model, arm = r['key'].split('|')[:2]
                s = out[f'{arm}|{model}']
                for c in r.get('tools', []):
                    name, args, result = c.get('name', ''), c.get('args') or {}, str(c.get('result', ''))
                    s[f'calls:{name}'] += 1
                    if 'param_not_on_surface' in result:
                        s['param_not_on_surface'] += 1
                    if arm == gbrain_label and name == 'search':
                        s['search'] += 1
                        for o in HIDDEN_SEARCH_OPTIONS:
                            if o in args:
                                s[f'search_with:{o}'] += 1
                        if 'mode' in args:
                            s[f'search_mode:{args["mode"]}'] += 1
                        if 'limit' not in args:
                            s['search_no_limit'] += 1
                        if re.search(r'"results"\s*:\s*\[\s*\]|\bno results\b|\b0 results\b', result, re.I):
                            s['search_empty'] += 1
    return {k: dict(v) for k, v in sorted(out.items())}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--world', action='append', required=True, help='NAME=file[,file...]')
    ap.add_argument('--transcripts')
    ap.add_argument('--judge-check')
    ap.add_argument('--gbrain', default='gbrain-newest')
    ap.add_argument('--fs', default='fs')
    ap.add_argument('--resamples', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--json')
    args = ap.parse_args(argv)
    worlds, cost = {}, defaultdict(float)
    for spec in args.world:
        name, files = spec.split('=', 1)
        worlds[name], c = load(files.split(','))
        for k, v in c.items():
            cost[k] += v
    G, F, B, S = args.gbrain, args.fs, args.resamples, args.seed
    gaps = complete(worlds, [G, F], FRONTIER)
    if gaps:
        print(json.dumps({'refused': 'HEADLINE_INCOMPLETE', 'missing_cells': gaps}), file=sys.stderr)
        print('STOP HEADLINE_INCOMPLETE: resume the missing cells with the same step command; no endpoint is computed on fewer cells', file=sys.stderr)
        return 3
    head = Comparison(worlds, G, F, 'success', FRONTIER).run(B, S)
    head.update({'wording': wording(head), 'comparison': comparison_label(head['delta_pp']), 'outcome_row': outcome_row(head),
                 'thresholds': {'holds_at_or_above': HOLD_AT, 'rises_above': RISE_ABOVE}})
    out = {'resamples': B, 'seed': S, 'arms': {'gbrain': G, 'fs': F}, 'readers_pooled': FRONTIER, 'headline': head,
           'per_reader': {}, 'per_family': {}, 'per_world': {}, 'secondary': {}, 'first_table': {}, 'claims': {}}
    particle_gaps = complete(worlds, [G, F], [PARTICLE])
    for m in FRONTIER + [PARTICLE]:
        if m == PARTICLE and particle_gaps:
            out['per_reader'][m] = {'incomplete': particle_gaps}
            continue
        out['per_reader'][m] = Comparison(worlds, G, F, 'success', [m]).run(B, S)
    for fam in FAMILIES:
        res = Comparison(worlds, G, F, 'success', FRONTIER, task_filter=lambda r, fam=fam: r['family'] == fam).run(B, S)
        if fam == 'H4':
            res['level_or_behind'] = res['ci95'][0] <= 0
        out['per_family'][fam] = res
    for long_ in (True, False):
        flt = lambda r, l=long_: r['family'] == 'H4' and (('+long' in str(r.get('variant', ''))) == l)
        out['per_family']['H4+long' if long_ else 'H4-not-long'] = Comparison(worlds, G, F, 'success', FRONTIER, task_filter=flt).run(B, S)
    for w in sorted(worlds):
        out['per_world'][w] = Comparison({w: worlds[w]}, G, F, 'success', FRONTIER).run(B, S)
    for what in ('wrong_value', 'wrong_submitted', 'not_submitted', 'turn_cap'):
        out['secondary'][what] = Comparison(worlds, G, F, what, FRONTIER).run(B, S)
    judge_ok = None
    if args.judge_check:
        with open(args.judge_check) as f:
            judge_ok = {j['judge']: j['passes'] for j in json.load(f)['judges']}
    judges = {'claude-opus-5-5': 'gpt-6.1-sol', 'gpt-6.2-sol': 'claude-opus-5-5', PARTICLE: 'gpt-6.1-sol'}
    for m in FRONTIER + [PARTICLE]:
        for arm in (G, F):
            n = sum(1 for cells in worlds.values() for (a, mm, _), r in cells.items() if a == arm and mm == m and r['score'].get('success'))
            usd = cost.get((arm, m), 0.0)
            out['first_table'][f'{arm}|{m}'] = {'successes': n, 'cost_per_correct_usd': round(usd / n, 4) if n else None}
            cs = claims_summary(worlds, arm, m)
            if cs:
                cs['judge'] = judges[m]
                cs['counted'] = bool(judge_ok and judge_ok.get(judges[m]))
                out['claims'][f'{arm}|{m}'] = cs
    if args.transcripts:
        out['tool_calls'] = tool_stats(args.transcripts.split(','), G)
    text = json.dumps(out, indent=1, allow_nan=False)
    if args.json:
        with open(args.json, 'w') as f:
            f.write(text)
    h = out['headline']
    print(f"headline: gbrain - files {h['delta_pp']:+.2f} pp [{h['ci95'][0]:+.2f}, {h['ci95'][1]:+.2f}] over {h['tasks']} tasks, readers {', '.join(FRONTIER)}: {h['wording']}; against the published leads: {h['comparison']}; outcome row: {h['outcome_row']}")
    h4 = out['per_family']['H4']
    print(f"H4: {h4['delta_pp']:+.2f} pp [{h4['ci95'][0]:+.2f}, {h4['ci95'][1]:+.2f}] level_or_behind={h4['level_or_behind']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
