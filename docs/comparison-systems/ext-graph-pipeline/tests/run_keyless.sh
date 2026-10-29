#!/usr/bin/env bash
# Keyless end-to-end check: sealed compose stack with the fake provider standing in for the metering proxy.
# Usage: docs/comparison-systems/ext-graph-pipeline/tests/run_keyless.sh [recipe|common]
set -euo pipefail
cd "$(dirname "$0")/.."
export SHIM_CONFIG="${1:-recipe}" PROXY_HOSTPORT=fake-provider:8787
mkdir -p tests/out
rm -f tests/out/fake_provider_requests.jsonl
docker compose --profile keyless down -v >/dev/null 2>&1 || true
docker compose --profile keyless up -d --build --wait
echo "== egress check: the shim container must not reach the internet directly"
if docker compose exec -T cognee python -c "import urllib.request; urllib.request.urlopen('https://api.openai.com', timeout=5)" 2>/dev/null; then
  echo "FAIL shim container reached api.openai.com"; exit 1
fi
echo "PASS shim container has no direct route out"
status=0
python3 tests/protocol_check.py --url "http://127.0.0.1:${SHIM_HOST_PORT:-8701}" --questions 3 --out "tests/out/keyless_${SHIM_CONFIG}.json" || status=$?
echo "== fake provider request counts (every provider call went through the egress relay)"
curl -s "http://127.0.0.1:${FAKE_PROVIDER_HOST_PORT:-8788}/_stats"; echo
docker compose --profile keyless down -v >/dev/null
exit $status
