/**
 * BrainBench Cat 29 — `gbrain think` synthesis vs raw `search` quality.
 *
 * The headline product question: "Search gives you raw pages. Think gives
 * you the answer." This Cat measures whether the synthesis layer produces
 * better answers than the raw retrieved payload on multi-page relational
 * questions over the synthetic-v1 corpus — judged BLIND.
 *
 * ── Feature boundary ─────────────────────────────────────────────────
 * UNDER TEST: gbrain's runThink pipeline (gather → synthesis → citations,
 * via the published 'gbrain/think' export) head-to-head against the raw
 * hybridSearch payload an agent would otherwise dump into context. Search
 * mode + reranker are pinned (WS5) and the think model is pinned via
 * `models.think` config — never left to tier defaults (audit cats26-29-12:
 * the old runner silently ran Opus while claiming Sonnet).
 * LEGITIMATELY SEEDED/STUBBED: the synthetic-v1 corpus (committed fixture,
 * deterministic seed). Under --stub (hermetic, no keys): the embed HTTP
 * transport (deterministic hash vectors), the think LLM (runThink's
 * stubResponse test seam — gather still runs against the real engine), and
 * the judge client. Stub runs verify the full plumbing + gates and are
 * stamped publishable:false; they are never a think-quality claim.
 *
 * ── Judging policy (WS0, audit cats26-29-10/11/18) ───────────────────
 * - BLIND: the judge never learns which answer came from think vs search.
 *   Each answer is scored independently via eval/runner/judge.ts
 *   scoreAnswer (temperature 0, rubric-coverage enforced) with zero system
 *   identity in the evidence.
 * - BOTH ORDERS: every question runs two judging passes with the two
 *   answers in opposite orders (first-pass order fixed by a seed derived
 *   from the question id — no unseeded randomness); per-answer scores are
 *   averaged across passes.
 * - EXPECTED FACTS: every question carries expected_facts extracted from
 *   the committed corpus (real ARR readings, attendee slugs, link counts),
 *   passed to the judge as ground truth + rubric criteria — a hallucinated
 *   value can no longer score 10 (audit cats26-29-18). Ground-truth facts
 *   are NOT verdict labels; no "X should win" prior ever reaches the judge.
 * - Judge API failure / judge_failed => probe-accounting origin 'judge':
 *   the question is EXCLUDED from means and capped — never scored 0
 *   (audit cats26-29-11).
 *
 * ── Verdict (real + failable) ────────────────────────────────────────
 * pass    — every question judged AND think mean >= search mean.
 * partial — think mean >= search mean but some questions excluded (judge
 *           errors within the accounting cap).
 * fail    — think mean < search mean, or nothing judged.
 * Exit code is non-zero unless verdict === 'pass'. Missing keys without
 * --stub → receipt run_status 'skipped' + non-zero exit unless --allow-skip.
 *
 * Cost: live run ≈ $0.40 (5 pinned-Sonnet think calls + up to 20 Haiku
 * judge calls at ~$0.01 each) plus one-time OpenAI embeds for 165 pages.
 * Stub run: $0, no keys.
 *
 * Run:
 *   bun eval/runner/cat29-think-vs-search.ts --stub        # hermetic
 *   bun eval/runner/cat29-think-vs-search.ts               # live (needs ANTHROPIC + OPENAI keys)
 *   CAT29_QUESTIONS=2 bun eval/runner/cat29-think-vs-search.ts --stub
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway, __setEmbedTransportForTests } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { runThink, type ThinkResponse } from 'gbrain/think';
import { loadSyntheticV1, type SyntheticPage } from './synthetic-corpus-loader.ts';
import { scoreAnswer, type JudgeEvidence, type JudgeConfig, type RubricCriterion } from './judge.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { writeReceipt, receiptPath, BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, type Receipt } from './receipt.ts';
import { gbrainVersion as gbrainVersionResolved, gbrainPin } from './gbrain-version.ts';
import { installStubEmbed } from './cat27-graph-signals.ts';

export const CAT29_CATEGORY = 'cat29-think-vs-search';

/** Pinned think model — recorded in resolved_config; ThinkResult.modelUsed is echoed back. */
export const THINK_MODEL = 'anthropic:claude-sonnet-4-6';
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
export const RUBRIC_VERSION = 'cat29-v2';

/**
 * WS5 pin — applied via engine.setConfig BEFORE ingest and echoed into
 * resolved_config. Both systems (think's gather and the raw search arm)
 * retrieve under the identical pinned mode; the default 'balanced' bundle
 * would silently enable the zerank-2 reranker when ZEROENTROPY_API_KEY is
 * set.
 */
export const PINNED_CONFIG: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.autocut': 'false',
  'search.cache.enabled': 'false',
};

// ─── Questions with corpus-extracted expected facts ────────────────────

export interface Cat29Question {
  id: string;
  text: string;
  /** Concrete ground-truth facts extracted from the committed corpus. */
  expected_facts: string[];
  /** Corpus pages handed to the judge as the world-of-facts. */
  gold_slugs: string[];
}

interface FactRow { since: string; claim: string }

/** Parse `| 2025-01-15 | ARR is $120K | arr | ... |` rows from a Facts fence. */
export function arrReadings(body: string): FactRow[] {
  const out: FactRow[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*arr\s*\|/);
    if (m) out.push({ since: m[1], claim: m[2] });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

function pageBySlug(pages: SyntheticPage[], slug: string): SyntheticPage | undefined {
  return pages.find(p => p.slug === slug);
}

function titleOf(p: SyntheticPage): string {
  return p.body.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? p.slug;
}

/**
 * Derive the question set (with expected facts) from the loaded corpus.
 * Extraction is deterministic — the corpus is a committed fixture generated
 * from a pinned seed, so facts can never drift from what was actually
 * seeded (audit cats26-29-18: the old golds described what a good answer
 * "should do" without ever stating the values, so a hallucinated ARR figure
 * could score 10). Questions whose entities are absent from `pages` (test
 * sub-corpora) are skipped.
 */
export function buildQuestions(pages: SyntheticPage[]): Cat29Question[] {
  const out: Cat29Question[] = [];

  // q1 — who works at Horizon TECH 6 (people pages linking the company).
  const horizon = pageBySlug(pages, 'companies/horizon-tech-6');
  if (horizon) {
    const linkers = pages
      .filter(p => p.slug.startsWith('people/') && p.body.includes('[[companies/horizon-tech-6]]'))
      .map(p => p.slug)
      .sort();
    if (linkers.length > 0) {
      out.push({
        id: 'q1-horizon-people',
        text: 'Who works at the Horizon TECH 6 company? What roles do they hold?',
        expected_facts: [
          `The people pages linking companies/horizon-tech-6 are: ${linkers.join(', ')}`,
          'Role information comes from those people pages (e.g. CEO / joined dates)',
        ],
        gold_slugs: ['companies/horizon-tech-6', ...linkers.slice(0, 5)],
      });
    }
  }

  // q2 — ARR trajectory of Acme CO 0 (real seeded readings, in date order).
  const acme = pageBySlug(pages, 'companies/acme-co-0');
  if (acme) {
    const readings = arrReadings(acme.body);
    if (readings.length >= 2) {
      out.push({
        id: 'q2-acme-arr-trajectory',
        text: 'Has the ARR of the Acme CO 0 company grown over time? What were the readings?',
        expected_facts: [
          ...readings.map(r => `${r.claim} as of ${r.since}`),
          'ARR grew across the readings, reported in date order',
        ],
        gold_slugs: ['companies/acme-co-0'],
      });
    }
  }

  // q3 — concepts most linked from company pages (counted from the corpus).
  const conceptCounts = new Map<string, number>();
  for (const p of pages.filter(p => p.slug.startsWith('companies/'))) {
    for (const m of p.body.matchAll(/\[\[(concepts\/[a-z0-9-]+)\]\]/g)) {
      conceptCounts.set(m[1], (conceptCounts.get(m[1]) ?? 0) + 1);
    }
  }
  const topConcepts = [...conceptCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  if (topConcepts.length > 0) {
    out.push({
      id: 'q3-top-concepts',
      text: 'Which concept pages do the largest number of company pages link to?',
      expected_facts: topConcepts.map(([slug, n]) => `${slug} is linked from ${n} company pages`),
      gold_slugs: topConcepts.map(([slug]) => slug).filter(s => pageBySlug(pages, s)),
    });
  }

  // q4 — attendees of the autonomous-picking meeting (extracted refs).
  const meeting = pages.find(p => p.slug.startsWith('meetings/') && p.slug.includes('autonomous-picking'));
  if (meeting) {
    const attendees = [...new Set([...meeting.body.matchAll(/\[\[(people\/[a-z0-9-]+)\]\]/g)].map(m => m[1]))].sort();
    if (attendees.length > 0) {
      out.push({
        id: 'q4-autonomous-picking-attendees',
        text: 'Who was at the autonomous-picking meeting? What did they discuss?',
        expected_facts: [
          `Attendees: ${attendees.join(', ')}`,
          'They discussed autonomous-picking (see the meeting notes)',
        ],
        gold_slugs: [meeting.slug, ...attendees],
      });
    }
  }

  // q5 — gap test: latest ARR of Cobalt Labs 16 vs an as-of date after it.
  const cobalt = pageBySlug(pages, 'companies/cobalt-labs-16');
  if (cobalt) {
    const readings = arrReadings(cobalt.body);
    const latest = readings[readings.length - 1];
    if (latest) {
      out.push({
        id: 'q5-cobalt-arr-gap',
        text: 'What is the current ARR of the Cobalt Labs 16 company as of May 2026?',
        expected_facts: [
          `The most recent seeded reading is "${latest.claim}" as of ${latest.since}`,
          'A correct answer reports that value AND/OR notes the reading predates May 2026 (data gap)',
        ],
        gold_slugs: ['companies/cobalt-labs-16'],
      });
    }
  }

  return out;
}

// ─── Blind judge (both orders, via judge.ts scoreAnswer) ───────────────

/** FNV-1a → deterministic coin per question id (rule: no unseeded randomness). */
export function seededCoin(id: string): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 1) === 1;
}

function extractSlugRefs(answer: string): string[] {
  return [...new Set(
    [...answer.matchAll(/\b(?:people|companies|concepts|meetings|deal|projects|daily|writing)\/[a-z0-9][a-z0-9/-]*/g)]
      .map(m => m[0]),
  )];
}

export function rubricFor(q: Cat29Question): RubricCriterion[] {
  return [
    { id: 'facts', weight: 2, criterion: `States the expected facts (see the _gold/expected-facts page): ${q.expected_facts.join('; ')}` },
    { id: 'grounded', weight: 1, criterion: 'Specific claims (numbers, dates, names) are supported by the ground-truth pages; invented values or invented slugs score 0' },
    { id: 'cites', weight: 1, criterion: 'Cites the relevant page slugs' },
    { id: 'direct', weight: 1, criterion: 'Directly answers the question asked; usable without reading the raw pages' },
  ];
}

/**
 * Build BLIND judge evidence: the answer text and ground truth only. No
 * system identity ('think'/'search'), no expected verdict, ever.
 */
export function evidenceFor(q: Cat29Question, answerText: string, pages: SyntheticPage[]): JudgeEvidence {
  const groundTruth = q.gold_slugs
    .map(slug => pageBySlug(pages, slug))
    .filter((p): p is SyntheticPage => p !== undefined)
    .map(p => ({ slug: p.slug, title: titleOf(p), content: p.body.slice(0, 1500) }));
  groundTruth.push({
    slug: '_gold/expected-facts',
    title: 'Expected facts',
    content: q.expected_facts.map(f => `- ${f}`).join('\n'),
  });
  return {
    schema_version: 1,
    // Category is a presentation-only field in the judge prompt; Cat 29 is
    // not in judge.ts's frozen 5|8|9 union (shared module, read-only for
    // this runner), so it is threaded through as-is.
    probe: { id: q.id, text: q.text, category: 29 as unknown as JudgeEvidence['probe']['category'] },
    final_answer_text: answerText,
    evidence_refs: extractSlugRefs(answerText),
    tool_call_summary: { count_by_tool: {}, saw_poison_items: [], made_dry_run_writes: [] },
    ground_truth_pages: groundTruth,
    rubric: rubricFor(q),
  };
}

export class JudgeFailure extends Error {}

interface PairScores {
  /** Mean overall_score (0-5) per side across both orders; null = side sut-failed (scored 0). */
  a: number;
  b: number;
  by_order: Array<{ order: ['a' | 'b', 'a' | 'b']; a?: number; b?: number }>;
  cost_usd: number;
}

/**
 * Judge two blind answers in BOTH presentation orders and average per side.
 * Any judge API error or judge_failed verdict throws JudgeFailure — the
 * caller excludes the question via probe-accounting origin 'judge'.
 * A null answer (its system crashed) is a sut MISS: scored 0 without
 * consulting the judge.
 */
async function judgePair(
  q: Cat29Question,
  answers: { a: string | null; b: string | null },
  pages: SyntheticPage[],
  judgeConfig: JudgeConfig,
): Promise<PairScores> {
  const firstIsB = seededCoin(q.id);
  const orders: Array<['a' | 'b', 'a' | 'b']> = firstIsB ? [['b', 'a'], ['a', 'b']] : [['a', 'b'], ['b', 'a']];
  const sums: Record<'a' | 'b', number> = { a: 0, b: 0 };
  const byOrder: PairScores['by_order'] = [];
  let cost = 0;
  for (const order of orders) {
    const row: PairScores['by_order'][number] = { order };
    for (const side of order) {
      const answer = answers[side];
      if (answer === null) {
        row[side] = 0; // sut miss — no judge call for a crashed system
        continue;
      }
      let result;
      try {
        result = await scoreAnswer(evidenceFor(q, answer, pages), judgeConfig);
      } catch (e: any) {
        throw new JudgeFailure(`judge call failed for ${q.id}: ${e?.message ?? e}`);
      }
      cost += result.cost_usd;
      if (result.verdict === 'judge_failed') {
        throw new JudgeFailure(`judge_failed (malformed output after retry) for ${q.id}`);
      }
      row[side] = result.overall_score;
    }
    sums.a += row.a ?? 0;
    sums.b += row.b ?? 0;
    byOrder.push(row);
  }
  return { a: sums.a / orders.length, b: sums.b / orders.length, by_order: byOrder, cost_usd: cost };
}

// ─── Hermetic stubs (plumbing verification, publishable:false) ─────────

/** Default stub think response: expected facts + citations (a "good" synthesis). */
export function defaultStubThinkResponse(q: Cat29Question): ThinkResponse {
  return {
    answer: `${q.expected_facts.join('. ')}. (see ${q.gold_slugs.join(', ')})`,
    citations: q.gold_slugs.map(slug => ({ page_slug: slug, row_num: null })),
    gaps: [],
  };
}

/**
 * Deterministic judge client for --stub runs: scores the `facts` criterion
 * by expected-fact substring coverage in the blind answer, `cites` by slug
 * presence, fixed midpoints elsewhere. Injected through scoreAnswer's
 * sanctioned JudgeConfig.client seam — rubric coverage, weighting and
 * verdict thresholds still run through the real judge.ts code path.
 */
export function makeStubJudgeClient(hooks?: {
  failOn?: (userContent: string) => boolean;
  onRequest?: (userContent: string) => void;
}): { messages: { create: (params: any) => Promise<any> } } {
  return {
    messages: {
      create: async (params: any) => {
        const userContent = String(params?.messages?.[0]?.content ?? '');
        hooks?.onRequest?.(userContent);
        if (hooks?.failOn?.(userContent)) throw new Error('stub judge: forced failure (test hook)');
        const rubricIds = [...userContent.matchAll(/- id=(\S+) weight=/g)].map(m => m[1]);
        const answer = userContent.split('<final_answer>')[1]?.split('</final_answer>')[0] ?? '';
        const factsBlock = userContent.split('title="Expected facts"')[1]?.split('</page>')[0] ?? '';
        const facts = factsBlock.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2));
        const factScore = facts.length === 0 ? 0
          : Math.round((facts.filter(f => answer.includes(f.slice(0, Math.min(40, f.length)))).length / facts.length) * 5);
        const hasCite = /\b(?:people|companies|concepts|meetings|deal)\//.test(answer);
        const scores = rubricIds.map(id => ({
          criterion_id: id,
          score: id === 'facts' ? factScore : id === 'cites' ? (hasCite ? 5 : 0) : 3,
          rationale: 'stub judge (deterministic substring coverage)',
        }));
        return {
          content: [{ type: 'tool_use', id: 'stub', name: 'score_answer', input: { scores, verdict: 'partial', overall_rationale: 'stub judge' } }],
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  };
}

// ─── Aggregation + verdict ─────────────────────────────────────────────

export interface QuestionResult {
  question_id: string;
  question_text: string;
  expected_facts: string[];
  search_answer: string | null;
  think_answer: string | null;
  /** Mean judge overall_score (0-5) across both orders; null when the question was judge-excluded. */
  search_score: number | null;
  think_score: number | null;
  think_wins: boolean | null;
  judge_excluded: boolean;
  sut_errors: string[];
}

export function computeVerdict(rows: QuestionResult[], nTotal: number): 'pass' | 'partial' | 'fail' {
  const judged = rows.filter(r => !r.judge_excluded && r.search_score !== null && r.think_score !== null);
  if (judged.length === 0) return 'fail';
  const mean = (key: 'search_score' | 'think_score') =>
    judged.reduce((a, r) => a + (r[key] as number), 0) / judged.length;
  if (mean('think_score') < mean('search_score')) return 'fail';
  return judged.length === nTotal ? 'pass' : 'partial';
}

// ─── Entry point ───────────────────────────────────────────────────────

export interface Cat29Options {
  /** Hermetic mode: stub embeds + stub think + stub judge, no keys. */
  stub?: boolean;
  allowSkip?: boolean;
  pages?: SyntheticPage[];
  questions?: Cat29Question[];
  questionLimit?: number;
  reportsDir?: string;
  quiet?: boolean;
  /** Injected judge client (tests). Defaults: stub client under --stub, real Haiku otherwise. */
  judgeClient?: JudgeConfig['client'];
  /** Injected stub think response builder (tests / --stub). */
  thinkResponseFor?: (q: Cat29Question) => ThinkResponse;
}

export interface Cat29RunResult {
  receipt: Receipt;
  rows: QuestionResult[];
  exitCode: number;
  receiptFile: string;
}

export function optionsFromEnv(argv: string[] = process.argv.slice(2)): Cat29Options {
  return {
    stub: argv.includes('--stub') || process.env.CAT29_STUB === '1',
    allowSkip: argv.includes('--allow-skip') || process.env.BRAINBENCH_ALLOW_SKIP === '1',
    questionLimit: process.env.CAT29_QUESTIONS ? parseInt(process.env.CAT29_QUESTIONS, 10) : undefined,
  };
}

export async function runCat29(options: Cat29Options = {}): Promise<Cat29RunResult> {
  const startedAt = new Date().toISOString();
  const stub = options.stub === true;
  const reportsDir = options.reportsDir ?? join(process.cwd(), 'eval/reports');
  const receiptFile = receiptPath(CAT29_CATEGORY, reportsDir);
  const log = options.quiet ? (_: string) => {} : (s: string) => process.stderr.write(s);

  // Isolate GBRAIN_HOME so the user's config can't override models/search.
  const home = join(tmpdir(), `cat29-gbrain-home-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env.GBRAIN_HOME = home;

  // ── Key preflight: live mode needs both providers; never pretend to pass ──
  if (!stub) {
    const missing = [
      ...(!process.env.ANTHROPIC_API_KEY ? ['ANTHROPIC_API_KEY'] : []),
      ...(!process.env.OPENAI_API_KEY ? ['OPENAI_API_KEY'] : []),
    ];
    if (missing.length > 0) {
      const receipt: Receipt = {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT29_CATEGORY,
        run_status: 'skipped',
        skip_reason: `missing keys: ${missing.join(', ')} (run with --stub for a hermetic plumbing check)`,
        n_total: 0,
        n_scored: 0,
        completion_rate: 0,
        errors: [],
        publishable: false,
        gbrain_version: gbrainVersionResolved(),
        gbrain_pin: gbrainPin(),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      writeReceipt(receiptFile, receipt);
      log(`[cat29] SKIPPED: ${receipt.skip_reason}\n`);
      return { receipt, rows: [], exitCode: options.allowSkip ? 0 : 1, receiptFile };
    }
  }

  if (stub) {
    installStubEmbed(); // hash-embed transport + dummy OPENAI key (import AND query sides)
  } else {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: process.env as Record<string, string | undefined>,
    });
  }

  const judgeConfig: JudgeConfig = {
    client: options.judgeClient ?? (stub ? makeStubJudgeClient() as unknown as JudgeConfig['client'] : undefined),
    model: JUDGE_MODEL,
    systemPromptVersion: RUBRIC_VERSION,
  };
  const thinkResponseFor = options.thinkResponseFor ?? (stub ? defaultStubThinkResponse : undefined);

  // ── Seed one brain with the corpus (pinned config BEFORE ingest) ──
  const pages = options.pages ?? loadSyntheticV1();
  const engine: any = new PGLiteEngine();
  const origLog = console.log;
  console.log = () => {};
  let thinkModelUsed: string | null = null;
  const rows: QuestionResult[] = [];
  let questions: Cat29Question[] = [];
  let judgeCost = 0;
  let acc: ProbeAccounting;
  try {
    await engine.connect({});
    await engine.initSchema();
    for (const [key, value] of Object.entries(PINNED_CONFIG)) await engine.setConfig(key, value);
    await engine.setConfig('models.think', THINK_MODEL);
    for (const p of pages) {
      await importFromContent(engine, p.slug, p.body, { noEmbed: false });
    }
    console.log = origLog;
    log(`[cat29] seeded ${pages.length} pages${stub ? ' [STUB — hash embeds, stub think, stub judge]' : ''}\n`);

    questions = options.questions ?? buildQuestions(pages);
    const limit = options.questionLimit ?? questions.length;
    questions = questions.slice(0, Math.max(0, limit));
    if (questions.length === 0) throw new Error('no questions derivable from the provided corpus');
    acc = new ProbeAccounting(questions.length);

    for (const q of questions) {
      log(`[cat29] running ${q.id}...\n`);
      const sutErrors: string[] = [];

      // SEARCH side: raw retrieved payload (what an agent would dump).
      let searchAns: string | null = null;
      try {
        const results = await hybridSearch(engine, q.text, { limit: 5 } as any);
        searchAns = results.length === 0
          ? '(no results)'
          : `Top retrieved pages:\n${(results as any[]).slice(0, 5).map((r: any, i: number) => {
              const body = String(r.chunk_text ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
              return `${i + 1}. ${r.slug} — ${body}`;
            }).join('\n')}`;
      } catch (e: any) {
        sutErrors.push(`search: ${e?.message ?? e}`);
        acc.error(q.id, 'sut', `search failed: ${e?.message ?? e}`);
      }

      // THINK side: full synthesis pipeline (gather runs against the real
      // engine even under --stub; only the LLM call is stubbed).
      let thinkAns: string | null = null;
      try {
        const r = await runThink(engine, {
          question: q.text,
          remote: false,
          ...(thinkResponseFor ? { stubResponse: thinkResponseFor(q) } : {}),
        });
        thinkModelUsed = thinkModelUsed ?? r.modelUsed;
        thinkAns = r.answer && r.answer.trim().length > 0 ? r.answer : null;
        if (thinkAns === null) {
          sutErrors.push(`think: empty answer (synthesis_status=${r.synthesis_status ?? 'unknown'})`);
          acc.error(q.id, 'sut', `think produced no answer (${r.synthesis_status ?? 'unknown'})`);
        }
      } catch (e: any) {
        sutErrors.push(`think: ${e?.message ?? e}`);
        acc.error(q.id, 'sut', `think failed: ${e?.message ?? e}`);
      }

      // BLIND judging, both orders. 'a' = search, 'b' = think — labels never
      // reach the judge; the mapping exists only in this runner.
      try {
        const pair = await judgePair(q, { a: searchAns, b: thinkAns }, pages, judgeConfig);
        judgeCost += pair.cost_usd;
        rows.push({
          question_id: q.id,
          question_text: q.text,
          expected_facts: q.expected_facts,
          search_answer: searchAns?.slice(0, 500) ?? null,
          think_answer: thinkAns?.slice(0, 500) ?? null,
          search_score: pair.a,
          think_score: pair.b,
          think_wins: pair.b > pair.a,
          judge_excluded: false,
          sut_errors: sutErrors,
        });
        // Probe score = think - search delta on the 0-5 judge scale.
        acc.score(q.id, pair.b - pair.a);
        log(`[cat29]   ${q.id}: search=${pair.a.toFixed(2)} think=${pair.b.toFixed(2)} Δ=${(pair.b - pair.a).toFixed(2)}\n`);
      } catch (e: any) {
        if (e instanceof JudgeFailure) {
          // Judge infra failure: EXCLUDED from means, recorded, capped —
          // never folded in as 0 (audit cats26-29-11).
          acc.error(q.id, 'judge', e.message);
          rows.push({
            question_id: q.id,
            question_text: q.text,
            expected_facts: q.expected_facts,
            search_answer: searchAns?.slice(0, 500) ?? null,
            think_answer: thinkAns?.slice(0, 500) ?? null,
            search_score: null,
            think_score: null,
            think_wins: null,
            judge_excluded: true,
            sut_errors: sutErrors,
          });
          log(`[cat29]   ${q.id}: JUDGE EXCLUDED (${e.message})\n`);
        } else {
          throw e;
        }
      }
    }
  } finally {
    console.log = origLog;
    if (stub) __setEmbedTransportForTests(null);
    try { await engine.disconnect(); } catch { /* already dead */ }
  }

  const judged = rows.filter(r => !r.judge_excluded);
  const mean = (key: 'search_score' | 'think_score') =>
    judged.length === 0 ? NaN : judged.reduce((a, r) => a + (r[key] ?? 0), 0) / judged.length;
  const sMean = mean('search_score');
  const tMean = mean('think_score');
  const verdict = computeVerdict(rows, questions.length);
  const summary = acc.summary();

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CAT29_CATEGORY,
    run_status: 'completed',
    verdict,
    n_total: summary.n_total,
    n_scored: summary.n_scored,
    completion_rate: summary.completion_rate,
    errors: summary.errors,
    publishable: summary.publishable && !stub && !options.questions && !options.pages
      && (options.questionLimit === undefined),
    gbrain_version: gbrainVersionResolved(),
    gbrain_pin: gbrainPin(),
    resolved_config: {
      ...PINNED_CONFIG,
      'models.think': THINK_MODEL,
      think_model_used: thinkModelUsed,
      embed_transport: stub ? 'stubbed-hash' : 'live',
      think_llm: stub || options.thinkResponseFor ? 'stubbed' : 'live',
      judge_mode: options.judgeClient || stub ? 'injected/stub' : 'live',
      judge_blind: true,
      judge_both_orders: true,
    },
    judge: { model: stub ? 'stub-judge' : JUDGE_MODEL, temperature: 0, rubric_version: RUBRIC_VERSION },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      corpus: 'synthetic-v1',
      corpus_pages: pages.length,
      questions: questions.length,
      questions_judged: judged.length,
      search_mean_score_0to5: Number.isNaN(sMean) ? null : sMean,
      think_mean_score_0to5: Number.isNaN(tMean) ? null : tMean,
      think_wins: judged.filter(r => (r.think_score ?? 0) > (r.search_score ?? 0)).length,
      search_wins: judged.filter(r => (r.search_score ?? 0) > (r.think_score ?? 0)).length,
      ties: judged.filter(r => r.search_score === r.think_score).length,
      judge_cost_usd: judgeCost,
      per_question: rows,
    },
  };
  writeReceipt(receiptFile, receipt);

  const outDir = join(reportsDir, CAT29_CATEGORY);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat29.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  log(`\n[cat29] ─── Scorecard ───────────────────\n`);
  log(`[cat29]   corpus:           synthetic-v1 (${pages.length} pages)\n`);
  log(`[cat29]   questions:        ${questions.length} (${judged.length} judged, ${rows.length - judged.length} judge-excluded)\n`);
  log(`[cat29]   search mean:      ${Number.isNaN(sMean) ? 'n/a' : sMean.toFixed(2)}/5\n`);
  log(`[cat29]   think mean:       ${Number.isNaN(tMean) ? 'n/a' : tMean.toFixed(2)}/5\n`);
  log(`[cat29]   think model:      ${thinkModelUsed ?? 'n/a'} (pinned ${THINK_MODEL})\n`);
  log(`[cat29]   verdict:          ${verdict} (run_invalid=${summary.run_invalid}, publishable=${receipt.publishable})\n`);
  log(`[cat29]   receipt:          ${receiptFile}\n`);

  const exitCode = summary.run_invalid ? 1 : (verdict === 'pass' ? 0 : 1);
  return { receipt, rows, exitCode, receiptFile };
}

if (import.meta.main) {
  try {
    const result = await runCat29(optionsFromEnv());
    process.exit(result.exitCode);
  } catch (e: any) {
    try {
      writeReceipt(receiptPath(CAT29_CATEGORY), {
        schema_version: RECEIPT_SCHEMA_VERSION,
        benchmark_version: BENCHMARK_VERSION,
        category: CAT29_CATEGORY,
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
    process.stderr.write(`[cat29] FATAL: ${e?.stack ?? e}\n`);
    process.exit(1);
  }
}
