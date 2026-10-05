"""Golden tests: each known fail-open path in the pinned harness scorer, run
against the real harness code, beside the strict scorer's result."""
from __future__ import annotations

import json
from dataclasses import asdict
from types import SimpleNamespace

import pytest

from conftest import BEAM_JUDGE, ScriptedLLM, answer_record
from memory_bench.models import AnswerResult, EvalSummary, Query, QueryResult
from mpw import scorer
from mpw.records import ABSTENTION, ANSWER_FAILURE, ANSWERED, INCOMPLETE_INGEST, JUDGE_FAILURE, RETRIEVAL_FAILURE

CELL = "cell-golden"
OPEN_JUDGE = "openai:judge-under-test"


def binary_query(qid="q1", gold="Paris") -> Query:
    return Query(id=qid, query="Where did I travel in May?", gold_ids=[], gold_answers=[gold],
                 meta={"category": 1})


def locomo():
    from memory_bench.dataset.locomo import LoComoDataset

    return LoComoDataset()


def harness_runner(tmp_path):
    """An EvalRunner whose aggregate/save code runs unmodified (no judge client is built)."""
    from memory_bench.runner import EvalRunner

    runner = EvalRunner.__new__(EvalRunner)
    runner.output_dir = tmp_path / "harness-out"
    runner._dataset_metrics = {}
    return runner


def query_result(qid, correct, score=None) -> QueryResult:
    return QueryResult(query_id=qid, query="q", answer="a", reasoning="", context="c", context_tokens=1,
                       retrieve_time_ms=0.0, gold_answers=["g"], correct=correct, judge_reason="", score=score)


def summary(results) -> EvalSummary:
    return EvalSummary(dataset="beam", split="100k", category=None, memory_provider="fake", run_name="fake",
                       mode="rag", oracle=False, total_queries=len(results), correct=sum(r.correct for r in results),
                       accuracy=0.0, ingestion_time_ms=0.0, ingested_docs=0, results=results)


def saved_accuracy(runner, results) -> float:
    runner._save(summary(results))
    path = runner._output_path("beam", "100k", "fake", "rag")
    return json.loads(path.read_text())["accuracy"]


# ---------------------------------------------------------------------------
# 1. Empty context drops out of BEAM's graded mean
# ---------------------------------------------------------------------------

def test_empty_context_row_dropped_from_graded_mean_in_harness_not_ours(tmp_path, beam, beam_queries, fake_gemini):
    """BEAM: one 1.0 answer plus one empty-context answer. The real harness run reports 1.0; ours 0.5."""
    from memory_bench.memory.base import MemoryProvider
    from memory_bench.modes.base import ResponseMode
    from memory_bench.runner import EvalRunner

    answers = {
        "What is the name of my dog?": ("Your dog is named Rex.", "## Memory 1\nI adopted a dog and named him Rex."),
        "Which city did I move to?": ("I don't have enough information to answer this question.", ""),
    }

    class Memory(MemoryProvider):
        name = "fake"
        description = kind = "test"
        concurrency = 1

        def ingest(self, documents):
            pass

        def retrieve(self, query, k=10, user_id=None, query_timestamp=None, filters=None):
            return [], None

    class Mode(ResponseMode):
        name = "rag"
        description = "test"

        @property
        def llm_id(self):
            return "fake:answer"

        def answer(self, query, memory, task_type="open", user_id=None):
            text, context = answers[query]
            return AnswerResult(answer=text, reasoning="", context=context, retrieve_time_ms=0.0)

        def answer_from_context(self, query, context, task_type="open"):
            raise NotImplementedError

    harness = EvalRunner(output_dir=tmp_path / "harness-out").run(
        beam, "100k", Memory(), Mode(), category="information_extraction",
    )
    rows = {r.query_id: r for r in harness.results}
    assert rows["c1_information_extraction_0"].score == 1.0
    assert rows["c1_information_extraction_1"].score is None
    assert rows["c1_information_extraction_1"].judge_reason.startswith("empty context")
    assert harness.accuracy == 1.0
    saved = json.loads((tmp_path / "harness-out/beam/fake/rag/100k.json").read_text())
    assert saved["accuracy"] == 1.0 and saved["total_queries"] == 2

    judge = scorer.resolve_judge_llm(beam)
    records = {}
    for qid, query in beam_queries.items():
        if not qid.startswith("c1_information_extraction"):
            continue
        text, context = answers[query.query]
        records[qid] = scorer.judge_answer(
            dataset=beam, split="100k", query=query, answer=answer_record(CELL, qid, text, context=context),
            judge_llm=judge, expected_judge_model=BEAM_JUDGE, cell_id=CELL,
        )
    assert records["c1_information_extraction_1"].outcome == ABSTENTION
    assert records["c1_information_extraction_1"].score == 0.0
    agg = scorer.aggregate(list(records), records, CELL)
    assert agg["mean_score"] == 0.5 and agg["scheduled"] == 2 and agg["complete"]


# ---------------------------------------------------------------------------
# 2. Abstention with empty context is judged
# ---------------------------------------------------------------------------

def test_abstention_with_empty_context_is_judged(beam, beam_queries, fake_gemini):
    query = beam_queries["c1_abstention_0"]
    text = "Based on the provided chat, there is no information related to a cat."
    judge = scorer.resolve_judge_llm(beam)
    record = scorer.judge_answer(
        dataset=beam, split="100k", query=query, answer=answer_record(CELL, query.id, text, context=""),
        judge_llm=judge, expected_judge_model=BEAM_JUDGE, cell_id=CELL,
    )
    assert record.outcome == ABSTENTION
    assert record.score == 1.0 and record.correct is True
    assert record.judge_model == BEAM_JUDGE
    assert len(judge.prompts) == 1 and text in judge.prompts[0]


def test_binary_abstention_with_empty_context_is_judged():
    calls = []
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: calls.append(p) or {"correct": False, "reason": "declined"})
    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=binary_query(),
        answer=answer_record(CELL, "q1", "The context does not mention any travel.", context=""),
        judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
    )
    assert record.outcome == ABSTENTION and record.correct is False and record.score == 0.0
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# 3. bool("false") passes in the harness judge
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", ["false", "true", "", "no", 0, 1, None])
def test_non_boolean_correct_passes_harness_judge_but_is_judge_failure_here(value):
    from memory_bench.judge import GeminiJudge

    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: {"correct": value, "reason": "r"})
    harness = GeminiJudge(llm=judge).score("Where did I travel?", "Rome", ["Paris"], locomo().build_judge_prompt)
    assert harness.correct is bool(value)

    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=binary_query(), answer=answer_record(CELL, "q1", "Rome"),
        judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE
    assert record.score is None and record.correct is None
    assert len(record.requests) == 1 and len(record.requests[0]["attempts"]) == 2
    assert record.requests[0]["prompt"] == judge.prompts[-1] == judge.prompts[-2]


def test_string_false_is_the_harness_pass():
    from memory_bench.judge import GeminiJudge

    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: {"correct": "false", "reason": "wrong city"})
    assert GeminiJudge(llm=judge).score("q", "Rome", ["Paris"]).correct is True


def test_invalid_then_valid_retry_uses_the_same_prompt():
    script = [{"correct": "false", "reason": "r"}, {"correct": False, "reason": "wrong city"}]
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: script[n - 1])
    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=binary_query(), answer=answer_record(CELL, "q1", "Rome"),
        judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
    )
    assert record.outcome == ANSWERED and record.correct is False and record.score == 0.0
    assert judge.prompts[0] == judge.prompts[1]


@pytest.mark.parametrize("response", [{"reason": "r"}, {"correct": True}, {"correct": True, "reason": 3}, "yes", None])
def test_missing_or_mistyped_fields_are_judge_failure(response):
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: response)
    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=binary_query(), answer=answer_record(CELL, "q1", "Paris"),
        judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE


def test_judge_exception_is_judge_failure_not_raised():
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: RuntimeError("upstream 500"))
    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=binary_query(), answer=answer_record(CELL, "q1", "Paris"),
        judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE and "upstream 500" in record.error


def test_valid_judgment_uses_the_dataset_judge_prompt():
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: {"correct": True, "reason": "matches"})
    query = binary_query()
    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=query, answer=answer_record(CELL, "q1", "Paris"),
        judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
    )
    assert record.outcome == ANSWERED and record.correct is True and record.score == 1.0
    assert judge.prompts == [locomo().build_judge_prompt(query.query, query.gold_answers, "Paris")]


# ---------------------------------------------------------------------------
# 4. Gemini's last-resort fill
# ---------------------------------------------------------------------------

def test_gemini_last_resort_text_fill(monkeypatch):
    """Unparseable Gemini text becomes every required field; the harness reads it as correct."""
    import memory_bench.llm.gemini as gemini_mod
    from memory_bench.judge import GeminiJudge

    text = "The answer does not match the gold answer."
    response = SimpleNamespace(parsed=None, candidates=[SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(text=text)]))])
    calls = []
    client = SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kw: calls.append(kw) or response))
    monkeypatch.setattr(gemini_mod.time, "sleep", lambda s: None)
    gemini = gemini_mod.GeminiLLM.__new__(gemini_mod.GeminiLLM)
    gemini._client, gemini._model = client, "gemini-test"

    filled = gemini.generate("prompt", __import__("memory_bench.judge", fromlist=["_SCHEMA"])._SCHEMA)
    assert filled == {"correct": text, "reason": text}
    assert GeminiJudge(llm=gemini).score("q", "Rome", ["Paris"]).correct is True

    record = scorer.judge_answer(
        dataset=locomo(), split="locomo10", query=binary_query(), answer=answer_record(CELL, "q1", "Rome"),
        judge_llm=gemini, expected_judge_model="gemini:gemini-test", cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE
    assert "not a JSON boolean" in record.error


# ---------------------------------------------------------------------------
# 5. BEAM rubric exceptions become silent zeros in the harness
# ---------------------------------------------------------------------------

def _rubric_breaks_on_lisbon(prompt, schema, call):
    if "should state: Lisbon" in prompt:
        return RuntimeError("judge timeout")
    return {"score": 1.0, "reason": "present"}


def test_beam_rubric_exception_is_zero_in_harness_incomplete_here(beam, beam_queries, fake_gemini):
    query = beam_queries["c1_multi_session_reasoning_0"]
    text = "You mentioned Rex and Lisbon."
    fake_gemini["respond"] = _rubric_breaks_on_lisbon

    tmp = QueryResult(query_id=query.id, query=query.query, answer=text, reasoning="", context="c",
                      context_tokens=0, retrieve_time_ms=0.0, gold_answers=query.gold_answers, correct=False,
                      judge_reason="", meta=query.meta)
    assert beam.score_result(tmp, beam.default_judge_llm()) == 0.5

    record = scorer.judge_answer(
        dataset=beam, split="100k", query=query, answer=answer_record(CELL, query.id, text),
        judge_llm=scorer.resolve_judge_llm(beam), expected_judge_model=BEAM_JUDGE, cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE and record.score is None
    assert [r["valid"] for r in record.rubric] == [True, False]
    assert record.rubric[0]["criterion"] == "LLM response should state: Rex"
    agg = scorer.aggregate([query.id], {query.id: record}, CELL)
    assert agg["complete"] is False and agg["judge_failure_ids"] == [query.id]


@pytest.mark.parametrize("bad", [{"score": "1.0", "reason": "r"}, {"score": 7, "reason": "r"},
                                 {"score": True, "reason": "r"}, {"score": 1.0}])
def test_beam_rubric_mistyped_score_is_judge_failure(beam, beam_queries, fake_gemini, bad):
    query = beam_queries["c1_information_extraction_0"]
    fake_gemini["respond"] = lambda p, s, n: bad
    record = scorer.judge_answer(
        dataset=beam, split="100k", query=query, answer=answer_record(CELL, query.id, "Rex"),
        judge_llm=scorer.resolve_judge_llm(beam), expected_judge_model=BEAM_JUDGE, cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE


def test_beam_all_rubric_items_scored(beam, beam_queries, fake_gemini):
    query = beam_queries["c1_multi_session_reasoning_0"]
    record = scorer.judge_answer(
        dataset=beam, split="100k", query=query, answer=answer_record(CELL, query.id, "Only Rex."),
        judge_llm=scorer.resolve_judge_llm(beam), expected_judge_model=BEAM_JUDGE, cell_id=CELL,
    )
    assert record.outcome == ANSWERED and record.score == 0.5 and record.correct is True
    assert [r["score"] for r in record.rubric] == [1.0, 0.0]


def test_beam_without_rubric_or_gold_is_judge_failure(beam, beam_queries, fake_gemini):
    query = beam_queries["c1_information_extraction_0"]
    bare = Query(id=query.id, query=query.query, gold_ids=[], gold_answers=[], meta={"question_category": "information_extraction"})
    record = scorer.judge_answer(
        dataset=beam, split="100k", query=bare, answer=answer_record(CELL, query.id, "Rex"),
        judge_llm=scorer.resolve_judge_llm(beam), expected_judge_model=BEAM_JUDGE, cell_id=CELL,
    )
    assert record.outcome == JUDGE_FAILURE and "no rubric" in record.error


# ---------------------------------------------------------------------------
# 6. Fixed denominator, typed system failures, no merged reruns
# ---------------------------------------------------------------------------

def test_denominator_fixed_when_rows_are_missing(tmp_path):
    runner = harness_runner(tmp_path)
    assert saved_accuracy(runner, [query_result("q1", True)]) == 1.0

    rec = scorer._record(CELL, "q1", ANSWERED, 1.0, True, OPEN_JUDGE)
    agg = scorer.aggregate(["q1", "q2", "q3"], {"q1": rec}, CELL)
    assert agg["scheduled"] == 3 and agg["mean_score"] == pytest.approx(1 / 3)
    assert agg["counts"]["missing"] == 2 and agg["missing_ids"] == ["q2", "q3"]
    assert agg["complete"] is False


def test_harness_beam_mean_skips_unscored_rows(tmp_path):
    runner = harness_runner(tmp_path)
    assert saved_accuracy(runner, [query_result("q1", True, 1.0), query_result("q2", False, None)]) == 1.0


def test_system_failures_count_zero_and_skip_the_judge():
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: pytest.fail("judge must not be called"))
    records = {}
    for qid, outcome in (("a", ANSWER_FAILURE), ("b", RETRIEVAL_FAILURE), ("c", INCOMPLETE_INGEST)):
        records[qid] = scorer.judge_answer(
            dataset=locomo(), split="locomo10", query=binary_query(qid),
            answer=answer_record(CELL, qid, "", outcome=outcome, ok=False, error="boom"),
            judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL,
        )
    assert [records[q].outcome for q in "abc"] == [ANSWER_FAILURE, RETRIEVAL_FAILURE, INCOMPLETE_INGEST]
    assert records["a"].score == 0.0 and records["c"].score is None
    records["d"] = scorer._record(CELL, "d", ANSWERED, 1.0, True, OPEN_JUDGE)
    agg = scorer.aggregate(list("abcd"), records, CELL)
    assert agg["mean_score"] == 0.25 and agg["accuracy"] == 0.25
    assert agg["complete"] is False and agg["incomplete_ingest_ids"] == ["c"]
    del records["c"]
    agg = scorer.aggregate(list("abd"), records, CELL)
    assert agg["complete"] is True and agg["mean_score"] == pytest.approx(1 / 3)


def test_harness_merges_reruns_ours_refuses_foreign_rows(tmp_path):
    runner = harness_runner(tmp_path)
    runner._save(summary([query_result("q1", True), query_result("q2", False)]))
    merged = runner._merge([query_result("q2", True)], "beam", "100k", "fake", "rag")
    assert sorted(r.query_id for r in merged) == ["q1", "q2"] and all(r.correct for r in merged)

    old = scorer._record("cell-old", "q1", ANSWERED, 1.0, True, OPEN_JUDGE)
    new = scorer._record(CELL, "q2", ANSWERED, 1.0, True, OPEN_JUDGE)
    with pytest.raises(ValueError, match="belongs to cell cell-old"):
        scorer.aggregate(["q1", "q2"], {"q1": old, "q2": new}, CELL)


def test_aggregate_rejects_unscheduled_duplicate_and_inconsistent_rows():
    good = scorer._record(CELL, "q1", ANSWERED, 1.0, True, OPEN_JUDGE)
    with pytest.raises(ValueError, match="not in the schedule"):
        scorer.aggregate(["q2"], [good], CELL)
    with pytest.raises(ValueError, match="duplicate record"):
        scorer.aggregate(["q1"], [good, good], CELL)
    with pytest.raises(ValueError, match="duplicate query ids"):
        scorer.aggregate(["q1", "q1"], [good], CELL)
    with pytest.raises(ValueError, match="empty schedule"):
        scorer.aggregate([], [], CELL)
    bad = scorer._record(CELL, "q1", ANSWERED, None, None, OPEN_JUDGE)
    with pytest.raises(ValueError, match="without a valid score"):
        scorer.aggregate(["q1"], [bad], CELL)


# ---------------------------------------------------------------------------
# 7. Judge model resolution and assertion; MCQ; retrieval
# ---------------------------------------------------------------------------

def test_beam_uses_its_own_judge_and_the_model_is_asserted(beam, beam_queries, fake_gemini, monkeypatch):
    monkeypatch.setenv("OMB_JUDGE_LLM", "gemini")
    monkeypatch.setenv("OMB_JUDGE_MODEL", "gemini-2.5-flash-lite")
    judge = scorer.resolve_judge_llm(beam)
    assert judge.model_id == BEAM_JUDGE
    query = beam_queries["c1_information_extraction_0"]
    with pytest.raises(scorer.JudgeModelMismatch):
        scorer.judge_answer(dataset=beam, split="100k", query=query, answer=answer_record(CELL, query.id, "Rex"),
                            judge_llm=judge, expected_judge_model="gemini:gemini-2.5-flash-lite", cell_id=CELL)
    assert judge.prompts == []


def test_datasets_without_their_own_judge_use_omb_judge(fake_gemini, monkeypatch):
    monkeypatch.setenv("OMB_JUDGE_LLM", "gemini")
    monkeypatch.setenv("OMB_JUDGE_MODEL", "gemini-judge-x")
    assert scorer.resolve_judge_llm(locomo()).model_id == "gemini:gemini-judge-x"


def test_open_dataset_requires_judge_and_expected_model():
    with pytest.raises(ValueError, match="judged by an LLM"):
        scorer.judge_answer(dataset=locomo(), split="locomo10", query=binary_query(),
                            answer=answer_record(CELL, "q1", "Paris"), cell_id=CELL)


def test_mcq_is_exact_letter_match_without_a_judge():
    from memory_bench.dataset.personamem import PersonaMemDataset

    dataset = PersonaMemDataset()
    query = Query(id="m1", query="Pick one", gold_ids=[], gold_answers=["(b)"], meta={})
    right = scorer.judge_answer(dataset=dataset, split="32k", query=query, answer=answer_record(CELL, "m1", "b"), cell_id=CELL)
    wrong = scorer.judge_answer(dataset=dataset, split="32k", query=query, answer=answer_record(CELL, "m1", "c", context=""), cell_id=CELL)
    empty = scorer.judge_answer(dataset=dataset, split="32k", query=query, answer=answer_record(CELL, "m1", "", context=""), cell_id=CELL)
    assert (right.outcome, right.correct, right.score, right.judge_model) == (ANSWERED, True, 1.0, None)
    assert (wrong.outcome, wrong.correct) == (ANSWERED, False)
    assert (empty.outcome, empty.correct) == (ABSTENTION, False)


def test_retrieval_scores_mapped_ids():
    class Retrieval:
        name = "retrieval-fixture"
        task_type = "retrieval"

        def score_retrieval(self, query, retrieved):
            ids = [d.id for d in retrieved] + [s for d in retrieved for s in (d.source_ids or [])]
            query.meta["seen"] = ids
            return "belief-7" in ids, f"saw {ids}"

    reverse = {"d-aaaaaa01": "belief-7", "d-aaaaaa02": "belief-9"}
    docs = scorer.map_retrieved(
        [{"id": "d-aaaaaa02", "content": "x"}, {"id": "f-1", "content": "y", "source_ids": ["d-aaaaaa01"]}],
        reverse.get,
    )
    assert [d.id for d in docs] == ["belief-9", "f-1"] and docs[1].source_ids == ["belief-7"]
    query = Query(id="r1", query="what", gold_ids=[], gold_answers=[], meta={})
    record = scorer.judge_answer(dataset=Retrieval(), split="single", query=query,
                                 answer=answer_record(CELL, "r1", "2 memories retrieved"),
                                 cell_id=CELL, retrieved_original=docs)
    assert record.outcome == ANSWERED and record.correct is True and record.score == 1.0
    assert record.details == {"seen": ["belief-9", "f-1", "belief-7"]} and query.meta == {}
    with pytest.raises(ValueError, match="retrieved_original"):
        scorer.judge_answer(dataset=Retrieval(), split="single", query=query,
                            answer=answer_record(CELL, "r1", "x"), cell_id=CELL)


# ---------------------------------------------------------------------------
# 8. Abstention classifier
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "", "   ",
    "I don't have enough information to answer this question.",
    "Based on the provided chat, there is no information related to a cat.",
    "The context does not mention a cat.",
    "That was not mentioned in our conversations.",
    "I\u2019m sorry, I can\u2019t find that. I don't know.",
    "Unable to determine from the memories.",
])
def test_abstention_classifier_positive(text):
    assert scorer.is_abstention(text)


@pytest.mark.parametrize("text", [
    "Your dog is named Rex.",
    "You moved to Lisbon in 2023, after the job offer.",
    "There is conflicting information: you said Lisbon and later Porto. Which is correct?",
    "Rex. " + "Details follow. " * 30 + "Your cat was not mentioned.",
])
def test_abstention_classifier_negative(text):
    assert not scorer.is_abstention(text)


def test_judge_cache_replays_without_calls(tmp_path):
    judge = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: {"correct": True, "reason": "ok"})
    kwargs = dict(dataset=locomo(), split="locomo10", query=binary_query(), answer=answer_record(CELL, "q1", "Paris"),
                  expected_judge_model=OPEN_JUDGE, cell_id=CELL, cache_dir=tmp_path / "cache")
    first = scorer.judge_answer(judge_llm=judge, **kwargs)
    offline = ScriptedLLM(OPEN_JUDGE, lambda p, s, n: pytest.fail("cache miss"))
    second = scorer.judge_answer(judge_llm=offline, **kwargs)
    assert asdict(first) == asdict(second)
