"""Call each harness LLM client once and print one JSON object of outcomes.

Used by test/eval/metering-proxy.test.ts to prove that a zero balance blocks
dispatch from a harness Python process. It runs the pinned harness's own
clients (Gemini, OpenAI, Groq) and our Anthropic client exactly as a cell
does, with the environment the metering proxy issues for the `harness`
label, so base URLs and keys come only from that environment.

    python eval/harness-provider/tests/llm_probe.py [gemini,openai,groq,anthropic]

Not collected by pytest (no test_ prefix).
"""
from __future__ import annotations

import json
import sys
import time

MODELS = {
    "gemini": "gemini-3.5-flash",
    "openai": "gpt-6.1-sol",
    "groq": "openai/gpt-oss-120b",
    "anthropic": "claude-sonnet-5-5",
}


def client(name: str):
    if name == "gemini":
        from memory_bench.llm.gemini import GeminiLLM

        return GeminiLLM(model=MODELS[name])
    if name == "openai":
        from memory_bench.llm.openai import OpenAILLM

        return OpenAILLM(model=MODELS[name])
    if name == "groq":
        from memory_bench.llm.groq import GroqLLM

        return GroqLLM(model=MODELS[name])
    if name == "anthropic":
        from mpw.anthropic_llm import AnthropicLLM

        return AnthropicLLM(model=MODELS[name])
    raise SystemExit(f"unknown client {name}")


def main() -> None:
    from memory_bench.llm.base import Schema

    names = sys.argv[1].split(",") if len(sys.argv) > 1 else list(MODELS)
    schema = Schema(properties={"answer": {"type": "string", "description": "The answer."}}, required=["answer"])
    out = {}
    for name in names:
        start = time.monotonic()
        try:
            result = client(name).generate("Reply with the word ok.", schema)
            out[name] = {"ok": True, "result": result, "seconds": round(time.monotonic() - start, 3)}
        except Exception as error:  # the probe reports every failure; the caller asserts on it
            out[name] = {"ok": False, "error": f"{type(error).__name__}: {error}", "seconds": round(time.monotonic() - start, 3)}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
