# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/prompts/__init__.py (Apache-2.0). Changes: none.
"""Benchmark protocol prompts."""

from agent_memory_benchmark.prompts.judge import build_judge_prompt

__all__ = ["build_judge_prompt"]
