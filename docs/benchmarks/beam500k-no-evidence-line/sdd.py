"""Detectable differences and decision-rule power for the BEAM-500K "no evidence found" preregistration.

Model (stated in the preregistration): per-question made-up probability ~ Beta(mean p0, concentration 2); each of 3 readers
adds N(0, 0.10) noise, clipped to [0, 1]; the oracle line multiplies it by (1 - cut). Unanswerable questions: 22, 3 samples
per arm; answerable: 198, 1 sample per arm, correct rate 0.55. 3,000 simulated runs per row, random.Random(1).
SDD = 2.8 x the standard deviation of the pooled estimate across runs (for Δ_O at a 50% cut; for L at no effect).
Power of the decision rule uses a normal interval from the per-question paired differences (question-level SE), with M
recomputed in each run from that run's own before rate.
"""
import random, statistics as st, math

def draw(rng, nq, readers, p0, cut, k):
    a, b = p0 * 2.0, (1 - p0) * 2.0
    per_q, before = [], []
    for _ in range(nq):
        qb = rng.betavariate(a, b)
        dq, bq = 0.0, 0.0
        for _ in range(readers):
            p = min(max(qb + rng.gauss(0, 0.1), 0), 1)
            bm = sum(rng.random() < p for _ in range(k)) / k
            am = sum(rng.random() < p * (1 - cut) for _ in range(k)) / k
            dq += (bm - am) / readers; bq += bm / readers
        per_q.append(dq); before.append(bq)
    return per_q, before

def sdd(nq, readers, p0, cut, k, reps=3000, seed=1):
    rng = random.Random(seed)
    est = [st.mean(draw(rng, nq, readers, p0, cut, k)[0]) for _ in range(reps)]
    return 2.8 * st.pstdev(est) * 100

def power(p0, cut, reps=3000, seed=1, nq=22, readers=3, k=3):
    rng = random.Random(seed); out = {"material": 0, "not material": 0, "no headroom": 0, "not distinguishable": 0}
    for _ in range(reps):
        d, b = draw(rng, nq, readers, p0, cut, k)
        rate = st.mean(b); dhat = st.mean(d); se = st.pstdev(d) / math.sqrt(nq)
        half = rate / 2; M = max(0.13, half)
        if rate < 0.13: out["no headroom"] += 1
        elif dhat >= M and dhat - 1.96 * se > 0: out["material"] += 1
        elif dhat + 1.96 * se < half: out["not material"] += 1
        else: out["not distinguishable"] += 1
    return {kk: round(100 * v / reps) for kk, v in out.items()}

if __name__ == "__main__":
    print("SDD Δ_O pooled (22 q x 3 samples, 50%% cut): %.1f" % sdd(22, 3, 0.32, 0.5, 3))
    print("SDD Δ_O one reader (50%% cut): %.1f" % sdd(22, 1, 0.32, 0.5, 3))
    print("SDD L pooled (198 q, no effect): %.1f" % sdd(198, 3, 0.55, 0.0, 1))
    print("SDD L one reader (no effect): %.1f" % sdd(198, 1, 0.55, 0.0, 1))
    for p0 in (0.32, 0.20):
        for cut in (0.0, 0.3, 0.5, 0.6, 0.7, 0.9):
            print("before %.2f true cut %d%%: %s" % (p0, cut * 100, power(p0, cut)))
