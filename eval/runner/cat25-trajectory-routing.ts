/**
 * BrainBench Cat 25 — trajectory routing A/B (v0.40.2.0).
 *
 * Headline question: does `gbrain think` with trajectory routing on
 * (default in v0.40.2.0) produce better temporal answers than think
 * with trajectory off?
 *
 * Hermetic seed (no external dataset download). Per-probe:
 *   1. Seed a brain with typed-claim facts about a fictional entity
 *      (mrr/arr/team_size over multiple dates).
 *   2. Build a temporal question ("what was the ARR in March?")
 *   3. Run runThink with withTrajectory=false (baseline), then true (wave).
 *   4. Judge each answer against the gold via a Haiku call.
 *   5. Report per-probe judge score + aggregate.
 *
 * Cost: ~$1 in Sonnet (4 think calls × 6 probes) + ~$0.30 Haiku judge.
 *
 * Run:
 *   bun eval/runner/cat25-trajectory-routing.ts
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import { configureGateway } from 'gbrain/ai/gateway';
import { runThink } from '../../node_modules/gbrain/src/core/think/index.ts';

// Isolate GBRAIN_HOME so the user's ~/.gbrain/config.json doesn't override
const ISOLATED_HOME = join(tmpdir(), `cat25-gbrain-home-${Date.now()}`);
mkdirSync(ISOLATED_HOME, { recursive: true });
process.env.GBRAIN_HOME = ISOLATED_HOME;

interface Probe {
  id: string;
  description: string;
  // Seed pages with typed-claim facts in the Facts fence
  pages: { slug: string; body: string }[];
  question: string;
  gold_answer: string;  // human-judged correct answer
}

const PROBES: Probe[] = [
  {
    id: 'arr-trajectory-acme',
    description: 'ARR changed across 3 dates; question asks for a specific date.',
    pages: [
      {
        slug: 'companies/acme-ai',
        body: `# Acme AI

Acme AI is an AI infrastructure company.

## Facts

| since | claim | metric | value | unit | period |
|-------|-------|--------|-------|------|--------|
| 2026-01-15 | ARR is $500K | arr | 500000 | usd | annual |
| 2026-03-10 | ARR is $1.2M | arr | 1200000 | usd | annual |
| 2026-05-01 | ARR is $2.5M | arr | 2500000 | usd | annual |
`,
      },
    ],
    question: 'What was the ARR of Acme AI in March 2026?',
    gold_answer: 'Approximately $1.2M (most recent reading on or before March 2026 was $1.2M as of 2026-03-10).',
  },
  {
    id: 'team-size-trajectory-foundry',
    description: 'Team size changed across 2 dates.',
    pages: [
      {
        slug: 'companies/foundry-labs',
        body: `# Foundry Labs

Robotics startup.

## Facts

| since | claim | metric | value | unit | period |
|-------|-------|--------|-------|------|--------|
| 2026-01-10 | team is 8 people | team_size | 8 | people | snapshot |
| 2026-04-15 | team is 15 people | team_size | 15 | people | snapshot |
`,
      },
    ],
    question: 'How big was the Foundry Labs team in January 2026?',
    gold_answer: '8 people (per the 2026-01-10 reading).',
  },
];

interface ProbeResult {
  probe_id: string;
  question: string;
  baseline_answer: string;
  wave_answer: string;
  baseline_judge: { score: number; verdict: string };
  wave_judge: { score: number; verdict: string };
  delta: number;
}

interface Receipt {
  schema_version: 1;
  cat: 'cat25-trajectory-routing';
  gbrain_version: string;
  timestamp: string;
  probes_tested: number;
  baseline_mean_score: number;
  wave_mean_score: number;
  wave_wins: number;
  baseline_wins: number;
  ties: number;
  per_probe: ProbeResult[];
}

// Haiku judge: 0-10 score on (groundedness + temporal correctness)
async function judgeAnswer(client: any, question: string, gold: string, answer: string): Promise<{ score: number; verdict: string }> {
  const prompt = `You are a strict judge scoring an LLM's answer to a temporal question.

Question: ${question}
Gold answer: ${gold}
LLM answer: ${answer}

Score 0-10 on this rubric:
- 10: matches the gold exactly, correct date anchoring
- 7-9: correct fact, weak date anchoring
- 4-6: partially correct, missing date or wrong magnitude
- 0-3: wrong, no temporal grounding, or hallucinated

Reply with EXACTLY this JSON shape (no prose):
{"score": <0-10 integer>, "verdict": "<one sentence reasoning>"}`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
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

async function main(): Promise<void> {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: process.env as Record<string, string | undefined>,
  });

  const judgeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const perProbe: ProbeResult[] = [];

  for (const probe of PROBES) {
    process.stderr.write(`[cat25] running ${probe.id}...\n`);

    // Fresh engine per probe so state doesn't bleed across
    const engine: any = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const origLog = console.log;
    console.log = () => {};

    for (const p of probe.pages) {
      await importFromContent(engine, p.slug, p.body, { noEmbed: false });
    }

    // BASELINE: trajectory off
    let baselineAnswer = '';
    try {
      const r = await runThink(engine, { question: probe.question, withTrajectory: false } as any);
      baselineAnswer = (r as any).answer ?? (r as any).response?.answer ?? (r as any).synthesis ?? JSON.stringify(r).slice(0, 500);
    } catch (e: any) {
      baselineAnswer = `error: ${e?.message ?? e}`;
    }

    // WAVE: trajectory on (default)
    let waveAnswer = '';
    try {
      const r = await runThink(engine, { question: probe.question, withTrajectory: true } as any);
      waveAnswer = (r as any).answer ?? (r as any).response?.answer ?? (r as any).synthesis ?? JSON.stringify(r).slice(0, 500);
    } catch (e: any) {
      waveAnswer = `error: ${e?.message ?? e}`;
    }
    console.log = origLog;

    // Judge both
    const baselineJ = await judgeAnswer(judgeClient, probe.question, probe.gold_answer, baselineAnswer);
    const waveJ = await judgeAnswer(judgeClient, probe.question, probe.gold_answer, waveAnswer);

    perProbe.push({
      probe_id: probe.id,
      question: probe.question,
      baseline_answer: baselineAnswer.slice(0, 400),
      wave_answer: waveAnswer.slice(0, 400),
      baseline_judge: baselineJ,
      wave_judge: waveJ,
      delta: waveJ.score - baselineJ.score,
    });

    process.stderr.write(`[cat25]   ${probe.id}: baseline=${baselineJ.score} wave=${waveJ.score} Δ=${waveJ.score - baselineJ.score >= 0 ? '+' : ''}${waveJ.score - baselineJ.score}\n`);

    await engine.disconnect();
  }

  let gbrainVersion = 'unknown';
  try {
    const pkg = await import('gbrain/package.json' as any);
    gbrainVersion = (pkg as any).default?.version ?? (pkg as any).version ?? 'unknown';
  } catch { /* best-effort */ }

  const baselineMean = perProbe.reduce((a, p) => a + p.baseline_judge.score, 0) / Math.max(1, perProbe.length);
  const waveMean = perProbe.reduce((a, p) => a + p.wave_judge.score, 0) / Math.max(1, perProbe.length);

  const receipt: Receipt = {
    schema_version: 1,
    cat: 'cat25-trajectory-routing',
    gbrain_version: gbrainVersion,
    timestamp: new Date().toISOString(),
    probes_tested: perProbe.length,
    baseline_mean_score: baselineMean,
    wave_mean_score: waveMean,
    wave_wins: perProbe.filter(p => p.delta > 0).length,
    baseline_wins: perProbe.filter(p => p.delta < 0).length,
    ties: perProbe.filter(p => p.delta === 0).length,
    per_probe: perProbe,
  };

  const outDir = join(process.cwd(), 'eval/reports/cat25-trajectory-routing');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-cat25.json`);
  writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  process.stderr.write(`\n[cat25] ─── Scorecard ───────────────────\n`);
  process.stderr.write(`[cat25]   probes:               ${perProbe.length}\n`);
  process.stderr.write(`[cat25]   baseline mean score:  ${baselineMean.toFixed(1)}/10\n`);
  process.stderr.write(`[cat25]   wave mean score:      ${waveMean.toFixed(1)}/10\n`);
  process.stderr.write(`[cat25]   wave vs baseline:     ${(waveMean - baselineMean).toFixed(1)}pt\n`);
  process.stderr.write(`[cat25]   wave / base / tie:    ${receipt.wave_wins}/${receipt.baseline_wins}/${receipt.ties}\n`);
  process.stderr.write(`[cat25]   receipt:              ${outFile}\n`);
}

await main();
