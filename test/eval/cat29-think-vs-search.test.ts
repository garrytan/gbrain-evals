/**
 * cat29-think-vs-search.ts regression tests (audit cats26-29-10/11/12/13/18).
 *
 * Hermetic: no API keys. Embeds go through gbrain's
 * __setEmbedTransportForTests seam (hash vectors + dummy OPENAI key,
 * installed by the runner in stub mode); think uses runThink's stubResponse
 * seam; the judge is an injected client behind judge.ts scoreAnswer.
 *
 * Gates proven failable AND passing:
 *   - the judge is BLIND: no 'think'/'search' label or system identity ever
 *     reaches the judge prompt, and every answer is judged in BOTH orders
 *   - judge failures land as probe-accounting origin 'judge' and are
 *     EXCLUDED from means (never folded in as 0)
 *   - expected facts extracted from the committed corpus appear in the
 *     rubric + ground truth, so hallucinated specifics can be caught
 *   - the verdict can FAIL (garbage think answers lose to search) and
 *     passes on good input; keyless live mode skips with a non-zero exit
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CAT29_CATEGORY,
  THINK_MODEL,
  PINNED_CONFIG,
  buildQuestions,
  arrReadings,
  rubricFor,
  evidenceFor,
  seededCoin,
  makeStubJudgeClient,
  defaultStubThinkResponse,
  computeVerdict,
  runCat29,
  type Cat29Question,
  type QuestionResult,
} from '../../eval/runner/cat29-think-vs-search.ts';
import { loadSyntheticV1, type SyntheticPage } from '../../eval/runner/synthetic-corpus-loader.ts';
import { loadReceipt, receiptPath } from '../../eval/runner/receipt.ts';
import type { JudgeConfig } from '../../eval/runner/judge.ts';

const RUN_TIMEOUT = 240_000;

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat29-test-reports-'));
}

// Mini corpus: enough for one ARR question; deliberately free of the words
// "think"/"search" so the blindness assertion is airtight.
const MINI_PAGES: SyntheticPage[] = [
  {
    slug: 'companies/acme-co-0',
    type: 'company',
    body: [
      '---', 'type: company', 'title: Acme CO 0', '---', '',
      '# Acme CO 0', '', 'A widgets company. Founded 2020.', '',
      '## Facts', '',
      '| since | claim | metric | value | unit | period |',
      '|-------|-------|--------|-------|------|--------|',
      '| 2025-01-15 | ARR is $120K | arr | 119737 | usd | annual |',
      '| 2025-08-20 | ARR is $502K | arr | 502387 | usd | annual |',
    ].join('\n'),
  },
  {
    slug: 'people/alice-example',
    type: 'person',
    body: '---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\nCEO at [[companies/acme-co-0]].',
  },
];

const MINI_QUESTION: Cat29Question = {
  id: 'tq1-acme-arr',
  text: 'What are the ARR readings of the Acme CO 0 company?',
  expected_facts: ['ARR is $120K as of 2025-01-15', 'ARR is $502K as of 2025-08-20'],
  gold_slugs: ['companies/acme-co-0'],
};

// ─── Expected facts extracted from the committed corpus (cats26-29-18) ─

describe('buildQuestions expected facts', () => {
  const pages = loadSyntheticV1();
  const questions = buildQuestions(pages);

  test('derives the full question set with concrete facts', () => {
    expect(questions.length).toBe(5);
    for (const q of questions) expect(q.expected_facts.length).toBeGreaterThan(0);
  });

  test('ARR trajectory question carries the real seeded values in date order', () => {
    const q2 = questions.find(q => q.id === 'q2-acme-arr-trajectory');
    expect(q2).toBeDefined();
    const facts = q2!.expected_facts.join(' | ');
    expect(facts).toContain('ARR is $120K as of 2025-01-15');
    expect(facts).toContain('ARR is $502K as of 2025-08-20');
    expect(facts).toContain('ARR is $842K as of 2026-04-10');
    expect(facts.indexOf('2025-01-15')).toBeLessThan(facts.indexOf('2026-04-10'));
  });

  test('meeting question carries the real seeded attendee slugs', () => {
    const q4 = questions.find(q => q.id === 'q4-autonomous-picking-attendees');
    const facts = q4!.expected_facts.join(' | ');
    expect(facts).toContain('people/paul-example-41');
    expect(facts).toContain('people/grace-placeholder-6');
  });

  test('facts land in the judge rubric and ground truth, never a verdict prior', () => {
    const q = MINI_QUESTION;
    const rubric = rubricFor(q);
    const factsCriterion = rubric.find(c => c.id === 'facts');
    expect(factsCriterion?.criterion).toContain('ARR is $120K as of 2025-01-15');
    const ev = evidenceFor(q, 'some answer', MINI_PAGES);
    const digest = ev.ground_truth_pages.find(p => p.slug === '_gold/expected-facts');
    expect(digest?.content).toContain('ARR is $502K as of 2025-08-20');
    // no expected-verdict leakage anywhere in the rendered evidence inputs
    const all = JSON.stringify(ev);
    expect(all).not.toMatch(/should win|is better|synthes/i);
  });

  test('arrReadings sorts by date', () => {
    const rows = arrReadings('| 2026-01-01 | ARR is $2 | arr | 2 | usd | annual |\n| 2025-01-01 | ARR is $1 | arr | 1 | usd | annual |');
    expect(rows.map(r => r.since)).toEqual(['2025-01-01', '2026-01-01']);
  });
});

// ─── Determinism ──────────────────────────────────────────────────────

describe('seededCoin', () => {
  test('deterministic per question id', () => {
    expect(seededCoin('q1')).toBe(seededCoin('q1'));
    const flips = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(seededCoin);
    expect(new Set(flips).size).toBe(2); // both outcomes occur across ids
  });
});

// ─── Verdict: failable + passing (pure) ───────────────────────────────

function row(overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
    question_id: 'q',
    question_text: 't',
    expected_facts: [],
    search_answer: 's',
    think_answer: 't',
    search_score: 2,
    think_score: 4,
    think_wins: true,
    judge_excluded: false,
    sut_errors: [],
    ...overrides,
  };
}

describe('computeVerdict', () => {
  test('pass when all judged and think >= search', () => {
    expect(computeVerdict([row(), row({ question_id: 'q2' })], 2)).toBe('pass');
  });
  test('FAILS when think loses on the judged mean (constructed bad input)', () => {
    expect(computeVerdict([row({ search_score: 4, think_score: 1, think_wins: false })], 1)).toBe('fail');
  });
  test('FAILS when nothing was judged (all judge-excluded)', () => {
    expect(computeVerdict([row({ judge_excluded: true, search_score: null, think_score: null })], 1)).toBe('fail');
  });
  test('partial when think >= search but some questions were judge-excluded', () => {
    expect(computeVerdict([row(), row({ question_id: 'q2', judge_excluded: true, search_score: null, think_score: null })], 2)).toBe('partial');
  });
});

// ─── Hermetic end-to-end: blind judging, both orders (cats26-29-10) ───

describe('runCat29 blind judging', () => {
  test('judge prompts carry no system identity; both orders judged; pins recorded', async () => {
    const reportsDir = tmpReports();
    const prompts: string[] = [];
    const r = await runCat29({
      stub: true,
      pages: MINI_PAGES,
      questions: [MINI_QUESTION],
      reportsDir,
      quiet: true,
      judgeClient: makeStubJudgeClient({ onRequest: c => prompts.push(c) }) as unknown as JudgeConfig['client'],
    });

    // 2 answers × 2 orders = 4 blind judge calls for the one question.
    expect(prompts.length).toBe(4);
    for (const p of prompts) {
      expect(p).not.toMatch(/\bthink\b/i);   // system identity never reaches the judge
      expect(p).not.toMatch(/\bsearch\b/i);
      expect(p).not.toMatch(/labeled/i);
      expect(p).toContain('ARR is $120K as of 2025-01-15'); // ground truth present
    }

    expect(r.receipt.run_status).toBe('completed');
    expect(r.receipt.n_total).toBe(1);
    expect(r.receipt.n_scored).toBe(1);
    // model pin recorded (cats26-29-12) and 'gbrain/think' path resolves it
    expect(r.receipt.resolved_config?.['models.think']).toBe(THINK_MODEL);
    expect(r.receipt.resolved_config?.think_model_used).toBe(THINK_MODEL);
    for (const [k, v] of Object.entries(PINNED_CONFIG)) {
      expect(r.receipt.resolved_config?.[k]).toBe(v);
    }
    expect(r.receipt.resolved_config?.judge_both_orders).toBe(true);
    // fact-rich stub think beats the raw dump → gate passes on good input
    expect(r.receipt.verdict).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.receipt.publishable).toBe(false); // stub + injected fixtures

    const loaded = loadReceipt(receiptPath(CAT29_CATEGORY, reportsDir));
    expect(loaded.category).toBe(CAT29_CATEGORY);
  }, RUN_TIMEOUT);

  test('garbage think answers LOSE and fail the gate (constructed bad input)', async () => {
    const reportsDir = tmpReports();
    const r = await runCat29({
      stub: true,
      pages: MINI_PAGES,
      questions: [MINI_QUESTION],
      reportsDir,
      quiet: true,
      thinkResponseFor: () => ({ answer: 'no idea, sorry', citations: [], gaps: [] }),
    });
    expect(r.receipt.verdict).toBe('fail');
    expect(r.exitCode).toBe(1);
    const data = r.receipt.data as Record<string, any>;
    expect(data.think_mean_score_0to5).toBeLessThan(data.search_mean_score_0to5);
  }, RUN_TIMEOUT);
});

// ─── Judge failures excluded, never scored 0 (cats26-29-11) ───────────

describe('runCat29 judge failure accounting', () => {
  test('judge API failure => origin judge, question EXCLUDED from means, non-zero exit', async () => {
    const reportsDir = tmpReports();
    const r = await runCat29({
      stub: true,
      pages: MINI_PAGES,
      questions: [MINI_QUESTION],
      reportsDir,
      quiet: true,
      judgeClient: makeStubJudgeClient({ failOn: () => true }) as unknown as JudgeConfig['client'],
    });
    expect(r.receipt.errors.length).toBe(1);
    expect(r.receipt.errors[0].origin).toBe('judge');
    expect(r.receipt.n_scored).toBe(0); // excluded, not scored 0
    const data = r.receipt.data as Record<string, any>;
    expect(data.search_mean_score_0to5).toBeNull(); // no fake-0 means
    expect(data.think_mean_score_0to5).toBeNull();
    expect(r.rows[0].judge_excluded).toBe(true);
    expect(r.receipt.verdict).toBe('fail'); // nothing judged
    expect(r.exitCode).toBe(1);
    expect(r.receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);

  test('partial judge failure excludes only the failed question (verdict partial)', async () => {
    const reportsDir = tmpReports();
    const q2: Cat29Question = { ...MINI_QUESTION, id: 'tq2-acme-arr-copy' };
    const r = await runCat29({
      stub: true,
      pages: MINI_PAGES,
      questions: [MINI_QUESTION, q2],
      reportsDir,
      quiet: true,
      judgeClient: makeStubJudgeClient({ failOn: c => c.includes('tq2-acme-arr-copy') }) as unknown as JudgeConfig['client'],
    });
    expect(r.receipt.n_total).toBe(2);
    expect(r.receipt.n_scored).toBe(1);
    expect(r.receipt.errors.map(e => e.origin)).toEqual(['judge']);
    expect(r.receipt.verdict).toBe('partial');
    expect(r.exitCode).toBe(1); // partial is not a pass
  }, RUN_TIMEOUT);
});

// ─── Keyless live mode: skip is loud, never a fake pass ───────────────

describe('runCat29 skip path', () => {
  test('missing keys without --stub => skipped receipt + non-zero exit; --allow-skip => 0', async () => {
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const reportsDir = tmpReports();
      const r = await runCat29({ stub: false, reportsDir, quiet: true });
      expect(r.receipt.run_status).toBe('skipped');
      expect(r.receipt.skip_reason).toContain('ANTHROPIC_API_KEY');
      expect(r.receipt.verdict).toBeUndefined();
      expect(r.exitCode).toBe(1);

      const r2 = await runCat29({ stub: false, allowSkip: true, reportsDir, quiet: true });
      expect(r2.receipt.run_status).toBe('skipped');
      expect(r2.exitCode).toBe(0);
    } finally {
      if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
      if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
    }
  }, RUN_TIMEOUT);
});
