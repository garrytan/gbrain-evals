#!/usr/bin/env python3
"""drive.py <machine-name> <world>...: runs each world's preregistered plan (next-confirm.ts plan --json) on this VM.

Machine steps first (ledger init once, check-world per world, freshness once). Then every world's oracle and its
slot builds start together; slot builds run one process per slot (--build-slot-ids i, budget one allowance each),
staggered so the first build of each gbrain root prepares the build tree alone. Each world then runs oracle-gate,
cells-baseline, the projection check (ledger projection + 10% <= cap), cells-wave, cells-fs. Every step writes
~/logs/<world>-<step>.done with its exit code; a failed step stops its world, a failed projection stops every world.
"""
import json, os, sqlite3, subprocess, sys, threading, time

E = os.path.expanduser('~/work/gbrain-evals')
LOGS = os.path.expanduser('~/logs')
ENV_SH = os.path.expanduser('~/run/common.sh')
MACHINE, WORLDS = sys.argv[1], sys.argv[2:]
SEALED_DIGESTS = {'s1': '561759a86819cda78184da4f22398daeee92f2ccd4b57fac89c8ed6ce6cb8fb8', 's2': '54d6ca94860c6401653d415afbb00ed69e7aae84dd8b228e9e76355e1b3d2dc6'}
PRICE = {'cells-baseline': 219.0, 'cells-wave': 219.0, 'cells-fs': 317.0, 'oracle': 28.0}
KIND = {'cells-baseline': 'gbrain', 'cells-wave': 'gbrain', 'cells-fs': 'fs', 'oracle': 'oracle'}
plans = {w: json.load(open(os.path.expanduser(f'~/run/plan-{w}.json'))) for w in WORLDS}
steps = {w: {s['id']: s for s in plans[w]['steps']} for w in WORLDS}
for w in WORLDS:
    for s in steps[w].values():
        s['argv'] = [SEALED_DIGESTS[w] if a == '<digest recorded in PREREG.md>' else a for a in s['argv']]
LEDGER = os.path.join(E, steps[WORLDS[0]]['oracle']['argv'][steps[WORLDS[0]]['oracle']['argv'].index('--budget-ledger') + 1])
launch_lock = threading.Lock()
state_lock = threading.Lock()
arm_runs = {}      # (world, step) -> budget run id
finished = set()   # (world, step) finished with exit 0
stop_all = threading.Event()
SLOT_PAR = threading.Semaphore(int(os.environ.get('SLOT_PAR', '5')))


def done_ok(name):
    f = os.path.join(LOGS, f'{name}.done')
    return os.path.exists(f) and open(f).read().strip() == '0'


def slot_run(name, argv):
    if done_ok(name):
        return 0
    with SLOT_PAR:
        return run(name, argv)



def log(msg):
    with open(os.path.join(LOGS, 'drive.log'), 'a') as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}\n")


def mark(name, rc):
    with open(os.path.join(LOGS, f'{name}.done'), 'w') as f:
        f.write(f'{rc}\n')
    log(f'{name} exit {rc}')


def ledger_runs():
    if not os.path.exists(LEDGER):
        return {}
    c = sqlite3.connect(f'file:{LEDGER}?mode=ro', uri=True)
    rows = c.execute('select run_id, runner, committed_usd, finished_at from runs').fetchall()
    c.close()
    return {r[0]: r for r in rows}


def committed_total():
    c = sqlite3.connect(f'file:{LEDGER}?mode=ro', uri=True)
    v = c.execute('select committed_usd from program').fetchone()[0]
    cap = c.execute('select program_cap_usd from caps order by seq desc limit 1').fetchone()[0]
    c.close()
    return v, cap


def run(name, argv, track=None):
    """Runs argv in the harness checkout with the env file sourced; returns the exit code."""
    cmd = f'. {ENV_SH} >/dev/null && exec ' + ' '.join("'" + a.replace("'", "'\\''") + "'" for a in argv)
    log(f'{name} start')
    with open(os.path.join(LOGS, f'{name}.log'), 'w') as out:
        if track is None:
            p = subprocess.Popen(['bash', '-c', cmd], cwd=E, stdout=out, stderr=subprocess.STDOUT)
        else:
            with launch_lock:
                before = set(ledger_runs())
                p = subprocess.Popen(['bash', '-c', cmd], cwd=E, stdout=out, stderr=subprocess.STDOUT)
                for _ in range(90):
                    new = [r for r in set(ledger_runs()) - before if r.startswith('cat40-model-ladder')]
                    if new or p.poll() is not None:
                        break
                    time.sleep(2)
                if new:
                    with state_lock:
                        arm_runs[track] = new[0]
                    log(f'{name} budget run {new[0]}')
        rc = p.wait()
    mark(name, rc)
    return rc


def projection(trigger):
    """Ledger committed plus what every unfinished priced step still needs, +10%, against the cap."""
    runs = ledger_runs()
    committed, cap = committed_total()
    measured = {}
    with state_lock:
        for (w, s), rid in arm_runs.items():
            if (w, s) in finished and rid in runs:
                measured.setdefault(KIND[s], []).append(runs[rid][2])
        need, rows = 0.0, []
        for w in WORLDS:
            for s in PRICE:
                if (w, s) in finished:
                    continue
                est = (sum(measured[KIND[s]]) / len(measured[KIND[s]])) if measured.get(KIND[s]) else PRICE[s]
                spent = runs[arm_runs[(w, s)]][2] if (w, s) in arm_runs and arm_runs[(w, s)] in runs else 0.0
                rows.append((w, s, round(est, 2), round(spent, 2)))
                need += max(est - spent, 0.0)
    total = committed + need
    ok = total * 1.10 <= cap
    rec = {'trigger': trigger, 'committed_usd': round(committed, 2), 'remaining_usd': round(need, 2), 'projection_usd': round(total, 2),
           'with_10pct_usd': round(total * 1.10, 2), 'cap_usd': cap, 'ok': ok, 'measured': {k: [round(x, 2) for x in v] for k, v in measured.items()}, 'rows': rows}
    with open(os.path.join(LOGS, 'projection.jsonl'), 'a') as f:
        f.write(json.dumps(rec) + '\n')
    log(f"projection after {trigger}: ${total:.2f} (+10% ${total * 1.1:.2f}) vs cap ${cap:.2f} -> {'ok' if ok else 'STOP'}")
    return ok


def slot_argv(w, arm, i):
    a = list(steps[w][f'slots-{arm}']['argv'])
    a[a.index('--budget-usd') + 1] = a[a.index('--slot-build-allowance-usd') + 1]
    a[a.index('--out') + 1] = a[a.index('--out') + 1] + f'/b{i}'
    return a + ['--build-slot-ids', str(i)]


def world_chain(w, slot_threads, oracle_thread):
    for t in slot_threads + [oracle_thread]:
        t.join()
    bad = [n for n in [f'{w}-slots-{arm}-{i}' for arm in ('wave', 'baseline') for i in range(5)] + [f'{w}-oracle']
           if open(os.path.join(LOGS, f'{n}.done')).read().strip() != '0']
    if bad:
        log(f'{w} stops: {bad} failed')
        mark(f'{w}-chain', 'prestep-failed')
        return
    with state_lock:
        finished.add((w, 'oracle'))
    if run(f'{w}-oracle-gate', steps[w]['oracle-gate']['argv']) != 0:
        mark(f'{w}-chain', 'oracle-gate-failed')
        return
    for s in ('cells-baseline', 'cells-wave', 'cells-fs'):
        if stop_all.is_set():
            mark(f'{w}-chain', 'stopped')
            return
        if run(f'{w}-{s}', steps[w][s]['argv'], track=(w, s)) != 0:
            mark(f'{w}-chain', f'{s}-failed')
            return
        with state_lock:
            finished.add((w, s))
        if s == 'cells-baseline' and not projection(f'{w} cells-baseline'):
            stop_all.set()
            mark(f'{w}-chain', 'projection-stop')
            return
    mark(f'{w}-chain', 0)


def main():
    os.makedirs(LOGS, exist_ok=True)
    first = steps[WORLDS[0]]
    if not os.path.exists(LEDGER):
        if run(f'{MACHINE}-ledger', first['ledger']['argv']) != 0:
            return
    for w in WORLDS:
        if done_ok(f'{w}-check-world'):
            continue
        if run(f'{w}-check-world', steps[w]['check-world']['argv']) != 0:
            log(f'{w} check-world failed: world void, nothing runs')
            return
    if not done_ok(f'{MACHINE}-freshness') and run(f'{MACHINE}-freshness', first['freshness']['argv']) != 0:
        log('freshness failed: stop')
        return
    oracles = {w: (threading.Thread(target=lambda: None) if done_ok(f'{w}-oracle') else threading.Thread(target=run, args=(f'{w}-oracle', steps[w]['oracle']['argv']), kwargs={'track': (w, 'oracle')})) for w in WORLDS}
    for t in oracles.values():
        t.start()
    slot_threads = {w: [] for w in WORLDS}
    order = [(w, arm, i) for w in WORLDS for i in range(5) for arm in ('wave', 'baseline')]
    for w, arm, i in order:
        t = threading.Thread(target=slot_run, args=(f'{w}-slots-{arm}-{i}', slot_argv(w, arm, i)))
        t.start()
        slot_threads[w].append(t)
        time.sleep(2)
    chains = [threading.Thread(target=world_chain, args=(w, slot_threads[w], oracles[w])) for w in WORLDS]
    for t in chains:
        t.start()
    for t in chains:
        t.join()
    log('drive done')
    mark(f'{MACHINE}-drive', 0)


if __name__ == '__main__':
    main()
