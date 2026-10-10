"""Full-context baseline: the answer model reads the whole history, no memory system.

Ingest keeps each unit's documents; retrieve returns all of them in session
order (dataset timestamp, then ingest order), each with the same one-line
date header the gbrain provider uses, so the reader gets everything a memory
system could have retrieved. It answers "how well does the reader do with no
retrieval at all" where the history fits the reader's context window.
"""
from __future__ import annotations

import json
from pathlib import Path

from memory_bench.memory.base import MemoryProvider
from memory_bench.models import Document

from .gbrain_provider import date_header, render_body


class FullContextProvider(MemoryProvider):
    name = "full-context"
    description = "No memory system: every document of the unit, in session order, goes to the answer model."
    kind = "local"
    concurrency = 4

    def __init__(self, config: dict | None = None):
        self.config = dict(config or {})
        self.root: Path | None = None
        self.units: dict[str, list[Document]] = {}

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        self.root = Path(store_dir) / "full-context"
        self.root.mkdir(parents=True, exist_ok=True)
        for f in self.root.glob("*.json"):
            if reset:
                f.unlink()
            else:
                rows = json.loads(f.read_text())
                self.units[f.stem] = [Document(**r) for r in rows]

    def ingest(self, documents: list[Document]) -> None:
        by_unit: dict[str, list[Document]] = {}
        for d in documents:
            by_unit.setdefault(d.user_id or "_all", []).append(d)
        for unit, docs in by_unit.items():
            self.units[unit] = self.units.get(unit, []) + docs
            if self.root is not None:
                (self.root / f"{unit}.json").write_text(json.dumps([d.__dict__ for d in self.units[unit]], ensure_ascii=False))

    def retrieve(self, query: str, k: int = 10, user_id: str | None = None, query_timestamp: str | None = None):
        if (user_id or "_all") not in self.units:
            raise RuntimeError(f"full-context: no documents for user {user_id!r}")
        docs = self.units[user_id or "_all"]
        ordered = sorted(enumerate(docs), key=lambda p: (p[1].timestamp or "", p[0]))
        return [Document(id=d.id, content=f"{date_header(d.timestamp)}\n{render_body(d)}", user_id=user_id) for _, d in ordered], None
