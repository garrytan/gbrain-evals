"""Summarize the #6066 equivalence check from its pushed receipts.

  python3 eval/harness-provider/mpw_tools/equivalence_report.py docs/benchmarks/2026-10-10-memory-proof-wave-equivalence

Reads <root>/<size>/{baseline,newhead}/<lane>/ for every size and lane present and writes <root>/report.json. Arms:
  p0-1, p0-2  baseline cell replayed on d7467d1cf (noise floor); p0-1 is the reference for every probe diff
  r2a         new head, baseline store; r2b: same after `extract --stale`; r3: new head, new-head store
Probe events are matched across arms by query text (with an occurrence counter), so a diff compares the same question.
"""
from __future__ import annotations

import collections
import gzip
import json
import sys
from pathlib import Path

ARMS = ("p0-1", "p0-2", "r2a", "r2b", "r3")
DELIVERY_FLAGS = ("budget_note", "breadth_cap", "budget_recount")


def probe(path: Path) -> dict:
    """query key -> {'query': event, 'vector': [events], 'keyword': [events]}; engine events attach to the next query of the same pid."""
    if not path.exists():
        return {}
    by_pid: dict = collections.defaultdict(lambda: {"vector": [], "keyword": []})
    seen: collections.Counter = collections.Counter()
    out = {}
    for line in gzip.open(path, "rt"):
        e = json.loads(line)
        if e["ev"] in ("vector", "keyword"):
            by_pid[e["pid"]][e["ev"]].append(e)
            continue
        text = str(e["params"]["query"])
        seen[text] += 1
        out[f"{text}\u0000{seen[text]}"] = {"query": e, **by_pid.pop(e["pid"], {"vector": [], "keyword": []})}
    return out


def ranked(events: list, column: str = "embedding") -> list:
    return [i for e in events if (e.get("column") or "embedding") == column for i in e["ids"]] if events and "column" in events[0] else [i for e in events for i in e["ids"]]


def list_diff(a: list, b: list) -> dict:
    return {"same_set": set(a) == set(b), "same_order": a == b, "changed": len(set(a) ^ set(b)) // 2 + (len(set(a) ^ set(b)) % 2)}


def compare(ref: dict, other: dict) -> dict:
    keys = sorted(set(ref) & set(other))
    out = {"matched": len(keys), "unmatched": len(set(ref) ^ set(other))}
    for arm in ("vector", "keyword"):
        diffs = [list_diff(ranked(ref[k][arm]), ranked(other[k][arm])) for k in keys]
        changed = [d for d in diffs if not d["same_order"]]
        out[arm] = {"questions_changed_order": len(changed), "questions_changed_set": sum(1 for d in diffs if not d["same_set"]),
                    "mean_changed_candidates": round(sum(d["changed"] for d in changed) / len(changed), 2) if changed else 0}
    rows = lambda k, s: [r for r in s[k]["query"]["rows"]]
    facts = [(lambda a, b: a != b)([r["fact_id"] for r in rows(k, ref) if r["result_type"] == "fact"], [r["fact_id"] for r in rows(k, other) if r["result_type"] == "fact"]) for k in keys]
    texts = [(lambda a, b: a != b)([(r["slug"], r["text_sha"]) for r in rows(k, ref)], [(r["slug"], r["text_sha"]) for r in rows(k, other)]) for k in keys]
    same_rows_diff_text = 0
    for k in keys:
        a = {(r["slug"], r["chunk_id"]): r["text_sha"] for r in rows(k, ref)}
        b = {(r["slug"], r["chunk_id"]): r["text_sha"] for r in rows(k, other)}
        same_rows_diff_text += sum(1 for x in set(a) & set(b) if a[x] != b[x])
    out["facts_rows_changed_questions"] = sum(facts)
    out["delivered_rows_changed_questions"] = sum(texts)
    out["same_row_text_changed"] = same_rows_diff_text
    return out


def scan(arm: dict) -> dict:
    qs = [v["query"] for v in arm.values()]
    eng = [e for v in arm.values() for e in v["vector"] + v["keyword"]]
    deliveries = [q.get("delivery") or {} for q in qs]
    rows = [r for q in qs for r in q["rows"]]
    return {
        "queries": len(qs),
        "harness_param_keys": sorted({k for q in qs for k in q["params"]["keys"]}),
        "harness_min_trust": sum(1 for q in qs if q["params"].get("min_trust") is not None),
        "engine_searches": len(eng),
        "engine_source_scope": dict(collections.Counter(f"sourceId={e.get('source_id')} sourceIds={e.get('source_ids')}" for e in eng)),
        "engine_min_trust": sum(1 for e in eng if e.get("min_trust") is not None),
        "image_arm_searches": sum(1 for v in arm.values() for e in v["vector"] if (e.get("column") or "embedding") != "embedding"),
        "vector_pool_underfilled": sum(1 for v in arm.values() for e in v["vector"] if e.get("pool")),
        "delivery_flags": {f: sum(1 for d in deliveries if f in d or f in (d.get("fallbacks") or [])) for f in DELIVERY_FLAGS},
        "delivery_unit_not_page": sum(1 for d in deliveries if d.get("applied_unit") not in (None, "page") or d.get("requested_unit") not in (None, "page")),
        "rows": len(rows),
        "rows_trust_tier": dict(collections.Counter(str(r.get("trust_tier")) for r in rows)),
        "rows_origin": dict(collections.Counter(str(r.get("origin")) for r in rows)),
        "rows_unconfirmed": sum(1 for r in rows if r.get("unconfirmed")),
    }


def counts(path: Path) -> dict:
    return dict(collections.Counter(json.loads(path.read_text())["questions"].values())) if path.exists() else {}


def census(path: Path) -> dict | None:
    if not path.exists():
        return None
    c = json.loads(path.read_text())
    tot: dict = collections.Counter()
    extra: dict = collections.defaultdict(collections.Counter)
    for u in c["units"].values():
        for k in ("pages", "chunks", "facts", "page_sources", "quarantined_pages"):
            tot[k] += u.get(k) or 0
        for k in ("gate_receipts", "gate_holds", "needs_rederive", "pages_trust_tiers", "facts_trust_tiers"):
            for row in u.get(k, []):
                extra[k][json.dumps({x: y for x, y in row.items() if x != "n"}, sort_keys=True)] += row["n"]
        for k in ("hidden_by_eligibility", "activation_suppressed", "fence_marked_chunks"):
            for x, y in (u.get(k) or {}).items():
                extra[k][x] += y
    return {"totals": dict(tot), **{k: dict(v) for k, v in extra.items()}, "read_policy": next((u.get("read_policy") for u in c["units"].values() if u.get("read_policy")), None),
            "queries": c.get("queries")}


def answers(d: Path) -> dict | None:
    s = d / "summary.json"
    if not s.exists():
        return None
    cells = json.loads(s.read_text())["cells"]
    return {cid.rsplit("-", 1)[-1] if cid.split("-")[-1].startswith("s") else "baseline": {k: v[k] for k in ("scheduled", "correct", "mean_score")} | {"abstention": v["counts"]["abstention"]} for cid, v in cells.items()}


def main() -> int:
    root = Path(sys.argv[1])
    report = {}
    for size_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for lane in ("combined", "raw"):
            nh = size_dir / "newhead" / lane
            if not nh.exists():
                continue
            arms = {a: probe(nh / a / "probe.jsonl.gz") for a in ARMS}
            entry = {
                "context_vs_baseline_answers": {a: counts(nh / a / "replay-diff.json") for a in ARMS},
                "probe_vs_p0-1": {a: compare(arms["p0-1"], arms[a]) for a in ARMS[1:] if arms[a]},
                "scan": {a: scan(arms[a]) for a in ARMS if arms[a]},
                "census": {k: census(nh / f"census-{k}.json") for k in ("base", "r2a", "r2b", "new")},
                "answers": {r: answers(nh / f"answer-{r}") for r in ("r2a", "r3")},
                "extract_stale": [json.loads(l) for l in (nh / "extract-stale.log").read_text().splitlines() if l.startswith('{"action":"extract_stale_done"')] if (nh / "extract-stale.log").exists() else None,
            }
            report[f"{size_dir.name}/{lane}"] = entry
        g = size_dir / "newhead" / "ingest-guard.json"
        if g.exists():
            report[f"{size_dir.name}/ingest_guard"] = json.loads(g.read_text())
    (root / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1)[:200000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
