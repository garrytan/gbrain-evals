#!/usr/bin/env bash
# Faster stall detector alongside watchdog-r.sh: kills the driver when the active arm's calls log is idle > 180 s
# (normal gap between logged paid calls is < 40 s). watchdog-r.sh then resumes the run. Kills are logged per arm.
cd $M6_DIR
while [ ! -f watchdog-r.done ]; do
  sleep 20
  P=$(pgrep -f "^bun driver-r") || continue
  ARM=$(tr '\0' ' ' < /proc/$P/environ 2>/dev/null | grep -o 'M6_CALLS=[^ ]*' | sed 's#.*/\(r[12]\)/calls.ndjson#\1#')
  [ -n "$ARM" ] || continue
  age=$(( $(date +%s) - $(stat -c %Y $ARM/calls.ndjson) ))
  up=$(( $(date +%s) - $(stat -c %Y /proc/$P) ))
  if [ $age -gt 180 ] && [ $up -gt 180 ]; then
    echo "$(date -u +%FT%TZ) fastkill stall ${age}s; last log: $(tail -1 $ARM/stderr.full.txt | cut -c1-200)" >> $ARM/watchdog.txt
    kill -9 $P
  fi
done
