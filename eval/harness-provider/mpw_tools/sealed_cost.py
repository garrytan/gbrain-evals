"""Cost per correct answer for the sealed BEAM cells, under the preregistered cost formula.

  python -m mpw_tools.sealed_cost --pair <gbrain-cell>:<comparator-cell>:<gbrain-rejudge>:<comparator-rejudge> [--pair ...] \
      [--vcpus gbrain=4,comparator=16] [--out <json>]

Per system and conversation c: ingest dollars I_c (ingest LLM and embedding requests, proxy-metered, plus ingest
wall-hours x vCPUs x $0.05) and read dollars per question (query embedding, rerank, any read-time LLM call and the
answer model's request). With n_c questions per conversation and R reads per written conversation,

  cost per correct answer = sum_c (n_c * I_c / R + read_c) / sum_c score_c

where scores come from the joint blinded re-judge (an unscored row counts 0 and is reported). The ratio gbrain /
comparator gets a 95% percentile interval from the paired, stratified cluster bootstrap over conversations
(strata are BEAM sizes; 9,999 draws, seed 20261005). R = 20 is primary, with R = 1 and R = 200 beside it.

Requests are split by the metering proxy's own fields. An answer request carries its question in its tag. An
untagged provider request belongs to the conversation of the next answer request in time (a cell ingests a
conversation, then asks its questions). It is read-time when it is a query embedding (`input_type: query`) or a
rerank, and ingest-time otherwise. Diagnostics count ingest-kind requests sent between two answers of one
conversation, which would mean a read-time LLM call this split misses. This module lives outside `mpw/` so it is
not part of any cell's wrapper revision. The output carries aggregates only.
"""
from __future__ import annotations

import argparse
import bisect
import json
from pathlib import Path

import numpy as np

CPU_USD_PER_VCPU_HOUR = 0.05
READS = (20, 1, 200)


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def _conversation(qid: str) -> str:
    return qid.split("_", 1)[0]


def system_costs(cell_dir: Path, rejudge_dir: Path, vcpus: int) -> dict:
    cell = _load(cell_dir / "cell.json")
    schedule = cell["resolved"]["schedule"]
    answers = [(r["ts"], _conversation(rec["query_id"]), rec["query_id"], r.get("actual_usd") or 0.0)
               for f in sorted((cell_dir / "stages" / "answer").glob("*.json"))
               for rec in [_load(f)]
               for r in rec.get("requests") or []]
    answers.sort()
    times = [a[0] for a in answers]
    read = {q: 0.0 for q in schedule}
    for _, _, qid, usd in answers:
        read[qid] += usd
    ingest: dict[str, float] = {}
    span: dict[str, tuple[str, str]] = {}
    for ts, conv, _, _ in answers:
        lo, hi = span.get(conv, (ts, ts))
        span[conv] = (min(lo, ts), max(hi, ts))
    diag = {"ingest_kind_inside_question_phase": 0, "after_last_answer": 0, "untagged_requests": 0}
    for line in (cell_dir / "proxy" / "requests.jsonl").read_text().splitlines():
        r = json.loads(line)
        if r["label"] == "harness" or not r.get("actual_usd"):
            continue
        diag["untagged_requests"] += 1
        i = bisect.bisect_left(times, r["ts"])
        if i == len(answers):
            diag["after_last_answer"] += 1
            continue
        _, conv, qid, _ = answers[i]
        body = cell_dir / "proxy" / "bodies" / f"{r['body_sha256']}.json"
        input_type = _load(body).get("input_type") if r.get("kind") == "embedding" and body.exists() else None
        if r.get("kind") == "rerank" or input_type == "query":
            read[qid] += r["actual_usd"]
            continue
        ingest[conv] = ingest.get(conv, 0.0) + r["actual_usd"]
        lo, hi = span[conv]
        if lo < r["ts"] < hi:
            diag["ingest_kind_inside_question_phase"] += 1
    cpu = {}
    for f in (cell_dir / "stages" / "ingest").glob("*.json"):
        rec = _load(f)
        cpu[str(rec["unit"])] = (rec.get("ingest_ms") or 0.0) / 3.6e6 * vcpus * CPU_USD_PER_VCPU_HOUR
    scores, unscored = {}, 0
    for f in (rejudge_dir / "stages" / "judge").glob("*.json"):
        rec = _load(f)
        scores[rec["query_id"]] = rec["score"] if isinstance(rec.get("score"), (int, float)) else 0.0
    unscored = sum(1 for q in schedule if q not in scores)
    convs = sorted({_conversation(q) for q in schedule}, key=lambda c: (len(c), c))
    per = {c: {"n": 0, "ingest_api": ingest.get(c, 0.0), "ingest_cpu": cpu.get(c, 0.0), "read": 0.0, "score": 0.0} for c in convs}
    for q in schedule:
        p = per[_conversation(q)]
        p["n"] += 1
        p["read"] += read[q]
        p["score"] += scores.get(q, 0.0)
    unattributed = sorted(set(ingest) - set(convs))
    return {"split": cell["spec"]["split"], "per": per, "diag": {**diag, "unscored_rows": unscored, "unattributed_conversations": len(unattributed)}}


def cpc(rows: list[dict], reads: int) -> float:
    cost = sum(r["n"] * (r["ingest_api"] + r["ingest_cpu"]) / reads + r["read"] for r in rows)
    return cost / sum(r["score"] for r in rows)


def summary(rows: list[dict]) -> dict:
    n = sum(r["n"] for r in rows)
    return {
        "questions": n, "conversations": len(rows), "accuracy": round(sum(r["score"] for r in rows) / n, 4),
        "ingest_api_usd": round(sum(r["ingest_api"] for r in rows), 4), "ingest_cpu_usd": round(sum(r["ingest_cpu"] for r in rows), 4),
        "read_usd": round(sum(r["read"] for r in rows), 4),
        **{f"cost_per_correct_R{R}": round(cpc(rows, R), 6) for R in READS},
    }


def ratio_interval(strata: list[tuple[list[dict], list[dict]]], reads: int, draws: int, seed: int) -> list[float]:
    rng = np.random.default_rng(seed)
    out = np.empty(draws)
    for b in range(draws):
        g, c = [], []
        for gs, cs in strata:
            idx = rng.integers(0, len(gs), len(gs))
            g += [gs[i] for i in idx]
            c += [cs[i] for i in idx]
        out[b] = cpc(g, reads) / cpc(c, reads)
    return [round(float(x), 4) for x in np.percentile(out, [2.5, 97.5])]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", action="append", required=True)
    ap.add_argument("--vcpus", default="gbrain=4,comparator=16")
    ap.add_argument("--draws", type=int, default=9999)
    ap.add_argument("--seed", type=int, default=20261005)
    ap.add_argument("--out")
    a = ap.parse_args()
    vcpus = dict((k, int(v)) for k, v in (kv.split("=") for kv in a.vcpus.split(",")))
    strata, report = [], {"formula": __doc__.split("\n\n")[1], "vcpus": vcpus, "draws": a.draws, "seed": a.seed, "by_split": {}}
    for pair in a.pair:
        gcell, ccell, grj, crj = (Path(p) for p in pair.split(":"))
        g = system_costs(gcell, grj, vcpus["gbrain"])
        c = system_costs(ccell, crj, vcpus["comparator"])
        assert g["split"] == c["split"] and list(g["per"]) == list(c["per"]), "pair must share one schedule"
        gs, cs = list(g["per"].values()), list(c["per"].values())
        strata.append((gs, cs))
        report["by_split"][g["split"]] = {"gbrain": {**summary(gs), "diagnostics": g["diag"]}, "comparator": {**summary(cs), "diagnostics": c["diag"]},
                                          **{f"ratio_R{R}": round(cpc(gs, R) / cpc(cs, R), 4) for R in READS}}
    g_all = [r for gs, _ in strata for r in gs]
    c_all = [r for _, cs in strata for r in cs]
    report["pooled"] = {"gbrain": summary(g_all), "comparator": summary(c_all)}
    for R in READS:
        report["pooled"][f"ratio_R{R}"] = round(cpc(g_all, R) / cpc(c_all, R), 4)
        report["pooled"][f"ratio_R{R}_ci95"] = ratio_interval(strata, R, a.draws, a.seed)
    report["pooled"]["cost_claim_R20"] = report["pooled"]["ratio_R20_ci95"][1] < 1
    text = json.dumps(report, indent=1)
    if a.out:
        Path(a.out).write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
