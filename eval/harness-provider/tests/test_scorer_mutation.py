"""Scorer mutation tests (the Python counterpart of eval/runner/mutation-kit.ts).

A conformance suite that a broken scorer can pass proves nothing. Each mutant
below reintroduces one historical fail-open behavior into mpw.scorer. The
honest scorer must pass every conformance check; each mutant must fail the
check aimed at it, which also shows the mutant really changed a result.
"""
from __future__ import annotations

import pytest

from conftest import BEAM_JUDGE, ScriptedLLM, answer_record
from mpw import scorer
from mpw.records import ABSTENTION, ANSWER_FAILURE, ANSWERED, JUDGE_FAILURE

CELL = "cell-mutation"
OPEN_JUDGE = "openai:judge-under-test"


def _locomo():
    from memory_bench.dataset.locomo import LoComoDataset

    return LoComoDataset()


def _query(qid="q1"):
    from memory_bench.models import Query

    return Query(id=qid, query="Where did I travel in May?", gold_ids=[], gold_answers=["Paris"], meta={"category": 1})


# ---------------------------------------------------------------------------
# Conformance checks: each returns None on pass or a failure description.
# ---------------------------------------------------------------------------

def check_failures_stay_in_denominator(ctx):
    records = {
        "a": scorer._record(CELL, "a", ANSWERED, 1.0, True, OPEN_JUDGE),
        "b": scorer.judge_answer(dataset=_locomo(), split="s", query=_query("b"),
                                 answer=answer_record(CELL, "b", "", outcome=ANSWER_FAILURE, ok=False),
                                 judge_llm=ScriptedLLM(OPEN_JUDGE, lambda *a: {"correct": True, "reason": ""}),
                                 expected_judge_model=OPEN_JUDGE, cell_id=CELL),
    }
    agg = scorer.aggregate(["a", "b", "c"], records, CELL)
    if agg["scheduled"] != 3 or agg["mean_score"] != pytest.approx(1 / 3) or agg["complete"]:
        return f"denominator not fixed: {agg['scheduled']} scheduled, mean {agg['mean_score']}, complete {agg['complete']}"
    return None


def check_string_false_is_judge_failure(ctx):
    judge = ScriptedLLM(OPEN_JUDGE, lambda *a: {"correct": "false", "reason": "wrong"})
    record = scorer.judge_answer(dataset=_locomo(), split="s", query=_query(), answer=answer_record(CELL, "q1", "Rome"),
                                 judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL)
    if record.outcome != JUDGE_FAILURE or record.correct is not None:
        return f'"false" string scored as {record.outcome} correct={record.correct}'
    return None


def check_empty_context_abstention_is_judged(ctx):
    judge = ScriptedLLM(OPEN_JUDGE, lambda *a: {"correct": True, "reason": "correct abstention"})
    record = scorer.judge_answer(dataset=_locomo(), split="s", query=_query(),
                                 answer=answer_record(CELL, "q1", "There is no information about May travel.", context=""),
                                 judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL)
    if record.outcome != ABSTENTION or record.correct is not True or len(judge.prompts) != 1:
        return f"empty-context abstention not judged: {record.outcome} correct={record.correct}, {len(judge.prompts)} judge calls"
    return None


def check_rubric_failure_is_incomplete(ctx):
    beam, queries, fake = ctx["beam"], ctx["beam_queries"], ctx["fake_gemini"]
    query = queries["c1_multi_session_reasoning_0"]
    fake["respond"] = lambda p, s, n: RuntimeError("judge timeout") if "Lisbon" in p.split("RUBRIC CRITERION:")[1] else {"score": 1.0, "reason": "ok"}
    try:
        record = scorer.judge_answer(dataset=beam, split="100k", query=query,
                                     answer=answer_record(CELL, query.id, "Rex and Lisbon"),
                                     judge_llm=scorer.resolve_judge_llm(beam), expected_judge_model=BEAM_JUDGE, cell_id=CELL)
    finally:
        fake["respond"] = ctx["default_respond"]
    agg = scorer.aggregate([query.id], {query.id: record}, CELL)
    if record.outcome != JUDGE_FAILURE or agg["complete"]:
        return f"rubric failure scored as {record.outcome} score={record.score}, complete={agg['complete']}"
    return None


def check_judge_model_asserted(ctx):
    judge = ScriptedLLM("openai:some-other-judge", lambda *a: {"correct": True, "reason": ""})
    try:
        scorer.judge_answer(dataset=_locomo(), split="s", query=_query(), answer=answer_record(CELL, "q1", "Paris"),
                            judge_llm=judge, expected_judge_model=OPEN_JUDGE, cell_id=CELL)
    except scorer.JudgeModelMismatch:
        return None if not judge.prompts else "judge called before the model check"
    return "a judge other than the expected model was used"


CHECKS = {
    "failures_stay_in_denominator": check_failures_stay_in_denominator,
    "string_false_is_judge_failure": check_string_false_is_judge_failure,
    "empty_context_abstention_is_judged": check_empty_context_abstention_is_judged,
    "rubric_failure_is_incomplete": check_rubric_failure_is_incomplete,
    "judge_model_asserted": check_judge_model_asserted,
}


def run_conformance(ctx) -> dict[str, str | None]:
    results = {}
    for name, fn in CHECKS.items():
        try:
            results[name] = fn(ctx)
        except Exception as exc:
            results[name] = f"raised {type(exc).__name__}: {exc}"
    return results


# ---------------------------------------------------------------------------
# Mutants: each reintroduces one historical fail-open behavior.
# ---------------------------------------------------------------------------

def mutant_drop_failures(monkeypatch):
    """Average only judged rows (the harness's BEAM mean over non-None scores)."""
    real = scorer.aggregate

    def aggregate(scheduled_ids, records, cell_id=None):
        rows = list(records.values()) if isinstance(records, dict) else list(records)
        kept = [r for r in rows if r.outcome in scorer.JUDGED]
        return real([r.query_id for r in kept], kept, cell_id)

    monkeypatch.setattr(scorer, "aggregate", aggregate)


def mutant_bool_cast(monkeypatch):
    """Accept any present field; the harness then casts `correct` with bool()."""
    monkeypatch.setattr(scorer, "check_fields",
                        lambda data, schema: [f"missing {k}" for k in schema.required if k not in (data or {})])


def mutant_skip_abstention_judging(monkeypatch):
    """Score empty-context answers wrong without calling the judge (the harness's empty-context guard)."""
    real = scorer.judge_answer

    def judge_answer(**kw):
        answer = kw["answer"]
        if answer.get("ok") and not answer.get("rendered_context"):
            return scorer._record(kw["cell_id"], kw["query"].id, ANSWERED, 0.0, False, None, reason="empty context")
        return real(**kw)

    monkeypatch.setattr(scorer, "judge_answer", judge_answer)


def mutant_silent_rubric_zero(monkeypatch):
    """Ignore rubric items without a valid judgment (the harness counts them as 0)."""
    monkeypatch.setattr(scorer, "rubric_failures", lambda items: [])


def mutant_no_model_check(monkeypatch):
    """Use whatever judge is passed in."""
    real = scorer.judge_answer

    def judge_answer(**kw):
        if kw.get("judge_llm") is not None:
            kw["expected_judge_model"] = kw["judge_llm"].model_id
        return real(**kw)

    monkeypatch.setattr(scorer, "judge_answer", judge_answer)


MUTANTS = {
    "drop_failures": (mutant_drop_failures, "failures_stay_in_denominator"),
    "bool_cast": (mutant_bool_cast, "string_false_is_judge_failure"),
    "skip_abstention_judging": (mutant_skip_abstention_judging, "empty_context_abstention_is_judged"),
    "silent_rubric_zero": (mutant_silent_rubric_zero, "rubric_failure_is_incomplete"),
    "no_model_check": (mutant_no_model_check, "judge_model_asserted"),
}


@pytest.fixture
def ctx(beam, beam_queries, fake_gemini):
    return {"beam": beam, "beam_queries": beam_queries, "fake_gemini": fake_gemini,
            "default_respond": fake_gemini["respond"]}


def test_honest_scorer_passes_every_check(ctx):
    results = run_conformance(ctx)
    assert results == {name: None for name in CHECKS}, results


@pytest.mark.parametrize("name", sorted(MUTANTS))
def test_mutant_fails_its_check(name, ctx, monkeypatch):
    apply, target = MUTANTS[name]
    apply(monkeypatch)
    results = run_conformance(ctx)
    assert results[target] is not None, f"mutant {name} passed {target}: the check cannot detect it"


def test_every_check_has_a_mutant():
    assert {target for _, target in MUTANTS.values()} == set(CHECKS)
