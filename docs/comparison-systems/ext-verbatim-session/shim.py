"""MemPalace 3.10.0 behind shim protocol v1 (eval/systems/PROTOCOL.md), in its two no-LLM retrieval modes.

Retrieval follows MemPalace's own LoCoMo benchmark at session granularity (MemPalace/mempalace,
benchmarks/locomo_bench.py, tag v3.10.0): one ChromaDB drawer per whole session in a persistent palace
(`chromadb.PersistentClient(path)`, collection `mempal_drawers`, ChromaDB's default all-MiniLM-L6-v2 embedder), then
either `raw` (vector search, top k) or `hybrid` (vector search over 3k candidates re-ranked by predicate-keyword
overlap, quoted-phrase and person-name boosts). The LLM reranker is never called. The vendor file is fetched at the
pinned commit and checked by sha256 at image build; the shim calls its corpus and scoring helpers directly.
README.md lists every deviation from the vendor benchmark.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

HERE = Path(__file__).resolve().parent
CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
if CONFIG != "recipe":
    raise SystemExit(f"SHIM_CONFIG must be recipe (the common config is unsupported for this system), not {CONFIG!r}")
PALACES = Path(os.environ.get("SHIM_DATA_DIR", "/data")) / "palaces"
VENDOR_BENCH = Path(os.environ.get("VENDOR_BENCH", HERE / "vendor" / "locomo_bench.py"))
VENDOR_BENCH_SHA256 = "ba7178748a14bd1c7667f2479d486bf37a8d19e6a8a810b27bd7bc4b40c8aad2"
COLLECTION = "mempal_drawers"
NS_RE = re.compile(r"^ns-[A-Za-z0-9_-]{1,80}$")
SRC_RE = re.compile(r"^src-[A-Za-z0-9_-]{1,120}$")
RECIPES = ("raw", "hybrid")
HYBRID = {"candidate_multiplier": 3, "predicate_overlap_weight": 0.50, "quoted_phrase_weight": 0.60, "person_name_weight": 0.20}


def load_vendor_bench() -> Any:
    digest = hashlib.sha256(VENDOR_BENCH.read_bytes()).hexdigest()
    if digest != VENDOR_BENCH_SHA256:
        raise SystemExit(f"{VENDOR_BENCH} sha256 {digest} is not the pinned {VENDOR_BENCH_SHA256}")
    spec = importlib.util.spec_from_file_location("vendor_locomo_bench", VENDOR_BENCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bench = load_vendor_bench()


def session_document(session: dict[str, Any]) -> str:
    """The vendor's session-granularity drawer text: every turn as `Speaker said, "text"`, joined by newlines."""
    dialogs = [{"speaker": t["speaker"], "text": str(t["content"])} for t in session["turns"]]
    corpus, _, _ = bench.build_corpus_from_sessions([{"session_num": 1, "date": session["event_time"] or "", "dialogs": dialogs}], granularity="session")
    return corpus[0]


class VerbatimSessionAdapter(Adapter):
    def __init__(self) -> None:
        PALACES.mkdir(parents=True, exist_ok=True)
        self.record = json.loads((HERE / "capability.json").read_text())
        lock = HERE / "uv.lock"
        self.record["versions"]["lock_sha256"] = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None
        self.record["versions"]["image"] = os.environ.get("SHIM_IMAGE") or None
        self.clients: dict[str, Any] = {}
        self.ns_locks: dict[str, threading.Lock] = {}
        self.guard = threading.Lock()
        from mempalace.version import __version__
        self.version = __version__
        self.embedder = DefaultEmbeddingFunction()
        self.embedder(["warm up"])

    def lock_for(self, ns: str) -> threading.Lock:
        if not NS_RE.match(ns):
            raise ShimError("invalid_request", "ns must be opaque (ns-...)", 400)
        with self.guard:
            return self.ns_locks.setdefault(ns, threading.Lock())

    def client(self, ns: str) -> Any:
        with self.guard:
            if ns not in self.clients:
                self.clients[ns] = chromadb.PersistentClient(path=str(PALACES / ns / "palace"))
            return self.clients[ns]

    def collection(self, ns: str) -> Any:
        return self.client(ns).get_or_create_collection(COLLECTION)

    def capabilities(self) -> dict[str, Any]:
        return self.record

    def health(self) -> dict[str, Any]:
        return {"ok": True, "config": CONFIG, "mempalace_version": self.version, "chromadb_version": chromadb.__version__}

    def reset(self, ns: str) -> None:
        with self.lock_for(ns):
            client = self.client(ns)
            try:
                client.delete_collection(COLLECTION)
            except Exception:  # noqa: BLE001 - a fresh palace has no collection yet
                pass
            client.create_collection(COLLECTION)

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        sid = session["source_id"]
        if not SRC_RE.match(sid):
            raise ShimError("invalid_request", "source_id must be opaque (src-...)", 400)
        with self.lock_for(ns):
            col = self.collection(ns)
            warnings = [f"{sid} replaced an earlier drawer with the same source_id"] if col.get(ids=[sid])["ids"] else []
            col.upsert(documents=[session_document(session)], ids=[sid],
                       metadatas=[{"corpus_id": sid, "timestamp": session["event_time"] or "", "room": "general"}])
        return {"items_created": 1, "warnings": warnings, "errors": [], "completeness": "known"}

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        start = time.monotonic()
        with self.lock_for(ns):
            count = self.collection(ns).count()
        return {"ready": True, "waited_ms": round((time.monotonic() - start) * 1000), "completeness": "known", "receipt": {"drawers": count}}

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        settings = policy.get("settings") or {}
        unknown = set(settings) - {"k", "recipe"}
        if unknown:
            raise ShimError("invalid_request", f"unknown policy settings {sorted(unknown)}; this shim takes k and recipe", 400)
        defaults = self.record["retrieval_policies"][mode]["settings"]
        k = int(settings.get("k") or defaults["k"])
        recipe = str(settings.get("recipe") or defaults["recipe"])
        if recipe not in RECIPES or k < 1:
            raise ShimError("invalid_request", f"recipe must be one of {list(RECIPES)} and k >= 1", 400)
        with self.lock_for(ns):
            col = self.collection(ns)
            total = col.count()
            n_retrieve = min(k * HYBRID["candidate_multiplier"] if recipe == "hybrid" else k, total)
            applied = {"recipe": recipe, "k": k, "n_retrieve": n_retrieve, "embedder": "chromadb default (all-MiniLM-L6-v2)",
                       "llm_rerank": False, "query_time": "ignored: neither recipe reads a reference date"}
            if recipe == "hybrid":
                applied.update(HYBRID)
            if not n_retrieve:
                return {"items": [], "applied_settings": applied, "truncated": False}
            results = bench._query(col, question, n_retrieve, "default")
        ids, distances, docs = results["ids"][0], results["distances"][0], results["documents"][0]
        metas = results["metadatas"][0]
        ranked = list(range(len(ids)))
        fused: dict[int, float] = {}
        if recipe == "hybrid":
            names = bench._person_names(question)
            name_words = {n.lower() for n in names}
            predicate_kws = [w for w in bench._kw(question) if w not in name_words]
            quoted = bench._quoted_phrases(question)
            for i, (dist, doc) in enumerate(zip(distances, docs)):
                score = dist * (1.0 - HYBRID["predicate_overlap_weight"] * bench._kw_overlap(predicate_kws, doc))
                q_boost = bench._quoted_boost(quoted, doc)
                if q_boost > 0:
                    score *= 1.0 - HYBRID["quoted_phrase_weight"] * q_boost
                n_boost = bench._name_boost(names, doc)
                if n_boost > 0:
                    score *= 1.0 - HYBRID["person_name_weight"] * n_boost
                fused[i] = score
            ranked.sort(key=lambda i: fused[i])
            applied.update({"predicate_keywords": predicate_kws, "person_names": sorted(names), "quoted_phrases": quoted})
        items = [Item(id=ids[i], rank=r + 1, type="episode", text=docs[i], source_ids=[ids[i]],
                      valid_from=(metas[i] or {}).get("timestamp") or None, provenance_status="exact")
                 for r, i in enumerate(ranked[:k])]
        raw = [{"id": ids[i], "distance": distances[i], **({"fused": fused[i]} if fused else {})} for i in ranked]
        return {"items": items, "applied_settings": applied, "truncated": total > k, "raw": raw}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        with self.lock_for(ns):
            col = self.collection(ns)
            if not col.get(ids=[source_id])["ids"]:
                return {"status": "partial", "receipt": {"reason": "source_id was never ingested in this namespace"}}
            col.delete(ids=[source_id])
            left = col.get(ids=[source_id])["ids"]
        return {"status": "partial" if left else "deleted", "receipt": {"api": "collection.delete(ids=[source_id])", "drawers_left_for_source": len(left)}}


if __name__ == "__main__":
    serve(VerbatimSessionAdapter())
