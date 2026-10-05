"""Audited cell runner over the pinned harness's datasets, modes and judges.

  python -m mpw.cell resolve --spec <spec.json>     (free) schedule, manifest hashes, token stats, revisions
  python -m mpw.cell run --cell-dir <dir>           run or continue the cell's stages

The launcher (eval/runner/harness-cell.ts) owns the cell id, the budget run,
the metering proxy and the environment; this module never chooses a model,
reads a key or a `.env` file.

Stages, each with one receipt per unit or question (mpw/records.py):
  ingest    per isolation unit: provider ingest plus its completion barrier
  retrieve  per question (rag and retrieval modes)
  answer    per question: the harness's own prompt builder and answer model,
            called even when the context is empty; the final prompt's inserted
            context is recovered, counted with cl100k_base and leak-checked
            before the model call
  judge     per question through mpw.scorer (strict fields, typed outcomes)

Continuing a cell reuses only receipts written under the same cell id and
never re-runs a question that already has an answer receipt, failed or not.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import signal
import sys
import time
import traceback
from dataclasses import asdict
from pathlib import Path

from . import capture, context as ctxmod, leakage, register, timestamps
from .projection import Projection
from .records import (
    ANSWER_FAILURE, ANSWERED, INCOMPLETE_INGEST, RETRIEVAL_FAILURE,
    AnswerRecord, IngestRecord, RetrieveRecord, read_record, write_record,
)

MPW_DIR = Path(__file__).resolve().parent
MODES = ("rag", "agentic-rag", "agent", "retrieval")


def _sha(*parts: bytes | str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else p.encode())
        h.update(b"\0")
    return h.hexdigest()


def _file_sha(paths: list[Path]) -> str:
    return _sha(*[p.read_bytes() for p in paths])


def _harness_file(rel: str) -> Path:
    import memory_bench

    return Path(memory_bench.__file__).resolve().parent / rel


def revisions(dataset: str) -> dict[str, str]:
    wrapper = sorted(p for p in MPW_DIR.glob("*.py"))
    prompt_files = [_harness_file(f"dataset/{dataset}.py") if dataset != "fixture" else MPW_DIR / "fixture.py",
                    _harness_file("dataset/base.py"), _harness_file("modes/rag.py"),
                    MPW_DIR / "context.py", MPW_DIR / "cell.py"]
    scorer_files = [p for p in (MPW_DIR / "scorer.py", MPW_DIR / "records.py", _harness_file("judge.py")) if p.exists()]
    return {
        "prompt_revision": _file_sha(prompt_files),
        "scorer_revision": _file_sha(scorer_files + [prompt_files[0]]),
        "wrapper_revision": _file_sha(wrapper),
    }


def get_dataset(name: str):
    if name == "fixture":
        from .fixture import FixtureDataset

        return FixtureDataset()
    from memory_bench.dataset import get_dataset as harness_get

    return harness_get(name)


def select_queries(dataset, split: str, spec: dict):
    sel = spec.get("questions") or {}
    queries = dataset.load_queries(split)
    if "ids" in sel:
        wanted = list(sel["ids"])
        by_id = {q.id: q for q in queries}
        missing = [i for i in wanted if i not in by_id]
        if missing:
            raise ValueError(f"{len(missing)} scheduled question ids are not in {spec['dataset']}/{split}: {missing[:3]}")
        queries = [by_id[i] for i in wanted]
    if "units" in sel:
        units = {str(u) for u in sel["units"]}
        queries = [q for q in queries if str(q.user_id) in units]
    if sel.get("per_unit"):
        seen: dict[str, int] = {}
        kept = []
        for q in queries:
            n = seen.get(str(q.user_id), 0)
            if n < int(sel["per_unit"]):
                kept.append(q)
            seen[str(q.user_id)] = n + 1
        queries = kept
    if sel.get("limit"):
        queries = queries[: int(sel["limit"])]
    if not queries:
        raise ValueError("the question selection is empty")
    return queries


def load_documents(dataset, split: str, queries) -> list:
    units = {q.user_id for q in queries if q.user_id is not None}
    if units:
        docs = dataset.load_documents(split, user_ids=units)
    else:
        docs = dataset.load_documents(split)
    return docs


def unit_of(dataset, doc) -> str | None:
    uid = dataset.get_isolation_id(doc) if dataset.isolation_unit is not None else doc.user_id
    return None if uid is None else str(uid)


def resolve(spec: dict) -> dict:
    """Everything the cell id depends on that only the harness can compute. Free: no model calls."""
    register.install()
    # Constructing the dataset's judge client (BEAM builds one) needs a key in env; no request is made.
    os.environ.setdefault("GEMINI_API_KEY", "mpw-resolve-no-network")
    dataset = get_dataset(spec["dataset"])
    split = spec["split"]
    if spec["mode"] not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    queries = select_queries(dataset, split, spec)
    docs = load_documents(dataset, split, queries)
    h = hashlib.sha256()
    for q in queries:
        h.update(json.dumps({"id": q.id, "query": q.query, "gold": q.gold_answers, "gold_ids": q.gold_ids,
                             "user": q.user_id, "meta": q.meta}, sort_keys=True, default=str).encode())
    doc_tokens: dict[str, int] = {}
    provenance: dict[str, int] = {}
    for d in sorted(docs, key=lambda d: d.id):
        h.update(json.dumps({"id": d.id, "user": d.user_id, "ts": d.timestamp,
                             "content": hashlib.sha256((d.content or "").encode()).hexdigest()}, sort_keys=True).encode())
        unit = unit_of(dataset, d) or "_"
        doc_tokens[unit] = doc_tokens.get(unit, 0) + ctxmod.count_tokens(d.content or "")
        kind = timestamps.classify(spec["dataset"], d.timestamp)
        provenance[kind] = provenance.get(kind, 0) + 1
    schedule = [q.id for q in queries]
    import memory_bench

    if dataset.task_type != "open":
        judge_calls = 0
    elif hasattr(dataset, "score_result"):
        judge_calls = sum(max(1, len(q.meta.get("rubric") or [])) for q in queries)
    else:
        judge_calls = len(queries)

    return {
        "dataset": spec["dataset"],
        "split": split,
        "task_type": dataset.task_type,
        "isolation_unit": dataset.isolation_unit,
        "schedule": schedule,
        "schedule_sha256": _sha(*schedule),
        "dataset_manifest_sha256": h.hexdigest(),
        "questions": len(queries),
        "units": sorted({str(q.user_id) for q in queries if q.user_id is not None}),
        "documents": len(docs),
        "document_tokens_cl100k": sum(doc_tokens.values()),
        "document_tokens_by_unit": doc_tokens,
        "timestamp_provenance": {"rule": timestamps.RULES.get(spec["dataset"]), "counts": provenance},
        "dataset_judge_model": (dataset.default_judge_llm().model_id if dataset.default_judge_llm() is not None else None)
        if dataset.task_type == "open" else None,
        "judge_calls": judge_calls,
        **revisions(spec["dataset"]),
    }


# ─── run ──────────────────────────────────────────────────────────────


class CellError(RuntimeError):
    pass


def _render_rag_context(docs) -> str:
    """Exactly RAGMode.async_answer's rendering at the pin."""
    return "\n\n".join(f"## Memory {i + 1}\n{doc.content}" for i, doc in enumerate(docs))


def _doc_dict(d) -> dict:
    return {k: v for k, v in asdict(d).items() if v is not None}


def _provider(spec: dict):
    import memory_bench.memory as memory_pkg

    cls = memory_pkg.REGISTRY[spec["provider"]]
    config = spec.get("provider_config") or {}
    try:
        return cls(config=config)
    except TypeError:
        return cls()


class CellRun:
    def __init__(self, cell_dir: Path):
        self.dir = cell_dir
        self.cell = json.loads((cell_dir / "cell.json").read_text())
        self.cell_id = self.cell["cell_id"]
        self.spec = self.cell["spec"]
        self.resolved = self.cell["resolved"]
        self.log_path = os.environ.get("MPW_PROXY_LOG")
        self.bodies_dir = os.environ.get("MPW_PROXY_BODIES")
        self.events = (cell_dir / "events.jsonl").open("a")

    def event(self, **row) -> None:
        row["ts"] = time.time()
        self.events.write(json.dumps(row, default=str) + "\n")
        self.events.flush()

    def exhausted(self) -> bool:
        flag = os.environ.get("MPW_PROXY_EXHAUSTED_FLAG")
        return bool(flag) and Path(flag).exists()

    # The harness and the providers are imported only after install() so .env is never read.
    def setup(self) -> None:
        register.install()
        capture.install_http_tagging()
        models = self.spec["models"]
        self.task_type = self.resolved["task_type"]
        needs_judge = self.task_type == "open"
        needs_answer = self.spec["mode"] != "retrieval"
        if needs_answer:
            register.assert_models(models["answer"], models.get("judge") if needs_judge else None)
        self.dataset = get_dataset(self.spec["dataset"])
        self.split = self.spec["split"]
        queries = select_queries(self.dataset, self.split, self.spec)
        if [q.id for q in queries] != self.resolved["schedule"]:
            raise CellError("the dataset's question schedule changed since this cell was planned; plan a new cell")
        fresh = resolve(self.spec)
        for key in ("dataset_manifest_sha256", "schedule_sha256", "prompt_revision", "scorer_revision", "wrapper_revision"):
            if fresh[key] != self.resolved[key]:
                raise CellError(f"{key} changed since this cell was planned ({self.resolved[key][:12]} -> {fresh[key][:12]}); plan a new cell instead of resuming")
        self.queries = queries
        docs = load_documents(self.dataset, self.split, queries)
        self.projection = Projection.for_split(self.spec["dataset"], self.split)
        self.raw_by_unit: dict[str, list] = {}
        self.pdocs_by_unit: dict[str, list] = {}
        for d in docs:
            unit = unit_of(self.dataset, d) or "_all"
            pd = self.projection.document(d, extra_ids=(unit,) if unit != "_all" else ())
            self.raw_by_unit.setdefault(unit, []).append(d)
            self.pdocs_by_unit.setdefault(unit, []).append(pd)
        self.pqueries = {q.id: self.projection.query(q) for q in queries}
        self.forbidden_all = set(self.projection.doc_ids.values()) | set(self.projection.unit_ids.values()) \
            | set(self.projection.query_ids.values()) | {g for q in queries for g in q.gold_ids}
        for unit, pdocs in self.pdocs_by_unit.items():
            forbidden = {d.id for d in self.raw_by_unit[unit]} | ({unit} if unit != "_all" else set())
            for pd in pdocs:
                blob = json.dumps(_doc_dict(pd), ensure_ascii=False)
                report = leakage.check(blob, forbidden)
                if not report.ok:
                    raise leakage.LeakError(f"projected document {pd.id} still carries {report.hits[:3]}")
        (self.dir / "scorer").mkdir(exist_ok=True)
        (self.dir / "scorer" / "reverse-maps.json").write_text(json.dumps(self.projection.reverse_maps(), indent=1))
        manifest = {pd_id: prov for pd_id, prov in self.projection.provenance.items()}
        (self.dir / "timestamp-manifest.json").write_text(json.dumps({
            "dataset": self.spec["dataset"], "rule": timestamps.RULES[self.spec["dataset"]],
            "documents": manifest}, indent=1, sort_keys=True))
        self.provider = _provider(self.spec)
        self.mode = self._mode()

    def _mode(self):
        if self.spec["mode"] == "retrieval":
            from memory_bench.modes.retrieval import RetrievalMode

            self.answer_llm = None
            return RetrievalMode()
        from memory_bench.llm import get_answer_llm
        import memory_bench.modes as modes_pkg

        self.answer_llm = capture.CapturingLLM(get_answer_llm())
        self.answer_llm.pre_dispatch = self._leak_guard
        if self.spec["mode"] == "agent":
            return modes_pkg.REGISTRY["agent"]()
        return modes_pkg.get_mode(self.spec["mode"], llm=self.answer_llm)

    def _leak_guard(self, prompt: str) -> None:
        cap = capture.current()
        forbidden = getattr(cap, "forbidden", None) or self.forbidden_all
        leakage.require_clean(prompt, forbidden, f"the answer prompt for {cap.tag if cap else '?'}")

    def _judge_llm(self):
        if self.task_type != "open":
            return None
        llm = self.dataset.default_judge_llm()
        if llm is None:
            from memory_bench.llm import get_judge_llm

            llm = get_judge_llm()
        return capture.CapturingLLM(llm)

    async def run(self) -> dict:
        self.setup()
        prov = self.provider
        prov.initialize()
        store = self.dir / "store"
        units = sorted(self.pdocs_by_unit)
        unit_ids = {self.projection.unit_id(u) for u in units if u != "_all"} or None
        resuming = any((self.dir / "stages" / "ingest").glob("*.json"))
        prov.prepare(store, unit_ids=unit_ids, reset=not resuming)
        queries_by_unit: dict[str, list] = {}
        for q in self.queries:
            queries_by_unit.setdefault(str(q.user_id) if q.user_id is not None else "_all", []).append(q)
        try:
            for unit in units:
                if unit not in queries_by_unit:
                    continue
                ok = await self._ingest(unit)
                await self._questions(unit, queries_by_unit[unit], ingest_ok=ok)
                if self.exhausted():
                    self.event(kind="budget_exhausted", unit=unit)
                    break
        finally:
            prov.cleanup()
        return self.finalize()

    async def _ingest(self, unit: str) -> bool:
        prior = read_record(self.dir, "ingest", unit, self.cell_id)
        if prior is not None:
            if not prior["ok"]:
                return False
            return True
        reset_unit = getattr(self.provider, "reset_unit", None)
        punit = self.projection.unit_id(unit) if unit != "_all" else None
        if reset_unit is not None and punit is not None:
            await asyncio.to_thread(reset_unit, punit)
        t0 = time.perf_counter()
        try:
            with capture.question_scope(f"{self.cell_id}/ingest/{punit or 'all'}"):
                await self.provider.async_ingest(self.pdocs_by_unit[unit])
            ms = (time.perf_counter() - t0) * 1000
            receipt = getattr(self.provider, "last_ingest_receipt", None)
            receipt = receipt(punit) if callable(receipt) else {}
            rec = IngestRecord(self.cell_id, unit, True, len(self.pdocs_by_unit[unit]), round(ms, 1),
                               barrier_ms=float((receipt or {}).get("barrier_ms", 0.0)), provider_receipt=receipt or {})
        except Exception as e:  # noqa: BLE001 - typed into the receipt
            rec = IngestRecord(self.cell_id, unit, False, len(self.pdocs_by_unit[unit]),
                               round((time.perf_counter() - t0) * 1000, 1), error=f"{type(e).__name__}: {e}")
            self.event(kind="ingest_failed", unit=unit, error=rec.error, trace=traceback.format_exc()[-2000:])
        write_record(self.dir, "ingest", unit, rec)
        return rec.ok

    async def _questions(self, unit: str, queries: list, ingest_ok: bool) -> None:
        sem = asyncio.Semaphore(int(getattr(self.provider, "concurrency", 4) or 1))

        async def one(q):
            async with sem:
                if self.exhausted():
                    return
                await self._question(unit, q, ingest_ok)

        await asyncio.gather(*[one(q) for q in queries])

    async def _question(self, unit: str, q, ingest_ok: bool) -> None:
        if read_record(self.dir, "answer", q.id, self.cell_id) is None:
            rec = await self._answer(unit, q, ingest_ok)
            write_record(self.dir, "answer", q.id, rec)
        answer = read_record(self.dir, "answer", q.id, self.cell_id)
        if read_record(self.dir, "judge", q.id, self.cell_id) is None:
            jr = await self._judge(q, answer)
            if jr is not None:
                write_record(self.dir, "judge", q.id, jr)

    async def _retrieve(self, q, pq) -> RetrieveRecord:
        prior = read_record(self.dir, "retrieve", q.id, self.cell_id)
        if prior is not None:
            return RetrieveRecord(**prior)
        k = int(pq.meta.get("retrieval_limit") or self.spec.get("k") or 10)
        t0 = time.perf_counter()
        try:
            with_meta = getattr(self.provider, "retrieve_with_meta", None)
            if with_meta is not None:
                docs, raw, meta = await asyncio.to_thread(with_meta, pq.query, k, pq.user_id, pq.meta.get("query_timestamp"))
            else:
                docs, raw = await self.provider.async_retrieve(pq.query, k=k, user_id=pq.user_id, query_timestamp=pq.meta.get("query_timestamp"))
                meta = {}
            rec = RetrieveRecord(self.cell_id, q.id, True, round((time.perf_counter() - t0) * 1000, 1),
                                 documents=[_doc_dict(d) for d in docs], raw_response=raw, provider_meta=meta or {})
        except Exception as e:  # noqa: BLE001
            rec = RetrieveRecord(self.cell_id, q.id, False, round((time.perf_counter() - t0) * 1000, 1),
                                 error=f"{type(e).__name__}: {e}")
        write_record(self.dir, "retrieve", q.id, rec)
        return rec

    def _forbidden_for(self, unit: str, q) -> set[str]:
        raw_docs = self.raw_by_unit.get(unit, [])
        ids = {d.id for d in raw_docs} | {q.id} | set(q.gold_ids)
        if unit != "_all":
            ids.add(unit)
        return ids

    async def _answer(self, unit: str, q, ingest_ok: bool) -> AnswerRecord:
        pq = self.pqueries[q.id]
        tag = f"{self.cell_id}/answer/{pq.id}"
        base = dict(cell_id=self.cell_id, query_id=q.id, task_type=self.task_type,
                    answer_model=self.answer_llm.model_id if self.answer_llm else None)
        if not ingest_ok:
            return AnswerRecord(ok=False, outcome=INCOMPLETE_INGEST, error="the unit's ingest did not complete", **base)
        mode = self.spec["mode"]
        from memory_bench.models import Document

        if mode in ("rag", "retrieval"):
            ret = await self._retrieve(q, pq)
            if not ret.ok:
                return AnswerRecord(ok=False, outcome=RETRIEVAL_FAILURE, error=ret.error, **base)
            docs = [Document(**d) for d in ret.documents]
            if mode == "retrieval":
                return AnswerRecord(ok=True, outcome=ANSWERED, answer=f"{len(docs)} memories retrieved",
                                    rendered_context=json.dumps([d.id for d in docs]), inserted_kind="none", **base)
            return await self._answer_rag(q, pq, docs, ret, tag, base, unit)
        return await self._answer_mode(q, pq, tag, base, unit)

    async def _answer_rag(self, q, pq, docs, ret: RetrieveRecord, tag: str, base: dict, unit: str) -> AnswerRecord:
        rendered = _render_rag_context(docs)
        meta = dict(pq.meta)
        task = self.task_type

        def prompt_fn(query, context, meta=None):
            return self.dataset.build_rag_prompt(query, context, task, self.split, None, meta)

        meta["_prompt_fn"] = prompt_fn
        try:
            with capture.question_scope(tag) as cap:
                cap.forbidden = self._forbidden_for(unit, q)
                if task == "mcq":
                    result = await asyncio.to_thread(self.mode._answer_mcq, pq.query, rendered, ret.retrieve_ms, ret.raw_response, prompt_fn, meta)
                else:
                    result = await asyncio.to_thread(self.mode._answer_open, pq.query, rendered, ret.retrieve_ms, ret.raw_response, prompt_fn, meta)
        except leakage.LeakError:
            raise
        except Exception as e:  # noqa: BLE001
            return AnswerRecord(ok=False, outcome=ANSWER_FAILURE, rendered_context=rendered,
                                error=f"{type(e).__name__}: {e}", requests=self._requests(tag), **base)
        prompts = [p for p in cap.prompts if "prompt" in p]
        if len(prompts) != 1:
            raise CellError(f"expected one answer prompt for {q.id}, captured {len(prompts)}")
        final = prompts[0]["prompt"]
        clean_meta = {k: v for k, v in meta.items() if k != "_prompt_fn"}
        ins = ctxmod.inserted_context(lambda qq, cc, meta: prompt_fn(qq, cc, meta=meta), pq.query, rendered,
                                      clean_meta, ret.raw_response, final)
        return AnswerRecord(
            ok=True, outcome=ANSWERED, answer=result.answer, reasoning=result.reasoning,
            rendered_context=rendered, inserted_context=ins.text, inserted_kind=ins.kind,
            inserted_tokens_cl100k=ins.tokens, final_prompt=final,
            final_prompt_sha256=hashlib.sha256(final.encode()).hexdigest(),
            requests=self._requests(tag, expected=1), leak_check={"ok": True, "checked": "pre-dispatch"}, **base)

    async def _answer_mode(self, q, pq, tag: str, base: dict, unit: str) -> AnswerRecord:
        meta = dict(pq.meta)
        try:
            with capture.question_scope(tag) as cap:
                cap.forbidden = self._forbidden_for(unit, q)
                result = await self.mode.async_answer(pq.query, self.provider, task_type=self.task_type, user_id=pq.user_id, meta=meta)
        except leakage.LeakError:
            raise
        except Exception as e:  # noqa: BLE001
            return AnswerRecord(ok=False, outcome=ANSWER_FAILURE, error=f"{type(e).__name__}: {e}", requests=self._requests(tag), **base)
        prompts = [p for p in cap.prompts if "prompt" in p]
        final = prompts[-1]["prompt"] if prompts else ""
        if final:
            leakage.require_clean(final, self._forbidden_for(unit, q), f"the final prompt for {q.id}")
        tool_calls = sum(p.get("tool_calls", 0) for p in cap.prompts)
        ctx_text = result.context or ""
        return AnswerRecord(
            ok=True, outcome=ANSWERED, answer=result.answer, reasoning=result.reasoning,
            rendered_context=ctx_text, inserted_context=ctx_text, inserted_kind="rendered",
            inserted_tokens_cl100k=ctxmod.count_tokens(ctx_text), final_prompt=final,
            final_prompt_sha256=hashlib.sha256(final.encode()).hexdigest() if final else "",
            requests=self._requests(tag), tool_calls=tool_calls,
            leak_check={"ok": True, "checked": "final prompt" if final else "no answer prompt (provider answered)"}, **base)

    def _requests(self, tag: str, expected: int | None = None) -> list[dict]:
        return capture.proxy_requests(self.log_path, tag, self.bodies_dir, wait_s=10.0 if expected else 2.0, expected=expected)

    async def _judge(self, q, answer: dict):
        from . import scorer

        tag = f"{self.cell_id}/judge/{self.pqueries[q.id].id}"
        retrieved_original = None
        if self.task_type == "retrieval" and answer.get("ok"):
            from memory_bench.models import Document

            ret = read_record(self.dir, "retrieve", q.id, self.cell_id) or {}
            retrieved_original = []
            for d in ret.get("documents", []):
                d = dict(d)
                d["id"] = self.projection.original_doc(d["id"]) or d["id"]
                if d.get("source_ids"):
                    d["source_ids"] = [self.projection.original_doc(s) or s for s in d["source_ids"]]
                retrieved_original.append(Document(**d))
        judge_llm = self._judge_llm()
        expected = self.spec["models"].get("judge") if self.task_type == "open" else None
        if self.task_type == "open" and self.resolved.get("dataset_judge_model"):
            expected = self.resolved["dataset_judge_model"]
        with capture.question_scope(tag):
            rec = await asyncio.to_thread(
                scorer.judge_answer, dataset=self.dataset, split=self.split, query=q, answer=answer,
                judge_llm=judge_llm, expected_judge_model=expected, cell_id=self.cell_id,
                retrieved_original=retrieved_original)
        rec.requests = self._requests(tag)
        return rec

    def finalize(self) -> dict:
        from . import scorer

        schedule = self.resolved["schedule"]
        judged = {qid: r for qid in schedule if (r := read_record(self.dir, "judge", qid, self.cell_id)) is not None}
        answers = {qid: r for qid in schedule if (r := read_record(self.dir, "answer", qid, self.cell_id)) is not None}
        score = scorer.aggregate(schedule, judged)
        tokens = [a["inserted_tokens_cl100k"] for a in answers.values() if a["ok"] and a["inserted_kind"] != "none"]
        gate = ctxmod.gate(self.spec.get("target_tokens"), tokens)
        clamps = []
        for qid in schedule:
            r = read_record(self.dir, "retrieve", qid, self.cell_id)
            if r and r.get("provider_meta", {}).get("budget_clamped"):
                clamps.append(qid)
        inserted_kinds: dict[str, int] = {}
        for a in answers.values():
            inserted_kinds[a["inserted_kind"]] = inserted_kinds.get(a["inserted_kind"], 0) + 1
        summary = {
            "cell_id": self.cell_id,
            "scheduled": len(schedule),
            "answered_receipts": len(answers),
            "judged_receipts": len(judged),
            "score": score,
            "delivered_context": {**gate.as_dict(), "inserted_kinds": inserted_kinds, "tokenizer": "cl100k_base"},
            "remote_budget_clamp": {"fired": bool(clamps), "questions": clamps},
            "leak_check": {"checked_prompts": sum(1 for a in answers.values() if a.get("leak_check", {}).get("ok")),
                           "policy": "pre-dispatch identifier check on every answer prompt"},
            "timestamp_provenance": self.resolved.get("timestamp_provenance"),
        }
        summary["gates"] = {
            "complete": bool(score.get("complete")),
            "delivered_context": gate.ok,
            "no_remote_clamp": not clamps,
        }
        summary["ok"] = all(summary["gates"].values())
        (self.dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m mpw.cell")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve")
    r.add_argument("--spec", required=True)
    rr = sub.add_parser("run")
    rr.add_argument("--cell-dir", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "resolve":
        spec = json.loads(Path(args.spec).read_text())
        print(json.dumps(resolve(spec)))
        return 0
    def _terminate(signum, _frame):
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, _terminate)
    run = CellRun(Path(args.cell_dir))
    summary = asyncio.run(run.run())
    print(json.dumps({"cell_id": summary["cell_id"], "ok": summary["ok"], "gates": summary["gates"],
                      "score": summary["score"]}, default=str))
    return 0 if summary["ok"] else 3


if __name__ == "__main__":
    sys.exit(main())
