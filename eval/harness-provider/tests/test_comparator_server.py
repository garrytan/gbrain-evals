"""The pinned comparator release end to end against a local stub LLM.

Needs the installed server (`python -m mpw.comparator_server install`, about
2 GB with CPU torch and the local model weights); skipped unless
MPW_REQUIRE_HARNESS=1. Every LLM call goes to the in-process stub; the
server's embeddings and reranker run locally on CPU with Hugging Face offline.
"""
import json
import math
import os
import re
import signal

import pytest

from mpw import comparator_server
from mpw.comparator_provider import ComparatorMemoryProvider

from stub_llm import StubUpstream

pytestmark = pytest.mark.skipif(os.environ.get("MPW_REQUIRE_HARNESS") != "1", reason="set MPW_REQUIRE_HARNESS=1 to run the pinned comparator server")

OPAQUE = re.compile(r"^c-[0-9a-f]{12}$")
TOKEN = "mpwp-comparator-test"


@pytest.fixture(scope="module")
def install():
    return comparator_server.ensure_installed()


@pytest.fixture
def stub():
    s = StubUpstream().start()
    yield s
    s.close()


@pytest.fixture
def upstream_env(stub, monkeypatch):
    monkeypatch.setenv("MPW_CHILD_ENV_COMPARATOR", json.dumps({"OPENAI_BASE_URL": f"{stub.url}/v1", "OPENAI_API_KEY": TOKEN}))
    return stub


def _docs():
    from memory_bench.models import Document

    return [
        Document(id="d-1a2b3c_answer_d61669c7_7_", user_id="u-alpha", timestamp="2023-03-05T10:00:00Z",
                 content="User: I adopted a beagle named Rex in March 2023.\nAssistant: Congratulations on Rex!"),
        Document(id="d-4d5e6f", user_id="u-alpha", timestamp="2023-04-01T10:00:00Z", context="Session d-4d5e6f with u-alpha",
                 content="User: My favourite colour is teal and I live in Lisbon."),
        Document(id="d-7a8b9c", user_id="u-beta", timestamp="2023-05-01T10:00:00Z",
                 content="User: I work as a night-shift nurse in Toronto."),
    ]


def test_ingest_retrieve_isolation_and_reaping(install, upstream_env, tmp_path):
    stub = upstream_env
    store = tmp_path / "longmemeval" / "comparator" / "_store" / "s" / "all"
    config = {"data_dir": str(tmp_path / "server"), "max_tokens": 2048, "max_chunk_tokens": 1024}
    provider = ComparatorMemoryProvider(config)
    docs = _docs()
    try:
        provider.prepare(store, unit_ids={"u-alpha", "u-beta"})
        home = provider._server.home
        assert comparator_server.processes_under(home), "server and embedded database should be running"
        receipt = provider.receipt()
        assert receipt["version"] == install.version and receipt["unmetered"] == []
        assert receipt["metered"][0]["model"] == install.defaults["llm_model"]

        provider.ingest(docs)
        receipt = provider.last_ingest_receipt("u-alpha")
        assert receipt["documents"] == 2 and receipt["facts"] >= 2 and receipt["extraction_calls_expected"] == 2
        assert receipt["bank_config"]["enable_observations"] is False
        assert receipt["server"]["version"] == install.version
        chats = stub.chat_requests()
        assert len(chats) == len(docs), "one extraction call per short document"
        assert {r["auth"] for r in chats} == {f"Bearer {TOKEN}"}
        assert {r["body"]["model"] for r in chats} == {install.defaults["llm_model"]}
        assert not [r for r in stub.requests if r["path"].endswith("/embeddings")], "embeddings run locally"
        for r in chats:
            for d in docs:
                assert d.id not in json.dumps(r["body"]), "the server only sees opaque document ids"
            assert "u-alpha" not in json.dumps(r["body"]) and "u-beta" not in json.dumps(r["body"])

        for user, own in (("u-alpha", {"d-1a2b3c_answer_d61669c7_7_", "d-4d5e6f"}), ("u-beta", {"d-7a8b9c"})):
            got, raw, meta = provider.retrieve_with_meta("where do I live and what pet do I have?", user_id=user,
                                                         query_timestamp="2023-06-01T00:00:00Z")
            assert got and meta["facts"] >= 1 and meta["chunks"] >= 1
            assert meta["max_tokens"] == 2048 and meta["max_chunk_tokens"] == 1024 and meta["include_chunks"]
            assert OPAQUE.match(meta["bank"])
            for d in got:
                assert OPAQUE.match(d.id)
                assert d.source_ids and all(OPAQUE.match(s) for s in d.source_ids)
            reverse = provider.reverse_ids()
            assert {reverse[s] for d in got for s in d.source_ids} <= own
            dumped = json.dumps(raw) + "".join(d.content for d in got)
            for d in docs:
                assert d.id not in dumped and "d61669c7" not in dumped
            assert user not in dumped
            other = "u-beta" if user == "u-alpha" else "u-alpha"
            assert provider._bank_id(other) not in dumped

        assert len(stub.chat_requests()) == len(docs), "recall makes no LLM calls"
        with pytest.raises(RuntimeError, match="never ingested"):
            provider.retrieve("anything", user_id="u-gamma")
        first_ids = sorted(s for d in provider.retrieve("pet", user_id="u-alpha")[0] for s in d.source_ids)
    finally:
        provider.cleanup()
    assert comparator_server.processes_under(home) == []

    # a resumed cell: a new process on the same data directory keeps banks, salt and ids
    resumed = ComparatorMemoryProvider(config)
    try:
        resumed.prepare(store, unit_ids={"u-alpha", "u-beta"}, reset=False)
        got = resumed.retrieve("pet", user_id="u-alpha")[0]
        assert sorted(s for d in got for s in d.source_ids) == first_ids
        assert resumed.last_ingest_receipt("u-alpha")["documents"] == 2
        assert {resumed.reverse_ids()[s] for s in first_ids} <= {"d-1a2b3c_answer_d61669c7_7_", "d-4d5e6f"}
        resumed.reset_unit("u-beta")
        with pytest.raises(RuntimeError, match="never ingested"):
            resumed.retrieve("job", user_id="u-beta")
        resumed.ingest([docs[2]])
        assert resumed.last_ingest_receipt("u-beta")["documents"] == 1
    finally:
        resumed.cleanup()
    assert comparator_server.processes_under(home) == []


def test_extraction_calls_per_document_follow_the_chunk_size(install, upstream_env, tmp_path):
    from memory_bench.models import Document

    stub = upstream_env
    chunk = install.defaults["retain_chunk_size"]
    turns = [f"User: on day {i} I walked {i} kilometres along the river and wrote it down.\nAssistant: Noted, day {i}." for i in range(160)]
    content = "\n".join(turns)
    provider = ComparatorMemoryProvider({"id_salt": "s", "data_dir": str(tmp_path / "server")})
    try:
        provider.prepare(tmp_path / "beam" / "comparator" / "_store" / "s" / "all", unit_ids={"u1"})
        provider.ingest([Document(id="d-long", user_id="u1", timestamp="2023-01-01T00:00:00Z", content=content)])
    finally:
        provider.cleanup()
    calls = len(stub.chat_requests())
    print(f"\n{len(content)} chars, chunk size {chunk} chars -> {calls} extraction calls")
    assert calls >= math.ceil(len(content) / chunk)
    assert calls <= math.ceil(len(content) / chunk) + 1


def test_server_killed_hard_still_leaves_nothing_running(install, stub, tmp_path):
    up = comparator_server.Upstream("openai", f"{stub.url}/v1", TOKEN)
    server = comparator_server.ComparatorServer(tmp_path / "server", up, install=install).start()
    home = server.home
    assert server.proc.poll() is None
    assert comparator_server.processes_under(home), "the embedded database runs from the isolated HOME"
    os.killpg(server.proc.pid, signal.SIGKILL)
    server.proc.wait(30)
    assert comparator_server.processes_under(home), "the embedded database outlives a SIGKILL of the server"
    server.stop()
    assert comparator_server.processes_under(home) == []


def test_startup_failure_reaps(install, stub, tmp_path):
    up = comparator_server.Upstream("openai", f"{stub.url}/v1", TOKEN)
    server = comparator_server.ComparatorServer(tmp_path / "server", up, install=install, startup_timeout_s=0.5)
    with pytest.raises(RuntimeError, match="not healthy"):
        server.start()
    assert server.proc is None
    assert comparator_server.processes_under(server.home) == []
