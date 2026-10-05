"""Shared HTTP shim for the memory shootout (protocol v1, see eval/systems/PROTOCOL.md).

A vendor shim subclasses `Adapter` and calls `serve(MyAdapter())`. This module owns routing, timing, error
shapes and request validation; the adapter owns only the vendor calls.
"""
from __future__ import annotations

import json
import os
import time
import traceback
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PROTOCOL = 1
ERROR_KINDS = {"unsupported", "product_error", "timeout", "invalid_request", "budget"}


class ShimError(Exception):
    def __init__(self, kind: str, message: str, status: int = 500):
        assert kind in ERROR_KINDS, kind
        super().__init__(message)
        self.kind, self.status = kind, status


@dataclass
class Item:
    id: str
    rank: int
    type: str
    text: str
    source_ids: list[str] = field(default_factory=list)
    valid_from: str | None = None
    valid_to: str | None = None
    provenance_status: str = "unavailable"

    def to_json(self) -> dict[str, Any]:
        if self.provenance_status not in ("exact", "partial", "unavailable"):
            raise ShimError("product_error", f"bad provenance_status {self.provenance_status}")
        if self.provenance_status == "unavailable" and self.source_ids:
            raise ShimError("product_error", "provenance unavailable but source_ids given")
        return self.__dict__.copy()


class Adapter:
    """Override every method; defaults raise `unsupported`."""

    def capabilities(self) -> dict[str, Any]:
        raise ShimError("unsupported", "capabilities not implemented", 501)

    def health(self) -> dict[str, Any]:
        return {"ok": True}

    def reset(self, ns: str) -> None:
        raise ShimError("unsupported", "reset not implemented", 501)

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        raise ShimError("unsupported", "ingest not implemented", 501)

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        return {"ready": True, "waited_ms": 0, "completeness": "unknown"}

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        raise ShimError("unsupported", "retrieve not implemented", 501)

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        return {"status": "unsupported", "receipt": {}}


def _require(body: dict[str, Any], *keys: str) -> None:
    missing = [k for k in keys if k not in body]
    if missing:
        raise ShimError("invalid_request", f"missing fields: {', '.join(missing)}", 400)


def _validate_session(s: Any) -> None:
    if not isinstance(s, dict):
        raise ShimError("invalid_request", "session must be an object", 400)
    _require(s, "source_id", "event_time", "turns")
    if not str(s["source_id"]).startswith("src-"):
        raise ShimError("invalid_request", "source_id must be opaque (src-...)", 400)
    for t in s["turns"]:
        _require(t, "role", "speaker", "content")


def dispatch(adapter: Adapter, method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    start = time.perf_counter()
    try:
        if method == "GET" and path == "/health":
            out = dict(adapter.health())
            out.setdefault("config", os.environ.get("SHIM_CONFIG", "recipe"))
        elif method == "GET" and path == "/capabilities":
            out = {"protocol": PROTOCOL, **adapter.capabilities()}
        elif method == "POST" and path == "/reset":
            _require(body, "ns")
            adapter.reset(body["ns"])
            out = {"ok": True}
        elif method == "POST" and path == "/ingest":
            _require(body, "ns", "session")
            _validate_session(body["session"])
            out = adapter.ingest(body["ns"], body["session"])
            if out.get("completeness") not in ("known", "unknown", "degraded"):
                raise ShimError("product_error", "ingest must report completeness")
        elif method == "POST" and path == "/finish":
            _require(body, "ns")
            out = adapter.finish(body["ns"], float(body.get("timeout_s", 600)))
        elif method == "POST" and path == "/retrieve":
            _require(body, "ns", "question", "policy")
            out = adapter.retrieve(body["ns"], body["question"], body.get("query_time"), body["policy"])
            items = out.get("items", [])
            out["items"] = [i.to_json() if isinstance(i, Item) else Item(**i).to_json() for i in items]
            out.setdefault("applied_settings", {})
            out.setdefault("truncated", False)
        elif method == "POST" and path == "/delete_source":
            _require(body, "ns", "source_id")
            out = adapter.delete_source(body["ns"], body["source_id"])
        else:
            raise ShimError("invalid_request", f"no route {method} {path}", 404)
        status = 200
    except ShimError as e:
        status, out = e.status, {"error": {"kind": e.kind, "message": str(e)}}
    except Exception as e:  # vendor exceptions are product errors, with the trace kept inside the container
        traceback.print_exc()
        status, out = 500, {"error": {"kind": "product_error", "message": f"{type(e).__name__}: {e}"}}
    out["service_ms"] = round((time.perf_counter() - start) * 1000, 3)
    return status, out


def serve(adapter: Adapter, port: int | None = None) -> None:
    class Handler(BaseHTTPRequestHandler):
        # Keep-alive with explicit Content-Length on every response; clients may still close each connection.
        protocol_version = "HTTP/1.1"

        def _go(self, method: str) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except json.JSONDecodeError:
                body = None
            status, out = (400, {"error": {"kind": "invalid_request", "message": "body is not JSON"}, "service_ms": 0}) if body is None else dispatch(adapter, method, self.path, body)
            data = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self._go("GET")

        def do_POST(self) -> None:
            self._go("POST")

        def log_message(self, *_: Any) -> None:
            pass

    ThreadingHTTPServer(("0.0.0.0", port or int(os.environ.get("SHIM_PORT", "8700"))), Handler).serve_forever()
