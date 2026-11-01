#!/usr/bin/env bash
# Secret scan of published receipts (docs/scoreboard.md): gitleaks over every receipts/ directory and every
# scoreboard receipt tree under docs/benchmarks/, and over the members of every compressed receipt (tarball or gzip
# file) under docs/benchmarks/, which gitleaks cannot open itself (#221). A compressed receipt listed in
# test/eval/fixtures/reviewed-compressed-receipts.json with its current sha256 was scanned member by member with this
# gitleaks version at review, so it is skipped; any other is unpacked and scanned. gitleaks skips binary files, so a
# compressed receipt in another format (.zip, .xz, .zst, .bz2, .7z), or one holding an archive or database, fails
# unread. gitleaks is pinned by version and sha256; findings are redacted.
#   bash scripts/scan-receipts.sh            (downloads gitleaks into a temporary directory)
#   GITLEAKS=/path/to/gitleaks bash scripts/scan-receipts.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=8.21.2
SHA256=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba
REVIEWED=test/eval/fixtures/reviewed-compressed-receipts.json
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin=${GITLEAKS:-}
if [ -z "$bin" ]; then
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
# "<sha256>  <path>" for each reviewed compressed receipt, when the review used this gitleaks version.
touch "$tmp/reviewed"
[ -f "$REVIEWED" ] && python3 -c 'import json, sys
r = json.load(open(sys.argv[1]))
if r["gitleaks"] == sys.argv[2]:
    print("".join(f"{sha}  {path}\n" for path, sha in r["files"].items()), end="")' "$REVIEWED" "$VERSION" > "$tmp/reviewed"
compressed=0 skipped=0
mkdir "$tmp/members"
while IFS= read -r f; do
  compressed=$((compressed + 1))
  if grep -qxF "$(sha256sum "$f" | cut -d' ' -f1)  $f" "$tmp/reviewed"; then skipped=$((skipped + 1)); continue; fi
  case "$f" in
    *.tgz|*.tar.gz|*.tar) mkdir -p "$tmp/members/$f" && tar -xf "$f" -C "$tmp/members/$f" ;;
    *.gz) mkdir -p "$tmp/members/$(dirname "$f")" && gzip -dc "$f" > "$tmp/members/${f%.gz}" ;;
    *) false ;;
  esac || { echo "cannot unpack $f"; status=1; }
done < <(find docs/benchmarks -type f \( -name '*.tgz' -o -name '*.tar' -o -name '*.gz' -o -name '*.zip' -o -name '*.xz' -o -name '*.zst' -o -name '*.bz2' -o -name '*.7z' \) | sort)
echo "compressed receipts: $compressed found, $skipped unchanged since review, $((compressed - skipped)) unpacked"
if [ "$compressed" != "$skipped" ]; then
  echo "scanning members of $((compressed - skipped)) compressed receipt(s)"
  # The archive, compression and database magics test/eval/receipt-machine-paths.test.ts refuses (OPAQUE).
  python3 - "$tmp/members" <<'EOF' || status=1
import os, sys
magic = (b"\x1f\x8b", b"PK\x03\x04", b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd", b"BZh", b"7z\xbc\xaf\x27\x1c", b"SQLite format 3\x00")
opaque = []
for parent, _, names in os.walk(sys.argv[1]):
    for name in names:
        path = os.path.join(parent, name)
        if os.path.islink(path):
            continue
        with open(path, "rb") as f:
            head = f.read(262)
        if head.startswith(magic) or head[257:262] == b"ustar":
            opaque.append(os.path.relpath(path, sys.argv[1]))
for path in sorted(opaque):
    print(f"cannot scan nested archive or database: {path}")
sys.exit(1 if opaque else 0)
EOF
  "$bin" dir "$tmp/members" --no-banner --redact --exit-code 1 || status=1
fi
echo "scan-receipts: $scanned director$([ "$scanned" = 1 ] && echo y || echo ies) scanned, $([ "$status" = 0 ] && echo 'no leaks' || echo 'LEAKS FOUND')"
exit $status
