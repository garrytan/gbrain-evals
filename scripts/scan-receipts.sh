#!/usr/bin/env bash
# Secret scan of published receipts (docs/scoreboard.md): gitleaks over every receipts/ directory and every
# scoreboard receipt tree under docs/benchmarks/, and over the members of every compressed receipt (tarball or gzip
# file) under docs/benchmarks/, which gitleaks cannot open itself (#221). A compressed receipt listed in
# test/eval/fixtures/reviewed-compressed-receipts.json with its current sha256 was scanned member by member with this
# gitleaks version at review, so it is skipped; any other is unpacked and scanned. A compressed receipt in another
# format (.zip, .xz, .zst, .bz2, .7z), or with a member that is not UTF-8 text, fails unread. gitleaks is pinned by
# version and sha256; findings are redacted.
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
  # gitleaks reads a file in 10,000-byte chunks, drops the rest of a file at a chunk whose first bytes look like a
  # binary format, and skips some paths (.svg, .bin, node_modules). So each member, which must be UTF-8 text without
  # NUL bytes, is cut into overlapping windows, each written as a numbered piece under a fixed header line. A piece is
  # shorter than one chunk, so gitleaks reads it whole, and a secret up to 4,500 bytes long (an RSA-4096 private key in
  # PEM is about 3,300) lies whole inside some piece. pieces.tsv maps a piece back to its member.
  mkdir "$tmp/pieces"
  python3 - "$tmp/members" "$tmp/pieces" "$tmp/pieces.tsv" <<'EOF' || status=1
import os, stat, sys
members, pieces, index = sys.argv[1:]
WINDOW, OVERLAP, HEADER = 9000, 4500, b"#" * 400 + b"\n"
rows, unreadable = [], []
for parent, dirs, names in os.walk(members):
    dirs.sort()
    for name in sorted(names):
        path = os.path.join(parent, name)
        member = os.path.relpath(path, members)
        if not stat.S_ISREG(os.lstat(path).st_mode):
            continue
        with open(path, "rb") as f:
            data = f.read()
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            unreadable.append(member)
            continue
        if b"\0" in data:
            unreadable.append(member)
            continue
        for begin in range(0, max(len(data) - OVERLAP, 1), WINDOW - OVERLAP):
            piece = f"{len(rows):09d}"
            with open(os.path.join(pieces, piece), "wb") as f:
                f.write(HEADER + data[begin:begin + WINDOW])
            rows.append(f"{piece}\t{member}\n")
with open(index, "w") as f:
    f.writelines(rows)
for member in unreadable:
    print(f"cannot scan a member that is not UTF-8 text: {member}")
sys.exit(1 if unreadable else 0)
EOF
  if ! "$bin" dir "$tmp/pieces" --no-banner --redact --exit-code 1 --report-format json --report-path "$tmp/leaks.json"; then
    status=1
    [ -s "$tmp/leaks.json" ] && python3 -c 'import json, os, sys
index = dict(line.rstrip("\n").split("\t", 1) for line in open(sys.argv[2]))
for leak in json.load(open(sys.argv[1])):
    print("leak (" + leak["RuleID"] + ") in " + index[os.path.basename(leak["File"])])' "$tmp/leaks.json" "$tmp/pieces.tsv" | sort | uniq -c || true
  fi
fi
echo "scan-receipts: $scanned director$([ "$scanned" = 1 ] && echo y || echo ies) scanned, $([ "$status" = 0 ] && echo 'no leaks' || echo 'LEAKS FOUND')"
exit $status
