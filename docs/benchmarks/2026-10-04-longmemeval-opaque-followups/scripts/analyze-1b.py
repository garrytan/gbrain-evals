#!/usr/bin/env python3
"""Item 1b analysis: notes against direct on the 361-question reading-notes cohort with opaque ids.

Usage: analyze-1b.py <labels.ndjson[.gz]> <journal-dir> <out-summary.json>
Paired 95% bootstrap: 10,000 resamples of questions, mulberry32 seed 20261004 (Python port), percentile interval.
"""
import gzip, json, math, os, sys, glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ORIG = os.path.join(ROOT, '2026-09-25-reading-notes', 'reading-notes-transfer.ndjson')


def nd(p):
    op = gzip.open if p.endswith('.gz') else open
    with op(p, 'rt') as f:
        return [json.loads(l) for l in f if l.strip()]


def mcnemar(g, l):
    n = g + l
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(g, l) + 1)) / 2 ** n)


def mulberry32(a):
    state = [a & 0xFFFFFFFF]
    def rnd():
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rnd


def boot(d, n_res=10000, seed=20261004):
    rnd = mulberry32(seed); n = len(d); means = []
    for _ in range(n_res):
        means.append(sum(d[int(rnd() * n)] for _ in range(n)) / n)
    means.sort()
    return [means[int(0.025 * n_res)], means[int(0.975 * n_res) - 1]]


def main():
    labels, jdir, out = sys.argv[1:4]
    orig = {r['question_id']: r for r in nd(ORIG) if r.get('record_type') == 'pair'}
    lab = {}
    for r in nd(labels):
        lab[(r['question_id'], r['mode'])] = r
    qs = list(orig)
    def ok(q, m):
        r = lab.get((q, m)); return bool(r and r.get('judge_correct') is True)
    def cut(q, m):
        r = lab.get((q, m)); return bool(r and r.get('finish_reason') == 'length')
    missing = [f'{q}:{m}' for q in qs for m in ('direct', 'notes') if (q, m) not in lab]
    judge_err = [f'{q}:{m}' for q in qs for m in ('direct', 'notes') if (q, m) in lab and lab[(q, m)].get('judge_correct') is None]
    S = {'denominator': len(qs), 'missing_responses': missing, 'judge_errors_counted_incorrect': judge_err, 'arms': {}, 'paired': {}, 'vs_september_24': {}}
    subsets = {'all': qs, 'answerable': [q for q in qs if not orig[q]['abstention']], 'abstention': [q for q in qs if orig[q]['abstention']],
               'retrieval_complete': [q for q in qs if orig[q]['retrieval_complete']], 'retrieval_incomplete': [q for q in qs if not orig[q]['retrieval_complete']]}
    for m in ('direct', 'notes'):
        rows = [lab[(q, m)] for q in qs if (q, m) in lab]
        S['arms'][m] = {k: f"{sum(ok(q, m) for q in v)}/{len(v)}" for k, v in subsets.items()}
        S['arms'][m]['correct'] = sum(ok(q, m) for q in qs)
        S['arms'][m]['cutoffs'] = sorted(q for q in qs if cut(q, m))
        S['arms'][m]['correct_if_cutoffs_incorrect'] = sum(ok(q, m) and not cut(q, m) for q in qs)
        S['arms'][m]['mean_output_tokens'] = sum(r['usage']['output_tokens'] for r in rows) / len(rows)
        S['arms'][m]['mean_input_tokens'] = sum(r['usage']['input_tokens'] for r in rows) / len(rows)
        S['arms'][m]['reader_cost_usd'] = sum(r['cost_usd'] or 0 for r in rows)
        S['arms'][m]['judge_cost_usd'] = sum(((r.get('judge_usage') or {}).get('input_tokens', 0) * 2.5e-6 + (r.get('judge_usage') or {}).get('output_tokens', 0) * 10e-6) * (r.get('judge_attempts') or 1) for r in rows)
        S['arms'][m]['by_category'] = {}
        for c in sorted({o['category'] for o in orig.values()}):
            ids = [q for q in qs if orig[q]['category'] == c]
            S['arms'][m]['by_category'][c] = f"{sum(ok(q, m) for q in ids)}/{len(ids)}"
        o_key = 'baseline_correct' if m == 'direct' else 'notes_correct'
        g = sum(1 for q in qs if ok(q, m) and not orig[q][o_key]); l = sum(1 for q in qs if orig[q][o_key] and not ok(q, m))
        S['vs_september_24'][m] = {'september_24_correct': sum(orig[q][o_key] for q in qs), 'opaque_correct': sum(ok(q, m) for q in qs), 'gains': g, 'losses': l, 'exact_mcnemar_p': mcnemar(g, l)}
    for name, ids in subsets.items():
        d = [int(ok(q, 'notes')) - int(ok(q, 'direct')) for q in ids]
        w = d.count(1); l = d.count(-1)
        entry = {'n': len(ids), 'notes_wins': w, 'notes_losses': l, 'both_right': sum(ok(q, 'notes') and ok(q, 'direct') for q in ids),
                 'both_wrong': sum(not ok(q, 'notes') and not ok(q, 'direct') for q in ids), 'exact_mcnemar_p': mcnemar(w, l), 'diff': sum(d) / len(ids)}
        if name in ('all',):
            entry['bootstrap95'] = boot(d)
        S['paired'][name] = entry
    dc = [int(ok(q, 'notes') and not cut(q, 'notes')) - int(ok(q, 'direct') and not cut(q, 'direct')) for q in qs]
    S['paired']['all_cutoffs_incorrect'] = {'notes_wins': dc.count(1), 'notes_losses': dc.count(-1), 'diff': sum(dc) / len(qs), 'bootstrap95': boot(dc)}
    lo = S['paired']['all']['bootstrap95'][0]
    abs_d, abs_n = sum(ok(q, 'direct') for q in subsets['abstention']), sum(ok(q, 'notes') for q in subsets['abstention'])
    S['gate'] = {'interval_above_zero': lo > 0, 'abstention_not_lower': abs_n >= abs_d, 'passes': lo > 0 and abs_n >= abs_d}
    spend = 0.0; calls = 0
    for j in sorted(glob.glob(os.path.join(jdir, '*journal*.ndjson*'))):
        for e in nd(j):
            if e.get('event') == 'settle':
                spend += e.get('cost_usd') or 0; calls += 1
    S['reader_spend_usd_from_journals'] = spend; S['reader_settled_calls'] = calls
    json.dump(S, open(out, 'w'), indent=1)
    print(json.dumps({k: S[k] for k in ('arms', 'paired', 'gate', 'vs_september_24')}, indent=1)[:6000])


if __name__ == '__main__':
    main()
