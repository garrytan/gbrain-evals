"""Summarize one memory-qa pilot run: the runner's receipt and rows plus the metering proxy's usage log. Stdlib only.

Usage: python3 pilot_summary.py <run dir> <proxy usage.jsonl> [--since ISO] [--shim-slot graph-pipeline] [--reader-slot reader]

Shim-slot requests before the first reader-slot request are ingest; later shim-slot requests are query-time. graph-pipeline's
retrieval makes embedding calls only, so this split is exact for it.
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
from pathlib import Path


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("usage_log")
    ap.add_argument("--since", default="")
    ap.add_argument("--shim-slot", default="graph-pipeline")
    ap.add_argument("--reader-slot", default="reader")
    a = ap.parse_args()
    run = Path(a.run_dir)
    receipt = json.loads((run / "receipt.json").read_text())
    rows = [json.loads(line) for line in (run / "rows.ndjson").read_text().splitlines() if line.strip()]
    usage = [json.loads(line) for line in Path(a.usage_log).read_text().splitlines() if line.strip()]
    usage = [u for u in usage if u["at"] >= a.since]
    shim = [u for u in usage if u["key"] == f"slot:{a.shim_slot}"]
    reader = [u for u in usage if u["key"] == f"slot:{a.reader_slot}"]
    first_reader = min((u["at"] for u in reader), default="9999")
    ingest = [u for u in shim if u["at"] < first_reader]
    query = [u for u in shim if u["at"] >= first_reader]

    def tally(us: list[dict]) -> dict:
        by = collections.defaultdict(lambda: {"requests": 0, "input_tokens": 0, "output_tokens": 0, "usd": 0.0})
        for u in us:
            b = by[f"{u.get('model')} {u['route']}"]
            b["requests"] += 1
            b["input_tokens"] += u.get("input_tokens", 0)
            b["output_tokens"] += u.get("output_tokens", 0)
            b["usd"] += u.get("actual_usd", 0.0)
        return {k: {**v, "usd": round(v["usd"], 5)} for k, v in by.items()} | {"total_usd": round(sum(u.get("actual_usd", 0.0) for u in us), 5)}

    n = len(rows)
    prov = collections.Counter()
    types = collections.Counter()
    for r in rows:
        prov.update(r.get("provenance") or {})
        types.update(i["type"] for i in r.get("items") or [])
    lat = [r["latency_ms"] for r in rows if isinstance(r.get("latency_ms"), (int, float))]
    out = {
        "run": str(run), "status": receipt["run_status"], "invalid_reasons": receipt["invalid_reasons"],
        "selection": receipt["selection"], "ingest_receipt": receipt.get("ingest"), "counts": receipt["counts"],
        "outcomes": dict(collections.Counter(r["outcome"] for r in rows)), "summary": receipt["summary"],
        "ingest_window": {"from": ingest[0]["at"] if ingest else None, "to": ingest[-1]["at"] if ingest else None},
        "ingest_usage": tally(ingest), "query_usage": tally(query), "reader_judge_usage": tally(reader),
        "reader_judge_usd_per_question": round(sum(u.get("actual_usd", 0.0) for u in reader) / n, 5) if n else None,
        "query_usd_per_question": round(sum(u.get("actual_usd", 0.0) for u in query) / n, 6) if n else None,
        "latency_ms": {"p50": pct(lat, 0.5), "p95": pct(lat, 0.95), "mean": round(statistics.mean(lat), 1) if lat else None},
        "items_per_question": round(sum(len(r.get("items") or []) for r in rows) / n, 1) if n else None,
        "provenance_mix": dict(prov), "item_types": dict(types),
        "refusals": sum(1 for u in usage if u["outcome"] != "forwarded"),
        "context_tokens_mean": round(statistics.mean(ctx), 0) if (ctx := [r["qa_context_tokens"] for r in rows if r.get("qa_context_tokens")]) else None,
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
