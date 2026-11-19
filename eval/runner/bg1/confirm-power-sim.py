# BG1-C's power simulation (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md). Two modes,
# each from numpy's default_rng with seed 20261119 and 200,000 runs per scenario, each committed as it ran:
#
#   --one-look  the "Power" section, as frozen: Holm over the four comparisons in each direction, treated as independent,
#               and the simultaneous one-sided bounds at 0.05 / 4 for the 3-point readings, drawing each comparison's
#               mean and SD from their sampling distributions.
#   (default)   "What the look costs" in Amendment 2: one look at 20 of the 40 worlds with O'Brien-Fleming bounds at
#               each Holm step's one-sided alpha, futility below 10% conditional power, then the final by Holm's
#               step-down with the final bounds, drawing 40 per-world normal differences. Its "one-look" figures read the
#               same draws by the frozen rule and agree with the Power section's.
#
# test/eval/bg1-confirm-power.test.ts reruns both in TypeScript from a seeded generator with the same seed: the frozen
# rule through decideFamily (rule.ts), and the look and the final through confirm.ts's own confirmLook and
# confirmFinal, the functions verdict.ts confirm calls. It checks every published number within a stated Monte Carlo
# tolerance: four standard errors of its own estimate and of this script's, plus half a unit of the published rounding.
# A JavaScript generator cannot reproduce numpy's draws, so the two agree in distribution, not draw for draw. Neither
# mode is part of the test suite.
#
#   uv run --no-project --with numpy --with scipy python eval/runner/bg1/confirm-power-sim.py [--one-look]
import sys
import numpy as np
from scipy import stats, optimize


def one_look():
    """The Power section's simulation, as frozen."""
    rng = np.random.default_rng(20261119)
    n = 40; df = n - 1; S = 200000
    eff = np.array([2.6, 1.1, 1.5, 1.5])
    sds = {'central': np.array([3.49, 4.83, 5.11, 4.33]), 'pessimistic': np.array([5.15, 5.59, 7.13, 7.42])}
    tb = stats.t.ppf(1 - 0.05/4, df)
    def holm(p):
        order = np.argsort(p, axis=1)
        ps = np.take_along_axis(p, order, axis=1)
        thr = 0.05 / (4 - np.arange(4))
        ok = ps <= thr
        cum = np.cumprod(ok, axis=1).astype(bool)
        rej = np.zeros_like(cum)
        np.put_along_axis(rej, order, cum, axis=1)
        return rej
    for name, sd in sds.items():
      for label, d in (('dev', eff), ('zero', np.zeros(4))):
        mean = rng.normal(d, sd / np.sqrt(n), size=(S, 4))
        s = sd * np.sqrt(rng.chisquare(df, size=(S, 4)) / df)
        t = mean / (s / np.sqrt(n))
        ahead = holm(stats.t.sf(t, df))
        behind = holm(stats.t.cdf(t, df))
        lo = mean - tb * s / np.sqrt(n); hi = mean + tb * s / np.sqrt(n)
        level = (lo > -3) & (hi < 3)
        notbehind = lo > -3
        any_behind = behind.any(1)
        all4 = ahead.all(1)
        class_both = (ahead[:, 0] & ahead[:, 1]) | (ahead[:, 2] & ahead[:, 3])
        some = ahead.any(1)
        r2 = any_behind; r3 = ~r2 & all4; r4 = ~r2 & ~all4 & class_both; r5 = ~r2 & ~all4 & ~class_both & some; r6 = ~r2 & ~some
        bonf_all4 = (stats.t.sf(t, df) <= 0.0125).all(1)
        print(name, label, 'rows2-6', [round(x.mean(), 3) for x in (r2, r3, r4, r5, r6)], 'holm_ahead', ahead.mean(0).round(3), 'all4_holm', round(all4.mean(), 4), 'all4_strict', round(bonf_all4.mean(), 4), 'notbehind', notbehind.mean(0).round(3), 'level', level.mean(0).round(3))


def two_look():
    """BG1-C's look at half the worlds (Amendment 2, R113): O'Brien-Fleming two-look bounds scaled to each Holm step's
    one-sided alpha, then the final. Per-world normal differences; z is the normal score with the paired t's one-sided p.
    numpy default_rng(20261119), 200,000 runs per scenario. With --one-look it reproduces the Power section's table."""
    rng = np.random.default_rng(20261119)
    N, H, S, CH = 40, 20, 200000, 10000
    eff = np.array([2.6, 1.1, 1.5, 1.5])
    sds = {'central': np.array([3.49, 4.83, 5.11, 4.33]), 'pessimistic': np.array([5.15, 5.59, 7.13, 7.42])}
    STEPS = [0.05 / 4, 0.05 / 3, 0.05 / 2, 0.05]
    RHO = np.sqrt(H / N)
    def obf(alpha):
        mvn = stats.multivariate_normal(mean=[0, 0], cov=[[1, RHO], [RHO, 1]])
        f = lambda c: (1 - mvn.cdf([np.sqrt(N / H) * c, c])) - alpha
        c = optimize.brentq(f, 0.5, 6, xtol=1e-10)
        return np.sqrt(N / H) * c, c
    B = np.array([obf(a) for a in STEPS])
    LOOK, FINAL = B[:, 0], B[:, 1]
    CP_MIN, CP_TARGET = 0.10, FINAL[-1]
    tb = stats.t.ppf(1 - 0.05 / 4, N - 1)
    def holm_bounds(z, bounds):
        order = np.argsort(-z, axis=1); zs = np.take_along_axis(z, order, axis=1)
        cum = np.cumprod(zs >= bounds[None, :], axis=1).astype(bool)
        rej = np.zeros_like(cum); np.put_along_axis(rej, order, cum, axis=1); return rej
    def tstat(x):
        n = x.shape[-1]; m = x.mean(-1); s = x.std(-1, ddof=1); return m, s, m / (s / np.sqrt(n))
    def zscore(t, df): return stats.norm.ppf(stats.t.cdf(t, df))
    def rows(ahead, behind):
        r2 = behind.any(1); all4 = ahead.all(1)
        cb = (ahead[:, 0] & ahead[:, 1]) | (ahead[:, 2] & ahead[:, 3]); some = ahead.any(1)
        return np.stack([r2, ~r2 & all4, ~r2 & ~all4 & cb, ~r2 & ~all4 & ~cb & some, ~r2 & ~some], 1)
    ONE = np.array([stats.norm.ppf(1 - a) for a in STEPS])
    print('bounds by Holm step (one-sided alpha, look z, final z, one-look z):')
    for a, l, f, o in zip(STEPS, LOOK, FINAL, ONE): print(f'  {a:.5f}  {l:.3f}  {f:.3f}  {o:.3f}')
    print('check, one-sided 0.025:', [round(v, 3) for v in obf(0.025)])
    print('conditional power target (last step final z):', round(CP_TARGET, 3))
    for name, sd in sds.items():
      for label, d in (('dev', eff), ('zero', np.zeros(4))):
        st = np.zeros(3); R = np.zeros(5); R1 = np.zeros(5); A = np.zeros(4); A1 = np.zeros(4); NB = np.zeros(4); NB1 = np.zeros(4); WB = WB1 = 0; worlds = 0.0
        for _ in range(S // CH):
            x = rng.normal(d[None, :, None], sd[None, :, None], size=(CH, 4, N))
            m40, s40, t40 = tstat(x); z40 = zscore(t40, N - 1)
            a1 = holm_bounds(z40, ONE); b1 = holm_bounds(-z40, ONE)
            R1 += rows(a1, b1).sum(0); A1 += a1.sum(0); WB1 += b1.any(1).sum()
            m1, s1, t1 = tstat(x[:, :, :H]); z1 = zscore(t1, H - 1)
            ca = holm_bounds(z1, LOOK); cbh = holm_bounds(-z1, LOOK); crossed = ca | cbh
            cp = 1 - stats.norm.cdf((CP_TARGET * s1 / np.sqrt(N) - (m1 + eff[None, :]) / 2) / (s1 / np.sqrt(2 * N)))
            futile = ~crossed & (cp < CP_MIN)
            stop = (crossed | futile).all(1)
            st += [stop.sum(), (stop & crossed.all(1)).sum(), (stop & ~crossed.all(1)).sum()]
            af = holm_bounds(z40, FINAL); bf = holm_bounds(-z40, FINAL)
            ahead = np.where(stop[:, None], ca, af); behind = np.where(stop[:, None], cbh, bf)
            R += rows(ahead, behind).sum(0); A += ahead.sum(0); WB += behind.any(1).sum()
            lo = m40 - tb * s40 / np.sqrt(N)
            NB += ((lo > -3) & ~stop[:, None]).sum(0); NB1 += (lo > -3).sum(0)
            worlds += np.where(stop, H, N).sum()
        f = lambda v: [round(float(u) / S, 3) for u in np.atleast_1d(v)]
        print(name, label, '| stop any/diff/futility', f(st), '| rows2-6 one-look', f(R1), 'with-look', f(R), '| ahead one-look', f(A1), 'with-look', f(A),
              '| notbehind3 one-look', f(NB1), 'with-look', f(NB), '| any behind one-look', round(WB1 / S, 4), 'with-look', round(WB / S, 4), '| mean worlds', round(worlds / S, 2))


one_look() if '--one-look' in sys.argv[1:] else two_look()
