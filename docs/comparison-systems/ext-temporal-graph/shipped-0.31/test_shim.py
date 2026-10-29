"""Protocol v1 smoke test for the shipped-0.31 shim: the pinned bundle's ../test_shim.py, unchanged, run against a
record whose only configuration is shipped-0.31 (stdlib only).

The pinned test requires the recipe and common configurations, which belong to the 0.30.2 build. This wrapper checks
that the record holds exactly shipped-0.31 instead and runs every other step as written.

    python3 docs/comparison-systems/ext-temporal-graph/shipped-0.31/test_shim.py --url http://127.0.0.1:8700
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
    if configs != ["shipped-0.31"]:
        pinned.log("FAIL", error=f"configs must be exactly ['shipped-0.31'], got {configs}")
        return 1
    pinned.check = check
    return pinned.main()


if __name__ == "__main__":
    sys.exit(main())
