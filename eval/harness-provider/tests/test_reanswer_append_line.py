"""mpw.reanswer --append-line: the line lands only on listed questions, and every prompt is checked before it is sent."""
from __future__ import annotations

import asyncio
import json

import pytest

from mpw import cell as cellmod
from mpw.reanswer import reanswer
from mpw.stub_llm import StubLLM

from test_cell_fixture import SPEC, make_cell, shim_scorer  # noqa: F401

LINE = "gbrain found no evidence for this question"


def _answers(d):
    return {json.loads(p.read_text())["query_id"]: json.loads(p.read_text()) for p in (d / "stages" / "answer").glob("*.json")}


@pytest.fixture
def source(tmp_path, stub_models, shim_scorer, monkeypatch):  # noqa: F811
    monkeypatch.setattr(cellmod, "resolve", cellmod.resolve)
    monkeypatch.setattr(cellmod, "_provider", cellmod._provider)
    d = make_cell(tmp_path, SPEC)
    asyncio.run(cellmod.CellRun(d).run())
    return d


@pytest.fixture
def sent(monkeypatch):
    prompts: list[str] = []
    real = StubLLM.generate

    def counting(self, prompt, schema):
        prompts.append(prompt)
        return real(self, prompt, schema)

    monkeypatch.setattr(StubLLM, "generate", counting)
    return prompts


def test_the_line_goes_only_on_listed_questions_after_the_recorded_context(source, tmp_path, sent):
    orig = _answers(source)
    qid = sorted(orig)[0]
    out = asyncio.run(reanswer(source, tmp_path / "out", 2, tag="oracle", append_line=LINE, line_ids={qid}))
    new = _answers(tmp_path / "out" / out["cell_id"])
    assert out["prompt_mismatch"] == 0 and out["answered"] == len(orig)
    ctx = orig[qid]["rendered_context"]
    assert new[qid]["final_prompt"] == orig[qid]["final_prompt"].replace(ctx, f"{ctx}\n\n{LINE}")
    assert new[qid]["rendered_context"].endswith(f"\n\n{LINE}")
    for other in set(orig) - {qid}:
        assert new[other]["final_prompt"] == orig[other]["final_prompt"]
        assert LINE not in new[other]["final_prompt"]
    meta = json.loads((tmp_path / "out" / out["cell_id"] / "cell.json").read_text())["reanswer"]["append_line"]
    assert meta["text"] == LINE and meta["ids"] == [qid] and len(meta["sha256"]) == 64


def test_a_prompt_that_differs_from_the_recorded_one_is_refused_before_it_is_sent(source, tmp_path, sent):
    p = sorted((source / "stages" / "answer").glob("*.json"))[0]
    rec = json.loads(p.read_text())
    ctx = rec["rendered_context"]
    rebuilt = rec["final_prompt"].replace(ctx, f"{ctx}\n\n{LINE}")
    rec["final_prompt"] = rec["final_prompt"] + " (edited)"
    p.write_text(json.dumps(rec))
    with pytest.raises(SystemExit, match="refusing before it is sent"):
        asyncio.run(reanswer(source, tmp_path / "out", 2, tag="oracle", append_line=LINE, line_ids={rec["query_id"]}))
    assert rebuilt not in sent
    assert not [s for s in sent if LINE in s]


def test_a_question_with_no_recorded_prompt_is_refused(source, tmp_path, sent):
    for p in (source / "stages" / "answer").glob("*.json"):
        rec = json.loads(p.read_text())
        rec["final_prompt"] = ""
        p.write_text(json.dumps(rec))
    with pytest.raises(SystemExit, match="recorded no answer prompt"):
        asyncio.run(reanswer(source, tmp_path / "out", 2, tag="oracle"))
    assert sent == []


@pytest.mark.parametrize("kwargs, match", [
    ({"append_line": LINE}, "go together"),
    ({"line_ids": {"q"}}, "go together"),
    ({"append_line": "  ", "line_ids": {"q"}}, "non-empty line"),
    ({"append_line": LINE, "line_ids": {"not-scheduled"}}, "outside the cell's schedule"),
])
def test_bad_line_options_are_refused_before_anything_runs(source, tmp_path, sent, kwargs, match):
    with pytest.raises(SystemExit, match=match):
        asyncio.run(reanswer(source, tmp_path / "out", 2, tag="oracle", **kwargs))
    assert sent == []


def test_line_ids_outside_questions_are_refused(source, tmp_path, sent):
    first, second = json.loads((source / "cell.json").read_text())["resolved"]["schedule"][:2]
    with pytest.raises(SystemExit, match="outside --questions"):
        asyncio.run(reanswer(source, tmp_path / "out", 2, only={first}, tag="oracle", append_line=LINE, line_ids={first, second}))
    assert sent == []


def test_a_reader_refusal_keeps_the_prompt_it_was_sent(tmp_path, stub_models, shim_scorer, monkeypatch):  # noqa: F811
    class ModelRefusal(RuntimeError):
        pass

    real = StubLLM.generate

    def refusing(self, prompt, schema):
        if "correct" in set(schema.properties):
            return real(self, prompt, schema)
        raise ModelRefusal("stop_reason=refusal")

    monkeypatch.setattr(StubLLM, "generate", refusing)
    d = make_cell(tmp_path, SPEC)
    asyncio.run(cellmod.CellRun(d).run())
    rows = _answers(d).values()
    assert rows and all(r["error"].startswith("reader refusal") for r in rows)
    assert all(r["final_prompt"] for r in rows)


def _fail_rows(source, keep_prompt=False):
    for p in (source / "stages" / "answer").glob("*.json"):
        rec = json.loads(p.read_text())
        rec.update(ok=False, outcome="answer_failure", answer="", error="RuntimeError: no structured response")
        if not keep_prompt:
            rec["final_prompt"] = ""
        p.write_text(json.dumps(rec))


def test_a_failed_row_with_no_recorded_prompt_is_asked_again_without_a_line(source, tmp_path, sent):
    _fail_rows(source)
    res = asyncio.run(reanswer(source, tmp_path / "out", 2, tag="repair"))
    assert res["answered"] == len(sent) > 0
    assert all(r["final_prompt"] for r in _answers(tmp_path / "out" / f"{source.name}-repair").values())


def test_a_failed_row_with_no_recorded_prompt_never_gets_the_line(source, tmp_path, sent):
    _fail_rows(source)
    ids = set(json.loads((source / "cell.json").read_text())["resolved"]["schedule"][:1])
    with pytest.raises(SystemExit, match="recorded no answer prompt"):
        asyncio.run(reanswer(source, tmp_path / "out", 2, tag="oracle", append_line=LINE, line_ids=ids))
    assert sent == []


def test_an_answer_failure_keeps_the_prompt_it_was_sent(tmp_path, stub_models, shim_scorer, monkeypatch):  # noqa: F811
    real = StubLLM.generate

    def broken(self, prompt, schema):
        if "correct" in set(schema.properties):
            return real(self, prompt, schema)
        raise RuntimeError("no structured response")

    monkeypatch.setattr(StubLLM, "generate", broken)
    d = make_cell(tmp_path, SPEC)
    asyncio.run(cellmod.CellRun(d).run())
    rows = _answers(d).values()
    assert rows and all(r["outcome"] == "answer_failure" and r["final_prompt"] for r in rows)
