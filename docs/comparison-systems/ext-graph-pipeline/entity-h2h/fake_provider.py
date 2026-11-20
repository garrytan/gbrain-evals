"""Keyless fake provider for the entity-h2h stack: the pinned ../tests/fake_provider.py, plus the JSON-object request
cognee sends for gpt-6.2-sol (stdlib only).

cognee's litellm_native adapter asks for native structured output only when litellm.supports_response_schema(model)
is true. The image runs with LITELLM_LOCAL_MODEL_COST_MAP=True, and litellm's bundled model map has no gpt-6.2-sol,
so cognee takes its JSON fallback: response_format {"type": "json_object"} with the response model's JSON schema
written into the system prompt in a json code fence. The pinned fake answers a json_object request with "{}", which
cognee accepts as an empty graph, so no entity is ever extracted. This file fills that schema from the prompt the way
the pinned fake fills a json_schema request (capitalized words become entities); everything else is the pinned fake,
unchanged. Scores obtained with it say nothing about memory quality.

It also enforces OpenAI's embeddings limit of 2,048 inputs per request, answering a longer list with the 400 OpenAI
sends ("Invalid 'input': array length must be 2048 or less."), so a keyless run meets the failure the counted run met
in consolidate_entities (preregistration Amendment 5). GET /_stats counts those refusals as embeddings:over_limit.

Run: python3 fake_provider.py  (FAKE_PROVIDER_PORT, default 8787; request log at FAKE_PROVIDER_LOG)
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
from http.server import ThreadingHTTPServer
from typing import Any

spec = importlib.util.spec_from_file_location("pinned_fake_provider", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fake_provider.py"))
pinned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pinned)
pinned_chat = pinned.chat
SCHEMA_IN_PROMPT = re.compile(r"```json\n(.*?)\n```", re.S)


def chat(body: dict[str, Any]) -> dict[str, Any]:
    out = pinned_chat(body)
    if (body.get("response_format") or {}).get("type") != "json_object":
        return out
    system = "\n".join(pinned.content_text(m.get("content")) for m in body.get("messages", []) if m.get("role") == "system")
    found = SCHEMA_IN_PROMPT.search(system)
    if found:
        schema = json.loads(found.group(1))
        out["choices"][0]["message"]["content"] = json.dumps(pinned.SchemaFiller(schema, pinned.last_user_text(body)).fill(schema))
    return out


pinned.chat = chat

EMBEDDING_INPUT_LIMIT = 2048
pinned_post = pinned.Handler.do_POST


def do_post(self: Any) -> None:
    if self.path.endswith("/embeddings"):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        inputs = json.loads(raw or b"{}").get("input", [])
        if isinstance(inputs, list) and len(inputs) > EMBEDDING_INPUT_LIMIT:
            with pinned.LOCK:
                pinned.STATS["embeddings:over_limit"] += 1
            return self._send(400, {"error": {"message": f"Invalid 'input': array length must be {EMBEDDING_INPUT_LIMIT} or less.",
                                              "type": "invalid_request_error", "param": "input", "code": None}})
        self.rfile = io.BytesIO(raw)
    return pinned_post(self)


pinned.Handler.do_POST = do_post

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("FAKE_PROVIDER_PORT", "8787"))), pinned.Handler).serve_forever()
