/**
 * P5 H2: do relation types written as typed lines reach the graph, and do
 * near-miss lines stay out?
 *
 * The world comes from eval/generators/relation-line-variants-gen.ts: world-v1
 * in which a seeded half of the person pages state their company
 * relationships only as lines like `- works_at [[companies/x]]` (the prose
 * that linked those companies removed), plus one decoy line per converted
 * page (text after the link, two links, multi-word unquoted type, stoplisted
 * word, a line inside a machine-written section, an undeclared verb). Pages
 * are written through put_page on in-memory PGLite with the build under test
 * and its stale-link sweep extracts the links. A second brain of the same
 * build runs with line_grammar.enabled=false, so the grammar's own effect is
 * separated from link-type inference changes between builds.
 *
 * Rows (data.rows), pairable by `id`, `cluster` = the person page:
 *   kind relation  typed_recall   the stated type is stored for (person, company)
 *                  found          any edge is stored for the pair
 *                  typed_recall_grammar_off  the same with the grammar off (inference alone)
 *   kind decoy     decoy_type_reached  the decoy's stated type is stored on an edge
 *                                      from the person to a decoy target (lower is better;
 *                                      the prereg compares candidate minus baseline)
 *                  decoy_type_reached_grammar_off  the same with the grammar off (same build)
 *                  decoy_added_by_grammar          reached with the grammar on and not with it off
 *   kind edge      (--type-rows, P5 delta H9) one row per world-v1 gold edge, scored against
 *                  the grammar-on brain as line-grammar-typing.ts scores world-v1:
 *                  anyTypeMatch, correctly_typed, found; id `s<seed>:<gold probe id>`, so two
 *                  builds (frozen vs delta extractor) pair per seed and edge
 * Summary per seed: rendered lines, typed recall, decoys reached per kind (and type accuracy with --type-rows).
 *
 * Arm config: GBRAIN_EVAL_CONFIG (eval/runner/eval-config.ts). Hermetic, no model.
 *
 * Usage: bun eval/runner/relation-line-variants.ts [--seeds 1,2,3] [--phrasing A] [--keep-prose] [--type-rows] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 *
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>.
 * The file holds `{ "id": ..., "templates": RelationLineTemplates }` and lives outside the repository; every read appends
 * a line to access-log.jsonl beside it, and the receipt records only the file's SHA-256, never its text (decoy rows then
 * omit stated and stored types, which come from the held-out vocabulary).
 *
 * Fresh-seed custodian mode (Q2 G5): --seeds-file <custody path> --decision-id <id> --purpose <text> --output <dir
 * outside every git worktree>. The file holds `{ "id": ..., "seeds": [..] }`; the templates stay the generator's own
 * (set A). Its read is access-logged, development seeds 1-3 are refused, and the receipt records only the file's
 * SHA-256 and the seed values. Accepts --campaign/--step/--run.
 */
import { join } from 'node:path';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { argValue, custodyInput, openP5Brain, p5Receipt, renderWorldPage, type StoredEdge } from './p5-brain.ts';
import { custodySeedsInput } from './sealed-confirmation-lib.ts';
import { campaignGuard } from './q2/campaign.ts';
import { receiptPath, writeReceipt } from './receipt.ts';
import { buildGoldEdges, loadCorpus, score, type RichPage } from './world-v1-gold.ts';
import {
  DECOY_KINDS, DEV_SEEDS, RELATION_LINE_VARIANTS_GENERATOR_VERSION, generateRelationLineWorld, validateTemplates,
  type RelationLineTemplates, type RelationLineWorld,
} from '../generators/relation-line-variants-gen.ts';

export const CATEGORY = 'relation-line-variants';

export interface H2Row { id: string; kind: 'relation' | 'decoy' | 'edge'; cluster: string; seed: number; [field: string]: unknown }

/**
 * H9: every world-v1 gold edge scored against one seed's stored edges (world-v1-gold.ts score, as
 * line-grammar-typing.ts does). `redact` drops the stored types, which could carry held-out vocabulary.
 */
export function typeRows(seed: number, corpus: readonly RichPage[], edges: readonly StoredEdge[], redact = false): { rows: H2Row[]; summary: Record<string, unknown> } {
  const s = score(buildGoldEdges([...corpus]), edges.map(({ from, to, type }) => ({ from, to, type })));
  const rows: H2Row[] = s.rows.filter(r => r.goldType !== null).map(r => ({
    id: `s${seed}:${r.probe_id}`, kind: 'edge', cluster: `s${seed}:${r.from}`, seed, from: r.from, to: r.to, gold_type: r.goldType,
    ...(redact ? {} : { inferred_types: r.inferredTypes }), classification: r.classification,
    anyTypeMatch: Number(r.anyTypeMatch), correctly_typed: Number(r.classification === 'correctly_typed'), found: Number(r.inferredTypes.length > 0),
  }));
  return { rows, summary: { gold_edges: rows.length, type_accuracy: s.overallTypeAccuracy, any_type_accuracy: s.overallAnyTypeAccuracy, strict_f1: s.overallStrictF1,
    any_type_match_rate: rows.reduce((a, r) => a + (r.anyTypeMatch as number), 0) / rows.length } };
}

/**
 * Score one world against the stored edges with the grammar on and off.
 * `redact` (custodian mode) keeps held-out template vocabulary out of the
 * rows: decoy rows then carry no stated or stored type.
 */
export function scoreWorld(world: RelationLineWorld, edges: readonly StoredEdge[], grammarOff: readonly StoredEdge[], redact = false): { rows: H2Row[]; summary: Record<string, unknown> } {
  const index = (list: readonly StoredEdge[]) => {
    const m = new Map<string, Set<string>>();
    for (const e of list) (m.get(`${e.from}\0${e.to}`) ?? m.set(`${e.from}\0${e.to}`, new Set()).get(`${e.from}\0${e.to}`)!).add(e.type);
    return (from: string, to: string) => m.get(`${from}\0${to}`) ?? new Set<string>();
  };
  const typesOf = index(edges);
  const offTypesOf = index(grammarOff);
  const rows: H2Row[] = [];
  for (const l of world.lines) {
    const types = typesOf(l.from, l.to);
    rows.push({ id: l.id, kind: 'relation', cluster: `s${world.seed}:${l.from}`, seed: world.seed, from: l.from, to: l.to, stated_type: l.type,
      stored_types: [...types].sort(), typed_recall: Number(types.has(l.type)), found: Number(types.size > 0),
      typed_recall_grammar_off: Number(offTypesOf(l.from, l.to).has(l.type)) });
  }
  for (const d of world.decoys) {
    const stored = d.targets.flatMap(t => [...typesOf(d.from, t)].map(type => ({ to: t, type })));
    const reached = d.targets.some(t => typesOf(d.from, t).has(d.stated_type));
    const reachedOff = d.targets.some(t => offTypesOf(d.from, t).has(d.stated_type));
    rows.push({ id: d.id, kind: 'decoy', cluster: `s${world.seed}:${d.from}`, seed: world.seed, decoy_kind: d.kind, from: d.from, targets: d.targets,
      ...(redact ? {} : { stated_type: d.stated_type, stored }), decoy_type_reached: Number(reached),
      decoy_type_reached_grammar_off: Number(reachedOff), decoy_added_by_grammar: Number(reached && !reachedOff) });
  }
  const rel = rows.filter(r => r.kind === 'relation');
  const decoysByKind = Object.fromEntries(DECOY_KINDS.map(k => {
    const of = rows.filter(r => r.kind === 'decoy' && r.decoy_kind === k);
    const sum = (f: string) => of.reduce((a, r) => a + (r[f] as number), 0);
    return [k, { n: of.length, reached: sum('decoy_type_reached'), reached_grammar_off: sum('decoy_type_reached_grammar_off'), added_by_grammar: sum('decoy_added_by_grammar') }];
  }));
  const mean = (f: string) => rel.length ? rel.reduce((a, r) => a + (r[f] as number), 0) / rel.length : null;
  return {
    rows,
    summary: {
      seed: world.seed, converted_people: world.converted.length, rendered_lines: rel.length,
      typed_recall: mean('typed_recall'),
      typed_recall_grammar_off: mean('typed_recall_grammar_off'),
      decoys: world.decoys.length,
      decoy_types_reached: Object.values(decoysByKind).reduce((a, k) => a + k.reached, 0),
      decoy_types_added_by_grammar: Object.values(decoysByKind).reduce((a, k) => a + k.added_by_grammar, 0),
      decoys_by_kind: decoysByKind,
      fingerprint: world.fingerprint,
    },
  };
}

export async function runRelationLineVariants(opts: {
  gut: GbrainUnderTest; seeds: readonly number[]; config: Record<string, string>; templates?: string;
  sealedTemplates?: { id: string; templates: RelationLineTemplates }; keepProse?: boolean; typeRows?: boolean; log?: (s: string) => void;
}): Promise<{ rows: H2Row[]; perSeed: Array<Record<string, unknown>>; config: Record<string, unknown> | null; worlds: RelationLineWorld[] }> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const corpus = loadCorpus('eval/data/world-v1');
    const rows: H2Row[] = [];
    const perSeed: Array<Record<string, unknown>> = [];
    const worlds: RelationLineWorld[] = [];
    let config: Record<string, unknown> | null = null;
    for (const seed of opts.seeds) {
      const world = generateRelationLineWorld({ seed, corpus, templates: opts.sealedTemplates ? undefined : opts.templates, sealedTemplates: opts.sealedTemplates, keepProse: opts.keepProse });
      worlds.push(world);
      const graph = async (config: Record<string, string>) => {
        const brain = await openP5Brain(opts.gut, config);
        try {
          for (const p of world.pages) await brain.put(p.slug, renderWorldPage(p));
          await brain.sweep();
          return { edges: await brain.edges(), record: brain.configRecord };
        } finally {
          await brain.close().catch(() => {});
        }
      };
      const on = await graph(opts.config);
      config = on.record;
      const off = await graph({ ...opts.config, 'line_grammar.enabled': 'false' });
      const scored = scoreWorld(world, on.edges, off.edges, !!opts.sealedTemplates);
      rows.push(...scored.rows);
      const typed = opts.typeRows ? typeRows(seed, corpus, on.edges, !!opts.sealedTemplates) : null;
      if (typed) rows.push(...typed.rows);
      perSeed.push({ ...scored.summary, ...(typed ? { type_rows: typed.summary } : {}) });
      if (typed) log(`seed ${seed}: type accuracy ${Number(typed.summary.type_accuracy).toFixed(3)}, any-type ${Number(typed.summary.any_type_accuracy).toFixed(3)}, strict F1 ${Number(typed.summary.strict_f1).toFixed(3)} over ${typed.summary.gold_edges} gold edges`);
      log(`seed ${seed}: ${scored.summary.rendered_lines} lines, typed recall ${Number(scored.summary.typed_recall).toFixed(3)} (grammar off ${Number(scored.summary.typed_recall_grammar_off).toFixed(3)}), decoy types reached ${scored.summary.decoy_types_reached}/${scored.summary.decoys}, added by the grammar ${scored.summary.decoy_types_added_by_grammar}`);
    }
    return { rows, perSeed, config, worlds };
  });
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const campaign = campaignGuard(rawArgv);
  const argv = campaign && !rawArgv.includes('--output') ? [...rawArgv, '--output', campaign.output] : rawArgv;
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedsFile = custodySeedsInput(argv, DEV_SEEDS);
  const seeds = seedsFile?.seeds ?? (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  const custody = seedsFile ? null : custodyInput(argv, seeds, DEV_SEEDS);
  const sealedTemplates = custody ? { id: custody.parsed.id, templates: validateTemplates(custody.parsed.templates) } : undefined;
  const devTemplates = argValue(argv, '--phrasing') ?? 'A';
  const keepProse = argv.includes('--keep-prose');
  const typeRowsFlag = argv.includes('--type-rows');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const config = parseEvalConfig();
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# ${CATEGORY} (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 9)}` : ', pinned'})`);
  let r: Awaited<ReturnType<typeof runRelationLineVariants>> | null = null;
  let harnessError: string | null = null;
  try { r = await runRelationLineVariants({ gut, seeds, config, templates: devTemplates, sealedTemplates, keepProse, typeRows: typeRowsFlag, log }); } catch (e) { harnessError = e instanceof Error ? e.message : String(e); }
  const rel = (r?.rows ?? []).filter(x => x.kind === 'relation');
  const decoys = (r?.rows ?? []).filter(x => x.kind === 'decoy');
  const edges = (r?.rows ?? []).filter(x => x.kind === 'edge');
  const sum = (xs: H2Row[], f: string) => xs.reduce((a, x) => a + (x[f] as number), 0);
  const summary = r ? {
    seeds, rendered_lines: rel.length,
    typed_recall: rel.length ? sum(rel, 'typed_recall') / rel.length : null,
    typed_recall_grammar_off: rel.length ? sum(rel, 'typed_recall_grammar_off') / rel.length : null,
    decoys: decoys.length,
    decoy_types_reached: sum(decoys, 'decoy_type_reached'),
    decoy_types_added_by_grammar: sum(decoys, 'decoy_added_by_grammar'),
    ...(typeRowsFlag ? { gold_edge_rows: edges.length, any_type_match_rate: edges.length ? sum(edges, 'anyTypeMatch') / edges.length : null,
      correctly_typed_rate: edges.length ? sum(edges, 'correctly_typed') / edges.length : null } : {}),
    per_seed: r.perSeed,
  } : null;
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, harnessError, rows: r?.rows ?? [], summary,
    basis: 'hermetic: provider keys stripped, put_page and the stale-link sweep only; no model and no paid request',
    resolvedConfig: {
      engine: 'pglite-in-memory',
      caller: 'put_page operation handler, OperationContext { remote: false, sourceId: default }',
      seeds, keep_prose: keepProse, type_rows: typeRowsFlag, generator_version: RELATION_LINE_VARIANTS_GENERATOR_VERSION,
      templates: sealedTemplates ? `held-out set ${sealedTemplates.id} (custody file sha256 ${custody!.sha256})` : `${devTemplates} (the generator's own)`,
      ...(seedsFile ? { seeds_file: { id: seedsFile.id, sha256: seedsFile.sha256, seeds: seedsFile.seeds } } : {}),
      extraction: 'extractStaleFromDB (gbrain extract --stale, catch-up) after every page is written; a second brain per seed with line_grammar.enabled=false',
      oracle: 'gold company relationships from world-v1-gold.ts buildGoldEdges; decoy stated types from the generator',
      eval_config: r?.config ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
    },
    hashes: Object.fromEntries((r?.worlds ?? []).map(w => [`world_seed_${w.seed}`, w.fingerprint])),
  });
  writeReceipt(outPath, receipt);
  campaign?.finish(outPath, 0);
  log(`receipt: ${outPath}`);
  if (harnessError) console.error(`harness error: ${harnessError}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary }, null, 2) + '\n');
  process.exit(harnessError ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
