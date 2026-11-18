"""dedupe arm: active learning on the held-out world, then partition the scored world.

  uv run python dedupe_arm.py --config configs/dedupe-default.json --entity people \
      --world WORLD --held-out HELD_OUT --labels LABELS --out-file OUT.json \
      [--label-budget N] [--seed S]

dedupe's documented path is prepare_training(data), then console_label, then
train(), then partition(data, threshold). Here the labeller is an oracle that
answers dedupe's uncertain_pairs() from the held-out labels through
mark_pairs, in the same loop console_label runs, until the config's stop rule.
Nothing reads standard input. --label-budget N caps the oracle at N answered
pairs in total; without it the config's stop rule alone applies (the
ceiling). --seed S (1 to 5, default 1) seeds the labeller's randomness, since
dedupe's active learning is random: Python's random, numpy's global state and
dedupe's unseeded numpy default_rng() calls all draw from it, and the arm
re-runs itself with PYTHONHASHSEED=0 so set ordering is fixed too. For --entity companies, the config's
"companies" section replaces the top-level keys it names. The scored world is
never labelled or used for tuning: the trained model (its learned blocking
predicates and classifier) partitions it. A threshold given as {"tune": ...}
is chosen by partitioning the held-out world. The run log goes to
OUT.run.json.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
from importlib.metadata import version as pkg_version

import dedupe
import numpy

import world

THRESHOLDS = [round(0.05 * i, 2) for i in range(1, 20)]


def records(rows: list[dict], cfg: dict) -> dict[str, dict]:
    fields = {v["field"] for v in cfg["variables"] if "field" in v}
    lower = cfg.get("lowercase", True)
    data = {}
    for r in rows:
        rec = {"key": r["key"]}
        for f in fields:
            v = r.get(f)
            if isinstance(v, list):
                vals = tuple(sorted({x.strip().lower() if lower else x.strip() for x in v if isinstance(x, str) and x.strip()}))
                rec[f] = vals or None
            elif isinstance(v, str) and v.strip():
                rec[f] = v.strip().lower() if lower else v.strip()
            else:
                rec[f] = None
        data[r["key"]] = rec
    return data


def variables(cfg: dict, data: dict[str, dict]):
    out = []
    for v in cfg["variables"]:
        cls = getattr(dedupe.variables, v["type"])
        if v["type"] == "Interaction":
            out.append(cls(*v["args"]))
            continue
        kwargs = dict(v.get("kwargs", {}))
        if v.get("corpus"):
            kwargs["corpus"] = [rec[v["field"]] for rec in data.values() if rec[v["field"]]]
        out.append(cls(v["field"], **kwargs))
    return out


def oracle_label(deduper, entity_of: dict[str, str], stop: dict, budget: int | None, log: dict) -> None:
    """console_label's loop with the held-out labels answering each pair, stopping at the stop rule or the budget."""
    limit = stop["max_pairs"] if budget is None else min(stop["max_pairs"], budget)
    n_match = n_distinct = asked = 0
    pending: list = []
    reason = "max_pairs" if budget is None or stop["max_pairs"] <= budget else "label_budget"
    while asked < limit:
        if stop.get("min_match") is not None and n_match >= stop["min_match"] and n_distinct >= stop["min_distinct"] and asked >= stop.get("min_pairs", 0):
            reason = "min_match_and_min_distinct"
            break
        if not pending:
            pending = deduper.uncertain_pairs()
            if not pending:
                reason = "no_uncertain_pairs"
                break
        a, b = pending.pop()
        same = entity_of[a["key"]] == entity_of[b["key"]]
        deduper.mark_pairs({"match": [(a, b)] if same else [], "distinct": [] if same else [(a, b)]})
        asked += 1
        n_match += same
        n_distinct += not same
    log["labels"] = {"asked": asked, "match": n_match, "distinct": n_distinct, "stopped_by": reason, "stop_rule": stop, "label_budget": budget}


def seed_labeller(seed: int) -> None:
    """dedupe draws from random, numpy's global state and unseeded numpy.random.default_rng() calls; seed all three."""
    random.seed(seed)
    numpy.random.seed(seed)
    stream = numpy.random.SeedSequence(seed)
    make = numpy.random.default_rng
    numpy.random.default_rng = lambda s=None: make(stream.spawn(1)[0] if s is None else s)


def partition(deduper, data: dict[str, dict], threshold: float) -> list[list[str]]:
    return [sorted(ids) for ids, _ in deduper.partition(data, threshold) if len(ids) > 1]


def main() -> None:
    if os.environ.get("PYTHONHASHSEED") != "0":
        os.execve(sys.executable, [sys.executable, *sys.argv], {**os.environ, "PYTHONHASHSEED": "0"})
    a = world.arm_args("dedupe", takes_labels=True, takes_seed=True)
    seed = 1 if a.seed is None else a.seed
    cfg = world.load_config(a.config, a.entity)
    seed_labeller(seed)
    log: dict = {"system": "dedupe", "version": pkg_version("dedupe"), "config": cfg["name"], "entity": a.entity, "config_file": a.config, "doc": cfg["doc"], "world": a.world, "held_out": a.held_out, "labels_file": a.labels, "label_budget": a.label_budget, "seed": seed}

    t0 = time.time()
    held_rows = world.read_world(a.held_out, a.entity)
    entity_of = world.read_labels(a.labels, held_rows)
    held = records(held_rows, cfg)
    deduper = dedupe.Dedupe(variables(cfg, held), num_cores=cfg.get("num_cores", 0))
    deduper.prepare_training(held, **cfg.get("prepare_training", {}))
    oracle_label(deduper, entity_of, cfg["labelling"], a.label_budget, log)
    deduper.train(**cfg.get("train", {}))
    log["held_out_pages"] = len(held_rows)
    log["train_seconds"] = round(time.time() - t0, 2)
    log["predicates"] = [str(p) for p in deduper.fingerprinter.predicates]

    threshold = cfg["threshold"]
    if isinstance(threshold, dict):
        curve = []
        for t in THRESHOLDS:
            curve.append({"threshold": t, **world.pair_metrics(partition(deduper, held, t), entity_of)})
        best = max(curve, key=lambda c: (c["f1"], c["threshold"]))
        log["held_out_tuning"] = {"goal": threshold["tune"], "chosen": best, "curve": curve}
        threshold = best["threshold"]
    log["threshold"] = threshold

    t0 = time.time()
    rows = world.read_world(a.world, a.entity)
    auto = partition(deduper, records(rows, cfg), threshold)
    log["scored_pages"] = len(rows)
    log["scored_seconds"] = round(time.time() - t0, 2)
    log["proposed_tier"] = cfg.get("proposed_note")
    world.write_output(a.out_file, "dedupe", log["version"], cfg["name"], auto)
    world.write_run_log(world.run_log_path(a.out_file), log)
    print(json.dumps({k: log[k] for k in ("config", "entity", "seed", "labels", "threshold", "train_seconds", "scored_seconds")}))


if __name__ == "__main__":
    main()
