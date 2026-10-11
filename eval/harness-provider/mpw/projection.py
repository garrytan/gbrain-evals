"""Model-input projection: what a memory system and the answer model may see.

Model inputs are built from an allowlist, not by deleting known-bad fields:

  documents   opaque id, opaque unit, content, messages, the timestamp the
              provenance rules allow, the dataset's provenance hint with
              every raw id replaced by its opaque id, and PrecisionMemBench's
              scope tags (caller data in that benchmark);
  questions   the question text (MCQ options are part of it) and the
              task-required public fields each prompt builder reads.

Gold answers, gold ids, rubrics, evidence labels and the reverse maps from
opaque ids to dataset ids stay in `Projection` on the scorer side. Opaque ids
are HMAC-SHA256 over the dataset id with a salt derived from the dataset and
split, so the gbrain and comparator cells of one comparison see the same ids.
"""
from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass, field

from memory_bench.models import Document, Query

from . import timestamps

POLICY = "mpw-opaque-hmac-sha256-12-v1"

# Query meta keys each harness prompt builder (or the retrieval mode) reads at the pin.
PROMPT_META: dict[str, tuple[str, ...]] = {
    "longmemeval": ("query_timestamp",),
    "locomo": ("query_timestamp",),
    "lifebench": ("query_timestamp",),
    "beam": ("question_category",),
    "personamem": (),
    "precisionmembench": ("query_timestamp", "retrieval_limit"),
    "fixture": ("query_timestamp",),
}

DOC_TAGS_ALLOWED = {"precisionmembench"}


def opaque(salt: bytes, prefix: str, original: str) -> str:
    return f"{prefix}-" + hmac.new(salt, original.encode(), hashlib.sha256).hexdigest()[:12]


@dataclass
class Projection:
    dataset: str
    split: str
    salt: bytes
    doc_ids: dict[str, str] = field(default_factory=dict)  # opaque -> original
    unit_ids: dict[str, str] = field(default_factory=dict)
    query_ids: dict[str, str] = field(default_factory=dict)
    provenance: dict[str, str] = field(default_factory=dict)  # opaque doc id -> provenance

    @classmethod
    def for_split(cls, dataset: str, split: str) -> "Projection":
        salt = hashlib.sha256(f"{POLICY}:{dataset}:{split}".encode()).digest()
        return cls(dataset=dataset, split=split, salt=salt)

    def _map(self, table: dict[str, str], prefix: str, original: str) -> str:
        oid = opaque(self.salt, prefix, original)
        prior = table.get(oid)
        if prior is not None and prior != original:
            raise RuntimeError(f"opaque id collision {oid} for {prior!r} and {original!r}")
        table[oid] = original
        return oid

    def doc_id(self, original: str) -> str:
        return self._map(self.doc_ids, "d", original)

    def unit_id(self, original: str | None) -> str | None:
        return None if original is None else self._map(self.unit_ids, "u", str(original))

    def query_id(self, original: str) -> str:
        return self._map(self.query_ids, "q", original)

    def original_doc(self, opaque_id: str) -> str | None:
        return self.doc_ids.get(opaque_id)

    def document(self, doc: Document, extra_ids: tuple[str, ...] = ()) -> Document:
        """Project one document. `extra_ids` are other raw ids that must not survive (e.g. the question id)."""
        oid = self.doc_id(doc.id)
        unit = self.unit_id(doc.user_id)
        ts, provenance = timestamps.provider_timestamp(self.dataset, doc.timestamp)
        self.provenance[oid] = provenance
        hint = doc.context
        if hint:
            replacements = [(doc.id, oid)]
            if doc.user_id is not None:
                replacements.append((str(doc.user_id), unit))
            replacements += [(x, self.unit_id(x) or "") for x in extra_ids if x]
            for raw, new in sorted(replacements, key=lambda r: -len(r[0])):
                hint = hint.replace(raw, new)
        return Document(
            id=oid,
            content=doc.content,
            user_id=unit,
            messages=[{"role": m.get("role"), "content": m.get("content")} for m in doc.messages] if doc.messages else None,
            timestamp=ts,
            context=hint,
            tags=list(doc.tags) if doc.tags and self.dataset in DOC_TAGS_ALLOWED else None,
        )

    def query(self, q: Query) -> Query:
        allowed = PROMPT_META.get(self.dataset)
        if allowed is None:
            raise KeyError(f"no prompt-meta allowlist for dataset {self.dataset!r}")
        return Query(
            id=self.query_id(q.id),
            query=q.query,
            gold_ids=[],
            gold_answers=[],
            user_id=self.unit_id(q.user_id),
            meta={k: q.meta[k] for k in allowed if k in q.meta},
        )

    def reverse_maps(self) -> dict[str, dict[str, str]]:
        return {"doc_ids": dict(self.doc_ids), "unit_ids": dict(self.unit_ids), "query_ids": dict(self.query_ids)}
