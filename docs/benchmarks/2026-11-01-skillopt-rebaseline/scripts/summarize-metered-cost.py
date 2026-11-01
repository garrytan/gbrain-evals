#!/usr/bin/env python3
"""Summarize the metering proxy's usage log for the 2026-11-01 SkillOpt re-baseline into metered-cost.json.

Usage: python3 summarize-metered-cost.py <usage.ndjson> <ledger-status.json> <out.json>
Slots: smoke (the proxy's default slot: Cat 30 B-pre), cat32bpre, probe (three Sonnet rollouts to price Cat 33),
cat30, cat31, cat32, cat33, r48 (the frontier probe) and repro (the success-reflect repro).
"""
import json, sys, collections

usage, ledger_status, out = sys.argv[1:4]
slots = collections.OrderedDict()
for line in open(usage):
    d = json.loads(line)
    if not d.get('model'):
        continue
    slot = d['slot'] if d.get('slot') != 'default' else 'smoke'
    s = slots.setdefault(slot, {'usd': 0.0, 'requests': 0, 'by_model': {}})
    m = s['by_model'].setdefault(f"{d['provider']}:{d['model']}", {'usd': 0.0, 'requests': 0, 'input_tokens': 0, 'output_tokens': 0})
    usd = d.get('actual_usd') or 0.0
    for t in (s, m):
        t['usd'] += usd
        t['requests'] += 1
    m['input_tokens'] += d.get('input_tokens') or 0
    m['output_tokens'] += d.get('output_tokens') or 0
    if d.get('outcome') != 'forwarded':
        s.setdefault('not_forwarded', 0)
        s['not_forwarded'] += 1
for s in slots.values():
    s['usd'] = round(s['usd'], 6)
    for m in s['by_model'].values():
        m['usd'] = round(m['usd'], 6)
status = json.load(open(ledger_status))
json.dump({
    'source': 'eval/runner/metering-proxy.ts usage log (providers usage fields at list price, eval/runner/budget-ledger.ts price table)',
    'total_usd': round(sum(s['usd'] for s in slots.values()), 6),
    'slots': slots,
    'ledger_totals': {k: status['totals'][k] for k in ('committed_usd', 'reconciled_usd', 'open_reservations_usd', 'requests')},
}, open(out, 'w'), indent=2)
open(out, 'a').write('\n')
