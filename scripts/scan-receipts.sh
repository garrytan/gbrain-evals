#!/usr/bin/env bash
# Secret scan of published receipts (docs/scoreboard.md): gitleaks over every receipts/ directory and every
# scoreboard receipt tree under docs/benchmarks/. gitleaks is pinned by version and sha256; findings are redacted.
#   bash scripts/scan-receipts.sh            (downloads gitleaks into a temporary directory)
#   GITLEAKS=/path/to/gitleaks bash scripts/scan-receipts.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=8.21.2
SHA256=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba
bin=${GITLEAKS:-}
if [ -z "$bin" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/gitleaks.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_linux_x64.tar.gz"
  echo "$SHA256  $tmp/gitleaks.tgz" > "$tmp/sum"
  sha256sum -c "$tmp/sum"
  tar -xzf "$tmp/gitleaks.tgz" -C "$tmp" gitleaks
  bin="$tmp/gitleaks"
fi
status=0 scanned=0
while IFS= read -r dir; do
  echo "scanning $dir"
  scanned=$((scanned + 1))
  "$bin" dir "$dir" --no-banner --redact --exit-code 1 || status=1
done < <(find docs/benchmarks -type d \( -name receipts -o -name '*-scoreboard' \) | sort)
echo "scan-receipts: $scanned director$([ "$scanned" = 1 ] && echo y || echo ies) scanned, $([ "$status" = 0 ] && echo 'no leaks' || echo 'LEAKS FOUND')"
exit $status
