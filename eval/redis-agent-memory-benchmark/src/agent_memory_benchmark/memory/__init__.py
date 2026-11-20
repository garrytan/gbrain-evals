# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/memory/__init__.py (Apache-2.0). Changes: removed the nine third-party provider adapters from the imports, STORES and __all__, so STORES starts empty.
"""Provider-neutral memory adapters.

Third-party SDKs are imported only when their adapter is instantiated, so
importing this package never requires provider extras or credentials.
"""

from agent_memory_benchmark.memory.base import (
    MemoryStore,
    QueryResult,
    TokenUsage,
    normalize_role,
)

STORES: dict[str, type[MemoryStore]] = {}


def get_store_class(name: str) -> type[MemoryStore]:
    """Resolve an adapter by public registry name."""
    try:
        return STORES[name]
    except KeyError as exc:
        available = ", ".join(sorted(STORES))
        raise KeyError(
            f"Unknown memory store {name!r}. Available: {available}"
        ) from exc


__all__ = [
    "MemoryStore",
    "QueryResult",
    "STORES",
    "TokenUsage",
    "get_store_class",
    "normalize_role",
]
