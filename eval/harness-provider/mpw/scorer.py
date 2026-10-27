"""Strict scorer for harness cells.

`judge_answer` turns one AnswerRecord into one JudgeRecord; `aggregate` turns a
cell's scheduled question ids and JudgeRecords into counts and means over a
fixed denominator. The judging itself is the pinned harness's code: its
per-dataset judge prompts (`get_judge_prompt_fn` / `build_judge_prompt` /
`memory_bench.judge._PROMPT` through `GeminiJudge.score`), its MCQ letter
match (`memory_bench.runner._score_mcq`), BEAM's rubric prompts and clamp
(`BEAMDataset.score_result`) and PrecisionMemBench's `score_retrieval`. What
changes is what happens around them:

- every judge response passes through `StrictJudge`, which checks each
  required field against the schema with exact JSON types (`correct` must be
  a real boolean; the string "false" is not), retries once with the same
  prompt, and otherwise makes the row a judge_failure;
- a BEAM row is graded only when every rubric item got a valid judgment;
- an answer is judged even when its retrieved context was empty, and an
  answer that declines is labelled `abstention` and still judged;
- the denominator is the cell's schedule, never the rows that happened to
  produce a score.

See ../SCORER.md for the published list of differences.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .records import (
    ABSTENTION,
    ANSWER_FAILURE,
    ANSWERED,
    INCOMPLETE_INGEST,
    JUDGE_FAILURE,
    OUTCOMES,
    RETRIEVAL_FAILURE,
    JudgeRecord,
)

JUDGED = (ANSWERED, ABSTENTION)
SYSTEM_FAILURES = (ANSWER_FAILURE, RETRIEVAL_FAILURE, INCOMPLETE_INGEST)
BLOCKS_COMPLETION = (JUDGE_FAILURE, INCOMPLETE_INGEST)

# Numeric fields whose valid range the judge prompt states. BEAM's rubric
# prompt asks for 0.0, 0.5 or 1.0; anything outside [0, 1] is not a judgment.
FIELD_RANGES = {"score": (0.0, 1.0)}


class JudgeFieldError(Exception):
    """The judge returned no response whose fields match the schema."""


class JudgeModelMismatch(RuntimeError):
    """The judge model about to be used is not the expected one."""


# ---------------------------------------------------------------------------
# Abstention label
# ---------------------------------------------------------------------------

# An answer is an abstention when it is empty or when one of these phrases
# appears in its first ABSTENTION_WINDOW characters (after lower-casing and
# straightening quotes). The label is descriptive: abstentions are judged
# like any other answer, so the label never changes a score.
ABSTENTION_WINDOW = 240
ABSTENTION_PATTERNS = tuple(
    re.compile(p)
    for p in (
        r"\b(?:i|we) (?:do not|don't|cannot|can't|am unable to|am not able to) (?:have|find|know|answer|determine|tell|recall|see)\b",
        r"\bnot enough (?:information|context|details)\b",
        r"\binsufficient (?:information|context|details)\b",
        r"\bthere (?:is|are) no (?:information|mention|record|details?|data|memories|evidence)\b",
        r"\bno (?:information|mention|record|details?|data|memories) (?:about|on|regarding|related to|of|for)\b",
        r"\b(?:is|was|are|were) not (?:mentioned|provided|specified|stated|available|included|present|discussed)\b",
        r"\b(?:context|memories|conversation|chat|records?) (?:does|do|did) not (?:contain|mention|include|provide|say|specify|state)\b",
        r"\bunable to (?:answer|determine|find)\b",
    )
)


def is_abstention(answer: str) -> bool:
    text = (answer or "").strip().lower().replace("\u2019", "'").replace("\u2018", "'")
    if not text:
        return True
    head = text[:ABSTENTION_WINDOW]
    return any(p.search(head) for p in ABSTENTION_PATTERNS)


# ---------------------------------------------------------------------------
# Strict judge facade
# ---------------------------------------------------------------------------

def check_fields(data: Any, schema) -> list[str]:
    """Problems with a judge response against a harness Schema; [] when valid.

    Types are exact JSON types: a boolean must be `true`/`false` (not the
    string "false", not 0/1), a number must be a finite int or float (not a
    string, not a boolean), a string must be a string. Fields outside the
    schema are ignored.
    """
    if not isinstance(data, dict):
        return [f"response is {type(data).__name__}, not an object"]
    problems = []
    for name in schema.required:
        if name not in data:
            problems.append(f"missing field {name!r}")
            continue
        value = data[name]
        kind = schema.properties.get(name, {}).get("type", "string")
        if kind == "boolean":
            ok = type(value) is bool
        elif kind == "number":
            ok = type(value) in (int, float) and math.isfinite(value)
        elif kind == "integer":
            ok = type(value) is int
        elif kind == "string":
            ok = isinstance(value, str)
        else:
            ok = False
        if not ok:
            problems.append(f"field {name!r} is {json.dumps(value, default=str)[:80]}, not a JSON {kind}")
            continue
        bounds = FIELD_RANGES.get(name) if kind in ("number", "integer") else None
        if bounds and not bounds[0] <= value <= bounds[1]:
            problems.append(f"field {name!r} is {value}, outside [{bounds[0]}, {bounds[1]}]")
    return problems


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class StrictJudge:
    """The LLM handed to harness judging code.

    `generate(prompt, schema)` returns only a response that passes
    `check_fields`; it retries once with the same prompt and otherwise raises
    JudgeFieldError. Every call is recorded in `items` (one item per
    `generate` call, with its attempts). Responses are JSON round-tripped so a
    fresh response and a cached one validate identically. With `cache_dir`,
    responses are stored and replayed by (model, prompt, schema, attempt).
    """

    def __init__(self, llm, cache_dir: Path | None = None, retries: int = 1):
        self._llm = llm
        self._cache_dir = Path(cache_dir) if cache_dir else None
        self._retries = retries
        self.items: list[dict] = []

    @property
    def model_id(self) -> str:
        return self._llm.model_id

    def _fetch(self, prompt: str, schema, attempt: int) -> Any:
        key = _sha256(json.dumps(
            {"model": self.model_id, "prompt": prompt, "properties": schema.properties,
             "required": schema.required, "attempt": attempt},
            sort_keys=True,
        ))
        path = self._cache_dir / f"{key}.json" if self._cache_dir else None
        if path and path.exists():
            return json.loads(path.read_text())["response"]
        raw = self._llm.generate(prompt, schema)
        data = json.loads(json.dumps(raw, default=str))
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"model": self.model_id, "attempt": attempt,
                                       "prompt_sha256": _sha256(prompt), "response": data}, indent=2) + "\n")
            tmp.replace(path)
        return data

    def generate(self, prompt: str, schema) -> dict:
        item: dict = {"model": self.model_id, "prompt": prompt, "prompt_sha256": _sha256(prompt),
                      "attempts": [], "valid": False, "response": None}
        self.items.append(item)
        for attempt in range(self._retries + 1):
            try:
                data = self._fetch(prompt, schema, attempt)
            except Exception as exc:
                item["attempts"].append({"attempt": attempt, "error": f"{type(exc).__name__}: {exc}"})
                continue
            problems = check_fields(data, schema)
            item["attempts"].append({"attempt": attempt, "response": data, "problems": problems})
            if not problems:
                item["valid"] = True
                item["response"] = data
                return data
        last = item["attempts"][-1]
        raise JudgeFieldError(f"{self.model_id}: no valid judgment after {len(item['attempts'])} attempts "
                              f"({last.get('error') or '; '.join(last['problems'])})")


# ---------------------------------------------------------------------------
# Judge resolution
# ---------------------------------------------------------------------------

def resolve_judge_llm(dataset):
    """The dataset's own judge (`default_judge_llm()`, e.g. BEAM's fixed model) else OMB_JUDGE_*."""
    own = dataset.default_judge_llm() if hasattr(dataset, "default_judge_llm") else None
    if own is not None:
        return own
    from memory_bench.llm import get_judge_llm

    return get_judge_llm()


def needs_judge(dataset) -> bool:
    return dataset.task_type == "open"


def map_retrieved(documents: Iterable[dict], id_map: Callable[[str], str | None]) -> list:
    """Harness Documents from RetrieveRecord document dicts with ids mapped back.

    `id_map` is the scorer-only reverse map from opaque ids to dataset ids; an
    id it does not know (None) is kept as returned, so it cannot match a
    dataset id.
    """
    from memory_bench.models import Document

    def back(identifier):
        if identifier is None:
            return None
        mapped = id_map(identifier)
        return identifier if mapped is None else mapped

    out = []
    for d in documents:
        source_ids = d.get("source_ids")
        out.append(Document(
            id=back(d.get("id")),
            content=d.get("content") or "",
            user_id=d.get("user_id"),
            messages=d.get("messages"),
            timestamp=d.get("timestamp"),
            context=d.get("context"),
            source_ids=[back(s) for s in source_ids] if source_ids else None,
            tags=d.get("tags"),
        ))
    return out


# ---------------------------------------------------------------------------
# Per-question scoring
# ---------------------------------------------------------------------------

_CRITERION = re.compile(r"RUBRIC CRITERION:\n(.*?)\n\nSCORING GUIDELINES", re.DOTALL)


def rubric_failures(items: list[dict]) -> list[dict]:
    """Rubric judge calls without a valid judgment."""
    return [i for i in items if not i["valid"]]


def _record(cell_id, query_id, outcome, score, correct, judge_model, reason="", **extra) -> JudgeRecord:
    return JudgeRecord(cell_id=cell_id, query_id=query_id, outcome=outcome, score=score, correct=correct,
                       judge_model=judge_model, reason=reason, **extra)


def _judge_failure(cell_id, query_id, judge: StrictJudge | None, error: str, rubric=None) -> JudgeRecord:
    return _record(cell_id, query_id, JUDGE_FAILURE, None, None, judge.model_id if judge else None,
                   reason="no valid judgment", error=error, rubric=rubric,
                   requests=judge.items if judge else [])


def _score_rubric(dataset, query, answer: dict, label: str, judge: StrictJudge, cell_id: str) -> JudgeRecord:
    from memory_bench.models import QueryResult

    tmp = QueryResult(
        query_id=query.id, query=query.query, answer=answer.get("answer") or "",
        reasoning="", context=answer.get("rendered_context") or "",
        context_tokens=0, retrieve_time_ms=0.0,
        gold_answers=query.gold_answers, correct=False, judge_reason="",
        meta=query.meta,
    )
    try:
        harness_score = float(dataset.score_result(tmp, judge))
    except Exception as exc:
        return _judge_failure(cell_id, query.id, judge, f"score_result raised {type(exc).__name__}: {exc}")
    rubric = [
        {
            "criterion": (m.group(1) if (m := _CRITERION.search(i["prompt"])) else None),
            "valid": i["valid"],
            "score": i["response"]["score"] if i["valid"] else None,
            "reason": i["response"]["reason"] if i["valid"] else None,
            "attempts": len(i["attempts"]),
        }
        for i in judge.items
    ]
    if not judge.items:
        return _judge_failure(cell_id, query.id, judge, "no rubric items were judged (no rubric and no gold answer)")
    failed = rubric_failures(judge.items)
    if failed:
        return _judge_failure(cell_id, query.id, judge,
                              f"{len(failed)} of {len(judge.items)} rubric items have no valid judgment", rubric=rubric)
    return _record(cell_id, query.id, label, harness_score, harness_score >= 0.5, judge.model_id,
                   reason=f"score={harness_score:.3f} over {len(rubric)} rubric items", rubric=rubric,
                   requests=judge.items)


def _score_binary(dataset, query, answer: dict, label: str, judge: StrictJudge, cell_id: str) -> JudgeRecord:
    from memory_bench.judge import GeminiJudge

    if hasattr(dataset, "get_judge_prompt_fn"):
        prompt_fn = dataset.get_judge_prompt_fn(
            query.meta.get("question_type") or query.meta.get("category"), meta=query.meta,
        )
    else:
        prompt_fn = dataset.build_judge_prompt
    try:
        result = GeminiJudge(llm=judge).score(query.query, answer.get("answer") or "", query.gold_answers, prompt_fn)
    except Exception as exc:
        return _judge_failure(cell_id, query.id, judge, f"{type(exc).__name__}: {exc}")
    return _record(cell_id, query.id, label, 1.0 if result.correct else 0.0, result.correct, judge.model_id,
                   reason=result.reason, requests=judge.items)


def judge_answer(
    *,
    dataset,
    split: str,
    query,
    answer: Mapping[str, Any],
    judge_llm=None,
    expected_judge_model: str | None = None,
    cell_id: str,
    retrieved_original: list | None = None,
    cache_dir: Path | None = None,
    retries: int = 1,
) -> JudgeRecord:
    """Score one scheduled question. Never raises on a judge problem.

    Raises only on caller errors: a judge model other than the expected one,
    a missing judge for an open-ended dataset, an answer for another
    question, an unknown outcome, or a retrieval answer without documents.
    """
    answer = asdict(answer) if hasattr(answer, "__dataclass_fields__") else dict(answer)
    if answer.get("query_id") != query.id:
        raise ValueError(f"answer is for {answer.get('query_id')!r}, query is {query.id!r}")
    task_type = dataset.task_type
    if task_type not in ("open", "mcq", "retrieval"):
        raise ValueError(f"task type {task_type!r} is not scored by mpw.scorer")
    if task_type == "open":
        if judge_llm is None or expected_judge_model is None:
            raise ValueError(f"{dataset.name} is judged by an LLM; pass judge_llm and expected_judge_model")
        if judge_llm.model_id != expected_judge_model:
            raise JudgeModelMismatch(f"{dataset.name} judge is {judge_llm.model_id}, expected {expected_judge_model}")

    outcome = answer.get("outcome")
    if outcome in SYSTEM_FAILURES or not answer.get("ok"):
        kind = outcome if outcome in SYSTEM_FAILURES else ANSWER_FAILURE
        return _record(cell_id, query.id, kind, None if kind == INCOMPLETE_INGEST else 0.0, False, None,
                       reason=f"{kind}: nothing to judge", error=answer.get("error"))
    if outcome not in JUDGED:
        raise ValueError(f"answer for {query.id} has unknown outcome {outcome!r}")

    if task_type == "retrieval":
        if retrieved_original is None:
            raise ValueError(f"retrieval answer for {query.id} needs retrieved_original documents")
        scratch = copy.deepcopy(query)
        try:
            passed, reason = dataset.score_retrieval(scratch, retrieved_original)
        except Exception as exc:
            return _judge_failure(cell_id, query.id, None, f"score_retrieval raised {type(exc).__name__}: {exc}")
        details = {k: v for k, v in scratch.meta.items() if k not in query.meta or query.meta[k] != v}
        return _record(cell_id, query.id, ANSWERED, 1.0 if passed else 0.0, bool(passed), None,
                       reason=reason, details=details)

    text = answer.get("answer") or ""
    label = ABSTENTION if is_abstention(text) else ANSWERED
    if task_type == "mcq":
        from memory_bench.runner import _score_mcq

        correct, reason = _score_mcq(text, query.gold_answers)
        return _record(cell_id, query.id, label, 1.0 if correct else 0.0, correct, None, reason=reason)

    judge = StrictJudge(judge_llm, cache_dir=cache_dir, retries=retries)
    if hasattr(dataset, "score_result"):
        return _score_rubric(dataset, query, answer, label, judge, cell_id)
    return _score_binary(dataset, query, answer, label, judge, cell_id)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def aggregate(scheduled_ids: list[str], records: Mapping[str, Any] | Iterable[Any], cell_id: str | None = None) -> dict:
    """Counts and means over a fixed denominator: every scheduled question.

    Policy:
      - denominator = number of scheduled ids, always;
      - answered and abstention rows contribute their judged score;
      - answer_failure, retrieval_failure, judge_failure, incomplete_ingest
        and scheduled ids without a record contribute 0;
      - `complete` is false when any scheduled id lacks a record or any row
        is judge_failure or incomplete_ingest (the cell must be resumed or
        re-judged before its numbers count);
      - a record for an unscheduled id, a duplicate record, a record from
        another cell or an inconsistent record raises: rows are never
        silently dropped or merged.
    `mean_score` is the graded mean (BEAM rubric mean; equal to accuracy for
    binary datasets). `accuracy` is correct rows over the same denominator.
    """
    ids = list(scheduled_ids)
    if not ids:
        raise ValueError("empty schedule: a cell needs at least one scheduled question")
    if len(set(ids)) != len(ids):
        raise ValueError("schedule has duplicate query ids")
    scheduled = set(ids)
    rows = records.values() if isinstance(records, Mapping) else records
    by_id: dict[str, dict] = {}
    for r in rows:
        d = asdict(r) if hasattr(r, "__dataclass_fields__") else dict(r)
        qid = d["query_id"]
        if cell_id is not None and d.get("cell_id") != cell_id:
            raise ValueError(f"record {qid} belongs to cell {d.get('cell_id')}, not {cell_id}")
        if qid not in scheduled:
            raise ValueError(f"record {qid} is not in the schedule")
        if qid in by_id:
            raise ValueError(f"duplicate record for {qid}")
        if d["outcome"] not in OUTCOMES:
            raise ValueError(f"record {qid} has unknown outcome {d['outcome']!r}")
        if d["outcome"] in JUDGED:
            s = d.get("score")
            if type(s) not in (int, float) or not 0.0 <= s <= 1.0 or type(d.get("correct")) is not bool:
                raise ValueError(f"record {qid} is {d['outcome']} without a valid score and correct flag")
        by_id[qid] = d

    counts = {o: 0 for o in OUTCOMES}
    missing: list[str] = []
    score_sum = 0.0
    correct = 0
    for qid in ids:
        d = by_id.get(qid)
        if d is None:
            missing.append(qid)
            continue
        counts[d["outcome"]] += 1
        if d["outcome"] in JUDGED:
            score_sum += float(d["score"])
            correct += d["correct"] is True
    n = len(ids)
    return {
        "scheduled": n,
        "counts": {**counts, "missing": len(missing)},
        "judged": counts[ANSWERED] + counts[ABSTENTION],
        "correct": correct,
        "accuracy": correct / n,
        "mean_score": score_sum / n,
        "complete": not missing and all(counts[o] == 0 for o in BLOCKS_COMPLETION),
        "missing_ids": missing,
        "judge_failure_ids": [q for q in ids if q in by_id and by_id[q]["outcome"] == JUDGE_FAILURE],
        "incomplete_ingest_ids": [q for q in ids if q in by_id and by_id[q]["outcome"] == INCOMPLETE_INGEST],
    }
