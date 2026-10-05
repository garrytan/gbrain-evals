"""The comparator as a harness memory provider: pinned server, opaque ids.

`ComparatorMemoryProvider` wraps the harness's own HTTP provider for the
comparator (resolved through `names.comparator_variant('http')`) and points
it at the pinned current release, which it starts in `prepare()` and stops in
`cleanup()` (see `comparator_server`). It uses the comparator's best
supported recall mode: extracted facts plus the raw chunks they came from.

Opaque ids. Every id the provider emits, and every id-bearing field inside
`raw_response` (the LongMemEval, LoCoMo and LifeBench prompt builders paste
`json.dumps(raw_response)` into the prompt), is `c-<hex12>` =
HMAC-sha256(salt, original). Document ids and bank ids are hashed before they
reach the server, so the server only ever sees opaque ids; ids the server
mints (facts, chunks) are hashed on the way out, and any original id left in
a text field is replaced. `reverse_ids()` returns the map back to the
originals for the scorer only. The salt and the map are kept in the server's
data directory under the cell's store, so a resumed cell keeps its ids.

Config (constructor dict, else `MPW_PROVIDER_CONFIG` JSON):
  max_tokens         facts budget per recall (default: the harness's per-dataset value)
  max_chunk_tokens   raw-chunk budget per recall; 0 means facts only (default: per-dataset)
  budget             recall effort, "low" | "mid" | "high" (default "high", as the harness)
  extraction_model   "provider:model" for the server's LLM (default: its documented default)
  server_url         use an already running pinned server instead of starting one
  data_dir           server data and id state (default <store_dir>/comparator-server)
  id_salt            HMAC salt (default: generated once per data_dir)
  startup_timeout_s  server health deadline (default 600)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
import time
from pathlib import Path

from memory_bench.memory.base import MemoryProvider
from memory_bench.models import Document

from . import names

_ID_KEY = re.compile(r"^(id|.*_id)$")
_ID_LIST_KEY = re.compile(r"^.*_ids$")
_ID_KEYED_MAPS = ("chunks", "source_facts")
_MIN_SCRUB_LEN = 4


# Bump when anything that changes what ingest writes changes (retain payload, bank config, id hashing).
INGEST_REVISION = "comparator-ingest-1"
INGEST_KEYS = ("extraction_model", "id_salt")

class OpaqueIds:
    """HMAC-sha256 id hashing with a scorer-only reverse map."""

    def __init__(self, salt: str | bytes, known: dict[str, str] | None = None):
        self._salt = salt.encode() if isinstance(salt, str) else salt
        self._reverse: dict[str, str] = dict(known or {})
        self._forward: dict[str, str] = {v: k for k, v in self._reverse.items()}
        self._new: list[tuple[str, str]] = []
        self._lock = threading.Lock()

    def hash(self, original: str) -> str:
        with self._lock:
            if original in self._reverse:
                return original
            hashed = self._forward.get(original)
            if hashed is None:
                hashed = "c-" + hmac.new(self._salt, original.encode(), hashlib.sha256).hexdigest()[:12]
                if self._reverse.get(hashed, original) != original:
                    raise RuntimeError(f"opaque id collision on {hashed}")
                self._forward[original] = hashed
                self._reverse[hashed] = original
                self._new.append((hashed, original))
            return hashed

    def load(self, known: dict[str, str]) -> None:
        with self._lock:
            self._reverse.update(known)
            self._forward.update({v: k for k, v in known.items()})

    def reverse_ids(self) -> dict[str, str]:
        with self._lock:
            return dict(self._reverse)

    def take_new(self) -> list[tuple[str, str]]:
        with self._lock:
            new, self._new = self._new, []
            return new

    def scrub(self, payload, extra_originals: list[str] = ()):
        """A copy of `payload` with every id field hashed and no original id left in any string."""
        seen: set[str] = set(o for o in extra_originals if o)

        def ident(value: str) -> str:
            if value not in self._reverse:
                seen.add(value)
            return self.hash(value)

        def walk(node):
            if isinstance(node, dict):
                out = {}
                for k, v in node.items():
                    if k in _ID_KEYED_MAPS and isinstance(v, dict):
                        out[k] = {ident(ck): walk(cv) for ck, cv in v.items()}
                    elif isinstance(v, str) and _ID_KEY.match(k):
                        out[k] = ident(v)
                    elif isinstance(v, list) and _ID_LIST_KEY.match(k):
                        out[k] = [ident(x) if isinstance(x, str) else walk(x) for x in v]
                    else:
                        out[k] = walk(v)
                return out
            if isinstance(node, list):
                return [walk(x) for x in node]
            return node

        hashed = walk(payload)
        needles = sorted((o for o in seen if len(o) >= _MIN_SCRUB_LEN), key=len, reverse=True)
        if not needles:
            return hashed
        pattern = re.compile("|".join(re.escape(n) for n in needles))

        def replace(node):
            if isinstance(node, str):
                return pattern.sub(lambda m: self.hash(m.group(0)), node)
            if isinstance(node, dict):
                return {replace(k): replace(v) for k, v in node.items()}
            if isinstance(node, list):
                return [replace(x) for x in node]
            return node

        return replace(hashed)


def _http_provider_class():
    """The harness's HTTP provider for the comparator, with banks chosen by the wrapper
    and the time spent waiting for the server's extraction queue recorded."""
    from memory_bench.memory import REGISTRY

    base = REGISTRY[names.comparator_variant("http")]

    class PinnedHTTPProvider(base):
        bank_for = None
        drain_ms: dict = {}

        def _bank_id_for(self, user_id):
            return self.bank_for(user_id)

        async def _await_bank_ingest(self, client, bank_id):
            t0 = time.perf_counter()
            try:
                await super()._await_bank_ingest(client, bank_id)
            finally:
                self.drain_ms[bank_id] = self.drain_ms.get(bank_id, 0.0) + (time.perf_counter() - t0) * 1000

    return PinnedHTTPProvider


def _schema(spec: dict, node: dict) -> dict:
    while "$ref" in node:
        node = spec["components"]["schemas"][node["$ref"].rsplit("/", 1)[-1]]
    for option in node.get("anyOf", []):
        if "$ref" in option or option.get("type") == "object":
            return _schema(spec, option)
    return node


class ComparatorMemoryProvider(MemoryProvider):
    name = "comparator"
    description = "the extract-first memory server, pinned current release, facts plus raw chunks, opaque ids"
    kind = "local"

    def __init__(self, config: dict | None = None):
        if config is None:
            config = json.loads(os.environ.get("MPW_PROVIDER_CONFIG") or "{}")
        self.config = dict(config)
        self._ids: OpaqueIds | None = None
        self._ids_path: Path | None = None
        self._banks_path: Path | None = None
        self._ids_lock = threading.Lock()
        self._server = None
        self._server_url: str | None = self.config.get("server_url")
        self._inner = None
        self._banks: dict[str | None, str] = {}
        self._bank_docs: dict[str, list[str]] = {}
        self._created: set[str] = set()
        self._receipts: dict[str | None, dict] = {}
        self._schema_checked = False
        if self.config.get("id_salt"):
            self._ids = OpaqueIds(self.config["id_salt"])

    # ── ids ──────────────────────────────────────────────────────────────

    def _bank_id(self, user_id: str | None) -> str:
        return self._ids.hash(f"bank:{'' if user_id is None else user_id}")

    def reverse_ids(self) -> dict[str, str]:
        """Opaque id -> original id. For the scorer only; never put this in a prompt."""
        return self._ids.reverse_ids() if self._ids else {}

    def _load_ids(self, data_dir: Path) -> None:
        """Salt and reverse map live beside the server data, on the scorer side of the cell."""
        self._ids_path = data_dir / "reverse-ids.jsonl"
        self._banks_path = data_dir / "banks.json"
        known = {}
        if self._ids_path.exists():
            for line in self._ids_path.read_text().splitlines():
                hashed, original = json.loads(line)
                known[hashed] = original
        if self._ids is None:
            salt_path = data_dir / "id-salt"
            if not salt_path.exists():
                salt_path.write_text(secrets.token_hex(16) + "\n")
            self._ids = OpaqueIds(salt_path.read_text().strip(), known)
        else:
            self._ids.load(known)
        if self._banks_path.exists():
            for row in json.loads(self._banks_path.read_text()):
                self._banks[row["user_id"]] = row["bank"]
                self._bank_docs[row["bank"]] = row["docs"]
                self._created.add(row["bank"])
                self._receipts[row["user_id"]] = row["receipt"]

    def _persist_banks(self) -> None:
        rows = [{"user_id": u, "bank": b, "docs": self._bank_docs.get(b, []), "receipt": self._receipts.get(u, {})}
                for u, b in self._banks.items()]
        tmp = self._banks_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rows, indent=1))
        tmp.replace(self._banks_path)

    def _persist_ids(self) -> None:
        if self._ids_path is None:
            return
        with self._ids_lock:
            new = self._ids.take_new()
            if new:
                with self._ids_path.open("a") as f:
                    f.write("".join(json.dumps(pair) + "\n" for pair in new))

    # ── lifecycle ────────────────────────────────────────────────────────

    def _extraction_model(self) -> tuple[str, str | None]:
        spec = self.config.get("extraction_model")
        if not spec:
            return "openai", None
        provider, sep, model = str(spec).partition(":")
        if not sep:
            raise RuntimeError(f"extraction_model must be 'provider:model', got {spec!r}")
        return provider, model

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        data_dir = Path(self.config.get("data_dir") or Path(store_dir) / "comparator-server")
        data_dir.mkdir(parents=True, exist_ok=True)
        self._load_ids(data_dir)
        if self._server_url is None:
            from .comparator_server import ComparatorServer, upstream_from_env

            provider, model = self._extraction_model()
            self._server = ComparatorServer(
                data_dir=data_dir,
                upstream=upstream_from_env(provider=provider, model=model),
                startup_timeout_s=float(self.config.get("startup_timeout_s", 600)),
            ).start()
            self._server_url = self._server.url
        if self._inner is None:
            os.environ[names.comparator_env("HTTP_URL")] = self._server_url
            os.environ.setdefault(names.comparator_env("HTTP_KEY"), "")
            self._inner = _http_provider_class()()
            self._inner.bank_for = self._bank_id
            self._inner.drain_ms = {}
        self._inner.prepare(Path(store_dir), unit_ids, reset)
        self._inner._per_unit = True
        self._verify_recall_schema()

    def cleanup(self) -> None:
        if self._ids is not None:
            self._persist_ids()
        if self._server is not None:
            self._server.stop()
            self._server = None

    def receipt(self) -> dict:
        """Server identity, models and metering declaration for the cell receipt."""
        return self._server.describe() if self._server else {"url": self._server_url, "external": True}

    def _verify_recall_schema(self) -> None:
        """Fail unless the server accepts every recall field this wrapper sends."""
        if self._schema_checked:
            return
        import httpx

        for top in ("query", "budget", "max_tokens", "query_timestamp", "include"):
            self._inner._require_recall_field(top)
        spec = httpx.get(f"{self._server_url.rstrip('/')}/openapi.json", timeout=30).json()
        include = _schema(spec, spec["components"]["schemas"]["RecallRequest"]["properties"]["include"])
        for part in ("chunks", "entities"):
            if part not in include.get("properties", {}):
                raise RuntimeError(f"{self.name}: the server's recall `include` has no {part!r} option; the chunk budget would be ignored")
        chunk_opts = _schema(spec, include["properties"]["chunks"])
        if "max_tokens" not in chunk_opts.get("properties", {}):
            raise RuntimeError(f"{self.name}: the server's recall `include.chunks` has no max_tokens; the chunk budget would be ignored")
        self._schema_checked = True

    # ── ingest ───────────────────────────────────────────────────────────

    def reset_unit(self, unit: str | None) -> None:
        """Drop a unit's bank so its next ingest starts empty (resume without a receipt)."""
        import httpx

        bank = self._bank_id(unit)
        r = httpx.delete(f"{self._server_url.rstrip('/')}/v1/default/banks/{bank}", timeout=120)
        if r.status_code not in (200, 202, 204, 404):
            raise RuntimeError(f"{self.name}: deleting bank {bank} failed with HTTP {r.status_code}: {r.text[:300]}")
        self._created.discard(bank)
        self._bank_docs.pop(bank, None)
        self._receipts.pop(unit, None)
        self._banks.pop(unit, None)
        if self._banks_path is not None:
            self._persist_banks()

    def ingest(self, documents: list[Document]) -> None:
        if self._inner is None:
            raise RuntimeError(f"{self.name}: prepare() must run before ingest()")
        import httpx

        by_bank: dict[str, list[Document]] = {}
        units: dict[str, str | None] = {}
        for doc in documents:
            bank = self._bank_id(doc.user_id)
            units[bank] = doc.user_id
            context = self._ids.scrub(doc.context, extra_originals=[doc.id, doc.user_id or ""]) if doc.context else doc.context
            hashed = Document(
                id=self._ids.hash(doc.id), content=doc.content, user_id=doc.user_id,
                timestamp=doc.timestamp, context=context, tags=doc.tags,
            )
            by_bank.setdefault(bank, []).append(hashed)
        defaults = self._server.install.defaults if self._server else {}
        chunk_chars = defaults.get("retain_chunk_size")
        for bank, docs in by_bank.items():
            t0 = time.perf_counter()
            self._inner.drain_ms.pop(bank, None)
            self._inner._resume = bank in self._created
            try:
                self._inner.ingest(docs)
            finally:
                self._inner._resume = False
            self._created.add(bank)
            known = self._bank_docs.setdefault(bank, [])
            known.extend(d for d in (self._ids.reverse_ids()[h.id] for h in docs) if d not in known)
            stats = httpx.get(f"{self._server_url.rstrip('/')}/v1/default/banks/{bank}/stats", timeout=60)
            stats.raise_for_status()
            s = stats.json()
            if s["pending_operations"] or s["failed_operations"] or s["total_documents"] != len(known):
                raise RuntimeError(
                    f"{self.name}: bank {bank} is not complete after ingest: {s['pending_operations']} pending, "
                    f"{s['failed_operations']} failed operations, {s['total_documents']} of {len(known)} documents stored"
                )
            user = units[bank]
            self._banks[user] = bank
            self._receipts[user] = {
                "bank": bank,
                "documents": len(known),
                "facts": s["total_nodes"],
                "ingest_ms": round((time.perf_counter() - t0) * 1000, 1),
                "barrier_ms": round(self._inner.drain_ms.get(bank, 0.0), 1),
                "extraction_calls_expected": sum(math.ceil(len(d.content) / chunk_chars) for d in docs) if chunk_chars else None,
                "extraction_calls_rule": f"one LLM call per {chunk_chars}-character retain chunk of each document" if chunk_chars else None,
                "bank_config": self._inner._bank_kwargs(bank),
                "server": self.receipt(),
            }
            if self._banks_path is not None:
                self._persist_banks()
        self._persist_ids()

    def last_ingest_receipt(self, unit: str | None) -> dict:
        return dict(self._receipts.get(unit) or {})

    # ── retrieve ─────────────────────────────────────────────────────────

    def _recall_body(self, query: str, user_id: str | None, query_timestamp: str | None) -> tuple[str, dict, dict]:
        if user_id not in self._banks:
            raise RuntimeError(f"{self.name}: no bank for user_id {user_id!r}; it was never ingested in this cell")
        bank = self._banks[user_id]
        defaults = self._inner._recall_kwargs(query, user_id, query_timestamp)
        max_tokens = int(self.config.get("max_tokens", defaults["max_tokens"]))
        max_chunk_tokens = int(self.config.get("max_chunk_tokens", defaults.get("max_chunk_tokens", 0)))
        include_chunks = max_chunk_tokens > 0
        body = {
            "query": defaults["query"],
            "budget": self.config.get("budget", defaults["budget"]),
            "max_tokens": max_tokens,
            "include": {"entities": None, "chunks": {"max_tokens": max_chunk_tokens} if include_chunks else None},
        }
        if query_timestamp:
            body["query_timestamp"] = query_timestamp
        knobs = {"max_tokens": max_tokens, "max_chunk_tokens": max_chunk_tokens, "include_chunks": include_chunks,
                 "budget": body["budget"], "query_truncated": len(query) > len(defaults["query"])}
        return bank, body, knobs

    def retrieve_with_meta(self, query, k=10, user_id=None, query_timestamp=None):
        import httpx

        bank, body, knobs = self._recall_body(query, user_id, query_timestamp)
        r = httpx.post(f"{self._server_url.rstrip('/')}/v1/default/banks/{bank}/memories/recall", json=body, timeout=300)
        if r.status_code != 200:
            raise RuntimeError(f"{self.name}: recall failed with HTTP {r.status_code}: {r.text[:500]}")
        raw = self._ids.scrub(r.json(), extra_originals=[*self._bank_docs.get(bank, []), "" if user_id is None else user_id])
        self._persist_ids()
        docs = self._build_docs(raw)
        chunks = raw.get("chunks") or {}
        meta = {
            **knobs,
            "facts": len(raw.get("results") or []),
            "chunks": len(chunks),
            "chunks_truncated": sum(1 for c in chunks.values() if c.get("truncated")),
            "documents": len(docs),
            "raw_json_chars": len(json.dumps(raw)),
            "bank": bank,
        }
        return docs, raw, meta

    def retrieve(self, query, k=10, user_id=None, query_timestamp=None):
        docs, raw, _meta = self.retrieve_with_meta(query, k, user_id, query_timestamp)
        return docs, raw

    # ── agent mode ───────────────────────────────────────────────────────

    def _reflect_route(self) -> tuple[str, set[str]]:
        """The server's reflect path template and the request fields it accepts (from its OpenAPI)."""
        if getattr(self, "_reflect", None) is None:
            import httpx

            spec = httpx.get(f"{self._server_url.rstrip('/')}/openapi.json", timeout=30).json()
            path = next((p for p in spec["paths"] if p.endswith("/reflect") and "{bank_id}" in p), None)
            if path is None:
                raise RuntimeError(f"{self.name}: the server exposes no reflect operation; agent mode is unsupported")
            body = spec["paths"][path]["post"]["requestBody"]["content"]["application/json"]["schema"]
            fields = set(_schema(spec, body).get("properties", {}))
            self._reflect = (path, fields)
        return self._reflect

    async def async_direct_answer(self, query, user_id=None, query_timestamp=None):
        """The server's own synthesis (reflect) over this user's bank, with every id in the reply made opaque.

        Called over HTTP: the harness's pinned client rejects `query_timestamp`,
        which the current server accepts. The question date is sent whenever the
        server's schema has the field, and the receipt says whether it was.
        """
        import httpx

        if user_id not in self._banks:
            raise RuntimeError(f"{self.name}: no bank for user_id {user_id!r}; it was never ingested in this cell")
        bank = self._banks[user_id]
        path, fields = self._reflect_route()
        body = {"query": query[:1900]}
        sent_timestamp = bool(query_timestamp) and "query_timestamp" in fields
        if sent_timestamp:
            body["query_timestamp"] = query_timestamp
        async with httpx.AsyncClient(timeout=300) as client:
            r = await client.post(self._server_url.rstrip("/") + path.replace("{bank_id}", bank).replace("{agent_id}", "default"), json=body)
        if r.status_code != 200:
            raise RuntimeError(f"{self.name}: reflect failed with HTTP {r.status_code}: {r.text[:500]}")
        raw = r.json()
        answer = raw.get("text") or raw.get("answer") or ""
        if not answer:
            raise RuntimeError(f"{self.name}: reflect returned no answer")
        originals = [*self._bank_docs.get(bank, []), "" if user_id is None else user_id]
        scrubbed = self._ids.scrub({"answer": answer, "raw": raw}, extra_originals=originals)
        self._persist_ids()
        meta = {"reflect": scrubbed["raw"], "query_timestamp_sent": sent_timestamp}
        return scrubbed["answer"], scrubbed["answer"], meta

    def direct_answer(self, query, user_id=None, query_timestamp=None):
        import asyncio

        return asyncio.run(self.async_direct_answer(query, user_id, query_timestamp))

    @staticmethod
    def _build_docs(raw: dict) -> list[Document]:
        import importlib

        module = importlib.import_module(f"memory_bench.memory.{names.comparator_key()}")
        response = module._as_recall_response(raw)
        return module._build_docs(module._deduplicate_results(response.results), response.chunks)
