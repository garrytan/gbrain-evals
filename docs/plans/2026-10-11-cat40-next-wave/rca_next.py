# Root cause of gbrain's weak spots for the next fix wave: wrong answers, M's H4, dev-world replication, headroom.
# Free: reads committed or copied cell records, transcripts and the regenerated worlds; no model calls.
# World M and the development (calibration) world only; the sealed world S is never read.
# Prints counts and generic shapes only (task ids, families, models, tool names, document types), never task or document text.
#
# Usage: python3 rca_next.py [--work ~/.capy/work] [--json out.json]
#   M:   <work>/mworld/world/world.json (seed 20261021, regenerated; digest 6f08629e...) + <work>/confirm/main/cells
#   dev: <work>/r3/world.json (seed 20261005; digest 2cde6dce...) + gbrain <work>/r3-out/dev-r5-{opus,sonnet,gpt} (build 3e4ff61ce)
#        + fs <work>/r3-out/dev-r4-fs
import json, re, sys, os, collections, statistics

args = sys.argv[1:]
WORK = os.path.expanduser(args[args.index('--work') + 1] if '--work' in args else '~/.capy/work')
OUT = args[args.index('--json') + 1] if '--json' in args else None
MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6.1-sol']
SHORT = {'claude-sonnet-5-5': 'Sonnet', 'claude-opus-5-5': 'Opus', 'gpt-6.1-sol': 'Sol'}
FAMS = ['H1', 'H2', 'H3', 'H4', 'H5']
CLASSES = {
    'a': 'superseded or older value (an authoritative record of the account, no longer in force)',
    'a_future': 'executed amendment applied before its effective date',
    'b': 'alias or entity confusion (a value of another account)',
    'c': 'set or count error (H1)',
    'd': 'value in no document or session',
    'e': 'generated summary or agent-note text taken as evidence',
    'g': 'lower-authority claim (unsigned draft or hearsay email)',
    'f': 'other (no parseable value, formatting, or an unclassified value)',
}
SUMMARY = {}


def arm_of(label): return 'gbrain' if label.startswith('gbrain') else label


def norm(s): return re.sub(r'[\s,$]', '', str(s).lower())


def has(hay_norm, v):
    """The normalized value appears in normalized text, not inside a longer number. Whitespace is stripped by norm,
    so only digits and decimal points count as a boundary violation; letters may touch the number."""
    n = norm(v)
    if not n: return False
    if not (n[0].isdigit() or n[-1].isdigit()): return n in hay_norm
    return re.search(r'(?<![0-9.])' + re.escape(n) + r'(?![0-9]|\.[0-9])', hay_norm) is not None


def load(world_path, cell_dirs):
    w = json.load(open(world_path))
    docs = {d['id']: d for d in w['docs']}
    dnorm = {i: norm(d['title'] + ' ' + d['body']) for i, d in docs.items()}
    ent_docs = collections.defaultdict(set)
    for r in w['references']: ent_docs[r['entity']].add(r['doc'])
    tasks = {t['id']: t for t in w['tasks']}
    R, T = {}, {}
    for d in cell_dirs:
        for l in open(os.path.join(d, 'attempts.jsonl')):
            r = json.loads(l)
            if r['stop'] == 'harness_error' or r['model'] not in MODELS: continue
            r['A'] = arm_of(r['arm'])
            R[(r['model'], r['A'], r['task'])] = r
        tp = os.path.join(d, 'transcripts.jsonl')
        for l in open(tp):
            t = json.loads(l)
            T[t['attempt_id']] = t['tools']
    for k, r in R.items(): r['tools'] = T.get(r['attempt_id'], [])
    return w, docs, dnorm, ent_docs, tasks, R


def parse_values(ans, n):
    if isinstance(ans, list): arr = ans
    else:
        s = '' if ans is None else str(ans)
        try: arr = json.loads(s)
        except Exception:
            m = re.search(r'\[.*\]', s, re.S)
            try: arr = json.loads(m.group(0)) if m else None
            except Exception: arr = None
    if not isinstance(arr, list) or len(arr) != n: return None
    return [str(x) for x in arr]


def head(s): return re.split(r'\s*\(|;|\s[-–—]\s', s, 1)[0]


TRANSCRIPT_CAP = 40_000   # transcripts store each tool result clipped to 40,000 characters; the model saw the full result
ABSTAIN = re.compile(r"unknown|not found|unable|cannot|can't|could not|no record|n/?a\b|unclear|not determin|insufficient|^none$", re.I)


def classify_value(v, item, task, w, docs, dnorm, ent_docs, sess_norm, today, carrier_text=''):
    """Class of a submitted value that is not the accepted one, from where it occurs in the world.
    When the value occurs in several of the account's documents, the document named in the first tool result that
    returned the value decides; otherwise the most authoritative kind (a_future, a, g, e) does."""
    acct = item['account']
    own = ent_docs.get(acct, set()) | set(task.get('relevant') or [])
    src = sorted(i for i in own if i in dnorm and has(dnorm[i], v))
    if task['family'] == 'H5' and sess_norm and has(sess_norm, v): return ('a', [], 'session')
    if not src:
        others = [i for i, x in dnorm.items() if has(x, v)]
        if not others: return ('d', [], None)
        return ('b', others[:3], docs[others[0]]['type'])
    def kind(i):
        d = docs[i]
        if d['type'] == 'agent-note': return 'e'
        if d['title'].startswith('DRAFT') or (d['type'] == 'email' and 'summary from the call' in d['body'].lower()): return 'g'
        m = re.search(r'Effective (\d{4}-\d{2}-\d{2})[^.]*?' + re.escape(v), d['body'])
        return 'a_future' if d['type'] == 'amendment' and m and m.group(1) > today else 'a'
    shown = [i for i in src if i in carrier_text]
    pool = shown or src
    ks = [kind(i) for i in pool]
    for k in ('a_future', 'a', 'g', 'e'):
        if k in ks: i = pool[ks.index(k)]; return (k, src[:3], docs[i]['type'])
    return (ks[0], src[:3], docs[pool[0]]['type'])


def tool_blob(tools):
    return ' '.join((x['result'] or '') + ' ' + (x['args'] if isinstance(x['args'], str) else json.dumps(x['args'])) for x in tools)


def first_carrier(tools, v):
    for i, x in enumerate(tools, 1):
        if has(norm(x['result'] or ''), v): return i, x['name'], x['result'] or ''
    return None, None, ''


def analyze(name, world_path, cell_dirs):
    w, docs, dnorm, ent_docs, tasks, R = load(world_path, cell_dirs)
    today = w['today']
    print(f'\n# {name}: world {os.path.basename(os.path.dirname(world_path))}, {len(docs)} documents, {len(R)} canonical cells')
    cnt = collections.Counter((r['A'], r['model']) for r in R.values())
    print('cells per arm and model:', {f'{a}/{SHORT[m]}': n for (a, m), n in sorted(cnt.items())})
    items_out = []   # one row per failed item of a submitted answer
    shown_ok = {'gbrain': [], 'fs': []}
    cells = {}
    mismatch = 0
    for key, r in R.items():
        t = tasks[r['task']]
        run = r['sessions'][-1]['run'] if r.get('sessions') else r['run']
        final = (run.get('final') or {}) if isinstance(run.get('final'), dict) else {}
        ans = final.get('answer')
        tools = r['tools']
        blob = tool_blob(tools)
        rnorm = norm(' '.join(x['result'] or '' for x in tools))
        sub = r['score']['submitted']
        turns = run.get('turns', 0)
        c = {'key': key, 'model': r['model'], 'A': r['A'], 'task': r['task'], 'family': t['family'], 'success': r['score']['success'],
             'submitted': sub, 'stop': r['stop'], 'turns': turns, 'calls': len(tools), 'said_wrong': r['score'].get('said_wrong', False),
             'classes': [], 'abstained_items': 0, 'variant': t['variant']}
        cells[key] = c
        if t['family'] == 'H4' and sub:
            hv = parse_values(ans, len(t['gold']['items'])) or []
            for n, it in enumerate(t['gold']['items'][:len(hv)]):
                if not any(has(norm(head(hv[n])), a) for a in it['answer']) or any(has(norm(hv[n]), x) for x in it['wrong']): continue
                ev = [d for d in t['gold']['evidence'] if d in ent_docs.get(it['account'], set())]
                dec = [ln for d in ev for ln in re.split(r'(?<=\.)\s+|\n', docs[d]['body']) if any(has(norm(ln), a) for a in it['answer'])]
                if dec: shown_ok[r['A']].append(any(norm(ln) in rnorm for ln in dec))
        if not sub or r['score']['success']: continue
        if t['answer_kind'] in ('set', 'count'):
            s = r['score']
            if t['answer_kind'] == 'set' and s.get('set'):
                st = s['set']; matched = round(st['precision'] * st['got']) if st['got'] else 0
                shape = ('missing' if matched < st['expected'] else '') + ('+extra' if st['got'] > matched else '')
            else:
                shape = 'unparseable' if s.get('unparseable_set') else ('count low' if (s.get('count_read') or 0) < t['gold']['count'] else 'count high')
            c['classes'].append('c')
            items_out.append({'cell': key, 'model': r['model'], 'A': r['A'], 'family': 'H1', 'cls': 'c', 'shape': shape or 'other', 'turns': turns,
                              'seen': sum(1 for d in t['gold']['evidence'] if d in blob) / max(1, len(t['gold']['evidence'])), 'carrier': None})
            continue
        gi = t['gold']['items']
        vals = parse_values(ans, len(gi))
        sess_norm = norm(' '.join(t.get('sessions') or []))
        mine_ok = True
        for n, it in enumerate(gi):
            ev = [d for d in t['gold']['evidence'] if d in ent_docs.get(it['account'], set())]
            seen = (any(d in blob for d in ev)) if ev else None
            dec = [ln for d in ev for ln in re.split(r'(?<=\.)\s+|\n', docs[d]['body']) if any(has(norm(ln), a) for a in it['answer'])]
            shown = any(norm(ln) in rnorm for ln in dec) if dec else None
            clipped = any(len(x['result'] or '') >= TRANSCRIPT_CAP and any(d in (x['result'] or '') for d in ev) for x in tools)
            if vals is None:
                c['classes'].append('f'); mine_ok = False
                items_out.append({'cell': key, 'model': r['model'], 'A': r['A'], 'family': t['family'], 'cls': 'f', 'shape': 'no parseable array', 'turns': turns, 'seen': seen, 'carrier': None, 'item_variant': t['variant'].split('|')[n] if '|' in t['variant'] else t['variant']})
                break
            got = vals[n]
            wrong_named = [x for x in it['wrong'] if has(norm(got), x)]
            ok = any(has(norm(head(got)), a) for a in it['answer']) and not wrong_named
            if ok: continue
            mine_ok = False
            if ABSTAIN.search(got) and not wrong_named:
                c['abstained_items'] += 1
                cls, src, styp = 'f', [], None
                shape = 'abstained item'
            else:
                v = wrong_named[0] if wrong_named else head(got).strip().strip('"')
                _, _, ctext = first_carrier(tools, v)
                cls, src, styp = classify_value(v, it, t, w, docs, dnorm, ent_docs, sess_norm, today, ctext)
                shape = ('listed wrong value' if wrong_named else 'unlisted value') + (f' from {styp}' if styp else '')
            ci, cname, cres = first_carrier(tools, wrong_named[0] if wrong_named else head(got)) if cls != 'f' else (None, None, '')
            carrier_doc = next((d for d in src if d in cres), None)
            c['classes'].append(cls)
            items_out.append({'cell': key, 'model': r['model'], 'A': r['A'], 'family': t['family'], 'cls': cls, 'shape': shape, 'turns': turns, 'seen': seen, 'shown': shown, 'clipped': clipped, 'item': n,
                              'carrier': cname, 'carrier_idx': ci, 'carrier_has_source_doc': carrier_doc is not None,
                              'source_type': styp, 'item_variant': t['variant'].split('|')[n] if '|' in t['variant'] else t['variant']})
        if mine_ok: mismatch += 1
    print('deciding sentence shown in a tool result, H4 items answered right (check of the shown test): ' + ', '.join(f'{A} {sum(v)}/{len(v)}' for A, v in shown_ok.items()))
    print(f'scorer agreement: {mismatch} failed submitted values-cells where every item re-scored as right (expected 0)')

    # 1. Wrong answers
    print('\n## 1. Wrong answers (submitted, not successful)')
    for A in ('gbrain', 'fs'):
        sw = collections.Counter(SHORT[c['model']] for c in cells.values() if c['A'] == A and c['said_wrong'])
        print(f"- {A} said_wrong cells by model: " + ', '.join(f'{SHORT[m]} {sw[SHORT[m]]}' for m in MODELS))
    for A in ('gbrain', 'fs'):
        wc = [c for c in cells.values() if c['A'] == A and c['submitted'] and not c['success']]
        sw = [c for c in cells.values() if c['A'] == A and c['said_wrong']]
        print(f'- {A}: {len(wc)} wrong submitted cells of {sum(1 for c in cells.values() if c["A"] == A)}; {len(sw)} named a listed wrong value (said_wrong)')
    print('\nFailed items by class (an H1 cell counts as one item):\n')
    print('| Class | gbrain | fs | gbrain by model (So/Op/Sol) | fs by model (So/Op/Sol) | gbrain by family (H1..H5) | fs by family (H1..H5) |')
    print('|---|---|---|---|---|---|---|')
    for k, label in CLASSES.items():
        g = [x for x in items_out if x['A'] == 'gbrain' and x['cls'] == k]
        f = [x for x in items_out if x['A'] == 'fs' and x['cls'] == k]
        bym = lambda L: '/'.join(str(sum(1 for x in L if x['model'] == m)) for m in MODELS)
        byf = lambda L: '/'.join(str(sum(1 for x in L if x['family'] == fam)) for fam in FAMS)
        print(f'| ({k}) {label} | {len(g)} | {len(f)} | {bym(g)} | {bym(f)} | {byf(g)} | {byf(f)} |')
    print('\nTool that first returned the wrong value, and whether that result also carried the source document (classes a, a_future, b, e, g):\n')
    print('| Arm | Class | items | first carrier tools | carrier result names the source doc | right doc seen in the cell |')
    print('|---|---|---|---|---|---|')
    for A in ('gbrain', 'fs'):
        for k in ('a', 'a_future', 'b', 'e', 'g', 'd'):
            L = [x for x in items_out if x['A'] == A and x['cls'] == k]
            if not L: continue
            car = collections.Counter(x['carrier'] or 'none' for x in L).most_common(4)
            src = sum(1 for x in L if x.get('carrier_has_source_doc'))
            sv = [x['seen'] for x in L if x['seen'] is not None]
            print(f"| {A} | {k} | {len(L)} | {', '.join(f'{a} {b}' for a, b in car)} | {src}/{len(L)} | {sum(sv)}/{len(sv)} |")
    print('\nSource document type of class a/b/e/g wrong values:', {A: dict(collections.Counter(x['source_type'] for x in items_out if x['A'] == A and x['cls'] in ('a', 'a_future', 'b', 'e', 'g'))) for A in ('gbrain', 'fs')})
    print('\nH1 set/count error shapes:', {A: dict(collections.Counter(x['shape'] for x in items_out if x['A'] == A and x['cls'] == 'c')) for A in ('gbrain', 'fs')})
    print('\nAnswered without the deciding document (a failed item whose evidence document never appeared in the cell), abstained items, and late submits:\n')
    print('| Arm | failed items with evidence | answered without seeing it | abstained items | wrong cells submitted at turn 14-16 | all submitted cells at turn 14-16 |')
    print('|---|---|---|---|---|---|')
    for A in ('gbrain', 'fs'):
        L = [x for x in items_out if x['A'] == A and x['seen'] is not None and x['cls'] != 'f']
        uns = sum(1 for x in L if not x['seen'])
        ab = sum(c['abstained_items'] for c in cells.values() if c['A'] == A)
        wc = [c for c in cells.values() if c['A'] == A and c['submitted'] and not c['success']]
        late = sum(1 for c in wc if c['turns'] >= 14)
        allsub = [c for c in cells.values() if c['A'] == A and c['submitted']]
        print(f"| {A} | {len(L)} | {uns} | {ab} | {late}/{len(wc)} | {sum(1 for c in allsub if c['turns'] >= 14)}/{len(allsub)} (success {sum(1 for c in allsub if c['turns'] >= 14 and c['success'])}) |")

    for A in ('gbrain', 'fs'):
        L = [x for x in items_out if x['A'] == A and x['seen'] is not None and x['cls'] != 'f']
        fam = collections.Counter(x['family'] for x in L if not x['seen'])
        wt = [c['turns'] for c in cells.values() if c['A'] == A and c['submitted'] and not c['success']]
        print(f"- {A}: answered without seeing the deciding document, by family {dict(sorted(fam.items()))}; wrong submitted cells median turn {statistics.median(wt) if wt else '-'}")

    # 2. H4 paired
    print('\n## 2. H4 paired by task and model')
    h4 = sorted(t for t in tasks if t.startswith('H4') and any(k[2] == t for k in R))
    fs_only, g_only, both, neither = [], [], 0, 0
    for t in h4:
        for m in MODELS:
            g, f = R.get((m, 'gbrain', t)), R.get((m, 'fs', t))
            if not g or not f: continue
            gs, fs_ = g['score']['success'], f['score']['success']
            if fs_ and not gs: fs_only.append((t, m))
            elif gs and not fs_: g_only.append((t, m))
            elif gs and fs_: both += 1
            else: neither += 1
    print(f'cells: fs wins {len(fs_only)}, gbrain wins {len(g_only)}, both {both}, neither {neither}')
    bt = collections.Counter(t for t, m in fs_only)
    print('tasks where fs wins (count of models):', dict(sorted(bt.items())))
    print('fs-win cells by model:', dict(collections.Counter(SHORT[m] for t, m in fs_only)), '; gbrain-win cells:', sorted((t, SHORT[m]) for t, m in g_only), '; fs-win cells on those tasks:', sorted((t, SHORT[m]) for t, m in fs_only if t in {x for x, _ in g_only}))
    print('tasks where gbrain wins (count of models):', dict(sorted(collections.Counter(t for t, m in g_only).items())))
    # item-level by variant
    print('\nH4 items right by variant (all models):\n')
    print('| Variant | gbrain right | fs right |')
    print('|---|---|---|')
    var_ok = collections.defaultdict(lambda: [0, 0, 0, 0])
    for (m, A, t), r in R.items():
        if not t.startswith('H4'): continue
        tk = tasks[t]; vals = parse_values(((r['sessions'][-1]['run'].get('final') or {}).get('answer')), len(tk['gold']['items']))
        for n, it in enumerate(tk['gold']['items']):
            vv = tk['variant'].split('|')[n].split(':')[0]
            ok = vals is not None and r['score']['submitted'] and any(has(norm(head(vals[n])), a) for a in it['answer']) and not any(has(norm(vals[n]), x) for x in it['wrong'])
            i = 0 if A == 'gbrain' else 2
            var_ok[vv][i] += ok; var_ok[vv][i + 1] += 1
    for vv, (a, b, c_, d) in sorted(var_ok.items()):
        print(f'| {vv} | {a}/{b} | {c_}/{d} |')
    # divergence on the fs-win cells
    print('\nWhere gbrain diverges on the cells fs wins (one count per failed item of a gbrain H4 cell that lost where fs on the same model succeeded):\n')
    div = collections.Counter(); detail = collections.Counter(); tc = {'gbrain': [], 'fs': []}; tu = {'gbrain': [], 'fs': []}
    exec_seen = []; evlen = collections.Counter(); evrange = []; gp_ev = 0
    for t, m in fs_only:
        g, f = R[(m, 'gbrain', t)], R[(m, 'fs', t)]
        tk = tasks[t]; gb = tool_blob(g['tools'])
        tc['gbrain'].append(len(g['tools'])); tc['fs'].append(len(f['tools'])); tu['gbrain'].append(g['sessions'][-1]['run']['turns']); tu['fs'].append(f['sessions'][-1]['run']['turns'])
        if g['stop'] == 'turn_cap': div['turn budget (turn cap)'] += 1; continue
        if not g['score']['submitted']: div[f'not submitted ({g["stop"]})'] += 1; continue
        mine = [x for x in items_out if x['cell'] == (m, 'gbrain', t)]
        for x in mine:
            if x['seen'] is False: div['search miss: deciding document never returned'] += 1
            elif not x.get('shown'):
                div[f'deciding document returned but its deciding sentence never shown, answered class {x["cls"]}'] += 1
                if x.get('clipped'): div['  of these, a result naming the document was clipped in the transcript (shown status uncertain)'] += 1
            else: div[f'deciding sentence shown, answered class {x["cls"]}'] += 1
            detail[(x['item_variant'].split(':')[0], x['cls'], x['seen'])] += 1
            it = tk['gold']['items'][x['item']]
            ev = [d for d in tk['gold']['evidence'] if d in ent_docs.get(it['account'], set())]
            L = max(len(docs[d]['body']) for d in ev)
            opened = any(x2['name'] == 'get_page' and any(d in json.dumps(x2['args']) for d in ev) for x2 in g['tools'])
            evlen[('long' if L >= 20_000 else 'short', 'seen' if x['seen'] else 'never returned')] += 1
            if L >= 20_000: evrange.append(L)
            gp_ev += opened
        for n, it in enumerate(tk['gold']['items']):
            ex = [d for d in tk['relevant'] if d in ent_docs.get(it['account'], set()) and docs[d]['type'] in ('contract', 'amendment') and 'Executed' in docs[d]['body']]
            if ex: exec_seen.append(sum(1 for d in ex if d in gb) / len(ex))
    for k, v in div.most_common(): print(f'- {k}: {v}')
    print(f"- deciding document length by outcome: {dict(evlen)}; long ones {min(evrange) if evrange else '-'}..{max(evrange) if evrange else '-'} characters; failed items whose deciding document was opened with get_page: {gp_ev}")
    print('- failed items by (variant, class, deciding doc seen):', {f'{a}/{b}/{c}': n for (a, b, c), n in detail.most_common()})
    if exec_seen: print(f'- executed contract and amendments of each item seen by gbrain in those cells: mean {statistics.mean(exec_seen):.2f}, all seen in {sum(1 for x in exec_seen if x == 1)}/{len(exec_seen)} items')
    if tc['gbrain']: print(f"- tool calls on those cells: gbrain median {statistics.median(tc['gbrain'])}, fs median {statistics.median(tc['fs'])}; turns: gbrain median {statistics.median(tu['gbrain'])}, fs median {statistics.median(tu['fs'])}")
    # card coverage: did an entity or context_pack result list the evidence doc?
    card = [0, 0]
    for t, m in fs_only:
        g = R[(m, 'gbrain', t)]; tk = tasks[t]
        cards = ' '.join((x['result'] or '') for x in g['tools'] if x['name'] in ('entity', 'context_pack'))
        for it in tk['gold']['items']:
            ev = [d for d in tk['gold']['evidence'] if d in ent_docs.get(it['account'], set())]
            if ev: card[1] += 1; card[0] += any(d in cards for d in ev)
    print(f'- deciding document listed by an entity or context_pack result: {card[0]}/{card[1]} items in those cells')
    st = collections.Counter()
    for (m, A, t), r in R.items():
        if A != 'gbrain' or not t.startswith('H4'): continue
        tk = tasks[t]
        for it in tk['gold']['items']:
            own = ent_docs.get(it['account'], set()); ev = [d for d in tk['gold']['evidence'] if d in own]
            for x in r['tools']:
                if x['name'] not in ('entity', 'context_pack', 'get_backlinks'): continue
                res = x['result'] or ''
                ids = set(re.findall(r'(?:contracts|mail|crm|notes)/[\w/.-]+', res)) & own
                if ids: st[(x['name'], 'lists own docs')] += 1; st[(x['name'], 'own ids')] += len(ids); st[(x['name'], 'lists deciding doc')] += any(d in res for d in ev)
    print('- all gbrain H4 cells, results that list documents of an asked account: ' + '; '.join(
        f"{n}: {st[(n, 'lists own docs')]} results, {st[(n, 'own ids')] / max(1, st[(n, 'lists own docs')]):.1f} of the account's documents each, deciding document in {st[(n, 'lists deciding doc')]}" for n in ('context_pack', 'get_backlinks', 'entity')))
    gp = [0, 0, 0]
    for (m, A, t), r in R.items():
        if A != 'gbrain' or not t.startswith('H4'): continue
        for x in r['tools']:
            a = x['args'] if isinstance(x['args'], dict) else {}
            d = docs.get(a.get('slug') or a.get('id') or '')
            if x['name'] != 'get_page' or not d or len(d['body']) < 20_000: continue
            dec = [z for z in re.split(r'(?<=\.)\s+|\n', d['body']) if z.startswith('Effective ') or ' under this agreement is ' in z]
            gp[0] += 1; gp[1] += any(norm(z) in norm(x['result'] or '') for z in dec); gp[2] += len(x['result'] or '') >= TRANSCRIPT_CAP
    print(f'- gbrain get_page calls on documents over 20,000 characters in H4: {gp[0]}, deciding sentence in the result {gp[1]}, clipped in the transcript {gp[2]}')
    print(f"- accounts asked in H4: median {statistics.median([len(ent_docs.get(it['account'], ())) for t in h4 for it in tasks[t]['gold']['items']])} documents each")
    h4calls = {A: [len(r['tools']) for (m, AA, t), r in R.items() if AA == A and t.startswith('H4')] for A in ('gbrain', 'fs')}
    print(f"- all H4 cells: tool calls median gbrain {statistics.median(h4calls['gbrain'])}, fs {statistics.median(h4calls['fs'])}")
    search_kw = collections.Counter()
    for t, m in fs_only:
        for x in R[(m, 'gbrain', t)]['tools']:
            if x['name'] == 'search':
                a = x['args'] if isinstance(x['args'], str) else json.dumps(x['args'])
                search_kw['keyword' if 'keyword' in a else 'hybrid'] += 1
                search_kw['types filter' if 'types' in a else 'no types filter'] += 1
                search_kw['date filter' if re.search(r'"(since|until|after|before|date)', a) else 'no date filter'] += 1
    print(f'- gbrain search calls in those cells: {dict(search_kw)}')

    # 4. headroom
    print('\n## 4. Paired cells by family (same model and task)')
    print('\n| Family | gbrain wins, fs loses | fs wins, gbrain loses | both | neither |')
    print('|---|---|---|---|---|')
    pair = {}
    for fam in FAMS:
        gw = fw = bo = ne = 0
        for (m, A, t), r in R.items():
            if A != 'gbrain' or not t.startswith(fam) or (m, 'fs', t) not in R: continue
            gs, fs_ = r['score']['success'], R[(m, 'fs', t)]['score']['success']
            gw += gs and not fs_; fw += fs_ and not gs; bo += gs and fs_; ne += (not gs) and (not fs_)
        pair[fam] = (gw, fw, bo, ne)
        print(f'| {fam} | {gw} | {fw} | {bo} | {ne} |')
    npairs = sum(sum(v) for v in pair.values())
    gtot = sum(v[0] + v[2] for v in pair.values()); ftot = sum(v[1] + v[2] for v in pair.values())
    print(f'\npooled successes: gbrain {gtot}/{npairs}, fs {ftot}/{npairs}, difference {100 * (gtot - ftot) / npairs:+.1f} points; by family gbrain/fs: ' + ', '.join(f'{f} {v[0] + v[2]}/{v[1] + v[2]}' for f, v in pair.items()))
    SUMMARY[name] = {'cells': cells, 'items': items_out, 'pair': pair, 'npairs': npairs}
    return cells, items_out, pair, npairs, R


def headroom(name, cells, items, npairs, R):
    print(f'\n## Headroom ceiling on {name}')
    nm = len(MODELS)
    g_fail = [c for c in cells.values() if c['A'] == 'gbrain' and not c['success']]
    by_cause = collections.Counter()
    for c in g_fail:
        if c['stop'] == 'turn_cap' or (not c['submitted']): by_cause['turn cap or no answer'] += 1; continue
        cl = set(c['classes']) or {'f'}
        by_cause['+'.join(sorted(cl))] += 1
    print('gbrain failed cells by cause (a cell with mixed item classes is listed under its combination):', dict(by_cause.most_common()))
    return by_cause


M = analyze('World M', f'{WORK}/mworld/world/world.json', [f'{WORK}/confirm/main/cells'])
DEV = analyze('Development world', f'{WORK}/r3/world.json', [f'{WORK}/r3-out/dev-r5-opus', f'{WORK}/r3-out/dev-r5-sonnet', f'{WORK}/r3-out/dev-r5-gpt', f'{WORK}/r3-out/dev-r4-fs'])
hm = headroom('World M', M[0], M[1], M[3], M[4])
hd = headroom('Development world', DEV[0], DEV[1], DEV[3], DEV[4])


def ceiling(name, cells, causes_fixed):
    """Ceiling gain on pooled Δ if every gbrain cell whose failure is only those causes became a success."""
    ntask = len({c['task'] for c in cells.values()})
    fixed = matched = 0
    for c in cells.values():
        if c['A'] != 'gbrain' or c['success']: continue
        cause = {'T'} if (c['stop'] == 'turn_cap' or not c['submitted']) else (set(c['classes']) or {'f'})
        if cause <= causes_fixed:
            fixed += 1
            f = cells.get((c['model'], 'fs', c['task']))
            matched += bool(f and f['success'])
    per_model = len(MODELS) * ntask
    return fixed, matched, 100 * fixed / per_model, 100 * matched / per_model


print('\n## Ceiling gains (points of pooled gbrain − fs, every listed cause fixed in every cell where it is the only cause)')
for label, causes in [('turn cap or no answer (T)', {'T'}), ('superseded/older value (a, a_future)', {'a', 'a_future'}), ('lower-authority or agent-note (g, e)', {'g', 'e'}),
                      ('set/count (c)', {'c'}), ('entity confusion (b)', {'b'}), ('T + a', {'T', 'a', 'a_future'}), ('T + c', {'T', 'c'}), ('a + g/e', {'a', 'a_future', 'g', 'e'})]:
    for nm_, data in (('M', M), ('dev', DEV)):
        fixed, matched, pts, mpts = ceiling(nm_, data[0], causes)
        print(f'- {label} on {nm_}: {fixed} cells (+{pts:.1f} points ceiling); {matched} of them where fs succeeded (+{mpts:.1f} points, fs-matched bound)')

if OUT:
    json.dump({k: {'pair': v['pair'], 'items': v['items']} for k, v in SUMMARY.items()}, open(OUT, 'w'), indent=1, default=str)
