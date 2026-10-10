"""Stage receipt records shared by the cell runner, scorer and re-judge.

A cell directory holds one JSON file per unit or question per stage:

  <cell>/cell.json                       resolved cell (id, spec, pins, schedule)
  <cell>/stages/ingest/<unit>.json       IngestRecord
  <cell>/stages/retrieve/<qid>.json      RetrieveRecord
  <cell>/stages/answer/<qid>.json        AnswerRecord
  <cell>/stages/judge/<qid>.json         JudgeRecord (written by the scorer)

Every record carries the cell id; a record whose cell id differs from the
cell's is never reused. Question and unit ids in file names are the dataset's
own ids: these files stay on the scorer side and never reach a model.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

STAGES = ("ingest", "retrieve", "answer", "judge")

# Outcome kinds. A cell's denominator is its scheduled question count; every
# scheduled question ends with exactly one of these.
ANSWERED = "answered"
ABSTENTION = "abstention"
ANSWER_FAILURE = "answer_failure"
RETRIEVAL_FAILURE = "retrieval_failure"
JUDGE_FAILURE = "judge_failure"
INCOMPLETE_INGEST = "incomplete_ingest"
OUTCOMES = (ANSWERED, ABSTENTION, ANSWER_FAILURE, RETRIEVAL_FAILURE, JUDGE_FAILURE, INCOMPLETE_INGEST)


@dataclass
class IngestRecord:
    cell_id: str
    unit: str
    ok: bool
    documents: int
    ingest_ms: float
    barrier_ms: float = 0.0
    error: str | None = None
    provider_receipt: dict = field(default_factory=dict)


@dataclass
class RetrieveRecord:
    cell_id: str
    query_id: str
    ok: bool
    retrieve_ms: float
    documents: list[dict] = field(default_factory=list)
    raw_response: Any = None
    provider_meta: dict = field(default_factory=dict)
    error: str | None = None


@dataclass
class ModelRequest:
    """One HTTP request the proxy forwarded for this question, byte-exact."""
    tag: str
    provider: str
    url_path: str
    body_sha256: str
    body: Any
    status: int | None = None
    usage: dict | None = None
    usd: float | None = None


@dataclass
class AnswerRecord:
    cell_id: str
    query_id: str
    ok: bool
    outcome: str  # ANSWERED | ANSWER_FAILURE | RETRIEVAL_FAILURE | INCOMPLETE_INGEST
    answer: str = ""
    reasoning: str = ""
    task_type: str = "open"
    answer_model: str | None = None
    rendered_context: str = ""
    inserted_context: str = ""
    inserted_kind: str = "rendered"  # rendered | raw_json | none
    inserted_tokens_cl100k: int = 0
    final_prompt: str = ""
    final_prompt_sha256: str = ""
    requests: list[dict] = field(default_factory=list)
    tool_calls: int = 0
    error: str | None = None
    leak_check: dict = field(default_factory=dict)
    agent_meta: dict = field(default_factory=dict)


@dataclass
class JudgeRecord:
    cell_id: str
    query_id: str
    outcome: str
    score: float | None
    correct: bool | None
    judge_model: str | None
    reason: str = ""
    rubric: list[dict] | None = None
    requests: list[dict] = field(default_factory=list)
    error: str | None = None
    details: dict = field(default_factory=dict)  # dataset metrics, e.g. PrecisionMemBench precision/recall


_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(identifier: str) -> str:
    """File-name form of a dataset id. An id that needs replacing (e.g. a name in Chinese characters) gets a short
    hash of the original so two such ids never share a file."""
    safe = _SAFE.sub("_", identifier)
    if safe == identifier and len(safe) <= 180:
        return safe
    return f"{safe[:160]}-{hashlib.sha256(identifier.encode()).hexdigest()[:12]}"


def stage_path(cell_dir: Path, stage: str, identifier: str) -> Path:
    if stage not in STAGES:
        raise ValueError(f"unknown stage {stage}")
    return cell_dir / "stages" / stage / f"{safe_name(identifier)}.json"


def write_record(cell_dir: Path, stage: str, identifier: str, record: Any) -> Path:
    path = stage_path(cell_dir, stage, identifier)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    data = asdict(record) if hasattr(record, "__dataclass_fields__") else record
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")
    os.replace(tmp, path)
    return path


def read_record(cell_dir: Path, stage: str, identifier: str, cell_id: str) -> dict | None:
    """The stored record, or None when absent. A record from another cell raises."""
    path = stage_path(cell_dir, stage, identifier)
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    if data.get("cell_id") != cell_id:
        raise RuntimeError(f"{path} belongs to cell {data.get('cell_id')}, not {cell_id}; refusing to mix receipts")
    owner = data.get("query_id", data.get("unit"))
    if owner is not None and owner != identifier:
        raise RuntimeError(f"{path} holds the record for {owner!r}, not {identifier!r}; refusing to mix receipts")
    return data
