"""Joint blinded re-judge of answers from several cells.

  python -m mpw.rejudge --cell <dir> --cell <dir> [--seed N] --out <dir> --judge-model provider:model

All cells must cover the same dataset, split and schedule (the set of
scheduled query ids); anything else is refused. Every answer is blinded
before it reaches the judge: the judge prompt is built from the dataset's
question, gold answer and rubric plus the answer text with provider names,
cell ids and provider-style ids (opaque `d-`/`u-` ids, UUIDs) replaced by
`[redacted]`. Answers from all cells are judged in one order shuffled with
the recorded seed, by the dataset's own judge (`default_judge_llm()`, else
OMB_JUDGE_*), through the strict scorer. The judge model id must equal
`--judge-model` (the preregistered judge).

Output:
  <out>/<cell_id>/stages/judge/<qid>.json   JudgeRecord per scheduled answer
  <out>/unblinding.json                     seed, judge order, blind ids -> cell/question
  <out>/summary.json                        per-cell aggregate with fixed denominators
  <out>/judge-cache/                        judge responses (default cache)

Given the cached judge responses the output is byte-identical on rerun.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path

from .records import read_record, write_record
from .scorer import aggregate, judge_answer

REDACTED = "[redacted]"
PROVIDER_ID_PATTERNS = (
    re.compile(r"\b[du]-[0-9a-f]{6,}\b"),
    re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE),
)


def cell_identity(cell_dir: Path) -> dict:
    """cell id, dataset, split, schedule and provider from <cell>/cell.json."""
    cell = json.loads((Path(cell_dir) / "cell.json").read_text())
    spec = cell.get("spec") or {}
    resolved = cell.get("resolved") or {}
    cell_id = cell.get("cell_id") or cell.get("id")
    schedule = resolved.get("schedule")
    if not cell_id or not spec.get("dataset") or not spec.get("split") or not isinstance(schedule, list):
        raise ValueError(f"{cell_dir}/cell.json needs cell_id, spec.dataset, spec.split and resolved.schedule")
    return {
        "dir": Path(cell_dir),
        "cell_id": cell_id,
        "dataset": spec["dataset"],
        "split": spec["split"],
        "schedule": [str(q) for q in schedule],
        "provider": spec.get("provider"),
    }


def load_cells(cell_dirs: list[Path]) -> list[dict]:
    cells = [cell_identity(d) for d in cell_dirs]
    if len(cells) < 2:
        raise ValueError("a joint re-judge needs at least two cells")
    ids = [c["cell_id"] for c in cells]
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate cell ids: {ids}")
    first = cells[0]
    for c in cells[1:]:
        if (c["dataset"], c["split"]) != (first["dataset"], first["split"]):
            raise ValueError(f"cell {c['cell_id']} is {c['dataset']}/{c['split']}, "
                             f"cell {first['cell_id']} is {first['dataset']}/{first['split']}")
        if set(c["schedule"]) != set(first["schedule"]) or len(c["schedule"]) != len(first["schedule"]):
            raise ValueError(f"cell {c['cell_id']} has a different schedule from cell {first['cell_id']}; "
                             "re-judge only cells scheduled over the same questions")
    for c in cells:
        c["answers"] = {}
        for qid in c["schedule"]:
            record = read_record(c["dir"], "answer", qid, c["cell_id"])
            if record is not None:
                if record.get("query_id") != qid:
                    raise ValueError(f"{c['dir']} answer file for {qid} holds {record.get('query_id')}")
                c["answers"][qid] = record
    return cells


def blind_terms(cells: list[dict]) -> list[str]:
    """Strings that identify a provider or a cell and must not reach the judge."""
    terms = {"gbrain", "comparator"}
    try:
        from .names import comparator_key

        terms.add(comparator_key())
    except Exception as exc:
        raise RuntimeError(f"cannot resolve the comparator's harness key for blinding: {exc}") from exc
    for c in cells:
        terms.add(c["cell_id"])
        if isinstance(c.get("provider"), str) and c["provider"]:
            terms.add(c["provider"])
    return sorted(terms, key=len, reverse=True)


def scrub(text: str, terms: list[str]) -> tuple[str, int]:
    """The answer text with identifying terms and provider-style ids redacted, and the redaction count."""
    count = 0
    for pattern in PROVIDER_ID_PATTERNS:
        text, n = pattern.subn(REDACTED, text)
        count += n
    for term in terms:
        text, n = re.subn(re.escape(term), REDACTED, text, flags=re.IGNORECASE)
        count += n
    return text, count


def _blind_id(seed: int, position: int) -> str:
    return "b-" + hashlib.sha256(f"{seed}:{position}".encode()).hexdigest()[:12]


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def rejudge(
    cell_dirs: list[Path],
    out_dir: Path,
    *,
    seed: int,
    dataset,
    queries: dict,
    judge_llm,
    expected_judge_model: str,
    cache_dir: Path | None = None,
    retries: int = 1,
) -> dict:
    cells = load_cells(cell_dirs)
    if dataset.name != cells[0]["dataset"]:
        raise ValueError(f"cells are {cells[0]['dataset']}, dataset is {dataset.name}")
    if dataset.task_type != "open":
        raise ValueError(f"{dataset.name} is scored without a judge ({dataset.task_type}); "
                         "score its cells with mpw.scorer.judge_answer directly")
    if judge_llm.model_id != expected_judge_model:
        raise ValueError(f"{dataset.name} judge is {judge_llm.model_id}, expected {expected_judge_model}")
    missing_queries = [q for q in cells[0]["schedule"] if q not in queries]
    if missing_queries:
        raise ValueError(f"{len(missing_queries)} scheduled ids are not in {dataset.name}/{cells[0]['split']}: "
                         f"{missing_queries[:5]}")

    out_dir = Path(out_dir)
    cache_dir = Path(cache_dir) if cache_dir else out_dir / "judge-cache"
    terms = blind_terms(cells)
    schedule = sorted(cells[0]["schedule"])
    items = [(ci, qid) for ci, c in enumerate(cells) for qid in schedule if qid in c["answers"]]
    order = list(range(len(items)))
    random.Random(seed).shuffle(order)

    records: dict[str, dict] = {c["cell_id"]: {} for c in cells}
    unblinding = []
    for position, index in enumerate(order):
        ci, qid = items[index]
        cell = cells[ci]
        original = cell["answers"][qid]
        text, redactions = scrub(original.get("answer") or "", terms)
        blinded = {
            "cell_id": "blind",
            "query_id": qid,
            "ok": original.get("ok"),
            "outcome": original.get("outcome"),
            "answer": text,
            "task_type": original.get("task_type", "open"),
        }
        record = judge_answer(
            dataset=dataset, split=cell["split"], query=queries[qid], answer=blinded,
            judge_llm=judge_llm, expected_judge_model=expected_judge_model, cell_id="blind",
            cache_dir=cache_dir, retries=retries,
        )
        record.cell_id = cell["cell_id"]
        if record.error is None and original.get("error") and record.outcome in ("answer_failure", "retrieval_failure", "incomplete_ingest"):
            record.error = original["error"]
        write_record(out_dir / cell["cell_id"], "judge", qid, record)
        records[cell["cell_id"]][qid] = record
        unblinding.append({"position": position, "blind_id": _blind_id(seed, position),
                           "cell_id": cell["cell_id"], "query_id": qid, "redactions": redactions})

    schedule_sha = hashlib.sha256("\n".join(schedule).encode()).hexdigest()
    _write_json(out_dir / "unblinding.json", {
        "seed": seed, "schedule_sha256": schedule_sha, "judge_model": expected_judge_model, "order": unblinding,
    })
    summary = {
        "dataset": cells[0]["dataset"],
        "split": cells[0]["split"],
        "seed": seed,
        "schedule_size": len(schedule),
        "schedule_sha256": schedule_sha,
        "judge_model": expected_judge_model,
        "cells": {c["cell_id"]: aggregate(c["schedule"], records[c["cell_id"]], c["cell_id"]) for c in cells},
    }
    _write_json(out_dir / "summary.json", summary)
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m mpw.rejudge", description=__doc__.split("\n\n")[0])
    parser.add_argument("--cell", action="append", required=True, type=Path, help="cell directory (repeat, 2 or more)")
    parser.add_argument("--seed", type=int, default=0, help="shuffle seed, recorded in the output (default 0)")
    parser.add_argument("--out", required=True, type=Path, help="output directory")
    parser.add_argument("--judge-model", required=True, help="expected judge model id, provider:model")
    parser.add_argument("--cache", type=Path, default=None, help="judge response cache (default <out>/judge-cache)")
    args = parser.parse_args(argv)

    from .register import install

    install()
    from memory_bench.dataset import get_dataset

    from .scorer import resolve_judge_llm

    first = cell_identity(args.cell[0])
    dataset = get_dataset(first["dataset"])
    queries = {q.id: q for q in dataset.load_queries(first["split"])}
    try:
        summary = rejudge(args.cell, args.out, seed=args.seed, dataset=dataset, queries=queries,
                          judge_llm=resolve_judge_llm(dataset), expected_judge_model=args.judge_model,
                          cache_dir=args.cache)
    except (ValueError, RuntimeError) as exc:
        print(f"rejudge refused: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({cid: {k: agg[k] for k in ("scheduled", "mean_score", "accuracy", "complete")}
                      for cid, agg in summary["cells"].items()}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
