"""Protocol v1 smoke test for a running shim (stdlib only).

Drives reset, ingest of two dated sessions, finish, retrieve under both policies, a namespace-isolation canary,
delete and the error shapes. Prints one JSON receipt line per step and exits non-zero on the first failure.

    python3 docs/comparison-systems/ext-temporal-graph/test_shim.py --url http://127.0.0.1:8701
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

CANARY = "cnry" + "".join(secrets.choice("bdfghjkmnpqrstvwxz") for _ in range(8))
SESSIONS = [
    {"event_time": "2023-05-08T13:56:00+00:00", "turns": [
        {"role": "user", "speaker": "Caroline", "content": "I went to the LGBTQ support group yesterday and it was really powerful."},
        {"role": "assistant", "speaker": "Melanie", "content": "That sounds wonderful, Caroline. What did you talk about there?"},
        {"role": "user", "speaker": "Caroline", "content": "Mostly about my transition and how the group helped me accept myself."}]},
    {"event_time": "2023-06-20T09:15:00+00:00", "turns": [
        {"role": "user", "speaker": "Melanie", "content": "Last weekend I painted a sunrise over Lake Tahoe with my kids."},
        {"role": "assistant", "speaker": "Caroline", "content": "A sunrise painting with your kids sounds lovely, Melanie."},
        {"role": "user", "speaker": "Melanie", "content": "We hung the Lake Tahoe painting in the living room."}]},
]
CANARY_SESSION = {"event_time": "2023-05-10T10:00:00+00:00", "turns": [
    {"role": "user", "speaker": "Jordan", "content": f"My locker combination is {CANARY}, please remember the locker code {CANARY}."},
    {"role": "assistant", "speaker": "Riley", "content": f"Noted, Jordan: the locker code is {CANARY}."}]}
QUESTION_TIME = "2023-07-01T00:00:00+00:00"


class Fail(Exception):
    pass


def call(base: str, method: str, path: str, body: dict | None = None, timeout: float = 1200) -> tuple[int, dict]:
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def ok(base: str, method: str, path: str, body: dict | None = None) -> dict:
    status, out = call(base, method, path, body)
    if status != 200:
        raise Fail(f"{method} {path} -> {status} {json.dumps(out)[:800]}")
    if "service_ms" not in out:
        raise Fail(f"{method} {path} response lacks service_ms")
    return out


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


def log(step: str, **kw) -> None:
    print(json.dumps({"step": step, **kw}), flush=True)


def check_items(items: list[dict], allowed_sources: set[str]) -> None:
    for i, it in enumerate(items):
        check(set(it) >= {"id", "rank", "type", "text", "source_ids", "valid_from", "valid_to", "provenance_status"}, f"item keys {sorted(it)}")
        check(it["rank"] == i + 1, f"ranks must be 1..n in order, got {it['rank']} at {i}")
        check(it["type"] in {"fact", "episode", "chunk", "note", "entity", "observation"}, f"bad type {it['type']}")
        check(it["provenance_status"] in {"exact", "partial", "unavailable"}, f"bad provenance {it['provenance_status']}")
        check(bool(it["source_ids"]) == (it["provenance_status"] != "unavailable"), f"source_ids vs provenance mismatch: {it}")
        check(set(it["source_ids"]) <= allowed_sources, f"item cites sources outside the namespace: {it['source_ids']}")


def retrieve(base: str, ns: str, question: str, mode: str, settings: dict | None = None) -> dict:
    return ok(base, "POST", "/retrieve", {"ns": ns, "question": question, "query_time": QUESTION_TIME,
                                          "policy": {"name": f"smoke-{mode}", "mode": mode, "settings": settings or {}}})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8700")
    ap.add_argument("--health-timeout", type=float, default=600)
    args = ap.parse_args()
    base = args.url.rstrip("/")
    run = secrets.token_hex(4)
    ns_a, ns_b = f"ns-smoke-a-{run}", f"ns-smoke-b-{run}"
    src = [f"src-{run}-{i}" for i in range(len(SESSIONS))]
    src_canary = f"src-{run}-canary"

    deadline = time.monotonic() + args.health_timeout
    while True:
        try:
            status, health = call(base, "GET", "/health", timeout=10)
            if status == 200 and health.get("ok"):
                break
        except (urllib.error.URLError, ConnectionError, TimeoutError, json.JSONDecodeError):
            health = None
        if time.monotonic() > deadline:
            raise Fail(f"shim not healthy after {args.health_timeout}s: {health}")
        time.sleep(2)
    log("health", **health)

    caps = ok(base, "GET", "/capabilities")
    for key in ("system", "protocol", "versions", "configs", "time", "provenance", "delete", "readiness", "namespace",
                "parallel_namespaces", "retrieval_policies", "streaming", "telemetry_off", "agent_surface", "deviations_from_vendor_code"):
        check(key in caps, f"capability record lacks {key}")
    check(caps["protocol"] == 1, "protocol must be 1")
    check(set(caps["configs"]) >= {"recipe", "common"}, "configs must include recipe and common")
    log("capabilities", system=caps["system"], provenance=caps["provenance"]["status"], delete=caps["delete"])

    for ns in (ns_a, ns_b):
        ok(base, "POST", "/reset", {"ns": ns})
    for sid, s in zip(src, SESSIONS):
        out = ok(base, "POST", "/ingest", {"ns": ns_a, "session": {"source_id": sid, **s}})
        check(out["completeness"] in ("known", "unknown", "degraded"), "bad completeness")
        check(not out["errors"], f"ingest errors: {out['errors']}")
        log("ingest", ns="a", source_id=sid, items_created=out["items_created"], completeness=out["completeness"], service_ms=out["service_ms"])
    out = ok(base, "POST", "/ingest", {"ns": ns_b, "session": {"source_id": src_canary, **CANARY_SESSION}})
    log("ingest", ns="b", source_id=src_canary, items_created=out["items_created"], completeness=out["completeness"])
    for ns in (ns_a, ns_b):
        fin = ok(base, "POST", "/finish", {"ns": ns, "timeout_s": 600})
        check(fin["ready"] is True, f"finish not ready: {fin}")
        log("finish", ns=ns, **{k: fin[k] for k in ("ready", "waited_ms", "completeness")})

    for mode in ("vendor-default", "fixed-evidence"):
        res = retrieve(base, ns_a, "What did Melanie paint with her kids, and where?", mode)
        check_items(res["items"], set(src))
        cited = [s for it in res["items"] for s in it["source_ids"]]
        check(bool(res["items"]), f"{mode}: no items returned")
        check(src[1] in cited, f"{mode}: the session about the painting ({src[1]}) is not cited: {[(it['type'], it['source_ids']) for it in res['items']]}")
        log("retrieve", mode=mode, items=len(res["items"]), first_cited=cited[:1] == [src[1]],
            types=sorted({it["type"] for it in res["items"]}), provenance=sorted({it["provenance_status"] for it in res["items"]}),
            applied_settings=res["applied_settings"], service_ms=res["service_ms"])

    leak = retrieve(base, ns_a, f"What is the locker code {CANARY}?", "fixed-evidence")
    check_items(leak["items"], set(src))
    check(all(CANARY not in it["text"] for it in leak["items"]), "canary from namespace b returned in namespace a")
    own = retrieve(base, ns_b, f"What is the locker code {CANARY}?", "fixed-evidence")
    check(any(src_canary in it["source_ids"] or CANARY in it["text"] for it in own["items"]), "canary not retrievable in its own namespace (probe is vacuous)")
    log("isolation", leaked=False, own_namespace_hits=len(own["items"]))

    dele = ok(base, "POST", "/delete_source", {"ns": ns_a, "source_id": src[1]})
    check(dele["status"] in ("deleted", "partial", "unsupported"), f"bad delete status {dele}")
    after = retrieve(base, ns_a, "What did Melanie paint with her kids, and where?", "fixed-evidence")
    check_items(after["items"], set(src))
    still = [it for it in after["items"] if src[1] in it["source_ids"]]
    check(dele["status"] != "deleted" or not still, f"delete reported deleted but items still cite {src[1]}: {still}")
    survivors = retrieve(base, ns_a, "What support group did Caroline go to?", "fixed-evidence")
    check(any(src[0] in it["source_ids"] for it in survivors["items"]), "unrelated session did not survive the delete")
    log("delete", status=dele["status"], receipt=dele["receipt"], items_citing_deleted=len(still), survivor_cited=True)

    for path, body, kind in (("/retrieve", {"ns": ns_a, "question": "x", "policy": {"mode": "bogus"}}, "invalid_request"),
                             ("/ingest", {"ns": ns_a}, "invalid_request"),
                             ("/ingest", {"ns": ns_a, "session": {"source_id": "raw-id", "event_time": None, "turns": []}}, "invalid_request")):
        status, out = call(base, "POST", path, body)
        check(400 <= status < 500 and out.get("error", {}).get("kind") == kind, f"{path} {body} -> {status} {out}")
    log("errors", ok=True)

    for ns in (ns_a, ns_b):
        ok(base, "POST", "/reset", {"ns": ns})
    empty = retrieve(base, ns_a, "What did Melanie paint with her kids, and where?", "fixed-evidence")
    check(not empty["items"], f"namespace not empty after reset: {len(empty['items'])} items")
    log("reset", empty=True)
    log("PASS", system=caps["system"], config=health.get("config"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as e:
        log("FAIL", error=str(e))
        sys.exit(1)
