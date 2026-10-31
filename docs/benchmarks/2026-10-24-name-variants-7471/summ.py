#!/usr/bin/env python3
import json,sys,collections
def load(p): return [json.loads(l) for l in open(p)]
base, fix = load(sys.argv[1]), load(sys.argv[2])
def agg(rows):
  fam=collections.defaultdict(list)
  for r in rows: fam[r['family']].append(r['rank'])
  out={}
  for f,rs in fam.items():
    n=len(rs); out[f]=(n, sum(1 for x in rs if x==1)/n, sum(1 for x in rs if x and x<=5)/n, sum(1/x for x in rs if x)/n)
  allr=[r['rank'] for r in rows]; n=len(allr)
  out['ALL']=(n, sum(1 for x in allr if x==1)/n, sum(1 for x in allr if x and x<=5)/n, sum(1/x for x in allr if x)/n)
  return out
a,b=agg(base),agg(fix)
print('%-24s %4s  %-22s %-22s' % ('family','n','base hit@1/hit@5/MRR','fix hit@1/hit@5/MRR'))
for f in sorted(a):
  print('%-24s %4d  %.2f / %.2f / %.3f     %.2f / %.2f / %.3f' % (f, a[f][0], *a[f][1:], *b[f][1:]))
worse=[(x['query'],x['rank'],y['rank']) for x,y in zip(base,fix) if (y['rank'] or 99) > (x['rank'] or 99)]
better=[(x['query'],x['rank'],y['rank']) for x,y in zip(base,fix) if (y['rank'] or 99) < (x['rank'] or 99)]
print('worse:', worse)
print('better:', len(better), better[:6])
