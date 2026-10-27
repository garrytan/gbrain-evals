#!/usr/bin/env python3
"""Cat 40 next wave confirmation analysis (docs/plans/2026-10-11-cat40-next-wave/PREREG.md, Endpoints).

Usage:
  python3 eval/runner/cat40/next_confirm_analysis.py --world P1=<attempts or results.jsonl>[,<more files>] \
      --world P2=<...> [--world S1=<...> --world S2=<...>] [--wave gbrain-next-wave] [--baseline gbrain-next-baseline] \
      [--fs fs] [--resamples 10000] [--seed 1] [--json out.json]

Each --world names one world and the cell files of every arm that ran on it. Worlds named P* belong to the public
generator and S* to the sealed generator. Canonical cells: the last attempt per (arm, model, task) whose stop is not
`harness_error`.

Primary, per generator G (PREREG.md): Delta_G = mean over models of (wave rate - fs rate) over all of G's tasks.
Interval: tasks nested in seeds, seeds fixed; 10,000 resamples from one random.Random(1) stream; each resample visits
G's worlds in name order and draws that world's task count of task ids with replacement (rng.choice over the world's
task ids sorted as strings); a drawn task carries every model's cells of both arms. Percentile 2.5 / 97.5.
Secondaries use the same procedure. Counts and rates only; no world content is read.
"""
import argparse, json, random, sys
from collections import defaultdict

MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']
FAMILIES = ['H1', 'H2', 'H3', 'H4', 'H5']


def load(paths):
    cells = {}
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                if r.get('stop') == 'harness_error':
                    continue
                cells[(r['arm'], r['model'], r['task'])] = r
    return cells


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
    """Arm a minus arm b over a set of worlds, restricted by task and model filters."""

    def __init__(self, worlds, a, b, what, models=MODELS, task_filter=None):
        self.worlds = sorted(worlds)
        self.models = models
        f = metric(what)
        self.tasks = {}
        self.diff = {}
        self.counts = {'cells': 0, 'a': 0.0, 'b': 0.0}
        for w in self.worlds:
            cells = worlds[w]
            tasks = sorted({t for (arm, m, t) in cells if arm == a and (task_filter is None or task_filter(cells[(arm, m, t)]))}, key=str)
            keep = []
            for t in tasks:
                per = {}
                for m in models:
                    ka, kb = (a, m, t), (b, m, t)
                    if ka in cells and kb in cells:
                        per[m] = (f(cells[ka]), f(cells[kb]))
                if per:
                    keep.append(t)
                    self.diff[(w, t)] = per
                    self.counts['cells'] += len(per)
                    self.counts['a'] += sum(x for x, _ in per.values())
                    self.counts['b'] += sum(y for _, y in per.values())
            self.tasks[w] = keep

    def delta(self, draw):
        """Mean over models of the per-model rate difference on the drawn (world, task) list."""
        num = defaultdict(float)
        den = defaultdict(int)
        for key in draw:
            for m, (x, y) in self.diff[key].items():
                num[m] += x - y
                den[m] += 1
        ms = [m for m in self.models if den[m]]
        return sum(num[m] / den[m] for m in ms) / len(ms) * 100 if ms else float('nan')

    def run(self, resamples, seed):
        if not any(self.tasks.values()):
            return {'delta_pp': None, 'ci95': None, 'tasks': 0, 'cells': 0, 'a_count': 0.0, 'b_count': 0.0}
        point = self.delta([(w, t) for w in self.worlds for t in self.tasks[w]])
        rng = random.Random(seed)
        stats = []
        for _ in range(resamples):
            draw = []
            for w in self.worlds:
                ids = self.tasks[w]
                if not ids:
                    continue
                draw.extend((w, rng.choice(ids)) for _ in range(len(ids)))
            stats.append(self.delta(draw))
        stats.sort()
        lo = stats[int(0.025 * resamples)]
        hi = stats[min(resamples - 1, int(0.975 * resamples))]
        return {'delta_pp': round(point, 2), 'ci95': [round(lo, 2), round(hi, 2)], 'tasks': sum(len(v) for v in self.tasks.values()),
                'cells': self.counts['cells'], 'a_count': self.counts['a'], 'b_count': self.counts['b']}


def wording(res):
    if not res['tasks']:
        return 'no cells'
    lo = res['ci95'][0]
    if lo > 0:
        return 'ahead'
    if lo > -3:
        return 'parity'
    return 'not distinguishable'


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--world', action='append', required=True, help='NAME=file[,file...]; P* public, S* sealed')
    ap.add_argument('--wave', default='gbrain-next-wave')
    ap.add_argument('--baseline', default='gbrain-next-baseline')
    ap.add_argument('--fs', default='fs')
    ap.add_argument('--resamples', type=int, default=10000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--json')
    args = ap.parse_args(argv)
    worlds = {}
    for spec in args.world:
        name, files = spec.split('=', 1)
        worlds[name] = load(files.split(','))
    gens = defaultdict(dict)
    for name, cells in worlds.items():
        gens['public' if name.upper().startswith('P') else 'sealed'][name] = cells
    B, S = args.resamples, args.seed
    out = {'resamples': B, 'seed': S, 'arms': {'wave': args.wave, 'baseline': args.baseline, 'fs': args.fs}, 'primary': {}, 'secondary': {}}
    has_baseline = any(k[0] == args.baseline for c in worlds.values() for k in c)
    for g, ws in sorted(gens.items()):
        res = Comparison(ws, args.wave, args.fs, 'success').run(B, S)
        res['wording'] = wording(res)
        res['per_world'] = {w: Comparison({w: ws[w]}, args.wave, args.fs, 'success').run(B, S) for w in sorted(ws)}
        out['primary'][g] = res
    p = out['primary']
    out['general_claim'] = bool(p.get('public') and p.get('sealed') and p['public']['tasks'] and p['sealed']['tasks'] and p['public']['delta_pp'] >= 0 and p['sealed']['delta_pp'] >= 0)
    groups = dict(gens)
    groups['all'] = worlds
    sec = out['secondary']
    for g, ws in sorted(groups.items()):
        s = sec[g] = {}
        if has_baseline:
            s['wave_vs_baseline_success'] = Comparison(ws, args.wave, args.baseline, 'success').run(B, S)
            for what in ('wrong_value', 'wrong_submitted', 'not_submitted', 'turn_cap'):
                s[f'wave_vs_baseline_{what}'] = Comparison(ws, args.wave, args.baseline, what).run(B, S)
            for m in MODELS:
                s[f'wave_vs_baseline_success:{m}'] = Comparison(ws, args.wave, args.baseline, 'success', models=[m]).run(B, S)
                s[f'wave_vs_baseline_wrong_value:{m}'] = Comparison(ws, args.wave, args.baseline, 'wrong_value', models=[m]).run(B, S)
        for fam in FAMILIES:
            s[f'wave_vs_fs_success:{fam}'] = Comparison(ws, args.wave, args.fs, 'success', task_filter=lambda r, fam=fam: r['family'] == fam).run(B, S)
            if has_baseline:
                s[f'wave_vs_baseline_success:{fam}'] = Comparison(ws, args.wave, args.baseline, 'success', task_filter=lambda r, fam=fam: r['family'] == fam).run(B, S)
        for long_ in (True, False):
            flt = lambda r, l=long_: r['family'] == 'H4' and (('+long' in r['variant']) == l)
            s[f'wave_vs_fs_success:H4{"+long" if long_ else "-not-long"}'] = Comparison(ws, args.wave, args.fs, 'success', task_filter=flt).run(B, S)
            if has_baseline:
                s[f'wave_vs_baseline_success:H4{"+long" if long_ else "-not-long"}'] = Comparison(ws, args.wave, args.baseline, 'success', task_filter=flt).run(B, S)
        for m in MODELS:
            s[f'wave_vs_fs_success:{m}'] = Comparison(ws, args.wave, args.fs, 'success', models=[m]).run(B, S)
    if has_baseline:
        wv = sec['all']['wave_vs_baseline_wrong_value']
        out['d3_wrong_value_effect'] = {'delta_pp': wv['delta_pp'], 'ci95': wv['ci95'], 'passes': bool(wv['tasks']) and wv['delta_pp'] <= -2.0 and wv['ci95'][1] < 0}
        sol = sec['all']['wave_vs_baseline_wrong_value:gpt-6.1-sol']
        out['sol_watch'] = {'wave_wrong_cells': sol['a_count'], 'baseline_wrong_cells': sol['b_count'], 'flag': sol['a_count'] - sol['b_count'] >= 3}
    text = json.dumps(out, indent=1, allow_nan=False)
    if args.json:
        with open(args.json, 'w') as f:
            f.write(text)
    for g, r in out['primary'].items():
        if r['tasks']:
            print(f"primary {g}: wave - fs {r['delta_pp']:+.2f} pp [{r['ci95'][0]:+.2f}, {r['ci95'][1]:+.2f}] over {r['tasks']} tasks ({r['wording']})")
    print('general claim:', out['general_claim'])
    if 'd3_wrong_value_effect' in out:
        d = out['d3_wrong_value_effect']
        if d['ci95']:
            print(f"D3 wrong values wave - baseline {d['delta_pp']:+.2f} pp [{d['ci95'][0]:+.2f}, {d['ci95'][1]:+.2f}] passes={d['passes']}; Sol watch {out['sol_watch']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
