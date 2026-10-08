"""memory-bank 0.10.2 shim (protocol v1, see eval/systems/PROTOCOL.md).

Starts from the vendor's own benchmark ingestion, AMB's `hindsight-http` provider
(vectorize-io/agent-memory-benchmark@f618ed7, src/memory_bench/memory/hindsight.py). Deviations are listed in
capability.json and README.md. The memory-bank server runs in its own pinned image; this process only speaks
the public HTTP API through hindsight-client 0.10.2.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

from hindsight_client import Hindsight  # noqa: E402
from hindsight_client_api.exceptions import ApiException, NotFoundException  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
HINDSIGHT_URL = os.environ.get("HINDSIGHT_URL", "http://memory-bank:8888")
CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
LLM_PROVIDER = os.environ.get("SHIM_LLM_PROVIDER", "openai")
INGEST_TIMEOUT_S = float(os.environ.get("SHIM_INGEST_TIMEOUT_S", "900"))
POLL_S = 0.5
RECALL_KNOBS = {"budget", "max_tokens", "include_chunks", "max_chunk_tokens", "types"}


def _parse_time(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise ShimError("invalid_request", f"not an ISO-8601 time: {value!r}", 400) from e
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _proxy_refused(message: str | None) -> bool:
    """The metering proxy answers a refused provider call with HTTP 402 and error kind `budget`."""
    return bool(message) and ("402" in message or "'budget'" in message or '"budget"' in message)


def _fact_text(r: Any) -> str:
    """AMB's `_format_result`, without the chunk id line and without inlining the chunk (chunks are items)."""
    lines = [f"**[{r.type}]** {r.text}" if r.type else r.text]
    meta = []
    if r.occurred_start and r.occurred_end and r.occurred_start != r.occurred_end:
        meta.append(f"occurred: {r.occurred_start} \u2013 {r.occurred_end}")
    elif r.occurred_start:
        meta.append(f"occurred: {r.occurred_start}")
    if r.mentioned_at:
        meta.append(f"mentioned: {r.mentioned_at}")
    if meta:
        lines.append("_" + " \u00b7 ".join(meta) + "_")
    return "\n".join(lines)


class HindsightAdapter(Adapter):
    def __init__(self) -> None:
        with open(os.path.join(HERE, "capability.json")) as f:
            self.record = json.load(f)
        if CONFIG not in self.record["configs"]:
            raise SystemExit(f"SHIM_CONFIG must be one of {sorted(self.record['configs'])}, got {CONFIG!r}")
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.client = self._run(self._make_client())
        self.banks: set[str] = set()

    async def _make_client(self) -> Hindsight:
        return Hindsight(base_url=HINDSIGHT_URL, timeout=600.0)

    def _run(self, coro: Any, timeout: float | None = None) -> Any:
        """All vendor calls share one event loop, since the client's aiohttp session is bound to it."""
        try:
            return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)
        except NotFoundException:
            raise
        except ApiException as e:
            body = (e.body or "")[:500]
            if _proxy_refused(body):
                raise ShimError("budget", f"metering proxy refused a provider call: {body}", 402) from e
            raise ShimError("product_error", f"memory-bank HTTP {e.status}: {body}") from e

    def capabilities(self) -> dict[str, Any]:
        return self.record

    def health(self) -> dict[str, Any]:
        try:
            readiness = self._run(self.client.monitoring.get_readiness(), 10)
            version = self._run(self.client.aget_version(), 10)
        except Exception as e:
            raise ShimError("product_error", f"memory-bank not ready: {e}", 503) from e
        return {"ok": True, "config": CONFIG, "llm_provider": LLM_PROVIDER, "readiness": readiness, "server_version": version.to_dict()}

    async def _create_bank(self, ns: str) -> None:
        await self.client.acreate_bank(bank_id=ns, enable_observations=False)
        self.banks.add(ns)

    def reset(self, ns: str) -> None:
        try:
            self._run(self.client.banks.delete_bank(bank_id=ns))
        except NotFoundException:
            pass
        self.banks.discard(ns)
        self._run(self._create_bank(ns))

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        source_id, turns = session["source_id"], session["turns"]
        timestamp = _parse_time(session["event_time"])
        if timestamp is None:
            raise ShimError("invalid_request", "event_time is required; the shim never defaults to the wall clock", 400)
        if ns not in self.banks:
            self._run(self._create_bank(ns))
        speakers = list(dict.fromkeys(t["speaker"] for t in turns))
        item = {
            "content": json.dumps(turns),
            "timestamp": timestamp,
            "context": f"Conversation between {' and '.join(speakers)}",
        }
        resp = self._run(self.client.aretain_batch(bank_id=ns, items=[item], document_id=source_id, retain_async=True))
        if not resp.var_async or not resp.operation_id:
            raise ShimError("product_error", f"retain returned no operation id: {resp.to_dict()}")
        status = self._wait_operation(ns, resp.operation_id, INGEST_TIMEOUT_S)
        if status.status != "completed" and _proxy_refused(status.error_message):
            raise ShimError("budget", f"metering proxy refused a provider call during retain: {status.error_message}", 402)
        if status.status != "completed":
            return {"items_created": 0, "warnings": [], "completeness": "degraded",
                    "errors": [f"operation {resp.operation_id} {status.status}: {status.error_message}"],
                    "receipt": {"operation_id": resp.operation_id, "status": status.status}}
        doc = self._run(self.client.documents.get_document(bank_id=ns, document_id=source_id))
        return {"items_created": doc.memory_unit_count, "warnings": [] if doc.memory_unit_count else ["no memory units extracted"],
                "errors": [], "completeness": "known",
                "receipt": {"operation_id": resp.operation_id, "nodes_by_fact_type": doc.nodes_by_fact_type}}

    def _wait_operation(self, ns: str, operation_id: str, timeout_s: float) -> Any:
        deadline = time.monotonic() + timeout_s
        while True:
            status = self._run(self.client.operations.get_operation_status(bank_id=ns, operation_id=operation_id))
            if status.status in ("completed", "failed", "cancelled"):
                return status
            if time.monotonic() > deadline:
                raise ShimError("timeout", f"retain operation {operation_id} still {status.status} after {timeout_s}s", 504)
            time.sleep(POLL_S)

    async def _op_count(self, ns: str, status: str | None = None) -> int:
        kwargs: dict[str, Any] = {"bank_id": ns, "limit": 1}
        if status:
            kwargs["status"] = status
        return (await self.client.operations.list_operations(**kwargs)).total or 0

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        """AMB's `_in_flight_ops`: in flight = total - completed - failed, polled until zero."""
        start = time.monotonic()
        while True:
            total, completed, failed = (self._run(self._op_count(ns, s)) for s in (None, "completed", "failed"))
            in_flight = max(0, total - completed - failed)
            waited_ms = round((time.monotonic() - start) * 1000)
            if in_flight == 0:
                return {"ready": True, "waited_ms": waited_ms, "completeness": "degraded" if failed else "known",
                        "operations": {"total": total, "completed": completed, "failed": failed}}
            if time.monotonic() - start > timeout_s:
                return {"ready": False, "waited_ms": waited_ms, "completeness": "unknown",
                        "operations": {"total": total, "completed": completed, "failed": failed, "in_flight": in_flight}}
            time.sleep(POLL_S)

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        settings = {**self.record["retrieval_policies"][mode]["settings"], **(policy.get("settings") or {})}
        unknown = set(settings) - RECALL_KNOBS
        if unknown:
            raise ShimError("unsupported", f"memory-bank recall has no knob(s) {sorted(unknown)}; allowed {sorted(RECALL_KNOBS)}", 400)
        _parse_time(query_time)
        if query_time:
            settings["query_timestamp"] = query_time
        resp = self._run(self.client.arecall(bank_id=ns, query=question, **settings))
        chunks = resp.chunks or {}
        items: list[Item] = []
        emitted_chunks: set[str] = set()
        for r in resp.results:
            sources = [r.document_id] if r.document_id else []
            items.append(Item(id=r.id, rank=len(items) + 1, type="observation" if r.type == "observation" else "fact",
                              text=_fact_text(r), source_ids=sources, provenance_status="exact" if sources else "unavailable"))
            if r.chunk_id and r.chunk_id in chunks and r.chunk_id not in emitted_chunks:
                emitted_chunks.add(r.chunk_id)
                items.append(Item(id=r.chunk_id, rank=len(items) + 1, type="chunk", text=chunks[r.chunk_id].text,
                                  source_ids=sources, provenance_status="exact" if sources else "unavailable"))
        truncated = any(c.truncated for c in chunks.values())
        return {"items": items, "applied_settings": {**settings, "endpoint": "POST /v1/default/banks/{bank}/memories/recall"},
                "truncated": truncated, "raw": resp.to_dict()}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        try:
            resp = self._run(self.client.documents.delete_document(bank_id=ns, document_id=source_id))
        except NotFoundException:
            return {"status": "partial", "receipt": {"removed": False, "reason": "document not found"}}
        return {"status": "deleted" if resp.success else "partial", "receipt": resp.to_dict()}


if __name__ == "__main__":
    serve(HindsightAdapter())
