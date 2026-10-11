"""Delivered-context accounting on the final prompt.

The delivered quantity is the exact context text a dataset's prompt builder
inserted into the final prompt, counted with tiktoken `cl100k_base` (the
harness's own tokenizer and gbrain's evidence packer's). When the LongMemEval,
LoCoMo or LifeBench builder substitutes `json.dumps(raw_response)` for the
rendered context, the JSON is what gets counted. Nothing is ever truncated:
a cell whose delivered tokens miss the target fails its gate instead.

`inserted_context` recovers the inserted text without trusting the builder's
internals: it renders the same builder once with a sentinel context and no
raw response, takes the text before and after the sentinel, and requires the
real prompt to have that prefix and suffix. The remainder is the inserted
context, which must equal either the rendered context or the raw JSON.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache

SENTINEL = "\u2063MPW-CONTEXT-SENTINEL\u2063"
GATE_TOLERANCE = 0.10


@lru_cache(maxsize=1)
def _encoding():
    import tiktoken

    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_encoding().encode(text, disallowed_special=()))


class PromptShapeError(RuntimeError):
    """The builder's prompt does not match its own template: the harness changed shape."""


@dataclass
class Inserted:
    text: str
    kind: str  # rendered | raw_json
    tokens: int


def inserted_context(build, query: str, context: str, meta: dict, raw_response, prompt: str) -> Inserted:
    """Recover the context text `build(query, context, meta=...)` inserted into `prompt`."""
    template = build(query, SENTINEL, meta={**meta, "_raw_response": None})
    if template.count(SENTINEL) != 1:
        raise PromptShapeError(f"the prompt builder inserted the context {template.count(SENTINEL)} times")
    prefix, suffix = template.split(SENTINEL)
    if not (prompt.startswith(prefix) and prompt.endswith(suffix)) or len(prompt) < len(prefix) + len(suffix):
        raise PromptShapeError("the final prompt does not match the builder's template around the context")
    text = prompt[len(prefix): len(prompt) - len(suffix)]
    if text == context:
        kind = "rendered"
    elif raw_response and text == json.dumps(raw_response):
        kind = "raw_json"
    else:
        raise PromptShapeError("the inserted context is neither the rendered context nor the provider's raw JSON")
    return Inserted(text=text, kind=kind, tokens=count_tokens(text))


def p95(values: list[int]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, math.ceil(0.95 * len(ordered)) - 1)
    return float(ordered[rank])


@dataclass
class GateResult:
    target: int
    n: int
    mean: float
    p95: float
    ok: bool
    reason: str

    def as_dict(self) -> dict:
        return {"target": self.target, "n": self.n, "mean": round(self.mean, 1), "p95": self.p95,
                "tolerance": GATE_TOLERANCE, "ok": self.ok, "reason": self.reason}


def gate(target: int | None, tokens: list[int]) -> GateResult:
    """Mean and p95 delivered tokens must each lie within ±10% of the target."""
    if target is None:
        return GateResult(0, len(tokens), sum(tokens) / max(1, len(tokens)), p95(tokens), True, "no target: system default, reported only")
    if not tokens:
        return GateResult(target, 0, 0.0, 0.0, False, "no delivered contexts to measure")
    mean = sum(tokens) / len(tokens)
    high = p95(tokens)
    lo, hi = target * (1 - GATE_TOLERANCE), target * (1 + GATE_TOLERANCE)
    problems = []
    if not lo <= mean <= hi:
        problems.append(f"mean {mean:.0f} outside [{lo:.0f}, {hi:.0f}]")
    if not lo <= high <= hi:
        problems.append(f"p95 {high:.0f} outside [{lo:.0f}, {hi:.0f}]")
    return GateResult(target, len(tokens), mean, high, not problems, "; ".join(problems) or "within ±10% of target")
