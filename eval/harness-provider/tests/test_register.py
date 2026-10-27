import os

from mpw import register


def test_install_registers_providers_and_fixes_agentic_rag(monkeypatch):
    register.install()
    import memory_bench.memory as memory_pkg
    import memory_bench.modes as modes_pkg
    import memory_bench.llm as llm_pkg

    assert memory_pkg.REGISTRY["gbrain"].name == "gbrain"
    assert memory_pkg.REGISTRY["comparator"].name == "comparator"
    assert "anthropic" in llm_pkg.REGISTRY

    class FakeLLM:
        model_id = "fake:model"

    mode = modes_pkg.get_mode("agentic-rag", llm=FakeLLM())
    assert mode.llm_id == "fake:model"
    assert mode._rag._llm is mode._llm


def test_dotenv_is_disabled(tmp_path, monkeypatch):
    register.install()
    import dotenv

    env_file = tmp_path / ".env"
    env_file.write_text("OMB_ANSWER_MODEL=should-not-load\n")
    monkeypatch.delenv("OMB_ANSWER_MODEL", raising=False)
    dotenv.load_dotenv(dotenv_path=env_file, override=True)
    assert "OMB_ANSWER_MODEL" not in os.environ


def test_models_come_only_from_omb(monkeypatch):
    register.install()
    monkeypatch.setenv("OMB_ANSWER_LLM", "openai")
    monkeypatch.setenv("OMB_ANSWER_MODEL", "gpt-6-sol")
    monkeypatch.setenv("OMB_JUDGE_LLM", "openai")
    monkeypatch.setenv("OMB_JUDGE_MODEL", "gpt-6-luna")
    monkeypatch.setenv("OPENAI_API_KEY", "mpwp-test")
    register.assert_models("openai:gpt-6-sol", "openai:gpt-6-luna")
    monkeypatch.delenv("OMB_ANSWER_MODEL")
    try:
        register.assert_models("openai:gpt-6-sol", None)
    except RuntimeError as e:
        assert "OMB_ANSWER_MODEL" in str(e)
    else:
        raise AssertionError("missing OMB_ANSWER_MODEL must fail")
