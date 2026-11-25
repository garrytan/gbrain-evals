#!/usr/bin/env python3
"""Cat 40 Hard H4 section-delivery confirmation analysis
(docs/benchmarks/2026-11-24-cat40-h4-fix-confirmation-preregistration.md).

Usage:
  python3 eval/runner/cat40/h4fix_analysis.py --world S3=<attempts.jsonl>[,<more>] ... --world S8=<...> \
      [--transcripts <transcripts.jsonl>[,<more>]] [--world-file S3=<world.json> ...] [--look interim|final] \
      [--stopped none|difference|futility] [--resamples 10000] [--seed 1] [--json out.json]

Canonical cell: the last attempt per (arm, reader, task, repeat) whose stop is not harness_error; cost sums every
attempt. A task's success in an arm is the mean over its repeats. Every comparison is paired by task: arm a minus arm b,
per reader averaged over tasks, then over the readers named. Intervals: tasks nested in worlds, worlds fixed and visited
in order S3 to S8; 10,000 resamples from one random.Random(1) stream per comparison; each resample draws that world's
task count of ids with replacement (rng.choice over the ids sorted as strings); a drawn task brings all its cells.

--look interim reads exactly H4 half A (H4-01 to H4-10 on every world) for both gbrain arms and both frontier readers.
It takes no stop when the bootstrap standard error is 0, stops for a difference at |z| >= 2.80, and stops for futility
only when conditional power to end at z >= 1.98 under +12.2 points and to end at z <= -1.98 under -12.2 points are each
below 10%. --look final reads every planned cell (half A only for H4 after --stopped difference or futility) and
refuses an endpoint while any planned frontier cell is missing. Counts and rates only; with --world-file it reads the
answer keys and reference forms on the custody VM and prints counts, never content.
"""
import argparse, json, math, random, sys
from collections import defaultdict

WORLDS = ['S3', 'S4', 'S5', 'S6', 'S7', 'S8']
FULL_WORLDS = ['S3', 'S4']
FRONTIER = ['claude-opus-5-5', 'gpt-6.2-sol']
PRIMARY = 'claude-opus-5-5'
PARTICLE = 'particle-1'
SECTION, DEFAULT, FS = 'gbrain-section', 'gbrain-default', 'fs'
OTHER = ['H1', 'H2', 'H3', 'H5']
H4_ALL = [f'H4-{i:02d}' for i in range(1, 21)]
H4_A = H4_ALL[:10]
OTHER_TASKS = [f'{f}-{i:02d}' for f in OTHER for i in range(1, 21)]
INTERIM_Z, FINAL_Z, PLANNED_EFFECT, FUTILITY_CP, INFO_FRACTION = 2.80, 1.98, 12.2, 0.10, 0.5
NO_HARM_MARGIN = -5.0
LEVEL_FLOOR = -3.0


def phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2))


def conditional_power(z, theta=PLANNED_EFFECT, se_interim=None, t=INFO_FRACTION, c=FINAL_Z):
    """P(final z >= c | interim z, true effect theta): B-value form, final SE = interim SE * sqrt(t)."""
    drift = theta / (se_interim * math.sqrt(t))
    return 1 - phi((c - z * math.sqrt(t) - drift * (1 - t)) / math.sqrt(1 - t))


def load(paths):
    """{(arm, model, task): [success per repeat, ...]} records, cost and cell counts per (arm, model)."""
    canon, cost, attempts, source = {}, defaultdict(float), defaultdict(int), {}
    seen = set()
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                if r.get('attempt_id') in seen:
                    continue
                seen.add(r.get('attempt_id'))
                cost[(r['arm'], r['model'])] += float(r.get('total_usd') or 0) + float(r.get('judge_usd') or 0)
                attempts[(r['arm'], r['model'])] += 1
                if r.get('stop') == 'harness_error':
                    continue
                k = (r['arm'], r['model'], r['task'], int(r.get('repeat') or 0))
                if source.setdefault(k, p) != p:
                    raise SystemExit(f'DUPLICATE_CELL: {"|".join(map(str, k))} appears in {source[k]} and {p}; pass each counted step\'s attempts once and never a pilot\'s')
                if k not in canon or int(r.get('attempt') or 0) >= int(canon[k].get('attempt') or 0):
                    canon[k] = r
    cells = defaultdict(dict)
    for (arm, model, task, rep), r in canon.items():
        cells[(arm, model, task)][rep] = r
    return dict(cells), cost


def success(reps):
    return sum(1.0 if r['score'].get('success') else 0.0 for r in reps.values()) / len(reps)


class Comparison:
    """Arm a minus arm b, paired by task, per reader then averaged over the readers, on the named tasks per world."""

    def __init__(self, worlds, a, b, models, tasks_for):
        self.models, self.diff, self.tasks, self.missing = models, {}, {}, []
        for w in WORLDS:
            if w not in worlds:
                continue
            ids = sorted(tasks_for(w), key=str)
            for t in ids:
                per = {}
                for m in models:
                    ka, kb = (a, m, t), (b, m, t)
                    if ka in worlds[w] and kb in worlds[w]:
                        per[m] = success(worlds[w][ka]) - success(worlds[w][kb])
                    else:
                        self.missing.append(f'{w}|{m}|{t}')
                self.diff[(w, t)] = per
            if ids:
                self.tasks[w] = ids

    def delta(self, draw):
        num, den = defaultdict(float), defaultdict(int)
        for key in draw:
            for m, d in self.diff[key].items():
                num[m] += d
                den[m] += 1
        ms = [m for m in self.models if den[m]]
        return sum(num[m] / den[m] for m in ms) / len(ms) * 100 if ms else float('nan')

    def run(self, resamples, seed, extra_z=()):
        if not self.tasks:
            return {'delta_pp': None, 'ci95': None, 'tasks': 0, 'missing': len(self.missing)}
        point = self.delta([(w, t) for w in self.tasks for t in self.tasks[w]])
        rng = random.Random(seed)
        stats = []
        for _ in range(resamples):
            draw = []
            for w, ids in self.tasks.items():
                draw.extend((w, rng.choice(ids)) for _ in range(len(ids)))
            stats.append(self.delta(draw))
        stats.sort()
        mean = sum(stats) / resamples
        res = {'delta_pp': round(point, 2), 'ci95': [round(stats[int(0.025 * resamples)], 2), round(stats[min(resamples - 1, int(0.975 * resamples))], 2)],
               'tasks': sum(len(v) for v in self.tasks.values()), 'missing': len(self.missing),
               'se_pp': round(math.sqrt(sum((s - mean) ** 2 for s in stats) / (resamples - 1)), 3),
               '_point': point, '_se': math.sqrt(sum((s - mean) ** 2 for s in stats) / (resamples - 1))}
        for z in extra_z:
            p = phi(-z)
            res[f'ci_z{z:.2f}'] = [round(stats[int(p * resamples)], 2), round(stats[min(resamples - 1, int((1 - p) * resamples))], 2)]
        return res


def primary_wording(ci):
    lo, hi = ci
    return 'helps' if lo > 0 else 'hurts' if hi < 0 else 'not distinguishable'


def gap_wording(ci):
    """Behind takes precedence; ahead; level (no more than 3 points behind) needs an upper bound at or above 0."""
    lo, hi = ci
    if hi < 0:
        return 'behind files'
    if lo > 0:
        return 'ahead of files'
    if lo > LEVEL_FLOOR:
        return 'level with files'
    return 'not distinguishable from files'


def decision_row(primary, no_harm):
    if primary == 'helps':
        return 'flip to Garry' if no_harm else 'helps, harm not ruled out: scoped version to GBRA-108'
    if primary == 'hurts':
        return 'closed: hurts'
    return 'closed: not distinguishable (Why null)'


def h4_tasks(stopped):
    return H4_A if stopped in ('difference', 'futility') else H4_ALL


def planned(stopped):
    """Planned frontier cells: (world, arm, task, repeats)."""
    out = []
    for w in WORLDS:
        for t in h4_tasks(stopped):
            out += [(w, SECTION, t, 2), (w, DEFAULT, t, 2), (w, FS, t, 1)]
        if w in FULL_WORLDS:
            for t in OTHER_TASKS:
                out += [(w, SECTION, t, 1), (w, DEFAULT, t, 1), (w, FS, t, 1)]
    return out


def gaps(worlds, models, cells_planned):
    miss = defaultdict(int)
    for w, arm, t, reps in cells_planned:
        for m in models:
            have = worlds.get(w, {}).get((arm, m, t), {})
            if len(have) < reps:
                miss[f'{w}|{arm}|{m}'] += reps - len(have)
    return dict(miss)


def half_a(worlds):
    """The look's cells: H4 half A for both gbrain arms and both frontier readers."""
    return {w: {k: v for k, v in cells.items() if k[0] in (SECTION, DEFAULT) and k[1] in FRONTIER and k[2] in H4_A} for w, cells in worlds.items()}


def interim(worlds, B, S):
    gbrain_cells = {w: {k: v for k, v in cells.items() if k[0] in (SECTION, DEFAULT) and k[1] in FRONTIER} for w, cells in worlds.items()}
    want = {(w, arm, m, t) for w in WORLDS for arm in (SECTION, DEFAULT) for m in FRONTIER for t in H4_A}
    have = {(w, arm, m, t) for w, cells in gbrain_cells.items() for (arm, m, t), reps in cells.items() if t.startswith('H4') and len(reps) == 2}
    stray = {(w, arm, m, t) for w, cells in gbrain_cells.items() for (arm, m, t) in cells if t.startswith('H4') and t not in H4_A}
    if have != want or stray:
        raise SystemExit(f'INTERIM_INCOMPLETE: the look needs exactly H4 half A at repeat 2 for both gbrain arms and both frontier readers on S3 to S8 ({len(want - have)} missing, {len(stray)} outside half A)')
    res = Comparison(worlds, SECTION, DEFAULT, [PRIMARY], lambda w: H4_A).run(B, S, extra_z=(INTERIM_Z,))
    d, se = res.pop('_point'), res.pop('_se')
    if se < 1e-9:
        res.update({'z': None, 'decision': 'continue', 'stopped_early': False, 'reason': 'bootstrap standard error is 0: no stop'})
        return res
    z = d / se
    cp_gain = conditional_power(z, PLANNED_EFFECT, se)
    cp_harm = conditional_power(-z, PLANNED_EFFECT, se)
    if z >= INTERIM_Z:
        decision = 'stop: difference, section delivery ahead'
    elif z <= -INTERIM_Z:
        decision = 'stop: difference, section delivery behind'
    elif cp_gain < FUTILITY_CP and cp_harm < FUTILITY_CP:
        decision = 'stop: futility'
    else:
        decision = 'continue'
    res.update({'z': round(z, 3), 'conditional_power_gain': round(cp_gain, 4), 'conditional_power_harm': round(cp_harm, 4), 'decision': decision,
                'stopped_early': decision != 'continue'})
    if res['stopped_early']:
        res['possibly_overstated'] = decision.startswith('stop: difference')
    return res


def claims(worlds, arm, model, tasks=None):
    rows = [r for cells in worlds.values() for (a, m, t), reps in cells.items() if a == arm and m == model and (tasks is None or t in tasks) for r in reps.values() if r.get('claims')]
    if not rows:
        return None
    bad = [int(r['claims'].get('unsupported', 0)) + int(r['claims'].get('contradicted', 0)) for r in rows]
    contra = [int(r['claims'].get('contradicted', 0)) for r in rows]
    return {'answers_judged': len(rows), 'answers_flagged_share': round(sum(1 for b in bad if b) / len(rows), 3),
            'descriptive_not_rule_checked': {'contradicted_or_unsupported_per_answer': round(sum(bad) / len(rows), 3),
                                             'contradicted_per_answer': round(sum(contra) / len(rows), 3)}}


def costs(worlds, cost):
    out = {}
    for (arm, model), usd in sorted(cost.items()):
        reps = [r for cells in worlds.values() for (a, m, _), rr in cells.items() if a == arm and m == model for r in rr.values()]
        correct = sum(1 for r in reps if r['score'].get('success'))
        out[f'{arm}|{model}'] = {'cells': len(reps), 'correct': correct, 'usd': round(usd, 4), 'usd_per_cell': round(usd / len(reps), 4) if reps else None,
                                 'usd_per_correct': round(usd / correct, 4) if correct else None}
    return out


def tool_stats(paths, world_files=None):
    """Per arm and reader: searches, searches whose rows the setting delivered (reason long_page), searches where the
    agent asked for a unit itself (return_unit), get_page grep calls with an alternation and how many returned matches.
    With world files (custody VM only): H4 items whose governing documents never appeared in a tool result, grouped by
    the reference form the governing document uses for the item's account."""
    s = defaultdict(lambda: defaultdict(int))
    keys = {}
    if world_files and len(world_files) > 1:
        raise SystemExit('ONE_WORLD_FILE: --world-file runs per world on its custody VM, with that world\'s transcripts only')
    for w, wf in (world_files or {}).items():
        world = json.load(open(wf))
        refs = defaultdict(set)
        for ref in world.get('references', []):
            refs[ref['doc']].add((ref['entity'], ref['form']))
        for t in world['tasks']:
            if t['family'] != 'H4':
                continue
            items = []
            for it in (t['gold'].get('items') or []):
                gov = [d for d in t['gold']['evidence'] if any(e == it['account'] for e, _ in refs.get(d, ()))]
                forms = sorted({f for d in gov for e, f in refs.get(d, ()) if e == it['account']})
                items.append((gov, forms[0] if forms else 'name'))
            keys[t['id']] = items
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                model, arm, task = r['key'].split('|')[:3]
                row = s[f'{arm}|{model}']
                seen_text = ''
                for c in r.get('tools', []):
                    name, args, result = c.get('name', ''), c.get('args') or {}, str(c.get('result', ''))
                    seen_text += result
                    if name in ('search', 'query'):
                        row[f'{name}'] += 1
                        rows = result.replace(' ', '').count('"reason":"long_page"')
                        if rows:
                            row[f'{name}_calls_long_page'] += 1
                            row[f'{name}_rows_long_page'] += rows
                        if 'return_unit' in args:
                            row[f'{name}_explicit_return_unit'] += 1
                    if name == 'get_page' and '|' in str(args.get('grep') or ''):
                        row['grep_alternation'] += 1
                        try:
                            g = json.loads(result).get('grep') or {}
                        except (ValueError, AttributeError):
                            g = {}
                        if int(g.get('total_matches') or 0) > 0:
                            row['grep_alternation_matched'] += 1
                for gov, form in keys.get(task, []):
                    if gov and not any(d in seen_text for d in gov):
                        row[f'h4_governing_never_returned:{form}'] += 1
    return {k: dict(v) for k, v in sorted(s.items())}


LOOK_FOR = {'continue': 'none', 'stop: futility': 'futility', 'stop: difference, section delivery ahead': 'difference', 'stop: difference, section delivery behind': 'difference'}


def final(worlds, cost, stopped, B, S, transcripts, world_files):
    plan = planned(stopped)
    miss = gaps(worlds, FRONTIER, plan)
    if miss:
        raise SystemExit(f'FINAL_INCOMPLETE: planned frontier cells are missing: {json.dumps(miss, sort_keys=True)}')
    look = interim(half_a(worlds), 10000, 1)
    if LOOK_FOR[look['decision']] != stopped:
        raise SystemExit(f'LOOK_MISMATCH: the half-A cells give "{look["decision"]}", but --stopped is {stopped}')
    if stopped != 'none':
        late = sorted(f'{w}|{a}|{m}|{t}' for w, cells in worlds.items() for (a, m, t) in cells if t in H4_ALL and t not in H4_A)
        if late:
            raise SystemExit(f'HALF_B_AFTER_STOP: {len(late)} H4 half-B cells are present after a stop at the look, e.g. {late[0]}')
    h4 = h4_tasks(stopped)
    label = 'half A only' if stopped in ('difference', 'futility') else None
    h4_for = lambda w: h4
    other_for = lambda w: OTHER_TASKS if w in FULL_WORLDS else []
    if stopped == 'difference':
        prim = Comparison(worlds, SECTION, DEFAULT, [PRIMARY], h4_for).run(B, S, extra_z=(INTERIM_Z,))
        key = f'ci_z{INTERIM_Z:.2f}'
        prim.update({'interval_key': key, 'wording': primary_wording(prim[key]), 'possibly_overstated': True})
    elif stopped == 'futility':
        prim = Comparison(worlds, SECTION, DEFAULT, [PRIMARY], h4_for).run(B, S)
        prim.update({'interval_key': 'ci95', 'wording': 'not distinguishable'})
    else:
        prim = Comparison(worlds, SECTION, DEFAULT, [PRIMARY], h4_for).run(B, S, extra_z=(FINAL_Z,))
        key = f'ci_z{FINAL_Z:.2f}'
        prim.update({'interval_key': key, 'wording': primary_wording(prim[key])})
    other = Comparison(worlds, SECTION, DEFAULT, FRONTIER, other_for).run(B, S)
    no_harm = other['ci95'][0] > NO_HARM_MARGIN
    other.update({'margin_pp': NO_HARM_MARGIN, 'no_harm': no_harm})
    out = {'stopped_at_look': stopped, 'primary': prim, 'no_harm_other_families': other,
           'decision_row': decision_row(prim['wording'], no_harm),
           'secondary': {
               'h4_pooled': Comparison(worlds, SECTION, DEFAULT, FRONTIER, h4_for).run(B, S),
               'h4_sol': Comparison(worlds, SECTION, DEFAULT, ['gpt-6.2-sol'], h4_for).run(B, S),
               'gap_to_files': {}, 'particle': {}, 'claims': {}, 'cost': costs(worlds, cost)}}
    for name, models in (('opus', [PRIMARY]), ('sol', ['gpt-6.2-sol']), ('pooled', FRONTIER)):
        g = Comparison(worlds, SECTION, FS, models, h4_for).run(B, S)
        g['wording'] = gap_wording(g['ci95'])
        out['secondary']['gap_to_files'][name] = g
    p_miss = gaps(worlds, [PARTICLE], [(w, a, t, 1) for (w, a, t, _) in plan])
    if p_miss:
        out['secondary']['particle'] = {'incomplete': p_miss}
    else:
        out['secondary']['particle'] = {'h4_delta': Comparison(worlds, SECTION, DEFAULT, [PARTICLE], h4_for).run(B, S),
                                        'h4_gap_to_files': Comparison(worlds, SECTION, FS, [PARTICLE], h4_for).run(B, S), 'descriptive': True}
    for arm in (SECTION, DEFAULT, FS):
        for m in FRONTIER + [PARTICLE]:
            c = claims(worlds, arm, m)
            if c:
                out['secondary']['claims'][f'{arm}|{m}'] = c
    if transcripts:
        out['secondary']['transcripts'] = tool_stats(transcripts, world_files)
    if label:
        out['h4_secondaries_label'] = label
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--world', action='append', required=True, help='NAME=file[,file...]')
    ap.add_argument('--transcripts')
    ap.add_argument('--world-file', action='append', default=[], help='NAME=world.json (custody VM only)')
    ap.add_argument('--look', choices=('interim', 'final'), default='final')
    ap.add_argument('--stopped', choices=('none', 'difference', 'futility'), default='none')
    ap.add_argument('--resamples', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--json')
    a = ap.parse_args(argv)
    worlds, cost = {}, defaultdict(float)
    for spec in a.world:
        name, files = spec.split('=', 1)
        if name not in WORLDS:
            raise SystemExit(f'UNKNOWN_WORLD: {name} is not one of {WORLDS}')
        worlds[name], c = load(files.split(','))
        for k, v in c.items():
            cost[k] += v
    if a.look == 'interim':
        out = {'look': 'interim', 'headline': interim(worlds, a.resamples, a.seed)}
    else:
        wf = dict(s.split('=', 1) for s in a.world_file)
        out = {'look': 'final', **final(worlds, cost, a.stopped, a.resamples, a.seed, a.transcripts.split(',') if a.transcripts else None, wf)}
    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items() if not k.startswith('_')}
        return [clean(v) for v in o] if isinstance(o, list) else o
    out = clean(out)
    text = json.dumps(out, indent=2, sort_keys=True)
    if a.json:
        with open(a.json, 'w') as f:
            f.write(text + '\n')
    print(text)


if __name__ == '__main__':
    main()
