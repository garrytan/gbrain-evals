"""gbrain as a harness memory provider, over stdio MCP, one hermetic brain per unit.

Process contract (the rules of eval/runner/hermetic-env.ts, applied to a child):
  - every unit gets an absolute GBRAIN_HOME and working directory under
    `<store>/gbrain/units/<unit>` and a HOME inside it, so the operator's real
    `~/.gbrain` is never read or written;
  - the child environment is built from nothing: PATH, the unit's homes, a few
    gbrain switches that turn off installs, banners and caches, and only the
    credentials the launcher declared for gbrain (metering-proxy tokens and
    base URLs in MPW_CHILD_ENV_GBRAIN). No TypeSafe key, so System One stays off;
  - `gbrain serve` runs in its own process group and is reaped after its unit,
    on cleanup, and on interruption or failure.

`prepare` builds one migrated, configured PGLite template brain per cell
(`init --db-only`, setup migrations, `search.return_budget_max_remote` raised
above the largest target so the remote 32k clamp cannot fire) and copies it
per unit. Units are created as their documents arrive, so PersonaMem (no
isolation unit in the harness) gets one brain per persona, and a retrieve for
a user with no brain is refused.

`ingest` writes one dated conversation page per document with an opaque slug,
through `put_pages` (50 per call, `wait_ms`) when the server has it, else
sequential `put_page`. A completion barrier then waits until every batch is
terminal, the page count is the expected one and no chunk lacks an embedding.

`retrieve` calls `query` with an explicit `token_budget` and
`return_unit: "page"`; each block starts with a one-line date header from the
timestamp manifest (`Date: unknown` when the dataset has no observed date).
"""
from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from memory_bench.memory.base import MemoryProvider
from memory_bench.models import Document

from .mcp_stdio import McpChild, McpToolError, stderr_tail

DEFAULTS = {
    "token_budget": 8000,
    "limit": 50,
    "return_unit": "page",
    "embedding_model": "voyage:voyage-4",
    "embedding_dimensions": 1024,
    "batch_size": 50,
    "wait_ms": 25000,
    "barrier_timeout_s": 900,
    "remote_budget_max": 200000,
    "expand": None,
    "gbrain_config": {},
    "max_open_units": 1,
}

SWITCHES = {
    "GBRAIN_NO_AUTOPILOT_INSTALL": "1",
    "GBRAIN_NO_BANNER": "1",
    "GBRAIN_NO_ONBOARD_NUDGE": "1",
    "GBRAIN_NO_SKILL_NAG": "1",
    "GBRAIN_NO_PROBE_PROMPT": "1",
    "GBRAIN_HEALTH_CACHE_TTL_MS": "0",
    "GBRAIN_INIT_SKIP_EMBED_CHECK": "1",
    "NO_COLOR": "1",
}

SLUG_PREFIX = "conversations/"


class GbrainIngestError(RuntimeError):
    pass


class GbrainRetrieveError(RuntimeError):
    pass


def render_body(doc: Document) -> str:
    """Transcript lines when the record has turns (structured or JSON content), else the content as is."""
    turns = doc.messages
    if not turns and doc.content and doc.content.lstrip().startswith("["):
        try:
            parsed = json.loads(doc.content)
            if isinstance(parsed, list) and all(isinstance(t, dict) and "content" in t for t in parsed):
                turns = parsed
        except json.JSONDecodeError:
            turns = None
    if turns:
        return "\n".join(f"{t.get('role') or t.get('speaker') or 'speaker'}: {t.get('content', '')}" for t in turns)
    return doc.content or ""


def date_header(timestamp: str | None) -> str:
    if not timestamp:
        return "Date: unknown"
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?", timestamp)
    if not m:
        return "Date: unknown"
    return f"Date: {m.group(1)}" + (f" {m.group(2)} UTC" if m.group(2) else "")


def page_markdown(doc: Document) -> str:
    fm = ["---", f"title: Conversation {doc.id}", "type: conversation"]
    if doc.timestamp:
        fm.append(f"date: {doc.timestamp[:10]}")
    fm.append("---")
    return "\n".join(fm) + "\n\n" + render_body(doc).strip() + "\n"


class _Unit:
    def __init__(self, unit: str, home: Path):
        self.unit = unit
        self.home = home
        self.child: McpChild | None = None
        self.receipt: dict = {}
        self.timestamps: dict[str, str | None] = {}
        meta = home / "mpw-unit.json"
        if meta.exists():
            self.timestamps = json.loads(meta.read_text()).get("timestamps", {})

    def save(self) -> None:
        (self.home / "mpw-unit.json").write_text(json.dumps({"unit": self.unit, "timestamps": self.timestamps}))


class GbrainMemoryProvider(MemoryProvider):
    name = "gbrain"
    description = "gbrain over stdio MCP: one hermetic PGLite brain per isolation unit, query with token_budget and return_unit=page"
    kind = "local"
    concurrency = 4

    def __init__(self, config: dict | None = None):
        cfg = dict(DEFAULTS)
        cfg.update(config if config is not None else json.loads(os.environ.get("MPW_PROVIDER_CONFIG") or "{}"))
        self.cfg = cfg
        self.cli = cfg.get("gbrain_cli") or os.environ.get("MPW_GBRAIN_CLI")
        if not self.cli:
            raise RuntimeError("no gbrain CLI: set provider_config.gbrain_cli or MPW_GBRAIN_CLI (the launcher resolves GBRAIN_UNDER_TEST)")
        self.bun = cfg.get("bun") or os.environ.get("MPW_BUN") or shutil.which("bun") or "bun"
        self.child_env = dict(cfg.get("child_env") or json.loads(os.environ.get("MPW_CHILD_ENV_GBRAIN") or "{}"))
        self.root: Path | None = None
        self.units: dict[str, _Unit] = {}
        self._open: list[str] = []
        self._lock = threading.RLock()
        self.version: dict = {}
        atexit.register(self.cleanup)

    # ── process contract ──────────────────────────────────────────────

    def env_for(self, home: Path) -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home / "home"),
            "GBRAIN_HOME": str(home),
            "TMPDIR": str(home / "tmp"),
            **SWITCHES,
        }
        for k, v in self.child_env.items():
            if k.startswith("GBRAIN_HOME") or k in ("HOME", "PATH"):
                continue
            env[k] = v
        (home / "home").mkdir(parents=True, exist_ok=True)
        (home / "tmp").mkdir(parents=True, exist_ok=True)
        return env

    def _cli(self, home: Path, *args: str, timeout: float = 300) -> str:
        proc = subprocess.run([self.bun, self.cli, *args], env=self.env_for(home), cwd=str(home),
                              capture_output=True, text=True, timeout=timeout, start_new_session=True)
        if proc.returncode != 0:
            raise RuntimeError(f"gbrain {' '.join(args[:2])} failed ({proc.returncode}): {(proc.stderr or proc.stdout)[-1500:]}")
        return proc.stdout

    def _rewrite_config(self, home: Path) -> None:
        path = home / ".gbrain" / "config.json"
        cfg = json.loads(path.read_text())
        cfg["database_path"] = str(home / ".gbrain" / "brain.pglite")
        cfg["self_upgrade"] = {**cfg.get("self_upgrade", {}), "mode": "off"}
        urls = {}
        if self.child_env.get("VOYAGE_BASE_URL"):
            urls["voyage"] = self.child_env["VOYAGE_BASE_URL"]
        if urls:
            cfg["provider_base_urls"] = {**cfg.get("provider_base_urls", {}), **urls}
        path.write_text(json.dumps(cfg, indent=2) + "\n")

    def _build_template(self, template: Path) -> None:
        if (template / "mpw-template.json").exists():
            self.version = json.loads((template / "mpw-template.json").read_text())["gbrain"]
            return
        shutil.rmtree(template, ignore_errors=True)
        template.mkdir(parents=True)
        t0 = time.perf_counter()
        self._cli(template, "init", "--pglite", "--db-only", "--non-interactive", "--json",
                  "--embedding-model", self.cfg["embedding_model"],
                  "--embedding-dimensions", str(self.cfg["embedding_dimensions"]), "--skip-embed-check")
        self._cli(template, "apply-migrations", "--yes", "--no-autopilot-install")
        self._rewrite_config(template)
        settings = {"search.return_budget_max_remote": str(self.cfg["remote_budget_max"]),
                    **{k: str(v) for k, v in (self.cfg.get("gbrain_config") or {}).items()}}
        for key, value in settings.items():
            self._cli(template, "config", "set", key, value)
        version = self._cli(template, "--version").strip()
        self.version = {"cli": self.cli, "version": version, "template_build_s": round(time.perf_counter() - t0, 2),
                        "config": settings}
        (template / "mpw-template.json").write_text(json.dumps({"gbrain": self.version}, indent=2))

    # ── harness hooks ─────────────────────────────────────────────────

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        self.root = Path(store_dir).resolve() / "gbrain"
        if reset:
            self.cleanup()
            shutil.rmtree(self.root / "units", ignore_errors=True)
        (self.root / "units").mkdir(parents=True, exist_ok=True)
        self._build_template(self.root / "_template")

    def _unit_home(self, unit: str) -> Path:
        assert self.root is not None, "prepare() was not called"
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", unit or "_all")
        return self.root / "units" / safe

    def _ensure_unit(self, unit: str, create: bool) -> _Unit:
        with self._lock:
            u = self.units.get(unit)
            home = self._unit_home(unit)
            if u is None:
                if not (home / ".gbrain").exists():
                    if not create:
                        raise GbrainRetrieveError(f"no gbrain brain for user {unit!r}: refusing to search another unit's memory")
                    t0 = time.perf_counter()
                    shutil.copytree(self.root / "_template", home, ignore=shutil.ignore_patterns("mpw-template.json", "home", "tmp"))
                    copy_s = time.perf_counter() - t0
                else:
                    copy_s = 0.0
                u = _Unit(unit, home)
                u.receipt["template_copy_s"] = round(copy_s, 3)
                self.units[unit] = u
            if u.child is None:
                while len(self._open) >= int(self.cfg["max_open_units"]):
                    self._close_unit(self._open[0])
                self._rewrite_config(home)
                t0 = time.perf_counter()
                u.child = McpChild([self.bun, self.cli, "serve"], env=self.env_for(home), cwd=home,
                                   stderr_path=home / "serve.stderr.log").start()
                u.receipt["child_start_s"] = round(time.perf_counter() - t0, 3)
                self._open.append(unit)
            return u

    def _close_unit(self, unit: str) -> None:
        u = self.units.get(unit)
        if u and u.child:
            u.child.close()
            u.child = None
        if unit in self._open:
            self._open.remove(unit)

    def reset_unit(self, unit: str) -> None:
        with self._lock:
            self._close_unit(unit)
            self.units.pop(unit, None)
            shutil.rmtree(self._unit_home(unit), ignore_errors=True)

    def cleanup(self) -> None:
        with self._lock:
            for unit in list(self._open):
                self._close_unit(unit)

    def child_pids(self) -> list[int]:
        return [u.child.pid for u in self.units.values() if u.child]

    def last_ingest_receipt(self, unit: str | None) -> dict:
        u = self.units.get(unit or "_all")
        return {**(u.receipt if u else {}), "gbrain": self.version}

    def ingest(self, documents: list[Document]) -> None:
        by_unit: dict[str, list[Document]] = {}
        for d in documents:
            by_unit.setdefault(d.user_id or "_all", []).append(d)
        for unit, docs in by_unit.items():
            self._ingest_unit(unit, docs)

    def _ingest_unit(self, unit: str, docs: list[Document]) -> None:
        u = self._ensure_unit(unit, create=True)
        child = u.child
        assert child is not None
        t0 = time.perf_counter()
        pages = [{"slug": SLUG_PREFIX + d.id.lower(), "content": page_markdown(d)} for d in docs]
        for d in docs:
            u.timestamps[d.id.lower()] = d.timestamp
        u.save()
        batched = "put_pages" in child.tools
        try:
            if batched:
                self._put_pages(child, pages)
            else:
                for p in pages:
                    child.call("put_page", {**p, "request_id": str(uuid.uuid4())})
        except McpToolError as e:
            raise GbrainIngestError(f"{e}; serve stderr: {stderr_tail(u.home / 'serve.stderr.log', 600)}") from e
        write_s = time.perf_counter() - t0
        b0 = time.perf_counter()
        barrier = self._barrier(child, expected_pages=len(pages))
        u.receipt.update({"write_path": "put_pages" if batched else "put_page", "pages": len(pages), "write_s": round(write_s, 3),
                          "barrier_ms": round((time.perf_counter() - b0) * 1000, 1), "barrier": barrier,
                          "server": child.server_info})

    def _put_pages(self, child: McpChild, pages: list[dict]) -> None:
        size = int(self.cfg["batch_size"])
        for i in range(0, len(pages), size):
            batch = pages[i:i + size]
            request_id = str(uuid.uuid4())
            args = {"pages": batch, "request_id": request_id, "wait_ms": int(self.cfg["wait_ms"])}
            deadline = time.monotonic() + float(self.cfg["barrier_timeout_s"])
            attempts = 0
            while True:
                try:
                    receipt, _ = child.call("put_pages", args)
                except McpToolError:
                    attempts += 1
                    if attempts > 3:
                        raise
                    time.sleep(2 * attempts)
                    continue
                state = receipt.get("state") if isinstance(receipt, dict) else None
                if state == "committed":
                    break
                if state in ("failed", "partial"):
                    raise GbrainIngestError(f"put_pages batch {request_id} ended {state}: {json.dumps(receipt.get('counts'))}")
                if time.monotonic() > deadline:
                    raise GbrainIngestError(f"put_pages batch {request_id} still {state} after the barrier timeout")
                time.sleep(max(0.2, (receipt.get("retry_after_ms") or 1000) / 1000))
                args = {"request_id": request_id, "wait_ms": int(self.cfg["wait_ms"])}

    def _barrier(self, child: McpChild, expected_pages: int) -> dict:
        """Wait until the brain holds the expected pages and no chunk lacks an embedding."""
        deadline = time.monotonic() + float(self.cfg["barrier_timeout_s"])
        polls = 0
        while True:
            polls += 1
            health, _ = child.call("get_health", {})
            stats, _ = child.call("get_stats", {})
            pages = int((stats or {}).get("page_count", (health or {}).get("page_count", -1)))
            missing = int((health or {}).get("missing_embeddings", 0) or 0)
            stale = int((health or {}).get("stale_pages", 0) or 0)
            if pages == expected_pages and missing == 0:
                return {"polls": polls, "pages": pages, "missing_embeddings": missing, "stale_pages": stale,
                        "embed_coverage": (health or {}).get("embed_coverage")}
            if time.monotonic() > deadline:
                raise GbrainIngestError(f"completion barrier timed out: {pages}/{expected_pages} pages, {missing} chunks without embeddings")
            time.sleep(min(5.0, 0.25 * polls))

    def retrieve(self, query: str, k: int = 10, user_id: str | None = None, query_timestamp: str | None = None):
        docs, raw, _meta = self.retrieve_with_meta(query, k, user_id, query_timestamp)
        return docs, raw

    def retrieve_with_meta(self, query: str, k: int = 10, user_id: str | None = None, query_timestamp: str | None = None):
        u = self._ensure_unit(user_id or "_all", create=False)
        args = {"query": query, "token_budget": int(self.cfg["token_budget"]), "return_unit": self.cfg["return_unit"],
                "limit": int(self.cfg["limit"])}
        if self.cfg.get("expand") is not None:
            args["expand"] = bool(self.cfg["expand"])
        with self._lock:
            child = u.child
            assert child is not None
            try:
                rows, meta = child.call("query", args)
            except McpToolError as e:
                raise GbrainRetrieveError(str(e)) from e
        retrieval = (meta or {}).get("retrieval", {})
        delivery = retrieval.get("delivery", {})
        degraded = retrieval.get("degraded") or []
        if degraded:
            raise GbrainRetrieveError(f"gbrain reported degraded retrieval: {degraded}")
        if not isinstance(rows, list):
            raise GbrainRetrieveError(f"query returned {type(rows).__name__}, not a list of blocks")
        docs = []
        for row in rows:
            slug = str(row.get("slug", ""))
            doc_id = slug[len(SLUG_PREFIX):] if slug.startswith(SLUG_PREFIX) else slug
            text = row.get("chunk_text") or row.get("text") or ""
            header = date_header(u.timestamps.get(doc_id))
            docs.append(Document(id=doc_id, content=f"{header}\n{text}", user_id=user_id))
        meta_out = {
            "requested": args,
            "tokens_delivered": delivery.get("tokens_delivered"),
            "tokenizer": delivery.get("tokenizer"),
            "applied_unit": delivery.get("applied_unit"),
            "blocks": delivery.get("blocks"),
            "dropped": delivery.get("dropped"),
            "fallbacks": delivery.get("fallbacks"),
            "budget_clamped": delivery.get("budget_clamped") or ("budget_clamped" in (delivery.get("fallbacks") or [])),
            "vector_enabled": retrieval.get("vector_enabled"),
            "expansion_applied": retrieval.get("expansion_applied"),
        }
        if delivery.get("tokenizer") not in (None, "cl100k"):
            raise GbrainRetrieveError(f"gbrain packed evidence with tokenizer {delivery.get('tokenizer')!r}, not cl100k")
        return docs, None, meta_out

    def direct_answer(self, query: str, user_id: str | None = None, query_timestamp: str | None = None):
        u = self._ensure_unit(user_id or "_all", create=False)
        args = {"question": query}
        if self.cfg.get("think_model"):
            args["model"] = self.cfg["think_model"]
        with self._lock:
            child = u.child
            assert child is not None
            result, meta = child.call("think", args)
        if not isinstance(result, dict):
            raise RuntimeError(f"think returned {type(result).__name__}")
        if result.get("synthesis_status") in ("no_llm", "model_unusable"):
            raise RuntimeError(f"gbrain think did not synthesize ({result.get('synthesis_status')})")
        citations = result.get("citations") or []
        context = json.dumps(citations, ensure_ascii=False)
        meta = {"model_used": result.get("modelUsed"), "usage": result.get("usage"), "pages_gathered": result.get("pagesGathered"),
                "takes_gathered": result.get("takesGathered"), "rounds": result.get("rounds"), "synthesis_status": result.get("synthesis_status"),
                "delivered_tokens_basis": "usage.input_tokens of gbrain think's synthesis call(s); the context field holds only its citations"}
        return str(result.get("answer", "")), context, meta
