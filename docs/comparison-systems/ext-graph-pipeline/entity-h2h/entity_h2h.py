"""Cognee shim, SHIM_CONFIG=entity-h2h: the pinned cognee 1.6.2 adapter with gpt-6.2-sol, entity consolidation and a readout.

The adapter is the pinned bundle's shim.py, unchanged (copied into the image as cognee_shim.py); it is imported under its
recipe configuration with LLM_MODEL set to openai/gpt-6.2-sol, so every LLM stage uses that model and the embedder stays
at the recipe default. Two additions:

- POST /finish runs cognee's entity-deduplication memify step once per namespace, as its guide describes
  (docs.cognee.ai/guides/memify-entity-deduplication): consolidate_entities_pipeline with its defaults (cosine 0.85 on
  entity-name embeddings, normalised-name match on, same EntityType only). It collapses each cluster into one canonical
  Entity node and re-points the duplicates' edges onto it.
- GET /entities (eval/systems/PROTOCOL.md, "Entity readout") reads the dataset's graph through
  get_formatted_graph_data, the function behind cognee's dataset graph API: Entity nodes, their EntityType (is_a), and
  the sources whose chunks contain them (DocumentChunk -contains-> Entity, DocumentChunk -is_part_of-> document, whose
  id is the data id the pinned shim assigns per source). A merge leaves no pointer, so links stay empty.
"""
from __future__ import annotations

import os
import time
from typing import Any

CONFIG = os.environ.get("SHIM_CONFIG", "entity-h2h")
if CONFIG != "entity-h2h":
    raise SystemExit(f"SHIM_CONFIG must be entity-h2h in this image, not {CONFIG!r}")
os.environ["LLM_MODEL"] = "openai/gpt-6.2-sol"
os.environ["SHIM_CONFIG"] = "recipe"
import cognee_shim as base  # noqa: E402

os.environ["SHIM_CONFIG"] = base.CONFIG = CONFIG

from cognee.memify_pipelines.consolidate_entities import consolidate_entities_pipeline  # noqa: E402
from cognee.modules.graph.methods.get_formatted_graph_data import get_formatted_graph_data  # noqa: E402
from cognee.modules.users.methods import get_default_user  # noqa: E402


class EntityReadoutAdapter(base.CogneeAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.consolidated: dict[str, dict[str, Any]] = {}

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        t0 = time.monotonic()
        if ns not in self.consolidated and self.run(self._dataset(ns)) is not None:
            result = self.run(consolidate_entities_pipeline(dataset=ns), timeout_s)
            self.consolidated[ns] = {"step": "consolidate_entities_pipeline", "defaults": True, "seconds": round(time.monotonic() - t0, 3),
                                     "result": str(result)[:2000]}
        return {"ready": True, "waited_ms": round((time.monotonic() - t0) * 1000), "completeness": "known",
                "consolidation": self.consolidated.get(ns)}

    async def _graph(self, ns: str) -> dict[str, Any] | None:
        dataset = await self._dataset(ns)
        if dataset is None:
            return None
        return await get_formatted_graph_data(dataset.id, await get_default_user())

    def entities(self, ns: str) -> dict[str, Any]:
        graph = self.run(self._graph(ns)) or {"nodes": [], "edges": []}
        sources = {**self.sources.get(ns, {}), **self.run(self._source_map(ns))}
        nodes = {n["id"]: n for n in graph["nodes"]}
        doc_of_chunk = {e["source"]: e["target"] for e in graph["edges"] if e["label"] == "is_part_of"}
        type_of: dict[str, str] = {}
        mentions: dict[str, list[str]] = {}
        for e in graph["edges"]:
            if e["label"] == "is_a" and nodes.get(e["target"], {}).get("type") == "EntityType":
                type_of[e["source"]] = nodes[e["target"]]["label"]
            if e["label"] == "contains" and nodes.get(e["target"], {}).get("type") == "Entity":
                source = sources.get(doc_of_chunk.get(e["source"], ""))
                if source and source not in mentions.setdefault(e["target"], []):
                    mentions[e["target"]].append(source)
        entities = [{"id": n["id"], "name": n["label"], "type": type_of.get(n["id"]), "source_ids": mentions.get(n["id"], []),
                     "provenance_status": "exact"} for n in graph["nodes"] if n["type"] == "Entity"]
        return {"entities": entities, "links": [],
                "notes": "get_formatted_graph_data; DocumentChunk -contains-> Entity and DocumentChunk -is_part_of-> document; "
                         f"consolidation: {self.consolidated.get(ns)}"}


if __name__ == "__main__":
    import json
    import signal
    import threading

    adapter = EntityReadoutAdapter()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=adapter.stop, daemon=True).start())
    print(json.dumps({"shim": "cognee", "config": CONFIG, "resolved": adapter.resolved_models(), "t": time.time()}), flush=True)
    base.serve(adapter)
