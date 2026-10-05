"""Keyless stand-in for the metering proxy's OpenAI route, for testing shim plumbing only (stdlib).

Serves /openai/v1/embeddings (hashed bag-of-words vectors), /openai/v1/responses (structured outputs built from
the JSON schema the caller sends, with crude capitalized-word entities so Graphiti produces edges) and
/openai/v1/chat/completions (word-overlap logprobs for Graphiti's cross-encoder). Every request is appended to
--log as one JSON line (path, model, schema name), which shows that a container's provider traffic went through
the proxy address. Scores obtained with it say nothing about memory quality.

    python3 eval/systems/graphiti/fake_provider.py --port 8787 --log /tmp/fake-provider.jsonl
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

WORD = re.compile(r"[a-z0-9]+")
NAME = re.compile(r"\b[A-Z][a-z]{2,}\b")
NOT_NAMES = {"The", "What", "That", "This", "Last", "Mostly", "Noted", "Please", "And", "But", "How", "When", "Where",
             "Who", "Why", "Yes", "Our", "Your", "They", "She", "Her", "His", "Its", "There", "Then", "With", "From", "Sure"}
LOCK = threading.Lock()


def words(text: str) -> list[str]:
    return [w for w in WORD.findall(text.lower()) if len(w) > 2]


def embed(text: str, dims: int) -> list[float]:
    v = [0.0] * dims
    v[0] = 0.01
    for w in words(text):
        h = int.from_bytes(hashlib.sha256(w.encode()).digest()[:8], "big")
        v[h % dims] += 1.0 if (h >> 63) else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def section(prompt: str, tag: str) -> str:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", prompt, re.S)
    return m.group(1) if m else ""


def names_in(text: str) -> list[str]:
    return list(dict.fromkeys(n for n in NAME.findall(text) if n not in NOT_NAMES))[:8]


def minimal(schema: dict, defs: dict) -> Any:
    if "$ref" in schema:
        return minimal(defs[schema["$ref"].split("/")[-1]], defs)
    if "anyOf" in schema:
        return None if any(s.get("type") == "null" for s in schema["anyOf"]) else minimal(schema["anyOf"][0], defs)
    t = schema.get("type")
    if t == "object":
        return {k: minimal(v, defs) for k, v in schema.get("properties", {}).items()}
    return {"array": [], "string": "", "integer": 0, "number": 0, "boolean": False, "null": None}.get(t)


def structured(name: str, schema: dict, prompt: str) -> dict:
    out = minimal(schema, schema.get("$defs", {}))
    current = section(prompt, "CURRENT MESSAGES") or section(prompt, "CURRENT MESSAGE") or section(prompt, "CURRENT_MESSAGE")
    if name == "ExtractedEntities":
        out["extracted_entities"] = [{"name": n, "entity_type_id": 0, "episode_indices": [0]} for n in names_in(current)]
    elif name == "ExtractedEdges":
        found = names_in(current)
        lines = [ln.strip() for ln in current.strip().splitlines() if ln.strip()]
        out["edges"] = []
        for a, b in zip(found, found[1:]):
            fact = next((ln for ln in lines if a in ln and b in ln), next((ln for ln in lines if b in ln), current.strip()))[:300]
            out["edges"].append({"source_entity_name": a, "target_entity_name": b, "relation_type": "MENTIONED_WITH",
                                 "fact": fact, "episode_indices": [0]})
    elif name == "EdgeTimestamps":
        when = re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", section(prompt, "REFERENCE_TIME"))
        out["valid_at"] = when.group(0) + "Z" if when else None
    return out


def responses_body(req: dict) -> dict:
    fmt = (req.get("text") or {}).get("format") or {}
    prompt = "\n".join(m["content"] if isinstance(m.get("content"), str) else json.dumps(m.get("content")) for m in req.get("input", []))
    payload = structured(fmt.get("name", ""), fmt.get("schema", {}), prompt) if fmt.get("type") == "json_schema" else {}
    text = json.dumps(payload)
    return {"id": f"resp_{uuid.uuid4().hex}", "object": "response", "created_at": int(time.time()), "model": req.get("model"),
            "status": "completed", "parallel_tool_calls": False, "tool_choice": "auto", "tools": [], "error": None,
            "incomplete_details": None, "instructions": None, "metadata": {}, "temperature": None, "top_p": None,
            "output": [{"type": "message", "id": f"msg_{uuid.uuid4().hex}", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": len(prompt) // 4, "output_tokens": len(text) // 4, "total_tokens": (len(prompt) + len(text)) // 4,
                      "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}


def chat_body(req: dict) -> dict:
    prompt = "\n".join(str(m.get("content", "")) for m in req.get("messages", []))
    logprobs = None
    if req.get("logprobs"):
        query, passage = set(words(section(prompt, "QUERY"))), set(words(section(prompt, "PASSAGE")))
        p = min(0.99, 0.05 + len(query & passage) / max(1, len(query)))
        token = "True" if p >= 0.5 else "False"
        lp = math.log(p if token == "True" else 1 - p)
        top = [{"token": token, "logprob": lp, "bytes": None}, {"token": "False" if token == "True" else "True", "logprob": math.log(1 - math.exp(lp) + 1e-9), "bytes": None}]
        logprobs = {"content": [{"token": token, "logprob": lp, "bytes": None, "top_logprobs": top}], "refusal": None}
        content = token
    else:
        content = "{}"
    return {"id": f"chatcmpl-{uuid.uuid4().hex}", "object": "chat.completion", "created": int(time.time()), "model": req.get("model"),
            "choices": [{"index": 0, "finish_reason": "stop", "logprobs": logprobs,
                         "message": {"role": "assistant", "content": content, "refusal": None}}],
            "usage": {"prompt_tokens": len(prompt) // 4, "completion_tokens": 1, "total_tokens": len(prompt) // 4 + 1}}


def embeddings_body(req: dict) -> dict:
    inputs = req["input"] if isinstance(req["input"], list) else [req["input"]]
    dims = req.get("dimensions") or (3072 if "large" in req.get("model", "") else 1536)
    return {"object": "list", "model": req.get("model"),
            "data": [{"object": "embedding", "index": i, "embedding": embed(str(t), dims)} for i, t in enumerate(inputs)],
            "usage": {"prompt_tokens": sum(len(str(t)) // 4 for t in inputs), "total_tokens": sum(len(str(t)) // 4 for t in inputs)}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--log", default="fake-provider.jsonl")
    args = ap.parse_args()
    routes = {"/embeddings": embeddings_body, "/responses": responses_body, "/chat/completions": chat_body}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            route = next((r for r in routes if self.path.endswith(r)), None)
            status, body = (200, routes[route](req)) if route else (404, {"error": {"message": f"no route {self.path}"}})
            with LOCK, open(args.log, "a") as f:
                f.write(json.dumps({"path": self.path, "model": req.get("model"), "status": status, "dimensions": req.get("dimensions"),
                                    "schema": ((req.get("text") or {}).get("format") or {}).get("name"),
                                    "auth_is_dummy": "dummy" in (self.headers.get("Authorization") or "")}) + "\n")
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_: Any) -> None:
            pass

    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
