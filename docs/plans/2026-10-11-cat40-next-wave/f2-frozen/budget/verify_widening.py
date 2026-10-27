"""Empirical check of the derived paths on M: conversation-type rows in implied-auto calls should carry widened page text
(row text longer than one chunk, or the whole page), and long non-conversation rows should stay one chunk."""
import json, collections, os, re
from parse import rows_of
W = os.path.expanduser('~/.capy/work')
w = json.load(open(f'{W}/mworld/world/world.json')); docs = {d['id']: d for d in w['docs']}
CONV = {'conversation', 'transcript', 'chat', 'meeting', 'slack', 'slack-dm-day', 'slack-thread', 'imessage', 'imessage-daily'}
sq = lambda s: re.sub(r'\s+', ' ', s).strip()
c = collections.Counter()
for l in open(f'{W}/confirm/main/cells/transcripts.jsonl'):
    t = json.loads(l)
    if '|gbrain' not in t['attempt_id']: continue
    for x in t['tools']:
        if x['name'] not in ('search', 'query'): continue
        a = x['args'] if isinstance(x['args'], dict) else {}
        if a.get('return_unit') or isinstance(a.get('token_budget'), (int, float)) or a.get('snippet_chars'): continue
        rows, partial = rows_of(x['result'] or '')
        for r in rows or []:
            if not isinstance(r, dict) or r.get('slug') not in docs: continue
            d = docs[r['slug']]; txt = sq(r.get('chunk_text', '')); body = sq(d['body'])
            kind = 'conversation' if str(r.get('type')).lower() in CONV else ('long other' if len(d['body']) >= 20000 else None)
            if not kind or len(body) < 3000: continue
            c[(kind, 'whole page' if len(txt) >= 0.95 * len(body) else 'more than 3,000 chars' if len(txt) > 3000 else 'one chunk or less')] += 1
for k, v in sorted(c.items()): print(k, v)
