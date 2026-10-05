"""Comparator memory provider wrapper (implementation in progress)."""
from memory_bench.memory.base import MemoryProvider


class ComparatorMemoryProvider(MemoryProvider):
    name = "comparator"
    description = "the extract-first memory server, pinned current release, opaque ids"
    kind = "local"

    def ingest(self, documents):
        raise NotImplementedError

    def retrieve(self, query, k=10, user_id=None, query_timestamp=None):
        raise NotImplementedError
