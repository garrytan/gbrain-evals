import json, collections, statistics
import os, pathlib
REPO=pathlib.Path(__file__).resolve().parents[6]
W=os.environ.get('FLAGCHECK_DIR') or str(REPO/'.flagcheck')
off={json.loads(l)['question_id']:json.loads(l) for l in open(W+'/redeliver/full-off.ndjson')}
on={json.loads(l)['question_id']:json.loads(l) for l in open(W+'/redeliver/full-on.ndjson')}
arms=[k for k in next(iter(off.values())) if ':' in k]
out={'questions':len(off),'hits_text_ok':{'ed_off':sum(r['ed_hits_text_ok'] for r in off.values()),'v2_off':sum(r['v2_hits_text_ok'] for r in off.values()),'ed_on':sum(r['ed_hits_text_ok'] for r in on.values()),'v2_on':sum(r['v2_hits_text_ok'] for r in on.values())},'arms':{}}
for a in arms:
    s=collections.Counter(); ins=[]; dtok=[]; fb=collections.Counter(); fboff=collections.Counter(); errs=0; overb=0; types=collections.Counter(); budget_used_over=0; same_results=0; reasons_changed=0; dropped_more=0
    for q,ro in off.items():
        x,y=ro[a],on[q][a]
        if 'error' in x or 'error' in y: errs+=1; continue
        changed = x['text_sha256']!=y['text_sha256']
        s['text_changed' if changed else 'text_same']+=1
        if changed: types[ro['question_type']]+=1
        n=(y['delivery'].get('relative_dates') or {}).get('insertions',0); ins.append(n)
        dtok.append(y['tokens']-x['tokens'])
        for f in y['delivery']['fallbacks'] or []: fb[f]+=1
        for f in x['delivery']['fallbacks'] or []: fboff[f]+=1
        bt=y['delivery']['budget_tokens']; 
        if bt is not None and y['delivery']['budget_used'] is not None and y['delivery']['budget_used']>max(bt, x['delivery']['budget_used']): budget_used_over+=1
        if x['results']==y['results']: same_results+=1
        if x['reasons']!=y['reasons']: reasons_changed+=1
        if (y['delivery']['dropped'] or 0)>(x['delivery']['dropped'] or 0): dropped_more+=1
    out['arms'][a]={'errors':errs,**s,'insertions_total':sum(ins),'questions_with_insertions':sum(1 for n in ins if n>0),'token_delta_total':sum(dtok),'token_delta_max':max(dtok),'token_delta_min':min(dtok),'questions_tokens_up':sum(1 for d in dtok if d>0),'questions_tokens_down':sum(1 for d in dtok if d<0),'fallbacks_on':dict(fb),'fallbacks_off':dict(fboff),'budget_used_over_cap':budget_used_over,'result_count_same':same_results,'reasons_changed':reasons_changed,'dropped_more':dropped_more,'changed_by_type':dict(types)}
json.dump(out,open(W+'/redeliver/summary.json','w'),indent=1)
print(json.dumps(out,indent=1))
# local vs remote parity within each build
for name,d in [('off',off),('on',on)]:
    for a in ['v2:auto','v2:page']:
        same=sum(1 for r in d.values() if r[a].get('fingerprint')==r[a+':remote'].get('fingerprint'))
        print(name,a,'local==remote fingerprint',same,'/',len(d))
