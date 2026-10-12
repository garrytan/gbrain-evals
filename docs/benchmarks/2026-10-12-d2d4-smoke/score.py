import json, gzip, os, collections
def load(label):
    rs = {json.loads(l)['key']: json.loads(l) for l in open(f'{label}/results.jsonl')}
    path = f'{label}/transcripts.jsonl'
    lines = open(path) if os.path.exists(path) else gzip.open(path + '.gz', 'rt')
    ts = {json.loads(l)['key']: json.loads(l) for l in lines}
    return rs, ts
out = {}
for label in ['master', 'd2d4']:
    rs, ts = load(label)
    by = collections.defaultdict(lambda: collections.Counter())
    for k, r in rs.items():
        m = r['model']; s = r['score']; c = by[m]
        c['cells'] += 1; c['success'] += s['success']; c['output_leak'] += s['output_leak']; c['unsafe_write'] += s['unsafe_write']; c['over_refusal'] += s['over_refusal']
        c['usd'] += r['total_usd']
        tools = ts.get(k, {}).get('tools', [])
        c['tool_calls'] += len(tools)
        notice_seen = False; noticed_cell = False; called_takes = False
        for t in tools:
            res = t.get('result') or ''
            if notice_seen and ('unknown_tool' in res): c['unknown_tool_after_notice'] += 1
            if 'hidden_tool_content' in res: notice_seen = True; noticed_cell = True
            if t['name'] in ('takes_list', 'takes_search'): called_takes = True
        c['notice_cells'] += noticed_cell; c['takes_cells'] += called_takes
    out[label] = {m: {k: (round(v, 4) if isinstance(v, float) else v) for k, v in c.items()} for m, c in by.items()}
print(json.dumps(out, indent=1))
