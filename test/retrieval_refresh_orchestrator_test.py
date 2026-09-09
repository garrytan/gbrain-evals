"""A quality loss may be valid evidence; an incomplete run never is."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import textwrap
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "refresh", Path(__file__).resolve().parents[1] / "scripts/run-retrieval-refresh.py")
REFRESH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REFRESH)
SUMMARY_SPEC = importlib.util.spec_from_file_location(
    "summary", Path(__file__).resolve().parents[1] / "scripts/summarize-retrieval-refresh.py")
SUMMARY = importlib.util.module_from_spec(SUMMARY_SPEC)
SUMMARY_SPEC.loader.exec_module(SUMMARY)


def observation(identifier, keyword=False, reranker=False):
    return dict(query_id=identifier, case_id=identifier, query="example query", mode="keyword" if keyword else "hybrid",
                result_count=0, rerank_scored=False, ranked_results=[], failures=[], relational_meta=None,
                search_meta=None if keyword else dict(vector_enabled=True, detail_resolved="medium", expansion_applied=False, degraded=[]))


def complete_contract(receipt, destination, cell):
    """Synthetic receipts exercise orchestration only; no search or API calls."""
    data = receipt.setdefault("data", {})
    config = receipt.setdefault("resolved_config", {})
    if cell == "relationships":
        config.update(stub_embed=False, ingestion_seeds=[1, 2, 3],
            embedder=dict(model="openai:text-embedding-3-large", dimensions=1536),
            common_search_pins=dict(REFRESH.RELATIONAL_PINS), relational_retrieval=dict(off=False, on=True),
            product_limit=5, precision_denominator=5)
        data["indices"] = [dict(seed=seed, index_id=f"index-{seed}", config_readback=dict(REFRESH.RELATIONAL_PINS))
                           for seed in (1, 2, 3)]
        def arm(enabled, identifier):
            return dict(relational_retrieval=enabled, rows=[], pages=[], query_embed_calls=1,
                query_vector_sha256=f"{identifier:064x}", relational_meta=[dict(errored=False)] if enabled else [],
                search_meta=dict(vector_enabled=True, expansion_applied=False, degraded=[]),
                metrics=dict(precision_at_5=0, recall_at_5=0, hit_at_1=0, hit_at_5=0))
        data["per_query"] = [dict(seed=seed, index_id=f"index-{seed}", query_id=f"q{i}",
            text=f"Example question {i}", template="example", relevant=["example-page"],
            off=arm(False, i), on=arm(True, i)) for seed in (1, 2, 3) for i in range(145)]
    elif cell.startswith("concept-"):
        names = ["gbrain", "vector-grep-rrf-fusion", "grep-only", "vector"] if cell == "concept-baselines" else ["gbrain"]
        data["scorecard"] = [dict(name=name) for name in names]
        data["per_query"] = {name: [dict(id=f"q{i}", text="example", template="example", graded_gold={"page": 3}, ranked_pages=[],
            subset="tuning" if i < 359 else "holdout" if i < 540 else "mixed", ndcg5=0, p5_graded=0, p1_strict=0) for i in range(548)] for name in names}
        config["observed_by_adapter"] = {name: dict(search_observations=[observation(f"q{i}") for i in range(548)])
            for name in names if name in {"gbrain", "vector-grep-rrf-fusion"}}
    elif cell == "source-swamp":
        rows = []
        for name in ["gbrain", "gbrain-no-source-boost", "vector-grep-rrf-fusion", "grep-only", "vector"]:
            rows.append(dict(name=name, per_query=[dict(id=f"q{i}") for i in range(30)],
                             observed=dict(search_observations=[observation(f"q{i}") for i in range(30)])))
        report = destination / "report.json"
        report.write_text(json.dumps(dict(results=rows)))
        data["report_file"] = str(report)
    elif cell == "baselines":
        data["runs_by_adapter"] = {}
        for name in ["gbrain", "vector-grep-rrf-fusion", "grep-only", "vector"]:
            count = 145 if name == "gbrain" else 216
            data["runs_by_adapter"][name] = [dict(seed=seed, perQuery=[dict(query_id=f"q{i}") for i in range(count)],
                observed=dict(search_observations=[observation(f"q{i}") for i in range(count)])) for seed in [1, 2, 3]]
    elif cell.startswith("precision-"):
        report = destination / "report.json"
        report.write_text(json.dumps(dict(cases=[dict(caseId=f"q{i}") for i in range(77)],
            search_observations=[observation(f"q{i}", keyword=cell == "precision-keyword") for i in range(72)])))
        data["report_path"] = str(report)


class PairedScores(unittest.TestCase):
    def test_duplicate_ids_and_changed_gold_are_rejected(self):
        before = [dict(id="a", score=0, graded_gold={"page": 3})]
        with self.assertRaises(AssertionError):
            SUMMARY.paired(before * 2, before, "id", "score")
        with self.assertRaises(AssertionError):
            SUMMARY.paired(before, [dict(id="a", score=1, graded_gold={"other": 3})], "id", "score")

    def test_null_is_distinct_from_a_loss(self):
        before = [dict(id="gain", score=0), dict(id="loss", score=1), dict(id="unknown", score=None)]
        after = [dict(id="gain", score=1), dict(id="loss", score=0), dict(id="unknown", score=1)]
        result = SUMMARY.paired(before, after, "id", "score")
        self.assertEqual(result["counts"], dict(gains=1, losses=1, ties=0, excluded_null=1))
        self.assertEqual(result["n"], 3)
        self.assertEqual(result["comparable"], 2)


class ReportRelocation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "new-checkout" / "precision-hybrid" / "attempt-2"
        report = self.directory / "nested" / "identified.json"
        report.parent.mkdir(parents=True)
        report.write_text(json.dumps(dict(selected="identified report")))
        (self.directory / "report.json").write_text(json.dumps(dict(selected="unrelated report")))

    def tearDown(self):
        self.temp.cleanup()

    def read(self, path):
        return REFRESH.attempt_report(dict(data=dict(report_path=path)), self.directory)

    def test_relocated_receipt_uses_its_identified_report_suffix(self):
        for prefix in ("/original/checkout", "docs/saved-matrix"):
            with self.subTest(prefix=prefix):
                result = self.read(prefix + "/precision-hybrid/attempt-2/nested/identified.json")
                self.assertEqual(result["selected"], "identified report")

    def test_foreign_cell_attempt_traversal_and_ambiguous_markers_are_rejected(self):
        for path in ("/original/precision-adaptive/attempt-2/nested/identified.json",
                     "/original/precision-hybrid/attempt-1/nested/identified.json",
                     "/original/precision-hybrid/attempt-2/nested/../nested/identified.json",
                     "/precision-hybrid/attempt-2/precision-hybrid/attempt-2/nested/identified.json"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.read(path)

    def test_missing_identified_report_never_falls_back_to_another_json_file(self):
        with self.assertRaises(FileNotFoundError):
            self.read("/original/precision-hybrid/attempt-2/missing.json")

    def test_symlink_escape_is_rejected(self):
        outside = Path(self.temp.name) / "outside.json"
        outside.write_text("{}")
        (self.directory / "escape.json").symlink_to(outside)
        with self.assertRaises(ValueError):
            self.read("/original/precision-hybrid/attempt-2/escape.json")


class RelationalEvidence(unittest.TestCase):
    def test_complete_pairs_pass_and_missing_or_inconsistent_evidence_fails(self):
        mutations = {
            "aggregate only": lambda r: r["data"].pop("per_query"),
            "missing pair": lambda r: r["data"]["per_query"].pop(),
            "duplicate query": lambda r: r["data"]["per_query"][0].update(query_id="q1"),
            "foreign shared index": lambda r: r["data"]["per_query"][0].update(index_id="other-index"),
            "different arm vectors": lambda r: r["data"]["per_query"][0]["on"].update(query_vector_sha256="f" * 64),
            "embedding unused": lambda r: r["data"]["per_query"][0]["on"].update(query_embed_calls=0),
            "six chunks": lambda r: r["data"]["per_query"][0]["on"].update(rows=[dict(slug="page")] * 6, pages=["page"]),
            "wrong page order": lambda r: r["data"]["per_query"][0]["on"].update(rows=[dict(slug="a"), dict(slug="b")], pages=["b", "a"]),
            "silent arm error": lambda r: r["data"]["per_query"][0]["on"].update(error=dict(origin="sut", message="failed")),
            "missing ON telemetry": lambda r: r["data"]["per_query"][0]["on"].update(relational_meta=[]),
            "unexpected OFF telemetry": lambda r: r["data"]["per_query"][0]["off"].update(relational_meta=[dict(errored=False)]),
            "failed-open relationship": lambda r: r["data"]["per_query"][0]["on"]["relational_meta"][0].update(errored=True),
            "failed-open vector": lambda r: r["data"]["per_query"][0]["on"]["search_meta"].update(vector_enabled=False),
            "search degradation": lambda r: r["data"]["per_query"][0]["on"]["search_meta"].update(degraded=[dict(stage="vector_search")]),
            "nonfinite score": lambda r: r["data"]["per_query"][0]["on"]["metrics"].update(recall_at_5=float("nan")),
            "changed gold across seeds": lambda r: r["data"]["per_query"][145].update(relevant=["different-page"]),
            "changed readback": lambda r: r["data"]["indices"][0]["config_readback"].update({"search.graph_signals": "false"}),
            "stub control": lambda r: r["resolved_config"].update(stub_embed=True),
        }
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name, mutate in [("complete evidence", None), *mutations.items()]:
                with self.subTest(case=name):
                    receipt = dict(run_status="completed", errors=[], n_total=870, n_scored=870,
                                   completion_rate=1, publishable=True, verdict="pass")
                    complete_contract(receipt, directory, "relationships")
                    if mutate:
                        mutate(receipt)
                    (directory / "receipt.json").write_text(json.dumps(receipt))
                    result = REFRESH.validate_attempt("relationships", directory, 0)
                    self.assertEqual(result["valid"], mutate is None, result)


class InterruptedUsage(unittest.TestCase):
    def test_inflight_calls_remain_unknown_after_timeout_without_double_counting_terminal_calls(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            ledger = dict(aggregate_ceiling_usd=25, attempts=[])
            runner = REFRESH.MatrixRunner(directory, ledger)
            def timeout(command, **options):
                events = [dict(event="reserved", id=i, reserved_usd=0.1) for i in range(1, 5)]
                events += [dict(event="completed", id=1, usage_tokens=1, gross_estimated_usd=0.001),
                           dict(event="completed", id=2, usage_tokens=None, gross_estimated_usd=None),
                           dict(event="failed", id=3)]
                Path(options["env"]["GBRAIN_EVAL_USAGE_LOG"]).write_text(
                    "".join(json.dumps(event) + "\n" for event in events))
                raise subprocess.TimeoutExpired(command, 1800)
            with patch.object(REFRESH.subprocess, "run", timeout), patch("builtins.print"):
                _, failure = runner.run_cell("precision-hybrid")
            attempt = ledger["attempts"][0]
            self.assertIsNotNone(failure)
            self.assertEqual(attempt["status"], "timed-out")
            self.assertEqual(attempt["api_attempts"], 4)
            self.assertEqual(attempt["requests_without_usage"], 3)
            self.assertEqual(attempt["gross_usage_estimate_usd"], 0.001)
            self.assertEqual(attempt["conservative_request_cost_usd"], 0.4)
            self.assertEqual(attempt["reservation_usd"], 25)


class ReceiptValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.receipt = dict(run_status="completed", errors=[], n_total=77, n_scored=77,
                            completion_rate=1, publishable=True, verdict="pass")

    def tearDown(self):
        self.temp.cleanup()

    def validate(self, cell="precision-hybrid", code=0):
        complete_contract(self.receipt, self.directory, cell)
        (self.directory / "receipt.json").write_text(json.dumps(self.receipt))
        return REFRESH.validate_attempt(cell, self.directory, code)["valid"]

    def test_missing_receipt_and_timeout_are_not_success(self):
        self.assertFalse(REFRESH.validate_attempt("precision-hybrid", self.directory, 0)["valid"])
        self.assertFalse(self.validate(code=124))

    def test_errors_and_short_denominators_invalidate(self):
        self.receipt["errors"] = [{"origin": "sut", "message": "Embedding failed"}]
        self.assertFalse(self.validate())
        self.receipt["errors"] = []
        self.receipt["n_scored"] = 76
        self.assertFalse(self.validate())

    def test_a_measured_source_swamp_loss_is_publishable(self):
        self.receipt.update(verdict="fail", n_total=150, n_scored=150)
        self.assertTrue(self.validate("source-swamp", 1))
        self.receipt["publishable"] = False
        self.assertFalse(self.validate("source-swamp", 1))

    def test_only_the_complete_predefined_concept_subset_is_valid(self):
        self.receipt.update(verdict="partial", publishable=False, n_total=548, n_scored=548,
                            data={"scorecard": [{"name": "gbrain"}]})
        self.assertTrue(self.validate("concept-rerank"))
        self.assertFalse(self.validate("concept-baselines"))
        self.receipt["n_total"] = self.receipt["n_scored"] = 200
        self.assertFalse(self.validate("concept-rerank"))

    def test_old_aggregate_only_concept_results_are_rejected(self):
        self.receipt.update(n_total=2192, n_scored=2192)
        (self.directory / "receipt.json").write_text(json.dumps(self.receipt))
        self.assertFalse(REFRESH.validate_attempt("concept-baselines", self.directory, 0)["valid"])

    def test_duplicate_or_changed_concept_splits_are_rejected(self):
        self.receipt.update(n_total=548, n_scored=548, verdict="partial", publishable=False)
        complete_contract(self.receipt, self.directory, "concept-rerank")
        rows = self.receipt["data"]["per_query"]["gbrain"]
        rows[0]["id"] = rows[1]["id"]
        (self.directory / "receipt.json").write_text(json.dumps(self.receipt))
        self.assertFalse(REFRESH.validate_attempt("concept-rerank", self.directory, 0)["valid"])
        rows[0]["id"] = "q0"
        rows[0]["subset"] = "holdout"
        (self.directory / "receipt.json").write_text(json.dumps(self.receipt))
        self.assertFalse(REFRESH.validate_attempt("concept-rerank", self.directory, 0)["valid"])

    def test_old_hybrid_metadata_is_rejected_for_each_runner(self):
        for cell in ["baselines", "source-swamp", "precision-hybrid"]:
            with self.subTest(cell=cell):
                self.receipt.update(n_total=REFRESH.EXPECTED_PROBES[cell], n_scored=REFRESH.EXPECTED_PROBES[cell])
                complete_contract(self.receipt, self.directory, cell)
                if cell == "baselines":
                    self.receipt["data"]["runs_by_adapter"]["vector-grep-rrf-fusion"][1]["observed"] = {"queries": 216}
                elif cell == "source-swamp":
                    report = self.directory / "report.json"
                    data = json.loads(report.read_text())
                    data["results"][0]["observed"] = {"queries": 30}
                    report.write_text(json.dumps(data))
                else:
                    report = self.directory / "report.json"
                    data = json.loads(report.read_text())
                    del data["search_observations"][0]["search_meta"]
                    report.write_text(json.dumps(data))
                (self.directory / "receipt.json").write_text(json.dumps(self.receipt))
                self.assertFalse(REFRESH.validate_attempt(cell, self.directory, 0)["valid"])

    def test_keyword_is_valid_without_hybrid_metadata_but_vector_fallback_is_not(self):
        self.assertTrue(self.validate("precision-keyword"))
        complete_contract(self.receipt, self.directory, "precision-hybrid")
        report = self.directory / "report.json"
        data = json.loads(report.read_text())
        data["search_observations"][0]["search_meta"]["vector_enabled"] = False
        report.write_text(json.dumps(data))
        (self.directory / "receipt.json").write_text(json.dumps(self.receipt))
        self.assertFalse(REFRESH.validate_attempt("precision-hybrid", self.directory, 0)["valid"])

    def test_concurrent_invocation_is_refused_before_launch(self):
        with (self.directory / ".budget.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = subprocess.run([sys.executable, str(REFRESH.ROOT / "scripts/run-retrieval-refresh.py"),
                "--cells", "precision-keyword", "--output-dir", str(self.directory)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("budget lock", result.stderr)
        self.assertFalse((self.directory / "precision-keyword").exists())

    def test_insufficient_remaining_budget_stops_before_launch(self):
        result = subprocess.run([sys.executable, str(REFRESH.ROOT / "scripts/run-retrieval-refresh.py"),
            "--cells", "precision-keyword", "--output-dir", str(self.directory), "--api-budget", "1"],
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("budget exhausted", result.stderr)
        self.assertFalse((self.directory / "precision-keyword").exists())


class ConcurrentMatrix(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.output = self.directory / "output"
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        fixtures = {}
        for cell in ["precision-keyword", "precision-hybrid", "source-swamp"]:
            target = self.directory / ("fixture-" + cell)
            target.mkdir()
            receipt = dict(run_status="completed", errors=[], n_total=REFRESH.EXPECTED_PROBES[cell], n_scored=REFRESH.EXPECTED_PROBES[cell],
                           completion_rate=1, publishable=True, verdict="fail" if cell == "source-swamp" else "pass")
            complete_contract(receipt, target, cell)
            fixtures[cell] = dict(receipt=receipt, report=json.loads((target / "report.json").read_text()))
        fixture_file = self.directory / "fixtures.json"
        fixture_file.write_text(json.dumps(fixtures))
        fake = self.bin / "bun"
        fake.write_text("#!" + sys.executable + "\n" + textwrap.dedent('''
            import json, os, sys, time
            from pathlib import Path
            destination = Path(os.environ["GBRAIN_EVAL_USAGE_LOG"]).parent
            output = destination.parent.parent
            cell = destination.parent.name
            ledger = json.loads((output / "budget-ledger.json").read_text())
            reserved = sum(row["reservation_usd"] for row in ledger["attempts"])
            assert reserved <= ledger["aggregate_ceiling_usd"]
            assert any(row.get("directory") == str(destination.relative_to(output)) and row["status"] == "running" for row in ledger["attempts"])
            assert os.environ["GBRAIN_EVAL_API_CAP_USD"] == "25"
            assert sys.argv[1] == "--preload"
            (destination / "fake-started.json").write_text(json.dumps(dict(start=time.monotonic(), reserved=reserved)))
            barrier = int(os.environ.get("FAKE_BARRIER", "0"))
            deadline = time.monotonic() + 5
            while len(list(output.rglob("fake-started.json"))) < barrier:
                if time.monotonic() > deadline:
                    raise RuntimeError("Concurrent children did not reach the barrier")
                time.sleep(0.01)
            time.sleep(0.06)
            fixture = json.loads(Path(os.environ["FAKE_FIXTURES"]).read_text())[cell]
            report = destination / "report.json"
            report.write_text(json.dumps(fixture["report"]))
            receipt = fixture["receipt"]
            key = "report_file" if cell == "source-swamp" else "report_path"
            receipt["data"][key] = str(report)
            (destination / "receipt.json").write_text(json.dumps(receipt))
            events = [dict(event="reserved", reserved_usd=0.01), dict(event="completed", usage_tokens=1, gross_estimated_usd=0.001)]
            Path(os.environ["GBRAIN_EVAL_USAGE_LOG"]).write_text("".join(json.dumps(event) + "\\n" for event in events))
            (destination / "fake-finished.json").write_text(json.dumps(dict(end=time.monotonic())))
            sys.exit(2 if cell == os.environ.get("FAKE_FAIL_CELL") else 1 if cell == "source-swamp" else 0)
        '''))
        fake.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""), FAKE_FIXTURES=str(fixture_file))

    def tearDown(self):
        self.temp.cleanup()

    def run_matrix(self, cells, *args, **environment):
        command = [sys.executable, str(REFRESH.ROOT / "scripts/run-retrieval-refresh.py"),
                   "--cells", ",".join(cells), "--output-dir", str(self.output), *args]
        process = subprocess.Popen(command, env=dict(self.env, **environment), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 15
        try:
            while process.poll() is None:
                path = self.output / "budget-ledger.json"
                if path.exists():
                    # Repeated reads during reservations and completions must
                    # never see a truncated JSON document or an overspend.
                    ledger = json.loads(path.read_text())
                    self.assertLessEqual(sum(a["reservation_usd"] for a in ledger["attempts"]), ledger["aggregate_ceiling_usd"])
                if time.monotonic() > deadline:
                    self.fail("Fake matrix did not finish")
                time.sleep(0.005)
            stdout, stderr = process.communicate()
            return process.returncode, stdout, stderr
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def ledger(self):
        return json.loads((self.output / "budget-ledger.json").read_text())

    def peak_children(self):
        events = [(json.loads(p.read_text())["start"], 1) for p in self.output.rglob("fake-started.json")]
        events += [(json.loads(p.read_text())["end"], -1) for p in self.output.rglob("fake-finished.json")]
        active = peak = 0
        for _, delta in sorted(events):
            active += delta
            peak = max(peak, active)
        return peak

    def test_three_jobs_overlap_and_each_reservation_is_durable_before_launch(self):
        code, _, stderr = self.run_matrix(["precision-keyword"] * 3, "--jobs", "3", "--api-budget", "75", FAKE_BARRIER="3")
        self.assertEqual(code, 0, stderr)
        attempts = self.ledger()["attempts"]
        self.assertEqual(self.peak_children(), 3)
        self.assertEqual(sorted(a["attempt"] for a in attempts), [1, 2, 3])
        self.assertEqual(len({a["directory"] for a in attempts}), 3)
        self.assertTrue(all(a["status"] == "finished" and a["validation"]["valid"] for a in attempts))
        self.assertTrue(all(len(a["harness_sha256"]) == 64 and "scripts/retrieval-usage.ts" in a["harness_files"] for a in attempts))

    def test_concurrent_workers_never_launch_beyond_remaining_budget(self):
        code, _, stderr = self.run_matrix(["precision-keyword"] * 4, "--jobs", "3", "--api-budget", "50", FAKE_BARRIER="2")
        self.assertNotEqual(code, 0)
        self.assertIn("budget exhausted", stderr)
        self.assertEqual(len(self.ledger()["attempts"]), 2)
        self.assertEqual(len(list(self.output.rglob("fake-started.json"))), 2)
        self.assertEqual(sum(a["reservation_usd"] for a in self.ledger()["attempts"]), 50)

    def test_default_remains_serial_and_historical_hashes_are_not_invented(self):
        self.output.mkdir()
        historical = dict(cell="precision-keyword", attempt=1, reservation_usd=25, status="finished")
        (self.output / "budget-ledger.json").write_text(json.dumps(dict(aggregate_ceiling_usd=100, attempts=[historical])))
        code, _, stderr = self.run_matrix(["precision-keyword"] * 3, "--api-budget", "100")
        self.assertEqual(code, 0, stderr)
        self.assertEqual(self.peak_children(), 1)
        attempts = self.ledger()["attempts"]
        self.assertEqual(attempts[0], historical)
        self.assertEqual([a["attempt"] for a in attempts[1:]], [2, 3, 4])

    def test_quality_loss_stays_valid_and_an_invalid_parallel_cell_fails_the_invocation(self):
        code, _, stderr = self.run_matrix(["source-swamp", "precision-keyword", "precision-hybrid"],
            "--jobs", "3", "--api-budget", "75", FAKE_BARRIER="3", FAKE_FAIL_CELL="precision-hybrid")
        self.assertNotEqual(code, 0)
        self.assertIn("precision-hybrid", stderr)
        attempts = {a["cell"]: a for a in self.ledger()["attempts"]}
        self.assertTrue(attempts["source-swamp"]["validation"]["valid"])
        self.assertEqual(attempts["source-swamp"]["exit_code"], 1)
        self.assertTrue(attempts["precision-keyword"]["validation"]["valid"])
        self.assertFalse(attempts["precision-hybrid"]["validation"]["valid"])

    def test_a_quality_loss_alone_does_not_fail_the_invocation(self):
        code, _, stderr = self.run_matrix(["source-swamp"], "--jobs", "3", "--api-budget", "25")
        self.assertEqual(code, 0, stderr)
        self.assertEqual(self.ledger()["attempts"][0]["validation"]["quality_gate"], "fail")

    def test_lowering_the_ceiling_below_old_reservations_never_launches(self):
        self.output.mkdir()
        ledger = dict(aggregate_ceiling_usd=100, attempts=[dict(cell="precision-keyword", attempt=1, reservation_usd=25)])
        (self.output / "budget-ledger.json").write_text(json.dumps(ledger))
        code, _, stderr = self.run_matrix(["precision-keyword"], "--jobs", "3", "--api-budget", "24")
        self.assertNotEqual(code, 0)
        self.assertIn("budget exhausted", stderr)
        self.assertEqual(self.ledger(), ledger)
        self.assertFalse(list(self.output.rglob("fake-started.json")))

    def test_job_limits_fail_before_any_child_launch(self):
        for jobs in ["0", "4", "not-a-number"]:
            code, _, stderr = self.run_matrix(["precision-keyword"], "--jobs", jobs)
            self.assertNotEqual(code, 0)
            self.assertIn("--jobs", stderr)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
