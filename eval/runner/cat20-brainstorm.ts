/**
 * BrainBench Cat 20 — brainstorm grounding + structure (redesign of the
 * v0.37.0.0 runner; audit cats18-21-10/-12/-15).
 *
 * Headline question: does `gbrain brainstorm` produce ideas that are
 * GROUNDED in the brain — citing real pages, in the idea text the user
 * actually reads — and structurally sound (enough ideas, judge wiring
 * intact)?
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's `runBrainstorm` orchestrator end to end over a real
 * index — close-set retrieval (hybridSearch, mode/reranker pinned),
 * domain-bank far-set stratification, cross generation, the internal judge
 * wiring, and the GROUNDING of what brainstorm ACTUALLY produced. Grounding
 * is computed programmatically from the emitted ideas: the idea's
 * close_slug/far_slug must exist in the seeded corpus AND the idea TEXT
 * itself must cite those slugs (the generator prompt demands verbatim
 * citations). The previous runner injected `(close=X, far=Y)` metadata into
 * every idea line before asking an LLM whether ideas "cite a slug" —
 * grounding was satisfied by construction (audit cats18-21-10). Nothing is
 * injected now; we grade the raw idea text.
 * LEGITIMATELY SEEDED/STUBBED: the synthetic-v1 corpus (committed fixture),
 * and — under --stub-llm — the embed transport (deterministic hash vectors)
 * plus the orchestrator's chatFn test seam (canned generator/judge
 * responses). Stub runs exercise the full orchestrator hermetically but are
 * publishable:false; they verify plumbing + the grounding gate, never model
 * quality. Optional novelty/usefulness axes run through
 * eval/runner/judge.ts scoreAnswer ONLY in --live-judge mode
 * (ANTHROPIC_API_KEY): the judge sees idea texts and the cited pages'
 * content, never gold labels or injected citations.
 *
 * ── Scoring policy (WS0) ─────────────────────────────────────────────
 * One grounding probe per question, scored via probe-accounting. A
 * runBrainstorm throw or an empty idea set is a 'sut' error (scored 0, kept
 * in the denominator) — the judge is NEVER invoked on an empty ideas string
 * (audit cats18-21-12). Live-judge failures are typed 'judge' (excluded +
 * capped), never averaged in as 0. Grounding is graded over the ideas the
 * product actually renders (`passes === true`); when the internal judge
 * failed (all passes false) we grade the full raw set and record that
 * (audit cats18-21-15 — no 2000-char truncation anywhere).
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass — every question scored (no sut errors), each produced >= minIdeas
 *        ideas, mean grounding >= minGrounding, and (live-judge mode only)
 *        mean judge score >= minJudgeScore.
 * fail — any gate missed. Exit non-zero unless verdict === 'pass'.
 * Missing keys in live mode → receipt run_status 'skipped' + non-zero exit
 * unless --allow-skip / BRAINBENCH_ALLOW_SKIP=1.
 *
 * Run:
 *   bun eval/runner/cat20-brainstorm.ts --stub-llm            # hermetic
 *   bun eval/runner/cat20-brainstorm.ts                       # live (keys required)
 *   bun eval/runner/cat20-brainstorm.ts --live-judge          # live + Haiku axes
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setEmbedTransportForTests, type ChatResult, type ChatOpts } from 'gbrain/ai/gateway';
import {
  runBrainstorm,
  BRAINSTORM_PROFILE,
  type BrainstormResult,
  type BrainstormIdea,
} from '../../node_modules/gbrain/src/core/brainstorm/orchestrator.ts';
import { loadSyntheticV1, type SyntheticPage } from './synthetic-corpus-loader.ts';
import { makeHashEmbedTransport } from './cat18-embedding-providers.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';
import { scoreAnswer, type JudgeEvidence, type RubricCriterion } from './judge.ts';

export const CAT20_CATEGORY = 'cat20-brainstorm';

export const QUESTIONS_DEFAULT = [
  'What is a non-obvious next-step product for an inference-platform company that already serves autonomous-picking?',
  'How could a fund focused on early ML differentiate from competitors going after the same wave?',
  'What is an unexplored research direction that combines agent memory with autonomous-picking robotics?',
];

/** Grounding floor for a pass verdict: on average, ideas must cite (in their
 *  own text) at least one of their two source slugs, and both slugs must be
 *  real pages. 0.5 == "one of two citations present" per idea. */
export const DEFAULT_MIN_GROUNDING = 0.5;
/** Every question must yield at least this many ideas. */
export const DEFAULT_MIN_IDEAS = 3;
/** Live-judge floor on scoreAnswer's 0-5 overall (>= partial threshold). */
export const DEFAULT_MIN_JUDGE_SCORE = 2.5;
export const EMBED_MODEL = 'openai:text-embedding-3-large';
export const EMBED_DIM = 1536;

/** WS5: pin the retrieval knobs runBrainstorm's close-set hybridSearch reads.
 *  gbrain's default 'balanced' mode silently enables the zerank-2 reranker
 *  when ZEROENTROPY_API_KEY is set — never rely on defaults. */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
};

// ─── Programmatic grounding (no LLM, no injection) ───────────────────

export interface IdeaGrounding {
  idea_id: string;
  /** Both cited slugs resolve to real pages in the seeded corpus. */
  slugs_valid: boolean;
  /** The idea TEXT (what the user reads) cites the close slug verbatim. */
  cites_close: boolean;
  /** The idea TEXT cites the far slug verbatim. */
  cites_far: boolean;
  /** 0..1 — 0 when either slug is fake, else 0.5 per in-text citation. */
  score: number;
}

export function gradeIdeaGrounding(
  idea: Pick<BrainstormIdea, 'id' | 'text' | 'close_slug' | 'far_slug'>,
  corpusSlugs: ReadonlySet<string>,
): IdeaGrounding {
  const slugsValid = corpusSlugs.has(idea.close_slug) && corpusSlugs.has(idea.far_slug);
  const citesClose = idea.text.includes(idea.close_slug);
  const citesFar = idea.text.includes(idea.far_slug);
  return {
    idea_id: idea.id,
    slugs_valid: slugsValid,
    cites_close: citesClose,
    cites_far: citesFar,
    score: slugsValid ? (citesClose ? 0.5 : 0) + (citesFar ? 0.5 : 0) : 0,
  };
}

// ─── Hermetic chat stub (orchestrator's documented chatFn test seam) ──

export type StubChatKind = 'grounded' | 'ungrounded' | 'throw';

/**
 * Deterministic ChatFn for --stub-llm runs and regression tests. Handles the
 * two prompt shapes runBrainstorm issues:
 *   - cross-generation (buildCrossPrompt): returns `## Idea N` blocks. The
 *     'grounded' kind cites both source slugs in the idea text (what a
 *     well-behaved generator does); 'ungrounded' returns citation-free
 *     platitudes so the grounding gate provably fails; 'throw' fails every
 *     cross so the orchestrator's no-ideas error path fires.
 *   - judge (buildJudgePrompt, detected via '## IDEAS TO EVALUATE'): echoes
 *     every idea id with fixed above-threshold scores so `passes` is true.
 */
export function makeStubChatFn(kind: StubChatKind): (opts: ChatOpts) => Promise<ChatResult> {
  return async (opts: ChatOpts) => {
    const first = opts.messages[0]?.content;
    const user = typeof first === 'string' ? first : JSON.stringify(first ?? '');
    let text: string;
    if (user.includes('## IDEAS TO EVALUATE')) {
      const ids = [...user.matchAll(/^## Idea (\S+)$/gm)].map(m => m[1]);
      text = JSON.stringify({
        ideas: ids.map(id => ({
          id,
          scores: { originality: 5, resistance: 4, thesis_density: 4, concrete_grounding: 4, cognitive_load: 4 },
          note: 'stub judge: fixed above-threshold scores',
        })),
      });
    } else {
      if (kind === 'throw') throw new Error('stub chat: forced cross failure (test hook)');
      const closeSlug = user.match(/CLOSE PAGE[^\n]*\n\[([^\]]+)\]/)?.[1] ?? 'unknown/close';
      const farSlug = user.match(/FAR PAGE[^\n]*\n\[([^\]]+)\]/)?.[1] ?? 'unknown/far';
      const n = parseInt(user.match(/Generate exactly (\d+) ideas/)?.[1] ?? '3', 10);
      const blocks: string[] = [];
      for (let i = 1; i <= n; i++) {
        blocks.push(
          kind === 'grounded'
            ? `## Idea ${i}\nCollide the anchor in [${closeSlug}] with the pattern in [${farSlug}]: variant ${i} builds a concrete next step from both notes.`
            : `## Idea ${i}\nThink outside the box and synergize broadly. Innovation matters. Variant ${i} of a generic uncited platitude.`,
        );
      }
      text = blocks.join('\n\n');
    }
    return {
      text,
      blocks: [{ type: 'text', text }] as ChatResult['blocks'],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'stub:cat20-fixture',
      providerId: 'stub',
    } satisfies ChatResult;
  };
}

// ─── Per-question result ─────────────────────────────────────────────

export interface QuestionResult {
  question: string;
  error: string | null;
  idea_count: number;
  passing_count: number;
  internal_judge_failed: boolean;
  /** Which idea set grounding was graded over. */
  graded_set: 'passing' | 'all_raw' | 'none';
  graded_count: number;
  grounding: number | null;
  grounding_detail: IdeaGrounding[];
  /** Live-judge axes (scoreAnswer overall 0-5); null when judge not run. */
  judge_overall: number | null;
  judge_verdict: string | null;
}

// ─── Run options ─────────────────────────────────────────────────────

export interface Cat20Options {
  questions?: string[];
  pages?: SyntheticPage[];
  /** Hermetic mode: stub embed transport + orchestrator chatFn. */
  stubLlm?: boolean;
  /** Which canned generator the stub uses (tests drive 'ungrounded'/'throw'). */
  stubChatKind?: StubChatKind;
  /** Run the novelty/usefulness LLM judge (needs ANTHROPIC_API_KEY). */
  liveJudge?: boolean;
  /** Client override for scoreAnswer — tests inject a stub Anthropic client. */
  judgeClient?: Anthropic;
  allowSkip?: boolean;
  minGrounding?: number;
  minIdeas?: number;
  minJudgeScore?: number;
  maxCostUsd?: number;
  reportsDir?: string;
  quiet?: boolean;
}

export interface Cat20RunResult {
  receipt: Receipt;
  exitCode: number;
  receiptFile: string;
  perQuestion: QuestionResult[];
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat20Options {
  return {
    stubLlm: argv.includes('--stub-llm') || process.env.CAT20_STUB_LLM === '1',
    liveJudge: argv.includes('--live-judge') || process.env.CAT20_LIVE_JUDGE === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    minGrounding: process.env.CAT20_MIN_GROUNDING ? parseFloat(process.env.CAT20_MIN_GROUNDING) : undefined,
  };
}

const NOVELTY_USEFULNESS_RUBRIC: RubricCriterion[] = [
  { id: 'novelty', criterion: 'Ideas are lateral and non-obvious: they combine the cited pages into theses the user would not surface by reading either page alone. Trivial restatements score 0-1.', weight: 1 },
  { id: 'usefulness', criterion: 'Ideas are actionable for a founder/operator: concrete next steps grounded in the cited pages, not generic platitudes.', weight: 1 },
];

async function judgeNoveltyUsefulness(
  question: string,
  qid: string,
  ideas: BrainstormIdea[],
  pagesBySlug: Map<string, SyntheticPage>,
  client: Anthropic | undefined,
): Promise<{ overall: number; verdict: string }> {
  // The judge sees ONLY what brainstorm produced (idea texts) + the cited
  // pages' real content as ground truth. No injected citation metadata, no
  // expected verdicts.
  const citedSlugs = [...new Set(ideas.flatMap(i => [i.close_slug, i.far_slug]))];
  const groundTruth = citedSlugs
    .map(slug => pagesBySlug.get(slug))
    .filter((p): p is SyntheticPage => p !== undefined)
    .slice(0, 12)
    .map(p => ({ slug: p.slug, title: p.slug, content: p.body.slice(0, 1500) }));
  const evidence: JudgeEvidence = {
    schema_version: 1,
    // judge.ts Probe.category is typed for the 5/8/9 rubric era; the value is
    // only rendered into the prompt header.
    probe: { id: qid, text: question, category: 20 as unknown as 5 },
    final_answer_text: ideas.map((i, n) => `${n + 1}. ${i.text}`).join('\n\n'),
    evidence_refs: citedSlugs,
    tool_call_summary: { count_by_tool: { brainstorm: 1 }, saw_poison_items: [], made_dry_run_writes: [] },
    ground_truth_pages: groundTruth,
    rubric: NOVELTY_USEFULNESS_RUBRIC,
  };
  const result = await scoreAnswer(evidence, client ? { client } : {});
  if (result.verdict === 'judge_failed') {
    throw new Error('judge_failed: scoreAnswer produced malformed output after retry');
  }
  return { overall: result.overall_score, verdict: result.verdict };
}

// ─── Full run ────────────────────────────────────────────────────────

export async function runCat20(options: Cat20Options = {}): Promise<Cat20RunResult> {
  const startedAt = new Date().toISOString();
  const stubLlm = options.stubLlm ?? false;
  const liveJudge = (options.liveJudge ?? false) && !stubLlm;
  const questions = options.questions ?? QUESTIONS_DEFAULT;
  const minGrounding = options.minGrounding ?? DEFAULT_MIN_GROUNDING;
  const minIdeas = options.minIdeas ?? DEFAULT_MIN_IDEAS;
  const minJudgeScore = options.minJudgeScore ?? DEFAULT_MIN_JUDGE_SCORE;
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT20_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  const home = join(tmpdir(), `cat20-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  // n_total: one grounding probe per question, plus one judge probe per
  // question in live-judge mode.
  const expected = questions.length * (liveJudge ? 2 : 1);
  const baseReceipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT20_CATEGORY,
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    started_at: startedAt,
  } as const;

  if (!stubLlm) {
    const missing: string[] = [];
    if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY (brainstorm chat + judge)');
    if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY (embeds)');
    if (missing.length > 0) {
      const receipt: Receipt = {
        ...baseReceipt,
        run_status: 'skipped',
        skip_reason: `missing keys: ${missing.join(', ')} (run with --stub-llm for a hermetic plumbing + grounding-gate check)`,
        n_total: expected,
        n_scored: 0,
        completion_rate: 0,
        errors: [],
        publishable: false,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat20] SKIPPED: ${receipt.skip_reason}\n[cat20] receipt: ${receiptFile}\n`);
      return { receipt, exitCode: options.allowSkip ? 0 : 1, receiptFile, perQuestion: [] };
    }
  } else {
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = 'dummy-stub-embed';
    __setEmbedTransportForTests(makeHashEmbedTransport());
  }
  const stubChatFn = stubLlm ? makeStubChatFn(options.stubChatKind ?? 'grounded') : undefined;

  configureGateway({
    embedding_model: EMBED_MODEL,
    embedding_dimensions: EMBED_DIM,
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: process.env as Record<string, string | undefined>,
  });

  const pages = options.pages ?? loadSyntheticV1();
  const pagesBySlug = new Map(pages.map(p => [p.slug, p]));
  const corpusSlugs = new Set(pages.map(p => p.slug));

  const acc = new ProbeAccounting(expected);
  const perQ: QuestionResult[] = [];

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  try {
    // WS5: pin retrieval knobs BEFORE ingest — runBrainstorm's close-set
    // hybridSearch resolves per-key config from the engine.
    for (const [k, v] of Object.entries(PINNED_CONFIG)) await engine.setConfig(k, v);

    const origLog = console.log;
    console.log = () => {};
    try {
      for (const p of pages) await importFromContent(engine, p.slug, p.body, { noEmbed: false });
    } finally {
      console.log = origLog;
    }
    log(`[cat20] seeded ${pages.length} pages${stubLlm ? ' [STUB LLM — plumbing + grounding-gate check, not model quality]' : ''}\n`);

    for (let qi = 0; qi < questions.length; qi++) {
      const question = questions[qi];
      const qid = `q${qi + 1}`;
      log(`[cat20] ${qid}: "${question.slice(0, 60)}..."\n`);

      let result: BrainstormResult | null = null;
      let error: string | null = null;
      try {
        result = await runBrainstorm(
          engine,
          { embedding_model: EMBED_MODEL },
          {
            question,
            profile: BRAINSTORM_PROFILE,
            skipCostPreview: true,
            maxCostUsd: options.maxCostUsd ?? 2.0,
            chatFn: stubChatFn,
            stderrWrite: options.quiet ? () => {} : (s: string) => process.stderr.write(`[cat20]   ${s}`),
          },
        );
      } catch (e: any) {
        error = String(e?.message ?? e).slice(0, 400);
      }

      const ideas = result?.ideas ?? [];
      if (error !== null || ideas.length === 0) {
        // The SUT failed the probe: scored 0, kept in the denominator. The
        // judge is never consulted about an empty ideas string.
        const msg = error ?? 'runBrainstorm returned zero ideas';
        acc.error(`${qid}:grounding`, 'sut', `brainstorm failed: ${msg}`);
        if (liveJudge) acc.error(`${qid}:judge`, 'sut', `brainstorm failed before judging: ${msg}`);
        perQ.push({
          question, error: msg, idea_count: 0, passing_count: 0,
          internal_judge_failed: result?.judge_failed ?? false,
          graded_set: 'none', graded_count: 0, grounding: null, grounding_detail: [],
          judge_overall: null, judge_verdict: null,
        });
        log(`[cat20]   SUT ERROR: ${msg}\n`);
        continue;
      }

      // Grade the set the product renders (`passes`); fall back to the full
      // raw set when the internal judge failed (all passes false).
      const passing = ideas.filter(i => i.passes);
      const gradedSet: 'passing' | 'all_raw' = passing.length > 0 ? 'passing' : 'all_raw';
      const graded = passing.length > 0 ? passing : ideas;
      const detail = graded.map(i => gradeIdeaGrounding(i, corpusSlugs));
      const grounding = detail.reduce((a, d) => a + d.score, 0) / detail.length;
      acc.score(`${qid}:grounding`, grounding);

      let judgeOverall: number | null = null;
      let judgeVerdict: string | null = null;
      if (liveJudge) {
        try {
          const j = await judgeNoveltyUsefulness(question, qid, graded, pagesBySlug, options.judgeClient);
          judgeOverall = j.overall;
          judgeVerdict = j.verdict;
          acc.score(`${qid}:judge`, j.overall / 5);
        } catch (e: any) {
          acc.error(`${qid}:judge`, 'judge', String(e?.message ?? e).slice(0, 300));
        }
      }

      perQ.push({
        question, error: null,
        idea_count: ideas.length,
        passing_count: passing.length,
        internal_judge_failed: result?.judge_failed ?? false,
        graded_set: gradedSet,
        graded_count: graded.length,
        grounding,
        grounding_detail: detail,
        judge_overall: judgeOverall,
        judge_verdict: judgeVerdict,
      });
      log(`[cat20]   ideas=${ideas.length} passing=${passing.length} graded=${gradedSet} grounding=${grounding.toFixed(2)}${judgeOverall !== null ? ` judge=${judgeOverall.toFixed(2)}/5` : ''}\n`);
    }
  } finally {
    if (stubLlm) __setEmbedTransportForTests(null);
    await engine.disconnect().catch(() => {});
  }

  const summary = acc.summary();
  const scoredQ = perQ.filter(p => p.error === null);
  const groundingScores = perQ.map(p => (p.error === null ? (p.grounding ?? 0) : 0));
  const meanGrounding = groundingScores.length > 0
    ? groundingScores.reduce((a, b) => a + b, 0) / groundingScores.length
    : NaN;
  const judgeScores = scoredQ.map(p => p.judge_overall).filter((v): v is number => v !== null);
  const meanJudge = judgeScores.length > 0 ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : null;

  const gateReasons: string[] = [];
  const sutErrors = summary.errors.filter(e => e.origin === 'sut');
  if (sutErrors.length > 0) gateReasons.push(`${sutErrors.length} brainstorm probe(s) failed (sut)`);
  const shortQuestions = scoredQ.filter(p => p.idea_count < minIdeas);
  if (shortQuestions.length > 0) gateReasons.push(`${shortQuestions.length} question(s) below ${minIdeas}-idea floor`);
  if (!(meanGrounding >= minGrounding)) gateReasons.push(`mean grounding ${Number.isNaN(meanGrounding) ? 'n/a' : meanGrounding.toFixed(2)} < ${minGrounding} floor`);
  if (liveJudge) {
    if (meanJudge === null) gateReasons.push('live-judge mode but no judge scores recorded');
    else if (meanJudge < minJudgeScore) gateReasons.push(`mean judge ${meanJudge.toFixed(2)} < ${minJudgeScore} floor`);
  }
  const verdict: 'pass' | 'fail' = gateReasons.length === 0 ? 'pass' : 'fail';
  const runInvalid = summary.run_invalid;
  const publishable = summary.publishable && !stubLlm;

  const receipt: Receipt = {
    ...baseReceipt,
    run_status: runInvalid ? 'error' : 'completed',
    ...(runInvalid ? {} : { verdict }),
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable,
    resolved_config: {
      search_mode: PINNED_CONFIG['search.mode'],
      reranker_enabled: false,
      pinned_config: PINNED_CONFIG,
      embed_transport: stubLlm ? 'stubbed-hash' : 'live',
      chat_transport: stubLlm ? `stubbed-${options.stubChatKind ?? 'grounded'}` : 'live',
      profile: 'brainstorm',
      corpus: 'synthetic-v1',
      corpus_pages: pages.length,
      min_grounding: minGrounding,
      min_ideas: minIdeas,
      live_judge: liveJudge,
      ...(liveJudge ? { min_judge_score: minJudgeScore } : {}),
    },
    ...(liveJudge ? { judge: { model: 'claude-haiku-4-5-20251001', temperature: 0, rubric_version: 'cat20-novelty-usefulness-v1' } } : {}),
    finished_at: new Date().toISOString(),
    data: {
      per_question: perQ,
      mean_grounding: Number.isNaN(meanGrounding) ? null : meanGrounding,
      mean_judge_overall: meanJudge,
      verdict_reasons: gateReasons.length > 0 ? gateReasons : ['all gates passed'],
      infra_error_rate: summary.infra_error_rate,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT20_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat20.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat20] ─── Scorecard ───────────────────\n`);
  for (const p of perQ) {
    log(`[cat20]   ${p.error ? 'ERR ' : '    '}ideas=${String(p.idea_count).padStart(2)} passing=${String(p.passing_count).padStart(2)} grounding=${p.grounding?.toFixed(2) ?? 'n/a '} ${p.question.slice(0, 48)}...\n`);
  }
  log(`[cat20]   mean grounding: ${Number.isNaN(meanGrounding) ? 'n/a' : meanGrounding.toFixed(2)} (gate >= ${minGrounding})\n`);
  if (liveJudge) log(`[cat20]   mean judge:     ${meanJudge?.toFixed(2) ?? 'n/a'}/5 (gate >= ${minJudgeScore})\n`);
  log(`[cat20]   run_status=${receipt.run_status} verdict=${receipt.verdict ?? 'n/a'} publishable=${publishable}\n`);
  log(`[cat20]   receipt: ${receiptFile}\n`);

  const exitCode = runInvalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, exitCode, receiptFile, perQuestion: perQ };
}

if (import.meta.main) {
  try {
    const result = await runCat20(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT20_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT20_CATEGORY,
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
    process.stderr.write(`[cat20] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
