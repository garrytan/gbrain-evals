"""Keyless OpenAI-compatible fake provider for shim plumbing tests (stdlib only).

It stands where the metering proxy stands (OPENAI_BASE_URL), so a run against it proves that the vendor SDK honours
the proxy base URL and that the shim works end to end without a provider key. Its answers are canned: chat
completions return a schema-valid instance built from the request's JSON schema (entities are capitalized words from
the prompt), and embeddings are hashed bag-of-words vectors. Scores obtained against it say nothing about memory
quality.

Run: python3 fake_provider.py  (listens on FAKE_PROVIDER_PORT, default 8787; request log at FAKE_PROVIDER_LOG)
GET /_stats returns request counts by route and model.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from typing import Any

WORD = re.compile(r"[A-Za-z0-9]+")
CAPITALIZED = re.compile(r"\b[A-Z][a-z]{2,}\b")
STATS: Counter = Counter()
LOCK = Lock()
LOG_PATH = os.environ.get("FAKE_PROVIDER_LOG")


def embed(text: str, dims: int) -> list[float]:
    vec = [0.0] * dims
    for w in WORD.findall(text.lower()):
        h = int.from_bytes(hashlib.sha256(w.encode()).digest()[:8], "big")
        vec[h % dims] += 1.0 if (h >> 32) & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def prompt_text(body: dict[str, Any]) -> str:
    return "\n".join(content_text(m.get("content")) for m in body.get("messages", []))


def last_user_text(body: dict[str, Any]) -> str:
    for m in reversed(body.get("messages", [])):
        if m.get("role") == "user":
            return content_text(m.get("content"))
    return prompt_text(body)


class SchemaFiller:
    def __init__(self, root: dict[str, Any], text: str):
        self.root = root
        self.entities = list(dict.fromkeys(CAPITALIZED.findall(text)))[:6] or ["Entity"]
        self.snippet = " ".join(text.split())[:300] or "text"

    def resolve(self, s: dict[str, Any]) -> dict[str, Any]:
        while "$ref" in s:
            ref = s["$ref"].split("/")[-1]
            s = (self.root.get("$defs") or self.root.get("definitions") or {})[ref]
        return s

    def fill(self, s: dict[str, Any], key: str = "") -> Any:
        s = self.resolve(s)
        for combo in ("anyOf", "oneOf"):
            if combo in s:
                options = [o for o in s[combo] if self.resolve(o).get("type") != "null"]
                return self.fill(options[0] if options else s[combo][0], key)
        if "allOf" in s:
            return self.fill(s["allOf"][0], key)
        if "enum" in s:
            return s["enum"][0]
        if "const" in s:
            return s["const"]
        t = s.get("type")
        if isinstance(t, list):
            t = next((x for x in t if x != "null"), "string")
        if t == "object" or "properties" in s:
            props = s.get("properties", {})
            if "nodes" in props and "edges" in props:
                return self.knowledge_graph(props)
            return {k: self.fill(v, k) for k, v in props.items()}
        if t == "array":
            return [self.fill(s.get("items", {"type": "string"}), key)]
        if t == "integer":
            return 1
        if t == "number":
            return 1.0
        if t == "boolean":
            return False
        if t == "null":
            return None
        return self.entities[0] if key in ("name", "id") else self.snippet

    def knowledge_graph(self, props: dict[str, Any]) -> dict[str, Any]:
        node_schema = self.resolve(self.resolve(props["nodes"]).get("items", {}))
        edge_schema = self.resolve(self.resolve(props["edges"]).get("items", {}))
        nodes = []
        for name in self.entities:
            node = self.fill(node_schema)
            node.update({k: v for k, v in {"id": name.lower(), "name": name, "type": "Concept",
                                            "description": f"{name} is mentioned in: {self.snippet[:120]}"}.items() if k in node})
            nodes.append(node)
        edges = []
        for a, b in zip(self.entities, self.entities[1:]):
            edge = self.fill(edge_schema)
            edge.update({k: v for k, v in {"source_node_id": a.lower(), "target_node_id": b.lower(),
                                            "relationship_name": "mentioned_with"}.items() if k in edge})
            edges.append(edge)
        out = {k: self.fill(v, k) for k, v in props.items() if k not in ("nodes", "edges")}
        out.update(nodes=nodes, edges=edges)
        return out


def chat(body: dict[str, Any]) -> dict[str, Any]:
    text = last_user_text(body)
    rf = body.get("response_format") or {}
    tools = body.get("tools") or []
    message: dict[str, Any] = {"role": "assistant", "content": None}
    if rf.get("type") == "json_schema":
        schema = rf["json_schema"].get("schema", {})
        message["content"] = json.dumps(SchemaFiller(schema, text).fill(schema))
    elif tools and body.get("tool_choice") not in (None, "auto", "none"):
        fn = tools[0]["function"]
        params = fn.get("parameters", {})
        message["tool_calls"] = [{"id": "call_fake", "type": "function",
                                  "function": {"name": fn["name"], "arguments": json.dumps(SchemaFiller(params, text).fill(params))}}]
    elif rf.get("type") == "json_object":
        message["content"] = "{}"
    else:
        message["content"] = "ok"
    prompt_tokens = max(1, len(prompt_text(body)) // 4)
    completion_tokens = max(1, len(json.dumps(message)) // 4)
    return {"id": "chatcmpl-fake", "object": "chat.completion", "created": int(time.time()), "model": body.get("model", "fake"),
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens}}


def embeddings(body: dict[str, Any]) -> dict[str, Any]:
    inputs = body.get("input", [])
    inputs = [inputs] if isinstance(inputs, str) else inputs
    model = body.get("model", "")
    dims = int(body.get("dimensions") or (1536 if "small" in model else 3072))
    data = [{"object": "embedding", "index": i, "embedding": embed(str(t), dims)} for i, t in enumerate(inputs)]
    tokens = sum(len(str(t)) // 4 + 1 for t in inputs)
    return {"object": "list", "data": data, "model": model, "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, out: Any, sse: bool = False) -> None:
        data = out if isinstance(out, bytes) else json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path.startswith("/_stats"):
            with LOCK:
                return self._send(200, dict(STATS))
        if self.path.rstrip("/").endswith("/models"):
            return self._send(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in
                                                                 ("gpt-4.1-mini", "gpt-5.6-luna", "text-embedding-3-large")]})
        self._send(404, {"error": {"message": f"no route {self.path}"}})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        route = "embeddings" if self.path.endswith("/embeddings") else "chat" if self.path.endswith("/chat/completions") else self.path
        with LOCK:
            STATS[f"{route}:{body.get('model')}"] += 1
            if LOG_PATH:
                with open(LOG_PATH, "a") as f:
                    f.write(json.dumps({"t": time.time(), "route": route, "model": body.get("model"),
                                        "response_format": (body.get("response_format") or {}).get("type"), "dimensions": body.get("dimensions"),
                                        "auth_present": bool(self.headers.get("Authorization"))}) + "\n")
        if route == "embeddings":
            return self._send(200, embeddings(body))
        if route == "chat":
            out = chat(body)
            if body.get("stream"):
                delta = {**out, "object": "chat.completion.chunk",
                         "choices": [{"index": 0, "delta": out["choices"][0]["message"], "finish_reason": out["choices"][0]["finish_reason"]}]}
                return self._send(200, f"data: {json.dumps(delta)}\n\ndata: [DONE]\n\n".encode(), sse=True)
            return self._send(200, out)
        self._send(404, {"error": {"message": f"no route {self.path}"}})

    def log_message(self, *_: Any) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("FAKE_PROVIDER_PORT", "8787"))), Handler).serve_forever()
