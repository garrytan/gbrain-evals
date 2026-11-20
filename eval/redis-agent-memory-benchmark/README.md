# Redis's LongMemEval harness, vendored

This folder holds the parts of Redis's open benchmark harness for agent memory that gbrain-evals reuses, so a gbrain
LongMemEval number can be compared like for like with the numbers Redis publishes from the same code. It is not our
code: it is a copy of [redis/agent-memory-server](https://github.com/redis/agent-memory-server), folder
`agent-memory-benchmark`, under the Apache License 2.0 ([LICENSE](LICENSE)). Upstream ships no NOTICE file.

- **Upstream commit:** `843d2078830f7297882316efb1aae0fb7ae1481f` (2026-11-17, still the tip of upstream `main` when
  this copy was taken on 2026-11-19). The copy is pinned to that commit and does not track `main`.
- **What we took:** the official LongMemEval judge prompts and Redis's yes/no scorer, the shared answer prompt, the
  task-averaged accuracy metric, the LongMemEval dataset loader with its seed-42 question order, the memory-store
  contract and the resumable runner and command line.
- **What we left out:** the nine third-party provider adapters (`memory/*_store.py`), their docs and tests, upstream's
  README and its `uv.lock`, and upstream's own tests (see below).
- **Reference results:** [redis-longmemeval-results.json](../../docs/comparison-systems/redis-longmemeval-results.json) is Redis's published LongMemEval
  table (task-averaged accuracy for each Redis strategy, with per-task figures), copied unchanged from
  [redis/redis-ai-research-public](https://github.com/redis/redis-ai-research-public) at
  `7dbb607e1d6a439b14b7d35a45624e82a54e0a8f`, `docs/longmemeval-agent-memory/data/results.json`, under that
  repository's MIT license ([LICENSE-redis-ai-research-public](../../docs/comparison-systems/LICENSE-redis-ai-research-public)). Redis publishes aggregates only, no per-question
  outputs.

## What we changed

Every copied source file starts with one comment line naming its upstream path and commit and saying what we changed,
or `Changes: none`. The license files and the JSON reference file can't carry a comment, so they are byte-identical to
upstream. [vendor.json](vendor.json) lists every copied file with its upstream path and git blob hash, and
`test/eval/redis-harness-vendor.test.ts` checks that each file marked unchanged is byte-identical to that blob once its
header line is removed.

| File | Change |
|---|---|
| `pyproject.toml` | Removed the optional third-party provider extras. |
| `src/agent_memory_benchmark/benchmark/runner.py` | Renames the local variable `key` to `qid` in `process()`, because gstack's secret scanner read `key = qa.question_id or ...` as a credential. Behaviour is unchanged. |
| `src/agent_memory_benchmark/cli.py` | `run` and `judge` refuse to start unless `OPENAI_BASE_URL` (and `--base-url`, if given) points at 127.0.0.1, ::1 or localhost, so the command line can reach only the metering proxy or the keyless fake, never a paid provider directly. `test/eval/redis-harness-cli-guard.test.ts` checks it. |
| `src/agent_memory_benchmark/datasets/longmemeval.py` | Reads the dataset at Hugging Face revision `98d7416c24c778c2fee6e6f3006e7a073259d48f` instead of `main`, so the files can't move under a run. |
| `src/agent_memory_benchmark/memory/__init__.py` | Imports and registers none of the removed provider adapters, so `STORES` starts empty. |

Local files, not from upstream: this README, `vendor.json` and `uv.lock`, which `uv` regenerated for the trimmed
dependency list.

The gbrain store, the readers other than OpenAI's and the cross-family judges are ours. They live on the results
branch of the experiment that uses this copy, named in its
[preregistration](../../docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md), and never change a
file here.

## Upstream's tests

Upstream's tests are not copied here, because CI runs no Python tests outside `test/`, so a copy would go untested.
Run them from upstream at `843d2078830f7297882316efb1aae0fb7ae1481f`. On 2026-11-19, before we dropped them from this
copy, all 37 tests in the four keyless test files we had copied (with the one test that imports the removed provider
adapters taken out) passed with no keys against these sources.
