"""Cognee shim, SHIM_CONFIG=entity-h2h: cognee 1.6.8 under the pinned adapter, with gpt-6.2-sol, entity consolidation and a readout.

The adapter is the pinned bundle's shim.py, unchanged (copied into the image as cognee_shim.py); it is imported under its
recipe configuration with LLM_MODEL set to openai/gpt-6.2-sol, so every LLM stage uses that model and the embedder stays
at the recipe default. The image installs cognee 1.6.8 from this directory's lock. The adapter was written for 1.6.2 and
imports payload, display_value and result_id from cognee.modules.retrieval.hybrid.results; cognee 1.6.5 moved those
three functions, unchanged, to cognee.modules.retrieval.utils.results (topoteretes/cognee#5534), so this file puts them
back under the old module name before importing the adapter. Nothing else in the adapter needed a change. Two additions:

- POST /finish runs cognee's entity-deduplication memify step once per namespace, as its guide describes
  (docs.cognee.ai/guides/memify-entity-deduplication): consolidate_entities_pipeline at the head-to-head setting the
  stack started in (ENTITY_H2H_SETTING: "default", cosine 0.85 on entity-name embeddings, or one setting of the tuning
  grid in capability.json entity_h2h_tuning), with its other parameters at their defaults (normalised-name match on,
  same EntityType only). It collapses each cluster into one canonical Entity node and re-points the duplicates' edges
  onto it. GET /health reports the setting and the parameters it passes under entity_h2h, which the runner checks
  against the cell.
- GET /entities (eval/systems/PROTOCOL.md, "Entity readout") reads the dataset's graph through
  get_formatted_graph_data, the function behind cognee's dataset graph API: Entity nodes, their EntityType (is_a), and
  the sources whose chunks contain them (DocumentChunk -contains-> Entity, DocumentChunk -is_part_of-> document, whose
  id is the data id the pinned shim assigns per source). A merge leaves no pointer, so links stay empty.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

CONFIG = os.environ.get("SHIM_CONFIG", "entity-h2h")
if CONFIG != "entity-h2h":
    raise SystemExit(f"SHIM_CONFIG must be entity-h2h in this image, not {CONFIG!r}")
_tuning = json.loads((Path(__file__).with_name("capability.json")).read_text())["entity_h2h_tuning"]
SETTING = os.environ.get("ENTITY_H2H_SETTING", "default")
if SETTING != "default" and SETTING not in _tuning["grid"]:
    raise SystemExit(f"ENTITY_H2H_SETTING {SETTING!r} is not default or a setting of capability.json entity_h2h_tuning")
SETTINGS: dict[str, Any] = _tuning["default"] if SETTING == "default" else _tuning["grid"][SETTING]["settings"]
os.environ["LLM_MODEL"] = "openai/gpt-6.2-sol"
os.environ["SHIM_CONFIG"] = "recipe"
import cognee.modules.retrieval.hybrid.results as hybrid_results  # noqa: E402
from cognee.modules.retrieval.utils import results as moved_results  # noqa: E402

for name in ("payload", "display_value", "result_id"):
    setattr(hybrid_results, name, getattr(moved_results, name))
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
            result = self.run(consolidate_entities_pipeline(dataset=ns, **SETTINGS), timeout_s)
            self.consolidated[ns] = {"step": "consolidate_entities_pipeline", "setting": SETTING, "settings": SETTINGS,
                                     "seconds": round(time.monotonic() - t0, 3), "result": str(result)[:2000]}
        return {"ready": True, "waited_ms": round((time.monotonic() - t0) * 1000), "completeness": "known",
                "consolidation": self.consolidated.get(ns)}

    async def _graph(self, ns: str) -> dict[str, Any] | None:
        dataset = await self._dataset(ns)
        if dataset is None:
            return None
        return await get_formatted_graph_data(dataset.id, await get_default_user())

    def health(self) -> dict[str, Any]:
        return {**super().health(), "entity_h2h": {"setting": SETTING, "settings": SETTINGS}}

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
