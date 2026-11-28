#!/usr/bin/env python3
"""Summarize cat13 engine-baseline receipts: per-run metrics, then mean/min/max/stddev per engine.

Usage: summarize.py <runs-dir> <out-dir>
Reads <runs-dir>/<engine>-r<N>/receipt.json and <engine>-ctl/receipt.json (one control run; counted as run 0).
Warm-up and refused runs are reported, not scored.
Metrics per probe, from the saved per-query rows (ranked_pages + graded_gold):
  nDCG@5, P@5(graded)      -- exactly the values cat13 stored (ndcg5, p5_graded)
  R@5                      -- share of the probe's grade-3 targets in the top 5 (deduped)
  MRR@5                    -- 1/rank of the first grade-3 target in the top 5, else 0
  latency                  -- per-probe adapter query() wall time (latency_ms), p50/p95 per run (first, cold pass)
  warm latency             -- the same from warm_latency_ms (--warm-passes repeats on the same brain), when present
  cost/query               -- ledger spend of the run / probes scored
"""
import json, math, os, re, statistics, sys

runs_dir, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

def pct(sorted_vals, p):
    # nearest-rank percentile, same convention as cat13 phaseStats (ceil(p*n)-1)
    if not sorted_vals: return None
    i = min(len(sorted_vals) - 1, max(0, math.ceil(p * len(sorted_vals)) - 1))
    return sorted_vals[i]

def ids_of(ranked):
    out, seen = [], set()
    for d in ranked:
        i = d['page_id'] if isinstance(d, dict) else d
        if i in seen: continue
        seen.add(i); out.append(i)
    return out

rows, per_query_rows, notes, diagnostic_rows = [], [], [], []

def diagnostic_dump(engine, rep, path):
    # An invalid run that still wrote a receipt: keep its rankings for inspection, never in the table.
    r = json.load(open(path))
    for q in (r.get('data') or {}).get('per_query', {}).get('gbrain', []):
        top = ids_of(q['ranked_pages'])[:5]
        targets = {k for k, v in q['graded_gold'].items() if v >= 3}
        diagnostic_rows.append({'engine': engine, 'run': rep, 'id': q['id'], 'template': q['template'], 'ndcg5': q['ndcg5'],
                                'r5': (len([i for i in top if i in targets]) / len(targets)) if targets else 0.0,
                                'mrr5': next((1.0 / (k + 1) for k, i in enumerate(top) if i in targets), 0.0),
                                'latency_ms': q.get('latency_ms'), 'warm_latency_ms': q.get('warm_latency_ms'), 'top5': top,
                                'graded_gold': q['graded_gold'], 'search_failures': (q.get('search_observation') or {}).get('failures', [])})
for name in sorted(os.listdir(runs_dir)):
    m = re.match(r'^(pglite|postgres|rust)-(?:r(\d+)|ctl)$', name)
    path = os.path.join(runs_dir, name, 'receipt.json')
    exit_code = open(os.path.join(runs_dir, name, 'exit_code')).read().strip() if os.path.exists(os.path.join(runs_dir, name, 'exit_code')) else None
    if not m:
        notes.append({'run': name, 'exit_code': exit_code, 'scored': False, 'why': 'warm-up run (fills the shared embedding cache); excluded from the table'})
        continue
    engine, rep = m.group(1), int(m.group(2) or 0)
    if not os.path.exists(path) or exit_code != '0':
        log = open(os.path.join(runs_dir, name, 'stdout.log')).read()
        bad = [l.strip() for l in log.splitlines() if any(w in l for w in ('FAILED', 'SKIPPED', 'REFUSED', 'INVALID', 'INCOMPLETE', 'does not support'))]
        notes.append({'run': name, 'exit_code': exit_code, 'scored': False, 'why': ' | '.join(bad[:3]) or 'no receipt'})
        if os.path.exists(path):
            diagnostic_dump(engine, int(m.group(2) or 0), path)
        continue
    r = json.load(open(path))
    pq = r['data']['per_query']['gbrain']
    nd, p5, rc, mrr, lat, wlat = [], [], [], [], [], []
    for q in pq:
        targets = {k for k, v in q['graded_gold'].items() if v >= 3}
        top = ids_of(q['ranked_pages'])[:5]
        r5 = (len([i for i in top if i in targets]) / len(targets)) if targets else 0.0
        rr = next((1.0 / (k + 1) for k, i in enumerate(top) if i in targets), 0.0)
        nd.append(q['ndcg5']); p5.append(q['p5_graded']); rc.append(r5); mrr.append(rr)
        if 'latency_ms' in q: lat.append(q['latency_ms'])
        wlat.extend(q.get('warm_latency_ms') or [])
        per_query_rows.append({'engine': engine, 'run': rep, 'id': q['id'], 'template': q['template'], 'subset': q['subset'],
                               'ndcg5': q['ndcg5'], 'p5_graded': q['p5_graded'], 'r5': r5, 'mrr5': rr,
                               'latency_ms': q.get('latency_ms'), 'warm_latency_ms': q.get('warm_latency_ms'), 'top5': top, 'graded_gold': q['graded_gold'],
                               'search_failures': (q.get('search_observation') or {}).get('failures', [])})
    lat.sort(); wlat.sort()
    usd = (r.get('cost') or {}).get('usd')
    rows.append({'engine': engine, 'run': rep, 'n': len(pq), 'run_status': r['run_status'], 'verdict': r['verdict'],
                 'ndcg5': statistics.fmean(nd), 'p5': statistics.fmean(p5), 'r5': statistics.fmean(rc), 'mrr5': statistics.fmean(mrr),
                 'p50_ms': pct(lat, 0.5), 'p95_ms': pct(lat, 0.95),
                 'warm_p50_ms': pct(wlat, 0.5), 'warm_p95_ms': pct(wlat, 0.95), 'warm': r['data']['scorecard'][0].get('warm'), 'cost_usd': usd,
                 'cost_per_query_usd': (usd / len(pq)) if usd is not None and pq else None,
                 'embed_cache': r['resolved_config'].get('embed_cache'),
                 'started_at': r['started_at'], 'finished_at': r['finished_at']})

metrics = ['ndcg5', 'p5', 'r5', 'mrr5', 'p50_ms', 'p95_ms', 'warm_p50_ms', 'warm_p95_ms', 'cost_per_query_usd']
agg = {}
for e in ('pglite', 'postgres', 'rust'):
    er = [x for x in rows if x['engine'] == e]
    if not er: continue
    agg[e] = {'runs': len(er)}
    for k in metrics:
        v = [x[k] for x in er if x[k] is not None]
        if not v: agg[e][k] = None; continue
        agg[e][k] = {'mean': statistics.fmean(v), 'min': min(v), 'max': max(v), 'stddev': statistics.stdev(v) if len(v) > 1 else 0.0}

json.dump({'runs': rows, 'not_scored': notes, 'by_engine': agg}, open(os.path.join(out_dir, 'summary.json'), 'w'), indent=2)
with open(os.path.join(out_dir, 'per-query.jsonl'), 'w') as f:
    for x in per_query_rows: f.write(json.dumps(x) + '\n')

def fmt(a, k, scale=100, unit='%', d=1):
    s = a.get(k)
    if s is None: return 'n/a'
    return f"{s['mean']*scale:.{d}f}{unit} [{s['min']*scale:.{d}f}–{s['max']*scale:.{d}f}, sd {s['stddev']*scale:.{d}f}]"

lines = ['| Engine | Runs | nDCG@5 | P@5 (graded) | R@5 | MRR@5 | p50 ms | p95 ms | warm p50 ms | warm p95 ms | Cost/query (scored run) |', '|---|---|---|---|---|---|---|---|---|---|---|']
for e in ('pglite', 'postgres', 'rust'):
    if e in agg:
        a = agg[e]
        lines.append(f"| {e} | {a['runs']} | {fmt(a,'ndcg5')} | {fmt(a,'p5')} | {fmt(a,'r5')} | {fmt(a,'mrr5')} | "
                     f"{fmt(a,'p50_ms',1,'',0)} | {fmt(a,'p95_ms',1,'',0)} | {fmt(a,'warm_p50_ms',1,'',0)} | {fmt(a,'warm_p95_ms',1,'',0)} | {fmt(a,'cost_per_query_usd',1,'',6)} |")
    else:
        why = next((n['why'] for n in notes if n['run'].startswith(e + '-')), 'not run')
        lines.append(f"| {e} | 0 scored | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked |")
lines.append('')
lines.append('Cells: mean [min–max, sd] across runs. Not scored:')
for n in notes: lines.append(f"- {n['run']} (exit {n['exit_code']}): {n['why']}")
if diagnostic_rows:
    with open(os.path.join(out_dir, 'per-query-invalid-runs.jsonl'), 'w') as f:
        for x in diagnostic_rows: f.write(json.dumps(x) + '\n')
open(os.path.join(out_dir, 'table.md'), 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
