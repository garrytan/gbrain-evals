#!/usr/bin/env bash
# One tier of the graph-backend benchmark (GBRA-123), resumable by stage.
#
#   run-tier.sh <tier> [stage...]
#
# Stages, in order: load-pg plan hydra-load calibrate arm-A arm-B arm-BL arm-C tput
# (default: all of them). Each stage writes a marker under $OUT/<tier>/.done and
# is skipped when it exists; worker rows are also resumable call by call.
#
# Env: GB_A, GB_B (gbrain worktrees at the two SHAs), OUT (receipt dir),
#      A_STARTS (arm A start count at team/company, default 100),
#      STARTS (start count; default 500), STRATEGY (fixed C strategy; else
#      read from the calibration file named by CALIBRATION).
set -euo pipefail
cd "$(dirname "$0")/../../.."
tier=$1; shift || true
stages=("$@"); [[ ${#stages[@]} -eq 0 ]] && stages=(load-pg plan hydra-load calibrate arm-A arm-B arm-BL arm-C tput)
GB_A=${GB_A:?}; GB_B=${GB_B:?}
OUT=${OUT:-docs/benchmarks/2026-10-17-graph-backend}
D="$OUT/$tier"; mkdir -p "$D/.done"
STACK=eval/runner/graph-backend/stack.sh
W=eval/runner/graph-backend/worker.ts
PG_ADMIN="postgres://postgres:bench@127.0.0.1:5433/gb_$tier"
PG_WALK="postgres://walker:walker@127.0.0.1:5433/gb_$tier"
PLAN="$D/plan.json"
ROWS="$D/rows.ndjson"
log() { echo "[run-tier $tier $(date -u +%H:%M:%S)] $*" >&2; }
done_mark() { touch "$D/.done/$1"; }
is_done() { [[ -e "$D/.done/$1" ]]; }
stats() { "$STACK" stats > "$D/stats-$1.json"; }
psql_admin() { docker exec gb-pg psql -U postgres -At "$@"; }

identities() {
  python3 - "$D/identities.json" <<EOF
import json, subprocess, sys
def git(d, *a): return subprocess.check_output(['git', '-C', d, *a], text=True).strip()
img = lambda i: subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', i], capture_output=True, text=True).stdout.strip()
json.dump({
  'gbrain_A': git('$GB_A', 'rev-parse', 'HEAD'), 'gbrain_B': git('$GB_B', 'rev-parse', 'HEAD'),
  'gbrain_evals': git('.', 'rev-parse', 'HEAD'), 'gbrain_evals_dirty': bool(git('.', 'status', '--porcelain', '--', 'eval/runner/graph-backend')),
  'hydradb_commit': open('$HOME/.capy/work/g123/hydradb.sha').read().strip() if __import__('os').path.exists('$HOME/.capy/work/g123/hydradb.sha') else None,
  'images': {i: img(i) for i in ['hydradb:local', 'pgvector/pgvector:pg17', 'bitnamilegacy/minio:2025.7.23']},
  'bun': subprocess.check_output(['bun', '--version'], text=True).strip(),
  'nproc': int(subprocess.check_output(['nproc'], text=True)), 'mem_kb': int(open('/proc/meminfo').readline().split()[1]),
  'uname': subprocess.check_output(['uname', '-srm'], text=True).strip(),
}, open(sys.argv[1], 'w'), indent=2)
EOF
}

wait_index() {
  python3 - "$D/load-hydra.json" <<'EOF'
import json, subprocess, sys, time
expected = {k: v['expected'] for k, v in json.load(open(sys.argv[1]))['counts'].items()}
t0 = time.time()
while True:
    logs = subprocess.run(['docker', 'logs', 'gb-hydra-indexer'], capture_output=True, text=True)
    got = {}
    for line in (logs.stdout + logs.stderr).splitlines():
        if 'generation published' not in line: continue
        try: j = json.loads(line)
        except Exception: continue
        got[j.get('hydradb.edge_type')] = j.get('edge_count')
    if all(got.get(k) == v for k, v in expected.items()):
        print(json.dumps({'index_ready_s': round(time.time() - t0, 1), 'generations': got})); break
    if time.time() - t0 > 7200: print(json.dumps({'index_ready_s': None, 'generations': got})); break
    time.sleep(10)
EOF
}

run_arm() { # arm engine_dir pass extra...
  local arm=$1 eng=$2 pass=$3; shift 3
  log "arm $arm pass $pass"
  GB_ENGINE_DIR=$eng bun "$W" --arm "$arm" --tier "$tier" --pass "$pass" --plan "$PLAN" --out "$ROWS" "$@" >> "$D/worker-runs.ndjson"
}

strategy() {
  if [[ -n "${STRATEGY:-}" ]]; then echo "$STRATEGY"; return; fi
  python3 -c "import json;c=json.load(open('${CALIBRATION:-$D/calibration.json}'));print(','.join(f'{k}={v}' for k,v in c['choice'].items()))"
}

identities
for st in "${stages[@]}"; do
  is_done "$st" && { log "skip $st"; continue; }
  case $st in
    load-pg)
      docker exec gb-pg psql -U postgres -c "DROP DATABASE IF EXISTS gb_$tier" -c "CREATE DATABASE gb_$tier" >/dev/null
      docker exec gb-pg psql -U postgres -c "DO \$\$BEGIN CREATE ROLE walker LOGIN SUPERUSER PASSWORD 'walker'; EXCEPTION WHEN duplicate_object THEN NULL; END\$\$" -c "ALTER ROLE walker SET statement_timeout = '30s'" >/dev/null
      GB_ENGINE_DIR=$GB_B bun eval/runner/graph-backend/pg-load.ts "$tier" "$PG_ADMIN" 2>"$D/load-pg.log" | tail -1 > "$D/load-pg.json"
      psql_admin -d "gb_$tier" -c "SELECT json_object_agg(name, setting) FROM pg_settings" > "$D/pg-settings.json"
      psql_admin -d "gb_$tier" -c "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1" > "$D/pg-schema-version.txt" 2>/dev/null || true
      ;;
    plan) bun eval/runner/graph-backend/plan.ts "$tier" "$PLAN" ${STARTS:-} > "$D/plan-summary.json" ;;
    hydra-load)
      HYDRA_FRESH=1 "$STACK" hydra-up
      bun eval/runner/graph-backend/hydra-load.ts "$tier" 2>"$D/load-hydra.log" | tail -1 > "$D/load-hydra.json"
      wait_index > "$D/index-ready.json"
      stats hydra-loaded
      ;;
    calibrate)
      "$STACK" hydra-up
      for s in layer perdepth; do for p in cal1 cal2; do run_arm "C-$s" "$GB_B" "$p" --db "$PG_WALK" --calls calibration --strategy "$s"; done; done
      python3 - "$ROWS" "$D/calibration.json" <<'EOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if '"cal2"' in l]
def p95(xs):
    xs = sorted(xs); return xs[min(len(xs) - 1, max(0, -(-len(xs) * 95 // 100) - 1))] if xs else None
res = {}
for kind in ['traverseGraph', 'traversePaths']:
    res[kind] = {}
    for s in ['layer', 'perdepth']:
        rs = [r for r in rows if r['arm'] == f'C-{s}' and r['cell'].startswith(kind)]
        ok = [r['ms'] if r['status'] == 'ok' else 30000 for r in rs]
        res[kind][s] = {'p95_ms': p95(ok), 'p50_ms': sorted(ok)[len(ok) // 2] if ok else None, 'n': len(rs), 'errors': sum(r['status'] != 'ok' for r in rs)}
choice = {k: min(v, key=lambda s: v[s]['p95_ms']) for k, v in res.items()}
json.dump({'pass': 'cal2 (warm)', 'results': res, 'choice': choice}, open(sys.argv[2], 'w'), indent=2)
print(json.dumps(choice))
EOF
      ;;
    arm-A|arm-B)
      arm=${st#arm-}; eng=$GB_B; [[ $arm == A ]] && eng=$GB_A
      extra=(); [[ $arm == A && $tier != personal ]] && extra=(--starts "${A_STARTS:-100}")
      "$STACK" hydra-stop
      "$STACK" cold pg
      run_arm "$arm" "$eng" cold --db "$PG_WALK" ${extra[@]+"${extra[@]}"}
      run_arm "$arm" "$eng" warm --db "$PG_WALK" ${extra[@]+"${extra[@]}"}
      stats "arm-$arm"
      ;;
    arm-BL)
      [[ $tier == personal ]] || { done_mark "$st"; continue; }
      rm -rf "$HOME/.capy/work/g123/run/pglite-$tier"
      GB_ENGINE_DIR=$GB_B bun eval/runner/graph-backend/pg-load.ts "$tier" "pglite:$HOME/.capy/work/g123/run/pglite-$tier" 2>>"$D/load-pglite.log" | tail -1 > "$D/load-pglite.json"
      drop=$(sync; sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'; echo ok)
      run_arm BL "$GB_B" cold --db "pglite:$HOME/.capy/work/g123/run/pglite-$tier"
      run_arm BL "$GB_B" warm --db "pglite:$HOME/.capy/work/g123/run/pglite-$tier"
      ;;
    arm-C)
      "$STACK" hydra-up
      "$STACK" cold hydra
      s=$(strategy); log "C strategy $s"
      run_arm C "$GB_B" cold --db "$PG_WALK" --strategy "$s"
      run_arm C "$GB_B" warm --db "$PG_WALK" --strategy "$s"
      stats arm-C
      ;;
    tput)
      [[ $tier == team ]] || { done_mark "$st"; continue; }
      "$STACK" hydra-stop
      run_arm B "$GB_B" tput8 --db "$PG_WALK" --starts 100 --concurrency 8
      "$STACK" hydra-up
      run_arm C "$GB_B" tput8 --db "$PG_WALK" --starts 100 --concurrency 8 --strategy "$(strategy)"
      ;;
    *) echo "unknown stage $st" >&2; exit 2 ;;
  esac
  done_mark "$st"
done
log "tier $tier complete"
