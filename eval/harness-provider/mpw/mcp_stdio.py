"""Minimal MCP client over a child process's stdio (newline-delimited JSON-RPC 2.0).

The child runs in its own process group so `close()` reaps it and anything it
started. A tool error (`isError` or a JSON-RPC error) raises `McpToolError`;
callers never see an empty result in place of a failure.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
from pathlib import Path


class McpToolError(RuntimeError):
    pass


class McpChild:
    def __init__(self, argv: list[str], env: dict[str, str], cwd: str | os.PathLike, stderr_path: str | os.PathLike,
                 timeout_s: float = 600.0):
        self.argv = argv
        self.timeout_s = timeout_s
        self._stderr = open(stderr_path, "ab")
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
                                     env=env, cwd=str(cwd), start_new_session=True)
        self._lock = threading.Lock()
        self._id = 0
        self.server_info: dict = {}
        self.tools: dict[str, dict] = {}

    @property
    def pid(self) -> int:
        return self.proc.pid

    def _send(self, msg: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None) -> dict:
        with self._lock:
            self._id += 1
            rid = self._id
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
            assert self.proc.stdout is not None
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    raise McpToolError(f"gbrain MCP child exited (code {self.proc.poll()}) during {method}")
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("id") == rid:
                    if "error" in msg:
                        raise McpToolError(f"{method}: {msg['error']}")
                    return msg.get("result") or {}

    def start(self) -> "McpChild":
        res = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "gbrain-evals-harness", "version": "1"}})
        self.server_info = res.get("serverInfo", {})
        with self._lock:
            self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.tools = {t["name"]: t for t in self.request("tools/list").get("tools", [])}
        return self

    def call(self, name: str, arguments: dict) -> tuple[object, dict]:
        """(parsed first text content, _meta). Raises on a tool error."""
        return _tool_result(name, self.request("tools/call", {"name": name, "arguments": arguments}))

    def call_many(self, calls: list[tuple[str, dict]], in_flight: int = 8) -> list:
        """Pipelined tool calls: up to `in_flight` requests outstanding at once, results in call order.

        Each result is a `(parsed, _meta)` tuple or the `McpToolError` that call raised; a child
        that exits mid-batch raises. Holds the request lock for the whole batch.
        """
        results: list = [None] * len(calls)
        pending: dict[int, int] = {}
        nxt = 0
        with self._lock:
            assert self.proc.stdout is not None
            while nxt < len(calls) or pending:
                while nxt < len(calls) and len(pending) < max(1, in_flight):
                    self._id += 1
                    name, arguments = calls[nxt]
                    self._send({"jsonrpc": "2.0", "id": self._id, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
                    pending[self._id] = nxt
                    nxt += 1
                line = self.proc.stdout.readline()
                if not line:
                    raise McpToolError(f"gbrain MCP child exited (code {self.proc.poll()}) during a batch of {len(calls)} calls")
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                i = pending.pop(msg.get("id"), None) if isinstance(msg.get("id"), int) else None
                if i is None:
                    continue
                name = calls[i][0]
                try:
                    if "error" in msg:
                        raise McpToolError(f"tools/call: {msg['error']}")
                    results[i] = _tool_result(name, msg.get("result") or {})
                except McpToolError as e:
                    results[i] = e
        return results

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait(timeout=10)
        else:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        for f in (self.proc.stdin, self.proc.stdout):
            try:
                f and f.close()
            except Exception:  # noqa: BLE001
                pass
        self._stderr.close()


def _tool_result(name: str, res: dict) -> tuple[object, dict]:
    texts = [c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"]
    if res.get("isError"):
        raise McpToolError(f"{name} failed: {' | '.join(texts)[:2000]}")
    first = texts[0] if texts else ""
    try:
        parsed = json.loads(first)
    except json.JSONDecodeError:
        parsed = first
    return parsed, res.get("_meta") or {}


def stderr_tail(path: str | os.PathLike, n: int = 2000) -> str:
    p = Path(path)
    return p.read_bytes()[-n:].decode(errors="replace") if p.exists() else ""
