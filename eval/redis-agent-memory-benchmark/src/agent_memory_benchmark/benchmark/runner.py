# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/benchmark/runner.py (Apache-2.0). Changes: renamed the local variable key to qid in process(), so the secret scanner stops reading it as a credential; behaviour unchanged.
"""Provider-neutral LongMemEval runners."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar

from agent_memory_benchmark.benchmark.models import (
    AnswerRecord,
    ExperimentMetadata,
    append_jsonl,
    create_metadata,
    experiment_dir,
    hypothesis_record,
    read_jsonl,
)
from agent_memory_benchmark.datasets import LongMemEvalAdapter
from agent_memory_benchmark.memory import STORES

logger = logging.getLogger(__name__)
T = TypeVar("T")
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_SENSITIVE_PARAM = re.compile(
    r"(?:api[_-]?key|token|secret|password|credential)", re.IGNORECASE
)
_STRING_PARAM = re.compile(
    r"(?:^|_)(?:id|ids|project|url|path|name|key|region|model|dsn|uri|user|host)$",
    re.IGNORECASE,
)


def parse_provider_params(items: list[str]) -> dict[str, Any]:
    params: dict[str, Any] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"Expected KEY=VALUE, got {item!r}")
        key, value = item.split("=", 1)
        if not key:
            raise ValueError(f"Empty parameter name in {item!r}")
        lowered = value.lower()
        if lowered in {"true", "false"}:
            params[key] = lowered == "true"
        elif lowered in {"none", "null"}:
            params[key] = None
        elif _STRING_PARAM.search(key):
            params[key] = value
        else:
            for cast in (int, float):
                try:
                    params[key] = cast(value)
                    break
                except ValueError:
                    continue
            else:
                params[key] = value
    return params


def redact_provider_params(params: dict[str, Any]) -> dict[str, Any]:
    """Return provider settings safe to persist in public experiment metadata."""
    return {
        key: "<redacted>" if _SENSITIVE_PARAM.search(key) else value
        for key, value in params.items()
    }


def store_kwargs(provider_params: dict[str, Any], user_id: str) -> dict[str, Any]:
    """Build adapter kwargs with a per-example user id that cannot be overridden."""
    params = dict(provider_params)
    if "user_id" in params:
        logger.warning(
            "Ignoring --provider-param user_id; each example uses an isolated id"
        )
        params.pop("user_id")
    return {**params, "user_id": user_id}


def default_run_name(benchmark: str, provider: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_provider = _SAFE_NAME.sub("-", provider).strip("-") or "provider"
    return f"{timestamp}-{benchmark}-{safe_provider}"


async def _retry(
    operation: Callable[[], Awaitable[T]], *, attempts: int, label: str
) -> T:
    for attempt in range(1, attempts + 1):
        try:
            return await operation()
        except Exception:
            if attempt == attempts:
                raise
            delay = min(30.0, 2.0 ** (attempt - 1))
            logger.warning(
                "%s failed (%d/%d); retrying in %.0fs",
                label,
                attempt,
                attempts,
                delay,
            )
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")


def _answer_key(record: AnswerRecord) -> str:
    return record.question_id or f"{record.example_idx}:{record.question}"


def _prepare_run(
    *,
    run_name: str,
    results_root: Path,
    benchmark: str,
    provider: str,
    benchmark_config: dict[str, Any],
    provider_params: dict[str, Any],
) -> tuple[Path, ExperimentMetadata, set[str]]:
    out_dir = experiment_dir(run_name, results_root)
    metadata_path = out_dir / "metadata.json"
    if metadata_path.exists():
        metadata = ExperimentMetadata.load(metadata_path)
        expected = (benchmark, provider, benchmark_config, provider_params)
        actual = (
            metadata.benchmark,
            metadata.provider,
            metadata.benchmark_config,
            metadata.provider_params,
        )
        if actual != expected:
            raise ValueError(
                f"Run {run_name!r} exists with different configuration; "
                "choose another --run-name"
            )
    else:
        metadata = create_metadata(
            run_name=run_name,
            benchmark=benchmark,
            provider=provider,
            benchmark_config=benchmark_config,
            provider_params=provider_params,
        )
        metadata.save(metadata_path)
    answers_path = out_dir / "answers.jsonl"
    completed = (
        {_answer_key(row) for row in read_jsonl(answers_path, AnswerRecord)}
        if answers_path.exists()
        else set()
    )
    hypotheses_path = out_dir / "hypotheses.jsonl"
    if answers_path.exists() and not hypotheses_path.exists():
        for row in read_jsonl(answers_path, AnswerRecord):
            append_jsonl(hypotheses_path, hypothesis_record(row))
    return out_dir, metadata, completed


def _usage(store: Any) -> dict[str, int] | None:
    value = store.get_token_usage()
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, dict):
        return value
    return None


async def _memories(store: Any) -> list[str]:
    wait = getattr(store, "wait_for_extraction", None)
    values = await wait() if callable(wait) else await store.list_memories()
    return [str(value) for value in values]


async def _ingest(store: Any, sessions: list[Any]) -> None:
    await store.ingest(sessions)


async def _query_record(
    *,
    store: Any,
    example_idx: int,
    qa: Any,
    dataset: str,
    split: str,
    provider: str,
    num_sessions: int,
    question_date: str | None,
    memories: list[str],
    ingest_ms: float,
    metadata: dict[str, Any],
    retries: int,
) -> AnswerRecord:
    started = time.perf_counter()
    result = await _retry(
        lambda: store.query(qa.question, question_date=question_date),
        attempts=retries,
        label=f"query {qa.question_id or example_idx}",
    )
    query_ms = round((time.perf_counter() - started) * 1000, 1)
    return AnswerRecord(
        example_idx=example_idx,
        question_id=qa.question_id,
        dataset=dataset,
        split=split,
        provider=provider,
        question=qa.question,
        ground_truth=qa.answer,
        predicted_answer=str(result.answer),
        prompt=list(getattr(result, "prompt", []) or []),
        question_type=qa.question_type,
        num_sessions=num_sessions,
        memories=memories if len(memories) <= 1000 else [],
        metadata={**metadata, **qa.metadata, "num_memories": len(memories)},
        ingest_latency_ms=ingest_ms,
        query_latency_ms=query_ms,
        retrieval_latency_ms=getattr(result, "retrieval_latency_ms", None),
        prompt_tokens=getattr(result, "llm_prompt_tokens", None),
        completion_tokens=getattr(result, "llm_completion_tokens", None),
        token_usage=_usage(store),
    )


async def run_longmemeval_v1(
    *,
    provider: str,
    split: str,
    results_root: Path,
    run_name: str | None = None,
    provider_params: dict[str, Any] | None = None,
    limit: int | None = None,
    concurrency: int = 1,
    retries: int = 3,
    cache_dir: Path | None = None,
) -> Path:
    """Run or resume LongMemEval, persisting each completed answer."""
    if provider not in STORES:
        raise ValueError(f"Unknown provider {provider!r}; available: {sorted(STORES)}")
    provider_params = provider_params or {}
    run_name = run_name or default_run_name(f"longmemeval-v1-{split}", provider)
    config = {"split": split, "limit": limit, "shuffle_seed": 42}
    out_dir, metadata, completed = _prepare_run(
        run_name=run_name,
        results_root=results_root,
        benchmark="longmemeval-v1",
        provider=provider,
        benchmark_config=config,
        provider_params=redact_provider_params(provider_params),
    )
    examples = LongMemEvalAdapter(split, cache_dir=cache_dir).load()
    random.Random(42).shuffle(examples)
    if limit is not None:
        examples = examples[:limit]
    answers_path = out_dir / "answers.jsonl"
    errors_path = out_dir / "errors.jsonl"
    hypotheses_path = out_dir / "hypotheses.jsonl"
    write_lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(concurrency)
    started = datetime.now(timezone.utc)
    prior_duration = metadata.duration_seconds or 0

    async def process(index: int, example: Any) -> None:
        qa = example.qa_pairs[0]
        qid = qa.question_id or f"{index}:{qa.question}"
        if qid in completed:
            return
        async with semaphore:
            store_cls = STORES[provider]
            kwargs = store_kwargs(provider_params, f"benchmark-{run_name}-{index}")
            try:
                async with store_cls(**kwargs) as store:

                    async def ingest_clean() -> None:
                        await store.reset()
                        await _ingest(store, example.sessions)

                    ingest_started = time.perf_counter()
                    await _retry(
                        ingest_clean,
                        attempts=retries,
                        label=f"ingest {qid}",
                    )
                    ingest_ms = round((time.perf_counter() - ingest_started) * 1000, 1)
                    memories = await _memories(store)
                    record = await _query_record(
                        store=store,
                        example_idx=index,
                        qa=qa,
                        dataset="LongMemEval",
                        split=split,
                        provider=provider,
                        num_sessions=len(example.sessions),
                        question_date=example.metadata.get("question_date"),
                        memories=memories,
                        ingest_ms=ingest_ms,
                        metadata={
                            "answer_session_ids": example.metadata.get(
                                "answer_session_ids"
                            )
                        },
                        retries=retries,
                    )
                    await store.reset()
                    async with write_lock:
                        if not metadata.provider_metadata:
                            metadata.provider_metadata = store.get_store_metadata()
                            metadata.save(out_dir / "metadata.json")
                        append_jsonl(answers_path, record)
                        append_jsonl(hypotheses_path, hypothesis_record(record))
                        completed.add(qid)
            except Exception as exc:
                logger.exception("Failed LongMemEval question %s", qid)
                async with write_lock:
                    append_jsonl(
                        errors_path,
                        {
                            "example_idx": index,
                            "question_id": qa.question_id,
                            "error_type": type(exc).__name__,
                            "error": str(exc),
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        },
                    )

    await asyncio.gather(
        *(process(index, example) for index, example in enumerate(examples))
    )
    metadata.num_answers = len(completed)
    metadata.completed_at = (
        datetime.now(timezone.utc).isoformat()
        if len(completed) >= len(examples)
        else None
    )
    metadata.duration_seconds = round(
        prior_duration + (datetime.now(timezone.utc) - started).total_seconds(),
        1,
    )
    metadata.save(out_dir / "metadata.json")
    return out_dir
