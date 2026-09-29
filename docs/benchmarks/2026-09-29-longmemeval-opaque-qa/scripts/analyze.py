#!/usr/bin/env python3
"""M6 analysis: per-arm accuracy (gbrain-framed judge and exact-official judge),
delivered tokens, cost, latency, provider/judge failures, paired exact McNemar.
Writes summary.json and per_question.csv; prints a text report."""
import json, math, csv, statistics, collections, os, re, sys

M6 = os.environ.get('M6_DIR', os.getcwd())
DS = {q['question_id']: q for q in json.load(open(f'{M6}/data/longmemeval_s_cleaned.json'))}
SUBSET = [l.strip() for l in open(f'{M6}/subset100_seed20260929.txt') if l.strip() and not l.startswith('#')]
PRICE = {'sonnet': (3e-6, 15e-6), 'gpt-4o': (2.5e-6, 10e-6), 'embed': 0.13e-6}


def nd(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def last_by_qid(rows):
    out = {}
    for r in rows:
        if isinstance(r.get('question_id'), str) and r.get('kind') != 'by_type_summary':
            out[r['question_id']] = r
    return out


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    return xs[f] if f == c else xs[f] + (xs[c] - xs[f]) * (k - f)


def mcnemar(a, b):
    """a, b: dict qid -> bool over the same qids. Returns gains (b right, a wrong), losses, exact two-sided p."""
    qids = sorted(set(a) & set(b))
    gain = sum(1 for q in qids if b[q] and not a[q])
    loss = sum(1 for q in qids if a[q] and not b[q])
    n = gain + loss
    if n == 0:
        p = 1.0
    else:
        k = min(gain, loss)
        p = min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)
    return {'n_paired': len(qids), 'a_correct': sum(a[q] for q in qids), 'b_correct': sum(b[q] for q in qids),
            'gains': gain, 'losses': loss, 'exact_mcnemar_p': p}


# ---------------------------------------------------------------- arm (a)
a_rows = last_by_qid(nd(f'{M6}/a/rows.ndjson'))
a_calls = nd(f'{M6}/a/calls.ndjson')
qkey = {(q['question'], q['question_date']): qid for qid, q in DS.items()}
qtext = {q['question']: qid for qid, q in DS.items()}
a_reader_calls = collections.defaultdict(list)
a_judge_calls = collections.defaultdict(list)
embed_tokens = 0
embed_calls = 0
for c in a_calls:
    if c['lane'] == 'reader':
        qid = qkey.get((c.get('question'), c.get('question_date'))) or qtext.get(c.get('question'))
        a_reader_calls[qid].append(c)
    elif c['lane'] == 'judge':
        a_judge_calls[qtext.get(c.get('reader_question'))].append(c)
    elif c['lane'] == 'embed':
        embed_tokens += c.get('usage_tokens') or 0
        embed_calls += 1
a_off = {r['question_id']: r for r in nd(f'{M6}/a/official-judge.ndjson') if 'off_judge_correct' in r}

# End-to-end per-question wall time (GBRAIN_LME_DEBUG lines), pilot + full logs.
e2e = {}
for log in ('stderr.pilot.log', 'stderr.full.log'):
    p = f'{M6}/a/{log}'
    if os.path.exists(p):
        for line in open(p, errors='replace'):
            m = re.match(r'^\[longmemeval\] (\S+) (\d+)ms$', line.strip())
            if m and m.group(1) in DS:
                e2e[m.group(1)] = int(m.group(2))


def arm_a():
    per = {}
    for qid, r in a_rows.items():
        calls = a_reader_calls.get(qid, [])
        ok = [c for c in calls if 'usage' in c]
        last = ok[-1] if ok else None
        jc = a_judge_calls.get(qid, [])
        per[qid] = {
            'reader_error': r.get('error'),
            'g_correct': r.get('judge_correct') is True,
            'g_judge_error': r.get('judge_error'),
            'o_correct': bool(a_off.get(qid, {}).get('off_judge_correct')),
            'o_judged': qid in a_off,
            'in_tokens': last['usage']['input_tokens'] if last else None,
            'out_tokens': last['usage']['output_tokens'] if last else None,
            'ctx_chars': r.get('reader_context_chars'),
            'ctx_sessions': r.get('reader_context_sessions'),
            'reader_latency_ms': last['latency_ms'] if last else None,
            'e2e_ms': e2e.get(qid),
            'reader_provider_failures': len([c for c in calls if 'provider_error' in c]),
            'judge_calls': len(jc),
            'judge_provider_failures': len([c for c in jc if 'provider_error' in c]),
            'judge_in': sum(c['usage']['input_tokens'] for c in jc if 'usage' in c),
            'judge_out': sum(c['usage']['output_tokens'] for c in jc if 'usage' in c),
            'recall_all_hit': r.get('recall_all_hit'),
            'hypothesis': r.get('hypothesis'),
        }
    return per


def arm_generic(path, price_key):
    per = {}
    for qid, r in last_by_qid(nd(path)).items():
        u = r.get('reader_usage') or {}
        ju = r.get('judge_usage') or {}
        ou = r.get('off_judge_usage') or {}
        per[qid] = {
            'reader_error': r.get('reader_error'),
            'g_correct': r.get('judge_correct') is True,
            'g_judge_error': r.get('judge_error'),
            'o_correct': r.get('off_judge_correct') is True,
            'o_judged': 'off_judge_correct' in r,
            'o_judge_error': r.get('off_judge_error'),
            'in_tokens': u.get('input_tokens'),
            'out_tokens': u.get('output_tokens'),
            'ctx_chars': r.get('reader_context_chars') or r.get('evidence_chars'),
            'ctx_sessions': r.get('reader_context_sessions'),
            'reader_latency_ms': r.get('reader_latency_ms'),
            'reader_provider_failures': len(r.get('reader_failures') or []),
            'judge_provider_failures': (r.get('judge_attempts') or 1) - 1 + len(r.get('off_judge_failures') or []),
            'judge_in': (ju.get('input_tokens') or 0), 'judge_out': (ju.get('output_tokens') or 0),
            'ojudge_in': (ou.get('input_tokens') or 0), 'ojudge_out': (ou.get('output_tokens') or 0),
            'think_parsed': r.get('think_envelope_parsed'),
            'hypothesis': r.get('hypothesis'),
        }
    return per


def summarize(name, per, denom_qids, reader_price, extra_cost=0.0, ojudge_from=None):
    qids = [q for q in denom_qids]
    have = [q for q in qids if q in per]
    rows = [per[q] for q in have]
    n = len(qids)
    g_ok = sum(1 for r in rows if r['g_correct'] and not r['reader_error'])
    o_ok = sum(1 for r in rows if r['o_correct'] and not r['reader_error'])
    reader_err = [q for q in have if per[q]['reader_error']]
    g_err = [q for q in have if per[q].get('g_judge_error')]
    o_unjudged = [q for q in have if not per[q]['reader_error'] and not per[q]['o_judged']]
    ins = [r['in_tokens'] for r in rows if r['in_tokens'] is not None]
    outs = [r['out_tokens'] for r in rows if r['out_tokens'] is not None]
    lat = [r['reader_latency_ms'] for r in rows if r['reader_latency_ms'] is not None]
    rp_in, rp_out = reader_price
    reader_cost = sum(ins) * rp_in + sum(outs) * rp_out
    gj_cost = sum(r['judge_in'] for r in rows) * 2.5e-6 + sum(r['judge_out'] for r in rows) * 10e-6
    if ojudge_from is not None:
        oj_cost = sum(ojudge_from.get(q, {}).get('off_judge_usage', {}).get('input_tokens', 0) for q in have) * 2.5e-6 + \
                  sum(ojudge_from.get(q, {}).get('off_judge_usage', {}).get('output_tokens', 0) for q in have) * 10e-6
    else:
        oj_cost = sum(r.get('ojudge_in', 0) for r in rows) * 2.5e-6 + sum(r.get('ojudge_out', 0) for r in rows) * 10e-6
    by_type = collections.defaultdict(lambda: [0, 0, 0])
    for q in qids:
        t = 'abstention' if q.endswith('_abs') else DS[q]['question_type']
        by_type[t][2] += 1
        if q in per and not per[q]['reader_error']:
            by_type[t][0] += per[q]['g_correct']
            by_type[t][1] += per[q]['o_correct']
    out = {
        'arm': name, 'denominator': n, 'rows_present': len(have),
        'correct_gbrain_judge': g_ok, 'correct_official_judge': o_ok,
        'accuracy_gbrain_judge': g_ok / n if n else None, 'accuracy_official_judge': o_ok / n if n else None,
        'reader_errors': len(reader_err), 'reader_error_ids': reader_err,
        'reader_provider_failed_attempts': sum(r['reader_provider_failures'] for r in rows),
        'gbrain_judge_errors': len(g_err), 'official_judge_unjudged': len(o_unjudged),
        'judge_provider_failed_attempts': sum(r['judge_provider_failures'] for r in rows),
        'delivered_input_tokens': {'mean': statistics.mean(ins) if ins else None, 'median': pct(ins, .5), 'p95': pct(ins, .95), 'total': sum(ins)},
        'output_tokens': {'mean': statistics.mean(outs) if outs else None, 'total': sum(outs)},
        'context_chars_mean': statistics.mean([r['ctx_chars'] for r in rows if r['ctx_chars']]) if rows else None,
        'context_sessions_mean': statistics.mean([r['ctx_sessions'] for r in rows if r['ctx_sessions']]) if any(r['ctx_sessions'] for r in rows) else None,
        'reader_latency_ms': {'p50': pct(lat, .5), 'p95': pct(lat, .95)},
        'cost_usd': {'reader': reader_cost, 'gbrain_judge': gj_cost, 'official_judge': oj_cost, 'other': extra_cost,
                     'total': reader_cost + gj_cost + oj_cost + extra_cost},
        'by_type': {t: {'n': v[2], 'correct_gbrain_judge': v[0], 'correct_official_judge': v[1]} for t, v in sorted(by_type.items())},
    }
    e2 = [r.get('e2e_ms') for r in rows if r.get('e2e_ms')]
    if e2:
        out['end_to_end_ms'] = {'p50': pct(e2, .5), 'p95': pct(e2, .95), 'n': len(e2), 'note': 'import+embed(cold cache)+search+reader+judge per question'}
    if name.startswith('c3'):
        out['think_envelope_unparsed'] = sum(1 for r in rows if r.get('think_parsed') is False)
    return out


def correct_map(per, qids, key):
    return {q: bool(per[q][key]) and not per[q]['reader_error'] for q in qids if q in per}


A = arm_a()
B = arm_generic(f'{M6}/b/rows.ndjson', 'gpt-4o')
C = {k: arm_generic(f'{M6}/c/{k}.ndjson', 'sonnet') for k in ('c1', 'c2', 'c3')}
ALL = sorted(DS)
a_off_rows = {q: r for q, r in a_off.items()}

summary = {'arms': {}, 'paired': {}}
summary['arms']['a_house_full500'] = summarize('a_house_full500', A, ALL, PRICE['sonnet'], extra_cost=embed_tokens * PRICE['embed'], ojudge_from=a_off_rows)
summary['arms']['a_house_full500']['embedding'] = {'tokens': embed_tokens, 'calls': embed_calls, 'cost_usd': embed_tokens * PRICE['embed']}
summary['arms']['b_gpt4o_official'] = summarize('b_gpt4o_official', B, ALL, PRICE['gpt-4o'])
summary['arms']['a_house_subset100'] = summarize('a_house_subset100', A, SUBSET, PRICE['sonnet'], ojudge_from=a_off_rows)
for k, name in (('c1', 'c1_prod_reader_chunks'), ('c2', 'c2_plain_rag_chunks'), ('c3', 'c3_think_prompt_chunks')):
    summary['arms'][name] = summarize(name, C[k], SUBSET, PRICE['sonnet'])

for judge, key in (('gbrain_judge', 'g_correct'), ('official_judge', 'o_correct')):
    ca = correct_map(A, ALL, key)
    summary['paired'][f'b_vs_a_{judge}'] = mcnemar(ca, correct_map(B, ALL, key))
    sa = correct_map(A, SUBSET, key)
    c = {k: correct_map(C[k], SUBSET, key) for k in C}
    summary['paired'][f'c1_vs_a_{judge}'] = mcnemar(sa, c['c1'])
    summary['paired'][f'c2_vs_a_{judge}'] = mcnemar(sa, c['c2'])
    summary['paired'][f'c3_vs_a_{judge}'] = mcnemar(sa, c['c3'])
    summary['paired'][f'c2_vs_c1_{judge}'] = mcnemar(c['c1'], c['c2'])
    summary['paired'][f'c3_vs_c1_{judge}'] = mcnemar(c['c1'], c['c3'])

# Judge agreement on the same hypotheses.
agree = {}
for name, per in (('a', A), ('b', B), ('c1', C['c1']), ('c2', C['c2']), ('c3', C['c3'])):
    both = [q for q, r in per.items() if not r['reader_error'] and r['o_judged'] and not r.get('g_judge_error')]
    agree[name] = {'n': len(both), 'agree': sum(1 for q in both if per[q]['g_correct'] == per[q]['o_correct'])}
summary['judge_agreement'] = agree

# Evidence-complete conversion on the 470 non-abstention questions (arm a retrieval).
non_abs = [q for q in ALL if not q.endswith('_abs') and q in A]
complete = [q for q in non_abs if A[q]['recall_all_hit'] is True]
summary['evidence'] = {
    'non_abstention': len(non_abs), 'recall_all_hit_at5': len(complete),
    'a_correct_given_complete_gbrain_judge': sum(1 for q in complete if A[q]['g_correct'] and not A[q]['reader_error']),
    'b_correct_given_complete_gbrain_judge': sum(1 for q in complete if q in B and B[q]['g_correct'] and not B[q]['reader_error']),
    'a_correct_given_complete_official_judge': sum(1 for q in complete if A[q]['o_correct'] and not A[q]['reader_error']),
    'b_correct_given_complete_official_judge': sum(1 for q in complete if q in B and B[q]['o_correct'] and not B[q]['reader_error']),
}

json.dump(summary, open(f'{M6}/summary.json', 'w'), indent=2)
with open(f'{M6}/per_question.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['question_id', 'question_type', 'in_subset100', 'recall_all_hit_at5', 'a_correct_gbrain', 'a_correct_official', 'a_reader_error',
                'b_correct_gbrain', 'b_correct_official', 'b_reader_error', 'c1_correct_gbrain', 'c1_correct_official', 'c2_correct_gbrain',
                'c2_correct_official', 'c3_correct_gbrain', 'c3_correct_official', 'a_in_tokens', 'b_in_tokens', 'c1_in_tokens'])
    sub = set(SUBSET)
    for q in ALL:
        g = lambda per, k: ('' if q not in per else int(bool(per[q][k]) and not per[q]['reader_error']))
        w.writerow([q, DS[q]['question_type'], int(q in sub), A.get(q, {}).get('recall_all_hit', ''),
                    g(A, 'g_correct'), g(A, 'o_correct'), A.get(q, {}).get('reader_error') or '',
                    g(B, 'g_correct'), g(B, 'o_correct'), B.get(q, {}).get('reader_error') or '',
                    g(C['c1'], 'g_correct'), g(C['c1'], 'o_correct'), g(C['c2'], 'g_correct'), g(C['c2'], 'o_correct'),
                    g(C['c3'], 'g_correct'), g(C['c3'], 'o_correct'),
                    A.get(q, {}).get('in_tokens', ''), B.get(q, {}).get('in_tokens', ''), C['c1'].get(q, {}).get('in_tokens', '')])

for k, v in summary['arms'].items():
    print(f"{k}: n={v['denominator']} present={v['rows_present']} gbrain={v['correct_gbrain_judge']} official={v['correct_official_judge']} "
          f"reader_err={v['reader_errors']} gj_err={v['gbrain_judge_errors']} oj_unjudged={v['official_judge_unjudged']} "
          f"in_tok_mean={v['delivered_input_tokens']['mean']} lat={v['reader_latency_ms']} cost={v['cost_usd']['total']:.3f}")
for k, v in summary['paired'].items():
    print(k, v)
print('judge agreement', agree)
print('evidence', summary['evidence'])
