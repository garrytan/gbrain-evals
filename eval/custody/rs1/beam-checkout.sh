#!/usr/bin/env bash
# BEAM for the RS1 mint, checked out sparse (F28): only the paths in a path list (eval/custody/rs1/beam-paths.txt, git
# sparse-checkout patterns) reach the machine. The fetch is blob-filtered (depth 1, --filter=blob:none), so git
# downloads the contents of the listed files alone; every other BEAM file, the 10M tier and the sealed conversations
# included, exists here only as a name and an object id in a tree object.
#
#   eval/custody/rs1/beam-checkout.sh <dir> <repository> <commit> <path list>
#
# A <dir> made from another path list, or a full checkout from before F28, is deleted and fetched again, because its
# working tree or object store can hold files the list excludes. Then, with git's lazy fetching off, it checks that
# HEAD is <commit>, the tree has no local changes, the files on disk are exactly the listed ones and the object store
# holds no file outside the list, and prints one counts-only line.
set -euo pipefail
umask 077

die() { printf 'rs1-mint refused: %s\n' "$*" >&2; exit 2; }
[ $# -eq 4 ] || die "usage: beam-checkout.sh <dir> <repository> <commit> <path list>"
DIR="$1" URL="$2" COMMIT="$3" LIST="$4"
[ -f "$LIST" ] || die "the BEAM path list does not exist"
LIST_SHA="$(sha256sum "$LIST" | cut -d' ' -f1)"
MARK="$DIR/.git/rs1-beam-paths-sha256"

REPLACED=0
if [ -e "$DIR" ] && [ "$(cat "$MARK" 2>/dev/null)" != "$LIST_SHA" ]; then
  rm -rf "$DIR"
  REPLACED=1
fi
if [ ! -e "$DIR" ]; then
  git init -q "$DIR"
  git -C "$DIR" remote add origin "$URL"
  git -C "$DIR" config core.sparseCheckout true
  git -C "$DIR" config core.sparseCheckoutCone false
  cp "$LIST" "$DIR/.git/info/sparse-checkout"
  git -C "$DIR" fetch -q --depth 1 --filter=blob:none origin "$COMMIT" >/dev/null 2>&1 || die "could not fetch BEAM at $COMMIT"
  git -C "$DIR" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD >/dev/null 2>&1 \
    || die "could not check out BEAM's listed paths at $COMMIT"
  echo "$LIST_SHA" > "$MARK"
fi

export GIT_NO_LAZY_FETCH=1
[ "$(git -C "$DIR" rev-parse HEAD 2>/dev/null)" = "$COMMIT" ] || die "the BEAM checkout is not at $COMMIT"
[ -z "$(git -C "$DIR" status --porcelain --untracked-files=all)" ] || die "the BEAM checkout has local changes; delete it and run again"

# The path list as awk's allowed(): a pattern ending in / admits everything under it, any other names one file.
ALLOWED='BEGIN { while ((getline l < list) > 0) if (l != "" && l !~ /^#/) { sub(/^\//, "", l); if (l ~ /\/$/) dirs[l] = 1; else files[l] = 1 } }
function allowed(p,  d) { if (p in files) return 1; for (d in dirs) if (index(p, d) == 1) return 1; return 0 }'
read -r FILES OUTSIDE MISSING < <(cd "$DIR" && find . -path ./.git -prune -o -type f -print | sed 's|^\./||' | awk -v list="$LIST" "$ALLOWED"'
  NF { seen[$0] = 1; n++; if (!allowed($0)) out++ }
  END { for (f in files) if (!(f in seen)) miss++
        for (d in dirs) { hit = 0; for (s in seen) if (index(s, d) == 1) { hit = 1; break }; if (!hit) miss++ }
        print n + 0, out + 0, miss + 0 }')
[ "$OUTSIDE" -eq 0 ] || die "the BEAM checkout holds $OUTSIDE files outside the path list"
[ "$MISSING" -eq 0 ] || die "the BEAM checkout lacks $MISSING listed paths"

# Which of the commit's files have contents in the object store. rev-list --missing=print reads only what is local and
# never fetches (nor does ls-tree, which reads trees), so a check can't pull an excluded file in.
MISSING_IDS="$(git -C "$DIR" rev-list --objects --missing=print HEAD)" || die "the BEAM checkout is missing tree objects"
TREE="$(git -C "$DIR" ls-tree -r --full-tree HEAD)" || die "the BEAM checkout is missing tree objects"
read -r ABSENT STRAY < <(awk -v list="$LIST" "$ALLOWED"'
  FNR == NR { if (sub(/^\?/, "")) gone[$0] = 1; next }
  $2 == "blob" { split($0, f, "\t"); blob[$3] = 1; if (allowed(f[2])) ok[$3] = 1 }
  END { for (b in blob) { if (b in gone) absent++; else if (!(b in ok)) stray++ } print absent + 0, stray + 0 }' \
  <(printf '%s\n' "$MISSING_IDS") <(printf '%s\n' "$TREE"))
[ "$STRAY" -eq 0 ] || die "the BEAM object store holds $STRAY files outside the path list"

printf 'rs1-mint beam=verified commit=%s tree=%s sparse_files=%s absent_blobs=%s paths_sha256=%s replaced=%s\n' \
  "$COMMIT" "$(git -C "$DIR" rev-parse 'HEAD^{tree}')" "$FILES" "$ABSENT" "$LIST_SHA" "$REPLACED"
