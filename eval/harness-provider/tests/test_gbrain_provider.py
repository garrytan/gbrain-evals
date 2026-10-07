"""gbrain provider: hermetic process contract, unit isolation, barrier, retrieval shape.

Runs the real gbrain from node_modules (or MPW_GBRAIN_CLI) against a local
embedding stub. Requires bun >= 1.4 and `bun install`; skipped otherwise
unless MPW_REQUIRE_HARNESS=1, which turns a missing prerequisite into a failure.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import textwrap
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from memory_bench.models import Document

REPO = Path(__file__).resolve().parents[3]
CLI = os.environ.get("MPW_GBRAIN_CLI") or str(REPO / "node_modules/gbrain/src/cli.ts")


def _bun_ok() -> bool:
    bun = shutil.which("bun")
    if not bun or not Path(CLI).exists():
        return False
    out = subprocess.run([bun, "--version"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(x) for x in out.split(".")[:2])
    return (major, minor) >= (1, 4)


if not _bun_ok():
    if os.environ.get("MPW_REQUIRE_HARNESS") == "1":
        raise RuntimeError("gbrain provider tests need bun >= 1.4 and node_modules/gbrain (bun install)")
    pytest.skip("bun >= 1.4 or node_modules/gbrain missing", allow_module_level=True)


class _Recorder(BaseHTTPRequestHandler):
    hits: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        type(self).hits.append((self.path, self.headers.get("authorization"), body.get("model")))
        if "embeddings" in self.path:
            inputs = body.get("input")
            inputs = [inputs] if isinstance(inputs, str) else inputs
            dim = body.get("dimensions") or body.get("output_dimension") or 1024
            data = []
            for i, text in enumerate(inputs):
                h = hashlib.sha256(str(text).encode()).digest()
                vec = [(h[j % 32] - 128) / 128 for j in range(dim)]
                norm = sum(v * v for v in vec) ** 0.5
                data.append({"object": "embedding", "index": i, "embedding": [v / norm for v in vec]})
            out = {"object": "list", "data": data, "model": body.get("model"), "usage": {"prompt_tokens": 8, "total_tokens": 8}}
        else:
            out = {"error": {"message": "unexpected"}}
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def _server():
    handler = type("H", (_Recorder,), {"hits": []})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, handler


@pytest.fixture
def embed_stub():
    srv, handler = _server()
    yield f"http://127.0.0.1:{srv.server_address[1]}", handler
    srv.shutdown()


@pytest.fixture
def sentinel(monkeypatch, tmp_path):
    """A fake operator home with a real-looking ~/.gbrain, and an unrelated key pointed at a recording server."""
    home = tmp_path / "operator-home"
    (home / ".gbrain").mkdir(parents=True)
    cfg = home / ".gbrain" / "config.json"
    cfg.write_text(json.dumps({"engine": "pglite", "database_path": str(home / ".gbrain/brain.pglite"), "sentinel": True}))
    srv, handler = _server()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GBRAIN_HOME", str(home))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-sentinel-should-never-be-used")
    monkeypatch.setenv("OPENAI_BASE_URL", f"http://127.0.0.1:{srv.server_address[1]}/v1")
    monkeypatch.setenv("SENTINEL_API_KEY", "sentinel-value")
    monkeypatch.setenv("JEV_TYPESAFE_API_KEY", "sentinel-typesafe")
    before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in home.rglob("*") if p.is_file()}
    yield {"home": home, "before": before, "handler": handler}
    srv.shutdown()


def _provider(store: Path, stub_url: str, **cfg):
    from mpw.gbrain_provider import GbrainMemoryProvider

    p = GbrainMemoryProvider({"gbrain_cli": CLI, "token_budget": 2000,
                              "child_env": {"VOYAGE_API_KEY": "mpwp-gbrain-test", "VOYAGE_BASE_URL": f"{stub_url}/v1"}, **cfg})
    p.prepare(store, unit_ids={"u-a", "u-b"}, reset=True)
    return p


DOCS = [
    Document(id="d-a1", content="I adopted a grey cat named Pixel.", user_id="u-a", timestamp="2024-03-02T10:00:00+00:00"),
    Document(id="d-a2", content="I bake sourdough on Saturdays.", user_id="u-a", timestamp=None),
    Document(id="d-b1", content="My daughter Mila has violin lessons on Tuesdays.", user_id="u-b", timestamp="2023-11-05T08:00:00+00:00"),
]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        state = Path(f"/proc/{pid}/stat").read_text().split()[2]
        return state != "Z"
    except FileNotFoundError:
        return False


def test_sentinel_isolation(tmp_path, embed_stub, sentinel):
    url, embed_hits = embed_stub
    p = _provider(tmp_path / "store", url, max_open_units=2)
    try:
        p.ingest([d for d in DOCS if d.user_id == "u-a"])
        p.ingest([d for d in DOCS if d.user_id == "u-b"])
        child_env = Path(f"/proc/{p.units['u-b'].child.pid}/environ").read_bytes().split(b"\0")
        names = {e.split(b"=", 1)[0].decode() for e in child_env if b"=" in e}
        assert "OPENAI_API_KEY" not in names and "SENTINEL_API_KEY" not in names and "JEV_TYPESAFE_API_KEY" not in names
        assert {k for k in names if k.endswith("_API_KEY")} == {"VOYAGE_API_KEY"}
        home = dict(e.split(b"=", 1) for e in child_env if b"=" in e)[b"GBRAIN_HOME"].decode()
        assert home.startswith(str(tmp_path / "store")) and Path(home).is_absolute()

        docs_a, raw, meta = p.retrieve_with_meta("grey cat", user_id="u-a")
        assert raw is None and docs_a
        assert {d.id for d in docs_a} <= {"d-a1", "d-a2"}
        docs_b, _, _ = p.retrieve_with_meta("grey cat", user_id="u-b")
        assert {d.id for d in docs_b} <= {"d-b1"}
        with pytest.raises(Exception, match="no gbrain brain"):
            p.retrieve_with_meta("anything", user_id="u-unknown")
        assert meta["requested"]["return_unit"] == "page" and meta["requested"]["token_budget"] == 2000
        assert meta["budget_clamped"] is False and meta["tokenizer"] == "cl100k"
        cat = next(d for d in docs_a if d.id == "d-a1")
        assert cat.content.startswith("Date: 2024-03-02 10:00 UTC\n")
        undated = [d for d in docs_a if d.id == "d-a2"]
        assert not undated or undated[0].content.startswith("Date: unknown\n")
        pids = p.child_pids()
        assert pids
    finally:
        p.cleanup()
    for pid in pids:
        assert not _alive(pid)
    assert sentinel["handler"].hits == [], "the unrelated key's endpoint was called"
    assert embed_hits.hits and all(auth == "Bearer mpwp-gbrain-test" for _, auth, _ in embed_hits.hits)
    after = {q: hashlib.sha256(q.read_bytes()).hexdigest() for q in sentinel["home"].rglob("*") if q.is_file()}
    assert after == sentinel["before"], "the operator's home changed"


def test_barrier_fails_when_embeddings_never_land(tmp_path):
    from mpw.gbrain_provider import GbrainIngestError, GbrainMemoryProvider

    p = GbrainMemoryProvider({"gbrain_cli": CLI, "barrier_timeout_s": 3,
                              "child_env": {"VOYAGE_API_KEY": "mpwp-x", "VOYAGE_BASE_URL": "http://127.0.0.1:9/v1"}})
    p.prepare(tmp_path / "store", reset=True)
    try:
        with pytest.raises(GbrainIngestError, match="barrier|embedding"):
            p.ingest([DOCS[0]])
    finally:
        p.cleanup()


def test_degraded_retrieval_raises_instead_of_returning_empty(tmp_path, embed_stub):
    url, _ = embed_stub
    p = _provider(tmp_path / "store", url)
    try:
        p.ingest([DOCS[0]])
        p.child_env["VOYAGE_BASE_URL"] = "http://127.0.0.1:9/v1"
        p._rewrite_config(p.units["u-a"].home)
        p._close_unit("u-a")
        with pytest.raises(Exception, match="degraded"):
            p.retrieve_with_meta("grey cat", user_id="u-a")
    finally:
        p.cleanup()


def test_children_reaped_on_sigterm(tmp_path, embed_stub):
    url, _ = embed_stub
    script = tmp_path / "victim.py"
    script.write_text(textwrap.dedent(f"""
        import json, signal, sys, time
        sys.path.insert(0, {str(REPO / 'eval/harness-provider')!r})
        from mpw import register; register.install()
        from memory_bench.models import Document
        from mpw.gbrain_provider import GbrainMemoryProvider
        signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))
        p = GbrainMemoryProvider({{"gbrain_cli": {CLI!r}, "child_env": {{"VOYAGE_API_KEY": "mpwp-x", "VOYAGE_BASE_URL": {url + '/v1'!r}}}}})
        p.prepare({str(tmp_path / 'store')!r}, reset=True)
        p.ingest([Document(id="d-1", content="hello there", user_id="u-1")])
        print(json.dumps(p.child_pids()), flush=True)
        time.sleep(120)
    """))
    proc = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, text=True, env={**os.environ})
    pids = json.loads(proc.stdout.readline())
    assert pids and all(_alive(x) for x in pids)
    proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=60)
    deadline = time.time() + 15
    while time.time() < deadline and any(_alive(x) for x in pids):
        time.sleep(0.2)
    assert not any(_alive(x) for x in pids)


def test_children_exit_when_parent_is_killed(tmp_path, embed_stub):
    url, _ = embed_stub
    script = tmp_path / "victim.py"
    script.write_text(textwrap.dedent(f"""
        import json, sys, time
        sys.path.insert(0, {str(REPO / 'eval/harness-provider')!r})
        from mpw import register; register.install()
        from memory_bench.models import Document
        from mpw.gbrain_provider import GbrainMemoryProvider
        p = GbrainMemoryProvider({{"gbrain_cli": {CLI!r}, "child_env": {{"VOYAGE_API_KEY": "mpwp-x", "VOYAGE_BASE_URL": {url + '/v1'!r}}}}})
        p.prepare({str(tmp_path / 'store')!r}, reset=True)
        p.ingest([Document(id="d-1", content="hello there", user_id="u-1")])
        print(json.dumps(p.child_pids()), flush=True)
        time.sleep(120)
    """))
    proc = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, text=True)
    pids = json.loads(proc.stdout.readline())
    proc.kill()
    proc.wait(timeout=30)
    deadline = time.time() + 30
    while time.time() < deadline and any(_alive(x) for x in pids):
        time.sleep(0.2)
    assert not any(_alive(x) for x in pids), "gbrain serve outlived a SIGKILLed parent (stdin EOF should end it)"

def test_repeated_session_is_written_once_and_a_changed_repeat_kept(tmp_path, embed_stub):
    url, _ = embed_stub
    p = _provider(tmp_path / "store", url)
    try:
        changed = Document(id="d-a1", content="I adopted a second cat named Byte.", user_id="u-a", timestamp="2024-04-01T09:00:00+00:00")
        p.ingest([DOCS[0], DOCS[0], changed])
        docs, _, _ = p.retrieve_with_meta("cat", user_id="u-a")
        by_id = {d.id: d.content for d in docs}
        assert set(by_id) == {"d-a1", "d-a1-2"}
        assert by_id["d-a1-2"].startswith("Date: 2024-04-01 09:00 UTC\n")
    finally:
        p.cleanup()


def test_concurrent_queries_across_units_survive_child_eviction(tmp_path, embed_stub):
    url, _ = embed_stub
    p = _provider(tmp_path / "store", url, max_open_units=1)
    try:
        p.ingest([d for d in DOCS if d.user_id == "u-a"])
        p.ingest([d for d in DOCS if d.user_id == "u-b"])
        errors = []
        opened = p._ensure_unit

        def slow_open(*a, **k):
            u = opened(*a, **k)
            time.sleep(0.05)
            return u

        p._ensure_unit = slow_open

        def worker(unit):
            for _ in range(4):
                try:
                    p.retrieve_with_meta("cat", user_id=unit)
                except Exception as e:
                    errors.append(repr(e))

        threads = [threading.Thread(target=worker, args=(u,)) for u in ("u-a", "u-b", "u-a", "u-b")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert errors == []
    finally:
        p.cleanup()


def test_search_config_is_read_time_and_never_inherited(tmp_path, embed_stub):
    url, _ = embed_stub
    store = tmp_path / "store"
    p = _provider(store, url, search_config={"search.return_budget_max_remote": "200000"})
    try:
        p.ingest([DOCS[0]])
        p.retrieve_with_meta("grey cat", user_id="u-a")
        home = p.units["u-a"].home
    finally:
        p.cleanup()
    assert p._cli(home, "config", "get", "search.return_budget_max_remote").strip() == "200000"

    from mpw.gbrain_provider import GbrainMemoryProvider

    q = GbrainMemoryProvider({"gbrain_cli": CLI, "token_budget": 2000,
                              "child_env": {"VOYAGE_API_KEY": "mpwp-gbrain-test", "VOYAGE_BASE_URL": f"{url}/v1"}})
    q.prepare(store, unit_ids={"u-a", "u-b"}, reset=False)
    try:
        _, _, meta = q.retrieve_with_meta("grey cat", user_id="u-a")
        assert meta["entity_anchored"] == 0
    finally:
        q.cleanup()
    with pytest.raises(RuntimeError, match="not found"):
        q._cli(home, "config", "get", "search.return_budget_max_remote")
