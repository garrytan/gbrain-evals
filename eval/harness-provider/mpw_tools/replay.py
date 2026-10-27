"""Retrieval-only replay of a finished rag cell on another build, against a copy of its store.

  python -m mpw_tools.replay --cell <dir> --out <dir>

The launcher (`harness:cell replay`) copies the cell's store, points the provider at
the replay build and meters every request. No question is answered or judged here:
each scheduled question is retrieved again with the cell's own provider config,
and its delivered context is compared with the recorded one. Output, all in custody:

  <out>/<cell_id>/stages/retrieve/<qid>.json   the replayed retrieve records
  <out>/<cell_id>/cell.json                    the source cell file, with a `replay` block
  <out>/replay-diff.json                       per question: same / changed / failed / no_baseline

`mpw.reanswer --retrievals <out>/<cell_id> --questions <changed ids>` then answers only
the questions whose context changed. This module lives outside `mpw/` so it is not
part of any cell's wrapper revision.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from mpw import cell as cellmod
from mpw.records import read_record


def context(record: dict | None) -> list[str] | None:
    if not record or not record.get("ok"):
        return None
    return [d.get("content", "") for d in record.get("documents") or []]


async def replay(src: Path, out_root: Path) -> dict:
    stored = json.loads((src / "cell.json").read_text())["resolved"]
    fresh_resolve = cellmod.resolve
    # A replay runs another build by design; the wrapper, prompt and scorer revisions are carried from the cell.
    cellmod.resolve = lambda s: {**fresh_resolve(s), **{k: stored[k] for k in ("prompt_revision", "scorer_revision", "wrapper_revision")}}
    run = cellmod.CellRun(src)
    run.setup()
    store = Path(os.environ["MPW_STORE_DIR"])
    out = out_root / run.cell_id
    cell = json.loads((src / "cell.json").read_text())
    cell["replay"] = {"source_cell": run.cell_id, "gbrain_cli": os.environ.get("MPW_GBRAIN_CLI"), "note": "retrieval only, against a copy of the cell's store"}
    (out / "stages").mkdir(parents=True, exist_ok=True)
    (out / "cell.json").write_text(json.dumps(cell, indent=2) + "\n")
    prov = run.provider
    prov.initialize()
    prov.prepare(store, unit_ids={run.projection.unit_id(u) for u in run.pdocs_by_unit if u != "_all"} or None, reset=False)
    run.dir = out
    diff = {}
    try:
        by_unit: dict = {}
        for q in run.queries:
            by_unit.setdefault(str(q.user_id), []).append(q)
        for qs in by_unit.values():
            recs = await asyncio.gather(*[run._retrieve(q, run.pqueries[q.id]) for q in qs])
            for q, rec in zip(qs, recs):
                old = context(read_record(src, "retrieve", q.id, run.cell_id))
                new = context(rec.__dict__)
                diff[q.id] = "failed" if new is None else "no_baseline" if old is None else ("same" if new == old else "changed")
    finally:
        prov.cleanup()
    (out_root / "replay-diff.json").write_text(json.dumps({"source_cell": run.cell_id, "questions": diff}, indent=1) + "\n")
    counts = {k: sum(1 for v in diff.values() if v == k) for k in ("same", "changed", "failed", "no_baseline")}
    return {"source_cell": run.cell_id, "questions": len(diff), **counts}


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m mpw_tools.replay")
    ap.add_argument("--cell", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    print(json.dumps(asyncio.run(replay(Path(a.cell), Path(a.out)))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
