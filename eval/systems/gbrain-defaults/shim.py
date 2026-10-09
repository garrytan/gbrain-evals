"""gbrain-defaults shim: gbrain's shipped defaults behind shim protocol v1 (eval/systems/PROTOCOL.md).

gbrain runs the way its documented agent install runs it: `bun install -g github:garrytan/gbrain#<sha>` in the image,
`gbrain init --pglite` with provider keys present (dummy keys here; the metering proxy injects the real ones), the
"defaults" answer to every first-run question, and `gbrain serve --surface starter` (the surface gbrain's own harness
registration pins) driven over MCP stdio. Every provider call leaves through `provider_base_urls`, which point at the
egress relay to the proxy before init runs its provider checks.

One brain per namespace, each a clean install at the same absolute path (GBRAIN_HOME). The stack's first install is
the reference: every later install must resolve to the same configuration (resolved models and search knobs, config
hash, starter tools/list), and every serve start checks the resolution again. Brains are moved, never copied, because
gbrain binds a brain's content checkout to its inode. Namespaces are driven one at a time (parallel_namespaces false):
activating another namespace stops serve, parks the active brain under /data/ns/<ns>, moves the requested one into
place and restarts serve.

Sessions are written with `put_page` as `type: conversation` pages under `conversations/<date>/<source id>` with a
deterministic request id (uuidv5 of namespace|source_id), so a replay returns gbrain's stored receipt. /finish is the
quiesce barrier: stop serve, run `gbrain doctor --json` with the brain to itself, require every expected page and
100% embedding coverage, then read gbrain's job queue (`gbrain jobs list --json`): pending jobs (a facts-absorb job can
be queued after its outbox effect completed, src/core/persistence/effect-facts.ts) are drained by a resident serve or
outlast the finish horizon, and whatever is left is recorded as `background_liabilities`; restart serve. /retrieve calls `query` (never with `token_budget`, which switches gbrain to
chunk delivery) and classifies the response meta; /answer is gbrain's own answer (`synthesize`, or `think` on the
full surface when GBRAIN_FULL_SURFACE=1).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shim"))
from shim import Adapter, ShimError, dispatch, serve  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("SHIM_DATA", "/data")
HOME = os.environ.get("GBRAIN_HOME", os.path.join(DATA, "home"))
REFERENCE = os.path.join(DATA, "reference.json")
SPARE = os.path.join(DATA, "spare")
NS_ROOT = os.path.join(DATA, "ns")
WORK = os.path.join(DATA, "work")
LOGS = os.path.join(DATA, "logs")
ACTIVE_MARK = os.path.join(DATA, "active-ns")
GBRAIN = os.environ.get("GBRAIN_BIN", "gbrain")
PROXY_BASE = os.environ.get("GBRAIN_PROXY_BASE", "").rstrip("/")
FULL_SURFACE = os.environ.get("GBRAIN_FULL_SURFACE", "0") == "1"
CALL_TIMEOUT_S = float(os.environ.get("GBRAIN_CALL_TIMEOUT_S", "900"))
WRITE_POLL_LIMIT_S = float(os.environ.get("GBRAIN_WRITE_POLL_S", "600"))
REQUEST_NS = uuid.UUID("6f1c3d4e-5a2b-4c8d-9e0f-1a2b3c4d5e6f")

# The ops this shim calls. Every one must appear in the starter surface's tools/list (checked at every install and
# at every serve start); `think` is called only on the labeled full surface.
STARTER_CALLS = ("put_page", "get_write_request", "list_write_requests", "query", "list_pages", "synthesize")
FULL_SURFACE_CALLS = ("think",)
PENDING_STATES = {"queued", "running", "recovering"}
# gbrain job states from which a job can still run (src/core/minions/types.ts MinionJobStatus).
PENDING_JOB_STATES = ("waiting", "delayed", "paused", "waiting-children", "active")
JOBS_LIST_LIMIT = 1000
# A resident stdio serve runs queued facts-absorb jobs from its own drain timer, which first ticks 10 minutes after
# start (src/core/facts/drain-scheduler.ts FACTS_DRAIN_TICK_MS), so each drain round keeps serve up a tick and a minute.
DRAIN_WAIT_S = float(os.environ.get("GBRAIN_DRAIN_WAIT_S", "660"))
# A round with only outbox effects pending (serve's persistence consumer dispatches them at start) is short.
OUTBOX_WAIT_S = 10.0
# Write-receipt effect states that still need serve's consumer (src/core/persistence/effect-model.ts; `dispatched`
# means a facts effect queued its job, which the job queue then shows).
PENDING_EFFECT_STATES = ("queued", "running")
FORBIDDEN_QUERY_KEYS = {"token_budget", "return_unit"}
QUERY_KNOBS = {"limit", "autocut", "expand"}
# Evidence-delivery fallbacks that are gbrain's shipped, content-driven behavior (preregistered): `redaction_unmapped`
# (the secret redactor changed a block's text, src/core/search/evidence-delivery.ts:925) and `no_text_chunks` (a page
# with no text chunks delivers its hit as a chunk, :609). They are recorded and counted per call, never a degraded read.
# Every other fallback (fetch_timeout, fetch_failed, row_limit, unsealed_page, anchor_not_located, page_missing, any
# unknown reason) stays a harness failure. GBRAIN_SHIPPED_FALLBACKS (comma-separated) overrides the set; the capability
# record shows the set in force beside the preregistered one.
PREREGISTERED_SHIPPED_BEHAVIOR = ("no_text_chunks", "redaction_unmapped")
SHIPPED_BEHAVIOR = frozenset(f.strip() for f in os.environ.get("GBRAIN_SHIPPED_FALLBACKS", ",".join(PREREGISTERED_SHIPPED_BEHAVIOR)).split(",") if f.strip())
ANCHOR_RE = re.compile(r"^\*\*(.+?)\*\*\s*\((\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\)\s*:\s*(.*)$")
DATE_HEADING_RE = re.compile(r"^#{1,6}\s*\d{4}-\d{2}-\d{2}\b")
SLUG_SAFE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def request_id(ns: str, source_id: str) -> str:
    return str(uuid.uuid5(REQUEST_NS, f"{ns}|{source_id}"))


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise ShimError("invalid_request", f"event_time is not ISO-8601: {value!r}", 400) from e
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def anchor_time(d: datetime) -> str:
    u = d.astimezone(timezone.utc)
    h = u.hour % 12 or 12
    return f"{u.date().isoformat()} {h}:{u.minute:02d} {'PM' if u.hour >= 12 else 'AM'}"


def speaker_label(turn: dict[str, Any]) -> str:
    raw = str(turn.get("speaker") or "").strip()
    cleaned = re.sub(r"[()\n:]", " ", raw.replace("*", "")).strip()
    return cleaned or ("User" if turn.get("role") == "user" else "Assistant")


def escape_body(text: str) -> str:
    return "\n".join(f"\\{ln}" if ANCHOR_RE.match(ln) or DATE_HEADING_RE.match(ln) else ln for ln in text.split("\n"))


def page_slug(source_id: str, when: datetime | None) -> str:
    sid = source_id.lower()
    opaque = sid if SLUG_SAFE.match(sid) else "src-" + sha256_text(source_id)[:16]
    return f"conversations/{when.astimezone(timezone.utc).date().isoformat() if when else 'undated'}/{opaque}"


def render_page(session: dict[str, Any]) -> tuple[str, str]:
    """A session as gbrain's transcript lane renders one: YAML frontmatter with type and date, then one
    `**Speaker** (YYYY-MM-DD h:mm AM): text` block per turn (the conversation parser's imessage-slack shape), with
    anchor-shaped body lines escaped. Turn text is never truncated."""
    when = parse_time(session.get("event_time"))
    slug = page_slug(session["source_id"], when)
    stamp = f" ({anchor_time(when)})" if when else ""
    blocks = []
    for t in session["turns"]:
        head, *rest = escape_body(str(t["content"])).split("\n")
        blocks.append("\n".join([f"**{speaker_label(t)}**{stamp}: {head}", *rest]))
    fm = ["---", "type: conversation"]
    if when:
        fm += [f"title: Conversation {anchor_time(when)}", f"date: {when.astimezone(timezone.utc).date().isoformat()}"]
    else:
        fm.append("title: Conversation")
    fm.append("---")
    return slug, "\n".join(fm) + "\n\n" + "\n\n".join(blocks) + "\n"


class GbrainError(Exception):
    def __init__(self, message: str, envelope: Any = None):
        super().__init__(message)
        self.envelope = envelope


class McpStdio:
    """Newline-delimited JSON-RPC to one `gbrain serve` process over its stdin/stdout."""

    def __init__(self, argv: list[str], env: dict[str, str], cwd: str, log_path: str):
        self.log = open(log_path, "ab")
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=env, cwd=cwd)
        self.next_id = 0
        self.lock = threading.Lock()
        self.pending: dict[int, Any] = {}
        self.cond = threading.Condition()
        self.closed = False
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and "id" in msg and ("result" in msg or "error" in msg):
                with self.cond:
                    self.pending[msg["id"]] = msg
                    self.cond.notify_all()
        with self.cond:
            self.closed = True
            self.cond.notify_all()

    def _send(self, msg: dict[str, Any], timeout_s: float = CALL_TIMEOUT_S) -> None:
        """Write one message, bounded: a serve that stops reading its input (its event loop busy) fills the pipe and
        would block the write forever, so a write that misses the deadline kills serve and fails as a timeout. The next
        call restarts serve on the same brain."""
        assert self.proc.stdin
        data = (json.dumps(msg) + "\n").encode()
        done = threading.Event()
        failed: list[BaseException] = []

        def write() -> None:
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except BaseException as e:  # noqa: BLE001 - re-raised in the caller's thread
                failed.append(e)
            finally:
                done.set()

        threading.Thread(target=write, daemon=True).start()
        if not done.wait(timeout_s):
            self.proc.kill()
            raise ShimError("timeout", f"gbrain serve stopped reading its input for {timeout_s:.0f}s; serve was killed and restarts on the next call")
        if failed:
            raise ShimError("product_error", f"gbrain serve input closed: {failed[0]}")

    def request(self, method: str, params: dict[str, Any], timeout_s: float = CALL_TIMEOUT_S) -> Any:
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            deadline = time.monotonic() + timeout_s
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, timeout_s)
        with self.cond:
            while rid not in self.pending:
                if self.closed:
                    raise ShimError("product_error", f"gbrain serve exited during {method} (exit {self.proc.poll()})")
                left = deadline - time.monotonic()
                if left <= 0:
                    raise ShimError("timeout", f"gbrain serve did not answer {method} within {timeout_s:.0f}s")
                self.cond.wait(left)
            msg = self.pending.pop(rid)
        if "error" in msg:
            raise ShimError("product_error", f"{method}: JSON-RPC error {msg['error']}")
        return msg["result"]

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        with self.lock:
            self._send({"jsonrpc": "2.0", "method": method, **({"params": params} if params else {})})

    def close(self, timeout_s: float = 30) -> None:
        try:
            if self.proc.stdin:
                try:
                    self.proc.stdin.close()
                except (OSError, ValueError):  # a killed serve's pipe is already broken
                    pass
            self.proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        finally:
            self.log.close()


def tool_payload(result: dict[str, Any]) -> tuple[Any, dict[str, Any], list[Any]]:
    """A tool result's body (content[0] parsed as JSON when it is JSON), its _meta, and its gbrain notices."""
    content = result.get("content") or []
    text = content[0].get("text", "") if content and isinstance(content[0], dict) else ""
    try:
        body: Any = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        body = text
    meta = result.get("_meta") or {}
    notices = meta.get("gbrain_notices") or []
    if result.get("isError"):
        raise GbrainError(f"gbrain returned an error: {text[:400]}", body)
    return body, meta, notices


def classify_query_meta(meta: dict[str, Any], resolved_search: dict[str, Any], shipped_behavior: frozenset[str] = SHIPPED_BEHAVIOR) -> dict[str, Any]:
    """Plan contract 4.8.4: a degraded stage, a missing rerank block in a reranked mode, an expansion that did not
    apply, an unavailable vector arm or a delivery fallback is a harness failure (retried after quiesce); a semantic
    cache hit and a shipped-behavior delivery fallback (SHIPPED_BEHAVIOR) are only recorded."""
    reasons: list[str] = []
    shipped: list[str] = []
    for d in meta.get("degraded") or []:
        reasons.append(f"degraded:{d.get('stage') if isinstance(d, dict) else d}")
    # The default reranker reports failure as a degraded stage (reranker_skipped, rerank_passthrough, rerank_failed);
    # its success shows as the confidence block's top_rerank_score. meta.rerank is System One's field, off by default.
    rows = meta.get("returned_count") or meta.get("retrieved_count") or 0
    crag = meta.get("crag")
    if resolved_search.get("reranker_enabled") is True and rows and isinstance(crag, dict) and "top_rerank_score" not in crag:
        reasons.append("rerank_missing")
    if resolved_search.get("expansion") is True and meta.get("expansion_applied") is False:
        reasons.append("expansion_not_applied")
    if meta.get("vector_enabled") is False:
        reasons.append("vector_disabled")
    readiness = meta.get("projection_readiness")
    if isinstance(readiness, dict) and readiness.get("status") not in (None, "ready"):
        reasons.append(f"projection:{readiness.get('status')}")
    delivery = meta.get("delivery") or {}
    for f in delivery.get("fallbacks") or []:
        (shipped if f in shipped_behavior else reasons).append(f"delivery_fallback:{f}")
    if delivery and delivery.get("requested_unit") != "auto":
        reasons.append(f"delivery_unit:{delivery.get('requested_unit')}")
    if meta.get("cache") == "hit":
        shipped.append("semantic_cache_hit")
    if meta.get("vector_pool_underfilled"):
        shipped.append("vector_pool_underfilled")
    for reason, n in (delivery.get("dropped_reasons") or {}).items():
        shipped.append(f"delivery_dropped:{reason}={n}")
    return {"outcome": "harness_invalid" if reasons else "scored", "reasons": reasons, "recorded": shipped}


def classify_synthesis(status: str | None, error_code: str | None) -> dict[str, Any]:
    """Own-answer classification (plan contract 4.8.4): ok is an answer; extractive_fallback is a product-degraded
    answer scored as given and counted in its own column; unavailable (the dummy-key or compose-failure path) is a
    harness failure."""
    if error_code is not None:
        return {"outcome": "harness_invalid", "synthesis_status": "unavailable", "degraded": None, "error_code": error_code}
    if status == "ok":
        return {"outcome": "scored", "synthesis_status": "ok", "degraded": None}
    if status == "extractive_fallback":
        return {"outcome": "scored", "synthesis_status": "extractive_fallback", "degraded": "extractive_fallback"}
    return {"outcome": "harness_invalid", "synthesis_status": status or "missing", "degraded": None}


def doctor_gate(report: dict[str, Any], expected_pages: int) -> dict[str, Any]:
    """The quiesce verdict from one `gbrain doctor --json` run with the brain to itself."""
    checks = {c.get("name"): c for c in report.get("checks") or [] if isinstance(c, dict)}
    conn = checks.get("connection") or {}
    reasons: list[str] = []
    if (conn.get("details") or {}).get("reason") == "live_serve":
        reasons.append("live_serve: doctor ran while a gbrain serve held the brain, so its database checks did not run")
    elif conn.get("status") != "ok":
        reasons.append(f"connection:{conn.get('status')}:{str(conn.get('message'))[:200]}")
    m = re.search(r"Connected, (\d+) pages", str(conn.get("message") or ""))
    pages = int(m.group(1)) if m else None
    if pages is not None and pages < expected_pages:
        reasons.append(f"pages:{pages}<{expected_pages}")
    emb = checks.get("embeddings") or {}
    em = re.search(r"(\d+)% coverage, (\d+) missing", str(emb.get("message") or ""))
    missing = int(em.group(2)) if em else None
    if expected_pages and (missing is None or missing > 0):
        reasons.append(f"embeddings:{str(emb.get('message') or 'absent')[:160]}")
    stale = checks.get("stale_embedding_effects") or {}
    if stale and stale.get("status") not in ("ok", None):
        reasons.append(f"stale_embedding_effects:{stale.get('status')}")
    failing = sorted(n for n, c in checks.items() if c.get("status") == "fail")
    background = {"facts_backlog": ((checks.get("facts_drain") or {}).get("details") or {}).get("backlog"),
                  "chronicle_pending_pages": ((checks.get("auto_chronicle") or {}).get("details") or {}).get("pending"),
                  "queue_waiting": ((checks.get("queue_health") or {}).get("details") or {}).get("depth")}
    return {"clean": not reasons and not failing, "background": background, "reasons": reasons, "failing_checks": failing, "pages": pages, "embeddings_missing": missing,
            "warnings": sorted(n for n, c in checks.items() if c.get("status") == "warn"), "status": report.get("status"), "health_score": report.get("health_score")}


def job_liabilities(jobs: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    """Pending gbrain jobs (any state a job can still run from) by kind, and the age of the oldest."""
    pending = [j for j in jobs if j.get("status") in PENDING_JOB_STATES]
    by_kind: dict[str, int] = {}
    for j in pending:
        by_kind[str(j.get("name"))] = by_kind.get(str(j.get("name")), 0) + 1
    ages = [(now - created).total_seconds() for j in pending if (created := parse_time(str(j.get("created_at") or "")))]
    return {"pending_jobs": dict(sorted(by_kind.items())), "oldest_pending_age_s": round(max(ages)) if ages else None}


class GbrainDefaultsAdapter(Adapter):
    def __init__(self) -> None:
        with open(os.path.join(HERE, "capability.json")) as f:
            self.record = json.load(f)
        for d in (DATA, NS_ROOT, WORK, LOGS):
            os.makedirs(d, exist_ok=True)
        self.lock = threading.RLock()
        self.active: str | None = self.read_active_mark()
        self.mcp: McpStdio | None = None
        self.serve_session: dict[str, Any] | None = None
        self.reference: dict[str, Any] | None = None
        self.reference_error: str | None = None
        self.called_ops: set[str] = set()
        self.shipped_counts: dict[str, int] = {}
        self.receipts = open(os.path.join(LOGS, "receipts.ndjson"), "a")
        threading.Thread(target=self._boot, daemon=True).start()

    @staticmethod
    def read_active_mark() -> str | None:
        """After a container restart the brain that was active is still at GBRAIN_HOME; the marker names it."""
        if os.path.isdir(HOME) and os.path.exists(ACTIVE_MARK):
            with open(ACTIVE_MARK) as f:
                return f.read().strip() or None
        shutil.rmtree(HOME, ignore_errors=True)
        return None

    def mark_active(self, ns: str | None) -> None:
        self.active = ns
        with open(ACTIVE_MARK + ".tmp", "w") as f:
            f.write(ns or "")
        os.replace(ACTIVE_MARK + ".tmp", ACTIVE_MARK)

    # ---- environment and subprocesses -------------------------------------------------------------------------

    def env(self) -> dict[str, str]:
        keep = {k: v for k, v in os.environ.items() if not k.startswith("SHIM_")}
        return {**keep, "GBRAIN_HOME": HOME, "HOME": HOME, "NO_COLOR": "1"}

    def cli(self, *args: str, timeout_s: float = 600, check: bool = True) -> subprocess.CompletedProcess:
        r = subprocess.run([GBRAIN, *args], env=self.env(), cwd=WORK, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout_s)
        with open(os.path.join(LOGS, "cli.log"), "a") as log:
            log.write(f"--- {now_iso()} gbrain {' '.join(args)} -> {r.returncode}\n{r.stderr}\n")
        if check and r.returncode != 0:
            raise ShimError("product_error", f"gbrain {' '.join(args)} exited {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
        return r

    def cli_json(self, *args: str, timeout_s: float = 600) -> Any:
        r = self.cli(*args, timeout_s=timeout_s, check=False)
        text = r.stdout.strip()
        try:
            return json.loads(text[text.index("{"):]) if "{" in text else json.loads(text)
        except (ValueError, json.JSONDecodeError) as e:
            raise ShimError("product_error", f"gbrain {' '.join(args)} printed no JSON (exit {r.returncode}): {(r.stderr or text)[-300:]}") from e

    def jobs(self) -> list[dict[str, Any]]:
        """Every job that can still run, with serve stopped: the newest JOBS_LIST_LIMIT jobs, or each pending state's
        full list when the queue holds more."""
        def listed(*args: str) -> list[dict[str, Any]]:
            r = self.cli("jobs", "list", "--json", *args, timeout_s=300, check=False)
            try:
                out = json.loads(r.stdout)
            except json.JSONDecodeError as e:
                raise ShimError("product_error", f"gbrain jobs list printed no JSON (exit {r.returncode}): {(r.stderr or r.stdout)[-300:]}") from e
            if not isinstance(out, list):
                raise ShimError("product_error", f"gbrain jobs list printed {type(out).__name__}, not a list")
            return out
        jobs = listed("--limit", str(JOBS_LIST_LIMIT))
        if len(jobs) < JOBS_LIST_LIMIT:
            return jobs
        return [j for state in PENDING_JOB_STATES for j in listed("--status", state, "--limit", "1000000")]

    def outbox_pending(self) -> dict[str, int]:
        """Write effects still in gbrain's outbox, by kind, through starter `list_write_requests` on the live serve.
        Receipts come newest first and the consumer claims effects in request order, so paging stops at the first page
        with none pending."""
        by_kind: dict[str, int] = {}
        before = None
        while True:
            body, _m, _n, _ms = self.call("list_write_requests", {"limit": 100, **({"before": before} if before else {})})
            body = body if isinstance(body, dict) else {}
            pending = [e for r in body.get("requests") or [] for e in r.get("effects") or [] if e.get("state") in PENDING_EFFECT_STATES]
            for e in pending:
                by_kind[str(e.get("kind"))] = by_kind.get(str(e.get("kind")), 0) + 1
            before = body.get("next")
            if not pending or not before:
                return dict(sorted(by_kind.items()))

    def receipt(self, kind: str, **fields: Any) -> None:
        self.receipts.write(json.dumps({"at": now_iso(), "kind": kind, "ns": self.active, **fields}) + "\n")
        self.receipts.flush()

    # ---- installs ---------------------------------------------------------------------------------------------

    def _boot(self) -> None:
        try:
            with self.lock:
                self.reference = self.ensure_reference()
        except Exception as e:  # health reports it; the stack never accepts a write without a verified install
            self.reference_error = f"{type(e).__name__}: {e}"
            print(f"gbrain-defaults: install failed: {self.reference_error}", file=sys.stderr, flush=True)

    def ensure_reference(self) -> dict[str, Any]:
        """The stack's first install is the reference every later install must resolve to. Its brain is kept as the
        spare the first namespace takes."""
        if os.path.exists(REFERENCE):
            with open(REFERENCE) as f:
                return json.load(f)
        self.park()
        meta = self.install_brain()
        with open(REFERENCE + ".tmp", "w") as f:
            json.dump(meta, f, indent=2)
        os.replace(REFERENCE + ".tmp", REFERENCE)
        os.replace(HOME, SPARE)
        return meta

    def install_brain(self) -> dict[str, Any]:
        """One clean install at GBRAIN_HOME, the documented way: provider_base_urls first, init --pglite, the setup
        migrations, the scripted defaults reply; then the resolved configuration, the starter tools/list and a doctor
        run with the brain to itself."""
        if not PROXY_BASE:
            raise ShimError("invalid_request", "GBRAIN_PROXY_BASE is unset; provider_base_urls must point at the metering proxy before init")
        shutil.rmtree(HOME, ignore_errors=True)
        os.makedirs(os.path.join(HOME, ".gbrain"))
        base_urls = {"voyage": f"{PROXY_BASE}/voyage/v1", "openai": f"{PROXY_BASE}/openai/v1", "anthropic": f"{PROXY_BASE}/anthropic"}
        with open(os.path.join(HOME, ".gbrain", "config.json"), "w") as f:
            json.dump({"provider_base_urls": base_urls}, f, indent=2)
        t0 = time.perf_counter()
        init = self.cli_json("init", "--pglite", "--json", timeout_s=900)
        if init.get("status") != "success":
            raise ShimError("product_error", f"gbrain init --pglite did not succeed: {canonical(init)[:400]}")
        migrations = self.cli("apply-migrations", "--yes", "--non-interactive", "--no-autopilot-install", timeout_s=900, check=False)
        answered = self.answer_first_run_defaults(init)
        resolved = self.resolve_config()
        tools = self.capture_tools(["--surface", "starter"])
        missing = [op for op in STARTER_CALLS if op not in tools]
        if missing:
            raise ShimError("product_error", f"the starter surface's tools/list lacks {missing}; the shim calls only starter ops")
        doctor = self.cli_json("doctor", "--json", timeout_s=900)
        meta = {
            "installed_at": now_iso(),
            "install_ms": round((time.perf_counter() - t0) * 1000),
            "gbrain_version": self.cli("--version").stdout.strip().splitlines()[-1],
            "provider_base_urls": base_urls,
            "init": {"status": init.get("status"), "engine": init.get("engine"), "embedding_check": init.get("embedding_check"), "pages": init.get("pages")},
            "apply_migrations_exit": migrations.returncode,
            "first_run_decisions": answered,
            "resolved": resolved,
            "resolved_sha256": sha256_text(canonical(resolved)),
            "config_sha256": self.config_sha256(),
            "starter_tools": sorted(tools),
            "starter_tools_sha256": sha256_text(canonical(sorted(tools))),
            "doctor": doctor_gate(doctor, 0),
        }
        os.makedirs(os.path.join(HOME, "shim"), exist_ok=True)
        with open(os.path.join(HOME, "shim", "install.json"), "w") as f:
            json.dump(meta, f, indent=2)
        with open(os.path.join(HOME, "shim", "state.json"), "w") as f:
            json.dump({"sessions": {}}, f)
        self.receipt("install", resolved_sha256=meta["resolved_sha256"], config_sha256=meta["config_sha256"], install_ms=meta["install_ms"])
        return meta

    def answer_first_run_defaults(self, init: dict[str, Any]) -> list[dict[str, Any]]:
        """The scripted "defaults" reply: for every first-run decision init reports, apply the default option's argv
        exactly as init printed it. A default without an argv (harness wiring: skip) changes nothing; the shim itself
        is the harness, registered the way gbrain's harness_wiring option says (`gbrain serve --surface starter`)."""
        out = []
        for notice in init.get("notices") or []:
            for d in notice.get("decisions") or [] if notice.get("code") == "first_run_decisions" else []:
                opt = next((o for o in d.get("options") or [] if o.get("id") == d.get("default")), None)
                argv = (opt or {}).get("argv")
                if argv:
                    self.cli(*argv[1:] if argv[0] == "gbrain" else argv)
                out.append({"id": d.get("id"), "default": d.get("default"), "applied_argv": argv or None})
        return out

    def config_sha256(self) -> str:
        """config.json without its install timestamp: two clean installs at the same GBRAIN_HOME hash equal."""
        with open(os.path.join(HOME, ".gbrain", "config.json")) as f:
            cfg = json.load(f)
        cfg.pop("protocol_installed_at", None)
        return sha256_text(canonical(cfg))

    def resolve_config(self) -> dict[str, Any]:
        with open(os.path.join(HOME, ".gbrain", "config.json")) as f:
            cfg = json.load(f)
        modes = self.cli_json("search", "modes", "--json")
        models = self.cli_json("models", "--json")
        return {
            "engine": cfg.get("engine"),
            "embedding_model": cfg.get("embedding_model"),
            "embedding_dimensions": cfg.get("embedding_dimensions"),
            "search_mode": modes.get("active_mode"),
            "search": {k: v.get("value") for k, v in sorted((modes.get("resolved") or {}).items()) if isinstance(v, dict)},
            "model_tiers": {k: v.get("resolved") for k, v in sorted((models.get("tiers") or {}).items())},
            "model_tasks": {t["key"]: t.get("resolved") for t in models.get("per_task") or []},
        }

    def capture_tools(self, surface_args: list[str]) -> list[str]:
        mcp = self.start_mcp(surface_args)
        try:
            return self.list_tools(mcp)
        finally:
            mcp.close()

    def require_reference(self) -> dict[str, Any]:
        if self.reference is None:
            raise ShimError("product_error", f"the reference install is not ready: {self.reference_error or 'still installing'}", 503)
        return self.reference

    def new_brain(self, target: str) -> None:
        """A fresh install for one namespace, verified against the reference (two clean installs must resolve
        identically). Brains are moved, never copied: gbrain binds a content checkout to its inode and birth time,
        so a copied brain refuses writes with recovery_required."""
        ref = self.require_reference()
        self.park()
        if os.path.isdir(SPARE):
            os.replace(SPARE, target)
            return
        meta = self.install_brain()
        drift = [k for k in ("resolved_sha256", "config_sha256", "starter_tools_sha256") if meta[k] != ref[k]]
        if drift:
            shutil.rmtree(HOME, ignore_errors=True)
            raise ShimError("product_error", f"a clean install resolved differently from the reference ({', '.join(drift)}); the cell is invalid (install or model-default drift)")
        os.replace(HOME, target)

    # ---- serve lifecycle --------------------------------------------------------------------------------------

    def start_mcp(self, surface_args: list[str]) -> McpStdio:
        mcp = McpStdio([GBRAIN, "serve", *surface_args], self.env(), WORK, os.path.join(LOGS, "serve.log"))
        try:
            mcp.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "gbrain-evals-shim", "version": "1"}}, timeout_s=300)
            mcp.notify("notifications/initialized")
        except Exception:
            mcp.close(5)
            raise
        return mcp

    @staticmethod
    def list_tools(mcp: McpStdio) -> list[str]:
        names, cursor = [], None
        while True:
            page = mcp.request("tools/list", {"cursor": cursor} if cursor else {})
            names += [t["name"] for t in page.get("tools") or []]
            cursor = page.get("nextCursor")
            if not cursor:
                return names

    def stop_serve(self) -> None:
        if self.mcp is not None:
            self.mcp.close()
            self.mcp = None
            self.serve_session = None

    def start_serve(self) -> None:
        """Serve the active brain. The resolved configuration is read again first (the models gbrain resolves at
        connect are fixed for the serve's lifetime), and a change from the reference invalidates the cell."""
        ref = self.require_reference()
        if sha256_text(canonical(self.resolve_config())) != ref["resolved_sha256"]:
            raise ShimError("product_error", "gbrain's resolved configuration changed from the reference install; the cell is invalid (install or model-default drift)")
        surface = ["--surface", "full" if FULL_SURFACE else "starter"]
        t0 = time.perf_counter()
        mcp = self.start_mcp(surface)
        tools = self.list_tools(mcp)
        needed = STARTER_CALLS + (FULL_SURFACE_CALLS if FULL_SURFACE else ())
        missing = [op for op in needed if op not in tools]
        if missing:
            mcp.close(5)
            raise ShimError("product_error", f"gbrain serve {' '.join(surface)} does not list {missing}")
        self.mcp = mcp
        self.serve_session = {"id": uuid.uuid4().hex[:12], "surface": surface[1], "started_at": now_iso(), "start_ms": round((time.perf_counter() - t0) * 1000, 1),
                              "tools_sha256": sha256_text(canonical(sorted(tools))), "resolved_sha256": ref["resolved_sha256"]}

    def ns_dir(self, ns: str) -> str:
        if not re.match(r"^[A-Za-z0-9_-]+$", ns):
            raise ShimError("invalid_request", f"namespace {ns!r} is not a safe directory name", 400)
        return os.path.join(NS_ROOT, ns)

    def park(self) -> None:
        """Stop serve and move the active brain back under /data/ns."""
        self.stop_serve()
        if self.active is not None and os.path.isdir(HOME):
            os.replace(HOME, self.ns_dir(self.active))
        self.mark_active(None)

    def place(self, ns: str) -> None:
        """Make `ns` the brain at GBRAIN_HOME with serve stopped. A namespace never reset gets a fresh install."""
        if self.active == ns:
            self.stop_serve()
            return
        target = self.ns_dir(ns)
        if not os.path.isdir(target):
            self.new_brain(target)
        self.park()
        os.replace(target, HOME)
        self.mark_active(ns)
        if self.config_sha256() != self.require_reference()["config_sha256"]:
            raise ShimError("product_error", f"namespace {ns}: config.json differs from the reference install's; the brain is invalid")

    def activate(self, ns: str) -> None:
        if self.active == ns and self.mcp is not None and self.mcp.proc.poll() is None:
            return
        self.place(ns)
        self.start_serve()

    def state(self) -> dict[str, Any]:
        with open(os.path.join(HOME, "shim", "state.json")) as f:
            return json.load(f)

    def save_state(self, st: dict[str, Any]) -> None:
        path = os.path.join(HOME, "shim", "state.json")
        with open(path + ".tmp", "w") as f:
            json.dump(st, f)
        os.replace(path + ".tmp", path)

    def call(self, name: str, args: dict[str, Any], timeout_s: float = CALL_TIMEOUT_S) -> tuple[Any, dict[str, Any], list[Any], float]:
        """One MCP tool call, timed inside the container (service_ms is this boundary, not gbrain's latency field)."""
        if "token_budget" in args:
            raise ShimError("invalid_request", "the shim never sends token_budget: it switches gbrain's query to chunk delivery", 400)
        assert self.mcp is not None
        self.called_ops.add(name)
        t0 = time.perf_counter()
        result = self.mcp.request("tools/call", {"name": name, "arguments": args}, timeout_s=timeout_s)
        ms = round((time.perf_counter() - t0) * 1000, 3)
        body, meta, notices = tool_payload(result)
        return body, meta, notices, ms

    # ---- protocol ---------------------------------------------------------------------------------------------

    def capabilities(self) -> dict[str, Any]:
        out = dict(self.record)
        out["answer"] = {"modes": ["synthesize", *(["think"] if FULL_SURFACE else [])]}
        out["shipped_behavior"] = {"delivery_fallbacks": sorted(SHIPPED_BEHAVIOR), "preregistered": list(PREREGISTERED_SHIPPED_BEHAVIOR),
                                   "configured_by": "GBRAIN_SHIPPED_FALLBACKS", "matches_preregistration": sorted(SHIPPED_BEHAVIOR) == sorted(PREREGISTERED_SHIPPED_BEHAVIOR)}
        if self.reference is not None:
            r = self.reference
            out["answer"]["models"] = {"synthesize": (r["resolved"].get("model_tasks") or {}).get("models.think")}
            out["resolved"] = {"gbrain_version": r["gbrain_version"], "resolved_sha256": r["resolved_sha256"], "config_sha256": r["config_sha256"],
                               "starter_tools_sha256": r["starter_tools_sha256"], "starter_tools": r["starter_tools"], "first_run_decisions": r["first_run_decisions"], **r["resolved"]}
        return out

    def health(self) -> dict[str, Any]:
        if self.reference is None:
            return {"ok": False, "reason": self.reference_error or "installing the reference brain"}
        return {"ok": True, "surface": "full" if FULL_SURFACE else "starter", "resolved_sha256": self.reference["resolved_sha256"], "active_ns": self.active,
                "called_ops": sorted(self.called_ops), "shipped_fallbacks": dict(sorted(self.shipped_counts.items()))}

    def stats(self) -> dict[str, Any]:
        """Engine footprint for the stress pilot: the serve process's resident memory (current and peak, from
        /proc) and the active brain's size on disk."""
        with self.lock:
            out: dict[str, Any] = {"active_ns": self.active, "serve_session": self.serve_session}
            if self.mcp is not None and self.mcp.proc.poll() is None:
                with open(f"/proc/{self.mcp.proc.pid}/status") as f:
                    fields = dict(ln.split(":", 1) for ln in f if ":" in ln)
                out["serve_rss_kb"] = int(fields.get("VmRSS", "0 kB").split()[0])
                out["serve_peak_rss_kb"] = int(fields.get("VmHWM", "0 kB").split()[0])
            if self.active is not None and os.path.isdir(HOME):
                out["brain_bytes"] = sum(os.path.getsize(os.path.join(d, n)) for d, _s, names in os.walk(HOME) for n in names if not os.path.islink(os.path.join(d, n)))
            return out

    def restart(self, ns: str) -> dict[str, Any]:
        """Stop and start serve on the namespace's brain; the time is the engine's restart cost."""
        with self.lock:
            self.place(ns)
            t0 = time.perf_counter()
            self.start_serve()
            return {"restart_ms": round((time.perf_counter() - t0) * 1000, 1), "serve_session": self.serve_session}

    def reset(self, ns: str) -> None:
        with self.lock:
            self.require_reference()
            if self.active == ns:
                self.stop_serve()
                shutil.rmtree(HOME, ignore_errors=True)
                self.mark_active(None)
            target = self.ns_dir(ns)
            shutil.rmtree(target, ignore_errors=True)
            self.new_brain(target)

    def ingest(self, ns: str, session: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.activate(ns)
            slug, content = render_page(session)
            sid = session["source_id"]
            rid = request_id(ns, sid)
            st = self.state()
            prior = st["sessions"].get(sid)
            input_sha = sha256_text(content)
            if prior and prior["input_sha256"] != input_sha:
                raise ShimError("invalid_request", f"{sid} was already written with different content; a conversation is never partly re-ingested", 409)
            receipt, ms = self.write_page(slug, content, rid)
            state = receipt.get("state")
            st["sessions"][sid] = {"slug": slug, "request_id": rid, "input_sha256": input_sha, "state": state, "replayed": bool(prior)}
            self.save_state(st)
            self.receipt("ingest", source_id=sid, slug=slug, request_id=rid, state=state, service_ms=ms, replay=bool(prior))
            if state != "committed":
                raise ShimError("product_error", f"put_page for {sid} ended {state}: {canonical(receipt)[:300]}; replay it with the same request id")
            return {"items_created": 1, "warnings": [], "errors": [], "completeness": "known", "request_id": rid, "write_state": state, "gbrain_ms": ms}

    def write_page(self, slug: str, content: str, rid: str) -> tuple[dict[str, Any], float]:
        """put_page, then poll get_write_request while the receipt is pending (queued, running, recovering)."""
        try:
            body, _meta, _n, ms = self.call("put_page", {"slug": slug, "content": content, "request_id": rid, "wait_ms": 30000})
        except GbrainError as e:
            env = e.envelope if isinstance(e.envelope, dict) else {}
            if (env.get("receipt") or {}).get("state") in PENDING_STATES or env.get("code") == "write_pending":
                body, ms = env.get("receipt") or {"request_id": rid, "state": "queued"}, 0.0
            else:
                raise ShimError("product_error", f"put_page {slug}: {e}") from e
        receipt = body.get("receipt", body) if isinstance(body, dict) else {}
        deadline = time.monotonic() + WRITE_POLL_LIMIT_S
        while receipt.get("state") in PENDING_STATES:
            if time.monotonic() > deadline:
                raise ShimError("timeout", f"write {rid} still {receipt.get('state')} after {WRITE_POLL_LIMIT_S:.0f}s")
            time.sleep(max(0.05, min(5.0, (receipt.get("retry_after_ms") or 250) / 1000)))
            receipt, _m, _n, poll_ms = self.call("get_write_request", {"request_id": rid})
            ms += poll_ms
        return receipt, ms

    def finish(self, ns: str, timeout_s: float) -> dict[str, Any]:
        """The quiesce barrier: stop serve, doctor with the brain to itself, require every expected page and 100%
        embedding coverage; while coverage is short, restart serve (its persistence consumer drains embedding effects)
        and look again, bounded by timeout_s. Then drain or horizon for gbrain's job queue: while any job can still run,
        keep serve up for a drain round and read the queue again, bounded by the same timeout_s. Write effects still in
        the outbox when the barrier began (read on the live serve first) count the same way, since dispatching one can
        queue a job. What is left is the realization's `background_liabilities`, recorded and never dropped. Finally
        restart serve and confirm every expected page through list_pages."""
        with self.lock:
            t0 = time.monotonic()
            self.activate(ns)
            read_errors: list[str] = []
            try:
                outbox = self.outbox_pending()
            except ShimError as e:
                outbox = {}
                read_errors.append(f"outbox: {str(e)[:300]}")
            self.place(ns)
            expected = {v["slug"]: sid for sid, v in self.state()["sessions"].items()}
            rounds = []
            while True:
                gate = doctor_gate(self.cli_json("doctor", "--json", timeout_s=900), len(expected))
                rounds.append(gate)
                live = any(r.startswith("live_serve") for r in gate["reasons"])
                if gate["clean"] or live or time.monotonic() - t0 > timeout_s:
                    break
                self.start_serve()
                time.sleep(min(10.0, max(1.0, timeout_s / 60)))
                self.stop_serve()
            liabilities: dict[str, Any] = {"pending_jobs": None, "oldest_pending_age_s": None}
            drain_rounds = 0
            if not live:
                try:
                    liabilities = job_liabilities(self.jobs(), datetime.now(timezone.utc))
                    while (liabilities["pending_jobs"] or outbox) and time.monotonic() - t0 < timeout_s:
                        self.start_serve()
                        time.sleep(max(1.0, min(DRAIN_WAIT_S if liabilities["pending_jobs"] else OUTBOX_WAIT_S, timeout_s - (time.monotonic() - t0))))
                        outbox = self.outbox_pending()
                        self.stop_serve()
                        drain_rounds += 1
                        liabilities = job_liabilities(self.jobs(), datetime.now(timezone.utc))
                except ShimError as e:
                    read_errors.append(str(e)[:300])
            liabilities = {**liabilities, **({"read_errors": read_errors} if read_errors else {}), "pending_effects": outbox, "drained": liabilities["pending_jobs"] == {} and not outbox, "drain_rounds": drain_rounds,
                           "doctor": gate.get("background")}
            self.start_serve()
            seen = self.listed_conversation_slugs()
            absent = sorted(s for s in expected if s not in seen)
            waited = round((time.monotonic() - t0) * 1000)
            ready = gate["clean"] and not absent
            self.receipt("finish", rounds=rounds, absent=absent[:20], ready=ready, waited_ms=waited, background_liabilities=liabilities)
            if any(r.startswith("live_serve") for r in gate["reasons"]):
                raise ShimError("product_error", "doctor ran under a live gbrain serve (details.reason live_serve); its database checks did not run, so the barrier cannot pass")
            return {"ready": ready, "waited_ms": waited, "completeness": "known" if ready else "degraded",
                    "doctor": gate, "doctor_rounds": len(rounds), "rounds": rounds, "absent_pages": len(absent), "expected_pages": len(expected),
                    "background_liabilities": liabilities}

    def listed_conversation_slugs(self) -> set[str]:
        seen: set[str] = set()
        offset = 0
        while True:
            rows, _m, _n, _ms = self.call("list_pages", {"type": "conversation", "limit": 100, "offset": offset, "sort": "slug"})
            rows = rows.get("pages", rows) if isinstance(rows, dict) else rows
            if not isinstance(rows, list) or not rows:
                return seen
            seen.update(str(r.get("slug")) for r in rows if isinstance(r, dict))
            if len(rows) < 100:
                return seen
            offset += len(rows)

    def query_args(self, question: str, policy: dict[str, Any]) -> dict[str, Any]:
        mode = policy.get("mode")
        if mode not in ("vendor-default", "fixed-evidence"):
            raise ShimError("invalid_request", "policy.mode must be vendor-default or fixed-evidence", 400)
        record = self.record["retrieval_policies"][mode]["settings"]
        settings = {**record, **(policy.get("settings") or {})}
        bad = sorted(set(settings) & FORBIDDEN_QUERY_KEYS)
        if bad:
            raise ShimError("invalid_request", f"policy settings {bad} are refused: token_budget switches gbrain's query to chunk delivery and the scoreboard measures shipped auto delivery", 400)
        unknown = sorted(set(settings) - QUERY_KNOBS - {"on_degraded"})
        if unknown:
            raise ShimError("invalid_request", f"unknown policy settings {unknown}; allowed: {sorted(QUERY_KNOBS)} and on_degraded", 400)
        return {"query": question, **{k: settings[k] for k in sorted(QUERY_KNOBS) if k in settings}}

    def retrieve(self, ns: str, question: str, query_time: str | None, policy: dict[str, Any]) -> dict[str, Any]:
        args = self.query_args(question, policy)
        on_degraded = (policy.get("settings") or {}).get("on_degraded", self.record["retrieval_policies"]["on_degraded"])
        with self.lock:
            self.activate(ns)
            sources = {v["slug"]: sid for sid, v in self.state()["sessions"].items()}
            rows, meta, notices, ms = self.call("query", args)
            retrieval = meta.get("retrieval") or {}
            verdict = classify_query_meta(retrieval, self.require_reference()["resolved"]["search"])
            for r in verdict["recorded"]:
                if r.startswith("delivery_fallback:"):
                    self.shipped_counts[r] = self.shipped_counts.get(r, 0) + 1
            items = []
            for rank, row in enumerate(rows if isinstance(rows, list) else [], start=1):
                slug = str(row.get("slug") or "")
                sid = sources.get(slug)
                items.append({
                    "id": f"{slug}#{row.get('chunk_id', rank)}",
                    "rank": rank,
                    "type": "episode" if row.get("type") == "conversation" and not (row.get("delivered") or {}).get("truncated") else "chunk",
                    "text": str(row.get("chunk_text") or ""),
                    "source_ids": [sid] if sid else [],
                    "valid_from": None, "valid_to": None,
                    "provenance_status": "exact" if sid else "unavailable",
                })
            raw = {"tool": "query", "args": args, "gbrain_ms": ms, "meta": retrieval, "notices": notices, "classification": verdict,
                   "serve_session": self.serve_session, "query_time": "not sent: query takes no as-of date", "rows": len(items)}
            self.receipt("retrieve", args=args, gbrain_ms=ms, classification=verdict, notices=len(notices), rows=len(items))
            if verdict["outcome"] != "scored" and on_degraded == "error":
                raise ShimError("invalid_request", f"degraded read (harness failure; retry after quiesce): {', '.join(verdict['reasons'])}", 503)
            return {"items": items, "applied_settings": args, "truncated": False, "raw": raw}

    def answer(self, ns: str, question: str, query_time: str | None, mode: str, model: str | None) -> dict[str, Any]:
        if mode not in ("synthesize", "think"):
            raise ShimError("invalid_request", "mode must be synthesize or think", 400)
        if mode == "think" and not FULL_SURFACE:
            raise ShimError("unsupported", "think is a full-surface op; start the stack with GBRAIN_FULL_SURFACE=1 for the labeled full-surface row", 501)
        args: dict[str, Any] = {"question": question}
        if mode == "think":
            if model:
                args["model"] = model
            when = parse_time(query_time)
            if when:
                args["reference_date"] = when.astimezone(timezone.utc).date().isoformat()
        with self.lock:
            self.activate(ns)
            sources = {v["slug"]: sid for sid, v in self.state()["sessions"].items()}
            try:
                body, meta, notices, ms = self.call(mode, args)
                error_code = None
            except GbrainError as e:
                env = e.envelope if isinstance(e.envelope, dict) else {}
                body, meta, notices, ms = env, {}, env.get("notices") or [], 0.0
                error_code = str(env.get("code") or env.get("error") or "error")
            body = body if isinstance(body, dict) else {"answer": str(body)}
            status = body.get("synthesis_status") or ("ok" if mode == "think" and body.get("answer") else None)
            verdict = classify_synthesis(status, error_code)
            slugs = [s if isinstance(s, str) else s.get("page_slug") for s in body.get("sources") or body.get("citations") or []]
            self.receipt("answer", mode=mode, gbrain_ms=ms, classification=verdict)
            cost = body.get("cost") if isinstance(body.get("cost"), dict) else {}
            usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
            return {"answer": str(body.get("answer") or ""), **verdict, "source_ids": sorted({sources[s] for s in slugs if s in sources}),
                    "model": cost.get("model") or body.get("modelUsed") or None,
                    "usage": {"input": int(cost.get("input_tokens") or usage.get("input_tokens") or 0), "output": int(cost.get("output_tokens") or usage.get("output_tokens") or 0)},
                    "usd": cost.get("usd_estimate"), "cost": body.get("cost"), "args": args, "gbrain_ms": ms, "notices": notices, "serve_session": self.serve_session,
                    "raw": {k: body.get(k) for k in ("gaps", "warnings", "pages_gathered", "takes_gathered", "sources", "error") if k in body}}

    def delete_source(self, ns: str, source_id: str) -> dict[str, Any]:
        return {"status": "unsupported", "receipt": {"why": "the starter surface has no page delete (delete_page is a full-surface op); the scoreboard reads only starter ops"}}


def extended_dispatch(adapter: GbrainDefaultsAdapter, method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Protocol v1 with its optional POST /answer {ns, question, query_time, mode, model} (gbrain's own answer), plus two
    gbrain-defaults routes: GET /stats (serve memory and brain size) and POST /restart {ns} (serve restart time)."""
    routes = {("POST", "/answer"), ("GET", "/stats"), ("POST", "/restart")}
    if (method, path) not in routes:
        return dispatch(adapter, method, path, body)
    start = time.perf_counter()
    try:
        if path == "/stats":
            out = adapter.stats()
        else:
            missing = [k for k in (("ns", "question") if path == "/answer" else ("ns",)) if k not in body]
            if missing:
                raise ShimError("invalid_request", f"missing fields: {', '.join(missing)}", 400)
            out = adapter.restart(body["ns"]) if path == "/restart" else \
                adapter.answer(body["ns"], body["question"], body.get("query_time"), body.get("mode", "synthesize"), body.get("model"))
        status = 200
    except ShimError as e:
        status, out = e.status, {"error": {"kind": e.kind, "message": str(e)}}
    except Exception as e:
        status, out = 500, {"error": {"kind": "product_error", "message": f"{type(e).__name__}: {e}"}}
    out["service_ms"] = round((time.perf_counter() - start) * 1000, 3)
    return status, out


if __name__ == "__main__":
    import shim as base

    adapter = GbrainDefaultsAdapter()
    base.dispatch = lambda a, m, p, b: extended_dispatch(adapter, m, p, b)  # type: ignore[assignment]
    serve(adapter)
