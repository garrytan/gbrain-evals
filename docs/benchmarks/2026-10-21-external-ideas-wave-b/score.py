#!/usr/bin/env python3
"""Score external-ideas wave B: per-arm recall_all@5 / recall_any@5 (k5 runs), NDCG@10 (k10 runs), per type, paired exact sign test with Holm."""
import json, glob, math, os, sys
from math import comb
L = os.path.expanduser('~/.capy/work/gbra162/lme')
ARMS = ['B0', 'B1', 'B2', 'B3']
ids = [l.strip() for l in open(os.path.expanduser('~/.capy/work/datasets/lme-s-470.txt')) if l.strip()]

def load(arm, k):
    rows, summaries = {}, []
    for f in sorted(glob.glob(f'{L}/runs/{arm}-k{k}-s*.ndjson')):
        for line in open(f):
            o = json.loads(line)
            if o.get('kind') == 'by_type_summary': summaries.append(o)
            elif 'question_id' in o: rows[o['question_id']] = o
    return rows, summaries

def bad(r):
    if r is None or r.get('error'): return True
    m = r.get('search_meta') or {}
    deg = {d.get('stage') for d in (m.get('degraded') or [])}
    return bool(deg & {'reranker_skipped', 'rerank_failed', 'rerank_passthrough'}) or m.get('reranked') is False

def ndcg10(r):
    if bad(r): return 0.0
    gold = set(r.get('answer_session_ids') or [])
    ret = (r.get('retrieved_session_ids') or [])[:10]
    dcg = sum(1 / math.log2(i + 2) for i, s in enumerate(ret) if s in gold)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(gold), 10)))
    return dcg / idcg if idcg else 0.0

def p_one_sided(b, n):
    return sum(comb(n, i) for i in range(b, n + 1)) / 2 ** n if n else 1.0

out = {'arms': {}, 'paired': {}, 'hashes': {}}
data = {}
for a in ARMS:
    r5, s5 = load(a, 5); r10, s10 = load(a, 10)
    if not r5: continue
    hit_all = {q: (not bad(r5.get(q))) and r5[q].get('recall_all_hit') is True for q in ids}
    hit_any = {q: (not bad(r5.get(q))) and r5[q].get('recall_any_hit') is True for q in ids}
    nd = {q: ndcg10(r10.get(q)) for q in ids} if r10 else None
    bad5 = sum(bad(r5.get(q)) for q in ids); bad10 = sum(bad(r10.get(q)) for q in ids) if r10 else None
    types = {}
    for q in ids:
        t = (r5.get(q) or {}).get('question_type', 'unknown')
        types.setdefault(t, [0, 0]); types[t][0] += 1; types[t][1] += hit_all[q]
    data[a] = hit_all
    out['arms'][a] = {
        'n': len(ids), 'rows_k5': len(r5), 'rows_k10': len(r10), 'bad_k5': bad5, 'bad_k10': bad10,
        'recall_all5': sum(hit_all.values()), 'recall_any5': sum(hit_any.values()),
        'ndcg10': round(sum(nd.values()) / len(ids), 4) if nd else None, 'by_type': types,
    }
    out['hashes'][a] = sorted({s['run_config']['retrieval_config_hash'] for s in s5} | {s['run_config']['retrieval_config_hash'] for s in s10})
ps = {}
for a in ARMS[1:]:
    if a not in data or 'B0' not in data: continue
    b = sum(data[a][q] and not data['B0'][q] for q in ids); c = sum(data['B0'][q] and not data[a][q] for q in ids)
    ps[a] = p_one_sided(b, b + c)
    out['paired'][a] = {'arm_only': b, 'b0_only': c, 'net': b - c, 'p_one_sided': round(ps[a], 5)}
order = sorted(ps, key=lambda a: ps[a]); m = len(order); stop = False
for i, a in enumerate(order):
    thr = 0.05 / (m - i)
    ok = (not stop) and ps[a] <= thr and out['paired'][a]['net'] > 0
    if not ok: stop = True
    out['paired'][a].update({'holm_threshold': round(thr, 5), 'recall_pass': ok})
json.dump(out, sys.stdout, indent=2)
