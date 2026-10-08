"""temporal-graph shim: graphiti-core 0.30.2 on Neo4j 5.26 (protocol v1, see eval/systems/PROTOCOL.md).

temporal-graph open source, not Zep Cloud. Starts from Zep's published LoCoMo harness
(getzep/zep-papers@4b7f26c, kg_architecture_agent_memory/locomo_eval/zep_locomo_ingestion.py and
zep_locomo_search.py), translated from the Zep Cloud client to the graphiti-core API it wraps. Deviations are
listed in capability.json and README.md.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

import openai

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient  # noqa: E402
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig  # noqa: E402
from graphiti_core.llm_client import LLMConfig, OpenAIClient  # noqa: E402
from graphiti_core.nodes import EpisodeType, EpisodicNode  # noqa: E402
from graphiti_core.search import search_config_recipes as recipes  # noqa: E402
from graphiti_core.utils.maintenance.graph_data_operations import clear_data  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
GRANULARITY = os.environ.get("SHIM_GRANULARITY", "session")
SOURCE_DESCRIPTION = "chat conversation"
SEARCH_KNOBS = {"recipe", "limit", "node_provenance"}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class GraphitiAdapter(Adapter):
    def __init__(self) -> None:
        with open(os.path.join(HERE, "capability.json")) as f:
            self.record = json.load(f)
        if CONFIG not in self.record["configs"]:
            raise SystemExit(f"SHIM_CONFIG must be one of {sorted(self.record['configs'])}, got {CONFIG!r}")
        if GRANULARITY not in ("session", "message"):
            raise SystemExit(f"SHIM_GRANULARITY must be session or message, got {GRANULARITY!r}")
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.graphiti: Graphiti = self._run(self._connect())
        self.episode_source: dict[str, tuple[str, str]] = {}
        self.ns_locks: dict[str, threading.Lock] = {}

    def _run(self, coro: Any) -> Any:
        """graphiti-core is async and its Neo4j driver is bound to one loop; every call goes through it.
        A 402 from the metering proxy (over the lease or an unpriced model) becomes the protocol's budget error."""
        try:
            return asyncio.run_coroutine_threadsafe(coro, self.loop).result()
        except Exception as e:
            cause: BaseException | None = e
            while cause is not None:
                if isinstance(cause, openai.APIStatusError) and cause.status_code == 402:
                    raise ShimError("budget", f"metering proxy refused a provider call: {cause.message}", 402) from e
                cause = cause.__cause__ or cause.__context__
            raise

    async def _connect(self) -> Graphiti:
        roles = self.record["configs"][CONFIG]["model_roles"]
        base_url, api_key = os.environ["OPENAI_BASE_URL"], os.environ["OPENAI_API_KEY"]
        llm = OpenAIClient(config=LLMConfig(api_key=api_key, base_url=base_url, model=roles["extraction"], small_model=roles["small"]))
        embedder = OpenAIEmbedder(config=OpenAIEmbedderConfig(api_key=api_key, base_url=base_url,
                                                              embedding_model=roles["embedder"], embedding_dim=roles["dims"]))
        reranker = OpenAIRerankerClient(config=LLMConfig(api_key=api_key, base_url=base_url, model=roles["reranker"]))
        graphiti = Graphiti(os.environ.get("NEO4J_URI", "bolt://neo4j:7687"), os.environ.get("NEO4J_USER", "neo4j"),
                            os.environ["NEO4J_PASSWORD"], llm_client=llm, embedder=embedder, cross_encoder=reranker)
        await graphiti.build_indices_and_constraints()
        return graphiti

    def _lock(self, ns: str) -> threading.Lock:
        return self.ns_locks.setdefault(ns, threading.Lock())

    def capabilities(self) -> dict[str, Any]:
        return self.record

    def health(self) -> dict[str, Any]:
        try:
            self._run(self.graphiti.driver.health_check())
        except Exception as e:
            raise ShimError("product_error", f"neo4j not ready: {e}", 503) from e
        return {"ok": True, "config": CONFIG, "granularity": GRANULARITY}

    def reset(self, ns: str) -> None:
        with self._lock(ns):
            self._run(clear_data(self.graphiti.driver, group_ids=[ns]))
            self.episode_source = {u: v for u, v in self.episode_source.items() if v[0] != ns}

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        """Zep's harness adds one `message` episode per turn, `speaker: text`, dated with the session time."""
        source_id, turns = session["source_id"], session["turns"]
        if not session["event_time"]:
            raise ShimError("invalid_request", "event_time is required; the shim never defaults to the wall clock", 400)
        try:
            event_time = datetime.fromisoformat(session["event_time"].replace("Z", "+00:00"))
        except ValueError as e:
            raise ShimError("invalid_request", f"not an ISO-8601 time: {session['event_time']!r}", 400) from e
        if event_time.tzinfo is None:
            event_time = event_time.replace(tzinfo=timezone.utc)
        lines = [f"{t['speaker']}: {t['content']}" for t in turns]
        episodes = [(source_id, "\n".join(lines), event_time)] if GRANULARITY == "session" else [
            (f"{source_id}#{i:04d}", line, event_time + timedelta(milliseconds=i)) for i, line in enumerate(lines)]
        nodes = edges = 0
        with self._lock(ns):
            for name, body, reference_time in episodes:
                result = self._run(self.graphiti.add_episode(name=name, episode_body=body, source_description=SOURCE_DESCRIPTION,
                                                             reference_time=reference_time, source=EpisodeType.message, group_id=ns))
                self.episode_source[result.episode.uuid] = (ns, source_id)
                nodes, edges = nodes + len(result.nodes), edges + len(result.edges)
        return {"items_created": len(episodes) + nodes + edges, "warnings": [], "errors": [], "completeness": "known",
                "receipt": {"episodes": len(episodes), "entity_nodes": nodes, "entity_edges": edges}}

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        return {"ready": True, "waited_ms": 0, "completeness": "known"}

    def _sources(self, ns: str, episode_uuids: list[str]) -> tuple[list[str], bool]:
        """Map episode uuids to this namespace's source ids through the public node API. Returns (sources, all_mapped)."""
        missing = [u for u in episode_uuids if u not in self.episode_source]
        if missing:
            for ep in self._run(EpisodicNode.get_by_uuids(self.graphiti.driver, missing)):
                self.episode_source[ep.uuid] = (ep.group_id, ep.name.split("#")[0])
        found = [self.episode_source[u][1] for u in episode_uuids if self.episode_source.get(u, ("", ""))[0] == ns]
        return list(dict.fromkeys(found)), len(found) == len(episode_uuids)

    def _item(self, ns: str, rank: int, uuid: str, type_: str, text: str, episode_uuids: list[str] | None,
              valid_from: str | None = None, valid_to: str | None = None, exact_if_complete: bool = True) -> Item:
        sources, complete = self._sources(ns, episode_uuids) if episode_uuids else ([], False)
        status = "unavailable" if not sources else ("exact" if complete and exact_if_complete else "partial")
        return Item(id=uuid, rank=rank, type=type_, text=text, source_ids=sources, valid_from=valid_from,
                    valid_to=valid_to, provenance_status=status)

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        settings = {**self.record["retrieval_policies"][mode]["settings"], **(policy.get("settings") or {})}
        unknown = set(settings) - SEARCH_KNOBS
        if unknown:
            raise ShimError("unsupported", f"temporal-graph search_ has no knob(s) {sorted(unknown)}; allowed {sorted(SEARCH_KNOBS)}", 400)
        recipe = getattr(recipes, settings["recipe"], None)
        if recipe is None or not settings["recipe"].isupper():
            raise ShimError("invalid_request", f"unknown search recipe {settings['recipe']!r}", 400)
        config = recipe.model_copy(deep=True)
        config.limit = int(settings["limit"])
        results = self._run(self.graphiti.search_(question, config=config, group_ids=[ns]))
        items: list[Item] = []
        for e in results.edges:
            items.append(self._item(ns, len(items) + 1, e.uuid, "fact", e.fact, e.episodes, _iso(e.valid_at), _iso(e.invalid_at)))
        for n in results.nodes:
            mentions = [ep.uuid for ep in self._run(EpisodicNode.get_by_entity_node_uuid(self.graphiti.driver, n.uuid))] \
                if settings["node_provenance"] == "mentions" else None
            items.append(self._item(ns, len(items) + 1, n.uuid, "entity", f"{n.name}: {n.summary}", mentions, exact_if_complete=False))
        for ep in results.episodes:
            items.append(self._item(ns, len(items) + 1, ep.uuid, "episode", ep.content, [ep.uuid], _iso(ep.valid_at)))
        for c in results.communities:
            items.append(self._item(ns, len(items) + 1, c.uuid, "observation", f"{c.name}: {c.summary}", None))
        applied = {**settings, "query_time": "not supported by search_; ignored", "group_ids": [ns],
                   "class_order": ["edges", "nodes", "episodes", "communities"]}
        raw = {"edges": [e.uuid for e in results.edges], "edge_reranker_scores": results.edge_reranker_scores,
               "nodes": [n.uuid for n in results.nodes], "node_reranker_scores": results.node_reranker_scores,
               "episodes": [ep.uuid for ep in results.episodes], "communities": [c.uuid for c in results.communities]}
        return {"items": items, "applied_settings": applied, "truncated": False, "raw": raw}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        with self._lock(ns):
            episodes = [ep for ep in self._run(EpisodicNode.get_by_group_ids(self.graphiti.driver, [ns]))
                        if ep.name.split("#")[0] == source_id]
            for ep in episodes:
                self._run(self.graphiti.remove_episode(ep.uuid))
                self.episode_source.pop(ep.uuid, None)
        return {"status": "deleted" if episodes else "partial",
                "receipt": {"episodes_removed": [ep.uuid for ep in episodes], "method": "Graphiti.remove_episode per episode"}}


if __name__ == "__main__":
    serve(GraphitiAdapter())
