"""Keyless stand-in for the metering proxy's OpenAI route, for plumbing tests only (stdlib).

It answers /openai/v1/embeddings with deterministic hashed bag-of-words vectors and /openai/v1/chat/completions with a
scripted extract-first extraction: every line under "## New Messages" becomes one memory. Every request is appended to a JSONL
log (path, model, dimensions, a hash of the body), which proves a shim's SDK honors OPENAI_BASE_URL and which models
it asks for. Its outputs say nothing about memory quality.

Run: python3 fake_provider.py --port 8787 --log /tmp/fake-provider.jsonl
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORD = re.compile(r"[a-z0-9]+")
NATIVE_DIMS = {"text-embedding-3-small": 1536, "text-embedding-3-large": 3072}


def embed(text: str, dims: int) -> list[float]:
    v = [0.0] * dims
    for w in WORD.findall(text.lower()):
        h = int.from_bytes(hashlib.sha256(w.encode()).digest()[:8], "big")
        v[h % dims] += 1.0 if (h >> 63) else -1.0
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


def extraction(prompt: str) -> str:
    m = re.search(r"## New Messages\n(.*?)\n## ", prompt, re.S)
    body = m.group(1) if m else ""
    try:
        parsed = json.loads(body)
        lines = parsed.splitlines() if isinstance(parsed, str) else [str(x) for x in parsed]
    except json.JSONDecodeError:
        lines = body.splitlines()
    facts = [ln.split(": ", 1)[1] for ln in lines if ln.startswith(("user: ", "assistant: "))]
    return json.dumps({"memory": [{"id": str(i), "text": f} for i, f in enumerate(facts)]})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--log", default="fake-provider.jsonl")
    a = ap.parse_args()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            body = json.loads(raw or b"{}")
            path = self.path.split("?")[0]
            if path.endswith("/embeddings"):
                inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
                dims = int(body.get("dimensions") or NATIVE_DIMS.get(body.get("model"), 1536))
                out = {"object": "list", "model": body.get("model"),
                       "data": [{"object": "embedding", "index": i, "embedding": embed(str(t), dims)} for i, t in enumerate(inputs)],
                       "usage": {"prompt_tokens": 0, "total_tokens": 0}}
                note = {"inputs": len(inputs), "dimensions": body.get("dimensions"), "returned_dims": dims}
            elif path.endswith("/chat/completions"):
                prompt = str((body.get("messages") or [{}])[-1].get("content"))
                content = extraction(prompt)
                out = {"id": "fake", "object": "chat.completion", "created": int(time.time()), "model": body.get("model"),
                       "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
                       "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}
                note = {"facts": len(json.loads(content)["memory"])}
            else:
                self.send_response(404)
                self.end_headers()
                return
            with open(a.log, "a") as f:
                f.write(json.dumps({"path": path, "model": body.get("model"), "dummy_key": "dummy" in self.headers.get("Authorization", ""),
                                    "sha256": hashlib.sha256(raw).hexdigest()[:16], **note}) + "\n")
            data = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_: object) -> None:
            pass

    ThreadingHTTPServer(("0.0.0.0", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
