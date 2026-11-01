#!/usr/bin/env bash
# Secret scan of published receipts (docs/scoreboard.md): gitleaks over every receipts/ directory and every
# scoreboard receipt tree under docs/benchmarks/, and over the members of every compressed receipt (gzip file or
# tarball) under docs/benchmarks, results, baselines and qrels, the roots test/eval/receipt-machine-paths.test.ts
# reads, which gitleaks cannot open itself (#221). A compressed receipt is found by its leading bytes as well as its
# name. One whose entry in test/eval/fixtures/reviewed-compressed-receipts.json matches its current sha256 and names
# this gitleaks version was scanned member by member at review, so it is skipped. Any other tarball is refused unread
# when GNU tar cannot list it cleanly (a non-zero exit, any warning, or more entries when told to read past zero
# blocks), when it names a member twice, or when it holds an entry other than a regular file or directory; otherwise
# GNU tar extracts it and the scan reads the extracted files, the same files a consumer gets. A compressed receipt in
# another format (zip, xz, zstd, bzip2, 7z, lz4, compress, lzip, rar), or with a member that is not UTF-8 text, fails
# unread. gitleaks is pinned by version and sha256; findings are redacted.
#   bash scripts/scan-receipts.sh            (downloads gitleaks into a temporary directory)
#   GITLEAKS=/path/to/gitleaks bash scripts/scan-receipts.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=8.21.2
SHA256=5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba
REVIEWED=test/eval/fixtures/reviewed-compressed-receipts.json
tmp=$(mktemp -d)
trap 'chmod -R u+rwX "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
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
# gitleaks reads a file in 10,000-byte chunks, drops the rest of a file at a chunk whose first bytes look like a
# binary format, and skips some paths (.svg, .bin, node_modules). So each member, which must be UTF-8 text without NUL
# bytes, is cut into overlapping windows, each written as a numbered piece under a fixed header line. A piece is
# shorter than one chunk, so gitleaks reads it whole, and a secret up to 4,500 bytes long (an RSA-4096 private key in
# PEM is about 3,300) lies whole inside some piece. pieces.tsv maps a piece back to its member.
mkdir "$tmp/pieces" "$tmp/members"
python3 - "$REVIEWED" "$VERSION" "$tmp/pieces" "$tmp/pieces.tsv" "$tmp/members" docs/benchmarks results baselines qrels <<'EOF' || status=1
import gzip, hashlib, json, os, posixpath, shutil, stat, subprocess, sys, tempfile
reviewed_path, version, pieces, index, members, *roots = sys.argv[1:]
WINDOW, OVERLAP, HEADER = 9000, 4500, b"#" * 400 + b"\n"
# Leading bytes of zip, xz, zstd, bzip2, 7z, lz4, compress (.Z), lzip and rar; receipt-machine-paths.test.ts refuses the same.
UNREADABLE = [bytes.fromhex(m) for m in ("504b0304", "fd377a585a00", "28b52ffd", "425a68", "377abcaf271c", "04224d18", "1f9d", "4c5a4950", "526172211a07")]
TAR = dict(os.environ, LC_ALL="C")
entries = json.load(open(reviewed_path))["files"] if os.path.exists(reviewed_path) else {}
reviewed = {path: e["sha256"] for path, e in entries.items() if e.get("gitleaks") == version}
rows, failed, found, skipped = [], False, 0, 0

def window(member, data):
    global failed
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        data = None
    if data is None or b"\0" in data:
        print(f"cannot scan a member that is not UTF-8 text: {member}")
        failed = True
        return
    for begin in range(0, max(len(data) - OVERLAP, 1), WINDOW - OVERLAP):
        piece = f"{len(rows):09d}"
        with open(os.path.join(pieces, piece), "wb") as f:
            f.write(HEADER + data[begin:begin + WINDOW])
        rows.append(f"{piece}\t{member}\n")

def refusal(path):
    """Why GNU tar's listing rules a tarball out (None when it does not), and the number of regular files it lists."""
    long, names, past = (subprocess.run(["tar", *flags, path], capture_output=True, env=TAR) for flags in (["-tvf"], ["-tf"], ["--ignore-zeros", "-tf"]))
    failed = next((p for p in (long, names, past) if p.returncode or p.stderr), None)
    if failed:
        said = failed.stderr.decode("utf-8", "replace").strip().splitlines()
        return f"tar cannot list it cleanly ({said[0] if said else f'exit {failed.returncode}'})", 0
    if past.stdout != names.stdout:
        return "tar cannot list it cleanly (it lists more entries past a zero block)", 0
    kinds, names = [line[:1] for line in long.stdout.splitlines()], names.stdout.splitlines()
    if len(kinds) != len(names):
        return "tar cannot list it cleanly (its two listings differ)", 0
    seen = set()
    for kind, name in zip(kinds, names):
        shown = name.decode("utf-8", "replace")
        if kind not in (b"-", b"d"):
            return f"{shown} is not a regular file or directory", 0
        key = posixpath.normpath(b"/" + name).strip(b"/")
        if key in seen:
            return f"{shown} is named twice", 0
        seen.add(key)
    return None, kinds.count(b"-")

def raise_error(error):
    raise error

def tarball(path):
    global failed
    reason, listed = refusal(path)
    if reason:
        print(f"refusing {path}: {reason}")
        failed = True
        return
    dest = tempfile.mkdtemp(dir=members)
    try:
        if subprocess.run(["tar", "-xf", path, "-C", dest], env=TAR).returncode:
            raise OSError(path)
        subprocess.run(["chmod", "-R", "u+rwX", dest], check=True)
        extracted = 0
        for parent, dirs, names in os.walk(dest, onerror=raise_error):
            dirs.sort()
            for name in sorted(names):
                member = os.path.join(parent, name)
                if not stat.S_ISREG(os.lstat(member).st_mode):
                    raise OSError(member)
                extracted += 1
                with open(member, "rb") as f:
                    window(f"{path}/{os.path.relpath(member, dest)}", f.read())
        if extracted != listed:
            raise OSError(path)
    finally:
        subprocess.run(["chmod", "-R", "u+rwX", dest])
        shutil.rmtree(dest)

for root in roots:
    for parent, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(parent, name)
            if os.path.islink(path) or not os.path.isfile(path):
                continue
            with open(path, "rb") as f:
                head = f.read(262)
            other = name.endswith((".zip", ".xz", ".zst", ".bz2", ".7z")) or any(head.startswith(m) for m in UNREADABLE)
            if not (other or name.endswith((".tgz", ".tar", ".gz")) or head[:2] == b"\x1f\x8b" or head[257:262] == b"ustar"):
                continue
            found += 1
            digest = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    digest.update(chunk)
            if reviewed.get(path) == digest.hexdigest():
                skipped += 1
                continue
            try:
                if other:
                    raise OSError(path)
                try:
                    inner = gzip.open(path).read(512) if head[:2] == b"\x1f\x8b" else head
                except Exception:
                    inner = b""
                if name.endswith((".tgz", ".tar", ".tar.gz")) or inner[257:262] == b"ustar":
                    tarball(path)
                else:
                    plain = subprocess.run(["gzip", "-dc", path], capture_output=True)
                    if plain.returncode:
                        raise OSError(path)
                    window(path[:-3] if path.endswith(".gz") else path, plain.stdout)
            except Exception:
                print(f"cannot unpack {path}")
                failed = True
with open(index, "w") as f:
    f.writelines(rows)
print(f"compressed receipts: {found} found, {skipped} unchanged since review, {found - skipped} unpacked")
if found != skipped:
    print(f"scanning members of {found - skipped} compressed receipt(s)")
sys.exit(1 if failed else 0)
EOF
if [ -s "$tmp/pieces.tsv" ] && ! "$bin" dir "$tmp/pieces" --no-banner --redact --exit-code 1 --report-format json --report-path "$tmp/leaks.json"; then
  status=1
  [ -s "$tmp/leaks.json" ] && python3 -c 'import json, os, sys
index = dict(line.rstrip("\n").split("\t", 1) for line in open(sys.argv[2]))
for leak in json.load(open(sys.argv[1])):
    print("leak (" + leak["RuleID"] + ") in " + index[os.path.basename(leak["File"])])' "$tmp/leaks.json" "$tmp/pieces.tsv" | sort | uniq -c || true
fi
echo "scan-receipts: $scanned director$([ "$scanned" = 1 ] && echo y || echo ies) scanned, $([ "$status" = 0 ] && echo 'no leaks' || echo 'LEAKS FOUND')"
exit $status
