#!/usr/bin/env bash
# Restarts arm (a) (resume) when no paid call has been logged for 600 s.
# Every kill is recorded in a/watchdog.log with the in-flight question.
cd $M6_DIR
source ~/.m6env; export PATH=$HOME/.bun/bin:$PATH
for attempt in $(seq 1 20); do
  ./run-a-full.sh &
  RUNPID=$!
  while kill -0 $RUNPID 2>/dev/null; do
    sleep 30
    age=$(( $(date +%s) - $(stat -c %Y a/calls.ndjson) ))
    if [ $age -gt 600 ]; then
      next=$(tail -1 a/stderr.full.log | cut -c1-200)
      echo "$(date -u +%FT%TZ) attempt=$attempt stall ${age}s; last log: $next; killing" >> a/watchdog.log
      pkill -9 -f "bun driver-a" ; sleep 5
    fi
  done
  if grep -q "^rc=0" <(tail -1 a/stderr.full.log); then echo "$(date -u +%FT%TZ) finished rc=0" >> a/watchdog.log; break; fi
  echo "$(date -u +%FT%TZ) attempt=$attempt ended: $(tail -1 a/stderr.full.log)" >> a/watchdog.log
done
