"""LongMemEval on Redis's open harness: contexts, messages and the runner store for gbrain.

Preregistration: docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md.

    uv run --project eval/redis-agent-memory-benchmark python eval/runner/lme-redis/lme_redis.py freeze \
        --cache-dir <dir> --out <dir> [--server-url http://127.0.0.1:8787] [--limit N | --last N]

freeze loads both LongMemEval files through the vendored loader after checking their sha256, puts the questions in
the harness's seed-42 order, and for each question writes one line per arm to <out>/messages/<arm>.jsonl: the two
messages from the vendored build_prompt, the context's sha256, the conversations it holds and turn-level delivery of
the evidence turns (`has_answer`). The gbrain arms build one brain per question on the adapter server
(eval/runner/lme-redis/gbrain-server.ts) and record each query in <out>/retrieval.jsonl. Whole conversations are
rendered with the vendored session_text in every arm, so the arms differ only in which conversations they hold.

The same rendering backs GBrainArmStore, a store for the vendored runner, so the runner's own requests can be checked
against the frozen messages byte for byte (the pilot's parity check).

freeze and the runner store need the vendored package's environment (httpx); the rendering functions need only the
vendored sources on the path, so their tests (test_lme_redis.py beside this file) run on a bare python3.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import random
import re
import sys
from pathlib import Path
from typing import Any

from agent_memory_benchmark.memory.base import QueryResult, SessionLike, TokenUsage
from agent_memory_benchmark.memory.common import AnsweringStore, session_text
from agent_memory_benchmark.memory.llm import build_prompt

SHA256 = {
    "small": "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
    "oracle": "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c",
}
FILES = {"small": "longmemeval_s_cleaned.json", "oracle": "longmemeval_oracle.json"}
TOP_SESSIONS = 5
QUERY_PARAMS: dict[str, dict[str, Any]] = {
    "off": {"limit": 10, "autocut": False},
    "on": {"limit": 10, "autocut": True},
    "agent-default": {},
}
ARMS = ("off", "on", "agent-default", "full", "oracle")
_SUPPLEMENTARY_UTF8_RE = re.compile(r"[\U00010000-\U0010ffff]+")


def load_split(split: str, cache_dir: Path) -> tuple[list[Any], list[dict]]:
    """The vendored loader's examples and raw rows, after the file's sha256 matches the preregistered one."""
    from agent_memory_benchmark.datasets.longmemeval import LongMemEvalAdapter

    path = Path(cache_dir) / "longmemeval-v1" / FILES[split]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SHA256[split]:
        raise SystemExit(f"{path}: sha256 {digest}, preregistered {SHA256[split]}; refusing to load")
    adapter = LongMemEvalAdapter(split, cache_dir=cache_dir)
    return adapter.load(), adapter.load_raw()


def seed42(items: list[Any]) -> list[Any]:
    """The harness's order: random.Random(42).shuffle over the loader's examples."""
    out = list(items)
    random.Random(42).shuffle(out)
    return out


def kept_raw_sessions(row: dict) -> list[list[dict]]:
    """The raw sessions the loader keeps, in its order (it drops sessions with no role/content turn)."""
    return [
        [t for t in s if isinstance(t, dict) and "role" in t and "content" in t]
        for s in row.get("haystack_sessions", [])
        if any(isinstance(t, dict) and "role" in t and "content" in t for t in s)
    ]


def evidence_turns(row: dict) -> list[tuple[int, str]]:
    """(kept session index, turn text as the loader cleans it) for every has_answer turn."""
    out = []
    for i, session in enumerate(kept_raw_sessions(row)):
        for t in session:
            if t.get("has_answer"):
                out.append((i, _SUPPLEMENTARY_UTF8_RE.sub("", str(t["content"]))))
    return out


def norm(text: str) -> str:
    """The preregistered normalisation: supplementary-plane characters removed (as the loader does), then whitespace
    collapsed and case folded."""
    return " ".join(_SUPPLEMENTARY_UTF8_RE.sub("", text).lower().split())


MIN_RUN = 16


def _covered(turn: str, passages: list[str]) -> int:
    """How many characters of `turn` the passages cover together: each passage contributes the runs of at least
    MIN_RUN characters it shares with the turn, taken greedily from the turn's start."""
    mark = bytearray(len(turn))
    for p in passages:
        s = 0
        while s < len(turn):
            lo, hi = 0, len(turn) - s
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if turn[s:s + mid] in p:
                    lo = mid
                else:
                    hi = mid - 1
            if lo >= MIN_RUN:
                mark[s:s + lo] = b"\x01" * lo
                s += lo
            else:
                s += 1
    return sum(mark)


def delivery(row: dict, texts: list[str], sessions: list[int] | None,
             passage_sessions: list[int] | None = None) -> dict[str, Any]:
    """Turn-level delivery of the evidence turns (`has_answer`) into a prompt's memories (preregistration, "Evidence
    delivered, at turn level").

    `texts` is what the prompt holds, one string per conversation (whole arms, `sessions` their indices) or per
    passage (`sessions` None, `passage_sessions` each passage's conversation). A turn is delivered only when its whole
    normalised text appears in one of them. For passages, a turn split across passages still counts when the passages
    from its conversation together cover every character of it (`split_rule` counts those). A turn present only in
    part counts as not delivered and is counted in `partial`. `conversation_level` counts turns whose conversation is
    in the prompt (whole arms only).
    """
    turns = evidence_turns(row)
    held = [norm(t) for t in texts]
    passages = sessions is None
    delivered = split_rule = partial = 0
    for idx, text in turns:
        t = norm(text)
        if not t:
            continue
        if any(t in h for h in held):
            delivered += 1
            continue
        if not passages:
            continue
        covered = _covered(t, [h for h, i in zip(held, passage_sessions or []) if i == idx])
        if passages and covered == len(t):
            delivered += 1
            split_rule += 1
        elif covered:
            partial += 1
    return {
        "evidence_turns": len(turns),
        "delivered": delivered,
        "all_delivered": bool(turns) and delivered == len(turns),
        "partial": partial,
        "split_rule": split_rule if passages else None,
        "conversation_level": None if passages else sum(1 for i, _ in turns if i in set(sessions)),
    }


def whole_context(example: Any, indices: list[int]) -> str:
    return "\n\n".join(session_text(example.sessions[i]) for i in indices)


def ranked_sessions(results: list[dict], top: int = TOP_SESSIONS) -> list[int]:
    """The first `top` distinct conversations behind gbrain's results, in rank order."""
    seen: list[int] = []
    for r in results:
        if r["idx"] not in seen:
            seen.append(r["idx"])
    return seen[:top]


def passage_context(example: Any, results: list[dict]) -> tuple[str, list[str]]:
    passages = [r["chunk_text"] for r in results]
    text = "\n\n".join(
        f"[Conversation date: {example.sessions[r['idx']].label}]\n{r['chunk_text']}" for r in results
    )
    return text, passages


def gbrain_context(arm: str, example: Any, results: list[dict]) -> tuple[str, list[int], list[str] | None]:
    if arm == "agent-default":
        text, passages = passage_context(example, results)
        return text, sorted({r["idx"] for r in results}), passages
    indices = ranked_sessions(results)
    return whole_context(example, indices), indices, None


def degraded(query: dict) -> bool:
    """A query that ran without the reranker or with a degraded stage."""
    return bool(query["op"]["degraded"]) or not query["op"]["reranker"]


def is_prefix(short: list[dict], long: list[dict]) -> bool:
    key = [(r["slug"], r["chunk_text"]) for r in long]
    return [(r["slug"], r["chunk_text"]) for r in short] == key[: len(short)]


def ingest_payload(sessions: list[SessionLike]) -> list[dict]:
    return [
        {
            "date": s.label or "",
            "turns": [
                {"role": "user" if m.speaker.lower().strip() in {"user", "human", "environment", "tool"} else "assistant",
                 "content": m.text}
                for m in s.messages
                if m.text.strip()
            ],
        }
        for s in sessions
    ]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def message_line(arm: str, example: Any, context: str, sessions: list[int], row: dict,
                 passages: list[str] | None, passage_sessions: list[int] | None = None) -> dict[str, Any]:
    qa = example.qa_pairs[0]
    messages = build_prompt(context, qa.question, question_date=example.metadata.get("question_date"))
    return {
        "question_id": qa.question_id,
        "question_type": qa.question_type,
        "arm": arm,
        "messages": messages,
        "context_sha256": sha(context),
        "messages_sha256": sha(json.dumps(messages, ensure_ascii=False, sort_keys=True)),
        "sessions": sessions,
        "delivery": delivery(row, passages if passages is not None else [session_text(example.sessions[i]) for i in sessions],
                             None if passages is not None else sessions, passage_sessions),
    }


RECORDED: dict[tuple[str, str], tuple[list[SessionLike], list[dict]]] = {}


class GBrainArmStore(AnsweringStore):
    """A store for the vendored runner: one gbrain arm (off, on or agent-default), rendered as freeze renders it."""

    def __init__(self, *, user_id: str = "benchmark", model: str = "gpt-4o", arm: str = "off",
                 server_url: str = "http://127.0.0.1:8787", request_timeout: float = 900) -> None:
        super().__init__(model=model)
        if arm not in QUERY_PARAMS:
            raise ValueError(f"arm must be one of {sorted(QUERY_PARAMS)}")
        self._brain_id = user_id
        self._arm = arm
        self._sessions: list[SessionLike] = []
        import httpx

        self._client = httpx.AsyncClient(base_url=server_url, timeout=request_timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        response = await self._client.post(path, json=body)
        if response.status_code != 200:
            raise RuntimeError(f"gbrain {path} failed: {response.text[:2000]}")
        return response.json()

    async def ingest(self, sessions: list[SessionLike]) -> None:
        self._sessions = list(sessions)
        await self._post("/ingest", {"brain_id": self._brain_id, "sessions": ingest_payload(self._sessions)})

    async def query(self, question: str, *, question_date: str | None = None) -> QueryResult:
        result = await self._post("/query", {"brain_id": self._brain_id, "question": question,
                                             "params": QUERY_PARAMS[self._arm]})

        class _Example:
            sessions = self._sessions

        RECORDED[(self._arm, question)] = (list(self._sessions), result["results"])
        context, _, _ = gbrain_context(self._arm, _Example, result["results"])
        return await self._answer(context, question, question_date)

    async def list_memories(self) -> list[str]:
        return [f"session-{i}" for i in range(len(self._sessions))]

    async def reset(self) -> None:
        await self._post("/reset", {"brain_id": self._brain_id})
        self._sessions = []
        self._token_usage = TokenUsage()

    def get_store_metadata(self) -> dict[str, Any]:
        return {**super().get_store_metadata(), "arm": self._arm, "query_params": QUERY_PARAMS[self._arm]}


class FullContextStore(AnsweringStore):
    """The plain arm for the vendored runner: every conversation, whole, in the loader's order."""

    def __init__(self, *, user_id: str = "benchmark", model: str = "gpt-4o") -> None:
        super().__init__(model=model)
        self._sessions: list[SessionLike] = []

    async def ingest(self, sessions: list[SessionLike]) -> None:
        self._sessions = list(sessions)

    async def query(self, question: str, *, question_date: str | None = None) -> QueryResult:
        return await self._answer("\n\n".join(session_text(s) for s in self._sessions), question, question_date)

    async def list_memories(self) -> list[str]:
        return [f"session-{i}" for i in range(len(self._sessions))]

    async def reset(self) -> None:
        self._sessions = []
        self._token_usage = TokenUsage()


def register_stores() -> None:
    from agent_memory_benchmark.memory import STORES

    STORES["gbrain-arm"] = GBrainArmStore
    STORES["full-context"] = FullContextStore


async def freeze(args: argparse.Namespace) -> int:
    import httpx

    small, small_raw = load_split("small", args.cache_dir)
    oracle, oracle_raw = load_split("oracle", args.cache_dir)
    raw_by_id = {str(r["question_id"]): r for r in small_raw}
    oracle_by_id = {str(e.qa_pairs[0].question_id): e for e in oracle}
    oracle_raw_by_id = {str(r["question_id"]): r for r in oracle_raw}
    order = seed42(small)
    if args.last:
        order = order[-args.last:]
    elif args.limit:
        order = order[: args.limit]
    out = Path(args.out)
    (out / "messages").mkdir(parents=True, exist_ok=True)
    (out / "order.json").write_text(json.dumps([str(e.qa_pairs[0].question_id) for e in order]) + "\n")
    done: set[str] = set()
    retrieval_path = out / "retrieval.jsonl"
    if retrieval_path.exists():
        done = {json.loads(line)["question_id"] for line in retrieval_path.read_text().split("\n") if line.strip()}
    handles = {arm: (out / "messages" / f"{arm}.jsonl").open("a", encoding="utf-8") for arm in ARMS}
    semaphore = asyncio.Semaphore(args.concurrency)
    lock = asyncio.Lock()
    failures = 0

    async with httpx.AsyncClient(base_url=args.server_url, timeout=900) as client:

        async def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
            r = await client.post(path, json=body)
            if r.status_code != 200:
                raise RuntimeError(f"{path}: {r.text[:2000]}")
            return r.json()

        async def one(example: Any) -> None:
            nonlocal failures
            qa = example.qa_pairs[0]
            qid = str(qa.question_id)
            if qid in done:
                return
            row = raw_by_id[qid]
            if len(kept_raw_sessions(row)) != len(example.sessions):
                raise RuntimeError(f"{qid}: raw and loader sessions disagree")
            async with semaphore:
                try:
                    await post("/ingest", {"brain_id": qid, "sessions": ingest_payload(example.sessions)})
                    retried = False
                    while True:
                        queries = {}
                        for arm, params in QUERY_PARAMS.items():
                            queries[arm] = await post("/query", {"brain_id": qid, "question": qa.question, "params": params})
                        if retried or not any(degraded(q) for q in queries.values()):
                            break
                        retried = True
                finally:
                    await post("/reset", {"brain_id": qid})
            lines = {}
            for arm, result in queries.items():
                context, sessions, passages = gbrain_context(arm, example, result["results"])
                lines[arm] = message_line(arm, example, context, sessions, row, passages,
                                          [r["idx"] for r in result["results"]] if passages is not None else None)
            lines["full"] = message_line("full", example, whole_context(example, list(range(len(example.sessions)))),
                                         list(range(len(example.sessions))), row, None)
            o = oracle_by_id[qid]
            o_row = oracle_raw_by_id[qid]
            lines["oracle"] = message_line("oracle", o, whole_context(o, list(range(len(o.sessions)))),
                                           list(range(len(o.sessions))), o_row, None)
            record = {
                "question_id": qid,
                "question_type": qa.question_type,
                "conversations": len(example.sessions),
                "queries": {
                    arm: {**q["op"], "order": [r["idx"] for r in q["results"]], "rows": len(q["results"]),
                          "meta": q["meta"]}
                    for arm, q in queries.items()
                },
                "retrieved_again": retried,
                "degraded": any(degraded(q) for q in queries.values()),
                "on_prefix_of_off": is_prefix(queries["on"]["results"], queries["off"]["results"]),
                "off_on_context_differs": lines["off"]["context_sha256"] != lines["on"]["context_sha256"],
            }
            if record["degraded"]:
                failures += 1
            async with lock:
                for arm in ARMS:
                    handles[arm].write(json.dumps(lines[arm], ensure_ascii=False) + "\n")
                    handles[arm].flush()
                with retrieval_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(record, ensure_ascii=False) + "\n")

        await asyncio.gather(*(one(e) for e in order))
    for h in handles.values():
        h.close()
    print(json.dumps({"questions": len(order), "skipped_done": len(done), "degraded_after_retry": failures}))
    return 0


ABSTAIN_REPLY = "I don't have enough information to answer that."
CONTROL_SEED = "lme-redis-harness"
PILOT_SIZE = 25


def judge_messages(qa: Any, response: str) -> list[dict[str, str]]:
    """The vendored official judge prompt as Redis's judge sends it: one user message."""
    from agent_memory_benchmark.prompts.judge import build_judge_prompt

    qid = str(qa.question_id)
    prompt = build_judge_prompt(question=qa.question, answer=qa.answer, response=response,
                                question_type=qa.question_type, abstain=qid.endswith("_abs"))
    return [{"role": "user", "content": prompt}]


def judge_line(item_id: str, qa: Any, response: str, **extra: Any) -> dict[str, Any]:
    messages = judge_messages(qa, response)
    return {"item_id": item_id, "question_id": str(qa.question_id), "question_type": qa.question_type,
            "messages": messages, "messages_sha256": sha(_canon(messages)), **extra}


def controls(examples: list[Any]) -> list[dict[str, Any]]:
    """The judge check's 200 known-answer items (preregistration, "Judge check" step 1): 50 Small questions outside the
    pilot's last 25 in seed-42 order, 40 answerable spread over the six types and 10 abstention, drawn with the seed
    `lme-redis-harness`, four answers each with a known verdict. Item ids are `<question id>__<g|o|a|h>`, short enough
    for a batch custom id."""
    order = seed42(examples)
    pool = order[: len(order) - PILOT_SIZE]
    rng = random.Random(CONTROL_SEED)
    abstain = [e for e in pool if str(e.qa_pairs[0].question_id).endswith("_abs")]
    answerable = [e for e in pool if not str(e.qa_pairs[0].question_id).endswith("_abs")]
    by_type: dict[str, list[Any]] = {}
    for e in answerable:
        by_type.setdefault(e.qa_pairs[0].question_type, []).append(e)
    types = sorted(by_type)
    for t in types:
        rng.shuffle(by_type[t])
    chosen: list[Any] = []
    i = 0
    while len(chosen) < 40:
        t = types[i % len(types)]
        if by_type[t]:
            chosen.append(by_type[t].pop())
        i += 1
    chosen += rng.sample(abstain, 10)
    golds = [e.qa_pairs[0] for e in chosen]
    donors = list(range(len(golds)))
    rng.shuffle(donors)
    for k in range(len(donors)):
        if donors[k] == k:
            j = (k + 1) % len(donors)
            donors[k], donors[j] = donors[j], donors[k]
    items = []
    for k, qa in enumerate(golds):
        abs_q = str(qa.question_id).endswith("_abs")
        other = golds[donors[k]].answer
        for code, kind, response, expected in (
            ("g", "gold", qa.answer, True),
            ("o", "other-gold", other, False),
            ("a", "abstain", ABSTAIN_REPLY, abs_q),
            ("h", "hedged-gold", f"I think it was {qa.answer}, though I'm not certain.", True),
        ):
            items.append(judge_line(f"{qa.question_id}__{code}", qa, response, kind=kind, expected=expected))
    return items


class _FakeOpenAI:
    """A local keyless stand-in for OpenAI chat completions: records every request body, answers a fixed string."""

    def __init__(self) -> None:
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        self.bodies: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fake.bodies.append(body)
                reply = json.dumps({
                    "id": "fake", "object": "chat.completion", "created": 0, "model": body.get("model", ""),
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "FAKE"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *_args: Any) -> None:
                return None

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def _question_date(system: str) -> str | None:
    match = re.search(r"\nCurrent date/time: (.*)\n", system)
    return match.group(1) if match else None


def _canon(messages: list[dict]) -> str:
    return json.dumps(messages, ensure_ascii=False)


async def parity(args: argparse.Namespace) -> int:
    """Redis's own runner, end to end on the first N questions, against a keyless fake: the messages it sends must
    equal the frozen messages byte for byte, arm by arm."""
    import os

    from agent_memory_benchmark.benchmark.runner import run_longmemeval_v1
    from agent_memory_benchmark.memory import llm

    fake = _FakeOpenAI()
    os.environ["OPENAI_BASE_URL"] = fake.url
    os.environ["OPENAI_API_KEY"] = "keyless-fake"
    llm._client = None
    register_stores()
    frozen = {
        arm: {json.loads(line)["messages"][1]["content"]: json.loads(line)
              for line in (Path(args.frozen) / "messages" / f"{arm}.jsonl").read_text().split("\n") if line.strip()}
        for arm in ARMS
    }
    runs = [(arm, "gbrain-arm", "small", {"arm": arm, "server_url": args.server_url}) for arm in QUERY_PARAMS]
    runs += [("full", "full-context", "small", {}), ("oracle", "full-context", "oracle", {})]
    report: dict[str, Any] = {}
    for arm, provider, split, params in runs:
        fake.bodies.clear()
        RECORDED.clear()
        await run_longmemeval_v1(provider=provider, split=split, results_root=Path(args.out), run_name=f"parity-{arm}",
                                 provider_params=params, limit=None if split == "oracle" else args.limit,
                                 cache_dir=args.cache_dir)
        sent = {b["messages"][1]["content"]: b for b in fake.bodies}
        with (Path(args.out) / f"sent-{arm}.jsonl").open("w", encoding="utf-8") as f:
            for b in fake.bodies:
                f.write(json.dumps(b, ensure_ascii=False) + "\n")
        compared = [q for q in frozen[arm] if q in sent]
        if arm in QUERY_PARAMS:
            # gbrain's ranking can differ between two retrievals of the same brain (ties), so the runner's messages are
            # checked against our rendering of the retrieval the runner's own store received, and the frozen file's
            # retrieval is compared with it separately.
            mismatched, same_retrieval = [], 0
            for q in compared:
                sessions, results = RECORDED[(arm, q)]

                class _Ex:
                    pass

                _Ex.sessions = sessions
                context, _, _ = gbrain_context(arm, _Ex, results)
                date = frozen[arm][q]["messages"][0]["content"]
                ours = build_prompt(context, q, question_date=_question_date(date))
                if _canon(sent[q]["messages"]) != _canon(ours):
                    mismatched.append(frozen[arm][q]["question_id"])
                same_retrieval += _canon(ours) == _canon(frozen[arm][q]["messages"])
        else:
            same_retrieval = None
            mismatched = [frozen[arm][q]["question_id"] for q in compared
                          if _canon(sent[q]["messages"]) != _canon(frozen[arm][q]["messages"])]
        report[arm] = {"compared": len(compared), "mismatched": mismatched, "same_as_frozen_retrieval": same_retrieval,
                       "runner_request": {k: v for k, v in next(iter(sent.values()), {}).items() if k != "messages"}}
    fake.server.shutdown()
    ok = all(r["compared"] >= min(args.limit, len(frozen[a])) and not r["mismatched"] for a, r in report.items())
    print(json.dumps({"parity": "ok" if ok else "FAILED", "arms": report}, indent=2))
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lme_redis")
    sub = parser.add_subparsers(dest="command", required=True)
    f = sub.add_parser("freeze")
    f.add_argument("--cache-dir", type=Path, required=True)
    f.add_argument("--out", type=Path, required=True)
    f.add_argument("--server-url", default="http://127.0.0.1:8787")
    f.add_argument("--concurrency", type=int, default=4)
    f.add_argument("--limit", type=int, default=0)
    f.add_argument("--last", type=int, default=0)
    c = sub.add_parser("controls")
    c.add_argument("--cache-dir", type=Path, required=True)
    c.add_argument("--out", type=Path, required=True)
    j = sub.add_parser("judge-messages")
    j.add_argument("--cache-dir", type=Path, required=True)
    j.add_argument("--answers", type=Path, required=True, help="JSONL of {item_id, question_id, answer}")
    j.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("parity")
    p.add_argument("--cache-dir", type=Path, required=True)
    p.add_argument("--frozen", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--server-url", default="http://127.0.0.1:8787")
    p.add_argument("--limit", type=int, default=3)
    args = parser.parse_args(argv)
    if args.command == "controls":
        examples, _ = load_split("small", args.cache_dir)
        write_jsonl(args.out, controls(examples))
        return 0
    if args.command == "judge-messages":
        examples, _ = load_split("small", args.cache_dir)
        by_id = {str(e.qa_pairs[0].question_id): e.qa_pairs[0] for e in examples}
        rows = [json.loads(line) for line in args.answers.read_text(encoding="utf-8").split("\n") if line.strip()]
        write_jsonl(args.out, [judge_line(r["item_id"], by_id[r["question_id"]], r["answer"]) for r in rows])
        return 0
    return asyncio.run(freeze(args) if args.command == "freeze" else parity(args))


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    sys.exit(main())
