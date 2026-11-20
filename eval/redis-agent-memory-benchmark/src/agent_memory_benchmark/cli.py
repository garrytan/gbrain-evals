# Vendored from redis/agent-memory-server@843d2078830f7297882316efb1aae0fb7ae1481f, agent-memory-benchmark/src/agent_memory_benchmark/cli.py (Apache-2.0). Changes: run and judge refuse to start unless OPENAI_BASE_URL (and --base-url, if given) points at a loopback host, so they reach only the metering proxy or the keyless fake.
"""Command-line interface for the LongMemEval harness."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

from agent_memory_benchmark.benchmark.judge import (
    DEFAULT_JUDGE_MODEL,
    judge_experiment,
)
from agent_memory_benchmark.benchmark.runner import (
    parse_provider_params,
    run_longmemeval_v1,
)
from agent_memory_benchmark.memory import STORES

DEFAULT_RESULTS_ROOT = Path("experiment_results")
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _positive(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="memory-bench",
        description="Provider-neutral LongMemEval benchmark harness.",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run", help="Run or resume a benchmark")
    run.add_argument("--provider", required=True, choices=sorted(STORES))
    run.add_argument("--run-name")
    run.add_argument("--results-root", type=Path, default=DEFAULT_RESULTS_ROOT)
    run.add_argument(
        "--provider-param", action="append", default=[], metavar="KEY=VALUE"
    )
    run.add_argument("--limit", type=_positive)
    run.add_argument("--retries", type=_positive, default=3)
    run.add_argument("--split", choices=["oracle", "small", "medium"], default="small")
    run.add_argument("--concurrency", type=_positive, default=1)
    run.add_argument("--cache-dir", type=Path)

    judge = subparsers.add_parser("judge", help="Judge or resume a LongMemEval run")
    judge.add_argument(
        "--experiment",
        required=True,
        help="Run name, directory, or answers.jsonl",
    )
    judge.add_argument("--results-root", type=Path, default=DEFAULT_RESULTS_ROOT)
    judge.add_argument(
        "--judge-model", "--model", dest="model", default=DEFAULT_JUDGE_MODEL
    )
    judge.add_argument("--base-url")
    judge.add_argument("--concurrency", type=_positive, default=5)
    judge.add_argument("--limit", type=_positive)
    judge.add_argument("--retries", type=_positive, default=3)

    providers = subparsers.add_parser("providers", help="List memory providers")
    providers.add_argument("--json", action="store_true", dest="as_json")
    return parser


def _refuse_unless_loopback(cli_base_url: str | None) -> None:
    urls = [os.environ.get("OPENAI_BASE_URL", "")]
    if cli_base_url is not None:
        urls.append(cli_base_url)
    for url in urls:
        try:
            host = urlsplit(url).hostname
        except ValueError:
            host = None
        if host not in LOOPBACK_HOSTS:
            raise SystemExit(
                "memory-bench: refusing to start: OPENAI_BASE_URL (and --base-url, if given) must point at "
                "127.0.0.1, ::1 or localhost, because the metering proxy or the keyless fake are the only allowed routes"
            )


async def _run(args: argparse.Namespace) -> Path:
    try:
        params = parse_provider_params(args.provider_param)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    return await run_longmemeval_v1(
        provider=args.provider,
        split=args.split,
        results_root=args.results_root,
        run_name=args.run_name,
        provider_params=params,
        limit=args.limit,
        concurrency=args.concurrency,
        retries=args.retries,
        cache_dir=args.cache_dir,
    )


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if args.command == "providers":
        names = sorted(STORES)
        print(json.dumps(names, indent=2) if args.as_json else "\n".join(names))
        return 0
    _refuse_unless_loopback(getattr(args, "base_url", None))
    if args.command == "run":
        out_dir = asyncio.run(_run(args))
        print(out_dir)
        return 0
    metrics = asyncio.run(
        judge_experiment(
            experiment=args.experiment,
            results_root=args.results_root,
            model=args.model,
            concurrency=args.concurrency,
            limit=args.limit,
            retries=args.retries,
            base_url=args.base_url,
        )
    )
    print(json.dumps(metrics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
