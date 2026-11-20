# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/datasets/base.py (Apache-2.0). Changes: none.
"""Dataset adapter protocol."""

from __future__ import annotations

from abc import ABC, abstractmethod

from agent_memory_benchmark.datasets.models import DatasetExample


class DatasetAdapter(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable dataset name."""

    @abstractmethod
    def load(self) -> list[DatasetExample]:
        """Load typed benchmark examples."""
