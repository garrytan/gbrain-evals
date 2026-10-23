import json,re
import os, pathlib
REPO=pathlib.Path(__file__).resolve().parents[6]
W=os.environ.get('FLAGCHECK_DIR') or str(REPO/'.flagcheck')
s=json.load(open(W+'/sweep/receipt-diff.json'))
ks={}
for f,v in s.items():
  for k in v.get('noise_keys',[]): ks.setdefault(k,f)
bad=[(k,f) for k,f in sorted(ks.items()) if not re.search(r'(latency|_ms|ms_|ms$|_at$|started|finished|sha|commit|tree|ref$|requested|path|git_head|wallclock|duration|frozen_at|hashes)',k)]
print(len(ks))
for k,f in bad: print(f,k)
