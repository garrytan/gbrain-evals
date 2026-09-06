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
 * Phase E0 (ranker wave) additions — see README-cat13-phase-e0.md:
 *   - The embedder is configurable (CAT13_EMBEDDING_MODEL / CAT13_EMBED_DIMS,
 *     or --embedding-model / --embedding-dims) and is applied to EVERY
 *     adapter's gateway config, so all arms share one embedding space. The
 *     receipt records the resolved embedder and the gateway state each
 *     adapter actually embedded with.
 *   - gbrain-backed adapters never run an unpinned default: search.mode,
 *     search.reranker.enabled and search.autocut are set explicitly
 *     (--reranker on|off, --autocut on|off, both default off) and echoed per
 *     adapter into the receipt.
 *   - A seeded concept split (--tuning-concepts / --holdout-concepts, default
 *     20/10 over the 30 concepts, --seed default 42) reports every metric for
 *     the tuning and held-out concept sets separately. The probe generator
 *     is untouched; the split only partitions the scoring.
 *
 * Phase E2 (arm-confidence floor) — see README-cat13-phase-e0.md "Phase E2":
 *   - `--keyword-arm-confidence-floor <f|off>` pins
 *     `search.keyword_arm_confidence_floor` on the gbrain-backed adapters
 *     (only written when given; echoed in the receipt). The adapters count
 *     per-query `keyword_arm_confidence` meta (stamped / down-weighted) into
 *     `observed_by_adapter`; a numeric floor with zero stamped queries is a
 *     harness error on every probe (`kacf_missing_meta`) — the knob did not
 *     fire, so the cell must not publish under a "floor on" label. The floor
 *     itself comes from eval/runner/cat13-kacf-calibrate.ts (tuning split).
 *
 * Generic knob pins (Phase E3 and any later knob A/B):
 *   - `--search-pin <search.key>=<value>` (repeatable) adds an arbitrary
 *     `search.*` config entry to the SAME pin set (engine.setConfig before
 *     ingest on the gbrain-backed adapters; echoed in `search_pins` and per
 *     adapter in `search_config_by_adapter`, plus `pins.extra_search_pins`).
 *     Validated at parse: the key must start with `search.` and name a knob,
 *     the value must be non-empty, and keys owned by a dedicated flag
 *     (search.mode, search.reranker.*, search.autocut,
 *     search.expansion_variant_budget, search.keyword_arm_confidence_floor)
 *     are refused so the fail-closed checks behind those flags cannot be
 *     bypassed. Repeating a key: last wins. Pure pass-through beyond that —
 *     gbrain ignores unknown `search.*` keys SILENTLY (no kacf-style
 *     fail-closed proof), so a misspelled key runs the default cell under
 *     the pinned label; check the linked gbrain's config surface before
 *     reading a --search-pin arm.
 *
 * Run:
 *   bun eval/runner/cat13-conceptual.ts                  # live embeds (OPENAI_API_KEY)
 *   bun eval/runner/cat13-conceptual.ts --stub-embed     # hermetic, no keys
 *   CAT13_PROBES=1000 bun eval/runner/cat13-conceptual.ts
 *   CAT13_PROBES=200 bun eval/runner/cat13-conceptual.ts --adapter vector
 *   CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 \
 *     bun eval/runner/cat13-conceptual.ts --reranker off --autocut off
 *   CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 \
 *     bun eval/runner/cat13-conceptual.ts --reranker off --autocut off --keyword-arm-confidence-floor 0.65
 *   CAT13_EMBEDDING_MODEL=voyage:voyage-4 CAT13_EMBED_DIMS=1024 \
 *     bun eval/runner/cat13-conceptual.ts --reranker off --autocut off --search-pin search.metadata_boost_gate=lexical
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import {
  configureGateway, __setEmbedTransportForTests, getEmbeddingModel, getEmbeddingDimensions,
} from 'gbrain/ai/gateway';
import { RipgrepBm25Adapter } from './adapters/grep-only.ts';
import { VectorOnlyAdapter } from './adapters/vector.ts';
import { HybridNoGraphAdapter } from './adapters/vector-grep-rrf-fusion.ts';
import { GbrainInlineAdapter } from './adapters/gbrain-inline.ts';
import type { EvalAdapterConfig } from './eval-adapter-config.ts';
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

// ─── Embedder (Phase E0: one embedding space for every adapter) ───

/** The historical Cat 13 space (2026-04-23 report). Overridable, never silently swapped. */
export const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
export const DEFAULT_EMBED_DIMS = 1536;

export interface EmbedderConfig {
  /** `provider:model`, handed to configureGateway({ embedding_model }). */
  model: string;
  /** Vector width, handed to configureGateway({ embedding_dimensions }) and used by the hash-embed stub. */
  dims: number;
}

/**
 * Precedence: explicit override (CLI flag) → CAT13_EMBEDDING_MODEL /
 * CAT13_EMBED_DIMS env → the historical OpenAI defaults. Malformed values
 * throw (same posture as the CAT13_PROBES guard) instead of falling back to
 * a default the receipt would then misreport.
 */
export function resolveEmbedder(
  overrides: { model?: string; dims?: string | number } = {},
  env: Record<string, string | undefined> = process.env,
): EmbedderConfig {
  const rawModel = overrides.model ?? env.CAT13_EMBEDDING_MODEL;
  const model = rawModel === undefined || rawModel.trim() === '' ? DEFAULT_EMBEDDING_MODEL : rawModel.trim();
  if (!/^[A-Za-z0-9_-]+:\S+$/.test(model)) {
    throw new Error(`CAT13_EMBEDDING_MODEL / --embedding-model must be 'provider:model', got '${model}'`);
  }
  const rawDims = overrides.dims ?? env.CAT13_EMBED_DIMS;
  let dims = DEFAULT_EMBED_DIMS;
  if (rawDims !== undefined && String(rawDims).trim() !== '') {
    const n = Number(rawDims);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`CAT13_EMBED_DIMS / --embedding-dims must be a positive integer, got '${rawDims}'`);
    }
    dims = n;
  }
  return { model, dims };
}

const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  zeroentropyai: 'ZEROENTROPY_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

/** The env var a `provider:model` id needs a key in (live runs preflight it; stub runs set a dummy). */
export function providerKeyEnv(model: string): string {
  const provider = model.split(':')[0].toLowerCase();
  return PROVIDER_KEY_ENV[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

// ─── Stub embed transport (hermetic runs; mirrors cat26's pattern) ──

export function hashEmbed(text: string, dims: number = DEFAULT_EMBED_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2));
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    vec[h.readUInt32BE(0) % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map(x => x / norm);
}

function makeHashEmbedTransport(dims: number) {
  return async (
    params: { values: string[] } & Record<string, unknown>,
  ): Promise<{ embeddings: number[][]; values: string[]; warnings: unknown[]; usage: { tokens: number } }> => ({
    embeddings: params.values.map(v => hashEmbed(v, dims)),
    values: params.values,
    warnings: [],
    usage: { tokens: 0 },
  });
}

let gatewayKey: string | null = null;
/**
 * Configure gbrain's process-global gateway for this run's embedder. Keyed on
 * (transport, model, dims) so a second call with a different embedder in the
 * same process (tests) reconfigures instead of being skipped.
 */
export function ensureGateway(stubEmbed: boolean, embedder: EmbedderConfig = resolveEmbedder()): void {
  const want = `${stubEmbed ? 'stub' : 'live'}|${embedder.model}|${embedder.dims}`;
  if (gatewayKey === want) return;
  if (stubEmbed) {
    const keyEnv = providerKeyEnv(embedder.model);
    if (!process.env[keyEnv]) process.env[keyEnv] = 'dummy-embed-transport-stubbed';
  }
  configureGateway({
    embedding_model: embedder.model,
    embedding_dimensions: embedder.dims,
    env: process.env as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests(
    stubEmbed
      ? (makeHashEmbedTransport(embedder.dims) as unknown as Parameters<typeof __setEmbedTransportForTests>[0])
      : null,
  );
  gatewayKey = want;
}

// ─── Search pins (Phase E0: no gbrain-backed cell runs an unpinned default) ──

export type OnOff = 'on' | 'off';

export interface Cat13Pins {
  reranker: OnOff;
  autocut: OnOff;
  /** Pass-through string for `search.expansion_variant_budget`; only set when given. */
  expansionVariantBudget?: string;
  /**
   * Phase E2: `search.keyword_arm_confidence_floor` — `'off'` or a number in
   * (0, 1] as a string (validated by parseKeywordArmConfidenceFloor); only
   * set when given, for the same reason as the budget.
   */
  keywordArmConfidenceFloor?: string;
  /**
   * Generic `--search-pin <search.key>=<value>` entries, applied after the
   * named pins (validated by validateSearchPin; a key owned by a dedicated
   * flag is refused). Pass-through only: gbrain ignores unknown keys silently.
   */
  searchPins?: Record<string, string>;
}

/** Every gbrain-backed arm runs the `balanced` bundle with the two toggles pinned explicitly. */
export const CAT13_SEARCH_MODE = 'balanced';
/**
 * The cross-encoder pinned for `--reranker on` — gbrain's mode-bundle default
 * since v0.48.2.0. Pinned by name so the receipt names the model and the
 * fail-closed key preflight checks the matching provider key.
 */
export const CAT13_RERANK_MODEL_PIN = 'voyage:rerank-2.5';

export function parseOnOff(raw: string | undefined, flag: string, fallback: OnOff = 'off'): OnOff {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'off') return v;
  throw new Error(`${flag} must be 'on' or 'off', got '${raw}'`);
}

/**
 * Phase E2: `--keyword-arm-confidence-floor <f|off>`. Mirrors gbrain's ONE
 * range contract for the knob (`normalizeKeywordArmConfidenceFloor`: finite
 * in (0, 1], or off) but FAILS on anything else instead of falling through to
 * the bundle default — a typo must not silently run the floor-off cell under
 * a "floor on" label. Returns the string written to config: `'off'` or the
 * numeric text exactly as given (trimmed), so the receipt echoes the input.
 */
export function parseKeywordArmConfidenceFloor(raw: string, flag = '--keyword-arm-confidence-floor'): string {
  const v = raw.trim();
  if (v.toLowerCase() === 'off') return 'off';
  const n = v === '' ? Number.NaN : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`${flag} must be 'off' or a number in (0, 1], got '${raw}'`);
  }
  return v;
}

/**
 * `search.*` keys a dedicated flag owns. `--search-pin` refuses them so the
 * fail-closed checks behind those flags (the reranker key preflight,
 * `kacf_missing_meta`, the strict on|off / range parsers) cannot be bypassed
 * by spelling the same key generically. Value = the flag to use instead.
 */
export const RESERVED_SEARCH_PIN_KEYS: Readonly<Record<string, string>> = {
  'search.mode': `the runner (fixed at ${CAT13_SEARCH_MODE})`,
  'search.reranker.enabled': '--reranker on|off',
  'search.reranker.model': '--reranker on',
  'search.autocut': '--autocut on|off',
  'search.expansion_variant_budget': '--expansion-variant-budget <b>',
  'search.keyword_arm_confidence_floor': '--keyword-arm-confidence-floor <f|off>',
};

/**
 * Validate one generic pin: key is `search.<knob>` and value is non-empty
 * (both trimmed), key not owned by a dedicated flag. Returns the trimmed pair.
 * Nothing beyond that is checked — gbrain ignores unknown `search.*` keys
 * silently, so the runner cannot prove the key exists; the receipt echoes
 * exactly what was written and the reader verifies the key against the
 * linked gbrain.
 */
export function validateSearchPin(key: string, value: string, flag = '--search-pin'): [string, string] {
  const k = key.trim();
  const v = value.trim();
  if (!k.startsWith('search.') || k.length <= 'search.'.length) {
    throw new Error(`${flag} key must start with 'search.' and name a knob, got '${key}'`);
  }
  if (v === '') throw new Error(`${flag} ${k} requires a non-empty value`);
  const owner = RESERVED_SEARCH_PIN_KEYS[k];
  if (owner !== undefined) {
    throw new Error(`${flag} refuses '${k}': it is owned by ${owner} (the dedicated flag keeps its fail-closed check)`);
  }
  return [k, v];
}

/**
 * `--search-pin <search.key>=<value>` → validated `[key, value]`. Splits on
 * the FIRST '=' so values may themselves contain '='.
 */
export function parseSearchPin(raw: string, flag = '--search-pin'): [string, string] {
  const eq = raw.indexOf('=');
  if (eq < 0) throw new Error(`${flag} expects <search.key>=<value>, got '${raw}'`);
  return validateSearchPin(raw.slice(0, eq), raw.slice(eq + 1), flag);
}

/**
 * The engine.setConfig entries applied to every gbrain-backed adapter before
 * ingest. `search.expansion_variant_budget` is only set when the flag was
 * given: gbrain pins that predate the knob ignore unknown keys silently, so
 * an always-present entry would be an unverifiable echo. Generic
 * `--search-pin` entries are appended last (re-validated here so a
 * programmatic caller gets the same refusals as the CLI).
 */
export function pinnedSearchConfig(pins: Cat13Pins): Record<string, string> {
  const cfg: Record<string, string> = {
    'search.mode': CAT13_SEARCH_MODE,
    'search.reranker.enabled': pins.reranker === 'on' ? 'true' : 'false',
    'search.autocut': pins.autocut === 'on' ? 'true' : 'false',
  };
  if (pins.reranker === 'on') cfg['search.reranker.model'] = CAT13_RERANK_MODEL_PIN;
  if (pins.expansionVariantBudget !== undefined) {
    const b = pins.expansionVariantBudget.trim();
    if (b === '') throw new Error('--expansion-variant-budget requires a non-empty value');
    cfg['search.expansion_variant_budget'] = b;
  }
  if (pins.keywordArmConfidenceFloor !== undefined) {
    cfg['search.keyword_arm_confidence_floor'] = parseKeywordArmConfidenceFloor(pins.keywordArmConfidenceFloor);
  }
  for (const [key, value] of Object.entries(pins.searchPins ?? {})) {
    const [k, v] = validateSearchPin(key, value);
    cfg[k] = v;
  }
  return cfg;
}

// ─── Seeded concept split (Phase E0: tuning vs held-out decision set) ──

export interface ConceptSplit {
  seed: number;
  tuning: string[];
  holdout: string[];
}

/**
 * Seeded Fisher-Yates over the SORTED concept slugs (input order cannot
 * perturb the split), then the first N are tuning and the next M held out.
 * Uses its own rng — the probe generator's stream is untouched.
 */
export function splitConcepts(
  conceptSlugs: readonly string[],
  tuningN: number,
  holdoutN: number,
  seed: number,
): ConceptSplit {
  for (const [name, n] of [['--tuning-concepts', tuningN], ['--holdout-concepts', holdoutN]] as const) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got '${n}'`);
  }
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`--seed must be a non-negative integer, got '${seed}'`);
  const sorted = [...new Set(conceptSlugs)].sort();
  if (tuningN + holdoutN > sorted.length) {
    throw new Error(`--tuning-concepts + --holdout-concepts (${tuningN} + ${holdoutN}) exceeds the ${sorted.length} concept pages`);
  }
  const shuffled = seededShuffle(sorted, mulberry32(seed));
  return {
    seed,
    tuning: shuffled.slice(0, tuningN).sort(),
    holdout: shuffled.slice(tuningN, tuningN + holdoutN).sort(),
  };
}

export type ProbeSubset = 'tuning' | 'holdout' | 'mixed' | 'unassigned';

/**
 * A probe belongs to a subset only when EVERY grade-3 target is in it —
 * company-neighborhood probes can name several concepts. A probe whose
 * targets straddle sets (or a set and the unsplit remainder) is `mixed`:
 * counted, excluded from both subsets, so the held-out numbers never
 * include a probe whose gold touches a tuning concept.
 */
export function probeSubset(probe: Pick<Probe, 'targetSlugs'>, split: ConceptSplit): ProbeSubset {
  const t = new Set(split.tuning);
  const h = new Set(split.holdout);
  const targets = probe.targetSlugs;
  if (targets.length > 0 && targets.every(s => t.has(s))) return 'tuning';
  if (targets.length > 0 && targets.every(s => h.has(s))) return 'holdout';
  if (targets.some(s => t.has(s) || h.has(s))) return 'mixed';
  return 'unassigned';
}

// ─── Scorer ───────────────────────────────────────────────────────

/** Metrics over one probe subset (overall, tuning or held-out). */
export interface SubsetScore {
  ndcg5: number;
  p5_graded: number;   // Mean P@5 against the grade>=1 set (shared metrics.ts denominator)
  p1_strict: number;   // Fraction of queries where rank-1 is in the grade-3 target set
  count: number;
  byTemplate: Record<string, { ndcg: number; count: number }>;
}

/** What a gbrain-backed adapter observed while answering (see GbrainInlineAdapter.observedStats). */
export interface ObservedStats {
  queries: number;
  rerank_scored_queries: number;
  /** Phase E2: queries whose hybridSearch meta carried `keyword_arm_confidence` (the fused path ran). */
  keyword_arm_confidence_stamped?: number;
  /** Phase E2: queries where the keyword + title lists fused at half weight (`downweighted: true`). */
  keyword_arm_confidence_downweighted?: number;
}

export interface AdapterScore {
  name: string;
  ndcg5: number;
  p5_graded: number;   // Mean P@5 against the grade>=1 set (shared metrics.ts denominator)
  p1_strict: number;   // Fraction of queries where rank-1 is in the grade-3 target set
  byTemplate: Record<string, { ndcg: number; count: number }>;
  probesScored: number;
  wallMs: number;
  /** Tuning / held-out rollups when a ConceptSplit was supplied. */
  splits?: {
    seed: number;
    tuning: SubsetScore;
    holdout: SubsetScore;
    /** Probes whose targets straddle sets — counted, scored in neither subset. */
    mixed: number;
    /** Probes whose targets fall outside both sets (only when tuning+holdout < concept count). */
    unassigned: number;
  };
  /** engine.setConfig entries the adapter applied at init (gbrain-backed adapters only). */
  resolvedConfig?: Record<string, string>;
  /** gbrain's live gateway embedder right after this adapter's init() — proves every arm shares one space. */
  gatewayAfterInit?: { model: string; dims: number };
  observed?: ObservedStats;
}

interface Accum {
  ndcg: number;
  p5: number;
  p1: number;
  count: number;
  byTemplate: Record<string, { ndcg: number; count: number }>;
}

function newAccum(): Accum {
  return { ndcg: 0, p5: 0, p1: 0, count: 0, byTemplate: {} };
}

function addToAccum(a: Accum, template: string, ndcg: number, p5: number, p1: number): void {
  a.ndcg += ndcg;
  a.p5 += p5;
  a.p1 += p1;
  a.count += 1;
  const bucket = a.byTemplate[template] ?? (a.byTemplate[template] = { ndcg: 0, count: 0 });
  bucket.ndcg += ndcg;
  bucket.count += 1;
}

function finalizeAccum(a: Accum): SubsetScore {
  const byTemplate: Record<string, { ndcg: number; count: number }> = {};
  for (const [k, b] of Object.entries(a.byTemplate)) {
    byTemplate[k] = { ndcg: b.count > 0 ? b.ndcg / b.count : 0, count: b.count };
  }
  return {
    ndcg5: a.count > 0 ? a.ndcg / a.count : 0,
    p5_graded: a.count > 0 ? a.p5 / a.count : 0,
    p1_strict: a.count > 0 ? a.p1 / a.count : 0,
    count: a.count,
    byTemplate,
  };
}

export interface ScoreAdapterOptions {
  /** Extra AdapterConfig fields merged into init() (e.g. `shootout`, `searchConfig`). */
  initConfig?: Record<string, unknown>;
  /** When supplied, tuning / held-out rollups are computed alongside the overall numbers. */
  split?: ConceptSplit;
}

/** Duck-typed optional adapter hooks (GbrainInlineAdapter / HybridNoGraphAdapter expose them). */
interface EchoingAdapter {
  resolvedConfig?: (state: unknown) => Record<string, string>;
  observedStats?: (state: unknown) => ObservedStats;
}

export async function scoreAdapter(
  adapter: Adapter,
  pages: Page[],
  probes: Probe[],
  gradesByQuery: Map<string, Map<string, number>>,
  acc: ProbeAccounting,
  opts: ScoreAdapterOptions = {},
): Promise<AdapterScore> {
  const t0 = Date.now();
  const publicPages = pages.map(sanitizePage);
  const state = await adapter.init(publicPages, { name: adapter.name, ...(opts.initConfig ?? {}) });

  // Read the gateway AFTER init: adapters that call configureGateway themselves
  // (vector, vector-grep-rrf-fusion) must land on the run's embedder, and the
  // receipt should show it rather than assume it.
  let gatewayAfterInit: AdapterScore['gatewayAfterInit'];
  try {
    gatewayAfterInit = { model: getEmbeddingModel(), dims: getEmbeddingDimensions() };
  } catch {
    gatewayAfterInit = undefined; // gateway unconfigured (pure unit tests) — nothing to echo
  }

  const overall = newAccum();
  const tuning = newAccum();
  const holdout = newAccum();
  let mixed = 0;
  let unassigned = 0;

  for (const probe of probes) {
    const probeId = `${adapter.name}:${probe.q.id}`;
    const grades = gradesByQuery.get(probe.q.id)!;
    let ndcg = 0;
    let p5 = 0;
    let p1 = 0;
    try {
      const results: RankedDoc[] = await adapter.query(sanitizeQuery(probe.q), state);
      const ids = results.map(r => r.page_id);
      const rawNdcg = ndcgAtK(ids, grades, TOP_K);
      ndcg = Number.isNaN(rawNdcg) ? 0 : rawNdcg;
      const relevant = new Set([...grades.entries()].filter(([, g]) => g >= 1).map(([slug]) => slug));
      p5 = precisionAtK(ids, relevant, TOP_K);
      if (ids.length > 0 && probe.targetSlugs.includes(ids[0])) p1 = 1;
      acc.score(probeId, ndcg);
    } catch (err) {
      // The system under test failed the probe: scored 0 (miss), kept in the
      // denominator (probe-accounting sut policy).
      acc.error(probeId, 'sut', String(err));
      ndcg = 0;
      p5 = 0;
      p1 = 0;
    }
    addToAccum(overall, probe.template, ndcg, p5, p1);
    if (opts.split) {
      switch (probeSubset(probe, opts.split)) {
        case 'tuning': addToAccum(tuning, probe.template, ndcg, p5, p1); break;
        case 'holdout': addToAccum(holdout, probe.template, ndcg, p5, p1); break;
        case 'mixed': mixed += 1; break;
        case 'unassigned': unassigned += 1; break;
      }
    }
  }

  const hooks = adapter as unknown as EchoingAdapter;
  const resolvedConfig = typeof hooks.resolvedConfig === 'function' ? hooks.resolvedConfig(state) : undefined;
  const observed = typeof hooks.observedStats === 'function' ? hooks.observedStats(state) : undefined;

  if (adapter.teardown) await adapter.teardown(state);

  const all = finalizeAccum(overall);
  return {
    name: adapter.name,
    ndcg5: all.ndcg5,
    p5_graded: all.p5_graded,
    p1_strict: all.p1_strict,
    byTemplate: all.byTemplate,
    probesScored: probes.length,
    wallMs: Date.now() - t0,
    ...(opts.split ? {
      splits: {
        seed: opts.split.seed,
        tuning: finalizeAccum(tuning),
        holdout: finalizeAccum(holdout),
        mixed,
        unassigned,
      },
    } : {}),
    ...(resolvedConfig ? { resolvedConfig } : {}),
    ...(gatewayAfterInit ? { gatewayAfterInit } : {}),
    ...(observed ? { observed } : {}),
  };
}

// ─── Runner ───────────────────────────────────────────────────────

/** An adapter plus the init-time config that puts it on this run's embedder + pins. */
export interface AdapterPlan {
  adapter: Adapter;
  initConfig: Record<string, unknown>;
}

/**
 * Every adapter that embeds gets the SAME embedder (vector and
 * vector-grep-rrf-fusion call configureGateway themselves at init, so without
 * the `shootout` sidecar they would silently reset the gateway to the OpenAI
 * default mid-run — the exact confound behind the unreproducible voyage-space
 * receipt). Both gbrain-backed arms get the same search pins.
 */
export function buildAdapters(run: { embedder: EmbedderConfig; searchConfig: Record<string, string> }): AdapterPlan[] {
  const shootout: EvalAdapterConfig = {
    embedder: run.embedder.model,
    dim: run.embedder.dims,
    searchMode: CAT13_SEARCH_MODE,
  };
  return [
    {
      adapter: new GbrainInlineAdapter({
        topK: TOP_K,
        searchConfig: run.searchConfig,
        embeddingModel: run.embedder.model,
        embeddingDimensions: run.embedder.dims,
      }),
      initConfig: {},
    },
    { adapter: new HybridNoGraphAdapter(), initConfig: { shootout, searchConfig: run.searchConfig } },
    { adapter: new RipgrepBm25Adapter(), initConfig: {} },
    { adapter: new VectorOnlyAdapter(), initConfig: { shootout } },
  ];
}

/** Adapters whose retrieval runs through gbrain's hybridSearch (the pins apply to these). */
export const GBRAIN_BACKED_ADAPTERS: ReadonlySet<string> = new Set(['gbrain', 'vector-grep-rrf-fusion']);

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
  /** `provider:model`; overrides CAT13_EMBEDDING_MODEL (default openai:text-embedding-3-large). */
  embeddingModel?: string;
  /** Vector width; overrides CAT13_EMBED_DIMS (default 1536). */
  embeddingDims?: string | number;
  /** search.reranker.enabled pin for gbrain-backed adapters (default off). */
  reranker?: OnOff;
  /** search.autocut pin for gbrain-backed adapters (default off). */
  autocut?: OnOff;
  /** search.expansion_variant_budget pass-through; only set when given. */
  expansionVariantBudget?: string;
  /** Phase E2: search.keyword_arm_confidence_floor — 'off' or a number in (0, 1]; only set when given. */
  keywordArmConfidenceFloor?: string;
  /**
   * Generic `--search-pin <search.key>=<value>` entries (validated; a repeated
   * key → last wins). Pass-through: gbrain ignores unknown keys silently.
   */
  searchPins?: Record<string, string>;
  /** Concept split sizes (default 20 / 10 over the 30 concepts) and seed (default PROBE_SEED). */
  tuningConcepts?: number;
  holdoutConcepts?: number;
  seed?: number;
}

export const DEFAULT_TUNING_CONCEPTS = 20;
export const DEFAULT_HOLDOUT_CONCEPTS = 10;

function parseNonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got '${raw}'`);
  return n;
}

/**
 * CLI → Cat13Options. Pure (env is injected) so it is unit-testable. Unknown
 * `--flags` throw: a typo like `--rerankr on` must not silently run the
 * default cell under the intended label.
 */
export function parseCat13Argv(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Cat13Options {
  const opts: Cat13Options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      i += 1;
      return v;
    };
    switch (flag) {
      case '--stub-embed': opts.stubEmbed = true; break;
      case '--allow-skip': opts.allowSkip = true; break;
      case '--adapter': opts.only = value(); break;
      case '--embedding-model': opts.embeddingModel = value(); break;
      case '--embedding-dims': opts.embeddingDims = value(); break;
      case '--reranker': opts.reranker = parseOnOff(value(), '--reranker'); break;
      case '--autocut': opts.autocut = parseOnOff(value(), '--autocut'); break;
      case '--expansion-variant-budget': opts.expansionVariantBudget = value(); break;
      case '--keyword-arm-confidence-floor': opts.keywordArmConfidenceFloor = parseKeywordArmConfidenceFloor(value()); break;
      case '--search-pin': {
        const [k, v] = parseSearchPin(value());
        opts.searchPins = { ...(opts.searchPins ?? {}), [k]: v };
        break;
      }
      case '--tuning-concepts': opts.tuningConcepts = parseNonNegativeInt(value(), '--tuning-concepts'); break;
      case '--holdout-concepts': opts.holdoutConcepts = parseNonNegativeInt(value(), '--holdout-concepts'); break;
      case '--seed': opts.seed = parseNonNegativeInt(value(), '--seed'); break;
      default:
        throw new Error(
          `unknown argument '${arg}'. Known: --stub-embed --allow-skip --adapter <name> `
          + `--embedding-model <provider:model> --embedding-dims <N> --reranker on|off --autocut on|off `
          + `--expansion-variant-budget <b> --keyword-arm-confidence-floor <f|off> `
          + `--search-pin <search.key>=<value> (repeatable; generic pass-through — gbrain ignores unknown search.* keys silently) `
          + `--tuning-concepts <N> --holdout-concepts <M> --seed <N>`,
        );
    }
  }
  if (env.CAT13_STUB_EMBED === '1') opts.stubEmbed = true;
  return opts;
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

  // Resolve the cell BEFORE any key check or embed: a malformed embedder or
  // pin throws here, never lands in a receipt under a default label.
  const embedder = resolveEmbedder({ model: opts.embeddingModel, dims: opts.embeddingDims });
  const pins: Cat13Pins = {
    reranker: opts.reranker ?? 'off',
    autocut: opts.autocut ?? 'off',
    ...(opts.expansionVariantBudget !== undefined ? { expansionVariantBudget: opts.expansionVariantBudget } : {}),
    ...(opts.keywordArmConfidenceFloor !== undefined ? { keywordArmConfidenceFloor: opts.keywordArmConfidenceFloor } : {}),
    ...(opts.searchPins !== undefined ? { searchPins: opts.searchPins } : {}),
  };
  const searchConfig = pinnedSearchConfig(pins);
  // Generic --search-pin entries as written (trimmed), for the receipt's pins block.
  const extraPins: Record<string, string> = Object.fromEntries(
    Object.entries(pins.searchPins ?? {}).map(([k, v]) => validateSearchPin(k, v)),
  );
  // Phase E2: a numeric floor must be PROVEN to have reached the engine (see the kacf_missing_meta check below).
  const floorPin = searchConfig['search.keyword_arm_confidence_floor'];
  const floorIsNumeric = floorPin !== undefined && floorPin !== 'off';
  const tuningN = opts.tuningConcepts ?? DEFAULT_TUNING_CONCEPTS;
  const holdoutN = opts.holdoutConcepts ?? DEFAULT_HOLDOUT_CONCEPTS;
  const splitSeed = opts.seed ?? PROBE_SEED;

  const cellConfig = (): Record<string, unknown> => ({
    embedder: { model: embedder.model, dims: embedder.dims },
    pins: {
      reranker: pins.reranker,
      autocut: pins.autocut,
      expansion_variant_budget: pins.expansionVariantBudget ?? null,
      keyword_arm_confidence_floor: searchConfig['search.keyword_arm_confidence_floor'] ?? null,
      extra_search_pins: Object.keys(extraPins).length > 0 ? extraPins : null,
    },
    search_pins: searchConfig,
  });

  const skipped = (reason: string): Cat13RunResult => {
    const receipt: Receipt = {
      ...baseReceipt(),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: 0,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      resolved_config: cellConfig(),
    };
    writeReceipt(receiptFile, receipt);
    console.error(`[cat13] SKIPPED — ${reason}`);
    return { receipt, results: [], exitCode: opts.allowSkip ? 0 : 2 };
  };

  // Fail-closed reranker preflight. gbrain's reranker is fail-open (no key →
  // plain hybrid, no error), so a "reranker on" cell must prove it CAN rerank
  // before question 1: the stub transport never reaches the cross-encoder, and
  // a live run needs the pinned model's provider key.
  if (pins.reranker === 'on') {
    if (stubEmbed) {
      throw new Error(
        `--reranker on cannot run under --stub-embed: the cross-encoder (${CAT13_RERANK_MODEL_PIN}) is not stubbed `
        + 'and gbrain\'s reranker is fail-open, so the cell would silently measure plain hybrid under a "reranker on" label',
      );
    }
    const rerankKeyEnv = providerKeyEnv(CAT13_RERANK_MODEL_PIN);
    if (!process.env[rerankKeyEnv]) {
      return skipped(`${rerankKeyEnv} required for --reranker on (${CAT13_RERANK_MODEL_PIN}); refusing to run a fail-open reranker cell without it`);
    }
  }

  const embedKeyEnv = providerKeyEnv(embedder.model);
  if (!stubEmbed && !process.env[embedKeyEnv]) {
    return skipped(`${embedKeyEnv} required for live embeds with ${embedder.model} (run with --stub-embed for the hermetic plumbing run)`);
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

  const conceptSlugs = pages.filter(p => p.slug.startsWith('concepts/')).map(p => p.slug);
  const split = splitConcepts(conceptSlugs, tuningN, holdoutN, splitSeed);
  const subsetCounts: Record<ProbeSubset, number> = { tuning: 0, holdout: 0, mixed: 0, unassigned: 0 };
  for (const p of probes) subsetCounts[probeSubset(p, split)] += 1;

  ensureGateway(stubEmbed, embedder);

  log(`# BrainBench Cat 13 — Conceptual Recall\n`);
  log(`Generated: ${new Date().toISOString().replace(/\..*$/, '')}`);
  log(`Corpus: ${pages.length} pages, ${conceptSlugs.length} concept pages`);
  log(`Probes: ${probes.length} (target ${targetProbes} per-concept + company pass; CAT13_PROBES env var to override)`);
  log(`Embeds: ${stubEmbed ? 'stubbed deterministic hash (hermetic)' : 'live'} — ${embedder.model} @ ${embedder.dims}d (every adapter, one gateway)`);
  log(`Search pins (gbrain-backed adapters): ${Object.entries(searchConfig).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`Concept split: seed=${split.seed} tuning=${split.tuning.length} held-out=${split.holdout.length} → probes tuning=${subsetCounts.tuning} held-out=${subsetCounts.holdout} mixed=${subsetCounts.mixed} unassigned=${subsetCounts.unassigned}`);
  log(`Metric: nDCG@${TOP_K} (graded: target=3, co-occurrence peer=1)\n`);
  log(`## Template breakdown\n`);
  const templateCounts: Record<string, number> = {};
  for (const p of probes) templateCounts[p.template] = (templateCounts[p.template] ?? 0) + 1;
  for (const [t, c] of Object.entries(templateCounts).sort((a, b) => b[1] - a[1])) {
    log(`- ${t}: ${c}`);
  }
  log('');

  const allPlans = buildAdapters({ embedder, searchConfig });
  const plans = opts.only ? allPlans.filter(p => p.adapter.name === opts.only) : allPlans;
  if (plans.length === 0) {
    throw new Error(`--adapter ${opts.only} matches none of: ${allPlans.map(p => p.adapter.name).join(', ')}`);
  }

  const acc = new ProbeAccounting(plans.length * probes.length);

  log(`## Running adapters\n`);
  const results: AdapterScore[] = [];
  for (const { adapter: a, initConfig } of plans) {
    log(`- ${a.name} ...`);
    try {
      const r = await scoreAdapter(a, pages, probes, gradesByQuery, acc, { initConfig, split });
      log(`  done (${(r.wallMs / 1000).toFixed(1)}s). nDCG@5=${(r.ndcg5 * 100).toFixed(1)}%, P@5(graded)=${(r.p5_graded * 100).toFixed(1)}%, P@1(strict)=${(r.p1_strict * 100).toFixed(1)}%`);
      if (r.gatewayAfterInit && (r.gatewayAfterInit.model !== embedder.model || r.gatewayAfterInit.dims !== embedder.dims)) {
        // The adapter reconfigured the gateway away from the run's embedder:
        // its numbers are in a different embedding space than the other arms.
        for (const p of probes) {
          acc.error(`${a.name}:${p.q.id}`, 'harness',
            `embedder drift: gateway after init was ${r.gatewayAfterInit.model}@${r.gatewayAfterInit.dims}, run pinned ${embedder.model}@${embedder.dims}`);
        }
        log(`  EMBEDDER DRIFT: ${r.gatewayAfterInit.model}@${r.gatewayAfterInit.dims} != ${embedder.model}@${embedder.dims}`);
      }
      if (pins.reranker === 'on' && GBRAIN_BACKED_ADAPTERS.has(a.name) && r.observed
        && r.observed.queries > 0 && r.observed.rerank_scored_queries === 0) {
        // Same shape as longmemeval's rerank_missing_score: the pin said
        // "reranker on" but no result carried a rerank_score — the fail-open
        // reranker measured plain hybrid. Harness error on every probe of the
        // arm so the run is invalid, never a quiet "reranker on" row.
        for (const p of probes) {
          acc.error(`${a.name}:${p.q.id}`, 'harness',
            `rerank_missing_score: search.reranker.enabled pinned 'true' for ${a.name} but no result carried rerank_score`);
        }
        log(`  RERANKER DID NOT FIRE: 0/${r.observed.queries} queries carried rerank_score`);
      }
      if (floorIsNumeric && GBRAIN_BACKED_ADAPTERS.has(a.name) && r.observed && r.observed.queries > 0) {
        // Phase E2, same shape as rerank_missing_score: the pin said "floor
        // on" but no query carried keyword_arm_confidence meta — the linked
        // gbrain never composed the decision (predates the knob, or the
        // fused path never ran). Harness error on every probe of the arm.
        const stamped = r.observed.keyword_arm_confidence_stamped ?? 0;
        const downweighted = r.observed.keyword_arm_confidence_downweighted ?? 0;
        if (stamped === 0) {
          for (const p of probes) {
            acc.error(`${a.name}:${p.q.id}`, 'harness',
              `kacf_missing_meta: search.keyword_arm_confidence_floor pinned '${floorPin}' for ${a.name} but no query carried keyword_arm_confidence meta`);
          }
          log(`  FLOOR NOT OBSERVED: 0/${r.observed.queries} queries carried keyword_arm_confidence`);
        } else {
          log(`  keyword_arm_confidence: stamped ${stamped}/${r.observed.queries}, down-weighted ${downweighted}${downweighted === 0 ? ' (the floor never fired — a legal null result)' : ''}`);
        }
      }
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

  // Per-template rollups: overall, then tuning and held-out.
  const templates = [...new Set(probes.map(p => p.template))].sort();
  const templateCountsFor = (subset: ProbeSubset | 'all'): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const p of probes) {
      if (subset !== 'all' && probeSubset(p, split) !== subset) continue;
      counts[p.template] = (counts[p.template] ?? 0) + 1;
    }
    return counts;
  };
  const logTemplateTable = (
    title: string,
    byTemplateOf: (r: AdapterScore) => Record<string, { ndcg: number; count: number }> | undefined,
    counts: Record<string, number>,
  ): void => {
    log(`\n## ${title}\n`);
    log(`| Template | ${results.map(r => r.name).join(' | ')} | #probes |`);
    log(`|----------|${results.map(() => '--------').join('|')}|---------|`);
    for (const t of templates) {
      if (!(counts[t] > 0)) continue;
      const row = results.map(r => `${((byTemplateOf(r)?.[t]?.ndcg ?? 0) * 100).toFixed(1)}%`).join(' | ');
      log(`| ${t} | ${row} | ${counts[t]} |`);
    }
  };
  logTemplateTable('Per-template nDCG@5 (where each retrieval style earns its keep)', r => r.byTemplate, templateCountsFor('all'));

  log(`\n## Concept split — tuning vs held-out (seed=${split.seed}, ${split.tuning.length}/${split.holdout.length} concepts)\n`);
  log(`| Adapter | Subset | #probes | nDCG@5 | P@5 (graded) | P@1 (strict target) |`);
  log(`|---------|--------|---------|--------|---------------|----------------------|`);
  for (const r of results) {
    for (const subset of ['tuning', 'holdout'] as const) {
      const s = r.splits?.[subset];
      if (!s) continue;
      log(`| ${r.name.padEnd(16)} | ${subset === 'holdout' ? 'held-out' : subset} | ${s.count} | ${(s.ndcg5 * 100).toFixed(1)}% | ${(s.p5_graded * 100).toFixed(1)}% | ${(s.p1_strict * 100).toFixed(1)}% |`);
    }
  }
  log(`\nMixed-target probes (gold names concepts from both sets) are excluded from both subsets: ${subsetCounts.mixed}. Unassigned (targets outside both sets): ${subsetCounts.unassigned}.`);
  log(`Held-out concepts: ${split.holdout.join(', ')}`);
  logTemplateTable('Per-template nDCG@5 — tuning concepts', r => r.splits?.tuning.byTemplate, templateCountsFor('tuning'));
  logTemplateTable('Per-template nDCG@5 — held-out concepts (decision set)', r => r.splits?.holdout.byTemplate, templateCountsFor('holdout'));

  log(`\n## Methodology\n`);
  log(`- Corpus: eval/data/world-v1/concepts__*.json (${conceptSlugs.length} concept pages) + the full world-v1 index.`);
  log(`- Probes: programmatic, seeded (mulberry32 seed=${PROBE_SEED}, Fisher-Yates sampling). Rerun produces the identical set across JS runtimes.`);
  log(`- Probe texts are globally unique: ambiguous candidates (same text claimable by >1 concept) are dropped at generation and the run aborts on any surviving duplicate.`);
  log(`- Graded gold: target concept=3, co-occurrence peers (share >=1 related company/person)=1. Company-neighborhood probes: every concept listing the company=3, the company page=1.`);
  log(`- Template mix: title paraphrase, title variation, description paraphrase, hand-authored synonyms, body-phrase fuzzy recall, semantic neighborhood (self-grounded), company neighborhood (global pass).`);
  log(`- Metric: nDCG@5 (primary, shared eval/runner/metrics.ts). P@5-graded = precision@5 against the grade>=1 set. P@1-strict = rank-1 is in the grade-3 target set.`);
  log(`- Top-K: ${TOP_K}.`);
  log(`- Embedder: ${embedder.model} @ ${embedder.dims}d for EVERY adapter (CAT13_EMBEDDING_MODEL / CAT13_EMBED_DIMS); the receipt records the gateway state after each adapter's init.`);
  log(`- Search pins on gbrain-backed adapters (${[...GBRAIN_BACKED_ADAPTERS].join(', ')}): ${Object.entries(searchConfig).map(([k, v]) => `${k}=${v}`).join(', ')} — set via engine.setConfig before ingest, echoed per adapter.`);
  log(`- Concept split: seeded Fisher-Yates over the sorted concept slugs (seed=${split.seed}, separate rng from the probe generator); ${split.tuning.length} tuning / ${split.holdout.length} held-out. A probe is in a subset only when every grade-3 target is.`);
  if (floorPin !== undefined) {
    log(`- Arm-confidence floor (Phase E2): search.keyword_arm_confidence_floor=${floorPin} on the gbrain-backed adapters — keyword + title lists fuse at half weight when the keyword arm's margin_ratio is below the floor (non-relational queries with a voting text vector arm). Per-adapter stamped / down-weighted query counts are in the receipt's observed_by_adapter.`);
  }
  if (Object.keys(extraPins).length > 0) {
    log(`- Generic pins (--search-pin): ${Object.entries(extraPins).map(([k, v]) => `${k}=${v}`).join(', ')} on the gbrain-backed adapters — pass-through engine.setConfig entries. gbrain ignores unknown search.* keys silently, so confirm each key exists in the linked gbrain (${gbrainVersion()}) before reading this arm.`);
  }
  log(`- No gold data passed to adapters; PublicPage/PublicQuery sealed at the boundary.`);

  const summary = acc.summary();

  const conceptSplitRecord = {
    seed: split.seed,
    tuning_n: split.tuning.length,
    holdout_n: split.holdout.length,
    tuning: split.tuning,
    holdout: split.holdout,
    probes: subsetCounts,
  };

  const reportFile = join(reportsDir, CATEGORY, 'report.json');
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify({
    ran_at: startedAt,
    stub_embed: stubEmbed,
    embedder,
    search_pins: searchConfig,
    concept_split: conceptSplitRecord,
    probes: probes.length,
    template_counts: templateCounts,
    results,
    accounting: summary,
  }, null, 2) + '\n');

  const subsetRow = (s: SubsetScore | undefined) => s
    ? { ndcg5: s.ndcg5, p5_graded: s.p5_graded, p1_strict: s.p1_strict, count: s.count }
    : null;

  const resolvedConfig: Record<string, unknown> = {
    top_k: TOP_K,
    probe_seed: PROBE_SEED,
    target_probes: targetProbes,
    probes_generated: probes.length,
    ...cellConfig(),
    embedding_transport: stubEmbed
      ? `stubbed deterministic hash-embed (__setEmbedTransportForTests), ${embedder.dims}d`
      : `live ${embedder.model} @ ${embedder.dims}d`,
    gateway_after_init_by_adapter: Object.fromEntries(results.map(r => [r.name, r.gatewayAfterInit ?? null])),
    search_config_by_adapter: Object.fromEntries(results.map(r => [r.name, r.resolvedConfig ?? null])),
    observed_by_adapter: Object.fromEntries(results.map(r => [r.name, r.observed ?? null])),
    concept_split: conceptSplitRecord,
    adapters_run: results.map(r => r.name),
  };
  const data: Record<string, unknown> = {
    scorecard: results.map(r => ({
      name: r.name,
      ndcg5: r.ndcg5,
      p5_graded: r.p5_graded,
      p1_strict: r.p1_strict,
      wall_ms: r.wallMs,
      tuning: subsetRow(r.splits?.tuning),
      holdout: subsetRow(r.splits?.holdout),
    })),
    per_template: Object.fromEntries(results.map(r => [r.name, {
      overall: r.byTemplate,
      tuning: r.splits?.tuning.byTemplate ?? null,
      holdout: r.splits?.holdout.byTemplate ?? null,
    }])),
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

  const fullStandardRun = !opts.only && results.length === allPlans.length;
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
  const { exitCode } = await runCat13(parseCat13Argv(process.argv.slice(2)));
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
