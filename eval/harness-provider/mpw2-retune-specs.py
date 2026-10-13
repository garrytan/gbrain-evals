"""Memory proof wave 2: the adaptive W5 re-tune on LongMemEval-S dev and BEAM dev (exploratory, go addendum).

    python3 eval/harness-provider/mpw2-retune-specs.py

Every arm is dev's `v2` cell (`combined-v2`, the full knob table) at the adaptive W5 pin, with W5's two keys in place
of the fixed-ratio key: `ref` sets `search.page_rank_cut: off`, and each `f<factor>` arm sets `whole_pages` with
that `search.page_rank_cut_factor`. Each group reads its dev store through `reuse_store`: the gbrain diff from the dev
pin touches no ingest, extraction, embedding, schema or migration code (pin addendum).
"""
import json
import runpy
from pathlib import Path

HERE = Path(__file__).resolve().parent
dev = runpy.run_path(str(HERE / "mpw2-dev-specs.py"))
OUT = HERE / "cells/mpw2/retune"

FACTORS = {"ref": None, "f1.00": 1.0, "f1.25": 1.25, "f1.50": 1.5}
STORES = {"lme": "gbrain-longmemeval-s-165df707838f", "beam-100k": "gbrain-beam-100k-6824b3680877",
          "beam-500k": "gbrain-beam-500k-8222a93c39c3", "beam-1m": "gbrain-beam-1m-5f98c3307942"}
BUDGET = {"lme": 2, "beam-100k": 4, "beam-500k": 7, "beam-1m": 7}
CAPS = {"lme": 10, "beam-100k": 10, "beam-500k": 16, "beam-1m": 18}
REUSE_REASON = ("dev store from gbrain fe9e0397b; the diff to 71b6d85 touches no ingest, extraction, embedding, schema "
                "or migration code (2026-10-12 adaptive W5 pin addendum)")


def w5_knobs(factor: float | None) -> dict:
    """W5 at the adaptive pin: `off`, or `whole_pages` with its factor."""
    return {"search.page_rank_cut": "off"} if factor is None else {"search.page_rank_cut": "whole_pages", "search.page_rank_cut_factor": f"{factor:g}"}


def read_knobs_w5a(mode: str, admission: str = "reserve", factor: float | None = None) -> dict:
    """`read_knobs_v2`'s table with W5's adaptive keys in place of `search.page_rank_budget_ratio`."""
    knobs = {k: v for k, v in dev["read_knobs_v2"](mode, admission).items() if k != "search.page_rank_budget_ratio"}
    return {**knobs, **w5_knobs(factor)}


def spec(group: str, arm: str) -> dict:
    s = dev["spec"](group, "v2")
    s["provider_config"]["search_config"] = read_knobs_w5a("tokenmax", factor=FACTORS[arm])
    s["budget_usd"] = BUDGET[group]
    s["reuse_store"] = {"store_id": STORES[group], "reason": REUSE_REASON}
    s["note"] = f"memory proof wave 2 adaptive W5 re-tune, {group} arm {arm}: see the go and adaptive W5 pin addenda (2026-10-12)"
    return s


ORDER = {g: list(FACTORS) for g in STORES}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for group, arms in ORDER.items():
        for arm in arms:
            (OUT / f"{group}-{arm}.json").write_text(json.dumps(spec(group, arm), indent=1) + "\n")
    (OUT / "order.json").write_text(json.dumps({"caps_usd": CAPS, "order": ORDER}, indent=1) + "\n")
