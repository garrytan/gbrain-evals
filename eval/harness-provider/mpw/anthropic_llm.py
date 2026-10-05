"""Anthropic answer/judge LLM for the harness LLM registry.

The pinned harness ships Gemini, Groq and OpenAI clients only. This client
follows the same contract (`generate(prompt, schema) -> dict`, `tool_loop`)
so the newest Sonnet/Opus readers can run through OMB_ANSWER_LLM=anthropic.
Structured output uses a `respond` tool whose input schema is the harness
Schema. The newest models reject a forced tool choice, so the tool is offered
with `tool_choice: auto` (and no `temperature`, which they also reject) and an instruction to call it; a JSON object in the
text reply is accepted when the model answers without the tool. The SDK reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL, so
the launcher points it at the metering proxy.
"""
from __future__ import annotations

import json
import time

from memory_bench.llm.base import LLM, Schema, ToolDef

_MAX_RETRIES = 6
_RETRY_BASE_DELAY = 5
MAX_OUTPUT_TOKENS = 8192


class ModelRefusal(RuntimeError):
    """The model declined to answer (stop_reason=refusal). A reader behavior, not an infrastructure failure."""


class AnthropicLLM(LLM):
    def __init__(self, model: str = "claude-sonnet-5-5"):
        import anthropic

        self._client = anthropic.Anthropic(max_retries=0)
        self._model = model

    @property
    def model_id(self) -> str:
        return f"anthropic:{self._model}"

    def _create(self, **kwargs):
        import anthropic

        delay = _RETRY_BASE_DELAY
        for attempt in range(_MAX_RETRIES):
            try:
                return self._client.messages.create(model=self._model, max_tokens=MAX_OUTPUT_TOKENS, **kwargs)
            except (anthropic.RateLimitError, anthropic.InternalServerError, anthropic.APIConnectionError):
                if attempt == _MAX_RETRIES - 1:
                    raise
                time.sleep(delay)
                delay *= 2
        raise RuntimeError("unreachable")

    def generate(self, prompt: str, schema: Schema) -> dict:
        tool = {
            "name": "respond",
            "description": "Return the structured response.",
            "input_schema": {"type": "object", "properties": schema.properties, "required": schema.required},
        }
        instruction = "\n\nGive your final response by calling the `respond` tool exactly once."
        response = self._create(
            messages=[{"role": "user", "content": prompt + instruction}],
            tools=[tool],
            tool_choice={"type": "auto"},
        )
        for block in response.content:
            if getattr(block, "type", None) == "tool_use" and block.name == "respond":
                return dict(block.input)
        if response.stop_reason == "refusal":
            raise ModelRefusal(f"{self.model_id} declined to answer (stop_reason=refusal)")
        text = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
                if isinstance(parsed, dict) and all(k in parsed for k in schema.required):
                    return parsed
            except json.JSONDecodeError:
                pass
        raise RuntimeError(f"{self.model_id} returned no structured response (stop_reason={response.stop_reason})")

    def tool_loop(self, prompt: str, tools: list[ToolDef], max_tool_calls: int = 10) -> str:
        specs = [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": {"type": "object", "properties": t.parameters, "required": t.required},
            }
            for t in tools
        ]
        fns = {t.name: t.fn for t in tools}
        messages: list[dict] = [{"role": "user", "content": prompt}]
        calls = 0
        while True:
            kwargs = {"tools": specs} if calls < max_tool_calls else {}
            response = self._create(messages=messages, **kwargs)
            uses = [b for b in response.content if getattr(b, "type", None) == "tool_use"]
            if not uses or calls >= max_tool_calls:
                return "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
            messages.append({"role": "assistant", "content": [b.model_dump() for b in response.content]})
            results = []
            for use in uses:
                results.append({"type": "tool_result", "tool_use_id": use.id, "content": fns[use.name](**dict(use.input))})
                calls += 1
            messages.append({"role": "user", "content": results})
