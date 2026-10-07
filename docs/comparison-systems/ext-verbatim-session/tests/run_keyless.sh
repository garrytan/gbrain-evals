#!/usr/bin/env bash
# Keyless check for the verbatim-session lane: sealed compose stack, the fake provider standing in for the metering
# proxy. Proves: no direct egress from the shim container, every protocol v1 check passing for the raw recipe, and zero
# provider requests (the raw and hybrid recipes call no model). Usage: docs/comparison-systems/ext-verbatim-session/tests/run_keyless.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PROXY_UPSTREAM=fake-provider:8787
port="${SHIM_HOST_PORT:-8703}"
mkdir -p tests/out
rm -f tests/out/fake_provider_requests.jsonl
docker compose --profile keyless down -v >/dev/null 2>&1 || true
docker compose --profile keyless up -d --build --wait
echo "== egress check: the shim container must not reach the internet directly"
if docker compose exec -T shim python -c "import urllib.request; urllib.request.urlopen('https://huggingface.co', timeout=5)" 2>/dev/null; then
  echo "FAIL shim container reached huggingface.co"; exit 1
fi
echo "PASS shim container has no direct route out"
status=0
python3 ../../../eval/systems/_shim/protocol_check.py --url "http://127.0.0.1:${port}" --questions 3 --json tests/out/keyless_recipe.json || status=$?
echo "== hybrid recipe (LLM rerank off) on a fresh namespace"
python3 - "$port" <<'PY' || status=$?
import json, sys, urllib.request
base = f"http://127.0.0.1:{sys.argv[1]}"
def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())
ns = "ns-keyless-hybrid"
post("/reset", {"ns": ns})
post("/ingest", {"ns": ns, "session": {"source_id": "src-h1", "event_time": "2023-05-08T13:56:00Z", "turns": [
    {"role": "user", "speaker": "Caroline", "content": "I signed up for a pottery class at the community studio in Portland."}]}})
post("/ingest", {"ns": ns, "session": {"source_id": "src-h2", "event_time": "2023-06-20T09:10:00Z", "turns": [
    {"role": "user", "speaker": "Melanie", "content": "We went camping at Yosemite and saw a black bear."}]}})
post("/finish", {"ns": ns, "timeout_s": 60})
out = post("/retrieve", {"ns": ns, "question": "What class did Caroline sign up for?", "query_time": None,
                         "policy": {"name": "vendor-default-v1", "mode": "vendor-default", "settings": {"recipe": "hybrid", "k": 10}}})
top = out["items"][0]["source_ids"] if out["items"] else []
ok = out["applied_settings"].get("recipe") == "hybrid" and out["applied_settings"].get("llm_rerank") is False and top == ["src-h1"]
print(("PASS" if ok else "FAIL") + f"  hybrid recipe ranks the pottery session first  top={top} names={out['applied_settings'].get('person_names')}")
post("/reset", {"ns": ns})
sys.exit(0 if ok else 1)
PY
echo "== fake provider request counts (expected: none)"
stats="$(curl -s "http://127.0.0.1:${FAKE_PROVIDER_HOST_PORT:-8790}/_stats")"; echo "$stats"
if [ "$stats" = "{}" ] && [ ! -s tests/out/fake_provider_requests.jsonl ]; then
  echo "PASS zero provider requests"
else
  echo "FAIL the shim made provider requests"; status=1
fi
docker compose --profile keyless down -v >/dev/null 2>&1
exit $status
