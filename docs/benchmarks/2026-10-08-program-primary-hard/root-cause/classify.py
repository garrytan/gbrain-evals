"""T0b root cause: classify every failed item of the v0.60.106.0 baseline, and tabulate the tool-call mechanisms.

Inputs (all committed beside this script or in ../baseline and ../candidate-0-master):
  gold.json                              per task: the champion, the three correction pages, the decisive line of each
  replay-live.jsonl.gz                   every recorded session-2 tool call of the 144 baseline cells, re-executed on a
                                         rebuilt v0.60.106.0 brain with reranking (repeat 1's condition)
  replay-dead-reranker-repeat2.jsonl.gz  the 72 repeat-2 cells re-executed with the Voyage endpoint dead (repeat 2's
                                         condition, see the report)

A failed item is one scored failure class: the superseded procurement contact (`contact`), stale terms (`terms`), the
old meeting date (`date`), the missed hop commitment (`hop`) or a namesake's value (`namesake`). For the first three:
  A  never returned: no session-2 tool result contained the correcting page or its decisive line;
  B  returned but outranked: the correcting page's slug came back but its decisive line did not reach the reader;
  C  present: the decisive line was in a tool result (or the page was opened), yet the answer kept the stale value;
  D  pushed stale: the session's hook output carried the stale value (checked separately; it never happened).

  python3 docs/benchmarks/2026-10-08-program-primary-hard/root-cause/classify.py [--out classification.json]
"""
import collections, gzip, json, os, re, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GOLD = json.load(open(os.path.join(HERE, 'gold.json')))
READERS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']
SLUG = re.compile(r'"slug"\s*:\s*"([^"]+)"')
norm = lambda s: re.sub(r'\s+', ' ', s)


def jsonl(path):
    return [json.loads(l) for l in gzip.open(path, 'rt') if l.strip()]


def classes(cell):
    """The failure classes of one scored cell."""
    g, sc, out = GOLD[cell['task']], cell['score'], []
    stale = sc['stale_correction_mentions']
    if 'stale_correction' in sc['kinds']:
        if any(re.search(p, m) for m in stale for p in g['stale']['contact']['patterns']): out.append('contact')
        if any(re.search(p, m, re.I) for m in stale for p in g['stale']['terms']['patterns']): out.append('terms')
    if 'stale_date' in sc['kinds']: out.append('date')
    if 'missed_commitment' in sc['kinds']:
        out += ['session1' if m == g['session1_commitment'] else 'hop' for m in sc['commitments_missed']]
    if 'unsupported' in sc['kinds']: out.append('namesake')
    if 'execution_error' in sc['kinds']: out.append('error')
    return out


def label(cell, replay):
    g = GOLD[cell['task']]
    labels = {}
    for cls in ('contact', 'date', 'terms'):
        slug, line = g['docs'][cls], g['decisive'][cls]
        opened = any(k['name'] == 'get_page' and (k['args'] or {}).get('slug') == slug for k in replay['s2'])
        listed = any(slug in SLUG.findall(k['result']) for k in replay['s2'] if k['name'] != 'get_page')
        seen = [k['name'] for k in replay['s2'] if line in norm(k['result'])]
        labels[cls] = 'C' if opened or seen else 'B' if listed else 'A'
    return labels


def entity_on_champion(cell, calls):
    g = GOLD[cell['task']]
    return any(k['name'] == 'entity' and (k['args'] or {}).get('name', '').lower() in (g['champion'].lower(), g['champion_slug']) for k in calls)


def main():
    cells = [c for c in jsonl(os.path.join(ROOT, 'baseline', 'results.jsonl.gz')) if c['arm'] == 'baseline']
    live = {r['key']: r for r in jsonl(os.path.join(HERE, 'replay-live.jsonl.gz'))}
    dead = {r['key']: r for r in jsonl(os.path.join(HERE, 'replay-dead-reranker-repeat2.jsonl.gz'))}
    rows, table, pushed = [], collections.Counter(), collections.Counter()
    for c in cells:
        g = GOLD[c['task']]
        hooks = '\n'.join(h['text'] for h in c['sessions'][1]['hooks'])
        for cls in ('contact', 'terms', 'date'):
            if any(re.search(p, hooks, re.I) for p in g['stale'][cls]['patterns']): pushed[(c['reader'], cls)] += 1
        replay = live[c['key']] if c['repeat'] == 1 else dead.get(c['key'], live[c['key']])
        lab = label(c, replay)
        for cls in classes(c):
            l = lab.get(cls, 'n/a')
            rows.append({'key': c['key'], 'reader': c['reader'], 'repeat': c['repeat'], 'class': cls, 'label': l,
                         'entity_on_champion': entity_on_champion(c, replay['s2'])})
            table[(c['reader'], c['repeat'], cls, l)] += 1
    print('failed items by reader, repeat, class and label')
    for k, v in sorted(table.items()): print(' ', k, v)
    print('stale value in the session-2 push:', dict(pushed) or 'never')
    cond = collections.Counter()
    for c in cells:
        e = entity_on_champion(c, live[c['key']]['s2'])
        f = set(classes(c))
        cond[(c['reader'], e, 'contact' in f, 'date' in f)] += 1
    print('runs by reader, entity(champion) called, contact failed, date failed')
    for k, v in sorted(cond.items()): print(' ', k, v)
    if '--out' in sys.argv:
        json.dump({'rows': rows, 'pushed_stale': {f'{a}|{b}': n for (a, b), n in pushed.items()}}, open(sys.argv[sys.argv.index('--out') + 1], 'w'), indent=1)


if __name__ == '__main__':
    main()
