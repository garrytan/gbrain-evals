/**
 * BrainBench Cat 23 — phantom-redirect resolution conformance.
 *
 * Headline question: when a brain accumulates "phantom" pages (bare-name
 * slugs like `alice` that should point at canonicals like
 * `people/alice-okafor`), does gbrain's phantom-redirect decision core
 * resolve them — and refuse when it must?
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: the decision core of gbrain's phantom-redirect cycle pass —
 *   - resolvePhantomCanonical (entities/resolve.ts): fuzzy-title arm, then
 *     bare-name prefix expansion over people/ companies/ hosts/ projects/
 *     with the `<dir>/<token>-%` LIKE pattern
 *   - findPrefixCandidates: the standalone ambiguity gate tryRedirectPhantom
 *     (cycle/phantom-redirect.ts) runs after resolution — >1 candidate must
 *     refuse the redirect
 * This runner mirrors tryRedirectPhantom's resolve→ambiguity-gate sequence
 * exactly; the commit phase (fact migration, disk fence, soft delete) is out
 * of scope, as is the cycle's lock/limit plumbing.
 * LEGITIMATELY SEEDED: canonical + phantom pages via importFromContent with
 * noEmbed (no gateway, no keys). Deep import of the resolver via the
 * node_modules relative path — gbrain does not export `entities/resolve` as
 * a subpath yet (upstream TODO stands).
 *
 * ── Fixture design (audit cats22-25-05) ──────────────────────────────
 * Phantoms are BARE NAMES ('alice', not 'alice-okafor'): prefix expansion
 * builds `<dir>/<token>-%`, so a full canonical tail can never match — the
 * old fixture set structurally excluded the exact layer the resolver was
 * built for. The set includes:
 *   - 6 bare names that MUST redirect (the designed case),
 *   - 'dan', ambiguous across people/dan-park + people/dan-brown: MUST be
 *     refused by the ambiguity gate (proves the probe detects refusals),
 *   - 'team' with no candidate: MUST resolve to nothing,
 *   - one full-tail phantom ('bob-chen') pinned as a KNOWN LIMITATION:
 *     fuzzy self-matches win the tiebreak and `people/bob-chen-%` cannot
 *     LIKE-match `people/bob-chen`, so the intended contract is
 *     no_canonical. A redirect to the exact canonical is also accepted
 *     (that would be an upstream improvement, not a regression); anything
 *     else fails.
 *
 * Run:
 *   bun eval/runner/cat23-phantom-redirect.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';

// Deep import via the relative path inside node_modules (gbrain doesn't
// export `entities/resolve` as a subpath yet — upstream TODO stands).
import {
  resolvePhantomCanonical,
  findPrefixCandidates,
} from '../../node_modules/gbrain/src/core/entities/resolve.ts';

export const CAT23_CATEGORY = 'cat23-phantom-redirect';

export type PhantomDecision = 'redirect' | 'ambiguous' | 'no_canonical' | 'error';

export interface PhantomExpectation {
  phantom_slug: string;
  /**
   * The decision the redirect pass must reach.
   *  - redirect: expected_canonical must match exactly
   *  - ambiguous: resolver found a canonical but the ambiguity gate refuses
   *  - no_canonical: nothing to redirect to
   */
  expected_decision: Exclude<PhantomDecision, 'error'>;
  expected_canonical: string | null;
  /**
   * Known-limitation escape hatch: when set, a redirect to EXACTLY
   * expected_canonical also passes (documents that an upstream improvement
   * is acceptable while pinning today's contract). Anything else fails.
   */
  also_accept_redirect_to?: string;
  note?: string;
}

export interface PhantomCase {
  phantom_slug: string;
  expected_decision: string;
  expected_canonical: string | null;
  decision: PhantomDecision;
  resolved_canonical: string | null;
  prefix_candidates: number;
  pass: boolean;
  error: string | null;
}

export const CANONICALS: Array<{ slug: string; body: string }> = [
  { slug: 'people/alice-okafor', body: '# Alice Okafor\n\nAlice Okafor is CEO of [[companies/acme-ai]].' },
  { slug: 'people/bob-chen', body: '# Bob Chen\n\nBob Chen is CTO at [[companies/acme-ai]].' },
  { slug: 'people/carol-singh', body: '# Carol Singh\n\nCarol Singh is VP Eng at [[companies/acme-ai]].' },
  // Deliberate ambiguity pair for the refuse-to-redirect path:
  { slug: 'people/dan-park', body: '# Dan Park\n\nDan Park leads ML research at [[companies/acme-ai]].' },
  { slug: 'people/dan-brown', body: '# Dan Brown\n\nDan Brown runs data infrastructure at [[companies/widget-co]].' },
  { slug: 'people/erin-yu', body: '# Erin Yu\n\nErin Yu works on robotics at [[companies/foundry-labs]].' },
  { slug: 'companies/acme-ai', body: '# Acme AI\n\nAcme AI: AI infrastructure company. Series A.' },
  { slug: 'companies/widget-co', body: '# Widget Co\n\nWidget Co: AI consulting.' },
  { slug: 'companies/foundry-labs', body: '# Foundry Labs\n\nFoundry Labs: autonomous picking robotics.' },
];

export const PHANTOMS: PhantomExpectation[] = [
  // The designed bare-name case: prefix expansion `people/<token>-%`.
  { phantom_slug: 'alice', expected_decision: 'redirect', expected_canonical: 'people/alice-okafor' },
  { phantom_slug: 'bob', expected_decision: 'redirect', expected_canonical: 'people/bob-chen' },
  { phantom_slug: 'carol', expected_decision: 'redirect', expected_canonical: 'people/carol-singh' },
  { phantom_slug: 'erin', expected_decision: 'redirect', expected_canonical: 'people/erin-yu' },
  // companies/ directory expansion:
  { phantom_slug: 'acme', expected_decision: 'redirect', expected_canonical: 'companies/acme-ai' },
  { phantom_slug: 'foundry', expected_decision: 'redirect', expected_canonical: 'companies/foundry-labs' },
  // MUST-fail-redirect fixtures (prove the probe detects refusals):
  {
    phantom_slug: 'dan', expected_decision: 'ambiguous', expected_canonical: null,
    note: 'two people/dan-* candidates — the ambiguity gate must refuse',
  },
  {
    phantom_slug: 'team', expected_decision: 'no_canonical', expected_canonical: null,
    note: 'no prefixed candidate anywhere — must resolve to nothing',
  },
  // Known limitation, pinned: full-tail phantoms are outside the resolver's
  // design (fuzzy self-match wins; `people/bob-chen-%` cannot match
  // `people/bob-chen`). An exact-canonical redirect is accepted as an
  // upstream improvement; a redirect anywhere ELSE fails.
  {
    phantom_slug: 'bob-chen', expected_decision: 'no_canonical', expected_canonical: null,
    also_accept_redirect_to: 'people/bob-chen',
    note: 'full canonical tail: documented out-of-scope for prefix expansion',
  },
];

/**
 * Mirror of tryRedirectPhantom's decision sequence (cycle/phantom-redirect.ts
 * lines ~404-425): resolve, then the standalone ambiguity gate. The commit
 * phase and body-residue gate are out of scope (we call with known stubs).
 */
export async function decidePhantom(
  engine: unknown,
  sourceId: string,
  phantomSlug: string,
): Promise<{ decision: PhantomDecision; canonical: string | null; candidates: number }> {
  const canonical = await resolvePhantomCanonical(engine as any, sourceId, phantomSlug);
  if (!canonical) return { decision: 'no_canonical', canonical: null, candidates: 0 };
  const candidates = await findPrefixCandidates(engine as any, sourceId, phantomSlug);
  if (candidates.length > 1) return { decision: 'ambiguous', canonical, candidates: candidates.length };
  return { decision: 'redirect', canonical, candidates: candidates.length };
}

/** Score one phantom case against its expectation. */
export function scorePhantomCase(
  exp: PhantomExpectation,
  decision: PhantomDecision,
  canonical: string | null,
): boolean {
  if (decision === 'error') return false;
  if (decision === exp.expected_decision) {
    if (exp.expected_decision === 'redirect') return canonical === exp.expected_canonical;
    return true;
  }
  // Known-limitation escape hatch: exact upstream improvement accepted.
  if (exp.also_accept_redirect_to && decision === 'redirect' && canonical === exp.also_accept_redirect_to) {
    return true;
  }
  return false;
}

export interface Cat23Options {
  reportsDir?: string;
  quiet?: boolean;
  /** Test hooks: substitute fixture sets to prove the gate can fail. */
  canonicals?: Array<{ slug: string; body: string }>;
  phantoms?: PhantomExpectation[];
}

export interface Cat23RunResult {
  receipt: Receipt;
  cases: PhantomCase[];
  exitCode: number;
  receiptFile: string;
}

export async function runCat23(options: Cat23Options = {}): Promise<Cat23RunResult> {
  const startedAt = new Date().toISOString();
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT23_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);
  const canonicals = options.canonicals ?? CANONICALS;
  const phantoms = options.phantoms ?? PHANTOMS;

  // Isolate GBRAIN_HOME so user config can't bleed into the run. No gateway
  // configuration at all: every import is noEmbed and the resolver is SQL-only.
  const home = join(tmpdir(), `cat23-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const acc = new ProbeAccounting(phantoms.length);
  const cases: PhantomCase[] = [];

  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    try {
      for (const c of canonicals) {
        await importFromContent(engine, c.slug, c.body, { noEmbed: true });
      }
      // Seed the phantoms as orphan bare-slug stub pages, the shape the
      // redirect pass scans for.
      for (const p of phantoms) {
        await importFromContent(engine, p.phantom_slug, `# ${p.phantom_slug}\n`, { noEmbed: true });
      }
    } catch (e: any) {
      console.log = origLog;
      console.error = origErr;
      await engine.disconnect();
      const receipt: Receipt = {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT23_CATEGORY,
        run_status: 'error',
        n_total: phantoms.length,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'seed', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat23] seed failed: ${e?.message ?? e}\n`);
      return { receipt, cases: [], exitCode: 1, receiptFile };
    }

    for (const exp of phantoms) {
      let decision: PhantomDecision = 'error';
      let canonical: string | null = null;
      let candidates = 0;
      let error: string | null = null;
      try {
        const d = await decidePhantom(engine, 'default', exp.phantom_slug);
        decision = d.decision;
        canonical = d.canonical;
        candidates = d.candidates;
      } catch (e: any) {
        // Resolver crash = the SUT failing the probe. Recorded with its own
        // 'error' outcome — never folded into 'unresolved', never allowed to
        // masquerade as a correct null (audit cats22-25-06).
        error = String(e?.message ?? e).slice(0, 300);
      }
      const pass = error === null && scorePhantomCase(exp, decision, canonical);
      cases.push({
        phantom_slug: exp.phantom_slug,
        expected_decision: exp.expected_decision,
        expected_canonical: exp.expected_canonical,
        decision,
        resolved_canonical: canonical,
        prefix_candidates: candidates,
        pass,
        error,
      });
      if (pass) {
        acc.score(exp.phantom_slug, 1);
      } else if (error !== null) {
        acc.error(exp.phantom_slug, 'sut', `resolver threw on '${exp.phantom_slug}': ${error}`);
      } else {
        acc.error(
          exp.phantom_slug, 'sut',
          `'${exp.phantom_slug}': expected ${exp.expected_decision}${exp.expected_canonical ? `→${exp.expected_canonical}` : ''}, got ${decision}${canonical ? `→${canonical}` : ''}`,
        );
      }
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    await engine.disconnect();
  }

  const summary = acc.summary();
  const redirectsCorrect = cases.filter(c => c.pass && c.decision === 'redirect').length;
  const refusalsCorrect = cases.filter(c => c.pass && c.decision !== 'redirect').length;
  const errored = cases.filter(c => c.error !== null).length;
  const verdict: 'pass' | 'fail' = cases.length === phantoms.length && cases.every(c => c.pass) ? 'pass' : 'fail';
  const runInvalid = summary.run_invalid;

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT23_CATEGORY,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && verdict === 'pass' && !options.phantoms && !options.canonicals,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      source_id: 'default',
      resolver: 'resolvePhantomCanonical + findPrefixCandidates (deep import; mirrors tryRedirectPhantom decision core)',
      embed_transport: 'none (noEmbed everywhere; resolver is SQL-only)',
      canonicals_seeded: canonicals.length,
      phantoms_tested: phantoms.length,
    },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      per_phantom: cases,
      redirects_correct: redirectsCorrect,
      refusals_correct: refusalsCorrect,
      resolver_errors: errored,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT23_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat23.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat23] ─── Scorecard ───────────────────\n`);
  log(`[cat23]   canonicals:       ${canonicals.length}\n`);
  log(`[cat23]   phantoms:         ${phantoms.length}\n`);
  log(`[cat23]   correct:          ${cases.filter(c => c.pass).length}/${phantoms.length} (${redirectsCorrect} redirects, ${refusalsCorrect} correct refusals)\n`);
  log(`[cat23]   resolver errors:  ${errored}\n`);
  for (const c of cases) {
    const icon = c.pass ? '✓' : '✗';
    log(`[cat23]   ${icon} ${c.phantom_slug.padEnd(14)} expected=${c.expected_decision.padEnd(12)} got=${c.decision.padEnd(12)} canonical=${c.resolved_canonical ?? '<none>'}${c.error ? ` ERROR: ${c.error}` : ''}\n`);
  }
  log(`[cat23]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'}\n`);
  log(`[cat23]   receipt:          ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, cases, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat23();
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT23_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT23_CATEGORY,
        run_status: 'error',
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [{ probe_id: 'preflight', origin: 'harness', message: String(e?.message ?? e).slice(0, 500) }],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch { /* receipt write failed too — exit code carries the failure */ }
    process.stderr.write(`[cat23] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
