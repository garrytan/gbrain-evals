/**
 * BrainBench Cat 29 — `gbrain think` synthesis vs raw `search` quality.
 *
 * The headline product question from Garry's 2026-05-23 X thread:
 * "Search gives you raw pages. Think gives you the answer." This Cat
 * measures whether the synthesis layer actually produces better answers
 * than the raw retrieved slug list on a fixture of multi-page relational
 * questions.
 *
 * Hermetic (synthetic-v1 corpus, no PII). Cost: ~$3 — one Sonnet think
 * call per question × N questions, plus one Haiku judge per pair (search
 * vs think).
 *
 * Flow per question:
 *   1. Run `hybridSearch` for the question → "search" answer = top-3 slugs
 *      + their first 200 chars (the raw context an agent would dump).
 *   2. Run `runThink` for the question → "think" answer = synthesized prose
 *      with citations.
 *   3. Haiku judge scores both 0-10 on (accuracy + groundedness + utility)
 *      against the gold answer.
 *   4. Aggregate: mean think score, mean search score, win-rate per question.
 *
 * Run:
 *   bun eval/runner/cat29-think-vs-search.ts
 *   CAT29_QUESTIONS=4 bun eval/runner/cat29-think-vs-search.ts  (smoke)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { hybridSearch } from 'gbrain/search/hybrid';
import { runThink } from '../../node_modules/gbrain/src/core/think/index.ts';
import { loadSyntheticV1 } from './synthetic-corpus-loader.ts';

// Pre-flight: isolate GBRAIN_HOME so user's config doesn't override.
const ISOLATED_HOME = join(tmpdir(), `cat29-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

interface Question {
  id: string;
  text: string;
  gold: string;  // human-written gold answer (synthesized from corpus knowledge)
}

const QUESTIONS: Question[] = [
  {
    id: 'q1-who-runs-acme',
    text: 'Who works at the Horizon TECH 6 company? What roles do they hold?',
    gold: 'Horizon TECH 6 is referenced from multiple people pages and at least one deal page. The synthesized answer should list the linked people and acknowledge any role information (CEO, CTO, etc.) that the people pages mention. Strong answers cite specific people-page slugs.',
  },
  {
    id: 'q2-foundry-arr-trajectory',
    text: 'Has the ARR of the Acme AI 0 company grown over time? What were the readings?',
    gold: 'The synthetic corpus seeds Acme AI 0 with 3 Facts-fence ARR readings on 3 different dates (2025-01-15, 2025-08-20, 2026-04-10). The synthesized answer should report the trajectory in order, including approximate values, and ideally note that ARR grew across all three.',
  },
  {
    id: 'q3-multi-source-fund',
    text: 'Which concept pages do the largest number of company pages link to?',
    gold: 'The corpus has 25 concept pages. The synthesized answer should name 2-5 concepts that show up multiple times in companies references, with at least slug citations.',
  },
  {
    id: 'q4-attendees',
    text: 'Who was at the autonomous-picking meeting? What did they discuss?',
    gold: 'The synthetic corpus has 20 meetings, some about autonomous-picking. The synthesized answer should name attendees by people-page slug and summarize the discussion topic.',
  },
  {
    id: 'q5-gap-test',
    text: 'What is the current ARR of Cobalt-Cloud-15 as of May 2026?',
    gold: 'The corpus seeds Cobalt-Cloud-15 with ARR readings at 2025-01-15, 2025-08-20, and 2026-04-10. The most recent ARR reading is from 2026-04-10. A correct answer either reports the 2026-04-10 ARR value OR notes that the most recent reading is older than May 2026 (gap analysis).',
  },
];

interface JudgeScore {
  score: number;
  verdict: string;
}

interface QuestionResult {
  question_id: string;
  question_text: string;
  search_answer: string;
  think_answer: string;
  search_judge: JudgeScore;
  think_judge: JudgeScore;
  think_wins: boolean;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat29-think-vs-search';
  gbrain_version: string;
  timestamp: string;
  corpus: 'synthetic-v1';
  corpus_pages: number;
  questions: number;
  search_mean_score: number;
  think_mean_score: number;
  think_wins: number;
  search_wins: number;
  ties: number;
  per_question: QuestionResult[];
}

async function judge(client: any, question: string, gold: string, answer: string, label: string): Promise<JudgeScore> {
  const prompt = `You are a strict judge scoring an answer to a question.

Question: ${question}
Gold-answer expectation: ${gold}
Answer to judge (labeled ${label}): ${answer}

Score 0-10 on this combined rubric (accuracy + groundedness + utility):
- 10: matches the gold expectation, accurate, well-grounded with citations, useful
- 7-9: mostly correct, good grounding, useful
- 4-6: partial info, weak grounding, partially useful
- 1-3: wrong direction, hallucinated, or unhelpful
- 0: blank, error, or refused

Reply with EXACTLY this JSON (no prose, no fence):
{"score": <0-10 integer>, "verdict": "<one sentence reasoning>"}`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return { score: Number(parsed.score) || 0, verdict: String(parsed.verdict || '') };
  } catch (e: any) {
    return { score: 0, verdict: `judge error: ${e?.message ?? e}` };
  }
}

async function searchAnswer(engine: any, q: string): Promise<string> {
  try {
    const results = await hybridSearch(engine, q, { limit: 5 } as any);
    if (results.length === 0) return '(no results)';
    const lines = (results as any[]).slice(0, 5).map((r: any, i: number) => {
      const body = (r.compiled_truth ?? r.chunk_text ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
      return `${i + 1}. ${r.slug} — ${body}`;
    });
    return `Top retrieved pages:\n${lines.join('\n')}`;
  } catch (e: any) {
    return `(search error: ${e?.message ?? e})`;
  }
}

async function thinkAnswer(engine: any, q: string): Promise<string> {
  try {
    const r = await runThink(engine, { question: q } as any);
    return (r as any).answer ?? (r as any).response?.answer ?? (r as any).synthesis ?? JSON.stringify(r).slice(0, 600);
  } catch (e: any) {
    return `(think error: ${e?.message ?? e})`;
  }
}

async function main(): Promise<void> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: process.env as Record<string, string | undefined>,
  });

  const judgeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // One brain holds the whole synthetic corpus
  const pages = loadSyntheticV1();
  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};
  for (const p of pages) {
    await importFromContent(engine, p.slug, p.body, { noEmbed: false });
  }
  console.log = origLog;
  process.stderr.write(`[cat29] seeded ${pages.length} pages\n`);

  const Q_LIMIT = parseInt(process.env.CAT29_QUESTIONS ?? '5', 10);
  const subset = QUESTIONS.slice(0, Q_LIMIT);

  const perQ: QuestionResult[] = [];
  for (const q of subset) {
    process.stderr.write(`[cat29] running ${q.id}...\n`);
    const searchAns = await searchAnswer(engine, q.text);
    const thinkAns = await thinkAnswer(engine, q.text);
    const sJ = await judge(judgeClient, q.text, q.gold, searchAns, 'search');
    const tJ = await judge(judgeClient, q.text, q.gold, thinkAns, 'think');
    perQ.push({
      question_id: q.id,
      question_text: q.text,
      search_answer: searchAns.slice(0, 500),
      think_answer: thinkAns.slice(0, 500),
      search_judge: sJ,
      think_judge: tJ,
      think_wins: tJ.score > sJ.score,
    });
    process.stderr.write(`[cat29]   ${q.id}: search=${sJ.score} think=${tJ.score} Δ=${tJ.score - sJ.score >= 0 ? '+' : ''}${tJ.score - sJ.score}\n`);
  }

  await engine.disconnect();

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const sMean = perQ.reduce((a, p) => a + p.search_judge.score, 0) / Math.max(1, perQ.length);
  const tMean = perQ.reduce((a, p) => a + p.think_judge.score, 0) / Math.max(1, perQ.length);

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat29-think-vs-search',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus: 'synthetic-v1',
    corpus_pages: pages.length,
    questions: perQ.length,
    search_mean_score: sMean,
    think_mean_score: tMean,
    think_wins: perQ.filter(p => p.think_judge.score > p.search_judge.score).length,
    search_wins: perQ.filter(p => p.search_judge.score > p.think_judge.score).length,
    ties: perQ.filter(p => p.search_judge.score === p.think_judge.score).length,
    per_question: perQ,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat29-think-vs-search');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat29.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat29] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat29]   corpus:           synthetic-v1 (${pages.length} pages)\n`);
  process.stderr.write(`[cat29]   questions:        ${perQ.length}\n`);
  process.stderr.write(`[cat29]   search mean:      ${sMean.toFixed(2)}/10\n`);
  process.stderr.write(`[cat29]   think mean:       ${tMean.toFixed(2)}/10\n`);
  process.stderr.write(`[cat29]   think Δ:          ${(tMean - sMean).toFixed(2)}pt\n`);
  process.stderr.write(`[cat29]   think wins:       ${receipt.think_wins}\n`);
  process.stderr.write(`[cat29]   search wins:      ${receipt.search_wins}\n`);
  process.stderr.write(`[cat29]   ties:             ${receipt.ties}\n`);
  process.stderr.write(`[cat29]   receipt:          ${outFile}\n`);
}

await main();
