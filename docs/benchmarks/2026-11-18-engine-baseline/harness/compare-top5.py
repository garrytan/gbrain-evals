#!/usr/bin/env python3
"""Compare the top 5 per probe between runs, from summarize.py's per-query.jsonl files.

Usage: compare-top5.py <out.json> <label>=<per-query.jsonl>[:<engine>-<run>] ...
Each argument names one run, for example
  rust-r1=dbc/per-query.jsonl:rust-1   pglite-6ad5-r1=old/per-query.jsonl:pglite-1
(run 0 is a <engine>-ctl control run). The first run is the reference. For every other run it counts probes
whose ordered top-5 page ids differ, probes whose top-5 set differs, and the metric deltas, and lists every
differing probe with both rankings and its graded gold.
"""
import json, sys

out_path, specs = sys.argv[1], sys.argv[2:]
runs = {}
for spec in specs:
    label, rest = spec.split('=', 1)
    path, sel = rest.rsplit(':', 1)
    engine, run = sel.rsplit('-', 1)
    rows = {}
    for line in open(path):
        q = json.loads(line)
        if q['engine'] == engine and q['run'] == int(run):
            rows[q['id']] = q
    if not rows:
        sys.exit(f'no rows for {sel} in {path}')
    runs[label] = rows

ref_label = specs[0].split('=', 1)[0]
ref = runs[ref_label]
report = {'reference': ref_label, 'probes': len(ref), 'comparisons': {}}
for label, rows in runs.items():
    if label == ref_label:
        continue
    if set(rows) != set(ref):
        sys.exit(f'{label} has a different probe set from {ref_label}')
    diffs = []
    for qid, a in ref.items():
        b = rows[qid]
        if a['top5'] != b['top5']:
            diffs.append({
                'id': qid, 'template': a['template'], 'same_set': set(a['top5']) == set(b['top5']),
                'reference_top5': a['top5'], 'top5': b['top5'],
                'graded_gold': a['graded_gold'],
                'ndcg5_delta': b['ndcg5'] - a['ndcg5'], 'r5_delta': b['r5'] - a['r5'], 'mrr5_delta': b['mrr5'] - a['mrr5'],
            })
    report['comparisons'][label] = {
        'ordered_top5_differs': len(diffs),
        'top5_set_differs': sum(1 for d in diffs if not d['same_set']),
        'quality_changed': sum(1 for d in diffs if d['ndcg5_delta'] or d['r5_delta'] or d['mrr5_delta']),
        'ndcg5_delta_sum': sum(d['ndcg5_delta'] for d in diffs),
        'probes': diffs,
    }
json.dump(report, open(out_path, 'w'), indent=2)
for label, c in report['comparisons'].items():
    print(f"{label} vs {ref_label}: ordered top-5 differs on {c['ordered_top5_differs']}/{len(ref)}, "
          f"set differs on {c['top5_set_differs']}, quality changed on {c['quality_changed']}")
