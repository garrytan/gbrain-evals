# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/tests/test_memory_base.py (Apache-2.0). Changes: removed test_async_adapters_poll_until_extraction_is_stable, which imports three of the removed provider adapters.
from __future__ import annotations

import inspect
from typing import Any

import pytest

import agent_memory_benchmark.memory.common as common
from agent_memory_benchmark.memory import (
    MemoryStore,
    QueryResult,
    TokenUsage,
    normalize_role,
)
from agent_memory_benchmark.memory.common import AnsweringStore, AsyncExtractionStore
from agent_memory_benchmark.memory.llm import build_prompt


class NeutralAnswerStore(AnsweringStore):
    async def ingest(self, sessions: list[Any]) -> None:
        return None

    async def query(
        self, question: str, *, question_date: str | None = None
    ) -> QueryResult:
        return await self._answer("shared context", question, question_date)

    async def list_memories(self) -> list[str]:
        return []

    async def reset(self) -> None:
        self._token_usage = TokenUsage()


def test_token_usage_totals_and_serialization() -> None:
    usage = TokenUsage(
        ingest_llm_prompt_tokens=2,
        ingest_llm_completion_tokens=3,
        ingest_embed_tokens=5,
        query_llm_prompt_tokens=7,
        query_llm_completion_tokens=11,
        query_embed_tokens=13,
    )

    assert usage.ingest_llm_total == 5
    assert usage.ingest_total == 10
    assert usage.query_llm_total == 18
    assert usage.query_total == 31
    assert usage.total_llm_tokens == 23
    assert usage.total_embed_tokens == 18
    assert usage.total == 41
    assert usage.to_dict()["total_tokens"] == 41


def test_shared_prompt_is_provider_neutral_and_handles_empty_context() -> None:
    prompt = build_prompt("", "Where is it?", question_date="2026-08-26")

    assert [message["role"] for message in prompt] == ["system", "user"]
    assert "Memories:" in prompt[0]["content"]
    assert "Current date/time: 2026-08-26" in prompt[0]["content"]
    assert "personal assistant" in prompt[0]["content"]
    assert prompt[1]["content"] == "Where is it?"


@pytest.mark.asyncio
async def test_answering_store_uses_shared_generation_and_accumulates_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, str, str | None]] = []

    async def fake_generate(
        context: str,
        question: str,
        *,
        model: str,
        question_date: str | None,
    ) -> tuple[QueryResult, dict[str, int]]:
        calls.append((context, question, model, question_date))
        return (
            QueryResult(
                answer="answer", prompt=[{"role": "user", "content": question}]
            ),
            {"prompt_tokens": 4, "completion_tokens": 2},
        )

    monkeypatch.setattr(common, "generate_answer", fake_generate)
    store = NeutralAnswerStore(model="neutral-model")

    await store.query("first", question_date="today")
    await store.query("second")

    assert calls == [
        ("shared context", "first", "neutral-model", "today"),
        ("shared context", "second", "neutral-model", None),
    ]
    assert store.get_token_usage().query_llm_prompt_tokens == 8
    assert store.get_token_usage().query_llm_completion_tokens == 4
    assert store.get_token_usage().query_total == 12


@pytest.mark.parametrize(
    ("speaker", "role"),
    [
        (" user ", "user"),
        ("HUMAN", "user"),
        ("environment", "user"),
        ("tool", "user"),
        ("assistant", "assistant"),
    ],
)
def test_role_normalization(speaker: str, role: str) -> None:
    assert normalize_role(speaker) == role


@pytest.mark.asyncio
async def test_wait_for_extraction_waits_until_count_is_stable() -> None:
    class GrowingStore(AsyncExtractionStore, NeutralAnswerStore):
        def __init__(self) -> None:
            super().__init__(model="neutral-model")
            self.calls = 0

        async def list_memories(self) -> list[str]:
            self.calls += 1
            if self.calls == 1:
                return []
            if self.calls < 4:
                return ["first"]
            return ["first", "second"]

    store = GrowingStore()
    memories = await store.wait_for_extraction(
        timeout=2, poll_interval=0.01, stable_seconds=0.05
    )
    assert memories == ["first", "second"]
    assert store.calls >= 4


def test_wait_for_extraction_defaults_cover_async_extraction() -> None:
    params = inspect.signature(AsyncExtractionStore.wait_for_extraction).parameters
    assert params["timeout"].default == 1800
    assert params["poll_interval"].default == 15
    assert params["stable_seconds"].default == 30


@pytest.mark.asyncio
async def test_wait_for_extraction_times_out_instead_of_scoring_empty() -> None:
    class EmptyStore(AsyncExtractionStore, NeutralAnswerStore):
        async def list_memories(self) -> list[str]:
            return []

    store = EmptyStore()
    with pytest.raises(TimeoutError, match="did not stabilize"):
        await store.wait_for_extraction(timeout=0.05, poll_interval=0.01)

