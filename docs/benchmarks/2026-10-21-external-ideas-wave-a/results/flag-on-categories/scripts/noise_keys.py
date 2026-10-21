import json,re
s=json.load(open('/home/user/.capy/work/gbra162-flagcheck/sweep/receipt-diff.json'))
ks={}
for f,v in s.items():
  for k in v.get('noise_keys',[]): ks.setdefault(k,f)
bad=[(k,f) for k,f in sorted(ks.items()) if not re.search(r'(latency|_ms|ms_|ms$|_at$|started|finished|sha|commit|tree|ref$|requested|path|git_head|wallclock|duration|frozen_at|hashes)',k)]
print(len(ks))
for k,f in bad: print(f,k)
