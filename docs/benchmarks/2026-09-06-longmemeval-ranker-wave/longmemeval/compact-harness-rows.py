#!/usr/bin/env python3
"""Compact a LongMemEval harness ndjson (full retrieved[] rows) into a receipt-sized ndjson: per-question hits + session ids only."""
import json, sys
KEEP = ["question_id","question_type","recall_all_hit","recall_any_hit","abstention","distinct_sessions_in_top_k","retrieved_session_ids","answer_session_ids","gold_missing_from_haystack","expansion_variants","search_meta","error","judge_correct","judge_error","judge_model","retrieval_config_hash"]
src, dst = sys.argv[1], sys.argv[2]
n=0
with open(src) as f, open(dst,"w") as o:
    for line in f:
        line=line.strip()
        if not line: continue
        row=json.loads(line)
        if row.get("schema_version") or "by_type_summary" in row or "summary" in row or row.get("kind")=="summary":
            o.write(json.dumps(row, separators=(",",":"))+"\n"); continue
        o.write(json.dumps({k:row[k] for k in KEEP if k in row}, separators=(",",":"))+"\n"); n+=1
print(f"{dst}: {n} question rows")
