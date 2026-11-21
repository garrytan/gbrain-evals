# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/memory/base.py (Apache-2.0). Changes: none.
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from typing import Any, Protocol


class MessageLike(Protocol):
    speaker: str
    text: str


class SessionLike(Protocol):
    label: str
    date: Any
    messages: list[MessageLike]


@dataclass
class TokenUsage:
    ingest_llm_prompt_tokens: int = 0
    ingest_llm_completion_tokens: int = 0
    ingest_embed_tokens: int = 0
    query_llm_prompt_tokens: int = 0
    query_llm_completion_tokens: int = 0
    query_embed_tokens: int = 0

    @property
    def ingest_llm_total(self) -> int:
        return self.ingest_llm_prompt_tokens + self.ingest_llm_completion_tokens

    @property
    def ingest_total(self) -> int:
        return self.ingest_llm_total + self.ingest_embed_tokens

    @property
    def query_llm_total(self) -> int:
        return self.query_llm_prompt_tokens + self.query_llm_completion_tokens

    @property
    def query_total(self) -> int:
        return self.query_llm_total + self.query_embed_tokens

    @property
    def total_llm_tokens(self) -> int:
        return self.ingest_llm_total + self.query_llm_total

    @property
    def total_embed_tokens(self) -> int:
        return self.ingest_embed_tokens + self.query_embed_tokens

    @property
    def total(self) -> int:
        return self.ingest_total + self.query_total

    def to_dict(self) -> dict[str, int]:
        result = asdict(self)
        result.update(
            ingest_llm_total_tokens=self.ingest_llm_total,
            ingest_total_tokens=self.ingest_total,
            query_llm_total_tokens=self.query_llm_total,
            query_total_tokens=self.query_total,
            total_llm_tokens=self.total_llm_tokens,
            total_embed_tokens=self.total_embed_tokens,
            total_tokens=self.total,
        )
        return result


@dataclass
class QueryResult:
    answer: str
    prompt: list[dict[str, str]]
    retrieval_latency_ms: float | None = None
    llm_prompt_tokens: int | None = None
    llm_completion_tokens: int | None = None


def normalize_role(speaker: str) -> str:
    return (
        "user"
        if speaker.lower().strip() in {"user", "human", "environment", "tool"}
        else "assistant"
    )


class MemoryStore(ABC):
    async def __aenter__(self) -> MemoryStore:
        return self

    async def __aexit__(self, *_args: object) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    @abstractmethod
    async def ingest(self, sessions: list[SessionLike]) -> None:
        pass

    @abstractmethod
    async def query(
        self, question: str, *, question_date: str | None = None
    ) -> QueryResult:
        pass

    @abstractmethod
    async def list_memories(self) -> list[str]:
        pass

    async def wait_for_extraction(self, **_kwargs: Any) -> list[str]:
        return await self.list_memories()

    async def _wait_until_stable(
        self,
        *,
        timeout: float = 1800,
        poll_interval: float = 15,
        stable_seconds: float = 30,
    ) -> list[str]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        last_count: int | None = None
        last_change = loop.time()
        latest: list[str] = []
        while loop.time() < deadline:
            latest = await self.list_memories()
            count = len(latest)
            now = loop.time()
            if count != last_count:
                last_count = count
                last_change = now
            elif count and now - last_change >= stable_seconds:
                return latest
            await asyncio.sleep(poll_interval)
        raise TimeoutError(
            f"Memory extraction did not stabilize within {timeout} seconds"
        )

    @abstractmethod
    async def reset(self) -> None:
        pass

    def get_token_usage(self) -> TokenUsage:
        return TokenUsage()

    def get_store_metadata(self) -> dict[str, Any]:
        return {}
