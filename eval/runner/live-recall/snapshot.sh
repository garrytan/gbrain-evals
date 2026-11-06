#!/usr/bin/env bash
# Disposable copy of a gbrain Postgres brain for the live-recall runner.
#
#   LIVE_RECALL_SOURCE_URL=<brain url> eval/runner/live-recall/snapshot.sh make [workdir]
#   eval/runner/live-recall/snapshot.sh teardown [workdir]
#
# make reads the source once with pg_dump, which runs in a single read-only
# repeatable-read transaction and writes nothing to the source. It restores the
# public schema into a pgvector container bound to 127.0.0.1, creates the
# marker table the runner's barrier check requires, compares row counts with
# the source, deletes the dump file and writes <workdir>/copy.env (mode 600)
# with LIVE_RECALL_DATABASE_URL. Restore output stays in <workdir>/restore.log
# because pg_restore errors can quote row data; the terminal gets counts only.
# teardown removes the container, its volume and the workdir.
#
# The public schema itself is left out of the restore list, since the new
# database already has it.
#
# Settings: LIVE_RECALL_PG_IMAGE (default pgvector/pgvector:pg17; its pg_dump
# must be at least the source server's major version), LIVE_RECALL_COPY_PORT
# (default 55432), LIVE_RECALL_CONTAINER (default gbrain-evals-live-recall).
set -euo pipefail

cmd="${1:-}"
workdir="${2:-$HOME/.gbrain-evals-live-recall-copy}"
image="${LIVE_RECALL_PG_IMAGE:-pgvector/pgvector:pg17}"
port="${LIVE_RECALL_COPY_PORT:-55432}"
name="${LIVE_RECALL_CONTAINER:-gbrain-evals-live-recall}"
volume="$name-data"
marker=gbrain_evals_live_recall_copy
count_tables="pages content_chunks links"

say() { printf 'live-recall snapshot: %s\n' "$*"; }
die() { printf 'live-recall snapshot: ABORT %s\n' "$*" >&2; exit 3; }

# psql, pg_dump and pg_restore from the image, on the host network so both the source and the copy are reachable.
pg() { docker run --rm -i --network host -e LIVE_RECALL_SOURCE_URL -e PGPASSWORD -v "$workdir:/work" "$image" "$@"; }

teardown() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$workdir"
  say "removed container $name, volume $volume and $workdir"
}

make_copy() {
  [ -n "${LIVE_RECALL_SOURCE_URL:-}" ] || die "LR_SNAPSHOT_NO_SOURCE: set LIVE_RECALL_SOURCE_URL to the brain's Postgres URL (session or direct, not the :6543 transaction pooler)"
  case "$LIVE_RECALL_SOURCE_URL" in *:6543/*) die "LR_SNAPSHOT_POOLER: pg_dump needs a session (:5432) or direct connection, not the :6543 transaction pooler" ;; esac
  command -v docker >/dev/null || die "LR_SNAPSHOT_NO_DOCKER: Docker is not installed; use a read replica or a read-only role instead (RUN-KIT.md)"
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then die "LR_SNAPSHOT_EXISTS: container $name exists; run teardown first"; fi
  mkdir -p "$workdir" && chmod 700 "$workdir"
  umask 077

  say "reading source extensions and row counts (read-only queries)"
  local q_ext="SELECT e.extname || ' ' || n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname IN ('vector', 'pg_trgm', 'pgcrypto') ORDER BY 1"
  local q_counts="SELECT $(for t in $count_tables; do printf "(SELECT count(*) FROM public.%s) || ' ' || " "$t"; done) ''"
  local exts src_counts
  exts="$(pg sh -c 'psql -X -q -t -A -v ON_ERROR_STOP=1 --dbname="$LIVE_RECALL_SOURCE_URL" -c "BEGIN READ ONLY" -c "$1" -c COMMIT' _ "$q_ext")" \
    || die "LR_SNAPSHOT_SOURCE_READ: could not query the source; check the URL and network"
  src_counts="$(pg sh -c 'psql -X -q -t -A -v ON_ERROR_STOP=1 --dbname="$LIVE_RECALL_SOURCE_URL" -c "BEGIN READ ONLY" -c "$1" -c COMMIT' _ "$q_counts" | tr -s ' ' | sed 's/ $//')"

  say "dumping the public schema (pg_dump, one read-only transaction)"
  pg sh -c 'pg_dump --dbname="$LIVE_RECALL_SOURCE_URL" --format=custom --schema=public --no-owner --no-privileges --file=/work/brain.dump' 2>"$workdir/dump.log" \
    || die "LR_SNAPSHOT_DUMP: pg_dump failed; details in $workdir/dump.log (stays on this box)"

  local password
  password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  docker volume create "$volume" >/dev/null
  docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=brain \
    -p "127.0.0.1:$port:5432" -v "$volume:/var/lib/postgresql/data" "$image" >/dev/null
  local url="postgresql://postgres:$password@127.0.0.1:$port/brain"
  for _ in $(seq 1 60); do
    PGPASSWORD="$password" pg psql -X -q -t -A "$url" -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  PGPASSWORD="$password" pg psql -X -q -t -A "$url" -c 'SELECT 1' >/dev/null 2>&1 || die "LR_SNAPSHOT_COPY_START: the copy container did not become ready"

  say "restoring into $name on 127.0.0.1:$port"
  local prep="" search_path="public" ext nsp role
  while read -r ext nsp; do
    [ -n "$ext" ] || continue
    prep+="CREATE SCHEMA IF NOT EXISTS \"$nsp\"; CREATE EXTENSION IF NOT EXISTS $ext SCHEMA \"$nsp\"; "
    case " $search_path " in *" \"$nsp\""*|*" $nsp "*) ;; *) [ "$nsp" = public ] || search_path+=", \"$nsp\"" ;; esac
  done <<<"$exts"
  for role in anon authenticated service_role; do
    prep+="DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') THEN CREATE ROLE $role NOLOGIN; END IF; END \$\$; "
  done
  PGPASSWORD="$password" pg psql -X -q -v ON_ERROR_STOP=1 "$url" -c "$prep ALTER DATABASE brain SET search_path = $search_path;" >/dev/null
  pg sh -c 'pg_restore --list /work/brain.dump | grep -vE "(SCHEMA|COMMENT) - (SCHEMA )?public " >/work/restore.list'
  PGPASSWORD="$password" pg pg_restore --no-owner --no-privileges --use-list=/work/restore.list --dbname="$url" /work/brain.dump >"$workdir/restore.log" 2>&1 || true
  rm -f "$workdir/brain.dump" "$workdir/restore.list"
  local errors
  errors="$(grep -c 'pg_restore: error' "$workdir/restore.log" || true)"

  local copy_counts
  copy_counts="$(PGPASSWORD="$password" pg psql -X -q -t -A "$url" -c "$q_counts" | tr -s ' ' | sed 's/ $//')"
  [ -n "$src_counts" ] && [ "$src_counts" = "$copy_counts" ] \
    || die "LR_SNAPSHOT_COUNTS: row counts differ (source: ${src_counts:-none}; copy: ${copy_counts:-none}; tables: $count_tables); $errors restore errors in $workdir/restore.log. Run teardown."

  PGPASSWORD="$password" pg psql -X -q -v ON_ERROR_STOP=1 "$url" \
    -c "CREATE TABLE public.$marker (made_at timestamptz NOT NULL DEFAULT now()); INSERT INTO public.$marker DEFAULT VALUES;" >/dev/null
  printf "export LIVE_RECALL_DATABASE_URL='%s'\n" "$url" >"$workdir/copy.env"
  chmod 600 "$workdir/copy.env"
  say "copy ready: row counts match the source ($count_tables: $copy_counts); restore errors: $errors (see $workdir/restore.log)"
  say "next: source $workdir/copy.env, run the runner, then: eval/runner/live-recall/snapshot.sh teardown $workdir"
}

case "$cmd" in
  make) make_copy ;;
  teardown) teardown ;;
  *) echo "usage: snapshot.sh make|teardown [workdir]" >&2; exit 2 ;;
esac
