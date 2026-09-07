#!/usr/bin/env python3
"""Convert in-repo `gbrain eval longmemeval` ndjson receipts into the gbrain-evals RunnerOutput shape
(eval/runner/longmemeval.ts RunSummary) so eval/runner/longmemeval-chart.ts can render them.
usage: harness-to-runner-output.py OUT.json LABEL=path.ndjson [LABEL=path.ndjson ...]"""
import json, sys, os, re
from datetime import datetime
out = sys.argv[1]; specs = sys.argv[2:]
R = os.path.dirname(os.path.abspath(__file__))
def passes_seconds(name):
    """wall seconds from arms.log pass start/exit stamps for this arm (bounded resume loop)."""
    tot = 0.0; start = None
    for l in open(os.path.join(R, 'arms.log')):
        m = re.match(rf"\[{re.escape(name)}\] pass \d+ (\S+) rows=", l)
        if m: start = datetime.fromisoformat(m.group(1).replace('Z', '+00:00')); continue
        m = re.match(rf"\[{re.escape(name)}\] pass \d+ exit \d+ (\S+)", l)
        if m and start: tot += (datetime.fromisoformat(m.group(1).replace('Z', '+00:00')) - start).total_seconds(); start = None
    return tot
summaries = []
for spec in specs:
    label, path = spec.split('=', 1)
    rows = []; summ = None
    for l in open(path):
        l = l.strip()
        if not l: continue
        r = json.loads(l)
        if 'recall_by_type' in r: summ = r; continue
        if 'question_id' in r: rows.append(r)
    scored = [r for r in rows if not r.get('abstention') and not r.get('error')]
    types = {}
    for r in scored:
        t = types.setdefault(r['question_type'], {'total': 0, 'hit_all': 0, 'hit_any': 0, 'dist': 0.0, 'short': 0})
        t['total'] += 1; t['hit_all'] += bool(r['recall_all_hit']); t['hit_any'] += bool(r['recall_any_hit'])
        d = r.get('distinct_sessions_in_top_k') or 0; t['dist'] += d; t['short'] += d < 5
    by_type = {k: {'total': v['total'], 'hit_all': v['hit_all'], 'recall_all': v['hit_all'] / v['total'], 'hit_any': v['hit_any'],
                   'recall_any': v['hit_any'] / v['total'], 'mean_distinct_sessions': v['dist'] / v['total'], 'session_shortfall_rate': v['short'] / v['total']}
               for k, v in sorted(types.items())}
    n = len(scored); ha = sum(bool(r['recall_all_hit']) for r in scored); hy = sum(bool(r['recall_any_hit']) for r in scored)
    dist = sum((r.get('distinct_sessions_in_top_k') or 0) for r in scored) / n
    arm = os.path.basename(path).replace('.ndjson', '')
    summaries.append({
        'adapter': label, 'dataset': 'longmemeval_s_cleaned', 'topK': (summ or {}).get('k', 5),
        'total': n, 'n_rows': len(rows), 'n_abs': sum(1 for r in rows if r.get('abstention')),
        'n_errors_sut': sum(1 for r in rows if r.get('error')), 'n_errors_infra': 0,
        'recall_all_at_k': ha / n, 'recall_any_at_k': hy / n, 'ndcg_any_at_k': None, 'abs_noise_at_k': None,
        'mean_distinct_sessions': dist, 'session_shortfall_rate': sum(1 for r in scored if (r.get('distinct_sessions_in_top_k') or 0) < 5) / n,
        'recall_by_type': by_type, 'avg_latency_ms': None, 'p50_latency_ms': None, 'p99_latency_ms': None,
        'total_seconds': passes_seconds(arm),
        'run_config': (summ or {}).get('run_config'),
    })
    print(f"{label}: {ha}/{n} recall_all, {hy}/{n} any, wall {passes_seconds(arm):.0f}s")
json.dump({'opts': {'datasetName': 's', 'topK': 5, 'source': 'gbrain eval longmemeval (in-repo harness), 2026-09-06 ranker wave'}, 'summaries': summaries}, open(out, 'w'), indent=1)
print('wrote', out)
