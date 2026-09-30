#!/usr/bin/env bash
# Watchdog: wd.sh <name> <progress-dir> <command...>
# Runs the command, kills and resumes it when no file under <progress-dir>
# changed for STALL_SECS (default 900), and stops on a budget refusal.
# Every restart is appended to $ED/logs/<name>.watchdog.txt. Staleness is
# measured from the later of the newest progress file and the attempt's start,
# so files left from before a restart never trigger an immediate kill.
set -u
name=$1; prog=$2; shift 2
log="$ED/logs/$name.log"; wlog="$ED/logs/$name.watchdog.txt"
mkdir -p "$ED/logs" "$prog"
for attempt in $(seq 1 12); do
  "$@" >> "$log" 2>&1 &
  pid=$!
  started=$(date +%s)
  while kill -0 $pid 2>/dev/null; do
    sleep 30
    newest=$(find "$prog" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
    newest=${newest:-$started}; [ "$newest" -lt "$started" ] && newest=$started
    age=$(( $(date +%s) - newest ))
    if [ "$age" -gt "${STALL_SECS:-900}" ]; then
      echo "$(date -u +%FT%TZ) attempt=$attempt stall ${age}s; killing" >> "$wlog"
      kill -9 $pid 2>/dev/null; pkill -9 -P $pid 2>/dev/null; sleep 5
    fi
  done
  wait $pid; rc=$?
  echo "$(date -u +%FT%TZ) attempt=$attempt rc=$rc" >> "$wlog"
  [ $rc -eq 0 ] && exit 0
  grep -q "BudgetExceededError" "$log" && { echo "budget refusal; stopping" >> "$wlog"; exit 3; }
done
exit 1
