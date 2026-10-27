"""Joint blinded re-judge: blinding, shuffling, schedule checks, judge model assertion, determinism."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import BEAM_JUDGE, answer_record
from mpw import rejudge, scorer
from mpw.names import comparator_key
from mpw.records import write_record

SCHEDULE = ["c1_information_extraction_0", "c1_abstention_0", "c1_multi_session_reasoning_0"]


def make_cell(root: Path, cell_id: str, provider: str, answers: dict[str, str], schedule=SCHEDULE,
              dataset="beam", split="100k") -> Path:
    cell = root / cell_id
    cell.mkdir(parents=True)
    (cell / "cell.json").write_text(json.dumps({
        "cell_id": cell_id,
        "spec": {"dataset": dataset, "split": split, "provider": provider},
        "resolved": {"schedule": schedule},
    }))
    for qid, text in answers.items():
        write_record(cell, "answer", qid, answer_record(cell_id, qid, text))
    return cell


@pytest.fixture
def cells(tmp_path):
    key = comparator_key()
    a = make_cell(tmp_path / "cells", "cell-aaa111", "gbrain", {
        "c1_information_extraction_0": "Your dog is Rex (from gbrain page d-1a2b3c4d5e).",
        "c1_abstention_0": "Based on the provided chat, there is no information related to a cat.",
        "c1_multi_session_reasoning_0": "Rex and Lisbon. cell-aaa111 says hi.",
    })
    b = make_cell(tmp_path / "cells", "cell-bbb222", "comparator", {
        "c1_information_extraction_0": f"Rex, according to {key.upper()} fact 123e4567-e89b-12d3-a456-426614174000.",
        "c1_abstention_0": "Your cat is Tom (comparator memory u-deadbeef01).",
        "c1_multi_session_reasoning_0": f"Just Rex, per {key}.",
    })
    return [a, b]


def run(cells, out, beam, beam_queries, seed=7, expected=BEAM_JUDGE, cache=None):
    return rejudge.rejudge(cells, out, seed=seed, dataset=beam, queries=beam_queries,
                           judge_llm=scorer.resolve_judge_llm(beam), expected_judge_model=expected, cache_dir=cache)


def test_no_provider_identity_reaches_the_judge(tmp_path, cells, beam, beam_queries, fake_gemini):
    summary = run(cells, tmp_path / "out", beam, beam_queries)
    prompts = [p for inst in fake_gemini["instances"] for p in inst.prompts]
    assert len(prompts) == 8  # 1 + 1 + 2 rubric items per cell
    forbidden = ["gbrain", "comparator", comparator_key(), "cell-aaa111", "cell-bbb222", "d-1a2b3c4d5e",
                 "u-deadbeef01", "123e4567-e89b-12d3-a456-426614174000"]
    for prompt in prompts:
        for term in forbidden:
            assert term.lower() not in prompt.lower(), f"{term!r} reached the judge"
    assert any("[redacted]" in p for p in prompts)

    cells_out = summary["cells"]
    assert cells_out["cell-aaa111"]["mean_score"] == 1.0 and cells_out["cell-aaa111"]["complete"]
    assert cells_out["cell-bbb222"]["mean_score"] == pytest.approx((1.0 + 0.0 + 0.5) / 3)
    assert summary["judge_model"] == BEAM_JUDGE and summary["seed"] == 7

    record = json.loads((tmp_path / "out/cell-bbb222/stages/judge/c1_abstention_0.json").read_text())
    assert record["cell_id"] == "cell-bbb222" and record["judge_model"] == BEAM_JUDGE
    assert record["outcome"] == "answered" and record["score"] == 0.0


def test_order_is_shuffled_with_the_recorded_seed(tmp_path, cells, beam, beam_queries, fake_gemini):
    run(cells, tmp_path / "s7", beam, beam_queries, seed=7)
    run(cells, tmp_path / "s8", beam, beam_queries, seed=8)
    o7 = json.loads((tmp_path / "s7/unblinding.json").read_text())
    o8 = json.loads((tmp_path / "s8/unblinding.json").read_text())
    natural = [(c, q) for c in ("cell-aaa111", "cell-bbb222") for q in sorted(SCHEDULE)]
    order7 = [(e["cell_id"], e["query_id"]) for e in o7["order"]]
    order8 = [(e["cell_id"], e["query_id"]) for e in o8["order"]]
    assert o7["seed"] == 7 and sorted(order7) == sorted(natural)
    assert order7 != natural and order7 != order8
    assert len({e["blind_id"] for e in o7["order"]}) == len(order7)
    redactions = {(e["cell_id"], e["query_id"]): e["redactions"] for e in o7["order"]}
    assert redactions[("cell-aaa111", "c1_abstention_0")] == 0
    assert redactions[("cell-bbb222", "c1_information_extraction_0")] == 2


def test_rerun_with_cached_judge_responses_is_byte_identical(tmp_path, cells, beam, beam_queries, fake_gemini):
    cache = tmp_path / "cache"
    run(cells, tmp_path / "first", beam, beam_queries, cache=cache)
    fake_gemini["respond"] = lambda p, s, n: pytest.fail("judge called despite a warm cache")
    run(cells, tmp_path / "second", beam, beam_queries, cache=cache)
    first = {p.relative_to(tmp_path / "first"): p.read_bytes() for p in (tmp_path / "first").rglob("*.json")}
    second = {p.relative_to(tmp_path / "second"): p.read_bytes() for p in (tmp_path / "second").rglob("*.json")}
    assert first and first == second


def test_judge_model_must_match(tmp_path, cells, beam, beam_queries, fake_gemini):
    with pytest.raises(ValueError, match="expected gemini:gemini-2.5-flash-lite"):
        run(cells, tmp_path / "out", beam, beam_queries, expected="gemini:gemini-2.5-flash-lite")
    assert all(not inst.prompts for inst in fake_gemini["instances"])


def test_mismatched_cells_are_refused(tmp_path, beam, beam_queries, fake_gemini):
    root = tmp_path / "cells"
    a = make_cell(root, "cell-a", "gbrain", {})
    short = make_cell(root, "cell-short", "comparator", {}, schedule=SCHEDULE[:2])
    other_split = make_cell(root, "cell-split", "comparator", {}, split="500k")
    with pytest.raises(ValueError, match="different schedule"):
        run([a, short], tmp_path / "o1", beam, beam_queries)
    with pytest.raises(ValueError, match="100k"):
        run([a, other_split], tmp_path / "o2", beam, beam_queries)
    with pytest.raises(ValueError, match="at least two cells"):
        run([a], tmp_path / "o3", beam, beam_queries)
    with pytest.raises(ValueError, match="duplicate cell ids"):
        run([a, a], tmp_path / "o4", beam, beam_queries)


def test_missing_answers_keep_the_denominator(tmp_path, beam, beam_queries, fake_gemini):
    root = tmp_path / "cells"
    a = make_cell(root, "cell-a", "gbrain", {q: "Rex and Lisbon; there is no information related to a cat." for q in SCHEDULE})
    b = make_cell(root, "cell-b", "comparator", {"c1_information_extraction_0": "Rex"})
    summary = run([a, b], tmp_path / "out", beam, beam_queries)
    agg = summary["cells"]["cell-b"]
    assert agg["scheduled"] == 3 and agg["counts"]["missing"] == 2
    assert agg["mean_score"] == pytest.approx(1 / 3) and agg["complete"] is False


def test_cli(tmp_path, cells, beam, fake_gemini, capsys):
    out = tmp_path / "cli"
    args = ["--cell", str(cells[0]), "--cell", str(cells[1]), "--seed", "3", "--out", str(out)]
    assert rejudge.main(args + ["--judge-model", BEAM_JUDGE]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert set(printed) == {"cell-aaa111", "cell-bbb222"} and printed["cell-aaa111"]["scheduled"] == 3
    assert json.loads((out / "summary.json").read_text())["seed"] == 3
    assert rejudge.main(args + ["--judge-model", "openai:not-the-beam-judge"]) == 2
    assert "rejudge refused" in capsys.readouterr().err
