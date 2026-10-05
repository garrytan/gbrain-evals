"""Coding-agent memory spike: a few tasks of the harness's coding benchmark with and without gbrain.

Started by `bun eval/runner/coding-spike.ts`, which owns the budget run, the metering proxy and the
agent image. This process never sees a real key.

Arms (the harness's own `run.py --history` values):
  none    `full`: the plain agent on the full repository; the harness also seeds the task's past
          developer chats as opencode sessions the agent may open (the published no-memory arm).
  gbrain  `provided`: the task's corpus is ingested into one gbrain brain per task, the bug report
          is the query, and the retrieved blocks are joined and appended to the task prompt the way
          the harness's generic provider path (`modes/coding.py`, arm `provided`) does it.

The cell runner (`mpw/cell.py`) does not support the coding mode, so this driver reimplements the
small part of `modes/coding.py` it needs: opaque ids for documents and units, the same `k=10`
retrieve, the same block join and the same `run.py` command (with the harness venv's Python instead
of `uv run`). Grading, interventions and the solved flag are `run.py`'s own.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from mpw import register

register.install()

import memory_bench.dataset.sdebench as sdebench_module  # noqa: E402
from memory_bench.dataset.sdebench import SdebenchDataset  # noqa: E402
from mpw.context import count_tokens  # noqa: E402
from mpw.gbrain_provider import GbrainMemoryProvider  # noqa: E402
from mpw.projection import opaque  # noqa: E402
from memory_bench.models import Document  # noqa: E402

HISTORY = {"none": "full", "gbrain": "provided"}
SALT = hashlib.sha256(b"mpw-coding-spike:sdebench:boltons").digest()


def project(doc: Document, unit: str) -> Document:
    return Document(id=opaque(SALT, "d", doc.id), content=doc.content, user_id=unit,
                    messages=doc.messages, timestamp=None, context=doc.context)


def proxy_rows(log: Path, start: str, end: str) -> list[dict]:
    if not log.exists():
        return []
    rows = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    return [r for r in rows if start <= r["ts"] <= end]


def spend(rows: list[dict]) -> dict:
    out: dict = {"requests": len(rows), "refused": sum(1 for r in rows if r.get("refused")), "usd": 0.0, "by_label": {}}
    for r in rows:
        label = out["by_label"].setdefault(r.get("label") or "?", {"requests": 0, "usd": 0.0, "input_tokens": 0, "output_tokens": 0})
        label["requests"] += 1
        label["usd"] += r.get("actual_usd") or 0.0
        label["input_tokens"] += r.get("input_tokens") or 0
        label["output_tokens"] += r.get("output_tokens") or 0
        out["usd"] += r.get("actual_usd") or 0.0
    out["usd"] = round(out["usd"], 6)
    return out


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def gbrain_context(provider: GbrainMemoryProvider, ds: SdebenchDataset, query, out: Path) -> tuple[str, dict]:
    unit = opaque(SALT, "u", query.id)
    originals = ds.load_documents("boltons", user_ids={query.id})
    docs = [project(d, unit) for d in originals]
    back = {opaque(SALT, "d", d.id).lower(): d.id for d in originals}
    t0 = time.perf_counter()
    provider.ingest(docs)
    ingest_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    found, _raw, meta = provider.retrieve_with_meta(query.query, k=10, user_id=unit)
    retrieve_ms = (time.perf_counter() - t0) * 1000
    provider.cleanup()
    block = "\n\n---\n\n".join(d.content for d in found if d.content) or "(no relevant memories found)"
    retrieved = [back.get(d.id, d.id) for d in found]
    decision = [d.id for d in originals if d.id.endswith(":decision-commit") or ":chat" in d.id]
    receipt = {
        "unit": unit, "documents": len(docs), "document_tokens_cl100k": sum(count_tokens(d.content or "") for d in docs),
        "ingest_s": round(ingest_s, 2), "ingest": provider.last_ingest_receipt(unit),
        "retrieve_ms": round(retrieve_ms, 1), "delivery": meta, "context_tokens_cl100k": count_tokens(block),
        "retrieved": retrieved, "decision_documents": decision,
        "decision_retrieved": [d for d in decision if d in retrieved],
        "decision_ranks": [retrieved.index(d) + 1 for d in decision if d in retrieved],
    }
    leaks = [x for x in [query.id, *[d.id for d in originals]] if x in block]
    if leaks:
        raise RuntimeError(f"dataset ids in the injected context: {leaks[:3]}")
    return block, receipt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--tasks", required=True, help="comma-separated task ids (e.g. boltons-discount-001) or all")
    ap.add_argument("--arms", default="none,gbrain")
    ap.add_argument("--model", required=True, help="opencode model id, e.g. google/gemini-3.8-flash")
    ap.add_argument("--max-interventions", type=int, default=5)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--retrieval-only", action="store_true", help="gbrain arm: ingest and retrieve, record decision recall, run no agent")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    harness_root = Path(os.environ["MPW_HARNESS_SRC"])
    run_py = harness_root / "sdebench" / "harness" / "run.py"
    sdebench_module._DATASETS = harness_root / "sdebench" / "datasets"
    proxy_log = Path(os.environ["MPW_PROXY_LOG"])
    exhausted = Path(os.environ["MPW_PROXY_EXHAUSTED_FLAG"])
    ds = SdebenchDataset()
    queries = {q.id: q for q in ds.load_queries("boltons")}
    tasks = list(queries) if args.tasks == "all" else [t.strip() for t in args.tasks.split(",") if t.strip()]
    missing = [t for t in tasks if t not in queries]
    if missing:
        raise SystemExit(f"unknown task ids {missing}; the dataset has {len(queries)} tasks")
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    if any(a not in HISTORY for a in arms):
        raise SystemExit(f"arms must be among {sorted(HISTORY)}")

    provider = None
    if "gbrain" in arms:
        provider = GbrainMemoryProvider()
        provider.prepare(out / "store", reset=True)

    records = []
    for tid in tasks:
        q = queries[tid]
        for arm in arms:
            if exhausted.exists():
                print(f"[spike] budget exhausted; stopping before {tid}/{arm}", flush=True)
                break
            rec_dir = out / "tasks" / tid / arm
            rec_dir.mkdir(parents=True, exist_ok=True)
            start = now_iso()
            rec: dict = {"task_id": tid, "arm": arm, "history": HISTORY[arm], "source": q.meta.get("source"),
                         "tier": q.meta.get("tier"), "category": q.meta.get("category"), "model": args.model,
                         "started_at": start}
            cmd = [sys.executable, str(run_py), "--task", q.meta["task_json"], "--history", HISTORY[arm],
                   "--agent", "opencode", "--model", args.model, "--run-id", f"spike-{int(time.time())}",
                   "--max-interventions", str(args.max_interventions), "--timeout", str(args.timeout)]
            try:
                if arm == "gbrain":
                    block, retrieval = gbrain_context(provider, ds, q, out)
                    ctx = rec_dir / "context.txt"
                    ctx.write_text(block)
                    cmd += ["--external-memory", str(ctx)]
                    rec["retrieval"] = retrieval
                    if args.retrieval_only:
                        raise StopIteration
                t0 = time.perf_counter()
                proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(harness_root))
                rec["wall_s"] = round(time.perf_counter() - t0, 1)
                (rec_dir / "run.log").write_text((proc.stdout or "") + "\n--- stderr ---\n" + (proc.stderr or ""))
                rec["exit_code"] = proc.returncode
                work = Path("/tmp/sdebench/run") / f"{tid}_{HISTORY[arm]}_{cmd[cmd.index('--run-id') + 1]}"
                for name in ("result.json", "trace.json"):
                    if (work / name).exists():
                        shutil.copy(work / name, rec_dir / name)
                if (rec_dir / "result.json").exists():
                    res = json.loads((rec_dir / "result.json").read_text())
                    rec.update({k: res.get(k) for k in ("solved", "interventions", "capped", "final_pytest", "turns", "tokens", "patch_bytes")})
                    rec["harness_cost_usd"] = res.get("cost_usd")
                else:
                    rec.update({"solved": False, "interventions": None, "error": "run.py wrote no result.json",
                                "stderr_tail": (proc.stderr or proc.stdout or "")[-600:]})
            except StopIteration:
                rec.update({"solved": None, "interventions": None, "retrieval_only": True})
            except Exception as e:  # noqa: BLE001 - a failed task is a typed outcome, not a crash of the spike
                rec.update({"solved": False, "interventions": None, "error": f"{type(e).__name__}: {e}"})
            rec["ended_at"] = now_iso()
            time.sleep(1.0)
            rec["metered"] = spend(proxy_rows(proxy_log, start, now_iso()))
            (rec_dir / "record.json").write_text(json.dumps(rec, indent=2, default=str))
            records.append(rec)
            print(f"[spike] {tid} {arm}: solved={rec.get('solved')} interventions={rec.get('interventions')} "
                  f"metered=${rec['metered']['usd']:.4f} wall={rec.get('wall_s')}s {rec.get('error') or ''}", flush=True)
    if provider is not None:
        provider.cleanup()
    summary = {"tasks": tasks, "arms": arms, "model": args.model, "records": [
        {k: r.get(k) for k in ("task_id", "arm", "source", "solved", "interventions", "capped", "wall_s", "error")}
        | {"metered_usd": r["metered"]["usd"], "decision_ranks": (r.get("retrieval") or {}).get("decision_ranks")} for r in records]}
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
