#!/usr/bin/env python3
"""Keyless recount of the 2026-10-04 LongMemEval opaque-id follow-ups from the committed receipts.

Re-derives items 1a (retrieval recount), 1b (reading-notes transfer) and 2 (frontier reader) with the executed
analysis scripts, checks the headline counts the report quotes and that the re-derived summaries equal the
committed ones. No dataset, network or API key is needed.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
R = os.path.join(ROOT, 'docs', 'benchmarks', '2026-10-04-longmemeval-opaque-followups')
S = os.path.join(R, 'scripts')
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


with tempfile.TemporaryDirectory() as t:
    subprocess.run([sys.executable, os.path.join(S, 'analyze-1a.py'), R, os.path.join(t, '1a.json')], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([sys.executable, os.path.join(S, 'analyze-1b.py'), os.path.join(R, '1b', 'labels.ndjson.gz'), os.path.join(R, '1b'), os.path.join(t, '1b.json')], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([sys.executable, os.path.join(S, 'analyze-2.py'), os.path.join(R, '2', 'judged.ndjson.gz'), os.path.join(t, '2.json')], check=True, stdout=subprocess.DEVNULL)
    a, b, c = (json.load(open(os.path.join(t, f))) for f in ('1a.json', '1b.json', '2.json'))

for name, new in (('summary-1a.json', a), ('summary-1b.json', b), ('summary-2.json', c)):
    check(json.load(open(os.path.join(R, name))) == new, f'{name} differs from the re-derived summary')

H = a['harness']
want = {'A1': (439, 434, 1, 6), 'A2': (449, 451, 2, 0), 'A3': (255, 436, 184, 3), 'A4': (379, 384, 7, 2), 'A3p': (394, 435, 49, 8),
        'A3pR': (381, 383, 6, 4), 'TMXR': (436, 442, 7, 1), 'FINAL': (449, 451, 2, 0),
        'dev40-b2.0': (24, 36, 13, 1), 'dev40-b1.0': (26, 36, 11, 1), 'dev40-b0.5': (30, 36, 7, 1), 'dev40-b0.25': (34, 36, 3, 1)}
for arm, (o, n, g, l) in want.items():
    x = H[arm]['all']
    check((x['old_strict'], x['new_strict'], x['gains'], x['losses']) == (o, n, g, l), f'1a {arm}: {x}')
    check(H[arm]['rows'] == (40 if arm.startswith('dev40') else 470), f'1a {arm} answerable rows {H[arm]["rows"]}')
    check(not H[arm]['error_rows'] and not H[arm]['rows_with_degraded_stage'], f'1a {arm} has error or degraded rows')
check([k for k, v in H.items() if v['verdict'] == 'moved'] == ['A3', 'A3p', 'dev40-b2.0', 'dev40-b1.0'], '1a harness verdicts')
wr = {'hybrid': (438, 436), 'hybrid+expansion': (258, 440), 'hybrid-sessdiv': (439, 437), 'hybrid+rerank': (448, 451), 'hybrid-sessdiv+rerank': (449, 452)}
for k, (o, n) in wr.items():
    x = a['runner'][k]['all']
    check((x['old_strict'], x['new_strict']) == (o, n) and a['runner'][k]['rows'] == 470 and not a['runner'][k]['error_rows'], f'1a runner {k}: {x}')

check(b['arms']['direct']['correct'] == 304 and b['arms']['notes']['correct'] == 320, '1b correct counts')
check((b['paired']['all']['notes_wins'], b['paired']['all']['notes_losses']) == (25, 9), '1b paired')
check(b['gate']['passes'] is True, '1b gate')
check(not b['missing_responses'] and not b['judge_errors_counted_incorrect'] and b['reader_settled_calls'] == 722, '1b completeness')
check(len(b['arms']['notes']['cutoffs']) == 11 and b['arms']['notes']['correct_if_cutoffs_incorrect'] == 314, '1b cutoffs')

check(c['correct']['frontier_gbrain_judge'] == 447 and c['correct']['frontier_official_judge'] == 448, '2 correct counts')
check((c['paired']['vs_b_gbrain']['frontier_better'], c['paired']['vs_b_gbrain']['frontier_worse']) == (33, 16), '2 paired vs b')
check((c['paired']['vs_a_gbrain']['frontier_better'], c['paired']['vs_a_gbrain']['frontier_worse']) == (25, 17), '2 paired vs a')
check(c['rows_present'] == 500 and not c['reader_errors'] and c['tokens']['finish_reasons'] == {'stop': 500}, '2 completeness')

# post-hoc attribution: 40 development questions at the published code 885bb91a1, raw and opaque ids
import gzip
def hits(path):
    with gzip.open(path, 'rt') as f:
        rows = [json.loads(l) for l in f if l.strip()]
    return {r['question_id']: bool(r['recall_all_hit']) for r in rows if r.get('question_id')}
A = {k: hits(os.path.join(R, 'attribution', k, 'rows.ndjson.gz')) for k in ('raw-A1', 'raw-A3', 'opaque-A1', 'opaque-A3')}
check({k: (len(v), sum(v.values())) for k, v in A.items()} == {'raw-A1': (40, 36), 'raw-A3': (40, 24), 'opaque-A1': (40, 36), 'opaque-A3': (40, 25)}, 'attribution counts')
new_a3 = hits(os.path.join(R, '1a-harness', 'A3', 'rows.ndjson.gz'))
g = sum(1 for q in A['opaque-A3'] if new_a3[q] and not A['opaque-A3'][q]); l = sum(1 for q in A['opaque-A3'] if A['opaque-A3'][q] and not new_a3[q])
check((g, l) == (12, 1), f'attribution code effect {g}/{l}')
g = sum(1 for q in A['raw-A3'] if A['opaque-A3'][q] and not A['raw-A3'][q]); l = sum(1 for q in A['raw-A3'] if A['raw-A3'][q] and not A['opaque-A3'][q])
check((g, l) == (2, 1), f'attribution id effect {g}/{l}')

if fails:
    print('FAIL'); [print(' -', f) for f in fails]; sys.exit(1)
print('OK: 1a (12 harness replays/arms, 5 runner arms), 1b (361 pairs, gate passes), 2 (500 answers, two judges), attribution (40 questions) recount from committed receipts')
