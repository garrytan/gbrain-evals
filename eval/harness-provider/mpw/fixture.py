"""A tiny committed dataset for the keyless plumbing check and the tests.

Two people, three dated sessions each, four questions. Its document ids
deliberately use LongMemEval's `answer_<hex>` form, so the opaque-id
projection and the prompt leak check are exercised on every fixture run.
This is a plumbing check, not benchmark evidence.
"""
from __future__ import annotations

import json

from memory_bench.dataset.base import Dataset
from memory_bench.models import Document, Query

_SESSIONS = {
    "fx-user-ada": [
        ("answer_a11ce001", "2024-03-02T10:00:00+00:00", [
            {"role": "user", "content": "I adopted a grey cat last week and named her Pixel."},
            {"role": "assistant", "content": "Pixel is a great name for a grey cat."}]),
        ("sharegpt_ada_002", "2024-04-11T09:30:00+00:00", [
            {"role": "user", "content": "Can you suggest a sourdough schedule? I bake on Saturdays."},
            {"role": "assistant", "content": "Feed the starter Friday night and mix the dough Saturday morning."}]),
        ("answer_a11ce003", "2024-05-20T18:15:00+00:00", [
            {"role": "user", "content": "Update: I moved to Lisbon for a new job at a robotics lab."},
            {"role": "assistant", "content": "Congratulations on the move to Lisbon and the robotics job."}]),
    ],
    "fx-user-bo": [
        ("answer_b0b00001", "2023-11-05T08:00:00+00:00", [
            {"role": "user", "content": "My daughter Mila starts violin lessons on Tuesdays."},
            {"role": "assistant", "content": "Tuesday violin lessons are a good routine for Mila."}]),
        ("sharegpt_bo_002", "2023-12-01T12:00:00+00:00", [
            {"role": "user", "content": "What is a good beginner telescope?"},
            {"role": "assistant", "content": "A 130mm reflector on a simple mount is a common first telescope."}]),
        ("sharegpt_bo_003", "2024-01-15T16:45:00+00:00", [
            {"role": "user", "content": "I switched my commute from driving to cycling."},
            {"role": "assistant", "content": "Cycling to work is a healthy change."}]),
    ],
}

_QUESTIONS = [
    ("fxq-ada-1", "fx-user-ada", "What is the name of the cat I adopted?", "Pixel", ["fx-user-ada_answer_a11ce001"], "2024-06-01T00:00:00+00:00"),
    ("fxq-ada-2", "fx-user-ada", "Which city did I move to for work?", "Lisbon", ["fx-user-ada_answer_a11ce003"], "2024-06-01T00:00:00+00:00"),
    ("fxq-bo-1", "fx-user-bo", "On which weekday does my daughter have violin lessons?", "Tuesday", ["fx-user-bo_answer_b0b00001"], "2024-02-01T00:00:00+00:00"),
    ("fxq-bo-2", "fx-user-bo", "What is my favourite opera?", "The conversations do not say.", [], "2024-02-01T00:00:00+00:00"),
]


class FixtureDataset(Dataset):
    name = "fixture"
    description = "Keyless plumbing fixture (two people, six sessions, four questions)."
    splits = ["tiny"]
    task_type = "open"
    isolation_unit = "user"

    def load_queries(self, split, category=None, limit=None):
        out = [Query(id=qid, query=text, gold_ids=gold_ids, gold_answers=[gold], user_id=user,
                     meta={"query_timestamp": qts, "question_type": "abstention" if not gold_ids else "single-session"})
               for qid, user, text, gold, gold_ids, qts in _QUESTIONS]
        return out[:limit] if limit else out

    def load_documents(self, split, category=None, limit=None, ids=None, user_ids=None):
        docs = []
        for user, sessions in _SESSIONS.items():
            if user_ids is not None and user not in user_ids:
                continue
            for sid, ts, turns in sessions:
                doc_id = f"{user}_{sid}"
                if ids is not None and doc_id not in ids:
                    continue
                docs.append(Document(id=doc_id, content=json.dumps(turns), user_id=user, messages=turns, timestamp=ts,
                                     context=f"Session {doc_id} with {user}"))
        return docs[:limit] if limit and ids is None else docs

    def build_rag_prompt(self, query, context, task_type, split, category=None, meta=None):
        meta = meta or {}
        raw = meta.get("_raw_response")
        ctx = json.dumps(raw) if raw else context
        return (f"Answer the question from the remembered conversations.\nQuestion date: {meta.get('query_timestamp') or 'unknown'}\n\n"
                f"Memories:\n{ctx}\n\nQuestion: {query}\nIf the memories do not contain the answer, say so.")
