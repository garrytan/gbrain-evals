"""Candidate 1 vs the fresh master arm: failure classes, the reader's route, tokens, latency and dollars per reader.

Inputs (committed beside this script): master/ and candidate-1/ results.jsonl.gz and usage.jsonl.gz; the task gold
(champion, correcting pages, stale patterns) is ../root-cause/gold.json. Failure classes use the root-cause
classifier's rules (contact, terms, date, hop, namesake).

  python3 docs/benchmarks/2026-10-08-program-primary-hard/candidate-1-newer-mentions/analyze.py [--out route.json]
  python3 .../analyze.py --arms fresh-seeds --gold gold-fresh.json [--out fresh-seeds/route.json]   # fresh-seed check
"""
import collections, gzip, json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
opt = lambda name, default: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
ARMS = os.path.join(HERE, opt('--arms', '.'))
GOLD = json.load(open(os.path.join(HERE, opt('--gold', os.path.join('..', 'root-cause', 'gold.json')))))
READERS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']


def jsonl(path):
    return [json.loads(l) for l in gzip.open(path, 'rt') if l.strip()]


def classes(cell):
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


def calls(usage, key):
    rs = sorted((r for r in usage.get(key, []) if r['question_id'].endswith(':s2')), key=lambda r: r['attempt'])
    out = []
    for r in rs:
        for blk in re.split(r'\n(?=\[tool_use )', str(r.get('answer') or '')):
            m = re.match(r'^\[tool_use (\w+)\] ([\s\S]*)$', blk)
            if not m or m.group(1) == 'submit_answer': continue
            try: args = json.loads(m.group(2).strip())
            except Exception: args = {}
            out.append((m.group(1), args if isinstance(args, dict) else {}))
    return out


def names_champion(g, value):
    v = str(value or '').lower()
    return g['champion'].lower() in v or g['champion_slug'] in v


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, math.ceil(q * len(xs)) - 1))] if xs else 0


def arm(name):
    cells = [c for c in jsonl(os.path.join(ARMS, name, 'results.jsonl.gz')) if c['arm'] == 'baseline']
    usage = collections.defaultdict(list)
    for r in jsonl(os.path.join(ARMS, name, 'usage.jsonl.gz')): usage[r['cell']].append(r)
    rows = {}
    for reader in READERS:
        cs = [c for c in cells if c['reader'] == reader]
        cls = collections.Counter(k for c in cs for k in set(classes(c)))
        route = collections.Counter()
        for c in cs:
            g, k = GOLD[c['task']], calls(usage, c['key'])
            ent = any(n == 'entity' and names_champion(g, a.get('name')) for n, a in k)
            pack = any(n == 'context_pack' and names_champion(g, a.get('entities')) for n, a in k)
            route['entity_on_champion'] += ent
            route['context_pack_on_champion'] += pack
            route['neither'] += not (ent or pack)
            f = set(classes(c))
            if not ent and ('contact' in f or 'date' in f): route['contact_or_date_failed_without_entity'] += 1
            if ent and ('contact' in f or 'date' in f): route['contact_or_date_failed_with_entity'] += 1
            for cl in ('contact', 'date', 'terms'):
                if any(n == 'get_page' and a.get('slug') == g['docs'][cl] for n, a in k): route[f'opened_{cl}_page'] += 1
            route['tool_calls'] += len(k)
        s2 = [c['sessions'][1]['wall_ms'] for c in cs]
        rows[reader] = {
            'runs': len(cs), 'failures': sum(c['score']['failed'] for c in cs), 'classes': dict(cls), 'route': dict(route),
            'mean_input_tokens': sum(c['tokens']['input_total'] for c in cs) / len(cs),
            'mean_output_tokens': sum(c['tokens']['output_total'] for c in cs) / len(cs),
            'p95_session2_ms': pct(s2, 0.95), 'mean_usd': sum(c['usd']['total'] for c in cs) / len(cs),
        }
    return rows


def main():
    m, c = arm('master'), arm('candidate-1')
    out = {'master': m, 'candidate_1': c, 'envelope': {}}
    for r in READERS:
        out['envelope'][r] = {
            'p95_session2_latency_x': c[r]['p95_session2_ms'] / m[r]['p95_session2_ms'],
            'mean_tokens_x': (c[r]['mean_input_tokens'] + c[r]['mean_output_tokens']) / (m[r]['mean_input_tokens'] + m[r]['mean_output_tokens']),
            'mean_usd_x': c[r]['mean_usd'] / m[r]['mean_usd'],
        }
        print(r)
        for name, a in (('master', m), ('candidate-1', c)):
            x = a[r]
            print(f"  {name:12} fail {x['failures']:2}/{x['runs']}  classes {x['classes']}  route {x['route']}  in {x['mean_input_tokens']:.0f}  p95 {x['p95_session2_ms']/1000:.1f}s  ${x['mean_usd']:.3f}")
        e = out['envelope'][r]
        print(f"  envelope: p95 {e['p95_session2_latency_x']:.2f}x  tokens {e['mean_tokens_x']:.2f}x  usd {e['mean_usd_x']:.2f}x")
    if '--out' in sys.argv: json.dump(out, open(sys.argv[sys.argv.index('--out') + 1], 'w'), indent=1)


if __name__ == '__main__':
    main()
