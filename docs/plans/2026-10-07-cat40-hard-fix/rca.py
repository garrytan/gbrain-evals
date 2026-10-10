import json,collections,re
w=json.load(open('eval/reports/cat40/hard-holdout/50k/world.json'))
form=collections.defaultdict(set)
for r in w['references']: form[r['doc']].add(r['form'])
docs={d['id']:d for d in w['docs']}
ents={e['id']:e for e in w['entities']}
R={};T={}
for l in open('eval/reports/cat40/hard/cells-50k/results.jsonl'):
    r=json.loads(l)
    if r['model']!='claude-fable-5-1': R[r['key']]=r
for l in open('eval/reports/cat40/hard/cells-50k/transcripts.jsonl'):
    t=json.loads(l)
    if t['key'] in R: T[t['key']]=t
def fclass(doc):
    f=form.get(doc)
    if not f: return 'resolution-or-name'
    return '+'.join(sorted(f))
# 1. missed evidence by reference form, per arm, among failed cells
miss=collections.defaultdict(collections.Counter); tot=collections.defaultdict(collections.Counter)
for k,r in R.items():
    a=r['arm']; s=r['score']
    for d in s.get('missed_evidence',[]): miss[a][fclass(d)]+=1
    for d in s.get('missed_evidence',[])+s.get('evidence_cited',[]): tot[a][fclass(d)]+=1
for a in miss: print('MISSED',a,dict(miss[a]))
# 2. search result counts & effective_date mismatch
eff=0; effbad=0; nres=[]; 
for k,t in T.items():
    if '|gbrain-hard|' not in k: continue
    for x in t['tools']:
        if x['name']!='search': continue
        try: rows=json.loads(x['result'])
        except Exception: continue
        if not isinstance(rows,list): continue
        nres.append(len(rows))
        for row in rows:
            ed=row.get('effective_date'); ct=row.get('chunk_text','')
            m=re.search(r'Effective (\d{4}-\d{2}-\d{2})',ct)
            if ed and m:
                eff+=1
                if ed[:10]!=m.group(1): effbad+=1
import statistics
print('search calls',len(nres),'median rows',statistics.median(nres) if nres else None, 'rows==20 share', sum(n>=20 for n in nres)/max(1,len(nres)))
print('effective_date shown vs body Effective date: compared',eff,'mismatched',effbad)
# 3. does entity card aka contain nickname?
aka_has_nick=0; aka_n=0
for k,t in T.items():
    if '|gbrain-hard|' not in k: continue
    for x in t['tools']:
        if x['name']!='entity': continue
        try: c=json.loads(x['result']).get('card',{})
        except Exception: continue
        name=x['args'].get('name','').lower()
        e=next((e for e in ents.values() if e['name'].lower()==name),None)
        if not e or not c: continue
        aka_n+=1; aka=[a.lower() for a in c.get('aka',[])]
        if any(n.lower() in aka for n in e['refs']['nicknames']): aka_has_nick+=1
print('entity cards for accounts',aka_n,'with nickname in aka',aka_has_nick)
# 4. wrong answers: did the agent cite an agent-note (wrong note) ?
wn=collections.Counter()
for k,r in R.items():
    if r['run']['stop']=='submitted' and not r['score']['success']:
        src=(r['run'].get('final') or {}).get('sources',[]) or []
        wn[(r['arm'], any(s.startswith('notes/agents') for s in src))]+=1
print('wrong answers citing agent notes', dict(wn))
