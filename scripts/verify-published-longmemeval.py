#!/usr/bin/env python3
"""Recount saved retrieval outcomes. This does not repeat model calls or re-judge answers."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs/benchmarks/2026-09-06-longmemeval-ranker-wave/longmemeval"


def rows(path):
    result = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    result = [r for r in result if r.get("question_id")]
    if len({r["question_id"] for r in result}) != len(result):
        raise ValueError("Duplicate questions: " + str(path))
    return result


def verify():
    judged = rows(SOURCE / "D1-judged-release-config-sonnet46-reader-gpt4o-judge.ndjson")
    gold = {r["question_id"]: r for r in judged}
    assert len(gold) == 500
    output = dict(source_run_date="2026-09-06", verification="Recomputed sets from saved rankings and saved gold session IDs",
                  limitation="Does not validate against a new dataset download or re-judge omitted answer strings", arms=[])
    for path in sorted(SOURCE.glob("*.ndjson")):
        data = rows(path)
        scored, all_hits, any_hits = 0, 0, 0
        for r in data:
            reference = gold[r["question_id"]]
            if reference["abstention"]:
                continue
            expected = set(reference["answer_session_ids"])
            returned = set(r["retrieved_session_ids"])
            all_hit, any_hit = expected <= returned, bool(expected & returned)
            assert all_hit == r["recall_all_hit"], (path.name, r["question_id"], "all")
            assert any_hit == r["recall_any_hit"], (path.name, r["question_id"], "any")
            scored += 1
            all_hits += all_hit
            any_hits += any_hit
        output["arms"].append(dict(artifact=str(path.relative_to(ROOT)), sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                                   questions=len(data), scored=scored, all_hits=all_hits, any_hits=any_hits, mismatches=0))
    output["judged"] = dict(questions=len(judged), correct=sum(r["judge_correct"] is True for r in judged),
                            note="Recount of stored judge booleans; answer text and raw judge output were not retained")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output")
    args = parser.parse_args()
    text = json.dumps(verify(), indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(text)
    else:
        print(text, end="")
