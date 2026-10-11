import json

from mpw import register
from mpw.projection import Projection


def _conversation(sessions: int) -> list[dict]:
    conv = {"speaker_a": "Ana", "speaker_b": "Ben"}
    for n in range(1, sessions + 1):
        conv[f"session_{n}"] = [{"speaker": "Ana", "dia_id": f"D{n}:1", "text": f"Note {n}."}]
        conv[f"session_{n}_date_time"] = f"1:00 pm on {n} May, 2023"
    return [{
        "sample_id": "conv-x",
        "conversation": conv,
        "qa": [{"question": "When was the last note?", "answer": "12 May 2023", "evidence": ["D12:1"], "category": 2}],
    }]


def test_twelve_session_conversation_is_asked_on_session_12_date(tmp_path, monkeypatch):
    register.install()
    from memory_bench.dataset.locomo import LoComoDataset

    path = tmp_path / "locomo10.json"
    path.write_text(json.dumps(_conversation(12)))
    monkeypatch.setenv("LOCOMO_DATA_PATH", str(path))
    ds = LoComoDataset()

    session_12 = ds._parse_date("1:00 pm on 12 May, 2023")
    [query] = ds.load_queries("locomo10")
    assert query.meta["query_timestamp"] == session_12
    assert query.gold_ids == ["conv-x_session_12"]
    assert [d.id for d in ds.load_documents("locomo10")][-3:] == ["conv-x_session_10", "conv-x_session_11", "conv-x_session_12"]

    projected = Projection(dataset="locomo", split="locomo10", salt=b"t").query(query)
    assert projected.meta == {"query_timestamp": session_12}
