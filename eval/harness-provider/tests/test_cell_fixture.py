"""End-to-end cell run on the committed fixture with the harness BM25 provider and the stub LLM."""
import asyncio
import json
import sys
import types
from pathlib import Path

import pytest

from mpw import cell as cellmod
from mpw import leakage
from mpw.records import JudgeRecord


@pytest.fixture
def shim_scorer(monkeypatch):
    """A minimal scorer until mpw/scorer.py lands (kept only when the real one is absent)."""
    try:
        import mpw.scorer  # noqa: F401
        return
    except ImportError:
        pass
    mod = types.ModuleType("mpw.scorer")

    def judge_answer(*, dataset, split, query, answer, judge_llm, expected_judge_model, cell_id, retrieved_original):
        if answer["outcome"] != "answered":
            return JudgeRecord(cell_id, query.id, answer["outcome"], 0.0, False, None)
        ok = query.gold_answers[0].lower().rstrip(".") in answer["answer"].lower()
        return JudgeRecord(cell_id, query.id, "answered", 1.0 if ok else 0.0, ok, judge_llm.model_id if judge_llm else None)

    def aggregate(schedule, records):
        scores = [records[q]["score"] if q in records else 0.0 for q in schedule]
        return {"scheduled": len(schedule), "mean": sum(scores) / len(schedule), "complete": all(q in records for q in schedule)}

    mod.judge_answer, mod.aggregate = judge_answer, aggregate
    monkeypatch.setitem(sys.modules, "mpw.scorer", mod)
    import mpw
    monkeypatch.setattr(mpw, "scorer", mod, raising=False)


def make_cell(tmp_path: Path, spec: dict, cell_id: str = "fixture-test-cell") -> Path:
    resolved = cellmod.resolve(spec)
    d = tmp_path / cell_id
    d.mkdir()
    (d / "cell.json").write_text(json.dumps({"cell_id": cell_id, "spec": spec, "resolved": resolved}))
    return d


SPEC = {"dataset": "fixture", "split": "tiny", "provider": "bm25", "mode": "rag", "k": 2,
        "models": {"answer": "mpw-stub:answer-1", "judge": "mpw-stub:judge-1"}, "target_tokens": None}


def test_fixture_cell_runs_and_writes_stage_receipts(tmp_path, stub_models, shim_scorer):
    d = make_cell(tmp_path, SPEC)
    summary = asyncio.run(cellmod.CellRun(d).run())
    for stage in ("ingest", "retrieve", "answer", "judge"):
        assert list((d / "stages" / stage).glob("*.json")), stage
    answers = [json.loads(p.read_text()) for p in (d / "stages" / "answer").glob("*.json")]
    assert len(answers) == 4
    for a in answers:
        assert a["outcome"] == "answered"
        assert a["final_prompt"] and a["inserted_context"] in a["final_prompt"]
        assert a["inserted_tokens_cl100k"] > 0
        assert "answer_" not in a["final_prompt"]
        assert a["leak_check"]["ok"]
    assert summary["scheduled"] == 4 and summary["judged_receipts"] == 4
    manifest = json.loads((d / "timestamp-manifest.json").read_text())
    assert set(manifest["documents"].values()) == {"observed_session_time"}
    maps = json.loads((d / "scorer" / "reverse-maps.json").read_text())
    assert any(v.endswith("answer_a11ce001") for v in maps["doc_ids"].values())


def test_resume_skips_done_work_and_refuses_foreign_receipts(tmp_path, stub_models, shim_scorer):
    d = make_cell(tmp_path, SPEC)
    asyncio.run(cellmod.CellRun(d).run())
    before = {p: p.stat().st_mtime_ns for p in (d / "stages").rglob("*.json")}
    asyncio.run(cellmod.CellRun(d).run())
    after = {p: p.stat().st_mtime_ns for p in (d / "stages").rglob("*.json")}
    assert before == after
    p = next((d / "stages" / "answer").glob("*.json"))
    rec = json.loads(p.read_text())
    rec["cell_id"] = "another-cell"
    p.write_text(json.dumps(rec))
    with pytest.raises(RuntimeError, match="belongs to cell"):
        asyncio.run(cellmod.CellRun(d).run())


def test_changed_schedule_refuses_resume(tmp_path, stub_models, shim_scorer):
    d = make_cell(tmp_path, SPEC)
    cell = json.loads((d / "cell.json").read_text())
    cell["resolved"]["dataset_manifest_sha256"] = "0" * 64
    (d / "cell.json").write_text(json.dumps(cell))
    with pytest.raises(cellmod.CellError, match="dataset_manifest_sha256 changed"):
        asyncio.run(cellmod.CellRun(d).run())


def test_leak_in_prompt_blocks_dispatch(tmp_path, stub_models, shim_scorer, monkeypatch):
    """A provider that echoes a raw dataset id must stop the cell before the answer model sees it."""
    import memory_bench.memory as memory_pkg
    from memory_bench.models import Document
    from memory_bench.memory.base import MemoryProvider

    class Echo(MemoryProvider):
        name = "echo"
        description = "test"
        kind = "local"

        def ingest(self, documents):
            pass

        def retrieve(self, query, k=10, user_id=None, query_timestamp=None):
            return [Document(id="x", content="from session fx-user-ada_answer_a11ce001")], None

    monkeypatch.setitem(memory_pkg.REGISTRY, "echo", Echo)
    d = make_cell(tmp_path, {**SPEC, "provider": "echo"})
    run = cellmod.CellRun(d)
    with pytest.raises(leakage.LeakError):
        asyncio.run(run.run())
    from memory_bench.llm import get_answer_llm  # noqa: F401
    assert not list((d / "stages" / "answer").glob("*.json")) if (d / "stages" / "answer").exists() else True


def test_empty_context_still_calls_the_answer_model(tmp_path, stub_models, shim_scorer, monkeypatch):
    import memory_bench.memory as memory_pkg
    from memory_bench.memory.base import MemoryProvider

    class Empty(MemoryProvider):
        name = "empty"
        description = "test"
        kind = "local"

        def ingest(self, documents):
            pass

        def retrieve(self, query, k=10, user_id=None, query_timestamp=None):
            return [], None

    monkeypatch.setitem(memory_pkg.REGISTRY, "empty", Empty)
    d = make_cell(tmp_path, {**SPEC, "provider": "empty"})
    asyncio.run(cellmod.CellRun(d).run())
    answers = [json.loads(p.read_text()) for p in (d / "stages" / "answer").glob("*.json")]
    assert answers and all(a["outcome"] == "answered" and a["final_prompt"] for a in answers)
    assert all(a["inserted_context"] == "" for a in answers)


def test_retrieval_errors_are_typed_not_empty(tmp_path, stub_models, shim_scorer, monkeypatch):
    import memory_bench.memory as memory_pkg
    from memory_bench.memory.base import MemoryProvider

    class Broken(MemoryProvider):
        name = "broken"
        description = "test"
        kind = "local"

        def ingest(self, documents):
            pass

        def retrieve(self, query, k=10, user_id=None, query_timestamp=None):
            raise ConnectionError("server went away")

    monkeypatch.setitem(memory_pkg.REGISTRY, "broken", Broken)
    d = make_cell(tmp_path, {**SPEC, "provider": "broken"})
    asyncio.run(cellmod.CellRun(d).run())
    answers = [json.loads(p.read_text()) for p in (d / "stages" / "answer").glob("*.json")]
    assert answers and all(a["outcome"] == "retrieval_failure" for a in answers)
