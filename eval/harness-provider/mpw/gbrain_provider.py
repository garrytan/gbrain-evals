"""gbrain memory provider for the harness (implementation in progress)."""
from memory_bench.memory.base import MemoryProvider


class GbrainMemoryProvider(MemoryProvider):
    name = "gbrain"
    description = "gbrain over stdio MCP, one hermetic brain per isolation unit"
    kind = "local"

    def ingest(self, documents):
        raise NotImplementedError

    def retrieve(self, query, k=10, user_id=None, query_timestamp=None):
        raise NotImplementedError
