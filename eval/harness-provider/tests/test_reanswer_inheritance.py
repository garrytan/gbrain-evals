"""mpw.reanswer keeps a source answer only for questions whose replayed context was `same`."""
from __future__ import annotations

import asyncio
import json

import pytest

from mpw.reanswer import reanswer


def _cell(tmp_path, classes: dict | None):
    src = tmp_path / "cell"
    src.mkdir()
    (src / "cell.json").write_text(json.dumps({"cell_id": "c", "spec": {"mode": "rag"}, "resolved": {"schedule": ["q1", "q2", "q3"]}}))
    replay = tmp_path / "replay"
    (replay / "c").mkdir(parents=True)
    if classes is not None:
        (replay / "replay-diff.json").write_text(json.dumps({"source_cell": "c", "questions": classes}))
    return src, replay / "c"


@pytest.mark.parametrize("cls", ["changed", "failed", "no_baseline", None])
def test_an_unselected_question_that_is_not_same_stops_the_run(tmp_path, cls):
    classes = {"q1": "changed", "q2": "same", **({"q3": cls} if cls else {})}
    src, retrievals = _cell(tmp_path, classes)
    with pytest.raises(SystemExit, match="only `same` rows keep the source answer") as e:
        asyncio.run(reanswer(src, tmp_path / "out", 2, retrievals, {"q1"}))
    assert f"q3={cls}" in str(e.value)


def test_a_replay_without_its_classes_stops_the_run(tmp_path):
    src, retrievals = _cell(tmp_path, None)
    with pytest.raises(SystemExit, match="replay-diff.json is missing"):
        asyncio.run(reanswer(src, tmp_path / "out", 2, retrievals, {"q1"}))
