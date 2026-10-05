"""Tune a provider's retrieval knobs to a delivered-context target on an ingested cell.

  python -m mpw.tune --cell-dir <dir> --grid '{"token_budget": [6000, 7000, 8000]}'

Reuses the cell's ingested store (no new ingest), retrieves every scheduled
question once per knob setting, renders the context exactly as the answer
stage would, runs the dataset's own prompt builder and counts the inserted
context with cl100k_base. No answer or judge model is called; the only model
traffic is what retrieval itself makes (gbrain: one query embedding per
question), metered by the proxy. Writes `<cell>/tuning/<timestamp>.json` with
mean, p95 and the ±10% gate per setting, and names the closest passing one.
Tuning belongs on dev cells; the chosen knobs go into the spec of the cells
that are then planned and run.
"""
from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import time
from pathlib import Path

from . import context as ctxmod
from .cell import CellRun, _provider, _render_rag_context


def _settings(grid: dict) -> list[dict]:
    keys = sorted(grid)
    return [dict(zip(keys, values)) for values in itertools.product(*(grid[k] for k in keys))]


def _sample(queries: list, n: int | None) -> list:
    """Every k-th question in schedule order, so each unit and category keeps its share."""
    if not n or n >= len(queries):
        return list(queries)
    step = len(queries) / n
    return [queries[int(i * step)] for i in range(n)]


async def _measure(run, prov, queries, spec, task) -> tuple[list[int], list[str]]:
    tokens, errors = [], []
    sem = asyncio.Semaphore(int(getattr(prov, "concurrency", 4) or 1))

    async def one(q):
        pq = run.pqueries[q.id]
        k = int(pq.meta.get("retrieval_limit") or spec.get("k") or 10)
        async with sem:
            try:
                with_meta = getattr(prov, "retrieve_with_meta", None)
                if with_meta is not None:
                    docs, raw, _ = await asyncio.to_thread(with_meta, pq.query, k, pq.user_id, pq.meta.get("query_timestamp"))
                else:
                    docs, raw = await prov.async_retrieve(pq.query, k=k, user_id=pq.user_id, query_timestamp=pq.meta.get("query_timestamp"))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{q.id}: {type(e).__name__}: {e}"[:300])
                return
        rendered = _render_rag_context(docs)
        meta = dict(pq.meta)

        def build(qq, cc, meta):
            return run.dataset.build_rag_prompt(qq, cc, task, run.split, None, meta)

        prompt = build(pq.query, rendered, {**meta, "_raw_response": raw})
        tokens.append(ctxmod.inserted_context(build, pq.query, rendered, meta, raw, prompt).tokens)

    await asyncio.gather(*[one(q) for q in queries])
    return tokens, errors


async def auto_tune(cell_dir: Path, targets: list[int], base: dict, sample: int | None, max_iter: int = 6) -> dict:
    """Scale the knobs in `base` together until each target's delivered mean and p95 pass the ±10% gate on the sample."""
    run = CellRun(cell_dir)
    run.setup()
    task = run.task_type
    base_cfg = dict(run.spec.get("provider_config") or {})
    prov = _provider({**run.spec, "provider_config": base_cfg})
    knobs = getattr(prov, "config", None) if isinstance(getattr(prov, "config", None), dict) else getattr(prov, "cfg", None)
    prov.initialize()
    prov.prepare(run.store, unit_ids=None, reset=False)
    queries = _sample(run.queries, sample)
    results = {}
    try:
        for target in targets:
            scale = target / 8000
            rows = []
            chosen = None
            for _ in range(max_iter):
                setting = {k: max(1, int(round(v * scale))) for k, v in base.items()}
                knobs.update(setting)
                tokens, errors = await _measure(run, prov, queries, run.spec, task)
                gate = ctxmod.gate(target, tokens)
                mean = gate.mean or 1.0
                rows.append({"setting": setting, **gate.as_dict(), "errors": errors[:5]})
                if not errors and gate.ok:
                    chosen = setting
                    break
                scale *= max(0.5, min(2.0, target / mean))
            results[str(target)] = {"chosen": chosen, "rows": rows}
    finally:
        prov.cleanup()
    out = {"cell_id": run.cell_id, "mode": "auto", "base": base, "sample": len(queries), "targets": results,
           "note": "retrieval-only tuning on an ingested store; no answer or judge calls; knobs scaled together"}
    (cell_dir / "tuning").mkdir(exist_ok=True)
    (cell_dir / "tuning" / f"auto-{time.strftime('%Y%m%dT%H%M%S')}.json").write_text(json.dumps(out, indent=2) + "\n")
    return out


async def tune(cell_dir: Path, grid: dict) -> dict:
    run = CellRun(cell_dir)
    run.setup()
    target = run.spec.get("target_tokens")
    task = run.task_type
    base_cfg = dict(run.spec.get("provider_config") or {})
    rows = []
    # One provider (and one server) for the whole sweep; each setting rewrites its knob dict in place.
    prov = _provider({**run.spec, "provider_config": base_cfg})
    knobs = getattr(prov, "config", None) if isinstance(getattr(prov, "config", None), dict) else getattr(prov, "cfg", None)
    if not isinstance(knobs, dict):
        raise RuntimeError(f"{run.spec['provider']} exposes no knob dict (config or cfg) to sweep")
    prov.initialize()
    prov.prepare(run.store, unit_ids=None, reset=False)
    for setting in _settings(grid):
        spec = {**run.spec, "provider_config": {**base_cfg, **setting}}
        knobs.update(setting)
        tokens, errors = [], []
        for q in run.queries:
            pq = run.pqueries[q.id]
            k = int(pq.meta.get("retrieval_limit") or spec.get("k") or 10)
            try:
                with_meta = getattr(prov, "retrieve_with_meta", None)
                if with_meta is not None:
                    docs, raw, _ = await asyncio.to_thread(with_meta, pq.query, k, pq.user_id, pq.meta.get("query_timestamp"))
                else:
                    docs, raw = await prov.async_retrieve(pq.query, k=k, user_id=pq.user_id, query_timestamp=pq.meta.get("query_timestamp"))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{q.id}: {type(e).__name__}: {e}"[:300])
                continue
            rendered = _render_rag_context(docs)
            meta = dict(pq.meta)

            def build(qq, cc, meta):
                return run.dataset.build_rag_prompt(qq, cc, task, run.split, None, meta)

            prompt = build(pq.query, rendered, {**meta, "_raw_response": raw})
            tokens.append(ctxmod.inserted_context(build, pq.query, rendered, meta, raw, prompt).tokens)
        gate = ctxmod.gate(target, tokens)
        rows.append({"setting": setting, **gate.as_dict(), "errors": errors})
    prov.cleanup()
    passing = [r for r in rows if r["ok"] and not r["errors"]]
    best = min(passing, key=lambda r: abs(r["mean"] - (target or r["mean"]))) if passing else None
    out = {"cell_id": run.cell_id, "target": target, "questions": len(run.queries), "rows": rows,
           "chosen": best["setting"] if best else None,
           "note": "retrieval-only tuning on an ingested cell; no answer or judge calls"}
    (cell_dir / "tuning").mkdir(exist_ok=True)
    (cell_dir / "tuning" / f"{time.strftime('%Y%m%dT%H%M%S')}.json").write_text(json.dumps(out, indent=2) + "\n")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m mpw.tune")
    ap.add_argument("--cell-dir", required=True)
    ap.add_argument("--grid", help='JSON object: knob -> list of values')
    ap.add_argument("--auto", help='JSON {"targets": [4000, ...], "base": {knob: value at 8k}, "sample": N}')
    args = ap.parse_args()
    if args.auto:
        spec = json.loads(args.auto)
        out = asyncio.run(auto_tune(Path(args.cell_dir), spec["targets"], spec["base"], spec.get("sample")))
        print(json.dumps({t: r["chosen"] for t, r in out["targets"].items()}))
        return 0 if all(r["chosen"] for r in out["targets"].values()) else 4
    out = asyncio.run(tune(Path(args.cell_dir), json.loads(args.grid)))
    print(json.dumps({"chosen": out["chosen"], "rows": [{k: r[k] for k in ("setting", "mean", "p95", "ok")} for r in out["rows"]]}))
    return 0 if out["chosen"] is not None else 4


if __name__ == "__main__":
    raise SystemExit(main())
