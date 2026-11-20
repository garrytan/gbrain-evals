"""AnthropicLLM.generate: a refusal is a refusal even mid tool call, and a plain text reply is the answer."""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest
from memory_bench.llm.base import Schema

from mpw.anthropic_llm import AnthropicLLM, ModelRefusal

SCHEMA = Schema(properties={"reasoning": {"type": "string"}, "answer": {"type": "string"}}, required=["reasoning", "answer"])


def _reply(stop, *blocks):
    return NS(stop_reason=stop, content=list(blocks))


def tool(**inp):
    return NS(type="tool_use", name="respond", input=inp)


def text(t):
    return NS(type="text", text=t)


THINKING = NS(type="thinking", thinking="")


@pytest.fixture
def llm(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "stub-key")
    return AnthropicLLM("claude-opus-5-5")


def _with(monkeypatch, llm, reply):
    monkeypatch.setattr(llm, "_create", lambda **kw: reply)


def test_a_full_tool_call_is_the_answer(monkeypatch, llm):
    _with(monkeypatch, llm, _reply("tool_use", THINKING, tool(reasoning="r", answer="Tom")))
    assert llm.generate("q", SCHEMA) == {"reasoning": "r", "answer": "Tom"}


@pytest.mark.parametrize("blocks", [(THINKING, tool(reasoning="partial")), (THINKING,), (tool(reasoning="r", answer="a"),)])
def test_a_refusal_is_a_refusal_even_with_a_tool_call(monkeypatch, llm, blocks):
    _with(monkeypatch, llm, _reply("refusal", *blocks))
    with pytest.raises(ModelRefusal):
        llm.generate("q", SCHEMA)


def test_a_plain_text_reply_is_the_answer(monkeypatch, llm):
    _with(monkeypatch, llm, _reply("end_turn", THINKING, text("  Your quiz score was 19 out of 20.  ")))
    assert llm.generate("q", SCHEMA) == {"reasoning": "", "answer": "Your quiz score was 19 out of 20."}


def test_a_json_text_reply_still_parses(monkeypatch, llm):
    _with(monkeypatch, llm, _reply("end_turn", text('{"reasoning": "r", "answer": "a"}')))
    assert llm.generate("q", SCHEMA) == {"reasoning": "r", "answer": "a"}


@pytest.mark.parametrize("reply", [
    _reply("tool_use", tool(reasoning="r")),
    _reply("tool_use", text("Let me answer."), tool(reasoning="r")),
    _reply("max_tokens", text("The answer is")),
])
def test_a_cut_off_or_partial_reply_is_an_error(monkeypatch, llm, reply):
    _with(monkeypatch, llm, reply)
    with pytest.raises(RuntimeError, match="no structured response"):
        llm.generate("q", SCHEMA)


def test_text_is_not_taken_for_a_schema_without_an_answer_field(monkeypatch, llm):
    _with(monkeypatch, llm, _reply("end_turn", text("yes")))
    with pytest.raises(RuntimeError):
        llm.generate("q", Schema(properties={"correct": {"type": "boolean"}, "reason": {"type": "string"}}, required=["correct", "reason"]))
