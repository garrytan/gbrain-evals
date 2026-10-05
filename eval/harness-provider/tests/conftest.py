import sys
import types

import pytest

from mpw import register

register.install()


@pytest.fixture
def stub_models(monkeypatch):
    import memory_bench.llm as llm_pkg
    from mpw.stub_llm import StubLLM

    llm_pkg.REGISTRY["mpw-stub"] = StubLLM
    for role in ("ANSWER", "JUDGE"):
        monkeypatch.setenv(f"OMB_{role}_LLM", "mpw-stub")
        monkeypatch.setenv(f"OMB_{role}_MODEL", f"{role.lower()}-1")
    return {"answer": "mpw-stub:answer-1", "judge": "mpw-stub:judge-1"}
