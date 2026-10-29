"""Basic Memory 0.23.2 behind shim protocol v1 (eval/systems/PROTOCOL.md).

Ingestion follows Basic Memory's own LoCoMo benchmark (basicmachines-co/basic-memory, benchmarks/, tag v0.23.2):
one Markdown note per session in a project directory, `bm project add`, `bm reindex --search --embeddings -p`, then
`search_notes` (hybrid, JSON output) over a warm `bm mcp` stdio session. Basic Memory is AGPL-3.0; it runs unmodified
in this container and no vendor code is copied here. README.md lists every deviation from the vendor benchmark.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import Future
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shim"))
from shim import Adapter, Item, ShimError, serve  # noqa: E402

HERE = Path(__file__).resolve().parent
CONFIG = os.environ.get("SHIM_CONFIG", "recipe")
if CONFIG not in ("recipe", "common"):
    raise SystemExit(f"SHIM_CONFIG must be recipe or common, not {CONFIG!r}")
# Basic Memory writes env overrides into config.json, so each configuration keeps its own state; otherwise a recipe
# container on a volume a common run used would silently keep the common embedder.
DATA = Path(os.environ.get("SHIM_DATA_DIR", "/data")) / CONFIG
NOTES = DATA / "notes"
META = DATA / "meta"
NS_RE = re.compile(r"^ns-[A-Za-z0-9_-]{1,80}$")
SRC_RE = re.compile(r"^src-[A-Za-z0-9_-]{1,120}$")
EMBED_SUMMARY = re.compile(r"(\d+) entities embedded, (\d+) skipped, (\d+) errors")

COMMON_ENV = {
    "BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER": "litellm",
    "BASIC_MEMORY_SEMANTIC_EMBEDDING_MODEL": "openai/text-embedding-3-large",
    "BASIC_MEMORY_SEMANTIC_EMBEDDING_DIMENSIONS": "1536",
}


def bm_env() -> dict[str, str]:
    env = dict(os.environ, BASIC_MEMORY_CONFIG_DIR=str(DATA / "bm-config"))
    if CONFIG == "common":
        env.update(COMMON_ENV)
        env["BASIC_MEMORY_SEMANTIC_EMBEDDING_API_BASE"] = os.environ["OPENAI_BASE_URL"]
    return env


def render_date(event_time: str | None) -> str:
    """ISO-8601 to the LoCoMo-style phrase the vendor converter writes into each note ("1:56 pm on 8 May, 2023")."""
    if not event_time:
        return ""
    dt = datetime.fromisoformat(event_time.replace("Z", "+00:00"))
    return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'am' if dt.hour < 12 else 'pm'} on {dt.day} {dt:%B}, {dt.year}"


def render_note(session: dict[str, Any]) -> str:
    sid, date = session["source_id"], render_date(session["event_time"])
    lines = ["---", f"title: {sid} ({date})" if date else f"title: {sid}", "type: note", f"source_doc_id: {sid}"]
    if date:
        lines.append(f"session_date: {date}")
    lines += ["---", "", f"# Chat session at {date}" if date else f"# {sid}", "", "## Conversation"]
    for t in session["turns"]:
        text = str(t["content"]).strip()
        if text:
            lines.append(f"- **{t['speaker']}:** {text}")
    return "\n".join(lines).rstrip() + "\n"


class McpSession:
    """One warm `bm mcp` stdio session, owned by a coroutine on a private event loop; calls are serialized."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True, name="bm-mcp-loop").start()
        self.queue: asyncio.Queue | None = None
        self.ready = threading.Event()
        self.error: BaseException | None = None
        self.lock = threading.Lock()

    def start(self, timeout: float = 120.0) -> None:
        self.ready.clear()
        self.error = None
        asyncio.run_coroutine_threadsafe(self._own(), self.loop)
        if not self.ready.wait(timeout):
            raise ShimError("timeout", "bm mcp session did not start", 504)
        if self.error:
            raise ShimError("product_error", f"bm mcp failed to start: {self.error}")

    async def _own(self) -> None:
        from mcp.client.session import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        self.queue = asyncio.Queue()
        try:
            params = StdioServerParameters(command="bm", args=["mcp"], env=bm_env())
            async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
                await session.initialize()
                names = {t.name for t in (await session.list_tools()).tools}
                missing = {"search_notes", "delete_note"} - names
                if missing:
                    raise RuntimeError(f"bm mcp lacks tools {sorted(missing)}")
                self.ready.set()
                while True:
                    name, args, fut = await self.queue.get()
                    try:
                        fut.set_result(await session.call_tool(name, args))
                    except Exception as e:  # noqa: BLE001 - handed back to the caller
                        fut.set_exception(e)
        except BaseException as e:  # noqa: BLE001 - surfaced through start() or the next call
            self.error = e
            self.ready.set()

    def call(self, name: str, args: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
        with self.lock:
            if self.error is not None or not self.ready.is_set():
                self.start()
            fut: Future = Future()
            self.loop.call_soon_threadsafe(self.queue.put_nowait, (name, args, fut))
            try:
                result = fut.result(timeout)
            except TimeoutError:
                raise ShimError("timeout", f"bm mcp {name} timed out after {timeout}s", 504)
        text = "".join(getattr(c, "text", "") or "" for c in result.content)
        if result.is_error:
            raise ShimError("product_error", f"bm mcp {name}: {text[:500]}")
        structured = result.structured_content
        if isinstance(structured, dict):
            inner = structured.get("result")
            return inner if isinstance(inner, dict) else structured
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            raise ShimError("product_error", f"bm mcp {name} returned non-JSON: {text[:300]}")
        return parsed if isinstance(parsed, dict) else {"result": parsed}


class BasicMemoryAdapter(Adapter):
    def __init__(self) -> None:
        NOTES.mkdir(parents=True, exist_ok=True)
        META.mkdir(parents=True, exist_ok=True)
        self.record = json.loads((HERE / "capability.json").read_text())
        lock = HERE / "uv.lock"
        self.record["versions"]["lock_sha256"] = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else None
        self.record["versions"]["image"] = os.environ.get("SHIM_IMAGE") or None
        self.mcp = McpSession()
        self.ns_locks: dict[str, threading.Lock] = {}
        self.ns_guard = threading.Lock()
        self.bm_version = self.bm(["--version"], 60).stdout.strip()
        self.mcp.start()

    def bm(self, args: list[str], timeout: float, check: bool = True) -> subprocess.CompletedProcess:
        try:
            proc = subprocess.run(["bm", *args], capture_output=True, text=True, timeout=timeout, env=bm_env())
        except subprocess.TimeoutExpired:
            raise ShimError("timeout", f"bm {' '.join(args)} exceeded {timeout:.0f}s", 504)
        if check and proc.returncode != 0:
            raise ShimError("product_error", f"bm {' '.join(args)} exited {proc.returncode}: {(proc.stderr or proc.stdout)[-800:]}")
        return proc

    def lock_for(self, ns: str) -> threading.Lock:
        if not NS_RE.match(ns):
            raise ShimError("invalid_request", "ns must be opaque (ns-...)", 400)
        with self.ns_guard:
            return self.ns_locks.setdefault(ns, threading.Lock())

    def meta(self, ns: str) -> dict[str, Any]:
        path = META / f"{ns}.json"
        return json.loads(path.read_text()) if path.exists() else {"registered": False, "events": {}}

    def save_meta(self, ns: str, meta: dict[str, Any]) -> None:
        (META / f"{ns}.json").write_text(json.dumps(meta))

    def capabilities(self) -> dict[str, Any]:
        return self.record

    def health(self) -> dict[str, Any]:
        return {"ok": self.mcp.ready.is_set() and self.mcp.error is None, "config": CONFIG, "bm_version": self.bm_version}

    def reset(self, ns: str) -> None:
        with self.lock_for(ns):
            proc = self.bm(["project", "remove", ns, "--delete-notes", "--local"], 120, check=False)
            out = (proc.stdout + proc.stderr).lower()
            if proc.returncode != 0 and "not found" not in out:
                raise ShimError("product_error", f"bm project remove {ns}: {out[-500:]}")
            shutil.rmtree(NOTES / ns, ignore_errors=True)
            (NOTES / ns).mkdir(parents=True)
            self.save_meta(ns, {"registered": False, "events": {}})

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        sid = session["source_id"]
        if not SRC_RE.match(sid):
            raise ShimError("invalid_request", "source_id must be opaque (src-...)", 400)
        with self.lock_for(ns):
            (NOTES / ns).mkdir(parents=True, exist_ok=True)
            path = NOTES / ns / f"{sid}.md"
            warnings = [f"{sid} replaced an earlier note with the same source_id"] if path.exists() else []
            path.write_text(render_note(session), encoding="utf-8")
            meta = self.meta(ns)
            meta["events"][sid] = session["event_time"]
            self.save_meta(ns, meta)
        return {"items_created": 1, "warnings": warnings, "errors": [], "completeness": "known"}

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        start = time.monotonic()
        with self.lock_for(ns):
            meta = self.meta(ns)
            if not meta["registered"]:
                proc = self.bm(["project", "add", ns, str(NOTES / ns), "--local"], timeout_s, check=False)
                if proc.returncode != 0 and "already exists" not in (proc.stdout + proc.stderr).lower():
                    raise ShimError("product_error", f"bm project add {ns}: {(proc.stdout + proc.stderr)[-500:]}")
                meta["registered"] = True
                self.save_meta(ns, meta)
            left = max(1.0, timeout_s - (time.monotonic() - start))
            out = self.bm(["reindex", "--search", "--embeddings", "-p", ns], left)
            summary = EMBED_SUMMARY.search(" ".join((out.stdout + out.stderr).split()))
            left = max(1.0, timeout_s - (time.monotonic() - start))
            status = json.loads(self.bm(["status", "--project", ns, "--json", "--local"], left).stdout or "{}")
        on_disk = len(list((NOTES / ns).glob("*.md")))
        degraded = summary is None or int(summary.group(3)) > 0 or status.get("total_files") != on_disk
        return {
            "ready": True,
            "waited_ms": round((time.monotonic() - start) * 1000),
            "completeness": "degraded" if degraded else "known",
            "receipt": {
                "notes_on_disk": on_disk,
                "indexed_files": status.get("total_files"),
                "embedded": int(summary.group(1)) if summary else None,
                "embed_skipped": int(summary.group(2)) if summary else None,
                "embed_errors": int(summary.group(3)) if summary else None,
            },
        }

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        settings = policy.get("settings") or {}
        unknown = set(settings) - {"k"}
        if unknown:
            raise ShimError("invalid_request", f"unknown policy settings {sorted(unknown)}; this shim takes only k", 400)
        k = int(settings.get("k") or self.record["retrieval_policies"][mode]["settings"]["k"])
        self.lock_for(ns)
        meta = self.meta(ns)
        applied = {
            "tool": "search_notes", "search_type": "hybrid", "page_size": k, "reranker_enabled": False,
            "semantic_min_similarity": 0.55, "semantic_vector_k": 100,
            "query_time": "ignored: search_notes takes no reference date",
        }
        if not meta["registered"]:
            return {"items": [], "applied_settings": applied, "truncated": False}
        events = meta["events"]
        payload = self.mcp.call("search_notes", {
            "query": question, "project": ns, "page": 1, "page_size": k,
            "search_type": "hybrid", "output_format": "json",
        })
        rows = payload.get("results") or []
        items = []
        for row in rows:
            sid = Path(str(row.get("file_path") or row.get("permalink") or "")).name.removesuffix(".md")
            if sid not in events:
                raise ShimError("product_error", f"search_notes returned a note this namespace never ingested: {sid!r}")
            text = str(row.get("matched_chunk") or row.get("content") or "").strip()
            title = str(row.get("title") or "")
            if title and title not in text:
                text = f"{title}\n{text}"
            items.append(Item(id=str(row.get("permalink") or sid), rank=len(items) + 1, type="note", text=text,
                              source_ids=[sid], valid_from=events[sid], provenance_status="exact"))
        return {"items": items, "applied_settings": applied, "truncated": bool(payload.get("has_more")), "raw": payload}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        with self.lock_for(ns):
            meta = self.meta(ns)
            if source_id not in meta["events"]:
                return {"status": "partial", "receipt": {"reason": "source_id was never ingested in this namespace"}}
            out = self.mcp.call("delete_note", {"identifier": f"{ns}/{source_id}", "project": ns, "output_format": "json"})
            gone = not (NOTES / ns / f"{source_id}.md").exists()
        return {"status": "deleted" if out.get("deleted") and gone else "partial", "receipt": {"delete_note": out, "file_removed": gone}}


if __name__ == "__main__":
    serve(BasicMemoryAdapter())
