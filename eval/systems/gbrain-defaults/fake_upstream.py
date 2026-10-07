"""Keyless provider stand-in for the gbrain-defaults stack (stdlib only, dev and tests).

It extends the shared fake provider (eval/systems/_shim/fake_provider.py) with the three provider shapes gbrain's
shipped defaults call and the shared fake does not answer, so every gbrain stage runs end to end without a key:

  POST .../voyage/v1/embeddings  Voyage embeddings: `output_dimension` is honored (voyage-4 defaults to 1024).
  POST .../voyage/v1/rerank      Voyage rerank: word-overlap relevance scores, `top_k` honored.
  POST .../anthropic/v1/messages a forced tool call (`tool_choice: {type: tool}`) gets schema-valid tool input, so
                                 query expansion and structured synthesis parse; anything else gets a short answer.

Failure injection, for the degraded-read fixtures: `POST /_fail {"rerank": 503, "messages": 402}` makes those routes
answer with that status until `POST /_fail {}` clears them (FAKE_UPSTREAM_FAIL="rerank:503,messages:402" sets the
same table at start). Route names are the shared fake's (chat, responses, embeddings, messages) plus rerank.

The request log keeps the shared fake's format (route, model, whether the credential is the container's dummy, a body
hash), never a body or a credential. Its answers are canned; its scores say nothing about memory quality.

Run: python3 eval/systems/gbrain-defaults/fake_upstream.py [--port 8787] [--log fake-upstream.jsonl]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from http.server import ThreadingHTTPServer
from threading import Lock
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shim"))
import fake_provider as fp  # noqa: E402

VOYAGE_DIMS = {"voyage-4": 1024, "voyage-4-large": 1024, "voyage-4-lite": 1024, "voyage-3.5": 1024, "voyage-3-large": 1024}
FAIL: dict[str, int] = {}
FAIL_LOCK = Lock()
shared_embeddings = fp.embeddings


def embeddings(body: dict[str, Any]) -> dict[str, Any]:
    model = str(body.get("model", ""))
    if model not in VOYAGE_DIMS:
        return shared_embeddings(body)
    return shared_embeddings({**body, "dimensions": int(body.get("output_dimension") or VOYAGE_DIMS[model])})


def rerank(body: dict[str, Any]) -> dict[str, Any]:
    query = set(fp.words(str(body.get("query", ""))))
    docs = [str(d) for d in body.get("documents") or []]
    scored = sorted(((min(0.99, 0.05 + len(query & set(fp.words(d))) / max(1, len(query))), i) for i, d in enumerate(docs)), key=lambda x: (-x[0], x[1]))
    top = int(body.get("top_k") or len(docs))
    tokens = sum(len(d) // 4 + 1 for d in docs) + len(str(body.get("query", ""))) // 4
    return {"object": "list", "model": body.get("model"), "data": [{"index": i, "relevance_score": round(s, 4)} for s, i in scored[:top]],
            "usage": {"total_tokens": tokens}}


def structured(schema: dict[str, Any], prompt: str) -> Any:
    """A schema-valid instance; query-expansion schemas (a `queries` string list) get two keyword variants of the
    question so expansion visibly applies."""
    if "queries" in (schema.get("properties") or {}):
        question = next((ln for ln in reversed(prompt.splitlines()) if ln.strip()), prompt)
        terms = fp.words(question)[:8] or ["memory"]
        return {"queries": [" ".join(terms), " ".join(reversed(terms))]}
    return fp.SchemaFiller(schema, prompt).fill(schema)


def synthesis(system: str, prompt: str) -> str:
    """gbrain's synthesis engine expects {answer, citations, gaps}; cite the first page in the prompt."""
    slugs = re.findall(r'<page slug="([^"]+)"', prompt)
    return json.dumps({"answer": f"Based on the brain, see [1]." if slugs else "Nothing in the brain answers this.",
                       "citations": [{"page_slug": slugs[0], "row_num": None, "citation_index": 1}] if slugs else [], "gaps": []})


def messages(body: dict[str, Any]) -> dict[str, Any]:
    msgs = body.get("messages") or []
    prompt = "\n".join(fp.content_text(m.get("content")) for m in msgs)
    system = fp.content_text(body.get("system"))
    choice = body.get("tool_choice") or {}
    tools = body.get("tools") or []
    fmt = ((body.get("output_config") or {}).get("format") or body.get("output_format") or {})
    if choice.get("type") in ("tool", "any") and tools:
        tool = next((t for t in tools if t.get("name") == choice.get("name")), tools[0])
        schema = tool.get("input_schema") or {}
        content = [{"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:20]}", "name": tool.get("name"), "input": structured(schema, prompt)}]
        stop = "tool_use"
    elif fmt.get("type") == "json_schema":
        content, stop = [{"type": "text", "text": json.dumps(structured(fmt.get("schema") or {}, prompt))}], "end_turn"
    elif "synthesis engine" in system:
        content, stop = [{"type": "text", "text": synthesis(system, prompt)}], "end_turn"
    else:
        content, stop = [{"type": "text", "text": "ok"}], "end_turn"
    return {"id": f"msg_{uuid.uuid4().hex}", "type": "message", "role": "assistant", "model": body.get("model"), "stop_reason": stop, "stop_sequence": None,
            "content": content, "usage": {"input_tokens": max(1, len(prompt) // 4), "output_tokens": max(1, len(json.dumps(content)) // 4)}}


fp.ROUTES["/embeddings"] = ("embeddings", embeddings)
fp.ROUTES["/messages"] = ("messages", messages)
fp.ROUTES["/rerank"] = ("rerank", rerank)


def parse_fail(spec: str) -> dict[str, int]:
    return {k: int(v) for k, v in (p.split(":", 1) for p in spec.split(",") if ":" in p)}


def make_handler(log_path: str | None) -> type:
    base = fp.make_handler(log_path)

    class Handler(base):  # type: ignore[misc, valid-type]
        def do_POST(self) -> None:
            path = self.path.split("?")[0]
            if path == "/_fail":
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                with FAIL_LOCK:
                    FAIL.clear()
                    FAIL.update({str(k): int(v) for k, v in json.loads(raw or b"{}").items()})
                    return self._send(200, dict(FAIL))
            route = next((r for r in fp.ROUTES if path.endswith(r)), None)
            with FAIL_LOCK:
                status = FAIL.get(fp.ROUTES[route][0]) if route else None
            if status:
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                with fp.LOCK:
                    fp.STATS[f"failed:{fp.ROUTES[route][0]}"] += 1
                return self._send(status, {"error": {"type": "injected_failure", "message": f"fake upstream: {fp.ROUTES[route][0]} answers {status}"}})
            super().do_POST()

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("FAKE_PROVIDER_PORT", "8787")))
    ap.add_argument("--log", default=os.environ.get("FAKE_PROVIDER_LOG"))
    a = ap.parse_args()
    FAIL.update(parse_fail(os.environ.get("FAKE_UPSTREAM_FAIL", "")))
    ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(a.log)).serve_forever()


if __name__ == "__main__":
    main()
