/**
 * BrainBench — per-link-type accuracy on the 240-page rich-prose corpus.
 *
 * This is the measurement tool for v0.10.5+ extraction work. It:
 *   1. Loads all pages from eval/data/world-v1/
 *   2. Derives GOLD expected links per page from `_facts` metadata
 *      (founders → founded, investors → invested_in, advisors → advises,
 *       employees → works_at, attendees → attended, primary_affiliation →
 *       works_at or founded based on role)
 *   3. Runs extractPageLinks on each page → INFERRED links
 *   4. Compares gold vs inferred per link type:
 *       - correctly_typed: gold (src, tgt) exists AND inferred type matches
 *       - mistyped:         gold (src, tgt) exists AND inferred type differs
 *       - missed:           gold (src, tgt) exists AND no inferred edge
 *       - spurious:         inferred (src, tgt) with no gold edge at all
 *
 * Emits a per-link-type table with type accuracy per type + overall.
 * Headline metric: TYPE ACCURACY = correctly_typed / (correctly_typed + mistyped)
 * conditional on the edge being found at all (excludes missed).
 *
 * Also emits a COMBINED metric: F1 per link type treating type as part of
 * the identity — (src, tgt, type) triple must match. Catches both the
 * extraction-recall problem and the type-accuracy problem in one number.
 *
 * Usage: bun eval/runner/type-accuracy.ts [--json] [--package=gbrain-cues]
 *
 * --package runs the same scorer against another installed gbrain alias.
 * gbrain-cues is 939232f, the pin before 2026-09-29, so the two runs form a
 * matched old-pin / new-pin comparison on one scorer.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { extractPageLinks } from 'gbrain/link-extraction';
import type { PageType } from 'gbrain/types';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, writeReceipt, type Receipt, type ReceiptVerdict } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { declaredPin } from './pins.ts';

export interface RichPage {
  slug: string;
  type: 'person' | 'company' | 'meeting' | 'concept';
  title: string;
  compiled_truth: string;
  timeline: string;
  _facts: {
    type: string;
    name?: string;
    role?: string;
    industry?: string;
    primary_affiliation?: string;
    secondary_affiliations?: string[];
    founders?: string[];
    employees?: string[];
    investors?: string[];
    advisors?: string[];
    attendees?: string[];
    related_companies?: string[];
  };
}

export interface GoldEdge {
  from: string;
  to: string;
  type: string;
}

/** Load all rich-prose pages from the world-v1 shard directory. */
function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort();
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

/**
 * Derive the gold edge set from `_facts` metadata. Only edges where both
 * endpoints are real pages in the corpus count (FK-constraint style).
 *
 * Rules:
 *   company.founders  -> founded (person -> company)
 *   company.employees -> works_at (person -> company)
 *   company.investors -> invested_in (person -> company)
 *   company.advisors  -> advises (person -> company)
 *   meeting.attendees -> attended (person -> meeting)
 *   person.primary_affiliation + role=founder       -> founded
 *   person.primary_affiliation + role∈{engineer,...}-> works_at
 *   person.primary_affiliation + role=advisor       -> advises
 *   person.primary_affiliation + role=investor/partner -> invested_in
 *   person.secondary_affiliations + role=advisor    -> advises
 */
export function buildGoldEdges(pages: RichPage[]): GoldEdge[] {
  const existing = new Set(pages.map(p => p.slug));
  const edges: GoldEdge[] = [];
  const push = (from: string, to: string, type: string) => {
    if (!existing.has(from) || !existing.has(to)) return;
    if (from === to) return;
    edges.push({ from, to, type });
  };

  // Company-page -> incoming edges from people referenced in _facts arrays.
  for (const p of pages) {
    if (p._facts.type === 'company') {
      for (const f of p._facts.founders ?? []) push(f, p.slug, 'founded');
      for (const e of p._facts.employees ?? []) {
        // Avoid double-labeling: if e is also a founder, prefer founded (more specific).
        if ((p._facts.founders ?? []).includes(e)) continue;
        push(e, p.slug, 'works_at');
      }
      for (const i of p._facts.investors ?? []) push(i, p.slug, 'invested_in');
      for (const a of p._facts.advisors ?? []) push(a, p.slug, 'advises');
    }
    if (p._facts.type === 'meeting') {
      // Direction: gbrain stores attendance as person -> meeting, both for
      // frontmatter `attendees:` and for body references it marks as
      // canonical attendance (orientCanonicalAttendance in
      // src/core/link-extraction.ts). The gold used meeting -> person until
      // 2026-09-29, which never matched a canonical attendance edge.
      for (const a of p._facts.attendees ?? []) push(a, p.slug, 'attended');
    }
  }

  // Person-page -> outgoing primary_affiliation + secondaries.
  for (const p of pages) {
    if (p._facts.type !== 'person') continue;
    const role = (p._facts.role ?? '').toLowerCase();
    const primary = p._facts.primary_affiliation;
    if (primary && existing.has(primary)) {
      if (['founder', 'co-founder'].includes(role)) push(p.slug, primary, 'founded');
      else if (role === 'advisor') push(p.slug, primary, 'advises');
      else if (['partner', 'investor', 'vc'].includes(role)) push(p.slug, primary, 'invested_in');
      else push(p.slug, primary, 'works_at');
    }
    for (const sec of p._facts.secondary_affiliations ?? []) {
      if (!existing.has(sec)) continue;
      // Secondary affiliations are typically advisory / board work.
      if (role === 'advisor') push(p.slug, sec, 'advises');
      else if (['partner', 'investor', 'vc'].includes(role)) push(p.slug, sec, 'invested_in');
      else push(p.slug, sec, 'mentions');
    }
  }

  // Dedup (same from/to/type edge could be added via multiple rules).
  const seen = new Set<string>();
  const dedup: GoldEdge[] = [];
  for (const e of edges) {
    const k = `${e.from}\u0000${e.to}\u0000${e.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(e);
  }
  return dedup;
}

export interface TypeAccuracyAttempt {
  probe_id: string;
  slug: string;
  status: 'completed' | 'error';
  inferred: GoldEdge[];
  error?: string;
}

export interface TypeAccuracyCounts {
  linkType: string;
  gold: number;
  correctly_typed: number;
  mistyped: number;
  missed: number;
  spurious: number;
}

export interface TypeAccuracyRow {
  probe_id: string;
  from: string;
  to: string;
  goldType: string | null;
  inferredTypes: string[];
  inferredType: string | null;
  classification: 'correctly_typed' | 'mistyped' | 'missed' | 'spurious';
  /** Lenient diagnostic: the gold type is among the inferred types, whatever else was inferred. */
  anyTypeMatch: boolean;
}

/**
 * 'mentions' is the extractor's untyped fallback (bare-slug pass). It never
 * competes with a specific gold type when deciding whether a pair is typed
 * correctly, but it is still charged as a spurious triple.
 */
export const UNTYPED_FALLBACK = 'mentions';

/**
 * A gold pair is correctly typed only when the gold type was inferred and no
 * other specific type was inferred for the same pair. Every inferred type that
 * differs from gold is charged as spurious for that type, so an extractor that
 * emits every type for every pair cannot score as well as an honest one
 * (C-05, audit 2026-09-28).
 */
export function classifyPair(goldType: string | null, inferredTypes: string[]): TypeAccuracyRow['classification'] {
  if (goldType === null) return 'spurious';
  if (inferredTypes.length === 0) return 'missed';
  if (!inferredTypes.includes(goldType)) return 'mistyped';
  return inferredTypes.every(t => t === goldType || t === UNTYPED_FALLBACK) ? 'correctly_typed' : 'mistyped';
}

export function typeAccuracyCounts(row: TypeAccuracyRow): TypeAccuracyCounts[] {
  const types = new Set([...row.inferredTypes, ...(row.goldType === null ? [] : [row.goldType])]);
  return [...types].map(linkType => ({
    linkType,
    gold: Number(row.goldType === linkType),
    correctly_typed: Number(row.goldType === linkType && row.classification === 'correctly_typed'),
    mistyped: Number(row.goldType === linkType && row.classification === 'mistyped'),
    missed: Number(row.goldType === linkType && row.classification === 'missed'),
    spurious: Number(row.goldType !== linkType && row.inferredTypes.includes(linkType)),
  }));
}

/** Run extractPageLinks on every page; return flat list of inferred edges. */
export async function inferAllEdges(
  pages: RichPage[],
  attempts: TypeAccuracyAttempt[] = [],
  extractor: typeof extractPageLinks = extractPageLinks,
): Promise<GoldEdge[]> {
  // v0.13+ contract: async (slug, content, frontmatter, pageType, resolver).
  // The pre-audit 3-arg sync call put content in the slug slot and iterated
  // a Promise — the runner crashed before scoring anything (finding
  // misc-runners-02). Resolver accepts corpus slugs so cross-page edges
  // survive resolution.
  const known = new Set(pages.map(p => p.slug));
  const resolver = { resolve: async (name: string) => (known.has(name) ? name : null) };
  const edges: GoldEdge[] = [];
  for (const p of pages) {
    const attempt: TypeAccuracyAttempt = { probe_id: `page:${p.slug}`, slug: p.slug, status: 'completed', inferred: [] };
    attempts.push(attempt);
    try {
      const content = `${p.title}\n\n${p.compiled_truth}\n\n${p.timeline}`;
      const res = await extractor(p.slug, content, {}, p.type as PageType, resolver);
      for (const c of res.candidates) {
        // Orient each candidate the way gbrain persists it: canonical
        // attendance flips to person -> meeting, and frontmatter incoming
        // edges carry their own source page.
        const edge = c.canonicalAttendance
          ? { from: c.targetSlug, to: p.slug, type: c.linkType }
          : { from: c.fromSlug ?? p.slug, to: c.targetSlug, type: c.linkType };
        edges.push(edge);
        attempt.inferred.push(edge);
      }
    } catch (error) {
      attempt.status = 'error';
      attempt.error = String(error);
      throw error;
    }
  }
  return edges;
}

interface PerTypeResult {
  linkType: string;
  gold: number;
  correctly_typed: number;  // gold edge present, gold type inferred, no other specific type inferred for the pair
  mistyped: number;         // gold edge present, found, but not correctly typed
  missed: number;           // gold edge present AND no inferred edge
  spurious: number;         // inferred (pair, this type) where the pair's gold type differs or there is no gold edge
  type_accuracy: number;    // correctly_typed / (correctly_typed + mistyped)  [conditional on finding the edge]
  recall: number;           // correctly_typed / gold
  precision: number;        // correctly_typed / (correctly_typed + spurious)
  f1_strict: number;        // F1 where (from, to, type) triple must match exactly
}

interface ConfusionMatrix {
  // matrix[goldType][inferredType] = count
  [goldType: string]: Record<string, number>;
}

export function score(gold: GoldEdge[], inferred: GoldEdge[]): {
  perType: PerTypeResult[];
  confusion: ConfusionMatrix;
  overallTypeAccuracy: number;
  overallAnyTypeAccuracy: number;
  overallStrictF1: number;
  rows: Array<TypeAccuracyRow & { contributed: true; counts: TypeAccuracyCounts[] }>;
} {
  // Index gold by (from, to) pair. A duplicate pair with a DIFFERENT type is
  // a gold-authoring error — fail loudly instead of silently overwriting
  // (misc-runners-14; currently 0 multi-type pairs in world-v1, latent).
  const goldByPair = new Map<string, string>();  // key: from\u0000to → type
  for (const g of gold) {
    const key = `${g.from}\u0000${g.to}`;
    const existing = goldByPair.get(key);
    if (existing !== undefined && existing !== g.type) {
      throw new Error(`gold carries two types for pair ${g.from} → ${g.to}: ${existing} and ${g.type}`);
    }
    goldByPair.set(key, g.type);
  }

  // Index inferred by (from, to) keeping ALL types per pair: gbrain's
  // within-page dedup key is (fromSlug, targetSlug, linkType), so one pair
  // can legitimately carry works_at (markdown pass) AND mentions (bare-slug
  // pass). First-type-wins scored the extractor on pass ordering, not
  // capability (misc-runners-14): a correctly-typed candidate was marked
  // mistyped when a generic 'mentions' happened to be emitted first.
  const inferredByPair = new Map<string, Set<string>>();
  for (const i of inferred) {
    const key = `${i.from}\u0000${i.to}`;
    let set = inferredByPair.get(key);
    if (!set) {
      set = new Set();
      inferredByPair.set(key, set);
    }
    set.add(i.type);
  }

  const linkTypes = new Set<string>();
  for (const g of gold) linkTypes.add(g.type);
  for (const i of inferred) linkTypes.add(i.type);

  // Confusion matrix: gold type → representative inferred type. A correctly
  // typed pair records the gold type; a pair typed with gold plus another
  // specific type records that competing type; otherwise the first inferred
  // type (sorted, deterministic).
  const confusion: ConfusionMatrix = {};
  const rows: TypeAccuracyRow[] = [];
  for (const t of linkTypes) confusion[t] = {};

  for (const [pair, goldType] of goldByPair) {
    const inferredTypes = [...(inferredByPair.get(pair) ?? [])].sort();
    const classification = classifyPair(goldType, inferredTypes);
    const inferredType = inferredTypes.length === 0 ? null
      : classification === 'correctly_typed' ? goldType
      : inferredTypes.includes(goldType) ? inferredTypes.find(t => t !== goldType && t !== UNTYPED_FALLBACK)!
      : inferredTypes[0];
    confusion[goldType][inferredType ?? '(missing)'] = (confusion[goldType][inferredType ?? '(missing)'] ?? 0) + 1;
    const [from, to] = pair.split('\u0000');
    rows.push({
      probe_id: `edge:${JSON.stringify([from, to])}`,
      from,
      to,
      goldType,
      inferredTypes,
      inferredType,
      classification,
      anyTypeMatch: inferredTypes.includes(goldType),
    });
  }
  confusion['(no-gold)'] = {};
  for (const [pair, types] of inferredByPair) {
    if (goldByPair.has(pair)) continue;
    const [from, to] = pair.split('\u0000');
    const inferredTypes = [...types].sort();
    rows.push({
      probe_id: `edge:${JSON.stringify([from, to])}`,
      from,
      to,
      goldType: null,
      inferredTypes,
      inferredType: null,
      classification: 'spurious',
      anyTypeMatch: false,
    });
    for (const t of inferredTypes) confusion['(no-gold)'][t] = (confusion['(no-gold)'][t] ?? 0) + 1;
  }

  const scoredRows = rows.map(row => ({ ...row, contributed: true as const, counts: typeAccuracyCounts(row) }));
  const totals = new Map<string, TypeAccuracyCounts>();
  for (const t of linkTypes) totals.set(t, { linkType: t, gold: 0, correctly_typed: 0, mistyped: 0, missed: 0, spurious: 0 });
  for (const row of scoredRows) {
    for (const c of row.counts) {
      const total = totals.get(c.linkType)!;
      total.gold += c.gold;
      total.correctly_typed += c.correctly_typed;
      total.mistyped += c.mistyped;
      total.missed += c.missed;
      total.spurious += c.spurious;
    }
  }

  const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);
  const f1 = (p: number, r: number) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
  const perType: PerTypeResult[] = [...totals.values()].map(t => {
    const recall = ratio(t.correctly_typed, t.gold);
    const precision = ratio(t.correctly_typed, t.correctly_typed + t.spurious);
    return {
      ...t,
      type_accuracy: ratio(t.correctly_typed, t.correctly_typed + t.mistyped),
      recall,
      precision,
      f1_strict: f1(precision, recall),
    };
  });
  const sum = (key: keyof Omit<TypeAccuracyCounts, 'linkType'>) => perType.reduce((a, r) => a + r[key], 0);
  const tp = sum('correctly_typed');
  const found = tp + sum('mistyped');
  const overallTypeAccuracy = ratio(tp, found);
  const overallAnyTypeAccuracy = ratio(rows.filter(r => r.anyTypeMatch).length, found);
  const overallStrictF1 = f1(ratio(tp, tp + sum('spurious')), ratio(tp, tp + sum('mistyped') + sum('missed')));

  // Sort perType by gold count descending (most common first).
  perType.sort((a, b) => b.gold - a.gold || a.linkType.localeCompare(b.linkType));

  return { perType, confusion, overallTypeAccuracy, overallAnyTypeAccuracy, overallStrictF1, rows: scoredRows };
}

/**
 * Regression floors. They catch an extraction regression; they are not a
 * quality claim. History:
 *   2026-09-28: 0.80 / 0.35, below 86.6% / 41.3% measured with gold
 *     `attended` edges oriented meeting -> person.
 *   2026-09-29: 0.70 / 0.15, below 74.7% (109/146) / 18.8% measured after the
 *     gold was corrected to person -> meeting, gbrain's stored orientation.
 *     The corrected scorer gives the same numbers at 939232f and b80cad6;
 *     only where the 134 attendance edges go differs (see
 *     docs/benchmarks/2026-09-29-repin-cats-1-2-6.md).
 */
export const CAT2_GATES = { min_type_accuracy: 0.70, min_strict_f1: 0.15 } as const;

export function cat2Verdict(scored: { overallTypeAccuracy: number; overallStrictF1: number }): ReceiptVerdict {
  return scored.overallTypeAccuracy >= CAT2_GATES.min_type_accuracy && scored.overallStrictF1 >= CAT2_GATES.min_strict_f1
    ? 'pass' : 'fail';
}

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

async function main() {
  const json = process.argv.includes('--json');
  const dir = process.argv.find(a => a.startsWith('--dir='))?.slice('--dir='.length) ??
    'eval/data/world-v1';
  const productPackage = process.argv.find(a => a.startsWith('--package='))?.slice('--package='.length) ?? 'gbrain';
  if (productPackage !== 'gbrain' && productPackage !== 'gbrain-cues') throw new Error('--package must be gbrain or gbrain-cues');
  const extractor = productPackage === 'gbrain' ? extractPageLinks
    : (await (import(`${productPackage}/link-extraction`) as Promise<typeof import('gbrain/link-extraction')>)).extractPageLinks;
  const log = json ? () => {} : console.log;

  log('# BrainBench — type accuracy on rich-prose corpus\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
  log(`Corpus: ${dir}/`);

  const pages = loadCorpus(dir);
  log(`Loaded ${pages.length} pages.\n`);

  const gold = buildGoldEdges(pages);
  const receiptBase = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'type-accuracy',
    gbrain_version: productPackage === 'gbrain' ? gbrainVersion()
      : JSON.parse(readFileSync(join('node_modules', productPackage, 'package.json'), 'utf8')).version as string,
    gbrain_pin: productPackage === 'gbrain' ? gbrainPin() : declaredPin(productPackage),
    product_package: productPackage,
    started_at: new Date().toISOString(),
  } as const;
  const attempts: TypeAccuracyAttempt[] = [];
  let inferred: GoldEdge[];
  let scored: ReturnType<typeof score>;
  try {
    inferred = await inferAllEdges(pages, attempts, extractor);
    scored = score(gold, inferred);
  } catch (error) {
    const errors = [{ probe_id: attempts.at(-1)?.status === 'error' ? attempts.at(-1)!.probe_id : 'score', origin: 'sut' as const, message: String(error) }];
    writeReceipt(receiptPath('type-accuracy'), {
      ...receiptBase,
      run_status: 'error',
      n_total: pages.length,
      n_scored: attempts.filter(a => a.status === 'completed').length,
      completion_rate: pages.length ? attempts.filter(a => a.status === 'completed').length / pages.length : 0,
      errors,
      publishable: false,
      finished_at: new Date().toISOString(),
      data: { goldEdges: gold, inferredEdges: attempts.flatMap(a => a.inferred), attempts, rows: [] },
    } satisfies Receipt);
    if (json) console.log(JSON.stringify({
      run_status: 'error',
      goldEdges: gold,
      inferredEdges: attempts.flatMap(a => a.inferred),
      attempts,
      rows: [],
      errors,
    }, null, 2));
    throw error;
  }

  log(`Gold edges (from _facts):     ${gold.length}`);
  log(`Inferred edges (extractPageLinks): ${inferred.length}\n`);

  const { perType, confusion, overallTypeAccuracy, overallAnyTypeAccuracy, overallStrictF1, rows } = scored;
  const verdict = cat2Verdict(scored);

  log('## Per-link-type results\n');
  log('| Link type    | Gold | Correct | Mistyped | Missed | Spurious | Type acc | Recall | Prec   | F1 (strict) |');
  log('|--------------|------|---------|----------|--------|----------|----------|--------|--------|-------------|');
  for (const r of perType) {
    log(
      `| ${r.linkType.padEnd(12)} | ${String(r.gold).padStart(4)} | ${String(r.correctly_typed).padStart(7)} | ${String(r.mistyped).padStart(8)} | ${String(r.missed).padStart(6)} | ${String(r.spurious).padStart(8)} | ${pct(r.type_accuracy).padStart(8)} | ${pct(r.recall).padStart(6)} | ${pct(r.precision).padStart(6)} | ${pct(r.f1_strict).padStart(11)} |`,
    );
  }
  log('');
  log('**Columns:**');
  log('- *Type acc*: given the edge was found at all, was it typed correctly? `correct / (correct + mistyped)`. A pair counts as correct only when no other specific type was inferred for it (the untyped `mentions` fallback is allowed).');
  log('- *Recall*: of gold edges, how many did we correctly find AND type? `correct / gold`.');
  log('- *Precision*: of edges we inferred as this type, how many were actually this type? `correct / (correct + spurious)`. Every inferred (pair, type) that differs from the gold type counts as spurious.');
  log('- *F1 (strict)*: strict `(from, to, type)` triple match. Catches both extraction-recall and type-accuracy misses in one number.\n');

  log('## Overall\n');
  log(`- Overall type accuracy (conditional on finding the edge): **${pct(overallTypeAccuracy)}**`);
  log(`- Overall strict F1 (triple match): **${pct(overallStrictF1)}**`);
  log(`- Diagnostic, any-type leniency (gold type among the inferred types): ${pct(overallAnyTypeAccuracy)}`);
  log(`- Verdict: ${verdict} (floors: type accuracy >= ${pct(CAT2_GATES.min_type_accuracy)}, strict F1 >= ${pct(CAT2_GATES.min_strict_f1)})\n`);

  log('## Confusion matrix (rows = gold type, cols = inferred type)\n');
  const inferredCols = Array.from(
    new Set(
      Object.values(confusion).flatMap(row => Object.keys(row)),
    ),
  ).sort();
  const rowKeys = Object.keys(confusion).filter(k => k !== '(no-gold)').sort();
  rowKeys.push('(no-gold)');

  const header = ['gold \\ inferred', ...inferredCols];
  log('| ' + header.map(h => h.padEnd(14)).join(' | ') + ' |');
  log('|' + header.map(() => '----------------').join('|') + '|');
  for (const g of rowKeys) {
    if (!confusion[g]) continue;
    const row = [g, ...inferredCols.map(ic => String(confusion[g][ic] ?? 0))];
    log('| ' + row.map(v => v.padEnd(14)).join(' | ') + ' |');
  }
  log('');

  const artifact = {
    overallTypeAccuracy,
    overallAnyTypeAccuracy,
    overallStrictF1,
    perType,
    confusion,
    goldTotal: gold.length,
    inferredTotal: inferred.length,
    goldEdges: gold,
    inferredEdges: inferred,
    attempts,
    rows,
  };
  writeReceipt(receiptPath('type-accuracy'), {
    ...receiptBase,
    run_status: 'completed',
    verdict,
    n_total: pages.length,
    n_scored: pages.length,
    completion_rate: 1,
    errors: [],
    publishable: true,
    resolved_config: { corpus: dir, gates: CAT2_GATES, untyped_fallback: UNTYPED_FALLBACK },
    finished_at: new Date().toISOString(),
    data: artifact,
  } satisfies Receipt);

  if (json) console.log(JSON.stringify(artifact, null, 2));
  if (verdict !== 'pass') process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
