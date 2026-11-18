"""Splink arm: Fellegi-Sunter on DuckDB, m and u fitted on the world being scored.

  uv run python splink_arm.py --config configs/splink-default.json --entity people \
      --world WORLD [--held-out HELD_OUT --labels LABELS] --out-file OUT.json

The config file names its Splink documentation source and is read as Splink
calls: each comparison is a function from splink.comparison_library with its
arguments, each blocking rule is block_on(...), and the training steps are the
linker.training methods in order. For --entity companies, the config's
"companies" section replaces the top-level keys it names. EM runs on the
scored world unsupervised, which is Splink's normal path, so the arm takes no
labels for training and refuses --label-budget and --seed. A threshold given
as a number is used as is; a threshold given as {"tune": ...} is chosen on the
held-out world, never on the scored world. Clustering is Splink's connected
components (cluster_pairwise_predictions_at_threshold). The run log goes to
OUT.run.json.
"""

from __future__ import annotations

import json
import time
import unicodedata

import pyarrow as pa
import splink
import splink.comparison_library as cl
from splink import DuckDBAPI, Linker, SettingsCreator, block_on

import world

WEIGHT_GRID = [w / 2 for w in range(-10, 41)]
FOLDED = ("city", "company", "linkedin", "github", "industry", "country")


def probability(weight: float) -> float:
    return 2**weight / (1 + 2**weight)


def fold(s: str | None) -> str | None:
    if s is None:
        return None
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = "".join(c if c.isalnum() or c in "@" else " " for c in s)
    return " ".join(s.split()) or None


def records(rows: list[dict], normalise: bool) -> pa.Table:
    lists = world.list_fields(rows)
    out = []
    for r in rows:
        name = fold(r["name"]) if normalise else r["name"]
        tokens = (name or "").split()
        rec = {k: v for k, v in r.items() if k not in ("key", "title")}
        rec["unique_id"] = r["key"]
        rec["first_name"] = tokens[0] if len(tokens) > 1 else None
        rec["surname"] = tokens[-1] if tokens else None
        rec["first_word"] = tokens[0] if tokens else None
        rec["name_concat"] = name
        for f in lists:
            vals = [v.strip().lower() if normalise else v for v in (r.get(f) or []) if isinstance(v, str) and v.strip()]
            rec[f] = vals or None
        rec["email"] = (rec.get("emails") or [None])[0]
        rec["domain"] = (rec.get("domains") or [None])[0]
        for f in FOLDED:
            if normalise and isinstance(rec.get(f), str):
                rec[f] = rec[f].strip().lower() or None
        out.append(rec)
    return pa.Table.from_pylist(out)


def comparison(spec: dict):
    c = getattr(cl, spec["fn"])(*spec.get("args", []), **spec.get("kwargs", {}))
    return c.configure(**spec["configure"]) if spec.get("configure") else c


def blocking(spec):
    if isinstance(spec, dict):
        return block_on(*spec["on"], arrays_to_explode=spec.get("arrays_to_explode"))
    return block_on(*spec)


def fit_and_predict(rows: list[dict], cfg: dict):
    db_api = DuckDBAPI()
    sdf = db_api.register(records(rows, cfg.get("records", {}).get("normalise", False)))
    s = cfg["settings"]
    settings = SettingsCreator(
        link_type=s["link_type"],
        comparisons=[comparison(c) for c in s["comparisons"]],
        blocking_rules_to_generate_predictions=[blocking(b) for b in s["blocking_rules_to_generate_predictions"]],
    )
    linker = Linker(sdf, settings)
    for step in cfg["training"]:
        name = step["step"]
        if name == "estimate_probability_two_random_records_match":
            linker.training.estimate_probability_two_random_records_match([blocking(b) for b in step["blocking"]], recall=step["recall"])
        elif name == "estimate_u_using_random_sampling":
            linker.training.estimate_u_using_random_sampling(max_pairs=step["max_pairs"], seed=step.get("seed"))
        elif name == "estimate_parameters_using_expectation_maximisation":
            linker.training.estimate_parameters_using_expectation_maximisation(blocking(step["blocking"]))
        else:
            raise ValueError(f"unknown training step {name}")
    df_predict = linker.inference.predict(**cfg["predict"])
    return linker, df_predict


def edges(df_predict) -> list[tuple[str, str, float]]:
    rel = df_predict.as_duckdbpyrelation()
    return [(a, b, p) for a, b, p in rel.select("unique_id_l, unique_id_r, match_probability").fetchall()]


def cluster(linker, df_predict, threshold: float) -> list[list[str]]:
    df = linker.clustering.cluster_pairwise_predictions_at_threshold(df_predict, threshold_match_probability=threshold)
    groups: dict[str, list[str]] = {}
    for uid, cid in df.as_duckdbpyrelation().select("unique_id, cluster_id").fetchall():
        groups.setdefault(cid, []).append(uid)
    return sorted(sorted(g) for g in groups.values() if len(g) > 1)


def tune(spec: dict, held_out_rows: list[dict], entity_of: dict[str, str], held_edges, log: dict, tier: str) -> float:
    keys = [r["key"] for r in held_out_rows]
    curve = []
    for w in WEIGHT_GRID:
        t = probability(w)
        m = world.pair_metrics(world.components(keys, [(a, b) for a, b, p in held_edges if p >= t]), entity_of)
        curve.append({"threshold": t, "match_weight": w, **m})
    goal = spec["tune"]
    if goal == "max_pair_f1":
        best = max(curve, key=lambda c: (c["f1"], c["threshold"]))
    elif goal.startswith("lowest_with_precision_at_least:"):
        floor = float(goal.split(":", 1)[1])
        ok = [c for c in curve if c["precision"] >= floor and c["merged_pairs"]]
        best = min(ok, key=lambda c: c["threshold"]) if ok else max(curve, key=lambda c: c["threshold"])
    else:
        raise ValueError(f"unknown tuning goal {goal}")
    log.setdefault("held_out_tuning", {})[tier] = {"goal": goal, "chosen": best, "curve": curve}
    return best["threshold"]


def main() -> None:
    a = world.arm_args("splink", takes_labels=False, takes_seed=False)
    cfg = world.load_config(a.config, a.entity)
    log: dict = {"system": "splink", "version": splink.__version__, "config": cfg["name"], "entity": a.entity, "config_file": a.config, "doc": cfg["doc"], "world": a.world, "held_out": a.held_out, "labels": a.labels, "label_budget": None, "seed": None}
    thresholds = {}
    needs_tuning = [t for t in ("auto", "proposed") if isinstance(cfg.get(t), dict)]
    if needs_tuning:
        if not (a.held_out and a.labels):
            raise SystemExit("splink_arm: this config tunes a threshold, so it needs --held-out and --labels")
        t0 = time.time()
        held_rows = world.read_world(a.held_out, a.entity)
        entity_of = world.read_labels(a.labels, held_rows)
        _, held_predict = fit_and_predict(held_rows, cfg)
        held_edges = edges(held_predict)
        for tier in needs_tuning:
            thresholds[tier] = tune(cfg[tier], held_rows, entity_of, held_edges, log, tier)
        log["held_out_pages"] = len(held_rows)
        log["held_out_seconds"] = round(time.time() - t0, 2)
    for tier in ("auto", "proposed"):
        if isinstance(cfg.get(tier), (int, float)):
            thresholds[tier] = float(cfg[tier])
    t0 = time.time()
    rows = world.read_world(a.world, a.entity)
    linker, df_predict = fit_and_predict(rows, cfg)
    auto = cluster(linker, df_predict, thresholds["auto"])
    proposed = cluster(linker, df_predict, thresholds["proposed"]) if "proposed" in thresholds else None
    log["scored_pages"] = len(rows)
    log["scored_seconds"] = round(time.time() - t0, 2)
    log["thresholds_match_probability"] = thresholds
    log["proposed_tier"] = cfg.get("proposed_note")
    log["pairs_predicted"] = len(edges(df_predict))
    log["probability_two_random_records_match"] = linker._settings_obj._probability_two_random_records_match
    world.write_output(a.out_file, "splink", splink.__version__, cfg["name"], auto, proposed)
    world.write_run_log(world.run_log_path(a.out_file), log)
    print(json.dumps({k: log[k] for k in ("config", "entity", "thresholds_match_probability", "scored_seconds", "pairs_predicted")}))


if __name__ == "__main__":
    main()
