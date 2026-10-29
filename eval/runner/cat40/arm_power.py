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

Output, per fraction: how many draws kept each full-data verdict that uses the arm, the weakest primary lower bound,
and the arm's recorded spend (total_usd plus judge_usd per cell) on the tasks the fraction leaves out. This measures how
stable each verdict is on fewer of the same tasks; it is not power against a smaller true effect. A preregistration
that sizes an arm this way names this command, its inputs and its output before any cell runs.
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


def arm_tasks(cells, arm):
    return sorted({t for (x, _, t) in cells if x == arm}, key=str)


def kept_count(n, fraction):
    return max(1, round(n * fraction)) if n else 0


def subsample(worlds, arm, fraction, rng):
    kept = {}
    for name in sorted(worlds):
        cells = worlds[name]
        tasks = arm_tasks(cells, arm)
        keep = set(rng.sample(tasks, kept_count(len(tasks), fraction)))
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
    if a.arm not in (a.wave, a.fs, a.baseline):
        print(f'arm {a.arm} is in no preregistered comparison (--wave {a.wave}, --fs {a.fs}, --baseline {a.baseline})', file=sys.stderr)
        return 2
    fractions = [float(x) for x in a.fractions.split(',')]
    if any(not 0 < f <= 1 for f in fractions):
        print(f'every fraction must be above 0 and at most 1: {a.fractions}', file=sys.stderr)
        return 2
    worlds, usd = {}, defaultdict(dict)
    for spec in a.world:
        name, files = spec.split('=', 1)
        if name[:1].upper() not in ('P', 'S'):
            print(f'world {name} must start with P (public) or S (sealed)', file=sys.stderr)
            return 2
        worlds[name], spent = load(files.split(','))
        for arm, v in spent.items():
            usd[arm][name] = v
    if not any(k[0] == a.arm for c in worlds.values() for k in c):
        print(f'arm {a.arm} has no cells in the input', file=sys.stderr)
        return 2
    full = verdicts(worlds, a, a.resamples, a.seed)
    empty = [k for k, v in full.items() if v['wording'] == 'no cells']
    if empty:
        print(f'no paired cells for {", ".join(empty)} in the full data, so there is no verdict to keep', file=sys.stderr)
        return 2
    uses = [k for k in full if a.arm in ((a.wave, a.baseline) if k == 'd3' else (a.wave, a.fs))]
    arm_usd = sum(usd[a.arm].values())
    out = {'arm': a.arm, 'draws': a.draws, 'resamples': a.resamples, 'seed': a.seed, 'arm_usd': round(arm_usd, 2), 'full': full, 'fractions': {}}
    for frac in fractions:
        rng = random.Random(a.seed)
        agree = defaultdict(int)
        weakest = {}
        for d in range(a.draws):
            got = verdicts(subsample(worlds, a.arm, frac, rng), a, a.resamples, a.seed + d)
            for k in uses:
                agree[k] += got[k]['wording'] == full[k]['wording']
                if k.startswith('primary') and got[k]['ci95'] and (k not in weakest or got[k]['ci95'][0] < weakest[k]):
                    weakest[k] = got[k]['ci95'][0]
        not_spent = 0.0
        for name, cells in worlds.items():
            n = len(arm_tasks(cells, a.arm))
            if n:
                not_spent += usd[a.arm].get(name, 0.0) * (1 - kept_count(n, frac) / n)
        out['fractions'][str(frac)] = {
            'agree': {k: f'{agree[k]}/{a.draws}' for k in uses},
            'all_agree': all(agree[k] == a.draws for k in uses),
            'weakest_primary_lower_pp': weakest,
            'usd_not_spent': round(not_spent, 2),
        }
    text = json.dumps(out, indent=1, allow_nan=False)
    if a.json:
        with open(a.json, 'w') as f:
            f.write(text + '\n')
    summary = ', '.join(f"{k} {v['wording']}" for k, v in full.items())
    print(f"full data: {summary}{'' if 'd3' in full else ', d3 not evaluated (no baseline cells)'}; {a.arm} spent ${out['arm_usd']}")
    for frac, r in out['fractions'].items():
        print(f"{a.arm} on {frac} of tasks: {', '.join(f'{k} {v}' for k, v in r['agree'].items())}; saves ${r['usd_not_spent']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
