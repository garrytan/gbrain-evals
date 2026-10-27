"""Every recorded gbrain agent search/query call (all families) with its hit list, real budget path and recorded
result chars (attempts `chars`, full serialized result); deciding pairs come from ../frozen.json."""
import json, os
from parse import rows_of
W = os.path.expanduser('~/.capy/work')
SETS = {'M': [f'{W}/confirm/main/cells'], 'dev': [f'{W}/r3-out/dev-r5-opus', f'{W}/r3-out/dev-r5-sonnet', f'{W}/r3-out/dev-r5-gpt']}
CONV = {'conversation', 'transcript', 'chat', 'meeting', 'slack', 'slack-dm-day', 'slack-thread', 'imessage', 'imessage-daily'}
frozen = json.load(open('../frozen.json'))
out = {}
for S, dirs in SETS.items():
    dec = {(c['cell'], c['call']): c['deciding'] for c in frozen[S]['calls']}
    calls, pages, mismatch = [], set(), 0
    for d in dirs:
        att = {}
        for l in open(f'{d}/attempts.jsonl'):
            r = json.loads(l)
            if r['stop'] != 'harness_error' and r['arm'].startswith('gbrain'): att[r['attempt_id']] = r
        for l in open(f'{d}/transcripts.jsonl'):
            t = json.loads(l); a = att.get(t['attempt_id'])
            if not a: continue
            meta = [tc for s in a['sessions'] for tc in s['run']['tool_calls']]
            if len(meta) != len(t['tools']) or any(m['name'] != x['name'] for m, x in zip(meta, t['tools'])): mismatch += 1; meta = None
            for k, x in enumerate(t['tools']):
                if x['name'] not in ('search', 'query'): continue
                args = x['args'] if isinstance(x['args'], dict) else {}
                rows, partial = rows_of(x['result'] or '')
                rows = [r for r in (rows or []) if isinstance(r, dict) and 'slug' in r]
                tb = args.get('token_budget') if isinstance(args.get('token_budget'), (int, float)) else None
                ru = args.get('return_unit')
                if ru and ru != 'auto': path = 'explicit'
                elif x['name'] == 'query' and tb is not None: path = 'legacy'
                elif tb is not None or ru == 'auto': path = 'cap' if tb is not None else 'auto'
                else: path = 'auto'
                calls.append({'cell': a['attempt_id'], 'family': a['family'], 'model': a['model'], 'call': k, 'name': x['name'], 'path': path,
                              'return_unit': ru, 'token_budget': tb, 'recorded_chars': meta[k]['chars'] if meta else len(x['result'] or ''),
                              'partial': partial, 'conv_hit': any(str(r.get('type') or '').lower() in CONV or r['slug'].startswith(('chat/', 'conversations/')) for r in rows),
                              'hits': [{'slug': r['slug'], 'chunk_text': r.get('chunk_text', '')} for r in rows],
                              'deciding': dec.get((a['attempt_id'], k), {})})
                pages.update(r['slug'] for r in rows)
    out[S] = {'calls': calls, 'pages': sorted(pages)}
    print(S, 'calls', len(calls), 'pages', len(pages), 'cells with tool-list mismatch', mismatch, 'deciding pairs', sum(len(c['deciding']) for c in calls),
          'paths', {p: sum(c['path'] == p for c in calls) for p in ('auto', 'cap', 'legacy', 'explicit')})
json.dump(out, open('calls_all.json', 'w'))
