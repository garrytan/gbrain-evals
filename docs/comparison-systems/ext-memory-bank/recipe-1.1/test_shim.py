"""Protocol v1 smoke test for the recipe-1.1 shim: the 0.10.2 bundle's ../test_shim.py, unchanged, run against a
record whose only configuration is recipe-1.1 (stdlib only).

The pinned test requires the recipe and common configurations, which belong to the 0.10.2 build. This wrapper checks
that the record holds exactly recipe-1.1 instead and runs every other step as written.

    python3 docs/comparison-systems/ext-memory-bank/recipe-1.1/test_shim.py --url http://127.0.0.1:8700

Under pytest, the three tests below check the wrapper itself offline.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import urllib.request

spec = importlib.util.spec_from_file_location("pinned_test_shim", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_shim.py"))
pinned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pinned)
PINNED_CONFIG_CHECK = "configs must include recipe and common"
pinned_check = pinned.check


def check(cond: bool, msg: str) -> None:
    if msg != PINNED_CONFIG_CHECK:
        pinned_check(cond, msg)


def main() -> int:
    url = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else "http://127.0.0.1:8700"
    with urllib.request.urlopen(url.rstrip("/") + "/capabilities", timeout=60) as r:
        configs = sorted(json.loads(r.read())["configs"])
    if configs != ["recipe-1.1"]:
        pinned.log("FAIL", error=f"configs must be exactly ['recipe-1.1'], got {configs}")
        return 1
    pinned.check = check
    return pinned.main()


def test_check_skips_only_the_pinned_config_assertion(monkeypatch) -> None:
    seen: list[tuple[bool, str]] = []
    monkeypatch.setitem(globals(), "pinned_check", lambda cond, msg: seen.append((cond, msg)))
    check(False, PINNED_CONFIG_CHECK)
    check(False, "fixed-evidence: no items returned")
    check(True, "protocol must be 1")
    assert seen == [(False, "fixed-evidence: no items returned"), (True, "protocol must be 1")]


class _Capabilities:
    def __init__(self, configs: list[str]) -> None:
        self.body = json.dumps({"configs": configs}).encode()

    def __enter__(self) -> "_Capabilities":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def test_main_refuses_a_record_that_is_not_only_recipe_11(monkeypatch) -> None:
    logged: list[tuple[str, dict]] = []
    monkeypatch.setattr(sys, "argv", ["test_shim.py", "--url", "http://shim.invalid"])
    monkeypatch.setattr(urllib.request, "urlopen", lambda url, timeout: _Capabilities(["common", "recipe", "recipe-1.1"]))
    monkeypatch.setattr(pinned, "log", lambda step, **kw: logged.append((step, kw)))
    monkeypatch.setattr(pinned, "main", lambda: (_ for _ in ()).throw(AssertionError("pinned test must not run")))
    assert main() == 1
    assert logged and logged[0][0] == "FAIL"


def test_main_runs_the_pinned_test_with_the_wrapped_check(monkeypatch) -> None:
    urls: list[str] = []
    monkeypatch.setattr(sys, "argv", ["test_shim.py", "--url", "http://shim.invalid/"])
    monkeypatch.setattr(urllib.request, "urlopen", lambda url, timeout: urls.append(url) or _Capabilities(["recipe-1.1"]))
    monkeypatch.setattr(pinned, "check", pinned_check)
    monkeypatch.setattr(pinned, "main", lambda: 0 if pinned.check is check else 2)
    assert main() == 0
    assert urls == ["http://shim.invalid/capabilities"]


if __name__ == "__main__":
    sys.exit(main())
