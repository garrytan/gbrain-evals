/**
 * BrainBench Cat 25 — trajectory routing A/B through gbrain's REAL think
 * pipeline (v0.40.2.0 wave gate).
 *
 * FEATURE BOUNDARY — what is under test vs what is scaffolding:
 *
 *   UNDER TEST: gbrain's trajectory ROUTING inside `runThink` (imported from
 *     the 'gbrain/think' subpath export): classifyIntent → candidate entity
 *     extraction → resolveEntitySlugWithSource → engine.findTrajectory →
 *     formatTrajectoryBlock → `<trajectory>` prompt injection → synthesis.
 *     Both arms run the same production code path against the same seeded
 *     brain; the ONLY difference is the public `withTrajectory` option:
 *       baseline = runThink(engine, { question, withTrajectory: false, ... })
 *       wave     = runThink(engine, { question, withTrajectory: true,  ... })
 *
 *   NOT under test: fact EXTRACTION. The facts table is a derived index that
 *     production populates via the extract_facts cycle phase / put_page
 *     backstop — a separate pipeline with its own evals. This runner seeds
 *     typed-claim rows DIRECTLY via `engine.insertFact` (claim_metric /
 *     claim_value / claim_unit / claim_period, dated valid_from). That is
 *     in-boundary by design: routing can only be measured when trajectory
 *     data verifiably exists. (Audit finding cats22-25-01: the previous
 *     version seeded a bare markdown table that never reached the facts
 *     table, so both arms ran byte-identical prompts and the published
 *     delta was sampling noise.) A preflight asserts engine.findTrajectory
 *     returns >0 points per probe entity and ABORTS the run otherwise, so
 *     the eval can never silently degenerate to same-vs-same again.
 *
 *   SEEDED / STUBBED (legitimately):
 *     - Per probe, a fresh in-memory PGLiteEngine: entity pages imported via
 *       importFromContent (so gather retrieval + entity resolution work),
 *       typed-claim facts via insertFact. Search config pinned per WS5
 *       BEFORE ingest and echoed into the receipt.
 *     - Embeddings: deterministic hash-embed transport via gbrain's
 *       __setEmbedTransportForTests + OPENAI_API_KEY=dummy. Retrieval
 *       quality is not under test; routing is.
 *     - The synthesis LLM is injected through runThink's documented `client`
 *       seam in BOTH modes; the client captures the exact prompts gbrain
 *       assembled, which powers the mechanical wiring checks (trajectory
 *       block present in the wave prompt, absent from baseline).
 *         live     — Anthropic messages.create at temperature 0
 *         hermetic — a deterministic actor that conditions ONLY on whether
 *                    gbrain actually delivered a <trajectory> block in the
 *                    prompt it received (echoes the block if present, says
 *                    it has no dated readings otherwise). If routing breaks,
 *                    the actor never sees the block and the gate fails.
 *
 * JUDGING:
 *   live     — eval/runner/judge.ts scoreAnswer (Haiku, temperature 0,
 *              rubric-coverage enforced). Each arm's answer is scored
 *              INDEPENDENTLY against the same rubric + the dated readings
 *              as ground truth (absolute scoring, so A/B presentation-order
 *              bias does not apply). The judge never sees gold answers,
 *              expected verdicts, or arm labels. judge_failed → 'judge'
 *              probe error (excluded from means, capped) — never scored 0.
 *   hermetic — deterministic marker judge: fraction of the probe's
 *              gold_markers present in the answer. Expectation-free at
 *              answer time (the actor cannot see markers).
 *
 * GATES (real + failable):
 *   - preflight: findTrajectory(entity) > 0 points for EVERY probe, else
 *     the whole run aborts with an error receipt (exit 2).
 *   - wiring: every scored probe must have the trajectory block injected in
 *     the wave arm and absent from baseline; violations are 'sut' failures
 *     scored 0.
 *   - wave_mean >= 0.99 hermetic / >= 0.6 live.
 *   - wave_mean >= baseline_mean (trajectory must not lose the A/B).
 *   - negative control (hermetic only, deterministic): the degraded arm
 *     (withTrajectory:false) must score <= 0.5 × the wave arm.
 *
 * Cost (live mode): 6 probes × 2 think calls (models.think pinned, default
 * claude-sonnet-4-6, temperature 0) + 12 Haiku judge calls ≈ $0.30-0.60.
 * Hermetic mode costs $0 and needs no keys.
 *
 * Run:
 *   bun eval/runner/cat25-trajectory-routing.ts                  # live (ANTHROPIC_API_KEY)
 *   CAT25_DRY_RUN=1 bun eval/runner/cat25-trajectory-routing.ts  # hermetic conformance run
 *   bun eval/runner/cat25-trajectory-routing.ts --allow-skip     # missing key → skip receipt, exit 0
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { runThink, type ThinkLLMClient, type ThinkResult } from 'gbrain/think';
import { scoreAnswer, type JudgeEvidence, type RubricCriterion } from './judge.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type Receipt,
  type ReceiptVerdict,
  type FailureOrigin,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

// Isolate GBRAIN_HOME so a developer's ~/.gbrain/config.json can't leak
// model/gateway config into the run.
const ISOLATED_HOME = join(tmpdir(), `cat25-gbrain-home-${process.pid}-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

export const CATEGORY = 'cat25-trajectory-routing';

// ─── Fixtures ────────────────────────────────────────────────────────

export interface SeedFact {
  since: string;      // YYYY-MM-DD → valid_from
  text: string;       // fact prose (survives verbatim into the trajectory block)
  metric: string;     // claim_metric
  value: number;      // claim_value
  unit: string;       // claim_unit
  period: string;     // claim_period
}

export interface Probe {
  id: string;
  description: string;
  /** Canonical entity slug — facts rows carry it, pages are imported at it. */
  entity_slug: string;
  /** Extra pages (e.g. a distractor entity). First page is the probe entity. */
  pages: { slug: string; body: string }[];
  /** Typed-claim rows seeded via engine.insertFact (NOT via markdown). */
  facts: { entity_slug: string; rows: SeedFact[] }[];
  /** Must classify as temporal/knowledge_update per gbrain's intent regexes. */
  question: string;
  /** Human reference. Report-only; NEVER shown to the judge or the actor. */
  gold_answer: string;
  /** Deterministic marker judge (hermetic): fraction present = score. */
  gold_markers: string[];
}

function companyPage(name: string, blurb: string): string {
  return `# ${name}\n\n${name} is ${blurb}\n\nDated metric readings live in the facts index, not in this page.\n`;
}

export const PROBES: Probe[] = [
  {
    id: 'arr-trajectory-acme',
    description: 'ARR changed across 3 dates; question asks for a specific month.',
    entity_slug: 'companies/acme-ai',
    pages: [{ slug: 'companies/acme-ai', body: companyPage('Acme AI', 'an AI infrastructure company.') }],
    facts: [{
      entity_slug: 'companies/acme-ai',
      rows: [
        { since: '2026-01-15', text: 'ARR is $500K', metric: 'arr', value: 500000, unit: 'usd', period: 'annual' },
        { since: '2026-03-10', text: 'ARR is $1.2M', metric: 'arr', value: 1200000, unit: 'usd', period: 'annual' },
        { since: '2026-05-01', text: 'ARR is $2.5M', metric: 'arr', value: 2500000, unit: 'usd', period: 'annual' },
      ],
    }],
    question: 'What was the ARR of Acme AI in March 2026?',
    gold_answer: '$1.2M (most recent reading on or before March 2026, dated 2026-03-10).',
    gold_markers: ['$1.2M', '2026-03-10'],
  },
  {
    id: 'team-size-trajectory-foundry',
    description: 'Team size changed across 2 dates; question asks about the earlier one.',
    entity_slug: 'companies/foundry-labs',
    pages: [{ slug: 'companies/foundry-labs', body: companyPage('Foundry Labs', 'a robotics startup.') }],
    facts: [{
      entity_slug: 'companies/foundry-labs',
      rows: [
        { since: '2026-01-10', text: 'team is 8 people', metric: 'team_size', value: 8, unit: 'people', period: 'snapshot' },
        { since: '2026-04-15', text: 'team is 15 people', metric: 'team_size', value: 15, unit: 'people', period: 'snapshot' },
      ],
    }],
    question: 'How big was the Foundry Labs team in January 2026?',
    gold_answer: '8 people (per the 2026-01-10 reading).',
    gold_markers: ['8 people', '2026-01-10'],
  },
  {
    id: 'mrr-midpoint-nimbus',
    description: 'Ambiguous date: the asked month sits between two readings; correct answer is the most recent on-or-before reading.',
    entity_slug: 'companies/nimbus-health',
    pages: [{ slug: 'companies/nimbus-health', body: companyPage('Nimbus Health', 'a clinical-notes automation company.') }],
    facts: [{
      entity_slug: 'companies/nimbus-health',
      rows: [
        { since: '2026-01-05', text: 'MRR is $40K', metric: 'mrr', value: 40000, unit: 'usd', period: 'monthly' },
        { since: '2026-03-20', text: 'MRR is $75K', metric: 'mrr', value: 75000, unit: 'usd', period: 'monthly' },
        { since: '2026-06-12', text: 'MRR is $130K', metric: 'mrr', value: 130000, unit: 'usd', period: 'monthly' },
      ],
    }],
    question: 'What was the MRR of Nimbus Health in April 2026?',
    gold_answer: '$75K (no April reading exists; the most recent reading on or before April 2026 is $75K, dated 2026-03-20).',
    gold_markers: ['$75K', '2026-03-20'],
  },
  {
    id: 'headcount-latest-orbital',
    description: 'Knowledge-update intent ("current") must route to the LATEST reading.',
    entity_slug: 'companies/orbital-freight',
    pages: [{ slug: 'companies/orbital-freight', body: companyPage('Orbital Freight', 'a logistics marketplace.') }],
    facts: [{
      entity_slug: 'companies/orbital-freight',
      rows: [
        { since: '2025-11-01', text: 'headcount is 22', metric: 'headcount', value: 22, unit: 'people', period: 'snapshot' },
        { since: '2026-02-14', text: 'headcount is 31', metric: 'headcount', value: 31, unit: 'people', period: 'snapshot' },
        { since: '2026-06-30', text: 'headcount is 45', metric: 'headcount', value: 45, unit: 'people', period: 'snapshot' },
      ],
    }],
    question: 'What is the current headcount at Orbital Freight?',
    gold_answer: '45 (latest reading, dated 2026-06-30).',
    gold_markers: ['45', '2026-06-30'],
  },
  {
    id: 'burn-rate-first-quasar',
    description: 'Question targets the EARLIEST reading with later readings present.',
    entity_slug: 'companies/quasar-bio',
    pages: [{ slug: 'companies/quasar-bio', body: companyPage('Quasar Bio', 'a protein-design startup.') }],
    facts: [{
      entity_slug: 'companies/quasar-bio',
      rows: [
        { since: '2026-01-20', text: 'burn rate is $180K per month', metric: 'burn_rate', value: 180000, unit: 'usd', period: 'monthly' },
        { since: '2026-04-02', text: 'burn rate is $260K per month', metric: 'burn_rate', value: 260000, unit: 'usd', period: 'monthly' },
      ],
    }],
    question: 'What was the burn rate of Quasar Bio in January 2026?',
    gold_answer: '$180K per month (per the 2026-01-20 reading).',
    gold_markers: ['$180K', '2026-01-20'],
  },
  {
    id: 'arr-two-entities-vector-vs-helix',
    description: 'Two entities with trajectories; the question names one — the answer must come from that entity.',
    entity_slug: 'companies/vector-tools',
    pages: [
      { slug: 'companies/vector-tools', body: companyPage('Vector Tools', 'a devtools company.') },
      { slug: 'companies/helix-data', body: companyPage('Helix Data', 'a data-labeling company.') },
    ],
    facts: [
      {
        entity_slug: 'companies/vector-tools',
        rows: [
          { since: '2026-02-01', text: 'ARR is $900K', metric: 'arr', value: 900000, unit: 'usd', period: 'annual' },
          { since: '2026-05-15', text: 'ARR is $1.6M', metric: 'arr', value: 1600000, unit: 'usd', period: 'annual' },
        ],
      },
      {
        entity_slug: 'companies/helix-data',
        rows: [
          { since: '2026-02-08', text: 'ARR is $3.1M', metric: 'arr', value: 3100000, unit: 'usd', period: 'annual' },
          { since: '2026-05-20', text: 'ARR is $4.4M', metric: 'arr', value: 4400000, unit: 'usd', period: 'annual' },
        ],
      },
    ],
    question: 'What was the ARR of Vector Tools in February 2026?',
    gold_answer: '$900K (Vector Tools reading dated 2026-02-01; Helix Data figures are a distractor).',
    gold_markers: ['$900K', '2026-02-01'],
  },
];

// ─── Gates ───────────────────────────────────────────────────────────

export const WAVE_MEAN_MIN_HERMETIC = 0.99;
export const WAVE_MEAN_MIN_LIVE = 0.6;
/** Negative control (rule 5): degraded arm must score <= 0.5x the real one. */
export const NEGATIVE_CONTROL_RATIO = 0.5;

// ─── Models ──────────────────────────────────────────────────────────

const THINK_MODEL = process.env.CAT25_MODEL ?? 'claude-sonnet-4-6';
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
export const THINK_TEMPERATURE = 0;

// ─── Paths ───────────────────────────────────────────────────────────

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTS_ROOT = join(RUNNER_DIR, '..', 'reports');
const DUMPS_DIR = join(REPORTS_ROOT, CATEGORY);

// ─── Gateway + deterministic hash-embed transport ────────────────────
// Embeddings are scaffolding (routing is under test, not retrieval quality).
// No OpenAI key is required: the gateway's embed transport is replaced with
// a deterministic token-bag hash embedding in BOTH modes.

const EMBED_DIMS = 1536;

export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIMS).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    const h = createHash('sha256').update(tok).digest();
    const idx = h.readUInt32BE(0) % EMBED_DIMS;
    vec[idx] += (h[4]! & 1) === 0 ? 1 : -1;
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

let gatewayReady = false;
export function ensureStubbedGateway(): void {
  if (gatewayReady) return;
  // ai-sdk model construction needs a non-empty key even when the transport
  // is stubbed; the dummy never reaches the network.
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'dummy-embed-transport-stubbed';
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: EMBED_DIMS,
    env: process.env as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests(
    hashEmbedTransport as unknown as Parameters<typeof __setEmbedTransportForTests>[0],
  );
  gatewayReady = true;
}

// ─── Brain seeding ───────────────────────────────────────────────────
// WS5: search mode + reranker + expansion pinned explicitly BEFORE ingest —
// never rely on gbrain defaults ('balanced' silently enables the zerank-2
// reranker when ZEROENTROPY_API_KEY is set). Echoed into resolved_config.

const SEARCH_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.cache.enabled': 'false',
};

/** Renders the LEGACY (pre-fix) bare markdown facts table. Test-only seam:
 *  regression tests seed through this broken path to prove the preflight
 *  gate catches facts that never reach the facts table (finding cats22-25-01). */
export function legacyFactsTable(rows: SeedFact[]): string {
  const lines = [
    '## Facts',
    '',
    '| since | claim | metric | value | unit | period |',
    '|-------|-------|--------|-------|------|--------|',
    ...rows.map(r => `| ${r.since} | ${r.text} | ${r.metric} | ${r.value} | ${r.unit} | ${r.period} |`),
  ];
  return lines.join('\n');
}

export interface SeedOptions {
  /** Default true: seed typed-claim rows via engine.insertFact (the fix).
   *  false = legacy broken path (bare markdown table only) for regression tests. */
  seedFactsViaInsert?: boolean;
  /** Test seam: extra engine mutation after seeding (e.g. kill switches). */
  configureEngine?: (engine: PGLiteEngine) => Promise<void>;
}

export async function seedProbeEngine(probe: Probe, opts: SeedOptions = {}): Promise<PGLiteEngine> {
  ensureStubbedGateway();
  const seedViaInsert = opts.seedFactsViaInsert !== false;
  const engine = new PGLiteEngine();
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await engine.connect({});
    await engine.initSchema();
    for (const [key, value] of Object.entries(SEARCH_CONFIG)) {
      await engine.setConfig(key, value);
    }
    await engine.setConfig('models.think', THINK_MODEL);

    for (const p of probe.pages) {
      const factsForPage = probe.facts.find(f => f.entity_slug === p.slug);
      const body = seedViaInsert || !factsForPage
        ? p.body
        : `${p.body}\n${legacyFactsTable(factsForPage.rows)}\n`;
      await importFromContent(engine, p.slug, body, { noEmbed: false });
    }

    if (seedViaInsert) {
      for (const group of probe.facts) {
        for (const row of group.rows) {
          await engine.insertFact(
            {
              fact: row.text,
              kind: 'fact',
              entity_slug: group.entity_slug,
              valid_from: new Date(`${row.since}T00:00:00Z`),
              source: 'eval:cat25-seed',
              claim_metric: row.metric,
              claim_value: row.value,
              claim_unit: row.unit,
              claim_period: row.period,
            },
            { source_id: 'default' },
          );
        }
      }
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  if (opts.configureEngine) await opts.configureEngine(engine);
  return engine;
}

/** Preflight: trajectory points visible for the probe's PRIMARY entity via the
 *  same engine API runThink uses. 0 points = the seed never reached the facts
 *  table = the A/B would be same-vs-same → the run must abort. */
export async function preflightTrajectoryPoints(engine: PGLiteEngine, probe: Probe): Promise<number> {
  const points = await engine.findTrajectory({
    entitySlug: probe.entity_slug,
    kind: 'all',
    remote: false,
  });
  return points.length;
}

// ─── Think client (capture + injected completion) ────────────────────

interface CapturedPrompts {
  baseline?: { system: string; user: string };
  wave?: { system: string; user: string };
}

export type CompleteFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  extracted: { system: string; user: string },
) => Promise<string>;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('');
  }
  return '';
}

function messageOf(text: string, model: unknown): Anthropic.Message {
  return {
    id: 'cat25-injected',
    type: 'message',
    role: 'assistant',
    model: String(model),
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function makeCapturingClient(
  arm: 'baseline' | 'wave',
  complete: CompleteFn,
  captured: CapturedPrompts,
): ThinkLLMClient {
  return {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      const system = extractText(params.system);
      const user = params.messages.map(m => extractText(m.content)).join('\n');
      captured[arm] = { system, user };
      const text = await complete(params, { system, user });
      return messageOf(text, params.model);
    },
  } as unknown as ThinkLLMClient;
}

// ─── Hermetic actor ──────────────────────────────────────────────────
// Deterministic stand-in for the synthesis model. Blind to the arm and to
// gold markers: it conditions ONLY on the prompt gbrain assembled. When a
// <trajectory> block was delivered it echoes the block (real consumption of
// the injected data); otherwise it truthfully reports having no dated
// readings. A broken trajectory wire therefore fails the wave gate.

const TRAJECTORY_BLOCK_RX = /<trajectory [^>]*>[\s\S]*?<\/trajectory>/g;

export const hermeticComplete: CompleteFn = async (_params, extracted) => {
  const blocks = extracted.user.match(TRAJECTORY_BLOCK_RX) ?? [];
  const answer = blocks.length > 0
    ? `Based on the recorded trajectory:\n${blocks.join('\n')}`
    : 'I do not have dated metric readings for that entity, so I cannot anchor an answer to the asked period.';
  return JSON.stringify({ answer, citations: [], gaps: [] });
};

function makeLiveComplete(anthropic: Anthropic): CompleteFn {
  return async (params) => {
    const model = String(params.model).replace(/^anthropic[:/]/, '');
    const res = await anthropic.messages.create({
      model,
      max_tokens: params.max_tokens,
      temperature: THINK_TEMPERATURE,
      ...(params.system !== undefined ? { system: params.system } : {}),
      messages: params.messages,
    });
    const block = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
    return block?.text ?? '';
  };
}

// ─── Judges ──────────────────────────────────────────────────────────

export type ArmJudgeOutcome = { score: number; detail: string } | { judge_failed: string };
export type ArmJudgeFn = (probe: Probe, answer: string) => Promise<ArmJudgeOutcome>;

/** Hermetic: fraction of gold markers present in the answer. Deterministic. */
export const markerJudge: ArmJudgeFn = async (probe, answer) => {
  const hit = probe.gold_markers.filter(m => answer.includes(m)).length;
  return {
    score: probe.gold_markers.length === 0 ? 0 : hit / probe.gold_markers.length,
    detail: `marker judge: ${hit}/${probe.gold_markers.length} gold markers present`,
  };
};

const TEMPORAL_RUBRIC: RubricCriterion[] = [
  { id: 'value_correct', criterion: 'States the value that the dated readings in the ground truth support for the period the question asks about (the most recent reading on or before the asked period; the latest reading for "current" questions). Wrong value, wrong entity, or refusal scores 0.', weight: 2 },
  { id: 'date_anchored', criterion: 'Anchors the answer to the specific reading date it came from (or clearly states the as-of semantics used).', weight: 1 },
];

/** Live: judge.ts scoreAnswer, absolute scoring per arm. The judge sees the
 *  dated readings as world-of-facts — never the gold answer or arm labels. */
function makeScoreAnswerJudge(client?: Anthropic): ArmJudgeFn {
  return async (probe, answer) => {
    const groundTruth = probe.facts.map(group => ({
      slug: group.entity_slug,
      title: `Dated readings — ${group.entity_slug}`,
      content: group.rows
        .map(r => `as of ${r.since}: ${r.text} (${r.metric}=${r.value} ${r.unit}, ${r.period})`)
        .join('\n'),
    }));
    const evidence: JudgeEvidence = {
      schema_version: 1,
      // judge.ts Probe.category is typed for the 5/8/9 rubric era; the value
      // is only rendered into the prompt header (same cast as cat20).
      probe: { id: probe.id, text: probe.question, category: 25 as unknown as 5 },
      final_answer_text: answer,
      evidence_refs: [],
      tool_call_summary: { count_by_tool: { think: 1 }, saw_poison_items: [], made_dry_run_writes: [] },
      ground_truth_pages: groundTruth,
      rubric: TEMPORAL_RUBRIC,
    };
    try {
      const result = await scoreAnswer(evidence, client ? { client, model: JUDGE_MODEL } : { model: JUDGE_MODEL });
      if (result.verdict === 'judge_failed') {
        return { judge_failed: 'scoreAnswer produced malformed output after retry' };
      }
      return { score: result.overall_score / 5, detail: result.overall_rationale };
    } catch (e) {
      return { judge_failed: `scoreAnswer threw: ${errMsg(e)}` };
    }
  };
}

// ─── Probe runner ────────────────────────────────────────────────────

export interface ProbeResult {
  probe_id: string;
  question: string;
  trajectory_points_preflight: number;
  baseline_answer: string;
  wave_answer: string;
  baseline_score: number;
  wave_score: number;
  delta: number;
  wave_trajectory_injected: boolean;
  wave_injected_points: number;
  baseline_block_absent: boolean;
  think_warnings: { baseline: string[]; wave: string[] };
  model_used: { baseline: string; wave: string };
  judge_detail: { baseline: string; wave: string };
  sut_failed?: boolean;
  sut_message?: string;
}

export type ProbeOutcome =
  | { kind: 'result'; result: ProbeResult; sutError?: string }
  | { kind: 'error'; origin: FailureOrigin; message: string }
  | { kind: 'preflight_failed'; message: string };

export interface ProbeRunDeps {
  complete: CompleteFn;
  judge: ArmJudgeFn;
  seed?: SeedOptions;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function injectedPointsOf(warnings: string[]): number {
  for (const w of warnings) {
    const m = /^TRAJECTORY_INJECTED_(\d+)_POINTS$/.exec(w);
    if (m) return Number(m[1]);
  }
  return 0;
}

function zeroResult(probe: Probe, preflightPoints: number, sutMessage: string): ProbeResult {
  return {
    probe_id: probe.id,
    question: probe.question,
    trajectory_points_preflight: preflightPoints,
    baseline_answer: '',
    wave_answer: '',
    baseline_score: 0,
    wave_score: 0,
    delta: 0,
    wave_trajectory_injected: false,
    wave_injected_points: 0,
    baseline_block_absent: false,
    think_warnings: { baseline: [], wave: [] },
    model_used: { baseline: '', wave: '' },
    judge_detail: { baseline: '', wave: '' },
    sut_failed: true,
    sut_message: sutMessage,
  };
}

export async function runProbe(probe: Probe, deps: ProbeRunDeps): Promise<ProbeOutcome> {
  let engine: PGLiteEngine;
  try {
    engine = await seedProbeEngine(probe, deps.seed ?? {});
  } catch (e) {
    return { kind: 'error', origin: 'harness', message: `brain seeding failed: ${errMsg(e)}` };
  }

  try {
    // PREFLIGHT (finding cats22-25-01): the facts MUST be visible through the
    // same engine API runThink's trajectory path reads, or the A/B measures
    // nothing. Abort-worthy, not scorable.
    let preflightPoints: number;
    try {
      preflightPoints = await preflightTrajectoryPoints(engine, probe);
    } catch (e) {
      return { kind: 'error', origin: 'harness', message: `preflight findTrajectory threw: ${errMsg(e)}` };
    }
    if (preflightPoints === 0) {
      return {
        kind: 'preflight_failed',
        message: `probe ${probe.id}: engine.findTrajectory returned 0 points for ${probe.entity_slug} — seeded facts never reached the facts table; the A/B would be same-vs-same`,
      };
    }

    const captured: CapturedPrompts = {};
    let baselineRes: ThinkResult;
    let waveRes: ThinkResult;
    try {
      baselineRes = await runThink(engine, {
        question: probe.question,
        withTrajectory: false,
        client: makeCapturingClient('baseline', deps.complete, captured),
        remote: false,
      });
      waveRes = await runThink(engine, {
        question: probe.question,
        withTrajectory: true,
        client: makeCapturingClient('wave', deps.complete, captured),
        remote: false,
      });
    } catch (e) {
      const msg = `runThink threw: ${errMsg(e)}`;
      return { kind: 'result', result: zeroResult(probe, preflightPoints, msg), sutError: msg };
    }

    // Typed failure classes per probe-accounting policy (finding cats22-25-02:
    // think/judge errors were silently scored 0 into the A/B means).
    for (const [arm, res] of [['baseline', baselineRes], ['wave', waveRes]] as const) {
      const st = res.synthesis_status ?? 'ok';
      if (st === 'llm_error') {
        return { kind: 'error', origin: 'dependency', message: `${arm}: LLM call failed (${res.warnings.join(', ')})` };
      }
      if (st === 'no_llm' || st === 'model_unusable') {
        return { kind: 'error', origin: 'harness', message: `${arm}: synthesis_status=${st} — runner misconfigured` };
      }
      if (st !== 'ok') {
        const msg = `${arm}: synthesis_status=${st} (unusable synthesis output)`;
        return { kind: 'result', result: zeroResult(probe, preflightPoints, msg), sutError: msg };
      }
    }

    // Mechanical wiring checks — the SUT's routing contract.
    const baselineUser = captured.baseline?.user ?? '';
    const waveUser = captured.wave?.user ?? '';
    const waveInjectedPoints = injectedPointsOf(waveRes.warnings);
    const waveBlockPresent = waveUser.includes('<trajectory entity=');
    const baselineBlockAbsent =
      !baselineUser.includes('<trajectory entity=') && injectedPointsOf(baselineRes.warnings) === 0;

    if (!baselineBlockAbsent) {
      const msg = 'baseline arm (withTrajectory:false) received a trajectory block — arms are not isolated';
      return { kind: 'result', result: zeroResult(probe, preflightPoints, msg), sutError: msg };
    }
    if (waveRes.warnings.includes('TRAJECTORY_INJECTION_FAILED')) {
      const msg = 'wave arm: TRAJECTORY_INJECTION_FAILED warning from runThink';
      return { kind: 'result', result: zeroResult(probe, preflightPoints, msg), sutError: msg };
    }
    if (waveInjectedPoints === 0 || !waveBlockPresent) {
      const msg = `wave arm: trajectory data exists (${preflightPoints} points) but runThink did not inject it (injected=${waveInjectedPoints}, block_present=${waveBlockPresent})`;
      return { kind: 'result', result: zeroResult(probe, preflightPoints, msg), sutError: msg };
    }

    // Judge each arm independently. judge_failed → 'judge' origin (excluded).
    const baselineJudged = await deps.judge(probe, baselineRes.answer);
    if ('judge_failed' in baselineJudged) {
      return { kind: 'error', origin: 'judge', message: `baseline: ${baselineJudged.judge_failed}` };
    }
    const waveJudged = await deps.judge(probe, waveRes.answer);
    if ('judge_failed' in waveJudged) {
      return { kind: 'error', origin: 'judge', message: `wave: ${waveJudged.judge_failed}` };
    }

    return {
      kind: 'result',
      result: {
        probe_id: probe.id,
        question: probe.question,
        trajectory_points_preflight: preflightPoints,
        baseline_answer: baselineRes.answer.slice(0, 1200),
        wave_answer: waveRes.answer.slice(0, 1200),
        baseline_score: baselineJudged.score,
        wave_score: waveJudged.score,
        delta: waveJudged.score - baselineJudged.score,
        wave_trajectory_injected: true,
        wave_injected_points: waveInjectedPoints,
        baseline_block_absent: baselineBlockAbsent,
        think_warnings: { baseline: baselineRes.warnings, wave: waveRes.warnings },
        model_used: { baseline: baselineRes.modelUsed, wave: waveRes.modelUsed },
        judge_detail: { baseline: baselineJudged.detail, wave: waveJudged.detail },
      },
    };
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

// ─── Aggregate + gates ───────────────────────────────────────────────

export interface RunSummary {
  mode: 'hermetic' | 'live';
  probes_planned: number;
  probes_scored: number;
  sut_failed: number;
  baseline_mean: number;
  wave_mean: number;
  delta_mean: number;
  wave_wins: number;
  baseline_wins: number;
  ties: number;
  trajectory_injected_rate: number;
  gate: 'pass' | 'fail';
  gate_reasons: string[];
}

export function aggregate(results: ProbeResult[], mode: 'hermetic' | 'live', probesPlanned: number): RunSummary {
  const n = results.length;
  const mean = (f: (r: ProbeResult) => number): number =>
    n === 0 ? NaN : results.reduce((a, r) => a + f(r), 0) / n;
  const baselineMean = mean(r => r.baseline_score);
  const waveMean = mean(r => r.wave_score);
  const deltaMean = mean(r => r.delta);
  const injectedRate = mean(r => (r.wave_trajectory_injected ? 1 : 0));

  const reasons: string[] = [];
  const pct = (x: number): string => Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`;
  if (n === 0) {
    reasons.push('no probes scored — cannot evaluate any gate');
  } else {
    if (injectedRate < 1) {
      reasons.push(`trajectory injected in only ${pct(injectedRate)} of scored probes (must be 100%: data exists per preflight)`);
    }
    const waveMin = mode === 'hermetic' ? WAVE_MEAN_MIN_HERMETIC : WAVE_MEAN_MIN_LIVE;
    if (waveMean < waveMin) {
      reasons.push(`wave_mean ${waveMean.toFixed(2)} < ${waveMin} minimum (${mode})`);
    }
    if (waveMean < baselineMean) {
      reasons.push(`wave_mean ${waveMean.toFixed(2)} < baseline_mean ${baselineMean.toFixed(2)} — trajectory routing loses its own A/B`);
    }
    if (mode === 'hermetic' && baselineMean > NEGATIVE_CONTROL_RATIO * waveMean) {
      reasons.push(`negative control: degraded arm (withTrajectory:false) scored ${baselineMean.toFixed(2)} > ${NEGATIVE_CONTROL_RATIO} × wave ${waveMean.toFixed(2)} — the A/B has no contrast`);
    }
  }

  return {
    mode,
    probes_planned: probesPlanned,
    probes_scored: n,
    sut_failed: results.filter(r => r.sut_failed).length,
    baseline_mean: baselineMean,
    wave_mean: waveMean,
    delta_mean: deltaMean,
    wave_wins: results.filter(r => r.delta > 0).length,
    baseline_wins: results.filter(r => r.delta < 0).length,
    ties: results.filter(r => r.delta === 0).length,
    trajectory_injected_rate: injectedRate,
    gate: reasons.length === 0 ? 'pass' : 'fail',
    gate_reasons: reasons,
  };
}

// ─── Receipt plumbing ────────────────────────────────────────────────

function baseReceipt(startedAt: string): Omit<Receipt, 'run_status' | 'n_total' | 'n_scored' | 'completion_rate' | 'errors' | 'publishable'> {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

function resolvedConfig(hermetic: boolean): Record<string, unknown> {
  return {
    ...SEARCH_CONFIG,
    'models.think': THINK_MODEL,
    think_temperature: THINK_TEMPERATURE,
    judge: hermetic ? 'deterministic-marker-judge' : `judge.ts scoreAnswer (${JUDGE_MODEL}, temperature 0)`,
    embedding_transport: 'stubbed deterministic hash-embed (__setEmbedTransportForTests)',
    fact_seeding: 'engine.insertFact typed-claim rows (direct; extraction is out of boundary)',
    pipeline: "gbrain runThink ('gbrain/think' subpath export), client-injected LLM, remote:false",
    mode: hermetic ? 'hermetic' : 'live',
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const allowSkip = process.argv.includes('--allow-skip');
  const hermetic = process.env.CAT25_DRY_RUN === '1' || process.argv.includes('--hermetic');

  if (!hermetic && !process.env.ANTHROPIC_API_KEY) {
    const reason = 'ANTHROPIC_API_KEY required for a live run (CAT25_DRY_RUN=1 runs the hermetic routing-conformance gate)';
    console.error(`[cat25] SKIP: ${reason}`);
    writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
      ...baseReceipt(startedAt),
      run_status: 'skipped',
      skip_reason: reason,
      n_total: PROBES.length,
      n_scored: 0,
      completion_rate: 0,
      errors: [],
      publishable: false,
      resolved_config: resolvedConfig(hermetic),
    });
    process.exit(allowSkip ? 0 : 3);
  }

  ensureStubbedGateway();
  const anthropic = hermetic ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const deps: ProbeRunDeps = hermetic
    ? { complete: hermeticComplete, judge: markerJudge }
    : { complete: makeLiveComplete(anthropic!), judge: makeScoreAnswerJudge(anthropic!) };

  console.log(`[cat25] ${PROBES.length} probes, mode=${hermetic ? 'hermetic' : 'live'} think=${THINK_MODEL}@t${THINK_TEMPERATURE} judge=${hermetic ? 'marker' : `${JUDGE_MODEL}@t0`}`);

  const acc = new ProbeAccounting(PROBES.length);
  const results: ProbeResult[] = [];

  for (const probe of PROBES) {
    process.stderr.write(`  ${probe.id}... `);
    let outcome: ProbeOutcome;
    try {
      outcome = await runProbe(probe, deps);
    } catch (e) {
      outcome = { kind: 'error', origin: 'harness', message: `runProbe threw: ${errMsg(e)}` };
    }
    if (outcome.kind === 'preflight_failed') {
      // Abort the WHOLE run: a failed preflight means the harness cannot
      // seed trajectory data, so no probe's A/B is meaningful.
      console.error(`\n[cat25] PREFLIGHT ABORT: ${outcome.message}`);
      acc.error(probe.id, 'harness', outcome.message);
      const s = acc.summary();
      writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
        ...baseReceipt(startedAt),
        run_status: 'error',
        n_total: s.n_total,
        n_scored: s.n_scored,
        completion_rate: s.completion_rate,
        errors: s.errors,
        publishable: false,
        resolved_config: resolvedConfig(hermetic),
      });
      process.exit(2);
    }
    if (outcome.kind === 'error') {
      acc.error(probe.id, outcome.origin, outcome.message);
      process.stderr.write(`ERROR(${outcome.origin}): ${outcome.message.slice(0, 140)}\n`);
      continue;
    }
    results.push(outcome.result);
    if (outcome.sutError) {
      acc.error(probe.id, 'sut', outcome.sutError);
      process.stderr.write(`SUT-FAIL: ${outcome.sutError.slice(0, 140)}\n`);
    } else {
      acc.score(probe.id, outcome.result.wave_score);
      process.stderr.write(`baseline=${outcome.result.baseline_score.toFixed(2)} wave=${outcome.result.wave_score.toFixed(2)} injected=${outcome.result.wave_injected_points}pts\n`);
    }
  }

  const summary = aggregate(results, hermetic ? 'hermetic' : 'live', PROBES.length);
  const accSummary = acc.summary();

  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(
    join(DUMPS_DIR, `${new Date().toISOString().slice(0, 10)}-cat25.json`),
    JSON.stringify({ summary, per_probe: results, accounting: accSummary }, null, 2) + '\n',
  );

  if (accSummary.run_invalid) {
    writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
      ...baseReceipt(startedAt),
      run_status: 'error',
      n_total: accSummary.n_total,
      n_scored: accSummary.n_scored,
      completion_rate: accSummary.completion_rate,
      errors: accSummary.errors,
      publishable: false,
      resolved_config: resolvedConfig(hermetic),
      judge: { model: hermetic ? 'deterministic-marker-judge' : JUDGE_MODEL, temperature: 0 },
      data: { summary: summary as unknown as Record<string, unknown> },
    });
    console.error(`[cat25] RUN INVALID: infra error rate ${(accSummary.infra_error_rate * 100).toFixed(0)}% over cap`);
    process.exit(2);
  }

  // Hermetic runs verify routing conformance, not live answer quality — they
  // can never claim a full 'pass'.
  const verdict: ReceiptVerdict = summary.gate === 'fail' ? 'fail' : hermetic ? 'partial' : 'pass';
  writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
    ...baseReceipt(startedAt),
    run_status: 'completed',
    verdict,
    n_total: accSummary.n_total,
    n_scored: accSummary.n_scored,
    completion_rate: accSummary.completion_rate,
    errors: accSummary.errors,
    publishable: accSummary.publishable && !hermetic,
    resolved_config: resolvedConfig(hermetic),
    judge: { model: hermetic ? 'deterministic-marker-judge' : JUDGE_MODEL, temperature: 0 },
    data: {
      summary: summary as unknown as Record<string, unknown>,
      per_probe: results as unknown as Record<string, unknown>[],
      model_used: results.map(r => r.model_used),
    },
  });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`cat25 trajectory routing A/B via gbrain runThink — summary (${summary.mode})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`probes:              ${summary.probes_scored}/${summary.probes_planned} scored (sut_failed=${summary.sut_failed})`);
  console.log(`baseline mean:       ${summary.baseline_mean.toFixed(2)}`);
  console.log(`wave mean:           ${summary.wave_mean.toFixed(2)}`);
  console.log(`delta mean:          ${summary.delta_mean >= 0 ? '+' : ''}${summary.delta_mean.toFixed(2)}`);
  console.log(`wave / base / tie:   ${summary.wave_wins}/${summary.baseline_wins}/${summary.ties}`);
  console.log(`trajectory injected: ${(summary.trajectory_injected_rate * 100).toFixed(0)}% of scored probes`);
  if (accSummary.errors.length > 0) {
    console.log(`errors: ${accSummary.errors.map(e => `${e.probe_id}:${e.origin}`).join(', ')}`);
  }
  console.log('');
  console.log(`gate: ${summary.gate.toUpperCase()}${verdict === 'partial' && summary.gate === 'pass' ? ' (verdict partial: hermetic run)' : ''}`);
  if (summary.gate === 'fail') {
    for (const reason of summary.gate_reasons) console.log(`  ✗ ${reason}`);
    process.exit(1);
  }
  console.log('  ✓ all gates pass');
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[cat25] fatal:', err);
    process.exit(2);
  });
}
