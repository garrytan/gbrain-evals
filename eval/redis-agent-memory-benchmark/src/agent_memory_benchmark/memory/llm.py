# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/memory/llm.py (Apache-2.0). Changes: none.
from __future__ import annotations

from typing import Any

from agent_memory_benchmark.memory.base import QueryResult

ANSWER_SYSTEM_PROMPT = (
    "You are a personal assistant with access to the user's past "
    "conversation history.\n"
    "Answer the user's question using the provided memories, which contain "
    "excerpts\n"
    "from their previous conversations.\n"
    "\n"
    "Draw on any relevant details — including the user's stated preferences,\n"
    "past experiences, habits, and opinions — to give a personalized, "
    "helpful answer.\n"
    "\n"
    "If you see conflicting memories, always put more weight on the more "
    "recent one. \n"
    "\n"
    'Only say "I don\'t have enough information to answer that" if the '
    "context\n"
    "contains nothing relevant to the question.\n"
    "\n"
    "Be concise and direct.\n"
)

_client: Any = None


def get_openai_client() -> Any:
    global _client
    if _client is None:
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise ImportError(
                "OpenAI answer generation requires the 'openai' package. "
                "Install it with: pip install openai"
            ) from exc
        _client = AsyncOpenAI()
    return _client


def build_prompt(
    context: str, question: str, *, question_date: str | None = None
) -> list[dict[str, str]]:
    parts = [ANSWER_SYSTEM_PROMPT]
    if question_date:
        parts.append(
            f"\nCurrent date/time: {question_date}\n"
            "Use this as 'now' when interpreting relative time expressions "
            "like 'last week', 'recently', 'how long ago', etc."
        )
    parts.append(f"\nMemories:\n{context}")
    return [
        {"role": "system", "content": "".join(parts)},
        {"role": "user", "content": question},
    ]


async def generate_answer(
    context: str,
    question: str,
    *,
    model: str = "gpt-4o",
    question_date: str | None = None,
) -> tuple[QueryResult, dict[str, int]]:
    messages = build_prompt(context, question, question_date=question_date)
    response = await get_openai_client().chat.completions.create(
        model=model, messages=messages, temperature=0
    )
    prompt_tokens = response.usage.prompt_tokens if response.usage else 0
    completion_tokens = response.usage.completion_tokens if response.usage else 0
    result = QueryResult(
        answer=response.choices[0].message.content or "",
        prompt=messages,
        llm_prompt_tokens=prompt_tokens,
        llm_completion_tokens=completion_tokens,
    )
    return result, {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
    }
