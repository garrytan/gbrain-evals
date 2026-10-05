"""Deterministic in-process LLM for unit tests (no network).

Answers by echoing the first context line that shares a word with the
question; judges by checking whether the gold text appears in the answer.
Registered as OMB_*_LLM=mpw-stub by tests only.
"""
from __future__ import annotations

import re

from memory_bench.llm.base import LLM, Schema

_WORD = re.compile(r"[a-z]{4,}")


class StubLLM(LLM):
    def __init__(self, model: str = "stub-1"):
        self._model = model
        self.calls: list[str] = []

    @property
    def model_id(self) -> str:
        return f"mpw-stub:{self._model}"

    def generate(self, prompt: str, schema: Schema) -> dict:
        self.calls.append(prompt)
        props = set(schema.properties)
        if "correct" in props:
            m = re.search(r"Gold answers[^\n]*\n- (.+)\n", prompt)
            gold = (m.group(1) if m else "").strip().lower()
            ans = prompt.split("System's answer:")[-1].lower() if "System's answer:" in prompt else prompt.lower()
            ok = bool(gold) and gold.rstrip(".") in ans
            return {"correct": ok, "reason": "stub judge: gold text " + ("found" if ok else "absent")}
        q = prompt.rsplit("Question:", 1)[-1].lower()
        words = set(_WORD.findall(q)) - {"what", "which", "does", "have", "with", "from", "that", "this"}
        for line in prompt.split("Memories:", 1)[-1].splitlines():
            if words & set(_WORD.findall(line.lower())):
                answer = line.strip()[:300]
                break
        else:
            answer = "The memories do not contain the answer."
        out = {"reasoning": "stub", "answer": answer}
        if "choice" in props:
            out = {"reasoning": "stub", "choice": "a"}
        return out
