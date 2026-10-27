"""Tables for the F2 frozen-hit step from M.jsonl and dev.jsonl (replay.ts output), then the pre-recorded rule."""
import json, statistics, collections
UNITS = ['chunk', 'window', 'section', 'page']
def q(v, p): v = sorted(v); return v[min(len(v) - 1, int(p * len(v)))] if v else 0
res = {}
for S in ('M', 'dev'):
    rows = [json.loads(l) for l in open(f'{S}.jsonl')]
    print(f'\n## {S}: {len({(r["cell"], r["call"]) for r in rows})} frozen calls, {len({(r["cell"], r["call"], r["slug"]) for r in rows})} (call, deciding page) pairs')
    rec = {}
    for r in rows:
        if r['cond'] == 'shared' and r['unit'] == 'chunk': rec[(r['cell'], r['call'], r['slug'])] = (r['recorded_has_sentence'], r['covered'])
    agree = sum(a == b for a, b in rec.values())
    print(f'- check: replayed chunk unit agrees with the recorded result on {agree}/{len(rec)} pairs (recorded has the sentence in {sum(a for a, b in rec.values())})')
    for cond in ('shared', 'isolated'):
        print(f'\n### {S}, {cond} budget (6,000 tokens)\n')
        print('| stratum | unit | pairs | deciding sentence delivered | delivered unit (as reported) | block chars median / p90 | call chars median / p90 | ms median |')
        print('|---|---|---|---|---|---|---|---|')
        for strat, f in (('long (>= 20k chars)', lambda r: r['doc_len'] >= 20000), ('short', lambda r: r['doc_len'] < 20000)):
            for u in UNITS:
                R = [r for r in rows if r['cond'] == cond and r['unit'] == u and f(r)]
                if not R: continue
                cov = sum(r['covered'] for r in R)
                du = collections.Counter(x for r in R for x in r['delivered_units'])
                print(f"| {strat} | {u} | {len(R)} | {cov}/{len(R)} ({100 * cov / len(R):.1f}%) | {dict(du)} | {statistics.median(r['block_chars'] for r in R):.0f} / {q([r['block_chars'] for r in R], .9)} | {statistics.median(r['call_chars'] for r in R):.0f} / {q([r['call_chars'] for r in R], .9)} | {statistics.median(r['ms'] for r in R):.0f} |")
                res[(S, cond, strat[:4], u)] = (cov, len(R), statistics.median(r['call_chars'] for r in R))
    L = [r for r in rows if r['cond'] == 'shared' and r['doc_len'] >= 20000 and r['unit'] == 'chunk']
    print(f"\n- long shared pairs from transcript-clipped hit lists: {sum(r['partial_hit_list'] for r in L)}; deciding page beyond the 50-hit cap: {sum(not r['in_hits'] for r in L)}")
    for u in UNITS:
        R = [r for r in rows if r['cond'] == 'shared' and r['unit'] == u and r['doc_len'] >= 20000 and not r['partial_hit_list']]
        print(f"- long shared, complete hit lists only, {u}: {sum(r['covered'] for r in R)}/{len(R)}")
    for u in UNITS:
        R = [r for r in rows if r['cond'] == 'shared' and r['unit'] == u and r['doc_len'] >= 20000]
        by = collections.Counter((r['model'].split('-')[1], r['covered']) for r in R)
        print(f"- long shared {u} by model (covered/total): " + ', '.join(f"{m} {by[(m, True)]}/{by[(m, True)] + by[(m, False)]}" for m in sorted({k[0] for k in by})))

print('\n## Rule (DECISION-RULE.md, recorded before these numbers)\n')
bar = 48 / 53
c_long, n_long, _ = res[('M', 'shared', 'long', 'chunk')]
c_short, n_short, _ = res[('M', 'shared', 'shor', 'chunk')]
elig = []
for u in ('window', 'section', 'page'):
    cl, nl, bytes_ = res[('M', 'shared', 'long', u)]; cs, ns, _ = res[('M', 'shared', 'shor', u)]
    beats_chunk = cl / nl > c_long / n_long; short_ok = cs / ns >= c_short / n_short; beats_bar = cl / nl > bar
    print(f'- {u}: long {cl}/{nl} ({100 * cl / nl:.1f}%) vs chunk {c_long}/{n_long} ({100 * c_long / n_long:.1f}%) -> beats chunk {beats_chunk}; short {cs}/{ns} vs chunk {c_short}/{n_short} -> not lower {short_ok}; selector bar > {100 * bar:.1f}% -> {beats_bar}; median call chars {bytes_:.0f}')
    if beats_chunk and short_ok and beats_bar: elig.append((cl / nl, bytes_, u))
if not elig: print('- PICK: none (no unit passes rules 1 and 2)')
else:
    best = max(e[0] for e in elig)
    near = sorted([e for e in elig if best - e[0] <= 0.02], key=lambda e: e[1])
    pick = near[0][2]
    print(f'- PICK: {pick} (eligible: {[e[2] for e in elig]}; within 2 points of the best: {[e[2] for e in near]})')
    dl, dn, _ = res[('dev', 'shared', 'long', pick)]; dcl, dcn, _ = res[('dev', 'shared', 'long', 'chunk')]
    print(f'- dev check (rule 5): {pick} {dl}/{dn} vs chunk {dcl}/{dcn} on dev long pairs -> ' + ('no contradiction' if dl / dn >= dcl / dcn else ('contradicts' if dn >= 5 else 'too few to veto')))
