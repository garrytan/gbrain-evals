
import json, os, sys, re
W='/home/user/.capy/work/gbra162-flagcheck'
def receipts(arm):
    root=f'{W}/evals-{arm}/eval/reports'; out={}
    for dp,dn,fn in os.walk(root):
        for f in fn:
            if f.endswith('.json') and os.path.getmtime(os.path.join(dp,f))>__import__('time').time()-4*3600:
                out[re.sub(r'sweep-[0-9a-f-]{36}','sweep-X',os.path.relpath(os.path.join(dp,f),root))]=os.path.join(dp,f)
    return out
a,b=receipts('off'),receipts('on')
print('off files',len(a),'on files',len(b))
print('only off', sorted(set(a)-set(b))[:20]); print('only on', sorted(set(b)-set(a))[:20])
def flat(x,p=''):
    if isinstance(x,dict):
        for k,v in x.items(): yield from flat(v,f'{p}.{k}' if p else k)
    elif isinstance(x,list):
        for i,v in enumerate(x): yield from flat(v,f'{p}[{i}]')
    else: yield p,x
NOISE=re.compile(r'(time|_at$|\.at$|date|duration|_ms|ms$|latency|elapsed|seconds|_s$|p50|p95|p99|mean_ms|wall|started|finished|ended|pid|run_id|uuid|tmp|/tmp|path|dir$|hostname|commit|sha|hash|tree|version|loaded_git_head|ref$|requested|cpu|memory|rss|heap|throughput|per_sec|qps|nonce|seed_dir)',re.I)
summary={}
for k in sorted(set(a)&set(b)):
    try: A=dict(flat(json.load(open(a[k])))); B=dict(flat(json.load(open(b[k]))))
    except Exception as e: summary[k]={'error':str(e)}; continue
    diffs=[]; noise=0; noisekeys=set()
    for key in sorted(set(A)|set(B)):
        if A.get(key)!=B.get(key):
            if NOISE.search(key) or (isinstance(A.get(key),str) and re.search(r'/home/user|\d{4}-\d\d-\d\dT',str(A.get(key)))): noise+=1; noisekeys.add(re.sub(r'\[\d+\]','[]',key)); continue
            diffs.append((key,A.get(key),B.get(key)))
    summary[k]={'leaves':len(A),'noise_diffs':noise,'real_diffs':len(diffs),'noise_keys':sorted(noisekeys)[:60],'examples':[(d[0],str(d[1])[:120],str(d[2])[:120]) for d in diffs[:12]]}
json.dump(summary,open(f'{W}/sweep/receipt-diff.json','w'),indent=1)
for k,v in summary.items():
    if v.get('real_diffs') or v.get('error'): print(k, json.dumps(v)[:1500])
print('files compared',len(summary),'with real diffs',sum(1 for v in summary.values() if v.get('real_diffs')))
