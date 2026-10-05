"""Drive a running shim through protocol v1 (eval/systems/PROTOCOL.md) and print one PASS/FAIL line per check.

Stdlib only; works against any shim. Checks: health, capability record shape and both policies, error shapes,
reset, ingest of two dated sessions, a canary session in a second namespace, finish, retrieval item shape and
provenance, dated probes that must return the right session, namespace isolation with a witness that the canary is
retrievable where it was written, delete_source with a survivor check, and reset emptying the namespace. With
`--questions N` it also asks up to N LoCoMo-style questions and records the returned evidence (metered smokes use
this). Systems that extract facts with an LLM make provider calls during ingest.

Usage: python3 eval/systems/_shim/protocol_check.py [--url http://127.0.0.1:8700] [--json report.json]
                                                     [--finish-timeout 600] [--questions 3] [--timeout 900]
Exit status is 0 only when every check passes.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from typing import Any

CANARY = "cnry" + "zqvmlwtx"
ITEM_KEYS = {"id", "rank", "type", "text", "source_ids", "valid_from", "valid_to", "provenance_status"}
CAP_KEYS = ["system", "protocol", "versions", "configs", "time", "provenance", "delete", "readiness", "namespace",
            "parallel_namespaces", "retrieval_policies", "streaming", "telemetry_off", "agent_surface", "deviations_from_vendor_code"]


def opaque(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(8)}"


def fixtures() -> tuple[list[dict[str, Any]], dict[str, Any], list[tuple[str, str, str]]]:
    p1, p2, c1 = opaque("src"), opaque("src"), opaque("src")
    sessions = [
        {"source_id": p1, "event_time": "2023-05-08T13:56:00Z", "turns": [
            {"role": "user", "speaker": "Caroline", "content": "I signed up for a pottery class at the community studio in Portland."},
            {"role": "assistant", "speaker": "Melanie", "content": "That's lovely! What are you making first?"},
            {"role": "user", "speaker": "Caroline", "content": "A blue glazed bowl for my grandmother's birthday."}]},
        {"source_id": p2, "event_time": "2023-06-20T09:10:00Z", "turns": [
            {"role": "user", "speaker": "Caroline", "content": "We just got back from a camping trip at Yosemite with my brother."},
            {"role": "assistant", "speaker": "Melanie", "content": "Did you hike Half Dome?"},
            {"role": "user", "speaker": "Caroline", "content": "Yes, and we saw a black bear near the campsite."}]},
    ]
    canary = {"source_id": c1, "event_time": "2023-05-09T10:00:00Z", "turns": [
        {"role": "user", "speaker": "Dana", "content": f"My locker code word is {CANARY} and I keep it in the gym near Elm Street."},
        {"role": "assistant", "speaker": "Eli", "content": f"Got it, your locker code word is {CANARY}."}]}
    questions = [("Where does Caroline take her pottery class?", p1, "portland"),
                 ("What did Caroline make in her pottery class?", p1, "bowl"),
                 ("What animal did Caroline see while camping?", p2, "bear")]
    return sessions, canary, questions


def call(base: str, method: str, path: str, body: Any = None, timeout: float = 900, raw: bytes | None = None) -> tuple[int, dict[str, Any]]:
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except json.JSONDecodeError:
            return e.code, {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8700")
    ap.add_argument("--json", help="write the results and the full transcript here")
    ap.add_argument("--finish-timeout", type=float, default=600)
    ap.add_argument("--questions", type=int, default=0)
    ap.add_argument("--timeout", type=float, default=900)
    a = ap.parse_args()
    base = a.url.rstrip("/")
    sessions, canary, questions = fixtures()
    ns_a, ns_b = opaque("ns"), opaque("ns")
    results: list[dict[str, Any]] = []
    log: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []

    def go(method: str, path: str, body: Any = None, raw: bytes | None = None) -> tuple[int, dict[str, Any]]:
        t = time.perf_counter()
        status, out = call(base, method, path, body, a.timeout, raw)
        log.append({"method": method, "path": path, "body": body, "status": status, "response": out, "wall_ms": round((time.perf_counter() - t) * 1000)})
        return status, out

    def check(name: str, ok: Any, detail: str = "") -> bool:
        results.append({"check": name, "pass": bool(ok), "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}", flush=True)
        return bool(ok)

    def retrieve(ns: str, q: str, mode: str = "vendor-default") -> tuple[int, dict[str, Any]]:
        return go("POST", "/retrieve", {"ns": ns, "question": q, "query_time": "2023-07-01T00:00:00Z", "policy": {"name": f"{mode}-v1", "mode": mode, "settings": {}}})

    s, h = go("GET", "/health")
    check("health ok", s == 200 and h.get("ok") is True, json.dumps(h)[:200])
    s, cap = go("GET", "/capabilities")
    check("capability record has every protocol field", s == 200 and all(k in cap for k in CAP_KEYS) and cap.get("protocol") == 1,
          f"missing={[k for k in CAP_KEYS if k not in cap]}")
    check("capability record has both policies", set(cap.get("retrieval_policies", {})) >= {"vendor-default", "fixed-evidence"})
    prov_unavailable = cap.get("provenance", {}).get("status") == "unavailable"

    s, out = go("POST", "/retrieve", {"ns": ns_a})
    check("missing fields -> 400 invalid_request", s == 400 and out.get("error", {}).get("kind") == "invalid_request")
    s, out = go("POST", "/ingest", {"ns": ns_a, "session": {"source_id": "raw-id", "event_time": None, "turns": []}})
    check("non-opaque source id -> 400 invalid_request", s == 400 and out.get("error", {}).get("kind") == "invalid_request")
    s, out = go("GET", "/nope")
    check("unknown route -> 404 invalid_request", s == 404 and out.get("error", {}).get("kind") == "invalid_request")
    s, out = go("POST", "/reset", raw=b"{nope")
    check("non-JSON body -> 400 invalid_request", s == 400 and out.get("error", {}).get("kind") == "invalid_request")

    for ns in (ns_a, ns_b):
        s, out = go("POST", "/reset", {"ns": ns})
        check("reset", s == 200 and out.get("ok") is True, json.dumps(out)[:200])
    for sess in sessions:
        s, out = go("POST", "/ingest", {"ns": ns_a, "session": sess})
        check("ingest dated session", s == 200 and out.get("completeness") in ("known", "unknown", "degraded") and isinstance(out.get("errors"), list) and not out["errors"],
              json.dumps(out)[:300])
    s, out = go("POST", "/ingest", {"ns": ns_b, "session": canary})
    check("ingest canary into second namespace", s == 200 and not out.get("errors"), json.dumps(out)[:300])
    for ns in (ns_a, ns_b):
        s, out = go("POST", "/finish", {"ns": ns, "timeout_s": a.finish_timeout})
        check("finish", s == 200 and out.get("ready") is True and out.get("completeness") in ("known", "unknown", "degraded"), json.dumps(out)[:300])

    valid = {x["source_id"] for x in sessions}
    p1, p2 = sessions[0]["source_id"], sessions[1]["source_id"]
    s, out = retrieve(ns_a, "When did Caroline go camping at Yosemite?")
    items = out.get("items", [])
    check("retrieve returns items with service_ms and applied_settings", s == 200 and items and "service_ms" in out and isinstance(out.get("applied_settings"), dict), f"n={len(items)}")
    check("items have protocol shape and ranks 1..n", all(ITEM_KEYS <= set(i) for i in items) and [i["rank"] for i in items] == list(range(1, len(items) + 1)))
    check("source_ids are ids this namespace ingested", all(set(i["source_ids"]) <= valid for i in items), str([i["source_ids"] for i in items])[:300])
    check("unavailable provenance carries no source ids", all(i["source_ids"] == [] for i in items if i["provenance_status"] == "unavailable"))
    top = next((i["source_ids"] for i in items if i["source_ids"]), [])
    if prov_unavailable:
        check("dated probe (camping) returns the camping text", any("Yosemite" in i["text"] for i in items[:3]), "provenance unavailable; checked text")
    else:
        check("dated probe (camping) ranks the camping session first", top[:1] == [p2], f"top={top}")
    s, out = retrieve(ns_a, "What did Caroline sign up for in May 2023?")
    items = out.get("items", [])
    top = next((i["source_ids"] for i in items if i["source_ids"]), [])
    if not prov_unavailable:
        check("dated probe (pottery) ranks the pottery session first", top[:1] == [p1], f"top={top}")
    check("pottery evidence text returned", any("pottery" in i["text"].lower() for i in items[:3]))

    s, out = retrieve(ns_a, f"What is the locker code word {CANARY}?", "fixed-evidence")
    check("canary never returns from another namespace", s == 200 and not any(CANARY in i["text"] or canary["source_id"] in i["source_ids"] for i in out.get("items", [])))
    s, out = retrieve(ns_b, "What is Dana's locker code word?", "fixed-evidence")
    check("canary witness: retrievable in its own namespace", s == 200 and any(CANARY in i["text"] for i in out.get("items", [])), f"n={len(out.get('items', []))}")

    for q, src, word in questions[: max(0, a.questions)]:
        s, out = retrieve(ns_a, q)
        its = out.get("items", [])
        evidence.append({"question": q, "expected_source": src, "items": its, "applied_settings": out.get("applied_settings"), "service_ms": out.get("service_ms")})
        hit = any(word in i["text"].lower() for i in its) or any(src in i["source_ids"] for i in its)
        check(f"question returns its evidence: {q}", s == 200 and hit, f"n={len(its)}")

    s, out = go("POST", "/delete_source", {"ns": ns_a, "source_id": p2})
    check("delete_source answers with a status", s == 200 and out.get("status") in ("deleted", "partial", "unsupported"), json.dumps(out)[:300])
    if cap.get("delete") == "unsupported":
        check("delete status matches the capability record", out.get("status") == "unsupported")
    elif out.get("status") != "unsupported":
        go("POST", "/finish", {"ns": ns_a, "timeout_s": a.finish_timeout})
        s, out = retrieve(ns_a, "When did Caroline go camping at Yosemite?", "fixed-evidence")
        its = out.get("items", [])
        check("deleted source no longer cited", not any(p2 in i["source_ids"] for i in its), str([i["source_ids"] for i in its])[:300])
        check("deleted fact no longer in text", not any("Yosemite" in i["text"] or "bear" in i["text"] for i in its))
        check("unrelated source survives delete", any("pottery" in i["text"].lower() for i in retrieve(ns_a, "pottery class")[1].get("items", [])))

    s, out = retrieve(ns_a, "x", "no-such-mode")
    check("bad policy -> 400 invalid_request", s == 400 and out.get("error", {}).get("kind") == "invalid_request", json.dumps(out)[:200])

    for ns in (ns_a, ns_b):
        go("POST", "/reset", {"ns": ns})
    s, out = retrieve(ns_b, "What is Dana's locker code word?", "fixed-evidence")
    check("reset empties the namespace", s == 200 and not out.get("items"), f"n={len(out.get('items', []))}")

    failed = [r for r in results if not r["pass"]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"url": base, "system": cap.get("system"), "results": results, "evidence": evidence, "transcript": log}, f, indent=1)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
