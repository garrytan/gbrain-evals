"""particle-1 answer LLM for the harness LLM registry.

The pinned harness has no Particle client. Particle serves OpenAI Chat Completions (eval/runner/providers/
openai-compatible.ts, COMPAT_PROVIDERS.particle), so this client sends one with the OpenAI SDK to PARTICLE_BASE_URL
with PARTICLE_API_KEY, which the launcher points at the metering proxy; a base URL that is not on this machine is refused. Every request carries `reasoning_effort: high`
and a 16,000-token output limit (particle-1 reasons by default and bills reasoning as output) and never `temperature`
or `seed`. Particle may bill a request that failed after it was sent, so nothing is sent twice: the SDK's own retries
are off, and the only resend is after the proxy's `mpw_proxy_upstream_unreachable` 502, which it returns only when the
request never reached Particle. Structured output is asked for in the prompt and parsed from the reply, as the
Anthropic client's fallback does. particle-1 is a reader only; it never judges.
"""
from __future__ import annotations

import json
import os
import time

from memory_bench.llm.base import LLM, Schema

MODEL = "particle-1"
REASONING_EFFORT = "high"
MAX_OUTPUT_TOKENS = 16_000
UNREACHABLE = "mpw_proxy_upstream_unreachable"
_MAX_SENDS = 4
_RETRY_BASE_DELAY = 5


def never_sent(error: Exception) -> bool:
    """True only for the proxy's answer that the request never reached Particle."""
    return getattr(error, "status_code", None) == 502 and UNREACHABLE in str(getattr(error, "body", None) or error)


def _fit(parsed: dict, schema: Schema) -> dict | None:
    """The reply's object with each string field as a string: a list of strings becomes its lines joined by newlines
    (particle-1 sometimes lists the steps of an ordering answer); any other non-string value is no structured response."""
    out = dict(parsed)
    for key, spec in schema.properties.items():
        if key not in out or (spec or {}).get("type") != "string" or isinstance(out[key], str):
            continue
        value = out[key]
        if not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
            return None
        out[key] = "\n".join(value)
    return out


class ParticleLLM(LLM):
    def __init__(self, model: str = MODEL):
        if model != MODEL:
            raise ValueError(f"particle: only {MODEL} is wired, not {model}")
        from urllib.parse import urlparse

        from openai import OpenAI

        base_url = os.environ.get("PARTICLE_BASE_URL") or ""
        if urlparse(base_url).hostname not in ("127.0.0.1", "localhost", "::1"):
            raise RuntimeError("particle: PARTICLE_BASE_URL must point at the local metering proxy; this client never calls Particle directly")
        self._client = OpenAI(api_key=os.environ.get("PARTICLE_API_KEY"), base_url=base_url, max_retries=0)
        self._model = model

    @property
    def model_id(self) -> str:
        return f"particle:{self._model}"

    def _create(self, prompt: str):
        delay = _RETRY_BASE_DELAY
        for attempt in range(_MAX_SENDS):
            try:
                return self._client.chat.completions.create(
                    model=self._model, messages=[{"role": "user", "content": prompt}],
                    reasoning_effort=REASONING_EFFORT, max_completion_tokens=MAX_OUTPUT_TOKENS,
                )
            except Exception as e:  # noqa: BLE001
                if not never_sent(e) or attempt == _MAX_SENDS - 1:
                    raise
                time.sleep(delay)
                delay *= 2
        raise RuntimeError("unreachable")

    def generate(self, prompt: str, schema: Schema) -> dict:
        keys = ", ".join(f'"{k}"' for k in schema.properties)
        instruction = f"\n\nReply with exactly one JSON object with the keys {keys} and nothing else."
        response = self._create(prompt + instruction)
        choice = response.choices[0]
        text = choice.message.content or ""
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
                if isinstance(parsed, dict) and all(k in parsed for k in schema.required):
                    fitted = _fit(parsed, schema)
                    if fitted is not None:
                        return fitted
            except json.JSONDecodeError:
                pass
        raise RuntimeError(f"{self.model_id} returned no structured response (finish_reason={choice.finish_reason})")

    def tool_loop(self, prompt, tools, max_tool_calls: int = 10):
        raise NotImplementedError("particle-1 is wired for rag answers only")
