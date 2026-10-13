"""Memory proof wave 2: the mode isolation on LongMemEval-S dev (exploratory, 2026-10-11 addendum).

    python3 eval/harness-provider/mpw2-iso-specs.py

Every arm reads the measured-default LongMemEval-S dev store at the dev pin with the explicit knob set of
`mpw2-dev-specs.py`, then changes one tokenmax component to its conservative value. `iso-b` (tokenmax) runs first and
builds the store, so the store's pages are embedded under tokenmax's inline contextual-retrieval tier, as step 0's
combined store was.
"""
import json
import runpy
from pathlib import Path

HERE = Path(__file__).resolve().parent
dev = runpy.run_path(str(HERE / "mpw2-dev-specs.py"))
OUT = HERE / "cells/mpw2/iso"

ARMS = {
    "b": ("tokenmax", {}),
    "d": ("conservative", {}),
    "comb": ("tokenmax", {}),
    "t-rerank-off": ("tokenmax", {"search.reranker.enabled": "false"}),
    "t-limit-10": ("tokenmax", {"search.searchLimit": "10"}),
    "t-relational-off": ("tokenmax", {"search.relational_retrieval": "false", "search.relational_planner": "false"}),
    "t-graph-off": ("tokenmax", {"search.graph_signals": "false"}),
    "t-cr-none": ("tokenmax", {"search.contextual_retrieval": "none"}),
    "c-rerank-on": ("conservative", {"search.reranker.enabled": "true"}),
}
CAP_USD = 23

# The two-way tokenBudget test (2026-10-11 addendum), on a rebuilt store of the same identity. `search.tokenBudget`
# accepts only a positive integer, so "unset" is a budget no ranked list reaches.
ARMS2 = {
    "b": ("tokenmax", {}),
    "d": ("conservative", {}),
    "t-tb-4000": ("tokenmax", {"search.tokenBudget": "4000"}),
    "c-tb-unset": ("conservative", {"search.tokenBudget": "10000000"}),
}
CAP2_USD = 16

# W5 dev tuning (re-scope addendum): the knob table with `search.tokenBudget` and W5's ratio, at the W5 pin.
ARMS3 = {
    "b": ("tokenmax", None),
    "d": ("conservative", None),
    **{f"w5-{r:.2f}": ("tokenmax", r) for r in (0.40, 0.50, 0.75, 1.00)},
}
CAP3_USD = 18

def write(out: Path, prefix: str, arms: dict, cap: int, label: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for i, (arm, (mode, flips)) in enumerate(arms.items()):
        spec = dev["spec"]("lme", "v1" if arm == "comb" else "filler")
        pc = spec["provider_config"]
        pc["search_config"] = {**dev["read_knobs"](mode), **flips}
        spec["budget_usd"] = 12 if i == 0 else 2
        spec["note"] = f"memory proof wave 2 {label} (exploratory), arm {arm}: see the 2026-10-11 addendum"
        (out / f"{prefix}-{arm}.json").write_text(json.dumps(spec, indent=1) + "\n")
    (out / "order.json").write_text(json.dumps({"cap_usd": cap, "order": list(arms)}, indent=1) + "\n")


def write_w5(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for i, (arm, (mode, ratio)) in enumerate(ARMS3.items()):
        spec = dev["spec"]("lme", "filler")
        spec["provider_config"]["search_config"] = dev["read_knobs_v2"](mode, ratio=ratio)
        spec["budget_usd"] = 12 if i == 0 else 2
        spec["note"] = f"memory proof wave 2 W5 dev tuning (exploratory), arm {arm}: see the 2026-10-11 re-scope addendum"
        (out / f"lme-{arm}.json").write_text(json.dumps(spec, indent=1) + "\n")
    (out / "order.json").write_text(json.dumps({"cap_usd": CAP3_USD, "order": list(ARMS3)}, indent=1) + "\n")


if __name__ == "__main__":
    write(OUT, "lme-iso", ARMS, CAP_USD, "mode isolation")
    write(HERE / "cells/mpw2/iso2", "lme-tb", ARMS2, CAP2_USD, "tokenBudget two-way test")
    write_w5(HERE / "cells/mpw2/w5")
