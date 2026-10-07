import json,collections,re
w=json.load(open('eval/reports/cat40/hard-holdout/50k/world.json'))
docs={d['id']:d for d in w['docs']}; tasks={t['id']:t for t in w['tasks']}
R=[json.loads(l) for l in open('eval/reports/cat40/hard/cells-50k/results.jsonl')]
R=[r for r in R if r['model']!='claude-fable-5-1']
def norm(s): return re.sub(r'[^0-9a-z$]','',str(s).lower())
cause=collections.defaultdict(collections.Counter)
for r in R:
    t=tasks[r['task']]
    if t['answer_kind']!='values' or t['family'] not in ('H2','H4'): continue
    fin=(r['run'].get('final') or {}).get('answer')
    try: ans=json.loads(fin) if isinstance(fin,str) else fin
    except Exception: cause[r['arm']]['unparseable']+=1; continue
    if not isinstance(ans,list): cause[r['arm']]['unparseable']+=1; continue
    qdates=re.findall(r'on (\d{4}-\d{2}-\d{2})', t['question'])
    for i,it in enumerate(t['gold']['items']):
        a=ans[i] if i<len(ans) else None
        if a is None: cause[r['arm']]['missing']+=1; continue
        if norm(a) in [norm(x) for x in it['answer']]: cause[r['arm']]['right']+=1; continue
        if norm(a) not in [norm(x) for x in it['wrong']]: cause[r['arm']]['other-wrong']+=1; continue
        # find doc stating this wrong value
        hits=[d for d in docs.values() if str(a).replace(',','') in d['body'].replace(',','')]
        q=qdates[i] if i<len(qdates) else None
        lab='superseded/other'
        for d in hits:
            m=re.search(r'Effective (\d{4}-\d{2}-\d{2})',d['body']); sm=re.search(r'Signed by both parties on ([A-Za-z]+ \d+, \d{4})',d['body'])
            if d['type']=='agent-note': lab='agent-note value'; break
            if m and q and m.group(1)>q and d['date']<=q: lab='not yet effective on date (signed before, effective after)'; break
            if m and q and m.group(1)<=q and d['date']>q: lab='backdated: signed after date'; 
        cause[r['arm']][lab]+=1
for a in cause: print(a, dict(cause[a]))

print('--- detail of superseded/other for gbrain')
refs=collections.defaultdict(set)
for r in w['references']: refs[r['doc']].add(r['entity'])
ents={e['id']:e for e in w['entities']}
def doc_accounts(d):
    s=set(refs.get(d['id'],()))
    for e in ents.values():
        if e.get('name') and e['name'] in d['body']: s.add(e['id'])
    return s
det=collections.Counter()
for r in R:
    t=tasks[r['task']]
    if r['arm']!='gbrain-hard' or t['answer_kind']!='values' or t['family'] not in ('H2','H4'): continue
    fin=(r['run'].get('final') or {}).get('answer')
    try: ans=json.loads(fin)
    except Exception: continue
    if not isinstance(ans,list): continue
    for i,it in enumerate(t['gold']['items']):
        a=ans[i] if i<len(ans) else None
        if a is None or norm(a) in [norm(x) for x in it['answer']] or norm(a) not in [norm(x) for x in it['wrong']]: continue
        hits=[d for d in docs.values() if str(a).replace(',','') in d['body'].replace(',','') and d['type']!='agent-note']
        if not hits: continue
        same=[d for d in hits if it['account'] in doc_accounts(d)]
        if same:
            types=sorted({d['type'] for d in same}); det[('same account', t['family'], tuple(types))]+=1
        else: det[('other account', t['family'])]+=1
for k,v in det.most_common(): print(k,v)
