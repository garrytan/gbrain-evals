/**
 * P5 H4: do links written before their target page exists heal once the page
 * appears?
 *
 * An agent writes notes one at a time, so a page often links a person or
 * company whose page comes later. This runner writes world-v1 (240 pages)
 * page by page through put_page on in-memory PGLite with the build under
 * test, in a seeded shuffled order and in the reverse of that order, running
 * the stale-link sweep (`gbrain extract --stale`, extractStaleFromDB) after
 * every 10 pages and after the last. The reference is the same pages written
 * all at once followed by one sweep, when every target already exists.
 *
 * A withheld variant drops a seeded 20% of the person and company pages and
 * writes the rest the same way; the build's `wanted_pages` list (links whose
 * target page does not exist) should then name the withheld entities that
 * remaining pages link to, and little else.
 *
 * Rows (data.rows), pairable by `id`:
 *   kind edge      edge_kept        a reference edge (from, to, type) is stored after the
 *                                   sequential import (cluster = seed:order:from page)
 *   kind withheld  withheld_recall  a withheld entity that remaining pages link to is among
 *                                   the wanted_pages targets (cluster = the entity)
 * Summary per seed: reference edges and edges lost per order, extra edges,
 * withheld entities referenced and found, wanted targets and the share that
 * are not entity-shaped (`people/<slug>` or `companies/<slug>`).
 * A build without the `wanted_pages` operation lists nothing: its withheld
 * recall is 0 by construction and the summary says so.
 *
 * HTTP arm: not run here; the receipt records why (HTTP_ARM).
 *
 * Arm config: GBRAIN_EVAL_CONFIG (eval/runner/eval-config.ts). Hermetic, no model.
 *
 * Usage: bun eval/runner/forward-reference-heal.ts [--seeds 1,2,3] [--sweep-every 10] [--withhold 0.2] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 *
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>.
 * H4 has no templates: the custody file (`{ "id": ... }`) records the draw, every read appends a line to
 * access-log.jsonl beside it, and the receipt records only the file's SHA-256.
 */
import { join } from 'node:path';
import { Rng, fingerprint } from '../generators/seeded.ts';
import { linksTo } from '../generators/relation-line-variants-gen.ts';
import { parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { argValue, custodyInput, edgeKeys, openP5Brain, p5Receipt, renderWorldPage, type P5Brain, type StoredEdge } from './p5-brain.ts';
import { receiptPath, writeReceipt } from './receipt.ts';
import { loadCorpus, type RichPage } from './world-v1-gold.ts';

export const CATEGORY = 'forward-reference-heal';
export const FORWARD_REFERENCE_VERSION = 'forward-reference-heal/1';
export const DEV_SEEDS: readonly number[] = [1, 2, 3];
export const HTTP_ARM = {
  status: 'not run',
  reason: 'This runner writes in process as a trusted local caller. An in-process remote put_page is refused (writer_registration_required), so a remote arm needs a gbrain serve --http session, where link extraction for remote writes waits for a sweep the server schedules.',
} as const;

const ENTITY_SHAPED = /^(people|companies)\/[a-z0-9][a-z0-9._-]*$/;

export interface H4Row { id: string; kind: 'edge' | 'withheld'; cluster: string; seed: number; [field: string]: unknown }
interface WantedTarget { target: string; ref_kind?: string; referenced_by?: number }

/** The seeded write order and the withheld set for one seed. */
export function planSeed(slugs: readonly string[], seed: number, withholdShare: number): { order: string[]; withheld: string[] } {
  const rng = new Rng(seed * 15_485_863 + 11);
  const order = rng.shuffle([...slugs].sort());
  const entities = [...slugs].filter(s => ENTITY_SHAPED.test(s)).sort();
  const withheld = rng.shuffle(entities).slice(0, Math.round(entities.length * withholdShare)).sort();
  return { order, withheld };
}

async function writeSequentially(brain: P5Brain, pages: readonly RichPage[], every: number): Promise<number> {
  let sweeps = 0;
  for (const [i, p] of pages.entries()) {
    await brain.put(p.slug, renderWorldPage(p));
    if ((i + 1) % every === 0 || i === pages.length - 1) { await brain.sweep(); sweeps++; }
  }
  return sweeps;
}

async function wantedTargets(brain: P5Brain): Promise<WantedTarget[] | null> {
  if (!brain.hasOp('wanted_pages')) return null;
  const out: WantedTarget[] = [];
  for (let offset = 0; ;) {
    const page = await brain.op('wanted_pages', { limit: 100, offset }) as { targets: WantedTarget[]; next_offset: number | null };
    out.push(...page.targets);
    if (page.next_offset == null) return out;
    offset = page.next_offset;
  }
}

/** A wanted target names a slug when it is that slug, or a bare-name reference to its basename. */
export function wantedNames(targets: readonly WantedTarget[], slug: string): boolean {
  const base = slug.slice(slug.lastIndexOf('/') + 1);
  return targets.some(t => t.target === slug || (t.ref_kind === 'name' && t.target === base));
}

/** Pooled share of wanted targets that are not entity-shaped; null when no seed listed any target. */
export function nonEntityShare(perSeed: ReadonlyArray<Record<string, unknown>>): number | null {
  const w = perSeed.map(s => s.withheld as { wanted_targets: number; non_entity_targets: number });
  const total = w.reduce((a, x) => a + x.wanted_targets, 0);
  return total ? w.reduce((a, x) => a + x.non_entity_targets, 0) / total : null;
}

export async function runForwardReferenceHeal(opts: {
  gut: GbrainUnderTest; seeds: readonly number[]; config: Record<string, string>; sweepEvery?: number; withholdShare?: number; log?: (s: string) => void;
}): Promise<{ rows: H4Row[]; perSeed: Array<Record<string, unknown>>; reference: { edges: number }; config: Record<string, unknown> | null; plans: Record<string, string> }> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const every = opts.sweepEvery ?? 10;
    const share = opts.withholdShare ?? 0.2;
    const corpus = loadCorpus('eval/data/world-v1');
    const bySlug = new Map(corpus.map(p => [p.slug, p]));
    const withBrain = async <T>(fn: (b: P5Brain) => Promise<T>): Promise<T> => {
      const brain = await openP5Brain(opts.gut, opts.config);
      try { return await fn(brain); } finally { await brain.close().catch(() => {}); }
    };

    let config: Record<string, unknown> | null = null;
    const reference: StoredEdge[] = await withBrain(async b => {
      config = b.configRecord;
      for (const p of corpus) await b.put(p.slug, renderWorldPage(p));
      await b.sweep();
      return b.edges();
    });
    const refKeys = [...edgeKeys(reference)].sort();
    const refSet = new Set(refKeys);
    log(`reference (all pages, one sweep): ${refKeys.length} edges`);

    const rows: H4Row[] = [];
    const perSeed: Array<Record<string, unknown>> = [];
    const plans: Record<string, string> = {};
    for (const seed of opts.seeds) {
      const plan = planSeed(corpus.map(p => p.slug), seed, share);
      plans[`plan_seed_${seed}`] = fingerprint({ v: FORWARD_REFERENCE_VERSION, seed, every, share, ...plan });
      const orders: Record<string, string[]> = { shuffled: plan.order, reversed: [...plan.order].reverse() };
      const seedSummary: Record<string, unknown> = { seed, reference_edges: refKeys.length };
      for (const [name, order] of Object.entries(orders)) {
        const { stored, sweeps } = await withBrain(async b => {
          const sweeps = await writeSequentially(b, order.map(s => bySlug.get(s)!), every);
          return { stored: edgeKeys(await b.edges()), sweeps };
        });
        let lost = 0;
        for (const key of refKeys) {
          const [from, to, type] = JSON.parse(key) as [string, string, string];
          const kept = stored.has(key);
          if (!kept) lost++;
          rows.push({ id: `s${seed}:${name}:edge:${key}`, kind: 'edge', cluster: `s${seed}:${name}:${from}`, seed, order: name, from, to, type, edge_kept: Number(kept) });
        }
        const extra = [...stored].filter(k => !refSet.has(k)).length;
        seedSummary[name] = { sweeps, edges_lost: lost, lost_share: lost / refKeys.length, extra_edges: extra };
        log(`seed ${seed} ${name}: ${lost}/${refKeys.length} reference edges lost (${sweeps} sweeps), ${extra} extra`);
      }

      const withheld = new Set(plan.withheld);
      const remaining = plan.order.filter(s => !withheld.has(s)).map(s => bySlug.get(s)!);
      const targets = await withBrain(async b => { await writeSequentially(b, remaining, every); return wantedTargets(b); });
      const referenced = plan.withheld.filter(slug => remaining.some(p => linksTo(`${p.compiled_truth}\n${p.timeline}`, slug)));
      for (const slug of referenced) {
        rows.push({ id: `s${seed}:withheld:${slug}`, kind: 'withheld', cluster: slug, seed, slug, withheld_recall: Number(!!targets && wantedNames(targets, slug)) });
      }
      const found = referenced.filter(slug => !!targets && wantedNames(targets, slug)).length;
      const nonEntity = (targets ?? []).filter(t => !ENTITY_SHAPED.test(t.target));
      const prefixes: Record<string, number> = {};
      for (const t of targets ?? []) { const k = t.target.includes('/') ? t.target.slice(0, t.target.indexOf('/')) : `(${t.ref_kind ?? 'bare'})`; prefixes[k] = (prefixes[k] ?? 0) + 1; }
      seedSummary.withheld = {
        withheld: plan.withheld.length, referenced: referenced.length, found_in_wanted: found,
        recall: referenced.length ? found / referenced.length : null,
        wanted_pages_supported: targets !== null,
        wanted_targets: targets?.length ?? 0,
        non_entity_targets: nonEntity.length,
        non_entity_share: targets?.length ? nonEntity.length / targets.length : null,
        non_entity_examples: nonEntity.slice(0, 10).map(t => t.target),
        targets_by_prefix: prefixes,
      };
      log(`seed ${seed} withheld: ${found}/${referenced.length} referenced withheld entities in wanted_pages${targets ? `; ${targets.length} wanted targets, ${nonEntity.length} not entity-shaped` : ' (build has no wanted_pages operation)'}`);
      perSeed.push(seedSummary);
    }
    return { rows, perSeed, reference: { edges: refKeys.length }, config, plans };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seeds = (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  const custody = custodyInput(argv, seeds, DEV_SEEDS);
  const sweepEvery = Number(argValue(argv, '--sweep-every') ?? 10);
  const withholdShare = Number(argValue(argv, '--withhold') ?? 0.2);
  if (!Number.isInteger(sweepEvery) || sweepEvery < 1) throw new Error('--sweep-every must be a positive integer');
  if (!(withholdShare > 0 && withholdShare < 1)) throw new Error('--withhold must be a share between 0 and 1');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const config = parseEvalConfig();
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# ${CATEGORY} (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 9)}` : ', pinned'})`);
  let r: Awaited<ReturnType<typeof runForwardReferenceHeal>> | null = null;
  let harnessError: string | null = null;
  try { r = await runForwardReferenceHeal({ gut, seeds, config, sweepEvery, withholdShare, log }); } catch (e) { harnessError = e instanceof Error ? e.message : String(e); }
  const edges = (r?.rows ?? []).filter(x => x.kind === 'edge');
  const withheld = (r?.rows ?? []).filter(x => x.kind === 'withheld');
  const summary = r ? {
    seeds, reference_edges: r.reference.edges,
    edges_lost: edges.filter(x => x.edge_kept === 0).length, edge_checks: edges.length,
    withheld_recall: withheld.length ? withheld.reduce((a, x) => a + (x.withheld_recall as number), 0) / withheld.length : null,
    non_entity_share: nonEntityShare(r.perSeed),
    per_seed: r.perSeed,
    http_arm: HTTP_ARM,
  } : null;
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, harnessError, rows: r?.rows ?? [], summary,
    basis: 'hermetic: provider keys stripped, put_page, the stale-link sweep and wanted_pages only; no model and no paid request',
    resolvedConfig: {
      engine: 'pglite-in-memory',
      caller: 'put_page and wanted_pages operation handlers, OperationContext { remote: false, sourceId: default }',
      seeds, sweep_every: sweepEvery, withhold_share: withholdShare, version: FORWARD_REFERENCE_VERSION,
      draw: custody ? `held-out draw ${custody.parsed.id} (custody file sha256 ${custody.sha256})` : 'development seeds',
      reference: 'all 240 world-v1 pages written, then one extractStaleFromDB sweep',
      sequential: `pages written one at a time in a seeded shuffled order and its reverse; extractStaleFromDB after every ${sweepEvery} pages and after the last`,
      entity_shaped: ENTITY_SHAPED.source,
      http_arm: HTTP_ARM,
      eval_config: r?.config ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
    },
    hashes: r?.plans,
  });
  writeReceipt(outPath, receipt);
  log(`receipt: ${outPath}`);
  if (harnessError) console.error(`harness error: ${harnessError}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, summary }, null, 2) + '\n');
  process.exit(harnessError ? 3 : 0);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
