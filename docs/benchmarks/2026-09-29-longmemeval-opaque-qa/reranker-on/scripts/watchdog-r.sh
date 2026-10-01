#!/usr/bin/env bash
# Runs R1 then R2 sequentially (never two processes on one embed cache). Restarts (resume) when no paid
# call has been logged for 600 s; every kill is recorded in <arm>/watchdog.txt.
cd $M6_DIR
source ~/.m6env; export PATH=$HOME/.bun/bin:$PATH
for ARM in r1 r2; do
  touch $ARM/calls.ndjson
  for attempt in $(seq 1 20); do
    ./run-r.sh $ARM &
    RUNPID=$!
    while kill -0 $RUNPID 2>/dev/null; do
      sleep 30
      age=$(( $(date +%s) - $(stat -c %Y $ARM/calls.ndjson) ))
      if [ $age -gt 600 ]; then
        echo "$(date -u +%FT%TZ) attempt=$attempt stall ${age}s; last log: $(tail -1 $ARM/stderr.full.txt | cut -c1-200); killing" >> $ARM/watchdog.txt
        pkill -9 -f "bun driver-r" ; sleep 5
      fi
    done
    if tail -1 $ARM/stderr.full.txt | grep -q "^rc=0"; then echo "$(date -u +%FT%TZ) finished rc=0" >> $ARM/watchdog.txt; break; fi
    echo "$(date -u +%FT%TZ) attempt=$attempt ended: $(tail -1 $ARM/stderr.full.txt)" >> $ARM/watchdog.txt
    # rc=1 at run end with all rows present (e.g. an un-reranked-rows gate) must not loop forever
    n=$(grep -c '"question_id"' $ARM/rows.ndjson); if [ "$n" -ge 500 ] && ! pgrep -f "bun driver-r" >/dev/null; then echo "$(date -u +%FT%TZ) all 500 rows present; stopping retries" >> $ARM/watchdog.txt; break; fi
  done
done
echo done > watchdog-r.done
