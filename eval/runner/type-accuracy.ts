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

import { readFileSync } from 'fs';
import { join } from 'path';
import { extractPageLinks } from 'gbrain/link-extraction';
import type { PageType } from 'gbrain/types';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, writeReceipt, type Receipt, type ReceiptVerdict, noModelSpend } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { declaredPin } from './pins.ts';
import { UNTYPED_FALLBACK, buildGoldEdges, loadCorpus, score, type GoldEdge, type RichPage } from './world-v1-gold.ts';

export {
  UNTYPED_FALLBACK, buildGoldEdges, classifyPair, loadCorpus, score, typeAccuracyCounts,
  type ConfusionMatrix, type GoldEdge, type PerTypeResult, type RichPage, type TypeAccuracyCounts, type TypeAccuracyRow,
} from './world-v1-gold.ts';

export interface TypeAccuracyAttempt {
  probe_id: string;
  slug: string;
  status: 'completed' | 'error';
  inferred: GoldEdge[];
  error?: string;
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
    ...noModelSpend('hermetic: no model and no paid request'),
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
