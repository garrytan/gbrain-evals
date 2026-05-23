/**
 * BrainBench Cat 20 — brainstorm novelty / usefulness / grounding (v0.37.0.0).
 *
 * Headline question: does `gbrain brainstorm` produce ideas that are
 * BOTH novel (lateral, distance-stratified across the brain) AND grounded
 * (cite real pages) AND useful (actionable, not generic)?
 *
 * Hermetic-ish: synthetic-v1 corpus + Sonnet brainstorm + Haiku judge.
 * Cost: ~$2-3 (3 brainstorms × ~$0.40 each + 3 judges × ~$0.10).
 *
 * Run:
 *   bun eval/runner/cat20-brainstorm.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { runBrainstorm, BRAINSTORM_PROFILE } from '../../node_modules/gbrain/src/core/brainstorm/orchestrator.ts';
import { loadSyntheticV1 } from './synthetic-corpus-loader.ts';

const ISOLATED_HOME = join(tmpdir(), `cat20-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

const QUESTIONS = [
  "What is a non-obvious next-step product for an inference-platform company that already serves autonomous-picking?",
  "How could a fund focused on early ML differentiate from competitors going after the same wave?",
  "What is an unexplored research direction that combines agent memory with autonomous-picking robotics?",
];

interface JudgeAxes {
  novelty: number;       // 0-10 lateral / non-obvious
  usefulness: number;    // 0-10 actionable
  grounding: number;     // 0-10 cites real pages
  verdict: string;
}

interface QuestionResult {
  question: string;
  idea_count: number;
  ideas_sample: { close: string[]; far: string[] };
  judge: JudgeAxes;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat20-brainstorm';
  gbrain_version: string;
  timestamp: string;
  corpus: 'synthetic-v1';
  questions: number;
  per_question: QuestionResult[];
  mean_novelty: number;
  mean_usefulness: number;
  mean_grounding: number;
}

async function judgeIdeas(client: any, question: string, ideas: string): Promise<JudgeAxes> {
  const prompt = `You are judging brainstorm ideas for a personal-knowledge agent.

Question: ${question}
Generated ideas (truncated): ${ideas.slice(0, 2000)}

Score 0-10 on each axis:
- novelty: how lateral / non-obvious are the ideas? (10 = surprising bisociations, 5 = mix of obvious + lateral, 0 = trivial)
- usefulness: how actionable for a founder/operator? (10 = paste-ready next steps, 5 = direction-only, 0 = empty platitudes)
- grounding: how well do ideas cite the underlying brain pages? (10 = every idea cites a slug, 5 = some citations, 0 = floating in vacuum)

Reply with EXACTLY this JSON (no prose):
{"novelty": <0-10>, "usefulness": <0-10>, "grounding": <0-10>, "verdict": "<one sentence>"}`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      novelty: Number(parsed.novelty) || 0,
      usefulness: Number(parsed.usefulness) || 0,
      grounding: Number(parsed.grounding) || 0,
      verdict: String(parsed.verdict ?? ''),
    };
  } catch (e: any) {
    return { novelty: 0, usefulness: 0, grounding: 0, verdict: `judge error: ${e?.message ?? e}` };
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

  const pages = loadSyntheticV1();
  const engine: any = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const origLog = console.log;
  console.log = () => {};
  for (const p of pages) await importFromContent(engine, p.slug, p.body, { noEmbed: false });
  console.log = origLog;
  process.stderr.write(`[cat20] seeded ${pages.length} pages\n`);

  const perQ: QuestionResult[] = [];

  for (const question of QUESTIONS) {
    process.stderr.write(`[cat20] brainstorm: "${question.slice(0, 60)}..."\n`);
    let ideas: any[] = [];
    let result: any = null;
    try {
      result = await runBrainstorm(engine, { embedding_model: 'openai:text-embedding-3-large' }, {
        question,
        profile: BRAINSTORM_PROFILE,
        maxCostUsd: 1.0,
      } as any);
      ideas = result?.ideas ?? [];
    } catch (e: any) {
      process.stderr.write(`[cat20]   brainstorm error: ${e?.message ?? e}\n`);
    }

    const ideasText = ideas.map((i: any, n: number) =>
      `[${i.id ?? n + 1}] (close=${i.close_slug}, far=${i.far_slug}) ${(i.text ?? '').slice(0, 250).replace(/\s+/g, ' ')}`
    ).join('\n');
    const closeSample = ideas.slice(0, 3).map((i: any) => i.close_slug ?? '');
    const farSample = ideas.slice(0, 3).map((i: any) => i.far_slug ?? '');

    const j = await judgeIdeas(judgeClient, question, ideasText);
    perQ.push({
      question,
      idea_count: ideas.length,
      ideas_sample: { close: closeSample, far: farSample },
      judge: j,
    });
    process.stderr.write(`[cat20]   ideas=${ideas.length} novelty=${j.novelty} usefulness=${j.usefulness} grounding=${j.grounding}\n`);
  }

  await engine.disconnect();

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const mNov = perQ.reduce((a, p) => a + p.judge.novelty, 0) / Math.max(1, perQ.length);
  const mUse = perQ.reduce((a, p) => a + p.judge.usefulness, 0) / Math.max(1, perQ.length);
  const mGr = perQ.reduce((a, p) => a + p.judge.grounding, 0) / Math.max(1, perQ.length);

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat20-brainstorm',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    corpus: 'synthetic-v1',
    questions: perQ.length,
    per_question: perQ,
    mean_novelty: mNov,
    mean_usefulness: mUse,
    mean_grounding: mGr,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat20-brainstorm');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat20.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat20] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat20]   corpus:            synthetic-v1 (${pages.length} pages)\n`);
  process.stderr.write(`[cat20]   questions:         ${perQ.length}\n`);
  process.stderr.write(`[cat20]   mean novelty:      ${mNov.toFixed(1)}/10\n`);
  process.stderr.write(`[cat20]   mean usefulness:   ${mUse.toFixed(1)}/10\n`);
  process.stderr.write(`[cat20]   mean grounding:    ${mGr.toFixed(1)}/10\n`);
  process.stderr.write(`[cat20]   receipt:           ${outFile}\n`);
}

await main();
