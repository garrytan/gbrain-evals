"""dedupe arm: active learning on the held-out world, then partition the scored world.

  uv run python dedupe_arm.py --config configs/dedupe-default.json \
      --world WORLD --held-out HELD_OUT --labels HELD_OUT.labels.json --out DIR

dedupe's documented path is prepare_training(data), then console_label, then
train(), then partition(data, threshold). Here the labeller is an oracle that
answers dedupe's uncertain_pairs() from the held-out world's page-to-person
map, in the same loop console_label runs, until the config's stop rule. The
scored world is never labelled or used for tuning: the trained model (its
learned blocking predicates and classifier) partitions it. A threshold given
as {"tune": ...} is chosen by partitioning the held-out world.
"""

from __future__ import annotations

import argparse
import json
import random
import time
from importlib.metadata import version as pkg_version
from pathlib import Path

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


def oracle_label(deduper, person: dict[str, str], stop: dict, log: dict) -> None:
    """console_label's loop with the held-out ledger answering each pair."""
    n_match = n_distinct = asked = 0
    pending: list = []
    while asked < stop["max_pairs"]:
        if stop.get("min_match") is not None and n_match >= stop["min_match"] and n_distinct >= stop["min_distinct"] and asked >= stop.get("min_pairs", 0):
            break
        if not pending:
            pending = deduper.uncertain_pairs()
            if not pending:
                break
        a, b = pending.pop()
        same = person[a["key"]] == person[b["key"]]
        deduper.mark_pairs({"match": [(a, b)] if same else [], "distinct": [] if same else [(a, b)]})
        asked += 1
        n_match += same
        n_distinct += not same
    log["labels"] = {"asked": asked, "match": n_match, "distinct": n_distinct}


def partition(deduper, data: dict[str, dict], threshold: float) -> list[list[str]]:
    return [sorted(ids) for ids, _ in deduper.partition(data, threshold) if len(ids) > 1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--world", required=True, help="world to score")
    ap.add_argument("--held-out", required=True, help="held-out world the labeller answers on")
    ap.add_argument("--labels", required=True, help="held-out labels from er-h2h-score.ts labels")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    if Path(a.held_out).resolve() == Path(a.world).resolve():
        raise SystemExit("dedupe_arm: the held-out world must differ from the scored world")
    cfg = json.loads(Path(a.config).read_text())
    random.seed(a.seed)
    numpy.random.seed(a.seed)
    log: dict = {"system": "dedupe", "version": pkg_version("dedupe"), "config": cfg["name"], "config_file": a.config, "doc": cfg["doc"], "world": a.world, "held_out": a.held_out, "seed": a.seed}

    t0 = time.time()
    held_rows = world.read_world(a.held_out)
    person = world.read_labels(a.labels, held_rows)
    held = records(held_rows, cfg)
    deduper = dedupe.Dedupe(variables(cfg, held), num_cores=cfg.get("num_cores", 0))
    deduper.prepare_training(held, **cfg.get("prepare_training", {}))
    oracle_label(deduper, person, cfg["labelling"], log)
    deduper.train(**cfg.get("train", {}))
    log["train_seconds"] = round(time.time() - t0, 2)
    log["predicates"] = [str(p) for p in deduper.fingerprinter.predicates]

    threshold = cfg["threshold"]
    if isinstance(threshold, dict):
        curve = []
        for t in THRESHOLDS:
            curve.append({"threshold": t, **world.pair_metrics(partition(deduper, held, t), person)})
        best = max(curve, key=lambda c: (c["f1"], c["threshold"]))
        log["held_out_tuning"] = {"goal": threshold["tune"], "chosen": best, "curve": curve}
        threshold = best["threshold"]
    log["threshold"] = threshold

    t0 = time.time()
    rows = world.read_world(a.world)
    auto = partition(deduper, records(rows, cfg), threshold)
    log["scored_seconds"] = round(time.time() - t0, 2)
    log["proposed_tier"] = cfg.get("proposed_note")
    out = Path(a.out)
    world.write_output(out / f"dedupe-{cfg['name']}.json", "dedupe", log["version"], cfg["name"], auto)
    world.write_run_log(out / f"dedupe-{cfg['name']}.run.json", log)
    print(json.dumps({k: log[k] for k in ("config", "labels", "threshold", "train_seconds", "scored_seconds")}))


if __name__ == "__main__":
    main()
