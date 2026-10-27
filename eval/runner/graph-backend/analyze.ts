/**
 * Scores the graph-backend benchmark receipts (GBRA-123): latency percentiles,
 * B vs C correctness on every shared call, A vs B distinct-set agreement with
 * cap classification, throughput, the exploratory 50 ms hop budget, and the
 * preregistered decision rule.
 *
 * Usage: bun eval/runner/graph-backend/analyze.ts <receipt dir> [--probe-db <tier>=<url> ...]
 * Reads <tier>/rows.ndjson, or the committed <tier>/rows.ndjson.gz. Writes
 * <receipt dir>/summary.json and prints Markdown tables.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const dir = process.argv[2];
const probeDbs = new Map<string, string>();
for (let i = 3; i < process.argv.length; i++) if (process.argv[i] === '--probe-db') { const [t, u] = process.argv[++i].split(/=(.*)/s); probeDbs.set(t, u); }
const TIERS = ['personal', 'team', 'company'];
const TIMEOUT_MS = 30_000;

interface Row { arm: string; tier: string; pass: string; call_id: string; cell: string; start: number; hub: boolean; status: string; ms?: number; n?: number; truncated?: boolean; h_full?: string; h_set?: string; error?: string; requests?: number }

const rank = (xs: number[], q: number) => xs.length ? xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * q) - 1))] : null;
function pct(rows: Row[]) {
  const ran = rows.filter(r => r.status !== 'not_run_breaker');
  const xs = ran.map(r => (r.status === 'ok' ? r.ms! : r.status === 'timeout' ? Math.max(TIMEOUT_MS, r.ms ?? 0) : Number.POSITIVE_INFINITY)).sort((a, b) => a - b);
  const timeouts = ran.filter(r => r.status === 'timeout').length;
  const errors = ran.filter(r => r.status === 'error').length;
  const capped = (v: number | null) => (v === null ? null : Number.isFinite(v) ? Math.round(v * 10) / 10 : 'error');
  return {
    n: rows.length, ran: ran.length, ok: ran.length - timeouts - errors, timeouts, errors, not_run_breaker: rows.length - ran.length,
    p50: capped(rank(xs, 0.5)), p95: capped(rank(xs, 0.95)), p99: capped(rank(xs, 0.99)),
    p95_at_least_timeout: timeouts + errors >= 0.05 * Math.max(1, ran.length),
  };
}

async function probeOldWalk(url: string, slug: string, depth: number): Promise<number> {
  const { default: postgres } = await import(`${process.env.GB_B}/vendor/postgres/src/index.js`);
  const sql = postgres(url, { max: 1 });
  try {
    const r = await sql.unsafe(`WITH RECURSIVE g AS (
      SELECT p.id, 0 AS depth, ARRAY[p.id] AS visited FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL
      UNION ALL
      SELECT p2.id, g.depth + 1, g.visited || p2.id FROM g JOIN links l ON l.from_page_id = g.id JOIN pages p2 ON p2.id = l.to_page_id
      WHERE g.depth < $2 AND NOT (p2.id = ANY(g.visited)) AND p2.deleted_at IS NULL)
      SELECT count(*)::int AS n FROM (SELECT 1 FROM g LIMIT 20001) c`, [slug, depth]);
    return r[0].n;
  } finally { await sql.end(); }
}

const summary: Record<string, unknown> = { generated_at: new Date().toISOString(), tiers: {} };
const md: string[] = [];
for (const tier of TIERS) {
  const f = `${dir}/${tier}/rows.ndjson`;
  const text = existsSync(f) ? readFileSync(f, 'utf8') : existsSync(`${f}.gz`) ? gunzipSync(readFileSync(`${f}.gz`)).toString('utf8') : null;
  if (text === null) continue;
  const rows: Row[] = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const counted = rows.filter(r => ['cold', 'warm', 'tput8'].includes(r.pass) && ['A', 'B', 'BL', 'C', 'D'].includes(r.arm));
  const arms = [...new Set(counted.map(r => r.arm))].sort();
  const t: Record<string, any> = { pooled: {}, cells: {}, hub: {}, correctness: {}, ab: {}, hops50: {}, throughput: {} };
  for (const arm of arms) for (const pass of ['cold', 'warm', 'tput8']) {
    const rs = counted.filter(r => r.arm === arm && r.pass === pass);
    if (!rs.length) continue;
    t.pooled[`${arm}/${pass}`] = pct(rs);
    for (const kind of ['traverseGraph', 'traversePaths']) t.pooled[`${arm}/${pass}/${kind}`] = pct(rs.filter(r => r.cell.startsWith(kind)));
    if (pass === 'warm') {
      for (const cell of [...new Set(rs.map(r => r.cell))].sort()) t.cells[`${arm}/${cell}`] = pct(rs.filter(r => r.cell === cell));
      t.hub[`${arm}/hub`] = pct(rs.filter(r => r.hub));
      t.hub[`${arm}/non-hub`] = pct(rs.filter(r => !r.hub));
    }
  }
  // B vs C correctness on every call both ran (same pass)
  const key = (r: Row) => `${r.pass}|${r.call_id}`;
  const B = new Map(counted.filter(r => r.arm === 'B').map(r => [key(r), r]));
  for (const other of arms.filter(a => a === 'C' || a === 'D' || a === 'BL')) {
    const mism: Array<Record<string, unknown>> = [];
    let compared = 0; let notComparable = 0;
    for (const c of counted.filter(r => r.arm === other)) {
      const b = B.get(key(c));
      if (!b) continue;
      if (b.status !== 'ok' || c.status !== 'ok') { notComparable++; continue; }
      compared++;
      if (b.h_full !== c.h_full) mism.push({ pass: c.pass, call_id: c.call_id, b: { n: b.n, truncated: b.truncated }, c: { n: c.n, truncated: c.truncated } });
    }
    const failures = (passes: string[]) => counted.filter(r => r.arm === other && passes.includes(r.pass) && r.status !== 'ok').length;
    t.correctness[`B-vs-${other}`] = {
      compared, mismatches: mism.length, not_comparable: notComparable,
      other_errors_or_timeouts_cold_warm: failures(['cold', 'warm']), other_errors_or_timeouts_tput8: failures(['tput8']),
      examples: mism.slice(0, 20),
    };
  }
  // A vs B distinct sets, cap classification
  const A = counted.filter(r => r.arm === 'A');
  if (A.length) {
    let compared = 0; let agree = 0; let capFired = 0; const real: Array<Record<string, unknown>> = []; let skipped = 0;
    for (const a of A) {
      const b = B.get(key(a));
      if (!b || a.status !== 'ok' || b.status !== 'ok') { skipped++; continue; }
      compared++;
      if (a.h_set === b.h_set) { agree++; continue; }
      if (a.truncated || b.truncated) { capFired++; continue; }
      if (a.cell.startsWith('traverseGraph') && probeDbs.has(tier)) {
        const depth = Number(a.cell.split(':d')[1]);
        const n = await probeOldWalk(probeDbs.get(tier)!, `p/${String(a.start).padStart(7, '0')}`, depth);
        if (n >= 20_000) { capFired++; continue; }
        real.push({ call_id: a.call_id, pass: a.pass, probe_rows: n });
      } else real.push({ call_id: a.call_id, pass: a.pass, probe_rows: null });
    }
    t.ab = { compared, agree, differ_cap_fired: capFired, differ_unexplained: real.length, unexplained: real.slice(0, 20), not_comparable: skipped };
  }
  // exploratory: hops within 50 ms (warm traverseGraph)
  for (const arm of arms) {
    const per = new Map<number, Map<number, Row>>();
    for (const r of counted.filter(x => x.arm === arm && x.pass === 'warm' && x.cell.startsWith('traverseGraph'))) {
      if (!per.has(r.start)) per.set(r.start, new Map());
      per.get(r.start)!.set(Number(r.cell.split(':d')[1]), r);
    }
    const hops: number[] = [];
    for (const m of per.values()) {
      if (m.size < 4) continue;
      let best = 0;
      for (const d of [1, 2, 3, 5]) { const r = m.get(d)!; if (r.status === 'ok' && r.ms! <= 50) best = d; }
      hops.push(best);
    }
    if (!hops.length) continue;
    const dist: Record<string, number> = {};
    for (const h of hops) dist[h] = (dist[h] ?? 0) + 1;
    t.hops50[arm] = { starts: hops.length, median: rank([...hops].sort((x, y) => x - y), 0.5), distribution: dist };
  }
  // throughput from worker run lines
  const wr = `${dir}/${tier}/worker-runs.ndjson`;
  if (existsSync(wr)) for (const l of readFileSync(wr, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(l);
    if (j.pass === 'tput8' && j.calls > 0) t.throughput[j.arm] = { calls: j.calls, wall_ms: j.wall_ms, calls_per_s: Math.round(j.calls_per_s * 100) / 100 };
  }
  // decision rule inputs
  const bw = t.pooled['B/warm']; const cw = t.pooled['C/warm'];
  if (bw && cw && tier !== 'personal') {
    const corr = t.correctness['B-vs-C'];
    const num = (v: unknown) => (typeof v === 'number' ? v : Number.POSITIVE_INFINITY);
    const speedup = num(bw.p95) / num(cw.p95);
    t.decision = {
      b_warm_p95: bw.p95, c_warm_p95: cw.p95, speedup_b_over_c: Math.round(speedup * 100) / 100, abs_gain_ms: Math.round((num(bw.p95) - num(cw.p95)) * 10) / 10,
      correctness_100_cold_warm: corr.mismatches === 0 && corr.other_errors_or_timeouts_cold_warm === 0,
      c_timeouts_under_8_callers: corr.other_errors_or_timeouts_tput8,
      meets_rule: speedup >= 2 && num(bw.p95) - num(cw.p95) >= 50 && corr.mismatches === 0 && corr.other_errors_or_timeouts_cold_warm === 0,
    };
  }
  (summary.tiers as Record<string, unknown>)[tier] = t;
  md.push(`\n## ${tier}\n\n| arm/pass | n | ok | timeouts | errors | p50 ms | p95 ms | p99 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const [k, v] of Object.entries(t.pooled) as Array<[string, any]>) md.push(`| ${k} | ${v.n} | ${v.ok} | ${v.timeouts} | ${v.errors} | ${v.p50} | ${v.p95_at_least_timeout ? '>= 30000' : v.p95} | ${v.p99} |`);
  md.push('', '```json', JSON.stringify({ correctness: t.correctness, ab: t.ab, hops50: t.hops50, throughput: t.throughput, decision: t.decision }, null, 1), '```');
}
writeFileSync(`${dir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(md.join('\n'));
