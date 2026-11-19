"""Keyless tests for lme_redis.py on a bare python3: python3 eval/runner/lme-redis/test_lme_redis.py"""

from __future__ import annotations

import hashlib
import json
import random
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "redis-agent-memory-benchmark" / "src")]
for name in ("httpx", "openai"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["openai"].AsyncOpenAI = getattr(sys.modules["openai"], "AsyncOpenAI", None)

import lme_redis as L  # noqa: E402
from agent_memory_benchmark.datasets.longmemeval import LongMemEvalAdapter  # noqa: E402
from agent_memory_benchmark.memory.common import session_text  # noqa: E402
from agent_memory_benchmark.memory.llm import build_prompt  # noqa: E402

ROW = {
    "question_id": "q1",
    "question_type": "single-session-user",
    "question": "What is my dog called?",
    "answer": "Biscuit",
    "question_date": "2023/05/30 (Tue) 10:00",
    "haystack_dates": ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 10:00", "2023/05/22 (Mon) 09:00", "2023/05/23 (Tue) 09:00"],
    "haystack_sessions": [
        [{"role": "user", "content": "My favourite pasta is carbonara."}, {"role": "assistant", "content": "Nice."}],
        [],
        [{"role": "user", "content": "I adopted a beagle named   Biscuit last week.", "has_answer": True},
         {"role": "assistant", "content": "Congrats!"}],
        [{"role": "user", "content": "I started learning Rust."}, {"role": "assistant", "content": "Good choice."}],
    ],
}


def example(row=ROW):
    return LongMemEvalAdapter("small")._sessions(row["haystack_sessions"], row["haystack_dates"])


class Example:
    def __init__(self, row=ROW):
        from agent_memory_benchmark.datasets.models import DatasetExample, QAPair

        self.inner = DatasetExample(
            sessions=example(row),
            qa_pairs=[QAPair(question=row["question"], answer=row["answer"], question_id=row["question_id"],
                             question_type=row["question_type"])],
            metadata={"question_date": row["question_date"]},
        )


class Tests(unittest.TestCase):
    def test_kept_sessions_align_with_the_loader(self):
        sessions = example()
        self.assertEqual(len(L.kept_raw_sessions(ROW)), len(sessions))
        self.assertEqual([s.label for s in sessions], [ROW["haystack_dates"][i] for i in (0, 2, 3)])
        self.assertEqual(L.evidence_turns(ROW), [(1, "I adopted a beagle named   Biscuit last week.")])

    def test_whole_sessions_deliver_by_conversation(self):
        self.assertEqual(L.delivery(ROW, [0, 2], None), {"evidence_turns": 1, "delivered": 0, "partial": 0})
        self.assertEqual(L.delivery(ROW, [1], None), {"evidence_turns": 1, "delivered": 1, "partial": 0})

    def test_passages_deliver_by_full_text(self):
        whole = "[excerpt]\n**user:** I adopted a beagle named Biscuit last week.\n"
        self.assertEqual(L.delivery(ROW, None, [whole])["delivered"], 1)
        self.assertEqual(L.delivery(ROW, None, ["I adopted a beagle"])["delivered"], 0)
        self.assertEqual(L.delivery(ROW, None, ["nothing here"]), {"evidence_turns": 1, "delivered": 0, "partial": 0})

    def test_ranked_sessions_keep_first_five_distinct_in_rank_order(self):
        results = [{"idx": i} for i in (4, 4, 2, 7, 2, 1, 9, 3)]
        self.assertEqual(L.ranked_sessions(results), [4, 2, 7, 1, 9])

    def test_whole_context_is_the_harness_session_text(self):
        ex = Example().inner
        self.assertEqual(L.whole_context(ex, [2, 0]), session_text(ex.sessions[2]) + "\n\n" + session_text(ex.sessions[0]))

    def test_gbrain_arms_render_whole_conversations_or_dated_passages(self):
        ex = Example().inner
        results = [{"idx": 1, "chunk_text": "beagle"}, {"idx": 1, "chunk_text": "Biscuit"}, {"idx": 0, "chunk_text": "pasta"}]
        text, sessions, passages = L.gbrain_context("off", ex, results)
        self.assertEqual((sessions, passages), ([1, 0], None))
        self.assertEqual(text, L.whole_context(ex, [1, 0]))
        text, sessions, passages = L.gbrain_context("agent-default", ex, results)
        self.assertEqual(sessions, [0, 1])
        self.assertEqual(passages, ["beagle", "Biscuit", "pasta"])
        self.assertTrue(text.startswith(f"[Conversation date: {ex.sessions[1].label}]\nbeagle\n\n"))

    def test_message_line_carries_the_vendored_prompt_bytes(self):
        ex = Example().inner
        context = L.whole_context(ex, [1])
        line = L.message_line("off", ex, context, [1], ROW, None)
        self.assertEqual(line["messages"], build_prompt(context, ROW["question"], question_date=ROW["question_date"]))
        self.assertEqual(line["context_sha256"], hashlib.sha256(context.encode()).hexdigest())
        self.assertEqual(line["delivery"]["delivered"], 1)

    def test_ingest_payload_matches_the_quick_look_roles(self):
        payload = L.ingest_payload(example())
        self.assertEqual([t["role"] for t in payload[1]["turns"]], ["user", "assistant"])
        self.assertEqual(payload[0]["date"], ROW["haystack_dates"][0])

    def test_seed42_is_the_runner_order(self):
        items = list(range(20))
        expected = list(items)
        random.Random(42).shuffle(expected)
        self.assertEqual(L.seed42(items), expected)
        self.assertEqual(items, list(range(20)))

    def test_a_dataset_file_with_another_hash_refuses_to_load(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "longmemeval-v1"
            p.mkdir()
            (p / L.FILES["small"]).write_text(json.dumps([ROW]))
            with self.assertRaises(SystemExit) as caught:
                L.load_split("small", Path(d))
            self.assertIn("refusing to load", str(caught.exception))

    def test_query_params_are_the_preregistered_three(self):
        self.assertEqual(L.QUERY_PARAMS, {"off": {"limit": 10, "autocut": False}, "on": {"limit": 10}, "agent-default": {}})


if __name__ == "__main__":
    unittest.main()
