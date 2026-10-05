"""The comparator as a harness memory provider: pinned server, opaque ids.

`ComparatorMemoryProvider` wraps the harness's own HTTP provider for the
comparator (resolved through `names.comparator_variant('http')`) and points
it at the pinned current release started by `comparator_server`. It uses the
comparator's best supported recall mode: extracted facts plus the raw chunks
they came from.

Opaque ids. Every id the provider emits, and every id-bearing field inside
`raw_response` (the LongMemEval, LoCoMo and LifeBench prompt builders paste
`json.dumps(raw_response)` into the prompt), is `c-<hex12>` =
HMAC-sha256(salt, original). Document ids and bank ids are hashed before they
reach the server, so the server only ever sees opaque ids; ids the server
mints (facts, chunks) are hashed on the way out, and any original id left in
a text field is replaced. `reverse_ids()` returns the map back to the
originals for the scorer only.

Config (constructor dict, else `MPW_PROVIDER_CONFIG` JSON):
  max_tokens         facts budget per recall (default: the harness's per-dataset value)
  max_chunk_tokens   raw-chunk budget per recall; 0 means facts only (default: per-dataset)
  budget             recall effort, "low" | "mid" | "high" (default "high", as the harness)
  server_url         use an already running pinned server instead of starting one
  data_dir           server data directory (default <store_dir>/comparator-server)
  id_salt            HMAC salt (default MPW_ID_SALT, else random per process)
  llm_model          extraction model override (default: the server's documented default)
  startup_timeout_s  server health deadline (default 600)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path

from memory_bench.memory.base import MemoryProvider
from memory_bench.models import Document

from . import names

_ID_KEY = re.compile(r"^(id|.*_id)$")
_ID_LIST_KEY = re.compile(r"^.*_ids$")
_ID_KEYED_MAPS = ("chunks", "source_facts")
_MIN_SCRUB_LEN = 4


class OpaqueIds:
    """HMAC-sha256 id hashing with a scorer-only reverse map."""

    def __init__(self, salt: str | bytes):
        self._salt = salt.encode() if isinstance(salt, str) else salt
        self._reverse: dict[str, str] = {}
        self._forward: dict[str, str] = {}

    def hash(self, original: str) -> str:
        if original in self._reverse:
            return original
        hashed = self._forward.get(original)
        if hashed is None:
            hashed = "c-" + hmac.new(self._salt, original.encode(), hashlib.sha256).hexdigest()[:12]
            if self._reverse.get(hashed, original) != original:
                raise RuntimeError(f"opaque id collision on {hashed}")
            self._forward[original] = hashed
            self._reverse[hashed] = original
        return hashed

    def reverse_ids(self) -> dict[str, str]:
        return dict(self._reverse)

    def scrub(self, payload, extra_originals: list[str] = ()):
        """A copy of `payload` with every id field hashed and no original id left in any string."""
        seen: set[str] = set(o for o in extra_originals if o)

        def ident(value: str) -> str:
            if value not in self._reverse:
                seen.add(value)
            return self.hash(value)

        def walk(node, key: str | None = None):
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
                        out[k] = walk(v, k)
                return out
            if isinstance(node, list):
                return [walk(x, key) for x in node]
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
    """The harness's HTTP provider for the comparator, with banks chosen by the wrapper."""
    from memory_bench.memory import REGISTRY

    base = REGISTRY[names.comparator_variant("http")]

    class PinnedHTTPProvider(base):
        bank_for = None

        def _bank_id_for(self, user_id):
            return self.bank_for(user_id)

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
        self._ids = OpaqueIds(self.config.get("id_salt") or os.environ.get("MPW_ID_SALT") or secrets.token_hex(16))
        self._server = None
        self._server_url: str | None = self.config.get("server_url")
        self._inner = None
        self._banks: dict[str | None, str] = {}
        self._bank_docs: dict[str, list[str]] = {}
        self._created: set[str] = set()
        self._schema_checked = False

    # ── ids ──────────────────────────────────────────────────────────────

    def _bank_id(self, user_id: str | None) -> str:
        return self._ids.hash(f"bank:{'' if user_id is None else user_id}")

    def reverse_ids(self) -> dict[str, str]:
        """Opaque id -> original id. For the scorer only; never put this in a prompt."""
        return self._ids.reverse_ids()

    # ── lifecycle ────────────────────────────────────────────────────────

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        if self._server_url is None:
            from .comparator_server import ComparatorServer, upstream_from_env

            data_dir = Path(self.config.get("data_dir") or Path(store_dir) / "comparator-server")
            data_dir.mkdir(parents=True, exist_ok=True)
            self._server = ComparatorServer(
                data_dir=data_dir,
                upstream=upstream_from_env(model=self.config.get("llm_model")),
                startup_timeout_s=float(self.config.get("startup_timeout_s", 600)),
            ).start()
            self._server_url = self._server.url
        if self._inner is None:
            os.environ[names.comparator_env("HTTP_URL")] = self._server_url
            os.environ.setdefault(names.comparator_env("HTTP_KEY"), "")
            self._inner = _http_provider_class()()
            self._inner.bank_for = self._bank_id
        self._inner.prepare(Path(store_dir), unit_ids, reset)
        self._inner._per_unit = True
        self._verify_recall_schema()

    def cleanup(self) -> None:
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

    def ingest(self, documents: list[Document]) -> None:
        if self._inner is None:
            raise RuntimeError(f"{self.name}: prepare() must run before ingest()")
        by_bank: dict[str, list[Document]] = {}
        for doc in documents:
            bank = self._bank_id(doc.user_id)
            self._banks.setdefault(doc.user_id, bank)
            hashed = Document(
                id=self._ids.hash(doc.id), content=doc.content, user_id=doc.user_id,
                timestamp=doc.timestamp, context=doc.context, tags=doc.tags,
            )
            by_bank.setdefault(bank, []).append(hashed)
            self._bank_docs.setdefault(bank, []).append(doc.id)
        for bank, docs in by_bank.items():
            self._inner._resume = bank in self._created
            self._inner.ingest(docs)
            self._created.add(bank)
        self._inner._resume = False

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

    @staticmethod
    def _build_docs(raw: dict) -> list[Document]:
        import importlib

        module = importlib.import_module(f"memory_bench.memory.{names.comparator_key()}")
        response = module._as_recall_response(raw)
        return module._build_docs(module._deduplicate_results(response.results), response.chunks)
