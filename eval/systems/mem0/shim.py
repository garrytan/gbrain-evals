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
POLICY_K = {"vendor-default": 20, "fixed-evidence": 200}
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
        "llm": {"provider": "openai", "config": {}},
        "embedder": {"provider": "openai", "config": {}},
        "history_db_path": str(DATA / f"history_{CONFIG}.db"),
    }
    if CONFIG == "common":
        cfg["llm"]["config"] = {"model": "gpt-4.1-mini"}
        cfg["embedder"]["config"] = {"model": "text-embedding-3-large", "embedding_dims": 1536}
    elif CONFIG != "recipe":
        raise SystemExit(f"SHIM_CONFIG must be recipe or common, not {CONFIG!r}")
    return cfg


def budget_refusal(exc: BaseException) -> bool:
    """True when the metering proxy refused the provider call (it answers 402)."""
    seen = exc
    while seen is not None:
        if getattr(seen, "status_code", None) == 402:
            return True
        seen = seen.__cause__ or seen.__context__
    return False


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
        self.ns_locks: dict[str, threading.Lock] = {}
        self.degraded: set[str] = set()

    def lock_for(self, ns: str) -> threading.Lock:
        if not NS_RE.match(ns):
            raise ShimError("invalid_request", "ns must be opaque (ns-...)", 400)
        with self.guard:
            return self.ns_locks.setdefault(ns, threading.Lock())

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
        with self.lock_for(ns):
            self.memory.delete_all(user_id=self.scope(ns))
            with self.guard:
                self.scopes[ns] = self.scopes.get(ns, 0) + 1
                self.scopes_path.write_text(json.dumps(self.scopes))
            self.degraded.discard(ns)

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
        sid, date = session["source_id"], render_date(session["event_time"])
        msgs = self.messages(session)
        header = [{"role": "system", "content": f"This conversation took place at {date}."}] if date else []
        metadata = {"source_id": sid, "session_date": session["event_time"]}
        created, errors, warnings = 0, [], []
        with self.lock_for(ns):
            user_id = self.scope(ns)
            for start in range(0, len(msgs), CHUNK_TURNS):
                try:
                    res = self.memory.add(header + msgs[start:start + CHUNK_TURNS], user_id=user_id, metadata=metadata)
                except Exception as e:  # noqa: BLE001 - one failed chunk degrades the session, the rest still run
                    if budget_refusal(e):
                        raise ShimError("budget", f"metering proxy refused a call while ingesting {sid}: {e}", 402)
                    errors.append(f"chunk {start // CHUNK_TURNS}: {type(e).__name__}: {str(e)[:300]}")
                    continue
                created += sum(1 for r in res.get("results", []) if r.get("event") == "ADD")
            if errors:
                self.degraded.add(ns)
        if not msgs:
            warnings.append(f"{sid} has no non-empty turns")
        return {"items_created": created, "warnings": warnings, "errors": errors,
                "completeness": "degraded" if errors else "known"}

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        with self.lock_for(ns):
            return {"ready": True, "waited_ms": 0, "completeness": "degraded" if ns in self.degraded else "known"}

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in POLICY_K:
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        k = int((policy.get("settings") or {}).get("k") or POLICY_K[mode])
        self.lock_for(ns)
        try:
            res = self.memory.search(question, top_k=k, filters={"user_id": self.scope(ns)})
        except Exception as e:  # noqa: BLE001
            if budget_refusal(e):
                raise ShimError("budget", f"metering proxy refused the query embedding: {e}", 402)
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
        with self.lock_for(ns):
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
