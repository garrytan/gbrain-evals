/**
 * BrainBench Cat 14 — calibration A/B through gbrain's REAL think pipeline.
 *
 * FEATURE BOUNDARY — what is under test vs what is scaffolding:
 *
 *   UNDER TEST: gbrain's production `runThink` pipeline (imported from the
 *     'gbrain/think' subpath export — the public surface behind
 *     `gbrain think`). Both arms run the same code path against the same
 *     seeded brain; the ONLY difference between the arms is the public
 *     `withCalibration` option:
 *       baseline   = runThink(engine, { question, client })
 *       calibrated = runThink(engine, { question, client,
 *                      withCalibration: true, calibrationHolder })
 *     `withCalibration: true` makes runThink fetch the latest
 *     calibration_profiles row via gbrain's getLatestProfile, extend
 *     buildThinkSystemPrompt with the anti-bias rewrite rules, and inject
 *     buildCalibrationBlock into the user message (D22 placement:
 *     retrieval → calibration → question). All of that is gbrain production
 *     code — nothing is mirrored here (audit finding calibration-cats-01:
 *     the previous version hand-rolled a prompt that had drifted from the
 *     shipped one and imported nothing from gbrain).
 *
 *   SEEDED / STUBBED (legitimately):
 *     - Per probe, a fresh in-memory PGLiteEngine seeded with evidence pages
 *       rendered from the probe's resolved_takes and — when the fixture
 *       profile is non-empty — one calibration_profiles row. Search config
 *       is pinned per WS5 BEFORE ingest (search.mode=balanced,
 *       reranker/expansion/cache explicitly off) and echoed into the receipt.
 *     - Embeddings: deterministic hash-embed transport installed via
 *       gbrain's __setEmbedTransportForTests + OPENAI_API_KEY=dummy.
 *       Retrieval quality is NOT under test here; think synthesis is.
 *     - The synthesis LLM is injected through runThink's documented `client`
 *       seam in BOTH modes. The client also captures the exact prompts
 *       gbrain assembled, which powers the mechanical wiring checks
 *       (calibration block present iff a profile was seeded;
 *       behaves_like_baseline's prompts-identical component).
 *         live     — Anthropic messages.create at temperature 0
 *                    (finding calibration-cats-12: no more default temp-1.0
 *                    sampling under an 8-probe gate)
 *         hermetic — a deterministic "ideal actor" that conditions ONLY on
 *                    whether gbrain actually delivered the <calibration>
 *                    block in the prompt it received. If the calibration
 *                    wiring breaks, the actor never sees the block, the
 *                    positive axes fail, and the gate fails. Hermetic mode
 *                    is a failable pipeline-conformance gate, not a stub
 *                    that echoes expectations back.
 *
 * JUDGING:
 *   live     — a BLIND A/B judge (Haiku, temperature 0). The judge sees the
 *              question, the profile's bias tags + pattern statements (needed
 *              to judge relevance), and the two answers under neutral
 *              "Answer A"/"Answer B" labels. It NEVER sees probe notes,
 *              category names, or expected verdicts (finding
 *              calibration-cats-04), and it never learns which answer is
 *              calibrated (finding -13). BOTH presentation orders are judged
 *              and the two verdicts averaged. A judge failure in either
 *              order is a 'judge'-origin probe error (excluded from means,
 *              capped) — never scored as 0.
 *   hermetic — a deterministic string-marker judge over the actor's output.
 *              It cannot judge semantic relevance, so force-fit grading in
 *              hermetic mode uses the fixture's domain ground truth
 *              (expected.mentions_relevant_bias_tag === false ⇒ any bias
 *              mention is a force-fit) on the RUNNER side; the judge itself
 *              stays expectation-free. Documented divergence from live mode.
 *
 * GATES (aligned to eval/data/cat14-calibration/README.md "Pass thresholds";
 * finding calibration-cats-03):
 *   - win rate >= 60% over WIN-ELIGIBLE probes only. Tie-expected categories
 *     (calibration-empty-profile, calibration-bias-irrelevant — probes whose
 *     only correct calibrated behavior is baseline-equivalent output) and
 *     judge-failed probes are excluded from the denominator (finding -05).
 *     win rate < 45% additionally emits the calibration_net_negative doctor
 *     flag.
 *   - mentions_relevant_bias_tag >= 80% and presents_counter_prior >= 80%
 *     over positive-category probes.
 *   - doesnt_force_fit_irrelevant_bias >= 90% over negative-category probes.
 *   - behaves_like_baseline >= 90% over probes declaring it (finding -08:
 *     previously declared + fixture-set but never scored). Actual =
 *     prompts mechanically identical AND judge saw no meaningful divergence.
 *   - voice_conversational >= 95% over ALL probes.
 *   - voice_must_not_be_clinical >= 95% over probes declaring it.
 *
 * Every run writes a Receipt (eval/reports/cat14-calibration/receipt.json).
 * A live run without ANTHROPIC_API_KEY writes run_status:'skipped' and exits
 * non-zero unless invoked with --allow-skip.
 *
 * Run:
 *   bun eval/runner/cat14-calibration.ts                  # live (ANTHROPIC_API_KEY)
 *   CAT14_DRY_RUN=1 bun eval/runner/cat14-calibration.ts  # hermetic conformance run
 *   CAT14_PROBES=cat14-pos-1-geography bun eval/runner/cat14-calibration.ts
 *   bun eval/runner/cat14-calibration.ts --allow-skip     # missing key → skip receipt, exit 0
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { runThink, type ThinkLLMClient, type ThinkResult } from 'gbrain/think';
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

// ─── Fixture types ──────────────────────────────────────────────────

interface ResolvedTake {
  claim: string;
  quality: 'correct' | 'incorrect' | 'partial';
  weight: number;
  domain: string;
  since_date: string;
}

interface CalibrationProfileSeed {
  active_bias_tags: string[];
  pattern_statements: string[];
  grade_completion: number;
  voice_gate_passed: boolean;
}

interface BrainSetup {
  holder: string;
  resolved_takes: ResolvedTake[];
  calibration_profile: CalibrationProfileSeed;
}

interface ProbeExpected {
  mentions_relevant_bias_tag: boolean;
  presents_counter_prior: boolean;
  changes_recommendation_meaningfully: boolean;
  voice_conversational: boolean;
  doesnt_force_fit_irrelevant_bias: boolean;
  behaves_like_baseline?: boolean;
  voice_must_not_be_clinical?: boolean;
}

interface Probe {
  id: string;
  question: string;
  brain_setup: BrainSetup;
  expected: ProbeExpected;
  category: string;
  notes: string;
}

type AxisName = keyof ProbeExpected;

const CORE_AXES: AxisName[] = [
  'mentions_relevant_bias_tag',
  'presents_counter_prior',
  'changes_recommendation_meaningfully',
  'voice_conversational',
  'doesnt_force_fit_irrelevant_bias',
];

const OPTIONAL_AXES: AxisName[] = ['behaves_like_baseline', 'voice_must_not_be_clinical'];

/** Axes a probe declares: 5 core always + optional axes when the fixture sets them. */
function declaredAxes(expected: ProbeExpected): AxisName[] {
  return [...CORE_AXES, ...OPTIONAL_AXES.filter(a => expected[a] !== undefined)];
}

// ─── Category subsets (README "Pass thresholds") ────────────────────

const POSITIVE_CATEGORIES = new Set(['calibration-pattern-relevant', 'calibration-pattern-confidence-boost']);
const NEGATIVE_CATEGORIES = new Set([
  'calibration-empty-profile',
  'calibration-bias-irrelevant',
  'calibration-multi-bias',
  'calibration-voice-stress',
]);
/** Probes whose only correct calibrated behavior is baseline-equivalent output.
 *  Excluded from the win-rate denominator (finding calibration-cats-05). */
const TIE_EXPECTED_CATEGORIES = new Set(['calibration-empty-profile', 'calibration-bias-irrelevant']);

// ─── Gate thresholds (README-documented) ────────────────────────────

const WIN_RATE_MIN = 0.60;
const WIN_RATE_DOCTOR_FLAG = 0.45;
const POSITIVE_AXIS_MIN = 0.80;
const NEGATIVE_AXIS_MIN = 0.90;
const VOICE_AXIS_MIN = 0.95;

// ─── Models + temperature ───────────────────────────────────────────

const THINK_MODEL = process.env.CAT14_MODEL ?? 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.CAT14_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';
/** Answers and judge verdicts are both sampled at temperature 0 (finding -12). */
export const THINK_TEMPERATURE = 0;
export const JUDGE_TEMPERATURE = 0;
const JUDGE_MAX_TOKENS = 700;

// ─── Paths ──────────────────────────────────────────────────────────

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = join(RUNNER_DIR, '..', 'data', 'cat14-calibration', 'probes.jsonl');
const REPORTS_ROOT = join(RUNNER_DIR, '..', 'reports');
const CATEGORY = 'cat14-calibration';
const DUMPS_DIR = join(REPORTS_ROOT, CATEGORY);

function loadProbes(): Probe[] {
  if (!existsSync(PROBES_PATH)) {
    throw new Error(`probes.jsonl not found at ${PROBES_PATH}`);
  }
  const text = readFileSync(PROBES_PATH, 'utf-8');
  const probes: Probe[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    probes.push(JSON.parse(trimmed) as Probe);
  }
  return probes;
}

// ─── Gateway + deterministic hash-embed transport ───────────────────
// Embeddings are scaffolding here (think synthesis is under test). No OpenAI
// key exists in this environment; the gateway's embed transport is replaced
// with a deterministic token-bag hash embedding so ingest + gather run
// hermetically and identically on every run.

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

// ─── Brain seeding ──────────────────────────────────────────────────
// WS5: search mode + reranker pinned explicitly BEFORE ingest — never rely
// on gbrain defaults ('balanced' silently enables the zerank-2 reranker when
// ZEROENTROPY_API_KEY is set). Echoed into the receipt's resolved_config.

const SEARCH_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.cache.enabled': 'false',
};

function takePageContent(probe: Probe, take: ResolvedTake): string {
  return [
    '---',
    'type: note',
    `title: ${JSON.stringify(`Resolved take — ${take.domain}`)}`,
    '---',
    '',
    `# Resolved take — ${take.domain}`,
    '',
    `Claim: "${take.claim}"`,
    `Outcome: ${take.quality} (conviction weight ${take.weight}, recorded ${take.since_date})`,
    `Domain: ${take.domain}`,
    `Holder: ${probe.brain_setup.holder}`,
  ].join('\n');
}

async function seedEngine(probe: Probe): Promise<{ engine: PGLiteEngine; profileSeeded: boolean }> {
  ensureStubbedGateway();
  const engine = new PGLiteEngine();

  // Silence schema + import chatter (same pattern as adapters/gbrain-inline.ts).
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

    for (let i = 0; i < probe.brain_setup.resolved_takes.length; i++) {
      const take = probe.brain_setup.resolved_takes[i]!;
      await importFromContent(engine, `cat14/${probe.id}/take-${i + 1}`, takePageContent(probe, take));
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const prof = probe.brain_setup.calibration_profile;
  const profileSeeded = prof.active_bias_tags.length > 0 || prof.pattern_statements.length > 0;
  if (profileSeeded) {
    // Positional jsonb binds through ::text::jsonb per gbrain's JSONB rule.
    await engine.executeRaw(
      `INSERT INTO calibration_profiles
         (source_id, holder, total_resolved, grade_completion, domain_scorecards,
          pattern_statements, voice_gate_passed, voice_gate_attempts, active_bias_tags, model_id)
       VALUES ('default', $1, $2, $3, $4::text::jsonb, $5, $6, 1, $7, 'cat14-eval-fixture')`,
      [
        probe.brain_setup.holder,
        probe.brain_setup.resolved_takes.length,
        prof.grade_completion,
        JSON.stringify({}),
        prof.pattern_statements,
        prof.voice_gate_passed,
        prof.active_bias_tags,
      ],
    );
  }
  return { engine, profileSeeded };
}

// ─── Think client (capture + injected completion) ───────────────────

interface CapturedPrompts {
  baseline?: { system: string; user: string };
  calibrated?: { system: string; user: string };
}

/** Completion function injected through runThink's documented client seam. */
export type CompleteFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  extracted: { system: string; user: string },
) => Promise<string>;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
  }
  return '';
}

function messageOf(text: string, model: unknown): Anthropic.Message {
  return {
    id: 'cat14-injected',
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
  arm: 'baseline' | 'calibrated',
  complete: CompleteFn,
  captured: CapturedPrompts,
): ThinkLLMClient {
  // Cast: this repo pins its own @anthropic-ai/sdk whose Message type differs
  // cosmetically from the one bundled inside gbrain; the shapes runThink
  // actually reads (content[].text, usage, stop_reason) are identical.
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

// ─── Hermetic actors ────────────────────────────────────────────────
// The actor is a deterministic stand-in for the synthesis model. It only
// sees the prompt gbrain actually built: the ideal actor surfaces the bias
// pattern ONLY when gbrain delivered the <calibration> block, so a broken
// calibration wire fails the positive axes. Sabotage actors exist so the
// regression tests can prove every gate CAN fail on bad behavior.

export type ActorBehavior = (probe: Probe, calibrationBlockPresent: boolean) => string;

export const idealActor: ActorBehavior = (probe, blockPresent) => {
  const exp = probe.expected;
  const tags = probe.brain_setup.calibration_profile.active_bias_tags;
  const lines: string[] = [`Here's how I'd think about it, friend to friend.`];
  if (blockPresent) {
    if (exp.mentions_relevant_bias_tag && tags.length > 0) {
      lines.push(`Worth flagging your own track record here: the ${tags[0]} pattern shows up in exactly this kind of call.`);
    }
    if (exp.presents_counter_prior) {
      lines.push(`Your gut prior says be skeptical; the counter-prior from your track record says that skepticism has repeatedly missed.`);
    }
  }
  const changed = blockPresent && exp.changes_recommendation_meaningfully;
  lines.push(`RECOMMENDATION: ${changed ? 'lean in — adjusted for your track record' : 'hold steady on the fundamentals'}`);
  return lines.join('\n');
};

/** Sabotage: force-fits a bias mention whenever a calibration block exists. */
export const forceFitActor: ActorBehavior = (probe, blockPresent) => {
  const tags = probe.brain_setup.calibration_profile.active_bias_tags;
  const lines: string[] = [`Here's how I'd think about it.`];
  if (blockPresent && tags.length > 0) {
    lines.push(`Remember your ${tags[0]} pattern — it applies to everything, including this.`);
  }
  lines.push(`RECOMMENDATION: hold steady on the fundamentals`);
  return lines.join('\n');
};

/** Sabotage: leaks clinical calibration language into the answer. */
export const clinicalActor: ActorBehavior = (probe, blockPresent) => {
  const base = idealActor(probe, blockPresent);
  return `${base}\nFor reference, your Brier score in this domain is 0.31, a statistically significant miscalibration.`;
};

export function makeHermeticComplete(probe: Probe, behavior: ActorBehavior = idealActor): CompleteFn {
  return async (_params, extracted) => {
    const blockPresent = extracted.user.includes('<calibration ');
    return JSON.stringify({ answer: behavior(probe, blockPresent), citations: [], gaps: [] });
  };
}

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

// ─── Judge ──────────────────────────────────────────────────────────

type Win = 'calibrated' | 'baseline' | 'tie';

export type JudgeView =
  | {
      kind: 'llm';
      cal_mentions_relevant_bias: boolean;
      cal_mentions_irrelevant_bias: boolean;
      cal_presents_counter_prior: boolean;
      cal_voice_conversational: boolean;
      cal_clinical_phrasing: boolean;
      answers_differ_meaningfully: boolean;
      win: Win;
      rationale: string;
    }
  | {
      kind: 'heuristic';
      cal_mentions_any_bias: boolean;
      cal_presents_counter_prior: boolean;
      cal_voice_conversational: boolean;
      cal_clinical_phrasing: boolean;
      answers_differ_meaningfully: boolean;
      win: Win;
      rationale: string;
    };

export type JudgeOutcome = { views: JudgeView[] } | { judge_failed: string };
export type JudgeFn = (probe: Probe, baselineAnswer: string, calibratedAnswer: string) => Promise<JudgeOutcome>;

const CLINICAL_RE = /brier|posterior probability|statistically significant|standard deviation/i;

export function heuristicView(probe: Probe, baselineAnswer: string, calibratedAnswer: string): JudgeView {
  const tags = probe.brain_setup.calibration_profile.active_bias_tags;
  const mentions = tags.some(t => calibratedAnswer.includes(t));
  const counter = /counter-prior/i.test(calibratedAnswer);
  const clinical = CLINICAL_RE.test(calibratedAnswer);
  const rec = (s: string): string => /RECOMMENDATION:\s*(.+)/i.exec(s)?.[1]?.trim() ?? '';
  const differ = rec(calibratedAnswer) !== rec(baselineAnswer);
  const win: Win = mentions || counter || differ ? 'calibrated' : 'tie';
  return {
    kind: 'heuristic',
    cal_mentions_any_bias: mentions,
    cal_presents_counter_prior: counter,
    cal_voice_conversational: !clinical,
    cal_clinical_phrasing: clinical,
    answers_differ_meaningfully: differ,
    win,
    rationale: 'heuristic string-marker judge (hermetic mode; single symmetric order)',
  };
}

export const heuristicJudge: JudgeFn = async (probe, baselineAnswer, calibratedAnswer) => ({
  views: [heuristicView(probe, baselineAnswer, calibratedAnswer)],
});

/**
 * Blind judge prompt. Deliberately EXCLUDES probe.notes, probe.category,
 * expected.* values, and any calibrated/baseline labeling (findings -04/-13).
 * The profile itself is included because relevance judgment requires it.
 */
export function buildJudgePrompts(
  probe: Probe,
  answerA: string,
  answerB: string,
): { system: string; user: string } {
  const prof = probe.brain_setup.calibration_profile;
  const system = `You are a blind A/B judge for answer quality. You will see a question a user asked their personal knowledge assistant, the user's calibration profile (bias patterns extracted from their resolved prediction track record), and two candidate answers labeled Answer A and Answer B. You do NOT know which system produced which answer; evaluate each answer on its own merits, then compare.

Definitions:
- "mentions a relevant bias": the answer references one of the profile's bias patterns/tags AND that pattern is semantically relevant to the question's domain.
- "mentions an irrelevant bias": the answer references a profile bias pattern that does NOT semantically fit the question's domain (a force-fit).
- "presents a counter-prior": the answer names BOTH the user's gut prior AND a counter-consideration drawn from their track record.
- "conversational voice": friend-not-doctor language throughout.
- "clinical phrasing": raw statistics jargon aimed at the user (e.g. quoting a Brier score without translation).

Score conservatively. Force-fitting an irrelevant bias is worse than missing a relevant one. Call the answers meaningfully different only when the substance of the recommendation differs, not mere wording. Return your evaluation via the judge_ab tool only.`;
  const user = `Question: ${probe.question}

Calibration profile:
- Active bias tags: ${prof.active_bias_tags.join(', ') || '(none)'}
- Pattern statements: ${prof.pattern_statements.join(' | ') || '(none)'}

[ANSWER A]
${answerA}

[ANSWER B]
${answerB}

Evaluate via the judge_ab tool.`;
  return { system, user };
}

const JUDGE_TOOL: Anthropic.Messages.Tool = {
  name: 'judge_ab',
  description: 'Blind evaluation of two candidate answers (A and B) to the same question.',
  input_schema: {
    type: 'object',
    properties: {
      a_mentions_relevant_bias: { type: 'boolean', description: 'Answer A references a profile bias pattern that IS semantically relevant to the question domain.' },
      a_mentions_irrelevant_bias: { type: 'boolean', description: 'Answer A references a profile bias pattern that does NOT fit the question domain (force-fit).' },
      a_presents_counter_prior: { type: 'boolean', description: 'Answer A names both the gut prior and a track-record counter-prior.' },
      a_voice_conversational: { type: 'boolean', description: 'Answer A keeps friend-not-doctor voice throughout.' },
      a_clinical_phrasing: { type: 'boolean', description: 'Answer A uses clinical statistics jargon aimed at the user.' },
      b_mentions_relevant_bias: { type: 'boolean', description: 'Same as above, for Answer B.' },
      b_mentions_irrelevant_bias: { type: 'boolean', description: 'Same as above, for Answer B.' },
      b_presents_counter_prior: { type: 'boolean', description: 'Same as above, for Answer B.' },
      b_voice_conversational: { type: 'boolean', description: 'Same as above, for Answer B.' },
      b_clinical_phrasing: { type: 'boolean', description: 'Same as above, for Answer B.' },
      answers_differ_meaningfully: { type: 'boolean', description: 'The substance of the two recommendations differs (not mere wording).' },
      more_useful: { type: 'string', enum: ['A', 'B', 'tie'], description: 'Which answer is more useful to this user? Prefer genuine, relevant track-record signal; penalize force-fit and clinical framing. Use tie when substantively equivalent.' },
      rationale: { type: 'string', description: '3-5 plain-English sentences explaining the booleans and the preference.' },
    },
    required: [
      'a_mentions_relevant_bias', 'a_mentions_irrelevant_bias', 'a_presents_counter_prior',
      'a_voice_conversational', 'a_clinical_phrasing',
      'b_mentions_relevant_bias', 'b_mentions_irrelevant_bias', 'b_presents_counter_prior',
      'b_voice_conversational', 'b_clinical_phrasing',
      'answers_differ_meaningfully', 'more_useful', 'rationale',
    ],
  },
};

export interface JudgeToolOut {
  a_mentions_relevant_bias: boolean;
  a_mentions_irrelevant_bias: boolean;
  a_presents_counter_prior: boolean;
  a_voice_conversational: boolean;
  a_clinical_phrasing: boolean;
  b_mentions_relevant_bias: boolean;
  b_mentions_irrelevant_bias: boolean;
  b_presents_counter_prior: boolean;
  b_voice_conversational: boolean;
  b_clinical_phrasing: boolean;
  answers_differ_meaningfully: boolean;
  more_useful: 'A' | 'B' | 'tie';
  rationale: string;
}

function validateJudgeToolOut(input: unknown): JudgeToolOut | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const bools = [
    'a_mentions_relevant_bias', 'a_mentions_irrelevant_bias', 'a_presents_counter_prior',
    'a_voice_conversational', 'a_clinical_phrasing',
    'b_mentions_relevant_bias', 'b_mentions_irrelevant_bias', 'b_presents_counter_prior',
    'b_voice_conversational', 'b_clinical_phrasing',
    'answers_differ_meaningfully',
  ];
  for (const k of bools) {
    if (typeof o[k] !== 'boolean') return null;
  }
  if (o.more_useful !== 'A' && o.more_useful !== 'B' && o.more_useful !== 'tie') return null;
  if (typeof o.rationale !== 'string') return null;
  return o as unknown as JudgeToolOut;
}

/** Map a blind tool output back to calibrated-answer semantics. */
export function mapJudgeOutputToView(out: JudgeToolOut, calibratedIs: 'A' | 'B'): JudgeView {
  const p = calibratedIs === 'A' ? 'a' : 'b';
  const g = (field: string): boolean => (out as unknown as Record<string, boolean>)[`${p}_${field}`]!;
  const win: Win = out.more_useful === 'tie' ? 'tie' : out.more_useful === calibratedIs ? 'calibrated' : 'baseline';
  return {
    kind: 'llm',
    cal_mentions_relevant_bias: g('mentions_relevant_bias'),
    cal_mentions_irrelevant_bias: g('mentions_irrelevant_bias'),
    cal_presents_counter_prior: g('presents_counter_prior'),
    cal_voice_conversational: g('voice_conversational'),
    cal_clinical_phrasing: g('clinical_phrasing'),
    answers_differ_meaningfully: out.answers_differ_meaningfully,
    win,
    rationale: out.rationale,
  };
}

function makeLiveJudge(anthropic: Anthropic): JudgeFn {
  return async (probe, baselineAnswer, calibratedAnswer) => {
    const views: JudgeView[] = [];
    // Both presentation orders, averaged (finding -13). Order 0: calibrated
    // is Answer B; order 1: calibrated is Answer A.
    for (const calibratedIs of ['B', 'A'] as const) {
      const [answerA, answerB] = calibratedIs === 'A'
        ? [calibratedAnswer, baselineAnswer]
        : [baselineAnswer, calibratedAnswer];
      const { system, user } = buildJudgePrompts(probe, answerA, answerB);
      let out: JudgeToolOut | null = null;
      let lastErr = 'malformed tool output';
      for (let attempt = 1; attempt <= 2 && !out; attempt++) {
        try {
          const res = await anthropic.messages.create({
            model: JUDGE_MODEL,
            max_tokens: JUDGE_MAX_TOKENS,
            temperature: JUDGE_TEMPERATURE,
            system,
            tools: [JUDGE_TOOL],
            tool_choice: { type: 'tool', name: 'judge_ab' },
            messages: [{ role: 'user', content: user }],
          });
          const toolUse = res.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
          out = toolUse && toolUse.name === 'judge_ab' ? validateJudgeToolOut(toolUse.input) : null;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      if (!out) {
        return { judge_failed: `judge failed for order calibrated=${calibratedIs} after retry: ${lastErr}` };
      }
      views.push(mapJudgeOutputToView(out, calibratedIs));
    }
    return { views };
  };
}

// ─── Grading ────────────────────────────────────────────────────────

export interface AxisScore {
  axis: AxisName;
  expected: boolean;
  actual_by_order: boolean[];
  /** Mean over judged orders of (expected === actual): 0, 0.5, or 1. */
  score: number;
  outcome: 'pass' | 'fail' | 'split';
  rationale: string;
}

export interface ProbeResult {
  probe_id: string;
  category: string;
  question: string;
  baseline_answer: string;
  calibrated_answer: string;
  prompts_identical: boolean;
  calibration_block_present: boolean;
  think_warnings: { baseline: string[]; calibrated: string[] };
  scores: AxisScore[];
  /** Mean over orders: calibrated=1, tie=0.5, baseline=0. */
  win_score: number;
  win_overall: Win;
  win_eligible: boolean;
  judge_orders: number;
  per_axis_pass_rate: number;
  failure_modes: string[];
  sut_failed?: boolean;
}

function axisActual(axis: AxisName, probe: Probe, view: JudgeView, promptsIdentical: boolean): boolean {
  switch (axis) {
    case 'mentions_relevant_bias_tag':
      return view.kind === 'llm' ? view.cal_mentions_relevant_bias : view.cal_mentions_any_bias;
    case 'presents_counter_prior':
      return view.cal_presents_counter_prior;
    case 'changes_recommendation_meaningfully':
      return view.answers_differ_meaningfully;
    case 'voice_conversational':
      return view.cal_voice_conversational;
    case 'doesnt_force_fit_irrelevant_bias':
      // Live judge decides relevance semantically. The hermetic judge cannot,
      // so hermetic grading uses the fixture's domain ground truth: on probes
      // where the fixture says no bias is relevant, ANY mention is a force-fit.
      return view.kind === 'llm'
        ? !view.cal_mentions_irrelevant_bias
        : !(view.cal_mentions_any_bias && probe.expected.mentions_relevant_bias_tag === false);
    case 'behaves_like_baseline':
      return promptsIdentical && !view.answers_differ_meaningfully;
    case 'voice_must_not_be_clinical':
      return !view.cal_clinical_phrasing;
  }
}

export function gradeProbe(
  probe: Probe,
  views: JudgeView[],
  promptsIdentical: boolean,
): Pick<ProbeResult, 'scores' | 'win_score' | 'win_overall' | 'per_axis_pass_rate' | 'failure_modes'> {
  const scores: AxisScore[] = [];
  for (const axis of declaredAxes(probe.expected)) {
    const expected = probe.expected[axis] === true;
    const actuals = views.map(v => axisActual(axis, probe, v, promptsIdentical));
    const score = actuals.reduce((acc, a) => acc + (a === expected ? 1 : 0), 0) / actuals.length;
    scores.push({
      axis,
      expected,
      actual_by_order: actuals,
      score,
      outcome: score === 1 ? 'pass' : score === 0 ? 'fail' : 'split',
      rationale: views.map(v => v.rationale).join(' || '),
    });
  }
  const winScore = views.reduce((acc, v) => acc + (v.win === 'calibrated' ? 1 : v.win === 'tie' ? 0.5 : 0), 0) / views.length;
  const winOverall: Win = winScore > 0.5 ? 'calibrated' : winScore < 0.5 ? 'baseline' : 'tie';
  const perAxis = scores.length > 0 ? scores.reduce((a, s) => a + s.score, 0) / scores.length : 0;
  return {
    scores,
    win_score: winScore,
    win_overall: winOverall,
    per_axis_pass_rate: perAxis,
    failure_modes: scores.filter(s => s.outcome !== 'pass').map(s => s.axis as string),
  };
}

function zeroResult(probe: Probe, sutMessage: string): ProbeResult {
  return {
    probe_id: probe.id,
    category: probe.category,
    question: probe.question,
    baseline_answer: '',
    calibrated_answer: '',
    prompts_identical: false,
    calibration_block_present: false,
    think_warnings: { baseline: [], calibrated: [] },
    scores: declaredAxes(probe.expected).map(axis => ({
      axis,
      expected: probe.expected[axis] === true,
      actual_by_order: [],
      score: 0,
      outcome: 'fail' as const,
      rationale: `sut_error: ${sutMessage}`,
    })),
    win_score: 0,
    win_overall: 'baseline',
    win_eligible: !TIE_EXPECTED_CATEGORIES.has(probe.category),
    judge_orders: 0,
    per_axis_pass_rate: 0,
    failure_modes: ['sut_error'],
    sut_failed: true,
  };
}

// ─── Probe runner ───────────────────────────────────────────────────

export interface ProbeRunDeps {
  complete: CompleteFn;
  judge: JudgeFn;
}

export type ProbeOutcome =
  | { kind: 'result'; result: ProbeResult; sutError?: string }
  | { kind: 'error'; origin: FailureOrigin; message: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runProbe(probe: Probe, deps: ProbeRunDeps): Promise<ProbeOutcome> {
  let engine: PGLiteEngine;
  let profileSeeded: boolean;
  try {
    ({ engine, profileSeeded } = await seedEngine(probe));
  } catch (e) {
    return { kind: 'error', origin: 'harness', message: `brain seeding failed: ${errMsg(e)}` };
  }

  try {
    const captured: CapturedPrompts = {};
    let baselineRes: ThinkResult;
    let calibratedRes: ThinkResult;
    try {
      baselineRes = await runThink(engine, {
        question: probe.question,
        client: makeCapturingClient('baseline', deps.complete, captured),
        remote: false,
      });
      calibratedRes = await runThink(engine, {
        question: probe.question,
        client: makeCapturingClient('calibrated', deps.complete, captured),
        withCalibration: true,
        calibrationHolder: probe.brain_setup.holder,
        remote: false,
      });
    } catch (e) {
      const msg = `runThink threw: ${errMsg(e)}`;
      return { kind: 'result', result: zeroResult(probe, msg), sutError: msg };
    }

    // Typed failure classes per probe-accounting policy.
    for (const [arm, res] of [['baseline', baselineRes], ['calibrated', calibratedRes]] as const) {
      const st = res.synthesis_status ?? 'ok';
      if (st === 'llm_error') {
        return { kind: 'error', origin: 'dependency', message: `${arm}: LLM call failed (${res.warnings.join(', ')})` };
      }
      if (st === 'no_llm' || st === 'model_unusable') {
        return { kind: 'error', origin: 'harness', message: `${arm}: synthesis_status=${st} — runner misconfigured` };
      }
      if (st !== 'ok') {
        const msg = `${arm}: synthesis_status=${st} (unusable synthesis output)`;
        return { kind: 'result', result: zeroResult(probe, msg), sutError: msg };
      }
    }

    // Mechanical calibration-wiring checks — these are the SUT's contract.
    const baselineUser = captured.baseline?.user ?? '';
    const calibratedUser = captured.calibrated?.user ?? '';
    const blockPresent = calibratedUser.includes('<calibration ');
    if (baselineUser.includes('<calibration ')) {
      const msg = 'baseline prompt contains a <calibration> block (arms are not isolated)';
      return { kind: 'result', result: zeroResult(probe, msg), sutError: msg };
    }
    if (profileSeeded && !blockPresent) {
      const msg = 'calibration profile seeded but <calibration> block missing from calibrated prompt';
      return { kind: 'result', result: zeroResult(probe, msg), sutError: msg };
    }
    if (!profileSeeded && blockPresent) {
      const msg = 'no calibration profile seeded but calibrated prompt contains a <calibration> block';
      return { kind: 'result', result: zeroResult(probe, msg), sutError: msg };
    }
    if (!profileSeeded && !calibratedRes.warnings.includes('NO_CALIBRATION_PROFILE')) {
      const msg = 'cold-brain probe: expected NO_CALIBRATION_PROFILE warning from runThink';
      return { kind: 'result', result: zeroResult(probe, msg), sutError: msg };
    }

    const promptsIdentical =
      captured.baseline?.system === captured.calibrated?.system &&
      captured.baseline?.user === captured.calibrated?.user;

    const judged = await deps.judge(probe, baselineRes.answer, calibratedRes.answer);
    if ('judge_failed' in judged) {
      return { kind: 'error', origin: 'judge', message: judged.judge_failed };
    }

    const graded = gradeProbe(probe, judged.views, promptsIdentical);
    return {
      kind: 'result',
      result: {
        probe_id: probe.id,
        category: probe.category,
        question: probe.question,
        baseline_answer: baselineRes.answer,
        calibrated_answer: calibratedRes.answer,
        prompts_identical: promptsIdentical,
        calibration_block_present: blockPresent,
        think_warnings: { baseline: baselineRes.warnings, calibrated: calibratedRes.warnings },
        win_eligible: !TIE_EXPECTED_CATEGORIES.has(probe.category),
        judge_orders: judged.views.length,
        ...graded,
      },
    };
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

// ─── Aggregate + gates ──────────────────────────────────────────────

interface AxisRate {
  rate: number;
  n: number;
  subset: string;
}

export interface RunSummary {
  mode: 'hermetic' | 'live';
  total_probes: number;
  scored_probes: number;
  judge_failed: number;
  sut_failed: number;
  win_eligible_n: number;
  win_rate_calibrated: number;
  win_rate_baseline: number;
  win_rate_tie: number;
  per_axis: Record<string, AxisRate>;
  failure_mode_counts: Record<string, number>;
  doctor_flags: string[];
  gate: 'pass' | 'fail';
  gate_reasons: string[];
  provenance?: Record<string, unknown>;
}

function axisRate(results: ProbeResult[], axis: AxisName, subset: (r: ProbeResult) => boolean, subsetName: string): AxisRate {
  const rows = results.filter(r => subset(r) && r.scores.some(s => s.axis === axis));
  const n = rows.length;
  const rate = n === 0 ? NaN : rows.reduce((a, r) => a + (r.scores.find(s => s.axis === axis)?.score ?? 0), 0) / n;
  return { rate, n, subset: subsetName };
}

export function aggregate(
  results: ProbeResult[],
  opts: { mode: 'hermetic' | 'live'; judgeFailed?: number },
): RunSummary {
  const judgeFailed = opts.judgeFailed ?? 0;
  const sutFailed = results.filter(r => r.sut_failed).length;

  // Win rate over win-eligible scored probes only (finding -05): tie-expected
  // categories excluded; judge failures excluded (they never reach results[]);
  // sut-failed eligible probes stay in the denominator as non-wins.
  const eligible = results.filter(r => r.win_eligible);
  const winCal = eligible.filter(r => r.win_overall === 'calibrated').length;
  const winBase = eligible.filter(r => r.win_overall === 'baseline').length;
  const winTie = eligible.filter(r => r.win_overall === 'tie').length;
  const winRate = eligible.length > 0 ? winCal / eligible.length : NaN;

  const perAxis: Record<string, AxisRate> = {
    mentions_relevant_bias_tag: axisRate(results, 'mentions_relevant_bias_tag', r => POSITIVE_CATEGORIES.has(r.category), 'positive'),
    presents_counter_prior: axisRate(results, 'presents_counter_prior', r => POSITIVE_CATEGORIES.has(r.category), 'positive'),
    changes_recommendation_meaningfully: axisRate(results, 'changes_recommendation_meaningfully', () => true, 'all'),
    voice_conversational: axisRate(results, 'voice_conversational', () => true, 'all'),
    doesnt_force_fit_irrelevant_bias: axisRate(results, 'doesnt_force_fit_irrelevant_bias', r => NEGATIVE_CATEGORIES.has(r.category), 'negative'),
    behaves_like_baseline: axisRate(results, 'behaves_like_baseline', () => true, 'declaring'),
    voice_must_not_be_clinical: axisRate(results, 'voice_must_not_be_clinical', () => true, 'declaring'),
  };

  const failureModes: Record<string, number> = {};
  for (const r of results) {
    for (const mode of r.failure_modes) {
      failureModes[mode] = (failureModes[mode] ?? 0) + 1;
    }
  }

  const reasons: string[] = [];
  const doctorFlags: string[] = [];
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

  if (eligible.length === 0) {
    reasons.push('win_rate: no win-eligible probes scored (cannot evaluate the >=60% gate)');
  } else {
    if (winRate < WIN_RATE_MIN) reasons.push(`win_rate ${pct(winRate)} < ${pct(WIN_RATE_MIN)} target (over ${eligible.length} win-eligible probes)`);
    if (winRate < WIN_RATE_DOCTOR_FLAG) doctorFlags.push('calibration_net_negative');
  }

  const gateAxis = (axis: string, min: number): void => {
    const a = perAxis[axis]!;
    if (a.n === 0) {
      reasons.push(`${axis}: no scored probes in ${a.subset} subset (cannot evaluate the >=${pct(min)} gate)`);
    } else if (a.rate < min) {
      reasons.push(`${axis} ${pct(a.rate)} < ${pct(min)} target (${a.subset} subset, n=${a.n})`);
    }
  };
  gateAxis('mentions_relevant_bias_tag', POSITIVE_AXIS_MIN);
  gateAxis('presents_counter_prior', POSITIVE_AXIS_MIN);
  gateAxis('doesnt_force_fit_irrelevant_bias', NEGATIVE_AXIS_MIN);
  gateAxis('behaves_like_baseline', NEGATIVE_AXIS_MIN);
  gateAxis('voice_conversational', VOICE_AXIS_MIN);
  gateAxis('voice_must_not_be_clinical', VOICE_AXIS_MIN);

  return {
    mode: opts.mode,
    total_probes: results.length + judgeFailed,
    scored_probes: results.length,
    judge_failed: judgeFailed,
    sut_failed: sutFailed,
    win_eligible_n: eligible.length,
    win_rate_calibrated: winRate,
    win_rate_baseline: eligible.length > 0 ? winBase / eligible.length : NaN,
    win_rate_tie: eligible.length > 0 ? winTie / eligible.length : NaN,
    per_axis: perAxis,
    failure_mode_counts: failureModes,
    doctor_flags: doctorFlags,
    gate: reasons.length === 0 ? 'pass' : 'fail',
    gate_reasons: reasons,
  };
}

// ─── Dumps + receipt ────────────────────────────────────────────────

function writeDump(result: ProbeResult): void {
  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(join(DUMPS_DIR, `${result.probe_id}.json`), JSON.stringify(result, null, 2));
}

function probesHash(): string {
  try {
    return createHash('sha256').update(readFileSync(PROBES_PATH)).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

function baseReceipt(startedAt: string): Omit<Receipt, 'run_status' | 'n_total' | 'n_scored' | 'completion_rate' | 'errors' | 'publishable'> {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    gbrain_version: gbrainVersion(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    hashes: { probes_jsonl: probesHash() },
  };
}

function resolvedConfig(hermetic: boolean, filter: string | null): Record<string, unknown> {
  return {
    ...SEARCH_CONFIG,
    'models.think': THINK_MODEL,
    think_temperature: THINK_TEMPERATURE,
    judge_model: hermetic ? 'heuristic-string-judge' : JUDGE_MODEL,
    judge_temperature: JUDGE_TEMPERATURE,
    judge_orders: hermetic ? 1 : 2,
    embedding_transport: 'stubbed deterministic hash-embed (__setEmbedTransportForTests)',
    pipeline: "gbrain runThink ('gbrain/think' subpath export), client-injected LLM",
    mode: hermetic ? 'hermetic' : 'live',
    probe_filter: filter,
  };
}

function writeSkipReceipt(startedAt: string, reason: string, nTotal: number, hermetic: boolean, filter: string | null): void {
  writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
    ...baseReceipt(startedAt),
    run_status: 'skipped',
    skip_reason: reason,
    n_total: nTotal,
    n_scored: 0,
    completion_rate: 0,
    errors: [],
    publishable: false,
    resolved_config: resolvedConfig(hermetic, filter),
  });
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const allowSkip = process.argv.includes('--allow-skip');
  const hermetic = process.env.CAT14_DRY_RUN === '1' || process.argv.includes('--hermetic');
  const filter = process.env.CAT14_PROBES ?? null;

  const probes = loadProbes();
  const filtered = filter ? probes.filter(p => filter.split(',').includes(p.id)) : probes;

  if (filtered.length === 0) {
    console.error(`[cat14] no probes matched filter: ${filter}`);
    writeSkipReceipt(startedAt, `probe filter matched nothing: ${filter}`, 0, hermetic, filter);
    process.exit(2);
  }

  if (!hermetic && !process.env.ANTHROPIC_API_KEY) {
    const reason = 'ANTHROPIC_API_KEY required for a live run (CAT14_DRY_RUN=1 runs the hermetic pipeline-conformance gate)';
    console.error(`[cat14] SKIP: ${reason}`);
    writeSkipReceipt(startedAt, reason, filtered.length, hermetic, filter);
    process.exit(allowSkip ? 0 : 3);
  }

  ensureStubbedGateway();
  const anthropic = hermetic ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const liveComplete = anthropic ? makeLiveComplete(anthropic) : null;
  const liveJudge = anthropic ? makeLiveJudge(anthropic) : null;

  console.log(`[cat14] running ${filtered.length} probes through gbrain runThink (mode=${hermetic ? 'hermetic' : 'live'} think=${THINK_MODEL}@t${THINK_TEMPERATURE} judge=${hermetic ? 'heuristic' : `${JUDGE_MODEL}@t${JUDGE_TEMPERATURE} both-orders`})`);

  const acc = new ProbeAccounting(filtered.length);
  const results: ProbeResult[] = [];
  let judgeFailedCount = 0;

  for (const probe of filtered) {
    process.stderr.write(`  ${probe.id}... `);
    const deps: ProbeRunDeps = hermetic
      ? { complete: makeHermeticComplete(probe, idealActor), judge: heuristicJudge }
      : { complete: liveComplete!, judge: liveJudge! };
    let outcome: ProbeOutcome;
    try {
      outcome = await runProbe(probe, deps);
    } catch (e) {
      outcome = { kind: 'error', origin: 'harness', message: `runProbe threw: ${errMsg(e)}` };
    }
    if (outcome.kind === 'error') {
      acc.error(probe.id, outcome.origin, outcome.message);
      if (outcome.origin === 'judge') judgeFailedCount++;
      process.stderr.write(`ERROR(${outcome.origin}): ${outcome.message.slice(0, 140)}\n`);
      continue;
    }
    results.push(outcome.result);
    writeDump(outcome.result);
    if (outcome.sutError) {
      acc.error(probe.id, 'sut', outcome.sutError);
      process.stderr.write(`SUT-FAIL: ${outcome.sutError.slice(0, 140)}\n`);
    } else {
      acc.score(probe.id, outcome.result.per_axis_pass_rate);
      process.stderr.write(`axes=${outcome.result.per_axis_pass_rate.toFixed(2)} win=${outcome.result.win_overall}${outcome.result.win_eligible ? '' : ' (tie-expected, win-exempt)'}\n`);
    }
  }

  const summary = aggregate(results, { mode: hermetic ? 'hermetic' : 'live', judgeFailed: judgeFailedCount });
  const accSummary = acc.summary();
  summary.provenance = {
    probe_filter: filter,
    probes_planned: filtered.length,
    probes_in_fixture: probes.length,
    think_model: THINK_MODEL,
    think_temperature: THINK_TEMPERATURE,
    judge_model: hermetic ? 'heuristic-string-judge' : JUDGE_MODEL,
    judge_temperature: JUDGE_TEMPERATURE,
    probes_jsonl_sha256_16: probesHash(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };

  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(join(DUMPS_DIR, '_summary.json'), JSON.stringify(summary, null, 2));

  if (accSummary.run_invalid) {
    writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
      ...baseReceipt(startedAt),
      run_status: 'error',
      n_total: accSummary.n_total,
      n_scored: accSummary.n_scored,
      completion_rate: accSummary.completion_rate,
      errors: accSummary.errors,
      publishable: false,
      resolved_config: resolvedConfig(hermetic, filter),
      judge: { model: hermetic ? 'heuristic-string-judge' : JUDGE_MODEL, temperature: JUDGE_TEMPERATURE },
      data: { summary: summary as unknown as Record<string, unknown> },
    });
    console.error(`[cat14] RUN INVALID: infra error rate ${(accSummary.infra_error_rate * 100).toFixed(0)}% over cap; see receipt errors[]`);
    process.exit(2);
  }

  // Hermetic and filtered runs can never claim a full 'pass' — they verify
  // pipeline conformance / a subset, not live answer quality.
  const verdict: ReceiptVerdict = summary.gate === 'fail' ? 'fail' : hermetic || filter ? 'partial' : 'pass';
  writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
    ...baseReceipt(startedAt),
    run_status: 'completed',
    verdict,
    n_total: accSummary.n_total,
    n_scored: accSummary.n_scored,
    completion_rate: accSummary.completion_rate,
    errors: accSummary.errors,
    publishable: accSummary.publishable && !hermetic && !filter,
    resolved_config: resolvedConfig(hermetic, filter),
    judge: { model: hermetic ? 'heuristic-string-judge' : JUDGE_MODEL, temperature: JUDGE_TEMPERATURE },
    data: { summary: summary as unknown as Record<string, unknown> },
  });

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`cat14 calibration A/B via gbrain runThink — summary (${summary.mode})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`probes:            ${summary.scored_probes}/${filtered.length} scored (judge_failed=${summary.judge_failed} sut_failed=${summary.sut_failed})`);
  const fmtRate = (x: number): string => Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`;
  console.log(`win calibrated:    ${fmtRate(summary.win_rate_calibrated)} of ${summary.win_eligible_n} win-eligible (tie-expected categories excluded)`);
  console.log(`win baseline/tie:  ${fmtRate(summary.win_rate_baseline)} / ${fmtRate(summary.win_rate_tie)}`);
  console.log('per-axis pass rate (gated subset):');
  for (const [axis, a] of Object.entries(summary.per_axis)) {
    console.log(`  ${axis.padEnd(38)} ${fmtRate(a.rate).padStart(4)}  (${a.subset}, n=${a.n})`);
  }
  if (Object.keys(summary.failure_mode_counts).length > 0) {
    console.log('failure-mode counts:');
    for (const [mode, count] of Object.entries(summary.failure_mode_counts)) {
      console.log(`  ${mode.padEnd(38)} ${count}`);
    }
  }
  for (const flag of summary.doctor_flags) console.log(`doctor flag: ${flag}`);
  if (accSummary.errors.length > 0) {
    console.log(`errors: ${accSummary.errors.map(e => `${e.probe_id}:${e.origin}`).join(', ')}`);
  }
  console.log('');
  console.log(`gate: ${summary.gate.toUpperCase()}${verdict === 'partial' && summary.gate === 'pass' ? ' (verdict partial: hermetic/filtered run)' : ''}`);
  if (summary.gate === 'fail') {
    for (const reason of summary.gate_reasons) console.log(`  ✗ ${reason}`);
    console.log('');
    console.log(`Per-probe dumps in ${DUMPS_DIR}/<probe_id>.json — read scores[].rationale to find what to fix. See ../data/cat14-calibration/README.md for the failure-mode → fix-location map.`);
    process.exit(1);
  }
  console.log(`  ✓ all gates pass`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[cat14] fatal:', err);
    process.exit(2);
  });
}

export { loadProbes, CATEGORY, POSITIVE_CATEGORIES, NEGATIVE_CATEGORIES, TIE_EXPECTED_CATEGORIES };
export type { Probe, ProbeExpected, AxisName };
