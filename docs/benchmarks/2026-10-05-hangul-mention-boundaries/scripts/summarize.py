import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
before = collections.Counter(r['label'] for r in rows)
after = collections.Counter(r['label'] for r in rows if r['kept_by_end_rule'])
print('| | NAME | WORD | INTERNAL |\n|---|---:|---:|---:|')
for title, c in [('no end boundary', before), ('suffix end rule', after)]:
    print(f"| {title} | {c['NAME']} | {c['WORD']} | {c['INTERNAL']} |")
for title, c in [('no end boundary', before), ('suffix end rule', after)]:
    print(f"precision over NAME + INTERNAL, {title}: {c['NAME'] / (c['NAME'] + c['INTERNAL']):.1%}")
