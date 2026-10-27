"""Draft-first firing and harm on M H4 (PLAN: preregistered firing/harm metric, stratified by model and H4 variant).
Firing: entity names rows served in H4 cells whose record list holds a DRAFT amendment row; draft-first = a draft row precedes
every executed (non-draft) record row. Harm: wrong-value (said_wrong) and success on H4 cells whose task has a draft-led item.
Draft-led item (settled definition, = the plan's 21 of 70, nextwave eng-check 3b): the account's contract and amendment documents
that reference it by name, code or nickname (account page plus identity sibling), newest document date first (ties by id), lead
with a DRAFT amendment, arm vs control on the same cells. Counts only."""
import json, collections, os, re
import sys
WORLD, R, OUT = sys.argv[1], sys.argv[2], sys.argv[3]  # world.json, dir holding wave/ and baseline/, output json
w = json.load(open(WORLD))
docs = {d['id']: d for d in w['docs']}
forms = collections.defaultdict(lambda: collections.defaultdict(set))
for r in w['references']: forms[r['doc']][r['entity']].add(r['form'])
SIB = {'name', 'code', 'nickname'}
acc_exec = collections.defaultdict(dict)
for dd, m_ in forms.items():
    if dd in docs and docs[dd]['type'] in ('contract', 'amendment'):
        for a, fs_ in m_.items(): acc_exec[a][dd] = fs_
def listed(a): return sorted([x for x, fs_ in acc_exec[a].items() if fs_ & SIB], key=lambda x: (docs[x]['date'], x), reverse=True)
def is_draft(d): return docs[d]['type'] == 'amendment' and docs[d]['title'].startswith('DRAFT')
draft_led_items = 0; items = 0; task_draft = {}; item_draft = {}
for t in w['tasks']:
    if t['family'] != 'H4': continue
    n = 0
    for i, it in enumerate(t['gold']['items']):
        items += 1; L = listed(it['account']); d = bool(L) and is_draft(L[0])
        item_draft[(t['id'], i)] = d; n += d
    draft_led_items += n; task_draft[t['id']] = n > 0
print(f'H4 items with a draft-led newest-first list: {draft_led_items}/{items}; tasks with one: {sum(task_draft.values())}/{len(task_draft)}')
def canon(path):
    out = {}
    for l in open(path):
        r = json.loads(l)
        if r['stop'] != 'harness_error': out[r['key']] = r
    return out
out = {}
DIRS = {'control': 'baseline', 'wave': 'wave'}
arms = ['control', 'wave']
cells = {a: canon(f'{R}/{DIRS[a]}/attempts.jsonl') for a in arms}
for a in arms:
    canon_ids = {r['attempt_id'] for r in cells[a].values()}
    meta = {r['attempt_id']: r for r in cells[a].values()}
    fire = collections.defaultdict(lambda: collections.Counter())
    for l in open(f'{R}/{DIRS[a]}/transcripts.jsonl'):
        tr = json.loads(l)
        if tr['attempt_id'] not in canon_ids: continue
        r = meta[tr['attempt_id']]
        if r['family'] != 'H4': continue
        strata = [('all',), ('model', r['model']), ('long', '+long' in r['variant']), ('draft_task', task_draft[r['task']])]
        cell_df = False
        for tool in tr['tools']:
            if tool['name'] != 'entity' or not isinstance(tool['args'].get('names'), list): continue
            try: js = json.loads(tool['result'][:tool['result'].rfind('}') + 1])
            except Exception: continue
            stack = [x for x in js.get('results', []) if isinstance(x, dict)]
            while stack:
                row = stack.pop(); stack += [s for s in row.get('siblings', []) or [] if isinstance(s, dict)]
                flat = [x for g in row.get('records', []) or [] if isinstance(g, dict) for x in g.get('rows', []) or []]
                if not flat: continue
                isd = ['draft' in str(x.get('title', '')).lower() for x in flat]
                for s in strata:
                    fire[s]['rows_with_records'] += 1
                    if any(isd):
                        fire[s]['rows_with_draft'] += 1
                        if isd.index(True) < (isd.index(False) if False in isd else len(isd)): fire[s]['draft_first'] += 1
                if any(isd) and isd[0]: cell_df = True
        for s in strata:
            fire[s]['h4_cells'] += 1; fire[s]['cells_served_draft_first'] += cell_df
    harm = {}
    for label, pred in [('draft_tasks', lambda t: task_draft[t]), ('other_tasks', lambda t: not task_draft[t])]:
        ks = [k for k, r in cells[a].items() if r['family'] == 'H4' and pred(r['task'])]
        ck = {k.replace(f"|{cells[a][k]['arm']}|", '|'): k for k in ks}
        ctl = {k.replace(f"|{r['arm']}|", '|'): r for k, r in cells['control'].items()}
        for m in ['all'] + sorted({cells[a][k]['model'] for k in ks}):
            sel = [x for x in ck if m == 'all' or cells[a][ck[x]]['model'] == m]
            harm[f'{label}:{m}'] = {'n': len(sel), 'wrong': sum(bool(cells[a][ck[x]]['score'].get('said_wrong')) for x in sel), 'success': sum(cells[a][ck[x]]['score']['success'] for x in sel),
                                   'ctl_wrong': sum(bool(ctl[x]['score'].get('said_wrong')) for x in sel), 'ctl_success': sum(ctl[x]['score']['success'] for x in sel)}
    out[a] = {'firing': {'|'.join(map(str, k)): dict(v) for k, v in fire.items()}, 'harm': harm}
json.dump({'definition': 'draft-led item: account contract+amendment docs referencing it by name/code/nickname, newest doc date first (ties by id), first is a DRAFT amendment', 'draft_led_tasks': sum(task_draft.values()), 'draft_led_items': draft_led_items, 'h4_items': items, 'arms': out}, open(OUT, 'w'), indent=1)
for a, v in out.items():
    f = v['firing']; g = f.get('all', {})
    print(f"{a:16s} rows_w_records {g.get('rows_with_records',0):4d} w_draft {g.get('rows_with_draft',0):4d} draft_first {g.get('draft_first',0):4d} cells_served_df {g.get('cells_served_draft_first',0)}/{g.get('h4_cells')}",
          ' by model', {k.split('|')[1].split('-')[1] if 'claude' in k else 'sol': v2.get('draft_first', 0) for k, v2 in f.items() if k.startswith('model')},
          ' long', {k: v2.get('draft_first', 0) for k, v2 in f.items() if k.startswith('long')})
    h = v['harm']; print('   harm draft_tasks', {k.split(':')[1]: f"W{x['wrong']}/c{x['ctl_wrong']} S{x['success']}/c{x['ctl_success']} n{x['n']}" for k, x in h.items() if k.startswith('draft')}, ' other', {k.split(':')[1]: f"W{x['wrong']}/c{x['ctl_wrong']} n{x['n']}" for k, x in h.items() if k == 'other_tasks:all'})

print('\nHarm on cells where the arm served a draft-first names row (arm vs control, same model+task):')
ctl = {(r['model'], r['task']): r for r in cells['control'].values()}
served = {}
for a in ['wave']:
    ids = {r['attempt_id']: r for r in cells[a].values() if r['family'] == 'H4'}
    hit = set()
    for l in open(f'{R}/{DIRS[a]}/transcripts.jsonl'):
        tr = json.loads(l); r = ids.get(tr['attempt_id'])
        if not r: continue
        for tool in tr['tools']:
            if tool['name'] == 'entity' and isinstance(tool['args'].get('names'), list) and '"DRAFT' in tool['result'].upper().replace('\\"', '"'):
                try: js = json.loads(tool['result'][:tool['result'].rfind('}') + 1])
                except Exception: continue
                stack = [x for x in js.get('results', []) if isinstance(x, dict)]
                while stack:
                    row = stack.pop(); stack += [s for s in row.get('siblings', []) or [] if isinstance(s, dict)]
                    flat = [x for g in row.get('records', []) or [] if isinstance(g, dict) for x in g.get('rows', []) or []]
                    if flat and 'draft' in str(flat[0].get('title', '')).lower(): hit.add((r['model'], r['task']))
    by = collections.defaultdict(lambda: [0, 0, 0, 0, 0])
    for k in hit:
        r = next(x for x in ids.values() if (x['model'], x['task']) == k)
        for m in ('all', k[0]):
            b = by[m]; b[0] += 1; b[1] += bool(r['score'].get('said_wrong')); b[2] += bool(ctl[k]['score'].get('said_wrong')); b[3] += r['score']['success']; b[4] += ctl[k]['score']['success']
    served[a] = {m: dict(zip(['n', 'wrong', 'ctl_wrong', 'success', 'ctl_success'], v)) for m, v in by.items()}
    print(f'{a:16s}', {m.split("-")[1] if "claude" in m else m.replace("gpt-6.1-", ""): f"n{v[0]} W{v[1]}/c{v[2]} S{v[3]}/c{v[4]}" for m, v in sorted(by.items())})
d = json.load(open(OUT)); d['harm_on_served_draft_first_cells'] = served
json.dump(d, open(OUT, 'w'), indent=1)
