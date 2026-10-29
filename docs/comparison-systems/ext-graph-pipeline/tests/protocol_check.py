"""Drive a running shim through protocol v1 (eval/systems/PROTOCOL.md) and report each check. Stdlib only.

Usage: python3 protocol_check.py [--url http://127.0.0.1:8701] [--questions 3] [--out report.json]

Steps: health and capabilities, error shapes, reset, ingest of two dated sessions, a canary session in a second
namespace, finish, retrieve with item validation, namespace isolation both ways, delete of one source, and reset.
With --questions N it also asks N LoCoMo-style questions and records the returned evidence (the metered smoke uses
this). Exit status is 0 only when every check passes.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

NS_A, NS_B = "ns-check-a-7f3c", "ns-check-b-91d2"
SESSIONS = [
    {"source_id": "src-a1", "event_time": "2023-05-08T13:56:00Z", "turns": [
        {"role": "user", "speaker": "Caroline", "content": "Hey Mel! Big news: I adopted a dog last weekend, a golden retriever puppy named Biscuit."},
        {"role": "user", "speaker": "Melanie", "content": "Caroline, that is wonderful! How is Biscuit settling in?"},
        {"role": "user", "speaker": "Caroline", "content": "Biscuit chews every shoe in the house, but my dog is the sweetest."},
        {"role": "user", "speaker": "Melanie", "content": "Ha! Puppies are like that. Send me photos."},
    ]},
    {"source_id": "src-a2", "event_time": "2023-06-19T09:12:00Z", "turns": [
        {"role": "user", "speaker": "Melanie", "content": "I signed up for a pottery class in Portland. The first session was on Saturday."},
        {"role": "user", "speaker": "Caroline", "content": "Pottery sounds relaxing. What did you make in the class?"},
        {"role": "user", "speaker": "Melanie", "content": "A lopsided blue bowl. The pottery teacher said it has character."},
    ]},
]
CANARY = {"source_id": "src-b1", "event_time": "2023-07-01T10:00:00Z", "turns": [
    {"role": "user", "speaker": "Ravi", "content": "The vault passphrase is zephyrine quokka marmalade."},
    {"role": "user", "speaker": "Ana", "content": "Noted: zephyrine quokka marmalade."},
]}
QUESTIONS = [
    ("What is the name of Caroline's dog?", "src-a1", "biscuit"),
    ("Where does Melanie take her pottery class?", "src-a2", "portland"),
    ("What did Melanie make in her pottery class?", "src-a2", "bowl"),
]
ITEM_KEYS = {"id", "rank", "type", "text", "source_ids", "valid_from", "valid_to", "provenance_status"}
CAP_KEYS = {"system", "protocol", "versions", "configs", "time", "provenance", "delete", "readiness", "namespace",
            "parallel_namespaces", "retrieval_policies", "streaming", "telemetry_off", "agent_surface", "deviations_from_vendor_code"}


class Checker:
    def __init__(self, url: str, timeout: float):
        self.url, self.timeout = url.rstrip("/"), timeout
        self.results: list[dict[str, Any]] = []

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, dict[str, Any], float]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method, headers={"Content-Type": "application/json"})
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        return status, json.loads(raw or b"{}"), (time.perf_counter() - start) * 1000

    def check(self, name: str, ok: bool, detail: Any = None) -> bool:
        self.results.append({"check": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + ("" if ok or detail is None else f"  {json.dumps(detail)[:400]}"), flush=True)
        return ok

    def retrieve(self, ns: str, question: str, mode: str = "fixed-evidence") -> tuple[int, dict[str, Any]]:
        status, out, _ = self.call("POST", "/retrieve", {"ns": ns, "question": question, "query_time": "2023-08-01T00:00:00Z",
                                                          "policy": {"name": f"check-{mode}", "mode": mode, "settings": {}}})
        return status, out


def item_problems(items: list[dict[str, Any]], allowed: set[str]) -> list[str]:
    problems = []
    for i, it in enumerate(items):
        if set(it) != ITEM_KEYS:
            problems.append(f"item {i} keys {sorted(it)}")
        if it.get("rank") != i + 1:
            problems.append(f"item {i} rank {it.get('rank')}")
        if not set(it.get("source_ids", [])) <= allowed:
            problems.append(f"item {i} foreign sources {it.get('source_ids')}")
        if it.get("provenance_status") == "unavailable" and it.get("source_ids"):
            problems.append(f"item {i} unavailable with sources")
    return problems


def mentions(items: list[dict[str, Any]], needle: str) -> bool:
    return any(needle in it["text"].lower() for it in items)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8701")
    ap.add_argument("--timeout", type=float, default=900)
    ap.add_argument("--questions", type=int, default=0)
    ap.add_argument("--capabilities-only", action="store_true", help="for shims whose capability record says no passive memory API")
    ap.add_argument("--out")
    args = ap.parse_args()
    c = Checker(args.url, args.timeout)

    status, health, _ = c.call("GET", "/health")
    c.check("health ok", status == 200 and health.get("ok") is True, health)
    status, caps, _ = c.call("GET", "/capabilities")
    c.check("capabilities has every record field", status == 200 and CAP_KEYS <= set(caps), sorted(CAP_KEYS - set(caps)))
    c.check("service_ms on every response", "service_ms" in health and "service_ms" in caps)
    status, out, _ = c.call("POST", "/retrieve", {"ns": NS_A, "question": "x", "policy": {"name": "bad", "mode": "nonsense"}})
    c.check("bad policy is invalid_request", status == 400 and out.get("error", {}).get("kind") == "invalid_request", out)
    status, out, _ = c.call("POST", "/ingest", {"ns": NS_A, "session": {**SESSIONS[0], "source_id": "raw-dataset-id"}})
    c.check("non-opaque source id is invalid_request", status == 400 and out.get("error", {}).get("kind") == "invalid_request", out)

    if args.capabilities_only:
        status, out, _ = c.call("POST", "/ingest", {"ns": NS_A, "session": SESSIONS[0]})
        c.check("ingest reports unsupported", status == 501 and out.get("error", {}).get("kind") == "unsupported", out)
        status, out = c.retrieve(NS_A, "anything")
        c.check("retrieve reports unsupported", status == 501 and out.get("error", {}).get("kind") == "unsupported", out)
        return finish(c, args.out, {"health": health})

    timings: dict[str, float] = {}
    for ns in (NS_A, NS_B):
        status, out, _ = c.call("POST", "/reset", {"ns": ns})
        c.check(f"reset {ns}", status == 200 and out.get("ok") is True, out)
    for ns, session in [(NS_A, SESSIONS[0]), (NS_A, SESSIONS[1]), (NS_B, CANARY)]:
        status, out, ms = c.call("POST", "/ingest", {"ns": ns, "session": session})
        timings[f"ingest {session['source_id']}"] = round(ms)
        c.check(f"ingest {session['source_id']} into {ns}", status == 200 and not out.get("errors") and out.get("completeness") in ("known", "unknown"), out)
    for ns in (NS_A, NS_B):
        status, out, _ = c.call("POST", "/finish", {"ns": ns, "timeout_s": 600})
        c.check(f"finish {ns} ready", status == 200 and out.get("ready") is True, out)

    for mode in ("vendor-default", "fixed-evidence"):
        status, out = c.retrieve(NS_A, QUESTIONS[0][0], mode)
        items = out.get("items", [])
        c.check(f"retrieve {mode} returns items", status == 200 and len(items) > 0, out if status != 200 else len(items))
        c.check(f"retrieve {mode} items are well formed", not item_problems(items, {"src-a1", "src-a2"}), item_problems(items, {"src-a1", "src-a2"}))
        c.check(f"retrieve {mode} reports applied settings", bool(out.get("applied_settings")), out.get("applied_settings"))
    status, out = c.retrieve(NS_A, QUESTIONS[0][0])
    items = out.get("items", [])
    c.check("dated probe returns the right session", any("src-a1" in it["source_ids"] for it in items) and mentions(items, "biscuit"),
            [(it["type"], it["source_ids"], it["text"][:80]) for it in items[:5]])
    c.check("item text carries the session date", mentions(items, "2023-05-08"), None)

    status, out = c.retrieve(NS_A, "What is the vault passphrase?")
    c.check("canary in ns B never returns from ns A", status == 200 and not mentions(out.get("items", []), "zephyrine"),
            [it["text"][:80] for it in out.get("items", []) if "zephyrine" in it["text"].lower()])
    status, out = c.retrieve(NS_B, "What is the vault passphrase?")
    c.check("canary returns from its own ns", status == 200 and mentions(out.get("items", []), "zephyrine"), out.get("items", [])[:3])
    status, out = c.retrieve(NS_B, QUESTIONS[0][0])
    c.check("ns A content never returns from ns B", status == 200 and not mentions(out.get("items", []), "biscuit"), None)

    asked = []
    for question, src, needle in QUESTIONS[: args.questions]:
        status, out = c.retrieve(NS_A, question)
        items = out.get("items", [])
        asked.append({"question": question, "expected_source": src, "status": status,
                      "expected_source_returned": any(src in it["source_ids"] for it in items),
                      "answer_word_in_evidence": mentions(items, needle), "service_ms": out.get("service_ms"),
                      "items": [{k: it[k] for k in ("rank", "type", "source_ids", "provenance_status")} | {"text": it["text"][:200]} for it in items]})
    for a in asked:
        print(f"  Q: {a['question']}  source returned={a['expected_source_returned']} answer word in evidence={a['answer_word_in_evidence']} items={len(a['items'])}")

    status, out, _ = c.call("POST", "/delete_source", {"ns": NS_A, "source_id": "src-a1"})
    c.check("delete_source src-a1", status == 200 and out.get("status") in ("deleted", "partial", "unsupported"), out)
    deleted_status = out.get("status")
    status, out = c.retrieve(NS_A, QUESTIONS[0][0])
    items = out.get("items", [])
    leftovers = [f"{it['type']}: {it['text'][:100]}" for it in items if "biscuit" in it["text"].lower()]
    if deleted_status == "deleted":
        c.check("deleted source no longer cited", status == 200 and not any("src-a1" in it["source_ids"] for it in items), [it["source_ids"] for it in items])
        c.check("deleted session text gone from chunks", not any(it["type"] in ("chunk", "episode", "note") and "biscuit" in it["text"].lower() for it in items), leftovers)
    print(f"  report only: derived items still mentioning the deleted fact: {leftovers}")
    status, out = c.retrieve(NS_A, QUESTIONS[1][0])
    c.check("unrelated source survives the delete", any("src-a2" in it["source_ids"] for it in out.get("items", [])) or mentions(out.get("items", []), "portland"), None)

    for ns in (NS_A, NS_B):
        c.call("POST", "/reset", {"ns": ns})
    status, out = c.retrieve(NS_A, QUESTIONS[1][0])
    c.check("namespace empty after reset", status == 200 and not out.get("items"), out.get("items", [])[:2])
    return finish(c, args.out, {"timings_ms": timings, "questions": asked, "delete_leftovers": leftovers, "health": health})


def finish(c: Checker, path: str | None, extra: dict[str, Any] | None = None) -> int:
    failed = [r for r in c.results if not r["ok"]]
    print(f"{len(c.results) - len(failed)}/{len(c.results)} checks passed")
    if path:
        with open(path, "w") as f:
            json.dump({"url": c.url, "results": c.results, **(extra or {})}, f, indent=2)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
