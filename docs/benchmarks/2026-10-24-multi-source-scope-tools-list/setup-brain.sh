#!/usr/bin/env bash
# Builds one synthetic brain for the GBRA-156 A/B with the given gbrain checkout.
# Usage: setup-brain.sh <gbrain-checkout> <brain-dir> <corpus-dir>
# Writes <brain-dir>/tokens.json (local test tokens for this throwaway brain; never commit it).
set -euo pipefail
CHECKOUT=$1; BRAIN=$2; CORPUS=$3
G() { bun run "$CHECKOUT/src/cli.ts" "$@"; }
export GBRAIN_HOME=$BRAIN
rm -rf "$BRAIN"; mkdir -p "$BRAIN"
cp -r "$CORPUS" "$BRAIN/corpus"
# A shared page that is soft-deleted after import (hidden-param task H1 needs get_page include_deleted).
cat > "$BRAIN/corpus/shared/decisions/dashboard-retirement.md" <<'EOF'
---
title: "Dashboard retirement policy"
type: "decision"
---

# Dashboard retirement policy

Decided 2026-06-02. Dashboards nobody has opened for 120 days are archived on the first Monday of each month. Owner: erin-example.
EOF
G init --pglite --no-embedding --non-interactive > "$BRAIN/init.log" 2>&1
for s in shared source-a source-b source-c; do
  d="$BRAIN/corpus/$s"
  (cd "$d" && git init -q && git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm corpus)
  G sources add "$s" --path "$d" --federated >> "$BRAIN/init.log" 2>&1
  G sync --source "$s" --no-pull --no-embed >> "$BRAIN/init.log" 2>&1
done
# Timeline entries live in their own table; get_page returns them only with include_timeline_entries (hidden-param task H2).
GBRAIN_SOURCE=shared G timeline-add projects/borealis-example 2026-10-02 "Signed the northwind-example warehouse contract" >> "$BRAIN/init.log" 2>&1
GBRAIN_SOURCE=shared G timeline-add projects/borealis-example 2026-10-16 "Dry run 1 finished in 3 hours 40 minutes; two dashboards failed" >> "$BRAIN/init.log" 2>&1
G delete decisions/dashboard-retirement --source-id shared --force >> "$BRAIN/init.log" 2>&1
echo '{' > "$BRAIN/tokens.json"
first=1
for t in all:shared,source-a,source-b,source-c alice-example:shared,source-a bob-example:shared,source-b carol-example:shared,source-c; do
  name=$(echo "$t" | cut -d: -f1); srcs=$(echo "$t" | cut -d: -f2)
  tok=$(G auth create "bot-$name" --scopes read 2>&1 | grep -o 'gbrain_[0-9a-f]*' | head -1)
  G auth rescope --token "bot-$name" --sources "$srcs" >> "$BRAIN/init.log" 2>&1
  [ $first = 1 ] || echo ',' >> "$BRAIN/tokens.json"; first=0
  printf '"%s": "%s"' "$name" "$tok" >> "$BRAIN/tokens.json"
done
echo '}' >> "$BRAIN/tokens.json"
G sources list
