"""The extract-first server with its searches embedding through the metering slot's read route: the bundle's shim
(shim.py, protocol v1) with a second search-only Memory over the same Qdrant collections.

Each search embeds the question and then the question's entities, a text the cost-and-speed experiment's probe label
(eval/runner/metering-proxy.ts) can't match, so in that experiment's held-back probe windows the entity embedding would
be billed as write work. Here the searches' embedder calls <slot>~read instead of <slot>: the proxy bills the read route
to the slot's own cell and labels it probe while a probe is registered (READ_ROUTE_SUFFIX). The model, the requests and
everything else are the bundle's, so the pinned bundle's files stay byte-identical. The cost-and-speed experiment
(docs/benchmarks/2026-11-24-cost-speed-preregistration.md) starts this stack (bootstrap.sh --config read-route). In the
image shim.py sits beside this file; in the repository it is one directory up.
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
_BASE = next(p for p in (os.path.join(HERE, "shim.py"), os.path.join(HERE, "..", "shim.py")) if os.path.exists(p))
_spec = importlib.util.spec_from_file_location("extract_first_shim", _BASE)
base = importlib.util.module_from_spec(_spec)
sys.modules["extract_first_shim"] = base
_spec.loader.exec_module(base)

BaseAdapter = next(v for k, v in vars(base).items() if k.endswith("Adapter") and k != "Adapter" and isinstance(v, type))


def read_base_url(url: str) -> str:
    """The read route of a metering-proxy slot base URL: .../<slot>/openai/v1 becomes .../<slot>~read/openai/v1."""
    m = re.fullmatch(r"(.*/)([^/~]+)(/openai/v1/?)", url)
    if not m:
        raise SystemExit(f"the read-route stack needs OPENAI_BASE_URL to end in /<slot>/openai/v1, not {url!r}")
    return f"{m[1]}{m[2]}~read{m[3]}"


def search_config(url: str) -> dict[str, Any]:
    """The bundle's configuration with the embedder pointed at the read route."""
    cfg = base.mem0_config()
    cfg["embedder"]["config"] = {**cfg["embedder"]["config"], "openai_base_url": read_base_url(url)}
    return cfg


class SplitMemory:
    """The bundle's Memory for everything but search, which goes to the read-route Memory."""

    def __init__(self, writer: Any, searcher: Any) -> None:
        self._writer, self._searcher = writer, searcher

    def search(self, *args: Any, **kwargs: Any) -> Any:
        return self._searcher.search(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._writer, name)


class ReadRouteAdapter(BaseAdapter):
    def __init__(self) -> None:
        cfg = search_config(os.environ.get("OPENAI_BASE_URL", ""))
        super().__init__()
        Memory = type(self.memory)
        self.memory = SplitMemory(self.memory, Memory.from_config(cfg))
        self.resolved = {**self.resolved, "read_route": True}


if __name__ == "__main__":
    base.serve(ReadRouteAdapter())
