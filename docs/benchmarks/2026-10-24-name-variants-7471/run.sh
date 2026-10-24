#!/bin/bash
# run.sh <brain dir> <tree> > results.jsonl
export PATH=$PATH GBRAIN_HOME=$1/home
cd $1
while IFS= read -r line; do
  q=$(echo "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin)["query"])')
  bun $2/src/cli.ts search "$q" --limit 10 --json 2>/dev/null | LINE="$line" python3 -c '
import json,sys,os
q=json.loads(os.environ["LINE"])
try:
  d=json.load(sys.stdin); rs=d["results"] if isinstance(d,dict) else d
except Exception as e:
  rs=[]
s=[x["slug"] for x in rs]
q["rank"]=s.index(q["expect"])+1 if q["expect"] in s else None
q["top"]=s[:3]
print(json.dumps(q))'
done < $1/queries.jsonl
