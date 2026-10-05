"""Shared fakes for the scorer tests. No network: every judge is a local script."""
from __future__ import annotations

import json
import re

import pytest

from mpw import register

register.install()

from memory_bench.llm.base import LLM  # noqa: E402

BEAM_JUDGE = "gemini:gemini-3.5-flash"

BEAM_FIXTURE = [
    {
        "conversation_id": "c1",
        "chat": [[
            {"role": "user", "content": "I adopted a dog and named him Rex.", "time_anchor": "March-15-2024", "id": 0},
            {"role": "assistant", "content": "Rex is a great name.", "id": 1},
        ]],
        "probing_questions": {
            "information_extraction": [
                {"question": "What is the name of my dog?", "answer": "Rex",
                 "rubric": ["LLM response should state: Rex"]},
                {"question": "Which city did I move to?", "answer": "Lisbon",
                 "rubric": ["LLM response should state: Lisbon"]},
            ],
            "abstention": [
                {"question": "What is the name of my cat?",
                 "answer": "Based on the provided chat, there is no information related to a cat.",
                 "rubric": ["LLM response should state: there is no information related to a cat"],
                 "why_unanswerable": "No cat is mentioned."},
            ],
            "multi_session_reasoning": [
                {"question": "Which pet and which city did I mention?", "answer": "Rex and Lisbon",
                 "rubric": ["LLM response should state: Rex", "LLM response should state: Lisbon"]},
            ],
        },
    }
]

_RESPONSE = re.compile(r"LLM RESPONSE:\n(.*?)\n\nRUBRIC CRITERION:\n(.*?)\n\nSCORING GUIDELINES", re.DOTALL)


def rubric_judge(prompt: str, schema, call: int):
    """Score a BEAM rubric item 1.0 when the phrase after "should state:" appears in the response."""
    m = _RESPONSE.search(prompt)
    if not m:
        return {"correct": True, "reason": "not a rubric prompt"}
    response, criterion = m.group(1), m.group(2)
    key = criterion.split("should state:", 1)[-1].strip().rstrip(".").lower()
    return {"score": 1.0 if key in response.lower() else 0.0, "reason": f"looked for {key}"}


class ScriptedLLM(LLM):
    """A judge LLM whose responses come from `respond(prompt, schema, call_number)`."""

    def __init__(self, model_id: str, respond):
        self._id = model_id
        self.respond = respond
        self.prompts: list[str] = []

    @property
    def model_id(self) -> str:
        return self._id

    def generate(self, prompt, schema):
        self.prompts.append(prompt)
        out = self.respond(prompt, schema, len(self.prompts))
        if isinstance(out, Exception):
            raise out
        return out


@pytest.fixture
def beam(tmp_path, monkeypatch):
    from memory_bench.dataset.beam import BEAMDataset

    path = tmp_path / "beam.json"
    path.write_text(json.dumps(BEAM_FIXTURE))
    monkeypatch.setenv("BEAM_DATA_PATH", str(path))
    return BEAMDataset()


@pytest.fixture
def beam_queries(beam):
    return {q.id: q for q in beam.load_queries("100k")}


@pytest.fixture
def fake_gemini(monkeypatch):
    """Replace the harness Gemini client class so BEAM's in-code judge builds a scripted LLM.

    Returns a dict whose "respond" entry scripts every instance; instances are
    collected under "instances".
    """
    import memory_bench.llm as llm_pkg
    import memory_bench.llm.gemini as gemini_mod

    state = {"respond": rubric_judge, "instances": []}

    class FakeGeminiLLM(ScriptedLLM):
        def __init__(self, model: str = "gemini-2.5-flash-lite"):
            super().__init__(f"gemini:{model}", lambda p, s, n: state["respond"](p, s, n))
            state["instances"].append(self)

    monkeypatch.setattr(gemini_mod, "GeminiLLM", FakeGeminiLLM)
    monkeypatch.setitem(llm_pkg.REGISTRY, "gemini", FakeGeminiLLM)
    return state


def answer_record(cell_id: str, query_id: str, answer: str, *, context: str = "x", outcome: str = "answered",
                  ok: bool = True, error: str | None = None) -> dict:
    from dataclasses import asdict

    from mpw.records import AnswerRecord

    return asdict(AnswerRecord(cell_id=cell_id, query_id=query_id, ok=ok, outcome=outcome, answer=answer,
                               rendered_context=context, inserted_context=context, error=error))
