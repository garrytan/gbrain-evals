/**
 * P5 H1: does the typed-line grammar leave link typing on ordinary prose as it
 * was? World-v1 (240 rich-prose pages, eval/data/world-v1) is written into
 * in-memory PGLite through put_page on the gbrain build under test, the
 * build's stale-link sweep extracts the links, and the stored edges are
 * scored against the gold that eval/runner/type-accuracy.ts derives from the
 * pages' `_facts` (world-v1-gold.ts buildGoldEdges and score, unchanged).
 *
 * Unlike type-accuracy.ts, which calls extractPageLinks of the installed
 * package, this runner measures the whole write path of the build passed with
 * `--gbrain` (an overlay copy), so baseline and candidate differ by build.
 *
 * Rows (data.rows), one per gold edge, pairable by `id` with `cluster` = the
 * source page:
 *   anyTypeMatch     the gold type is among the stored types for the pair
 *   correctly_typed  the gold type and no other specific type (`mentions` allowed)
 *   found            any edge stored for the pair
 * plus one row per page checked for invariance:
 *   extract_identical  the page's edges are the same with line_grammar.enabled
 *                      true and false (two brains, same build); pages that
 *                      carry relation lines by the build's own parser are skipped
 * Summary: type accuracy, any-type accuracy and strict F1 as type-accuracy.ts
 * computes them, and the count of pages that extract differently.
 *
 * Arm config: GBRAIN_EVAL_CONFIG (eval/runner/eval-config.ts) on the scored
 * brain and on both invariance brains (line_grammar.enabled forced per brain).
 * Hermetic: provider keys stripped, no model call.
 *
 * Usage: bun eval/runner/line-grammar-typing.ts [--output <dir>] [--gbrain <checkout>[@ref]] [--dir eval/data/world-v1] [--json]
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { argValue, openP5Brain, p5Receipt, renderWorldPage, type P5Brain, type StoredEdge } from './p5-brain.ts';
import { receiptPath, writeReceipt } from './receipt.ts';
import { UNTYPED_FALLBACK, buildGoldEdges, loadCorpus, score, type RichPage } from './world-v1-gold.ts';

export const CATEGORY = 'line-grammar-typing';

export interface H1Row { id: string; kind: 'edge' | 'invariance'; cluster: string; [field: string]: unknown }

export interface H1Result {
  rows: H1Row[];
  summary: Record<string, unknown>;
  config: Record<string, unknown>;
}

async function writeWorld(brain: P5Brain, pages: readonly RichPage[]): Promise<StoredEdge[]> {
  for (const p of pages) await brain.put(p.slug, renderWorldPage(p));
  await brain.sweep();
  return brain.edges();
}

/** Per-page sorted edge lists keyed by the page whose text produced them. */
export function edgesByOrigin(edges: readonly StoredEdge[]): Map<string, string> {
  const by = new Map<string, string[]>();
  for (const e of edges) (by.get(e.origin) ?? by.set(e.origin, []).get(e.origin)!).push(JSON.stringify([e.from, e.to, e.type]));
  return new Map([...by].map(([k, v]) => [k, [...new Set(v)].sort().join('\n')]));
}

/** Slugs whose compiled truth carries a relation line by the build's own parser; null when the build has no line grammar. */
async function pagesWithRelationLines(gut: GbrainUnderTest, pages: readonly RichPage[]): Promise<Set<string> | null> {
  if (!existsSync(join(gut.root, 'src/core/line-grammar.ts'))) return null;
  const { parseLineGrammar } = await importGbrain<{ parseLineGrammar: (t: string) => { relations: unknown[] } }>(gut, 'src/core/line-grammar.ts');
  return new Set(pages.filter(p => parseLineGrammar(p.compiled_truth).relations.length > 0).map(p => p.slug));
}

export async function runLineGrammarTyping(opts: { gut: GbrainUnderTest; dir: string; config: Record<string, string>; log?: (s: string) => void }): Promise<H1Result> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const pages = loadCorpus(opts.dir);
    const gold = buildGoldEdges(pages);
    log(`world: ${pages.length} pages, ${gold.length} gold edges`);

    const scored = await openP5Brain(opts.gut, opts.config);
    let inferred: StoredEdge[];
    try { inferred = await writeWorld(scored, pages); } finally { await scored.close().catch(() => {}); }
    const s = score(gold, inferred.map(({ from, to, type }) => ({ from, to, type })));
    const rows: H1Row[] = s.rows.filter(r => r.goldType !== null).map(r => ({
      id: r.probe_id, kind: 'edge', cluster: r.from, from: r.from, to: r.to, gold_type: r.goldType, inferred_types: r.inferredTypes,
      classification: r.classification, anyTypeMatch: Number(r.anyTypeMatch), correctly_typed: Number(r.classification === 'correctly_typed'),
      found: Number(r.inferredTypes.length > 0),
    }));

    const views: Record<'on' | 'off', Map<string, string>> = { on: new Map(), off: new Map() };
    for (const state of ['on', 'off'] as const) {
      const brain = await openP5Brain(opts.gut, { ...opts.config, 'line_grammar.enabled': state === 'on' ? 'true' : 'false' });
      try { views[state] = edgesByOrigin(await writeWorld(brain, pages)); } finally { await brain.close().catch(() => {}); }
    }
    const withLines = await pagesWithRelationLines(opts.gut, pages);
    const checked = pages.filter(p => !withLines?.has(p.slug));
    const differing: string[] = [];
    for (const p of checked) {
      const same = (views.on.get(p.slug) ?? '') === (views.off.get(p.slug) ?? '');
      if (!same) differing.push(p.slug);
      rows.push({ id: `page:${p.slug}`, kind: 'invariance', cluster: p.slug, extract_identical: Number(same) });
    }

    const summary = {
      gold_edges: gold.length,
      stored_edges: inferred.length,
      type_accuracy: s.overallTypeAccuracy,
      any_type_accuracy: s.overallAnyTypeAccuracy,
      strict_f1: s.overallStrictF1,
      any_type_match_rate: rows.filter(r => r.kind === 'edge').reduce((a, r) => a + (r.anyTypeMatch as number), 0) / gold.length,
      spurious_pairs: s.rows.filter(r => r.goldType === null).length,
      per_type: s.perType,
      confusion: s.confusion,
      invariance: {
        pages_checked: checked.length,
        pages_with_relation_lines: withLines ? withLines.size : 'build has no line grammar (src/core/line-grammar.ts absent); every page checked',
        pages_differing: differing.length,
        differing: differing.slice(0, 50),
      },
    };
    log(`type accuracy ${s.overallTypeAccuracy.toFixed(3)}, any-type ${s.overallAnyTypeAccuracy.toFixed(3)}, strict F1 ${s.overallStrictF1.toFixed(3)}; grammar on/off differ on ${differing.length}/${checked.length} pages`);
    return { rows, summary, config: scored.configRecord };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const dir = argValue(argv, '--dir') ?? 'eval/data/world-v1';
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const config = parseEvalConfig();
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# ${CATEGORY} (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 9)}` : ', pinned'})`);
  let r: H1Result | null = null;
  let harnessError: string | null = null;
  try { r = await runLineGrammarTyping({ gut, dir, config, log }); } catch (e) { harnessError = e instanceof Error ? e.message : String(e); }
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, harnessError, rows: r?.rows ?? [], summary: r?.summary ?? null,
    basis: 'hermetic: provider keys stripped, put_page and the stale-link sweep only; no model and no paid request',
    resolvedConfig: {
      engine: 'pglite-in-memory',
      caller: 'put_page operation handler, OperationContext { remote: false, sourceId: default }',
      corpus: dir,
      render: 'serializeMarkdown form: frontmatter type/title, compiled truth, <!-- timeline -->, timeline',
      extraction: 'extractStaleFromDB (gbrain extract --stale, catch-up) after every page is written',
      gold: 'world-v1-gold.ts buildGoldEdges (the type-accuracy gold)',
      untyped_fallback: UNTYPED_FALLBACK,
      eval_config: r?.config ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
    },
  });
  writeReceipt(outPath, receipt);
  log(`receipt: ${outPath}`);
  if (harnessError) console.error(`harness error: ${harnessError}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary: r?.summary ?? null }, null, 2) + '\n');
  process.exit(harnessError ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
