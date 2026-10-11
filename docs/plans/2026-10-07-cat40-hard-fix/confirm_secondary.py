# Confirmation secondary measures (PREREG "Secondary"), one world per run. Prints counts and rates only, never task or document text.
# Usage: python3 confirm_secondary.py <world.json | -> <cells dir with attempts.jsonl and transcripts.jsonl>  ("-" skips the DX measures, which need the world)
import json,collections,re,statistics,sys
cells=sys.argv[2]
R={}
for l in open(cells+'/attempts.jsonl'):
    r=json.loads(l)
    if r['stop']!='harness_error': R[r['key']]=r
T={}
for l in open(cells+'/transcripts.jsonl'):
    t=json.loads(l)
    if t['key'] in R and t['attempt_id']==R[t['key']]['attempt_id']: T[t['key']]=t
print('canonical cells',len(R),'with transcripts',len(T))
models=['claude-sonnet-5-5','claude-opus-5-5','gpt-6.1-sol']; arms=['gbrain-hard','fs']
def args(x): return x['args'] if isinstance(x['args'],str) else json.dumps(x['args'])
# 1. wrong answers: submitted cells whose answer asserts a wrong value (score.said_wrong), share of all cells
print('\n| Model | Arm | wrong answers | submitted | turn_cap | context_overflow | error |')
for m in models+['all']:
    for a in arms:
        rs=[r for r in R.values() if r['arm']==a and (m=='all' or r['model']==m)]
        s=collections.Counter(r['stop'] for r in rs)
        print(f"| {m} | {a} | {sum(bool(r['score'].get('said_wrong')) for r in rs)}/{len(rs)} | {s['submitted']} | {s['turn_cap']} | {s['context_overflow']} | {s['error']} |")
# 2. median seconds per cell (agent time, and wall time including restore and judge)
print('\n| Model | Arm | agent p50 s | wall p50 s |')
for m in models:
    for a in arms:
        rs=[r for r in R.values() if r['arm']==a and r['model']==m]
        print(f"| {m} | {a} | {statistics.median(r['timings']['agent_ms'] for r in rs)/1000:.1f} | {statistics.median(r['wall_ms'] for r in rs)/1000:.1f} |")
# 3. rerank check: gbrain cells with a hybrid search (a search call without match "keyword") show voyage:rerank-2.5 in metering;
#    rerank degradation is a degraded_recall or rerank_failed marker in a tool result
hyb=0; rr=0; notices=collections.Counter(); cells_deg=0
for k,r in R.items():
    if r['arm']!='gbrain-hard': continue
    tl=T.get(k,{'tools':[]})['tools']
    h=any(x['name']=='search' and 'keyword' not in args(x) for x in tl)
    if h:
        hyb+=1; rr+=(r.get('gbrain_internal') or {}).get('byModel',{}).get('voyage:rerank-2.5',{}).get('requests',0)>0
    deg=False
    for x in tl:
        res=x['result'] or ''
        for c in set(re.findall(r'\[gbrain notice ([a-z_]+)',res)): notices[c]+=1
        if 'degraded_recall' in res or 'rerank_failed' in res: deg=True
    cells_deg+=deg
print(f'\nrerank: {rr} of {hyb} gbrain cells with a hybrid search show voyage:rerank-2.5 in metering; cells with a rerank degradation marker: {cells_deg}; notices on tool results: {dict(notices)}')
# 4. DX: nickname seen (in a result) and queried (in an argument), H2-H4, first four accounts per task (rca4.py method);
#    tool calls from the question to the first alias query (nickname or account code of a task account, word match), H2-H4 cells
if sys.argv[1]=='-': sys.exit()
w=json.load(open(sys.argv[1])); ents={e['id']:e for e in w['entities']}; tasks={t['id']:t for t in w['tasks']}
if not all((e.get('refs') or {}).get('nicknames') is not None for e in ents.values()):
    print('\nDX: world has no nickname refs'); sys.exit()
seen=collections.Counter(); qry=collections.Counter(); n=collections.Counter(); first=collections.defaultdict(list); nq=collections.Counter(); nc=collections.Counter()
for k,r in R.items():
    t=tasks[r['task']]
    if t['family'] not in ('H2','H3','H4'): continue
    tl=T[k]['tools']; res=' '.join((x['result'] or '') for x in tl).lower(); arg=' '.join(args(x) for x in tl).lower()
    for acc in t['accounts'][:4]:
        nick=[z.lower() for z in ents[acc]['refs']['nicknames']]
        if not nick: continue
        n[r['arm']]+=1; seen[r['arm']]+=any(z in res for z in nick); qry[r['arm']]+=any(z in arg for z in nick)
    al=[z.lower() for acc in t['accounts'] for z in ents[acc]['refs']['nicknames']+ents[acc]['refs']['codes']]
    pat=re.compile(r'(?<![0-9a-z])('+'|'.join(re.escape(z) for z in al)+r')(?![0-9a-z])') if al else None
    nc[r['arm']]+=1
    i=next((i for i,x in enumerate(tl,1) if pat and pat.search(args(x).lower())),None)
    if i: first[r['arm']].append(i); nq[r['arm']]+=1
print('\n| Arm | nickname seen | nickname queried | account-cells | cells with an alias query | tool calls to first alias query (median, p75) |')
for a in arms:
    f=sorted(first[a]); p75=f[int(0.75*(len(f)-1))] if f else None
    print(f"| {a} | {100*seen[a]/n[a]:.0f}% | {100*qry[a]/n[a]:.0f}% | {n[a]} | {nq[a]}/{nc[a]} | {statistics.median(f) if f else 'n/a'}, {p75} |")
