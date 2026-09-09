#!/usr/bin/env python3
"""Run the fixed documentation-refresh matrix, preserving every attempt.

Each process reserves $25 of the aggregate budget before starting. Its fetch
preload caps conservative per-request costs at $25, including retries. The
ledger never refunds reservations, even after a failed run. Actual usage-based
gross cost estimates live in each attempt's usage.ndjson; they are not invoices.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
CELLS = ["baselines", "relationships", "concept-baselines", "concept-ungated",
         "concept-rerank", "source-swamp", "precision-keyword", "precision-hybrid",
         "precision-adaptive", "precision-hybrid-rerank", "precision-adaptive-rerank"]
RESERVATION_USD = 25
EXPECTED_PROBES = dict(baselines=793, relationships=870, **{
    "concept-baselines": 2192, "concept-ungated": 548, "concept-rerank": 548,
    "source-swamp": 150, **{cell: 77 for cell in CELLS if cell.startswith("precision-")},
})
HARNESS_FILES = [
    "scripts/run-retrieval-refresh.py", "scripts/retrieval-usage.ts",
    "eval/runner/multi-adapter.ts", "eval/runner/relational-ab.ts",
    "eval/runner/cat13-conceptual.ts", "eval/runner/cat13b-source-swamp.ts",
    "eval/runner/precisionmembench.ts", "eval/runner/retrieval-pins.ts",
    "eval/runner/adapters/gbrain-inline.ts", "eval/runner/adapters/vector-grep-rrf-fusion.ts",
    "eval/runner/adapters/page-results.ts", "eval/runner/adapters/grep-only.ts",
    "eval/runner/adapters/vector.ts", "eval/runner/metrics.ts",
    "eval/runner/queries/relational.ts", "eval/precisionmembench/seed.ts",
    "eval/precisionmembench/gbrainAdapter.ts",
]
MEASURED_DEGRADATIONS = {"keyword_zero", "keyword_relaxed_carried", "budget_dropped_all", "budget_truncated"}
RELATIONAL_PINS = {
    "search.mode": "balanced", "search.reranker.enabled": "false", "search.expansion": "false",
    "search.autocut": "false", "search.cache.enabled": "false", "search.adaptive_return": "false",
    "search.graph_signals": "true", "search.metadata_boost_gate": "lexical",
    "search.relational_retrieval_depth": "2",
}


def unique_rows(rows, key, count):
    return (isinstance(rows, list) and len(rows) == count
            and all(isinstance(row, dict) and isinstance(row.get(key), str) and row[key] for row in rows)
            and len({row[key] for row in rows}) == count)


def complete_observations(observations, count, expected_ids=None, keyword=False, reranker=False):
    """Require the final adapter contract, including every successful empty answer."""
    if not isinstance(observations, list) or len(observations) != count:
        return False
    if expected_ids is not None and (not unique_rows(observations, "query_id", count)
                                     or {o["query_id"] for o in observations} != set(expected_ids)):
        return False
    required = {"query", "mode", "result_count", "rerank_scored", "ranked_results",
                "search_meta", "relational_meta", "failures"}
    for observation in observations:
        if (not isinstance(observation, dict) or not required <= observation.keys()
                or observation["failures"] or observation.get("error")
                or not isinstance(observation["ranked_results"], list)
                or observation["result_count"] != len(observation["ranked_results"])):
            return False
        if keyword:
            if observation["mode"] != "keyword":
                return False
            continue  # Keyword search intentionally has no hybrid metadata or vector arm.
        meta = observation["search_meta"]
        if (observation["mode"] != "hybrid" or not isinstance(meta, dict)
                or not {"vector_enabled", "detail_resolved", "expansion_applied"} <= meta.keys()
                or meta["vector_enabled"] is not True or meta["expansion_applied"] is not False
                or any(d.get("stage") not in MEASURED_DEGRADATIONS for d in meta.get("degraded", []))
                or (observation.get("relational_meta") or {}).get("errored")):
            return False
        if observation["result_count"] > 0 and observation["rerank_scored"] is not reranker:
            return False
    return True


def attempt_report(receipt, destination):
    """Read the identified report from this attempt, never a different run."""
    raw = receipt.get("data", {}).get("report_path") or receipt.get("data", {}).get("report_file")
    if not raw:
        raise ValueError("Missing report path")
    path = Path(raw)
    if ".." in path.parts:
        raise ValueError("Report path contains traversal")
    destination = destination.resolve()
    if not path.is_absolute():
        path = ROOT / path
    try:
        path.relative_to(destination)
    except ValueError:
        # Saved receipts retain the original checkout's absolute path. Relocate
        # only its explicitly identified cell/attempt suffix, never another
        # report discovered by filename or a path from a different attempt.
        marker = (destination.parent.name, destination.name)
        matches = [i for i in range(len(path.parts) - 1) if path.parts[i:i + 2] == marker]
        if (marker[0] not in CELLS or not marker[1].startswith("attempt-")
                or not marker[1][8:].isdigit() or len(matches) != 1):
            raise ValueError("Report path does not identify this cell and attempt")
        path = destination.joinpath(*path.parts[matches[0] + 2:])
    path = path.resolve()
    path.relative_to(destination)  # Reject symlink escapes as well as traversal.
    return json.loads(path.read_text())


def relational_contract(data, config):
    if (config.get("stub_embed") is not False or config.get("ingestion_seeds") != [1, 2, 3]
            or config.get("embedder") != {"model": "openai:text-embedding-3-large", "dimensions": 1536}
            or config.get("common_search_pins") != RELATIONAL_PINS
            or config.get("relational_retrieval") != {"off": False, "on": True}
            or config.get("product_limit") != 5 or config.get("precision_denominator") != 5):
        return "Relationship receipt lacks the planned live embedding and search configuration"
    indices = data.get("indices")
    if (not unique_rows(indices, "index_id", 3) or {r.get("seed") for r in indices} != {1, 2, 3}
            or any(r.get("config_readback") != RELATIONAL_PINS for r in indices)):
        return "Relationship receipt lacks three distinct indices with the planned configuration"
    index_by_seed = {r["seed"]: r["index_id"] for r in indices}
    rows = data.get("per_query")
    if not isinstance(rows, list) or len(rows) != 435:
        return "Relationship receipt lacks 435 complete paired question records"
    expected_questions = None
    repeated_questions = {}
    for seed in (1, 2, 3):
        seed_rows = [r for r in rows if r.get("seed") == seed]
        if not unique_rows(seed_rows, "query_id", 145):
            return "Relationship receipt lacks 145 unique questions in each ingestion seed"
        questions = {r["query_id"] for r in seed_rows}
        if expected_questions is not None and questions != expected_questions:
            return "Relationship ingestion repeats contain different questions"
        expected_questions = questions
        for row in seed_rows:
            if (row.get("index_id") != index_by_seed[seed]
                    or not {"text", "template", "relevant", "off", "on"} <= row.keys()
                    or not isinstance(row["relevant"], list)):
                return "Relationship pair lacks its shared index or question evidence"
            pair_hash = None
            for name, enabled in (("off", False), ("on", True)):
                arm = row[name]
                chunks, pages = arm.get("rows"), arm.get("pages")
                if (arm.get("error") or arm.get("relational_retrieval") is not enabled
                        or not isinstance(chunks, list) or len(chunks) > 5
                        or any(not isinstance(c, dict) or not isinstance(c.get("slug"), str) or not c["slug"] for c in chunks)
                        or pages != list(dict.fromkeys(c["slug"] for c in chunks))):
                    return "Relationship arm failed or lost the five-chunk, first-page-order contract"
                vector_hash = arm.get("query_vector_sha256", "")
                if (not isinstance(arm.get("query_embed_calls"), int) or arm["query_embed_calls"] < 1
                        or not isinstance(vector_hash, str) or len(vector_hash) != 64
                        or any(c not in "0123456789abcdef" for c in vector_hash)
                        or (pair_hash is not None and vector_hash != pair_hash)):
                    return "Relationship arms lack the same observed query embedding"
                pair_hash = vector_hash
                meta, relational = arm.get("search_meta"), arm.get("relational_meta")
                if (not isinstance(meta, dict) or meta.get("vector_enabled") is not True
                        or meta.get("expansion_applied") is not False
                        or any(d.get("stage") not in MEASURED_DEGRADATIONS for d in meta.get("degraded", []))
                        or not isinstance(relational, list) or bool(relational) != enabled
                        or any(m.get("errored") is not False for m in relational)):
                    return "Relationship arm lacks complete search and OFF/ON telemetry"
                metrics = arm.get("metrics")
                metric_names = ("precision_at_5", "recall_at_5", "hit_at_1", "hit_at_5")
                if (not isinstance(metrics, dict) or any(not isinstance(metrics.get(k), (int, float))
                        or not math.isfinite(metrics[k]) or not 0 <= metrics[k] <= 1 for k in metric_names)):
                    return "Relationship arm lacks finite scored metrics"
            identity = (row["text"], row["template"], row["relevant"], pair_hash)
            if row["query_id"] in repeated_questions and repeated_questions[row["query_id"]] != identity:
                return "Relationship question, gold, or shared vector changed across ingestion repeats"
            repeated_questions[row["query_id"]] = identity
    return None


def metadata_contract(cell, destination, receipt):
    data = receipt.get("data", {})
    config = receipt.get("resolved_config", {})
    if cell == "relationships":
        return relational_contract(data, config)
    elif cell.startswith("concept-"):
        names = {"gbrain", "vector-grep-rrf-fusion", "grep-only", "vector"} if cell == "concept-baselines" else {"gbrain"}
        per_query = data.get("per_query", {})
        if set(per_query) != names:
            return "Concept receipt is missing planned per-query adapter records"
        for name in names:
            rows = per_query[name]
            if (not unique_rows(rows, "id", 548)
                    or Counter(row.get("subset") for row in rows) != {"tuning": 359, "holdout": 181, "mixed": 8}
                    or any(not {"text", "template", "graded_gold", "ranked_pages", "ndcg5", "p5_graded", "p1_strict"} <= row.keys() for row in rows)):
                return f"Concept {name} lacks 548 complete, unique question records with the planned split"
            if name in {"gbrain", "vector-grep-rrf-fusion"} and not complete_observations(
                    config.get("observed_by_adapter", {}).get(name, {}).get("search_observations"), 548,
                    [row["id"] for row in rows], reranker=cell == "concept-rerank"):
                return f"Concept {name} lacks complete search metadata"
    elif cell == "baselines":
        runs = data.get("runs_by_adapter", {})
        if set(runs) != {"gbrain", "vector-grep-rrf-fusion", "grep-only", "vector"}:
            return "Baseline receipt is missing a planned adapter"
        for name, repetitions in runs.items():
            if len(repetitions) != 3 or {run.get("seed") for run in repetitions} != {1, 2, 3}:
                return f"Baseline {name} lacks the three ingestion repeats"
            for run in repetitions:
                count = 145 if name == "gbrain" else 216
                rows = run.get("perQuery")
                if not unique_rows(rows, "query_id", count):
                    return f"Baseline {name} lacks complete question rankings"
                if name == "vector-grep-rrf-fusion" and not complete_observations(
                        (run.get("observed") or {}).get("search_observations"), count, [row["query_id"] for row in rows]):
                    return "Baseline hybrid repeat lacks complete search metadata"
    elif cell == "source-swamp":
        rows = attempt_report(receipt, destination).get("results", [])
        expected = {"gbrain", "gbrain-no-source-boost", "vector-grep-rrf-fusion", "grep-only", "vector"}
        if len(rows) != 5 or {row.get("name") for row in rows} != expected:
            return "Source comparison is missing a planned adapter"
        for row in rows:
            queries = row.get("per_query")
            if not unique_rows(queries, "id", 30):
                return f"Source {row['name']} lacks 30 unique question rankings"
            if row["name"] in {"gbrain", "gbrain-no-source-boost", "vector-grep-rrf-fusion"} and not complete_observations(
                    (row.get("observed") or {}).get("search_observations"), 30, [query["id"] for query in queries]):
                return f"Source {row['name']} lacks complete search metadata"
    elif cell.startswith("precision-"):
        report = attempt_report(receipt, destination)
        cases = report.get("cases")
        observations = report.get("search_observations")
        if not unique_rows(cases, "caseId", 77):
            return "Precision report lacks 77 unique scored cases"
        if not complete_observations(observations, 72, keyword=cell == "precision-keyword", reranker=cell.endswith("rerank")):
            return "Precision report lacks complete metadata for its 72 search calls"
        if not unique_rows(observations, "case_id", 72) or not {o["case_id"] for o in observations} <= {case["caseId"] for case in cases}:
            return "Precision search observations do not map to the scored cases"
    return None


def validate_attempt(cell, destination, exit_code):
    """Separate an experiment's measured loss from a broken experiment."""
    receipts = list(destination.rglob("receipt.json"))
    if len(receipts) != 1:
        return dict(valid=False, reason=f"Expected one receipt, found {len(receipts)}")
    try:
        receipt = json.loads(receipts[0].read_text())
    except (OSError, ValueError) as error:
        return dict(valid=False, reason="Unreadable receipt: " + str(error))
    if (receipt.get("run_status") != "completed" or receipt.get("errors")
            or receipt.get("n_total") != EXPECTED_PROBES[cell] or receipt.get("n_scored") != receipt.get("n_total")
            or receipt.get("completion_rate") != 1):
        return dict(valid=False, reason="Receipt is incomplete, skipped, or contains execution errors")
    subset = cell in ("concept-ungated", "concept-rerank")
    if subset:
        # Cat 13 intentionally calls any adapter subset 'partial'. The matrix
        # defines these two single-adapter cells in advance; every probe is required.
        names = [row["name"] for row in receipt.get("data", {}).get("scorecard", [])]
        if names != ["gbrain"] or receipt.get("verdict") != "partial" or receipt["n_total"] != 548:
            return dict(valid=False, reason="Concept subset did not complete the intended gbrain-only cell")
    elif receipt.get("publishable") is not True:
        return dict(valid=False, reason="Receipt is not publishable")
    # The source-swamp absolute quality gate can fail on a complete measurement.
    quality_loss = exit_code == 1 and receipt.get("verdict") == "fail" and cell == "source-swamp"
    if exit_code != 0 and not quality_loss:
        return dict(valid=False, reason=f"Unexpected child exit code {exit_code}")
    try:
        incomplete = metadata_contract(cell, destination, receipt)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        incomplete = "Unreadable per-query evidence: " + str(error)
    if incomplete:
        return dict(valid=False, reason=incomplete)
    return dict(valid=True, reason="Complete planned subset" if subset else "Complete measurement",
                quality_gate=receipt.get("verdict"), receipt=str(receipts[0].relative_to(destination)))


def command(cell, destination):
    out = str(destination)
    if cell == "baselines":
        return ["eval/runner/multi-adapter.ts", "--queries", "all", "--receipt-path", out + "/receipt.json"]
    if cell == "relationships":
        return ["eval/runner/relational-ab.ts", "--reports-dir", out]
    if cell.startswith("concept-"):
        opts = dict(reportsDir=out, embeddingModel="voyage:voyage-4", embeddingDims=1024,
                    reranker="on" if cell == "concept-rerank" else "off", autocut="off", seed=42,
                    searchPins={"search.metadata_boost_gate": "always" if cell == "concept-ungated" else "lexical",
                                "search.expansion": "false", "search.cache.enabled": "false",
                                "search.relational_rerank_pin": "3", "search.adaptive_return": "false"})
        if cell != "concept-baselines":
            opts["only"] = "gbrain"
        code = "import {runCat13} from './eval/runner/cat13-conceptual.ts'; process.exit((await runCat13(" + json.dumps(opts) + ")).exitCode);"
        return ["-e", code]
    if cell == "source-swamp":
        return ["-e", "import {runCat13b} from './eval/runner/cat13b-source-swamp.ts'; process.exit((await runCat13b(" + json.dumps({"reportsDir": out}) + ")).exitCode);"]
    mode = "gbrain-keyword" if cell == "precision-keyword" else "gbrain-adaptive" if "adaptive" in cell else "gbrain-hybrid"
    args = ["eval/runner/precisionmembench.ts", "--mode", mode, "--reranker", "on" if cell.endswith("rerank") else "off",
            "--autocut", "off", "--embedding-model", "openai:text-embedding-3-large", "--embedding-dims", "1536",
            "--report-dir", out, "--receipt-path", out + "/receipt.json"]
    if "adaptive" in cell:
        args += ["--entity-max", "1", "--other-max", "1", "--min-keep", "1"]
    return args


def atomic_ledger_write(path, ledger):
    """Readers see either the old complete ledger or the new complete ledger."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".budget-ledger-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(ledger, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def harness_identity():
    files = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in HARNESS_FILES}
    combined = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return combined, files


class MatrixRunner:
    """One process-wide budget ledger shared by at most three child workers."""
    def __init__(self, output, ledger, jobs=1):
        self.output = output
        self.ledger = ledger
        self.ledger_path = output / "budget-ledger.json"
        self.lock = threading.Lock()
        self.jobs = jobs

    def run_cell(self, cell):
        # Reservation, attempt numbering, and durable writes are one critical
        # section. No child is started before its full $25 is in the ledger.
        with self.lock:
            reserved = sum(a["reservation_usd"] for a in self.ledger["attempts"])
            if reserved + RESERVATION_USD > self.ledger["aggregate_ceiling_usd"]:
                return cell, "Aggregate API budget exhausted before " + cell
            number = 1 + max((a["attempt"] for a in self.ledger["attempts"] if a["cell"] == cell), default=0)
            destination = self.output / cell / ("attempt-" + str(number))
            # An unrecorded directory from an interrupted setup still belongs
            # to that old attempt; preserve it and allocate the next number.
            while destination.exists():
                number += 1
                destination = self.output / cell / ("attempt-" + str(number))
            destination.mkdir(parents=True)
            cmd = ["bun", "--preload", str(ROOT / "scripts/retrieval-usage.ts")] + command(cell, destination)
            harness_sha256, harness_files = harness_identity()
            attempt = dict(cell=cell, attempt=number, directory=str(destination.relative_to(self.output)),
                           reservation_usd=RESERVATION_USD, started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           command=cmd, status="running", jobs=self.jobs,
                           harness_sha256=harness_sha256, harness_files=harness_files)
            self.ledger["attempts"].append(attempt)
            atomic_ledger_write(self.ledger_path, self.ledger)
            print(f"{cell}: attempt {number}, ${reserved + RESERVATION_USD:.0f} reserved of ${self.ledger['aggregate_ceiling_usd']:.0f}", flush=True)

        env = dict(os.environ, BRAINBENCH_N="3", CAT13_PROBES="500",
                   GBRAIN_EVAL_USAGE_LOG=str(destination / "usage.ndjson"), GBRAIN_EVAL_API_CAP_USD=str(RESERVATION_USD))
        env.pop("GBRAIN_SOURCE_BOOST", None)
        start = time.monotonic()
        finished = {}
        try:
            with (destination / "run.log").open("w") as log:
                result = subprocess.run(cmd, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
                finished.update(exit_code=result.returncode, status="finished")
        except subprocess.TimeoutExpired:
            finished.update(exit_code=124, status="timed-out")
        except OSError as error:
            finished.update(exit_code=127, status="launch-failed", launch_error=str(error))
        finished["wall_seconds"] = round(time.monotonic() - start, 3)
        finished["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        usage_file = destination / "usage.ndjson"
        try:
            events = [json.loads(line) for line in usage_file.read_text().splitlines() if line.strip()] if usage_file.exists() else []
            finished["api_attempts"] = sum(e["event"] == "reserved" for e in events)
            finished["conservative_request_cost_usd"] = sum(e["reserved_usd"] for e in events if e["event"] == "reserved")
            finished["gross_usage_estimate_usd"] = sum(e.get("gross_estimated_usd") or 0 for e in events)
            terminal_ids = {e.get("id") for e in events if e["event"] in {"completed", "failed"}}
            finished["requests_without_usage"] = sum(
                e["event"] == "failed" or (e["event"] == "completed" and e["usage_tokens"] is None)
                or (e["event"] == "reserved" and e.get("id") not in terminal_ids) for e in events)
            finished["validation"] = validate_attempt(cell, destination, finished["exit_code"])
        except (OSError, ValueError, KeyError, TypeError) as error:
            finished["validation"] = dict(valid=False, reason="Unreadable usage log: " + str(error))
        with self.lock:
            # Mutate the shared object only under the same lock as reservation
            # writes, so a concurrently finishing child cannot lose an update.
            attempt.update(finished)
            atomic_ledger_write(self.ledger_path, self.ledger)
            cost = finished.get("gross_usage_estimate_usd")
            estimate = f"${cost:.4f}" if cost is not None else "unavailable"
            print(f"{cell}: attempt {number}, exit {attempt['exit_code']}, {attempt['wall_seconds']}s, usage estimate {estimate}", flush=True)
        return cell, None if attempt["validation"]["valid"] else attempt["validation"]["reason"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cells", default=",".join(CELLS))
    parser.add_argument("--output-dir", default="eval/reports/retrieval-refresh")
    parser.add_argument("--api-budget", type=float, default=1000)
    parser.add_argument("--jobs", type=int, choices=range(1, 4), default=1,
                        help="independent cell subprocesses (default: 1; maximum: 3)")
    args = parser.parse_args()
    cells = args.cells.split(",")
    if not set(cells) <= set(CELLS):
        parser.error("Unknown cell; choose from " + ", ".join(CELLS))
    if not 0 < args.api_budget <= 1000:
        parser.error("Budget must be positive and at most the authorized $1000 ceiling")
    output = (ROOT / args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Hold the lock throughout this invocation so another matrix process cannot
    # overwrite reservations or launch an attempt against stale budget state.
    lock = (output / ".budget.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another matrix process holds this output directory's budget lock")
    ledger_path = output / "budget-ledger.json"
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {
        "schema_version": 1, "aggregate_ceiling_usd": args.api_budget, "reservation_per_attempt_usd": 25,
        "note": "Reservations are conservative preflight limits, not spend. Each attempted HTTP call is metered in usage.ndjson.",
        "pricing_sources": ["https://developers.openai.com/api/docs/models/text-embedding-3-large", "https://docs.voyageai.com/docs/pricing"],
        "attempts": []}
    ceiling = min(ledger["aggregate_ceiling_usd"], args.api_budget)
    if sum(a["reservation_usd"] for a in ledger["attempts"]) > ceiling:
        raise SystemExit("Aggregate API budget exhausted: existing reservations exceed the requested ceiling")
    ledger["aggregate_ceiling_usd"] = ceiling
    atomic_ledger_write(ledger_path, ledger)
    runner = MatrixRunner(output, ledger, args.jobs)
    invalid = []
    with ThreadPoolExecutor(max_workers=args.jobs) as workers:
        submitted = {workers.submit(runner.run_cell, cell): cell for cell in cells}
        for future in as_completed(submitted):
            cell = submitted[future]
            try:
                _, failure = future.result()
            except Exception as error:
                failure = "Orchestrator error: " + str(error)
            if failure:
                invalid.append(f"{cell}: {failure}")
    if invalid:
        raise SystemExit("Invalid matrix cells (attempts retained): " + "; ".join(invalid))



if __name__ == "__main__":
    main()
