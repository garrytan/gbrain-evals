"""Tables and the pre-recorded rule (DECISION-RULE.md) for the scoped-policy replay."""
import json, statistics, collections
V = ['chunk', 'today'] + [f'scoped-{u}{c}' for u in ('window', 'section', 'page') for c in ('', '+cap')]
def key(r): return (r['cell'], r['call'], r['slug'])
out = {}
for S in ('M', 'dev'):
    rows = [json.loads(l) for l in open(f'{S}.jsonl')]
    iso = {key(r): r['covered'] for r in map(json.loads, open(f'../{S}.jsonl')) if r['cond'] == 'isolated' and r['unit'] == 'page'}
    for B in (6000, 24000):
        R = {v: {key(r): r for r in rows if r['variant'] == v and (r['B'] == B or v == 'chunk')} for v in V}
        chunk = R['chunk']
        n_long = sum(1 for r in chunk.values() if r['doc_len'] >= 20000); n_short = len(chunk) - n_long
        print(f'\n## {S}, B = {B:,} tokens ({len(chunk)} pairs: {n_long} long, {n_short} short)\n')
        print('| variant | long covered | short covered | short pairs lost vs chunk | crowd-out | deciding long block: widened / spilled to chunk | median chars per call (long calls) | median deciding-block chars (long) | median ms |')
        print('|---|---|---|---|---|---|---|---|---|')
        for v in V:
            P = R[v]
            L = [r for r in P.values() if r['doc_len'] >= 20000]; Sh = [r for r in P.values() if r['doc_len'] < 20000]
            lost = sum(1 for k, r in P.items() if r['doc_len'] < 20000 and chunk[k]['covered'] and not r['covered'])
            crowd = sum(1 for r in L if not r['covered'] and iso.get(key(r)) and r['earlier_widened'] > 0)
            wid = sum(1 for r in L if any(not d.startswith('chunk') and d != 'none' for d in r['delivered']))
            spill = sum(1 for r in L if any('over_budget' in d for d in r['delivered']))
            lc = sum(r['covered'] for r in L); sc = sum(r['covered'] for r in Sh)
            print(f"| {v} | {lc}/{len(L)} ({100 * lc / len(L):.1f}%) | {sc}/{len(Sh)} | {lost} | {crowd if v.startswith('scoped') else '-'} | {wid} / {spill} | {statistics.median(r['call_chars'] for r in L):.0f} | {statistics.median(r['block_chars'] for r in L):.0f} | {statistics.median(r['ms'] for r in P.values()):.0f} |")
            out[(S, B, v)] = dict(lc=lc, nl=len(L), lost=lost, chars=statistics.median(r['call_chars'] for r in L), crowd=crowd)
        if B == 6000:
            for v in ('scoped-page', 'scoped-section', 'scoped-window', 'scoped-page+cap'):
                L = [r for r in R[v].values() if r['doc_len'] >= 20000 and not r['covered']]
                why = collections.Counter(('earlier long page widened' if r['earlier_widened'] else 'earlier long page, not widened' if r['earlier_long'] else 'no earlier long page') + (', isolated covers it' if iso.get(key(r)) else ', isolated misses it') for r in L)
                print(f'- {v}: uncovered long pairs by cause: {dict(why)}')
            for v in ('scoped-page', 'scoped-page+cap'):
                L = [r for r in R[v].values() if r['doc_len'] >= 20000]
                by = collections.Counter((r['model'].split('-')[1], r['covered']) for r in L)
                print(f"- {v} long by model: " + ', '.join(f"{m} {by[(m, True)]}/{by[(m, True)] + by[(m, False)]}" for m in sorted({k[0] for k in by})))
            L = [r for r in R['scoped-page'].values() if r['doc_len'] >= 20000]
            print(f"- long pairs with an earlier-ranked long page in the hit list: {sum(1 for r in L if r['earlier_long'])}; from transcript-clipped hit lists: {sum(r['partial_hit_list'] for r in L)}")

print('\n## Rule (recorded before these numbers; M, B = 6,000)\n')
bar = 48 / 53
def passes(S, v):
    c, x = out[(S, 6000, 'chunk')], out[(S, 6000, v)]
    return x['lc'] / x['nl'] > c['lc'] / c['nl'], x['lost'] == 0, x['lc'] / x['nl'] > bar
res = {}
for v in V[2:]:
    b1, b2, b3 = passes('M', v); res[v] = b1 and b2 and b3
    x = out[('M', 6000, v)]
    print(f"- {v}: long {x['lc']}/{x['nl']} ({100 * x['lc'] / x['nl']:.1f}%) beats chunk {b1}; short lost {x['lost']} -> {b2}; > 90.6% {b3}; median chars per long call {x['chars']:.0f}")
unguarded = [v for v in V[2:] if res[v] and '+cap' not in v]; guarded = [v for v in V[2:] if res[v] and '+cap' in v]
pool = unguarded or guarded
if not pool: print('- PICK: none')
else:
    best = max(out[('M', 6000, v)]['lc'] / out[('M', 6000, v)]['nl'] for v in pool)
    near = sorted([v for v in pool if best - out[('M', 6000, v)]['lc'] / out[('M', 6000, v)]['nl'] <= 0.02], key=lambda v: out[('M', 6000, v)]['chars'])
    pick = near[0]
    print(f"- PICK: {pick} (passing unguarded {unguarded}, passing guarded {guarded}; within 2 points: {near})")
    d, dc = out[('dev', 6000, pick)], out[('dev', 6000, 'chunk')]
    ok = d['lc'] / d['nl'] >= dc['lc'] / dc['nl'] and d['lost'] == 0
    print(f"- dev check: {pick} long {d['lc']}/{d['nl']} vs chunk {dc['lc']}/{dc['nl']}, short lost {d['lost']} -> {'no contradiction' if ok else ('VETO' if d['nl'] >= 5 else 'too few to veto')}")
