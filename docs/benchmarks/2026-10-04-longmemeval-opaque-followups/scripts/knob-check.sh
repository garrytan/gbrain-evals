#!/usr/bin/env bash
# Item 1a settings check: recompute each September 6 arm's resolved search knobs and knobs_hash with gbrain's own
# resolveSearchMode/knobsHash at the code that produced it, and at the recount pin 109b992 with the pre-flip pins.
# Needs gbrain worktrees at 885bb91a1, 2efaaf8f and 109b992 (GBRAIN_WT=<dir holding gbrain-<sha>/>).
set -eu
cd "$(dirname "$0")"
WT=${GBRAIN_WT:?}
BASE='"A1":{"mode":"balanced","expansion":false,"reranker":false,"autocut":false},"A2":{"mode":"balanced","expansion":false,"reranker":true,"autocut":false},"A3":{"mode":"balanced","expansion":true,"reranker":false,"autocut":false},"A4":{"mode":"balanced","expansion":false,"reranker":true,"autocut":true},"A3p":{"mode":"balanced","expansion":true,"budget":0.25,"reranker":false,"autocut":false},"A3pR":{"mode":"tokenmax","expansion":true,"budget":0.25,"reranker":true,"autocut":true}'
REL='"TMXR":{"mode":"tokenmax","expansion":true,"reranker":true,"autocut":false},"FINAL":{"mode":"balanced","expansion":false,"reranker":true,"autocut":false}'
PRE='"pins":{"search.relational_rerank_pin":"0","search.metadata_boost_gate":"always"}'
NEW=$(echo "{$BASE}" | sed "s/\"autocut\":\(true\|false\)}/\"autocut\":\1,$PRE}/g")
bun knobs.ts "$WT/gbrain-885bb91a1" "{$BASE}" > knobs-885bb91a1.json
bun knobs.ts "$WT/gbrain-2efaaf8f" "{$REL}" > knobs-2efaaf8f.json
bun knobs.ts "$WT/gbrain-109b992" "$(python3 -c "import json,sys; a=json.loads(sys.argv[1]); a.update(json.loads(sys.argv[2])); print(json.dumps(a))" "$NEW" "{$REL}")" > knobs-109b992.json
python3 - <<'PY'
import json
want={'A1':'0f49f9c6e3de0dad','A2':'6ae9bd8d4e0b88f4','A3':'28ade59a7d3bb01a','A4':'e16bbfd4dfb4dce6','A3p':'d0a12840688512b9','A3pR':'4e0ee9ff84645d38','TMXR':'bd3a9082e104a961','FINAL':'a8a2e8818b34e328'}
old={**json.load(open('knobs-885bb91a1.json')),**json.load(open('knobs-2efaaf8f.json'))}; new=json.load(open('knobs-109b992.json'))
for k in want:
    o=old[k]['knobs']; n=new[k]['knobs']
    diff={x:(o.get(x,'<absent>'),n.get(x,'<absent>')) for x in sorted(set(o)|set(n)) if o.get(x,'<absent>')!=n.get(x,'<absent>')}
    print(k, 'published knobs_hash', want[k], 'recomputed', old[k]['knobs_hash'], 'MATCH' if old[k]['knobs_hash']==want[k] else 'MISMATCH', '| differences at 109b992:', diff)
PY
