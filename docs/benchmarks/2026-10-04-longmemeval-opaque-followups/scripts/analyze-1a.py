#!/usr/bin/env python3
"""Item 1a analysis: each opaque-id recount arm against its published raw-id receipt, question by question.

Usage: analyze-1a.py <receipts-dir> <out-summary.json>
<receipts-dir> holds 1a-H/<arm>/rows.ndjson(.gz) and 1a-R/rows.ndjson(.gz). Strict recall_all@5 and recall_any@5 over the
answerable questions (no `_abs`), paired gains/losses on strict hits, two-sided exact McNemar p.
"""
import gzip, json, math, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SEPT6 = os.path.join(ROOT, '2026-09-06-longmemeval-ranker-wave', 'longmemeval')
SEPT2 = os.path.join(ROOT, '2026-05-07-longmemeval-s')
OPAQ = os.path.join(ROOT, '2026-09-29-longmemeval-opaque-qa')
H_ARMS = {
    'A1': 'A1-hybrid-rerank-off-autocut-off', 'A2': 'A2-hybrid-rerank-on-autocut-off', 'A3': 'A3-hybrid-expansion-rerank-off-autocut-off',
    'A4': 'A4-default-rerank-on-autocut-on', 'A3p': 'A3prime-hybrid-expansion-budget0.25-rerank-off',
    'A3pR': 'A3primeR-tokenmax-expansion-budget0.25-rerank-on-autocut-on', 'TMXR': 'TMXR-tokenmax-as-released-legacy-expansion-rerank-on-autocut-off',
    'FINAL': 'FINAL-release-config-rerank-on-autocut-off-pin3-gate-lexical',
    'dev40-b2.0': 'devslice40-budget2.0', 'dev40-b1.0': 'devslice40-budget1.0', 'dev40-b0.5': 'devslice40-budget0.5', 'dev40-b0.25': 'devslice40-budget0.25',
}
R_ARMS = ['hybrid', 'hybrid+expansion', 'hybrid-sessdiv', 'hybrid+rerank', 'hybrid-sessdiv+rerank']


def nd(path):
    if not os.path.exists(path) and os.path.exists(path + '.gz'):
        path += '.gz'
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt') as f:
        return [json.loads(l) for l in f if l.strip()]


def mcnemar(gains, losses):
    n = gains + losses
    if n == 0:
        return 1.0
    k = min(gains, losses)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def compare(old, new, ids):
    g = sum(1 for q in ids if new[q][0] and not old[q][0])
    l = sum(1 for q in ids if old[q][0] and not new[q][0])
    return {'denominator': len(ids), 'old_strict': sum(old[q][0] for q in ids), 'new_strict': sum(new[q][0] for q in ids),
            'old_any': sum(old[q][1] for q in ids), 'new_any': sum(new[q][1] for q in ids),
            'gains': g, 'losses': l, 'exact_mcnemar_p': mcnemar(g, l)}


def verdict(c):
    return 'moved' if c['exact_mcnemar_p'] < 0.05 or abs(c['new_strict'] - c['old_strict']) >= 10 else 'confirmed'


def harness_map(rows):
    return {r['question_id']: (bool(r['recall_all_hit']), bool(r['recall_any_hit'])) for r in rows
            if r.get('question_id') and not r.get('abstention') and '_abs' not in r['question_id']}


def main():
    rec, out = sys.argv[1], sys.argv[2]
    H = '1a-H' if os.path.isdir(os.path.join(rec, '1a-H')) else '1a-harness'
    RR = '1a-R' if os.path.isdir(os.path.join(rec, '1a-R')) else '1a-runner'
    summary = {'harness': {}, 'runner': {}, 'context': {}}
    dev40 = {r['question_id'] for r in nd(os.path.join(SEPT6, 'devslice40-budget0.25.ndjson')) if r.get('question_id')}
    for arm, pub in H_ARMS.items():
        p = os.path.join(rec, H, arm, 'rows.ndjson')
        if not (os.path.exists(p) or os.path.exists(p + '.gz')):
            summary['harness'][arm] = {'status': 'missing'}
            continue
        rows = nd(p)
        tail = rows[-1] if rows and rows[-1].get('kind') == 'by_type_summary' else None
        old, new = harness_map(nd(os.path.join(SEPT6, pub + '.ndjson'))), harness_map(rows)
        ids = sorted(set(old) & set(new))
        entry = {'published_receipt': pub + '.ndjson', 'rows': len(new), 'missing_vs_published': sorted(set(old) - set(new)),
                 'all': compare(old, new, ids)}
        if not arm.startswith('dev40'):
            entry['decision_set'] = compare(old, new, [q for q in ids if q not in dev40])
        entry['verdict'] = verdict(entry['all'])
        if tail:
            rc = tail.get('run_config', {})
            entry['run_config'] = {k: rc.get(k) for k in ('mode', 'reranker', 'autocut', 'expansion', 'expansion_variant_budget', 'search_pins', 'retrieval_config_hash', 'knobs_hash', 'knobs_hash_version', 'reranker_skipped_rows', 'vector_degraded_rows', 'expansion_failed_rows', 'expansion_replay_miss', 'errors', 'slug_collisions', 'gold_missing_from_haystack')}
            entry['run_config']['cache_misses'] = (rc.get('cache') or {}).get('misses')
            entry['mean_distinct_sessions'] = tail.get('mean_distinct_sessions')
        degraded = [r['question_id'] for r in rows if r.get('question_id') and (r.get('search_meta') or {}).get('degraded')]
        entry['rows_with_degraded_stage'] = degraded
        entry['error_rows'] = [r['question_id'] for r in rows if r.get('question_id') and r.get('error')]
        summary['harness'][arm] = entry
    rp = os.path.join(rec, RR, 'rows.ndjson')
    if os.path.exists(rp) or os.path.exists(rp + '.gz'):
        rows = nd(rp)
        for a in R_ARMS:
            name = 'gbrain-' + a
            new = {r['question_id']: (bool(r['recall_all']), bool(r['recall_any'])) for r in rows if r.get('adapter') == name and '_abs' not in r['question_id'] and r.get('recall_all') is not None}
            old = {r['question_id']: (bool(r['recall_all']), bool(r['recall_any'])) for r in nd(os.path.join(SEPT2, f'rerun-2026-09-02-v0.48.2.0-{a}.ndjson')) if r.get('adapter') == name and '_abs' not in r['question_id'] and r.get('recall_all') is not None}
            ids = sorted(set(old) & set(new))
            errs = [r['question_id'] for r in rows if r.get('adapter') == name and r.get('error')]
            c = compare(old, new, ids) if ids else None
            summary['runner'][a] = {'rows': len(new), 'error_rows': errs, 'all': c, 'verdict': verdict(c) if c else None}
    # context: the 2026-09-29/30 opaque-id harness runs at gbrain a7cb37b
    a = {r['question_id']: (bool(r['recall_all_hit']), bool(r['recall_any_hit'])) for r in nd(os.path.join(OPAQ, 'a', 'rows.ndjson')) if r.get('question_id') and '_abs' not in r['question_id'] and 'recall_all_hit' in r}
    r1 = {r['question_id']: (bool(r['recall_all_hit']), bool(r['recall_any_hit'])) for r in nd(os.path.join(OPAQ, 'reranker-on', 'r1', 'rows.ndjson')) if r.get('question_id') and '_abs' not in r['question_id'] and 'recall_all_hit' in r}
    for arm, ctx, label in (('A1', a, 'a7cb37b_reranker_off'), ('FINAL', r1, 'a7cb37b_reranker_on')):
        p = os.path.join(rec, H, arm, 'rows.ndjson')
        if os.path.exists(p) or os.path.exists(p + '.gz'):
            new = harness_map(nd(p)); ids = sorted(set(ctx) & set(new))
            summary['context'][f'{arm}_vs_{label}'] = compare(ctx, new, ids)
    json.dump(summary, open(out, 'w'), indent=1)
    for k, v in summary['harness'].items():
        if 'all' in v:
            c = v['all']; print(f"{k:12s} old {c['old_strict']}/{c['denominator']} new {c['new_strict']}/{c['denominator']} any {c['old_any']}->{c['new_any']} +{c['gains']}/-{c['losses']} p={c['exact_mcnemar_p']:.3g} {v['verdict']}")
    for k, v in summary['runner'].items():
        if v['all']:
            c = v['all']; print(f"R {k:22s} old {c['old_strict']}/{c['denominator']} new {c['new_strict']}/{c['denominator']} any {c['old_any']}->{c['new_any']} +{c['gains']}/-{c['losses']} p={c['exact_mcnemar_p']:.3g} {v['verdict']}")
    for k, c in summary['context'].items():
        print(f"ctx {k}: {c['old_strict']} -> {c['new_strict']} +{c['gains']}/-{c['losses']} p={c['exact_mcnemar_p']:.3g}")


if __name__ == '__main__':
    main()
