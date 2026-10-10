"""Opaque-id wrapper and pinned-server plumbing for the comparator. No server, no network."""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from mpw import comparator_server, names
from mpw.comparator_provider import ComparatorMemoryProvider, OpaqueIds

FIXTURE = Path(__file__).parent / "fixtures" / "comparator_recall_raw.json"
BANK = "longmemeval-s-u0a1b2c3"
RAW_IDS = [
    "answer_d61669c7_7", "d61669c7", "sharegpt_x9Yq3Lm_0", "x9Yq3Lm",
    "5df67616-0d68-4474-b610-24b2e555c716", "ddd1ab3a-1d57-4311-871b-699ae392b9ad",
    "9b2f6a0e-1c4d-4e8a-9f3b-7d5e2a1c0b9f", "u0a1b2c3", "~5F",
]
OPAQUE = re.compile(r"^c-[0-9a-f]{12}$")


def _raw():
    return json.loads(FIXTURE.read_text())


def _id_fields(node, path=""):
    """(path, value) for every id-bearing field, including keys of id-keyed maps."""
    if isinstance(node, dict):
        for k, v in node.items():
            p = f"{path}.{k}"
            if k in ("chunks", "source_facts") and isinstance(v, dict):
                for ck, cv in v.items():
                    yield f"{p}[key]", ck
                    yield from _id_fields(cv, f"{p}[{ck}]")
            elif isinstance(v, str) and (k == "id" or k.endswith("_id")):
                yield p, v
            elif isinstance(v, list) and k.endswith("_ids"):
                for i, x in enumerate(v):
                    yield f"{p}[{i}]", x
            else:
                yield from _id_fields(v, p)
    elif isinstance(node, list):
        for i, x in enumerate(node):
            yield from _id_fields(x, f"{path}[{i}]")


def test_every_id_field_is_hashed():
    ids = OpaqueIds("salt")
    out = ids.scrub(_raw(), extra_originals=[BANK])
    fields = list(_id_fields(out))
    assert len(fields) >= 14
    for path, value in fields:
        assert OPAQUE.match(value), f"{path} = {value!r} is not opaque"


def test_no_raw_id_survives_json_dumps():
    ids = OpaqueIds("salt")
    dumped = json.dumps(ids.scrub(_raw(), extra_originals=[BANK]))
    for raw in RAW_IDS + [BANK]:
        assert raw not in dumped, raw
    assert "adopted a beagle named Rex" in dumped


def test_reverse_map_round_trips():
    raw = _raw()
    ids = OpaqueIds("salt")
    out = ids.scrub(raw, extra_originals=[BANK])
    reverse = ids.reverse_ids()
    before, after = list(_id_fields(raw)), list(_id_fields(out))
    assert len(before) == len(after)
    for (path, original), (_, value) in zip(before, after):
        assert reverse[value] == original, path
    first = out["results"][0]
    assert reverse[first["document_id"]] == "answer_d61669c7_7"
    assert first["metadata"]["doc_id"] == first["document_id"]
    chunk_key = first["chunk_id"]
    assert chunk_key in out["chunks"]
    assert reverse[chunk_key] == "longmemeval-s-u0a1b2c3_answer~5Fd61669c7~5F7_0"


def test_hashing_is_salted_hmac_and_stable():
    a, b, c = OpaqueIds("salt"), OpaqueIds("salt"), OpaqueIds("other")
    assert a.hash("answer_d61669c7_7") == b.hash("answer_d61669c7_7")
    assert a.hash("answer_d61669c7_7") != c.hash("answer_d61669c7_7")
    h = a.hash("answer_d61669c7_7")
    assert a.hash(h) == h


def test_harness_docs_built_from_scrubbed_raw_carry_only_opaque_ids():
    from importlib import import_module

    ids = OpaqueIds("salt")
    out = ids.scrub(_raw(), extra_originals=[BANK])
    docs = ComparatorMemoryProvider._build_docs(out)
    assert [d.id for d in docs] == [r["id"] for r in out["results"]]
    reverse = ids.reverse_ids()
    assert {reverse[s] for d in docs for s in d.source_ids} == {"answer_d61669c7_7", "sharegpt_x9Yq3Lm_0"}
    text = "\n".join(d.content for d in docs)
    assert "adopted a beagle" in text
    for raw in RAW_IDS:
        assert raw not in text, raw
    # the module the wrapper borrows formatting from is the comparator's own harness module
    assert import_module(f"memory_bench.memory.{names.comparator_key()}")._build_docs


def test_retrieve_for_unknown_user_raises():
    provider = ComparatorMemoryProvider({"server_url": "http://127.0.0.1:9", "id_salt": "s"})
    with pytest.raises(RuntimeError, match="never ingested"):
        provider.retrieve("what dog?", user_id="nobody")


class _Fail(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_POST(self):
        self.send_response(500)
        self.end_headers()
        self.wfile.write(b"boom")


def _provider_with_fake_bank(url: str) -> ComparatorMemoryProvider:
    provider = ComparatorMemoryProvider({"server_url": url, "id_salt": "s", "max_tokens": 4096, "max_chunk_tokens": 2048})
    provider._banks["u1"] = provider._bank_id("u1")

    class Inner:
        @staticmethod
        def _recall_kwargs(q, u, t):
            return {"query": q[:1900], "budget": "high", "max_tokens": 32768, "max_chunk_tokens": 16384}

    provider._inner = Inner()
    return provider


def test_recall_errors_raise_instead_of_returning_empty():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Fail)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        provider = _provider_with_fake_bank(f"http://127.0.0.1:{server.server_address[1]}")
        with pytest.raises(RuntimeError, match="HTTP 500"):
            provider.retrieve("q", user_id="u1")
    finally:
        server.shutdown()
    import httpx

    with pytest.raises(httpx.TransportError):
        _provider_with_fake_bank(f"http://127.0.0.1:{comparator_server.free_port()}").retrieve("q", user_id="u1")


def test_config_knobs_drive_the_recall_body(monkeypatch):
    provider = _provider_with_fake_bank("http://127.0.0.1:9")
    bank, body, knobs = provider._recall_body("q", "u1", "2023-06-01T00:00:00Z")
    assert bank == provider._bank_id("u1") and OPAQUE.match(bank)
    assert body["max_tokens"] == 4096 and body["include"]["chunks"] == {"max_tokens": 2048}
    assert body["include"]["entities"] is None and body["query_timestamp"] == "2023-06-01T00:00:00Z"
    assert knobs == {"max_tokens": 4096, "max_chunk_tokens": 2048, "include_chunks": True, "budget": "high", "query_truncated": False}
    monkeypatch.setenv("MPW_PROVIDER_CONFIG", json.dumps({"max_chunk_tokens": 0, "server_url": "http://127.0.0.1:9"}))
    facts_only = ComparatorMemoryProvider()
    facts_only._banks, facts_only._inner = provider._banks, provider._inner
    _, body, knobs = facts_only._recall_body("q", "u1", None)
    assert body["include"]["chunks"] is None and knobs["include_chunks"] is False and body["max_tokens"] == 32768


def test_upstream_must_be_loopback_and_come_from_the_launcher():
    with pytest.raises(RuntimeError, match="not loopback"):
        comparator_server.Upstream("openai", "https://api.openai.com/v1", "mpwp-x")
    with pytest.raises(RuntimeError, match="MPW_CHILD_ENV_COMPARATOR"):
        comparator_server.upstream_from_env({})
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        comparator_server.upstream_from_env({"MPW_CHILD_ENV_COMPARATOR": json.dumps({"OPENAI_BASE_URL": "http://127.0.0.1:5/openai/v1"})})
    child = {"OPENAI_BASE_URL": "http://127.0.0.1:5/openai/v1", "OPENAI_API_KEY": "mpwp-comparator-1", "GEMINI_API_KEY": "mpwp-comparator-2"}
    up = comparator_server.upstream_from_env({"MPW_CHILD_ENV_COMPARATOR": json.dumps(child)}, model="gpt-6-luna")
    assert (up.provider, up.base_url, up.api_key, up.model) == ("openai", child["OPENAI_BASE_URL"], "mpwp-comparator-1", "gpt-6-luna")


def test_lock_pins_by_hash_without_the_plain_name():
    text = comparator_server.LOCK_PATH.read_text()
    key = names.comparator_key()
    assert key not in text.lower()
    lock, _ = comparator_server.read_lock()
    assert lock["server"]["package_sha256"] == comparator_server._sha(comparator_server.fill(lock["server"]["package"]))
    assert all(r["hashes"] for r in lock["requirements"])
    rendered = comparator_server.render_requirements(lock)
    assert f"{key}-api=={lock['version']}" in rendered
    assert "{key}" not in rendered
    assert all(m["revision"] and m["files"] for m in lock["models"].values())


@pytest.mark.parametrize("filename,keep", [
    ("numpy-2.5.3-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl", True),
    ("numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl", True),
    ("numpy-2.5.3-cp312-cp312-musllinux_1_2_x86_64.whl", False),
    ("numpy-2.5.3-cp313-cp313-manylinux_2_28_x86_64.whl", False),
    ("numpy-2.5.3-cp312-cp312-win_amd64.whl", False),
    ("cryptography-50.0.0-cp311-abi3-manylinux_2_34_aarch64.whl", True),
    ("httpx-0.28.1-py3-none-any.whl", True),
])
def test_wheel_filter(filename, keep):
    assert comparator_server.wheel_supported(filename) is keep


class _Stats(BaseHTTPRequestHandler):
    documents = 0

    def log_message(self, *_a):
        pass

    def do_GET(self):
        body = json.dumps({"total_nodes": 3, "pending_operations": 0, "failed_operations": 0,
                           "total_documents": type(self).documents}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def test_repeated_session_is_retained_once_and_a_changed_repeat_kept():
    from memory_bench.models import Document

    handler = type("H", (_Stats,), {"documents": 2})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    sent = []

    class Inner:
        drain_ms: dict = {}
        _resume = False

        @staticmethod
        def ingest(docs):
            sent.extend(docs)

        @staticmethod
        def _bank_kwargs(bank):
            return {}

    try:
        provider = ComparatorMemoryProvider({"server_url": f"http://127.0.0.1:{server.server_address[1]}", "id_salt": "s"})
        provider._inner = Inner()
        same = Document(id="s1", content="I adopted a cat.", user_id="u1")
        changed = Document(id="s1", content="I adopted a second cat.", user_id="u1")
        provider.ingest([same, same, changed])
    finally:
        server.shutdown()
    assert [d.content for d in sent] == ["I adopted a cat.", "I adopted a second cat."]
    assert len({d.id for d in sent}) == 2 and all(OPAQUE.match(d.id) for d in sent)
    assert provider.last_ingest_receipt("u1")["documents"] == 2
