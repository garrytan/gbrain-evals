#!/usr/bin/env python3
"""Endpoints of the BEAM-500K "no evidence found" oracle-stub test, as its preregistration defines them.

Reads, per reader, the arm B cell, its extra unanswerable samples (-s2, -s3), the oracle-line replays (-s11..-s13),
the false-alarm replay (-s21), the joint blinded re-judge of those cells and the answer-type labels. Prints the before
row, both primary endpoints with question-bootstrap intervals, the preregistered "material" verdict, the approved build
condition, the secondaries and the sensitivity checks. Standard library only.

usage: analyze.py --self-test
       analyze.py --cells DIR --run DIR --reader NAME=BCELL [--reader ...] [--json OUT]
  --run holds rejudge-<BCELL>/ and labels-<BCELL>.ndjson for each reader; --cells holds the cells.
"""
import argparse, glob, json, os, random, sys
from collections import Counter, defaultdict

RESAMPLES = 10_000
BUILD = 8 / 18
UNANS_SAMPLES = {'B': ['', '-s2', '-s3'], 'O': ['-s11', '-s12', '-s13']}
F_SAMPLE = '-s21'
SHARED_14_CONVS = {'10', '18', '20', '24', '25', '29', '33'}
OCTOBER_BRIDGE = (5, 14)


def load_json(p):
    with open(p) as f:
        return json.load(f)


def special(rec):
    err = rec.get('error') or ''
    if err.startswith('reader refusal'):
        return 'refusal'
    if not (rec.get('answer') or '').strip():
        return 'empty'
    if err:
        return 'error: ' + err[:60]
    return None


def answer_cost(rec):
    return sum(r.get('actual_usd') or 0 for r in rec.get('requests') or [] if '/answer/' in (r.get('tag') or ''))


def load_reader(cells, run, bcell):
    rj = os.path.join(run, 'rejudge-' + bcell)
    labels = {}
    with open(os.path.join(run, 'labels-' + bcell + '.ndjson')) as f:
        for line in f:
            r = json.loads(line)
            labels[(r['cell'], r['qid'])] = r.get('label')
    rows = {}
    for suffix in ['', '-s2', '-s3', '-s11', '-s12', '-s13', F_SAMPLE]:
        cell = bcell + suffix
        for p in sorted(glob.glob(os.path.join(cells, cell, 'stages', 'answer', '*.json'))):
            rec = load_json(p)
            qid = rec['query_id']
            jp = os.path.join(rj, cell, 'stages', 'judge', qid + '.json')
            if not os.path.exists(jp):
                sys.exit(f'{cell}/{qid}: no re-judge record')
            j = load_json(jp)
            rows[(suffix, qid)] = {
                'correct': bool(j.get('correct')), 'label': labels.get((cell, qid)), 'special': special(rec),
                'tokens': rec.get('inserted_tokens_cl100k'), 'cost': answer_cost(rec), 'model': rec.get('answer_model'),
            }
    return rows


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def ci(xs):
    return [pct(xs, 0.025), pct(xs, 0.975)]


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else None


def pooled(per_reader_q, draw):
    """per_reader_q: {reader: {qid: value}}; draw: list of qids. Equal reader weight; a reader's mean is over drawn qids it has."""
    ms = []
    for vals in per_reader_q.values():
        xs = [vals[q] for q in draw if q in vals]
        if xs:
            ms.append(sum(xs) / len(xs))
    return sum(ms) / len(ms) if ms else None


def bootstrap(ids, stat):
    ids = sorted(ids, key=str)
    rng = random.Random(1)
    out = []
    for _ in range(RESAMPLES):
        draw = [rng.choice(ids) for _ in ids]
        out.append(stat(draw))
    return out


def unans_tables(R, unans, drop=lambda reader, qid, arm, row: False, value=lambda row: not row['correct']):
    """{arm: {reader: {qid: mean over kept samples}}}; a pair is dropped when either arm has no kept sample."""
    t = {'B': defaultdict(dict), 'O': defaultdict(dict)}
    for reader, rows in R.items():
        for q in unans:
            means = {}
            for arm, sfx in UNANS_SAMPLES.items():
                vs = [value(rows[(s, q)]) for s in sfx if (s, q) in rows and not drop(reader, q, arm, rows[(s, q)])]
                vs = [v for v in vs if v is not None]
                means[arm] = mean(vs)
            if means['B'] is None or means['O'] is None:
                continue
            for arm in t:
                t[arm][reader][q] = float(means[arm])
    return t


def delta_family(R, unans, **kw):
    t = unans_tables(R, unans, **kw)
    readers = list(R)

    def stats(draw):
        b, o = pooled(t['B'], draw), pooled(t['O'], draw)
        d = b - o
        m = max(0.13, b / 2)
        per = {r: (pooled({r: t['B'][r]}, draw) or 0) - (pooled({r: t['O'][r]}, draw) or 0) for r in readers}
        return {'B': b, 'O': o, 'delta': d, 'D': d - m, 'D_half': d - b / 2, 'rel': (d / b) if b > 0 else None, 'per': per}

    point = stats(sorted(unans))
    boots = bootstrap(unans, stats)
    rels = [s['rel'] for s in boots if s['rel'] is not None]
    pairs = {r: len(t['B'][r]) for r in readers}
    return {
        'pairs': pairs, 'B': point['B'], 'O': point['O'], 'delta': point['delta'], 'delta_ci': ci([s['delta'] for s in boots]),
        'M': max(0.13, point['B'] / 2), 'D': point['D'], 'D_ci': ci([s['D'] for s in boots]),
        'D_half': point['D_half'], 'D_half_ci': ci([s['D_half'] for s in boots]),
        'rel': point['rel'], 'rel_ci': ci(rels), 'rel_dropped': RESAMPLES - len(rels),
        'per_reader': {r: {'B': pooled({r: t['B'][r]}, sorted(unans)), 'O': pooled({r: t['O'][r]}, sorted(unans)),
                           'delta': point['per'][r], 'delta_ci': ci([s['per'][r] for s in boots]),
                           'rel': (point['per'][r] / pooled({r: t['B'][r]}, sorted(unans))) if pooled({r: t['B'][r]}, sorted(unans)) else None}
                       for r in readers},
    }


def material_verdict(x):
    if x['B'] < 0.13:
        return 'no headroom'
    if x['D'] >= 0 and x['delta_ci'][0] > 0:
        return 'material'
    if x['D_half_ci'][1] < 0:
        return 'not material'
    return 'not distinguishable'


def build_verdict(x):
    if x['B'] == 0:
        return 'no headroom'
    rel, lo, hi = x['rel'], x['delta_ci'][0], x['delta_ci'][1]
    if rel < 0.25:
        return 'no build'
    if rel >= BUILD and (lo > 0 or hi < 0):
        return 'build'
    return 'borderline'


def l_family(R, ans, drop=lambda reader, qid: False):
    readers = list(R)
    b = {r: {q: float(R[r][('', q)]['correct']) for q in ans if not drop(r, q)} for r in readers}
    f = {r: {q: float(R[r][(F_SAMPLE, q)]['correct']) for q in ans if not drop(r, q)} for r in readers}

    def stats(draw):
        L = (pooled(b, draw) - pooled(f, draw)) * 100
        return {'L': L, 'cost5': 0.05 * L, 'maxmis': 1.0 if L <= 0 else min(1.0, 1 / L),
                'per': {r: (pooled({r: b[r]}, draw) - pooled({r: f[r]}, draw)) * 100 for r in readers}}

    point = stats(sorted(ans))
    boots = bootstrap(ans, stats)
    out = {'L_points': point['L'], 'L_ci': ci([s['L'] for s in boots]),
           'cost_at_5pct_points': point['cost5'], 'cost_at_5pct_ci': ci([s['cost5'] for s in boots]),
           'max_misfire_for_1pt': point['maxmis'], 'max_misfire_ci': ci([s['maxmis'] for s in boots]),
           'per_reader': {r: {'L_points': point['per'][r], 'L_ci': ci([s['per'][r] for s in boots])} for r in readers}}
    flips = {}
    for r in readers:
        c = Counter()
        for q in ans:
            if drop(r, q):
                continue
            rb, rf = R[r][('', q)], R[r][(F_SAMPLE, q)]
            if rb['correct'] and not rf['correct']:
                c['lost: to declined' if rf['label'] == 'declined' else 'lost: to wrong (hedged or committed)' if rf['label'] in ('hedged', 'committed') else 'lost: label unparseable'] += 1
            elif not rb['correct'] and rf['correct']:
                c['gained'] += 1
        flips[r] = dict(c)
    out['flips'] = flips
    return out


def self_test():
    v = lambda **k: dict({'B': 0.3, 'delta': 0.2, 'D': 0.05, 'delta_ci': [0.05, 0.3], 'D_half_ci': [-0.1, 0.2], 'rel': 0.5}, **k)
    assert material_verdict(v(B=0.1299)) == 'no headroom'
    assert material_verdict(v()) == 'material'
    assert material_verdict(v(delta_ci=[0.0, 0.3])) == 'not distinguishable'
    assert material_verdict(v(D=-0.01, D_half_ci=[-0.2, -0.001])) == 'not material'
    assert material_verdict(v(D=-0.01)) == 'not distinguishable'
    assert build_verdict(v(B=0)) == 'no headroom'
    assert build_verdict(v(rel=0.2499)) == 'no build'
    assert build_verdict(v(rel=BUILD)) == 'build'
    assert build_verdict(v(rel=BUILD - 1e-9)) == 'borderline'
    assert build_verdict(v(delta_ci=[0.0, 0.3])) == 'borderline'
    assert build_verdict(v(rel=0.25)) == 'borderline'
    a = bootstrap(['b', 'a', 'c'], lambda d: tuple(d))
    assert a == bootstrap(['c', 'a', 'b'], lambda d: tuple(d)) and len(a) == RESAMPLES
    rng = random.Random(1)
    assert a[0] == tuple(rng.choice(['a', 'b', 'c']) for _ in range(3))
    assert pooled({'x': {'q1': 1.0, 'q2': 0.0}, 'y': {'q1': 0.0}}, ['q1', 'q2', 'q2']) == (1 / 3 + 0.0) / 2
    row = lambda c: {'correct': c, 'label': 'committed', 'special': None}
    R = {'r': {('', 'q1'): row(True), (F_SAMPLE, 'q1'): row(True), ('', 'q2'): row(False), (F_SAMPLE, 'q2'): row(True)}}
    lf = l_family(R, ['q1', 'q2'])
    assert lf['L_points'] == -50.0 and lf['max_misfire_for_1pt'] == 1.0 and lf['cost_at_5pct_points'] == -2.5
    print('self-test ok')


def main():
    if sys.argv[1:] == ['--self-test']:
        return self_test()
    ap = argparse.ArgumentParser()
    ap.add_argument('--cells', required=True)
    ap.add_argument('--run', required=True)
    ap.add_argument('--reader', action='append', required=True)
    ap.add_argument('--repair', help='answer-repair.json whose rows the sensitivity check leaves out, NAME=PATH')
    ap.add_argument('--json')
    a = ap.parse_args()
    R, bcells = {}, {}
    for spec in a.reader:
        name, bcell = spec.split('=', 1)
        bcells[name] = bcell
        R[name] = load_reader(a.cells, a.run, bcell)
    qids = sorted({q for rows in R.values() for (s, q) in rows if s == ''})
    unans = [q for q in qids if '_abstention_' in q]
    ans = [q for q in qids if '_abstention_' not in q]
    missing = []
    for r, rows in R.items():
        for q in unans:
            missing += [f'{r} {s or "B"} {q}' for s in UNANS_SAMPLES['B'] + UNANS_SAMPLES['O'] if (s, q) not in rows]
        for q in ans:
            missing += [f'{r} {s or "B"} {q}' for s in ['', F_SAMPLE] if (s, q) not in rows]
    if len(unans) != 22 or len(ans) != 198 or missing:
        sys.exit(f'schedule incomplete: {len(unans)} unanswerable, {len(ans)} answerable, missing {missing[:10]}')

    res = {'readers': {r: bcells[r] for r in R}, 'resamples': RESAMPLES}
    before = {}
    for r, rows in R.items():
        b220 = [rows[('', q)] for q in qids]
        wrong = [rows[('', q)] for q in ans if not rows[('', q)]['correct']]
        lab_wrong = [w['label'] for w in wrong if w['label']]
        lab_ans = [rows[('', q)]['label'] for q in ans if rows[('', q)]['label']]
        correct = sum(x['correct'] for x in b220)
        cost = sum(x['cost'] for x in b220)
        before[r] = {
            'accuracy_220': correct / 220, 'correct_220': correct,
            'made_up_rate_22': mean(mean(not rows[(s, q)]['correct'] for s in UNANS_SAMPLES['B']) for q in unans),
            'wrong_rate_198': len(wrong) / 198,
            'wrong_committed_share': lab_wrong.count('committed') / len(lab_wrong) if lab_wrong else None,
            'wrong_hedged_share': lab_wrong.count('hedged') / len(lab_wrong) if lab_wrong else None,
            'wrong_labelled': len(lab_wrong), 'wrong_total': len(wrong),
            'answerable_declined_share': lab_ans.count('declined') / len(lab_ans) if lab_ans else None,
            'answerable_labelled': len(lab_ans),
            'delivered_tokens_mean': mean(x['tokens'] for x in b220 if x['tokens'] is not None),
            'answer_cost_usd_220': cost, 'cost_per_correct_usd': cost / correct if correct else None,
        }
    res['before'] = before
    res['before_pooled'] = {k: mean(before[r][k] for r in R) for k in ('accuracy_220', 'made_up_rate_22', 'wrong_rate_198')}

    specials = {}
    for r, rows in R.items():
        c = Counter()
        for (s, q), row in rows.items():
            arm = 'B' if s in ('', '-s2', '-s3') else 'O' if s in UNANS_SAMPLES['O'] else 'F'
            if row['special']:
                c[f'{arm} {"unanswerable" if q in unans else "answerable"}: {row["special"]}'] += 1
        specials[r] = dict(c)
    res['special_rows'] = specials
    unparse = {r: Counter(('B' if s in ('', '-s2', '-s3') else 'O' if s in UNANS_SAMPLES['O'] else 'F') for (s, q), row in rows.items() if not row['label']) for r, rows in R.items()}
    res['type_label_unparseable'] = {r: dict(c) for r, c in unparse.items()}

    x = delta_family(R, unans)
    x['material'] = material_verdict(x)
    x['build'] = build_verdict(x)
    res['delta_O'] = x
    res['L'] = l_family(R, ans)
    res['L_per_ability'] = {}
    for ab in sorted({q.split('_', 1)[1].rsplit('_', 1)[0] for q in ans}):
        qs = [q for q in ans if q.split('_', 1)[1].rsplit('_', 1)[0] == ab]
        res['L_per_ability'][ab] = {k: v for k, v in l_family(R, qs).items() if k in ('L_points', 'L_ci')}

    sec = {}
    sec['delta_O_committed_made_up'] = delta_family(R, unans, value=lambda row: None if not row['label'] else (not row['correct'] and row['label'] == 'committed'))
    sec['delta_O_type_label'] = delta_family(R, unans, value=lambda row: None if not row['label'] else row['label'] != 'declined')
    sec['delta_O_without_special_rows'] = delta_family(R, unans, drop=lambda r, q, arm, row: bool(row['special']))
    shares = {}
    for r, rows in R.items():
        for arm, sfx in UNANS_SAMPLES.items():
            labs = [rows[(s, q)]['label'] for q in unans for s in sfx if rows[(s, q)]['label']]
            shares[f'{r} {arm} unanswerable'] = {k: labs.count(k) / len(labs) for k in ('declined', 'hedged', 'committed')} | {'n': len(labs)}
        for arm, s in (('B', ''), ('F', F_SAMPLE)):
            labs = [rows[(s, q)]['label'] for q in ans if rows[(s, q)]['label']]
            shares[f'{r} {arm} answerable'] = {k: labs.count(k) / len(labs) for k in ('declined', 'hedged', 'committed')} | {'n': len(labs)}
    sec['answer_type_shares'] = shares
    bridge = [q for q in unans if q.split('_', 1)[0] in SHARED_14_CONVS]
    sec['bridge_14'] = {'questions': len(bridge), 'october_stated_an_answer': f'{OCTOBER_BRIDGE[0]} of {OCTOBER_BRIDGE[1]}',
                        'this_run_B_made_up_rate': {r: mean(mean(not R[r][(s, q)]['correct'] for s in UNANS_SAMPLES['B']) for q in bridge) for r in R}}
    if a.repair:
        name, path = a.repair.split('=', 1)
        rep = {row['query_id'] for row in load_json(path)['rows']}
        sens = delta_family(R, unans, drop=lambda r, q, arm, row: r == name and q in rep)
        sens['material'], sens['build'] = material_verdict(sens), build_verdict(sens)
        sec['sensitivity_without_repaired_rows'] = {'reader': name, 'rows': len(rep), 'unanswerable': len(rep & set(unans)),
                                                     'delta_O': sens, 'L': l_family(R, ans, drop=lambda r, q: r == name and q in rep)}
    res['secondary'] = sec
    out = json.dumps(res, indent=2, default=float)
    if a.json:
        with open(a.json, 'w') as f:
            f.write(out + '\n')
    print(out)


if __name__ == '__main__':
    main()
