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


async def tune(cell_dir: Path, grid: dict) -> dict:
    run = CellRun(cell_dir)
    run.setup()
    target = run.spec.get("target_tokens")
    task = run.task_type
    base_cfg = dict(run.spec.get("provider_config") or {})
    rows = []
    for setting in _settings(grid):
        spec = {**run.spec, "provider_config": {**base_cfg, **setting}}
        prov = _provider(spec)
        prov.initialize()
        prov.prepare(cell_dir / "store", unit_ids=None, reset=False)
        tokens, errors = [], []
        try:
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
        finally:
            prov.cleanup()
        gate = ctxmod.gate(target, tokens)
        rows.append({"setting": setting, **gate.as_dict(), "errors": errors})
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
    ap.add_argument("--grid", required=True, help='JSON object: knob -> list of values')
    args = ap.parse_args()
    out = asyncio.run(tune(Path(args.cell_dir), json.loads(args.grid)))
    print(json.dumps({"chosen": out["chosen"], "rows": [{k: r[k] for k in ("setting", "mean", "p95", "ok")} for r in out["rows"]]}))
    return 0 if out["chosen"] is not None else 4


if __name__ == "__main__":
    raise SystemExit(main())
