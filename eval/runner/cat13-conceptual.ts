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
 * Probes: ~500-1000 deterministic, template-generated variants per concept.
 * Metric: nDCG@5 (graded gold: target=3, co-occurrence peers=1).
 *
 * Run:
 *   bun eval/runner/cat13-conceptual.ts
 *   CAT13_PROBES=1000 bun eval/runner/cat13-conceptual.ts
 *   CAT13_PROBES=200 bun eval/runner/cat13-conceptual.ts --adapter vector
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { runExtract } from 'gbrain/extract';
import { hybridSearch } from "gbrain/search/hybrid";
import { importFromContent } from "gbrain/import-file";
import type { Adapter, Page, Query, RankedDoc } from './types.ts';
import { sanitizePage, sanitizeQuery } from './types.ts';

const TOP_K = 5;
const TARGET_PROBES = Number(process.env.CAT13_PROBES ?? 500);

// ─── Corpus loader ────────────────────────────────────────────────

interface RichPage extends Page {
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

function loadCorpus(dir: string): RichPage[] {
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

// ─── Seeded RNG (mulberry32) ──────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
const rng = mulberry32(42);
const pick = <T>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

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

interface Probe {
  q: Query;
  targetSlug: string;
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

function buildProbes(pages: RichPage[]): { probes: Probe[]; gradesByQuery: Map<string, Map<string, number>> } {
  const concepts = pages.filter(p => p.slug.startsWith('concepts/'));
  // Co-occurrence graph: concepts that share ≥1 related_company or related_person score 1.
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

  // Probes per concept so total probes ≈ TARGET_PROBES
  const perConcept = Math.max(8, Math.round(TARGET_PROBES / concepts.length));

  for (const c of concepts) {
    const title = c.title;
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

    // F. Semantic neighborhood probes
    const neighbors = [...(coOccur.get(c.slug) ?? [])].slice(0, 3);
    for (const n of neighbors) {
      const np = concepts.find(p => p.slug === n);
      if (np) {
        variants.push({
          text: `concepts related to ${np._facts.name ?? np.title.toLowerCase()}`,
          template: 'semantic-neighborhood',
        });
      }
    }
    // Also seed-by-company if there's a related company
    for (const cmp of (c._facts.related_companies ?? []).slice(0, 2)) {
      variants.push({
        text: `frameworks that come up when discussing ${cmp.split('/')[1]}`,
        template: 'semantic-neighborhood',
      });
    }

    // Dedupe by text
    const seen = new Set<string>();
    const unique = variants.filter(v => {
      const k = v.text.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Cap at perConcept (shuffle-and-slice so mixes represent all templates)
    const shuffled = [...unique].sort(() => rng() - 0.5).slice(0, perConcept);

    // Build the graded gold for this concept.
    // Target = 3, co-occurrence neighbors = 1. Binary-relevant set =
    // grades ≥ 1, for a P@5 secondary metric.
    const grades = new Map<string, number>();
    grades.set(c.slug, 3);
    for (const n of coOccur.get(c.slug) ?? []) grades.set(n, 1);

    for (const v of shuffled) {
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
      probes.push({ q, targetSlug: c.slug, template: v.template });
      gradesByQuery.set(id, grades);
    }
  }

  return { probes, gradesByQuery };
}

// ─── Scorer: nDCG@k on RankedDoc ──────────────────────────────────

function ndcgAtKDocs(docs: RankedDoc[], grades: Map<string, number>, k: number): number {
  if (k <= 0 || docs.length === 0 || grades.size === 0) return 0;
  const top = docs.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const g = grades.get(top[i].page_id) ?? 0;
    dcg += g / Math.log2(i + 2);
  }
  const ideal = [...grades.values()].filter(v => v > 0).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) idcg += ideal[i] / Math.log2(i + 2);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

// ─── gbrain adapter (inline, mirrors multi-adapter.ts) ──────

// ─── Runner ───────────────────────────────────────────────────────

async function scoreAdapter(
  adapter: Adapter,
  pages: Page[],
  probes: Probe[],
  gradesByQuery: Map<string, Map<string, number>>,
): Promise<{
  name: string;
  ndcg5: number;
  p5_graded: number;   // Fraction of top-5 positions filled by grade ≥1 docs
  p1_strict: number;   // Fraction of queries where rank-1 is the target (grade 3)
  byTemplate: Record<string, { ndcg: number; count: number }>;
  wallMs: number;
}> {
  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name });
  let sumNdcg = 0;
  let sumPGraded = 0;
  let sumP1Strict = 0;
  const byTemplate: Record<string, { ndcg: number; count: number }> = {};

  for (const probe of probes) {
    const publicQ = sanitizeQuery(probe.q);
    const results = await adapter.query(publicQ as unknown as Query, state);
    const grades = gradesByQuery.get(probe.q.id)!;
    const ndcg = ndcgAtKDocs(results, grades, TOP_K);
    sumNdcg += ndcg;

    const topK = results.slice(0, TOP_K);
    let hits = 0;
    for (const r of topK) if ((grades.get(r.page_id) ?? 0) >= 1) hits++;
    sumPGraded += hits / TOP_K;

    if (results.length > 0 && results[0].page_id === probe.targetSlug) sumP1Strict += 1;

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
    wallMs: Date.now() - t0,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--adapter');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  const corpusDir = join(import.meta.dir, '..', 'data', 'world-v1');
  const pages = loadCorpus(corpusDir);
  const { probes, gradesByQuery } = buildProbes(pages);

  console.log(`# BrainBench Cat 13 — Conceptual Recall\n`);
  console.log(`Generated: ${new Date().toISOString().replace(/\..*$/, '')}`);
  console.log(`Corpus: ${pages.length} pages, ${pages.filter(p => p.slug.startsWith('concepts/')).length} concept pages`);
  console.log(`Probes: ${probes.length} (target ${TARGET_PROBES}, CAT13_PROBES env var to override)`);
  console.log(`Metric: nDCG@${TOP_K} (graded: target=3, co-occurrence peer=1)\n`);
  console.log(`## Template breakdown\n`);
  const templateCounts: Record<string, number> = {};
  for (const p of probes) templateCounts[p.template] = (templateCounts[p.template] ?? 0) + 1;
  for (const [t, c] of Object.entries(templateCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`- ${t}: ${c}`);
  }
  console.log('');

  const allAdapters: Adapter[] = [
    new GbrainInlineAdapter({ topK: TOP_K }),
    new HybridNoGraphAdapter(),
    new RipgrepBm25Adapter(),
    new VectorOnlyAdapter(),
  ];
  const adapters = only ? allAdapters.filter(a => a.name === only) : allAdapters;

  console.log(`## Running adapters\n`);
  const results = [];
  for (const a of adapters) {
    process.stdout.write(`- ${a.name} ...\n`);
    const r = await scoreAdapter(a, pages, probes, gradesByQuery);
    console.log(`  done (${(r.wallMs / 1000).toFixed(1)}s). nDCG@5=${(r.ndcg5 * 100).toFixed(1)}%, P@5(graded)=${(r.p5_graded * 100).toFixed(1)}%, P@1(strict)=${(r.p1_strict * 100).toFixed(1)}%`);
    results.push(r);
  }

  // Sort by nDCG@5 desc for the scorecard
  results.sort((a, b) => b.ndcg5 - a.ndcg5);

  console.log(`\n## Scorecard\n`);
  console.log(`| Adapter | nDCG@5 | P@5 (graded) | P@1 (strict target) | Wall (s) |`);
  console.log(`|---------|--------|---------------|----------------------|----------|`);
  for (const r of results) {
    console.log(`| ${r.name.padEnd(16)} | ${(r.ndcg5 * 100).toFixed(1)}% | ${(r.p5_graded * 100).toFixed(1)}% | ${(r.p1_strict * 100).toFixed(1)}% | ${(r.wallMs / 1000).toFixed(1)} |`);
  }

  // Per-template rollup
  const templates = [...new Set(probes.map(p => p.template))];
  console.log(`\n## Per-template nDCG@5 (where each retrieval style earns its keep)\n`);
  console.log(`| Template | ${results.map(r => r.name).join(' | ')} | #probes |`);
  console.log(`|----------|${results.map(() => '--------').join('|')}|---------|`);
  for (const t of templates.sort()) {
    const row = results.map(r => `${((r.byTemplate[t]?.ndcg ?? 0) * 100).toFixed(1)}%`).join(' | ');
    const count = probes.filter(p => p.template === t).length;
    console.log(`| ${t} | ${row} | ${count} |`);
  }

  console.log(`\n## Methodology\n`);
  console.log(`- Corpus: eval/data/world-v1/concepts__*.json (30 concept pages).`);
  console.log(`- Probes: programmatic, seeded (mulberry32 seed=42). Rerun produces identical set.`);
  console.log(`- Graded gold: target concept=3, co-occurrence peers (share ≥1 related company/person)=1.`);
  console.log(`- Template mix: title paraphrase, title variation, description paraphrase, hand-authored synonyms, body-phrase fuzzy recall, semantic neighborhood (co-occurrence seeded).`);
  console.log(`- Metric: nDCG@5 (primary). P@5-graded = fraction of top-5 positions filled by grade ≥1 docs. P@1-strict = rank-1 is the strict target concept.`);
  console.log(`- Top-K: ${TOP_K}.`);
  console.log(`- No gold data passed to adapters; PublicPage/PublicQuery sealed at the boundary.`);
}

main().catch(e => { console.error(e); process.exit(1); });
