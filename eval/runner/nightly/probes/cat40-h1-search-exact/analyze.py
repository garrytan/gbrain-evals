#!/usr/bin/env python3
"""Pairs the probe's Cat 40 H1 episodes with the 2026-11-10 master rows (same reader, item and trial) and writes the
README's comparison: pass rates with a paired item-bootstrap interval and exact McNemar, turn-cap stops, search_exact
use and the turn of its first call, gold pages, refusals and tool errors, and cost per episode.

  python3 analyze.py --probe <probe night dir> --baseline <2026-11-10 master by-suite/cat40-hard-m.jsonl.gz> --out <dir>

The probe night dir is <out>/<night>/<sha12> from probe.sh; its suites/cat40-hard-m/cells holds attempts.jsonl and
gbrain-call-turns.jsonl. Standard library only."""
import argparse, gzip, json, math, os, random, statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta

READERS = ['claude-opus-5-5', 'gpt-6.1-sol']
SEED, RESAMPLES = 20261111, 10_000


def rows(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt', encoding='utf8') as f:
        return [json.loads(l) for l in f if l.strip()]


def h1(rs):
    return {(r['reader'], r['item'], r['trial']): r for r in rs if r.get('suite') == 'cat40-hard-m' and str(r.get('item', '')).startswith('H1-')}


def when(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def first_turns(cells_dir):
    """(reader, item, trial) -> list of (tool, turn) for the clean attempt, joined to the call-turn log by slot and time."""
    attempts_path, log_path = os.path.join(cells_dir, 'attempts.jsonl'), os.path.join(cells_dir, 'gbrain-call-turns.jsonl')
    if not (os.path.exists(attempts_path) and os.path.exists(log_path)):
        return {}, 'no call-turn log'
    log = defaultdict(list)
    for line in open(log_path, encoding='utf8'):
        if line.strip():
            e = json.loads(line)
            log[e['slot']].append((when(e['at']), e['tool'], e['turn']))
    out, unmatched = {}, 0
    for line in open(attempts_path, encoding='utf8'):
        if not line.strip():
            continue
        a = json.loads(line)
        if a.get('stop') == 'harness_error' or not str(a.get('task', '')).startswith('H1-'):
            continue
        names = [c['name'] for s in a.get('sessions', []) for c in s['run'].get('tool_calls', [])]
        t0 = when(a['started_at']); t1 = t0 + timedelta(milliseconds=a['wall_ms'])
        found = None
        for slot, events in log.items():
            inside = [(tool, turn) for at, tool, turn in events if t0 <= at <= t1]
            if [t for t, _ in inside] == names:
                found = inside
                break
        if found is None:
            unmatched += 1
            continue
        out[(a['model'], a['task'], a['repeat'] + 1)] = found
    return out, f'{unmatched} clean H1 attempts not matched to the log'


def members(s):
    try:
        v = json.loads(s) if s else None
    except (TypeError, ValueError):
        return None
    return {str(x).strip().lower() for x in v} if isinstance(v, list) else None


def wrong_kind(r):
    """How a submitted wrong H1 answer was wrong: a count above or below the gold count, a list with extra or missing
    accounts (against each gold account's first name; the scorer also takes aliases), or no answer."""
    ans, exp = (r.get('answer') or '').strip(), (r.get('expected') or '').strip()
    if ans.upper() in ('UNKNOWN', 'NOT_ACCESSIBLE', ''):
        return 'no_answer'
    if exp.isdigit():
        try:
            n = int(ans.replace(',', ''))
        except ValueError:
            return 'count_unparsed'
        return 'count_over' if n > int(exp) else 'count_under' if n < int(exp) else 'count_equal_but_failed'
    got, want = members(ans), members(exp)
    if got is None or want is None:
        return 'list_unparsed'
    extra, missing = bool(got - want), bool(want - got)
    return 'list_extra_and_missing' if extra and missing else 'list_extra' if extra else 'list_missing' if missing else 'list_equal_but_failed'


def describe(rs, turns=None):
    n = len(rs)
    se = [sum(1 for c in (r.get('calls') or []) if c['name'] == 'search_exact') for r in rs]
    pos = [next((i + 1 for i, c in enumerate(r.get('calls') or []) if c['name'] == 'search_exact'), None) for r in rs]
    errs = [e for r in rs for e in r.get('tool_errors') or []]
    gold = [r.get('gold_count') or 0 for r in rs]
    named = [len(r.get('searched_gold') or []) for r in rs]
    cited = [len(r['evidence'].get('evidence_cited') or []) for r in rs]
    d = {
        'episodes': n, 'pass': sum(1 for r in rs if r['pass']), 'pass_rate': sum(1 for r in rs if r['pass']) / n if n else None,
        'stops': dict(Counter(r.get('stop') for r in rs)), 'turn_cap': sum(1 for r in rs if r.get('stop') == 'turn_cap'),
        'harness_rows': sum(1 for r in rs if r.get('harness')),
        'search_exact_calls_per_episode': sum(se) / n if n else None, 'episodes_calling_search_exact': sum(1 for x in se if x),
        'first_search_exact_call_position': {'median': statistics.median([p for p in pos if p]) if any(pos) else None, 'values': sorted(p for p in pos if p)},
        'gold_needed_mean': sum(gold) / n if n else None, 'gold_named_in_results_mean': sum(named) / n if n else None,
        'gold_cited_mean': sum(cited) / n if n else None, 'gold_named_share': sum(named) / sum(gold) if sum(gold) else None,
        'gold_cited_share': sum(cited) / sum(gold) if sum(gold) else None,
        'episodes_with_every_gold_named': sum(1 for r in rs if r.get('retrieved') == 'all'),
        'tool_errors': len(errs), 'refusals': sum(1 for e in errs if e.get('refused')),
        'tool_errors_by_tool_code': dict(Counter(f"{e.get('tool')}:{e.get('code') or (e.get('message') or '')[:40]}" for e in errs).most_common(12)),
        'cost_usd_total': sum(r.get('cost_usd') or 0 for r in rs), 'cost_usd_per_episode': sum(r.get('cost_usd') or 0 for r in rs) / n if n else None,
    }
    d['submitted_wrong'] = dict(Counter(wrong_kind(r) for r in rs if not r['pass'] and r.get('stop') == 'submitted'))
    if turns is not None:
        ft = [next((turn for tool, turn in turns[k] if tool == 'search_exact'), None) for k in turns]
        d['first_search_exact_turn'] = {'matched_episodes': len(turns), 'calling': sum(1 for t in ft if t is not None),
            'median': statistics.median([t for t in ft if t is not None]) if any(t is not None for t in ft) else None,
            'distribution': dict(sorted(Counter(t for t in ft if t is not None).items()))}
    return d


def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def paired(pairs):
    """pairs: list of (item, base_pass, probe_pass)."""
    by_item = defaultdict(list)
    for item, b, p in pairs:
        by_item[item].append((b, p))
    items = sorted(by_item)
    diff = lambda ps: (sum(p for _, p in ps) - sum(b for b, _ in ps)) / len(ps)
    rng = random.Random(SEED)
    boots = sorted(diff([x for it in (rng.choice(items) for _ in items) for x in by_item[it]]) for _ in range(RESAMPLES))
    gains = sum(1 for _, b, p in pairs if not b and p); losses = sum(1 for _, b, p in pairs if b and not p)
    return {'pairs': len(pairs), 'base_pass': sum(b for _, b, _ in pairs), 'probe_pass': sum(p for *_, p in pairs),
            'difference': diff([(b, p) for _, b, p in pairs]), 'ci95_item_bootstrap': [boots[int(0.025 * RESAMPLES)], boots[int(0.975 * RESAMPLES) - 1]],
            'fail_to_pass': gains, 'pass_to_fail': losses, 'mcnemar_exact_p': mcnemar(gains, losses),
            'base_failures': sum(1 for _, b, _ in pairs if not b)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', required=True); ap.add_argument('--baseline', required=True); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    probe = h1(rows(os.path.join(a.probe, 'by-suite', 'cat40-hard-m.jsonl.gz')))
    base = h1(rows(a.baseline))
    turns, turn_note = first_turns(os.path.join(a.probe, 'suites', 'cat40-hard-m', 'cells'))
    keys = sorted(set(probe) & set(base))
    unpaired = {'probe_only': sorted(map(list, set(probe) - set(base))), 'baseline_only': sorted(map(list, set(base) - set(probe)))}
    scored = [k for k in keys if not probe[k].get('harness') and not base[k].get('harness')]
    res = {'pairs': len(keys), 'scored_pairs': len(scored), 'unpaired': unpaired, 'call_turn_join': turn_note,
           'probe_sha': next(iter(probe.values()))['sha'] if probe else None, 'probe_suite_digest': sorted({r['suite_digest'] for r in probe.values()}),
           'baseline_suite_digest': sorted({r['suite_digest'] for r in base.values()}), 'by_reader': {}}
    for scope in READERS + ['pooled']:
        ks = [k for k in scored if scope == 'pooled' or k[0] == scope]
        tk = {k: turns[k] for k in ks if k in turns}
        res['by_reader'][scope] = {
            'paired': paired([(k[1], bool(base[k]['pass']), bool(probe[k]['pass'])) for k in ks]),
            'baseline': describe([base[k] for k in ks]), 'probe': describe([probe[k] for k in ks], tk),
        }
    pooled = res['by_reader']['pooled']['paired']
    res['clears_most_failures'] = pooled['fail_to_pass'] >= 38 and pooled['ci95_item_bootstrap'][0] > 0
    res['per_item'] = {item: {r: {'baseline': [int(base[(r, item, t)]['pass']) for t in (1, 2, 3) if (r, item, t) in base],
                                  'probe': [int(probe[(r, item, t)]['pass']) for t in (1, 2, 3) if (r, item, t) in probe],
                                  'probe_stops': [probe[(r, item, t)]['stop'] for t in (1, 2, 3) if (r, item, t) in probe],
                                  'gold': base.get((r, item, 1), probe.get((r, item, 1), {})).get('gold_count')} for r in READERS}
                       for item in sorted({k[1] for k in keys})}
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'summary.json'), 'w', encoding='utf8') as f:
        json.dump(res, f, indent=1, default=list)
    print(json.dumps({s: {'paired': v['paired'], 'turn_cap': [v['baseline']['turn_cap'], v['probe']['turn_cap']]} for s, v in res['by_reader'].items()}, indent=1))
    print('clears_most_failures', res['clears_most_failures'], '|', turn_note)


if __name__ == '__main__':
    main()
