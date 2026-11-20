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

    def test_whole_conversations_deliver_by_turn_text_and_by_conversation(self):
        ex = Example().inner
        texts = [session_text(ex.sessions[i]) for i in (0, 2)]
        self.assertEqual(L.delivery(ROW, texts, [0, 2]),
                         {"evidence_turns": 1, "delivered": 0, "all_delivered": False, "partial": 0, "split_rule": None,
                          "conversation_level": 0})
        held = L.delivery(ROW, [session_text(ex.sessions[1])], [1])
        self.assertEqual((held["delivered"], held["all_delivered"], held["conversation_level"]), (1, True, 1))

    def test_a_passage_holding_the_whole_turn_delivers_it_after_normalisation(self):
        quoted = "[excerpt]\n**user:** I ADOPTED a beagle named Biscuit\n last week.\n"
        self.assertEqual(L.delivery(ROW, [quoted], None, [1])["delivered"], 1)
        self.assertEqual(L.delivery(ROW, ["nothing here"], None, [1]),
                         {"evidence_turns": 1, "delivered": 0, "all_delivered": False, "partial": 0, "split_rule": 0,
                          "conversation_level": None})

    def test_a_passage_that_keeps_the_opening_but_cuts_the_answer_is_not_delivered(self):
        got = L.delivery(ROW, ["**user:** I adopted a beagle named"], None, [1])
        self.assertEqual((got["delivered"], got["partial"], got["all_delivered"]), (0, 1, False))

    def test_a_turn_split_across_passages_of_its_conversation_counts_when_they_cover_all_of_it(self):
        long = " ".join(f"word{i}" for i in range(60))
        row = {**ROW, "haystack_sessions": [[{"role": "user", "content": long, "has_answer": True}],
                                            [{"role": "user", "content": "other"}]],
               "haystack_dates": ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 10:00"]}
        head, tail = long[: len(long) // 2 + 10], long[len(long) // 2 - 10:]
        got = L.delivery(row, ["unrelated", head, tail], None, [1, 0, 0])
        self.assertEqual((got["delivered"], got["split_rule"], got["partial"]), (1, 1, 0))
        other_conversation = L.delivery(row, [head, tail], None, [0, 1])
        self.assertEqual((other_conversation["delivered"], other_conversation["partial"]), (0, 1))
        gap = L.delivery(row, [long[:150], long[200:]], None, [0, 0])
        self.assertEqual((gap["delivered"], gap["partial"]), (0, 1))

    def test_degraded_means_no_reranker_or_any_degraded_stage(self):
        self.assertFalse(L.degraded({"op": {"degraded": [], "reranker": "voyage:rerank-3-lite"}}))
        self.assertTrue(L.degraded({"op": {"degraded": [], "reranker": None}}))
        self.assertTrue(L.degraded({"op": {"degraded": [{"stage": "rerank_failed"}], "reranker": "voyage:rerank-3-lite"}}))

    def test_on_is_checked_as_a_prefix_of_off(self):
        rows = [{"slug": s, "chunk_text": s * 2} for s in "abc"]
        self.assertTrue(L.is_prefix(rows[:2], rows))
        self.assertFalse(L.is_prefix([rows[1]], rows))

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
        self.assertEqual((line["delivery"]["delivered"], line["delivery"]["conversation_level"]), (1, 1))

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

    def test_parity_reads_the_question_date_back_from_a_prompt(self):
        system = build_prompt("ctx", "q?", question_date=ROW["question_date"])[0]["content"]
        self.assertEqual(L._question_date(system), ROW["question_date"])
        self.assertIsNone(L._question_date(build_prompt("ctx", "q?")[0]["content"]))

    def test_judge_messages_are_the_vendored_official_prompt(self):
        from agent_memory_benchmark.prompts.judge import build_judge_prompt

        qa = Example().inner.qa_pairs[0]
        line = L.judge_line("q1~x", qa, "Biscuit, I think")
        self.assertEqual(line["messages"], [{"role": "user", "content": build_judge_prompt(
            question=qa.question, answer=qa.answer, response="Biscuit, I think", question_type=qa.question_type, abstain=False)}])
        abs_qa = type(qa)(question="q", answer="none", question_id="q9_abs", question_type="multi-session")
        self.assertIn("unanswerable", L.judge_messages(abs_qa, "x")[0]["content"])

    def test_controls_are_200_items_over_50_questions_outside_the_pilot(self):
        from agent_memory_benchmark.datasets.models import DatasetExample, QAPair

        types = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session",
                 "temporal-reasoning", "knowledge-update"]
        examples = [DatasetExample(sessions=[], qa_pairs=[QAPair(question=f"q{i}", answer=f"a{i}",
                    question_id=f"id{i}" + ("_abs" if i % 10 == 0 else ""), question_type=types[i % 6])])
                    for i in range(300)]
        items = L.controls(examples)
        self.assertEqual(len(items), 200)
        qids = {i["question_id"] for i in items}
        self.assertEqual(len(qids), 50)
        pilot = {str(e.qa_pairs[0].question_id) for e in L.seed42(examples)[-L.PILOT_SIZE:]}
        self.assertFalse(qids & pilot)
        self.assertEqual(sum(q.endswith("_abs") for q in qids), 10)
        answerable_types = {i["question_type"] for i in items if not i["question_id"].endswith("_abs")}
        self.assertEqual(answerable_types, set(types))
        for i in items:
            if i["kind"] == "other-gold":
                self.assertFalse(i["expected"])
                self.assertNotIn(f"Correct Answer: a{i['question_id'][2:].removesuffix('_abs')}\n\nModel Response: a{i['question_id'][2:].removesuffix('_abs')}\n", i["messages"][0]["content"])
            if i["kind"] == "abstain":
                self.assertEqual(i["expected"], i["question_id"].endswith("_abs"))
        self.assertEqual(L.controls(examples), items)
        self.assertTrue(all(len(i["item_id"]) <= 27 and i["item_id"].rsplit("__", 1)[1] in "goah" for i in items))

    def test_query_params_are_the_preregistered_three(self):
        self.assertEqual(L.QUERY_PARAMS, {"off": {"limit": 10, "autocut": False}, "on": {"limit": 10, "autocut": True}, "agent-default": {}})


if __name__ == "__main__":
    unittest.main()
