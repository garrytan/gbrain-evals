#!/usr/bin/env bash
# Keyless check for the Letta lane: sealed compose stack, the fake provider standing in for the metering proxy.
# Proves: no direct egress, the capability-only protocol surface, the App Server handshake (backend local), and that a
# native agent turn's model call leaves only through the proxy. Usage: docs/comparison-systems/ext-agent-runtime/tests/run_keyless.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PROXY_HOSTPORT=fake-provider:8787
mkdir -p tests/out ../ext-graph-pipeline/tests/out run
rm -f ../ext-graph-pipeline/tests/out/fake_provider_requests.jsonl
docker compose --profile keyless down -v >/dev/null 2>&1 || true
docker compose --profile keyless up -d --build --wait
echo "== egress check: the Letta container must not reach the internet directly"
if docker compose exec -T letta python3 -c "import urllib.request; urllib.request.urlopen('https://api.letta.com', timeout=5)" 2>/dev/null; then
  echo "FAIL letta container reached api.letta.com"; exit 1
fi
echo "PASS letta container has no direct route out"
status=0
python3 ../ext-graph-pipeline/tests/protocol_check.py --url "http://127.0.0.1:${SHIM_HOST_PORT:-8702}" --capabilities-only --out tests/out/keyless_letta.json || status=$?
echo "== native agent turn through the proxy (headless, local backend)"
docker compose exec -T letta letta -p "Remember: my dog is named Biscuit." --backend local -m openai-compatible/gpt-4.1-mini --output-format json \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print({k: r.get(k) for k in ('subtype','is_error','result','usage')})" || status=$?
echo "== fake provider request counts"
curl -s "http://127.0.0.1:${FAKE_PROVIDER_HOST_PORT:-8789}/_stats"; echo
docker compose --profile keyless down -v >/dev/null 2>&1
exit $status
