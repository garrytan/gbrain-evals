/**
 * P5 H5a: when a write creates a page for an entity that already has one,
 * does put_page's "did you mean an existing page?" hint name the existing
 * page, and does it stay quiet for names that belong to nobody?
 *
 * Wraps the N4 entity ledger (eval/generators/n4-entity-gen.ts, seeded):
 * the ledger's pages are imported into in-memory PGLite exactly as
 * eval/runner/n4-entity-resolution.ts imports them (importFromContent, two
 * sources), then for each probe the runner creates a page titled with the
 * probe's text through put_page on the build under test, reads the write's
 * `similar_pages` advisory (up to three candidates) and deletes the page
 * again, so every create sees only the ledger.
 *
 * Probes:
 *   solvable mentions  every N4 mention with a single-source local caller whose oracle
 *                      gold is one entity; created in the caller's source
 *   no-referent names  the N4 ledger's own no-referent mentions plus >= 50 names from
 *                      eval/generators/no-referent-names-gen.ts (no page matches them)
 * The created slug is `<people|companies>/<slugified text>` (a slug-shaped text keeps its own
 * path), with `-2`, `-3`, ... when that slug is already a ledger page (a writer does not
 * overwrite the page it duplicates).
 *
 * Rows (data.rows), pairable by `id`, `cluster` = mention family:
 *   recall_at_3  a gold page of the mention's entity is among the hint's candidates
 *   hinted       the hint named any page (no-referent probes; lower is better)
 *   lexical      the family is one the prereg calls lexically detectable (exact name,
 *                exact slug, typo, initials, changed name) or the variant is a declared alias
 * Summary: recall@3 per family, lexical recall@3, hint rate on no-referent names.
 * A build without the hint returns no candidates: recall 0 and hint rate 0 by construction.
 *
 * Arm config: GBRAIN_EVAL_CONFIG (eval/runner/eval-config.ts). Hermetic, no model.
 *
 * Usage: bun eval/runner/n4-similar-pages.ts [--seeds 1,2,3] [--pools A] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 *
 * Custodian (held-out) mode: --phrasing-file <custody path> --decision-id <id> --purpose <text> --seeds <held-out seeds>.
 * The file holds `{ "id": ..., "templates": NamePools }` and lives outside the repository; every read appends a line to
 * access-log.jsonl beside it, and the receipt records only the file's SHA-256 (rows then omit the held-out names).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from 'gbrain/operations';
import { applyEvalConfig, evalConfigRecord, parseEvalConfig } from './eval-config.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { withHermeticEnv } from './hermetic-env.ts';
import { argValue, custodyInput, p5Receipt } from './p5-brain.ts';
import { receiptPath, writeReceipt } from './receipt.ts';
import {
  N4_GENERATOR_VERSION, deriveGold, generateLedger, ledgerFingerprint, renderPage, slugPart, type Ledger, type SourceId,
} from '../generators/n4-entity-gen.ts';
import {
  DEV_SEEDS, NO_REFERENT_GENERATOR_VERSION, generateNoReferentNames, validatePools, type NamePools, type NoReferentSet,
} from '../generators/no-referent-names-gen.ts';

export const CATEGORY = 'n4-similar-pages';
export const LEXICAL_FAMILIES: readonly string[] = ['exact-name', 'exact-slug', 'typo', 'initials', 'changed-name'];

export interface Probe {
  id: string; text: string; family: string; source: SourceId; kind: 'person' | 'company';
  gold: string[] | null; documented: boolean | null; origin: 'n4-mention' | 'no-referent-gen';
}
export interface H5Row { id: string; cluster: string; seed: number; [field: string]: unknown }

/** Every probe for one ledger: solvable single-source local mentions and no-referent names. */
export function probesFor(ledger: Ledger, names: NoReferentSet): Probe[] {
  const gold = deriveGold(ledger);
  const kindOf = new Map(ledger.entities.map(e => [e.id, e.kind]));
  const probes: Probe[] = [];
  for (const m of ledger.mentions) {
    if (m.caller.remote || m.caller.sources.length !== 1) continue;
    const g = gold.get(m.id)!;
    if (m.design === 'solvable' && g.kind === 'entity') {
      probes.push({ id: `s${ledger.seed}:${m.id}`, text: m.text, family: m.family, source: m.caller.sources[0], kind: kindOf.get(g.entity)!,
        gold: g.pages, documented: m.documented, origin: 'n4-mention' });
    } else if (m.design === 'no-referent') {
      probes.push({ id: `s${ledger.seed}:${m.id}`, text: m.text, family: 'no-referent', source: m.caller.sources[0], kind: 'person', gold: null, documented: null, origin: 'n4-mention' });
    }
  }
  for (const n of names.names) {
    probes.push({ id: `s${ledger.seed}:${n.id}`, text: n.text, family: 'no-referent', source: 'default', kind: n.kind, gold: null, documented: null, origin: 'no-referent-gen' });
  }
  return probes;
}

/** The first free slug for a create titled `text`; text that is already a slug keeps its own path. */
export function createSlug(text: string, kind: Probe['kind'], taken: ReadonlySet<string>): string {
  const base = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(text.trim()) ? text.trim()
    : `${kind === 'company' ? 'companies' : 'people'}/${slugPart(text) || 'untitled'}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function isLexical(p: Pick<Probe, 'family' | 'documented'>): boolean {
  return LEXICAL_FAMILIES.includes(p.family) || p.documented === true;
}

interface Engine {
  connect(c: object): Promise<void>; initSchema(): Promise<void>; disconnect(): Promise<void>;
  setConfig(k: string, v: string): Promise<void>; getConfig(k: string): Promise<string | null>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
type Handler = (ctx: OperationContext, p: Record<string, unknown>) => Promise<unknown>;

async function runSeed(gut: GbrainUnderTest, ledger: Ledger, names: NoReferentSet, config: Record<string, string>, redact: boolean): Promise<{ rows: H5Row[]; config: Record<string, unknown> }> {
  const { PGLiteEngine } = await importGbrain<{ PGLiteEngine: new () => Engine }>(gut, 'src/core/pglite-engine.ts');
  const { importFromContent } = await importGbrain<{ importFromContent: (e: Engine, slug: string, md: string, o: object) => Promise<unknown> }>(gut, 'src/core/import-file.ts');
  const { operations } = await importGbrain<{ operations: Array<{ name: string; handler: Handler }> }>(gut, 'src/core/operations.ts');
  const { KNOWN_CONFIG_KEYS } = await importGbrain<{ KNOWN_CONFIG_KEYS?: readonly string[] }>(gut, 'src/core/config.ts');
  const op = (name: string) => { const o = operations.find(x => x.name === name); if (!o) throw new Error(`gbrain has no operation ${name}`); return o.handler; };
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    const applied = await applyEvalConfig(engine, config);
    for (const s of ledger.sources) if (s !== 'default') await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [s]);
    for (const p of ledger.pages) await importFromContent(engine, p.slug, renderPage(p), { noEmbed: true, sourceId: p.source });
    const [landed] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL');
    if (landed.n !== ledger.pages.length) throw new Error(`presence: ${landed.n} pages landed, ledger has ${ledger.pages.length}`);

    const ctxFor = (source: SourceId) => ({ engine, config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: source }) as unknown as OperationContext;
    const taken = new Map<SourceId, Set<string>>(ledger.sources.map(s => [s, new Set(ledger.pages.filter(p => p.source === s).map(p => p.slug))]));
    const rows: H5Row[] = [];
    for (const probe of probesFor(ledger, names)) {
      const ctx = ctxFor(probe.source);
      const slug = createSlug(probe.text, probe.kind, taken.get(probe.source)!);
      taken.get(probe.source)!.add(slug);
      const content = `---\ntitle: ${JSON.stringify(probe.text)}\ntype: ${probe.kind}\n---\n\n# ${probe.text}\n\nNotes about ${probe.text}.\n`;
      const written = await op('put_page')(ctx, { slug, content }) as Record<string, unknown>;
      const outcome = (written.outcome ?? written) as { similar_pages?: { candidates?: Array<{ slug: string; source_id: string; evidence: string }> }; revision?: string };
      const candidates = (outcome.similar_pages?.candidates ?? []).slice(0, 3);
      await op('delete_page')(ctx, { slug, ...(outcome.revision ? { expected_revision: outcome.revision } : {}) });
      const keys = candidates.map(c => `${c.source_id}:${c.slug}`);
      const hide = redact && probe.origin === 'no-referent-gen';
      rows.push({
        id: probe.id, cluster: probe.family, seed: ledger.seed, family: probe.family, origin: probe.origin, source: probe.source,
        ...(hide ? {} : { text: probe.text, slug_written: slug }), lexical: isLexical(probe),
        candidates: candidates.map(c => ({ key: `${c.source_id}:${c.slug}`, evidence: c.evidence })),
        ...(probe.gold ? { gold: probe.gold, recall_at_3: Number(keys.some(k => probe.gold!.includes(k))) } : { hinted: Number(candidates.length > 0) }),
      });
    }
    return { rows, config: evalConfigRecord(applied, KNOWN_CONFIG_KEYS ?? null) };
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

export function summarizeH5(rows: readonly H5Row[]): Record<string, unknown> {
  const mean = (xs: readonly H5Row[], f: string) => xs.length ? xs.reduce((a, r) => a + (r[f] as number), 0) / xs.length : null;
  const solvable = rows.filter(r => typeof r.recall_at_3 === 'number');
  const families = [...new Set(solvable.map(r => r.family as string))].sort();
  const noRef = rows.filter(r => typeof r.hinted === 'number');
  return {
    recall_at_3_by_family: Object.fromEntries(families.map(f => { const of = solvable.filter(r => r.family === f); return [f, { n: of.length, recall_at_3: mean(of, 'recall_at_3') }]; })),
    lexical: { n: solvable.filter(r => r.lexical).length, recall_at_3: mean(solvable.filter(r => r.lexical), 'recall_at_3') },
    solvable: { n: solvable.length, recall_at_3: mean(solvable, 'recall_at_3') },
    no_referent: {
      n: noRef.length, hint_rate: mean(noRef, 'hinted'),
      generated: { n: noRef.filter(r => r.origin === 'no-referent-gen').length, hint_rate: mean(noRef.filter(r => r.origin === 'no-referent-gen'), 'hinted') },
      n4_ledger: { n: noRef.filter(r => r.origin === 'n4-mention').length, hint_rate: mean(noRef.filter(r => r.origin === 'n4-mention'), 'hinted') },
    },
  };
}

export async function runN4SimilarPages(opts: {
  gut: GbrainUnderTest; seeds: readonly number[]; config: Record<string, string>; pools?: string; sealedPools?: { id: string; pools: NamePools }; log?: (s: string) => void;
}): Promise<{ rows: H5Row[]; perSeed: Array<Record<string, unknown>>; config: Record<string, unknown> | null; hashes: Record<string, string> }> {
  return withHermeticEnv(CATEGORY, async () => {
    const log = opts.log ?? (() => {});
    const rows: H5Row[] = [];
    const perSeed: Array<Record<string, unknown>> = [];
    const hashes: Record<string, string> = {};
    let config: Record<string, unknown> | null = null;
    for (const seed of opts.seeds) {
      const ledger = generateLedger(seed);
      const names = generateNoReferentNames({ seed, ledger, pools: opts.sealedPools ? undefined : opts.pools, sealedPools: opts.sealedPools });
      hashes[`ledger_seed_${seed}`] = ledgerFingerprint(ledger);
      hashes[`no_referent_seed_${seed}`] = names.fingerprint;
      const r = await runSeed(opts.gut, ledger, names, opts.config, !!opts.sealedPools);
      config = r.config;
      rows.push(...r.rows);
      const s = summarizeH5(r.rows);
      perSeed.push({ seed, ...s });
      const lex = s.lexical as { n: number; recall_at_3: number | null };
      const nr = s.no_referent as { n: number; hint_rate: number | null };
      log(`seed ${seed}: lexical recall@3 ${lex.recall_at_3?.toFixed(3)} (n ${lex.n}), no-referent hint rate ${nr.hint_rate?.toFixed(3)} (n ${nr.n})`);
    }
    return { rows, perSeed, config, hashes };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seeds = (argValue(argv, '--seeds') ?? DEV_SEEDS.join(',')).split(',').map(Number);
  const custody = custodyInput(argv, seeds, DEV_SEEDS);
  const sealedPools = custody ? { id: custody.parsed.id, pools: validatePools(custody.parsed.templates) } : undefined;
  const devPools = argValue(argv, '--pools') ?? 'A';
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const config = parseEvalConfig();
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# ${CATEGORY} (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 9)}` : ', pinned'})`);
  let r: Awaited<ReturnType<typeof runN4SimilarPages>> | null = null;
  let harnessError: string | null = null;
  try { r = await runN4SimilarPages({ gut, seeds, config, pools: devPools, sealedPools, log }); } catch (e) { harnessError = e instanceof Error ? e.message : String(e); }
  const pooled = r ? summarizeH5(r.rows) : null;
  const summary = r ? {
    seeds, ...pooled,
    lexical_recall_at_3: (pooled!.lexical as { recall_at_3: number | null }).recall_at_3,
    no_referent_hint_rate: (pooled!.no_referent as { hint_rate: number | null }).hint_rate,
    similar_pages_supported: existsSync(join(gut.root, 'src/core/similar-pages.ts')),
    per_seed: r.perSeed,
  } : null;
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt, harnessError, rows: r?.rows ?? [], summary,
    basis: 'hermetic: provider keys stripped, importFromContent, put_page and delete_page only; no model and no paid request',
    resolvedConfig: {
      engine: 'pglite-in-memory',
      caller: 'put_page and delete_page operation handlers, OperationContext { remote: false, sourceId: the mention caller\'s source }',
      seeds, n4_generator_version: N4_GENERATOR_VERSION, no_referent_generator_version: NO_REFERENT_GENERATOR_VERSION,
      pools: sealedPools ? `held-out set ${sealedPools.id} (custody file sha256 ${custody!.sha256})` : `${devPools} (development)`,
      create: 'title = probe text; slug = <people|companies>/<slugified text> (slug-shaped text keeps its path), -2, -3, ... past existing ledger slugs; deleted after the hint is read',
      gold: 'N4 oracle (deriveGold) pages of the mention\'s entity in the caller\'s source',
      lexical_families: LEXICAL_FAMILIES, lexical_also: 'any mention whose variant is a declared alias (documented: true)',
      eval_config: r?.config ?? { channel: 'GBRAIN_EVAL_CONFIG', requested: config },
    },
    hashes: r?.hashes,
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
