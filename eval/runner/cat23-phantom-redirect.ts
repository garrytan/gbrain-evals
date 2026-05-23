/**
 * BrainBench Cat 23 — phantom-redirect cycle pass (v0.35.6.0).
 *
 * Headline question: when a brain accumulates "phantom" pages (unprefixed
 * slugs like `alice` that resolve to canonicals like `people/alice-okafor`),
 * does the phantom-redirect cycle pass merge them losslessly?
 *
 * Hermetic. No API keys. Uses resolveEntitySlug + resolvePhantomCanonical
 * directly from the gbrain core path; doesn't spin up the full cycle.
 *
 * Flow:
 *   1. Seed canonicals (people/alice-okafor, people/bob-chen, etc.)
 *   2. Seed phantoms (unprefixed slugs: alice, bob-c, charlie, etc.)
 *   3. For each phantom, call resolvePhantomCanonical
 *   4. Report: how many phantoms have a canonical, how many are ambiguous,
 *      how many can't be resolved
 *
 * Run:
 *   bun eval/runner/cat23-phantom-redirect.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';

// Deep import via the relative path inside node_modules (gbrain doesn't
// export `entities/resolve` as a subpath yet — file a TODO to add it).
import { resolvePhantomCanonical } from '../../node_modules/gbrain/src/core/entities/resolve.ts';

interface PhantomCase {
  phantom_slug: string;
  expected_canonical: string | null;  // null = unresolvable (ambiguous or missing)
  resolved_canonical: string | null;
  outcome: 'redirected' | 'unresolved' | 'ambiguous' | 'wrong';
}

const CANONICALS = [
  { slug: 'people/alice-okafor', body: 'Alice Okafor is CEO of [[companies/acme-ai]].' },
  { slug: 'people/bob-chen', body: 'Bob Chen is CTO at [[companies/acme-ai]].' },
  { slug: 'people/carol-singh', body: 'Carol Singh is VP Eng at [[companies/acme-ai]].' },
  { slug: 'people/dan-park', body: 'Dan Park leads ML research at [[companies/acme-ai]].' },
  { slug: 'companies/acme-ai', body: 'Acme AI: AI infrastructure company. Series A.' },
  { slug: 'companies/widget-co', body: 'Widget Co: AI consulting.' },
  { slug: 'people/erin-yu', body: 'Erin Yu works on robotics at [[companies/foundry-labs]].' },
  { slug: 'companies/foundry-labs', body: 'Foundry Labs: autonomous picking robotics.' },
];

// Phantoms — unprefixed slugs that should resolve to canonicals.
const PHANTOMS: { phantom_slug: string; expected_canonical: string | null }[] = [
  { phantom_slug: 'alice-okafor', expected_canonical: 'people/alice-okafor' },
  { phantom_slug: 'bob-chen',     expected_canonical: 'people/bob-chen' },
  { phantom_slug: 'carol-singh',  expected_canonical: 'people/carol-singh' },
  { phantom_slug: 'acme-ai',      expected_canonical: 'companies/acme-ai' },
  { phantom_slug: 'foundry-labs', expected_canonical: 'companies/foundry-labs' },
  // Ambiguous (no token matches uniquely)
  { phantom_slug: 'team',         expected_canonical: null },
  { phantom_slug: 'something-random', expected_canonical: null },
];

interface Receipt {
  schema_version: 1;
  cat: 'cat23-phantom-redirect';
  gbrain_version: string;
  timestamp: string;
  canonicals_seeded: number;
  phantoms_tested: number;
  redirects_correct: number;
  redirects_wrong: number;
  redirects_missing: number;
  per_phantom: PhantomCase[];
}

async function main(): Promise<void> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: process.env as Record<string, string | undefined>,
  });

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};

  for (const c of CANONICALS) {
    await importFromContent(engine, c.slug, c.body, { noEmbed: true });
  }
  // Seed the phantoms too — as orphan unprefixed pages
  for (const p of PHANTOMS) {
    await importFromContent(engine, p.phantom_slug, `Some draft content about ${p.phantom_slug}.`, { noEmbed: true });
  }
  console.log = origLog;

  const perPhantom: PhantomCase[] = [];
  for (const p of PHANTOMS) {
    let resolved: string | null = null;
    try {
      resolved = await resolvePhantomCanonical(engine, 'default', p.phantom_slug);
    } catch (e: any) {
      // best-effort
    }
    let outcome: PhantomCase['outcome'];
    if (resolved === p.expected_canonical) {
      outcome = resolved === null ? 'unresolved' : 'redirected';
    } else if (resolved === null && p.expected_canonical !== null) {
      outcome = 'unresolved';
    } else if (p.expected_canonical === null && resolved !== null) {
      outcome = 'ambiguous';
    } else {
      outcome = 'wrong';
    }
    perPhantom.push({
      phantom_slug: p.phantom_slug,
      expected_canonical: p.expected_canonical,
      resolved_canonical: resolved,
      outcome,
    });
  }

  await engine.disconnect();

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const correct = perPhantom.filter(p =>
    (p.expected_canonical === null && p.resolved_canonical === null) ||
    (p.expected_canonical !== null && p.resolved_canonical === p.expected_canonical)
  ).length;
  const wrong = perPhantom.filter(p => p.outcome === 'wrong' || p.outcome === 'ambiguous').length;
  const missing = perPhantom.filter(p => p.outcome === 'unresolved' && p.expected_canonical !== null).length;

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat23-phantom-redirect',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    canonicals_seeded: CANONICALS.length,
    phantoms_tested: PHANTOMS.length,
    redirects_correct: correct,
    redirects_wrong: wrong,
    redirects_missing: missing,
    per_phantom: perPhantom,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat23-phantom-redirect');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat23.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat23] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat23]   canonicals:    ${CANONICALS.length}\n`);
  process.stderr.write(`[cat23]   phantoms:      ${PHANTOMS.length}\n`);
  process.stderr.write(`[cat23]   correct:       ${correct}/${PHANTOMS.length}\n`);
  process.stderr.write(`[cat23]   wrong target:  ${wrong}\n`);
  process.stderr.write(`[cat23]   missed valid:  ${missing}\n`);
  for (const p of perPhantom) {
    const icon = p.outcome === 'redirected' ? '✓' : p.outcome === 'unresolved' && p.expected_canonical === null ? '·' : '✗';
    process.stderr.write(`[cat23]   ${icon} ${p.phantom_slug.padEnd(20)} expected=${(p.expected_canonical ?? '<none>').padEnd(28)} got=${p.resolved_canonical ?? '<none>'}\n`);
  }
  process.stderr.write(`[cat23]   receipt:       ${outFile}\n`);
}

await main();
