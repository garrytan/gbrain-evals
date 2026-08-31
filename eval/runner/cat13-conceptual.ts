/**
 * BrainBench Cat 13 — Conceptual Recall.
 *
 * Where BrainBench's Cats 1+2 measure relational retrieval (entity lookups,
 * typed-edge traversal), Cat 13 measures conceptual retrieval: paraphrase,
 * vocabulary substitution, fuzzy recall, semantic neighborhood.
 *
 * This is the Cat where vector should actually earn its keep. The Cat
 * 1+2 scorecard shows vector at P@5 10.8% because relational queries
 * demand exact-entity matching — vectors smear entity names into
 * neighborhoods. Cat 13 flips the workload.
 *
 * Corpus: the 30 concepts/ pages in world-v1.
 * Probes: deterministic, template-generated variants per concept.
 * Metric: nDCG@5 (graded gold: target=3, co-occurrence peers=1).
 *
 * AUDIT REMEDIATIONS baked into this runner:
 *   - retrieval-cats-08: semantic-neighborhood probes are grounded in the
 *     QUERY TEXT, not the generating concept. "concepts related to <B>" is
 *     emitted once (for B itself, gold B=3 + B's neighbors=1), never once
 *     per neighbor with conflicting golds. Company-seeded probes are
 *     generated in one global pass (one probe per company, every concept
 *     that lists the company graded 3, the company page graded 1) and use
 *     the company page title, not the slug tail. Any probe text that two
 *     concepts still both claim is DROPPED as ambiguous at generation, and
 *     `assertUniqueProbeTexts` fails the run on any surviving duplicate.
 *   - retrieval-cats-13: CAT13_PROBES is validated (`5oo` throws instead of
 *     silently producing a 0-probe run scored 0.0%), and a 0-probe build
 *     aborts the run.
 *   - retrieval-cats-17: probe sampling uses a seeded Fisher-Yates shuffle
 *     (fixed rng draws per element), not a random sort comparator, so the
 *     sampled set is identical across JS runtimes, not just within one.
 *
 * Verdict policy (receipt): this Cat is a comparative scorecard with no
 * published absolute bar. A completed run is 'pass' when every standard
 * adapter arm ran live with full scoring and the gbrain arm shows live
 * retrieval (nDCG@5 > 0); 'partial' when the run was hermetic (--stub-embed)
 * or an --adapter subset; 'fail' when the gbrain arm ran and scored 0.0
 * (dead retrieval plumbing). Probe-set integrity violations and the infra
 * error cap are run_status 'error' (exit non-zero), never a quiet pass.
 *
 * Run:
 *   bun eval/runner/cat13-conceptual.ts                  # live embeds (OPENAI_API_KEY)
 *   bun eval/runner/cat13-conceptual.ts --stub-embed     # hermetic, no keys
 *   CAT13_PROBES=1000 bun eval/runner/cat13-conceptual.ts
 *   CAT13_PROBES=200 bun eval/runner/cat13-conceptual.ts --adapter vector
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { sanitizePage, sanitizeQuery } from './types.ts';
import { ndcgAtK, precisionAtK } from './metrics.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  writeReceipt, receiptPath, RECEIPT_SCHEMA_VERSION, BENCHMARK_VERSION,
  type Receipt, type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

export const TOP_K = 5;
const CATEGORY = 'cat13-conceptual';
export const PROBE_SEED = 42;

/** CAT13_PROBES guard (audit retrieval-cats-13): a typo like `5oo` used to
 *  become NaN → Math.round(NaN) → .slice(0, NaN) → a 0-probe run printed as
 *  an all-zero scorecard with exit 0. Now it throws. */
export function resolveTargetProbes(raw: string | undefined = process.env.CAT13_PROBES): number {
  if (raw === undefined || raw.trim() === '') return 500;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`CAT13_PROBES must be a positive number, got '${raw}'`);
  }
  return Math.floor(n);
}

// ─── Corpus loader ────────────────────────────────────────────────

export interface RichPage extends Page {
  _facts: {
    type: string;
    name?: string;
    description?: string;
    related_companies?: string[];
    related_people?: string[];
    role?: string;
    primary_affiliation?: string;
    employees?: string[];
    founders?: string[];
    investors?: string[];
    attendees?: string[];
  };
}

export function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

// ─── Seeded RNG (mulberry32) + Fisher-Yates ───────────────────────

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Seeded Fisher-Yates (audit retrieval-cats-17). Unlike a random sort
 * comparator, this is unbiased AND consumes exactly `arr.length - 1` rng
 * draws regardless of the engine's sort implementation, so the sampled
 * probe set is identical across Bun/Node versions, and one concept's
 * shuffle can never perturb a later concept's sample.
 */
export function seededShuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Synonym / cross-vocabulary map ───────────────────────────────
//
// Keyed by concept slug. Each entry is a list of alternative phrasings a
// user might employ instead of the page title. Deliberately light — this
// is BrainBench, not Oxford. Missing entries fall back to title-only probes.

const SYNONYMS: Record<string, string[]> = {
  'concepts/do-things-that-don-t-scale': [
    'unscalable founder work', 'hand-crafted early traction',
    'manual white-glove onboarding', 'unscalable effort as strategy',
  ],
  'concepts/product-market-fit': [
    'PMF', 'when the product pulls users toward it',
    'the thing founders chase before scale', 'market pull',
  ],
  'concepts/founder-mode': [
    'hands-on founder involvement', 'the opposite of professional management',
    'deep founder ownership of details',
  ],
  'concepts/agentic-workflows': [
    'multi-agent orchestration', 'AI agents collaborating',
    'agent-to-agent delegation', 'agent-first systems',
  ],
  'concepts/unit-economics': [
    'per-customer profitability', 'CAC vs LTV math',
    'the unit-level cost of growth',
  ],
  'concepts/usage-based-pricing': [
    'pay-per-use pricing', 'consumption pricing',
    'charge-by-what-you-use', 'metered billing',
  ],
  'concepts/vertical-saas': [
    'industry-specific software', 'niche SaaS for one vertical',
    'specialized enterprise tools',
  ],
  'concepts/horizontal-api': [
    'cross-industry API platform', 'broadly-applicable infra',
    'general-purpose developer platform',
  ],
  'concepts/foundation-models': [
    'large base models', 'general-purpose LLMs',
    'pretrained model families',
  ],
  'concepts/fine-tuning': [
    'domain adaptation', 'post-training specialization',
    'taking a base model and teaching it new tricks',
  ],
  'concepts/inference-cost': [
    'runtime LLM cost', 'cost per query at serve time',
    'what it costs to run the model',
  ],
  'concepts/latency-budget': [
    'response time ceiling', 'speed SLA',
    'how fast the product has to feel',
  ],
  'concepts/retrieval-augmented-generation': [
    'RAG', 'grounding LLMs in external docs',
    'injecting private context into model calls',
  ],
  'concepts/open-source-distribution': [
    'OSS-led GTM', 'open-core strategy',
    'community-first distribution', 'free-then-paid',
  ],
  'concepts/developer-relations': [
    'DevRel', 'developer advocacy',
    'building bottoms-up dev mindshare',
  ],
  'concepts/community-led-growth': [
    'CLG', 'community as flywheel',
    'grassroots adoption strategy',
  ],
  'concepts/plg-motion': [
    'product-led sales', 'self-serve-first growth',
    'freemium motion',
  ],
  'concepts/enterprise-gtm': [
    'top-down enterprise selling', 'big-ticket B2B sales',
    'six-figure contract motion',
  ],
  'concepts/top-down-sales': [
    'exec-first selling', 'suite-level enterprise sales',
    'selling to the C-suite',
  ],
  'concepts/multi-modal': [
    'vision + text + audio', 'cross-modality models',
    'beyond text-only AI',
  ],
  'concepts/ai-first-product': [
    'AI-native UX', 'products where the LLM is the product',
    'AI as core primitive, not a feature',
  ],
  'concepts/embedded-fintech': [
    'fintech built into someone else\'s product',
    'finance APIs powering other apps',
    'invisible financial infrastructure',
  ],
  'concepts/churn-cohorts': [
    'retention by signup month', 'month-1 retention',
    'cohort-sliced churn analysis',
  ],
  'concepts/customer-concentration': [
    'revenue riding on one customer', 'whale dependency',
    'top-account exposure',
  ],
  'concepts/gross-margin-expansion': [
    'margin improvement as the business scales',
    'path to better unit economics',
    'variable-cost leverage',
  ],
  'concepts/revenue-durability': [
    'how sticky ARR actually is', 'net-revenue-retention quality',
    'protection against churn',
  ],
  'concepts/second-time-founder': [
    'repeat founder', 'serial entrepreneur',
    'founder on startup #2',
  ],
  'concepts/carbon-credits': [
    'offset markets', 'emissions offsets',
    'voluntary carbon market',
  ],
  'concepts/permitting-reform': [
    'faster permitting', 'environmental review speedup',
    'NEPA reform',
  ],
  'concepts/wallet-share': [
    'share of customer spend', 'revenue penetration per account',
    'budget capture',
  ],
};

// ─── Probe generator ──────────────────────────────────────────────

export interface Probe {
  q: Query;
  /** Slugs whose rank-1 placement counts as a strict hit (grade-3 set). */
  targetSlugs: string[];
  template: string; // which template bucket generated it (for per-template rollups)
}

function extractKeyPhrases(text: string, maxN = 4): string[] {
  // Naive noun-phrase proxy: grab 2-4 word sequences of Title-case words
  // and lowercase noun-like phrases. Good enough for paraphrase seeds.
  const out = new Set<string>();
  const titleCase = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g) ?? [];
  for (const m of titleCase) {
    if (m.split(/\s+/).length <= maxN && m.length > 4) out.add(m);
  }
  // Distinctive bigrams like "unit economics", "manual onboarding"
  const lower = (text.toLowerCase().match(/\b(?:[a-z]{4,}\s+[a-z]{4,})\b/g) ?? []).slice(0, 30);
  for (const m of lower) out.add(m);
  return [...out].slice(0, 15);
}

export class DuplicateProbeTextError extends Error {}

/**
 * The loud guard behind the generation-time dedupe (audit retrieval-cats-08):
 * two probes with the same query text but different golds make every
 * deterministic retriever structurally wrong on all but one twin. Throws on
 * ANY duplicate text in the final probe set.
 */
export function assertUniqueProbeTexts(probes: readonly Probe[]): void {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const p of probes) {
    const key = p.q.text.toLowerCase().trim();
    const prior = seen.get(key);
    if (prior !== undefined) {
      dupes.push(`'${p.q.text}' (${prior} vs ${p.q.id})`);
    } else {
      seen.set(key, p.q.id);
    }
  }
  if (dupes.length > 0) {
    throw new DuplicateProbeTextError(
      `${dupes.length} duplicate probe text(s) with potentially conflicting golds: ${dupes.slice(0, 5).join('; ')}${dupes.length > 5 ? ' …' : ''}`,
    );
  }
}

export function buildProbes(
  pages: RichPage[],
  targetProbes: number = resolveTargetProbes(),
  seed: number = PROBE_SEED,
): { probes: Probe[]; gradesByQuery: Map<string, Map<string, number>> } {
  const rng = mulberry32(seed);
  const concepts = pages.filter(p => p.slug.startsWith('concepts/'));
  const pageBySlug = new Map(pages.map(p => [p.slug, p]));

  // Co-occurrence graph: concepts that share >=1 related_company or related_person score 1.
  const coOccur = new Map<string, Set<string>>();
  for (const a of concepts) {
    const set = new Set<string>();
    const aRelated = new Set([
      ...(a._facts.related_companies ?? []),
      ...(a._facts.related_people ?? []),
    ]);
    for (const b of concepts) {
      if (a.slug === b.slug) continue;
      const bRelated = new Set([
        ...(b._facts.related_companies ?? []),
        ...(b._facts.related_people ?? []),
      ]);
      for (const r of aRelated) if (bRelated.has(r)) { set.add(b.slug); break; }
    }
    coOccur.set(a.slug, set);
  }

  const probes: Probe[] = [];
  const gradesByQuery = new Map<string, Map<string, number>>();
  let counter = 0;
  const nextId = () => `c13-${String(++counter).padStart(5, '0')}`;

  // Probes per concept so per-concept probes ≈ targetProbes
  const perConcept = Math.max(8, Math.round(targetProbes / Math.max(1, concepts.length)));

  // Pass 1: generate every concept's variant candidates (pre-cap).
  const variantsByConcept = new Map<string, Array<{ text: string; template: string }>>();
  for (const c of concepts) {
    const name = (c._facts.name ?? c.title).toLowerCase();
    const desc = (c._facts.description ?? '').replace(/\.$/, '').toLowerCase();
    const synonyms = SYNONYMS[c.slug] ?? [];
    const keyPhrases = extractKeyPhrases(c.compiled_truth).filter(p =>
      !p.toLowerCase().includes(name.split(' ')[0]),
    );

    const variants: Array<{ text: string; template: string }> = [];

    // A. Title paraphrase
    variants.push(
      { text: `what is ${name}?`, template: 'title-paraphrase' },
      { text: `tell me about ${name}`, template: 'title-paraphrase' },
      { text: `define ${name}`, template: 'title-paraphrase' },
      { text: `explain ${name} to me`, template: 'title-paraphrase' },
      { text: `describe ${name}`, template: 'title-paraphrase' },
    );

    // B. Title variations (less exact phrasing)
    variants.push(
      { text: `the ${name} framework`, template: 'title-variation' },
      { text: `${name} as a concept`, template: 'title-variation' },
      { text: `the idea of ${name}`, template: 'title-variation' },
      { text: `how does ${name} work`, template: 'title-variation' },
    );

    // C. Description paraphrase
    if (desc) {
      variants.push(
        { text: `the concept of ${desc}`, template: 'description-paraphrase' },
        { text: `notes on ${desc}`, template: 'description-paraphrase' },
      );
    }

    // D. Cross-vocabulary via hand-authored synonyms (THE vector-favoring tier)
    for (const syn of synonyms) {
      variants.push(
        { text: `what is ${syn}`, template: 'synonym' },
        { text: `notes on ${syn}`, template: 'synonym' },
        { text: `the concept behind ${syn}`, template: 'synonym' },
        { text: `that essay arguing ${syn}`, template: 'synonym-fuzzy' },
      );
    }

    // E. Key-phrase fuzzy recall (extracted from compiled_truth body)
    for (const kp of keyPhrases.slice(0, 6)) {
      variants.push(
        { text: `that thing about ${kp}`, template: 'body-fuzzy' },
        { text: `the framework I wrote about ${kp}`, template: 'body-fuzzy' },
      );
    }

    // F. Semantic neighborhood — grounded in THIS concept's own name (audit
    // retrieval-cats-08: the old form generated "concepts related to <B>"
    // once per NEIGHBOR of B, each copy demanding a different page at #1).
    // Emitted once, for the named concept, when it has a neighborhood.
    if ((coOccur.get(c.slug)?.size ?? 0) > 0) {
      variants.push({
        text: `concepts related to ${name}`,
        template: 'semantic-neighborhood',
      });
    }

    // Dedupe by text within the concept
    const seen = new Set<string>();
    variantsByConcept.set(c.slug, variants.filter(v => {
      const k = v.text.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }));
  }

  // Pass 2: GLOBAL dedupe (audit retrieval-cats-08). A text emitted by two
  // different concepts is ambiguous — its golds conflict — so every copy is
  // dropped at generation, before sampling.
  const claimCounts = new Map<string, number>();
  for (const variants of variantsByConcept.values()) {
    for (const v of variants) {
      const k = v.text.toLowerCase().trim();
      claimCounts.set(k, (claimCounts.get(k) ?? 0) + 1);
    }
  }
  let droppedAmbiguous = 0;
  for (const [slug, variants] of variantsByConcept) {
    variantsByConcept.set(slug, variants.filter(v => {
      const unique = claimCounts.get(v.text.toLowerCase().trim()) === 1;
      if (!unique) droppedAmbiguous++;
      return unique;
    }));
  }

  // Pass 3: per-concept sample (seeded Fisher-Yates, fixed draw count) + emit.
  for (const c of concepts) {
    const unique = variantsByConcept.get(c.slug) ?? [];
    const sampled = seededShuffle(unique, rng).slice(0, perConcept);

    // Graded gold for this concept: target = 3, co-occurrence neighbors = 1.
    const grades = new Map<string, number>();
    grades.set(c.slug, 3);
    for (const n of coOccur.get(c.slug) ?? []) grades.set(n, 1);

    for (const v of sampled) {
      const id = nextId();
      const q: Query = {
        id,
        tier: 'fuzzy',
        text: v.text,
        expected_output_type: 'cited-source-pages',
        gold: {
          grades: Object.fromEntries(grades),
          relevant: [c.slug], // strict target for P@1 / binary scorer compat
        },
        tags: [v.template, 'cat-13', 'concept-recall'],
      };
      probes.push({ q, targetSlugs: [c.slug], template: v.template });
      gradesByQuery.set(id, grades);
    }
  }

  // Pass 4: company-seeded neighborhood probes — ONE GLOBAL PASS (audit
  // retrieval-cats-08: previously each concept that listed a company emitted
  // the same text with itself as the sole target; 23 of 62 companies are
  // listed by more than one concept). One probe per company; every concept
  // listing the company is graded 3 (they are all "frameworks that come up"),
  // the company page itself is graded 1 (on-topic, not a framework). Query
  // text uses the company page's display name, never the slug tail.
  const companyToConcepts = new Map<string, string[]>();
  for (const c of concepts) {
    for (const cmp of c._facts.related_companies ?? []) {
      const list = companyToConcepts.get(cmp) ?? [];
      list.push(c.slug);
      companyToConcepts.set(cmp, list);
    }
  }
  for (const [cmp, conceptSlugs] of [...companyToConcepts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const companyPage = pageBySlug.get(cmp) as RichPage | undefined;
    if (!companyPage) continue; // company not in corpus — no display name, no gradeable page
    const displayName = companyPage._facts?.name ?? companyPage.title;
    const grades = new Map<string, number>();
    for (const slug of conceptSlugs) grades.set(slug, 3);
    grades.set(cmp, 1);
    const id = nextId();
    const q: Query = {
      id,
      tier: 'fuzzy',
      text: `frameworks that come up when discussing ${displayName}`,
      expected_output_type: 'cited-source-pages',
      gold: {
        grades: Object.fromEntries(grades),
        relevant: [...conceptSlugs],
      },
      tags: ['company-neighborhood', 'cat-13', 'concept-recall'],
    };
    probes.push({ q, targetSlugs: [...conceptSlugs], template: 'company-neighborhood' });
    gradesByQuery.set(id, grades);
  }

  if (droppedAmbiguous > 0) {
    // Informational: ambiguous texts are dropped BY DESIGN; the assertion
    // below is the guard for anything that slips through a future edit.
    console.error(`[cat13] dropped ${droppedAmbiguous} ambiguous probe candidate(s) claimed by >1 concept`);
  }
  assertUniqueProbeTexts(probes);
  if (probes.length === 0) {
    // A 0-probe build used to print an all-zero scorecard and exit 0
    // (audit retrieval-cats-13). It is a hard error now.
    throw new Error('buildProbes produced 0 probes (no concepts/ pages in the corpus?) — refusing to score an empty run');
  }

  return { probes, gradesByQuery };
}

// ─── Stub embed transport (hermetic runs; mirrors cat26's pattern) ──

const EMBED_DIMS = 1536;

export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS).fill(0);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    vec[h.readUInt32BE(0) % EMBED_DIMS] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

async function hashEmbedTransport(
  params: { values: string[] } & Record<string, unknown>,
): Promise<{ embeddings: number[][]; values: string[]; warnings: unknown[]; usage: { tokens: number } }> {
  return {
    embeddings: params.values.map(v => hashEmbed(v)),
    values: params.values,
    warnings: [],
    usage: { tokens: 0 },
  };
}

let gatewayMode: 'stub' | 'live' | null = null;
export function ensureGateway(stubEmbed: boolean): void {
  const want = stubEmbed ? 'stub' : 'live';
  if (gatewayMode === want) return;
  if (stubEmbed && !process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = 'dummy-embed-transport-stubbed';
  }
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: EMBED_DIMS,
    env: process.env as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests(
    stubEmbed
      ? (hashEmbedTransport as unknown as Parameters<typeof __setEmbedTransportForTests>[0])
      : null,
  );
  gatewayMode = want;
}

// ─── Scorer ───────────────────────────────────────────────────────

export interface AdapterScore {
  name: string;
  ndcg5: number;
  p5_graded: number;   // Mean P@5 against the grade>=1 set (shared metrics.ts denominator)
  p1_strict: number;   // Fraction of queries where rank-1 is in the grade-3 target set
  byTemplate: Record<string, { ndcg: number; count: number }>;
  probesScored: number;
  wallMs: number;
}

export async function scoreAdapter(
  adapter: Adapter,
  pages: Page[],
  probes: Probe[],
  gradesByQuery: Map<string, Map<string, number>>,
  acc: ProbeAccounting,
): Promise<AdapterScore> {
  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name });
  let sumNdcg = 0;
  let sumPGraded = 0;
  let sumP1Strict = 0;
  const byTemplate: Record<string, { ndcg: number; count: number }> = {};

  for (const probe of probes) {
    const probeId = `${adapter.name}:${probe.q.id}`;
    const grades = gradesByQuery.get(probe.q.id)!;
    let ndcg = 0;
    try {
      const results: RankedDoc[] = await adapter.query(sanitizeQuery(probe.q), state);
      const ids = results.map(r => r.page_id);
      const rawNdcg = ndcgAtK(ids, grades, TOP_K);
      ndcg = Number.isNaN(rawNdcg) ? 0 : rawNdcg;
      const relevant = new Set([...grades.entries()].filter(([, g]) => g >= 1).map(([slug]) => slug));
      sumPGraded += precisionAtK(ids, relevant, TOP_K);
      if (ids.length > 0 && probe.targetSlugs.includes(ids[0])) sumP1Strict += 1;
      acc.score(probeId, ndcg);
    } catch (err) {
      // The system under test failed the probe: scored 0 (miss), kept in the
      // denominator (probe-accounting sut policy).
      acc.error(probeId, 'sut', String(err));
      ndcg = 0;
    }
    sumNdcg += ndcg;
    const bucket = byTemplate[probe.template] ?? (byTemplate[probe.template] = { ndcg: 0, count: 0 });
    bucket.ndcg += ndcg;
    bucket.count += 1;
  }

  if (adapter.teardown) await adapter.teardown(state);

  for (const k of Object.keys(byTemplate)) {
    byTemplate[k].ndcg = byTemplate[k].count > 0 ? byTemplate[k].ndcg / byTemplate[k].count : 0;
  }

  return {
    name: adapter.name,
    ndcg5: probes.length > 0 ? sumNdcg / probes.length : 0,
    p5_graded: probes.length > 0 ? sumPGraded / probes.length : 0,
    p1_strict: probes.length > 0 ? sumP1Strict / probes.length : 0,
    byTemplate,
    probesScored: probes.length,
    wallMs: Date.now() - t0,
  };
}

// ─── Runner ───────────────────────────────────────────────────────

export function buildAdapters(): Adapter[] {
  return [
    new GbrainInlineAdapter({ topK: TOP_K }),
    new HybridNoGraphAdapter(),
    new RipgrepBm25Adapter(),
    new VectorOnlyAdapter(),
  ];
}

/**
 * Verdict policy (see header): 'fail' on dead retrieval plumbing (no arm
 * produced results, or the gbrain arm ran and scored an all-zero nDCG@5);
 * 'partial' for hermetic (--stub-embed) or --adapter-subset runs; 'pass'
 * only for a full live standard run.
 */
export function computeCat13Verdict(
  results: ReadonlyArray<Pick<AdapterScore, 'name' | 'ndcg5'>>,
  opts: { stubEmbed: boolean; fullStandardRun: boolean },
): ReceiptVerdict {
  const gbrain = results.find(r => r.name === 'gbrain');
  if (results.length === 0 || (gbrain !== undefined && gbrain.ndcg5 === 0)) return 'fail';
  if (opts.stubEmbed || !opts.fullStandardRun) return 'partial';
  return 'pass';
}

export interface Cat13Options {
  stubEmbed?: boolean;
  only?: string;
  targetProbes?: number;
  allowSkip?: boolean;
  reportsDir?: string;
  quiet?: boolean;
}

export interface Cat13RunResult {
  receipt: Receipt;
  results: AdapterScore[];
  exitCode: number;
}

export async function runCat13(opts: Cat13Options = {}): Promise<Cat13RunResult> {
  const startedAt = new Date().toISOString();
  const stubEmbed = opts.stubEmbed ?? false;
  const reportsDir = opts.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CATEGORY, reportsDir);
  const log = opts.quiet ? (_: string) => {} : (s: string) => console.log(s);

  const baseReceipt = (): Pick<Receipt, 'schema_version' | 'benchmark_version' | 'category' | 'gbrain_version' | 'gbrain_pin' | 'started_at' | 'finished_at'> => ({
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  if (!stubEmbed && !process.env.OPENAI_API_KEY) {
    const reason = 'OPENAI_API_KEY required for live embeds (run with --stub-embed for the hermetic plumbing run)';
    const receipt: Receipt = {
      ...baseReceipt(),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
    };
    writeReceipt(receiptFile, receipt);
    console.error(`[cat13] SKIPPED — ${reason}`);
    return { receipt, results: [], exitCode: opts.allowSkip ? 0 : 2 };
  }

  const targetProbes = opts.targetProbes ?? resolveTargetProbes();
  const corpusDir = join(import.meta.dir, '..', 'data', 'world-v1');
  const pages = loadCorpus(corpusDir);
  const { probes, gradesByQuery } = buildProbes(pages, targetProbes);
  if (probes.length === 0) {
    // Previously a 0-probe build printed an all-zero scorecard and exited 0
    // (audit retrieval-cats-13). Now it is a hard error.
    throw new Error('buildProbes produced 0 probes — refusing to score an empty run');
  }

  ensureGateway(stubEmbed);

  log(`# BrainBench Cat 13 — Conceptual Recall\n`);
  log(`Generated: ${new Date().toISOString().replace(/\..*$/, '')}`);
  log(`Corpus: ${pages.length} pages, ${pages.filter(p => p.slug.startsWith('concepts/')).length} concept pages`);
  log(`Probes: ${probes.length} (target ${targetProbes} per-concept + company pass; CAT13_PROBES env var to override)`);
  log(`Embeds: ${stubEmbed ? 'stubbed deterministic hash (hermetic)' : 'live OpenAI'}`);
  log(`Metric: nDCG@${TOP_K} (graded: target=3, co-occurrence peer=1)\n`);
  log(`## Template breakdown\n`);
  const templateCounts: Record<string, number> = {};
  for (const p of probes) templateCounts[p.template] = (templateCounts[p.template] ?? 0) + 1;
  for (const [t, c] of Object.entries(templateCounts).sort((a, b) => b[1] - a[1])) {
    log(`- ${t}: ${c}`);
  }
  log('');

  const allAdapters = buildAdapters();
  const adapters = opts.only ? allAdapters.filter(a => a.name === opts.only) : allAdapters;
  if (adapters.length === 0) {
    throw new Error(`--adapter ${opts.only} matches none of: ${allAdapters.map(a => a.name).join(', ')}`);
  }

  const acc = new ProbeAccounting(adapters.length * probes.length);

  log(`## Running adapters\n`);
  const results: AdapterScore[] = [];
  for (const a of adapters) {
    log(`- ${a.name} ...`);
    try {
      const r = await scoreAdapter(a, pages, probes, gradesByQuery, acc);
      log(`  done (${(r.wallMs / 1000).toFixed(1)}s). nDCG@5=${(r.ndcg5 * 100).toFixed(1)}%, P@5(graded)=${(r.p5_graded * 100).toFixed(1)}%, P@1(strict)=${(r.p1_strict * 100).toFixed(1)}%`);
      results.push(r);
    } catch (err) {
      // init/teardown failure: the whole arm is gone (missing dependency or
      // harness bug), excluded from means and capped.
      for (const p of probes) acc.error(`${a.name}:${p.q.id}`, 'harness', `adapter init/teardown failed: ${String(err)}`);
      log(`  FAILED to run: ${String(err)}`);
    }
  }

  // Sort by nDCG@5 desc for the scorecard
  results.sort((a, b) => b.ndcg5 - a.ndcg5);

  log(`\n## Scorecard\n`);
  log(`| Adapter | nDCG@5 | P@5 (graded) | P@1 (strict target) | Wall (s) |`);
  log(`|---------|--------|---------------|----------------------|----------|`);
  for (const r of results) {
    log(`| ${r.name.padEnd(16)} | ${(r.ndcg5 * 100).toFixed(1)}% | ${(r.p5_graded * 100).toFixed(1)}% | ${(r.p1_strict * 100).toFixed(1)}% | ${(r.wallMs / 1000).toFixed(1)} |`);
  }

  // Per-template rollup
  const templates = [...new Set(probes.map(p => p.template))];
  log(`\n## Per-template nDCG@5 (where each retrieval style earns its keep)\n`);
  log(`| Template | ${results.map(r => r.name).join(' | ')} | #probes |`);
  log(`|----------|${results.map(() => '--------').join('|')}|---------|`);
  for (const t of templates.sort()) {
    const row = results.map(r => `${((r.byTemplate[t]?.ndcg ?? 0) * 100).toFixed(1)}%`).join(' | ');
    const count = probes.filter(p => p.template === t).length;
    log(`| ${t} | ${row} | ${count} |`);
  }

  log(`\n## Methodology\n`);
  log(`- Corpus: eval/data/world-v1/concepts__*.json (${pages.filter(p => p.slug.startsWith('concepts/')).length} concept pages) + the full world-v1 index.`);
  log(`- Probes: programmatic, seeded (mulberry32 seed=${PROBE_SEED}, Fisher-Yates sampling). Rerun produces the identical set across JS runtimes.`);
  log(`- Probe texts are globally unique: ambiguous candidates (same text claimable by >1 concept) are dropped at generation and the run aborts on any surviving duplicate.`);
  log(`- Graded gold: target concept=3, co-occurrence peers (share >=1 related company/person)=1. Company-neighborhood probes: every concept listing the company=3, the company page=1.`);
  log(`- Template mix: title paraphrase, title variation, description paraphrase, hand-authored synonyms, body-phrase fuzzy recall, semantic neighborhood (self-grounded), company neighborhood (global pass).`);
  log(`- Metric: nDCG@5 (primary, shared eval/runner/metrics.ts). P@5-graded = precision@5 against the grade>=1 set. P@1-strict = rank-1 is in the grade-3 target set.`);
  log(`- Top-K: ${TOP_K}.`);
  log(`- No gold data passed to adapters; PublicPage/PublicQuery sealed at the boundary.`);

  const summary = acc.summary();

  const reportFile = join(reportsDir, CATEGORY, 'report.json');
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify({
    ran_at: startedAt,
    stub_embed: stubEmbed,
    probes: probes.length,
    template_counts: templateCounts,
    results,
    accounting: summary,
  }, null, 2) + '\n');

  const resolvedConfig: Record<string, unknown> = {
    top_k: TOP_K,
    probe_seed: PROBE_SEED,
    target_probes: targetProbes,
    probes_generated: probes.length,
    embedding_transport: stubEmbed ? 'stubbed deterministic hash-embed (__setEmbedTransportForTests)' : 'live openai:text-embedding-3-large',
    adapters_run: results.map(r => r.name),
  };
  const data: Record<string, unknown> = {
    scorecard: results.map(r => ({
      name: r.name,
      ndcg5: r.ndcg5,
      p5_graded: r.p5_graded,
      p1_strict: r.p1_strict,
      wall_ms: r.wallMs,
    })),
    template_counts: templateCounts,
    report_file: reportFile,
  };

  if (summary.run_invalid) {
    const receipt: Receipt = {
      ...baseReceipt(),
      run_status: 'error',
      n_total: summary.n_total,
      n_scored: summary.n_scored,
      completion_rate: summary.completion_rate,
      errors: summary.errors,
      publishable: false,
      resolved_config: resolvedConfig,
      data,
    };
    writeReceipt(receiptFile, receipt);
    console.error(`[cat13] RUN INVALID — infra error rate ${(summary.infra_error_rate * 100).toFixed(1)}% over cap`);
    return { receipt, results, exitCode: 3 };
  }

  const fullStandardRun = !opts.only && results.length === allAdapters.length;
  const verdict = computeCat13Verdict(results, { stubEmbed, fullStandardRun });

  const receipt: Receipt = {
    ...baseReceipt(),
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && !stubEmbed && fullStandardRun,
    resolved_config: resolvedConfig,
    data,
  };
  writeReceipt(receiptFile, receipt);
  log(`\n[cat13] run_status=completed verdict=${verdict} n_scored=${summary.n_scored}/${summary.n_total}`);

  return { receipt, results, exitCode: verdict === 'fail' ? 1 : 0 };
}

// ─── CLI ──────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--adapter');
  const { exitCode } = await runCat13({
    stubEmbed: argv.includes('--stub-embed') || process.env.CAT13_STUB_EMBED === '1',
    only: onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined,
    allowSkip: argv.includes('--allow-skip'),
  });
  return exitCode;
}

if (import.meta.main) {
  main()
    .then(code => process.exit(code)) // explicit: PGLite's WASM runtime pollutes ambient process.exitCode
    .catch(err => {
      console.error(err);
      process.exit(3);
    });
}
