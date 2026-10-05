"""Drive a running shim through protocol v1 and print one PASS/FAIL line per check (stdlib only).

Checks: health, capability record shape, reset, ingest of two dated sessions, finish, a dated probe that must return
the right session, namespace isolation with a canary (and a witness that the canary is retrievable where it was
written), delete_source, error shapes, and reset emptying the namespace.

Usage: python3 protocol_check.py [--url http://127.0.0.1:8700] [--json report.json]
Works against any shim. Systems that extract facts with an LLM make provider calls during ingest.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

CANARY = "cnry" + "zqvmlwtx"
SESSIONS = [
    {"source_id": "src-p1", "event_time": "2023-05-08T13:56:00Z", "turns": [
        {"role": "user", "speaker": "Caroline", "content": "I signed up for a pottery class at the community studio downtown."},
        {"role": "assistant", "speaker": "Melanie", "content": "That's lovely! What are you making first?"},
        {"role": "user", "speaker": "Caroline", "content": "A blue glazed bowl for my grandmother's birthday."}]},
    {"source_id": "src-p2", "event_time": "2023-06-20T09:10:00Z", "turns": [
        {"role": "user", "speaker": "Caroline", "content": "We just got back from a camping trip at Yosemite with my brother."},
        {"role": "assistant", "speaker": "Melanie", "content": "Did you hike Half Dome?"},
        {"role": "user", "speaker": "Caroline", "content": "Yes, and we saw a black bear near the campsite."}]},
]
CANARY_SESSION = {"source_id": "src-c1", "event_time": "2023-05-09T10:00:00Z", "turns": [
    {"role": "user", "speaker": "Dana", "content": f"My locker code word is {CANARY} and I keep it in the gym near Elm Street."},
    {"role": "assistant", "speaker": "Eli", "content": f"Got it, your locker code word is {CANARY}."}]}


def call(base: str, method: str, path: str, body: dict | None = None, timeout: float = 900) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8700")
    ap.add_argument("--json", help="write the full transcript here")
    ap.add_argument("--finish-timeout", type=float, default=600)
    a = ap.parse_args()
    base = a.url.rstrip("/")
    run = uuid.uuid4().hex[:10]
    ns_a, ns_b = f"ns-a{run}", f"ns-b{run}"
    results: list[tuple[str, bool, str]] = []
    log: list[dict] = []

    def go(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        t = time.perf_counter()
        status, out = call(base, method, path, body)
        log.append({"method": method, "path": path, "body": body, "status": status, "response": out,
                    "wall_ms": round((time.perf_counter() - t) * 1000)})
        return status, out

    def check(name: str, ok: bool, detail: str = "") -> bool:
        results.append((name, bool(ok), detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}{'  ' + detail if detail else ''}", flush=True)
        return bool(ok)

    def retrieve(ns: str, q: str, mode: str = "vendor-default") -> tuple[int, dict]:
        return go("POST", "/retrieve", {"ns": ns, "question": q, "query_time": "2023-07-01T00:00:00Z",
                                       "policy": {"name": f"{mode}-v1", "mode": mode, "settings": {}}})

    s, h = go("GET", "/health")
    check("health ok", s == 200 and h.get("ok") is True, json.dumps(h))
    s, cap = go("GET", "/capabilities")
    need = ["system", "protocol", "versions", "configs", "time", "provenance", "delete", "readiness", "namespace",
            "parallel_namespaces", "retrieval_policies", "streaming", "telemetry_off", "agent_surface",
            "deviations_from_vendor_code"]
    check("capability record has every protocol field", s == 200 and all(k in cap for k in need) and cap.get("protocol") == 1,
          f"missing={[k for k in need if k not in cap]}")
    check("capability record has both policies", set(cap.get("retrieval_policies", {})) >= {"vendor-default", "fixed-evidence"})

    for ns in (ns_a, ns_b):
        s, out = go("POST", "/reset", {"ns": ns})
        check(f"reset {ns[:5]}", s == 200 and out.get("ok") is True, json.dumps(out)[:200])

    for sess in SESSIONS:
        s, out = go("POST", "/ingest", {"ns": ns_a, "session": sess})
        check(f"ingest {sess['source_id']}", s == 200 and out.get("completeness") in ("known", "unknown", "degraded")
              and isinstance(out.get("errors"), list) and not out["errors"], json.dumps(out)[:300])
    s, out = go("POST", "/ingest", {"ns": ns_b, "session": CANARY_SESSION})
    check("ingest canary into second namespace", s == 200 and not out.get("errors"), json.dumps(out)[:300])

    for ns in (ns_a, ns_b):
        s, out = go("POST", "/finish", {"ns": ns, "timeout_s": a.finish_timeout})
        check(f"finish {ns[:5]}", s == 200 and out.get("ready") is True and out.get("completeness") in ("known", "unknown"),
              json.dumps(out)[:300])

    valid = {x["source_id"] for x in SESSIONS}
    s, out = retrieve(ns_a, "When did Caroline go camping at Yosemite?")
    items = out.get("items", [])
    check("retrieve returns items with service_ms and applied_settings", s == 200 and items and "service_ms" in out
          and isinstance(out.get("applied_settings"), dict), f"n={len(items)}")
    shape = all({"id", "rank", "type", "text", "source_ids", "provenance_status"} <= set(i) for i in items)
    check("items have protocol shape and ranks 1..n", shape and [i["rank"] for i in items] == list(range(1, len(items) + 1)))
    check("source_ids are ids this namespace ingested", all(set(i["source_ids"]) <= valid for i in items),
          str([i["source_ids"] for i in items]))
    with_prov = [i for i in items if i["provenance_status"] != "unavailable"]
    top_src = next((i["source_ids"] for i in with_prov if i["source_ids"]), [])
    if cap.get("provenance", {}).get("status") == "unavailable":
        check("dated probe (camping) returns the camping session", any("Yosemite" in i["text"] for i in items[:3]),
              "provenance unavailable; checked text")
    else:
        check("dated probe (camping) ranks the camping session first", top_src == ["src-p2"], f"top={top_src}")
    s, out = retrieve(ns_a, "What did Caroline sign up for in May 2023?")
    items = out.get("items", [])
    top = next((i["source_ids"] for i in items if i["source_ids"]), [])
    if cap.get("provenance", {}).get("status") != "unavailable":
        check("dated probe (pottery) ranks the pottery session first", top == ["src-p1"], f"top={top}")
    check("pottery evidence text returned", any("pottery" in i["text"].lower() for i in items[:3]))

    s, out = retrieve(ns_a, f"What is the locker code word {CANARY}?", "fixed-evidence")
    check("canary never returns from another namespace", s == 200 and not any(CANARY in i["text"] for i in out.get("items", [])))
    s, out = retrieve(ns_b, "What is Dana's locker code word?", "fixed-evidence")
    check("canary witness: retrievable in its own namespace", s == 200 and any(CANARY in i["text"] for i in out.get("items", [])),
          f"n={len(out.get('items', []))}")

    s, out = go("POST", "/delete_source", {"ns": ns_a, "source_id": "src-p2"})
    check("delete_source answers with a status", s == 200 and out.get("status") in ("deleted", "partial", "unsupported"), json.dumps(out)[:300])
    if out.get("status") != "unsupported":
        go("POST", "/finish", {"ns": ns_a, "timeout_s": a.finish_timeout})
        s, out = retrieve(ns_a, "When did Caroline go camping at Yosemite?", "fixed-evidence")
        its = out.get("items", [])
        check("deleted source no longer cited", not any("src-p2" in i["source_ids"] for i in its), str([i["source_ids"] for i in its]))
        check("deleted fact no longer in text", not any("Yosemite" in i["text"] or "bear" in i["text"] for i in its))
        check("unrelated source survives delete", any("pottery" in i["text"].lower() for i in retrieve(ns_a, "pottery class")[1].get("items", [])))

    s, out = retrieve(ns_a, "x", "no-such-mode")
    check("bad policy -> 400 invalid_request", s == 400 and out.get("error", {}).get("kind") == "invalid_request", json.dumps(out)[:200])
    s, out = go("POST", "/ingest", {"ns": ns_a, "session": {"source_id": "raw-id", "event_time": None, "turns": []}})
    check("non-opaque source id -> 400", s == 400 and out.get("error", {}).get("kind") == "invalid_request")
    s, out = go("GET", "/nope")
    check("unknown route -> 404", s == 404 and out.get("error", {}).get("kind") == "invalid_request")

    for ns in (ns_a, ns_b):
        go("POST", "/reset", {"ns": ns})
    s, out = retrieve(ns_b, "What is Dana's locker code word?", "fixed-evidence")
    check("reset empties the namespace", s == 200 and not out.get("items"), f"n={len(out.get('items', []))}")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"url": base, "results": results, "transcript": log}, f, indent=1)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
