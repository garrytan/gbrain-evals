"""gbrain facts lanes: extraction windows, opt-in extraction at ingest, facts and combined retrieval.

Runs the real gbrain from node_modules (or MPW_GBRAIN_CLI) against
eval/runner/stub-upstream.ts, behind a recording forwarder so the tests can
see which model requests gbrain made. Requires bun >= 1.4 and `bun install`;
skipped otherwise unless MPW_REQUIRE_HARNESS=1.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from memory_bench.models import Document

from mpw.gbrain_provider import extraction_windows, render_body

REPO = Path(__file__).resolve().parents[3]
CLI = os.environ.get("MPW_GBRAIN_CLI") or str(REPO / "node_modules/gbrain/src/cli.ts")
MODEL = "openai:gpt-6-luna"


def _bun_ok() -> bool:
    bun = shutil.which("bun")
    if not bun or not Path(CLI).exists():
        return False
    out = subprocess.run([bun, "--version"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(x) for x in out.split(".")[:2])
    return (major, minor) >= (1, 4)


def test_extraction_windows_keep_whole_turns_and_label_continuations():
    turns = [{"role": "user", "content": "a" * 30}, {"role": "assistant", "content": "b" * 30},
             {"role": "user", "content": "c" * 95}, {"role": "assistant", "content": "d" * 10}]
    doc = Document(id="d-1", content="", messages=turns)
    assert extraction_windows(doc, 80) == [
        f"user: {'a' * 30}\nassistant: {'b' * 30}",
        f"user: {'c' * 74}",
        f"user: {'c' * 21}\nassistant: {'d' * 10}",
    ]
    assert render_body(doc) == "\n".join(f"{t['role']}: {t['content']}" for t in turns)
    plain = Document(id="d-2", content="x" * 170)
    assert extraction_windows(plain, 80) == ["x" * 80, "x" * 80, "x" * 10]
    assert extraction_windows(Document(id="d-3", content=""), 80) == []


if not _bun_ok():
    if os.environ.get("MPW_REQUIRE_HARNESS") == "1":
        raise RuntimeError("gbrain facts tests need bun >= 1.4 and node_modules/gbrain (bun install)")
    pytest.skip("bun >= 1.4 or node_modules/gbrain missing", allow_module_level=True)


@pytest.fixture(scope="module")
def upstream():
    """stub-upstream.ts behind a forwarder that records (path, model, authorization) per request."""
    proc = subprocess.Popen([shutil.which("bun"), str(REPO / "eval/runner/stub-upstream.ts")], stdout=subprocess.PIPE, text=True)
    stub = json.loads(proc.stdout.readline())["url"].rstrip("/")
    hits: list = []

    class Forward(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _forward(self, method: str):
            n = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(n) if n else None
            body = json.loads(raw) if raw else {}
            hits.append((self.path, body.get("model"), self.headers.get("authorization")))
            req = urllib.request.Request(stub + self.path, data=raw, method=method,
                                         headers={"content-type": self.headers.get("content-type") or "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                out = r.read()
                self.send_response(r.status)
                self.send_header("content-type", r.headers.get("content-type") or "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def do_POST(self):
            self._forward("POST")

        def do_GET(self):
            self._forward("GET")

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Forward)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", hits
    srv.shutdown()
    proc.terminate()
    proc.wait(timeout=10)


def _provider(store: Path, url: str, **cfg):
    from mpw.gbrain_provider import GbrainMemoryProvider

    p = GbrainMemoryProvider({"gbrain_cli": CLI, "token_budget": 1500, "extraction_model": MODEL, "facts_tokens": 400,
                              "child_env": {"VOYAGE_API_KEY": "mpwp-gbrain-test", "VOYAGE_BASE_URL": f"{url}/voyage/v1",
                                            "OPENAI_API_KEY": "mpwp-gbrain-test", "OPENAI_BASE_URL": f"{url}/openai/v1"}, **cfg})
    p.prepare(store)
    return p


def _docs(unit: str) -> list[Document]:
    long_turns = [{"role": "user", "content": f"Turn {i}: I adopted a cat named Miso in March and she likes the window seat. " * 6}
                  for i in range(40)]
    return [
        Document(id="d-a0", content="", user_id=unit, timestamp="2024-03-01T09:00:00",
                 messages=[{"role": "user", "content": "I'm planning a trip to Kyoto in May with my sister Anna."},
                           {"role": "assistant", "content": "Kyoto in May is lovely. Do you want temple suggestions?"}]),
        Document(id="d-a1", content="", user_id=unit, timestamp="2024-03-05T18:30:00", messages=long_turns),
        Document(id="d-a2", content="I switched my running shoes to a new brand after the half marathon.", user_id=unit, timestamp=None),
    ]


def _model_hits(hits: list, start: int) -> list:
    return [(p, m) for p, m, _ in hits[start:] if "/openai/" in p and m]


def test_facts_extraction_and_lanes(tmp_path, upstream):
    url, hits = upstream
    p = _provider(tmp_path / "store", url, lane="facts")
    docs = _docs("u-1")
    try:
        before = len(hits)
        p.ingest(docs)
        facts = p.last_ingest_receipt("u-1")["facts"]
        windows = sum(len(extraction_windows(d, 8000)) for d in docs)
        assert windows == 5 and facts["windows"] == windows
        assert facts["failed_windows"] == 0 and facts["inserted"] > 0 and facts["op"] == "extract_facts"
        extraction = _model_hits(hits, before)
        assert extraction and all(m == "gpt-6-luna" for _, m in extraction)
        assert len(extraction) == windows
        assert all(auth == "Bearer mpwp-gbrain-test" for _, _, auth in hits[before:])
        template = json.loads((tmp_path / "store/gbrain/_template/mpw-template.json").read_text())
        assert template["gbrain"]["config"]["facts.extraction_model"] == MODEL

        before = len(hits)
        fdocs, raw, meta = p.retrieve_with_meta("What is the cat called?", 10, "u-1")
        assert raw is None and meta["lane"] == "facts"
        assert fdocs and all("\nSaved facts:\n- " in d.content and d.content.startswith("Date: ") for d in fdocs)
        assert {d.id for d in fdocs} <= {"d-a0", "d-a1", "d-a2", "facts"}
        assert 0 < meta["facts"]["tokens"] <= 400 and meta["tokens_delivered"] == meta["facts"]["tokens"]
        assert meta["pages"]["requested"]["expand"] is False
        assert not _model_hits(hits, before), "retrieval made a chat request (query expansion must stay off)"
        dated = next(d for d in fdocs if d.id == "d-a1")
        assert dated.content.startswith("Date: 2024-03-05 18:30 UTC")

        p.cfg["lane"] = "combined"
        cdocs, raw, cmeta = p.retrieve_with_meta("What is the cat called?", 10, "u-1")
        page_docs = [d for d in cdocs if "\nSaved facts:\n" not in d.content]
        assert page_docs and len(cdocs) == len(page_docs) + cmeta["facts"]["documents"]
        assert cmeta["tokens_delivered"] == cmeta["facts"]["tokens"] + cmeta["pages"]["tokens_delivered"]
        assert cmeta["pages"]["requested"]["token_budget"] == 1500 and cmeta["pages"]["requested"]["expand"] is False
        assert [d.content for d in cdocs[:len(fdocs)]] == [d.content for d in fdocs]

        p.cfg["lane"] = "summaries"
        with pytest.raises(Exception, match="unknown lane"):
            p.retrieve_with_meta("anything", 10, "u-1")
    finally:
        p.cleanup()


def test_raw_lane_makes_no_chat_request_and_keeps_its_shape(tmp_path, upstream):
    url, hits = upstream
    from mpw.gbrain_provider import GbrainMemoryProvider

    p = GbrainMemoryProvider({"gbrain_cli": CLI, "token_budget": 1500,
                              "child_env": {"VOYAGE_API_KEY": "mpwp-gbrain-test", "VOYAGE_BASE_URL": f"{url}/voyage/v1"}})
    p.prepare(tmp_path / "store")
    try:
        before = len(hits)
        p.ingest(_docs("u-2"))
        assert "facts" not in p.last_ingest_receipt("u-2")
        docs, raw, meta = p.retrieve_with_meta("What is the cat called?", 10, "u-2")
        assert raw is None and docs
        assert set(meta) == {"requested", "tokens_delivered", "tokenizer", "applied_unit", "blocks", "dropped", "fallbacks",
                             "budget_clamped", "vector_enabled", "expansion_applied"}
        assert "expand" not in meta["requested"]
        assert not _model_hits(hits, before)
        template = json.loads((tmp_path / "store/gbrain/_template/mpw-template.json").read_text())
        assert "facts.extraction_model" not in template["gbrain"]["config"]
    finally:
        p.cleanup()
