/**
 * Per-unit census of a harness gbrain store, read through the gbrain build given (equivalence check, #6066).
 *
 *   bun eval/harness-provider/mpw_tools/store-census.ts --gbrain <checkout> --store <store dir> --out <json> [--probe-log <probe.jsonl>]
 *
 * For every unit brain under <store>/gbrain/units it opens the PGLite datastore read-only in practice (SELECTs only)
 * and counts: live pages, chunks and facts; distinct page sources; quarantined pages; and, where the build's schema
 * has them, write-gate receipts by verdict and reason family, write-gate holds by status, needs_rederive rows, trust
 * tiers, rows the read eligibility predicate hides under the brain's own read policy (no `min_trust`, which the
 * harness never sends), rows the activation rule would suppress, and chunks that carry a fence trust marker. With
 * --probe-log (a replay's probe.jsonl), it also counts the distinct query texts the build parses as relational
 * (planner on) and those carrying a run of 32 or more dash negations.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const root = resolve(arg('--gbrain') ?? '');
const store = resolve(arg('--store') ?? '');
const out = arg('--out');
if (!existsSync(join(root, 'src/cli.ts')) || !existsSync(join(store, 'gbrain/units')) || !out) {
  console.error('usage: store-census.ts --gbrain <checkout> --store <store dir> --out <json> [--probe-log <probe.jsonl>]');
  process.exit(2);
}
const has = (rel: string) => existsSync(join(root, rel));
const { PGLiteEngine } = await import(join(root, 'src/core/pglite-engine.ts'));
const elig = has('src/core/eligibility/sql.ts') ? await import(join(root, 'src/core/eligibility/sql.ts')) : null;
const policy = has('src/core/eligibility/policy.ts') ? await import(join(root, 'src/core/eligibility/policy.ts')) : null;
const fence = has('src/core/eligibility/fence-overlay.ts') ? await import(join(root, 'src/core/eligibility/fence-overlay.ts')) : null;

type Row = Record<string, unknown>;
const units: Record<string, Row> = {};
for (const unit of readdirSync(join(store, 'gbrain/units')).sort()) {
  const db = join(store, 'gbrain/units', unit, '.gbrain/brain.pglite');
  if (!existsSync(db)) { units[unit] = { error: 'no brain.pglite' }; continue; }
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: db });
  const q = async (sql: string, params: unknown[] = []) => await engine.executeRaw(sql, params) as Row[];
  const one = async (sql: string) => Number(Object.values((await q(sql))[0] ?? { n: 0 })[0] ?? 0);
  const table = async (t: string) => (await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t]))[0]?.ok === true;
  const column = async (t: string, c: string) => (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c])).length > 0;
  const r: Row = {
    pages: await one(`SELECT count(*) FROM pages WHERE deleted_at IS NULL`),
    chunks: await one(`SELECT count(*) FROM content_chunks`),
    facts: await table('facts') ? await one(`SELECT count(*) FROM facts`) : null,
    page_sources: await one(`SELECT count(DISTINCT source_id) FROM pages WHERE deleted_at IS NULL`),
    quarantined_pages: await one(`SELECT count(*) FROM pages WHERE COALESCE(frontmatter, '{}'::jsonb) ? 'quarantine'`),
  };
  if (await table('write_gate_receipts')) {
    r.gate_receipts = await q(`SELECT target_table, verdict, reason_families::text AS families, count(*)::int AS n FROM write_gate_receipts GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
  }
  if (await table('write_gate_holds')) r.gate_holds = await q(`SELECT status, count(*)::int AS n FROM write_gate_holds GROUP BY 1 ORDER BY 1`);
  if (await table('needs_rederive')) r.needs_rederive = await q(`SELECT derived_table, count(*)::int AS n FROM needs_rederive GROUP BY 1 ORDER BY 1`);
  for (const t of ['pages', 'facts']) {
    if (await column(t, 'trust_tier')) r[`${t}_trust_tiers`] = await q(`SELECT trust_tier, count(*)::int AS n FROM ${t} GROUP BY 1 ORDER BY 1`);
  }
  if (elig && policy) {
    const cfg = policy.loadTrustReadConfig ? await policy.loadTrustReadConfig(engine) : null;
    const floor = cfg?.mode === 'filter' ? policy.FILTER_POLICY_FLOOR : undefined;
    r.read_policy = cfg;
    const hidden: Row = {};
    for (const [t, alias] of [['facts', 'f'], ['takes', 't'], ['timeline_entries', 'te']] as const) {
      if (await table(t)) hidden[t] = await one(`SELECT count(*) FROM ${t} ${alias} WHERE NOT (${elig.projectionEligibleSql(t, alias, { floor })})`);
    }
    hidden.pages = await one(`SELECT count(*) FROM pages p WHERE p.deleted_at IS NULL AND NOT (${elig.pageEligibleSql('p', { floor })})`);
    r.hidden_by_eligibility = hidden;
    const suppressed: Row = {};
    for (const [t, alias] of [['facts', 'f'], ['pages', 'p']] as const) {
      if (await column(t, 'trust_tier')) suppressed[t] = await one(`SELECT count(*) FROM ${t} ${alias} WHERE ${elig.activationSuppressedSql(t, alias)}`);
    }
    r.activation_suppressed = suppressed;
  }
  if (fence?.chunkFenceMarker) {
    const marked = { chunks: 0, unconfirmed: 0 };
    for (const row of await q(`SELECT chunk_text FROM content_chunks WHERE chunk_text LIKE '%' || $1 || '%'`, [fence.FENCE_TRUST_ORIGIN ?? 'facts-fence'])) {
      const m = fence.chunkFenceMarker(row.chunk_text);
      if (m) { marked.chunks++; if (m.unconfirmed) marked.unconfirmed++; }
    }
    r.fence_marked_chunks = marked;
  }
  await engine.disconnect();
  units[unit] = r;
}

const result: Row = { gbrain: root, store, units };
const probeLog = arg('--probe-log');
if (probeLog) {
  const texts = [...new Set(readFileSync(probeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.ev === 'query').map(e => String(e.params.query)))];
  const rel = has('src/core/search/relational-plan.ts') ? await import(join(root, 'src/core/search/relational-plan.ts')) : null;
  result.queries = {
    n: texts.length,
    relational: rel?.isRelationalQuery ? texts.filter(t => rel.isRelationalQuery(t, true)).length : null,
    dash_negation_runs_32: texts.filter(t => /(?:^|\s)(?:-\S+\s*){32,}/.test(t)).length,
  };
}
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ units: Object.keys(units).length, out }));
