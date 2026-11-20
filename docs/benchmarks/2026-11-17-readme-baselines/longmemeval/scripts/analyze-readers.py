#!/usr/bin/env python3
"""RB-LME reader arms against gbrain's committed per-question verdicts, official judge (gpt-4o-2024-08-06).

usage: analyze-readers.py <arms dir> > summary-readers.json

<arms dir>/<arm>/rows.ndjson come from `bun eval/runner/batch/w10.ts export <arm> <dir>`. Pairs (exact two-sided McNemar,
Wald 95% interval for the paired difference, gbrain minus baseline, in points):
  Sonnet 5.5 arms  with W10a's w10a-sonnet55-notes (gbrain c5fb0201, 468/500);
  Opus 5.5 arm     with W10b's w10b-opus55-notes (gbrain a7cb37b retrieval saved 2026-09-29, 474/500).
A reader or judge error, or a missing row, counts as wrong, as in W10. Reader dollars are the batch lane's settled
per-row `usd` (provider usage at batch prices).
"""
import json, math, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))
GB = {
    'w10a-sonnet55-notes': 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin/arms/w10a-sonnet55-notes/rows.ndjson',
    'w10b-opus55-notes': 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-opus55-notes/rows.ndjson',
}
PAIRS = [('rb-sonnet55-full', 'w10a-sonnet55-notes'), ('rb-sonnet55-hybrid5', 'w10a-sonnet55-notes'), ('rb-sonnet55-none', 'w10a-sonnet55-notes'), ('rb-opus55-hybrid5', 'w10b-opus55-notes')]

def nd(path):
    with open(path) as f:
        return {r['question_id']: r for r in (json.loads(l) for l in f if l.strip())}

def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)

def diff_ci(b, c, n, z=1.959964):
    d = (b - c) / n
    h = z * math.sqrt(max((b + c - (b - c) ** 2 / n) / (n * n), 0))
    return [round(100 * (d - h), 2), round(100 * (d + h), 2)]

def mdd(b, c, n, z_a=1.959964, z_b=0.841621):
    """Smallest paired difference (points) a two-sided 0.05 test detects with 80% power at the observed discordance."""
    p = (b + c) / n
    return round(100 * (z_a + z_b) * math.sqrt(p / n), 2)

out = {}
gbrain = {k: nd(os.path.join(ROOT, v)) for k, v in GB.items()}
for arm, ref in PAIRS:
    path = os.path.join(sys.argv[1], arm, 'rows.ndjson')
    if not os.path.exists(path):
        out[arm] = {'status': 'not run'}
        continue
    rows, g = nd(path), gbrain[ref]
    ids = sorted(g)
    ok = lambda r: bool(r and r.get('correct_official') == 1)
    base = {q: ok(rows.get(q)) for q in ids}
    gbr = {q: ok(g[q]) for q in ids}
    b = sum(1 for q in ids if gbr[q] and not base[q])
    c = sum(1 for q in ids if base[q] and not gbr[q])
    by_type = {}
    for q in ids:
        t = by_type.setdefault(g[q]['question_type'] if not q.endswith('_abs') else 'abstention', {'n': 0, 'gbrain': 0, 'baseline': 0})
        t['n'] += 1; t['gbrain'] += gbr[q]; t['baseline'] += base[q]
    usd = [rows[q]['usd'] for q in ids if q in rows and rows[q].get('usd') is not None]
    gusd = [g[q]['usd'] for q in ids if g[q].get('usd') is not None]
    p = mcnemar(b, c)
    out[arm] = {
        'gbrain_arm': ref, 'denominator': len(ids), 'rows': len(rows), 'baseline_correct': sum(base.values()), 'gbrain_correct': sum(gbr.values()),
        'gbrain_only': b, 'baseline_only': c, 'exact_mcnemar_p': p, 'diff_points_ci95': diff_ci(b, c, len(ids)), 'mdd_points_80pct': mdd(b, c, len(ids)),
        'verdict': ('win' if b > c else 'loss') if p < 0.05 else 'no measurable difference',
        'reader_errors': sum(1 for q in ids if q in rows and rows[q].get('error')), 'missing_rows': sum(1 for q in ids if q not in rows),
        'max_tokens_finishes': sum(1 for q in ids if q in rows and rows[q].get('finish') in ('length', 'max_tokens')),
        'mean_input_tokens': round(sum(rows[q]['usage']['input_tokens'] for q in ids if q in rows and rows[q].get('usage')) / max(1, len(usd)), 1),
        'reader_usd_per_question': round(sum(usd) / len(ids), 5), 'gbrain_reader_usd_per_question': round(sum(gusd) / len(ids), 5),
        'reader_usd_per_correct': round(sum(usd) / max(1, sum(base.values())), 5), 'gbrain_reader_usd_per_correct': round(sum(gusd) / max(1, sum(gbr.values())), 5),
        'by_type': by_type,
    }
print(json.dumps(out, indent=1))
