"""Graphiti shim, SHIM_CONFIG=entity-h2h: the pinned graphiti-core 0.30.2 adapter with gpt-6.2-sol and an entity readout.

The adapter is the pinned bundle's shim.py, unchanged (copied into the image as graphiti_shim.py); it builds its clients
from this directory's capability.json, whose only configuration sets both LLM roles to gpt-6.2-sol and keeps the pinned
recipe's embedder and cross-encoder. This file adds GET /entities (eval/systems/PROTOCOL.md, "Entity readout"), read
through graphiti-core's public node and edge APIs:

- entities: every EntityNode in the namespace's group. Graphiti merges a mention into an existing node during
  add_episode (exact name, then MinHash, then its LLM dedupe prompt), so two sources that resolved to one person share
  one node.
- source_ids: for every episode in the group, the nodes it MENTIONS (search_utils.get_mentioned_nodes); the episode
  name is the source id, as the pinned shim names it.
- links: IS_DUPLICATE_OF facts between two surviving nodes, which Graphiti records when its dedupe prompt names an
  existing node as a duplicate without reusing it; tier "proposed", since both nodes stay separate.
"""
from __future__ import annotations

from typing import Any

import graphiti_shim as base
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode, EpisodicNode
from graphiti_core.search.search_utils import get_mentioned_nodes


class EntityReadoutAdapter(base.GraphitiAdapter):
    async def _entities(self, ns: str) -> dict[str, Any]:
        driver = self.graphiti.driver
        nodes = await EntityNode.get_by_group_ids(driver, [ns])
        mentions: dict[str, list[str]] = {n.uuid: [] for n in nodes}
        for ep in await EpisodicNode.get_by_group_ids(driver, [ns]):
            source = ep.name.split("#")[0]
            for n in await get_mentioned_nodes(driver, [ep]):
                if source not in mentions.setdefault(n.uuid, []):
                    mentions[n.uuid].append(source)
        edges = await EntityEdge.get_by_group_ids(driver, [ns])
        return {
            "entities": [{"id": n.uuid, "name": n.name, "type": next((l for l in n.labels if l != "Entity"), None),
                          "source_ids": mentions.get(n.uuid, []), "provenance_status": "exact"} for n in nodes],
            "links": [{"a": e.source_node_uuid, "b": e.target_node_uuid, "kind": "IS_DUPLICATE_OF", "tier": "proposed", "score": None}
                      for e in edges if e.name == "IS_DUPLICATE_OF"],
            "notes": "EntityNode.get_by_group_ids; MENTIONS per episode through search_utils.get_mentioned_nodes; "
                     "IS_DUPLICATE_OF from EntityEdge.get_by_group_ids",
        }

    def entities(self, ns: str) -> dict[str, Any]:
        with self._lock(ns):
            return self._run(self._entities(ns))


if __name__ == "__main__":
    base.serve(EntityReadoutAdapter())
