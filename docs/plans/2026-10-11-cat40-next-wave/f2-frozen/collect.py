"""Collect frozen hits: gbrain search/query calls in H4 cells whose recorded hit list contains an item's deciding document."""
import json, os, re, sys, collections
W = os.path.expanduser('~/.capy/work')
SETS = {'M': (f'{W}/mworld/world/world.json', [f'{W}/confirm/main/cells']),
        'dev': (f'{W}/r3/world.json', [f'{W}/r3-out/dev-r5-opus', f'{W}/r3-out/dev-r5-sonnet', f'{W}/r3-out/dev-r5-gpt'])}
def nrm(s): return re.sub(r'\s+', ' ', s).strip()
DEC = json.JSONDecoder()
def rows_of(res):
    """The leading JSON array of a recorded result (notices may follow it); a transcript-clipped array keeps its complete rows."""
    res = res.lstrip()
    try:
        j, _ = DEC.raw_decode(res)
        if isinstance(j, dict): j = j.get('results', j.get('rows'))
        return (j, False) if isinstance(j, list) else (None, False)
    except Exception: pass
    if not res.startswith('['): return (None, False)
    rows, i = [], 1
    while True:
        while i < len(res) and res[i] in ' ,\n': i += 1
        try: o, i = DEC.raw_decode(res, i)
        except Exception: break
        rows.append(o)
    return (rows, True) if rows else (None, False)
out = {}
for name, (wp, dirs) in SETS.items():
    w = json.load(open(wp)); docs = {d['id']: d for d in w['docs']}
    refs = collections.defaultdict(set)
    for r in w['references']: refs[r['doc']].add(r['entity'])
    tasks = {t['id']: t for t in w['tasks'] if t['family'] == 'H4'}
    calls, pages, unparsed, clipped = [], set(), 0, 0
    for d in dirs:
        att = {}
        for l in open(f'{d}/attempts.jsonl'):
            r = json.loads(l)
            if r['stop'] != 'harness_error' and r['arm'].startswith('gbrain') and r['task'] in tasks: att[r['attempt_id']] = r
        for l in open(f'{d}/transcripts.jsonl'):
            tr = json.loads(l); a = att.get(tr['attempt_id'])
            if not a: continue
            t = tasks[a['task']]
            dec = {}
            for n, it in enumerate(t['gold']['items']):
                for e in t['gold']['evidence']:
                    if docs[e]['type'] in ('contract', 'amendment') and it['account'] in refs[e]:
                        sents = [s for s in re.split(r'(?<=\.)\s+|\n', docs[e]['body']) if any(ans in s for ans in it['answer'])]
                        dec[e] = {'item': n, 'sentences': sents, 'len': len(docs[e]['body'])}
            for k, x in enumerate(tr['tools']):
                if x['name'] not in ('search', 'query'): continue
                rows, partial = rows_of(x['result'] or '')
                if rows is None:
                    unparsed += 1; clipped += len(x['result'] or '') >= 40000; continue
                hits = [{'slug': r['slug'], 'chunk_text': r.get('chunk_text', ''), 'chunk_id': r.get('chunk_id')} for r in rows if isinstance(r, dict) and 'slug' in r]
                found = [s for s in dict.fromkeys(h['slug'] for h in hits) if s in dec]
                if not found: continue
                args = x['args'] if isinstance(x['args'], dict) else {}
                calls.append({'partial_hit_list': partial, 'cell': a['attempt_id'], 'model': a['model'], 'task': a['task'], 'call': k, 'name': x['name'],
                              'args': {kk: args.get(kk) for kk in ('return_unit', 'token_budget', 'snippet_chars', 'match', 'limit') if kk in args},
                              'hits': hits, 'deciding': {s: dec[s] for s in found},
                              'recorded_has_sentence': {s: any(nrm(se) in nrm(' '.join(h['chunk_text'] for h in hits if h['slug'] == s)) for se in dec[s]['sentences']) for s in found}})
                pages.update(h['slug'] for h in hits)
    out[name] = {'calls': calls, 'pages': sorted(pages)}
    print(name, 'frozen calls', len(calls), 'distinct hit pages', len(pages), 'unparsed search results', unparsed, '(clipped', clipped, ')',
          'deciding pairs', sum(len(c['deciding']) for c in calls), 'long pairs', sum(1 for c in calls for s, v in c['deciding'].items() if v['len'] >= 20000),
          'explicit return_unit', sum(1 for c in calls if c['args'].get('return_unit')), 'explicit token_budget', sum(1 for c in calls if c['args'].get('token_budget')))
json.dump(out, open('frozen.json', 'w'))
