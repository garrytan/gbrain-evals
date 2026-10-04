#!/usr/bin/env python3
"""Item 2 analysis: gpt-5.4 reader against arm b (gpt-4o) and arm a (house reader) on identical sessions.

Usage: analyze-2.py <judged.ndjson[.gz]> <out-summary.json>
"""
import gzip, json, math, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OPAQ = os.path.join(ROOT, '2026-09-29-longmemeval-opaque-qa')


def nd(p):
    op = gzip.open if p.endswith('.gz') else open
    with op(p, 'rt') as f:
        return [json.loads(l) for l in f if l.strip()]


def mcnemar(g, l):
    n = g + l
    return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(g, l) + 1)) / 2 ** n)


# USD per token: gpt-5.4 standard (pilot) and Batch API rates; gpt-4o list rates (2026-10-04).
PRICE = {'chat.completions': (2.5e-6, 15e-6, 0.25e-6), 'batch': (1.25e-6, 7.5e-6, 0.125e-6)}


def main():
    src, out = sys.argv[1:3]
    f = {r['question_id']: r for r in nd(src)}
    import csv
    pq = {r['question_id']: r for r in csv.DictReader(open(os.path.join(OPAQ, 'per_question.csv')))}
    b = {r['question_id']: r for r in nd(os.path.join(OPAQ, 'b', 'rows.ndjson.gz'))}
    a_g = {r['question_id']: bool(r.get('judge_correct')) for r in nd(os.path.join(OPAQ, 'a', 'rows.ndjson')) if r.get('question_id') and 'judge_correct' in r}
    a_o = {r['question_id']: bool(r.get('off_judge_correct')) for r in nd(os.path.join(OPAQ, 'a', 'official-judge.ndjson'))}
    qs = sorted(b)
    S = {'denominator': len(qs), 'rows_present': len(f), 'missing': [q for q in qs if q not in f],
         'reader_errors': [q for q in qs if q in f and 'hypothesis' not in f[q]]}
    fg = {q: bool(f.get(q, {}).get('judge_correct') is True) for q in qs}
    fo = {q: bool(f.get(q, {}).get('off_judge_correct') is True) for q in qs}
    bg = {q: bool(b[q].get('judge_correct')) for q in qs}; bo = {q: bool(b[q].get('off_judge_correct')) for q in qs}
    S['correct'] = {'frontier_gbrain_judge': sum(fg.values()), 'frontier_official_judge': sum(fo.values()),
                    'gpt4o_b_gbrain_judge': sum(bg.values()), 'gpt4o_b_official_judge': sum(bo.values()),
                    'house_a_gbrain_judge': sum(a_g[q] for q in qs), 'house_a_official_judge': sum(a_o.get(q, False) for q in qs)}
    S['judge_agreement'] = sum(fg[q] == fo[q] for q in qs)
    S['judge_errors'] = {'gbrain': [q for q in qs if q in f and f[q].get('judge_correct') is None], 'official': [q for q in qs if q in f and f[q].get('off_judge_correct') is None]}
    def pair(x, y):
        g = sum(1 for q in qs if x[q] and not y[q]); l = sum(1 for q in qs if y[q] and not x[q]); return {'frontier_better': g, 'frontier_worse': l, 'exact_mcnemar_p': mcnemar(g, l)}
    S['paired'] = {'vs_b_gbrain': pair(fg, bg), 'vs_b_official': pair(fo, bo), 'vs_a_gbrain': pair(fg, {q: a_g[q] for q in qs}), 'vs_a_official': pair(fo, {q: a_o.get(q, False) for q in qs})}
    complete = [q for q in qs if '_abs' not in q and pq[q]['recall_all_hit_at5'] in ('1', 'True', 'true')]
    S['retrieval_complete'] = {'n': len(complete), 'frontier_gbrain_judge': sum(fg[q] for q in complete), 'gpt4o_b_gbrain_judge': sum(bg[q] for q in complete), 'house_a_gbrain_judge': sum(a_g[q] for q in complete)}
    types = {}
    for q in qs:
        t = 'abstention' if '_abs' in q else b[q]['question_type']
        e = types.setdefault(t, {'n': 0, 'frontier': 0, 'gpt4o_b': 0, 'house_a': 0}); e['n'] += 1; e['frontier'] += fg[q]; e['gpt4o_b'] += bg[q]; e['house_a'] += a_g[q]
    S['by_type_gbrain_judge'] = types
    rows = [f[q] for q in qs if q in f and 'hypothesis' in f[q]]
    usage = lambda r, k: (r.get('reader_usage') or {}).get(k) or 0
    reasoning = lambda r: ((r.get('reader_usage') or {}).get('completion_tokens_details') or {}).get('reasoning_tokens') or 0
    cached = lambda r: ((r.get('reader_usage') or {}).get('prompt_tokens_details') or {}).get('cached_tokens') or 0
    cost = 0.0
    for r in rows:
        pin, pout, pc = PRICE[r['via']]
        cost += (usage(r, 'prompt_tokens') - cached(r)) * pin + cached(r) * pc + usage(r, 'completion_tokens') * pout
    jc = sum(((r.get('judge_usage') or {}).get('input_tokens', 0) * 2.5e-6 + (r.get('judge_usage') or {}).get('output_tokens', 0) * 10e-6) * (r.get('judge_attempts') or 1) for r in rows)
    oc = sum(((r.get('off_judge_usage') or {}).get('prompt_tokens', 0) * 2.5e-6 + (r.get('off_judge_usage') or {}).get('completion_tokens', 0) * 10e-6) for r in rows)
    S['tokens'] = {'mean_prompt': sum(usage(r, 'prompt_tokens') for r in rows) / len(rows), 'mean_completion': sum(usage(r, 'completion_tokens') for r in rows) / len(rows),
                   'mean_reasoning': sum(reasoning(r) for r in rows) / len(rows), 'max_completion': max(usage(r, 'completion_tokens') for r in rows),
                   'finish_reasons': {k: sum(1 for r in rows if r.get('reader_finish_reason') == k) for k in {r.get('reader_finish_reason') for r in rows}},
                   'response_models': sorted({str(r.get('reader_response_model')) for r in rows}), 'via': {k: sum(1 for r in rows if r['via'] == k) for k in PRICE}}
    S['cost_usd'] = {'reader': cost, 'gbrain_judge': jc, 'official_judge': oc, 'total': cost + jc + oc}
    json.dump(S, open(out, 'w'), indent=1)
    print(json.dumps(S, indent=1)[:5000])


if __name__ == '__main__':
    main()
