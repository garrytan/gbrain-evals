"""ParticleLLM: the request it sends, what it parses, and that it never sends a request twice unless it never left."""
from __future__ import annotations

import httpx
import openai
import pytest
from memory_bench.llm.base import Schema

from mpw import particle_llm
from mpw.particle_llm import ParticleLLM

SCHEMA = Schema(properties={"reasoning": {"type": "string"}, "answer": {"type": "string"}}, required=["reasoning", "answer"])


class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content, finish="stop"):
        self.message = _Msg(content)
        self.finish_reason = finish


class _Resp:
    def __init__(self, content, finish="stop"):
        self.choices = [_Choice(content, finish)]


def _error(status: int, body: dict) -> openai.APIStatusError:
    request = httpx.Request("POST", "http://proxy/particle/v1/chat/completions")
    return openai.APIStatusError("upstream", response=httpx.Response(status, request=request, json=body), body=body)


@pytest.fixture
def llm(monkeypatch):
    monkeypatch.setenv("PARTICLE_API_KEY", "stub-key")
    monkeypatch.setenv("PARTICLE_BASE_URL", "http://127.0.0.1:9/particle/v1")
    monkeypatch.setattr(particle_llm.time, "sleep", lambda s: None)
    return ParticleLLM()


def _replies(monkeypatch, llm, *outcomes):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        out = outcomes[len(calls) - 1]
        if isinstance(out, Exception):
            raise out
        return out

    monkeypatch.setattr(llm._client.chat.completions, "create", create)
    return calls


def test_sends_particle_1_at_high_effort_with_16k_output_and_no_sampling_controls(monkeypatch, llm):
    calls = _replies(monkeypatch, llm, _Resp('{"reasoning": "r", "answer": "Tom"}'))
    assert llm.generate("Question: cat?", SCHEMA) == {"reasoning": "r", "answer": "Tom"}
    (sent,) = calls
    assert sent["model"] == "particle-1" and sent["reasoning_effort"] == "high" and sent["max_completion_tokens"] == 16_000
    assert "temperature" not in sent and "seed" not in sent and "response_format" not in sent
    assert sent["messages"][0]["content"].startswith("Question: cat?")
    assert llm.model_id == "particle:particle-1"
    assert str(llm._client.base_url).startswith("http://127.0.0.1:9/particle/v1") and llm._client.max_retries == 0


def test_a_reply_without_the_json_object_is_an_error(monkeypatch, llm):
    _replies(monkeypatch, llm, _Resp("", finish="length"))
    with pytest.raises(RuntimeError, match="finish_reason=length"):
        llm.generate("q", SCHEMA)


def test_a_list_of_strings_in_a_string_field_is_read_as_its_lines(monkeypatch, llm):
    _replies(monkeypatch, llm, _Resp('{"reasoning": "r", "answer": ["2024-05-02 first", "2024-07-07 second"]}'))
    assert llm.generate("q", SCHEMA) == {"reasoning": "r", "answer": "2024-05-02 first\n2024-07-07 second"}


def test_any_other_non_string_answer_is_an_error(monkeypatch, llm):
    _replies(monkeypatch, llm, _Resp('{"reasoning": "r", "answer": {"first": "x"}}'), _Resp('{"reasoning": "r", "answer": ["x", 2]}'))
    for _ in range(2):
        with pytest.raises(RuntimeError, match="no structured response"):
            llm.generate("q", SCHEMA)


def test_a_request_that_may_have_reached_particle_is_never_sent_again(monkeypatch, llm):
    for error in (_error(504, {"error": {"code": "mpw_proxy_upstream_lost"}}), _error(429, {"error": "rate"}), _error(500, {"error": "x"})):
        calls = _replies(monkeypatch, llm, error, _Resp('{"reasoning": "", "answer": "a"}'))
        with pytest.raises(openai.APIStatusError):
            llm.generate("q", SCHEMA)
        assert len(calls) == 1


def test_only_a_request_that_never_left_is_sent_again(monkeypatch, llm):
    calls = _replies(monkeypatch, llm, _error(502, {"error": {"code": "mpw_proxy_upstream_unreachable"}}), _Resp('{"reasoning": "", "answer": "a"}'))
    assert llm.generate("q", SCHEMA)["answer"] == "a"
    assert len(calls) == 2


def test_only_particle_1_is_wired_and_it_is_registered():
    with pytest.raises(ValueError):
        ParticleLLM("particle-2")
    import memory_bench.llm as llm_pkg

    from mpw import register

    register.install()
    assert llm_pkg.REGISTRY["particle"] is ParticleLLM


@pytest.mark.parametrize("base_url", [None, "https://api.particle.ai/v1", "http://example.com/particle/v1"])
def test_it_never_calls_particle_directly(monkeypatch, base_url):
    monkeypatch.setenv("PARTICLE_API_KEY", "stub-key")
    if base_url is None:
        monkeypatch.delenv("PARTICLE_BASE_URL", raising=False)
    else:
        monkeypatch.setenv("PARTICLE_BASE_URL", base_url)
    with pytest.raises(RuntimeError, match="metering proxy"):
        ParticleLLM()
