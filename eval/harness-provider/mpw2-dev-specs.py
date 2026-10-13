"""Memory proof wave 2, stage 2 (dev): write the dev cell specs.

    python3 eval/harness-provider/mpw2-dev-specs.py

Every gbrain spec sets the read-time knobs (`search_config`) and the ingest knobs (`gbrain_config`) explicitly, as
the 2026-10-11 addendum requires, so no cell depends on the pinned build's defaults. One VM and one ledger per
group (`dev-lme`, `dev-locomo`, `dev-beam-100k`, `dev-beam-500k`, `dev-beam-1m`); `ORDER` lists each group's specs
in run order, store-building cell first. The re-scope addendum's plan: no gpt-6-luna rows, a `combined-v2+w5` arm
(`v2-w5`, W5 at the ratio the W5 dev tuning picked) on each BEAM split, and the LongMemEval-S group on the W5 tuning
store, so its first cell pays no ingest.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "cells/mpw2/dev"
LME_IDS = json.loads((HERE / "cells/mpw2/step0/lme-s-dev-comb.json").read_text())["questions"]["ids"]
MODELS = {"answer": "gemini:gemini-3.8-flash", "judge": "gemini:gemini-3.5-flash"}
EMBED = {"embedding_model": "voyage:voyage-4", "embedding_dimensions": 1024}

W5_RATIO = 0.40
INGEST_KNOBS = {"extraction.date_grounding": "true", "facts.attribution": "true",
                "facts.supersession_thresholds": json.dumps({"voyage:voyage-4@1024": 0.95})}


def read_knobs(mode: str, admission: str = "reserve") -> dict:
    rerank = mode == "tokenmax"
    return {"search.mode": mode, "search.reranker.enabled": str(rerank).lower(), "search.reranker.model": "voyage:rerank-2.5",
            "search.reranker.gate": "off", "search.reranker.gate_min_gap": "0.05", "search.query_facts_arm": "true",
            "search.temporal_fact_reserve": "false", "search.evidence_date_header": "false", "search.entity_anchoring": "false",
            "recall.question_admission": admission}


def read_knobs_v2(mode: str, admission: str = "reserve", ratio: float | None = None) -> dict:
    """The re-scope addendum's knob table: `read_knobs` plus the mode's `search.tokenBudget` (10000000 stands for
    tokenmax's unset budget) and W5's `search.page_rank_budget_ratio` (0 is off)."""
    return {**read_knobs(mode, admission), "search.tokenBudget": "4000" if mode == "conservative" else "10000000",
            "search.page_rank_budget_ratio": "0" if ratio is None else f"{ratio:g}"}


DATASETS = {
    "lme": {"dataset": "longmemeval", "split": "s", "questions": {"ids": LME_IDS}, "facts_tokens": 1800, "extra": {}},
    "locomo": {"dataset": "locomo", "split": "locomo10", "questions": {"units": ["conv-42", "conv-44"]}, "facts_tokens": 1800, "extra": {}},
    "beam-100k": {"dataset": "beam", "split": "100k", "questions": {"units": ["3", "11"]}, "facts_tokens": 600,
                  "extra": {"page_split": "exchanges"}, "cost_matched": 7560},
    "beam-500k": {"dataset": "beam", "split": "500k", "questions": {"units": ["12", "21", "28", "31"]}, "facts_tokens": 600,
                  "extra": {"page_split": "exchanges"}, "cost_matched": 7665},
    "beam-1m": {"dataset": "beam", "split": "1m", "questions": {"units": ["16", "21", "22", "25"]}, "facts_tokens": 600,
                "extra": {"page_split": "exchanges"}, "cost_matched": 7846},
}

# Per-cell caps (USD). The first cell of a store pays its ingest.
BUDGET = {
    "lme": {"v2": 2, "raw": 4, "v2-facts-arm": 2, "v1": 2, "filler": 2, "one-call": 2},
    "locomo": {"v2": 7, "raw": 6, "v2-facts-arm": 9, "v1": 9, "one-call": 9},
    "beam-100k": {a: 4 for a in ("v2", "v2-w5", "v2-facts-arm", "v1", "one-call", "cost-matched")},
    "beam-500k": {a: 7 for a in ("v2", "v2-w5", "v2-facts-arm", "v1", "one-call", "cost-matched")},
    "beam-1m": {"v2": 10, **{a: 7 for a in ("v2-w5", "v2-facts-arm", "v1", "one-call", "cost-matched")}},
}
# Budgets are reservation headroom: the metering proxy reserves each in-flight call's worst case (about $0.37 per
# judge call), so a cell needs several times its actual spend (2026-10-12 sizing addendum).
CAPS = {"lme": 12, "locomo": 39, "beam-100k": 14, "beam-500k": 28, "beam-1m": 34}


def spec(group: str, arm: str) -> dict:
    d = DATASETS[group]
    measured = {"extraction_source": "measured_default"}
    facts_cfg = {**EMBED, "facts_limit": 100, **d["extra"], "gbrain_config": INGEST_KNOBS}
    if arm == "raw":
        lane, pc, creds = "raw", {**EMBED, "token_budget": 8100, "gbrain_config": INGEST_KNOBS, "search_config": read_knobs_v2("conservative")}, ["voyage"]
    else:
        lane = {"v2": "combined-v2", "v2-w5": "combined-v2", "v2-facts-arm": "combined-v2", "cost-matched": "combined-v2", "v1": "combined",
                "filler": "filler-removed", "one-call": "recall-one-call"}[arm]
        pc = {**facts_cfg, **measured, "lane": lane, "search_config": read_knobs_v2("tokenmax", "facts_arm" if arm == "v2-facts-arm" else "reserve",
                                                                                   W5_RATIO if arm == "v2-w5" else None)}
        if lane == "combined-v2":
            pc |= {"facts_tokens": d["facts_tokens"], "delivered_tokens": d["cost_matched"] if arm == "cost-matched" else 8100}
        elif lane == "combined":
            pc |= {"facts_tokens": d["facts_tokens"], "token_budget": 8100 - d["facts_tokens"]}
        elif lane == "filler-removed":
            pc |= {"token_budget": 8100}
        else:
            pc |= {"delivered_tokens": 8100}
        creds = ["voyage", "anthropic"]
    return {"dataset": d["dataset"], "split": d["split"], "provider": "gbrain", "mode": "rag", "lane": lane, "seal": "dev",
            "target_tokens": 8000, "models": MODELS, "budget_usd": BUDGET[group][arm], "questions": d["questions"], "k": 10,
            "provider_config": pc, "gbrain_credentials": creds,
            "note": f"memory proof wave 2 dev, {group} arm {arm}: see the 2026-10-11 and 2026-10-12 addenda"}


ORDER = {
    "lme": ["v2", "raw", "v2-facts-arm", "v1", "filler", "one-call"],
    "locomo": ["v2", "raw", "v2-facts-arm", "v1", "one-call"],
    **{g: ["v2", "v2-w5", "v2-facts-arm", "v1", "one-call", "cost-matched"] for g in ("beam-100k", "beam-500k", "beam-1m")},
}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for group, arms in ORDER.items():
        for arm in arms:
            (OUT / f"{group}-{arm}.json").write_text(json.dumps(spec(group, arm), indent=1) + "\n")
    (OUT / "order.json").write_text(json.dumps({"caps_usd": CAPS, "order": ORDER}, indent=1) + "\n")
