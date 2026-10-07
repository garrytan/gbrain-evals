import json,collections,re
w=json.load(open('eval/reports/cat40/hard-holdout/50k/world.json'))
docs={d['id']:d for d in w['docs']}; tasks={t['id']:t for t in w['tasks']}
R={}
for l in open('eval/reports/cat40/hard/cells-50k/results.jsonl'):
    r=json.loads(l)
    if r['model']!='claude-fable-5-1': R[(r['model'],r['arm'],r['task'])]=r
T={}
for l in open('eval/reports/cat40/hard/cells-50k/transcripts.jsonl'):
    t=json.loads(l); T[t['key']]=t
def norm(s): return re.sub(r'[^0-9a-z$]','',str(s).lower())
agentvals=set()
for d in docs.values():
    if d['type']=='agent-note':
        for m in re.findall(r'(\$[\d,]+|\b\d{2,5}\b)',d['body']): agentvals.add(norm(m))
cause=collections.Counter(); won=collections.Counter(); tc_calls=[]
for (m,a,t),r in R.items():
    if a!='gbrain-hard': continue
    f=R[(m,'fs',t)]; g=r['score']['success']; fs=f['score']['success']
    if g and not fs: won[(t[:2], f['run']['stop'])]+=1
    if fs and not g:
        fam=t[:2]
        if r['run']['stop']=='turn_cap':
            k=T.get(r['key'],{'tools':[]}); n=collections.Counter(x['name'] for x in k['tools'])
            cause[(fam,'ran out of turns')]+=1; tc_calls.append(dict(n))
        else:
            task=tasks[t]; fin=(r['run'].get('final') or {}).get('answer')
            lab='wrong: other'
            try:
                ans=json.loads(fin) if task['answer_kind']=='values' else None
            except Exception: ans=None
            if isinstance(ans,list):
                labs=[]
                for i,it in enumerate(task['gold']['items']):
                    x=ans[i] if i<len(ans) else None
                    if x is None or norm(x) in [norm(y) for y in it['answer']]: continue
                    hits=[d for d in docs.values() if str(x).replace(',','') in d['body'].replace(',','')]
                    if any(d['type']=='agent-note' for d in hits) and not any(d['type']!='agent-note' and d['type'] in('amendment','contract','email') for d in hits): labs.append('agent-note value')
                    elif hits: labs.append('superseded or earlier value')
                    else: labs.append('value in no document')
                lab='wrong: '+(labs[0] if labs else 'other')
            elif fam=='H1': lab='wrong: incomplete set'
            elif fam=='H5': lab='wrong: memory recall'
            cause[(fam,lab)]+=1
n=300
print('lost cells (fs right, gbrain wrong):', sum(cause.values()), 'won cells:', sum(won.values()))
agg=collections.Counter()
for (fam,lab),v in cause.items(): agg[lab]+=v
for lab,v in agg.most_common(): print(f'{lab:32s} {v:3d} cells = {100*v/n:.1f} pts')
for k,v in sorted(cause.items()): print('  ',k,v)
print('won by family/fs stop', dict(won))
import statistics
print('turn-cap losses: mean search calls', statistics.mean(c.get('search',0) for c in tc_calls), 'get_page', statistics.mean(c.get('get_page',0) for c in tc_calls), 'remember', statistics.mean(c.get('remember',0) for c in tc_calls))
