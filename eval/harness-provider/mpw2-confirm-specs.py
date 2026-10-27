"""Memory proof wave 2, stage 3 (confirmation, counted): write the BEAM and LongMemEval-S confirmation specs.

    python3 eval/harness-provider/mpw2-confirm-specs.py

Every gbrain arm is its dev spec at the adaptive W5 pin with the re-tune's knob table (`read_knobs_w5a`): W5 off
except `v2-w5`, which runs `whole_pages` at the re-tune's picked factor (`W5_PICK`; no `v2-w5` spec while it is None).
One VM and one ledger per group, and each group's first cell builds the store its other gbrain cells share
(`raw` builds its own). LongMemEval-S runs as wave 1's four shards of 100 histories, so its comparator answers
from wave 1 cover the same 400 questions. BEAM is the 72 non-dev conversations, with BEAM-500K and BEAM-1M in two
groups of 14. The comparator's BEAM cells are regenerated from `mpw-sealed-specs.py` on the same groups. `confirm-smoke/` holds the comparator's keyless smoke, the BEAM-100K comparator spec on dev
conversation 3, which runs against the stub upstream before any paid comparator cell.
"""
import json
import runpy
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
dev = runpy.run_path(str(HERE / "mpw2-dev-specs.py"))
retune = runpy.run_path(str(HERE / "mpw2-retune-specs.py"))
sealed = runpy.run_path(str(HERE / "mpw-sealed-specs.py"))
OUT = HERE / "cells/mpw2/confirm"

W5_PICK: float | None = 1.5
LME_400 = json.loads((REPO / "docs/benchmarks/2026-10-09-memory-proof-wave-matched/cells/longmemeval-s-comparator-rag-d7a615c1cd51/spec.json")
                     .read_text())["questions"]["ids"]
NON_DEV = {
    "100k": ["1", "2", "4", "5", "6", "7", "8", "9", "10", "13", "14", "16", "17", "18", "19", "20"],
    "500k": ["1", "2", "3", "4", "5", "6", "7", "10", "11", "13", "14", "15", "16", "17", "18", "19", "20", "22", "23", "24",
             "25", "26", "27", "29", "30", "32", "33", "34"],
    "1m": ["2", "3", "4", "5", "7", "8", "9", "10", "11", "12", "13", "14", "15", "17", "18", "19", "20", "23", "24", "27",
           "28", "29", "30", "31", "32", "33", "34", "35"],
}
GROUPS = {
    **{f"lme-{k + 1}": ("lme", {"ids": LME_400[100 * k:100 * (k + 1)]}) for k in range(4)},
    "beam-100k": ("beam-100k", {"units": NON_DEV["100k"]}),
    **{f"beam-{s}-{k + 1}": (f"beam-{s}", {"units": NON_DEV[s][14 * k:14 * (k + 1)]}) for s in ("500k", "1m") for k in range(2)},
}
# Per-cell caps (USD): expected spend plus reservation headroom; the first cell of a store pays its ingest.
BUDGET = {
    "lme": {"v2": 18, "v1": 6, "one-call": 6, "raw": 8},
    "beam-100k": {"v2": 16, "v1": 15, "v2-w5": 15},
    "beam-500k": {"v2": 20, "v1": 14, "v2-w5": 14},
    "beam-1m": {"v2": 24, "v1": 15, "v2-w5": 15},
}
COMPARATOR_BUDGET = {"beam-100k": 20, "beam-500k": 35, "beam-1m": 55}
# The comparator's first BEAM-100K cell ran before the runner kept custody copies of aggregates-only cells, so its
# per-question rows went with its VM. This second cell of the same group (a new budget, so a new cell id) is the one
# the joint re-judge reads (confirmation run addendum).
REPEATS = {"comparator-beam-100k-r2": ("beam-100k", 21)}
EXPECTED = {"lme": 15.5, "beam-100k": 25, "beam-500k": 27, "beam-1m": 32.5, "comparator-beam-100k": 8, "comparator-beam-500k": 17,
            "comparator-beam-1m": 34}


def gbrain_spec(group: str, arm: str) -> dict:
    kind, questions = GROUPS[group]
    s = dev["spec"](kind, "v2" if arm == "v2-w5" else arm)
    s["provider_config"]["search_config"] = retune["read_knobs_w5a"]("conservative" if arm == "raw" else "tokenmax",
                                                                     factor=W5_PICK if arm == "v2-w5" else None)
    s |= {"seal": "public" if kind == "lme" else "sealed", "questions": questions, "budget_usd": BUDGET[kind][arm],
          "note": f"memory proof wave 2 confirmation (counted), {group} arm {arm}: see the go and adaptive W5 pin addenda (2026-10-12)"}
    return s


def comparator_spec(group: str, budget: float | None = None) -> dict:
    kind, questions = GROUPS[group]
    split = kind.removeprefix("beam-")
    s = sealed["specs"]({f"beam/{x}": questions["units"] if x == split else [] for x in ("100k", "500k", "1m")}, False)[f"sealed-beam-{split}-comparator"]
    s |= {"budget_usd": budget or COMPARATOR_BUDGET[kind], "note": f"memory proof wave 2 confirmation (counted), comparator BEAM regeneration, {group}"}
    return s


def arms(group: str) -> list[str]:
    if group.startswith("lme"):
        return ["v2", "v1", "one-call", "raw"]
    return ["v2", "v1"] + (["v2-w5"] if W5_PICK is not None else [])


ORDER = {**{g: arms(g) for g in GROUPS}, **{f"comparator-{g}": ["comparator"] for g in GROUPS if g.startswith("beam")}, **{g: ["comparator"] for g in REPEATS}}


def cap(group: str) -> float:
    if group in REPEATS:
        return REPEATS[group][1]
    kind = GROUPS[group.removeprefix("comparator-")][0]
    if group.startswith("comparator-"):
        return COMPARATOR_BUDGET[kind]
    share = len(GROUPS[group][1].get("ids") or GROUPS[group][1]["units"]) / {"lme": 100, "beam-100k": 16, "beam-500k": 14, "beam-1m": 14}[kind]
    return round(EXPECTED[kind] * share + max(BUDGET[kind][a] for a in arms(group)), 2)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    for group, group_arms in ORDER.items():
        for arm in group_arms:
            spec = (comparator_spec(*REPEATS[group]) if group in REPEATS else comparator_spec(group.removeprefix("comparator-"))) if arm == "comparator" else gbrain_spec(group, arm)
            (OUT / f"{group}-{arm}.json").write_text(json.dumps(spec, indent=1) + "\n")
    smoke = sealed["specs"]({"beam/100k": ["3"], "beam/500k": [], "beam/1m": []}, False)["sealed-beam-100k-comparator"]
    smoke |= {"seal": "dev", "budget_usd": 10, "note": "memory proof wave 2 confirmation: the comparator's keyless stub-upstream smoke on BEAM-100K dev conversation 3"}
    (HERE / "cells/mpw2/confirm-smoke").mkdir(exist_ok=True)
    (HERE / "cells/mpw2/confirm-smoke/comparator-beam-100k-dev3.json").write_text(json.dumps(smoke, indent=1) + "\n")
    (OUT / "order.json").write_text(json.dumps({"caps_usd": {g: cap(g) for g in ORDER}, "order": ORDER}, indent=1) + "\n")
