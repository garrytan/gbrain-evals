import json,collections,re
W='/home/user/.capy/work/gbra162-flagcheck'
rows=[json.loads(l) for l in open(W+'/sweep/instr-deliveries.ndjson')]
agg=collections.defaultdict(lambda: collections.Counter())
for r in rows:
    m=re.search(r'eval/runner/([^ ]+)\.ts',r['argv']) or re.search(r'(src/cli\.ts[^ ]*)',r['argv'])
    k=m.group(1) if m else r['argv'][-80:]
    c=agg[k]; c['deliveries']+=1; c['with_conversation_results']+= r['conversation_results']>0; c['insertions']+= r['insertions'] or 0; c['deliveries_with_insertions']+= (r['insertions'] or 0)>0
    for f in r['fallbacks']: c[f]+=1
    c['unit_'+r['unit']]+=1
out={k:dict(v) for k,v in sorted(agg.items())}
json.dump(out,open(W+'/sweep/instr-summary.json','w'),indent=1)
print(len(rows)); print(json.dumps(out,indent=1))
