#!/usr/bin/env python3
"""Derive comparison tables from every fixed matrix cell; no provider calls.

Selects the latest complete valid attempt for each cell, retaining the full
attempt history and costs. Missing or invalid cells stop publication. Rankings
and individual scores remain in the linked source receipts/reports.
"""
import argparse
from collections import defaultdict
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("matrix", ROOT / "scripts/run-retrieval-refresh.py")
MATRIX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATRIX)


def read(path):
    return json.loads(path.read_text())


def paired(before, after, key, metric):
    a, b = {r[key]: r for r in before}, {r[key]: r for r in after}
    assert len(a) == len(before) and len(b) == len(after), "Duplicate question IDs in paired comparison"
    assert set(a) == set(b), "Paired comparison must retain every question"
    output = dict(n=len(a), comparable=0, gains=[], losses=[], ties=[], excluded_null=[])
    for identifier in a:
        for invariant in ("text", "query_text", "graded_gold", "relevant", "subset", "category", "description"):
            if invariant in a[identifier] or invariant in b[identifier]:
                assert a[identifier].get(invariant) == b[identifier].get(invariant), f"Paired question changed: {identifier}/{invariant}"
        x, y = a[identifier].get(metric), b[identifier].get(metric)
        if x is None or y is None:
            output["excluded_null"].append(identifier)
            continue
        output["comparable"] += 1
        assert math.isfinite(float(x)) and math.isfinite(float(y)), "Nonfinite paired score"
        delta = float(y) - float(x)
        output["gains" if delta > 1e-10 else "losses" if delta < -1e-10 else "ties"].append(identifier)
    output["counts"] = {k: len(output[k]) for k in ("gains", "losses", "ties", "excluded_null")}
    return output


def template(text, family="relational"):
    for prefix, label in [("Who attended ", "attended"), ("Who works at ", "works_at"),
                          ("Who invested in ", "invested_in"), ("Who advises ", "advises")]:
        if text.startswith(prefix):
            return label
    return family


def summarize(output):
    ledger = read(output / "budget-ledger.json")
    selected, attempts = {}, []
    for a in ledger["attempts"]:
        destination = output / a["directory"]
        validation = MATRIX.validate_attempt(a["cell"], destination, a.get("exit_code", -1))
        attempts.append({k: a[k] for k in ("cell", "attempt", "directory", "status", "exit_code",
                                         "api_attempts", "gross_usage_estimate_usd", "conservative_request_cost_usd") if k in a} | {"validation": validation})
        if validation["valid"]:
            selected[a["cell"]] = (a, destination, read(destination / validation["receipt"]))
    missing = set(MATRIX.CELLS) - set(selected)
    if missing:
        raise SystemExit("Missing valid complete cells: " + ", ".join(sorted(missing)))
    result = dict(schema_version=1, run_date="2026-09-09", attempts=attempts,
                  selected_attempts={k: v[0]["directory"] for k, v in selected.items()},
                  artifacts=[], budget={
                      "ceiling_usd": ledger["aggregate_ceiling_usd"],
                      "reserved_usd": sum(a["reservation_usd"] for a in ledger["attempts"]),
                      "gross_usage_estimate_usd": sum(a.get("gross_usage_estimate_usd", 0) for a in ledger["attempts"]),
                      "conservative_request_cost_usd": sum(a.get("conservative_request_cost_usd", 0) for a in ledger["attempts"]),
                      "api_attempts": sum(a.get("api_attempts", 0) for a in ledger["attempts"]),
                      "requests_without_usage": sum(a.get("requests_without_usage", 0) for a in ledger["attempts"]),
                  })
    for attempt in ledger["attempts"]:
        directory = output / attempt["directory"]
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path.suffix in {".json", ".ndjson", ".log"}:
                result["artifacts"].append(dict(cell=attempt["cell"], attempt=attempt["attempt"],
                    selected=attempt["directory"] == selected[attempt["cell"]][0]["directory"],
                    path=str(path.relative_to(ROOT)), sha256=hashlib.sha256(path.read_bytes()).hexdigest()))

    baseline = selected["baselines"][2]
    runs = baseline["data"]["runs_by_adapter"]
    result["baselines"] = baseline["data"]["scorecards"]
    result["baseline_by_template"] = []
    for name, repetitions in runs.items():
        groups = defaultdict(list)
        for repetition in repetitions:
            for row in repetition["perQuery"]:
                groups[(row["family"], template(row["query_text"], row["family"]))].append(row)
        for (family, label), rows in groups.items():
            result["baseline_by_template"].append(dict(adapter=name, family=family, template=label,
                question_repetitions=len(rows), mean_precision=sum(r["precision"] for r in rows)/len(rows),
                mean_recall=sum(r["recall"] for r in rows)/len(rows)))
    result["baseline_pairs"] = []
    for left, right in itertools.combinations(runs, 2):
        aa_seeds, bb_seeds = {r["seed"]: r for r in runs[left]}, {r["seed"]: r for r in runs[right]}
        assert len(aa_seeds) == len(runs[left]) and len(bb_seeds) == len(runs[right]), "Duplicate ingestion seed"
        assert set(aa_seeds) == set(bb_seeds) == {1, 2, 3}, "Missing planned ingestion seed"
        for seed in (1, 2, 3):
            a, b = aa_seeds[seed], bb_seeds[seed]
            families = {r["family"] for r in a["perQuery"]} & {r["family"] for r in b["perQuery"]}
            for family in sorted(families):
                aa = [r for r in a["perQuery"] if r["family"] == family]
                bb = [r for r in b["perQuery"] if r["family"] == family]
                result["baseline_pairs"].append(dict(before=left, after=right, seed=a["seed"], family=family,
                    recall=paired(aa, bb, "query_id", "recall"), precision=paired(aa, bb, "query_id", "precision")))

    relational = selected["relationships"][2]["data"]
    result["relationships"] = {k: relational[k] for k in ("summary", "by_seed", "by_template")}

    concept = []
    for cell in ("concept-baselines", "concept-ungated", "concept-rerank"):
        directory = selected[cell][1]
        report = MATRIX.attempt_report(selected[cell][2], directory)
        for row in report["results"]:
            concept.append(dict(cell=cell, **row))
    result["concept"] = [{k: v for k, v in row.items() if k not in ("per_query", "observed")} for row in concept]
    result["concept_pairs"] = []
    reference = next(r for r in concept if r["cell"] == "concept-baselines" and r["name"] == "gbrain")
    for other in concept:
        if other is reference:
            continue
        for subset in ("all", "tuning", "holdout", "mixed"):
            a = [r for r in reference["per_query"] if subset == "all" or r["subset"] == subset]
            b = [r for r in other["per_query"] if subset == "all" or r["subset"] == subset]
            result["concept_pairs"].append(dict(before="concept-baselines/gbrain", after=other["cell"]+"/"+other["name"],
                subset=subset, n=len(a), ndcg5=paired(a, b, "id", "ndcg5"), p1_strict=paired(a, b, "id", "p1_strict")))

    source = MATRIX.attempt_report(selected["source-swamp"][2], selected["source-swamp"][1])
    result["source_swamp"] = source
    result["source_pairs"] = []
    for a, b in itertools.combinations(source["results"], 2):
        aa = [dict(r, top1_hit=r["targetRank"] == 1) for r in a["per_query"]]
        bb = [dict(r, top1_hit=r["targetRank"] == 1) for r in b["per_query"]]
        result["source_pairs"].append(dict(before=a["name"], after=b["name"], top1=paired(aa, bb, "id", "top1_hit")))

    precision = {}
    for cell in MATRIX.CELLS:
        if not cell.startswith("precision-"):
            continue
        directory = selected[cell][1]
        report = MATRIX.attempt_report(selected[cell][2], directory)
        precision[cell] = report
    result["precision"] = {cell: dict(**report["retrieval"],
        precision_denominator=sum(c["retrievalPrecision"] is not None for c in report["cases"]),
        recall_denominator=sum(c["retrievalRecall"] is not None for c in report["cases"]))
        for cell, report in precision.items()}
    result["precision_pairs"] = []
    for left, right in itertools.combinations(precision, 2):
        a, b = precision[left]["cases"], precision[right]["cases"]
        result["precision_pairs"].append(dict(before=left, after=right,
            passed=paired(a, b, "caseId", "passed"),
            precision=paired(a, b, "caseId", "retrievalPrecision"),
            recall=paired(a, b, "caseId", "retrievalRecall")))
    return result


def render_tables(result):
    lines = ["# Every template and paired comparison", "",
             "Generated by `scripts/summarize-retrieval-refresh.py` from the saved attempts. "
             "See the [main report](../2026-09-09-retrieval-refresh.md) for methods and interpretation. "
             "[summary.json](summary.json) includes every changed question ID and source artifact hash.", ""]

    def table(title, headers, rows):
        lines.extend(["## " + title, "", "| " + " | ".join(headers) + " |",
                      "| " + " | ".join("---" for _ in headers) + " |"])
        lines.extend("| " + " | ".join(str(x) for x in row) + " |" for row in rows)
        lines.append("")

    def score(x):
        return "—" if x is None else f"{x:.4f}"

    def counts(x):
        c = x["counts"]
        return f"{c['gains']} / {c['losses']} / {c['ties']}"

    table("Existing adapters by question template", ["Adapter", "Family / template", "Question repetitions", "P@5", "R@5"],
          [[r["adapter"], r["family"]+" / "+r["template"], r["question_repetitions"], score(r["mean_precision"]), score(r["mean_recall"])]
           for r in result["baseline_by_template"]])
    lines.extend(["Each question appears in three ingestion orders. These are sensitivity checks, "
                  "not three independent question sets. `gbrain` here is the specialized historical relationship adapter.", ""])
    table("Existing adapters: paired recall changes", ["Before → after", "Family", "Seed", "Gains / losses / ties"],
          [[r["before"]+" → "+r["after"], r["family"], r["seed"], counts(r["recall"])] for r in result["baseline_pairs"]])
    table("Production relationship retrieval by template", ["Template", "Questions × seeds", "Off R@5", "On R@5", "Recall gains / losses / ties", "Off hit@1", "On hit@1"],
          [[name, r["paired"]["recall_at_5"]["n"], score(r["off"]["recall_at_5"]), score(r["on"]["recall_at_5"]),
            " / ".join(str(r["paired"]["recall_at_5"][k]) for k in ("gains", "losses", "ties")),
            score(r["off"]["hit_at_1"]), score(r["on"]["hit_at_1"])]
           for name, r in result["relationships"]["by_template"].items()])
    table("Concept search by template", ["Cell / adapter", "Split", "Template", "Questions", "nDCG@5"],
          [[r["cell"]+" / "+r["name"], split, name, row["count"], score(row["ndcg"])]
           for r in result["concept"] for split, templates in
           [("all", r["byTemplate"]), ("tuning", r["splits"]["tuning"]["byTemplate"]), ("held out", r["splits"]["holdout"]["byTemplate"])]
           for name, row in templates.items()])
    table("Concept search: paired changes from lexical-gated gbrain", ["After", "Split", "Questions", "nDCG gains / losses / ties", "Strict top-1 gains / losses / ties"],
          [[r["after"], r["subset"], r["n"], counts(r["ndcg5"]), counts(r["p1_strict"])] for r in result["concept_pairs"]])
    table("Source preferences: paired top-1 changes", ["Before → after", "Gains / losses / ties"],
          [[r["before"]+" → "+r["after"], counts(r["top1"])] for r in result["source_pairs"]])
    table("PrecisionMemBench by category", ["Cell", "Category", "Cases", "All assertions passed", "Mean precision", "Mean recall"],
          [[cell, c["category"], c["caseCount"], c["passed"], score(c["meanPrecision"]), score(c["meanRecall"])]
           for cell, r in result["precision"].items() for c in r["categories"]])
    lines.extend(["Precision and recall follow the upstream scorer's null exclusion. A dash means no defined score, "
                  "not zero. Passing a case means passing every assertion; structural and trivially empty passes "
                  "are separately counted in the main report.", ""])
    table("PrecisionMemBench: paired changes", ["Before → after", "Full-case gains / losses / ties", "Precision gains / losses / ties", "Recall gains / losses / ties"],
          [[r["before"]+" → "+r["after"], counts(r["passed"]), counts(r["precision"]), counts(r["recall"])]
           for r in result["precision_pairs"]])
    lines.extend(["Null scores are excluded only from that metric's paired comparison. "
                  "The JSON records those case IDs explicitly; the full-case comparison includes all 77 cases.", ""])
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="docs/benchmarks/2026-09-09-retrieval-refresh")
    args = parser.parse_args()
    directory = ROOT / args.output_dir
    result = summarize(directory)
    (directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    (directory / "tables.md").write_text(render_tables(result))
    print(directory / "summary.json")
