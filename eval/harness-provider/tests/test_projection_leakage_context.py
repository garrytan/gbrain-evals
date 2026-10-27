import json

import pytest

from mpw import context, leakage, timestamps
from mpw.fixture import FixtureDataset
from mpw.projection import Projection


def test_projection_hides_raw_ids_and_gold():
    ds = FixtureDataset()
    proj = Projection.for_split("fixture", "tiny")
    docs = ds.load_documents("tiny")
    queries = ds.load_queries("tiny")
    pdocs = [proj.document(d, extra_ids=(d.user_id,)) for d in docs]
    pqs = [proj.query(q) for q in queries]
    blob = json.dumps([d.__dict__ for d in pdocs] + [q.__dict__ for q in pqs])
    forbidden = {d.id for d in docs} | {d.user_id for d in docs} | {q.id for q in queries}
    assert leakage.check(blob, forbidden).ok
    assert "answer_" not in blob
    assert all(q.gold_answers == [] and q.gold_ids == [] for q in pqs)
    assert all(set(q.meta) <= {"query_timestamp"} for q in pqs)
    # reverse map round-trips
    for d, pd in zip(docs, pdocs):
        assert proj.original_doc(pd.id) == d.id


def test_projection_is_deterministic_across_providers():
    a = Projection.for_split("fixture", "tiny").doc_id("x_answer_123456")
    b = Projection.for_split("fixture", "tiny").doc_id("x_answer_123456")
    assert a == b and a.startswith("d-")


def test_leak_check_catches_answer_ids_raw_ids_and_labels_but_not_gold_text():
    assert not leakage.check("context answer_d61669c7 here", set()).ok
    assert not leakage.check("chunk longmemeval-s-q1_answer_d61669c7_7_", set()).ok
    assert not leakage.check('{"has_answer": true}', set()).ok
    assert not leakage.check("see session fx-user-ada_sharegpt", {"fx-user-ada_sharegpt"}).ok
    assert leakage.check("The cat is named Pixel.", {"fx-user-ada_answer_a11ce001"}).ok


def test_personamem_event_dates_are_never_promoted():
    ts, prov = timestamps.provider_timestamp("personamem", "2023-05-01T00:00:00+00:00")
    assert ts is None and prov == timestamps.STATED
    ts, prov = timestamps.provider_timestamp("longmemeval", "2023-05-20T02:21:00+00:00")
    assert ts == "2023-05-20T02:21:00+00:00" and prov == timestamps.OBSERVED
    assert timestamps.provider_timestamp("beam", None) == (None, timestamps.UNKNOWN)
    with pytest.raises(KeyError):
        timestamps.classify("unknown-dataset", "2023-01-01")


def test_cl100k_count_matches_harness_tokenizer():
    from memory_bench.utils import count_tokens as harness_count

    text = "## Memory 1\nPixel is a grey cat. answer_ ids are hidden. 東京"
    assert context.count_tokens(text) == harness_count(text)


@pytest.mark.parametrize("dataset_name", ["longmemeval", "locomo", "lifebench", "beam", "personamem"])
@pytest.mark.parametrize("raw", [None, {"results": [{"id": "c-1", "text": "fact"}]}])
def test_inserted_context_recovered_from_each_builder(dataset_name, raw):
    from memory_bench.dataset import get_dataset

    ds = get_dataset(dataset_name)
    task = ds.task_type
    meta = {"query_timestamp": "2024-01-01T00:00:00+00:00", "question_category": "temporal_reasoning"}
    rendered = "## Memory 1\nfirst\n\n## Memory 2\nsecond"

    def build(q, c, meta):
        return ds.build_rag_prompt(q, c, task, "s", None, meta)

    prompt = build("When?", rendered, {**meta, "_raw_response": raw})
    ins = context.inserted_context(build, "When?", rendered, meta, raw, prompt)
    substitutes = dataset_name in ("longmemeval", "locomo", "lifebench")
    if raw is not None and substitutes:
        assert ins.kind == "raw_json" and ins.text == json.dumps(raw)
    else:
        assert ins.kind == "rendered" and ins.text == rendered
    assert ins.tokens == context.count_tokens(ins.text)


def test_inserted_context_detects_shape_change():
    def build(q, c, meta):
        return f"A {c} B"

    with pytest.raises(context.PromptShapeError):
        context.inserted_context(build, "q", "ctx", {}, None, "A ctx C")


def test_gate_requires_mean_and_p95_within_ten_percent():
    assert context.gate(1000, [950, 1000, 1050, 1080]).ok
    assert not context.gate(1000, [500, 1000, 1000, 1000]).ok  # mean low
    g = context.gate(1000, [1000] * 19 + [5000])
    assert not g.ok and "mean" in g.reason
    assert not context.gate(1000, [1000] * 18 + [1200, 1200]).ok  # p95 high
    assert context.gate(None, [5, 7]).ok
    assert not context.gate(1000, []).ok
