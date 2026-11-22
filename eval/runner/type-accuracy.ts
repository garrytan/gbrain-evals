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
 * Usage: bun eval/runner/type-accuracy.ts [--json] [--package=gbrain-cues] [--gbrain <checkout>[@ref]] [--output <dir>] [--pg-url <admin url>]
 *
 * --package runs the same scorer against another installed gbrain alias.
 * gbrain-cues is 939232f, the pin before 2026-09-29, so the two runs form a
 * matched old-pin / new-pin comparison on one scorer.
 *
 * Engines: with GBRAIN_EVAL_ENGINE=pglite|postgres|rust the runner also scores
 * the links an engine STORES, not only what the extractor infers. It opens that
 * engine through eval/runner/eval-engine.ts, imports every page the way the
 * BrainBench gbrain adapter does (importFromContent, keyword only), runs
 * `extract links --source db`, reads each page's links back with getLinks and
 * scores them with the same scorer and floors. The verdict then needs both the
 * extraction score and the stored-links score over the floors. A step the
 * engine refuses is reported as engine_not_supported_by_runner and the verdict
 * is partial at best. Unset, the runner is extraction only, as before.
 * `--gbrain <checkout>[@ref]` measures a copied build (extraction and engine).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { extractPageLinks } from 'gbrain/link-extraction';
import type { PageType } from 'gbrain/types';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, writeReceipt, type Receipt, type ReceiptVerdict, noModelSpend } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { EngineStepLedger, EVAL_ENGINE_REFUSED_EXIT, behaviorEngineReceiptFields, evalEngineRefusalMessage, isEngineUnavailable, openBehaviorEngine, requestedEvalEngine, verdictWithUnsupported, type EvalEngineKind } from './eval-engine.ts';
import { sourceTreeIdentity } from './receipt.ts';
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

/** The markdown the BrainBench gbrain adapter imports for a world-v1 page (adapters/gbrain-inline.ts). */
export function pageMarkdown(p: RichPage): string {
  const lines = ['---', `type: ${p.type}`, `title: ${JSON.stringify(p.title)}`, '---', '', `# ${p.title}`, '', p.compiled_truth];
  if (p.timeline && p.timeline.trim().length > 0) lines.push('', '## Timeline', '', p.timeline);
  return lines.join('\n');
}

export interface StoredLinksRun { engine: EvalEngineKind; edges: GoldEdge[] | null; unsupported: EngineStepLedger['steps'] }

/**
 * The links one engine stores for the corpus: import every page (keyword only), run `extract links --source db`, then
 * read each page's outgoing links with getLinks. A step the engine refuses is recorded and `edges` is null.
 */
export async function storedEdgesOnEngine(gut: GbrainUnderTest, kind: EvalEngineKind, pages: RichPage[]): Promise<StoredLinksRun> {
  const ledger = new EngineStepLedger(kind, 'type-accuracy');
  const { configureGateway } = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
  const { runExtract } = await importGbrain<any>(gut, 'src/commands/extract.ts');
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const brain = await openBehaviorEngine({ gut, label: 'cat2', kind });
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const engine: any = brain.engine;
    const imported = await ledger.run('import pages (importFromContent)', async () => {
      for (const p of pages) await importFromContent(engine, p.slug, pageMarkdown(p), { noEmbed: true });
    });
    if (!imported.ok) return { engine: kind, edges: null, unsupported: ledger.steps };
    const extracted = await ledger.run('extract links --source db', () => runExtract(engine, ['links', '--source', 'db']));
    if (!extracted.ok) return { engine: kind, edges: null, unsupported: ledger.steps };
    const read = await ledger.run('read stored links (getLinks)', async () => {
      const edges: GoldEdge[] = [];
      for (const p of pages) for (const l of await engine.getLinks(p.slug)) edges.push({ from: l.from_slug ?? p.slug, to: l.to_slug, type: l.link_type });
      return edges;
    });
    return { engine: kind, edges: read.ok ? read.value : null, unsupported: ledger.steps };
  } finally {
    console.log = origLog;
    console.error = origErr;
    await brain.close();
  }
}

export function cat2Verdict(scored: { overallTypeAccuracy: number; overallStrictF1: number }): ReceiptVerdict {
  return scored.overallTypeAccuracy >= CAT2_GATES.min_type_accuracy && scored.overallStrictF1 >= CAT2_GATES.min_strict_f1
    ? 'pass' : 'fail';
}

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

async function main() {
  const json = process.argv.includes('--json');
  const requested = requestedEvalEngine();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(process.argv.slice(2)));
  const outputAt = process.argv.indexOf('--output');
  const receiptFile = outputAt >= 0 ? join(process.argv[outputAt + 1]!, 'receipt.json') : receiptPath('type-accuracy');
  const dir = process.argv.find(a => a.startsWith('--dir='))?.slice('--dir='.length) ??
    'eval/data/world-v1';
  const productPackage = process.argv.find(a => a.startsWith('--package='))?.slice('--package='.length) ?? 'gbrain';
  if (productPackage !== 'gbrain' && productPackage !== 'gbrain-cues') throw new Error('--package must be gbrain or gbrain-cues');
  if (gut.overlay && productPackage !== 'gbrain') throw new Error('--gbrain and --package cannot be combined; --gbrain already names the build');
  const extractor = productPackage === 'gbrain' ? (gut.overlay ? (await importGbrain<typeof import('gbrain/link-extraction')>(gut, 'src/core/link-extraction.ts')).extractPageLinks : extractPageLinks)
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
    gbrain_version: productPackage === 'gbrain' ? (gut.overlay ? gut.version : gbrainVersion())
      : JSON.parse(readFileSync(join('node_modules', productPackage, 'package.json'), 'utf8')).version as string,
    gbrain_pin: productPackage === 'gbrain' ? gbrainPin() : declaredPin(productPackage),
    product_package: productPackage,
    ...(gut.overlay ? { execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) } } : {}),
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
    writeReceipt(receiptFile, {
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
  // With GBRAIN_EVAL_ENGINE set, the links the engine stores must clear the same floors; a refused step makes it partial.
  const stored = requested && productPackage === 'gbrain' ? await storedEdgesOnEngine(gut, requested, pages) : null;
  const storedScored = stored?.edges ? score(gold, stored.edges) : null;
  const extractionVerdict = cat2Verdict(scored);
  const storedVerdict = storedScored ? cat2Verdict(storedScored) : null;
  const verdict = stored
    ? verdictWithUnsupported(extractionVerdict === 'fail' || storedVerdict === 'fail' ? 'fail' : storedVerdict === 'pass' ? 'pass' : 'partial', stored.unsupported)
    : extractionVerdict;
  if (stored) {
    log(`## Stored links on ${stored.engine} (import, extract links --source db, getLinks)\n`);
    if (storedScored) log(`- Stored edges: ${stored.edges!.length}; type accuracy **${pct(storedScored.overallTypeAccuracy)}**, strict F1 **${pct(storedScored.overallStrictF1)}** (extraction: ${pct(overallTypeAccuracy)}, ${pct(overallStrictF1)})\n`);
    for (const u of stored.unsupported) log(`- ${u.step}: engine_not_supported_by_runner (${u.engine}): ${u.reason}`);
  }

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
  writeReceipt(receiptFile, {
    ...noModelSpend('hermetic: no model and no paid request'),
    ...receiptBase,
    run_status: 'completed',
    verdict,
    n_total: pages.length,
    n_scored: pages.length,
    completion_rate: 1,
    errors: [],
    publishable: true,
    ...behaviorEngineReceiptFields(requested, stored?.unsupported ?? []),
    resolved_config: {
      corpus: dir, gates: CAT2_GATES, untyped_fallback: UNTYPED_FALLBACK,
      ...(stored ? { engine: stored.engine, stored_links: 'importFromContent (keyword only, the BrainBench gbrain adapter markdown), extract links --source db, getLinks per page; scored with the same scorer and floors', verdict_rule: 'pass = extraction and stored links both clear the floors; partial = a step the engine refused' } : {}),
      ...(gut.overlay ? { gbrain_overlay: overlaySummary(gut) } : {}),
    },
    finished_at: new Date().toISOString(),
    data: stored ? {
      ...artifact,
      extraction_verdict: extractionVerdict,
      stored_links: storedScored ? {
        engine: stored.engine, verdict: storedVerdict, overallTypeAccuracy: storedScored.overallTypeAccuracy, overallAnyTypeAccuracy: storedScored.overallAnyTypeAccuracy,
        overallStrictF1: storedScored.overallStrictF1, perType: storedScored.perType, confusion: storedScored.confusion, storedTotal: stored.edges!.length, storedEdges: stored.edges,
      } : { engine: stored.engine, verdict: null, not_run: stored.unsupported.map(u => u.step) },
    } : artifact,
  } satisfies Receipt);

  if (json) console.log(JSON.stringify(artifact, null, 2));
  if (verdict === 'fail' || (verdict === 'partial' && !stored?.unsupported.length)) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(e => {
    if (isEngineUnavailable(e)) { console.error(evalEngineRefusalMessage(e, 'Cat 2 type accuracy')); process.exit(EVAL_ENGINE_REFUSED_EXIT); }
    console.error(e);
    process.exit(1);
  });
}
