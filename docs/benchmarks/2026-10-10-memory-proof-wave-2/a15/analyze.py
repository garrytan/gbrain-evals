#!/usr/bin/env python3
"""analyze.py <out.ndjson>... : A15 report (would-skip by reason and kind, rank-1, context change vs noise, A58 overlap)."""
import collections, json, sys

rows = [json.loads(l) for f in sys.argv[1:] for l in open(f) if l.strip()]


def keyset(arm, field='key'):
    return {b[field] for b in arm['blocks']}


def overlap(a, b, field='key'):
    total = sum(x['tokens'] for x in a['blocks'])
    keys = keyset(b, field)
    return (sum(x['tokens'] for x in a['blocks'] if x[field] in keys) / total) if total else 1.0


def rank1(arm):
    return arm['blocks'][0]['page'] if arm['blocks'] else None


def pct(n, d):
    return f"{n}/{d} ({100 * n / d:.1f}%)" if d else f"{n}/0"


def report(name, rs):
    ok = [r for r in rs if not r.get('error')]
    print(f"\n== {name}: {len(rs)} questions, {len(rs) - len(ok)} errors")
    if not ok:
        return
    g = [r['shadow']['gate'] or {} for r in ok]
    elig = [r for r, x in zip(ok, g) if x.get('eligible')]
    ws = [r for r in ok if (r['shadow']['gate'] or {}).get('would_skip')]
    print(f"eligible: {pct(len(elig), len(ok))}; would-skip: {pct(len(ws), len(ok))}")
    print("grade/reason:", dict(collections.Counter(f"{x.get('grade')}:{x.get('reason')}" for x in g)))
    blocked = collections.Counter(x.get('skip_blocked') for x in g if x.get('skip_blocked'))
    if blocked:
        print("strong but blocked:", dict(blocked))
    cos = sorted(x.get('top_cosine') for x in g if x.get('top_cosine') is not None)
    if cos:
        print(f"top_cosine: min {cos[0]:.3f} p50 {cos[len(cos) // 2]:.3f} p90 {cos[int(len(cos) * 0.9)]:.3f} max {cos[-1]:.3f}")
    kinds = collections.defaultdict(lambda: [0, 0])
    for r in ok:
        kinds[r['kind']][1] += 1
        kinds[r['kind']][0] += bool((r['shadow']['gate'] or {}).get('would_skip'))
    print("would-skip by kind:", {k: f"{a}/{b}" for k, (a, b) in sorted(kinds.items())})
    skipped_on = sum(bool((r['on']['gate'] or {}).get('skipped')) for r in ok)
    print(f"on arm skipped: {skipped_on} (would-skip {len(ws)})")
    agree = sum(rank1(r['fused']) == rank1(r['shadow']) for r in ok)
    print(f"rank-1 fused == reranked: {pct(agree, len(ok))}" + (f"; on would-skip: {pct(sum(rank1(r['fused']) == rank1(r['shadow']) for r in ws), len(ws))}" if ws else ""))
    noise = sum(keyset(r['shadow']) != keyset(r['shadow2']) for r in ok)
    print(f"context change, shadow vs shadow (noise): {pct(noise, len(ok))}; mean overlap {sum(overlap(r['shadow'], r['shadow2']) for r in ok) / len(ok):.3f}")
    fused_change = sum(keyset(r['shadow']) != keyset(r['fused']) for r in ok)
    print(f"context change, reranked vs no reranker (all questions): {pct(fused_change, len(ok))}; mean token overlap {sum(overlap(r['shadow'], r['fused']) for r in ok) / len(ok):.3f} (page-level {sum(overlap(r['shadow'], r['fused'], 'page') for r in ok) / len(ok):.3f})")
    if ws:
        ch = sum(keyset(r['shadow']) != keyset(r['on']) for r in ws)
        ov = [overlap(r['shadow'], r['on']) for r in ws]
        ovp = [overlap(r['shadow'], r['on'], 'page') for r in ws]
        print(f"A58 on would-skip: context change {pct(ch, len(ws))}; token-weighted overlap mean {sum(ov) / len(ov):.3f} min {min(ov):.3f} (page-level mean {sum(ovp) / len(ovp):.3f})")
    ms = lambda a: sorted(r[a]['ms'] for r in ok)
    for a in ('shadow2', 'on', 'fused'):
        m = ms(a)
        print(f"  {a} query ms: p50 {m[len(m) // 2]} mean {sum(m) / len(m):.0f}")


by = collections.defaultdict(list)
for r in rows:
    by[r['dataset']].append(r)
for d, rs in sorted(by.items()):
    report(d, rs)
beam = [r for d, rs in by.items() if d.startswith('beam') for r in rs]
if beam:
    report('BEAM pooled', beam)
report('pooled', rows)
