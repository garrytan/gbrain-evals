/**
 * seed.ts — ingest the 35-belief PrecisionMemBench fixture into an in-memory
 * gbrain (PGLite) the way real content arrives: one page per belief.
 *
 *   - slug === beliefId (so the returned page slug round-trips to the fixture)
 *   - belief.scope[0] → gbrain source_id (registered first; FK requires it)
 *   - body = canonical_name + aliases + content + why_it_matters, so gbrain's
 *     real FTS matches alias queries ("k8s" → kubernetes) — this is gbrain's
 *     keyword search doing real work, not a bench-specific alias index.
 *   - ALL beliefs are seeded LIVE, including superseded ones (audit finding
 *     precisionmembench-01). The upstream provider contract sends providers
 *     only {text, user_id, metadata:{beliefId, scope}, aliases} — never a
 *     supersession field — so leaderboard systems had to infer supersession
 *     from in-band prose ("Previously used TSLint... Replaced by ESLint.").
 *     This harness previously read the fixture's ground-truth `superseded_by`
 *     and pre-hid those beliefs via engine.softDeletePage — the answer key
 *     leaking into the index at seed time. That branch is REMOVED: gbrain
 *     must exclude superseded beliefs itself or fail those cases honestly.
 *     Scores dropped when the leak was removed; the report doc says so.
 *
 * Fidelity (A6):
 *   - 'body-text'  : the above. The everyday ingest path. Ships now.
 *   - 'structured' : exercise gbrain's structured alias/entity layer (facts).
 *                    Deferred to the Phase-4 facts-mode data point — there is
 *                    no page-level alias index beyond FTS, so the honest
 *                    "structured" comparison is the facts path. Throws until
 *                    implemented so we never emit misleading duplicate numbers.
 */

import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { loadConfig } from 'gbrain/config';
import { configureGateway } from '../../node_modules/gbrain/src/core/ai/gateway.ts';
import type { BrainEngine } from 'gbrain/engine';
import type { Belief } from './scorer/belief.ts';
import { scopeToSourceId, distinctSourceIds } from './scope.ts';

export type SeedFidelity = 'body-text' | 'structured';

export interface SeedOpts {
  fidelity?: SeedFidelity;
  /** Skip chunk embedding (keyword-only honest fallback when no embed key). */
  noEmbed?: boolean;
}

/** Configure the AI gateway once (mirrors cli.ts#connectEngine + longmemeval). */
export function configureGatewayForBench(): void {
  const cfg = (loadConfig() as unknown as Record<string, unknown>) || {};
  configureGateway({
    embedding_model: cfg.embedding_model,
    embedding_dimensions: cfg.embedding_dimensions,
    expansion_model: cfg.expansion_model,
    chat_model: cfg.chat_model,
    chat_fallback_chain: cfg.chat_fallback_chain,
    base_urls: cfg.provider_base_urls,
    env: { ...process.env },
  } as Parameters<typeof configureGateway>[0]);
}

/** Fresh in-memory PGLite brain. */
export async function createBenchEngine(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

/** Register the source rows the beliefs reference (FK target for pages). */
async function registerSources(engine: BrainEngine, beliefs: Belief[]): Promise<void> {
  const ids = distinctSourceIds(beliefs.map((b) => b.scope as string[]));
  for (const sid of ids) {
    if (sid === 'default') continue;
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [sid, sid],
    );
  }
}

/** canonical_name + aliases + content + why_it_matters → markdown body. */
function bodyTextFor(b: Belief): string {
  const aliases = (b.aliases ?? []).join(', ');
  const lines = [
    `# ${b.canonical_name}`,
    '',
    aliases ? `Also known as: ${aliases}` : '',
    '',
    b.content ?? '',
    '',
    b.why_it_matters ?? '',
  ];
  return lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n');
}

/**
 * Ingest beliefs into the engine. Every belief is seeded LIVE — the fixture's
 * ground-truth `superseded_by` is never consulted (see header + audit finding
 * precisionmembench-01). Returns the imported count plus how many superseded
 * beliefs entered the index live, so runners can report the honest setup.
 * Caller separately calls `adapter.loadFixture(beliefs)` to populate seedIndex.
 */
export async function seedGbrainEngine(
  engine: BrainEngine,
  beliefs: Belief[],
  opts: SeedOpts = {},
): Promise<{ imported: number; supersededLive: number }> {
  const fidelity = opts.fidelity ?? 'body-text';
  if (fidelity === 'structured') {
    throw new Error(
      "seed fidelity 'structured' is deferred to the Phase-4 facts-mode data point " +
        '(no page-level alias index beyond FTS). Use --fidelity body-text for now.',
    );
  }

  await registerSources(engine, beliefs);

  let imported = 0;
  let supersededLive = 0;
  for (const b of beliefs) {
    const sourceId = scopeToSourceId((b.scope as string[])[0] ?? 'default');
    await importFromContent(engine, b._id as string, bodyTextFor(b), {
      sourceId,
      noEmbed: opts.noEmbed === true,
    });
    imported++;
    if (b.superseded_by != null) supersededLive++;
  }
  return { imported, supersededLive };
}
