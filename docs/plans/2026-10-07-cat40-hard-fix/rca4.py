# Autoplan re-check of the root cause (2026-10-07). Run from the gbrain-evals root, like rca.py.
# Reads every stored tool result (results longer than 40,000 characters are cut in transcripts.jsonl).
import json,collections,re,statistics
w=json.load(open('eval/reports/cat40/hard-holdout/50k/world.json'))
ents={e['id']:e for e in w['entities']}; tasks={t['id']:t for t in w['tasks']}; docs={d['id']:d for d in w['docs']}
form=collections.defaultdict(set)
for r in w['references']: form[(r['doc'],r['entity'])].add(r['form'])
R={}
for l in open('eval/reports/cat40/hard/cells-50k/results.jsonl'):
    r=json.loads(l)
    if r['model']!='claude-fable-5-1': R[r['key']]=r
T={}
for l in open('eval/reports/cat40/hard/cells-50k/transcripts.jsonl'):
    t=json.loads(l)
    if t['key'] in R: T[t['key']]=t
def norm(s): return re.sub(r'[^0-9a-z$]','',str(s).lower())
def blob(k,args=True): return ' '.join((x['result'] or '')+(json.dumps(x['args']) if args else '') for x in T.get(k,{'tools':[]})['tools'])
# 1. nickname learned (seen in a result) and queried (in an argument), H2-H4, first four accounts per task
learn=collections.Counter(); qry=collections.Counter(); n=collections.Counter()
for k,r in R.items():
    t=tasks[r['task']]
    if t['family'] not in ('H2','H3','H4'): continue
    res=' '.join((x['result'] or '') for x in T[k]['tools']).lower(); args=' '.join(json.dumps(x['args']) for x in T[k]['tools']).lower()
    for acc in t['accounts'][:4]:
        nick=[z.lower() for z in ents[acc]['refs']['nicknames']]
        if not nick: continue
        n[r['arm']]+=1; learn[r['arm']]+=any(z in res for z in nick); qry[r['arm']]+=any(z in args for z in nick)
for a in sorted(n): print(f'{a}: nickname learned {100*learn[a]/n[a]:.0f}%, queried {100*qry[a]/n[a]:.0f}% of {n[a]} account-cells')
# 2. lost cells (fs right, gbrain wrong), excluding turn-cap stops: unseen needed documents by reference form
lost=[k for k,r in R.items() if r['arm']=='gbrain-hard' and R[k.replace('|gbrain-hard|','|fs|')]['score']['success'] and not r['score']['success'] and r['stop']!='turn_cap']
fam=collections.Counter(R[k]['task'][:2] for k in lost); print('lost non-turn-cap cells', len(lost), dict(fam))
tot=collections.Counter(); uns=collections.Counter(); percell=collections.Counter()
for k in lost:
    t=tasks[R[k]['task']]; b=blob(k); cats=set()
    for d in t['gold'].get('evidence') or []:
        f=set()
        for acc in t.get('accounts',[]): f|=form.get((d,acc),set())
        for x in (f or {'none'}):
            tot[x]+=1
            if d not in b: uns[x]+=1; cats.add(x)
    if t['family']!='H5': percell[tuple(sorted(cats))]+=1
print('unseen needed documents by form:', {x:f'{uns[x]}/{tot[x]}' for x in tot})
print('H1-H4 lost cells by unseen forms:', dict(percell))
# 3. agent-note values in lost cells (note about the asked account contains the wrong value)
cells=set()
for k in lost:
    t=tasks[R[k]['task']]
    if t['answer_kind']!='values': continue
    try: ans=json.loads((R[k]['sessions'][-1]['run'].get('final') or {}).get('answer'))
    except Exception: continue
    for i,it in enumerate(t['gold']['items']):
        a=ans[i] if i<len(ans) else None
        if a is None or norm(a) in [norm(z) for z in it['answer']]: continue
        keys=[ents[it['account']]['name'].lower()]+[x.lower() for x in ents[it['account']].get('aliases',[])]
        if any(d['type']=='agent-note' and norm(a) in norm(d['body']) and any(kk in (d['title']+d['body']).lower() for kk in keys) for d in docs.values()): cells.add(k)
print('lost cells with an agent-note value for the asked account:', len(cells))
# 4. search limit use, remember errors, notices
lim=collections.Counter(); rows=collections.defaultdict(list); rem=collections.Counter(); notice=collections.Counter(); cells_rr=set(); sugg=collections.Counter()
for k,t in T.items():
    if '|gbrain-hard|' not in k: continue
    for x in t['tools']:
        r=x['result'] or ''; body=r.split('\n[gbrain notice')[0]
        for c in set(re.findall(r'\[gbrain notice ([a-z_]+)',r)): notice[c]+=1
        if x['name']=='search':
            L=x['args'].get('limit'); lim['none' if L is None else ('>=30' if L>=30 else '<30')]+=1
            if 'degraded_recall' in r: cells_rr.add(k)
            try: rows[L].append(len(json.loads(body)))
            except Exception: pass
        if x['name']=='remember': rem['error' if body.startswith('Error') else 'ok']+=1
        if x['name']=='entity':
            try: e=json.loads(body)
            except Exception: continue
            if e.get('found'): sugg['found']+=1; sugg['account sheet in suggestions']+=any(s['slug'].startswith('accounts/') for s in e.get('suggestions') or [])
print('search calls by limit:', dict(lim), '| default-limit calls returning 20 rows:', sum(1 for z in rows[None] if z==20), 'of', len(rows[None]))
print('remember:', dict(rem), '| entity cards:', dict(sugg))
print('cells with rerank_failed notice:', len(cells_rr), '| notices on tool results:', dict(notice))
# 5. latency components per cell (median)
agg=collections.defaultdict(lambda: collections.defaultdict(list))
for r in R.values():
    tm=sum(s['run'].get('tool_ms',0) for s in r['sessions']); mm=sum(s['run'].get('model_ms',0) for s in r['sessions'])
    agg[r['arm']]['tool_s'].append(tm/1000); agg[r['arm']]['model_s'].append(mm/1000)
for a in agg: print(a, {k:round(statistics.median(v),1) for k,v in agg[a].items()})
