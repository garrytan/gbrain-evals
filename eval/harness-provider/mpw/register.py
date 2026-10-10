"""Runtime registration into the pinned harness.

`install()` must run before any harness module that reads `.env`:
  - replaces `dotenv.load_dotenv` with a no-op (the harness CLI calls it with
    override=True, which would let a stray `.env` beat the resolved models);
  - adds `gbrain` and `comparator` to the harness memory-provider registry;
  - adds an `anthropic` answer/judge LLM to the harness LLM registry;
  - replaces the `agentic-rag` mode with a subclass whose constructor works
    (at the pin `AgenticRAGMode.__init__` passes `k` to `RAGMode`, which
    rejects it, and defaults to a hard-coded Gemini model instead of the
    resolved answer model).

Models are chosen only through OMB_ANSWER_LLM / OMB_ANSWER_MODEL and
OMB_JUDGE_LLM / OMB_JUDGE_MODEL, which the launcher sets from the cell's
resolved model ids. `assert_models()` checks the harness resolves exactly those.
"""
from __future__ import annotations

import os

_installed = False


def _disable_dotenv() -> None:
    import dotenv
    import dotenv.main

    def _no_dotenv(*_args, **_kwargs) -> bool:
        return False

    dotenv.load_dotenv = _no_dotenv
    dotenv.main.load_dotenv = _no_dotenv
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"


def _stable_dataset_cache() -> None:
    """Keep downloaded datasets under MPW_DATASET_CACHE, outside the venv, so a rebuilt venv reuses them."""
    root = os.environ.get("MPW_DATASET_CACHE")
    if not root:
        return
    import importlib
    import pkgutil
    from pathlib import Path

    import memory_bench.dataset as ds_pkg
    import memory_bench.dataset._cache as cache_mod

    def dataset_cache_dir(name: str) -> Path:
        path = Path(root) / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    cache_mod.dataset_cache_dir = dataset_cache_dir
    for info in pkgutil.iter_modules(ds_pkg.__path__):
        mod = importlib.import_module(f"memory_bench.dataset.{info.name}")
        if hasattr(mod, "dataset_cache_dir"):
            mod.dataset_cache_dir = dataset_cache_dir


def _fixed_agentic_rag():
    from memory_bench.modes.agentic_rag import AgenticRAGMode
    from memory_bench.modes.rag import RAGMode

    class FixedAgenticRAGMode(AgenticRAGMode):
        """AgenticRAGMode with a constructor that runs and uses the resolved answer model."""

        def __init__(self, llm=None, k: int = 10):
            from memory_bench.llm import get_answer_llm

            self._llm = llm or get_answer_llm()
            self._rag = RAGMode(llm=self._llm)
            self.k = k

    return FixedAgenticRAGMode


def _numeric_locomo_sessions() -> None:
    """Order LoCoMo sessions by number, as the pinned LifeBench loader does.

    The pinned LoCoMo loader sorts session keys as strings, so session_9 sorts last and becomes
    every conversation's question date. Both systems read queries through this one loader.
    """
    from memory_bench.dataset.locomo import LoComoDataset

    LoComoDataset._session_keys = staticmethod(lambda conv: sorted(
        (k for k in conv
         if k.startswith("session_") and not k.endswith("_date_time") and isinstance(conv[k], list)),
        key=lambda k: int(k.split("_", 1)[1]),
    ))


def install() -> None:
    global _installed
    if _installed:
        return
    _disable_dotenv()
    _stable_dataset_cache()
    _numeric_locomo_sessions()

    import memory_bench.llm as llm_pkg
    import memory_bench.memory as memory_pkg
    import memory_bench.modes as modes_pkg

    from .anthropic_llm import AnthropicLLM

    llm_pkg.REGISTRY["anthropic"] = AnthropicLLM
    modes_pkg.REGISTRY["agentic-rag"] = _fixed_agentic_rag()

    from .comparator_provider import ComparatorMemoryProvider
    from .gbrain_provider import GbrainMemoryProvider

    memory_pkg.REGISTRY["gbrain"] = GbrainMemoryProvider
    memory_pkg.REGISTRY["comparator"] = ComparatorMemoryProvider
    from .fullcontext_provider import FullContextProvider

    memory_pkg.REGISTRY["full-context"] = FullContextProvider
    _installed = True


def resolved_model_ids() -> dict[str, str]:
    """The `provider:model` ids the harness resolves from OMB_* right now."""
    from memory_bench.llm import get_answer_llm, get_judge_llm

    return {"answer": get_answer_llm().model_id, "judge": get_judge_llm().model_id}


def assert_models(expected_answer: str, expected_judge: str | None) -> None:
    """Fail unless OMB_* resolves to the cell's model ids (no harness default slipped in)."""
    for role in ("ANSWER", "JUDGE"):
        if role == "JUDGE" and expected_judge is None:
            continue
        for suffix in ("LLM", "MODEL"):
            if not os.environ.get(f"OMB_{role}_{suffix}"):
                raise RuntimeError(f"OMB_{role}_{suffix} is not set; the harness would fall back to its default {role.lower()} model")
    got = resolved_model_ids()
    if got["answer"] != expected_answer:
        raise RuntimeError(f"answer model resolves to {got['answer']}, the cell says {expected_answer}")
    if expected_judge is not None and got["judge"] != expected_judge:
        raise RuntimeError(f"judge model resolves to {got['judge']}, the cell says {expected_judge}")
