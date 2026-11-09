#!/usr/bin/env python3
"""Reprice the other runners' published OpenAI cost figures for cache writes and the long-context tier (GST-1887).

Run from the repository root:

    python3 docs/audit/2026-11-09-openai-cache-writes/other-runners/reprice.py

It reads only files git tracks (eight of them at older commits, through git show), calls no provider and reads no
key. The harness-ledger figures come from running eval/runner/harness-ledger.ts with bun on copies of the plan in a
temporary directory, with every provider key blanked. It writes results.json next to this file, one figure per
line and nothing machine-specific, so a rerun on the same tree writes the same file. It then checks that each
corrected document still carries the wording the figure's doc_text lists, and exits 1 if any is missing.

Rule. OpenAI reports almost every uncached prompt token of a request of 1,024 tokens or more as a cache write, as
the committed rows that report the count show, and prices it at the cache-write rate. A runner that didn't read the
count under-priced those requests by (cache_write - input) x uncached tokens / 1e6. Above 272,000 input tokens OpenAI
prices the whole request at the long-context rates, so every figure records the largest request the committed data
shows or bounds. Prices are OpenAI's list prices (developers.openai.com/api/docs/pricing, read 2026-11-09).
"""
import gzip, json, math, os, re, subprocess, sys, tempfile
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
TOOL = str(Path(__file__).resolve().relative_to(ROOT))
B = 'docs/benchmarks'
LONG = 272_000
MIN_CACHE = 1024
CW = 'corrected 2026-11-09: cache writes were under-counted'
NR = 'not recomputed 2026-11-09'
PRICE = {
    'gpt-6.1-sol': {'input': 2.0, 'cached': 0.1, 'cache_write': 2.5, 'output': 10.0, 'long': {'input': 4.0, 'cached': 0.2, 'cache_write': 5.0, 'output': 15.0}},
    'gpt-6-sol': {'input': 2.0, 'cached': 0.2, 'cache_write': 2.5, 'output': 10.0, 'long': {'input': 4.0, 'cached': 0.4, 'cache_write': 5.0, 'output': 15.0}},
    'gpt-6-luna': {'input': 0.1, 'cached': 0.01, 'cache_write': 0.125, 'output': 0.5, 'long': {'input': 0.2, 'cached': 0.02, 'cache_write': 0.25, 'output': 0.75}},
    'gpt-6-astra': {'input': 10.0, 'cached': 1.0, 'cache_write': 12.5, 'output': 50.0, 'long': {'input': 20.0, 'cached': 2.0, 'cache_write': 25.0, 'output': 75.0}},
}
DELTA = {m: p['cache_write'] - p['input'] for m, p in PRICE.items()}
SHARE = {m: DELTA[m] / p['input'] for m, p in PRICE.items()}
reads, shown, results = set(), set(), []


def git(*a):
    r = subprocess.run(['git', '-C', str(ROOT), *a], capture_output=True, text=True)
    if r.returncode:
        sys.exit('git %s failed: %s' % (' '.join(a), r.stderr.strip()))
    return r.stdout


def show(commit, p):
    shown.add(commit + ':' + p)
    return git('show', '%s:%s' % (commit, p))


def text(p):
    reads.add(p)
    data = (ROOT / p).read_bytes()
    return (gzip.decompress(data) if p.endswith('.gz') else data).decode()


def j(p):
    return json.loads(text(p))


def jl(p):
    return [json.loads(l) for l in text(p).splitlines() if l.strip()]


def files(pattern):
    out = sorted(str(p.relative_to(ROOT)) for p in ROOT.glob(pattern))
    if not out:
        sys.exit('nothing matches ' + pattern)
    return out


def prem(model, uncached):
    return DELTA[model] * uncached / 1e6


def r6(x):
    return None if x is None else round(x, 6)


def pct(extra, base):
    return round(100 * extra / base)


def money(x, dig):
    return '$%.*f' % (dig, x)


def add(**kw):
    for k in ('published', 'recomputed', 'max_request_input', 'max_request_basis', 'ranking', 'detail', 'doc_text'):
        kw.setdefault(k, None)
    kw.setdefault('long_tier', 'below')
    results.append(kw)


def was(new, old):
    return '%s (%s; was %s)' % (new, CW, old)


def small_requests():
    d = B + '/2026-10-06-fence-repair-tier3'
    calls = [c for pat in ('results/gpt-6.1-sol-run*.jsonl', 'round-2/results/heldout-gpt-6.1-sol-run*.jsonl', 'round-2/results/fixtures-gpt-6.1-sol-run*.jsonl')
             for f in files(d + '/' + pat) for r in jl(f) for c in (r.get('calls') or [])]
    mx = max(c['input_tokens'] for c in calls)
    add(id='fence-repair', doc=d + '.md', model='gpt-6.1-sol', figure='Sol $ per repair', published='$0.0026 / $0.0023',
        status='NO MOVE' if mx < MIN_CACHE else 'CHECK', evidence='every Sol request is under 1,024 prompt tokens', max_request_input=mx, max_request_basis='rows')
    rows = jl(B + '/2026-10-06-takes-bootstrap-frontier/requests-gpt-6.1-sol.jsonl')
    mx = max(r['usage']['input_tokens'] for r in rows if r.get('usage'))
    add(id='takes-bootstrap', doc=B + '/2026-10-06-takes-bootstrap-frontier.md', model='gpt-6.1-sol', figure='Sol run', published='$0.174',
        status='NO MOVE' if mx < MIN_CACHE else 'CHECK', evidence='every request is under 1,024 prompt tokens; gpt-6-sol appears only in its price list',
        max_request_input=mx, max_request_basis='rows')
    d = B + '/2026-10-16-take-grading/results'
    rows = [r for f in [d + '/counted/gpt-6.1-sol.jsonl'] + files(d + '/dev/*/gpt-6.1-sol.jsonl') for r in jl(f)]
    mx = max(r.get('input_tokens') or 0 for r in rows)
    add(id='take-grading', doc=B + '/2026-10-16-take-grading.md', model='gpt-6.1-sol', figure='Sol per verdict', published='$0.0016',
        status='NO MOVE' if mx < MIN_CACHE else 'CHECK', evidence='every request is under 1,024 prompt tokens', max_request_input=mx, max_request_basis='rows')
    rows = [r for r in jl(B + '/2026-11-07-skill-ranker-offline/results/spend.jsonl') if r.get('key') == 'openai:gpt-6.1-sol']
    mx = max(r['usage']['input_tokens'] for r in rows)
    add(id='skill-ranker-offline', doc=B + '/2026-11-07-skill-ranker-offline.md', model='gpt-6.1-sol', figure='Sol writer spend', published=r6(sum(r['cost_usd'] for r in rows)),
        status='NO MOVE' if mx < MIN_CACHE else 'CHECK', evidence='every request is under 1,024 prompt tokens', max_request_input=mx, max_request_basis='rows')


def priced(rows, model_of, usage_of, usd_key):
    agg = defaultdict(Counter)
    for r in rows:
        m = model_of(r)
        u = usage_of(r) if m in PRICE else None
        if not u:
            continue
        un, cr, cw, out = u
        p = PRICE[m]
        a = agg[m]
        a['rows'] += 1
        a['priced_with_cache_writes'] += abs((r[usd_key] or 0) - (un * p['input'] + cr * p['cached'] + cw * p['cache_write'] + out * p['output']) / 1e6) < 1e-8
        a['max_request_input'] = max(a['max_request_input'], un + cr + cw)
    return {m: dict(a) for m, a in agg.items()}


def all_priced(det):
    return all(v['rows'] == v['priced_with_cache_writes'] for v in det.values())


def priced_runners():
    def ev(r):
        u = r.get('usage')
        return u and (u['input_uncached'], u.get('cache_read') or 0, u.get('cache_write') or 0, u['output_total'])
    for lane, parts in (('evidence-architecture-pilot', {'builds': 'builder', 'reads': 'model'}), ('evidence-brief-confirmation', {'reads': 'model'})):
        det = {}
        for f, k in parts.items():
            for m, v in priced(jl('%s/2026-10-08-%s/%s.ndjson.gz' % (B, lane, f)), lambda r, k=k: (r.get(k) or '').split(':')[-1], ev, 'usd').items():
                det['%s %s' % (f, m)] = v
        mx = max(v['max_request_input'] for v in det.values())
        add(id=lane, doc='%s/2026-10-08-%s.md' % (B, lane), model='gpt-6.1-sol, gpt-6-luna', figure='Sol and Luna reads and builds',
            status='NO MOVE' if all_priced(det) else 'CHECK', evidence='every OpenAI row prices its reported cache writes', detail=det,
            max_request_input=mx, max_request_basis='rows', long_tier='below' if mx <= LONG else 'CHECK')

    def a2(r):
        x = r.get('usage')
        if not x:
            return None
        d = x.get('prompt_tokens_details') or {}
        cr, cw = d.get('cached_tokens') or 0, d.get('cache_write_tokens') or 0
        return x['prompt_tokens'] - cr - cw, cr, cw, x['completion_tokens']
    rows = [r for f in files(B + '/2026-10-21-external-ideas-wave-a2/results/harm/rows/*gpt-6.1-sol*.ndjson.gz') for r in jl(f)]
    det = priced(rows, lambda r: r.get('model'), a2, 'list_usd')
    mx = max(v['max_request_input'] for v in det.values())
    add(id='external-ideas-wave-a2', doc=B + '/2026-10-21-external-ideas-wave-a2.md', model='gpt-6.1-sol', figure='Sol harm check', published='$13.14',
        status='NO MOVE' if all_priced(det) else 'CHECK', evidence='list_usd prices cache writes on every Sol row', detail=det,
        max_request_input=mx, max_request_basis='rows', long_tier='below' if mx <= LONG else 'CHECK')
    codex()

    d = j(B + '/2026-11-01-skillopt-rebaseline/receipts/metered-cost.json')
    s = d['slots']['cat32']['by_model']['openai:gpt-6.1-sol']
    add(id='skillopt-rebaseline Cat 32', doc=B + '/2026-11-01-skillopt-rebaseline/PREREGISTRATION.md', model='gpt-6.1-sol', figure='Metered Sol judge share', published='$0.0242',
        status='NO MOVE', evidence='metered through the budget ledger, which prices cache writes and the long-context tier (8a8e502a and later)',
        detail={'usd': s['usd'], 'at_plain_input_and_output': r6((s['input_tokens'] * 2 + s['output_tokens'] * 10) / 1e6)}, long_tier='priced by the ledger')

    det = {}
    for c in ('73524d0d', '6c28f2d3', '1269f0f4', 'ca091617', 'b8731941'):
        src = show(c, 'eval/runner/budget-ledger.ts')
        det[c] = {'reads_cache_write_tokens': 'cache_write_tokens' in src, 'long_tier': 'above_input_tokens' in src}
    rec = {}
    for f in ('prefs-gpt-6.1-sol', 'prefs-v2-gpt-6.1-sol', 'cat37-relay-origin-gpt-62773f02', 'cat37-relay-plain-gpt-62773f02'):
        c = j('%s/2026-10-08-memory-trust/paid/%s.receipt.json' % (B, f))['cost']
        rec[f] = {'usd': c['usd'], 'mean_request_input': round(c['input_tokens'] / requests(c))}
    add(id='memory-trust prefs and relay GPT', doc=B + '/2026-10-08-memory-trust-results-paid.md', model='gpt-6.1-sol', figure='Preference, preference v2 and relay GPT cells',
        published='$3.12, $2.50, $2.14 + $2.12', status='NO MOVE' if all(v['reads_cache_write_tokens'] for k, v in det.items() if k in ('ca091617', 'b8731941')) else 'CHECK',
        evidence='settled by runner commits ca091617 and b8731941, whose budget ledger reads cache writes and prices the long-context tier',
        detail={'commits': det, 'receipts': rec}, long_tier='priced by the ledger')


def requests(cost):
    return int(cost['basis'].split(': ')[1].split()[0])


def codex():
    """Codex resends an append-only conversation, so each request contains the one before it and its cached part is at
    most the previous request. The last request is then the largest, and over n requests with total input T and new
    (uncached or cache-written) input N it is at most T / n + N. A tool call that uses text first seen in an earlier
    call's result needs another request, and the answer after the last call needs one more, so the longest such chain
    plus one is a lower bound on n."""
    tok = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_./-]{5,}')
    for lane, pub in (('2026-10-24-brain-first-install-block', '$12.21'), ('2026-10-24-spring-loaded-skills', '$10.12')):
        d = '%s/%s' % (B, lane)
        rows = jl(d + '/results/codex.jsonl')
        prompts = {t['id']: t['prompt'] for t in j(d + '/tasks.json')['tasks']} if (ROOT / d / 'tasks.json').exists() else {}

        def cu(r):
            x = r['usage']
            return x['input'] - x['cache_read'] - x['cache_write'], x['cache_read'], x['cache_write'], x['output']
        det = priced([dict(r, model='gpt-6.1-sol') for r in rows], lambda r: r['model'], cu, 'cost_usd')
        bound, over = 0, []
        for r in rows:
            u = r['usage']
            T, N = u['input'], u['input'] - u['cache_read']
            seen, rounds = prompts.get(r['task'], ''), []
            for k, c in enumerate(r['calls']):
                new = set(tok.findall(c['args'])) - set(tok.findall(seen))
                rounds.append(1 + max((rounds[i] for i in range(k) if any(t in r['calls'][i]['result'] for t in new)), default=0))
                seen += ' ' + c['args']
            n = (max(rounds) if rounds else 0) + 1
            b = min(T, math.floor(T / n + N))
            bound = max(bound, b)
            if T > LONG:
                over.append({'trial': r['trial_id'], 'input_total': T, 'new_input': N, 'tool_calls': len(r['calls']), 'requests_at_least': n, 'largest_request_at_most': b})
        add(id=lane + ' Codex', doc=d + '.md', model='gpt-6.1-sol', figure='Codex gpt-6.1-sol spend', published=pub, recomputed=pub,
            status='NO MOVE' if all_priced(det) else 'CHECK', evidence='Codex reports cache writes and every row prices them; run.ts has no long-context tier',
            detail={'rows': det, 'runs_over_272k_in_total': over}, max_request_input=bound,
            max_request_basis='upper bound from run totals and call dependencies (largest run total %d)' % max(r['usage']['input'] for r in rows),
            long_tier='below' if bound <= LONG else 'CHECK')


def n2():
    d = B + '/2026-10-06-n2-judges'
    sc = {m['model']: m for m in j(d + '/score.json')['models']}
    o = {}
    for m in ('gpt-6.1-sol', 'gpt-6-luna'):
        jd = j('%s/judge-%s.json' % (d, m))
        ins = [x['input_tokens'] for x in jd['results'] if x.get('input_tokens')]
        p = prem(m, sum(i for i in ins if i >= MIN_CACHE))
        usd = jd['cost']['usd']
        o[m] = {'requests_with_usage': len(ins), 'at_or_over_1024': sum(i >= MIN_CACHE for i in ins), 'max_input': max(ins), 'premium': r6(p), 'usd': usd,
                'per_1000': round(sc['openai:' + m]['cost_per_1000_judged_pairs'], 4), 'per_1000_new': round((usd + p) / jd['judged'] * 1000, 4)}
    s, l = o['gpt-6.1-sol'], o['gpt-6-luna']
    ln, sn = '$%.2f' % l['per_1000_new'], '$%.2f' % s['per_1000_new']
    tot, lp, sp = pct(s['premium'] + l['premium'], 25.52), pct(l['premium'], l['usd']), pct(s['premium'], s['usd'])
    doc = d + '.md'
    add(id='n2 luna per 1000', doc=doc, model='gpt-6-luna', figure='GPT-6 Luna cost per 1,000 judged pairs (title, finding, table)', published='$0.21', recomputed=ln,
        status='MOVES', evidence='%d of %d judged prompts are 1,024 tokens or more; the run priced them as input' % (l['at_or_over_1024'], l['requests_with_usage']), detail=l,
        max_request_input=l['max_input'], max_request_basis='rows', ranking='unchanged: Luna stays the cheapest model that passes',
        doc_text=['costs %s per 1,000 pairs (%s; was $0.21)' % (ln, CW), '**`gpt-6-luna` at %s per 1,000 judged pairs** (%s; was $0.21)' % (ln, CW), '| **%s** (%s; was $0.21) |' % (ln, CW)])
    add(id='n2 sol per 1000', doc=doc, model='gpt-6.1-sol', figure='GPT-6.1 Sol cost per 1,000 judged pairs', published='$2.69', recomputed=sn, status='MOVES',
        evidence='%d of %d judged prompts are 1,024 tokens or more' % (s['at_or_over_1024'], s['requests_with_usage']), detail=s,
        max_request_input=s['max_input'], max_request_basis='rows', doc_text=[was(sn, '$2.69')])
    add(id='n2 spend', doc=doc, model='gpt-6.1-sol, gpt-6-luna', figure='Spend for five models; Luna; Sol', published='$25.52; $0.16; $1.99',
        recomputed='%d%% low; %d%% low; %d%% low' % (tot, lp, sp), status='MOVES', evidence='as above', max_request_input=s['max_input'], max_request_basis='rows',
        doc_text=['so the total is about %d%% low, Luna\'s figure about %d%% low and GPT-6.1 Sol\'s about %d%% low' % (tot, lp, sp), 'so the GPT-6 Luna figure is about %d%% low' % lp])
    add(id='todos n2', doc='TODOS.md', model='gpt-6.1-sol, gpt-6-luna', figure='N2 entry: spend; cheapest passing cost per 1,000 pairs', published='$25.52; $0.21',
        recomputed='%d%% low; %s' % (tot, ln), status='MOVES', evidence='as the N2 report', max_request_input=s['max_input'], max_request_basis='rows',
        doc_text=['($25.52, %s, so this is about %d%% low;' % (CW, tot), '%s per 1,000 pairs (%s; was $0.21)' % (ln, CW)])


def content_repair():
    d = B + '/2026-10-09-content-repair-judgment'
    rows = [r for f in files(d + '/results/gpt-6.1-sol-run*.jsonl') for r in jl(f)]
    usd = sum(r['usd'] for r in rows)
    big = [r['input_tokens'] for r in rows if r['input_tokens'] >= MIN_CACHE]
    p = prem('gpt-6.1-sol', sum(big))
    new = '$%.4f' % ((usd + p) / len(rows))
    common = dict(model='gpt-6.1-sol', max_request_input=max(r['input_tokens'] for r in rows), max_request_basis='rows')
    add(id='content-repair per pair', doc=[d + '.md', d + '/summary.md'], figure='gpt-6.1-sol USD per pair (report table and summary.md)', published='$0.0022', recomputed=new,
        status='MOVES', evidence='%d of %d Sol pair runs are 1,024 tokens or more; every row is priced at the input rate' % (len(big), len(rows)),
        detail={'rows': len(rows), 'usd': r6(usd), 'premium': r6(p)}, ranking='unchanged: Sol stays the cheapest per pair', doc_text=[was(new, '$0.0022')], **common)
    add(id='content-repair spend', doc=d + '.md', figure='gpt-6.1-sol spend; spend for 432 pair runs', published='$0.31; $2.05',
        recomputed='%d%% low; %d%% low' % (pct(p, usd), pct(p, 2.05)), status='MOVES', evidence='as above',
        doc_text=['so Sol\'s figure is about %d%% low and the total about %d%% low' % (pct(p, usd), pct(p, 2.05))], **common)


def multi_source():
    d = B + '/2026-10-24-multi-source-scope-tools-list'
    arms, tot, mx = {}, defaultdict(lambda: [0.0, 0.0]), 0
    for s in ('starter', 'scope'):
        for r in jl('%s/results/%s.jsonl' % (d, s)):
            m = r['model']
            if m not in PRICE:
                continue
            u = r['usage']
            a = arms.setdefault('%s %s %s' % (m, s, r['arm']), Counter())
            a['n'] += 1
            a['usd'] += r['usd']
            a['premium'] += prem(m, u['input'])
            a['cache_write_recorded'] += u.get('cache_write') or 0
            tot[m][0] += r['usd']
            tot[m][1] += prem(m, u['input'])
            mx = max(mx, u['input'] + u['cache_read'] + (u.get('cache_write') or 0))
    common = dict(max_request_input=mx, max_request_basis='largest trial total, so an upper bound on any one request')
    s, a = tot['gpt-6.1-sol'], tot['gpt-6-astra']
    tp, spp, ap = pct(s[1] + a[1], 20.76), pct(s[1], s[0]), pct(a[1], a[0])
    add(id='multi-source spend', doc=[d + '.md', d + '/summary.md'], model='gpt-6.1-sol, gpt-6-astra', figure='Model spend over 964 trials; gpt-6.1-sol; gpt-6-astra',
        published='$20.76; $1.72; $4.72', recomputed='%d%% low; %d%% low; %d%% low' % (tp, spp, ap), status='MOVES',
        evidence='the Cat 40 agent loop records OpenAI cache writes as 0 and prices the uncached prompt as input',
        doc_text=['$20.76 over 964 counted trials (%s, so this is about %d%% low)' % (CW, tp), '$20.76 over 964 trials (%s, so this is about %d%% low)' % (CW, tp),
                  '$1.72 (%s, so this is about %d%% low)' % (CW, spp), '$4.72 (%s, so this is about %d%% low)' % (CW, ap)], **common)
    det = {k: {'n': v['n'], 'old': round(v['usd'] / v['n'], 4), 'new': round((v['usd'] + v['premium']) / v['n'], 4), 'cache_write_recorded': v['cache_write_recorded']}
           for k, v in sorted(arms.items()) if ' starter ' in k}
    keys = ('gpt-6.1-sol starter base', 'gpt-6.1-sol starter pr', 'gpt-6-astra starter base', 'gpt-6-astra starter pr')
    add(id='multi-source per trial', doc=d + '/summary.md', model='gpt-6.1-sol, gpt-6-astra', figure='USD per trial, base / PR: gpt-6.1-sol; gpt-6-astra',
        published='$%.4f / $%.4f; $%.4f / $%.4f' % tuple(det[k]['old'] for k in keys), recomputed='$%.4f / $%.4f; $%.4f / $%.4f' % tuple(det[k]['new'] for k in keys),
        status='MOVES', evidence='as above', detail=det, ranking='unchanged: Sol stays the cheapest per trial, and PR stays cheaper than base',
        doc_text=[was('$%.4f' % det[k]['new'], '$%.4f' % det[k]['old']) for k in keys], **common)
    add(id='multi-source budget ledger', doc=d + '.md', model='gpt-6.1-sol, gpt-6-astra', figure='Budget ledger total; spend before the counted runs', published='$31.59; $0.60',
        status='NO MOVE', evidence='the budget ledger priced cache writes', long_tier='priced by the ledger')


def skillopt_method():
    d = B + '/2026-11-01-skillopt-method'
    rec = j(d + '/probe/frontier/test-sol/receipt.json')
    pubs = {'query': ('0.033', '0.026'), 'briefing': ('0.16', '0.034'), 'fact-check': ('0.18', '0.036')}
    calls = inp = 0
    for s in rec['data']['probe']['skills']:
        new, det = [], {}
        for arm in ('seed', 'rewrite'):
            a = s['arms'][arm]
            c = a['cost']
            un = c['input_tokens'] - c['cache_read_tokens'] - c['cache_creation_tokens']
            calls, inp = calls + c['calls'], inp + c['input_tokens']
            v = (c['usd'] + prem('gpt-6.1-sol', un)) / a['correct_rollouts']
            new.append(money(v, len(pubs[s['skill']][len(new)].split('.')[1])))
            det[arm] = {'usd': r6(c['usd']), 'uncached': un, 'cache_creation_tokens': c['cache_creation_tokens'], 'correct': a['correct_rollouts'], 'per_correct_new': round(v, 5)}
        old = '$%s / $%s' % pubs[s['skill']]
        add(id='skillopt-method per correct ' + s['skill'], doc=d + '/REPORT.md', model='gpt-6.1-sol', figure='Sol $ per correct, %s seed / rewrite' % s['skill'],
            published=old, recomputed=' / '.join(new), status='MOVES', evidence='the meter reads gbrain\'s cache_creation_tokens, which is 0 on every Sol call',
            detail=det, max_request_basis='receipts give totals only (mean %d input tokens per call)' % (inp / calls),
            long_tier='below (inferred from the ceiling re-read rows: same harness and skills)', ranking='unchanged: Sol stays cheaper per correct than Opus', doc_text=[was(' / '.join(new), old)])
    pub = {'query': ('0.033', '0.032'), 'briefing': ('0.079', '0.048'), 'fact-check': ('0.091', '0.054')}
    f = defaultdict(dict)
    for run in ('f0a-sol', 'f0b-sol'):
        for s in j('%s/probe/frontier/%s/receipt.json' % (d, run))['data']['probe']['skills']:
            c = s['cost']
            un = c['input_tokens'] - c['cache_read_tokens'] - c['cache_creation_tokens']
            f[s['skill']][run] = (c['usd'] + prem('gpt-6.1-sol', un)) / c['rollouts']
    for sk, v in f.items():
        new, old = '$%.3f / $%.3f' % (v['f0a-sol'], v['f0b-sol']), '$%s / $%s' % pub[sk]
        add(id='skillopt-probe mean rollout ' + sk, doc=d + '/probe/frontier/README.md', model='gpt-6.1-sol', figure='Sol mean rollout F0a / F0b, ' + sk,
            published=old, recomputed=new, status='MOVES', evidence='as above', max_request_basis='receipts give totals only',
            long_tier='below (inferred from the ceiling re-read rows)', doc_text=[was(new, old)])
    add(id='skillopt-method spend', doc=d + '/REPORT.md', model='gpt-6.1-sol', figure='Program spend (frontier probe, test read, total)', published='ledger figures',
        status='NO MOVE', evidence='settled by the budget ledger, which prices cache writes', long_tier='priced by the ledger')


def skillopt_ceiling():
    d = B + '/2026-11-02-skillopt-ceiling'
    rows = [r for r in jl(d + '/runs/calibration-reread/sol/rows.jsonl.gz') if r.get('kind') == 'rollout']
    by, mx = defaultdict(Counter), 0
    for r in rows:
        u = r['usage']
        for k in ('usd', 'input_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'calls'):
            by[r['skill']][k] += u[k]
            by['all'][k] += u[k]
        by[r['skill']]['n'] += 1
        by['all']['n'] += 1
        mx = max(mx, min(u['input_tokens'], math.floor(u['input_tokens'] / u['calls'] + u['input_tokens'] - u['cache_read_tokens'])))
    out = {}
    for sk, c in by.items():
        un = c['input_tokens'] - c['cache_read_tokens'] - c['cache_creation_tokens']
        out[sk] = {'rollouts': c['n'], 'meter_usd': r6(c['usd']), 'premium': r6(prem('gpt-6.1-sol', un)), 'mean_old': round(c['usd'] / c['n'], 7),
                   'mean_new': round((c['usd'] + prem('gpt-6.1-sol', un)) / c['n'], 7)}
    a = out['all']
    ratio = a['mean_new'] / a['mean_old']
    dm = a['mean_new'] - a['mean_old']
    rpct = round(100 * (ratio - 1))
    common = dict(doc=d + '/PREREGISTRATION.md', model='gpt-6.1-sol', max_request_input=mx, max_request_basis='per-call upper bound from each rollout (input / calls + uncached input)')
    sk = ['$%.4f' % out[s]['mean_new'] for s in ('query', 'briefing', 'fact-check')]
    add(id='skillopt-ceiling Sol means (re-read)', figure='Sol mean per rollout; by skill: query, briefing, fact-check', published='$0.0736; $0.0141, $0.1084, $0.0983',
        recomputed='$%.4f; %s' % (a['mean_new'], ', '.join(sk)), status='MOVES', evidence='the meter reads cache_creation_tokens, which is 0 on every Sol rollout',
        detail=out, ranking='unchanged: the corrected mean stays under the $0.0920 re-price trigger, and Sol\'s gate never ran',
        doc_text=['Sol\'s mean per rollout is $%.4f rather than $0.0736, and %s, %s and %s by skill' % (a['mean_new'], sk[0], sk[1], sk[2])], **common)
    add(id='skillopt-ceiling first calibration', figure='Sol mean per rollout, calibration rounds 1 and 2 (rows not committed)', published='$0.0631, $0.0626',
        recomputed='about %d%% low' % rpct, status='MOVES (by ratio)', evidence='scaled by the re-read rows\' ratio %.4f' % ratio,
        doc_text=['so the Sol means in this table are about %d%% low, by the ratio the re-read\'s committed rows show' % rpct], **common)
    stages = (('A2/A3 gate attempt', 1368, 311.42, 331.34), ('A4 stop-path read', 1728, 386.55, 411.71), ('B0 E1 check', 672, 152.13, 161.91))
    r2 = [100 * n * 0.0626 * (ratio - 1) / v2 for _, n, v2, _ in stages]
    rr = [100 * n * dm / v3 for _, n, _, v3 in stages]
    rp = '/'.join(str(x) for x in sorted({round(v) for v in rr}))
    add(id='skillopt-ceiling round-2 stages', figure='Round-2 re-priced stages (Sol rollouts: gate 1,368, stop-path 1,728, B0 672)', published='$311.42, $386.55, $152.13',
        recomputed=', '.join('%.1f%% low' % v for v in r2), status='MOVES (by ratio)', evidence='Sol\'s round-2 mean scaled by the re-read ratio', ranking='each stays inside its cap',
        doc_text=['so these re-priced figures are about %d%% to %d%% low, and each stays inside its cap' % (math.floor(min(r2)), math.ceil(max(r2)))], **common)
    add(id='skillopt-ceiling re-read stages', figure='Re-read re-priced stages', published='$331.34, $411.71, $161.91',
        recomputed=', '.join('%.1f%% low' % v for v in rr), status='MOVES', evidence='Sol rollouts at the corrected mean', ranking='each stays inside its cap',
        doc_text=['so these three re-priced figures are about %s%% low' % rp, 'are about %d%% and %s%% low' % (rpct, rp)], **common)
    share = a['premium'] / 0.52
    add(id='skillopt-ceiling restart gap', figure='Gap called in-flight spend after the restart', published='$0.52',
        recomputed='%d%% of it is the missed premium' % round(100 * share), status='MOVES', evidence='premium the meters missed on the counted rollouts',
        doc_text=['about two thirds of it is the cache-write premium the meters missed' if 0.6 <= share <= 0.72 else 'share outside two thirds'], **common)
    add(id='skillopt-ceiling trigger', figure='Sol 1.25x re-price trigger (gate text)', published='$0.0920', recomputed='$0.0920', status='NO MOVE (gate text)',
        evidence='the corrected mean $%.4f stays under it' % a['mean_new'], **common)


def harness():
    led_path, plan_path, inputs = 'eval/harness-provider/ledger/ledger.json', 'eval/harness-provider/ledger/plan.json', 'eval/harness-provider/ledger/inputs.json'
    cells = 'docs/benchmarks/2026-10-05-harness-acceptance'
    committed = j(led_path)
    reads.update([inputs, cells])
    env = {k: ('' if any(s in k.upper() for s in ('KEY', 'TOKEN', 'SECRET')) else v) for k, v in os.environ.items()}
    sub = {'openai:gpt-6.1-sol': 'openai:gpt-6.1-sol-cw', 'openai:gpt-6-astra': 'openai:gpt-6-astra-cw'}
    with tempfile.TemporaryDirectory() as tmp:
        def run(plan, name):
            p, out = Path(tmp) / (name + '.plan.json'), Path(tmp) / (name + '.out.json')
            p.write_text(json.dumps(plan))
            r = subprocess.run(['bun', 'eval/runner/harness-ledger.ts', '--plan', str(p), '--inputs', inputs, '--cells-dir', cells, '--out', str(out)],
                               cwd=ROOT, env=env, capture_output=True, text=True)
            if r.returncode:
                sys.exit('harness-ledger.ts failed on %s: %s' % (name, r.stderr[-400:]))
            return json.loads(out.read_text())

        def cw(plan, rates):
            p = json.loads(json.dumps(plan))
            for it in p['items']:
                if 'readers' in it:
                    it['readers'] = [sub.get(x, x) for x in it['readers']]
            p['reader_alternatives'] = [sub.get(x, x) for x in p['reader_alternatives']]
            for k, v in sub.items():
                m = k.split(':')[1]
                p['extra_prices'][v] = {'input': PRICE[m]['cache_write'], 'output': PRICE[m]['output']}
                for f in ('answer_output_tokens', 'reader_input_ratio'):
                    p['fallback_rates'][f][v] = rates[f][k]
            return p
        now_plan, oct5_plan = j(plan_path), json.loads(show('baaa81d1', plan_path))
        now = run(now_plan, 'now')
        now_cw = run(cw(now_plan, now['rates']), 'now-cw')
        oct5 = run(oct5_plan, 'oct5')
        oct5_cw = run(cw(oct5_plan, oct5['rates']), 'oct5-cw')

    def row(led, model):
        return [x for x in led['rows'] if any(r in (model, sub[model]) for r in x['readers'])][0]

    def part(led, model):
        x = row(led, model)
        return [v for k, v in x['parts'].items() if k.startswith('answer ' + model)][0]

    def line(led, n):
        return sum(x['usd'] for x in led['rows'] if x['line'] == n)
    sol, astra = 'openai:gpt-6.1-sol', 'openai:gpt-6-astra'
    sp, ap = row(now_cw, sol)['usd'] - row(now, sol)['usd'], row(now_cw, astra)['usd'] - row(now, astra)['usd']
    total, cap = now['total_usd'], now['cap_usd']
    reproduced = round(total, 2) == round(committed['total_usd'], 2) and now['within_cap'] == committed['within_cap']
    breakeven = (cap - total - sp) / ap
    o5, o5c = oct5['total_usd'], oct5_cw['total_usd']
    sweep10, sweep10_cw = o5 - 0.6 * row(oct5, astra)['usd'], o5c - 0.6 * row(oct5_cw, astra)['usd']
    alts = [pct(b['total_usd'] - a['total_usd'], a['total_usd']) for a, b in zip(oct5['alternatives'], oct5_cw['alternatives'])]
    n = lambda x: '{:,.0f}'.format(x)
    doc = 'eval/harness-provider/LEDGER.md'
    common = dict(doc=doc, max_request_input=None, max_request_basis='planned reader prompts at the 8k target (measured Sol requests 8,247 to 8,327 tokens); the 16k lever doubles that')
    pcts = {'sol_row': pct(sp, row(now, sol)['usd']), 'sol_answer': pct(sp, part(now, sol)), 'sweep_row': pct(ap, row(now, astra)['usd']), 'astra_answer': pct(ap, part(now, astra)),
            'line3': pct(line(now_cw, 3) - line(now, 3), line(now, 3)), 'line4': pct(line(now_cw, 4) - line(now, 4), line(now, 4)), 'total': pct(now_cw['total_usd'] - total, total),
            'as_planned': pct(o5c - o5, o5), 'sweep10': pct(sweep10_cw - sweep10, sweep10), 'lever16k': pct(o5c - o5, 2976)}
    add(id='harness ledger', model='gpt-6.1-sol, gpt-6-astra', figure='Line 3 Sol agent mode and its answer part; line 4 sweep and its Astra part; lines 3 and 4; total; as planned; 10% sweep; 16k lever; A-reader alternatives',
        published='$%.1f, $%.1f; $%.1f, $%.1f; $%s, $%s; $%s; $%s; $%s; $2,976; $%s' % (row(now, sol)['usd'], part(now, sol), row(now, astra)['usd'], part(now, astra), n(line(now, 3)), n(line(now, 4)),
                                                                                n(total), n(o5), n(sweep10), ', $'.join(n(a['total_usd']) for a in oct5['alternatives'])),
        recomputed='%s; alternatives %s%% low' % ('; '.join('%s %d%% low' % kv for kv in pcts.items()), '/'.join(map(str, alts))),
        status='MOVES (Astra share assumed)', evidence='harness-ledger.ts reruns with Sol and Astra reader input at the cache-write rate; no gpt-6-astra request ran in the lane',
        detail={'reproduces_ledger_json': reproduced, 'ledger_json_within_cap': committed['within_cap'], 'ledger_json_generated_at': committed['generated_at'],
                'within_cap_corrected': now_cw['within_cap'], 'within_cap_with_sol_only': total + sp <= cap, 'astra_share_that_crosses_cap': round(breakeven, 3),
                'sweep10_within_cap_corrected': sweep10_cw <= cap},
        ranking='the rebuilt total goes over the cap only if at least %d%% of Astra\'s reader input is cache-written; the 10%% sweep fits either way' % round(100 * breakeven),
        doc_text=['$%.1f (%s, so this is about %d%% low)' % (row(now, sol)['usd'], CW, pcts['sol_row']), 'answer openai:gpt-6.1-sol $%.1f (about %d%% low)' % (part(now, sol), pcts['sol_answer']),
                  '$%.1f (%s, so this is about %d%% low)' % (row(now, astra)['usd'], CW, pcts['sweep_row']), 'answer openai:gpt-6-astra $%.1f (about %d%% low)' % (part(now, astra), pcts['astra_answer']),
                  '$%s (%s, so this is about %d%% low)' % (n(line(now, 3)), CW, pcts['line3']), '$%s (%s, so this is about %d%% low)' % (n(line(now, 4)), CW, pcts['line4']),
                  '**$%s** (%s, so this is about %d%% low; it no longer fits the cap if gpt-6-astra\'s cache writes behave like Sol\'s)' % (n(total), CW, pcts['total']),
                  'so both totals are about %d%% low' % pcts['total'] if pcts['total'] == pcts['as_planned'] else 'totals differ',
                  '$%s (%s, so this is about %d%% low)' % (n(o5), CW, pcts['as_planned']), '$%s (%s, so this is about %d%% low; it still fits the cap)' % (n(sweep10), CW, pcts['sweep10']),
                  '$2,976 (%s, so this is about %d%% low)' % (CW, pcts['lever16k']), 'so these are about %d%%, %d%% and %d%% low' % tuple(alts),
                  'it goes over only if about %d%% or more of Astra\'s reader input is cache-written' % round(100 * breakeven),
                  '`within_cap` in `ledger.json` is the October 7 record and is unchanged, so it still reads `%s`' % json.dumps(committed['within_cap'])],
        long_tier='below', **common)


def memory_trust():
    d = B + '/2026-10-08-memory-trust/paid/'
    cost = lambda f: j(d + f + '.receipt.json')['cost']
    g = cost('cat37-gpt')
    un = ((g['usd'] - g['output_tokens'] * 10 / 1e6) * 1e6 - 0.1 * g['input_tokens']) / 1.9
    b = {'cat37-gpt': prem('gpt-6.1-sol', un)}
    for f in ('cat37-labels-absent', 'cat38', 'cat39', 'cat37-preflight-gpt'):
        b[f] = prem('gpt-6.1-sol', cost(f)['input_tokens'])
    counted = sum(cost(f)['usd'] for f in ('cat37-opus', 'cat37-sonnet', 'cat37-gpt'))
    smoke = cost('cat37-fable-smoke')['usd'] + cost('cat37-preflight-gpt')['usd']
    w = jl(B + '/2026-10-07-longmemeval-w10b-reader-replay/arms/w10b-sol-notes/rows.ndjson')
    cw = sum(r['usage']['prompt_tokens_details']['cache_write_tokens'] for r in w)
    ratio = 1 + prem('gpt-6.1-sol', cw) / sum(r['list_usd'] for r in w)
    guard = 14.72 * (ratio - 1)
    worst = guard + sum(b.values())
    bp = {f: pct(v, cost(f)['usd']) for f, v in b.items() if f != 'cat37-preflight-gpt'}
    doc = B + '/2026-10-08-memory-trust-results-paid.md'
    common = dict(doc=doc, model='gpt-6.1-sol', long_tier='unknown (rows not committed); the bounds assume no request above 272k')
    add(id='memory-trust Cat 37 GPT', figure='Cat 37 counted GPT cell; counted cells', published='$6.17; $33.77', recomputed='at most %d%% low; at most %d%% low' % (bp['cat37-gpt'], pct(b['cat37-gpt'], counted)),
        status='BOUND (rows not committed)', evidence='runner 73524d0d pre-dates 8a8e502a; uncached input derived from the receipt (%d tokens)' % un,
        max_request_basis='receipt mean %d input tokens per request' % (g['input_tokens'] / requests(g)), doc_text=['so the GPT figure is low by at most %d%%' % bp['cat37-gpt']], **common)
    for f, fig, pub in (('cat37-labels-absent', 'Cat 37 labels-absent arm', '$17.01'), ('cat38', 'Cat 38 model arm', '$5.44'), ('cat39', 'Cat 39 model arm and embedding probe', '$0.85')):
        c = cost(f)
        add(id='memory-trust ' + f, figure=fig, published=pub, recomputed='at most %d%% low' % bp[f], status='BOUND (no per-model split)',
            evidence='every input token priced as a Sol cache write', max_request_basis='receipt mean %d input tokens per request' % (c['input_tokens'] / requests(c)),
            doc_text=['%s (%s: the per-model usage is not committed; cache writes were under-counted on its GPT-6.1 Sol share, so this is low by at most %d%%' % (pub, NR, bp[f])], **common)
    add(id='memory-trust smoke and pre-flight', figure='Cat 37 Fable smoke and GPT pre-flight', published='$%.2f' % smoke, recomputed='at most %d%% low' % pct(b['cat37-preflight-gpt'], smoke),
        status='BOUND (rows not committed)', evidence='pre-flight input priced as Sol cache writes',
        doc_text=['$%.2f (%s: the rows are not committed; cache writes were under-counted, so this is low by at most %d%%)' % (smoke, NR, pct(b['cat37-preflight-gpt'], smoke))], **common)
    add(id='memory-trust utility guard', figure='Utility guard GPT reader; guard line', published='$14.72; $86.23', recomputed='about %d%% low; about %d%% low' % (round(100 * (ratio - 1)), pct(guard, 86.23)),
        status='ESTIMATE (rows not committed)', evidence='same LongMemEval notes reader as W10b, whose committed rows give the ratio %.4f' % ratio,
        doc_text=['so the GPT reader is about %d%% low' % round(100 * (ratio - 1))], **common)
    add(id='memory-trust spend', figure='Real spend; spent before amendment 4', published='$212.15; $165.14',
        recomputed='about %d%% and at most %d%% low; about %d%% and at most %d%% low' % (pct(guard, 212.15), pct(worst, 212.15), pct(guard, 165.14), pct(worst, 165.14)),
        status='ESTIMATE AND BOUND', evidence='the utility-guard estimate, plus every bound above for the worst case',
        doc_text=['so this is about %d%% low, and low by at most %d%%' % (pct(guard, 212.15), pct(worst, 212.15)), 'so this is about %d%% low, and low by at most %d%%' % (pct(guard, 165.14), pct(worst, 165.14))], **common)


def facts_extraction():
    d = B + '/2026-10-08-facts-extraction-model'
    wc = j(d + '/write-cost/receipt-off-luna-haiku55.json')
    luna = [a for a in wc['arms'] if a['arm'] == 'on:openai:gpt-6-luna'][0]
    ci = luna['calls_by_cause']['chat:openai:gpt-6-luna effect=facts-absorb']
    p = prem('gpt-6-luna', ci['input_tokens'])
    ext = (ci['input_tokens'] * PRICE['gpt-6-luna']['input'] + ci['output_tokens'] * PRICE['gpt-6-luna']['output']) / 1e6
    arms = sum(a['usd'] for a in wc['arms'])
    gate = j(d + '/gate/receipt.json')
    gl = [a for a in gate['arms'] if a['extraction_input_tokens'] == [x for x in gate['arms'] if x['arm']['label'] == 'luna'][0]['extraction_input_tokens']]
    pg = sum(prem('gpt-6-luna', a['extraction_input_tokens']) for a in gl)
    judge = 0.25 * 0.34
    gp, ap, r2 = pct(pg + judge, 3.27), pct(p, arms), 100 * (p + pg + judge) / 23.30
    doc = d + '.md'
    common = dict(doc=doc, long_tier='unknown (rows not committed); the bounds assume no request above 272k')
    add(id='facts-extraction Luna write cost', model='gpt-6-luna', figure='Luna $ per 1,000 pages, measured / if all 996 ran; Luna extraction', published='$0.89 / $1.23; $0.57',
        recomputed='at most %d%% low each; at most %d%% low' % (pct(p, luna['usd']), pct(p, 0.57)), status='BOUND (rows not committed)',
        evidence='run pre-dates 8a8e502a; every extraction input token priced as a cache write', max_request_basis='receipt mean %d input tokens per call' % (ci['input_tokens'] / ci['calls']),
        ranking='unchanged at the bound: Haiku 5.5 stays above Luna',
        detail={'premium': r6(p), 'extraction_at_list_from_tokens': r6(ext)},
        doc_text=['so each is low by at most %d%%' % pct(p, luna['usd']), '($0.57 of extraction; %s: the rows are not committed; cache writes were under-counted, so this is low by at most %d%%)' % (NR, pct(p, 0.57))], **common)
    g = [a for a in gate['arms'] if a['arm']['label'] == 'luna'][0]
    add(id='facts-extraction Luna gate arm', model='gpt-6-luna', figure='Luna gate arm, 190 pages', published='$%.2f' % g['usd'], recomputed='at most $%.2f' % (g['usd'] + prem('gpt-6-luna', g['extraction_input_tokens'])),
        status='NO VISIBLE MOVE', evidence='the bound stays inside the rounding', max_request_basis='mean %d input tokens per call' % (g['extraction_input_tokens'] / g['extraction_calls']), **common)
    add(id='facts-extraction totals', model='gpt-6.1-sol, gpt-6-luna', figure='Sol judge; gate; off, Luna and Haiku arms; R2 total', published='about $0.34; $3.27; $%.2f; $23.30' % arms,
        recomputed='at most 25%%; at most %d%%; at most %d%%; %s' % (gp, ap, 'less than 1%' if r2 < 1 else '%.1f%%' % r2), status='BOUND (rows not committed)',
        evidence='judge tokens not split out, so its premium is at most a quarter of its cost',
        doc_text=['so the judge\'s figure is low by at most 25%%, the gate\'s by at most %d%%, the three arms\' by at most %d%% and the R2 total by %s' % (gp, ap, 'less than 1%' if r2 < 1 else 'CHECK')], **common)


def bounds_and_notes():
    rows = jl(B + '/2026-10-05-hangul-mention-boundaries/labels.jsonl')
    batches = math.ceil(len(rows) / 40)
    hp = prem('gpt-6.1-sol', batches * 2000)
    add(id='hangul labels', doc=B + '/2026-10-05-hangul-mention-boundaries.md', model='gpt-6.1-sol', figure='Labeling cost', published='$0.36', recomputed='about %d%% low' % pct(hp, 0.36),
        status='ESTIMATE (usage not committed)', evidence='scripts/label.py prices prompt tokens at the input rate; %d batches of up to 40 items, about 2,000 prompt tokens each by character count (assumed)' % batches,
        max_request_input=2000, max_request_basis='estimate', doc_text=['so this is about %d%% low' % pct(hp, 0.36)])
    doc = 'docs/comparison-systems/ext-temporal-graph/shipped-0.31/README.md'
    cells = [c.strip() for c in [l for l in text(doc).splitlines() if '`gpt-6-luna` (ingest)' in l][0].split('|')]
    reqs, tin = int(cells[2]), int(cells[3].replace(',', ''))
    tp = prem('gpt-6-luna', tin)
    add(id='temporal-graph 0.31 Luna ingest', doc=doc, model='gpt-6-luna', figure='Luna ingest, %d requests; billed total' % reqs, published='$0.0017; $0.0022',
        recomputed='at most %d%% low; at most %d%% low' % (pct(tp, 0.0017), pct(tp, 0.0022)), status='BOUND (rows not committed)', evidence='probe.py prices input and output only',
        max_request_input=tin, max_request_basis='all %d input tokens of the %d requests' % (tin, reqs),
        doc_text=['$0.0017 (%s: the rows are not committed; cache writes were under-counted, so this is low by at most %d%%)' % (NR, pct(tp, 0.0017)), 'so this is low by at most %d%%' % pct(tp, 0.0022)])
    sp = j(B + '/2026-10-14-expansion-latency/results/spend.json')
    lu = sp['by_phase_model']['arm:openai:gpt-6-luna']
    add(id='expansion-latency Luna arm', doc=B + '/2026-10-14-expansion-latency-preregistration.md', model='gpt-6-luna', figure='Luna expansion spend; total', published='$%.4f; $%.2f' % (lu, sp['total_usd']),
        recomputed='at most 25%% low; %s' % ('less than 1% low' if 25 * lu / sp['total_usd'] < 1 else 'CHECK'), status='BOUND (request log not committed)',
        evidence='harness/proxy.ts has no cache-write rate', long_tier='unknown (request log not committed); query-expansion prompts are short',
        doc_text=['so this is low by at most 25%%, and the $%.2f total by less than 1%%' % sp['total_usd']])
    add(id='q2 G6 ingest', doc=B + '/2026-10-05-heldout-program/q2.md', model='gpt-6.1-sol', figure='G6 ingest (Sonnet, Sol, Opus)', published='$293.70', recomputed='at most 25% low',
        status='BOUND (no per-model split)', evidence='ingests ran before 8a8e502a; no per-model or per-request usage committed', long_tier='unknown (usage not committed)',
        doc_text=['cache writes were under-counted on the gpt-6.1-sol ingests, so this is low by at most 25%'])
    rt = text('eval/runner/p4-stream/run.ts')
    window = int(rt.split('[--window ')[1].split(']')[0])
    v = j(B + '/2026-10-05-heldout-verdicts/p4-core-heldout-2026-10-06.json')['per_model']
    sol, son = v['gpt-6.1-sol']['cost'], v['claude-sonnet-5-5']['cost']
    add(id='p4 core gate Sol', doc=B + '/2026-10-05-heldout-program/p4.md', model='gpt-6.1-sol', figure='Sol $ per correct, A-prime to C (verdict JSON: per question %.3f / %.3f, per correct %.3f / %.3f)' % (
        sol['Aprime']['per_question'], sol['C']['per_question'], sol['Aprime']['per_correct'], sol['C']['per_correct']), published='$0.32 -> $0.37', recomputed='at most 25% low',
        status='BOUND (rows not committed here)', evidence='eval/runner/p4-stream/model.ts records cache_write 0 for OpenAI and cat40/loop.ts prices the uncached prompt as input; Sol rows are in gbrain\'s decision record',
        max_request_input=window, max_request_basis='the harness compacts before 95%% of its %d-token window' % window,
        ranking='unchanged: Sonnet $%.2f per correct stays above Sol\'s bound $%.2f; cost gates neither default' % (son['Aprime']['per_correct'], sol['C']['per_correct'] * 1.25),
        doc_text=['`gpt-6.1-sol` $0.32 → $0.37 (%s: the rows are not committed here; cache writes were under-counted, so each Sol figure is low by at most 25%%)' % NR])
    h5 = j(B + '/2026-10-05-heldout-verdicts/p5-h5b-heldout-2026-10-06.json')
    h3 = j(B + '/2026-10-05-heldout-verdicts/p5-h3-heldout-2026-10-06.json')
    add(id='p5 h5b agent spend', doc=B + '/2026-10-05-heldout-verdicts/p5-h5b-heldout-2026-10-06.json', model='gpt-6.1-sol', figure='agent_usd off / on (claude-sonnet-5-5 and gpt-6.1-sol together)',
        published='%s / %s' % (h5['agent_usd']['off'], h5['agent_usd']['on']), recomputed='at most 25% low', status='BOUND (JSON record, not in the report text)',
        evidence='eval/runner/p5-agent.ts records cache_write 0 for OpenAI; no per-model or per-request usage committed', long_tier='unknown (usage not committed)')
    add(id='p5 h3 judge spend', doc=B + '/2026-10-05-heldout-verdicts/p5-h3-heldout-2026-10-06.json', model='gpt-6.1-sol', figure='judge_usd (claude-sonnet-5-5 and gpt-6.1-sol judges)',
        published=h3['judge_usd'], recomputed='at most 25% low', status='BOUND (JSON record, not in the report text)', evidence='as above', long_tier='unknown (usage not committed)')
    for c in ('88d0b199', '337c130d'):
        src = show(c, 'eval/runner/sealed-confirmation-lib.ts')
        assert 'cache_write_tokens: u.input_tokens_details?.cache_write_tokens' in src and "'gpt-6-sol': { input: 2.0, cached_input: 0.2, cache_write: 2.5" in src
    for v_, figure in (('v1', 'Generation cost (gpt-6-sol writer and auditor)'), ('v2', 'Generation cost (gpt-6-sol planner and auditor, gpt-6-luna writer)')):
        m = j('eval/data/sealed-confirmation-%s/manifest.json' % v_)
        hs = m['counts']['approx_tokens_per_haystack_chars_div_4']['max']
        add(id='sealed-confirmation %s generation' % v_, doc=B + ('/2026-09-29-sealed-confirmation-protocol.md' if v_ == 'v1' else '/2026-10-01-sealed-confirmation-v2-protocol.md'),
            model='gpt-6-sol' + (', gpt-6-luna' if v_ == 'v2' else ''), figure=figure, published='$%.2f' % m['generation_cost_usd'], status='NO MOVE',
            evidence='sealed-confirmation-lib.ts read cache_write_tokens and priced them at the cache-write rate from its first commit (88d0b199, also at 337c130d)',
            max_request_input=hs, max_request_basis='each request carries one plan or one chat; the largest whole haystack is %d tokens (manifest, chars / 4)' % hs)
    add(id='p2-e2 consumers judge', doc=B + '/p2-e2-consumers/README.md', model='gpt-6-sol', figure='Blind pairwise judge, 1,200 verdicts', status='NO FIGURE',
        evidence='no cost is published for the gpt-6-sol judge', long_tier='not applicable')
    add(id='model ladder gpt-6-sol', doc=B + '/2026-10-02-model-ladder/baseline-uncapped/README.md', model='gpt-6-sol', figure='gpt-6-sol cells of the Cat 40 model ladder', status='OUT OF SCOPE (Cat 40)',
        evidence='Cat 40 cells belong to the Cat 40 part of the audit', long_tier='not checked here')
    bl = [l for l in text('eval/runner/budget-ledger.ts').splitlines() if "'openai:gpt-6-sol':" in l][0].strip()
    add(id='budget-ledger gpt-6-sol price row', doc='eval/runner/budget-ledger.ts', model='gpt-6-sol', figure='price row', published=bl, status='NOTE',
        evidence='no cache-write rate and no long-context tier; no figure in this scope was priced through it', long_tier='not applicable')
    for kw in (dict(id='GST-1365 Sol judge planning price', doc=B + '/2026-11-04-gst-1365-judge-robustness-preregistration.md', figure='Second-judge cost per answer (measured, GBEV-35)', published='$0.0188',
                    status='NO MOVE', evidence='settled by a budget ledger that prices cache writes', long_tier='priced by the ledger'),
               dict(id='wave11 smoke estimate', doc=B + '/2026-10-07-wave11-agent-smoke-preregistration.md', figure='Sol build estimate', published='$2.6', status='OUT OF SCOPE (Cat 40)',
                    evidence='a planning figure taken from the Cat 40 cells', long_tier='not checked here'),
               dict(id='cat41-brief Codex estimate', doc=B + '/2026-10-15-cat41-brief-preregistration.md', figure='About $0.50 per Codex run', published='$0.50', status='NO MOVE',
                    evidence='Codex reports and prices cache writes', long_tier='see the Codex rows'),
               dict(id='RS1 stage 0', doc=B + '/2026-11-04-rs1-stage0.md', figure='Cost per minted conversation', status='NO MOVE', evidence='OpenAI is used only for embeddings here',
                    long_tier='not applicable')):
        add(model=kw.pop('model', 'gpt-6.1-sol'), **kw)


def main():
    for fn in (small_requests, priced_runners, n2, content_repair, multi_source, skillopt_method, skillopt_ceiling, harness, memory_trust, facts_extraction, bounds_and_notes):
        fn()
    norm = lambda s: ' '.join(s.split())
    missing = []
    for r in results:
        if not r['doc_text']:
            r['doc_match'] = None
            continue
        body = ' '.join(norm(text(d)) for d in (r['doc'] if isinstance(r['doc'], list) else [r['doc']]))
        miss = [t for t in r['doc_text'] if norm(t) not in body]
        r['doc_match'] = not miss
        missing += ['%s: %s' % (r['id'], t) for t in miss]
    untracked = [p for p in sorted(reads) if not git('ls-files', '--', p).strip()]
    if untracked:
        sys.exit('read untracked files: ' + ', '.join(untracked))
    counts = Counter(r['status'].split(' (')[0] for r in results)
    checked = [r for r in results if r['doc_match'] is not None]
    head = {'tool': TOOL, 'command': 'python3 ' + TOOL, 'rule': __doc__.split('Rule. ')[1].strip().replace('\n', ' '), 'prices_usd_per_million': PRICE,
            'long_context_above_input_tokens': LONG, 'cache_write_from_prompt_tokens': MIN_CACHE, 'files_read': len(reads), 'files_read_at_older_commits': sorted(shown),
            'status_counts': dict(sorted(counts.items())), 'doc_check': {'figures_checked': len(checked), 'figures_matching': sum(r['doc_match'] for r in checked)}}
    lines = ['{'] + ['%s: %s,' % (json.dumps(k), json.dumps(v, separators=(',', ':'))) for k, v in head.items()] + ['"figures": [']
    lines += [json.dumps(r, separators=(',', ':'), ensure_ascii=False) + (',' if i < len(results) - 1 else '') for i, r in enumerate(results)]
    (HERE / 'results.json').write_text('\n'.join(lines + [']}', '']))
    print('%d figures: %s. Doc wording: %d of %d figures match.' % (len(results), ', '.join('%s %d' % kv for kv in sorted(counts.items())), head['doc_check']['figures_matching'], len(checked)))
    for m in missing:
        print('MISSING ' + m)
    sys.exit(1 if missing else 0)


if __name__ == '__main__':
    main()
