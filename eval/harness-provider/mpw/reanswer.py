"""Second answer sample for a finished rag cell, from its recorded retrievals.

  python -m mpw.reanswer --cell <dir> --out <dir> --sample N

Reads every scheduled question's retrieve record, rebuilds the answer prompt
exactly as the cell did (the rebuilt prompt must equal the recorded one, or the
run stops), and asks the answer model again. No memory system is started: the
delivered context is the recorded one, so the only thing that varies is the
answer. Output is a cell-shaped directory `<out>/<cell_id>-s<N>` with
`cell.json` and `stages/answer/`, which `mpw.rejudge` judges jointly with the
original cell.

With `--retrievals` (a replay) and `--questions`, a question outside the list
keeps the source cell's answer only when the replay classed its context `same`
(`<retrievals>/../replay-diff.json`). A `changed`, `failed` or `no_baseline`
question outside the list stops the run: it must be answered again or resolved.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from . import cell as cellmod
from .records import RetrieveRecord, read_record, write_record


async def reanswer(src: Path, out_root: Path, sample: int, retrievals: Path | None = None, only: set[str] | None = None, tag: str | None = None) -> dict:
    spec = json.loads((src / "cell.json").read_text())
    if spec["spec"]["mode"] != "rag":
        raise SystemExit(f"{src}: reanswer covers rag cells only (mode {spec['spec']['mode']})")
    stored = spec["resolved"]
    if retrievals is not None and only is not None:
        diff_path = retrievals.parent / "replay-diff.json"
        if not diff_path.exists():
            raise SystemExit(f"{diff_path} is missing: without the replay's classes no question can keep the source cell's answer")
        classes = json.loads(diff_path.read_text())["questions"]
        unresolved = sorted(q for q in stored["schedule"] if q not in only and classes.get(q) != "same")
        if unresolved:
            raise SystemExit(f"{len(unresolved)} question(s) outside --questions are not `same` in the replay "
                             f"({', '.join(f'{q}={classes.get(q)}' for q in unresolved[:10])}); only `same` rows keep the source answer")
    fresh_resolve = cellmod.resolve
    # The prompt is checked byte for byte below, so a wrapper or scorer revision change since the cell ran is allowed.
    cellmod.resolve = lambda s: {**fresh_resolve(s), **{k: stored[k] for k in ("prompt_revision", "scorer_revision", "wrapper_revision")}}
    cellmod._provider = lambda s: None
    run = cellmod.CellRun(src)
    run.setup()
    new_id = f"{run.cell_id}-{tag}" if tag else f"{run.cell_id}-s{sample}"
    out = out_root / new_id
    (out / "stages" / "answer").mkdir(parents=True, exist_ok=True)
    cell = json.loads((src / "cell.json").read_text())
    cell["cell_id"] = new_id
    cell["reanswer"] = {"source_cell": run.cell_id, "sample": sample, "retrievals": str(retrievals) if retrievals else None,
                        "questions": sorted(only) if only is not None else "all",
                        "note": "answers regenerated from recorded retrievals; questions outside `questions` keep the source cell's answer"}
    (out / "cell.json").write_text(json.dumps(cell, indent=2) + "\n")
    counts = {"answered": 0, "failed": 0, "prompt_mismatch": 0}
    for q in run.queries:
        pq = run.pqueries[q.id]
        orig = read_record(src, "answer", q.id, run.cell_id)
        if only is not None and q.id not in only:
            if orig is not None:
                write_record(out, "answer", q.id, {**orig, "cell_id": new_id})
                counts["kept"] = counts.get("kept", 0) + 1
            continue
        ret = read_record(retrievals or src, "retrieve", q.id, run.cell_id)
        if ret is None or orig is None or not ret.get("ok"):
            counts["failed"] += 1
            continue
        from memory_bench.models import Document

        docs = [Document(**d) for d in ret["documents"]]
        unit = str(q.user_id) if str(q.user_id) in run.pdocs_by_unit else "_all"
        base = dict(cell_id=new_id, query_id=q.id, task_type=run.task_type, answer_model=run.answer_llm.model_id)
        rec = await run._answer_rag(q, pq, docs, RetrieveRecord(**ret), f"{new_id}/answer/{pq.id}", base, unit)
        if retrievals is None and orig.get("final_prompt") and rec.final_prompt and rec.final_prompt != orig["final_prompt"]:
            counts["prompt_mismatch"] += 1
            raise SystemExit(f"{q.id}: the rebuilt prompt differs from the recorded one; refusing to reanswer this cell")
        write_record(out, "answer", q.id, rec)
        counts["answered" if rec.ok else "failed"] += 1
    return {"source_cell": run.cell_id, "cell_id": new_id, "out": str(out), **counts}


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m mpw.reanswer")
    ap.add_argument("--cell", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--sample", type=int, default=2)
    ap.add_argument("--retrievals", help="cell-shaped dir of replayed retrieve records (mpw_tools.replay)")
    ap.add_argument("--questions", help="JSON list of question ids to answer; the rest keep the source cell's answer")
    ap.add_argument("--tag", help="suffix for the new cell id instead of s<sample>")
    args = ap.parse_args()
    only = set(json.loads(Path(args.questions).read_text())) if args.questions else None
    print(json.dumps(asyncio.run(reanswer(Path(args.cell), Path(args.out), args.sample, Path(args.retrievals) if args.retrievals else None, only, args.tag))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
