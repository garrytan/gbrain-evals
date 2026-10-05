"""JSON-lines bridge from the workload-suite bench (eval/workload-suites/bench.ts) to the harness providers.

  python -m mpw_workload.bridge        (stdin: one request per line; stdout: one response per line)

Requests are {"id": n, "method": "...", "params": {...}}; responses are
{"id": n, "result": ...} or {"id": n, "error": "..."}. The bench owns the
metering proxy and the environment; this process never reads a key. It holds
one provider instance (gbrain or the comparator) exactly as a harness cell
does, so ingest, the completion barrier, retrieval knobs and opaque ids are
the same code the A cells run.

Methods:
  init(system, config, store_dir)        construct and prepare the provider
  ingest(docs)                           provider ingest (one call per unit); returns the unit receipts
  retrieve(unit, query, query_timestamp, overrides)
                                         rendered context exactly as RAGMode renders it, plus provider metadata
  gbrain_tools(unit) / gbrain_call(unit, tool, args) / gbrain_cli(unit, args)
  comparator_http(method, unit, path, body)   `{bank}` in path becomes the unit's opaque bank id
  presence(unit, values, kind)           which values the store holds for the unit
  close()

This package lives outside `mpw/` on purpose: the A cells hash every `mpw/*.py`
file into their wrapper revision, and the bridge is not part of those cells.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

from mpw import register


def _render(docs) -> str:
    """RAGMode.async_answer's rendering at the harness pin (mpw.cell._render_rag_context)."""
    return "\n\n".join(f"## Memory {i + 1}\n{doc.content}" for i, doc in enumerate(docs))


def _norm(text: str) -> str:
    import re
    import unicodedata

    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return " " + re.sub(r"[^a-z0-9]+", " ", t).strip() + " "


class Bridge:
    def __init__(self) -> None:
        self.system: str | None = None
        self.provider = None

    # ── lifecycle ──────────────────────────────────────────────────────

    def init(self, system: str, config: dict, store_dir: str, reset: bool = True) -> dict:
        register.install()
        self.system = system
        if system == "gbrain":
            from mpw import gbrain_provider
            from mpw.gbrain_provider import GbrainMemoryProvider

            if config.pop("speaker_format", None) == "bold":
                # gbrain's conversation parser recognizes `**Speaker:** text` lines (builtin `bold-name-no-time`),
                # not the plain `role: text` lines the provider writes by default; the facts extractor skips the latter.
                def bold_body(doc):
                    turns = doc.messages or []
                    if not turns:
                        return doc.content or ""
                    return "\n\n".join(f"**{(t.get('role') or 'speaker').capitalize()}:** {t.get('content', '')}" for t in turns)

                gbrain_provider.render_body = bold_body

            self.provider = GbrainMemoryProvider(config=config)
        elif system == "comparator":
            from mpw.comparator_provider import ComparatorMemoryProvider

            self.provider = ComparatorMemoryProvider(config=config)
        else:
            raise ValueError(f"unknown system {system!r}")
        self.provider.initialize()
        Path(store_dir).mkdir(parents=True, exist_ok=True)
        self.provider.prepare(Path(store_dir), unit_ids=None, reset=reset)
        out = {"system": system}
        if system == "gbrain":
            out["gbrain"] = self.provider.version
        else:
            out["server"] = self.provider.receipt()
        return out

    def close(self) -> dict:
        if self.provider is not None:
            self.provider.cleanup()
        return {"closed": True}

    # ── ingest and retrieval ───────────────────────────────────────────

    def ingest(self, docs: list[dict]) -> dict:
        from memory_bench.models import Document

        documents = [Document(**{k: v for k, v in d.items() if k in ("id", "content", "user_id", "messages", "timestamp", "context")}) for d in docs]
        t0 = time.perf_counter()
        try:
            self.provider.ingest(documents)
        except RuntimeError as e:
            # Incremental retains into an existing bank can finish before the server's document count catches up;
            # the provider's completeness check then fires with nothing pending or failed. Wait for the count.
            if self.system != "comparator" or "0 pending, 0 failed operations" not in str(e):
                raise
            self._await_documents({d.user_id for d in documents}, str(e))
        units = sorted({d.user_id for d in documents})
        return {"ms": round((time.perf_counter() - t0) * 1000, 1),
                "receipts": {u: self.provider.last_ingest_receipt(u) for u in units}}

    def _await_documents(self, units: set, why: str, timeout_s: float = 180) -> None:
        import httpx

        deadline = time.monotonic() + timeout_s
        for unit in units:
            bank = self.provider._bank_id(unit)
            want = len(self.provider._bank_docs.get(bank, []))
            while True:
                s = httpx.get(f"{self.provider._server_url.rstrip('/')}/v1/default/banks/{bank}/stats", timeout=60).json()
                if s["total_documents"] == want and not s["pending_operations"] and not s["failed_operations"]:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(why)
                time.sleep(1.0)
            self.provider._banks[unit] = bank
            if self.provider._banks_path is not None:
                self.provider._persist_banks()

    def retrieve(self, unit: str, query: str, query_timestamp: str | None = None, overrides: dict | None = None) -> dict:
        target = self.provider.cfg if self.system == "gbrain" else self.provider.config
        saved = {k: target.get(k, None) for k in (overrides or {})}
        missing = {k for k in (overrides or {}) if k not in target}
        target.update(overrides or {})
        try:
            t0 = time.perf_counter()
            if self.system == "gbrain":
                docs, meta = self._gbrain_retrieve(unit, query)
            else:
                docs, _raw, meta = self.provider.retrieve_with_meta(query, 10, unit, query_timestamp)
            ms = (time.perf_counter() - t0) * 1000
        finally:
            for k, v in saved.items():
                if k in missing:
                    target.pop(k, None)
                else:
                    target[k] = v
        from mpw.context import count_tokens

        context = _render(docs)
        return {"context": context, "documents": len(docs), "retrieve_ms": round(ms, 1), "tokens_cl100k": count_tokens(context), "meta": meta}

    def _gbrain_retrieve(self, unit: str, query: str):
        """The provider's `query` call (same arguments and page blocks with date headers), plus the saved facts
        `query` returns beside its blocks, each rendered as its own memory with its valid-from date."""
        from memory_bench.models import Document
        from mpw.gbrain_provider import SLUG_PREFIX, date_header

        p = self.provider
        u = p._ensure_unit(unit, create=False)
        args = {"query": query, "token_budget": int(p.cfg["token_budget"]), "return_unit": p.cfg["return_unit"], "limit": int(p.cfg["limit"])}
        if p.cfg.get("expand") is not None:
            args["expand"] = bool(p.cfg["expand"])
        if p.cfg.get("autocut") is not None:
            args["autocut"] = bool(p.cfg["autocut"])
        with p._lock:
            rows, meta = u.child.call("query", args)
        retrieval = (meta or {}).get("retrieval", {})
        if retrieval.get("degraded"):
            raise RuntimeError(f"gbrain reported degraded retrieval: {retrieval.get('degraded')}")
        docs = []
        for row in rows if isinstance(rows, list) else []:
            slug = str(row.get("slug", ""))
            doc_id = slug[len(SLUG_PREFIX):] if slug.startswith(SLUG_PREFIX) else slug
            text = row.get("chunk_text") or row.get("text") or ""
            docs.append(Document(id=doc_id, content=f"{date_header(u.timestamps.get(doc_id))}\n{text}", user_id=unit))
        saved = retrieval.get("saved_facts") or []
        for f in saved:
            docs.append(Document(id=f"fact-{f.get('id')}", content=f"{date_header(str(f.get('valid_from') or '') or None)}\nSaved fact: {f.get('fact', '')}", user_id=unit))
        delivery = retrieval.get("delivery", {})
        return docs, {"requested": args, "tokens_delivered": delivery.get("tokens_delivered"), "blocks": delivery.get("blocks"),
                      "saved_facts": len(saved), "budget_clamped": delivery.get("budget_clamped"), "vector_enabled": retrieval.get("vector_enabled")}

    def gbrain_put(self, unit: str, doc: dict) -> dict:
        """Write or overwrite one conversation page (same slug rule as ingest) and wait until its chunks are embedded."""
        from memory_bench.models import Document
        from mpw.gbrain_provider import SLUG_PREFIX, page_markdown
        import uuid

        d = Document(**{k: v for k, v in doc.items() if k in ("id", "content", "user_id", "messages", "timestamp", "context")})
        u = self.provider._ensure_unit(unit, create=True)
        u.timestamps[d.id.lower()] = d.timestamp
        u.save()
        t0 = time.perf_counter()
        slug = SLUG_PREFIX + d.id.lower()
        with self.provider._lock:
            args = {"slug": slug, "content": page_markdown(d), "request_id": str(uuid.uuid4())}
            try:
                current, _ = u.child.call("get_page", {"slug": slug, "include_content": True})
            except Exception:  # noqa: BLE001  (a new page has nothing to read)
                current = None
            if isinstance(current, dict) and current.get("revision") is not None:
                args["expected_revision"] = current["revision"]
            res, _ = u.child.call("put_page", args)
            deadline = time.monotonic() + 600
            while True:
                health, _ = u.child.call("get_health", {})
                if int((health or {}).get("missing_embeddings", 0) or 0) == 0:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("embedding barrier timed out after put_page")
                time.sleep(0.5)
        return {"ms": round((time.perf_counter() - t0) * 1000, 1), "result": res if isinstance(res, dict) else str(res)[:300]}

    # ── gbrain operations ──────────────────────────────────────────────

    def _gbrain_unit(self, unit: str):
        return self.provider._ensure_unit(unit, create=False)

    def gbrain_tools(self, unit: str) -> dict:
        u = self._gbrain_unit(unit)
        return {name: (tool.get("inputSchema") or {}).get("properties", {}) for name, tool in u.child.tools.items()}

    def gbrain_call(self, unit: str, tool: str, args: dict) -> dict:
        u = self._gbrain_unit(unit)
        with self.provider._lock:
            result, meta = u.child.call(tool, args)
        return {"result": result, "meta": meta}

    def gbrain_cli(self, unit: str, args: list[str], timeout_s: float = 3600) -> dict:
        """Run a gbrain CLI command on the unit's brain with its serve child closed (PGLite has one writer)."""
        with self.provider._lock:
            self.provider._close_unit(unit)
            home = self.provider._unit_home(unit)
            t0 = time.perf_counter()
            out = self.provider._cli(home, *args, timeout=timeout_s)
        self.provider._ensure_unit(unit, create=False)
        return {"stdout": out[-20000:], "ms": round((time.perf_counter() - t0) * 1000, 1)}

    # ── comparator operations ──────────────────────────────────────────

    def comparator_http(self, method: str, unit: str, path: str, body: dict | None = None, params: dict | None = None) -> dict:
        import httpx

        bank = self.provider._banks.get(unit) or self.provider._bank_id(unit)
        url = self.provider._server_url.rstrip("/") + path.replace("{bank}", bank)
        r = httpx.request(method, url, json=body, params=params, timeout=600)
        try:
            payload = r.json()
        except ValueError:
            payload = r.text
        return {"status": r.status_code, "body": payload}

    def comparator_retain(self, unit: str, doc: dict) -> dict:
        """Retain one document into an existing bank synchronously (the retain item the harness builds:
        content, timestamp, context, document_id and metadata.doc_id, all ids opaque). Retaining an id that
        already exists replaces that document and what was derived from it."""
        p = self.provider
        bank = p._banks.get(unit) or p._bank_id(unit)
        hashed = p._ids.hash(doc["id"])
        item = {"content": (doc.get("content") or "").replace("\x00", ""), "document_id": hashed, "metadata": {"doc_id": hashed},
                "update_mode": "replace"}
        if doc.get("timestamp"):
            item["timestamp"] = doc["timestamp"]
        if doc.get("context"):
            item["context"] = p._ids.scrub(doc["context"], extra_originals=[doc["id"], unit])
        t0 = time.perf_counter()
        r = self.comparator_http("POST", unit, "/v1/default/banks/{bank}/memories", {"items": [item], "async": True})
        if r["status"] != 200:
            raise RuntimeError(f"comparator retain HTTP {r['status']}: {str(r['body'])[:400]}")
        op = r["body"].get("operation_id") if isinstance(r["body"], dict) else None
        deadline = time.monotonic() + 600
        while op:
            o = self.comparator_http("GET", unit, f"/v1/default/banks/{{bank}}/operations/{op}")
            status = o["body"].get("status") if isinstance(o["body"], dict) else None
            if status == "completed":
                break
            if status in ("failed", "cancelled") or time.monotonic() > deadline:
                raise RuntimeError(f"comparator retain operation {op} ended {status}: {str(o['body'])[:300]}")
            time.sleep(0.25)
        # The bank stats endpoint lags new documents by up to a minute, so completion is read from the
        # operation and the document itself instead.
        d = self.comparator_http("GET", unit, f"/v1/default/banks/{{bank}}/documents/{hashed}")
        if d["status"] != 200:
            raise RuntimeError(f"comparator retain of {hashed}: document not found after the operation completed (HTTP {d['status']})")
        known = p._bank_docs.setdefault(bank, [])
        if doc["id"] not in known:
            known.append(doc["id"])
        p._persist_ids()
        return {"ms": round((time.perf_counter() - t0) * 1000, 1)}

    def comparator_doc_id(self, doc_id: str) -> dict:
        return {"id": self.provider._ids.hash(doc_id)}

    # ── presence ───────────────────────────────────────────────────────

    def presence(self, unit: str, needles: list[dict], kind: str) -> dict:
        """Which needle values the unit's store holds, per record kind.

        gbrain: `pages` reads the conversation page the needle came from (get_page) and checks its text;
        `facts` greps the unit's facts. comparator: `chunks` reads the stored chunks of the needle's
        document; `facts` lists the bank's memories whose text holds the value."""
        found: dict[str, bool] = {}

        def holds(n: dict, text: str) -> bool:
            t = _norm(text)
            return any(_norm(f) in t for f in (n.get("forms") or [n["value"]]))

        if self.system == "gbrain":
            from mpw.gbrain_provider import SLUG_PREFIX

            for n in needles:
                v = n["value"]
                if kind == "facts":
                    res = self.gbrain_call(unit, "recall", {"grep": v, "limit": 5})["result"]
                    rows = (res or {}).get("facts", []) if isinstance(res, dict) else []
                    found[v] = found.get(v, False) or any(holds(n, str(r.get("fact", ""))) for r in rows)
                else:
                    try:
                        page = self.gbrain_call(unit, "get_page", {"slug": SLUG_PREFIX + n["doc_id"].lower(), "include_content": True})["result"]
                    except Exception:  # noqa: BLE001
                        page = None
                    text = json.dumps(page, ensure_ascii=False) if page is not None else ""
                    found[v] = found.get(v, False) or holds(n, text.replace("\\n", " "))
        else:
            for n in needles:
                v = n["value"]
                if kind == "facts":
                    hit = False
                    for form in (n.get("forms") or [v]):
                        q = form.split(" ")[-1] if len(n.get("forms") or []) > 1 else form
                        r = self.comparator_http("GET", unit, "/v1/default/banks/{bank}/memories/list", params={"q": q[:200], "limit": 100})
                        items = r["body"].get("items", []) if isinstance(r["body"], dict) else []
                        if any(holds(n, str(x.get("text", ""))) for x in items):
                            hit = True
                            break
                else:
                    doc = self.provider._ids.hash(n["doc_id"])
                    r = self.comparator_http("GET", unit, f"/v1/default/banks/{{bank}}/documents/{doc}/chunks")
                    body = r["body"]
                    items = body.get("items", body.get("chunks", [])) if isinstance(body, dict) else (body if isinstance(body, list) else [])
                    hit = any(holds(n, str(x.get("text", x.get("chunk_text", "")))) for x in items)
                found[v] = found.get(v, False) or hit
        return {"found": found}


def main() -> int:
    bridge = Bridge()
    out = sys.stdout
    sys.stdout = sys.stderr  # provider prints never corrupt the protocol stream
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            result = getattr(bridge, req["method"])(**(req.get("params") or {}))
            resp = {"id": req["id"], "result": result}
        except Exception as e:  # noqa: BLE001
            resp = {"id": req["id"], "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-4000:]}
        out.write(json.dumps(resp, default=str) + "\n")
        out.flush()
        if req["method"] == "close":
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
