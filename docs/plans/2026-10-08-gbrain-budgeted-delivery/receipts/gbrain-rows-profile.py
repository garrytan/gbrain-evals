# Profile of the gbrain-shootout (frozen master) rows: items, tokens per item, estimated 8k pack, native vs rehydrated flips.
# Usage, from a checkout of gbrain-evals at 9c07b7e2 (branch capy/oss-memory-shootout):
#   python3 gbrain-rows-profile.py [results-dir]
import json,gzip,glob,os,collections,statistics as st,sys
R=sys.argv[1] if len(sys.argv)>1 else 'docs/benchmarks/2026-10-06-oss-memory-shootout/results'
def rows(cell,arm):
  out=[]
  for f in sorted(glob.glob(f'{R}/{cell}*/*/**/arms/{arm}/rows.ndjson.gz',recursive=True)):
    out+= [json.loads(l) for l in gzip.open(f)]
  return {r['id']:r for r in out}
for bench in ['lme-s','locomo-r1','beam-100k']:
  c=f'gbrain-shootout-master-common-{bench}'
  N=rows(c,'fixed-evidence.native.b8000.main'); H=rows(c,'fixed-evidence.rehydrated.b8000.main'); V=rows(c,'vendor-default.native.bnone.main'); VR=rows(c,'vendor-default.rehydrated.bnone.main')
  tpi=[V[k]['qa_context_tokens']/V[k]['items_returned'] for k in V if V[k]['items_returned']]
  packed=[N[k]['qa_context_tokens']/(V[k]['qa_context_tokens']/V[k]['items_returned']) for k in N if k in V and V[k]['items_returned']]
  frac=[p/N[k]['items_returned'] for p,k in zip(packed,[k for k in N if k in V and V[k]['items_returned']])]
  lr=collections.Counter(len(r['retrieved']) for r in N.values())
  print(f'== {bench} n={len(N)} items_returned mean {st.mean(r["items_returned"] for r in N.values()):.1f} min {min(r["items_returned"] for r in N.values())} max {max(r["items_returned"] for r in N.values())}; vd native tokens/item mean {st.mean(tpi):.0f} median {st.median(tpi):.0f}; est items packed at 8k {st.mean(packed):.1f} ({100*st.mean(frac):.0f}% of returned); retrieved-list lengths {dict(lr)}')
  print(f'   rehydrated 8k tokens mean {st.mean(r["qa_context_tokens"] for r in H.values()):.0f}; vd rehydrated tokens {st.mean(r["qa_context_tokens"] for r in VR.values()):.0f}; vd retrieval latency p50 {st.median(r["latency_ms"] for r in V.values()):.0f} ms; retrieval usd/q {st.mean(r["provider"]["usd"] for r in N.values()):.5f}')
  # flips
  both=[k for k in N if k in H and N[k]['outcome']=='scored' and H[k]['outcome']=='scored']
  w=sum(1 for k in both if H[k]['qa_score']>N[k]['qa_score']); l=sum(1 for k in both if H[k]['qa_score']<N[k]['qa_score'])
  wr=sum(1 for k in both if H[k]['qa_score']>N[k]['qa_score'] and N[k].get('recall_all_at_5')==1)
  print(f'   rehydrated vs native 8k: +{w}/-{l}; of the wins, {wr} have recall_all@5 = 1')
  cat=collections.defaultdict(lambda:[0,0,0,0])
  for k in both:
    c_=N[k]['category']; cat[c_][0]+=1; cat[c_][1]+=N[k]['qa_score']; cat[c_][2]+=H[k]['qa_score']; cat[c_][3]+= (N[k].get('recall_all_at_5') or 0)
  for c_,(n,a,b,r) in sorted(cat.items()): print(f'     {c_:28} n={n:3} native={a:5.1f} rehyd={b:5.1f} r@5={r}')
