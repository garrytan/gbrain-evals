# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/benchmark/models.py (Apache-2.0). Changes: none.
"""Benchmark result and provenance models."""

from __future__ import annotations

import json
import os
import platform
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TypeVar


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class AnswerRecord:
    example_idx: int
    question_id: str | None
    dataset: str
    split: str
    provider: str
    question: str
    ground_truth: str
    predicted_answer: str
    prompt: list[dict[str, str]] = field(default_factory=list)
    question_type: str | None = None
    num_sessions: int = 0
    memories: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    ingest_latency_ms: float | None = None
    query_latency_ms: float | None = None
    retrieval_latency_ms: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    token_usage: dict[str, int] | None = None
    timestamp: str = field(default_factory=utc_now)


@dataclass(slots=True)
class JudgmentRecord:
    example_idx: int
    question_id: str | None
    dataset: str
    split: str
    provider: str
    question: str
    ground_truth: str
    predicted_answer: str
    score: int
    reasoning: str
    judge_model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    timestamp: str = field(default_factory=utc_now)


@dataclass(slots=True)
class ExperimentMetadata:
    run_name: str
    benchmark: str
    provider: str
    benchmark_config: dict[str, Any]
    provider_params: dict[str, Any]
    created_at: str = field(default_factory=utc_now)
    completed_at: str | None = None
    num_answers: int = 0
    duration_seconds: float | None = None
    git_hash: str = "unknown"
    git_branch: str = "unknown"
    git_dirty: bool | None = None
    environment: dict[str, Any] = field(default_factory=dict)
    provider_metadata: dict[str, Any] = field(default_factory=dict)
    judge: dict[str, Any] | None = None

    def save(self, path: Path) -> None:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(asdict(self), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)

    @classmethod
    def load(cls, path: Path) -> ExperimentMetadata:
        return cls(**json.loads(path.read_text(encoding="utf-8")))


RecordT = TypeVar("RecordT", AnswerRecord, JudgmentRecord)


def append_jsonl(
    path: Path, record: AnswerRecord | JudgmentRecord | dict[str, Any]
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = record if isinstance(record, dict) else asdict(record)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def read_jsonl(path: Path, record_type: type[RecordT]) -> list[RecordT]:
    records: list[RecordT] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                records.append(record_type(**json.loads(line)))
            except (json.JSONDecodeError, TypeError) as exc:
                raise ValueError(f"Invalid record at {path}:{line_number}") from exc
    return records


def hypothesis_record(record: AnswerRecord) -> dict[str, str | None]:
    return {"question_id": record.question_id, "hypothesis": record.predicted_answer}


def create_metadata(
    *,
    run_name: str,
    benchmark: str,
    provider: str,
    benchmark_config: dict[str, Any],
    provider_params: dict[str, Any],
) -> ExperimentMetadata:
    def git(*args: str) -> str:
        return subprocess.check_output(
            ["git", *args], stderr=subprocess.DEVNULL, text=True
        ).strip()

    try:
        git_hash = git("rev-parse", "HEAD")
        git_branch = git("rev-parse", "--abbrev-ref", "HEAD")
        git_dirty = bool(git("status", "--porcelain"))
    except (OSError, subprocess.SubprocessError):
        git_hash, git_branch, git_dirty = "unknown", "unknown", None
    return ExperimentMetadata(
        run_name=run_name,
        benchmark=benchmark,
        provider=provider,
        benchmark_config=benchmark_config,
        provider_params=provider_params,
        git_hash=git_hash,
        git_branch=git_branch,
        git_dirty=git_dirty,
        environment={
            "python_version": platform.python_version(),
            "platform": f"{platform.system()} {platform.machine()}",
        },
    )


def experiment_dir(run_name: str, root: Path | str, *, create: bool = True) -> Path:
    path = Path(root).expanduser() / run_name
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path
