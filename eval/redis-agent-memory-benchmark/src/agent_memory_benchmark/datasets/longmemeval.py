# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/datasets/longmemeval.py (Apache-2.0). Changes: BASE_URL reads the dataset at Hugging Face revision 98d7416c24c778c2fee6e6f3006e7a073259d48f instead of main.
"""Public adapter for LongMemEval."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx

from agent_memory_benchmark.datasets.base import DatasetAdapter
from agent_memory_benchmark.datasets.models import (
    ContextMessage,
    DatasetExample,
    QAPair,
    Session,
)

BASE_URL = (
    "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/"
    "98d7416c24c778c2fee6e6f3006e7a073259d48f"
)
SPLITS = {
    "oracle": "longmemeval_oracle",
    "small": "longmemeval_s_cleaned",
    "medium": "longmemeval_m_cleaned",
}
_SUPPLEMENTARY_UTF8_RE = re.compile(r"[\U00010000-\U0010ffff]+")


class LongMemEvalAdapter(DatasetAdapter):
    """Load a public LongMemEval split from Hugging Face or a local cache."""

    def __init__(
        self,
        split: str = "oracle",
        *,
        cache_dir: Path | str | None = None,
        timeout: float = 300,
    ) -> None:
        if split not in SPLITS:
            raise ValueError(f"Unknown split {split!r}; choose from {tuple(SPLITS)}")
        self.split = split
        self.cache_dir = Path(cache_dir or Path.home() / ".cache" / "memory-bench")
        self.timeout = timeout
        self._rows: list[dict] | None = None
        self._examples: list[DatasetExample] | None = None

    @property
    def name(self) -> str:
        return f"LongMemEval ({self.split})"

    def load_raw(self) -> list[dict]:
        if self._rows is not None:
            return self._rows
        filename = f"{SPLITS[self.split]}.json"
        path = self.cache_dir / "longmemeval-v1" / filename
        payload = _read_rows(path) if path.exists() else None
        if payload is None:
            path.parent.mkdir(parents=True, exist_ok=True)
            _download(
                f"{BASE_URL}/{filename}",
                path,
                timeout=self.timeout,
            )
            payload = _read_rows(path)
            if payload is None:
                raise ValueError(f"Expected a JSON list from {filename}")
        self._rows = payload
        return payload

    def load(self) -> list[DatasetExample]:
        if self._examples is not None:
            return self._examples
        examples: list[DatasetExample] = []
        for row in self.load_raw():
            sessions = self._sessions(
                row.get("haystack_sessions", []), row.get("haystack_dates", [])
            )
            qid = row.get("question_id")
            qtype = row.get("question_type")
            examples.append(
                DatasetExample(
                    sessions=sessions,
                    qa_pairs=[
                        QAPair(
                            question=str(row["question"]),
                            answer=str(row["answer"]),
                            question_id=str(qid) if qid is not None else None,
                            question_type=qtype,
                        )
                    ],
                    metadata={
                        "question_id": qid,
                        "question_type": qtype,
                        "question_date": row.get("question_date"),
                        "answer_session_ids": row.get("answer_session_ids"),
                    },
                )
            )
        self._examples = examples
        return examples

    @classmethod
    def _sessions(
        cls, raw_sessions: list[list[dict]], dates: list[str]
    ) -> list[Session]:
        sessions: list[Session] = []
        for index, raw_session in enumerate(raw_sessions):
            label = dates[index] if index < len(dates) else f"Session {index + 1}"
            messages = [
                ContextMessage(
                    speaker=str(turn["role"]),
                    text=_SUPPLEMENTARY_UTF8_RE.sub("", str(turn["content"])),
                )
                for turn in raw_session
                if isinstance(turn, dict) and "role" in turn and "content" in turn
            ]
            if messages:
                sessions.append(
                    Session(label=label, messages=messages, date=cls._date(label))
                )
        return sessions

    @staticmethod
    def _date(label: str) -> datetime | None:
        match = re.match(r"(\d{4}/\d{2}/\d{2})\s*(?:\(\w+\))?\s*(\d{2}:\d{2})?", label)
        if not match:
            return None
        try:
            return datetime.strptime(
                f"{match.group(1)} {match.group(2) or '00:00'}",
                "%Y/%m/%d %H:%M",
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _download(url: str, path: Path, timeout: float) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as response:
        response.raise_for_status()
        with temporary.open("wb") as handle:
            for chunk in response.iter_bytes(1024 * 1024):
                handle.write(chunk)
    temporary.replace(path)


def _read_rows(path: Path) -> list[dict] | None:
    try:
        with path.open("rb") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, list) else None
