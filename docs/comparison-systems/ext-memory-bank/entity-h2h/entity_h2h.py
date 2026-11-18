"""Hindsight shim, SHIM_CONFIG=entity-h2h: Hindsight 1.2.1 under the pinned adapter, with an entity readout.

The adapter is the pinned bundle's shim.py, unchanged (copied into the image as hindsight_shim.py); every client call it
makes keeps its signature and response fields in hindsight-client 1.2.1, which the image installs from this directory's
lock. The server's model comes from hindsight.entity-h2h.env (gpt-6.2-sol; embedder and reranker at the 1.2.1 server
defaults). This file adds GET /entities (eval/systems/PROTOCOL.md, "Entity readout"), read through the server's public
HTTP API with hindsight-client 1.2.1:

- entities: every entity the bank knows (GET .../entities, paged). Hindsight resolves each extracted mention to an
  existing entity or a new one during retain, so two sources it resolved to one person share one entity id.
- source_ids: the document ids of the bank's memory units linked to the entity (GET .../memories/list?entity_id=);
  the pinned shim retains each source as its own document, so the document id is the source id.
- links: none; the server keeps no merge pointer or review band in its public API.

GET /health reports the head-to-head setting the stack started in under entity_h2h, which the runner checks against the
cell: ENTITY_H2H_SETTING, and the server's entity merge floor, HINDSIGHT_API_ENTITY_MERGE_MIN_SIMILARITY (the knob in
capability.json entity_h2h_tuning). The floor is a server-wide environment variable in 1.2.1 that no API reads back, so
docker-compose.yml passes one value to both the server and this container (ENTITY_H2H_SERVER_ENTITY_MERGE_MIN_SIMILARITY),
and this reports the value the server was given.
"""
from __future__ import annotations

import os
from typing import Any

import hindsight_shim as base

PAGE = 500


class EntityReadoutAdapter(base.HindsightAdapter):
    async def _entities(self, ns: str) -> dict[str, Any]:
        rows = []
        while True:
            page = await self.client.entities.list_entities(bank_id=ns, limit=PAGE, offset=len(rows))
            rows.extend(page.items)
            if len(page.items) < PAGE:
                break
        entities = []
        for e in rows:
            sources: list[str] = []
            offset = 0
            while True:
                units = await self.client.memory.list_memories(bank_id=ns, entity_id=e.id, limit=PAGE, offset=offset)
                for u in units.items:
                    if u.document_id and u.document_id not in sources:
                        sources.append(u.document_id)
                offset += len(units.items)
                if len(units.items) < PAGE:
                    break
            entities.append({"id": e.id, "name": e.canonical_name, "type": (e.metadata or {}).get("type"),
                             "source_ids": sources, "provenance_status": "exact"})
        return {"entities": entities, "links": [],
                "notes": "entities.list_entities, then memory.list_memories(entity_id) document ids per entity"}

    def entities(self, ns: str) -> dict[str, Any]:
        return self._run(self._entities(ns))

    def health(self) -> dict[str, Any]:
        merge_min = os.environ.get("ENTITY_H2H_SERVER_ENTITY_MERGE_MIN_SIMILARITY")
        settings = {} if merge_min is None else {"HINDSIGHT_API_ENTITY_MERGE_MIN_SIMILARITY": float(merge_min)}
        return {**super().health(), "entity_h2h": {"setting": os.environ.get("ENTITY_H2H_SETTING", "default"), "settings": settings}}


if __name__ == "__main__":
    base.serve(EntityReadoutAdapter())
