#!/usr/bin/env bash
# ubi-runner — run a command on an ephemeral Ubicloud VM.
#
#   UBICLOUD_API_KEY=... scripts/ubicloud/ubi-runner.sh run --setup S.sh -- 'make test'
#
# UBICLOUD_API_TOKEN is accepted as an alias for UBICLOUD_API_KEY. SSH
# connections are multiplexed per VM, and `pack` / `unpack` upload one prebuilt
# checkout tarball to many VMs. (Kept in sync with gbrain's
# scripts/ubicloud/ubi-runner.sh.)
#
# Creates a VM (standard-16 by default), streams the checkout to it (tracked +
# untracked-unignored files + .git, so uncommitted edits are included), runs an
# optional setup script and the command, copies requested artifacts back, and
# destroys the VM on every exit path. Exits with the command's status. The command runs detached on the VM
# (setsid/nohup, log and exit status in files there) and this side follows its log over short ssh calls, so a
# dropped session is retried instead of killing the command; an exit before the command ended (a signal, a
# timeout) stops the command and pulls its output before the VM is destroyed. A VM unreachable for
# UBI_FOLLOW_LOST_SECONDS is left running (exit 255) for a reattach watcher.
# A final pull that still fails after UBI_PULL_TRIES tries keeps the VM too (exit 253), so its output can be pulled
# again; a push or sync is retried UBI_PUSH_TRIES times.
# Needs only bash, curl, python3, ssh, ssh-keygen, and tar locally, so it works
# from dev boxes, containers, and cloud sandboxes.
#
# Ownership: VMs are named ubirun-<owner>-<epoch>-<suffix>. <owner> is UBI_OWNER
# (lowercased, letters and digits only, at most 12 characters, starting with a
# letter) or a random per-machine id kept in $STATE_ROOT/owner-id. Ubicloud names
# allow 63 characters of [a-z0-9-], so a full name stays under 40.
#
# Teardown: `up` records each VM's state (location, create status) before it
# sends the create request, and `down` destroys and polls until the VM is
# confirmed gone or provably never existed, waiting out a create that may still
# be in flight. An interrupted `up` or `run` (EXIT, INT, TERM, HUP, QUIT) runs
# that `down`; further signals are ignored until it finishes. A create refused
# for vCPU quota prints the project's usage per owner.
#
# Stale-VM sweeps are off by default. With UBI_GC_HOURS set to a positive
# number, every `up` first destroys this owner's VMs older than that; `gc HOURS`
# runs the same sweep on demand. Neither ever touches another owner's VMs.
set -euo pipefail
# Keep heredoc bodies on temp files, not the pipe window (test/heredoc-pipe-deadlock.test.ts).
BASH_COMPAT=50

API="${UBICLOUD_API_URL:-https://api.ubicloud.com}"
STATE_ROOT="${UBI_RUNNER_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/ubi-runner}"
DEFAULT_SIZE="${UBI_SIZE:-standard-16}"
DEFAULT_LOCATION="${UBI_LOCATION:-eu-central-h1}"
GC_HOURS="${UBI_GC_HOURS:-0}"
API_TIMEOUT="${UBI_API_TIMEOUT:-120}"
CREATE_GRACE="${UBI_CREATE_GRACE:-180}"
DOWN_TIMEOUT="${UBI_DOWN_TIMEOUT:-900}"
POLL="${UBI_POLL_SECONDS:-5}"
FOLLOW_EVERY="${UBI_FOLLOW_SECONDS:-15}"
FOLLOW_LOST="${UBI_FOLLOW_LOST_SECONDS:-3600}"
STOP_WAIT="${UBI_STOP_WAIT_SECONDS:-600}"
PULL_TIMEOUT="${UBI_PULL_TIMEOUT_SECONDS:-1800}"
# A23: a final pull is tried UBI_PULL_TRIES times before the VM is kept for a later pull (exit 253), and a push or
# sync whose stream fails (the custodian saw "tar: Write error") UBI_PUSH_TRIES times.
PULL_TRIES="${UBI_PULL_TRIES:-3}"
PUSH_TRIES="${UBI_PUSH_TRIES:-3}"
PREFIX="ubirun"
# macOS tar would otherwise add AppleDouble (._*) entries for extended attributes to every archive it writes.
export COPYFILE_DISABLE=1

die() { echo "ubi-runner: $*" >&2; exit 1; }
log() { echo "ubi-runner: $*" >&2; }

for bin in curl python3 ssh ssh-keygen tar; do
  command -v "$bin" >/dev/null || die "$bin is required"
done
UBICLOUD_API_KEY="${UBICLOUD_API_KEY:-${UBICLOUD_API_TOKEN:-}}"
[[ "$GC_HOURS" =~ ^[0-9]+$ ]] || die "UBI_GC_HOURS must be a whole number of hours (unset or 0 disables the sweep)"

owner_id() {
  local raw=${UBI_OWNER:-} file="$STATE_ROOT/owner-id" tmp
  if [ -z "$raw" ]; then
    if [ ! -s "$file" ]; then
      mkdir -p "$STATE_ROOT"
      tmp="$file.$$"
      echo "m$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$tmp"
      mv -n "$tmp" "$file"
      rm -f "$tmp"
    fi
    raw=$(cat "$file")
  fi
  raw=$(printf %s "$raw" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
  [ -n "$raw" ] || die "UBI_OWNER must contain letters or digits"
  [[ "$raw" =~ ^[a-z] ]] || raw="u$raw"
  echo "${raw:0:12}"
}
OWNER=$(owner_id)

# api OUT ARGS...: send one Ubicloud CLI command, write the body to OUT, and
# print the HTTP status (000 when no response arrived).
api() {
  local out=$1 code
  shift
  code=$(python3 -c 'import json,sys; print(json.dumps({"argv": sys.argv[1:]}))' "$@" \
    | curl -sS -o "$out" -w '%{http_code}' --max-time "$API_TIMEOUT" -X POST \
        -H "Authorization: Bearer $UBICLOUD_API_KEY" \
        -H 'Accept: text/plain' -H 'Content-Type: application/json' \
        -H 'X-Ubi-Version: 1.0.0' --data @- "$API/cli") || true
  echo "${code:-000}"
}

cli() {
  local out code
  out=$(mktemp)
  code=$(api "$out" "$@")
  if [ "$code" = 000 ]; then
    rm -f "$out"
    die "request failed: ubi $*"
  fi
  if [ "$code" != 200 ]; then
    cat "$out" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

state_dir() { echo "$STATE_ROOT/$1"; }

# ctl_path DIR: the ssh ControlMaster socket of the VM whose state is DIR. A socket path holds at most 104 bytes on
# macOS (108 on Linux), and ssh first binds a temporary name 17 bytes longer, so a long state root or VM name (the
# custodian's keep2 runner, A23) breaks every ssh call. A path that would not fit moves to a short per-user directory,
# named by a hash of DIR.
ctl_path() {
  local p="$1/ctl" d h
  if [ ${#p} -le 80 ]; then echo "$p"; return; fi
  d="/tmp/ubi-ctl-$(id -u)"
  mkdir -p "$d" && chmod 700 "$d"
  if command -v sha256sum >/dev/null 2>&1; then h=$(printf %s "$1" | sha256sum); else h=$(printf %s "$1" | shasum -a 256); fi
  echo "$d/${h:0:32}"
}

load() {
  local dir
  dir=$(state_dir "$1")
  [ -f "$dir/env" ] || die "no local state for VM '$1' (created on another machine?)"
  # shellcheck disable=SC1091
  . "$dir/env"
  KEY="$dir/key"
}

ssh_opts() {
  echo -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=10 \
    -o ControlMaster=auto -o "ControlPath=$(ctl_path "$(dirname "$KEY")")" -o ControlPersist=300
}

# Ubuntu's default umask (002) leaves new directories group-writable, which
# permission-checking code under test rejects; every remote command uses 022.
remote() {
  local name=$1; shift
  load "$name"
  # shellcheck disable=SC2046
  ssh $(ssh_opts) "ubi@$IP" "umask 022; $*"
}

# vm_rows: "location name owner" for every VM in the project; owner is
# "-" for untagged ubirun-<epoch>-* names and "." for VMs this runner did not name.
vm_rows() {
  cli vm list -N -f location,name | while read -r loc name; do
    if [[ "$name" =~ ^${PREFIX}-([a-z][a-z0-9]{0,11})-[0-9]{10}- ]]; then
      echo "$loc $name ${BASH_REMATCH[1]}"
    elif [[ "$name" =~ ^${PREFIX}-[0-9]{10}- ]]; then
      echo "$loc $name -"
    else
      echo "$loc $name ."
    fi
  done
}

cmd_gc() {
  local hours=${1:-$GC_HOURS} now loc name owner
  if ! [[ "$hours" =~ ^[0-9]+$ ]] || [ "$hours" -eq 0 ]; then die "gc: give HOURS > 0 (or set UBI_GC_HOURS)"; fi
  now=$(date +%s)
  vm_rows | while read -r loc name owner; do
    [ "$owner" = "$OWNER" ] || continue
    [[ "$name" =~ -([0-9]{10})- ]] || continue
    if [ $(( (now - BASH_REMATCH[1]) / 3600 )) -ge "$hours" ]; then
      log "destroying stale $loc/$name (owner $OWNER, older than ${hours}h)"
      cmd_down "$name" -l "$loc" || log "failed to destroy $loc/$name"
    fi
  done
}

cmd_list() {
  case ${1:-} in
    "") cli vm list ;;
    --mine) vm_rows | awk -v o="$OWNER" '$3==o {print $1 "  " $2}' ;;
    *) die "list: unknown option $1 (use --mine)" ;;
  esac
}

# usage: VMs and vCPUs per owner, from each VM's size (standard-16 = 16 vCPUs).
cmd_usage() {
  local tmp loc name owner i=0
  tmp=$(mktemp -d)
  while read -r loc name owner; do
    i=$(( i + 1 ))
    cli vm "$loc/$name" show 2>/dev/null | sed -n "s/^size: /$owner /p" >"$tmp/$i" &
    [ $(( i % 8 )) -ne 0 ] || wait
  done < <(vm_rows)
  wait
  cat "$tmp"/* 2>/dev/null | awk -v me="$OWNER" '
    { n = $2; sub(/^.*-/, "", n); o = $1 == "-" ? "(untagged)" : $1 == "." ? "(other)" : $1
      vms[o]++; cpu[o] += n; total += n; count++ }
    END {
      printf "%-14s %4s %6s\n", "OWNER", "VMS", "VCPUS"
      for (o in cpu) printf "%-14s %4d %6d%s\n", o, vms[o], cpu[o], o == me ? "  (you)" : "" | "sort -k3,3nr"
      close("sort -k3,3nr")
      printf "%-14s %4d %6d\n", "total", count, total
    }'
  rm -rf "$tmp"
}

write_state() {
  printf 'NAME=%q\nLOCATION=%q\nSIZE=%q\nIP=%q\nCREATED=%q\nCREATE_AT=%q\nCREATE_PID=%q\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$$" >"$(state_dir "$1")/env"
}

new_name() { echo "$PREFIX-$OWNER-$(date +%s)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

valid_name() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; }

UP_NAME=""
UP_READY=""
cmd_up() {
  local size=$DEFAULT_SIZE location=$DEFAULT_LOCATION name="" storage="" image=ubuntu-noble
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size) size=$2; shift 2 ;;
      -l|--location) location=$2; shift 2 ;;
      -n|--name) name=$2; shift 2 ;;
      -S|--storage) storage=$2; shift 2 ;;
      -b|--image) image=$2; shift 2 ;;
      *) die "up: unknown option $1" ;;
    esac
  done
  [ -n "$name" ] || name=$(new_name)
  valid_name "$name" || die "invalid VM name '$name' (Ubicloud allows 1-63 of a-z, 0-9 and '-', starting and ending with a letter or digit)"
  if [ "$GC_HOURS" -gt 0 ]; then
    cmd_gc "$GC_HOURS" || log "stale-VM cleanup failed; continuing"
  fi

  local dir create_at
  dir=$(state_dir "$name")
  mkdir -p "$dir"
  chmod 700 "$dir"
  ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$dir/key"

  local args=(vm "$location/$name" create -s "$size" -b "$image")
  [ -z "$storage" ] || args+=(-S "$storage")
  args+=("$(cat "$dir/key.pub")")
  create_at=$(date +%s)
  write_state "$name" "$location" "$size" "" unknown "$create_at"
  UP_NAME=$name
  log "creating $location/$name ($size)"
  # Hold signals until the create answer is recorded, so teardown knows
  # whether the VM exists instead of waiting out UBI_CREATE_GRACE.
  local interrupted="" created=yes refusal need used max
  trap 'interrupted=1' INT TERM HUP QUIT
  cli "${args[@]}" >/dev/null 2>"$dir/create.err" || created=no
  write_state "$name" "$location" "$size" "" "$created" "$create_at"
  trap 'exit 130' INT TERM HUP QUIT
  [ -z "$interrupted" ] || exit 130
  if [ "$created" = no ]; then
    refusal=$(sed -n 's/.*Requested vCPU count: \([0-9]*\), currently used vCPU count: \([0-9]*\), maximum allowed vCPU count: \([0-9]*\).*/\1 \2 \3/p' "$dir/create.err")
    if [ -z "$refusal" ]; then
      cat "$dir/create.err" >&2
      die "create failed"
    fi
    read -r need used max <<<"$refusal"
    log "quota refused $location/$name ($size): it needs $need vCPUs and the project already uses $used of $max"
    log "VMs in the project by owner (the rest of the used count is other usage, such as managed GitHub runners):"
    cmd_usage >&2 || true
    die "create failed: vCPU quota exhausted; wait for running VMs to finish, or use fewer or smaller VMs (ci:ubicloud --vms N)"
  fi

  local deadline=$(( $(date +%s) + 600 )) show state ip
  while :; do
    show=$(cli vm "$location/$name" show 2>/dev/null || true)
    state=$(sed -n 's/^state: //p' <<<"$show")
    ip=$(sed -n 's/^ip4: //p' <<<"$show")
    [ "$state" = running ] && [ -n "$ip" ] && break
    [ "$(date +%s)" -lt "$deadline" ] || die "VM did not reach running in 10 minutes (last state: ${state:-unknown})"
    sleep "$POLL"
  done
  write_state "$name" "$location" "$size" "$ip" yes "$create_at"

  load "$name"
  deadline=$(( $(date +%s) + 300 ))
  # shellcheck disable=SC2046
  until ssh $(ssh_opts) "ubi@$IP" true 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || die "SSH did not come up on $IP"
    sleep "$POLL"
  done
  remote "$name" 'cloud-init status --wait >/dev/null 2>&1 || true'
  UP_READY=1
  log "ready: $name ($IP)"
  echo "$name"
}

# down NAME [-l LOCATION]: destroy NAME and return 0 only once it is confirmed
# gone or never existed. While this machine's create request for NAME may
# still be in flight (its `up` process is alive, or the create was sent less
# than UBI_CREATE_GRACE seconds ago with no answer), "not found" is not final.
cmd_down() {
  local name=${1:-} loc="" dir
  [ -n "$name" ] || die "down: missing NAME"
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      -l|--location) loc=$2; shift 2 ;;
      *) die "down: unknown option $1" ;;
    esac
  done
  valid_name "$name" || die "invalid VM name '$name'"
  dir=$(state_dir "$name")
  local CREATED=none CREATE_AT=0 CREATE_PID="" IP="" LOCATION="" KEY=""
  if [ -f "$dir/env" ]; then
    load "$name"
    loc=$LOCATION
    if [ -S "$(ctl_path "$dir")" ] && [ -n "$IP" ]; then
      # shellcheck disable=SC2046
      ssh $(ssh_opts) -O exit "ubi@$IP" >/dev/null 2>&1 || true
    fi
  fi

  local deadline=$(( $(date +%s) + DOWN_TIMEOUT )) seen=0 asked=0 out code now
  out=$(mktemp)
  while :; do
    now=$(date +%s)
    if [ -z "$loc" ]; then
      loc=$(vm_rows 2>/dev/null | awk -v n="$name" '$2==n {print $1}') || loc=""
      code=404
      [ -z "$loc" ] || code=$(api "$out" vm "$loc/$name" show)
    else
      code=$(api "$out" vm "$loc/$name" show)
    fi
    if [ "$code" = 200 ]; then
      seen=1
      if [ $(( now - asked )) -ge 60 ]; then
        api "$out" vm "$loc/$name" destroy -f >/dev/null
        asked=$now
        log "destroy requested: $loc/$name"
      fi
    elif [ "$code" = 404 ]; then
      if [ "$seen" = 1 ] || [ "$CREATED" != unknown ] || { [ $(( now - CREATE_AT )) -ge "$CREATE_GRACE" ] \
        && { [ "$CREATE_PID" = "$$" ] || ! kill -0 "$CREATE_PID" 2>/dev/null; }; }; then
        rm -f "$out"
        rm -rf "$dir"
        if [ "$seen" = 1 ]; then log "destroyed ${loc:-?}/$name"; else log "gone: ${loc:-?}/$name (never existed or already destroyed)"; fi
        return 0
      fi
      log "waiting for an in-flight create of $name to resolve"
    fi
    if [ "$now" -ge "$deadline" ]; then
      rm -f "$out"
      log "WARNING: could not confirm ${loc:-?}/$name is gone after ${DOWN_TIMEOUT}s; rerun: $0 down $name"
      return 1
    fi
    sleep "$POLL"
  done
}

# pack SRC: write a gzipped checkout tarball to stdout (tracked + untracked
# files that are not ignored, plus .git; a non-git directory is taken whole).
cmd_pack() {
  local src
  src=$(cd "${1:-.}" && pwd)
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    (
      cd "$src"
      { git ls-files -z -co --exclude-standard; printf '.git\0'; } \
        | while IFS= read -r -d '' f; do
            if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
          done \
        | tar --null -T - -czf -
    )
  else
    tar -C "$src" -czf - .
  fi
}

# unpack NAME DEST: extract a tarball read from stdin into DEST on the VM.
cmd_unpack() {
  local qdest
  qdest=$(printf %q "$2")
  remote "$1" "mkdir -p $qdest && tar -xzf - -C $qdest"
}

# push NAME LOCAL_DIR REMOTE_DIR [LIST_FILE]: copy LOCAL_DIR (or only the relative paths LIST_FILE names) into
# REMOTE_DIR on the VM, replacing it, readable only by the VM user. Used for custody files that never enter the
# checkout tarball (A17: the custodian's BEAM-10M files, a sealed cell's restore snapshot).
cmd_push() {
  local name=$1 src=$2 dest=$3 list=${4:-} qdest
  [ -d "$src" ] || die "push: $src is not a directory"
  [ -z "$list" ] || [ -f "$list" ] || die "push: list file $list not found"
  qdest=$(printf %q "$dest")
  retry_stream "push to $dest" push_once "$name" "$src" "$qdest" "$list" || die "push to $dest failed after $PUSH_TRIES attempts"
  log "pushed ${list:+$(grep -c . "$list") listed file(s) from }$src -> $name:$dest"
}

push_once() {
  local name=$1 src=$2 qdest=$3 list=$4
  ( set -o pipefail
    if [ -n "$list" ]; then tar -C "$src" -T "$list" -czf -; else tar -C "$src" -czf - .; fi \
      | remote "$name" "umask 077 && rm -rf $qdest && mkdir -p $qdest && tar -xzf - -C $qdest" )
}

# retry_stream LABEL COMMAND...: run a whole tar stream again when either end fails. Each attempt replaces what the
# last one wrote, so a stream cut short ("tar: Write error", a dropped session) leaves nothing half-written behind.
retry_stream() {
  local label=$1 try; shift
  for (( try = 1; try <= PUSH_TRIES; try++ )); do
    "$@" && return 0
    [ "$try" -lt "$PUSH_TRIES" ] || break
    log "$label failed (attempt $try of $PUSH_TRIES); retrying in $(( try * 10 ))s"
    sleep $(( try * 10 ))
  done
  return 1
}

cmd_sync() {
  local name=$1 src=${2:-.} dest=${3:-}
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"
  retry_stream "sync to $dest" sync_once "$name" "$src" "$dest" || die "sync to $dest failed after $PUSH_TRIES attempts"
  log "synced $src -> $name:$dest"
}

sync_once() { ( set -o pipefail; cmd_pack "$2" | cmd_unpack "$1" "$3" ); }

# pull NAME REMOTE_GLOB LOCAL_DIR: copy matching remote entries into LOCAL_DIR.
# Relative remote paths start at /home/ubi.
# pull_lock DIR: take the VM's pull lock, waiting out another pull of the same
# VM and breaking a lock whose holder died. Returns 1, holding nothing, when the
# run's final pull has begun and this is not it (a periodic pull is then moot).
pull_lock() {
  local dir=$1 holder
  while :; do
    [ -n "${UBI_FINAL_PULL:-}" ] || [ ! -e "$dir/final-pull" ] || return 1
    if mkdir "$dir/pull.lock" 2>/dev/null; then
      echo $$ >"$dir/pull.lock/pid"
      [ -n "${UBI_FINAL_PULL:-}" ] || [ ! -e "$dir/final-pull" ] || { rm -rf "$dir/pull.lock"; return 1; }
      return 0
    fi
    holder=$(cat "$dir/pull.lock/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$dir/pull.lock"; continue; fi
    sleep 1
  done
}

# Pulls of one VM never overlap: a periodic pull and the run's final pull take
# the VM's pull lock in turn, and a periodic pull that comes after the final
# pull has begun is skipped instead of racing it into the same directory.
#
# A pull extracts into a temporary directory beside LOCAL_DIR and moves each entry into place only after the whole
# stream arrived and both tar ends exited 0, so a pull cut short (a VM destroyed mid-transfer, a dropped session)
# leaves the previous copy untouched instead of truncated files.
cmd_pull() {
  local name=$1 from=$2 to=$3 dir rc=0 tmp e job
  dir=$(state_dir "$name")
  [ -f "$dir/env" ] || die "no local state for VM '$name' (created on another machine?)"
  pull_lock "$dir" || { log "pull of $from skipped: the run's final pull of $name has begun"; return 0; }
  mkdir -p "$to"
  tmp=$(mktemp -d "$to/.pull-XXXXXX")
  # The transfer runs in its own process group. Stopped by a signal (with_timeout, A23), the pull ends that whole group
  # (ssh, tar and their children) and removes its scratch copy and lock; killed alone, they ran on as orphans writing
  # into the scratch directory.
  set -m
  ( set -o pipefail; remote "$name" "cd $(printf %q "$(dirname "$from")") && tar -czf - $(basename "$from")" | tar -xzf - -C "$tmp" ) &
  job=$!
  set +m
  trap 'kill -TERM -- "-$job" 2>/dev/null || true; wait "$job" 2>/dev/null || true; rm -rf "$tmp" "$dir/pull.lock"; exit 143' TERM INT
  wait "$job" || rc=$?
  trap - TERM INT
  if [ "$rc" = 0 ]; then
    for e in "$tmp"/* "$tmp"/.[!.]*; do
      [ -e "$e" ] || [ -L "$e" ] || continue
      rm -rf "$to/.old-$(basename "$e")"
      [ ! -e "$to/$(basename "$e")" ] || mv "$to/$(basename "$e")" "$to/.old-$(basename "$e")"
      mv "$e" "$to/$(basename "$e")"
      rm -rf "$to/.old-$(basename "$e")"
    done
  else
    log "pull of $from from $name failed (exit $rc); kept the previous copy in $to"
  fi
  rm -rf "$tmp" "$dir/pull.lock"
  return "$rc"
}

# detach NAME DEST COMMAND: start COMMAND on the VM in DEST under setsid/nohup, sourcing ~/.ubirun-env, with its
# output in ~/.ubirun-cmd.log and its exit status written to ~/.ubirun-cmd.rc when it ends. A dropped ssh session
# never reaches it: it has no controlling terminal and no pipe back to this side.
cmd_detach() {
  local name=$1 dest=$2 cmd=$3 script
  # The wrapper forwards SIGTERM to the command and still records its status when the command ends.
  script='echo $$ > ~/.ubirun-cmd.pid; . ~/.ubirun-env; bash -lc "$1" & c=$!; trap "kill -TERM $c 2>/dev/null" TERM; while :; do wait $c; rc=$?; kill -0 $c 2>/dev/null || break; done; echo $rc > ~/.ubirun-cmd.rc.tmp; mv ~/.ubirun-cmd.rc.tmp ~/.ubirun-cmd.rc'
  remote "$name" "rm -f ~/.ubirun-cmd.rc ~/.ubirun-cmd.rc.tmp ~/.ubirun-cmd.log ~/.ubirun-cmd.pid && cd $(printf %q "$dest") && (setsid nohup bash -c $(printf %q "$script") ubirun-cmd $(printf %q "$cmd") > ~/.ubirun-cmd.log 2>&1 < /dev/null &)"
}

# follow NAME: copy the detached command's log to stdout as it grows and return its exit status. Each check is its
# own short ssh call; a failed call is retried every UBI_FOLLOW_SECONDS, and only after UBI_FOLLOW_LOST_SECONDS
# without one success does follow give up with status 255 (the command may still be running on the VM).
cmd_follow() {
  local name=$1 off=0 rc="" n tmp miss=0 now
  tmp=$(mktemp)
  while :; do
    if remote "$name" "tail -c +$((off + 1)) ~/.ubirun-cmd.log 2>/dev/null; true" >"$tmp" 2>/dev/null; then
      n=$(wc -c <"$tmp" | tr -d ' ')
      cat "$tmp"
      off=$((off + n))
      miss=0
      [ -z "$rc" ] || break
      rc=$(remote "$name" "cat ~/.ubirun-cmd.rc 2>/dev/null; true" 2>/dev/null | tr -dc '0-9') || rc=""
      [ -n "$rc" ] || sleep "$FOLLOW_EVERY"
      continue
    fi
    now=$(date +%s)
    [ "$miss" != 0 ] || { miss=$now; log "lost the ssh session to $name; retrying every ${FOLLOW_EVERY}s (the command keeps running there)"; }
    if (( now - miss >= FOLLOW_LOST )); then rm -f "$tmp"; log "no ssh session to $name for ${FOLLOW_LOST}s"; return 255; fi
    sleep "$FOLLOW_EVERY"
  done
  rm -f "$tmp"
  return "$rc"
}

# stop_detached NAME: ask the detached command to stop (SIGTERM through its wrapper) and wait up to
# UBI_STOP_WAIT_SECONDS for its exit status, so its own shutdown (final checkpoint, lease summary) runs first.
stop_detached() {
  local name=$1 waited=0
  remote "$name" "[ -f ~/.ubirun-cmd.rc ] || kill -TERM \$(cat ~/.ubirun-cmd.pid 2>/dev/null) 2>/dev/null || true" >/dev/null 2>&1 || return 0
  while (( waited < STOP_WAIT )); do
    remote "$name" "[ -f ~/.ubirun-cmd.rc ]" >/dev/null 2>&1 && return 0
    sleep "$FOLLOW_EVERY"; waited=$((waited + FOLLOW_EVERY))
  done
  log "the command on $name did not stop within ${STOP_WAIT}s"
}

# with_timeout SECONDS CMD...: run CMD (a function or program), stopping it after SECONDS (macOS has no timeout(1)).
with_timeout() {
  local t=$1 pid w rc=0; shift
  "$@" & pid=$!
  ( sleep "$t"; kill -TERM "$pid" 2>/dev/null ) & w=$!
  wait "$pid" || rc=$?
  kill "$w" 2>/dev/null || true; wait "$w" 2>/dev/null || true
  return "$rc"
}

# final_pulls: the run's --pull list, each under the VM's pull lock and at most UBI_PULL_TIMEOUT_SECONDS a try, tried
# UBI_PULL_TRIES times. When one still fails, the VM is kept (never destroyed with output not yet brought back, A23) and
# final_pulls returns 1; pull it again with `pull`, then `down`.
final_pulls() {
  local p try ok failed=0
  if [ ${#RUN_PULLS[@]} -gt 0 ]; then
    touch "$(state_dir "$RUN_VM")/final-pull"
    for p in "${RUN_PULLS[@]}"; do
      ok=0
      for (( try = 1; try <= PULL_TRIES; try++ )); do
        if UBI_FINAL_PULL=1 with_timeout "$PULL_TIMEOUT" cmd_pull "$RUN_VM" "${p%%:*}" "${p#*:}"; then ok=1; break; fi
        [ "$try" -lt "$PULL_TRIES" ] || break
        log "final pull of ${p%%:*} failed (attempt $try of $PULL_TRIES); retrying in $(( try * 30 ))s"
        sleep $(( try * 30 ))
      done
      [ "$ok" = 1 ] || { failed=1; log "pull failed after $PULL_TRIES attempts: $p"; }
    done
  fi
  RUN_PULLED=1
  [ "$failed" = 1 ] || return 0
  RUN_KEEP=1
  rm -f "$(state_dir "$RUN_VM")/final-pull"
  log "keeping $RUN_VM because its output did not come back; pull it with: $0 pull $RUN_VM <remote> <local dir>, then destroy it with: $0 down $RUN_VM"
  return 1
}

# run_exit: the run's EXIT handler. When the command had started and its final pulls had not, it stops the command
# and pulls first (a timeout, a signal or an error still brings the rows back), then destroys the VM.
run_exit() {
  trap "" INT TERM HUP QUIT
  if [ "${RUN_STARTED:-0}" = 1 ] && [ "${RUN_PULLED:-0}" = 0 ] && [ "${RUN_LOST:-0}" = 0 ]; then
    log "stopping the command on $RUN_VM and pulling its output before teardown"
    stop_detached "$RUN_VM" || true
    final_pulls || true
  fi
  [ "${RUN_KEEP:-0}" = 1 ] || cmd_down "$RUN_VM" || log "WARNING: failed to destroy $RUN_VM; run: $0 down $RUN_VM"
}

cmd_run() {
  local up_args=() src=. dest="" setup="" keep=0 pulls=() envs=() pushes=()
  while [ $# -gt 0 ]; do
    case $1 in
      -s|--size|-l|--location|-n|--name|-S|--storage|-b|--image) up_args+=("$1" "$2"); shift 2 ;;
      --src) src=$2; shift 2 ;;
      --dest) dest=$2; shift 2 ;;
      --setup) setup=$2; shift 2 ;;
      --env) envs+=("$2"); shift 2 ;;
      --pass) [ -n "${!2+x}" ] || die "--pass $2: not set locally"; envs+=("$2=${!2}"); shift 2 ;;
      --pull) pulls+=("$2"); shift 2 ;;
      --push) pushes+=("$2"); shift 2 ;;
      --keep) keep=1; shift ;;
      --) shift; break ;;
      *) die "run: unknown option $1" ;;
    esac
  done
  [ $# -gt 0 ] || die "run: missing command after --"
  RUN_PULLS=(${pulls[@]+"${pulls[@]}"}) RUN_KEEP=$keep RUN_STARTED=0 RUN_PULLED=0 RUN_LOST=0
  [ -z "$setup" ] || [ -f "$setup" ] || die "setup script not found: $setup"
  src=$(cd "$src" && pwd)
  [ -n "$dest" ] || dest="work/$(basename "$src")"

  local i name=""
  for (( i = 0; i < ${#up_args[@]}; i += 2 )); do
    case ${up_args[i]} in -n|--name) name=${up_args[i+1]} ;; esac
  done
  [ -n "$name" ] || { name=$(new_name); up_args+=(-n "$name"); }
  RUN_VM=$name
  # Armed before the create request: an interrupted `up` still destroys its VM.
  # A second signal must not cut teardown short, so the EXIT handler ignores them.
  trap run_exit EXIT
  trap 'exit 130' INT TERM HUP QUIT
  cmd_up "${up_args[@]}" >/dev/null
  [ "$keep" = 0 ] || log "--keep: leaving $name running; destroy with: $0 down $name"

  local e
  for e in ${envs[@]+"${envs[@]}"}; do printf 'export %s=%q\n' "${e%%=*}" "${e#*=}"; done \
    | remote "$name" 'umask 077 && cat > ~/.ubirun-env'

  cmd_sync "$name" "$src" "$dest"
  local qdest p rest
  qdest=$(printf %q "$dest")
  for p in ${pushes[@]+"${pushes[@]}"}; do
    rest=${p#*:}
    if [ "$rest" = "${rest#*:}" ]; then cmd_push "$name" "${p%%:*}" "$rest"; else cmd_push "$name" "${p%%:*}" "${rest%%:*}" "${rest#*:}"; fi
  done
  if [ -n "$setup" ]; then
    remote "$name" 'cat > ~/.ubirun-setup.sh' <"$setup"
    log "running setup $(basename "$setup")"
    remote "$name" "cd $qdest && . ~/.ubirun-env && bash -l ~/.ubirun-setup.sh" || die "setup failed"
  fi

  local start rc=0
  start=$(date +%s)
  log "running on $name (detached; output follows): $*"
  cmd_detach "$name" "$dest" "$*" || die "could not start the command on $name"
  RUN_STARTED=1
  cmd_follow "$name" || rc=$?
  if [ "$rc" = 255 ]; then
    RUN_LOST=1 RUN_KEEP=1
    log "lost $name; it is left running for a reattach watcher (eval/runner/q1/reattach.ts) or: $0 down $name"
    return 255
  fi
  log "command exited $rc after $(( $(date +%s) - start ))s"

  final_pulls || return 253
  [ "$keep" = 0 ] || rm -f "$(state_dir "$name")/final-pull"
  return "$rc"
}

usage() {
  cat <<EOF
usage: ubi-runner.sh <command> [args]

  run [up opts] [--src DIR] [--dest PATH] [--setup FILE] [--env K=V]...
      [--pass NAME]... [--push LOCAL_DIR:REMOTE_DIR[:LIST_FILE]]...
      [--pull REMOTE_GLOB:LOCAL_DIR]... [--keep] -- COMMAND
                         up + sync + push + setup + command + pull + destroy; exits with COMMAND's status
  up [-s SIZE] [-l LOCATION] [-n NAME] [-S STORAGE_GIB] [-b IMAGE]
                         create a VM and wait for SSH; prints its name
  ssh NAME [COMMAND]     shell or login-shell command on the VM (user ubi, passwordless sudo)
  sync NAME [SRC] [DEST] stream a checkout (tracked + untracked-unignored + .git)
  pack [SRC]             write that checkout tarball to stdout
  unpack NAME DEST       extract a tarball from stdin into DEST on the VM
  push NAME LOCAL_DIR REMOTE_DIR [LIST_FILE]
                         replace REMOTE_DIR with LOCAL_DIR (or the listed relative paths), mode 0700
  pull NAME REMOTE_GLOB LOCAL_DIR
                         copy matching remote entries into LOCAL_DIR; waits for another
                         pull of NAME, and is skipped once a run's final pull has begun;
                         entries are replaced only after the whole transfer arrived
  detach NAME DEST COMMAND
                         start COMMAND on the VM under setsid/nohup (log ~/.ubirun-cmd.log,
                         exit status ~/.ubirun-cmd.rc); a dropped session never reaches it
  follow NAME            print the detached command's log as it grows; exit with its status
                         (255 after UBI_FOLLOW_LOST_SECONDS without an ssh session)
  stop NAME              SIGTERM the detached command and wait for its exit status
  down NAME [-l LOC]     destroy the VM; returns once it is confirmed gone or never existed
  list [--mine]          list all VMs in the project, or only this owner's
  usage                  VMs and vCPUs per owner across the project
  owner                  print this caller's owner tag ($OWNER)
  gc HOURS               destroy this owner's VMs older than HOURS (never other owners')
  cli ARGS...            raw Ubicloud CLI passthrough (e.g. cli vm list)

VMs are named $PREFIX-<owner>-<epoch>-<suffix>; set UBI_OWNER (e.g. your thread
code) to tag them, otherwise a per-machine id is used.
defaults: size=$DEFAULT_SIZE location=$DEFAULT_LOCATION (env UBI_SIZE, UBI_LOCATION)
env: UBI_GC_HOURS (unset/0: no sweep on up), UBI_CREATE_GRACE (${CREATE_GRACE}s),
     UBI_DOWN_TIMEOUT (${DOWN_TIMEOUT}s), UBI_API_TIMEOUT (${API_TIMEOUT}s)
EOF
}

cmd=${1:-help}
[ $# -eq 0 ] || shift
case $cmd in
  owner|pack|help|-h|--help) ;;
  *) [ -n "${UBICLOUD_API_KEY:-}" ] || die "UBICLOUD_API_KEY is not set (create a token under your Ubicloud project's Tokens page)" ;;
esac
case $cmd in
  run) cmd_run "$@" ;;
  up) trap 'trap "" INT TERM HUP QUIT; [ -z "$UP_NAME" ] || [ -n "$UP_READY" ] || cmd_down "$UP_NAME" || log "WARNING: failed to destroy $UP_NAME; run: $0 down $UP_NAME"' EXIT
      trap 'exit 130' INT TERM HUP QUIT
      cmd_up "$@" ;;
  ssh) name=$1; shift; load "$name"
       # shellcheck disable=SC2046
       if [ $# -eq 0 ]; then exec ssh -t $(ssh_opts) "ubi@$IP"; else remote "$name" "bash -lc $(printf %q "$*")"; fi ;;
  sync) cmd_sync "$@" ;;
  pack) cmd_pack "$@" ;;
  unpack) cmd_unpack "$@" ;;
  push) cmd_push "$@" ;;
  pull) cmd_pull "$@" ;;
  detach) cmd_detach "$@" ;;
  follow) cmd_follow "$@" ;;
  stop) stop_detached "$@" ;;
  down) cmd_down "$@" ;;
  list) cmd_list "$@" ;;
  usage) cmd_usage ;;
  owner) echo "$OWNER" ;;
  gc) cmd_gc "$@" ;;
  cli) cli "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
