#!/usr/bin/env python3
"""Reranker follow-ups (R1, R2) against arm (a) and the historical September 6 run.
Writes summary-rerank.json and per_question_rerank.csv."""
import json, math, csv, statistics, collections, os, re, sys

M6 = os.environ.get('M6_DIR', os.getcwd())
EVALS = os.environ.get('EVALS_DIR', '.')
WAVE = f'{EVALS}/docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval'
DS = {q['question_id']: q for q in json.load(open(f'{M6}/data/longmemeval_s_cleaned.json'))}
ALL = sorted(DS)
NON_ABS = [q for q in ALL if not q.endswith('_abs')]
PRICE = {'sonnet': (3e-6, 15e-6), 'gpt-4o': (2.5e-6, 10e-6), 'rerank': 0.05e-6}


def nd(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def by_qid(rows):
    out = {}
    for r in rows:
        if isinstance(r.get('question_id'), str) and r.get('kind') != 'by_type_summary':
            out[r['question_id']] = r
    return out


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    return xs[f] if f == c else xs[f] + (xs[c] - xs[f]) * (k - f)


def mcnemar(a, b):
    qids = sorted(set(a) & set(b))
    gain = sum(1 for q in qids if b[q] and not a[q])
    loss = sum(1 for q in qids if a[q] and not b[q])
    n = gain + loss
    p = 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(min(gain, loss) + 1)) / 2 ** n)
    return {'n_paired': len(qids), 'a_correct': sum(a[q] for q in qids), 'b_correct': sum(b[q] for q in qids),
            'gains': gain, 'losses': loss, 'exact_mcnemar_p': p}


qtext = {q['question']: qid for qid, q in DS.items()}


def load_arm(name):
    rows = by_qid(nd(f'{M6}/{name}/rows.ndjson'))
    off = by_qid(nd(f'{M6}/{name}/official-judge.ndjson'))
    calls = nd(f'{M6}/{name}/calls.ndjson')
    reader, judge, rerank = collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    pending_rerank = []
    for c in calls:
        if c['lane'] == 'rerank':
            pending_rerank.append(c)
        elif c['lane'] == 'reader':
            qid = qtext.get(c.get('question'))
            reader[qid].append(c)
            rerank[qid].extend(pending_rerank)
            pending_rerank = []
        elif c['lane'] == 'judge':
            judge[qtext.get(c.get('reader_question'))].append(c)
    orphan_rerank = pending_rerank
    e2e = {}
    for log in ('stderr.pilot.txt', 'stderr.full.txt', 'stderr.pilot.log', 'stderr.full.log'):
        p = f'{M6}/{name}/{log}'
        if os.path.exists(p):
            for line in open(p, errors='replace'):
                m = re.match(r'^\[longmemeval\] (\S+) (\d+)ms$', line.strip())
                if m and m.group(1) in DS:
                    e2e[m.group(1)] = int(m.group(2))
    return rows, off, reader, judge, rerank, orphan_rerank, e2e, calls


def ok(r, off=None, key='judge_correct'):
    if r is None or isinstance(r.get('error'), str):
        return False
    if off is not None:
        return bool(off.get('off_judge_correct'))
    return r.get(key) is True


summary = {'arms': {}, 'paired': {}, 'retrieval': {}}
arms = {}
for name in ('a', 'r1', 'r2'):
    arms[name] = load_arm(name)

for name in ('r1', 'r2'):
    rows, off, reader, judge, rerank, orphan, e2e, calls = arms[name]
    last = {q: [c for c in reader[q] if 'usage' in c][-1] for q in rows if any('usage' in c for c in reader[q])}
    ins = [c['usage']['input_tokens'] for c in last.values()]
    outs = [c['usage']['output_tokens'] for c in last.values()]
    lat = [c['latency_ms'] for c in last.values()]
    all_reader = [c for cs in reader.values() for c in cs]
    rr_all = [c for c in calls if c['lane'] == 'rerank']
    rr_tokens = sum((c.get('usage') or {}).get('total_tokens', 0) for c in rr_all)
    rr_status = collections.Counter(str(c.get('status', 'transport_error')) for c in rr_all)
    jcalls = [c for cs in judge.values() for c in cs]
    degraded = collections.Counter(s for r in rows.values() for s in (r.get('search_meta') or {}).get('degraded', []))
    reranked = sum(1 for r in rows.values() if (r.get('search_meta') or {}).get('reranked'))
    reader_err = {q: r['error'] for q, r in rows.items() if isinstance(r.get('error'), str)}
    gj = sum(ok(rows.get(q)) for q in ALL)
    oj = sum(ok(rows.get(q), off.get(q, {})) for q in ALL)
    oj_cost = sum((o.get('off_judge_usage') or {}).get('input_tokens', 0) * 2.5e-6 + (o.get('off_judge_usage') or {}).get('output_tokens', 0) * 10e-6 for o in off.values())
    reader_cost_all = sum(c['usage']['input_tokens'] * 3e-6 + c['usage']['output_tokens'] * 15e-6 for c in all_reader if 'usage' in c)
    gj_cost = sum(c['usage']['input_tokens'] * 2.5e-6 + c['usage']['output_tokens'] * 10e-6 for c in jcalls if 'usage' in c)
    by_type = collections.defaultdict(lambda: [0, 0, 0])
    for q in ALL:
        t = 'abstention' if q.endswith('_abs') else DS[q]['question_type']
        by_type[t][2] += 1
        by_type[t][0] += ok(rows.get(q))
        by_type[t][1] += ok(rows.get(q), off.get(q, {}))
    strict = sum(1 for q in NON_ABS if rows.get(q, {}).get('recall_all_hit') is True)
    summary['arms'][name] = {
        'denominator': 500, 'rows_present': len(rows),
        'correct_gbrain_judge': gj, 'correct_official_judge': oj,
        'reader_errors': len(reader_err), 'reader_error_detail': collections.Counter(reader_err.values()),
        'gbrain_judge_errors': sum(1 for r in rows.values() if r.get('judge_error')),
        'official_judge_unjudged': sum(1 for q, r in rows.items() if not isinstance(r.get('error'), str) and q not in off),
        'reader_calls': len(all_reader), 'reader_provider_failures': sum(1 for c in all_reader if 'provider_error' in c),
        'judge_calls': len(jcalls), 'judge_provider_failures': sum(1 for c in jcalls if 'provider_error' in c),
        'finish_reasons': collections.Counter(c.get('stop_reason') for c in last.values()),
        'delivered_input_tokens': {'mean': statistics.mean(ins), 'median': pct(ins, .5), 'p95': pct(ins, .95)},
        'output_tokens_mean': statistics.mean(outs),
        'reader_latency_ms': {'p50': pct(lat, .5), 'p95': pct(lat, .95)},
        'end_to_end_ms': {'p50': pct(list(e2e.values()), .5), 'p95': pct(list(e2e.values()), .95), 'n': len(e2e)},
        'strict_recall_all_at5': strict, 'strict_denominator': len(NON_ABS),
        'voyage': {'calls': len(rr_all), 'status': dict(rr_status), 'tokens': rr_tokens, 'cost_usd': rr_tokens * PRICE['rerank'],
                   'latency_ms': {'p50': pct([c['latency_ms'] for c in rr_all], .5), 'p95': pct([c['latency_ms'] for c in rr_all], .95)},
                   'rows_reranked': reranked, 'degraded_stages': dict(degraded)},
        'cost_usd': {'reader_all_calls': reader_cost_all, 'gbrain_judge': gj_cost, 'official_judge': oj_cost, 'voyage': rr_tokens * PRICE['rerank'],
                     'total': reader_cost_all + gj_cost + oj_cost + rr_tokens * PRICE['rerank']},
        'by_type': {t: {'n': v[2], 'correct_gbrain_judge': v[0], 'correct_official_judge': v[1]} for t, v in sorted(by_type.items())},
    }

# Accuracy maps.
acc = {}
for name in ('a', 'r1', 'r2'):
    rows, off = arms[name][0], arms[name][1]
    acc[name] = {'g': {q: ok(rows.get(q)) for q in ALL}, 'o': {q: ok(rows.get(q), off.get(q, {})) for q in ALL}}
d1 = by_qid(nd(f'{WAVE}/D1-judged-release-config-sonnet46-reader-gpt4o-judge.ndjson'))
acc['d1'] = {'g': {q: d1[q].get('judge_correct') is True for q in ALL}}
for j in ('g', 'o'):
    jn = 'gbrain_judge' if j == 'g' else 'official_judge'
    summary['paired'][f'r1_vs_a_{jn}'] = mcnemar(acc['a'][j], acc['r1'][j])
    summary['paired'][f'r2_vs_r1_{jn}'] = mcnemar(acc['r1'][j], acc['r2'][j])
    summary['paired'][f'r2_vs_a_{jn}'] = mcnemar(acc['a'][j], acc['r2'][j])
summary['paired']['r2_vs_published_d1_gbrain_judge'] = mcnemar(acc['d1']['g'], acc['r2']['g'])
summary['paired']['r2_vs_published_d1_gbrain_judge']['note'] = 'D1 = the invalid published 433/500 (September 6, v0.48.4.0, answer_ ids visible); gbrain judge on both sides, same judge prompt version'

# Retrieval: strict recall_all@5 on the 470 answerable questions.
ret = {}
for name in ('a', 'r1', 'r2'):
    rows = arms[name][0]
    ret[name] = {q: rows.get(q, {}).get('recall_all_hit') is True for q in NON_ABS}
for f, key in (('A1-hybrid-rerank-off-autocut-off.ndjson', 'sep6_a1_rerank_off'), ('A2-hybrid-rerank-on-autocut-off.ndjson', 'sep6_a2_rerank_on'),
               ('D1-judged-release-config-sonnet46-reader-gpt4o-judge.ndjson', 'sep6_d1_published')):
    rows = by_qid(nd(f'{WAVE}/{f}'))
    ret[key] = {q: rows[q].get('recall_all_hit') is True for q in NON_ABS}
summary['retrieval']['strict_counts'] = {k: sum(v.values()) for k, v in ret.items()}
summary['retrieval']['r1_vs_a'] = mcnemar(ret['a'], ret['r1'])
summary['retrieval']['r2_vs_a'] = mcnemar(ret['a'], ret['r2'])
summary['retrieval']['r1_vs_sep6_d1_published'] = mcnemar(ret['sep6_d1_published'], ret['r1'])
summary['retrieval']['r2_vs_sep6_d1_published'] = mcnemar(ret['sep6_d1_published'], ret['r2'])
r1rows, r2rows = arms['r1'][0], arms['r2'][0]
same = sum(1 for q in ALL if q in r1rows and q in r2rows and
           [(x['slug'], x['chunk_id']) for x in r1rows[q]['retrieved']] == [(x['slug'], x['chunk_id']) for x in r2rows[q]['retrieved']])
summary['retrieval']['r1_r2_identical_chunk_lists'] = same

# Evidence-complete conversion (strict hit) per arm.
summary['evidence'] = {}
for name in ('r1', 'r2'):
    comp = [q for q in NON_ABS if ret[name][q]]
    summary['evidence'][name] = {'recall_all_hit': len(comp), 'correct_given_complete_gbrain_judge': sum(acc[name]['g'][q] for q in comp),
                                 'correct_given_complete_official_judge': sum(acc[name]['o'][q] for q in comp)}

# Judge agreement.
summary['judge_agreement'] = {}
for name in ('r1', 'r2'):
    rows, off = arms[name][0], arms[name][1]
    both = [q for q, r in rows.items() if not isinstance(r.get('error'), str) and q in off and 'judge_correct' in r]
    summary['judge_agreement'][name] = {'n': len(both), 'agree': sum(1 for q in both if (r := rows[q])['judge_correct'] == off[q]['off_judge_correct'])}

json.dump(summary, open(f'{M6}/summary-rerank.json', 'w'), indent=2, default=dict)
with open(f'{M6}/per_question_rerank.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['question_id', 'question_type', 'a_recall_all', 'r1_recall_all', 'r2_recall_all', 'sep6_d1_recall_all',
                'a_correct_gbrain', 'a_correct_official', 'r1_correct_gbrain', 'r1_correct_official', 'r1_reader_error',
                'r2_correct_gbrain', 'r2_correct_official', 'r2_reader_error', 'sep6_d1_correct_gbrain'])
    for q in ALL:
        ra = lambda n: '' if q.endswith('_abs') else int(ret[n][q])
        w.writerow([q, DS[q]['question_type'], ra('a'), ra('r1'), ra('r2'), ra('sep6_d1_published'),
                    int(acc['a']['g'][q]), int(acc['a']['o'][q]), int(acc['r1']['g'][q]), int(acc['r1']['o'][q]), r1rows.get(q, {}).get('error') or '',
                    int(acc['r2']['g'][q]), int(acc['r2']['o'][q]), r2rows.get(q, {}).get('error') or '', int(acc['d1']['g'][q])])
print(json.dumps({k: {kk: v[kk] for kk in ('rows_present', 'correct_gbrain_judge', 'correct_official_judge', 'reader_errors', 'strict_recall_all_at5')} for k, v in summary['arms'].items()}, indent=1))
print(json.dumps(summary['paired'], indent=1)); print(json.dumps(summary['retrieval'], indent=1))
