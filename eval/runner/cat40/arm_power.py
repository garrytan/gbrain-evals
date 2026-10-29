#!/usr/bin/env python3
"""Size a Cat 40 arm before preregistering it: simulate running one arm on a fraction of the tasks.

Usage:
  python3 eval/runner/cat40/arm_power.py --world P1=<results.jsonl>[,<more>] [--world P2=...] --arm fs \
      [--fractions 0.33,0.5,0.67] [--draws 20] [--resamples 2000] [--seed 1] \
      [--wave gbrain-next-wave] [--baseline gbrain-next-baseline] [--fs fs] [--json out.json]

Input is cells that already ran with every arm on every task (a development round or an earlier confirmation).
For each fraction f, each draw keeps a seeded random f of every world's tasks for --arm and drops that arm's other
cells; the other arms keep all their cells. The preregistered endpoints of next_confirm_analysis.py are then
recomputed on what is left with the same Comparison code: the primary wave - fs wording per generator, and D3 when a
baseline is present. A comparison pairs cells by task, so dropping one arm's cells drops those tasks from every
comparison that uses that arm and leaves the others untouched.

Output, per fraction: how many draws kept each full-data verdict, the weakest primary lower bound, and the share of
the arm's recorded spend (total_usd plus judge_usd per cell) that the fraction would not have spent. A preregistration that sizes an
arm this way names this command, its inputs and its output before any cell runs.
"""
import argparse, json, os, random, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from next_confirm_analysis import Comparison, wording  # noqa: E402


def load(paths):
    cells, usd = {}, defaultdict(float)
    for p in paths:
        with open(p) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                if r.get('stop') == 'harness_error':
                    continue
                cells[(r['arm'], r['model'], r['task'])] = r
    for (arm, _, _), r in cells.items():
        usd[arm] += float(r.get('total_usd') or 0) + float(r.get('judge_usd') or 0)
    return cells, usd


def generators(worlds):
    gens = defaultdict(dict)
    for name, cells in worlds.items():
        gens['public' if name.upper().startswith('P') else 'sealed'][name] = cells
    return gens


def verdicts(worlds, a, resamples, seed):
    out = {}
    for g, ws in sorted(generators(worlds).items()):
        res = Comparison(ws, a.wave, a.fs, 'success').run(resamples, seed)
        out[f'primary:{g}'] = {'wording': wording(res), 'delta_pp': res['delta_pp'], 'ci95': res['ci95']}
    if any(k[0] == a.baseline for c in worlds.values() for k in c):
        wv = Comparison(worlds, a.wave, a.baseline, 'wrong_value').run(resamples, seed)
        passes = bool(wv['tasks']) and wv['delta_pp'] <= -2.0 and wv['ci95'][1] < 0
        out['d3'] = {'wording': 'passes' if passes else 'fails', 'delta_pp': wv['delta_pp'], 'ci95': wv['ci95']}
    return out


def subsample(worlds, arm, fraction, rng):
    kept = {}
    for name in sorted(worlds):
        cells = worlds[name]
        tasks = sorted({t for (x, _, t) in cells if x == arm}, key=str)
        keep = set(rng.sample(tasks, max(1, round(len(tasks) * fraction)))) if tasks else set()
        kept[name] = {k: v for k, v in cells.items() if k[0] != arm or k[2] in keep}
    return kept


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--world', action='append', required=True, help='NAME=file[,file...]; P* public, S* sealed')
    ap.add_argument('--arm', required=True, help='the arm to run on fewer tasks')
    ap.add_argument('--fractions', default='0.33,0.5,0.67')
    ap.add_argument('--draws', type=int, default=20)
    ap.add_argument('--resamples', type=int, default=2000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--wave', default='gbrain-next-wave')
    ap.add_argument('--baseline', default='gbrain-next-baseline')
    ap.add_argument('--fs', default='fs')
    ap.add_argument('--json')
    a = ap.parse_args(argv)
    worlds, usd = {}, defaultdict(float)
    for spec in a.world:
        name, files = spec.split('=', 1)
        worlds[name], spent = load(files.split(','))
        for arm, v in spent.items():
            usd[arm] += v
    if not any(k[0] == a.arm for c in worlds.values() for k in c):
        print(f'arm {a.arm} has no cells in the input', file=sys.stderr)
        return 2
    full = verdicts(worlds, a, a.resamples, a.seed)
    out = {'arm': a.arm, 'draws': a.draws, 'resamples': a.resamples, 'seed': a.seed, 'arm_usd': round(usd[a.arm], 2), 'full': full, 'fractions': {}}
    for frac in [float(x) for x in a.fractions.split(',')]:
        rng = random.Random(a.seed)
        agree = defaultdict(int)
        weakest = {}
        for d in range(a.draws):
            got = verdicts(subsample(worlds, a.arm, frac, rng), a, a.resamples, a.seed + d)
            for k, v in got.items():
                agree[k] += v['wording'] == full[k]['wording']
                if k.startswith('primary') and v['ci95'] and (k not in weakest or v['ci95'][0] < weakest[k]):
                    weakest[k] = v['ci95'][0]
        out['fractions'][str(frac)] = {
            'agree': {k: f'{agree[k]}/{a.draws}' for k in full},
            'all_agree': all(agree[k] == a.draws for k in full),
            'weakest_primary_lower_pp': weakest,
            'usd_not_spent': round(usd[a.arm] * (1 - frac), 2),
        }
    text = json.dumps(out, indent=1, allow_nan=False)
    if a.json:
        with open(a.json, 'w') as f:
            f.write(text + '\n')
    summary = ', '.join(f"{k} {v['wording']}" for k, v in full.items())
    print(f"full data: {summary}; {a.arm} spent ${out['arm_usd']}")
    for frac, r in out['fractions'].items():
        print(f"{a.arm} on {frac} of tasks: {', '.join(f'{k} {v}' for k, v in r['agree'].items())}; saves ${r['usd_not_spent']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
