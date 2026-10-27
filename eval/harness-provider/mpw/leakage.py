"""Identifier leak check on every final prompt.

The check looks for identifier-class strings only: the dataset's own
document, unit and question ids, gold ids, and LongMemEval's `answer_`
session-id form. Gold answer text is not an identifier and legitimately
appears in correct evidence, so it is never checked here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

ANSWER_ID = re.compile(r"answer_[0-9a-f]{6,}", re.IGNORECASE)
EVIDENCE_LABELS = ("has_answer",)
# Ids shorter than this are too generic to search for as substrings (e.g. LoCoMo "conv-26" is fine, "1" is not).
MIN_ID_LENGTH = 6


@dataclass
class LeakReport:
    ok: bool
    hits: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "hits": self.hits}


class LeakError(RuntimeError):
    pass


def check(text: str, forbidden_ids: set[str]) -> LeakReport:
    hits: list[str] = []
    for m in ANSWER_ID.finditer(text):
        hits.append(f"answer-id:{m.group(0)}")
    for label in EVIDENCE_LABELS:
        if label in text:
            hits.append(f"evidence-label:{label}")
    for raw in forbidden_ids:
        if raw and len(raw) >= MIN_ID_LENGTH and raw in text:
            hits.append(f"raw-id:{raw}")
    return LeakReport(ok=not hits, hits=sorted(set(hits)))


def require_clean(text: str, forbidden_ids: set[str], where: str) -> LeakReport:
    report = check(text, forbidden_ids)
    if not report.ok:
        raise LeakError(f"identifier leak in {where}: {', '.join(report.hits[:5])}")
    return report
