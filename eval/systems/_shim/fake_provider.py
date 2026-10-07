"""Keyless OpenAI-compatible fake provider for shim plumbing tests (stdlib only).

It stands where the metering proxy stands (OPENAI_BASE_URL, ANTHROPIC_BASE_URL), so a run against it proves that a
vendor SDK honors the proxy base URL and that a shim works end to end without a provider key. Its answers are canned
and its scores say nothing about memory quality.

Routes (any path prefix, so `/openai/v1/...` and `/<slot>/openai/v1/...` both work):
  POST .../chat/completions  logprobs requests get a word-overlap True/False answer (cross-encoder rerankers);
                             `response_format: json_schema` gets a schema-valid instance (entities are capitalized
                             words, knowledge graphs get nodes and edges); a forced tool call gets schema-valid
                             arguments; an extract-first-style "## New Messages" prompt gets one memory per message line;
                             anything else gets "ok". `stream: true` answers as server-sent events with usage.
  POST .../responses         `text.format: json_schema` gets the temporal graph library's named structured outputs (ExtractedEntities,
                             ExtractedEdges, EdgeTimestamps) or a schema-valid instance for any other schema.
  POST .../embeddings        hashed bag-of-words vectors; `dimensions` is honored, else the model's native size.
  POST .../messages          an Anthropic-style text answer.
  GET  .../models            a short model list.   GET /_stats   request counts by route and model.

Every request is appended to the log (one JSON line: route, model, dimensions, schema name, response format, whether
the credential is the container's dummy, a body hash), never the body or the credential itself.

Run: python3 eval/systems/_shim/fake_provider.py [--port 8787] [--log fake-provider.jsonl]
     (or FAKE_PROVIDER_PORT / FAKE_PROVIDER_LOG)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import time
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from typing import Any

WORD = re.compile(r"[a-z0-9]+")
NAME = re.compile(r"\b[A-Z][a-z]{2,}\b")
NOT_NAMES = {"The", "What", "That", "This", "Last", "Mostly", "Noted", "Please", "And", "But", "How", "When", "Where",
             "Who", "Why", "Yes", "Our", "Your", "They", "She", "Her", "His", "Its", "There", "Then", "With", "From", "Sure"}
NATIVE_DIMS = {"text-embedding-3-small": 1536, "text-embedding-3-large": 3072, "text-embedding-ada-002": 1536}
STATS: Counter = Counter()
LOCK = Lock()


def words(text: str) -> list[str]:
    return [w for w in WORD.findall(text.lower()) if len(w) > 2]


def embed(text: str, dims: int) -> list[float]:
    v = [0.0] * dims
    v[0] = 0.01
    for w in WORD.findall(text.lower()):
        h = int.from_bytes(hashlib.sha256(w.encode()).digest()[:8], "big")
        v[h % dims] += 1.0 if (h >> 63) else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def names_in(text: str) -> list[str]:
    return list(dict.fromkeys(n for n in NAME.findall(text) if n not in NOT_NAMES))[:8]


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return "" if content is None else json.dumps(content)


def section(prompt: str, tag: str) -> str:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", prompt, re.S)
    return m.group(1) if m else ""


class SchemaFiller:
    """A schema-valid instance: entity names where a name or id is asked for, a snippet of the prompt elsewhere."""

    def __init__(self, root: dict[str, Any], text: str):
        self.root = root
        self.entities = names_in(text) or ["Entity"]
        self.snippet = " ".join(text.split())[:300] or "text"

    def resolve(self, s: dict[str, Any]) -> dict[str, Any]:
        while isinstance(s, dict) and "$ref" in s:
            s = (self.root.get("$defs") or self.root.get("definitions") or {})[s["$ref"].split("/")[-1]]
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


def extract_first_extraction(prompt: str) -> str | None:
    m = re.search(r"## New Messages\n(.*?)(?:\n## |\Z)", prompt, re.S)
    if not m:
        return None
    body = m.group(1)
    try:
        parsed = json.loads(body)
        lines = parsed.splitlines() if isinstance(parsed, str) else [str(x) for x in parsed]
    except json.JSONDecodeError:
        lines = body.splitlines()
    facts = [ln.split(": ", 1)[1] for ln in lines if ": " in ln and ln.split(": ", 1)[0].strip().lower() in ("user", "assistant")]
    return json.dumps({"memory": [{"id": str(i), "text": f} for i, f in enumerate(facts)]})


def temporal_graph_structured(name: str, schema: dict[str, Any], prompt: str) -> Any:
    filler = SchemaFiller(schema, prompt)
    current = section(prompt, "CURRENT MESSAGES") or section(prompt, "CURRENT MESSAGE") or section(prompt, "CURRENT_MESSAGE")
    if name == "ExtractedEntities":
        return {"extracted_entities": [{"name": n, "entity_type_id": 0, "episode_indices": [0]} for n in names_in(current)]}
    if name == "ExtractedEdges":
        found = names_in(current)
        lines = [ln.strip() for ln in current.strip().splitlines() if ln.strip()]
        edges = []
        for a, b in zip(found, found[1:]):
            fact = next((ln for ln in lines if a in ln and b in ln), next((ln for ln in lines if b in ln), current.strip()))[:300]
            edges.append({"source_entity_name": a, "target_entity_name": b, "relation_type": "MENTIONED_WITH", "fact": fact, "episode_indices": [0]})
        return {"edges": edges}
    if name == "EdgeTimestamps":
        when = re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", section(prompt, "REFERENCE_TIME"))
        return {"valid_at": when.group(0) + "Z" if when else None, "invalid_at": None}
    return filler.fill(schema)


def usage_chat(prompt: str, completion: str) -> dict[str, int]:
    p, c = max(1, len(prompt) // 4), max(1, len(completion) // 4)
    return {"prompt_tokens": p, "completion_tokens": c, "total_tokens": p + c}


def chat(body: dict[str, Any]) -> dict[str, Any]:
    msgs = body.get("messages") or []
    prompt = "\n".join(content_text(m.get("content")) for m in msgs)
    last_user = next((content_text(m.get("content")) for m in reversed(msgs) if m.get("role") == "user"), prompt)
    rf = body.get("response_format") or {}
    tools = body.get("tools") or []
    message: dict[str, Any] = {"role": "assistant", "content": None, "refusal": None}
    logprobs = None
    if body.get("logprobs"):
        query, passage = set(words(section(prompt, "QUERY"))), set(words(section(prompt, "PASSAGE")))
        p = min(0.99, 0.05 + len(query & passage) / max(1, len(query)))
        token = "True" if p >= 0.5 else "False"
        lp = math.log(p if token == "True" else 1 - p)
        other = math.log(max(1e-9, 1 - math.exp(lp)))
        top = [{"token": token, "logprob": lp, "bytes": None}, {"token": "False" if token == "True" else "True", "logprob": other, "bytes": None}]
        logprobs = {"content": [{"token": token, "logprob": lp, "bytes": None, "top_logprobs": top}], "refusal": None}
        message["content"] = token
    elif rf.get("type") == "json_schema":
        schema = (rf.get("json_schema") or {}).get("schema", {})
        message["content"] = json.dumps(SchemaFiller(schema, last_user).fill(schema))
    elif tools and body.get("tool_choice") not in (None, "auto", "none"):
        fn = tools[0]["function"]
        params = fn.get("parameters", {})
        message["tool_calls"] = [{"id": "call_fake", "type": "function", "function": {"name": fn["name"], "arguments": json.dumps(SchemaFiller(params, last_user).fill(params))}}]
    else:
        extracted = extract_first_extraction(prompt)
        message["content"] = extracted if extracted is not None else "{}" if rf.get("type") == "json_object" else "ok"
    return {"id": f"chatcmpl-{uuid.uuid4().hex}", "object": "chat.completion", "created": int(time.time()), "model": body.get("model", "fake"),
            "choices": [{"index": 0, "message": message, "logprobs": logprobs, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}],
            "usage": usage_chat(prompt, json.dumps(message))}


def responses(body: dict[str, Any]) -> dict[str, Any]:
    fmt = (body.get("text") or {}).get("format") or {}
    items = body.get("input") or []
    prompt = items if isinstance(items, str) else "\n".join(content_text(m.get("content")) if isinstance(m, dict) else str(m) for m in items)
    prompt = "\n".join(x for x in [content_text(body.get("instructions")), prompt] if x)
    payload = temporal_graph_structured(fmt.get("name", ""), fmt.get("schema", {}), prompt) if fmt.get("type") == "json_schema" else "ok"
    text = payload if isinstance(payload, str) else json.dumps(payload)
    u = usage_chat(prompt, text)
    return {"id": f"resp_{uuid.uuid4().hex}", "object": "response", "created_at": int(time.time()), "model": body.get("model"),
            "status": "completed", "parallel_tool_calls": False, "tool_choice": "auto", "tools": [], "error": None,
            "incomplete_details": None, "instructions": None, "metadata": {}, "temperature": None, "top_p": None,
            "output": [{"type": "message", "id": f"msg_{uuid.uuid4().hex}", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": u["prompt_tokens"], "output_tokens": u["completion_tokens"], "total_tokens": u["total_tokens"],
                      "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}


def embeddings(body: dict[str, Any]) -> dict[str, Any]:
    inputs = body.get("input", [])
    inputs = [inputs] if isinstance(inputs, str) else inputs
    model = body.get("model", "")
    dims = int(body.get("dimensions") or NATIVE_DIMS.get(model, 3072 if "large" in model else 1536))
    tokens = sum(len(str(t)) // 4 + 1 for t in inputs)
    return {"object": "list", "model": model, "data": [{"object": "embedding", "index": i, "embedding": embed(str(t), dims)} for i, t in enumerate(inputs)],
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}


def messages(body: dict[str, Any]) -> dict[str, Any]:
    prompt = "\n".join(content_text(m.get("content")) for m in body.get("messages", []))
    return {"id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": body.get("model"), "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "ok"}], "usage": {"input_tokens": max(1, len(prompt) // 4), "output_tokens": 1}}


ROUTES = {"/chat/completions": ("chat", chat), "/responses": ("responses", responses), "/embeddings": ("embeddings", embeddings), "/messages": ("messages", messages)}


def make_handler(log_path: str | None) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, out: Any, sse: bool = False) -> None:
            data = out if isinstance(out, bytes) else json.dumps(out).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            if path.startswith("/_stats"):
                with LOCK:
                    return self._send(200, dict(STATS))
            if re.search(r"/models(/[^/]+)?/?$", path):
                return self._send(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in ("gpt-4.1-mini", "gpt-5-mini", "text-embedding-3-large")]})
            self._send(404, {"error": {"message": f"no route {path}"}})

        def do_POST(self) -> None:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            path = self.path.split("?")[0]
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": {"message": "body is not JSON"}})
            route = next((r for r in ROUTES if path.endswith(r)), None)
            name = ROUTES[route][0] if route else path
            cred = self.headers.get("Authorization") or self.headers.get("x-api-key") or ""
            with LOCK:
                STATS[f"{name}:{body.get('model')}"] += 1
                if log_path:
                    with open(log_path, "a") as f:
                        f.write(json.dumps({"t": round(time.time(), 3), "route": name, "path": path, "model": body.get("model"), "dimensions": body.get("dimensions"),
                                            "schema": ((body.get("text") or {}).get("format") or {}).get("name") or ((body.get("response_format") or {}).get("json_schema") or {}).get("name"),
                                            "response_format": (body.get("response_format") or {}).get("type"), "logprobs": bool(body.get("logprobs")),
                                            "auth_is_dummy": "dummy" in cred, "auth_present": bool(cred), "sha256": hashlib.sha256(raw).hexdigest()[:16]}) + "\n")
            if not route:
                return self._send(404, {"error": {"message": f"no route {path}"}})
            out = ROUTES[route][1](body)
            if body.get("stream") and name == "chat":
                chunk = {**out, "object": "chat.completion.chunk", "usage": None,
                         "choices": [{"index": 0, "delta": out["choices"][0]["message"], "finish_reason": out["choices"][0]["finish_reason"]}]}
                final = {**out, "object": "chat.completion.chunk", "choices": []}
                return self._send(200, f"data: {json.dumps(chunk)}\n\ndata: {json.dumps(final)}\n\ndata: [DONE]\n\n".encode(), sse=True)
            self._send(200, out)

        def log_message(self, *_: Any) -> None:
            pass

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("FAKE_PROVIDER_PORT", "8787")))
    ap.add_argument("--log", default=os.environ.get("FAKE_PROVIDER_LOG"))
    a = ap.parse_args()
    ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(a.log)).serve_forever()


if __name__ == "__main__":
    main()
