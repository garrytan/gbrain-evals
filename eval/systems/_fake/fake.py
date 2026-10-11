"""Keyless reference shim: an in-memory keyword store that implements protocol v1 exactly.

It proves the harness plumbing (conformance tests, CI). Its scores say nothing about memory quality.
Run: python3 eval/systems/_fake/fake.py  (listens on SHIM_PORT, default 8700)
With SHIM_STATE_FILE set, the store is written to that JSON file after every change and read back at start, so a
restart keeps state (lifecycle-lite's restart checkpoint); without it the store lives in memory only.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from threading import Lock
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

WORD = re.compile(r"[a-z0-9]+")


def words(text: str) -> set[str]:
    return {w for w in WORD.findall(text.lower()) if len(w) > 2}


class FakeAdapter(Adapter):
    def __init__(self) -> None:
        self.store: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
        self.lock = Lock()
        self.state_file = os.environ.get("SHIM_STATE_FILE") or None
        if self.state_file and os.path.exists(self.state_file):
            with open(self.state_file, encoding="utf-8") as f:
                for ns, sessions in json.load(f).items():
                    for src, s in sessions.items():
                        self.store[ns][src] = {"text": s["text"], "event_time": s["event_time"], "words": words(s["text"])}

    def save(self) -> None:
        """Write the store to SHIM_STATE_FILE (atomically); call with the lock held."""
        if not self.state_file:
            return
        data = {ns: {src: {"text": s["text"], "event_time": s["event_time"]} for src, s in sessions.items()} for ns, sessions in self.store.items()}
        tmp = f"{self.state_file}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, self.state_file)

    def capabilities(self) -> dict[str, Any]:
        return {
            "system": "fake",
            "versions": {"package": "in-repo", "lock_sha256": None, "image": None, "vendor_benchmark_code": None},
            "configs": {"recipe": {"model_roles": {}, "notes": "keyword overlap, no provider calls"},
                        "common": {"model_roles": {}, "unsettable": ["extraction", "embedder"]}},
            "time": "native",
            "provenance": {"status": "exact", "mechanism": "one item per ingested session"},
            "delete": "native",
            "readiness": "synchronous",
            "namespace": "in-memory dict key",
            "parallel_namespaces": True,
            "retrieval_policies": {"vendor-default": {"settings": {"k": 5}}, "fixed-evidence": {"settings": {"k": 20}}},
            "streaming": "disabled",
            "telemetry_off": [],
            "agent_surface": {"kind": "none"},
            "deviations_from_vendor_code": [],
        }

    def reset(self, ns: str) -> None:
        with self.lock:
            self.store.pop(ns, None)
            self.save()

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        text = "\n".join(f"{t['speaker']}: {t['content']}" for t in session["turns"])
        with self.lock:
            self.store[ns][session["source_id"]] = {"text": text, "event_time": session["event_time"], "words": words(text)}
            self.save()
        return {"items_created": 1, "warnings": [], "errors": [], "completeness": "known"}

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        if policy.get("mode") not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        k = int(policy.get("settings", {}).get("k") or self.capabilities()["retrieval_policies"][policy["mode"]]["settings"]["k"])
        q = words(question)
        with self.lock:
            scored = sorted(((len(q & s["words"]), src, s) for src, s in self.store.get(ns, {}).items()), key=lambda x: (-x[0], x[1]))
        items = [Item(id=src, rank=i + 1, type="episode", text=s["text"], source_ids=[src], valid_from=s["event_time"], provenance_status="exact")
                 for i, (score, src, s) in enumerate(scored[:k]) if score > 0]
        return {"items": items, "applied_settings": {"k": k}}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        with self.lock:
            removed = self.store.get(ns, {}).pop(source_id, None)
            self.save()
        return {"status": "deleted" if removed else "partial", "receipt": {"removed": bool(removed)}}


if __name__ == "__main__":
    serve(FakeAdapter())
