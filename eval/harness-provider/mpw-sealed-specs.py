#!/usr/bin/env python3
"""Write the memory proof wave's sealed BEAM cell specs from the opened sealed ids.

  python3 eval/harness-provider/mpw-sealed-specs.py <sealed-ids.json> <out-dir> --reserve on|off

The ids file is the output of `memory-proof-wave-grouping.ts open --split sealed --out ...`
and stays in custody, as does every spec written here (they list sealed conversation ids).
One spec per size and arm:

  gbrain-combined   primary arm: opt-in fact extraction (gpt-6-luna) plus one dated page per
                    exchange; facts 600 + page token_budget 7,500 = 8,000 delivered tokens;
                    the temporal fact reserve per its validation verdict; date grounding at
                    the build default
  gbrain-raw        secondary arm: exchange pages only, token_budget 8,700 (tuned on dev)
  comparator        facts plus chunks, budgets tuned on dev per size (7:4 ratio)

Every knob was fixed on dev; nothing is tuned on sealed questions.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ANSWER, JUDGE = "gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash"
COMPARATOR_KNOBS = {"100k": (3129, 1788), "500k": (2845, 1626), "1m": (2855, 1631)}
BUDGET = {"100k": 25, "500k": 45, "1m": 45}
EMB = {"embedding_model": "voyage:voyage-4", "embedding_dimensions": 1024}


def specs(ids: dict, reserve: bool) -> dict[str, dict]:
    out = {}
    for split in ("100k", "500k", "1m"):
        units = [str(u) for u in ids[f"beam/{split}"]]
        base = {"dataset": "beam", "split": split, "mode": "rag", "seal": "sealed", "target_tokens": 8000,
                "models": {"answer": ANSWER, "judge": JUDGE}, "k": 10, "questions": {"units": units},
                "budget_usd": BUDGET[split]}
        combined = {**EMB, "lane": "combined", "extraction_model": "openai:gpt-6-luna", "facts_limit": 100,
                    "page_split": "exchanges", "facts_tokens": 600, "token_budget": 7500}
        if reserve:
            combined["search_config"] = {"search.temporal_fact_reserve": "true"}
        out[f"sealed-beam-{split}-gbrain-combined"] = {**base, "provider": "gbrain", "lane": "combined", "provider_config": combined,
            "gbrain_credentials": ["voyage", "openai"], "note": f"memory proof wave sealed primary, gbrain combined lane, beam {split}"}
        out[f"sealed-beam-{split}-gbrain-raw"] = {**base, "provider": "gbrain", "lane": "raw",
            "provider_config": {**EMB, "page_split": "exchanges", "token_budget": 8700},
            "gbrain_credentials": ["voyage"], "note": f"memory proof wave sealed secondary, gbrain raw lane, beam {split}"}
        facts, chunks = COMPARATOR_KNOBS[split]
        out[f"sealed-beam-{split}-comparator"] = {**base, "provider": "comparator", "lane": "combined",
            "provider_config": {"max_tokens": facts, "max_chunk_tokens": chunks},
            "note": f"memory proof wave sealed primary, comparator facts plus chunks, beam {split}"}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids")
    ap.add_argument("out")
    ap.add_argument("--reserve", choices=("on", "off"), required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, spec in specs(json.loads(Path(a.ids).read_text()), a.reserve == "on").items():
        (out / f"{name}.json").write_text(json.dumps(spec, indent=2) + "\n")
        print(out / f"{name}.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
