/**
 * BrainBench N4: entity resolution (registry id `entity-resolution`).
 *
 * Question: when a note or an agent names a person or company by a variant
 * (nickname, typo, @handle, initials, a former name) does gbrain land on the
 * right entity page, refuse when the name is truly ambiguous, and keep two
 * different people apart even when they share a name or a slug?
 *
 * What runs (all real gbrain code, loaded through gbrain-under-test.ts so
 * `--gbrain <checkout>` measures a copied overlay instead of the pin):
 *   resolver         resolveEntitySlugWithSource, the read-time cascade
 *                    (exact slug, alias exact, exact basename, bare-name
 *                    prefix expansion, same-name fuzzy match, slugify
 *                    fallback) in src/core/entities/resolve.ts.
 *   recall           the `recall` operation with `entity`, which resolves the
 *                    name per granted source and lists that entity's facts.
 *                    Each seeded page carries one marker fact, so the facts
 *                    that come back name the page(s) gbrain resolved to.
 *                    Callers: scoped local, remote with a one-source grant,
 *                    remote with a two-source grant.
 *   remember         the `remember` operation (save-time): the stored
 *                    fact's entity_slug is the resolution.
 *   resolve_on_save  resolveExtractedEntitiesForSave, the bulk-extraction
 *                    save path (src/core/entities/resolve-on-save.ts), fed
 *                    extractor-shaped facts directly (no LLM extractor).
 *   search_floor     the `search` operation on exact slugs and exact names:
 *                    the structural exact-lookup tier must rank the page
 *                    itself first.
 *   identity         entity_identity_link / entity_identity_list under five
 *                    caller scopes: linked cross-source members must be
 *                    visible inside the grant and never outside it.
 *
 * Gold: eval/generators/n4-entity-gen.ts writes a seeded ledger and derives
 * gold with an oracle that re-reads the rendered Markdown the harness
 * imports. Gold lives in a GoldStore; gbrain only ever sees mention text.
 *
 * Controls: solvability (every solvable mention carries the evidence line
 * that identifies its entity), negative controls (ambiguous, unreadable and
 * no-referent mentions whose correct answer is a refusal), and presence
 * assertions (pages, alias rows, identity members, marker facts) checked in
 * the engine before scoring. A failed presence assertion is a harness error.
 *
 * Metrics per surface: B-cubed precision/recall/F1 over mention clusters,
 * accuracy, wrong-merge rate, fragmentation rate, unresolved rate,
 * correct-refusal rate and the exact-lookup floor, beside the degenerate
 * baselines (singleton-everything, merge-everything, exact-only) scored by
 * the same scorer.
 *
 * Usage: bun eval/runner/n4-entity-resolution.ts [--seed N] [--output DIR] [--gbrain <checkout>[@ref]] [--json]
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from 'gbrain/engine';
import type { Operation, OperationContext } from 'gbrain/operations';
import type { GBrainConfig } from 'gbrain/config';
import {
  N4_DEFAULT_SEED, N4_GENERATOR_VERSION, deriveGold, entityByPage, generateLedger, ledgerFingerprint,
  normName, pageKey, parseWrittenPage, renderPage,
  type Gold, type Ledger, type LedgerMention, type MentionCaller, type SourceId, type WrittenPage,
} from '../generators/n4-entity-gen.ts';
import { GoldStore } from './evaluator/gold-store.ts';
import { gbrainPin } from './gbrain-version.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt,
  type Receipt, type ReceiptVerdict,
} from './receipt.ts';

export const CATEGORY = 'entity-resolution';
export const RECEIPT_STEM = 'n4-entity-resolution';

/** Contract targets. `pass` requires every surface to meet every target. */
export const TARGETS = {
  wrong_merge_rate_max: 0,
  floor_rate_min: 1,
  correct_refusal_rate_min: 0.95,
  b3_f1_min: 0.9,
  unresolved_rate_max: 0.1,
  fragmentation_rate_max: 0.1,
  search_floor_rate_min: 1,
  identity_leaks_max: 0,
  identity_recall_min: 1,
} as const;

// ─── Scoring (pure) ────────────────────────────────────────────────────

/**
 * What a surface did with one mention.
 *   pages       resolved to seeded page(s) (page keys `source:slug`)
 *   phantom     produced a slug that is no seeded page (a new identity)
 *   unresolved  explicit refusal / no result
 *   error       the product threw: scored as a miss, never as a refusal
 */
export type Prediction =
  | { kind: 'pages'; pages: string[] }
  | { kind: 'phantom'; slug: string }
  | { kind: 'unresolved' }
  | { kind: 'error'; message: string };

export interface ScoredProbe {
  id: string;
  family: string;
  documented: boolean | null;
  floor: boolean;
  pred: Prediction;
}

export type Outcome = 'correct' | 'wrong-merge' | 'fragmented' | 'unresolved' | 'correct-refusal' | 'error';

export interface FamilyCounts { n: number; correct: number; wrong_merge: number; fragmented: number; unresolved: number; correct_refusal: number; error: number }

export interface SurfaceMetrics {
  n: number;
  n_solvable: number;
  n_refusal: number;
  b3: { precision: number; recall: number; f1: number };
  accuracy: number;
  wrong_merges: number;
  wrong_merge_rate: number;
  wrong_merges_on_solvable: number;
  wrong_merges_on_refusal: number;
  fragmentation_rate: number;
  unresolved_rate: number;
  correct_refusal_rate: number;
  floor: { n: number; correct: number; rate: number };
  errors: number;
  by_family: Record<string, FamilyCounts>;
  by_documented: Record<'documented' | 'prose-or-derived' | 'n/a', FamilyCounts>;
}

export interface ScoringContext {
  entityOfPage: ReadonlyMap<string, string>;
  /** Predicted cluster for a page: gbrain's identity group when the page is a member, else the page. */
  clusterOfPage: (key: string) => string;
}

function predEntities(pred: Prediction, ctx: ScoringContext): string[] {
  if (pred.kind !== 'pages') return [];
  return [...new Set(pred.pages.map(p => {
    const e = ctx.entityOfPage.get(p);
    if (!e) throw new Error(`scorer: page ${p} is not a seeded page`);
    return e;
  }))].sort();
}

function predCluster(pred: Prediction, ctx: ScoringContext): string | null {
  if (pred.kind === 'pages') return [...new Set(pred.pages.map(ctx.clusterOfPage))].sort().join('|');
  if (pred.kind === 'phantom') return `phantom:${pred.slug}`;
  return null;
}

export function outcomeOf(gold: Gold, pred: Prediction, ctx: ScoringContext): Outcome {
  if (pred.kind === 'error') return 'error';
  const ents = predEntities(pred, ctx);
  if (gold.kind === 'refuse') return ents.length ? 'wrong-merge' : 'correct-refusal';
  if (ents.some(e => e !== gold.entity)) return 'wrong-merge';
  if (ents.length === 1) return 'correct';
  return pred.kind === 'phantom' ? 'fragmented' : 'unresolved';
}

/** B-cubed precision and recall; refusal-gold and unresolved/error predictions are singletons. */
export function bcubed(goldCluster: readonly (string | null)[], predCluster: readonly (string | null)[]): { precision: number; recall: number; f1: number } {
  const n = goldCluster.length;
  if (n === 0) return { precision: NaN, recall: NaN, f1: NaN };
  const g = goldCluster.map((c, i) => c ?? `__gold_singleton_${i}`);
  const p = predCluster.map((c, i) => c ?? `__pred_singleton_${i}`);
  let precision = 0;
  let recall = 0;
  for (let i = 0; i < n; i++) {
    let both = 0;
    let inP = 0;
    let inG = 0;
    for (let j = 0; j < n; j++) {
      const sp = p[j] === p[i];
      const sg = g[j] === g[i];
      if (sp) inP++;
      if (sg) inG++;
      if (sp && sg) both++;
    }
    precision += both / inP;
    recall += both / inG;
  }
  precision /= n;
  recall /= n;
  return { precision, recall, f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0 };
}

const emptyCounts = (): FamilyCounts => ({ n: 0, correct: 0, wrong_merge: 0, fragmented: 0, unresolved: 0, correct_refusal: 0, error: 0 });

export function scoreSurface(probes: readonly ScoredProbe[], gold: GoldStore<Gold>, ctx: ScoringContext): SurfaceMetrics {
  const byFamily: Record<string, FamilyCounts> = {};
  const byDoc: SurfaceMetrics['by_documented'] = { documented: emptyCounts(), 'prose-or-derived': emptyCounts(), 'n/a': emptyCounts() };
  const goldClusters: (string | null)[] = [];
  const predClusters: (string | null)[] = [];
  let nSolvable = 0, nRefusal = 0, correct = 0, wmSolv = 0, wmRef = 0, frag = 0, unres = 0, refOk = 0, errors = 0, floorN = 0, floorOk = 0;
  for (const probe of probes) {
    const g = gold.read(probe.id);
    const outcome = outcomeOf(g, probe.pred, ctx);
    goldClusters.push(g.kind === 'entity' ? g.entity : null);
    // An errored probe is its own singleton: it cannot earn B-cubed precision
    // by accident, and it never counts as a correct refusal.
    predClusters.push(probe.pred.kind === 'error' ? null : predCluster(probe.pred, ctx));
    const fam = (byFamily[probe.family] ??= emptyCounts());
    const doc = byDoc[probe.documented === null ? 'n/a' : probe.documented ? 'documented' : 'prose-or-derived'];
    for (const c of [fam, doc]) {
      c.n++;
      if (outcome === 'correct') c.correct++;
      if (outcome === 'wrong-merge') c.wrong_merge++;
      if (outcome === 'fragmented') c.fragmented++;
      if (outcome === 'unresolved') c.unresolved++;
      if (outcome === 'correct-refusal') c.correct_refusal++;
      if (outcome === 'error') c.error++;
    }
    if (g.kind === 'entity') {
      nSolvable++;
      if (outcome === 'correct') correct++;
      if (outcome === 'wrong-merge') wmSolv++;
      if (outcome === 'fragmented') frag++;
      if (outcome === 'unresolved') unres++;
      if (probe.floor) { floorN++; if (outcome === 'correct') floorOk++; }
    } else {
      nRefusal++;
      if (outcome === 'correct-refusal') refOk++;
      if (outcome === 'wrong-merge') wmRef++;
    }
    if (outcome === 'error') errors++;
  }
  const rate = (a: number, b: number) => (b > 0 ? a / b : NaN);
  return {
    n: probes.length,
    n_solvable: nSolvable,
    n_refusal: nRefusal,
    b3: bcubed(goldClusters, predClusters),
    accuracy: rate(correct, nSolvable),
    wrong_merges: wmSolv + wmRef,
    wrong_merge_rate: rate(wmSolv + wmRef, probes.length),
    wrong_merges_on_solvable: wmSolv,
    wrong_merges_on_refusal: wmRef,
    fragmentation_rate: rate(frag, nSolvable),
    unresolved_rate: rate(unres, nSolvable),
    correct_refusal_rate: rate(refOk, nRefusal),
    floor: { n: floorN, correct: floorOk, rate: rate(floorOk, floorN) },
    errors,
    by_family: byFamily,
    by_documented: byDoc,
  };
}

/** Every target a resolution surface must meet; returns the failed ones. */
export function surfaceShortfalls(m: SurfaceMetrics): string[] {
  const out: string[] = [];
  if (!(m.wrong_merge_rate <= TARGETS.wrong_merge_rate_max)) out.push(`wrong_merge_rate ${fmt(m.wrong_merge_rate)} > ${TARGETS.wrong_merge_rate_max}`);
  if (m.floor.n > 0 && !(m.floor.rate >= TARGETS.floor_rate_min)) out.push(`floor ${m.floor.correct}/${m.floor.n} < ${TARGETS.floor_rate_min}`);
  if (m.n_refusal > 0 && !(m.correct_refusal_rate >= TARGETS.correct_refusal_rate_min)) out.push(`correct_refusal_rate ${fmt(m.correct_refusal_rate)} < ${TARGETS.correct_refusal_rate_min}`);
  if (!(m.b3.f1 >= TARGETS.b3_f1_min)) out.push(`b3_f1 ${fmt(m.b3.f1)} < ${TARGETS.b3_f1_min}`);
  if (!(m.unresolved_rate <= TARGETS.unresolved_rate_max)) out.push(`unresolved_rate ${fmt(m.unresolved_rate)} > ${TARGETS.unresolved_rate_max}`);
  if (!(m.fragmentation_rate <= TARGETS.fragmentation_rate_max)) out.push(`fragmentation_rate ${fmt(m.fragmentation_rate)} > ${TARGETS.fragmentation_rate_max}`);
  if (m.errors > 0) out.push(`${m.errors} product errors`);
  return out;
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : String(x);
}

// ─── Baselines (pure, same scorer) ─────────────────────────────────────

export type BaselineName = 'singleton-everything' | 'merge-everything' | 'exact-only';

/** Pages as the harness reads them back from the rendered Markdown. */
export function writtenPages(ledger: Ledger): WrittenPage[] {
  return ledger.pages.map(p => parseWrittenPage(p.source, p.slug, renderPage(p)));
}

export function baselinePrediction(name: BaselineName, mention: Pick<LedgerMention, 'text' | 'caller'>, pages: readonly WrittenPage[]): Prediction {
  const readable = pages.filter(p => mention.caller.sources.includes(p.source));
  if (name === 'singleton-everything') return { kind: 'unresolved' };
  if (name === 'merge-everything') return { kind: 'pages', pages: readable.map(p => p.key) };
  const bySlug = readable.filter(p => p.slug === mention.text.trim());
  if (bySlug.length === 1) return { kind: 'pages', pages: [bySlug[0].key] };
  const byTitle = readable.filter(p => normName(p.title) === normName(mention.text));
  if (bySlug.length === 0 && byTitle.length === 1) return { kind: 'pages', pages: [byTitle[0].key] };
  return { kind: 'unresolved' };
}

// ─── Harness ───────────────────────────────────────────────────────────

type ResolveModule = typeof import('../../node_modules/gbrain/src/core/entities/resolve.ts');
type ResolveOnSaveModule = typeof import('../../node_modules/gbrain/src/core/entities/resolve-on-save.ts');

interface Gbrain {
  PGLiteEngine: typeof import('gbrain/pglite-engine').PGLiteEngine;
  importFromContent: typeof import('gbrain/import-file').importFromContent;
  operations: Operation[];
  resolveEntitySlugWithSource: ResolveModule['resolveEntitySlugWithSource'];
  resolveExtractedEntitiesForSave: ResolveOnSaveModule['resolveExtractedEntitiesForSave'];
}

async function loadGbrain(gut: GbrainUnderTest): Promise<Gbrain> {
  const [pglite, imp, ops, res, ros] = await Promise.all([
    importGbrain<typeof import('gbrain/pglite-engine')>(gut, 'src/core/pglite-engine.ts'),
    importGbrain<typeof import('gbrain/import-file')>(gut, 'src/core/import-file.ts'),
    importGbrain<typeof import('gbrain/operations')>(gut, 'src/core/operations.ts'),
    importGbrain<ResolveModule>(gut, 'src/core/entities/resolve.ts'),
    importGbrain<ResolveOnSaveModule>(gut, 'src/core/entities/resolve-on-save.ts'),
  ]);
  return {
    PGLiteEngine: pglite.PGLiteEngine,
    importFromContent: imp.importFromContent,
    operations: ops.operations,
    resolveEntitySlugWithSource: res.resolveEntitySlugWithSource,
    resolveExtractedEntitiesForSave: ros.resolveExtractedEntitiesForSave,
  };
}

class HarnessError extends Error {}

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

/** Operation context for a caller. Local callers are trusted and scalar-scoped; remote callers carry a grant. */
export function callerContext(engine: BrainEngine, caller: MentionCaller | 'trusted'): OperationContext {
  const base = { engine, config: {} as GBrainConfig, logger: SILENT_LOGGER as never, dryRun: false };
  if (caller === 'trusted') return { ...base, remote: false, sourceId: 'default' } as OperationContext;
  if (!caller.remote) return { ...base, remote: false, sourceId: caller.sources[0] } as OperationContext;
  return { ...base, remote: true, sourceId: caller.sources[0], auth: { allowedSources: [...caller.sources] } } as unknown as OperationContext;
}

function op(g: Gbrain, name: string): Operation {
  const found = g.operations.find(o => o.name === name);
  if (!found) throw new HarnessError(`operation ${name} not found in this gbrain`);
  return found;
}

const MARKER = 'n4-marker ';

export interface IdentityProbeRow {
  probe_id: string;
  page: string;
  scope: string;
  expected: string[];
  returned: string[];
  missing: string[];
  leaked: string[];
  foreign: string[];
}

export interface RunResult {
  surfaces: Record<'resolver' | 'recall' | 'remember' | 'resolve_on_save', SurfaceMetrics>;
  search_floor: { n: number; correct: number; rate: number; errors: number };
  identity: { n: number; expected_members: number; found_members: number; recall: number; leaks: number; foreign_rows: number; foreign_by_scope: Record<string, number> };
  baselines: Record<BaselineName, SurfaceMetrics>;
  stage_tags: Record<string, Record<string, number>>;
  presence: Array<{ check: string; ok: boolean; detail: string }>;
  rows: Array<Record<string, unknown>>;
  identity_rows: IdentityProbeRow[];
}

export interface RunOptions {
  seed: number;
  log?: (s: string) => void;
  acc?: ProbeAccounting;
}

/** Planned probe count for accounting, before anything runs. */
export function plannedProbes(ledger: Ledger): number {
  const single = ledger.mentions.filter(m => m.caller.sources.length === 1 && !m.caller.remote).length;
  const floorSolvable = ledger.mentions.filter(m => m.caller.sources.length === 1 && !m.caller.remote && m.design === 'solvable' && (m.family === 'exact-slug' || m.family === 'exact-name')).length;
  return single /* resolver */ + ledger.mentions.length /* recall */ + single /* remember */ + single /* resolve_on_save */
    + floorSolvable /* search floor */ + ledger.pages.length * IDENTITY_SCOPES.length;
}

const IDENTITY_SCOPES: ReadonlyArray<{ name: string; caller: MentionCaller | 'trusted' }> = [
  { name: 'trusted-local', caller: 'trusted' },
  { name: 'remote-default', caller: { sources: ['default'], remote: true } },
  { name: 'remote-team', caller: { sources: ['team'], remote: true } },
  { name: 'remote-both', caller: { sources: ['default', 'team'], remote: true } },
  { name: 'local-team', caller: { sources: ['team'], remote: false } },
];

export async function runN4(gut: GbrainUnderTest, ledger: Ledger, gold: GoldStore<Gold>, opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const acc = opts.acc ?? new ProbeAccounting(plannedProbes(ledger));
  const g = await loadGbrain(gut);
  const engine = new g.PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    return await runOnEngine(g, engine as unknown as BrainEngine, ledger, gold, acc, log);
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

async function runOnEngine(g: Gbrain, engine: BrainEngine, ledger: Ledger, gold: GoldStore<Gold>, acc: ProbeAccounting, log: (s: string) => void): Promise<RunResult> {
  const entityOfPage = entityByPage(ledger);
  const seeded = new Set(entityOfPage.keys());
  const trusted = callerContext(engine, 'trusted');

  // ── Seed ──
  for (const s of ledger.sources) {
    if (s === 'default') continue;
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [s]);
  }
  for (const p of ledger.pages) {
    await g.importFromContent(engine as never, p.slug, renderPage(p), { noEmbed: true, sourceId: p.source });
  }
  for (const id of ledger.identities) {
    for (const m of id.members) {
      const canonical = m.source === id.canonical.source && m.slug === id.canonical.slug;
      await op(g, 'entity_identity_link').handler(trusted, { entity_id: id.entity_id, slug: m.slug, source_id: m.source, ...(canonical ? { canonical: true } : {}) });
    }
  }
  for (const p of ledger.pages) {
    await engine.insertFact({ fact: `${MARKER}${pageKey(p)}`, entity_slug: p.slug, source: 'eval:n4-entity-resolution', visibility: 'world', embedding: null }, { source_id: p.source });
  }

  // ── Presence: prove the world landed before anything is scored ──
  const presence: RunResult['presence'] = [];
  const pageRows = await engine.executeRaw<{ source_id: string; slug: string; title: string }>(
    `SELECT source_id, slug, title FROM pages WHERE deleted_at IS NULL`);
  const landed = new Map(pageRows.map(r => [`${r.source_id}:${r.slug}`, r.title]));
  const missingPages = ledger.pages.filter(p => landed.get(pageKey(p)) !== p.title).map(pageKey);
  presence.push({ check: 'every ledger page exists with its title', ok: missingPages.length === 0, detail: `${ledger.pages.length - missingPages.length}/${ledger.pages.length} pages${missingPages.length ? `; missing or mistitled: ${missingPages.join(', ')}` : ''}` });
  const aliasRows = await engine.executeRaw<{ source_id: string; slug: string; alias_norm: string }>(`SELECT source_id, slug, alias_norm FROM page_aliases`);
  const aliasMismatch = ledger.pages.filter(p => {
    const want = [...new Set(p.aliases.map(normName))].sort().join('\n');
    const got = [...new Set(aliasRows.filter(r => r.source_id === p.source && r.slug === p.slug).map(r => r.alias_norm))].sort().join('\n');
    return want !== got;
  }).map(pageKey);
  const aliasTotal = ledger.pages.reduce((n, p) => n + p.aliases.length, 0);
  presence.push({ check: 'page_aliases rows equal each page\'s aliases: frontmatter', ok: aliasMismatch.length === 0, detail: `${aliasRows.length} alias rows for ${aliasTotal} written aliases${aliasMismatch.length ? `; mismatched pages: ${aliasMismatch.join(', ')}` : ''}` });
  const listed = await op(g, 'entity_identity_list').handler(trusted, {}) as { identities: Array<{ entity_id: string; canonical: { source_id: string; slug: string } | null; members: Array<{ source_id: string; slug: string }> }> };
  const identityOk = ledger.identities.every(id => {
    const got = listed.identities.find(x => x.entity_id === id.entity_id);
    const want = id.members.map(pageKey).sort().join(',');
    return got !== undefined && got.members.map(m => `${m.source_id}:${m.slug}`).sort().join(',') === want
      && got.canonical !== null && `${got.canonical.source_id}:${got.canonical.slug}` === pageKey(id.canonical);
  }) && listed.identities.length === ledger.identities.length;
  presence.push({ check: 'identity groups read back with their members and canonical', ok: identityOk, detail: `${listed.identities.length} groups read back, ${ledger.identities.length} written` });
  const markers = await engine.executeRaw<{ source_id: string; entity_slug: string; fact: string }>(`SELECT source_id, entity_slug, fact FROM facts WHERE fact LIKE $1`, [`${MARKER}%`]);
  const markersOk = markers.length === ledger.pages.length && markers.every(r => r.fact === `${MARKER}${r.source_id}:${r.entity_slug}`);
  presence.push({ check: 'one marker fact per page', ok: markersOk, detail: `${markers.length} marker facts for ${ledger.pages.length} pages` });
  for (const p of presence) log(`  presence: ${p.ok ? 'ok  ' : 'FAIL'} ${p.check} (${p.detail})`);
  const failed = presence.filter(p => !p.ok);
  if (failed.length) throw new HarnessError(`presence assertion failed: ${failed.map(f => `${f.check} (${f.detail})`).join('; ')}`);

  // Predicted clusters come from the identity groups gbrain stored.
  const identityOf = new Map<string, string>();
  for (const id of listed.identities) for (const m of id.members) identityOf.set(`${m.source_id}:${m.slug}`, `identity:${id.entity_id}`);
  const ctx: ScoringContext = { entityOfPage, clusterOfPage: key => identityOf.get(key) ?? key };

  const toPred = (source: SourceId, slug: string | null | undefined): Prediction => {
    if (slug == null) return { kind: 'unresolved' };
    const key = `${source}:${slug}`;
    return seeded.has(key) ? { kind: 'pages', pages: [key] } : { kind: 'phantom', slug: key };
  };
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const single = ledger.mentions.filter(m => m.caller.sources.length === 1 && !m.caller.remote);
  const isFloor = (m: LedgerMention) => gold.score(m.id, gd => gd.kind === 'entity') && (m.family === 'exact-slug' || m.family === 'exact-name');
  const probeOf = (m: LedgerMention, pred: Prediction): ScoredProbe => ({ id: m.id, family: m.family, documented: m.documented, floor: isFloor(m), pred });
  const record = (surface: string, m: LedgerMention, pred: Prediction) => {
    const pid = `${surface}:${m.id}`;
    if (pred.kind === 'error') acc.error(pid, 'sut', pred.message);
    else acc.score(pid, gold.score(m.id, gd => {
      const o = outcomeOf(gd, pred, ctx);
      return o === 'correct' || o === 'correct-refusal' ? 1 : 0;
    }));
  };
  const rows = new Map<string, Record<string, unknown>>(ledger.mentions.map(m => [m.id, {
    id: m.id, text: m.text, family: m.family, scenario: m.scenario, caller: m.caller, design: m.design, documented: m.documented, note: m.note, referent: m.referent,
    gold: gold.read(m.id),
  }]));

  // ── Surface: resolver cascade ──
  const resolverProbes: ScoredProbe[] = [];
  const stageTags: Record<string, Record<string, number>> = {};
  for (const m of single) {
    const source = m.caller.sources[0];
    let pred: Prediction;
    let tag: string | null = null;
    let slug: string | null = null;
    try {
      const r = await g.resolveEntitySlugWithSource(engine, source, m.text);
      tag = r?.source ?? null;
      slug = r?.slug ?? null;
      pred = !r || r.source === 'fallback_slugify' ? { kind: 'unresolved' } : toPred(source, r.slug);
    } catch (e) {
      pred = { kind: 'error', message: errMsg(e) };
    }
    (stageTags[m.family] ??= {})[tag ?? 'error-or-null'] = ((stageTags[m.family] ??= {})[tag ?? 'error-or-null'] ?? 0) + 1;
    resolverProbes.push(probeOf(m, pred));
    record('resolver', m, pred);
    rows.get(m.id)!.resolver = { stage: tag, slug, pred, outcome: gold.score(m.id, gd => outcomeOf(gd, pred, ctx)) };
  }
  log(`  resolver: ${resolverProbes.length} probes`);

  // ── Surface: recall operation (reads facts through the entity param) ──
  const recallProbes: ScoredProbe[] = [];
  for (const m of ledger.mentions) {
    let pred: Prediction;
    let returned: string[] = [];
    try {
      const res = await op(g, 'recall').handler(callerContext(engine, m.caller), { entity: m.text, limit: 100 }) as { facts?: Array<{ fact: string }> };
      returned = (res.facts ?? []).map(f => f.fact).filter(f => f.startsWith(MARKER)).map(f => f.slice(MARKER.length));
      const pages = [...new Set(returned)].sort();
      const stray = pages.filter(p => !seeded.has(p));
      if (stray.length) throw new HarnessError(`recall returned marker for unseeded page ${stray.join(', ')}`);
      pred = pages.length ? { kind: 'pages', pages } : { kind: 'unresolved' };
    } catch (e) {
      if (e instanceof HarnessError) throw e;
      pred = { kind: 'error', message: errMsg(e) };
    }
    recallProbes.push(probeOf(m, pred));
    record('recall', m, pred);
    rows.get(m.id)!.recall = { markers: returned, pred, outcome: gold.score(m.id, gd => outcomeOf(gd, pred, ctx)) };
  }
  log(`  recall: ${recallProbes.length} probes`);

  // ── Surface: search exact-lookup floor ──
  let searchN = 0, searchOk = 0, searchErr = 0;
  for (const m of single.filter(isFloor)) {
    searchN++;
    const pid = `search_floor:${m.id}`;
    try {
      const res = await op(g, 'search').handler(callerContext(engine, m.caller), { query: m.text, limit: 5 }) as unknown;
      const list = (Array.isArray(res) ? res : ((res as { results?: unknown[] }).results ?? [])) as Array<{ slug: string; source_id?: string }>;
      const top = list[0] ? `${list[0].source_id ?? m.caller.sources[0]}:${list[0].slug}` : null;
      const ok = gold.score(m.id, gd => gd.kind === 'entity' && top !== null && gd.pages.includes(top));
      if (ok) searchOk++;
      acc.score(pid, ok ? 1 : 0);
      rows.get(m.id)!.search_floor = { top, top5: list.slice(0, 5).map(r => `${r.source_id ?? m.caller.sources[0]}:${r.slug}`), ok };
    } catch (e) {
      searchErr++;
      acc.error(pid, 'sut', errMsg(e));
      rows.get(m.id)!.search_floor = { error: errMsg(e) };
    }
  }
  log(`  search_floor: ${searchOk}/${searchN}`);

  // ── Surface: identity visibility under five scopes ──
  const identityRows: IdentityProbeRow[] = [];
  const ledgerGroupOf = new Map<string, string[]>();
  for (const id of ledger.identities) for (const m of id.members) ledgerGroupOf.set(pageKey(m), id.members.map(pageKey));
  for (const p of ledger.pages) {
    for (const scope of IDENTITY_SCOPES) {
      const pid = `identity:${pageKey(p)}:${scope.name}`;
      const readable = (s: string) => scope.caller === 'trusted' || scope.caller.remote === false || scope.caller.sources.includes(s as SourceId);
      const expected = readable(p.source) ? (ledgerGroupOf.get(pageKey(p)) ?? []).filter(k => readable(k.split(':')[0])) : [];
      try {
        const res = await op(g, 'entity_identity_list').handler(callerContext(engine, scope.caller), { slug: p.slug }) as { identities: Array<{ members: Array<{ source_id: string; slug: string }> }> };
        const returned = [...new Set(res.identities.flatMap(i => i.members.map(m => `${m.source_id}:${m.slug}`)))].sort();
        const own = new Set(ledgerGroupOf.get(pageKey(p)) ?? []);
        const row: IdentityProbeRow = {
          probe_id: pid, page: pageKey(p), scope: scope.name, expected, returned,
          missing: expected.filter(k => !returned.includes(k)),
          leaked: returned.filter(k => !readable(k.split(':')[0])),
          // Members of a group that does not contain the queried page, asked
          // by a caller who can read that page: the slug seeded someone else's group.
          foreign: readable(p.source) ? returned.filter(k => !own.has(k) && readable(k.split(':')[0])) : [],
        };
        identityRows.push(row);
        acc.score(pid, row.missing.length === 0 && row.leaked.length === 0 ? 1 : 0);
      } catch (e) {
        acc.error(pid, 'sut', errMsg(e));
        identityRows.push({ probe_id: pid, page: pageKey(p), scope: scope.name, expected, returned: [], missing: expected, leaked: [], foreign: [] });
      }
    }
  }

  // ── Surface: remember (save-time, operation) — after recall so its facts cannot leak into recall ──
  const rememberProbes: ScoredProbe[] = [];
  for (const m of single) {
    const source = m.caller.sources[0];
    let pred: Prediction;
    let stored: string | null = null;
    try {
      const res = await op(g, 'remember').handler(callerContext(engine, m.caller), { fact: `n4 save-time probe ${m.id}`, entity: m.text, provenance: 'eval:n4-entity-resolution' }) as { entity_slug?: string | null };
      stored = res.entity_slug ?? null;
      pred = toPred(source, stored);
    } catch (e) {
      pred = { kind: 'error', message: errMsg(e) };
    }
    rememberProbes.push(probeOf(m, pred));
    record('remember', m, pred);
    rows.get(m.id)!.remember = { entity_slug: stored, pred, outcome: gold.score(m.id, gd => outcomeOf(gd, pred, ctx)) };
  }
  log(`  remember: ${rememberProbes.length} probes`);

  // ── Surface: bulk-extraction save path ──
  const rosProbes: ScoredProbe[] = [];
  for (const m of single) {
    const source = m.caller.sources[0];
    let pred: Prediction;
    let stored: string | null = null;
    try {
      const facts = [{ fact: `n4 extracted probe ${m.id}`, entity_slug: m.text, kind: 'fact' as const, source: 'eval:n4-entity-resolution' }];
      await g.resolveExtractedEntitiesForSave(engine, source, facts as never);
      stored = facts[0].entity_slug;
      pred = toPred(source, stored);
    } catch (e) {
      pred = { kind: 'error', message: errMsg(e) };
    }
    rosProbes.push(probeOf(m, pred));
    record('resolve_on_save', m, pred);
    rows.get(m.id)!.resolve_on_save = { entity_slug: stored, pred, outcome: gold.score(m.id, gd => outcomeOf(gd, pred, ctx)) };
  }
  log(`  resolve_on_save: ${rosProbes.length} probes`);

  // ── Baselines over the resolver probe set, same scorer ──
  const written = writtenPages(ledger);
  const baselines = Object.fromEntries((['singleton-everything', 'merge-everything', 'exact-only'] as const).map(name => [name,
    scoreSurface(single.map(m => probeOf(m, baselinePrediction(name, m, written))), gold, ctx)])) as Record<BaselineName, SurfaceMetrics>;

  const expectedMembers = identityRows.reduce((n, r) => n + r.expected.length, 0);
  const foundMembers = identityRows.reduce((n, r) => n + (r.expected.length - r.missing.length), 0);
  const foreignByScope: Record<string, number> = {};
  for (const r of identityRows) foreignByScope[r.scope] = (foreignByScope[r.scope] ?? 0) + r.foreign.length;
  return {
    surfaces: {
      resolver: scoreSurface(resolverProbes, gold, ctx),
      recall: scoreSurface(recallProbes, gold, ctx),
      remember: scoreSurface(rememberProbes, gold, ctx),
      resolve_on_save: scoreSurface(rosProbes, gold, ctx),
    },
    search_floor: { n: searchN, correct: searchOk, rate: searchN ? searchOk / searchN : NaN, errors: searchErr },
    identity: {
      n: identityRows.length, expected_members: expectedMembers, found_members: foundMembers,
      recall: expectedMembers ? foundMembers / expectedMembers : NaN,
      leaks: identityRows.reduce((n, r) => n + r.leaked.length, 0),
      foreign_rows: identityRows.reduce((n, r) => n + r.foreign.length, 0),
      foreign_by_scope: foreignByScope,
    },
    baselines,
    stage_tags: stageTags,
    presence,
    rows: [...rows.values()],
    identity_rows: identityRows,
  };
}

export function verdictOf(r: Pick<RunResult, 'surfaces' | 'search_floor' | 'identity'>): { verdict: ReceiptVerdict; shortfalls: string[] } {
  const shortfalls: string[] = [];
  for (const [name, m] of Object.entries(r.surfaces)) for (const s of surfaceShortfalls(m)) shortfalls.push(`${name}: ${s}`);
  if (!(r.search_floor.rate >= TARGETS.search_floor_rate_min)) shortfalls.push(`search_floor: ${r.search_floor.correct}/${r.search_floor.n}`);
  if (r.identity.leaks > TARGETS.identity_leaks_max) shortfalls.push(`identity: ${r.identity.leaks} members leaked outside the grant`);
  if (!(r.identity.recall >= TARGETS.identity_recall_min)) shortfalls.push(`identity: member recall ${fmt(r.identity.recall)}`);
  return { verdict: shortfalls.length ? 'fail' : 'pass', shortfalls };
}

export const UNSUPPORTED = [
  'Context-aware disambiguation: the resolver takes only the mention text and a source id, so a namesake cannot be disambiguated by surrounding prose; slug and aliases are the only disambiguators. Namesake mentions are scored as refusals.',
  'Names declared only in page prose ("Goes by X.", "Handle: @x", "Formerly X; name changed on D.") are not read by the resolver; only `aliases:` frontmatter reaches page_aliases. Those variants are solvable by the oracle and scored as misses, reported separately as prose-or-derived.',
  'entity_identity_list takes no source_id: a slug seeds groups from any source the caller may read (documented in listEntityIdentities), so the same slug in another source returns that source\'s group. Counted as foreign rows, not as a pass/fail target.',
  'The LLM extractor in front of resolve-on-save (extract-conversation-facts) is not run; extractor-shaped facts are fed to resolveExtractedEntitiesForSave directly. The resolver cascade itself has no embedding or LLM stage, so no stage was skipped.',
  'Import-time mention linking in page bodies (by-mention gazetteer, auto-link) and the entity_identity.union link read are not exercised here.',
];

// ─── CLI ───────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? N4_DEFAULT_SEED : Number(seedArg);
  const outputDir = argValue(argv, '--output');
  const receiptFile = outputDir ? join(resolve(outputDir), 'receipt.json') : receiptPath(RECEIPT_STEM);
  if (outputDir) mkdirSync(resolve(outputDir), { recursive: true });
  const startedAt = new Date().toISOString();

  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const ledger = generateLedger(seed);
  const fingerprint = ledgerFingerprint(ledger);
  const gold = new GoldStore<Gold>('n4-entity-resolution', deriveGold(ledger));
  const acc = new ProbeAccounting(plannedProbes(ledger));

  log('# BrainBench N4: entity resolution\n');
  log(`gbrain ${gut.version}${gut.overlay ? ` (overlay ${gut.overlay.build.commit.slice(0, 9)})` : ' (pinned dependency)'}; seed ${seed}; ledger ${fingerprint.slice(0, 12)}; ${ledger.pages.length} pages, ${ledger.mentions.length} mentions`);

  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
  } as const;
  const resolvedConfig = {
    engine: 'pglite-in-memory',
    embedding: 'none (no provider configured; noEmbed imports)',
    seed,
    generator_version: N4_GENERATOR_VERSION,
    ledger_sha256: fingerprint,
    gold_fingerprint: gold.fingerprint,
    gbrain_overlay: overlaySummary(gut),
    sources: ledger.sources,
    surfaces: ['resolver', 'recall', 'remember', 'resolve_on_save', 'search_floor', 'identity'],
    targets: TARGETS,
  };

  let result: RunResult;
  try {
    result = await runN4(gut, ledger, gold, { seed, log, acc });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    acc.error('run', 'harness', msg);
    const a = acc.summary();
    writeReceipt(receiptFile, {
      ...base, run_status: 'error', n_total: a.n_total, n_scored: a.n_scored, completion_rate: a.completion_rate,
      errors: a.errors, publishable: false, resolved_config: resolvedConfig, finished_at: new Date().toISOString(),
      hashes: { ledger: fingerprint, gold: gold.fingerprint },
    } satisfies Receipt);
    console.error(`N4 harness error: ${msg}`);
    process.exit(3);
  }

  const { verdict, shortfalls } = verdictOf(result);
  const a = acc.summary();
  const r = result.surfaces.resolver;
  log('\n## Resolution surfaces');
  log('| surface | n | B3 F1 | accuracy | wrong merges | unresolved | fragmented | correct refusals | floor |');
  log('|---|---|---|---|---|---|---|---|---|');
  const line = (name: string, m: SurfaceMetrics) => log(`| ${name} | ${m.n} | ${fmt(m.b3.f1)} | ${pct(m.accuracy)} of ${m.n_solvable} | ${m.wrong_merges}/${m.n} | ${pct(m.unresolved_rate)} | ${pct(m.fragmentation_rate)} | ${pct(m.correct_refusal_rate)} of ${m.n_refusal} | ${m.floor.correct}/${m.floor.n} |`);
  for (const [name, m] of Object.entries(result.surfaces)) line(name, m);
  for (const [name, m] of Object.entries(result.baselines)) line(`baseline: ${name}`, m);
  log(`\nsearch exact-lookup floor: ${result.search_floor.correct}/${result.search_floor.n}`);
  log(`identity: member recall ${result.identity.found_members}/${result.identity.expected_members}, leaks ${result.identity.leaks}, foreign rows ${result.identity.foreign_rows} ${JSON.stringify(result.identity.foreign_by_scope)}`);
  log(`\nVerdict: ${verdict}${shortfalls.length ? `\n  ${shortfalls.join('\n  ')}` : ''}`);

  const oracleRules: Record<string, number> = {};
  const refusalReasons: Record<string, number> = {};
  for (const id of gold.ids()) {
    const gd = gold.read(id);
    if (gd.kind === 'entity') oracleRules[gd.rule] = (oracleRules[gd.rule] ?? 0) + 1;
    else refusalReasons[gd.reason] = (refusalReasons[gd.reason] ?? 0) + 1;
  }

  writeReceipt(receiptFile, {
    ...noModelSpend('hermetic: PGLite in memory, no embedding provider, no model call'),
    ...base,
    run_status: 'completed',
    verdict,
    n_total: a.n_total,
    n_scored: a.n_scored,
    completion_rate: a.completion_rate,
    errors: a.errors,
    publishable: a.publishable,
    resolved_config: resolvedConfig,
    hashes: { ledger: fingerprint, gold: gold.fingerprint },
    finished_at: new Date().toISOString(),
    data: {
      headline: {
        surface: 'resolver',
        b3_f1: r.b3.f1, accuracy: r.accuracy, n_solvable: r.n_solvable, wrong_merges: r.wrong_merges, n: r.n,
        correct_refusal_rate: r.correct_refusal_rate, n_refusal: r.n_refusal, floor: r.floor,
      },
      shortfalls,
      surfaces: result.surfaces,
      search_floor: result.search_floor,
      identity: result.identity,
      baselines: result.baselines,
      resolver_stage_by_family: result.stage_tags,
      presence: result.presence,
      oracle: { rules: oracleRules, refusal_reasons: refusalReasons, derivation: 'first matching rule over rendered Markdown readable by the caller: exact-slug, exact-name, declared-name (aliases or prose declaration), typo (one edit, no other name within two), initials, first-name; one entity = solvable, two or more = ambiguous, none = no-evidence' },
      ledger: { seed, generator_version: N4_GENERATOR_VERSION, sha256: fingerprint, entities: ledger.entities, pages: ledger.pages, identities: ledger.identities },
      unsupported: UNSUPPORTED,
      rows: result.rows,
      identity_rows: result.identity_rows,
    },
  } satisfies Receipt);
  log(`\nReceipt: ${receiptFile}`);
  if (json) process.stdout.write(JSON.stringify({ verdict, shortfalls, surfaces: result.surfaces, baselines: result.baselines, search_floor: result.search_floor, identity: result.identity }, null, 2) + '\n');
  process.exit(verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
