"""Write the committed timestamp provenance manifest for each dataset split.

  python -m mpw.timestamp_manifest --out timestamp-manifests [dataset:split ...]

Each manifest records the loader rule, how many documents fall in each
provenance class, how many dates reach providers, and a sha256 over the
sorted (sha256(document id), provenance, provider timestamp) rows, so a cell's
own per-document manifest can be checked against it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from . import register, timestamps

DEFAULT = ["longmemeval:s", "locomo:locomo10", "beam:100k", "beam:500k", "beam:1m", "beam:10m", "personamem:32k",
           "personamem:128k", "lifebench:en", "precisionmembench:single-turn"]


def manifest(dataset_name: str, split: str) -> dict:
    from .cell import get_dataset

    ds = get_dataset(dataset_name)
    docs = ds.load_documents(split)
    rows = []
    counts: dict[str, int] = {}
    passed = 0
    for d in docs:
        ts, prov = timestamps.provider_timestamp(dataset_name, d.timestamp)
        counts[prov] = counts.get(prov, 0) + 1
        passed += ts is not None
        rows.append((hashlib.sha256(d.id.encode()).hexdigest(), prov, ts or ""))
    rows.sort()
    digest = hashlib.sha256("\n".join("\t".join(r) for r in rows).encode()).hexdigest()
    return {"dataset": dataset_name, "split": split, "rule": timestamps.RULES[dataset_name], "documents": len(docs),
            "counts": counts, "dates_passed_to_providers": passed, "rows_sha256": digest,
            "policy": "Only observed session times reach providers; stated event dates and unknown dates are withheld from both systems."}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("splits", nargs="*")
    args = ap.parse_args()
    register.install()
    os.environ.setdefault("GEMINI_API_KEY", "mpw-no-network")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for item in args.splits or DEFAULT:
        name, split = item.split(":")
        try:
            m = manifest(name, split)
        except Exception as e:  # noqa: BLE001 - recorded, not hidden
            m = {"dataset": name, "split": split, "error": f"{type(e).__name__}: {e}"[:500]}
        (out / f"{name}-{split}.json").write_text(json.dumps(m, indent=2, sort_keys=True) + "\n")
        print(json.dumps({k: m.get(k) for k in ("dataset", "split", "documents", "counts", "error")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
