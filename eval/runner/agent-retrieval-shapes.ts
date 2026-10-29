/**
 * Agent retrieval shapes (registry id `agent-retrieval-shapes`, alias ARS).
 *
 * Question: on the retrieval shapes an operator agent hit on a large
 * multi-source production brain, does gbrain return the page the agent
 * needed? Fifteen probe families (E1 to E15), one per reported shape (gbrain
 * issues #4612, #6058 and #7153 to #7165), each with its own pass rate and
 * denominator. GBRA-154 (ranking) and GBRA-155 (entity and lookup) measure
 * their fixes against it with `--gbrain <checkout>@<ref>`.
 *
 * What runs (real gbrain code, loaded through gbrain-under-test.ts so
 * `--gbrain` measures a copied overlay instead of the pin):
 *   writes   put_page for every page (source_id for the two federated
 *            sources E1 adds with sources_add), importImageFile for the E14
 *            images; mention extraction is never run.
 *   reads    search and query (keyword path: no embedding key), entity,
 *            get_page (presence), get_chunks (E13 stored chunks), run_doctor
 *            (E7), all through operation handlers with a trusted local
 *            OperationContext.
 *
 * Gold: eval/generators/agent-retrieval-shapes-gen.ts writes a seeded ledger
 * and an independent oracle derives gold from the rendered pages; gold lives
 * in a GoldStore and never comes from gbrain.
 *
 * Accounting: every (probe, surface) pair is scored pass or fail. A gbrain
 * exception where an answer is expected is a scored miss. A family whose
 * behavior needs a capability the build lacks (E5's frontmatter filter) or a
 * state the hermetic arm cannot reach (E14) is reported as not measured with
 * the reason, never as a pass. A failed presence assertion is a harness
 * error and voids the run.
 *
 * Hermetic: provider and TypeSafe keys stripped, throwaway GBRAIN_HOME,
 * PGLite in memory, keyword search only. There is no paid arm: vector,
 * reranker and expansion behavior is listed under data.not_measured.
 *
 * Usage: bun eval/runner/agent-retrieval-shapes.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]]
 *          [--families E1,E2] [--record-bugs] [--json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GBrainConfig } from 'gbrain/config';
import type { OperationContext } from 'gbrain/operations';
import type { PGLiteEngine as PGLiteEngineType } from 'gbrain/pglite-engine';
import { GoldStore } from './evaluator/gold-store.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { upsertBug, type BugEntry } from './bug-ledger.ts';
import {
  BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, latencySummary, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt,
} from './receipt.ts';
import {
  ARS_CHUNK_CAP_CHARS, ARS_DEFAULT_SEED, ARS_FAMILIES, ARS_GENERATOR_VERSION, ARS_LIMIT, ARS_TOP_K, generateArsWorld, pageKey, renderPage,
  type ArsFamily, type ArsGold, type ArsLedger, type ArsProbe, type ArsSurface, type GeneratedArs,
} from '../generators/agent-retrieval-shapes-gen.ts';

export const CATEGORY = 'agent-retrieval-shapes';
export const BUG_PREFIX = 'ARS';
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Per family: the shape, its gbrain issue, the variants its headline pass rate counts, and the finding it files when they fail. */
export const FAMILY_META: Record<ArsFamily, { shape: string; issue: string; headline: readonly string[]; classification: BugEntry['classification']; contract: string; surface: string; expected: string }> = {
  E1: { shape: 'twin collapse across two federated sources', issue: '#4612', headline: ['default'], classification: 'feature-gap',
    contract: 'None stated: gbrain keys result slots on (source_id, slug) on purpose and has no source-agnostic collapse stage (gbrain#4612).', surface: 'search / query with source_id __all__',
    expected: 'a slug held by both sources takes one of the top 10 rows and ranks first for its own title words' },
  E2: { shape: 'merge-redirect stub above its target', issue: '#7153', headline: ['same-title', 'renamed-stub'], classification: 'feature-gap',
    contract: 'None stated: gbrain does not claim to collapse or demote merge-redirect stubs (gbrain#7153).', surface: 'search / query',
    expected: 'the target ranks above the stub whose body says "This page has been merged into [[target]]", or the stub is collapsed onto it' },
  E3: { shape: 'derived copies of one document crowd the top results', issue: '#7154', headline: ['default'], classification: 'feature-gap',
    contract: 'None stated: gbrain has no document-family collapse for pages that share an origin (gbrain#7154).', surface: 'search / query',
    expected: 'the page that answers the question ranks first and the transcript, summary and diarized copies take at most 1 of the top 5' },
  E4: { shape: 'founder page above the company a product query describes', issue: '#7155', headline: ['default'], classification: 'feature-gap',
    contract: 'None stated: gbrain has no entity-type prior for descriptive organization queries (gbrain#7155).', surface: 'search / query',
    expected: 'the company page ranks first for a product-description query that names no person, without --types' },
  E5: { shape: 'frontmatter fields as the only discriminator', issue: '#7159', headline: ['filter'], classification: 'feature-gap',
    contract: 'None stated: search, query and list_pages take no frontmatter-field filter (gbrain#7159); the probes pass a where parameter only when the operation declares one.', surface: 'search / query params',
    expected: 'a where: {partner, cycle, outcome} filter returns the one interview whose frontmatter matches' },
  E6: { shape: 'entity name variants beyond N4 (honorific, surname, diminutive, reversed)', issue: '#7160', headline: ['honorific', 'surname', 'diminutive', 'reversed'], classification: 'feature-gap',
    contract: 'None stated: the entity op resolves "Name, alias or slug" (alias, exact slug, exact title, slug suffix); variant generation is what gbrain#7160 asks for.', surface: 'entity',
    expected: 'each variant of a person with empty aliases resolves to that person, none resolves to a wrong page, and no miss suggests an index or digest page' },
  E7: { shape: 'title-prefixed duplicate person stub', issue: '#7160', headline: ['prefixed'], classification: 'feature-gap',
    contract: 'None stated: the entity op prefers an exact title, and no doctor check looks for title-prefixed person duplicates (gbrain#7160).', surface: 'entity; run_doctor',
    expected: '"Mayor <Surname>-Example" resolves to the canonical person page, not the short people/mayor-<surname>-example stub, and a doctor check flags the pair' },
  E8: { shape: 'a name that appears only in raw notes', issue: '#7161', headline: ['raw-only'], classification: 'feature-gap',
    contract: 'None stated: entity resolves pages, and its miss suggestions are a 3-row keyword search; a bounded mention probe while coverage is pending is what gbrain#7161 asks for.', surface: 'entity',
    expected: 'a lookup for a full name that only daily notes mention names at least one of those notes instead of a bare miss' },
  E9: { shape: 'short OCR image pages above the person a name query names', issue: '#7162', headline: ['default'], classification: 'feature-gap',
    contract: 'None stated: gbrain has no ranking prior for single-token OCR matches (gbrain#7162).', surface: 'search / query',
    expected: 'the person page ranks first for the full name, above image pages that share one word with it' },
  E10: { shape: 'identifier lookups (phone, mail, hex id)', issue: '#7163', headline: ['phone', 'mail', 'hex'], classification: 'feature-gap',
    contract: 'None stated: gbrain has no exact-match path for identifier-shaped queries (gbrain#7163).', surface: 'search / query',
    expected: 'the one page among 200 look-alike contact cards that contains the identifier ranks first' },
  E11: { shape: '"when did X start Y" with an undated stub and a dated page', issue: '#6058', headline: ['default'], classification: 'feature-gap',
    contract: 'None stated: keyword ranking has no date-evidence signal for "when" questions (gbrain#6058).', surface: 'search / query',
    expected: 'the dated meeting page ranks first, above the undated concept stub' },
  E12: { shape: 'score monotonic in rank order', issue: '#7156', headline: [], classification: 'bug',
    contract: 'search and query rows are returned in rank order; gbrain#7156 asks that score be the value the list is sorted by.', surface: 'search / query score field',
    expected: 'score is non-increasing down every result list' },
  E13: { shape: 'returned chunk size on a 60,000-character meeting', issue: '#7164', headline: ['default'], classification: 'feature-gap',
    contract: 'The chunker caps a stored chunk at 6,000 characters (src/core/chunkers/recursive.ts, maxChars); return_unit auto returns whole conversations by design, and gbrain#7164 asks for a cap on returned text.', surface: 'search / query (return_unit auto)',
    expected: 'no returned row carries more than 6,000 characters' },
  E14: { shape: 'projection_pending notice on queries it cannot affect', issue: '#7165', headline: ['unscoped'], classification: 'feature-gap',
    contract: 'None stated: the readiness probe covers the caller\'s whole visible scope, narrowed only by --types (src/core/search/projection-readiness.ts); gbrain#7165 asks to scope it to the query.', surface: 'search / query response meta degraded',
    expected: 'a text query that cannot match an unprojected image page reports no projection_pending stage' },
  E15: { shape: 'known-item paraphrase questions', issue: '#7157', headline: ['default'], classification: 'feature-gap',
    contract: 'None stated: keyword search cannot match words a question paraphrases; query without --expand ranks like search on the keyword path (gbrain#7157).', surface: 'search / query',
    expected: 'the page each paraphrased question describes ranks first (hit@1), with query at least as good as search' },
};

/** Behavior the hermetic arm cannot reach, by family. */
export const NOT_MEASURED: ReadonlyArray<{ family: ArsFamily | 'all'; what: string; reason: string }> = [
  { family: 'all', what: 'vector and hybrid ranking', reason: 'the hermetic arm has no embedding key; every search and query runs on the keyword path. A paid arm (requirePaidArm, startPaidRun) is follow-up work.' },
  { family: 'E12', what: 'score after reranking (the case gbrain#7156 reports)', reason: 'the reranker calls a paid provider; the hermetic arm checks monotonic score on the keyword path, where no reranker runs.' },
  { family: 'E15', what: 'query --expand', reason: 'expansion calls a chat model; query is measured without it.' },
  { family: 'E8', what: 'mention coverage after extraction', reason: 'mention extraction is never run, on purpose: the shape is a name that only raw notes carry while coverage is pending.' },
];

// ─── Observations and the pure scorer (exported for tests) ──────────────

export interface ArsRow { key: string; slug: string; source: string; score: number | null; chars: number }
export interface ArsEntityView { found: boolean; key: string | null; suggestions: string[]; named: string[] }
/** What one (probe, surface) call returned, reduced to what the scorer reads. */
export interface ArsObservation { rows: ArsRow[]; entity: ArsEntityView | null; stages: string[]; error: string | null }

export const emptyObservation = (): ArsObservation => ({ rows: [], entity: null, stages: [], error: null });

/** Distinct page keys of the first k rows, in product order. */
export function distinctPages(rows: readonly ArsRow[], k = ARS_TOP_K): string[] {
  const out: string[] = [];
  for (const r of rows.slice(0, k)) if (!out.includes(r.key)) out.push(r.key);
  return out;
}

export interface ProbeScore { pass: boolean; rank: number | null; detail: Record<string, unknown> }

export function scoreProbe(gold: ArsGold, obs: ArsObservation): ProbeScore {
  if (obs.error) return { pass: false, rank: null, detail: { error: obs.error } };
  const pages = distinctPages(obs.rows);
  const rankOf = (key: string) => { const i = pages.indexOf(key); return i < 0 ? null : i + 1; };
  const entity = obs.entity ?? { found: false, key: null, suggestions: [], named: [] };
  switch (gold.kind) {
    case 'rank': {
      const rank = rankOf(gold.target);
      const above = (gold.not_above ?? []).filter(k => { const r = rankOf(k); return r !== null && (rank === null || r < rank); });
      const familyTop5 = gold.family_pages ? pages.slice(0, 5).filter(k => gold.family_pages!.includes(k)).length : null;
      const placed = gold.need === 'first' ? rank === 1 : rank !== null;
      const pass = placed && above.length === 0 && (familyTop5 === null || familyTop5 <= (gold.family_max_top5 ?? Infinity));
      return { pass, rank, detail: { ranked_above_target: above, ...(familyTop5 === null ? {} : { family_in_top5: familyTop5 }) } };
    }
    case 'twin': {
      const top = obs.rows.slice(0, ARS_TOP_K);
      const sources = new Map<string, Set<string>>();
      for (const r of top) sources.set(r.slug, new Set([...(sources.get(r.slug) ?? []), r.source]));
      const duplicated = [...sources].filter(([, s]) => s.size > 1).map(([slug]) => slug);
      const hit1 = top.length > 0 && gold.keys.includes(top[0].key);
      return { pass: hit1 && duplicated.length === 0, rank: hit1 ? 1 : null, detail: { hit1, duplicated_slugs: duplicated } };
    }
    case 'resolve': {
      const right = entity.found && entity.key === gold.key;
      return { pass: right, rank: null, detail: { resolved: entity.key, wrong: entity.found && !right, forbidden_suggested: entity.suggestions.filter(s => gold.forbidden_suggestions.includes(s)) } };
    }
    case 'refuse':
      return { pass: !entity.found && !entity.suggestions.some(s => gold.forbidden_suggestions.includes(s)), rank: null, detail: { resolved: entity.key, wrong: entity.found, forbidden_suggested: entity.suggestions.filter(s => gold.forbidden_suggestions.includes(s)) } };
    case 'mentions': {
      const named = entity.named.filter(k => gold.keys.includes(k));
      return { pass: named.length > 0, rank: null, detail: { found: entity.found, mention_pages_named: named.length, mention_pages: gold.keys.length } };
    }
    case 'no-mentions':
      return { pass: !entity.found && entity.named.length === 0, rank: null, detail: { found: entity.found, named: entity.named } };
    case 'chunk-cap': {
      const max = Math.max(0, ...obs.rows.map(r => r.chars));
      const returned = obs.rows.some(r => r.key === gold.page);
      return { pass: returned && max <= gold.cap, rank: rankOf(gold.page), detail: { max_chars: max, page_returned: returned } };
    }
    case 'no-stage':
      return { pass: !obs.stages.includes(gold.stage), rank: null, detail: { stages: obs.stages } };
    case 'empty':
      return { pass: obs.rows.length === 0, rank: null, detail: { rows: obs.rows.length } };
    case 'known-item': {
      const rank = rankOf(gold.target);
      return { pass: rank === 1, rank, detail: {} };
    }
  }
}

/** Non-increasing score down the list (rows with no numeric score are skipped). */
export function scoreMonotonic(rows: readonly ArsRow[]): { ok: boolean; at: number | null } {
  const s = rows.map(r => r.score).filter((x): x is number => typeof x === 'number');
  for (let i = 1; i < s.length; i++) if (s[i] > s[i - 1] + 1e-12) return { ok: false, at: i };
  return { ok: true, at: null };
}

export interface ProbeRow {
  probe_id: string;
  family: ArsFamily;
  variant: string;
  surface: ArsSurface;
  negative: boolean;
  status: 'scored' | 'error' | 'not_measured';
  pass: boolean;
  rank: number | null;
  detail: Record<string, unknown>;
  reason?: string;
}

type Tally = { passed: number; total: number };
const tally = (rows: readonly ProbeRow[]): Tally => ({ passed: rows.filter(r => r.pass).length, total: rows.length });
const rate = (t: Tally) => (t.total ? t.passed / t.total : null);

export interface FamilySummary {
  family: ArsFamily;
  shape: string;
  issue: string;
  status: 'measured' | 'not_measured';
  reason?: string;
  headline: Partial<Record<ArsSurface, Tally>>;
  negatives: Tally;
  variants: Record<string, Partial<Record<ArsSurface, Tally>>>;
  metrics: Record<string, unknown>;
}

export interface RunExtras {
  monotonic: { checked: number; ok: number; violations: Array<{ id: string; at: number }> };
  doctor?: { ran: boolean; flagged_pairs: number; pairs: number; checks_naming_a_stub: string[]; error?: string };
  stored_chunk_max_chars?: number | null;
  e14_state?: { reachable: boolean; detail: string };
  /** E15: probes whose search and query return the same distinct pages in the same order in the first 10 rows. */
  e15_identical_top10?: { n: number; of: number };
  max_returned_chars: number;
}

export function summarizeFamilies(rows: readonly ProbeRow[], extras: RunExtras): FamilySummary[] {
  return ARS_FAMILIES.map(family => {
    const meta = FAMILY_META[family];
    const fr = rows.filter(r => r.family === family);
    const scored = fr.filter(r => r.status !== 'not_measured');
    const bySurface = (rs: readonly ProbeRow[]) => {
      const out: Partial<Record<ArsSurface, Tally>> = {};
      for (const s of ['search', 'query', 'entity'] as const) { const x = rs.filter(r => r.surface === s); if (x.length) out[s] = tally(x); }
      return out;
    };
    const variants: FamilySummary['variants'] = {};
    for (const v of [...new Set(fr.map(r => r.variant))]) variants[v] = bySurface(scored.filter(r => r.variant === v));
    const head = scored.filter(r => meta.headline.includes(r.variant) && !r.negative);
    const metrics: Record<string, unknown> = {};
    const notMeasured = fr.filter(r => r.status === 'not_measured');
    const base: FamilySummary = { family, shape: meta.shape, issue: meta.issue, status: 'measured', headline: bySurface(head), negatives: tally(scored.filter(r => r.negative)), variants, metrics };
    if (family === 'E12') {
      metrics.monotonic_lists = { passed: extras.monotonic.ok, total: extras.monotonic.checked };
      metrics.violations = extras.monotonic.violations.slice(0, 10);
      metrics.note = 'keyword path only; no reranker runs in the hermetic arm';
      return { ...base, headline: { search: { passed: extras.monotonic.ok, total: extras.monotonic.checked } } };
    }
    if (head.length === 0 && notMeasured.some(r => meta.headline.includes(r.variant))) {
      base.status = 'not_measured';
      base.reason = [...new Set(notMeasured.filter(r => meta.headline.includes(r.variant)).map(r => r.reason))].join('; ');
    }
    const perSurface = (fn: (rs: ProbeRow[]) => unknown) => Object.fromEntries((['search', 'query'] as const).map(s => [s, fn(head.filter(r => r.surface === s))]));
    if (family === 'E1') {
      metrics.queries_with_duplicate_slug_in_top10 = perSurface(rs => ({ n: rs.filter(r => ((r.detail.duplicated_slugs as string[] | undefined) ?? []).length > 0).length, of: rs.length }));
      metrics.hit_at_1_target_or_twin = perSurface(rs => ({ n: rs.filter(r => r.detail.hit1 === true).length, of: rs.length }));
    }
    if (family === 'E2') metrics.stub_above_target = perSurface(rs => ({ n: rs.filter(r => ((r.detail.ranked_above_target as string[]) ?? []).length > 0).length, of: rs.length }));
    if (family === 'E3') {
      metrics.answer_rank_1 = perSurface(rs => ({ n: rs.filter(r => r.rank === 1).length, of: rs.length }));
      metrics.family_over_one_of_top5 = perSurface(rs => ({ n: rs.filter(r => Number(r.detail.family_in_top5 ?? 0) > 1).length, of: rs.length }));
    }
    if (family === 'E6' || family === 'E7') {
      const ent = scored.filter(r => r.surface === 'entity');
      metrics.resolved_right = { n: head.filter(r => r.pass).length, of: head.length };
      metrics.resolved_to_wrong_page = { n: ent.filter(r => r.detail.wrong === true).length, of: ent.length };
      metrics.misses_suggesting_index_or_digest = { n: ent.filter(r => ((r.detail.forbidden_suggested as string[]) ?? []).length > 0).length, of: ent.length };
      if (family === 'E7') metrics.doctor = extras.doctor ?? null;
    }
    if (family === 'E8') metrics.mention_pages_named = head.map(r => ({ probe: r.probe_id, named: r.detail.mention_pages_named, of: r.detail.mention_pages }));
    if (family === 'E13') {
      metrics.max_returned_chars_this_family = perSurface(rs => Math.max(0, ...rs.map(r => Number(r.detail.max_chars ?? 0))));
      metrics.max_returned_chars_whole_run = extras.max_returned_chars;
      metrics.max_stored_chunk_chars = extras.stored_chunk_max_chars ?? null;
      metrics.cap_chars = ARS_CHUNK_CAP_CHARS;
    }
    if (family === 'E14' && extras.e14_state) metrics.projection_state = extras.e14_state;
    if (family === 'E15') {
      if (extras.e15_identical_top10) metrics.search_query_identical_top10 = extras.e15_identical_top10;
      metrics.ranking = perSurface(rs => {
        const n = rs.length || 1;
        const hit = (k: number) => rs.filter(r => r.rank !== null && r.rank <= k).length / n;
        return { n: rs.length, hit_at_1: hit(1), hit_at_5: hit(5), hit_at_10: hit(10), mrr: rs.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / n };
      });
    }
    return base;
  });
}

/** Every measured family passes every headline and negative probe on every surface, and every list is monotonic. */
export function arsVerdict(families: readonly FamilySummary[]): 'pass' | 'fail' {
  return families.every(f => f.status === 'not_measured' || (Object.values(f.headline).every(t => t!.passed === t!.total) && f.negatives.passed === f.negatives.total)) ? 'pass' : 'fail';
}

/** The category's scorer over a full set of observations: what the mutation suite and the runner share. */
export function scoreObservations(probes: readonly ArsProbe[], gold: (id: string) => ArsGold, observations: ReadonlyMap<string, ArsObservation>): { rows: ProbeRow[]; families: FamilySummary[]; verdict: 'pass' | 'fail' } {
  const rows: ProbeRow[] = [];
  const monotonic: RunExtras['monotonic'] = { checked: 0, ok: 0, violations: [] };
  let maxChars = 0;
  for (const p of probes) for (const surface of p.surfaces) {
    const id = `${p.id}@${surface}`;
    const obs = observations.get(id);
    if (!obs) continue;
    const s = scoreProbe(gold(p.id), obs);
    rows.push({ probe_id: p.id, family: p.family, variant: p.variant, surface, negative: p.negative, status: obs.error ? 'error' : 'scored', pass: s.pass, rank: s.rank, detail: s.detail });
    if (surface !== 'entity' && !obs.error) {
      const m = scoreMonotonic(obs.rows);
      monotonic.checked++;
      if (m.ok) monotonic.ok++; else monotonic.violations.push({ id, at: m.at! });
      maxChars = Math.max(maxChars, ...obs.rows.map(r => r.chars));
    }
  }
  const families = summarizeFamilies(rows, { monotonic, max_returned_chars: maxChars });
  return { rows, families, verdict: arsVerdict(families) };
}

// ─── gbrain surface ──────────────────────────────────────────────────────

type OperationsModule = typeof import('gbrain/operations');
type EngineModule = typeof import('gbrain/pglite-engine');
interface ImportModule { importImageFile: (engine: unknown, filePath: string, relativePath: string, opts: { noEmbed?: boolean; sourceId?: string }) => Promise<{ slug: string; status: string; error?: string }> }
export type OpCall = (name: string, params: Record<string, unknown>) => Promise<unknown>;
/** Test seam: wraps every operation call (a deliberately broken adapter rewrites what search returns). */
export type OpWrapper = (name: string, params: Record<string, unknown>, call: OpCall) => Promise<unknown>;

interface Sut {
  engine: PGLiteEngineType;
  /** One operation call with the response meta and notices it emitted. */
  call: (name: string, params: Record<string, unknown>) => Promise<{ result: unknown; meta: Record<string, unknown>; notices: unknown[]; ms: number }>;
  params: (name: string) => string[];
  sql: <T = Record<string, unknown>>(q: string, params?: unknown[]) => Promise<T[]>;
  importImage: ImportModule['importImageFile'];
}

class HarnessError extends Error {}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function openSut(gut: GbrainUnderTest, wrap?: OpWrapper): Promise<Sut> {
  const { PGLiteEngine } = await importGbrain<EngineModule>(gut, 'src/core/pglite-engine.ts');
  const { operations } = await importGbrain<OperationsModule>(gut, 'src/core/operations.ts');
  const { importImageFile } = await importGbrain<ImportModule>(gut, 'src/core/import-file.ts');
  const { resetGateway } = await importGbrain<{ resetGateway: () => void }>(gut, 'src/core/ai/gateway.ts');
  resetGateway();
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const config: GBrainConfig = { engine: 'pglite', database_path: ':memory:' };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  let meta: Record<string, unknown> = {};
  let notices: unknown[] = [];
  const ctx = {
    engine, config, logger, dryRun: false, remote: false, sourceId: 'default',
    emitNotice: (n: unknown) => { notices.push(n); },
    emitResponseMeta: (k: string, v: unknown) => { meta[k] = v; },
  } as unknown as OperationContext;
  const byName = new Map(operations.map(o => [o.name, o]));
  const raw: OpCall = async (name, params) => {
    const o = byName.get(name);
    if (!o) throw new HarnessError(`gbrain has no operation ${name}`);
    return await o.handler(ctx, params);
  };
  const op: OpCall = wrap ? (name, params) => wrap(name, params, raw) : raw;
  return {
    engine,
    call: async (name, params) => {
      meta = {};
      notices = [];
      const t0 = performance.now();
      const result = await op(name, params);
      return { result, meta, notices, ms: performance.now() - t0 };
    },
    params: name => Object.keys((byName.get(name) as { params?: Record<string, unknown> } | undefined)?.params ?? {}),
    sql: async (q, params) => await (engine as unknown as { executeRaw: <T>(q: string, p?: unknown[]) => Promise<T[]> }).executeRaw(q, params),
    importImage: importImageFile,
  };
}

function toRows(result: unknown): ArsRow[] {
  if (!Array.isArray(result)) throw new Error(`expected a result array, got ${typeof result}`);
  return result.map((r: Record<string, unknown>) => {
    const source = String(r.source_id ?? 'default');
    const slug = String(r.slug);
    return { key: pageKey(source, slug), slug, source, score: typeof r.score === 'number' ? r.score : null, chars: typeof r.chunk_text === 'string' ? r.chunk_text.length : 0 };
  });
}

/** Every page a response names: values of any slug field (with its row's source_id) anywhere in the payload. */
function namedKeys(value: unknown, out = new Set<string>()): string[] {
  if (Array.isArray(value)) for (const v of value) namedKeys(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.slug === 'string') out.add(pageKey(String(o.source_id ?? 'default'), o.slug));
    for (const v of Object.values(o)) namedKeys(v, out);
  }
  return [...out].sort();
}

function toEntity(result: unknown): ArsEntityView {
  const r = (result ?? {}) as { found?: boolean; card?: { entity?: { slug?: string; source_id?: string } }; suggestions?: Array<{ slug: string; source_id?: string }> };
  const e = r.card?.entity;
  return {
    found: r.found === true,
    key: r.found && e?.slug ? pageKey(e.source_id ?? 'default', e.slug) : null,
    suggestions: (r.suggestions ?? []).map(s => pageKey(s.source_id ?? 'default', s.slug)),
    named: namedKeys(result),
  };
}

const stagesOf = (meta: Record<string, unknown>) => {
  const degraded = (meta.retrieval as { degraded?: Array<{ stage?: string }> } | undefined)?.degraded ?? [];
  return [...new Set(degraded.map(d => String(d.stage)))].sort();
};

// ─── Seeding and presence ────────────────────────────────────────────────

export interface SeedReport { writes: number; write_errors: string[]; images: number; image_errors: string[]; sources_added: string[] }

async function seed(sut: Sut, ledger: ArsLedger, home: string): Promise<SeedReport> {
  const report: SeedReport = { writes: 0, write_errors: [], images: 0, image_errors: [], sources_added: [] };
  for (const s of [...new Set(ledger.pages.map(p => p.source))].filter(s => s !== 'default')) {
    await sut.call('sources_add', { id: s, name: s, federated: true });
    report.sources_added.push(s);
  }
  for (const p of ledger.pages) {
    try {
      await sut.call('put_page', { slug: p.slug, content: renderPage(p), ...(p.source === 'default' ? {} : { source_id: p.source }) });
      report.writes++;
    } catch (e) {
      report.write_errors.push(`${p.source}:${p.slug}: ${errMsg(e)}`);
    }
  }
  if (ledger.images.length) {
    const dir = join(home, 'ars-images');
    mkdirSync(dir, { recursive: true });
    for (const img of ledger.images) {
      const file = join(dir, img.file);
      writeFileSync(file, Buffer.from(ONE_PIXEL_PNG, 'base64'));
      try {
        const r = await sut.importImage(sut.engine, file, img.slug, { noEmbed: true });
        if (r.status === 'imported') report.images++; else report.image_errors.push(`${img.slug}: ${r.status} ${r.error ?? ''}`);
      } catch (e) {
        report.image_errors.push(`${img.slug}: ${errMsg(e)}`);
      }
    }
  }
  return report;
}

export interface PresenceCheck { name: string; ok: boolean; expected: number; actual: number; missing?: string[] }

/** Every page gold names, and every image, is in the brain and readable by its exact slug before anything is scored. */
async function presence(sut: Sut, ledger: ArsLedger, gold: GoldStore<ArsGold>): Promise<PresenceCheck[]> {
  const checks: PresenceCheck[] = [];
  const counts = await sut.sql<{ source_id: string; n: number }>(`SELECT source_id, count(*)::int AS n FROM pages WHERE deleted_at IS NULL GROUP BY source_id`);
  for (const s of [...new Set(ledger.pages.map(p => p.source))]) {
    const want = ledger.pages.filter(p => p.source === s).length + (s === 'default' ? ledger.images.length : 0);
    checks.push({ name: `pages in ${s}`, ok: (counts.find(c => c.source_id === s)?.n ?? 0) === want, expected: want, actual: counts.find(c => c.source_id === s)?.n ?? 0 });
  }
  const keys = new Set<string>();
  for (const id of gold.ids()) gold.score(id, g => {
    if (g.kind === 'rank' || g.kind === 'known-item') keys.add(g.target);
    if (g.kind === 'rank') for (const k of [...(g.not_above ?? []), ...(g.family_pages ?? [])]) keys.add(k);
    if (g.kind === 'twin' || g.kind === 'mentions') for (const k of g.keys) keys.add(k);
    if (g.kind === 'resolve') keys.add(g.key);
    if (g.kind === 'chunk-cap') keys.add(g.page);
  });
  const missing: string[] = [];
  for (const k of [...keys].sort()) {
    const [source, slug] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    try {
      const r = (await sut.call('get_page', { slug, source_id: source, include_content: false })).result as { slug?: string } | null;
      if (r?.slug !== slug) missing.push(k);
    } catch { missing.push(k); }
  }
  checks.push({ name: 'gold pages readable by exact slug (get_page)', ok: missing.length === 0, expected: keys.size, actual: keys.size - missing.length, ...(missing.length ? { missing: missing.slice(0, 10) } : {}) });
  const imgs = await sut.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE page_kind = 'image' AND deleted_at IS NULL`);
  checks.push({ name: 'image pages written by importImageFile', ok: (imgs[0]?.n ?? 0) === ledger.images.length, expected: ledger.images.length, actual: imgs[0]?.n ?? 0 });
  return checks;
}

// ─── Run ─────────────────────────────────────────────────────────────────

export interface ArsRunOptions {
  gut: GbrainUnderTest;
  seed?: number;
  families?: readonly ArsFamily[];
  wrapOp?: OpWrapper;
  log?: (s: string) => void;
}

export interface ArsRunResult {
  world: GeneratedArs;
  goldFingerprint: string;
  seedReport: SeedReport | null;
  presence: PresenceCheck[];
  rows: ProbeRow[];
  families: FamilySummary[] | null;
  verdict: 'pass' | 'fail' | null;
  extras: RunExtras | null;
  acc: ProbeAccounting;
  latencies: number[];
  wallMs: number;
  harnessError: string | null;
}

export async function runAgentRetrievalShapes(opts: ArsRunOptions): Promise<ArsRunResult> {
  return withHermeticEnv('ars', h => runHermetic(opts, h.home));
}

async function runHermetic(opts: ArsRunOptions, home: string): Promise<ArsRunResult> {
  const t0 = performance.now();
  const log = opts.log ?? (() => {});
  const world = generateArsWorld({ seed: opts.seed ?? ARS_DEFAULT_SEED, families: opts.families });
  const gold = new GoldStore<ArsGold>('agent-retrieval-shapes', world.gold.entries());
  const { ledger } = world;
  const sut = await openSut(opts.gut, opts.wrapOp);
  const filterSurfaces = (['search', 'query'] as const).filter(s => sut.params(s).includes('where'));
  const unmeasured = (p: ArsProbe, s: ArsSurface) => p.params.where !== undefined && !(filterSurfaces as readonly string[]).includes(s);
  const planned = ledger.probes.reduce((n, p) => n + p.surfaces.filter(s => !unmeasured(p, s)).length, 0);
  const acc = new ProbeAccounting(planned);
  const result: ArsRunResult = { world, goldFingerprint: gold.fingerprint, seedReport: null, presence: [], rows: [], families: null, verdict: null, extras: null, acc, latencies: [], wallMs: 0, harnessError: null };
  try {
    log(`seeding ${ledger.pages.length} pages and ${ledger.images.length} images across ${new Set(ledger.pages.map(p => p.source)).size} sources`);
    result.seedReport = await seed(sut, ledger, home);
    result.presence = await presence(sut, ledger, gold);
    const failed = result.presence.filter(p => !p.ok);
    if (failed.length) {
      const msg = `presence assertions failed: ${failed.map(f => `${f.name} expected ${f.expected} got ${f.actual}`).join('; ')}${result.seedReport.write_errors.length ? `; first write error: ${result.seedReport.write_errors[0]}` : ''}`;
      acc.error('presence', 'harness', msg);
      result.harnessError = msg;
      return result;
    }

    const observations = new Map<string, ArsObservation>();
    const observe = async (p: ArsProbe, surface: ArsSurface): Promise<void> => {
      const id = `${p.id}@${surface}`;
      const obs = emptyObservation();
      try {
        if (surface === 'entity') {
          const r = await sut.call('entity', { name: p.text });
          result.latencies.push(r.ms);
          obs.entity = toEntity(r.result);
        } else {
          const r = await sut.call(surface, { query: p.text, limit: ARS_LIMIT, ...p.params });
          result.latencies.push(r.ms);
          obs.rows = toRows(r.result);
          obs.stages = stagesOf(r.meta);
        }
        acc.score(id, gold.score(p.id, g => (scoreProbe(g, obs).pass ? 1 : 0)));
      } catch (e) {
        if (e instanceof HarnessError) throw e;
        obs.error = errMsg(e);
        acc.error(id, 'sut', obs.error);
      }
      observations.set(id, obs);
    };

    const extrasNotes: Partial<RunExtras> = {};
    const ordered = [...ledger.probes.filter(p => p.family !== 'E14'), ...ledger.probes.filter(p => p.family === 'E14')];
    let unsealed = false;
    for (const p of ordered) {
      if (p.family === 'E14' && !unsealed) {
        unsealed = true;
        extrasNotes.e14_state = await unsealImages(sut, ledger);
        log(`E14 projection state: ${extrasNotes.e14_state.detail}`);
      }
      for (const s of p.surfaces) if (!unmeasured(p, s) && !(p.family === 'E14' && !extrasNotes.e14_state?.reachable)) await observe(p, s);
    }
    log(`observed ${observations.size} probe-surface pairs`);

    if (ledger.probes.some(p => p.family === 'E7')) extrasNotes.doctor = await doctorFlags(sut, ledger);
    if (ledger.probes.some(p => p.family === 'E13')) {
      const slug = ledger.pages.find(p => p.family === 'E13')!.slug;
      try {
        const r = (await sut.call('get_chunks', { slug, limit: 500 })).result as Array<{ chunk_text?: string }> | { chunks?: Array<{ chunk_text?: string }> };
        const chunks = Array.isArray(r) ? r : r.chunks ?? [];
        extrasNotes.stored_chunk_max_chars = Math.max(0, ...chunks.map(c => (c.chunk_text ?? '').length));
      } catch { extrasNotes.stored_chunk_max_chars = null; }
    }

    const scored = scoreObservations(ledger.probes, id => gold.read(id), observations);
    const notMeasuredRows: ProbeRow[] = [];
    for (const p of ledger.probes) for (const s of p.surfaces) {
      if (observations.has(`${p.id}@${s}`)) continue;
      const lacking = (['search', 'query'] as const).filter(x => !(filterSurfaces as readonly string[]).includes(x));
      const reason = unmeasured(p, s)
        ? `capability gap: ${lacking.join(' and ')} ${lacking.length > 1 ? 'declare' : 'declares'} no where (frontmatter filter) parameter at this build`
        : `the projection_pending state could not be produced hermetically: ${extrasNotes.e14_state?.detail ?? 'unknown'}`;
      notMeasuredRows.push({ probe_id: p.id, family: p.family, variant: p.variant, surface: s, negative: p.negative, status: 'not_measured', pass: false, rank: null, detail: {}, reason });
    }
    result.rows = [...scored.rows, ...notMeasuredRows];
    const monotonic = { checked: 0, ok: 0, violations: [] as Array<{ id: string; at: number }> };
    let maxChars = 0;
    for (const [id, obs] of observations) {
      if (id.endsWith('@entity') || obs.error) continue;
      const m = scoreMonotonic(obs.rows);
      monotonic.checked++;
      if (m.ok) monotonic.ok++; else monotonic.violations.push({ id, at: m.at! });
      maxChars = Math.max(maxChars, ...obs.rows.map(r => r.chars));
    }
    const e15 = ledger.probes.filter(p => p.family === 'E15');
    if (e15.length) {
      const same = e15.filter(p => {
        const s = observations.get(`${p.id}@search`), q = observations.get(`${p.id}@query`);
        return s && q && !s.error && !q.error && distinctPages(s.rows).join('|') === distinctPages(q.rows).join('|');
      });
      extrasNotes.e15_identical_top10 = { n: same.length, of: e15.length };
    }
    result.extras = { monotonic, max_returned_chars: maxChars, ...extrasNotes };
    const families = summarizeFamilies(result.rows, result.extras);
    result.families = opts.families ? families.filter(f => opts.families!.includes(f.family)) : families;
    result.verdict = arsVerdict(result.families);
    return result;
  } catch (e) {
    const msg = `harness: ${errMsg(e)}`;
    acc.error('run', 'harness', msg);
    result.harnessError = msg;
    return result;
  } finally {
    result.wallMs = performance.now() - t0;
    await sut.engine.disconnect().catch(() => {});
  }
}

/**
 * E14 state: the image pages are written by gbrain's importer, sealed. The
 * shape needs them unsealed, the state migration v153 left on upgraded
 * brains; no hermetic operation produces it, so one SQL update clears their
 * text_projection_revision. The state counts as reachable only when a search
 * scoped to images then reports projection_pending.
 */
async function unsealImages(sut: Sut, ledger: ArsLedger): Promise<{ reachable: boolean; detail: string }> {
  if (!ledger.images.length) return { reachable: false, detail: 'no image pages in this run' };
  try {
    await sut.sql(`UPDATE pages SET text_projection_revision = NULL WHERE page_kind = 'image' AND slug = ANY($1::text[])`, [ledger.images.map(i => i.slug)]);
    const r = await sut.call('search', { query: 'scan', limit: 5, types: ['image'] });
    const stages = stagesOf(r.meta);
    return stages.includes('projection_pending')
      ? { reachable: true, detail: `${ledger.images.length} image pages unsealed by SQL; a search scoped to types [image] reports projection_pending` }
      : { reachable: false, detail: `after unsealing ${ledger.images.length} image pages, a search scoped to images reports stages [${stages.join(', ')}], not projection_pending` };
  } catch (e) {
    return { reachable: false, detail: `unsealing failed: ${errMsg(e)}` };
  }
}

/** E7: does any doctor check name both pages of a title-prefixed duplicate pair? */
async function doctorFlags(sut: Sut, ledger: ArsLedger): Promise<NonNullable<RunExtras['doctor']>> {
  const pairs = ledger.probes.filter(p => p.family === 'E7' && p.variant === 'prefixed').map(p => [String(p.design.stub), String(p.design.slug)] as const);
  try {
    const r = (await sut.call('run_doctor', {})).result as { checks?: Array<{ name?: string }> };
    const checks = (r.checks ?? []).map(c => ({ name: String(c.name), text: JSON.stringify(c) }));
    return {
      ran: true, pairs: pairs.length,
      flagged_pairs: pairs.filter(([stub, canon]) => checks.some(c => c.text.includes(stub) && c.text.includes(canon))).length,
      checks_naming_a_stub: checks.filter(c => pairs.some(([stub]) => c.text.includes(stub))).map(c => c.name),
    };
  } catch (e) {
    return { ran: false, pairs: pairs.length, flagged_pairs: 0, checks_naming_a_stub: [], error: errMsg(e) };
  }
}

// ─── Findings ────────────────────────────────────────────────────────────

const PIN_SHA = /#([0-9a-f]{40})$/.exec(gbrainPin())?.[1] ?? '';
const fmt = (t: Tally | undefined) => (t ? `${t.passed}/${t.total}` : 'n/a');

/** One finding per family whose headline fails or whose capability is missing at this build. */
export function arsFindings(families: readonly FamilySummary[], gut: GbrainUnderTest, receipt: string, date: string): BugEntry[] {
  const sha = gut.overlay?.build.commit ?? PIN_SHA;
  const out: BugEntry[] = [];
  for (const f of families) {
    const meta = FAMILY_META[f.family];
    const failing = f.status === 'not_measured' ? f.family === 'E5' : Object.values(f.headline).some(t => t!.passed < t!.total);
    if (!failing) continue;
    const n = Number(f.family.slice(1));
    const head = Object.entries(f.headline).map(([s, t]) => `${s} ${fmt(t)}`).join(', ');
    const extra = f.family === 'E13' ? `; largest returned row ${String(f.metrics.max_returned_chars_whole_run)} characters, largest stored chunk ${String(f.metrics.max_stored_chunk_chars)}`
      : f.family === 'E7' ? `; doctor flags ${String((f.metrics.doctor as RunExtras['doctor'])?.flagged_pairs ?? 0)} of ${String((f.metrics.doctor as RunExtras['doctor'])?.pairs ?? 0)} pairs`
        : f.family === 'E1' ? `; duplicate slug in the top 10: ${JSON.stringify(f.metrics.queries_with_duplicate_slug_in_top10)}`
          : f.family === 'E6' ? `; wrong page ${JSON.stringify(f.metrics.resolved_to_wrong_page)}, index or digest suggested ${JSON.stringify(f.metrics.misses_suggesting_index_or_digest)}`
            : f.family === 'E15' ? `; ${JSON.stringify(f.metrics.ranking)}; search and query return the same top 10 for ${JSON.stringify(f.metrics.search_query_identical_top10)}` : '';
    const actual = f.status === 'not_measured' ? `${f.reason}; without a filter the right interview ranks first ${Object.entries(f.variants.baseline ?? {}).map(([s, t]) => `${s} ${fmt(t)}`).join(', ')} (baseline)`
      : `headline pass ${head} (${meta.headline.join(', ') || 'every list'})${extra}`;
    out.push({
      id: `${BUG_PREFIX}-${n}`, category: CATEGORY, classification: meta.classification, contract: meta.contract, gbrain_sha: sha, surface: meta.surface,
      repro: `bun eval/runner/agent-retrieval-shapes.ts --families ${f.family}`, expected: meta.expected, actual, status: 'open',
      review: { date, gbrain_sha: sha, evidence: 'rerun', receipts: [receipt], note: `found by this run (gbrain${meta.issue})` },
    });
  }
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

export function parseFamilies(spec: string | undefined): ArsFamily[] | undefined {
  if (!spec) return undefined;
  const fams = spec.split(',').map(s => s.trim().toUpperCase());
  const bad = fams.filter(f => !(ARS_FAMILIES as readonly string[]).includes(f));
  if (bad.length) throw new Error(`--families: unknown ${bad.join(', ')}; use E1 to E15`);
  return fams as ArsFamily[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seedValue = seedArg === undefined ? ARS_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seedValue)) throw new Error('--seed needs an integer');
  const families = parseFamilies(argValue(argv, '--families'));
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# Agent retrieval shapes (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);

  const r = await runAgentRetrievalShapes({ gut, seed: seedValue, families, log });
  const a = r.acc.summary();
  const findings = r.families ? arsFindings(r.families, gut, outPath, startedAt.slice(0, 10)) : [];
  if (argv.includes('--record-bugs')) for (const f of findings) upsertBug(f);
  const defaultRecipe = seedValue === ARS_DEFAULT_SEED && !families;
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider and TypeSafe keys stripped, keyword search only; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: r.harnessError || a.run_invalid ? 'error' : 'completed',
    ...(r.harnessError || a.run_invalid ? {} : { verdict: defaultRecipe ? (r.verdict ?? 'fail') : 'partial' }),
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: a.publishable && !r.harnessError && defaultRecipe,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      decide: DECIDE_OFF,
      caller: 'operation handlers with OperationContext { remote: false, sourceId: default }',
      sources: ['default', 'source-a (federated, added with sources_add)', 'source-b (federated, added with sources_add)'],
      search_path: `search and query with limit ${ARS_LIMIT} and each probe's own params, scored on the distinct pages of the first ${ARS_TOP_K} rows; no embedding key (keyword only), no reranker, no expansion`,
      entity_path: 'entity { name } (card lookup, zero LLM); mention extraction never run',
      seed: seedValue,
      families: families ?? 'all',
      generator_version: ARS_GENERATOR_VERSION,
      ledger_sha256: r.world.fingerprint,
      oracle: 'eval/generators/agent-retrieval-shapes-gen.ts deriveArsGold: re-parses the rendered pages; throws when it disagrees with the design',
      chunk_cap_chars: ARS_CHUNK_CAP_CHARS,
      e14_state: 'image pages written by importImageFile (noEmbed), then text_projection_revision cleared by SQL (the unsealed state; no hermetic operation produces it)',
      gbrain_overlay: overlaySummary(gut),
      verdict_meaning: 'pass only when every measured family passes every headline and negative probe on every surface; report-only, nothing gates (registry promotion rules)',
    },
    hashes: { ledger_sha256: r.world.fingerprint, gold_fingerprint: r.goldFingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    latency_ms: latencySummary(r.latencies, 'wall time of each search, query and entity call (seeding excluded)'),
    data: {
      families: r.families,
      hermetic_wall_ms: Math.round(r.wallMs),
      ledger_counts: { pages: r.world.ledger.pages.length, images: r.world.ledger.images.length, probes: r.world.ledger.probes.length },
      presence: r.presence,
      seed_report: r.seedReport,
      extras: r.extras,
      not_measured: NOT_MEASURED,
      findings: findings.map(f => ({ id: f.id, classification: f.classification, surface: f.surface, expected: f.expected, actual: f.actual, repro: f.repro })),
      failures: r.rows.filter(x => x.status !== 'not_measured' && !x.pass).map(x => ({ probe_id: x.probe_id, surface: x.surface, rank: x.rank, detail: x.detail })),
      rows: r.rows,
      harness_error: r.harnessError,
    },
  };
  mkdirSync(join(outPath, '..'), { recursive: true });
  writeReceipt(outPath, receipt);

  log(`verdict: ${receipt.verdict ?? `error (${r.harnessError})`}${defaultRecipe || !r.verdict ? '' : ` (not the default seed and family set; these families score ${r.verdict})`}`);
  log('safety contracts: none preregistered (report-only category)');
  if (r.families) {
    log('\n| family | shape | issue | headline pass | negatives | status |\n|---|---|---|---|---|---|');
    for (const f of r.families) {
      const head = Object.entries(f.headline).map(([s, t]) => `${s} ${fmt(t)}`).join(', ') || 'n/a';
      log(`| ${f.family} | ${f.shape} | gbrain${f.issue} | ${head} | ${f.negatives.total ? fmt(f.negatives) : 'none'} | ${f.status === 'measured' ? 'measured' : `not measured: ${f.reason}`} |`);
    }
    const e15 = r.families.find(f => f.family === 'E15');
    if (e15?.metrics.ranking) log(`E15 ranking: ${JSON.stringify(e15.metrics.ranking)}`);
  }
  for (const f of findings) log(`gbrain ${f.classification} ${f.id}: ${f.actual} - repro: ${f.repro}`);
  log(`hermetic wall time: ${(r.wallMs / 1000).toFixed(1)} s`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, families: r.families, errors: a.errors }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : receipt.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
