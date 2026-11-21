# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/memory/common.py (Apache-2.0). Changes: none.
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from agent_memory_benchmark.memory.base import (
    MemoryStore,
    QueryResult,
    SessionLike,
    TokenUsage,
    normalize_role,
)
from agent_memory_benchmark.memory.llm import generate_answer


def missing_dependency(
    distribution: str, extra: str, provider: str, exc: Exception
) -> ImportError:
    return ImportError(
        f"{provider} requires the optional '{distribution}' dependency. "
        f"Install it with: pip install 'agent-memory-benchmark[{extra}]'"
    ).with_traceback(exc.__traceback__)


def session_created_at(session: SessionLike) -> datetime:
    created = getattr(session, "date", None) or datetime.now(timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created


def session_text(session: SessionLike) -> str:
    lines = [f"Conversation date: {session.label}"] if session.label else []
    lines.extend(
        f"{normalize_role(message.speaker)}: {message.text}"
        for message in session.messages
        if message.text.strip()
    )
    return "\n".join(lines)


class AnsweringStore(MemoryStore):
    """Retrieve vendor memory, then generate the LongMemEval answer with one LLM."""

    def __init__(self, *, model: str = "gpt-4o") -> None:
        self._model = model
        self._token_usage = TokenUsage()

    async def _answer(
        self, context: str, question: str, question_date: str | None
    ) -> QueryResult:
        result, usage = await generate_answer(
            context, question, model=self._model, question_date=question_date
        )
        self._token_usage.query_llm_prompt_tokens += usage["prompt_tokens"]
        self._token_usage.query_llm_completion_tokens += usage["completion_tokens"]
        return result

    def get_token_usage(self) -> TokenUsage:
        return self._token_usage

    def get_store_metadata(self) -> dict[str, Any]:
        return {"answer_model": self._model}


class AsyncExtractionStore(AnsweringStore):
    """Poll list_memories until extraction has produced a stable count."""

    async def wait_for_extraction(
        self,
        *,
        timeout: float = 1800,
        poll_interval: float = 15,
        stable_seconds: float = 30,
    ) -> list[str]:
        return await self._wait_until_stable(
            timeout=timeout,
            poll_interval=poll_interval,
            stable_seconds=stable_seconds,
        )
