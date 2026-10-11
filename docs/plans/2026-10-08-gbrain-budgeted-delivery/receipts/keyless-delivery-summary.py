import json,sys,statistics as st
d=json.load(open(sys.argv[1]))
ans=[r for r in d if r['gold']>0]
def m(xs): xs=list(xs); return st.mean(xs) if xs else float('nan')
print('n',len(d),'answerable',len(ans))
A=[r['A'] for r in d]
print(f"A shootout chunks: returned {m(a['items'] for a in A):.1f} items, {m(a['gbrain_ret_tokens'] for a in A):.0f} harness tokens, packed {m(a['packed'] for a in A):.1f} items/{m(a['tokens'] for a in A):.0f} tok, sessions packed {m(a['sessions'] for a in A):.1f} of {m(a['sessions_returned'] for a in A):.1f} returned; all-gold-in-context {100*m(r['A']['all_gold'] for r in ans):.1f}%")
print(f"D rehydrated 8k: sessions {m(r['D']['sessions'] for r in d):.1f}, tok {m(r['D']['tokens'] for r in d):.0f}, all-gold {100*m(r['D']['all_gold'] for r in ans):.1f}%")
for k in ['auto8k_l25','auto24k_l25','auto8k_l5']:
  X=[r[k] for r in d]
  over=sum(1 for x in X if x['budget_used']>x['budget'])
  print(f"{k}: hits {m(x['hits'] for x in X):.1f} blocks {m(x['blocks'] for x in X):.1f} pages {m(x['pages'] for x in X):.1f} whole {m(x['whole_pages'] for x in X):.1f} spilled {m(x['spilled'] for x in X):.1f}; budget_used mean {m(x['budget_used'] for x in X):.0f} max {max(x['budget_used'] for x in X)} over-budget {over}/{len(X)}; harness tokens all {m(x['harness_tokens_all'] for x in X):.0f}; packed@8k blocks {m(x['harness_packed_blocks'] for x in X):.1f} tok {m(x['harness_packed_tokens'] for x in X):.0f}; all-gold delivered {100*m(r[k]['all_gold_delivered'] for r in ans):.1f}% packed@8k {100*m(r[k]['all_gold_packed8k'] for r in ans):.1f}%; gold whole pages/q {m(r[k]['gold_whole_pages'] for r in ans):.2f}")
