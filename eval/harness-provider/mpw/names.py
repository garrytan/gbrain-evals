"""Resolve the comparator's harness identifiers without writing its name.

The harness registers the comparator's providers under a key whose sha256 is
recorded in harness.lock.json. Everything that needs the real name (its
provider classes, package names, environment variable prefixes) derives it
here at runtime from the installed harness registry.
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

LOCK_PATH = Path(__file__).resolve().parents[1] / "harness.lock.json"


def lock() -> dict:
    return json.loads(LOCK_PATH.read_text())


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@lru_cache(maxsize=1)
def comparator_key() -> str:
    """The comparator's base registry key in the installed harness."""
    from memory_bench.memory import REGISTRY

    want = lock()["comparator"]["registry_key_sha256"]
    matches = [k for k in REGISTRY if _sha(k) == want]
    if len(matches) != 1:
        raise RuntimeError(
            f"expected exactly one harness provider key with sha256 {want[:12]}, found {len(matches)}. "
            "The pinned harness changed its registry; update harness.lock.json after checking the provider."
        )
    return matches[0]


def comparator_variant(suffix: str) -> str:
    """Registry key for a comparator variant, e.g. comparator_variant('http')."""
    return f"{comparator_key()}-{suffix}"


def comparator_env(name: str) -> str:
    """The comparator's environment variable `<KEY>_<name>` (e.g. HTTP_URL)."""
    return f"{comparator_key().upper()}_{name}"
