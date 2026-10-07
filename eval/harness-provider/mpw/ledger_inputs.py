"""Free inputs for the cell ledger: per dataset split, questions, units, document tokens and judge calls.

  python -m mpw.ledger_inputs --out ledger-inputs.json [dataset:split ...]
"""
from __future__ import annotations

import argparse
import json
import os

from . import register
from .context import count_tokens

DEFAULT = ["longmemeval:s", "locomo:locomo10", "beam:100k", "beam:500k", "beam:1m", "personamem:32k",
           "lifebench:en", "precisionmembench:single-turn"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("splits", nargs="*")
    args = ap.parse_args()
    register.install()
    os.environ.setdefault("GEMINI_API_KEY", "mpw-no-network")
    from .cell import get_dataset

    out = {}
    for item in args.splits or DEFAULT:
        name, split = item.split(":")
        ds = get_dataset(name)
        qs = ds.load_queries(split)
        docs = ds.load_documents(split)
        units = {str(q.user_id) for q in qs if q.user_id is not None}
        rubric = sum(max(1, len(q.meta.get("rubric") or [])) for q in qs) if hasattr(ds, "score_result") else None
        out[item] = {"questions": len(qs), "units": len(units), "documents": len(docs),
                     "document_tokens_cl100k": sum(count_tokens(d.content or "") for d in docs),
                     "task_type": ds.task_type, "judge_calls": 0 if ds.task_type != "open" else (rubric or len(qs))}
        print(item, json.dumps(out[item]), flush=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2, sort_keys=True)
        f.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
