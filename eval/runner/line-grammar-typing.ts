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
 * Q2 C-gate metrics (summary): typed_recall_by_type (per gold type, correctly typed / gold edges; the kit pairs the
 * rows by edge) and spurious specific types (stored typed edges other than `mentions` whose pair has another gold
 * type or no gold edge, over all stored specific typed edges, in points).
 *
 * Custodian mode (Q2 W1/W2): --dir <custody path> --decision-id <id> --purpose <text> --output <dir outside every git
 * worktree>. Every page file read appends an access-log line beside it; the receipt is hash-only: slugs in ids,
 * clusters and edge fields become SHA-256 prefixes (the same in every arm, so rows still pair), and no page text or
 * slug appears.
 *
 * Usage: bun eval/runner/line-grammar-typing.ts [--output <dir>] [--gbrain <checkout>[@ref]] [--dir eval/data/world-v1] [--json]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertCustodyRoots, openCustodyFile } from './sealed-confirmation-lib.ts';
import { campaignGuard } from './q2/campaign.ts';
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

/**
 * W custody pages in world-v1's page format. When the directory holds a manifest (`*manifest.json` with
 * `files: [{ path, sha256 }]`), exactly the listed files are read and each must hash to its entry; otherwise every
 * `*.json` except manifests is a page. Every file read is hash-logged through the access log before parsing.
 */
export function loadCustodyPages(dir: string, custody: { decisionId: string; purpose: string }): { pages: RichPage[]; files_sha256: string; manifest_sha256: string | null } {
  const manifests = readdirSync(dir).filter(f => /manifest\.json$/.test(f)).sort();
  if (manifests.length > 1) throw new Error(`--dir ${dir} holds ${manifests.length} manifests (${manifests.join(', ')}); a W set has one`);
  let listed: Array<{ path: string; sha256: string | null }>;
  let manifestSha: string | null = null;
  if (manifests.length) {
    const m = openCustodyFile({ file: join(dir, manifests[0]), flag: '--dir', decisionId: custody.decisionId, purpose: custody.purpose });
    manifestSha = m.sha256;
    const parsed = JSON.parse(m.bytes.toString('utf8')) as { files?: Array<{ path: string; sha256: string }> };
    if (!Array.isArray(parsed.files) || !parsed.files.length) throw new Error(`${manifests[0]} (sha256 ${m.sha256}) needs files [{ path, sha256 }]; ask the custodian for the manifest`);
    listed = parsed.files.map(f => ({ path: f.path, sha256: f.sha256 }));
  } else listed = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort().map(path => ({ path, sha256: null }));
  if (!listed.length) throw new Error(`--dir ${dir} holds no page files (*.json in world-v1 format); ask the custodian for the set`);
  const hashes: string[] = [];
  const pages = listed.map(f => {
    if (f.path.startsWith('/') || f.path.split('/').includes('..')) throw new Error(`W manifest path ${f.path} must stay inside ${dir}`);
    const { bytes, sha256 } = openCustodyFile({ file: join(dir, f.path), flag: '--dir', decisionId: custody.decisionId, purpose: custody.purpose });
    if (f.sha256 && f.sha256 !== sha256) throw new Error(`W page ${f.path} hashes to ${sha256}, not the manifest's ${f.sha256}; the custody copy changed, stop and tell the custodian`);
    hashes.push(`${f.path.length}:${sha256}`);
    const p = JSON.parse(bytes.toString('utf8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    return { ...p, title: String(p.title ?? ''), compiled_truth: String(p.compiled_truth ?? ''), timeline: String(p.timeline ?? '') } as RichPage;
  });
  return { pages, files_sha256: createHash('sha256').update(hashes.join('\n')).digest('hex'), manifest_sha256: manifestSha };
}

/** Spurious specific types: stored typed edges other than `mentions` whose pair's gold type differs or is absent. */
export function spuriousSpecific(rows: ReadonlyArray<{ goldType: string | null; inferredTypes: string[] }>): { specific_typed_edges: number; spurious_specific: number; spurious_specific_points: number | null } {
  let specific = 0, spurious = 0;
  for (const r of rows) for (const t of new Set(r.inferredTypes)) {
    if (t === UNTYPED_FALLBACK) continue;
    specific++;
    if (t !== r.goldType) spurious++;
  }
  return { specific_typed_edges: specific, spurious_specific: spurious, spurious_specific_points: specific ? 100 * spurious / specific : null };
}

const hashSlug = (s: string) => `h:${createHash('sha256').update(s).digest('hex').slice(0, 16)}`;

/** Hash-only rows for a custody receipt: slugs become stable hashes, so arms still pair by id and cluster. */
export function redactRows(rows: readonly H1Row[]): H1Row[] {
  return rows.map(r => {
    const out: H1Row = { ...r, id: r.kind === 'invariance' ? `page:${hashSlug(String(r.cluster))}` : hashSlug(r.id), cluster: hashSlug(r.cluster) };
    for (const k of ['from', 'to']) if (typeof out[k] === 'string') out[k] = hashSlug(out[k] as string);
    return out;
  });
}

export async function runLineGrammarTyping(opts: { gut: GbrainUnderTest; dir: string; config: Record<string, string>; log?: (s: string) => void; pages?: RichPage[] }): Promise<H1Result> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const pages = opts.pages ?? loadCorpus(opts.dir);
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

    const goldTypes = [...new Set(rows.filter(r => r.kind === 'edge').map(r => String(r.gold_type)))].sort();
    const summary = {
      typed_recall_by_type: Object.fromEntries(goldTypes.map(t => { const xs = rows.filter(r => r.kind === 'edge' && r.gold_type === t); return [t, { gold: xs.length, correctly_typed: xs.reduce((a, r) => a + (r.correctly_typed as number), 0), recall: xs.reduce((a, r) => a + (r.correctly_typed as number), 0) / xs.length }]; })),
      ...spuriousSpecific(s.rows),
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
  const rawArgv = process.argv.slice(2);
  const campaign = campaignGuard(rawArgv);
  const argv = campaign && !rawArgv.includes('--output') ? [...rawArgv, '--output', campaign.output] : rawArgv;
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const dir = argValue(argv, '--dir') ?? 'eval/data/world-v1';
  const decisionId = argValue(argv, '--decision-id');
  const purpose = argValue(argv, '--purpose');
  const custodian = !!(decisionId || purpose);
  if (custodian && (!decisionId || !purpose)) throw new Error('custodian mode needs both --decision-id and --purpose, recorded in the access log before --dir is read');
  const output = custodian ? assertCustodyRoots({ output: argValue(argv, '--output') }).output : argValue(argv, '--output');
  const custody = custodian ? loadCustodyPages(dir, { decisionId: decisionId!, purpose: purpose! }) : null;
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const config = parseEvalConfig();
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# ${CATEGORY} (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 9)}` : ', pinned'})`);
  let r: H1Result | null = null;
  let harnessError: string | null = null;
  try { r = await runLineGrammarTyping({ gut, dir, config, log: custody ? () => {} : log, ...(custody ? { pages: custody.pages } : {}) }); } catch (e) { harnessError = e instanceof Error ? e.message : String(e); }
  const summary = r && custody ? { ...r.summary, confusion: undefined, invariance: { ...(r.summary.invariance as Record<string, unknown>), differing: `${(r.summary.invariance as { pages_differing: number }).pages_differing} page(s); slugs withheld (custody)` } } : r?.summary ?? null;
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, harnessError, rows: r ? (custody ? redactRows(r.rows) : r.rows) : [], summary,
    basis: 'hermetic: provider keys stripped, put_page and the stale-link sweep only; no model and no paid request',
    resolvedConfig: {
      engine: 'pglite-in-memory',
      caller: 'put_page operation handler, OperationContext { remote: false, sourceId: default }',
      corpus: custody ? `custody set (files sha256 ${custody.files_sha256}, ${custody.pages.length} pages)` : dir,
      ...(custody ? { custody: { decision_id: decisionId, files_sha256: custody.files_sha256, manifest_sha256: custody.manifest_sha256, receipt: 'hash-only: slugs hashed, no page text' } } : {}),
      render: 'serializeMarkdown form: frontmatter type/title, compiled truth, <!-- timeline -->, timeline',
      extraction: 'extractStaleFromDB (gbrain extract --stale, catch-up) after every page is written',
      gold: 'world-v1-gold.ts buildGoldEdges (the type-accuracy gold)',
      untyped_fallback: UNTYPED_FALLBACK,
      eval_config: r?.config ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
    },
  });
  writeReceipt(outPath, receipt);
  campaign?.finish(outPath, 0);
  log(`receipt: ${outPath}`);
  if (harnessError) console.error(`harness error: ${harnessError}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary: r?.summary ?? null }, null, 2) + '\n');
  process.exit(harnessError ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
