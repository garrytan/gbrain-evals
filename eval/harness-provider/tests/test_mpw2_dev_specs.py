"""Memory proof wave 2: every dev, re-tune and confirmation spec sets its knobs explicitly (2026-10-11 addendum)."""
import json
from pathlib import Path

import pytest

CELLS = Path(__file__).resolve().parents[1] / "cells/mpw2"
SPECS = sorted(p for p in (CELLS / "dev").glob("*.json") if p.name != "order.json")
W5_SPECS = sorted(p for p in (CELLS / "w5").glob("*.json") if p.name != "order.json")
READ_KEYS = {"search.mode", "search.reranker.enabled", "search.reranker.model", "search.reranker.gate", "search.reranker.gate_min_gap",
             "search.query_facts_arm", "search.temporal_fact_reserve", "search.evidence_date_header", "search.entity_anchoring",
             "recall.question_admission", "search.tokenBudget", "search.page_rank_budget_ratio"}
INGEST_KEYS = {"extraction.date_grounding", "facts.attribution", "facts.supersession_thresholds"}


def test_dev_specs_exist():
    assert len([p for p in SPECS if p.parent.name == "dev"]) == 29


@pytest.mark.parametrize("path", SPECS, ids=lambda p: f"{p.parent.name}/{p.stem}")
def test_spec_sets_every_knob_and_validates(path):
    from mpw.gbrain_provider import GbrainMemoryProvider

    spec = json.loads(path.read_text())
    pc = spec["provider_config"]
    assert set(pc["search_config"]) == READ_KEYS
    assert set(pc["gbrain_config"]) == INGEST_KEYS
    assert pc["search_config"]["search.mode"] == ("conservative" if spec["lane"] == "raw" else "tokenmax")
    assert pc["search_config"]["search.reranker.enabled"] == ("false" if spec["lane"] == "raw" else "true")
    assert pc["search_config"]["search.query_facts_arm"] == "true" and pc["search_config"]["search.temporal_fact_reserve"] == "false"
    assert pc["search_config"]["search.tokenBudget"] == ("4000" if spec["lane"] == "raw" else "10000000")
    assert pc["search_config"]["search.page_rank_budget_ratio"] == ("0.4" if path.stem.endswith("-v2-w5") else "0")
    assert "extraction_model" not in pc
    if spec["lane"] != "raw":
        assert pc["extraction_source"] == "measured_default" and spec["gbrain_credentials"] == ["voyage", "anthropic"]
    GbrainMemoryProvider({"gbrain_cli": "unused", "child_env": {}, "lane": spec["lane"], **pc})


def test_w5_tuning_arms():
    from mpw.gbrain_provider import GbrainMemoryProvider

    ratios = {}
    for path in W5_SPECS:
        spec = json.loads(path.read_text())
        sc = spec["provider_config"]["search_config"]
        assert set(sc) == READ_KEYS and spec["lane"] == "filler-removed" and spec["provider_config"]["token_budget"] == 8100
        assert sc["search.tokenBudget"] == ("4000" if sc["search.mode"] == "conservative" else "10000000")
        ratios[path.stem.removeprefix("lme-")] = (sc["search.mode"], sc["search.page_rank_budget_ratio"])
        GbrainMemoryProvider({"gbrain_cli": "unused", "child_env": {}, "lane": spec["lane"], **spec["provider_config"]})
    assert ratios == {"b": ("tokenmax", "0"), "d": ("conservative", "0"), "w5-0.40": ("tokenmax", "0.4"), "w5-0.50": ("tokenmax", "0.5"),
                      "w5-0.75": ("tokenmax", "0.75"), "w5-1.00": ("tokenmax", "1")}


RETUNE = sorted(p for p in (CELLS / "retune").glob("*.json") if p.name != "order.json")
W5A_KEYS = (READ_KEYS - {"search.page_rank_budget_ratio"}) | {"search.page_rank_cut"}
STORES = {"lme": "gbrain-longmemeval-s-165df707838f", "beam-100k": "gbrain-beam-100k-6824b3680877",
          "beam-500k": "gbrain-beam-500k-8222a93c39c3", "beam-1m": "gbrain-beam-1m-5f98c3307942"}


def test_retune_arms_are_dev_v2_with_the_adaptive_w5_keys():
    from mpw.gbrain_provider import GbrainMemoryProvider

    arms = {}
    for path in RETUNE:
        group, arm = path.stem.rsplit("-", 1)
        spec = json.loads(path.read_text())
        dev = json.loads((CELLS / "dev" / f"{group}-v2.json").read_text())
        sc = spec["provider_config"].pop("search_config")
        dev_sc = dev["provider_config"].pop("search_config")
        assert spec["provider_config"] == dev["provider_config"] and spec["lane"] == "combined-v2" and spec["questions"] == dev["questions"]
        assert {k: v for k, v in sc.items() if not k.startswith("search.page_rank_cut")} == {k: v for k, v in dev_sc.items() if k != "search.page_rank_budget_ratio"}
        assert set(sc) == (W5A_KEYS if arm == "ref" else W5A_KEYS | {"search.page_rank_cut_factor"})
        assert spec["reuse_store"]["store_id"] == STORES[group] and spec["reuse_store"]["reason"]
        arms.setdefault(arm, set()).add(group)
        expect = None if arm == "ref" else float(arm[1:])
        assert GbrainMemoryProvider({"gbrain_cli": "unused", "child_env": {}, "lane": spec["lane"], **spec["provider_config"],
                                     "search_config": sc})._arm_page_rank_cut() == expect
    assert arms == {a: set(STORES) for a in ("ref", "f1.00", "f1.25", "f1.50")}


CONFIRM = sorted(p for p in (CELLS / "confirm").glob("*.json") if p.name != "order.json")
NON_DEV_UNITS = {"100k": 16, "500k": 28, "1m": 28}


def test_confirmation_arms_are_dev_arms_on_the_non_dev_data_with_w5_only_on_v2_w5():
    from mpw.gbrain_provider import GbrainMemoryProvider

    order = json.loads((CELLS / "confirm/order.json").read_text())["order"]
    assert {f"{g}-{a}.json" for g, arms in order.items() for a in arms} == {p.name for p in CONFIRM}
    lme, beam = [], {s: [] for s in NON_DEV_UNITS}
    for path in CONFIRM:
        arm = next(a for a in ("one-call", "v2-w5", "comparator", "v2", "v1", "raw") if path.stem.endswith("-" + a))
        group = path.stem[:-len(arm) - 1]
        spec = json.loads(path.read_text())
        if spec["provider"] == "comparator":
            assert spec["lane"] == "combined" and spec["seal"] == "sealed" and set(spec["provider_config"]) == {"max_tokens", "max_chunk_tokens"}
            continue
        kind = "lme" if group.startswith("lme") else "beam-" + group.split("-")[1]
        dev = json.loads((CELLS / "dev" / f"{kind}-{'one-call' if arm == 'one-call' else arm}.json").read_text())
        sc, dev_sc = spec["provider_config"].pop("search_config"), dev["provider_config"].pop("search_config")
        assert spec["provider_config"] == dev["provider_config"] and spec["lane"] == dev["lane"] and spec["models"] == dev["models"]
        assert {k: v for k, v in sc.items() if not k.startswith("search.page_rank_cut")} == {k: v for k, v in dev_sc.items() if k != "search.page_rank_budget_ratio"}
        w5 = arm == "v2-w5"
        assert sc["search.page_rank_cut"] == ("whole_pages" if w5 else "off") and "reuse_store" not in spec
        assert set(sc) == (W5A_KEYS | {"search.page_rank_cut_factor"} if w5 else W5A_KEYS) and (not w5 or sc["search.page_rank_cut_factor"] == "1.5")
        assert GbrainMemoryProvider({"gbrain_cli": "unused", "child_env": {}, "lane": spec["lane"], **spec["provider_config"],
                                     "search_config": sc})._arm_page_rank_cut() == (1.5 if w5 else None)
        if kind == "lme":
            assert spec["seal"] == "public"
            if arm == "v2":
                lme += spec["questions"]["ids"]
        else:
            assert spec["seal"] == "sealed"
            if arm == "v2":
                beam[kind.removeprefix("beam-")] += spec["questions"]["units"]
    dev_ids = set(json.loads((CELLS / "step0/lme-s-dev-comb.json").read_text())["questions"]["ids"])
    assert len(lme) == len(set(lme)) == 400 and not set(lme) & dev_ids
    dev_units = {s: set(json.loads((CELLS / "dev" / f"beam-{s}-v2.json").read_text())["questions"]["units"]) for s in NON_DEV_UNITS}
    assert {s: len(set(u)) for s, u in beam.items()} == NON_DEV_UNITS and all(not set(u) & dev_units[s] for s, u in beam.items())
    assert all(arms[-1] == "v2-w5" for g, arms in order.items() if g.startswith("beam"))
