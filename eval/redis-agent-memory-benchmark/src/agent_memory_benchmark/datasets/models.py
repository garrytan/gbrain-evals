# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/datasets/models.py (Apache-2.0). Changes: none.
"""Provider-neutral dataset records used by benchmark adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class ContextMessage:
    speaker: str
    text: str


@dataclass(slots=True)
class Session:
    label: str
    messages: list[ContextMessage]
    date: datetime | None = None


@dataclass(slots=True)
class QAPair:
    question: str
    answer: str
    question_id: str | None = None
    question_type: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class DatasetExample:
    sessions: list[Session]
    qa_pairs: list[QAPair]
    metadata: dict[str, Any] = field(default_factory=dict)
