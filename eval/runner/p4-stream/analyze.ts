/**
 * P4 streaming harness analysis: paired arm differences per model with a
 * question-level bootstrap CI, per-category deltas, cost per question, notice
 * fire/miss rates, and the sample size a preregistered effect needs.
 *
 *   bun eval/runner/p4-stream/analyze.ts <rows.ndjson>... [--effect 0.03] [--power 0.8] [--json]
 *
 * Sample size: for a paired difference with per-question SD s (measured from
 * the rows), detecting an effect d with a two-sided 95% CI excluding zero at
 * the given power needs n = ((1.96 + z_power) * s / d)^2 questions per model.
 */
import { readFileSync } from 'node:fs';
import type { CellRow } from './run.ts';

const Z = { 0.8: 0.8416, 0.9: 1.2816 } as Record<number, number>;

function mulberry(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function pairedStats(diffs: number[], draws = 10_000, seed = 42) {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const rand = mulberry(seed);
  const boots: number[] = [];
  for (let i = 0; i < draws; i++) { let s = 0; for (let j = 0; j < n; j++) s += diffs[Math.floor(rand() * n)]; boots.push(s / n); }
  boots.sort((a, b) => a - b);
  return { n, mean, sd, lo: boots[Math.floor(draws * 0.025)], hi: boots[Math.floor(draws * 0.975)], discordant: diffs.filter(d => d !== 0).length / n };
}

/**
 * Cluster bootstrap: resample conversations (BEAM asks many questions per
 * conversation, which are not independent). Also returns the one-way ANOVA
 * intraclass correlation of the per-question differences.
 */
export function clusteredStats(byCluster: Map<string, number[]>, draws = 10_000, seed = 42) {
  const clusters = [...byCluster.values()].filter(c => c.length);
  const all = clusters.flat();
  const n = all.length;
  const mean = all.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const rand = mulberry(seed);
  const boots: number[] = [];
  for (let i = 0; i < draws; i++) {
    let s = 0, k = 0;
    for (let j = 0; j < clusters.length; j++) { const c = clusters[Math.floor(rand() * clusters.length)]; for (const d of c) { s += d; k++; } }
    boots.push(s / k);
  }
  boots.sort((a, b) => a - b);
  const m = n / clusters.length;
  const msb = clusters.reduce((a, c) => a + c.length * ((c.reduce((x, y) => x + y, 0) / c.length) - mean) ** 2, 0) / Math.max(1, clusters.length - 1);
  const msw = clusters.reduce((a, c) => { const cm = c.reduce((x, y) => x + y, 0) / c.length; return a + c.reduce((x, y) => x + (y - cm) ** 2, 0); }, 0) / Math.max(1, n - clusters.length);
  const icc = clusters.length > 1 && msb + (m - 1) * msw > 0 ? Math.max(0, (msb - msw) / (msb + (m - 1) * msw)) : null;
  return { n, clusters: clusters.length, mean, sd, lo: boots[Math.floor(draws * 0.025)], hi: boots[Math.floor(draws * 0.975)], icc };
}

/** Minimum detectable effect (two-sided 95%, given power) for k clusters of m items with per-item SD and ICC. */
export function minimumDetectable(sd: number, k: number, m: number, icc: number, power = 0.8): number {
  const deff = 1 + (m - 1) * icc;
  return (1.96 + (Z[power] ?? 0.8416)) * sd * Math.sqrt(deff / (k * m));
}

export function requiredN(sd: number, effect: number, power = 0.8): number {
  return Math.ceil(((1.96 + (Z[power] ?? 0.8416)) * sd / effect) ** 2);
}

function main(argv: string[]) {
  const files = argv.filter(a => !a.startsWith('--') && !/^\d/.test(a));
  const effect = Number(argv[argv.indexOf('--effect') + 1] ?? 0.03) || 0.03;
  const power = Number(argv[argv.indexOf('--power') + 1] ?? 0.8) || 0.8;
  const rows: CellRow[] = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CellRow)).filter(r => !r.errors.length);
  const models = [...new Set(rows.map(r => r.model))];
  const out: Record<string, unknown> = {};
  for (const model of models) {
    const byArm = new Map<string, Map<string, CellRow>>();
    for (const r of rows.filter(x => x.model === model)) { if (!byArm.has(r.arm)) byArm.set(r.arm, new Map()); byArm.get(r.arm)!.set(r.question_id, r); }
    const arms: Record<string, unknown> = {};
    for (const [arm, m] of byArm) {
      const rs = [...m.values()];
      const usd = rs.map(r => r.usd_agent + r.usd_gbrain + r.usd_profile);
      arms[arm] = {
        n: rs.length, accuracy: rs.reduce((a, r) => a + r.qa_score, 0) / rs.length,
        usd_per_question: usd.reduce((a, b) => a + b, 0) / rs.length,
        compactions: rs.reduce((a, r) => a + r.compactions, 0) / rs.length,
        notice_fire_rate: rs.filter(r => r.notices > 0).length / rs.length,
        notice_miss_rate: (() => { const seg = rs.reduce((a, r) => a + r.compactions, 0); return seg ? rs.reduce((a, r) => a + r.missed_segments, 0) / seg : null; })(),
        facts_saved: rs.reduce((a, r) => a + r.facts_saved, 0) / rs.length,
        evidence_saved: rs.filter(r => !r.abstention).filter(r => r.evidence_saved).length / Math.max(1, rs.filter(r => !r.abstention).length),
      };
    }
    const base = byArm.get('Aprime');
    const deltas: Record<string, unknown> = {};
    if (base) for (const [arm, m] of byArm) {
      if (arm === 'Aprime') continue;
      const ids = [...m.keys()].filter(id => base.has(id));
      if (ids.length < 2) continue;
      const st = pairedStats(ids.map(id => m.get(id)!.qa_score - base.get(id)!.qa_score));
      const byConv = new Map<string, number[]>();
      for (const id of ids) { const r = m.get(id)!; const k = r.conversation ?? r.question_id; byConv.set(k, [...(byConv.get(k) ?? []), r.qa_score - base.get(id)!.qa_score]); }
      const clustered = byConv.size < ids.length ? clusteredStats(byConv) : null;
      const cats: Record<string, number> = {};
      for (const c of new Set(ids.map(id => m.get(id)!.category))) {
        const cid = ids.filter(id => m.get(id)!.category === c);
        cats[c] = cid.reduce((a, id) => a + m.get(id)!.qa_score - base.get(id)!.qa_score, 0) / cid.length;
      }
      deltas[`${arm}-Aprime`] = { ...st, ...(clustered ? { clustered } : {}), n_for_effect: requiredN(st.sd, effect, power), by_category: cats };
    }
    out[model] = { arms, deltas };
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const [model, v] of Object.entries(out) as Array<[string, { arms: Record<string, Record<string, number | null>>; deltas: Record<string, Record<string, unknown>> }]>) {
    console.log(`\n${model}`);
    for (const [arm, a] of Object.entries(v.arms)) console.log(`  ${arm.padEnd(7)} n ${a.n}  acc ${((a.accuracy as number) * 100).toFixed(1)}%  $/q ${(a.usd_per_question as number).toFixed(2)}  compactions ${(a.compactions as number).toFixed(1)}  notice fire ${((a.notice_fire_rate as number) * 100).toFixed(0)}%  miss ${a.notice_miss_rate === null ? '-' : `${((a.notice_miss_rate as number) * 100).toFixed(0)}%`}  facts ${(a.facts_saved as number).toFixed(1)}  evidence-saved ${((a.evidence_saved as number) * 100).toFixed(0)}%`);
    for (const [k, d] of Object.entries(v.deltas)) if (d.clustered) { const c = d.clustered as Record<string, number | null>; console.log(`  ${k} (clustered by conversation): Δ ${((c.mean as number) * 100).toFixed(1)} pts, 95% CI [${((c.lo as number) * 100).toFixed(1)}, ${((c.hi as number) * 100).toFixed(1)}], ${c.clusters} conversations, ${c.n} questions, ICC ${c.icc === null ? '-' : (c.icc as number).toFixed(2)}`); }
    for (const [k, d] of Object.entries(v.deltas)) console.log(`  ${k}: Δ ${((d.mean as number) * 100).toFixed(1)} pts, 95% CI [${((d.lo as number) * 100).toFixed(1)}, ${((d.hi as number) * 100).toFixed(1)}], n ${d.n}, SD ${(d.sd as number).toFixed(3)}, discordant ${((d.discordant as number) * 100).toFixed(0)}%, n for +${(effect * 100).toFixed(1)} pts at ${power * 100}% power: ${d.n_for_effect}`);
  }
}

if (import.meta.main) main(process.argv.slice(2));
