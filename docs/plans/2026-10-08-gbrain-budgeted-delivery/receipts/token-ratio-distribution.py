import gzip, json, statistics as st, sys

FILES = {
    'LongMemEval-S slice': 'keyless-replay-lme-s-100.json.gz',
    'LoCoMo dev': 'keyless-replay-locomo-dev.json.gz',
}
CONFIGS = ['auto8k_l25', 'auto24k_l25', 'auto8k_l5']
MARGIN = 1.02
TARGET = 8000

for name, path in FILES.items():
    rows = json.load(gzip.open(path))
    worst = 0.0
    for k in CONFIGS:
        r = sorted(x[k]['harness_tokens_all'] / x[k]['budget_used'] for x in rows if x[k]['budget_used'] > 0)
        n = len(r)
        p99 = r[min(n - 1, int(0.99 * n))]
        worst = max(worst, r[-1])
        print(f"{name} {k}: n {n} mean {st.mean(r):.3f} median {r[n // 2]:.3f} p99 {p99:.3f} max {r[-1]:.3f} above-1.15 {sum(v > 1.15 for v in r)}")
    budget = int(TARGET / (worst * MARGIN)) // 100 * 100
    print(f"{name}: max ratio {worst:.3f}; provisional budget floor_100({TARGET} / ({worst:.3f} x {MARGIN})) = {budget}")
