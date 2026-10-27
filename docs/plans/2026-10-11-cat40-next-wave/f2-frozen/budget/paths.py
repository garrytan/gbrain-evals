"""Budget path of every recorded agent search/query call (all families), from call args and hit types, per gbrain
3e4ff61c (resolveEvidencePlan, effectivePlan, conversationSignal, ops/search.ts evidencePlanFor) and the slot config
(the runs passed no --gbrain-config, so search.return_unit, return_budget_default=6000 and
return_budget_conversation=24000 are at their defaults; stdio serve is remote, remote max 32000)."""
import json, collections, os
from parse import rows_of
W = os.path.expanduser('~/.capy/work')
CONV_TYPES = {'conversation', 'transcript', 'chat', 'meeting', 'slack', 'slack-dm-day', 'slack-thread', 'imessage', 'imessage-daily'}
def conv(r): return (str(r.get('type') or '').lower() in CONV_TYPES) or r.get('slug', '').startswith(('chat/', 'conversations/'))
SETS = {'M': [f'{W}/confirm/main/cells'], 'dev': [f'{W}/r3-out/dev-r5-opus', f'{W}/r3-out/dev-r5-sonnet', f'{W}/r3-out/dev-r5-gpt']}
for S, dirs in SETS.items():
    c = collections.Counter(); deliv = collections.Counter()
    for d in dirs:
        arm = {json.loads(l)['attempt_id']: json.loads(l)['arm'] for l in open(f'{d}/attempts.jsonl')}
        for l in open(f'{d}/transcripts.jsonl'):
            t = json.loads(l)
            if not arm.get(t['attempt_id'], '').startswith('gbrain'): continue
            for x in t['tools']:
                if x['name'] not in ('search', 'query'): continue
                a = x['args'] if isinstance(x['args'], dict) else {}
                rows, _ = rows_of(x['result'] or '')
                rows = [r for r in (rows or []) if isinstance(r, dict)]
                tb = isinstance(a.get('token_budget'), (int, float))
                if a.get('return_unit') and a['return_unit'] != 'auto': p = f"explicit {a['return_unit']}: budget {a.get('token_budget') or 6000}"
                elif a.get('return_unit') == 'auto': p = f"explicit auto: budget {a.get('token_budget') or 24000}"
                elif x['name'] == 'query' and tb: p = 'query + token_budget: legacy chunk path, no evidence budget'
                elif tb: p = f"implied auto + token_budget: cap path, budget = token_budget"
                elif any(conv(r) for r in rows): p = 'implied auto, conversation hit present: auto path, budget 24000'
                else: p = 'implied auto, no conversation hit: chunk path, no evidence budget'
                c[p] += 1
                deliv[(p, any('delivered' in r for r in rows))] += 1
    tot = sum(c.values())
    print(f'\n{S}: {tot} recorded agent search/query calls')
    for p, n in c.most_common(): print(f'  {n:5d}  {p}   (rows carrying a delivered object: {deliv[(p, True)]} calls)')
