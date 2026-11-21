#!/usr/bin/env python3
"""Cat 40 Hard newest-build re-measure analysis (docs/benchmarks/2026-11-19-cat40-hard-newest-preregistration.md).

Usage:
  python3 eval/runner/cat40/newest_analysis.py --world N1=<attempts or results.jsonl>[,<more>] --world N2=<...> \
      [--transcripts <transcripts.jsonl>[,<more>]] [--judge-check <report.json>] [--gbrain gbrain-newest] [--fs fs] \
      [--resamples 10000] [--seed 1] [--json out.json] [--look interim|final|control] [--old gbrain-old-09d]
      [--world-transcripts N1=<transcripts.jsonl>[,<more>] ...]  (--look control only)

--look control is the old-build control (docs/benchmarks/2026-11-19-cat40-hard-old-build-control-preregistration.md):
each world's files list holds the old build's cells beside the newest run's gbrain and files cells. It reports Delta_old
(old minus files) and newest minus old with 95% intervals from the same resample draws, and the control's outcome row.

--look interim is the one look at half the tasks (R113; amendment of 2026-11-19): it reads exactly half A (tasks 01 to
10 of each family) and stops for a difference at |z| >= 2.80, or for futility when conditional power under the planned
effect (+5.4 points) is below 10%; z is the pooled Delta over its bootstrap standard error. The final headline reads
its interval at the final bound, z 1.98.

Canonical cells: the last attempt per (arm, model, task) whose stop is not harness_error; cost sums every attempt.
Headline: Delta = mean over the frontier readers (claude-opus-5-5, gpt-6.2-sol) of (gbrain rate - files rate) over all
tasks of N1 and N2. Interval: tasks nested in worlds, worlds fixed; 10,000 resamples from one random.Random(1) stream;
each resample visits the worlds in name order and draws that world's task count of task ids with replacement
(rng.choice over the world's task ids sorted as strings); a drawn task brings every reader's cells of both arms.
An endpoint whose planned cells are not all present is refused (exit 3 for the headline), never computed on fewer.
Counts and rates only; no world content is read.
"""
import argparse, json, math, random, re, sys
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
# The one interim look (R113, amendment of 2026-11-19): O'Brien-Fleming bounds at half the tasks, futility on
# conditional power under the planned effect (the 80%-power detectable difference), and the final critical value.
HALF_A = [f'{fam}-{i:02d}' for fam in FAMILIES for i in range(1, 11)]
# The old-build control's outcome rows (its preregistration, "What the result changes").
CONTROL_ROWS = ('regression', 'smaller regression', 'newest improved', 'not a regression')
CONTROL_WORLDS = ('N1', 'N2')
TASKS = [f'{fam}-{i:02d}' for fam in FAMILIES for i in range(1, TASKS_PER_WORLD // len(FAMILIES) + 1)]
PROVIDER_FAILURE = re.compile(r'provider error (?:429|5\d\d)\b')
INTERIM_Z, FINAL_Z, PLANNED_EFFECT, FUTILITY_CP, INFO_FRACTION = 2.80, 1.98, 5.4, 0.10, 0.5


def phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


def conditional_power(z, theta=PLANNED_EFFECT, se_interim=None, t=INFO_FRACTION, c=FINAL_Z):
    """P(final z >= c | interim z, true effect theta): Brownian-motion B-value form, final SE = interim SE * sqrt(t)."""
    drift = theta / (se_interim * math.sqrt(t))
    return 1 - phi((c - z * math.sqrt(t) - drift * (1 - t)) / math.sqrt(1 - t))


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

    def run(self, resamples, seed, extra_z=()):
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
        mean = sum(stats) / resamples
        res = {'delta_pp': round(point, 2), 'ci95': [round(lo, 2), round(hi, 2)], 'tasks': sum(len(v) for v in self.tasks.values()),
               'cells': self.counts['cells'], 'a_count': self.counts['a'], 'b_count': self.counts['b'], 'missing_pairs': self.missing,
               'se_pp': round(math.sqrt(sum((s - mean) ** 2 for s in stats) / (resamples - 1)), 3)}
        for z in extra_z:
            p = phi(-z)
            res[f'ci_z{z:.2f}'] = [round(stats[int(p * resamples)], 2), round(stats[min(resamples - 1, int((1 - p) * resamples))], 2)]
        return res


def wording(res, key='ci95'):
    lo, hi = res[key]
    if lo > 0:
        return 'ahead'
    if hi < 0:
        return 'behind'
    return 'parity' if lo > -3 else 'not distinguishable'


def comparison_label(delta):
    return 'drops' if delta < HOLD_AT else 'rises' if delta > RISE_ABOVE else 'holds'


def outcome_row(res, key='ci95'):
    """Precedence (Decision rule): the interval wording first; 'not distinguishable' decides the row on its own."""
    w = wording(res, key)
    return 'not distinguishable from 0' if w == 'not distinguishable' else comparison_label(res['delta_pp'])


def complete(worlds, arms, models, tasks=None):
    """Planned cells absent per (world, arm, model): exactly the worlds N1 and N2, each with every planned task id (or
    exactly the named tasks) for every arm and reader; a missing or extra world is a gap too."""
    want = set(TASKS if tasks is None else tasks)
    gaps = {f'{w}|*|*': 'world missing' for w in CONTROL_WORLDS if w not in worlds}
    gaps.update({f'{w}|*|*': 'world not planned' for w in worlds if w not in CONTROL_WORLDS})
    for w, cells in worlds.items():
        for arm in arms:
            for m in models:
                have = {t for (a, mm, t) in cells if a == arm and mm == m}
                if have != want:
                    stray = sorted(have - want)
                    gaps[f'{w}|{arm}|{m}'] = f'{len(want - have)} missing; outside the planned task ids: {stray}' if stray else len(want - have)
    return gaps


def unretried(worlds, accepted):
    """Counted cells that ended on a provider 5xx or 429, a harness error the preregistration retries, unless named."""
    return sorted(k for w, cells in worlds.items() for (a, m, t), r in cells.items()
                  if r.get('stop') == 'error' and PROVIDER_FAILURE.search(str(r.get('error') or ''))
                  and (k := f'{w}|{a}|{m}|{t}') not in accepted)


def interim(worlds, G, F, B, S):
    """The one look at half A (R113). Stops for a difference at |z| >= 2.80, for futility when conditional power under
    the planned effect is below 10%; otherwise half B runs. A stop reports its estimate as possibly overstated."""
    res = Comparison(worlds, G, F, 'success', FRONTIER).run(B, S, extra_z=(INTERIM_Z,))
    d, se = res['delta_pp'], res['se_pp']
    z = d / se if se else (0.0 if d == 0 else math.copysign(float('inf'), d))
    cp = conditional_power(z, se_interim=se) if se else (1.0 if d >= PLANNED_EFFECT else 0.0)
    if z >= INTERIM_Z:
        decision = 'stop: difference, gbrain ahead'
    elif z <= -INTERIM_Z:
        decision = 'stop: difference, gbrain behind'
    elif cp < FUTILITY_CP:
        decision = 'stop: futility'
    else:
        decision = 'continue'
    key = f'ci_z{INTERIM_Z:.2f}'
    res.update({'z': round(z, 3), 'conditional_power': round(cp, 4), 'decision': decision, 'stopped_early': decision != 'continue',
                'bounds': {'difference_abs_z': INTERIM_Z, 'final_z': FINAL_Z, 'futility_conditional_power_below': FUTILITY_CP,
                           'planned_effect_pp': PLANNED_EFFECT, 'information_fraction': INFO_FRACTION}})
    if res['stopped_early']:
        res.update({'interval_key': key, 'wording': wording(res, key), 'comparison': comparison_label(res['delta_pp']),
                    'outcome_row': outcome_row(res, key), 'possibly_overstated': True})
    return res


def control_row(delta_old, newest_minus_old):
    """Delta_old at +5.3 or more is a regression whatever the paired interval shows; below it the paired newest-minus-old
    95% interval decides: below 0 a smaller regression, above 0 an improvement, otherwise not a regression."""
    if delta_old['delta_pp'] >= HOLD_AT:
        return 'regression'
    lo, hi = newest_minus_old['ci95']
    if hi < 0:
        return 'smaller regression'
    if lo > 0:
        return 'newest improved'
    return 'not a regression'


def without(worlds, drop):
    """The same cells without every arm's cell for each dropped (world, model, task): the widened-session sensitivity."""
    return {w: {k: r for k, r in cells.items() if (w, k[1], k[2]) not in drop} for w, cells in worlds.items()}


def control(worlds, cost, O, G, F, B, S, transcripts=None):
    """The old-build control. Both differences use one draw sequence: every arm covers the same tasks per world, so each
    Comparison's random.Random(S) stream draws the same tasks (checked below). transcripts maps each world to its own
    transcript files, because attempt ids don't name the world."""
    old = Comparison(worlds, O, F, 'success', FRONTIER)
    nmo = Comparison(worlds, G, O, 'success', FRONTIER)
    if old.tasks != nmo.tasks:
        raise ValueError('the old, newest and files arms do not cover the same tasks; the paired draws would differ')
    d_old, d_nmo = old.run(B, S), nmo.run(B, S)
    if d_old['missing_pairs'] or d_nmo['missing_pairs']:
        raise ValueError(f"{d_old['missing_pairs'] + d_nmo['missing_pairs']} task pairs lack a cell in one arm; the arms must cover the same task ids")
    row = control_row(d_old, d_nmo)
    out = {'look': 'control', 'resamples': B, 'seed': S, 'arms': {'old': O, 'newest': G, 'fs': F}, 'readers_pooled': FRONTIER,
           'delta_old': d_old, 'newest_minus_old': d_nmo, 'outcome_row': row, 'threshold_regression_at_or_above': HOLD_AT,
           'note': 'newest lower, within noise' if row == 'not a regression' and d_nmo['delta_pp'] < 0 else None,
           'per_reader': {}, 'per_world': {}, 'per_family': {}, 'secondary': {}, 'first_table': {}}
    for m in FRONTIER:
        out['per_reader'][m] = {'delta_old': Comparison(worlds, O, F, 'success', [m]).run(B, S),
                                'newest_minus_old': Comparison(worlds, G, O, 'success', [m]).run(B, S)}
    for w in sorted(worlds):
        one = {w: worlds[w]}
        out['per_world'][w] = {'delta_old': Comparison(one, O, F, 'success', FRONTIER).run(B, S),
                               'newest_minus_old': Comparison(one, G, O, 'success', FRONTIER).run(B, S)}
    fams = [(f, lambda r, f=f: r['family'] == f) for f in FAMILIES]
    fams += [('H4+long', lambda r: r['family'] == 'H4' and '+long' in str(r.get('variant', ''))),
             ('H4-not-long', lambda r: r['family'] == 'H4' and '+long' not in str(r.get('variant', '')))]
    for name, flt in fams:
        out['per_family'][name] = {'delta_old': Comparison(worlds, O, F, 'success', FRONTIER, task_filter=flt).run(B, S),
                                   'newest_minus_old': Comparison(worlds, G, O, 'success', FRONTIER, task_filter=flt).run(B, S),
                                   'delta_newest': Comparison(worlds, G, F, 'success', FRONTIER, task_filter=flt).run(B, S)}
    out['h4_regression'] = out['per_family']['H4']['newest_minus_old']['ci95'][1] < 0
    for what in ('wrong_value', 'wrong_submitted', 'not_submitted', 'turn_cap'):
        out['secondary'][what] = {'delta_old': Comparison(worlds, O, F, what, FRONTIER).run(B, S),
                                  'newest_minus_old': Comparison(worlds, G, O, what, FRONTIER).run(B, S)}
    for m in FRONTIER:
        for arm in (O, G, F):
            n = sum(1 for cells in worlds.values() for (a, mm, _), r in cells.items() if a == arm and mm == m and r['score'].get('success'))
            usd = cost.get((arm, m), 0.0)
            out['first_table'][f'{arm}|{m}'] = {'successes': n, 'cost_per_correct_usd': round(usd / n, 4) if n else None}
    out['first_table'][f'{O}|{PARTICLE}'] = 'not run in this control (the decision reads only the frontier readers)'
    if transcripts:
        out['tool_calls'], widened = {}, set()
        if set(transcripts) != set(worlds):
            raise ValueError(f'the widened-session sensitivity needs transcripts for every world: {sorted(set(worlds) - set(transcripts))} missing')
        for w, paths in sorted(transcripts.items()):
            seen = set()
            for p in paths:
                with open(p) as f:
                    seen |= {json.loads(line).get('attempt_id') for line in f if line.strip()}
            lacking = {r['attempt_id'] for k, r in worlds[w].items() if k[0] in (O, G)} - seen
            if lacking:
                raise ValueError(f'{w}: {len(lacking)} old- or newest-build attempts have no transcript; the widened-session sensitivity needs them all')
            for label in (O, G):
                stats, wid = tool_stats(paths, label, worlds_of={w: worlds[w]})
                for k, v in stats.items():
                    if k.split('|')[0] == label:
                        acc = out['tool_calls'].setdefault(k, {})
                        for kk, vv in v.items():
                            acc[kk] = acc.get(kk, 0) + vv
                widened |= wid
        cut = without(worlds, widened)
        out['without_widened_sessions'] = {'dropped_pairs': len(widened),
                                           'delta_old': Comparison(cut, O, F, 'success', FRONTIER).run(B, S),
                                           'newest_minus_old': Comparison(cut, G, O, 'success', FRONTIER).run(B, S)}
    return out


def claims_summary(worlds, arm, model):
    rows = [r for cells in worlds.values() for (a, m, _), r in cells.items() if a == arm and m == model and r.get('claims')]
    if not rows:
        return None
    bad = [r['claims']['unsupported'] + r['claims']['contradicted'] for r in rows]
    return {'answers_judged': len(rows), 'mean_bad_claims': round(sum(bad) / len(rows), 3), 'share_with_bad_claim': round(sum(1 for b in bad if b) / len(rows), 3)}


def tool_stats(paths, gbrain_label, worlds_of=None):
    """Tool-call counts per arm and reader. With worlds_of, also returns the (world, model, task) of every gbrain_label cell
    whose session widened itself to the full surface with request_tools, located by its attempt id in those worlds."""
    out = defaultdict(lambda: defaultdict(int))
    widened = set()
    where = {}
    if worlds_of is not None:
        where = {r['attempt_id']: (w, k[1], k[2]) for w, cells in worlds_of.items() for k, r in cells.items() if k[0] == gbrain_label}
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                model, arm = r['key'].split('|')[:2]
                s = out[f'{arm}|{model}']
                if arm == gbrain_label and any(c.get('name') == 'request_tools' and '"surface":"full"' in str(c.get('result', '')).replace(' ', '')
                                               and '"previous":"starter"' in str(c.get('result', '')).replace(' ', '') for c in r.get('tools', [])):
                    s['cells_widened_to_full'] += 1
                    if r.get('attempt_id') in where:
                        widened.add(where[r['attempt_id']])
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
    stats = {k: dict(v) for k, v in sorted(out.items())}
    return (stats, widened) if worlds_of is not None else stats


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--world', action='append', required=True, help='NAME=file[,file...]')
    ap.add_argument('--transcripts')
    ap.add_argument('--world-transcripts', action='append', help='--look control: NAME=transcripts.jsonl[,...] per world')
    ap.add_argument('--judge-check')
    ap.add_argument('--gbrain', default='gbrain-newest')
    ap.add_argument('--fs', default='fs')
    ap.add_argument('--resamples', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--json')
    ap.add_argument('--look', choices=('interim', 'final', 'control'), default='final')
    ap.add_argument('--old', default='gbrain-old-09d')
    ap.add_argument('--accept-unretried', action='append', default=[], help='WORLD|arm|model|task of a cell that ended on a provider failure and was not retried, counted as scored; the results page must disclose it')
    args = ap.parse_args(argv)
    worlds, cost = {}, defaultdict(float)
    for spec in args.world:
        name, files = spec.split('=', 1)
        worlds[name], c = load(files.split(','))
        for k, v in c.items():
            cost[k] += v
    bad = unretried(worlds, set(args.accept_unretried))
    if bad:
        print(json.dumps({'refused': 'HARNESS_ERROR_SCORED', 'cells': bad}), file=sys.stderr)
        print('STOP HARNESS_ERROR_SCORED: these cells ended on a provider 5xx or 429, which the preregistration retries; resume them, or name each with --accept-unretried after disclosing it', file=sys.stderr)
        return 3
    G, F, B, S = args.gbrain, args.fs, args.resamples, args.seed
    if args.look == 'control':
        if set(worlds) != set(CONTROL_WORLDS):
            print(f'STOP CONTROL_INCOMPLETE: the control reads exactly the worlds {list(CONTROL_WORLDS)}, got {sorted(worlds)}', file=sys.stderr)
            return 3
        gaps = complete(worlds, [args.old, G, F], FRONTIER)
        if gaps:
            print(json.dumps({'refused': 'CONTROL_INCOMPLETE', 'missing_cells': gaps}), file=sys.stderr)
            print('STOP CONTROL_INCOMPLETE: the control needs every planned cell of the old, newest and files arms; resume the missing cells', file=sys.stderr)
            if any(isinstance(v, str) and 'outside the planned task ids' in v for v in gaps.values()):
                print('STOP CONTROL_INCOMPLETE: task pairs lack a cell in one arm; the arms must cover the same planned task ids', file=sys.stderr)
            return 3
        if args.transcripts:
            print('--look control takes --world-transcripts NAME=file[,file...] per world, not --transcripts', file=sys.stderr)
            return 2
        wt = dict(spec.split('=', 1) for spec in args.world_transcripts or [])
        if set(wt) - set(worlds):
            print(f'--world-transcripts names worlds not given with --world: {sorted(set(wt) - set(worlds))}', file=sys.stderr)
            return 2
        try:
            out = control(worlds, cost, args.old, G, F, B, S, {w: f.split(',') for w, f in wt.items()} or None)
        except ValueError as e:
            print(f'STOP CONTROL_INCOMPLETE: {e}', file=sys.stderr)
            return 3
        if args.json:
            with open(args.json, 'w') as f:
                f.write(json.dumps(out, indent=1, allow_nan=False))
        d, n = out['delta_old'], out['newest_minus_old']
        print(f"control: old - files {d['delta_pp']:+.2f} pp [{d['ci95'][0]:+.2f}, {d['ci95'][1]:+.2f}]; newest - old {n['delta_pp']:+.2f} pp [{n['ci95'][0]:+.2f}, {n['ci95'][1]:+.2f}]; outcome row: {out['outcome_row']}{'; ' + out['note'] if out['note'] else ''}; H4 regression: {out['h4_regression']}")
        return 0
    if args.look == 'interim':
        gaps = complete(worlds, [G, F], FRONTIER, HALF_A)
        if gaps:
            print(json.dumps({'refused': 'INTERIM_INCOMPLETE', 'missing_cells': gaps}), file=sys.stderr)
            print('STOP INTERIM_INCOMPLETE: the look reads exactly half A (tasks 01 to 10 of each family) for both arms and readers in every world', file=sys.stderr)
            return 3
        look = {'look': 'interim', 'resamples': B, 'seed': S, 'tasks': HALF_A, 'headline': interim(worlds, G, F, B, S)}
        if args.json:
            with open(args.json, 'w') as f:
                f.write(json.dumps(look, indent=1, allow_nan=False))
        h = look['headline']
        print(f"interim: gbrain - files {h['delta_pp']:+.2f} pp, se {h['se_pp']:.2f}, z {h['z']:+.2f}, conditional power {h['conditional_power']:.3f}: {h['decision']}")
        return 0
    gaps = complete(worlds, [G, F], FRONTIER)
    if gaps:
        print(json.dumps({'refused': 'HEADLINE_INCOMPLETE', 'missing_cells': gaps}), file=sys.stderr)
        print('STOP HEADLINE_INCOMPLETE: resume the missing cells with the same step command; no endpoint is computed on fewer cells', file=sys.stderr)
        return 3
    head = Comparison(worlds, G, F, 'success', FRONTIER).run(B, S, extra_z=(FINAL_Z,))
    key = f'ci_z{FINAL_Z:.2f}'
    head.update({'interval_key': key, 'wording': wording(head, key), 'comparison': comparison_label(head['delta_pp']), 'outcome_row': outcome_row(head, key),
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
    print(f"headline: gbrain - files {h['delta_pp']:+.2f} pp [{h[key][0]:+.2f}, {h[key][1]:+.2f}] (z {FINAL_Z}) over {h['tasks']} tasks, readers {', '.join(FRONTIER)}: {h['wording']}; against the published leads: {h['comparison']}; outcome row: {h['outcome_row']}")
    h4 = out['per_family']['H4']
    print(f"H4: {h4['delta_pp']:+.2f} pp [{h4['ci95'][0]:+.2f}, {h4['ci95'][1]:+.2f}] level_or_behind={h4['level_or_behind']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
