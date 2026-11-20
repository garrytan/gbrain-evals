/**
 * G6 reachability: imports a generated world into an in-process PGLite brain
 * through gbrain's own import path (importFromContent, keyless hash embeddings
 * from the live-recall fixture), then asks gbrain's own read operations, through
 * the MCP dispatch layer, whether a local caller (remote: false, the trusted
 * CLI) and a remote caller (remote: true over stdio, no grant) can reach each
 * gold page. gbrain decides visibility; this file only counts.
 *
 * Two surfaces per caller: get_page by slug (the reachability verdict) and a
 * keyword `search` for the page's own fact value (reported beside it). Gold a
 * caller cannot get is out of view and counted under the privacy_hidden cause,
 * split by its intended sub-cause. A gold page whose observed reachability
 * disagrees with its intended view (a marked page a remote caller still gets, an
 * unmarked page it does not, or any gold the local caller misses) is counted as
 * unexpected. Every count is a count of hides, never a judgment that a hide is
 * right or wrong.
 *
 * Callers must run inside enterHermeticEnv or withHermeticEnv
 * (eval/runner/hermetic-env.ts): no provider key is read and no provider call
 * is made.
 */
import { assertEmbedded } from '../../import-embedded.ts';
import { importGbrain, type GbrainUnderTest } from '../../gbrain-under-test.ts';
import { useFixtureTransports } from '../../live-recall/run.ts';
import { PRIVACY_SUBCAUSES, type CauseId, type PrivacySubcause } from '../causes.ts';
import { CALLERS, expectedReachable, type Caller, type IntendedView, type Knobs, type World } from './gen.ts';

export const REACH_SCHEMA = 'gbrain-evals/predictive-out-of-view/reach/v1';

export interface PageReach {
  slug: string;
  intended: IntendedView;
  variant: string;
  get_page: Record<Caller, boolean>;
  search: Record<Caller, boolean>;
}

export interface CallerCounts {
  gold: number;
  reachable: number;
  out_of_view: number;
  /** Gold whose own fact value finds it through keyword search. */
  found_by_search: number;
  /** Out-of-view gold by its intended sub-cause; out-of-view gold with no privacy marker is in unexpected only. */
  by_subcause: Record<PrivacySubcause, number>;
}

export interface UnexpectedRow { slug: string; caller: Caller; intended: IntendedView; variant: string; reachable: boolean }

export interface ReachReport {
  schema: typeof REACH_SCHEMA;
  seed: number;
  knobs: Knobs;
  world_digest: string;
  gbrain_version: string;
  cause: CauseId;
  surfaces: { reachability: 'get_page'; also_reported: 'search' };
  by_caller: Record<Caller, CallerCounts>;
  unexpected: number;
  unexpected_rows: UnexpectedRow[];
  pages: PageReach[];
}

function textOf(r: { content?: Array<{ type: string; text?: string }> }): string {
  return (r.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
}

/** Import every world page into a fresh in-memory PGLite brain with keyless transports. */
export async function buildWorldBrain(gut: GbrainUnderTest, world: World): Promise<{ engine: any; close: () => Promise<void> }> {
  const reset = await useFixtureTransports(gut);
  const { PGLiteEngine } = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    for (const page of world.pages) assertEmbedded(await importFromContent(engine, page.slug, page.markdown, { noEmbed: false }), page.slug);
  } catch (e) {
    reset();
    await engine.disconnect().catch(() => {});
    throw e;
  }
  return { engine, close: async () => { reset(); await engine.disconnect(); } };
}

/** Ask gbrain's get_page and search operations, as each caller, about every gold page. */
export async function probeReach(gut: GbrainUnderTest, engine: any, world: World): Promise<PageReach[]> {
  const dispatch = await importGbrain<any>(gut, 'src/mcp/dispatch.ts');
  const call = async (caller: Caller, name: string, params: Record<string, unknown>) =>
    dispatch.dispatchToolCall(engine, name, params, { remote: caller === 'remote', transport: 'stdio', sourceId: 'default' });
  const rows: PageReach[] = [];
  for (const page of world.pages.filter(p => p.gold)) {
    const needle = '"slug":"' + page.slug + '"';
    const row: PageReach = { slug: page.slug, intended: page.intended!, variant: page.variant!, get_page: { local: false, remote: false }, search: { local: false, remote: false } };
    for (const caller of CALLERS) {
      const got = await call(caller, 'get_page', { slug: page.slug });
      row.get_page[caller] = got.isError !== true && textOf(got).includes(needle);
      const found = await call(caller, 'search', { query: page.value!, limit: 10 });
      row.search[caller] = found.isError !== true && textOf(found).includes(needle);
    }
    rows.push(row);
  }
  return rows;
}

export function summarize(world: World, gbrainVersion: string, pages: PageReach[]): ReachReport {
  const by_caller = {} as Record<Caller, CallerCounts>;
  const unexpected_rows: UnexpectedRow[] = [];
  for (const caller of CALLERS) {
    const by_subcause = Object.fromEntries(PRIVACY_SUBCAUSES.map(s => [s, 0])) as Record<PrivacySubcause, number>;
    let reachable = 0, found_by_search = 0;
    for (const p of pages) {
      const r = p.get_page[caller];
      if (r) reachable += 1;
      else if (p.intended !== 'visible') by_subcause[p.intended] += 1;
      if (p.search[caller]) found_by_search += 1;
      if (r !== expectedReachable(p.intended, caller)) unexpected_rows.push({ slug: p.slug, caller, intended: p.intended, variant: p.variant, reachable: r });
    }
    by_caller[caller] = { gold: pages.length, reachable, out_of_view: pages.length - reachable, found_by_search, by_subcause };
  }
  return {
    schema: REACH_SCHEMA, seed: world.seed, knobs: world.knobs, world_digest: world.digest, gbrain_version: gbrainVersion,
    cause: 'privacy_hidden', surfaces: { reachability: 'get_page', also_reported: 'search' },
    by_caller, unexpected: unexpected_rows.length, unexpected_rows, pages,
  };
}

/** Build the brain, probe every gold page as both callers, and summarize. Run inside the hermetic environment. */
export async function measureReach(gut: GbrainUnderTest, world: World): Promise<ReachReport> {
  const brain = await buildWorldBrain(gut, world);
  try {
    return summarize(world, gut.version, await probeReach(gut, brain.engine, world));
  } finally {
    await brain.close();
  }
}

/** One plain line per caller: counts of hides, with no verdict on them. */
export function reachSummaryLines(report: ReachReport): string[] {
  return CALLERS.map(caller => {
    const c = report.by_caller[caller];
    return caller + ' caller: ' + c.reachable + ' of ' + c.gold + ' gold pages in view, ' + c.out_of_view + ' out of view ('
      + PRIVACY_SUBCAUSES.map(s => s + ' ' + c.by_subcause[s]).join(', ') + ')';
  }).concat('unexpected (observed view differs from the intended one): ' + report.unexpected);
}
