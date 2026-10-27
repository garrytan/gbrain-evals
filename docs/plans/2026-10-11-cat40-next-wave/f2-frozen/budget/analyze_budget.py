"""Coverage and payload tables plus the pre-recorded rule (DECISION-RULE.md), from M_all.jsonl and dev_all.jsonl."""
import json, os, collections, statistics
X, X_STRICT, BAR = 0.25, 0.164, 48 / 53
U = ['window', 'section', 'page']
res = {}
for S in ('M', 'dev'):
    if not os.path.exists(f'{S}_all.jsonl'): continue
    R = [json.loads(l) for l in open(f'{S}_all.jsonl')]
    live = [r for r in R if not r.get('empty')]
    print(f"\n## {S}: {len(R)} recorded agent search/query calls ({len(R) - len(live)} with no replayable hit); calls with a long non-conversation hit: {sum(r['has_long'] for r in live)}")
    print(f"- paths: {dict(collections.Counter(r['path'] for r in R))}; long-hit calls by path: {dict(collections.Counter(r['path'] for r in live if r['has_long']))}")
    pairs = [(r, slug) for r in live if r.get('covered', {}).get('chunk') for slug in r['covered']['chunk']]
    print(f'\n| variant | long covered | short covered | short lost vs chunk | payload rise H2-H4 (pooled) | payload rise all families | cells H2-H4 with rise > 25% |')
    print('|---|---|---|---|---|---|---|')
    for v in ['chunk', 'today'] + U:
        L = [r['covered'][v][s]['covered'] for r, s in pairs if r['covered'][v][s]['long']]
        Sh = [(r['covered'][v][s]['covered'], r['covered']['chunk'][s]['covered']) for r, s in pairs if not r['covered'][v][s]['long']]
        lost = sum(1 for a, c in Sh if c and not a)
        def rise(fams):
            calls = [r for r in R if r['family'] in fams]
            base = sum(r['recorded_chars'] for r in calls)
            add = sum(r['chars'].get(v, r['chars'].get('today', 0)) - r['chars'].get('today', 0) for r in calls if not r.get('empty')) if v not in ('chunk', 'today') else 0
            return add / base if base else 0
        cells = collections.defaultdict(lambda: [0, 0])
        if v in U:
            for r in R:
                if r['family'] in ('H2', 'H3', 'H4'):
                    cells[r['cell']][0] += r['recorded_chars']
                    if not r.get('empty'): cells[r['cell']][1] += r['chars'][v] - r['chars']['today']
        over = sum(1 for b, a in cells.values() if b and a / b > X)
        r24 = rise({'H2', 'H3', 'H4'}); rall = rise({'H1', 'H2', 'H3', 'H4', 'H5'})
        print(f"| {v} | {sum(L)}/{len(L)} ({100 * sum(L) / len(L):.1f}%) | {sum(a for a, c in Sh)}/{len(Sh)} | {lost} | {'-' if v in ('chunk', 'today') else f'{100 * r24:+.1f}%'} | {'-' if v in ('chunk', 'today') else f'{100 * rall:+.1f}%'} | {over if v in U else '-'}{'/' + str(len(cells)) if v in U else ''} |")
        res[(S, v)] = dict(lc=sum(L), nl=len(L), lost=lost, rise=r24)
    for v in U:
        byp = collections.Counter((r['path'], r['covered'][v][s]['covered']) for r, s in pairs if r['covered'][v][s]['long'])
        print(f"- {v}: long covered by path: " + ', '.join(f"{p} {byp[(p, True)]}/{byp[(p, True)] + byp[(p, False)]}" for p in sorted({k[0] for k in byp})))
print('\n## Rule (recorded before these numbers)\n')
if ('M', 'chunk') in res:
    c = res[('M', 'chunk')]; ok = []
    for v in U:
        x = res[('M', v)]
        b = [x['lc'] / x['nl'] > c['lc'] / c['nl'], x['lost'] == 0, x['lc'] / x['nl'] > BAR, x['rise'] <= X]
        print(f"- {v}: long {x['lc']}/{x['nl']} > chunk {c['lc']}/{c['nl']}: {b[0]}; short lost {x['lost']}: {b[1]}; > 90.6%: {b[2]}; payload {100 * x['rise']:+.1f}% <= 25%: {b[3]} (strict 16.4% sensitivity: {x['rise'] <= X_STRICT})")
        if all(b): ok.append(v)
    if not ok: print('- PICK: none')
    else:
        best = max(res[('M', v)]['lc'] / res[('M', v)]['nl'] for v in ok)
        pick = sorted([v for v in ok if best - res[('M', v)]['lc'] / res[('M', v)]['nl'] <= 0.02], key=lambda v: res[('M', v)]['rise'])[0]
        print(f'- PICK: {pick} (passing: {ok})')
        if ('dev', pick) in res:
            d, dc = res[('dev', pick)], res[('dev', 'chunk')]
            okd = d['lc'] / d['nl'] >= dc['lc'] / dc['nl'] and d['lost'] == 0 and d['rise'] <= X
            print(f"- dev check: long {d['lc']}/{d['nl']} vs chunk {dc['lc']}/{dc['nl']}, short lost {d['lost']}, payload {100 * d['rise']:+.1f}% -> {'no contradiction' if okd else 'VETO'}")
