/**
 * Cat 5 — Source Attribution / Provenance.
 *
 * FEATURE BOUNDARY (what is under test vs what is seeded/stubbed):
 *   - UNDER TEST: gbrain's provenance quality — whether claims found on
 *     brain pages are actually grounded in their source material.
 *   - SEEDED: the gold claim catalog + source pages (pagesBySlug). The
 *     Haiku classifier is the measurement instrument (live in real runs,
 *     stubbed in hermetic tests) — NOT the system under test.
 *
 * Samples N claims from gbrain brain pages. For each claim, asks Haiku to
 * classify it against source material as:
 *   - **supported** — the claim is directly backed by the source pages
 *   - **unsupported** — the claim has no grounding in the source pages
 *   - **over-generalized** — the claim is partially supported but extrapolates
 *     beyond what the source actually says
 *
 * BLIND CLASSIFICATION (audit agentic-cats-02 / tests-audit-04): the
 * classifier prompt must never encode the gold label. Two rules:
 *   1. The context handed to the classifier is label-independent: every
 *      claim's own `source_page` content is ALWAYS included (plus any
 *      `expected_evidence` pages), so gold-unsupported claims no longer get
 *      an empty, trivially-separable context.
 *   2. No verdict hints. The old "(no source pages provided — the claim is
 *      almost certainly unsupported)" note literally told the judge the
 *      answer for every gold-unsupported claim; the note is now neutral.
 * Residual caveat: supported claims still tend to carry MORE pages than
 * unsupported ones (evidence lists differ by class); fully removing that
 * signal needs retrieved distractor pages, which requires an engine this
 * runner deliberately does not have. Stated in the report, not hidden.
 *
 * Gold-resolution policy: a `source_page` or `expected_evidence` slug that
 * does not resolve in pagesBySlug is a HARNESS error (fails loudly via
 * probe accounting) — silent drops previously flipped the prompt into the
 * leaking empty-context shape.
 *
 * Uses a dedicated classify_claim tool (single-enum output) rather than
 * reusing judge.ts's rubric-scoring path. Cat 5 doesn't need graded
 * criteria — it's a single three-way classification per claim. The call
 * runs at temperature 0 (WS0 judge policy: reproducible verdicts).
 *
 * Metric: `citation_accuracy` = fraction where label == gold `expected_label`,
 * over CLASSIFIED claims. judge_failed claims are 'judge' errors — excluded
 * from the denominator and capped via probe-accounting, never scored as 0.
 * Threshold (informational, baseline-only in v1 until hand-authored gold
 * claims exist): >0.90 per design-doc METRICS.md.
 *
 * Every run writes a receipt (eval/reports/cat5-provenance/receipt.json by
 * default).
 *
 * Gold input: `eval/data/gold/citations.json` with `{version, claims: [...]}`.
 * v1 ships with a template. Day 3b corpus generation + hand-authoring fills
 * in real claims sampled from the amara-life-v1 brain-export. Until then,
 * this runner is validated on synthetic test fixtures.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ProbeAccounting, type ProbeSummary } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  BENCHMARK_VERSION,
  RECEIPT_SCHEMA_VERSION,
  type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type ClaimLabel = 'supported' | 'unsupported' | 'over-generalized';
export type ClassificationOutcome = ClaimLabel | 'judge_failed';

export interface Claim {
  /** Stable fixture id, e.g. "claim-001". */
  id: string;
  /**
   * Slug of the brain page that contains the claim. MUST resolve in
   * pagesBySlug: its content is always part of the classifier context
   * (blind-classification rule), so an unresolvable source_page is a
   * harness error, not a silent skip.
   */
  source_page: string;
  /** The claim text itself (one sentence or statement). */
  claim_text: string;
  /** Gold label — what the correct classification is. NEVER shown to the classifier. */
  expected_label: ClaimLabel;
  /** Slugs of pages that should support the claim when expected_label=supported. */
  expected_evidence: string[];
  /** Human-readable rationale in the gold file. Not passed to the judge. */
  reason?: string;
}

export interface GroundTruthPage {
  slug: string;
  title: string;
  content: string;
}

export interface ClaimScore {
  claim_id: string;
  predicted_label: ClassificationOutcome;
  expected_label: ClaimLabel;
  matches_expected: boolean;
  judge_rationale: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  fallback_used: boolean;
}

export interface Cat5Report {
  schema_version: 1;
  ran_at: string;
  total_claims: number;
  by_predicted: Record<ClassificationOutcome, number>;
  by_expected: Record<ClaimLabel, number>;
  /**
   * Accuracy = fraction of CLASSIFIED claims where predicted == expected.
   * judge_failed claims are excluded from the denominator (WS0: judge
   * failures are typed errors, not misses).
   */
  citation_accuracy: number;
  /** Judge failure rate — fraction that fell back to judge_failed. */
  judge_failure_rate: number;
  per_claim: ClaimScore[];
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  verdict: 'pass' | 'fail' | 'baseline_only';
}

export interface Cat5Config {
  /** Anthropic client. Defaults to lazy singleton reading ANTHROPIC_API_KEY. */
  client?: Anthropic;
  /** Haiku model id. Default: claude-haiku-4-5-20251001. */
  model?: string;
  /** Max tokens per judge call. Default 400. */
  maxTokens?: number;
  /** Threshold for pass verdict. Default 0.90. v1 ignores this by default. */
  threshold?: number;
  /** Whether to apply the threshold (v1 uses baseline_only). Default false. */
  enableThreshold?: boolean;
}

// ─── Defaults + pricing ──────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_THRESHOLD = 0.9;

const PRICE_INPUT_PER_M = 1.0;
const PRICE_OUTPUT_PER_M = 5.0;

let defaultClient: Anthropic | null = null;
function getDefaultClient(): Anthropic {
  if (!defaultClient) defaultClient = new Anthropic();
  return defaultClient;
}

function priceOf(input: number, output: number): number {
  return (input * PRICE_INPUT_PER_M + output * PRICE_OUTPUT_PER_M) / 1_000_000;
}

// ─── Tool definition ─────────────────────────────────────────────────

export const CLASSIFY_CLAIM_TOOL = {
  name: 'classify_claim',
  description:
    'Classify how well the brain claim is grounded in the provided source pages. Return one of three labels with a terse one-sentence rationale.',
  input_schema: {
    type: 'object' as const,
    properties: {
      label: {
        type: 'string',
        enum: ['supported', 'unsupported', 'over-generalized'],
        description:
          'supported: claim is directly backed by at least one source page. unsupported: no source page grounds the claim (hallucination). over-generalized: partially grounded but extrapolates beyond what the source actually states.',
      },
      rationale: {
        type: 'string',
        description: 'One short sentence explaining the label. Quote the relevant source phrase if possible.',
      },
    },
    required: ['label', 'rationale'],
  },
};

// ─── Prompt assembly ─────────────────────────────────────────────────

export const DEFAULT_CAT5_SYSTEM_PROMPT = `You are a provenance auditor for BrainBench. Given a CLAIM extracted from a brain page and the SOURCE PAGES it purports to be based on, decide whether the claim is:

- supported: the claim is directly stated or implied by at least one source page (paraphrase OK, but the factual content must match).
- unsupported: no source page backs the claim — it's a hallucination or unrelated.
- over-generalized: part of the claim is grounded, but it extrapolates beyond what the sources actually say (e.g., claim says "always" when source says "sometimes"; claim attributes a statement to the wrong person; claim adds a number or date that no source provides).

Return your answer via the classify_claim tool. No plain text reply.`;

function renderClaimPrompt(claim: Claim, sources: GroundTruthPage[]): string {
  const lines: string[] = [];
  lines.push('<claim>');
  lines.push(`  id: ${claim.id}`);
  lines.push(`  source_page: ${claim.source_page}`);
  lines.push(`  text: ${JSON.stringify(claim.claim_text)}`);
  lines.push('</claim>');
  lines.push('');
  lines.push('<source_pages>');
  for (const p of sources) {
    lines.push(`  <page slug="${p.slug}" title=${JSON.stringify(p.title)}>`);
    lines.push(indent(p.content, '    '));
    lines.push('  </page>');
  }
  if (sources.length === 0) {
    // Neutral note ONLY — this branch previously leaked the gold label
    // ("...the claim is almost certainly unsupported") for every claim
    // whose context resolved empty (audit agentic-cats-02 / tests-audit-04).
    // runCat5 never reaches this branch anymore (source_page is always
    // included or the claim is a harness error), but renderClaimPrompt is
    // exported, so keep the empty case honest and hint-free.
    lines.push('  (no source pages provided)');
  }
  lines.push('</source_pages>');
  lines.push('');
  lines.push('Classify via the classify_claim tool. No plain text reply.');
  return lines.join('\n');
}

function indent(s: string, prefix: string): string {
  return s.split('\n').map(l => prefix + l).join('\n');
}

// ─── Parsing ─────────────────────────────────────────────────────────

interface ParsedClassification {
  label: ClaimLabel;
  rationale: string;
}

function parseClassification(response: Anthropic.Messages.Message): ParsedClassification | null {
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'classify_claim') {
      const input = block.input as unknown;
      if (!input || typeof input !== 'object') return null;
      const obj = input as Record<string, unknown>;
      if (
        obj.label !== 'supported' &&
        obj.label !== 'unsupported' &&
        obj.label !== 'over-generalized'
      ) {
        return null;
      }
      if (typeof obj.rationale !== 'string') return null;
      return { label: obj.label, rationale: obj.rationale };
    }
  }
  return null;
}

// ─── Per-claim classification ────────────────────────────────────────

export async function classifyClaim(
  claim: Claim,
  sources: GroundTruthPage[],
  config: Cat5Config = {},
): Promise<ClaimScore> {
  const client = config.client ?? getDefaultClient();
  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const userContent = renderClaimPrompt(claim, sources);

  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  async function callOnce(): Promise<ParsedClassification | null> {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // WS0 judge policy: temperature 0 — classifications must be reproducible.
      temperature: 0,
      system: [
        { type: 'text', text: DEFAULT_CAT5_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [CLASSIFY_CLAIM_TOOL],
      tool_choice: { type: 'tool', name: 'classify_claim' },
      messages: [{ role: 'user', content: userContent }],
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cost += priceOf(response.usage.input_tokens, response.usage.output_tokens);
    return parseClassification(response);
  }

  let parsed = await callOnce();
  if (parsed === null) parsed = await callOnce();

  if (parsed === null) {
    return {
      claim_id: claim.id,
      predicted_label: 'judge_failed',
      expected_label: claim.expected_label,
      matches_expected: false,
      judge_rationale:
        'judge_failed: malformed classify_claim response across 2 attempts; scoring as unsupported for safety',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      fallback_used: true,
    };
  }

  return {
    claim_id: claim.id,
    predicted_label: parsed.label,
    expected_label: claim.expected_label,
    matches_expected: parsed.label === claim.expected_label,
    judge_rationale: parsed.rationale,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
    fallback_used: false,
  };
}

// ─── Aggregate + report ──────────────────────────────────────────────

export function aggregate(
  claims: Claim[],
  scores: ClaimScore[],
  config: Cat5Config = {},
): Cat5Report {
  const threshold = config.threshold ?? DEFAULT_THRESHOLD;
  const enableThreshold = config.enableThreshold ?? false;

  const byPredicted: Record<ClassificationOutcome, number> = {
    supported: 0,
    unsupported: 0,
    'over-generalized': 0,
    judge_failed: 0,
  };
  const byExpected: Record<ClaimLabel, number> = {
    supported: 0,
    unsupported: 0,
    'over-generalized': 0,
  };
  let matched = 0;
  let classified = 0;
  let fallbacks = 0;
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    byPredicted[s.predicted_label] = (byPredicted[s.predicted_label] ?? 0) + 1;
    byExpected[s.expected_label] = (byExpected[s.expected_label] ?? 0) + 1;
    if (s.predicted_label !== 'judge_failed') {
      // WS0: judge failures are excluded from the accuracy denominator
      // (recorded + capped via probe accounting) — never averaged in as 0.
      classified++;
      if (s.matches_expected) matched++;
    }
    if (s.fallback_used) fallbacks++;
    totalCost += s.cost_usd;
    totalIn += s.input_tokens;
    totalOut += s.output_tokens;
  }

  const accuracy = classified === 0 ? 0 : matched / classified;
  const failureRate = scores.length === 0 ? 0 : fallbacks / scores.length;

  let verdict: 'pass' | 'fail' | 'baseline_only';
  if (!enableThreshold) {
    verdict = 'baseline_only';
  } else {
    verdict = accuracy >= threshold ? 'pass' : 'fail';
  }

  void claims; // claims[] reference is for structure; scores carry the telemetry

  return {
    schema_version: 1,
    ran_at: new Date().toISOString(),
    total_claims: scores.length,
    by_predicted: byPredicted,
    by_expected: byExpected,
    citation_accuracy: accuracy,
    judge_failure_rate: failureRate,
    per_claim: scores,
    total_cost_usd: totalCost,
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    verdict,
  };
}

// ─── Runner entry ─────────────────────────────────────────────────────

export interface RunCat5Options extends Cat5Config {
  /** Claims to evaluate. Typically loaded from eval/data/gold/citations.json. */
  claims: Claim[];
  /**
   * Source pages indexed by slug. The runner resolves each claim's
   * source_page + expected_evidence against this map; unresolvable slugs
   * are harness errors (gold drift fails loudly).
   */
  pagesBySlug: Map<string, GroundTruthPage>;
  /** Max concurrent judge calls. Default 4 to respect Haiku rate limits. */
  concurrency?: number;
  /** Root for the receipt. Default eval/reports. Tests point this at a tmp dir. */
  reportsRoot?: string;
}

export const CAT5_CATEGORY = 'cat5-provenance';

/**
 * Resolve the label-independent classifier context for a claim: the claim's
 * own source_page content FIRST, then any expected_evidence pages, deduped.
 * Returns the missing slugs so the caller can fail loudly on gold drift.
 */
export function resolveClaimSources(
  claim: Claim,
  pagesBySlug: Map<string, GroundTruthPage>,
): { sources: GroundTruthPage[]; missing: string[] } {
  const sources: GroundTruthPage[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const slug of [claim.source_page, ...claim.expected_evidence]) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const page = pagesBySlug.get(slug);
    if (page) sources.push(page);
    else missing.push(slug);
  }
  return { sources, missing };
}

async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function runCat5(opts: RunCat5Options): Promise<Cat5Report> {
  const startedAt = new Date().toISOString();
  const concurrency = opts.concurrency ?? 4;
  const acc = new ProbeAccounting(opts.claims.length);

  const outcomes = await runConcurrently(opts.claims, concurrency, async (claim): Promise<ClaimScore | null> => {
    const { sources, missing } = resolveClaimSources(claim, opts.pagesBySlug);
    if (missing.length > 0) {
      // Gold drift fails LOUDLY (audit agentic-cats-09 twin in cat5): a
      // silently-shrunk context previously flipped the prompt into the
      // leaking empty-sources shape.
      const msg =
        `Cat 5 gold drift: claim ${claim.id} references slugs that do not resolve: ` +
        `${missing.join(', ')}. Fix the gold data or the pagesBySlug map.`;
      console.error(`[cat5] HARNESS ERROR: ${msg}`);
      acc.error(claim.id, 'harness', msg);
      return null;
    }
    let score: ClaimScore;
    try {
      score = await classifyClaim(claim, sources, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      acc.error(claim.id, 'dependency', `classify_claim call failed: ${msg}`);
      return null;
    }
    if (score.predicted_label === 'judge_failed') {
      // WS0: excluded from citation_accuracy denominator (see aggregate) + capped.
      acc.error(claim.id, 'judge', score.judge_rationale);
    } else {
      acc.score(claim.id, score.matches_expected ? 1 : 0);
    }
    return score;
  });

  const scores = outcomes.filter((s): s is ClaimScore => s !== null);
  const report = aggregate(opts.claims, scores, opts);
  writeCat5Receipt(opts, report, acc.summary(), startedAt);
  return report;
}

// ─── Receipt ──────────────────────────────────────────────────────────

function writeCat5Receipt(
  opts: RunCat5Options,
  report: Cat5Report,
  summary: ProbeSummary,
  startedAt: string,
): void {
  const model = opts.model ?? DEFAULT_MODEL;
  const base = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT5_CATEGORY,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      classifier_model: model,
      classifier_temperature: 0,
      threshold: opts.threshold ?? DEFAULT_THRESHOLD,
      thresholds_enabled: opts.enableThreshold ?? false,
      // WS5: cat5 classifies gold claims against gold pages — no gbrain
      // engine, search, or reranker is in the loop, so there is no search
      // mode to pin.
      search_mode: 'not_applicable (no retrieval in this eval)',
      reranker_enabled: 'not_applicable (no retrieval in this eval)',
    },
    judge: { model, temperature: 0 },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  } as const;

  const path = opts.reportsRoot ? receiptPath(CAT5_CATEGORY, opts.reportsRoot) : receiptPath(CAT5_CATEGORY);
  if (summary.n_total === 0) {
    writeReceipt(path, {
      ...base,
      run_status: 'skipped',
      skip_reason: 'no claims provided to runCat5',
      publishable: false,
    });
  } else if (summary.run_invalid) {
    writeReceipt(path, { ...base, run_status: 'error', publishable: false });
  } else {
    const receiptVerdict: ReceiptVerdict =
      report.verdict === 'baseline_only' ? 'partial' : report.verdict;
    writeReceipt(path, {
      ...base,
      run_status: 'completed',
      verdict: receiptVerdict,
      publishable: summary.publishable,
    });
  }
}

// Exports for tests
export { renderClaimPrompt, parseClassification };
