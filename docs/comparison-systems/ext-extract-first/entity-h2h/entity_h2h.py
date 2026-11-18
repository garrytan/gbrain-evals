"""Mem0 OSS shim, SHIM_CONFIG=entity-h2h: the pinned mem0ai 2.2.1 adapter with gpt-6.2-sol and an entity readout.

The adapter is the pinned bundle's shim.py, unchanged (copied into the image as mem0_shim.py). Only its config builder is
replaced: the recipe's Memory.from_config with the LLM set to gpt-6.2-sol (is_reasoning_model kept, as the recipe sets it,
so mem0 sends no temperature) and the embedder left at the SDK default. This file adds GET /entities
(eval/systems/PROTOCOL.md, "Entity readout"), read through mem0's public Memory API:

- entities: the entity store mem0 2.2.1 keeps beside its memories (Memory.entity_store, one row per entity text
  spaCy finds in a memory). mem0 links a new mention to an existing row on an exact normalised-text match or an
  embedding score of at least 0.95; otherwise it inserts a new row. There is no graph store in 2.2.1.
- source_ids: the source_id metadata of each memory in the row's linked_memory_ids (Memory.get_all).
- links: none; mem0 has no merge pointer or review band, it reuses the row.

GET /health reports the head-to-head setting the stack started in (ENTITY_H2H_SETTING) under entity_h2h, which the
runner checks against the cell. mem0 2.2.1 documents no knob for its entity linking (the 0.95 cut is a literal;
capability.json entity_h2h_tuning), so the settings are always empty and only "default" is a valid setting.
"""
from __future__ import annotations

import copy
import os
from typing import Any

import mem0_shim as base
from mem0.memory.main import _vector_store_list_rows

LIST_LIMIT = 100_000
_recipe = base.mem0_config


def entity_h2h_config() -> dict[str, Any]:
    if base.CONFIG != "entity-h2h":
        raise SystemExit(f"SHIM_CONFIG must be entity-h2h in this image, not {base.CONFIG!r}")
    base.CONFIG = "recipe"
    try:
        cfg = copy.deepcopy(_recipe())
    finally:
        base.CONFIG = "entity-h2h"
    cfg["vector_store"]["config"]["collection_name"] = "memories_entity_h2h"
    cfg["history_db_path"] = str(base.DATA / "history_entity_h2h.db")
    cfg["llm"]["config"]["model"] = "gpt-6.2-sol"
    return cfg


base.mem0_config = entity_h2h_config


class EntityReadoutAdapter(base.Mem0Adapter):
    def entities(self, ns: str) -> dict[str, Any]:
        _, done = self.drain(ns, 3600)
        if not done:
            raise base.ShimError("timeout", "ingest still running after an hour; entities not read", 504)
        scope = {"user_id": self.scope(ns)}
        memories = self.memory.get_all(filters=scope, top_k=LIST_LIMIT).get("results", [])
        source_of = {str(m["id"]): (m.get("metadata") or {}).get("source_id") or m.get("source_id") for m in memories}
        entities = []
        for row in _vector_store_list_rows(self.memory.entity_store.list(filters=scope, top_k=LIST_LIMIT)):
            p = row.payload or {}
            sources = list(dict.fromkeys(s for mid in p.get("linked_memory_ids", []) if (s := source_of.get(str(mid)))))
            entities.append({"id": str(row.id), "name": p.get("data"), "type": p.get("entity_type"),
                             "source_ids": sources, "provenance_status": "exact"})
        return {"entities": entities, "links": [],
                "notes": f"Memory.entity_store rows with linked_memory_ids; source_id metadata of {len(memories)} memories from Memory.get_all"}

    def health(self) -> dict[str, Any]:
        return {**super().health(), "entity_h2h": {"setting": os.environ.get("ENTITY_H2H_SETTING", "default"), "settings": {}}}


if __name__ == "__main__":
    base.serve(EntityReadoutAdapter())
