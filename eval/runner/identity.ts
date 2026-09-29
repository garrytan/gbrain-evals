/**
 * BrainBench Category 3: Alias lookup through keyword search (formerly
 * "Identity Resolution").
 *
 * Tests whether keyword search ranks one canonical page first for an alias
 * ("Sarah Chen", "S. Chen", "@schen", "sarah.chen@example.com").
 *
 * This protocol measures searchKeyword (tsvector) only. It never calls
 * gbrain's identity features, which exist and go untested here (coverage
 * audit F5): the entity resolver (`resolveEntitySlugWithSource`, fuzzy title
 * and prefix expansion, src/core/entities/resolve.ts), write-time alias
 * resolution (resolve-on-save.ts), cross-source identity groups
 * (entity-identity.ts) and the exact slug/title/alias lookup floor
 * (search/exact-lookup.ts). Documented aliases occur in the fixture body;
 * undocumented variants do not, so undocumented recall measures how far
 * lexical search alone gets, not gbrain's alias resolution.
 *
 * The handle without its @ ("schen") is scored as DOCUMENTED: the tsvector
 * parser strips the @ from the indexed "@schen", so the bare handle is present
 * in the indexed text. Counting it as undocumented inflated the published
 * undocumented recall from 13.75% (55/400) to 31.0% (C-03, audit 2026-09-28).
 *
 * Receipt: eval/reports/identity/receipt.json. Verdict gates on documented
 * recall (an exact-token contract) and a documented MRR floor; undocumented
 * recall is reported as a capability-gap measurement, not gated.
 *
 * Usage: bun run eval/runner/identity.ts [--json]
 */

import { PGLiteEngine } from 'gbrain/pglite-engine';
import { installPageProjection, readProjectionSnapshot } from '../../node_modules/gbrain/src/core/page-state/projections.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, receiptPath, writeReceipt, type Receipt, type ReceiptVerdict, noModelSpend } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';

export interface Entity {
  canonicalSlug: string;
  fullName: string;
  /** Aliases written into the canonical page body and chunk: full name, @handle, email. */
  indexedAliases: string[];
  /** Query aliases present in the indexed text: the indexed aliases plus the handle without @. */
  documentedAliases: string[];
  /** Aliases whose tokens are NOT in any page (initials, typos). */
  undocumentedAliases: string[];
}

const FIRST_NAMES = ['Sarah', 'Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack', 'Kate', 'Liam', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rachel', 'Sam'];
const LAST_NAMES = ['Chen', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson'];
const COMPANIES = ['stripe.com', 'acme.io', 'beta.co', 'gamma.dev', 'delta.ai'];

export function generateEntities(n: number): Entity[] {
  const entities: Entity[] = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
    const fullName = `${first} ${last}`;
    const handle = `@${first[0].toLowerCase()}${last.toLowerCase()}`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@${COMPANIES[i % COMPANIES.length]}`;
    const initial = `${first[0]}. ${last}`;
    const noSpace = `${first[0]} ${last}`;
    const typo1 = `${first.slice(0, -1)}${first[first.length - 1]}${first[first.length - 1]} ${last}`;
    const typo2 = `${first} ${last}n`;
    const handlePlain = handle.slice(1);

    entities.push({
      canonicalSlug: `people/${first.toLowerCase()}-${last.toLowerCase()}-${i}`,
      fullName,
      indexedAliases: [fullName, handle, email],
      documentedAliases: [fullName, handle, email, handlePlain],
      undocumentedAliases: [initial, noSpace, typo1, typo2],
    });
  }
  return entities;
}

interface QueryResult {
  alias: string;
  canonicalSlug: string;
  category: 'documented' | 'undocumented';
  found: boolean;
  rankPosition: number; // 1-indexed; 0 = not in top-10
}

/** Documented aliases are exact tokens in the page, so recall must be complete. */
export const CAT3_GATES = { min_documented_recall: 1, min_documented_mrr: 0.95 } as const;

export function cat3Verdict(summary: { docRecall: number; docMrr: number }): ReceiptVerdict {
  return summary.docRecall >= CAT3_GATES.min_documented_recall && summary.docMrr >= CAT3_GATES.min_documented_mrr ? 'pass' : 'fail';
}

export function aliasType(alias: string, category: 'documented' | 'undocumented'): string {
  if (category === 'documented') {
    if (alias.startsWith('@')) return 'handle';
    if (alias.includes('@')) return 'email';
    return alias.includes(' ') ? 'fullname' : 'handle-plain';
  }
  if (/^[A-Z]\. /.test(alias)) return 'initial';
  if (/^[A-Z] /.test(alias)) return 'no-period';
  return 'typo';
}

export async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;
  const startedAt = new Date().toISOString();

  log('# BrainBench Category 3: Identity Resolution\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const entities = generateEntities(100);
  log(`Entities: ${entities.length}`);
  log(`Aliases per entity: ${entities[0].documentedAliases.length} documented + ${entities[0].undocumentedAliases.length} undocumented = ${entities[0].documentedAliases.length + entities[0].undocumentedAliases.length} total`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed canonical pages. Each page mentions the entity by full name + handle + email.
  for (const e of entities) {
    await engine.putPage(e.canonicalSlug, {
      type: 'person',
      title: e.fullName,
      compiled_truth: `${e.fullName} (also known as ${e.indexedAliases.slice(1).join(', ')}) is a person in our network. Reach them at ${e.indexedAliases[2]}.`,
      timeline: '',
    });
    // Also chunk for searchKeyword.
    const snapshot = await readProjectionSnapshot(engine, e.canonicalSlug, 'default', { allowUnsealed: true });
    if (!snapshot) throw new Error(`identity fixture snapshot missing: ${e.canonicalSlug}`);
    const chunkText = `${e.fullName} ${e.indexedAliases.join(' ')}`;
    await installPageProjection(engine, snapshot, [
      { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' },
    ], { seal: true });
    const stored = await engine.getPage(e.canonicalSlug, { sourceId: 'default' });
    const chunks = await engine.getChunks(e.canonicalSlug, { sourceId: 'default' });
    if (stored?.compiled_truth !== snapshot.snapshot.page.compiled_truth || chunks.length !== 1 || chunks[0].chunk_text !== chunkText) {
      throw new Error(`identity fixture text/chunk contract changed: ${e.canonicalSlug}`);
    }
  }

  // Run queries.
  const results: QueryResult[] = [];
  for (const e of entities) {
    for (const cat of ['documented', 'undocumented'] as const) {
      const aliases = cat === 'documented' ? e.documentedAliases : e.undocumentedAliases;
      for (const alias of aliases) {
        const r = await engine.searchKeyword(alias, { limit: 10 });
        // Page-level dedup, keep highest score per slug
        const seen = new Set<string>();
        const pages = r.filter(x => { if (seen.has(x.slug)) return false; seen.add(x.slug); return true; });
        const idx = pages.findIndex(x => x.slug === e.canonicalSlug);
        results.push({
          alias,
          canonicalSlug: e.canonicalSlug,
          category: cat,
          found: idx >= 0,
          rankPosition: idx + 1, // 0 if not found
        });
      }
    }
  }

  await engine.disconnect();

  // ── Metrics ──
  const documented = results.filter(r => r.category === 'documented');
  const undocumented = results.filter(r => r.category === 'undocumented');
  const docRecall = documented.filter(r => r.found).length / documented.length;
  const undocRecall = undocumented.filter(r => r.found).length / undocumented.length;
  const docMrr = documented.reduce((s, r) => s + (r.found ? 1 / r.rankPosition : 0), 0) / documented.length;
  const undocMrr = undocumented.reduce((s, r) => s + (r.found ? 1 / r.rankPosition : 0), 0) / undocumented.length;

  log('\n## Metrics');
  log('| Alias category   | Recall (top-10) | MRR    |');
  log('|------------------|-----------------|--------|');
  log(`| Documented       | ${(docRecall * 100).toFixed(1)}%             | ${docMrr.toFixed(3)}  |`);
  log(`| Undocumented     | ${(undocRecall * 100).toFixed(1)}%             | ${undocMrr.toFixed(3)}  |`);

  log('\n## Per-alias-type breakdown (documented)');
  const docByType: Record<string, { found: number; total: number }> = {};
  for (const r of documented) {
    const type = aliasType(r.alias, 'documented');
    docByType[type] ??= { found: 0, total: 0 };
    docByType[type].total++;
    if (r.found) docByType[type].found++;
  }
  for (const [type, { found, total }] of Object.entries(docByType)) {
    log(`  ${type.padEnd(10)} ${found}/${total} = ${((found / total) * 100).toFixed(1)}%`);
  }

  log('\n## Per-alias-type breakdown (undocumented)');
  const undocByType: Record<string, { found: number; total: number }> = {};
  for (const r of undocumented) {
    const type = aliasType(r.alias, 'undocumented');
    undocByType[type] ??= { found: 0, total: 0 };
    undocByType[type].total++;
    if (r.found) undocByType[type].found++;
  }
  for (const [type, { found, total }] of Object.entries(undocByType)) {
    log(`  ${type.padEnd(13)} ${found}/${total} = ${((found / total) * 100).toFixed(1)}%`);
  }

  log('\n## Interpretation');
  log('Documented aliases (full name, handle, email mentioned in canonical body, plus the handle without @, which the tsvector index also holds):');
  log(`  Recall ${(docRecall * 100).toFixed(1)}% through this fixture's tsvector keyword path.`);
  log('Undocumented aliases (initials, typos):');
  log(`  Recall ${(undocRecall * 100).toFixed(1)}% through the same keyword path, without invoking the alias resolver.`);
  log('');
  log('Scope: this keyword-only protocol does not measure the explicit alias resolver, fuzzy matching, or nickname lookup.');

  const summary = { docRecall, undocRecall, docMrr, undocMrr, docByType, undocByType };
  const verdict = cat3Verdict(summary);
  log(`\nVerdict: ${verdict} (documented recall >= ${CAT3_GATES.min_documented_recall * 100}%, documented MRR >= ${CAT3_GATES.min_documented_mrr})`);
  writeReceipt(receiptPath('identity'), {
    ...noModelSpend('hermetic: no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: 'identity',
    run_status: 'completed',
    verdict,
    n_total: results.length,
    n_scored: results.length,
    completion_rate: 1,
    errors: [],
    publishable: true,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: { entities: entities.length, search: 'searchKeyword limit 10', gates: CAT3_GATES },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: { summary, results },
  } satisfies Receipt);

  if (json) {
    process.stdout.write(JSON.stringify({ results, summary, verdict }, null, 2) + '\n');
  }
  if (verdict !== 'pass') process.exitCode = 1;
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1); });
