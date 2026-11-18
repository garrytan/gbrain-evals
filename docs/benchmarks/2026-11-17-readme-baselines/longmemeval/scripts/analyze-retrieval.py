#!/usr/bin/env python3
"""Plain hybrid retrieval against gbrain's committed LongMemEval retrieval records.

usage: analyze-retrieval.py <plain hybrid rows.ndjson(.gz)> <longmemeval_s_cleaned.json> > summary-retrieval.json

A question's last row is its result (a rerun appends). Row 1: strict recall_all@5 over the 470 answerable questions,
paired with gbrain's release configuration at 109b992 (docs/benchmarks/2026-10-04-longmemeval-opaque-followups/
1a-harness/FINAL/rows.ndjson.gz), exact two-sided McNemar. Row 2: strict recall@10 over all 500 questions with the
dataset's answer_session_ids (the verbatim probe's denominator), and the verbatim probe's target at rank 1, in the
top 10 and in the top 50 (gbrain's "target found": among 50 cited sessions). The verbatim verdict file holds counts
only, so row 2 is unpaired.
"""
import gzip, json, math, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))

def nd(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt') as f:
        return [json.loads(l) for l in f if l.strip()]

def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)

def wilson(x, n, z=1.959964):
    p = x / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]

def paired_diff_ci(b, c, n, z=1.959964):
    """Wald interval for the paired difference in proportions (gbrain minus baseline), in points."""
    d = (b - c) / n
    var = (b + c - (b - c) ** 2 / n) / (n * n)
    h = z * math.sqrt(max(var, 0))
    return [round(100 * (d - h), 2), round(100 * (d + h), 2)]

rows = {}
for r in nd(sys.argv[1]):
    rows[r['question_id']] = r
data = {q['question_id']: q for q in json.load(open(sys.argv[2]))}
assert len(rows) == 500 and set(rows) == set(data), 'need one result per question'
errors = [q for q, r in rows.items() if r.get('error')]
gb = {r['question_id']: r for r in nd(os.path.join(ROOT, 'docs/benchmarks/2026-10-04-longmemeval-opaque-followups/1a-harness/FINAL/rows.ndjson.gz')) if r.get('question_id')}

answerable = sorted(q for q in data if not q.endswith('_abs'))
def strict(r, k, gold):
    top = [x['id'] for x in r['question_top'][:k]]
    return all(g in top for g in gold)

base5 = {q: strict(rows[q], 5, data[q]['answer_session_ids']) for q in answerable}
gb5 = {q: bool(gb[q]['recall_all_hit']) for q in answerable}
b = sum(1 for q in answerable if gb5[q] and not base5[q])
c = sum(1 for q in answerable if base5[q] and not gb5[q])
by_type = {}
for q in answerable:
    t = by_type.setdefault(data[q]['question_type'], {'n': 0, 'gbrain': 0, 'baseline': 0})
    t['n'] += 1; t['gbrain'] += gb5[q]; t['baseline'] += base5[q]
row1 = {
    'denominator': len(answerable), 'gbrain_strict5': sum(gb5.values()), 'baseline_strict5': sum(base5.values()),
    'baseline_any5': sum(1 for q in answerable if any(g in [x['id'] for x in rows[q]['question_top'][:5]] for g in data[q]['answer_session_ids'])),
    'gbrain_only': b, 'baseline_only': c, 'exact_mcnemar_p': mcnemar(b, c), 'diff_points_ci95': paired_diff_ci(b, c, len(answerable)),
    'baseline_ci95': wilson(sum(base5.values()), len(answerable)), 'by_type': by_type,
    'baseline_strict10_answerable': sum(strict(rows[q], 10, data[q]['answer_session_ids']) for q in answerable),
}
allq = sorted(data)
s10 = sum(strict(rows[q], 10, data[q]['answer_session_ids']) for q in allq)
s5 = sum(strict(rows[q], 5, data[q]['answer_session_ids']) for q in allq)
a10 = sum(any(g in [x['id'] for x in rows[q]['question_top'][:10]] for g in data[q]['answer_session_ids']) for q in allq)
probes = [rows[q]['probe'] for q in allq]
rank = [p['rank'] if p else None for p in probes]
row2 = {
    'denominator': 500, 'gbrain': {'strict10': 496, 'strict5': 474, 'any10': 500, 'probe_found_top50': 500, 'source': 'docs/benchmarks/2026-10-09-verbatim-probe-verdict.json arm B (counts only)'},
    'baseline_strict10': s10, 'baseline_strict10_ci95': wilson(s10, 500), 'baseline_strict5': s5, 'baseline_any10': a10,
    'probe_rank1': sum(1 for x in rank if x == 1), 'probe_top10': sum(1 for x in rank if x and x <= 10), 'probe_top50': sum(1 for x in rank if x),
    'probe_errors': [q for q in allq if rows[q]['probe'] and rows[q]['probe'].get('error')], 'probe_missing': [q for q in allq if not rows[q]['probe']],
    'probe_rank1_ci95': wilson(sum(1 for x in rank if x == 1), 500),
    'probe_not_rank1': [{'question_id': q, 'rank': rows[q]['probe']['rank'] if rows[q]['probe'] else None} for q in allq if not (rows[q]['probe'] and rows[q]['probe']['rank'] == 1)],
}
print(json.dumps({'rows': len(rows), 'error_rows': errors, 'row1_recall_all_at5': row1, 'row2_verbatim': row2}, indent=1))
