"""Capture every model call a question makes.

`question_scope(tag)` binds a mutable capture to the current context. While
it is bound:
  - every httpx request (the Gemini, OpenAI, Groq and Anthropic SDKs all use
    httpx) carries an `x-mpw-tag` header, which the metering proxy records
    with the byte-exact request body and strips before forwarding;
  - `CapturingLLM` records each prompt and schema it is asked to generate
    for, and the parsed result.
`asyncio.to_thread` copies the context, so captures follow the harness's
own threading. The proxy log is joined to a question by tag afterwards.
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import itertools
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

TAG_HEADER = "x-mpw-tag"


@dataclass
class Capture:
    tag: str
    prompts: list[dict] = field(default_factory=list)
    counter: itertools.count = field(default_factory=itertools.count)
    forbidden: set[str] | None = None

    def next_tag(self) -> str:
        return f"{self.tag}#{next(self.counter)}"


_current: contextvars.ContextVar[Capture | None] = contextvars.ContextVar("mpw_capture", default=None)
_patched = False


def current() -> Capture | None:
    return _current.get()


@contextlib.contextmanager
def question_scope(tag: str):
    cap = Capture(tag=tag)
    token = _current.set(cap)
    try:
        yield cap
    finally:
        _current.reset(token)


def install_http_tagging() -> None:
    """Add the tag header to every httpx request made inside a question scope."""
    global _patched
    if _patched:
        return
    import httpx

    original_sync = httpx.Client.send
    original_async = httpx.AsyncClient.send

    def _tag(request):
        cap = _current.get()
        if cap is not None:
            request.headers[TAG_HEADER] = cap.next_tag()

    def send(self, request, *args, **kwargs):
        _tag(request)
        return original_sync(self, request, *args, **kwargs)

    async def asend(self, request, *args, **kwargs):
        _tag(request)
        return await original_async(self, request, *args, **kwargs)

    httpx.Client.send = send
    httpx.AsyncClient.send = asend
    _patched = True


class CapturingLLM:
    """Wraps a harness LLM; records each prompt it receives inside a question scope.

    `pre_dispatch(text)`, when set, runs on every prompt and every tool result
    before the model can see it (the cell runner's identifier leak check).
    """

    def __init__(self, inner, pre_dispatch=None):
        self._inner = inner
        self.pre_dispatch = pre_dispatch

    @property
    def model_id(self) -> str:
        return self._inner.model_id

    def generate(self, prompt: str, schema):
        cap = _current.get()
        entry = {"prompt": prompt, "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
                 "schema": {"properties": schema.properties, "required": schema.required}}
        if cap is not None:
            cap.prompts.append(entry)
        if self.pre_dispatch is not None:
            self.pre_dispatch(prompt)
        result = self._inner.generate(prompt, schema)
        entry["result"] = result
        return result

    def tool_loop(self, prompt, tools, max_tool_calls: int = 10):
        cap = _current.get()
        entry = {"tool_loop_prompt": prompt, "tool_calls": 0}
        if cap is not None:
            cap.prompts.append(entry)
        if self.pre_dispatch is not None:
            self.pre_dispatch(prompt)
        wrapped = []
        for t in tools:
            def fn(*args, _fn=t.fn, **kwargs):
                entry["tool_calls"] += 1
                out = _fn(*args, **kwargs)
                if self.pre_dispatch is not None:
                    self.pre_dispatch(out)
                return out
            wrapped.append(type(t)(name=t.name, description=t.description, parameters=t.parameters, required=t.required, fn=fn))
        return self._inner.tool_loop(prompt, wrapped, max_tool_calls)

    def __getattr__(self, name):
        if name == "_inner":
            raise AttributeError(name)
        return getattr(self._inner, name)


def proxy_requests(log_path: str | os.PathLike | None, tag_prefix: str, bodies_dir: str | os.PathLike | None,
                   wait_s: float = 10.0, expected: int | None = None) -> list[dict]:
    """Proxy log entries whose tag starts with `<tag_prefix>#`, with their exact bodies."""
    if not log_path:
        return []
    path = Path(log_path)
    deadline = time.monotonic() + wait_s
    while True:
        entries = []
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(row.get("tag", "")).startswith(tag_prefix + "#"):
                    entries.append(row)
        if expected is None or len(entries) >= expected or time.monotonic() > deadline:
            break
        time.sleep(0.2)
    out = []
    for row in entries:
        body = None
        sha = row.get("body_sha256")
        if bodies_dir and sha:
            bp = Path(bodies_dir) / f"{sha}.json"
            if bp.exists():
                body = json.loads(bp.read_text())
        out.append({**row, "body": body})
    return out
