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

Facts lanes (opt-in, `extraction_model` set). gbrain's automatic extraction
never runs on these pages: the put_page backstop and its drain skip
`type: conversation` (not an eligible page type), and the conversation
extractor (`extract-conversation-facts`, the opt-in cycle phase) finds no
messages in `role: text` transcripts with its built-in parsers. So ingest
calls gbrain's explicit extraction op, `extract_facts`, once per window of
whole turns that fits its 8,000-character input (the windowing gbrain applies
to session-corpus files), with the document's date as `valid_from`, its
page id as `session_id` and `visibility: "world"` (stdio MCP is a remote
caller and sees world facts only). An identical repeated session is written
and extracted once. The calls return only after the facts are
written, so the extraction barrier is the last call returning; failed windows
are retried once and counted in the receipt.

`lane` picks retrieval: `raw` (default, the page query above, unchanged),
`facts` (facts only: the question's `saved_facts` from `query` followed by
`recall`'s facts, packed to `facts_tokens`) or `combined` (those facts, then
the page query with `token_budget`). `recall` ranks facts newest first and does
not rank them by the question; only `saved_facts` (at most five keyword
matches) depends on it.
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

# Bump when anything that changes what ingest writes changes (page rendering, slugs, template config, barrier).
# Cells with equal ingest inputs share one store keyed on this (eval/runner/harness-cell.ts storeIdentity).
INGEST_REVISION = "gbrain-ingest-1"
INGEST_KEYS = ("embedding_model", "embedding_dimensions", "gbrain_config", "remote_budget_max", "extraction_model", "extraction_window_chars",
               "page_split")

DEFAULTS = {
    "lane": "raw",
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
    "search_config": {},
    "max_open_units": 1,
    # The provider's own one-line date header from the timestamp manifest; off when gbrain renders its own (C1).
    "date_header": True,
    "extraction_model": None,
    "extraction_window_chars": 8000,
    "extraction_in_flight": 8,
    "facts_tokens": 2000,
    "facts_limit": 100,
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


_EXCHANGE_START = re.compile(r"(?=\[(?:[A-Za-z]+-\d{1,2}-\d{4} \| )?Turn (\d+)\] User:)")


def split_exchanges(doc: Document) -> list[Document]:
    """One page per exchange (a user turn and the replies before the next user turn), for transcripts that mark
    turns as `[Turn N] User:` (BEAM). Each page keeps the document's date; text before the first marker stays with
    the first page. A document without markers stays whole."""
    marks = list(_EXCHANGE_START.finditer(doc.content))
    if len(marks) < 2:
        return [doc]
    bounds = [0] + [m.start() for m in marks[1:]] + [len(doc.content)]
    return [Document(id=f"{doc.id}-t{m.group(1)}", content=doc.content[a:b].strip(), user_id=doc.user_id, timestamp=doc.timestamp)
            for m, a, b in zip(marks, bounds, bounds[1:]) if doc.content[a:b].strip()]


def _turns(doc: Document) -> list[tuple[str, str]] | None:
    turns = doc.messages
    if not turns and doc.content and doc.content.lstrip().startswith("["):
        try:
            parsed = json.loads(doc.content)
            if isinstance(parsed, list) and all(isinstance(t, dict) and "content" in t for t in parsed):
                turns = parsed
        except json.JSONDecodeError:
            turns = None
    if not turns:
        return None
    return [(str(t.get("role") or t.get("speaker") or "speaker"), str(t.get("content", ""))) for t in turns]


def extraction_windows(doc: Document, max_chars: int) -> list[str]:
    """The page body cut into windows of whole turns that fit the extractor's input.

    A turn longer than a window is split, and every continuation repeats its
    speaker label, so no text is read as another speaker's. Joined, the windows
    hold every turn line of `render_body(doc)`.
    """
    turns = _turns(doc)
    if turns is None:
        text = (doc.content or "").strip()
        return [text[i:i + max_chars] for i in range(0, len(text), max_chars)] if text else []
    windows: list[str] = []
    cur = ""
    for label, content in turns:
        line = f"{label}: {content}"
        if cur and len(cur) + 1 + len(line) <= max_chars:
            cur += "\n" + line
            continue
        if cur:
            windows.append(cur)
            cur = ""
        if len(line) <= max_chars:
            cur = line
            continue
        prefix = f"{label}: "
        step = max(1, max_chars - len(prefix))
        pieces = [prefix + content[i:i + step] for i in range(0, len(content), step)]
        windows.extend(pieces[:-1])
        cur = pieces[-1]
    if cur:
        windows.append(cur)
    return windows


def _iso(timestamp: str | None) -> str | None:
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?", timestamp or "")
    if not m:
        return None
    return f"{m.group(1)}T{m.group(2) or '00:00'}:00Z"


class _Unit:
    def __init__(self, unit: str, home: Path):
        self.unit = unit
        self.home = home
        self.child: McpChild | None = None
        self.receipt: dict = {}
        self.timestamps: dict[str, str | None] = {}
        self.search_applied = False
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
                    **({"facts.extraction_model": str(self.cfg["extraction_model"])} if self.cfg.get("extraction_model") else {}),
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
                if not u.search_applied:
                    self._apply_search_config(home)
                    u.search_applied = True
                t0 = time.perf_counter()
                u.child = McpChild([self.bun, self.cli, "serve"], env=self.env_for(home), cwd=home,
                                   stderr_path=home / "serve.stderr.log").start()
                u.receipt["child_start_s"] = round(time.perf_counter() - t0, 3)
                self._open.append(unit)
            return u

    def _apply_search_config(self, home: Path) -> None:
        """Set this cell's read-time `search_config` keys in the unit's brain before its child starts.

        Read-time keys are not ingest inputs, so cells with different values share a store. The unit remembers
        which keys a cell set; a later cell without them unsets them, so no cell inherits another's setting.
        """
        marker = home / "mpw-search-config.json"
        applied = json.loads(marker.read_text()) if marker.exists() else {}
        want = {k: str(v) for k, v in (self.cfg.get("search_config") or {}).items()}
        if applied == want:
            return
        for key in applied.keys() - want.keys():
            self._cli(home, "config", "unset", key)
        for key, value in want.items():
            if applied.get(key) != value:
                self._cli(home, "config", "set", key, value)
        marker.write_text(json.dumps(want, sort_keys=True))

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
        # A dataset can list one session twice in a history (LongMemEval haystacks do): an identical repeat is
        # written once; a repeat with different text gets its own slug so both stay retrievable.
        if self.cfg.get("page_split") == "exchanges":
            docs = [piece for d in docs for piece in split_exchanges(d)]
        elif self.cfg.get("page_split"):
            raise GbrainIngestError(f"unknown page_split {self.cfg['page_split']!r}: use exchanges or leave it unset")
        pages, seen, written = [], {}, []
        for d in docs:
            slug, body = SLUG_PREFIX + d.id.lower(), page_markdown(d)
            if slug in seen:
                if seen[slug] == body:
                    continue
                n = 2
                while f"{slug}-{n}" in seen:
                    n += 1
                slug = f"{slug}-{n}"
            seen[slug] = body
            u.timestamps[slug[len(SLUG_PREFIX):]] = d.timestamp
            pages.append({"slug": slug, "content": body})
            written.append((slug, d))
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
        if self.cfg.get("extraction_model"):
            u.receipt["facts"] = self._extract_facts(child, written)

    def _extract_facts(self, child: McpChild, written: list[tuple[str, Document]]) -> dict:
        """gbrain's `extract_facts` over every window of every written page; returns when every call has returned."""
        calls = []
        for slug, d in written:
            for text in extraction_windows(d, int(self.cfg["extraction_window_chars"])):
                args = {"turn_text": text, "session_id": slug[len(SLUG_PREFIX):], "source_slug": slug,
                        "visibility": "world", "request_id": str(uuid.uuid4())}
                if _iso(d.timestamp):
                    args["valid_from"] = _iso(d.timestamp)
                calls.append(args)
        t0 = time.perf_counter()
        totals = {"inserted": 0, "duplicate": 0, "superseded": 0}
        failures: dict[str, int] = {}
        todo = list(range(len(calls)))
        retried = 0
        for attempt in range(2):
            results = child.call_many([("extract_facts", calls[i]) for i in todo], int(self.cfg["extraction_in_flight"]))
            failed = []
            for i, r in zip(todo, results):
                if isinstance(r, Exception):
                    failed.append((i, "tool_error"))
                    continue
                body = r[0] if isinstance(r[0], dict) else {}
                if body.get("skipped") == "extraction_unavailable":
                    raise GbrainIngestError(f"gbrain extract_facts has no servable extraction model ({self.cfg['extraction_model']}): {json.dumps(body)[:500]}")
                if body.get("skipped"):
                    failed.append((i, str(body.get("reason") or body.get("skipped"))))
                    continue
                for k in totals:
                    totals[k] += int(body.get(k) or 0)
            if not failed:
                break
            if attempt == 0:
                retried = len(failed)
                todo = [i for i, _ in failed]
                for i in todo:
                    calls[i] = {**calls[i], "request_id": str(uuid.uuid4())}
                continue
            for _, reason in failed:
                failures[reason] = failures.get(reason, 0) + 1
        return {"extraction_model": self.cfg["extraction_model"], "op": "extract_facts", "windows": len(calls),
                "window_chars": int(self.cfg["extraction_window_chars"]), "window_text_chars": sum(len(c["turn_text"]) for c in calls),
                **totals, "retried_windows": retried, "failed_windows": sum(failures.values()), "failures": failures,
                "extract_s": round(time.perf_counter() - t0, 2)}

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
        lane = self.cfg.get("lane") or "raw"
        if lane == "raw":
            _u, docs, meta_out, _saved = self._query_pages(query, user_id)
            return docs, None, meta_out
        if lane not in ("facts", "combined"):
            raise GbrainRetrieveError(f"unknown lane {lane!r}: use raw, facts or combined")
        # One lock hold across both calls: another unit opening in between could close this unit's child.
        with self._lock:
            u, pages, page_meta, saved = self._query_pages(query, user_id, expand_default=False)
            try:
                recalled, _ = u.child.call("recall", {"limit": int(self.cfg["facts_limit"])})
            except McpToolError as e:
                raise GbrainRetrieveError(str(e)) from e
        if not isinstance(recalled, dict) or not isinstance(recalled.get("facts"), list):
            raise GbrainRetrieveError(f"recall returned {type(recalled).__name__} without a facts list")
        fact_docs, fact_meta = self._pack_facts(u, saved, recalled["facts"], int(self.cfg["facts_tokens"]), user_id)
        if lane == "facts":
            return fact_docs, None, {"lane": lane, "facts": fact_meta, "tokens_delivered": fact_meta["tokens"], "tokenizer": "cl100k",
                                     "budget_clamped": False, "pages": {"requested": page_meta["requested"], "used": "saved_facts only"}}
        return fact_docs + pages, None, {"lane": lane, "facts": fact_meta, "pages": page_meta, "tokenizer": "cl100k",
                                         "tokens_delivered": fact_meta["tokens"] + int(page_meta.get("tokens_delivered") or 0),
                                         "budget_clamped": bool(page_meta.get("budget_clamped"))}

    def _pack_facts(self, u: _Unit, saved: list, recalled: list, budget: int, user_id: str | None) -> tuple[list[Document], dict]:
        """Question-matched saved_facts first, then recall's newest facts, one line each, grouped under their source page."""
        from .context import count_tokens

        sessions = {str(f.get("id")): str(f.get("source_session") or "") for f in recalled if f.get("id") is not None}
        seen: set[str] = set()
        groups: dict[str, list[str]] = {}
        used, kept, dropped = 0, 0, 0
        for rows in (saved, recalled):
            for f in rows:
                text = str(f.get("fact") or "").strip()
                key = str(f.get("id") or text)
                if not text or key in seen:
                    continue
                seen.add(key)
                session = str(f.get("source_session") or sessions.get(key) or "")
                doc_id = session if session in u.timestamps else ""
                line = f"- {text}"
                cost = count_tokens(line + "\n")
                if used + cost > budget:
                    dropped += 1
                    continue
                used += cost
                kept += 1
                groups.setdefault(doc_id, []).append(line)
        docs = []
        for doc_id, lines in groups.items():
            header = date_header(u.timestamps.get(doc_id)) if doc_id else "Date: unknown"
            docs.append(Document(id=doc_id or "facts", content=f"{header}\nSaved facts:\n" + "\n".join(lines), user_id=user_id))
        return docs, {"budget": budget, "tokens": used, "kept": kept, "dropped": dropped, "saved_facts": len(saved),
                      "recalled": len(recalled), "documents": len(docs)}

    def _query_pages(self, query: str, user_id: str | None, expand_default: bool | None = None):
        # token_budget / return_unit / limit set to null in the cell config mean "gbrain's own default": the argument is omitted.
        args = {"query": query}
        for key in ("detail", "return_window"):
            if self.cfg.get(key) is not None:
                args[key] = self.cfg[key]
        for key in ("token_budget", "return_unit", "limit"):
            if self.cfg.get(key) is not None:
                args[key] = int(self.cfg[key]) if key != "return_unit" else self.cfg[key]
        # The facts lanes give gbrain a chat key, which turns on query expansion; the raw lane has none, so it never expands.
        expand = self.cfg.get("expand") if self.cfg.get("expand") is not None else expand_default
        if expand is not None:
            args["expand"] = bool(expand)
        # Open the unit and call it under one lock hold: another unit opening in between can close this unit's
        # child once `max_open_units` children are live.
        with self._lock:
            u = self._ensure_unit(user_id or "_all", create=False)
            try:
                rows, meta = u.child.call("query", args)
            except McpToolError as e:
                raise GbrainRetrieveError(str(e)) from e
        retrieval = (meta or {}).get("retrieval", {})
        delivery = retrieval.get("delivery", {})
        degraded = retrieval.get("degraded") or []
        # Degraded stages that leave the text query without semantic search fail the row. Others are kept in
        # the receipt: e.g. a query that mentions photos makes gbrain try an image-search arm, which fails without a
        # multimodal model while the text vector arm still serves the query (`vector_enabled` stays true).
        fatal = {"embed_unavailable", "embed_timeout", "keyword_only_no_embedding_provider"}
        if retrieval.get("vector_enabled") is False or any(d.get("stage") in fatal for d in degraded if isinstance(d, dict)):
            raise GbrainRetrieveError(f"gbrain reported degraded retrieval: {degraded}")
        if not isinstance(rows, list):
            raise GbrainRetrieveError(f"query returned {type(rows).__name__}, not a list of blocks")
        docs = []
        for row in rows:
            slug = str(row.get("slug", ""))
            doc_id = slug[len(SLUG_PREFIX):] if slug.startswith(SLUG_PREFIX) else slug
            text = row.get("chunk_text") or row.get("text") or ""
            if self.cfg.get("date_header", True):
                text = f"{date_header(u.timestamps.get(doc_id))}\n{text}"
            docs.append(Document(id=doc_id, content=text, user_id=user_id))
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
            "degraded": degraded,
            "entity_anchored": sum(1 for row in rows if isinstance(row, dict) and row.get("entity_anchored")),
        }
        if delivery.get("tokenizer") not in (None, "cl100k"):
            raise GbrainRetrieveError(f"gbrain packed evidence with tokenizer {delivery.get('tokenizer')!r}, not cl100k")
        return u, docs, meta_out, retrieval.get("saved_facts") or []

    def direct_answer(self, query: str, user_id: str | None = None, query_timestamp: str | None = None):
        args = {"question": query}
        if self.cfg.get("think_model"):
            args["model"] = self.cfg["think_model"]
        with self._lock:
            u = self._ensure_unit(user_id or "_all", create=False)
            result, meta = u.child.call("think", args)
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
