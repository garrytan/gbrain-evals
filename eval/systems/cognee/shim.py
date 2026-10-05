"""Protocol v1 shim for cognee 1.6.2 (see eval/systems/PROTOCOL.md and README.md in this directory).

Ingestion follows cognee's own BEAM ingestion (cognee/eval_framework/beam/local_ingest.py at v1.6.2): each session is
one JSON-list document, one turn pair per item, added and cognified one session at a time with `JsonListChunker`.
Retrieval follows cognee's reported BEAM configuration (`hybrid_completion`): `cognee.search` with
`query_type=HYBRID_COMPLETION`, `only_context=True` (no answer generation) and `verbose=True`, so the ranked chunks,
entities and facts that make up the context come back as separate objects.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
CONFIG_ENV = {
    "recipe": {},
    "common": {"LLM_MODEL": "openai/gpt-4.1-mini", "EMBEDDING_MODEL": "openai/text-embedding-3-large", "EMBEDDING_DIMENSIONS": "1536"},
}
if CONFIG not in CONFIG_ENV:
    raise SystemExit(f"SHIM_CONFIG must be recipe or common, got {CONFIG!r}")
os.environ.update(CONFIG_ENV[CONFIG])

import cognee  # noqa: E402
from cognee import SearchType  # noqa: E402
from cognee.modules.chunking.JsonListChunker import JsonListChunker  # noqa: E402
from cognee.modules.retrieval.hybrid.entities import format_entities  # noqa: E402
from cognee.modules.retrieval.hybrid.results import display_value, payload, result_id  # noqa: E402
from cognee.tasks.ingestion.data_item import DataItem  # noqa: E402

CAPABILITY = json.loads((Path(__file__).resolve().parent / "capability.json").read_text())
POLICIES = CAPABILITY["retrieval_policies"]
LANE_KEYS = ("chunks_top_k", "entities_top_k", "facts_top_k", "max_edges_per_entity")
ENTITY_HEADER = "## Relevant entities\n"
PROXY_REFUSAL = re.compile(r"\b402\b|['\"]kind['\"]\s*:\s*['\"]budget['\"]")


def render_session(session: dict[str, Any], session_number: int) -> list[str]:
    turns = session["turns"]
    items = []
    for i in range(0, len(turns), 2):
        header = f"Session: {session_number}\nTurn: {i // 2 + 1}\nTime anchor: {session['event_time'] or 'unknown'}"
        body = "\n\n".join(f"{t['speaker'] or t['role']}:\n{t['content']}" for t in turns[i:i + 2])
        items.append(f"{header}\n\n{body}")
    return items


class CogneeAdapter(Adapter):
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.lock = threading.Lock()
        self.sources: dict[str, dict[str, str]] = {}
        self.session_counts: dict[str, int] = {}
        from cognee.low_level import setup
        self.run(setup())

    def run(self, coro: Any, timeout: float | None = None) -> Any:
        with self.lock:
            try:
                return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)
            except ShimError:
                raise
            except Exception as e:
                if PROXY_REFUSAL.search(str(e)):
                    raise ShimError("budget", f"metering proxy refused a provider call: {type(e).__name__}: {e}", 402) from e
                raise

    def data_id(self, ns: str, source_id: str) -> UUID:
        return uuid5(NAMESPACE_URL, f"shootout:{ns}:{source_id}")

    def resolved_models(self) -> dict[str, Any]:
        from cognee.infrastructure.databases.vector.embeddings.config import get_embedding_config
        from cognee.infrastructure.llm.config import get_llm_config
        from cognee.modules.cognify.config import get_cognify_config
        llm, emb = get_llm_config(), get_embedding_config()
        return {"llm_model": llm.llm_model, "llm_endpoint": llm.llm_endpoint, "structured_output_framework": llm.structured_output_framework,
                "embedding_model": emb.embedding_model, "embedding_dimensions": emb.embedding_dimensions,
                "embedding_endpoint": emb.embedding_endpoint, "graph_extractor": get_cognify_config().graph_extractor}

    def capabilities(self) -> dict[str, Any]:
        return CAPABILITY

    def health(self) -> dict[str, Any]:
        return {"ok": True, "config": CONFIG, "resolved": self.resolved_models()}

    async def _dataset(self, ns: str) -> Any:
        return next((d for d in await cognee.datasets.list_datasets() if d.name == ns), None)

    async def _reset(self, ns: str) -> None:
        if await self._dataset(ns) is not None:
            await cognee.forget(dataset=ns)

    def reset(self, ns: str) -> None:
        self.run(self._reset(ns))
        self.sources.pop(ns, None)
        self.session_counts.pop(ns, None)

    async def _ingest(self, ns: str, source_id: str, items: list[str]) -> Any:
        data_id = self.data_id(ns, source_id)
        await cognee.add(DataItem(data=json.dumps(items, ensure_ascii=False), label=source_id, data_id=data_id), dataset_name=ns)
        return await cognee.cognify(datasets=[ns], chunker=JsonListChunker, extractor="llm")

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        if not session["event_time"]:
            raise ShimError("invalid_request", "event_time is required; cognee would otherwise date the session to ingest time", 400)
        number = self.session_counts.get(ns, 0) + 1
        items = render_session(session, number)
        if not items:
            return {"items_created": 0, "warnings": ["session has no turns"], "errors": [], "completeness": "known"}
        result = self.run(self._ingest(ns, session["source_id"], items))
        self.session_counts[ns] = number
        self.sources.setdefault(ns, {})[str(self.data_id(ns, session["source_id"]))] = session["source_id"]
        runs = list(result.values()) if isinstance(result, dict) else [result]
        statuses = [str(getattr(r, "status", "")) for r in runs]
        errors = [s for s in statuses if "error" in s.lower() or "fail" in s.lower()]
        return {"items_created": len(items), "warnings": [], "errors": errors,
                "completeness": "degraded" if errors else "known", "pipeline_status": statuses}

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        return {"ready": True, "waited_ms": 0, "completeness": "known"}

    async def _source_map(self, ns: str) -> dict[str, str]:
        dataset = await self._dataset(ns)
        if dataset is None:
            return {}
        return {str(row.id): row.label for row in await cognee.datasets.list_data(dataset.id) if row.label}

    async def _search(self, ns: str, question: str, settings: dict[str, Any]) -> Any:
        if await self._dataset(ns) is None:
            return None
        return await cognee.search(question, query_type=SearchType.HYBRID_COMPLETION, datasets=[ns], top_k=settings["top_k"],
                                   only_context=True, verbose=True,
                                   retriever_specific_config={k: settings[k] for k in LANE_KEYS if k in settings})

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        unknown = set(policy.get("settings", {})) - {"top_k", *LANE_KEYS}
        if unknown:
            raise ShimError("invalid_request", f"unknown settings for cognee: {sorted(unknown)}", 400)
        settings = {**POLICIES[mode]["settings"], **policy.get("settings", {})}
        applied = {"query_type": "HYBRID_COMPLETION", "only_context": True, "verbose": True, **settings,
                   "query_time": "not supported by cognee search; ignored"}
        results = self.run(self._search(ns, question, settings))
        if not results:
            return {"items": [], "applied_settings": applied}
        result = results[0]
        objects = result.get("objects_result")
        if not isinstance(objects, dict) or "chunks" not in objects:
            raise ShimError("product_error", "HYBRID_COMPLETION deferred to another retriever; the item shape is not hybrid")
        sources = self.sources.get(ns, {})
        items: list[Item] = []
        for chunk in objects.get("chunks", []):
            p = payload(chunk)
            data_id = display_value(p.get("document_id"))
            if data_id and data_id not in sources:
                sources.update(self.run(self._source_map(ns)))
                self.sources[ns] = sources
            source = sources.get(data_id or "")
            items.append(Item(id=result_id(chunk) or "", rank=len(items) + 1, type="chunk", text=display_value(p.get("text")) or "",
                              source_ids=[source] if source else [], provenance_status="exact" if source else "unavailable"))
        for entity in objects.get("entities", []):
            text = format_entities([entity]).removeprefix(ENTITY_HEADER)
            if text:
                items.append(Item(id=str(entity.get("id", "")), rank=len(items) + 1, type="entity", text=text))
        for fact in objects.get("facts", []):
            if fact.get("text"):
                items.append(Item(id=str(fact.get("id", "")), rank=len(items) + 1, type="fact", text=fact["text"]))
        return {"items": items, "applied_settings": applied, "raw": {"context": result.get("context_result")}}

    async def _delete(self, ns: str, source_id: str) -> Any:
        if await self._dataset(ns) is None:
            return None
        return await cognee.forget(data_id=self.data_id(ns, source_id), dataset=ns)

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        receipt = self.run(self._delete(ns, source_id))
        if receipt is None:
            return {"status": "partial", "receipt": {"reason": "namespace has no dataset"}}
        self.sources.get(ns, {}).pop(str(self.data_id(ns, source_id)), None)
        return {"status": "deleted", "receipt": json.loads(json.dumps(receipt, default=str))}


if __name__ == "__main__":
    adapter = CogneeAdapter()
    print(json.dumps({"shim": "cognee", "config": CONFIG, "resolved": adapter.resolved_models(), "t": time.time()}), flush=True)
    serve(adapter)
