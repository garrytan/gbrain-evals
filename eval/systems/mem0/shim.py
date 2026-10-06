"""Mem0 OSS 2.2.1 behind shim protocol v1 (eval/systems/PROTOCOL.md).

Ingestion follows mem0ai/memory-benchmarks (commit 4b61c5d3): each session is split into chunks of turns, each turn
becomes one message whose content is "Speaker: text", and every chunk is one `Memory.add` call scoped by user_id.
Search is `Memory.search(question, filters={"user_id": ...})`. README.md lists every deviation from that code.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("SHIM_DATA_DIR", "/data"))
CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
CHUNK_TURNS = int(os.environ.get("MEM0_CHUNK_TURNS", "2"))
NS_RE = re.compile(r"^ns-[A-Za-z0-9_-]{1,80}$")
LIST_PAGE = 1000


def render_date(event_time: str | None) -> str:
    """ISO-8601 to the LoCoMo phrase ("1:56 pm on 8 May, 2023"), the form mem0's benchmark code shows its reader."""
    if not event_time:
        return ""
    dt = datetime.fromisoformat(event_time.replace("Z", "+00:00"))
    return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'am' if dt.hour < 12 else 'pm'} on {dt.day} {dt:%B}, {dt.year}"


def mem0_config() -> dict[str, Any]:
    qdrant = {"host": os.environ.get("QDRANT_HOST", "qdrant"), "port": int(os.environ.get("QDRANT_PORT", "6333")),
              "collection_name": f"memories_{CONFIG}", "embedding_model_dims": 1536}
    cfg: dict[str, Any] = {
        "version": "v1.1",
        "vector_store": {"provider": "qdrant", "config": qdrant},
        "llm": {"provider": "openai", "config": {"is_reasoning_model": True}},
        "embedder": {"provider": "openai", "config": {}},
        "history_db_path": str(DATA / f"history_{CONFIG}.db"),
    }
    if CONFIG == "common":
        cfg["llm"]["config"] = {"model": "gpt-4.1-mini"}
        cfg["embedder"]["config"] = {"model": "text-embedding-3-large", "embedding_dims": 1536}
    elif CONFIG != "recipe":
        raise SystemExit(f"SHIM_CONFIG must be recipe or common, not {CONFIG!r}")
    return cfg


def proxy_refusal(exc: BaseException, doing: str) -> None:
    """Raise the protocol error when the metering proxy refused a provider call: 402 is over lease or an unpriced
    model (`budget`), 403 a route outside the allowlist or a leak tripwire (`invalid_request`)."""
    seen = exc
    while seen is not None:
        status = getattr(seen, "status_code", None)
        if status == 402:
            raise ShimError("budget", f"metering proxy refused a call while {doing}: {seen}", 402)
        if status == 403:
            raise ShimError("invalid_request", f"metering proxy rejected a call while {doing}: {seen}", 403)
        seen = seen.__cause__ or seen.__context__


@dataclass
class Lane:
    """One namespace's ingest queue: a single worker keeps sessions in arrival (event-time) order."""
    pool: ThreadPoolExecutor = field(default_factory=lambda: ThreadPoolExecutor(max_workers=1))
    futures: list = field(default_factory=list)
    sessions: int = 0
    created: int = 0
    errors: list = field(default_factory=list)
    budget: str | None = None


class Mem0Adapter(Adapter):
    def __init__(self) -> None:
        from mem0 import Memory

        DATA.mkdir(parents=True, exist_ok=True)
        self.memory = Memory.from_config(mem0_config())
        self.record = json.loads((HERE / "capability.json").read_text())
        lock = HERE / "uv.lock"
        self.record["versions"]["lock_sha256"] = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None
        self.record["versions"]["image"] = os.environ.get("SHIM_IMAGE") or None
        self.resolved = {
            "config": CONFIG,
            "extraction": self.memory.llm.config.model,
            "embedder": self.memory.embedding_model.config.model,
            "dims": self.memory.embedding_model.config.embedding_dims,
            "chunk_turns": CHUNK_TURNS,
        }
        self.scopes_path = DATA / f"scopes_{CONFIG}.json"
        self.scopes: dict[str, int] = json.loads(self.scopes_path.read_text()) if self.scopes_path.exists() else {}
        self.guard = threading.Lock()
        self.lanes: dict[str, Lane] = {}

    def lane(self, ns: str) -> Lane:
        if not NS_RE.match(ns):
            raise ShimError("invalid_request", "ns must be opaque (ns-...)", 400)
        with self.guard:
            return self.lanes.setdefault(ns, Lane())

    def drain(self, ns: str, timeout_s: float) -> tuple[Lane, bool]:
        lane = self.lane(ns)
        _, pending = wait(list(lane.futures), timeout=timeout_s)
        return lane, not pending

    def scope(self, ns: str) -> str:
        """Mem0 user_id for a namespace. Reset moves to a fresh user_id because delete_all leaves the scope's
        recent raw messages in the history store, where later extraction calls would read them as context."""
        return f"{ns}.g{self.scopes.get(ns, 0)}"

    def capabilities(self) -> dict[str, Any]:
        return {**self.record, "resolved": self.resolved}

    def health(self) -> dict[str, Any]:
        try:
            self.memory.vector_store.client.get_collections()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "config": CONFIG, "error": f"qdrant: {e}"}
        return {"ok": True, **self.resolved}

    def reset(self, ns: str) -> None:
        """Queued sessions are cancelled; one already running finishes into the old user_id, which nothing reads."""
        old = self.lane(ns)
        with self.guard:
            old_scope = self.scope(ns)
            self.scopes[ns] = self.scopes.get(ns, 0) + 1
            self.scopes_path.write_text(json.dumps(self.scopes))
            self.lanes[ns] = Lane()
        old.pool.shutdown(wait=False, cancel_futures=True)
        self.memory.delete_all(user_id=old_scope)

    def messages(self, session: dict[str, Any]) -> list[dict[str, str]]:
        first = session["turns"][0]["speaker"] if session["turns"] else None
        out = []
        for t in session["turns"]:
            text = str(t["content"]).strip()
            if not text:
                continue
            role = t["role"] if t["role"] in ("user", "assistant") else ("user" if t["speaker"] == first else "assistant")
            out.append({"role": role, "content": f"{t['speaker']}: {text}"})
        return out

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        """Queues the session and returns at once: one session can take longer than the harness's request deadline
        (about 16 s per gpt-5-mini add call), so /finish is where the shim waits for mem0, as the protocol allows."""
        msgs = self.messages(session)
        lane = self.lane(ns)
        with self.guard:
            user_id = self.scope(ns)
            lane.futures.append(lane.pool.submit(self.add_session, lane, user_id, session, msgs))
        warnings = [f"{session['source_id']} has no non-empty turns"] if not msgs else []
        return {"items_created": 0, "warnings": warnings, "errors": [], "completeness": "unknown"}

    def add_session(self, lane: Lane, user_id: str, session: dict[str, Any], msgs: list[dict[str, str]]) -> None:
        sid, date = session["source_id"], render_date(session["event_time"])
        header = [{"role": "system", "content": f"This conversation took place at {date}."}] if date else []
        metadata = {"source_id": sid, "session_date": session["event_time"]}
        for start in range(0, len(msgs), CHUNK_TURNS):
            if lane.budget:
                lane.errors.append(f"{sid} chunk {start // CHUNK_TURNS}: not sent after a budget refusal")
                continue
            try:
                res = self.memory.add(header + msgs[start:start + CHUNK_TURNS], user_id=user_id, metadata=metadata)
            except Exception as e:  # noqa: BLE001 - one failed chunk degrades the session, the rest still run
                try:
                    proxy_refusal(e, f"ingesting {sid}")
                except ShimError as refusal:
                    if refusal.kind == "budget":
                        lane.budget = str(refusal)
                    lane.errors.append(f"{sid} chunk {start // CHUNK_TURNS}: {refusal}")
                    continue
                lane.errors.append(f"{sid} chunk {start // CHUNK_TURNS}: {type(e).__name__}: {str(e)[:300]}")
                continue
            lane.created += sum(1 for r in res.get("results", []) if r.get("event") == "ADD")
        lane.sessions += 1

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        t0 = time.monotonic()
        lane, done = self.drain(ns, timeout_s)
        if lane.budget:
            raise ShimError("budget", lane.budget, 402)
        receipt = {"sessions_added": lane.sessions, "memories_created": lane.created, "errors": lane.errors[:50],
                   "error_count": len(lane.errors), "pending": sum(not f.done() for f in lane.futures)}
        return {"ready": done, "waited_ms": round((time.monotonic() - t0) * 1000),
                "completeness": "unknown" if not done else "degraded" if lane.errors else "known", "receipt": receipt}

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        settings = policy.get("settings") or {}
        unknown = set(settings) - {"k"}
        if unknown:
            raise ShimError("invalid_request", f"unknown policy settings {sorted(unknown)}; this shim takes only k", 400)
        k = int(settings.get("k") or self.record["retrieval_policies"][mode]["settings"]["k"])
        self.lane(ns)
        try:
            res = self.memory.search(question, top_k=k, filters={"user_id": self.scope(ns)})
        except Exception as e:  # noqa: BLE001
            proxy_refusal(e, "embedding the query")
            raise
        items = []
        for r in res.get("results", []):
            meta = r.get("metadata") or {}
            sid = meta.get("source_id")
            items.append(Item(id=str(r["id"]), rank=len(items) + 1, type="fact", text=str(r.get("memory", "")),
                              source_ids=[sid] if sid else [], valid_from=meta.get("session_date"),
                              provenance_status="partial" if sid else "unavailable"))
        applied = {"top_k": k, "threshold": 0.1, "rerank": False, "reranker": None,
                   "query_time": "not sent: Memory.search rejects a non-null reference_date in OSS 2.2.1",
                   **self.resolved}
        return {"items": items, "applied_settings": applied, "truncated": len(items) >= k, "raw": res}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        _, done = self.drain(ns, 3600)
        if not done:
            raise ShimError("timeout", "ingest still running after an hour; delete not attempted", 504)
        with self.guard:
            filters = {"user_id": self.scope(ns), "source_id": source_id}
        deleted: list[str] = []
        for _ in range(100):
            batch = self.memory.get_all(filters=filters, top_k=LIST_PAGE).get("results", [])
            if not batch:
                break
            for m in batch:
                self.memory.delete(m["id"])
                deleted.append(m["id"])
        left = self.memory.get_all(filters=filters, top_k=LIST_PAGE).get("results", [])
        return {
            "status": "partial" if left else "deleted",
            "receipt": {
                "memories_deleted": deleted,
                "memories_left": [m["id"] for m in left],
                "residue": "the history store keeps the scope's 10 most recent raw messages and each memory's ADD/DELETE log; neither is searchable",
            },
        }


if __name__ == "__main__":
    serve(Mem0Adapter())
