# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/benchmark/judge.py (Apache-2.0). Changes: none.
"""Resumable LongMemEval LLM-as-a-judge evaluation."""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI

from agent_memory_benchmark.benchmark.models import (
    AnswerRecord,
    ExperimentMetadata,
    JudgmentRecord,
    append_jsonl,
    experiment_dir,
    read_jsonl,
)
from agent_memory_benchmark.prompts import build_judge_prompt

logger = logging.getLogger(__name__)
DEFAULT_JUDGE_MODEL = "gpt-4o"
DEFAULT_SEED = 42


def resolve_experiment(value: str, results_root: Path) -> Path:
    candidate = Path(value).expanduser()
    if candidate.is_file() and candidate.name == "answers.jsonl":
        return candidate.parent
    if candidate.is_dir():
        return candidate
    named = experiment_dir(value, results_root, create=False)
    if named.is_dir():
        return named
    raise FileNotFoundError(
        f"Experiment {value!r} not found as a path or below {results_root}"
    )


def _key(record: AnswerRecord | JudgmentRecord) -> str:
    return record.question_id or f"{record.example_idx}:{record.question}"


def _score(text: str) -> int:
    lowered = text.strip().lower()
    if "yes" in lowered:
        return 1
    if "no" in lowered:
        return 0
    return -1


async def _judge_one(
    record: AnswerRecord,
    *,
    client: AsyncOpenAI,
    model: str,
    attempts: int,
) -> JudgmentRecord:
    prompt = build_judge_prompt(
        question=record.question,
        answer=record.ground_truth,
        response=record.predicted_answer,
        question_type=record.question_type,
        abstain=bool(record.question_id and record.question_id.endswith("_abs")),
    )
    for attempt in range(1, attempts + 1):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                seed=DEFAULT_SEED,
                max_tokens=10,
            )
            raw = response.choices[0].message.content or ""
            usage = response.usage
            return JudgmentRecord(
                example_idx=record.example_idx,
                question_id=record.question_id,
                dataset=record.dataset,
                split=record.split,
                provider=record.provider,
                question=record.question,
                ground_truth=record.ground_truth,
                predicted_answer=record.predicted_answer,
                score=_score(raw),
                reasoning=raw.strip(),
                judge_model=model,
                prompt_tokens=usage.prompt_tokens if usage else None,
                completion_tokens=usage.completion_tokens if usage else None,
            )
        except Exception:
            if attempt == attempts:
                raise
            delay = min(30.0, 2.0 ** (attempt - 1))
            logger.warning(
                "Judge call failed for %s (%d/%d); retrying in %.0fs",
                _key(record),
                attempt,
                attempts,
                delay,
            )
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")


def compute_metrics(
    judgments: list[JudgmentRecord], answers: list[AnswerRecord]
) -> dict[str, Any]:
    answer_types = {_key(record): record.question_type for record in answers}
    valid = [row for row in judgments if row.score in {0, 1}]
    by_type: dict[str, list[int]] = defaultdict(list)
    abstention: list[int] = []
    for row in valid:
        by_type[answer_types.get(_key(row)) or "unknown"].append(row.score)
        if row.question_id and row.question_id.endswith("_abs"):
            abstention.append(row.score)

    def summary(scores: list[int]) -> dict[str, int | float | None]:
        return {
            "count": len(scores),
            "accuracy": round(sum(scores) / len(scores), 4) if scores else None,
        }

    task_accuracies = [
        sum(scores) / len(scores) for scores in by_type.values() if scores
    ]
    return {
        "overall": summary([row.score for row in valid]),
        "task_averaged_accuracy": (
            round(sum(task_accuracies) / len(task_accuracies), 4)
            if task_accuracies
            else None
        ),
        "abstention": summary(abstention),
        "unparsable": sum(row.score == -1 for row in judgments),
        "per_question_type": {
            name: summary(scores) for name, scores in sorted(by_type.items())
        },
    }


async def judge_experiment(
    *,
    experiment: str,
    results_root: Path,
    model: str = DEFAULT_JUDGE_MODEL,
    concurrency: int = 5,
    limit: int | None = None,
    retries: int = 3,
    base_url: str | None = None,
) -> dict[str, Any]:
    """Judge or resume an experiment, durably writing each judgment."""
    out_dir = resolve_experiment(experiment, results_root)
    answers_path = out_dir / "answers.jsonl"
    judgments_path = out_dir / "judgments.jsonl"
    if not answers_path.exists():
        raise FileNotFoundError(f"No answers.jsonl in {out_dir}")
    answers = read_jsonl(answers_path, AnswerRecord)
    metadata_path = out_dir / "metadata.json"
    metadata = (
        ExperimentMetadata.load(metadata_path) if metadata_path.exists() else None
    )
    if metadata and metadata.benchmark != "longmemeval-v1":
        raise ValueError(
            f"The built-in judge supports LongMemEval only, not {metadata.benchmark!r}"
        )
    if not metadata and any(record.dataset != "LongMemEval" for record in answers):
        raise ValueError("The built-in judge supports LongMemEval answers only")
    if limit is not None:
        answers = answers[:limit]
    judgments = (
        read_jsonl(judgments_path, JudgmentRecord) if judgments_path.exists() else []
    )
    existing_models = {row.judge_model for row in judgments}
    if existing_models and existing_models != {model}:
        raise ValueError(
            f"Existing judgments use {sorted(existing_models)}; requested {model!r}. "
            "Use the same model or a fresh experiment copy."
        )
    done = {_key(row) for row in judgments}
    pending = [record for record in answers if _key(record) not in done]
    client = AsyncOpenAI(base_url=base_url) if base_url else AsyncOpenAI()
    semaphore = asyncio.Semaphore(concurrency)
    write_lock = asyncio.Lock()

    async def process(record: AnswerRecord) -> None:
        async with semaphore:
            judgment = await _judge_one(
                record, client=client, model=model, attempts=retries
            )
        async with write_lock:
            append_jsonl(judgments_path, judgment)
            judgments.append(judgment)

    results = await asyncio.gather(
        *(process(record) for record in pending), return_exceptions=True
    )
    failures = [result for result in results if isinstance(result, BaseException)]
    for failure in failures:
        logger.error("Judgment failed: %s", failure)

    selected = {_key(record) for record in answers}
    relevant = [row for row in judgments if _key(row) in selected]
    metrics = compute_metrics(relevant, answers)
    metrics.update(
        {
            "judge_model": model,
            "requested": len(answers),
            "judged": len(relevant),
            "failures": len(failures),
        }
    )
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(
        json.dumps(metrics, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    if metadata is not None:
        metadata.judge = {
            "judge_model": model,
            "judged": len(relevant),
            "failures": len(failures),
            "metrics": metrics,
        }
        metadata.save(metadata_path)
    return metrics
