"""Test-only local stand-in for an OpenAI-compatible upstream.

Serves `POST .../chat/completions` with JSON that satisfies the requested
schema (either `response_format.json_schema` or the schema the client wrote
into the prompt for `json_object` mode) and `POST .../embeddings` with
deterministic hash vectors. Every request is recorded so a test can count
calls. No request ever leaves the machine.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEMA_IN_PROMPT = re.compile(r"respond with valid JSON matching this schema:\s*(\{.*\})", re.S)


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _resolve(schema: dict, root: dict) -> dict:
    while "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        schema = {**node, **{k: v for k, v in schema.items() if k != "$ref"}}
    return schema


def instance(schema: dict, root: dict, filler: str, depth: int = 0) -> object:
    """A minimal value that validates against `schema`."""
    schema = _resolve(schema, root)
    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        return schema["enum"][0]
    for key in ("anyOf", "oneOf"):
        if key in schema:
            options = [_resolve(s, root) for s in schema[key]]
            non_null = [s for s in options if s.get("type") != "null"]
            if depth > 3 and len(non_null) < len(options):
                return None
            return instance(non_null[0] if non_null else options[0], root, filler, depth + 1)
    if "allOf" in schema:
        merged: dict = {}
        for s in schema["allOf"]:
            merged.update(_resolve(s, root))
        return instance(merged, root, filler, depth + 1)
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), "null")
    if kind == "object" or "properties" in schema:
        props = schema.get("properties", {})
        required = schema.get("required", list(props))
        return {name: instance(props[name], root, filler, depth + 1) for name in required if name in props}
    if kind == "array":
        if depth > 3:
            return []
        n = max(1, schema.get("minItems", 1))
        return [instance(schema.get("items", {"type": "string"}), root, filler, depth + 1) for _ in range(n)]
    if kind == "integer":
        return schema.get("minimum", 0)
    if kind == "number":
        return float(schema.get("minimum", 0))
    if kind == "boolean":
        return False
    if kind == "null":
        return None
    fmt = schema.get("format")
    if fmt == "date-time":
        return "2024-01-01T00:00:00Z"
    if fmt == "date":
        return "2024-01-01"
    return filler


def hash_embedding(text: str, dims: int) -> list[float]:
    raw = b""
    counter = 0
    while len(raw) < dims * 4:
        raw += hashlib.sha256(f"{counter}:{text}".encode()).digest()
        counter += 1
    vec = [int.from_bytes(raw[i * 4:(i + 1) * 4], "little") / 2**32 - 0.5 for i in range(dims)]
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class StubUpstream:
    def __init__(self, embedding_dims: int = 384):
        self.embedding_dims = embedding_dims
        self.requests: list[dict] = []
        self._lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self._reply(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
                with stub._lock:
                    stub.requests.append({"path": self.path, "auth": self.headers.get("authorization", ""), "body": body})
                if self.path.endswith("/chat/completions"):
                    self._reply(200, stub.chat(body))
                elif self.path.endswith("/embeddings"):
                    self._reply(200, stub.embeddings(body))
                else:
                    self._reply(404, {"error": {"message": f"stub has no route {self.path}"}})

            def _reply(self, status: int, payload: dict):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> "StubUpstream":
        self._thread.start()
        return self

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def chat(self, body: dict) -> dict:
        messages = body.get("messages") or []
        users = [_text_of(m.get("content")) for m in messages if m.get("role") == "user"]
        filler = " ".join((users[-1] if users else "stub").split())[-160:] or "stub"
        fmt = body.get("response_format") or {}
        schema = None
        if fmt.get("type") == "json_schema":
            schema = fmt["json_schema"]["schema"]
        elif fmt.get("type") == "json_object":
            for m in messages:
                found = SCHEMA_IN_PROMPT.search(_text_of(m.get("content")))
                if found:
                    schema = json.loads(found.group(1))
                    break
        if schema is not None:
            content = json.dumps(instance(schema, schema, filler))
        elif fmt.get("type") == "json_object":
            content = "{}"
        else:
            content = filler
        return {
            "id": f"stub-{len(self.requests)}",
            "object": "chat.completion",
            "created": 0,
            "model": body.get("model", "stub-model"),
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    def embeddings(self, body: dict) -> dict:
        inputs = body.get("input")
        inputs = [inputs] if isinstance(inputs, str) else list(inputs or [])
        dims = int(body.get("dimensions") or self.embedding_dims)
        return {
            "object": "list",
            "model": body.get("model", "stub-embedding"),
            "data": [{"object": "embedding", "index": i, "embedding": hash_embedding(str(t), dims)} for i, t in enumerate(inputs)],
            "usage": {"prompt_tokens": len(inputs), "total_tokens": len(inputs)},
        }

    def chat_requests(self) -> list[dict]:
        with self._lock:
            return [r for r in self.requests if r["path"].endswith("/chat/completions")]
