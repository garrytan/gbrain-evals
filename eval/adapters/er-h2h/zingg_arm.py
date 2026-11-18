"""Zingg Community arm: Spark local mode, JSON config, the documented phases.

  uv run python zingg_arm.py --config configs/zingg-default.json --entity people \
      --world WORLD --held-out HELD_OUT --labels LABELS --out-file OUT.json \
      [--label-budget N] [--zingg-home DIR] [--spark-home DIR]

Zingg's documented path is findTrainingData, then label, repeated until there
are enough labelled pairs, then train, then match (scripts/zingg.sh --phase
<phase> --conf config.json). Here the label phase's human is an oracle: after
each findTrainingData round it reads the candidate pairs Zingg wrote under
<zinggDir>/<modelId>/trainingData/unmarked, answers each pair from the
held-out labels (1 match, 0 no match), and writes them where the label phase
writes them (trainingData/marked). Every Zingg phase runs with standard input
closed. --label-budget N stops after the round that reaches N answered pairs,
answering only up to N within that round; without it the config's stop rule
alone applies (the ceiling). Zingg Community has no seed setting, so the arm
refuses --seed and each config runs once. For --entity companies, the
config's "companies" section replaces the top-level keys it names. Training
sees only the held-out world. match then runs the trained model on the scored
world, and the output's z_cluster gives the clusters. Zingg Community has no
threshold setting and no review band, so there is no proposed tier. Work
files go to OUT.work/ and the run log to OUT.run.json.
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import duckdb

import world


def write_csv(rows: list[dict], fields: list[dict], path: Path) -> str:
    cols = [f["fieldName"] for f in fields]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", *cols])
        for r in rows:
            vals = []
            for f in fields:
                src = f.get("source", f["fieldName"])
                v = r.get(src)
                if src == "first_name" or src == "surname":
                    tokens = (r["name"] or "").split()
                    v = (tokens[0] if len(tokens) > 1 else None) if src == "first_name" else (tokens[-1] if tokens else None)
                if isinstance(v, list):
                    v = " ".join(sorted(x for x in v if isinstance(x, str)))
                vals.append("" if v is None else str(v).lower() if f.get("lowercase", True) else str(v))
            w.writerow([r["key"], *vals])
    return "id string, " + ", ".join(f"{c} string" for c in cols)


def zingg_conf(cfg: dict, data_csv: Path, schema: str, out_dir: Path, zingg_dir: Path) -> dict:
    fields = [{"fieldName": "id", "matchType": "dont_use", "fields": "id", "dataType": "string"}]
    fields += [{k: v for k, v in f.items() if k in ("fieldName", "matchType", "fields", "dataType")} for f in cfg["fieldDefinition"]]
    return {
        "fieldDefinition": fields,
        "output": [{"name": "output", "format": "csv", "props": {"location": str(out_dir), "path": str(out_dir), "delimiter": ",", "header": True}}],
        "data": [{"name": "data", "format": "csv", "props": {"location": str(data_csv), "path": str(data_csv), "delimiter": ",", "header": True}, "schema": schema}],
        "labelDataSampleSize": cfg["labelDataSampleSize"],
        "numPartitions": cfg["numPartitions"],
        "modelId": cfg["modelId"],
        "zinggDir": str(zingg_dir),
    }


def run_phase(phase: str, conf: Path, zingg_home: Path, spark_home: Path, log_dir: Path, timings: list) -> None:
    env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
    env.update({"ZINGG_HOME": str(zingg_home), "SPARK_HOME": str(spark_home), "SPARK_MASTER": env.get("SPARK_MASTER", "local[*]")})
    t0 = time.time()
    log_file = log_dir / f"{len(timings):02d}-{phase}.log"
    with log_file.open("w") as fh:
        rc = subprocess.run(["bash", "scripts/zingg.sh", "--properties-file", "config/zingg.conf", "--phase", phase, "--conf", str(conf)], cwd=zingg_home, env=env, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT).returncode
    timings.append({"phase": phase, "seconds": round(time.time() - t0, 2), "log": str(log_file)})
    if rc != 0:
        raise SystemExit(f"zingg_arm: phase {phase} failed with exit {rc}; see {log_file}")


def oracle_label(model_dir: Path, entity_of: dict[str, str], round_no: int, room: int | None) -> dict:
    """What the label phase does with a human, answered from the held-out labels, for at most room pairs."""
    unmarked = model_dir / "trainingData" / "unmarked"
    marked = model_dir / "trainingData" / "marked"
    con = duckdb.connect()
    rel = con.sql(f"select * from read_parquet('{unmarked}/**/*.parquet', union_by_name=true)")
    cols = rel.columns
    rows = rel.fetchall()
    idx_cluster, idx_id, idx_match = cols.index("z_cluster"), cols.index("id"), cols.index("z_isMatch")
    pairs: dict = {}
    for row in rows:
        pairs.setdefault(row[idx_cluster], []).append(row)
    done_before = set()
    if marked.exists():
        done_before = {r[0] for r in con.sql(f"select distinct z_cluster from read_parquet('{marked}/**/*.parquet', union_by_name=true)").fetchall()}
    labelled = []
    n_match = n_distinct = 0
    for cid in sorted(pairs, key=str):
        members = pairs[cid]
        if cid in done_before or len(members) != 2:
            continue
        if room is not None and n_match + n_distinct >= room:
            break
        same = entity_of[members[0][idx_id]] == entity_of[members[1][idx_id]]
        n_match += same
        n_distinct += not same
        for m in members:
            m = list(m)
            m[idx_match] = 1 if same else 0
            labelled.append(m)
    if labelled:
        marked.mkdir(parents=True, exist_ok=True)
        con.execute("create table lab as select * from rel limit 0")
        con.executemany(f"insert into lab values ({', '.join('?' for _ in cols)})", labelled)
        con.execute(f"copy lab to '{marked}/oracle-round-{round_no:02d}.parquet' (format parquet)")
    shutil.rmtree(unmarked)
    return {"round": round_no, "pairs_offered": len(pairs), "match": n_match, "distinct": n_distinct}


def read_clusters(out_dir: Path) -> list[list[str]]:
    con = duckdb.connect()
    rel = con.sql(f"select id, z_cluster from read_csv('{out_dir}/*.csv', header=true, all_varchar=true)")
    groups: dict = {}
    for key, cid in rel.fetchall():
        groups.setdefault(cid, []).append(key)
    return sorted(sorted(g) for g in groups.values() if len(g) > 1)


def zingg_paths(ap) -> None:
    ap.add_argument("--zingg-home", default=os.environ.get("ZINGG_HOME"))
    ap.add_argument("--spark-home", default=os.environ.get("SPARK_HOME"))


def main() -> None:
    a = world.arm_args("zingg", takes_labels=True, takes_seed=False, extra=zingg_paths)
    if not a.zingg_home or not a.spark_home:
        raise SystemExit("zingg_arm: set --zingg-home and --spark-home (or ZINGG_HOME and SPARK_HOME)")
    cfg = world.load_config(a.config, a.entity)
    zingg_home, spark_home = Path(a.zingg_home).resolve(), Path(a.spark_home).resolve()
    out_file = Path(a.out_file).resolve()
    work = out_file.with_suffix(".work")
    if work.exists():
        shutil.rmtree(work)
    (work / "logs").mkdir(parents=True)
    zingg_dir = work / "models"
    model_dir = zingg_dir / str(cfg["modelId"])
    version = (zingg_home / "zingg-version.txt").read_text().strip() if (zingg_home / "zingg-version.txt").exists() else next(p.stem.split("-", 1)[1] for p in zingg_home.glob("zingg-*.jar") if "tests" not in p.name)
    log: dict = {"system": "zingg", "version": version, "edition": "Community", "config": cfg["name"], "entity": a.entity, "config_file": a.config, "doc": cfg["doc"], "world": a.world, "held_out": a.held_out, "labels_file": a.labels, "label_budget": a.label_budget, "seed": None, "runs_per_config": 1, "spark_master": os.environ.get("SPARK_MASTER", "local[*]"), "phases": [], "label_rounds": []}

    held_rows = world.read_world(a.held_out, a.entity)
    entity_of = world.read_labels(a.labels, held_rows)
    schema = write_csv(held_rows, cfg["fieldDefinition"], work / "held-out.csv")
    held_conf = work / "held-out.json"
    held_conf.write_text(json.dumps(zingg_conf(cfg, work / "held-out.csv", schema, work / "held-out-match", zingg_dir), indent=1))

    stop = cfg["labelling"]
    total_match = total_distinct = 0
    stopped_by = "max_rounds"
    for round_no in range(1, stop["max_rounds"] + 1):
        run_phase("findTrainingData", held_conf, zingg_home, spark_home, work / "logs", log["phases"])
        room = None if a.label_budget is None else a.label_budget - total_match - total_distinct
        r = oracle_label(model_dir, entity_of, round_no, room)
        log["label_rounds"].append(r)
        total_match += r["match"]
        total_distinct += r["distinct"]
        if total_match >= stop["min_match"] and total_distinct >= stop["min_distinct"]:
            stopped_by = "min_match_and_min_distinct"
            break
        if a.label_budget is not None and total_match + total_distinct >= a.label_budget:
            stopped_by = "label_budget"
            break
    log["labels"] = {"asked": total_match + total_distinct, "match": total_match, "distinct": total_distinct, "rounds": len(log["label_rounds"]), "stopped_by": stopped_by, "stop_rule": stop, "label_budget": a.label_budget}
    log["held_out_pages"] = len(held_rows)
    run_phase("train", held_conf, zingg_home, spark_home, work / "logs", log["phases"])

    rows = world.read_world(a.world, a.entity)
    scored_schema = write_csv(rows, cfg["fieldDefinition"], work / "scored.csv")
    scored_conf = work / "scored.json"
    scored_conf.write_text(json.dumps(zingg_conf(cfg, work / "scored.csv", scored_schema, work / "scored-match", zingg_dir), indent=1))
    run_phase("match", scored_conf, zingg_home, spark_home, work / "logs", log["phases"])
    auto = read_clusters(work / "scored-match")
    log["scored_pages"] = len(rows)
    log["proposed_tier"] = cfg.get("proposed_note")
    world.write_output(out_file, "zingg", version, cfg["name"], auto)
    world.write_run_log(world.run_log_path(out_file), log)
    print(json.dumps({"config": cfg["name"], "entity": a.entity, "labels": log["labels"], "phases": [(p["phase"], p["seconds"]) for p in log["phases"]]}))


if __name__ == "__main__":
    main()
