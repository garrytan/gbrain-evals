/**
 * BrainBench Cat 15 — propose_takes precision/recall against hand-labeled corpus.
 *
 * Tests the SECOND-most-important question for gbrain v0.36.1.0's
 * calibration wave: does the `propose_takes` extractor prompt actually
 * find the gradeable claims hiding in the user's prose?
 *
 * If cat14 measures whether the OUTPUT side of calibration works
 * (think --with-calibration produces better answers), cat15 measures
 * whether the INPUT side works (extract claims from prose so the
 * calibration loop has fuel).
 *
 * Per-probe flow:
 *   1. Read the fixture page from gbrain repo (path via CAT15_CORPUS_DIR
 *      or default).
 *   2. Call the extract-takes prompt against the page body via Sonnet.
 *      Use the EXTRACT_TAKES_PROMPT shape from gbrain's source-of-truth
 *      stub at src/core/cycle/propose-takes.ts.
 *   3. Load the hand-labeled .gradeable-claims.json ground truth.
 *   4. Send (extracted claims, ground-truth claims, page body) to a
 *      Haiku matcher judge. Judge labels each extracted claim as TP/FP
 *      and each ground-truth claim as TP/FN via structured tool-use.
 *   5. Compute precision/recall/F1 per probe; aggregate per-split.
 *   6. Gate: training F1 >= 0.85, holdout F1 >= 0.80.
 *
 * Run:
 *   bun eval/runner/cat15-propose-takes.ts
 *   CAT15_PROBES=cat15-train-concept-market bun eval/runner/cat15-propose-takes.ts
 *   CAT15_DRY_RUN=1 bun eval/runner/cat15-propose-takes.ts
 *   CAT15_CORPUS_DIR=/path/to/test/fixtures/calibration bun eval/runner/cat15-propose-takes.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Types ──────────────────────────────────────────────────────────

interface Probe {
  id: string;
  page: string;
  ground_truth: string;
  split: 'training' | 'holdout';
  genre: string;
  f1_target: number;
}

interface ExtractedClaim {
  claim_text: string;
  kind?: string;
  holder?: string;
  weight?: number;
  domain?: string;
}

interface GroundTruthClaim {
  claim_text: string;
  kind: string;
  domain: string;
  conviction: number;
  since_date: string;
  rationale?: string;
}

interface ClaimMatch {
  ground_truth_index: number;
  extracted_index: number | null;  // null = false negative (missed)
  reasoning: string;
}

interface MatchResult {
  matches: ClaimMatch[];
  false_positives: number[];        // indices in extracted that match no GT
  rationale: string;
}

interface ProbeResult {
  probe_id: string;
  split: string;
  genre: string;
  page_path: string;
  extracted_count: number;
  ground_truth_count: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
  f1_target: number;
  gate: 'pass' | 'fail';
  extracted_claims: ExtractedClaim[];
  ground_truth_claims: GroundTruthClaim[];
  matches: ClaimMatch[];
}

// ─── Fixture loader ────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBES_PATH = join(__dirname, '..', 'data', 'cat15-propose-takes', 'probes.jsonl');
const DUMPS_DIR = join(__dirname, '..', 'reports', 'cat15-propose-takes');
const DEFAULT_CORPUS_DIR = join(
  __dirname, '..', '..', '..',
  'conductor/workspaces/gbrain/asuncion/test/fixtures/calibration',
);

function corpusDir(): string {
  const env = process.env.CAT15_CORPUS_DIR;
  if (env) return env;
  if (existsSync(DEFAULT_CORPUS_DIR)) return DEFAULT_CORPUS_DIR;
  throw new Error(`Corpus dir not found. Set CAT15_CORPUS_DIR or place fixtures at ${DEFAULT_CORPUS_DIR}`);
}

function loadProbes(): Probe[] {
  const text = readFileSync(PROBES_PATH, 'utf-8');
  const probes: Probe[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    probes.push(JSON.parse(t));
  }
  return probes;
}

// ─── Extract-takes prompt (mirrors src/core/cycle/propose-takes.ts) ──

const EXTRACT_TAKES_PROMPT = `Extract gradeable claims from the prose below.

A "gradeable claim" is a prediction, recommendation, or interpretive judgment
that could turn out wrong over time. Examples:
- "X company will hit ARR milestone by Q3" (prediction)
- "Y founder is going to struggle with execution" (judgment)
- "Z market will compress in 18 months" (prediction)
- "I bet alice wins the round" (bet)

NOT gradeable (do NOT extract these):
- Pure facts ("X was founded in 2020")
- Direct quotes from others without endorsement
- Restatements of an earlier claim in the same page

For each gradeable claim, output a JSON object with:
- claim_text   (string, <=200 chars, paraphrase or near-verbatim from prose)
- kind         ('prediction' | 'judgment' | 'bet')
- domain       (short tag — e.g. 'tactics', 'macro', 'hiring', 'geography', 'pricing')
- conviction   (number 0..1 inferred from hedging language: 'I bet'/'strong conviction'=0.7-0.85,
                'I think'/'moderate conviction'=0.5-0.7, 'maybe'/'I'd guess'=0.3-0.5)

Output ONLY a JSON array of these objects. No prose. No commentary. If no
gradeable claims, return [].

PAGE PROSE:
{PAGE_BODY}
`;

// ─── Anthropic + chat ──────────────────────────────────────────────

const EXTRACT_MODEL = process.env.CAT15_MODEL ?? 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.CAT15_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required');
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

async function extractClaims(pageBody: string): Promise<ExtractedClaim[]> {
  const prompt = EXTRACT_TAKES_PROMPT.replace('{PAGE_BODY}', pageBody);
  const res = await getAnthropic().messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  const raw = block?.text ?? '';
  // Try to find a JSON array in the output. Be tolerant of fence wrappers.
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed as ExtractedClaim[];
  } catch {
    return [];
  }
}

// ─── Matcher judge ──────────────────────────────────────────────────

const MATCH_TOOL: Anthropic.Messages.Tool = {
  name: 'match_claims',
  description: 'Match extracted claims against ground-truth claims for the same page.',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        description: 'One entry per ground-truth claim. If an extracted claim captures it, set extracted_index to that claim\'s 0-based index. If no extracted claim captures it, set extracted_index to null.',
        items: {
          type: 'object',
          properties: {
            ground_truth_index: { type: 'number' },
            extracted_index: { type: ['number', 'null'] },
            reasoning: { type: 'string' },
          },
          required: ['ground_truth_index', 'extracted_index', 'reasoning'],
        },
      },
      false_positives: {
        type: 'array',
        description: 'Indices in the extracted list that do NOT match any ground-truth claim (false positives). Includes extracted claims that are duplicates of each other after the first.',
        items: { type: 'number' },
      },
      rationale: {
        type: 'string',
        description: 'Plain-English summary of the matching judgment.',
      },
    },
    required: ['matches', 'false_positives', 'rationale'],
  },
};

async function matchClaims(
  pageBody: string,
  extracted: ExtractedClaim[],
  groundTruth: GroundTruthClaim[],
): Promise<MatchResult | null> {
  if (extracted.length === 0 && groundTruth.length === 0) {
    return { matches: [], false_positives: [], rationale: 'both lists empty' };
  }
  if (extracted.length === 0) {
    return {
      matches: groundTruth.map((_, i) => ({ ground_truth_index: i, extracted_index: null, reasoning: 'extractor produced empty list' })),
      false_positives: [],
      rationale: 'extracted empty; all ground-truth missed',
    };
  }
  const sys = `You match extracted gradeable claims against hand-labeled ground-truth claims for the same page. A match is "claim X in the extracted list captures the same gradeable assertion as claim Y in the ground truth." Loose paraphrase OK; the kinds (prediction/judgment/bet) should align; the domain should be the same.

Be strict about duplicates: if two extracted claims capture the same ground-truth assertion, only the first is a TP; the second is a false positive (over-extraction).

Be strict about over-extraction: if an extracted claim is a restatement, a pure fact (not a forecast), a direct quote, or evidence for another claim, it's a false positive.`;
  const user = `PAGE PROSE:
${pageBody}

GROUND-TRUTH CLAIMS:
${groundTruth.map((c, i) => `  [${i}] ${c.claim_text} (kind=${c.kind}, domain=${c.domain}, conviction=${c.conviction})`).join('\n')}

EXTRACTED CLAIMS:
${extracted.map((c, i) => `  [${i}] ${c.claim_text} (kind=${c.kind ?? '?'}, domain=${c.domain ?? '?'}, conviction=${c.conviction ?? c.weight ?? '?'})`).join('\n')}

Call match_claims tool with TP/FP/FN labels.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await getAnthropic().messages.create({
        model: JUDGE_MODEL,
        max_tokens: 2000,
        system: sys,
        tools: [MATCH_TOOL],
        tool_choice: { type: 'tool', name: 'match_claims' },
        messages: [{ role: 'user', content: user }],
      });
      const t = res.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
      if (t && t.name === 'match_claims') return t.input as MatchResult;
    } catch (err) {
      if (attempt === 2) {
        console.error(`[cat15] match failed after retry:`, err);
        return null;
      }
    }
  }
  return null;
}

// ─── Score one probe ───────────────────────────────────────────────

interface GroundTruthFile {
  claims: GroundTruthClaim[];
}

async function runProbe(probe: Probe, dryRun: boolean): Promise<ProbeResult> {
  const dir = corpusDir();
  const pageBody = readFileSync(join(dir, probe.page), 'utf-8');
  const gtJson: GroundTruthFile = JSON.parse(readFileSync(join(dir, probe.ground_truth), 'utf-8'));
  const groundTruth = gtJson.claims;

  let extracted: ExtractedClaim[] = [];
  let match: MatchResult | null = null;

  if (dryRun) {
    // Stub: pretend we matched everything perfectly.
    extracted = groundTruth.map(c => ({
      claim_text: c.claim_text,
      kind: c.kind,
      domain: c.domain,
      weight: c.conviction,
    }));
    match = {
      matches: groundTruth.map((_, i) => ({ ground_truth_index: i, extracted_index: i, reasoning: 'DRY-RUN perfect match' })),
      false_positives: [],
      rationale: 'DRY-RUN stub',
    };
  } else {
    extracted = await extractClaims(pageBody);
    match = await matchClaims(pageBody, extracted, groundTruth);
  }

  const tp = match ? match.matches.filter(m => m.extracted_index !== null).length : 0;
  const fn = match ? match.matches.filter(m => m.extracted_index === null).length : groundTruth.length;
  const fp = match ? match.false_positives.length : extracted.length;

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const gate: 'pass' | 'fail' = f1 >= probe.f1_target ? 'pass' : 'fail';

  return {
    probe_id: probe.id,
    split: probe.split,
    genre: probe.genre,
    page_path: probe.page,
    extracted_count: extracted.length,
    ground_truth_count: groundTruth.length,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
    precision,
    recall,
    f1,
    f1_target: probe.f1_target,
    gate,
    extracted_claims: extracted,
    ground_truth_claims: groundTruth,
    matches: match?.matches ?? [],
  };
}

function writeDump(r: ProbeResult): void {
  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(join(DUMPS_DIR, `${r.probe_id}.json`), JSON.stringify(r, null, 2));
}

// ─── Aggregate ──────────────────────────────────────────────────────

interface SplitSummary {
  split: string;
  probes: number;
  avg_precision: number;
  avg_recall: number;
  avg_f1: number;
  gate_pass_count: number;
  gate_fail_count: number;
  by_genre: Record<string, { count: number; avg_f1: number }>;
}

interface RunSummary {
  training: SplitSummary | null;
  holdout: SplitSummary | null;
  overall_gate: 'pass' | 'fail';
  gate_reasons: string[];
}

const TRAINING_GATE = 0.85;
const HOLDOUT_GATE = 0.80;

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function aggregate(results: ProbeResult[]): RunSummary {
  const bySplit: Record<string, ProbeResult[]> = { training: [], holdout: [] };
  for (const r of results) (bySplit[r.split] ?? bySplit.training).push(r);

  function makeSplitSummary(split: string, items: ProbeResult[]): SplitSummary | null {
    if (items.length === 0) return null;
    const byGenre: Record<string, ProbeResult[]> = {};
    for (const r of items) (byGenre[r.genre] ??= []).push(r);
    const byGenreOut: Record<string, { count: number; avg_f1: number }> = {};
    for (const [g, list] of Object.entries(byGenre)) {
      byGenreOut[g] = { count: list.length, avg_f1: avg(list.map(r => r.f1)) };
    }
    return {
      split,
      probes: items.length,
      avg_precision: avg(items.map(r => r.precision)),
      avg_recall: avg(items.map(r => r.recall)),
      avg_f1: avg(items.map(r => r.f1)),
      gate_pass_count: items.filter(r => r.gate === 'pass').length,
      gate_fail_count: items.filter(r => r.gate === 'fail').length,
      by_genre: byGenreOut,
    };
  }

  const training = makeSplitSummary('training', bySplit.training);
  const holdout = makeSplitSummary('holdout', bySplit.holdout);

  const reasons: string[] = [];
  if (training && training.avg_f1 < TRAINING_GATE) {
    reasons.push(`training avg F1 ${training.avg_f1.toFixed(3)} < ${TRAINING_GATE} target`);
  }
  if (holdout && holdout.avg_f1 < HOLDOUT_GATE) {
    reasons.push(`holdout avg F1 ${holdout.avg_f1.toFixed(3)} < ${HOLDOUT_GATE} target`);
  }
  // Also catch the overfitting case (training >> holdout by > 10pts) as a soft warning.
  if (training && holdout && (training.avg_f1 - holdout.avg_f1) > 0.10) {
    reasons.push(`training-holdout gap ${(training.avg_f1 - holdout.avg_f1).toFixed(3)} > 0.10 (overfitting signal)`);
  }

  return {
    training,
    holdout,
    overall_gate: reasons.length === 0 ? 'pass' : 'fail',
    gate_reasons: reasons,
  };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const probes = loadProbes();
  const filter = process.env.CAT15_PROBES;
  const filtered = filter ? probes.filter(p => filter.split(',').includes(p.id)) : probes;
  const dryRun = process.env.CAT15_DRY_RUN === '1';

  if (filtered.length === 0) {
    console.error(`No probes matched filter: ${filter}`);
    process.exit(2);
  }

  console.log(`[cat15] running ${filtered.length} probes (extract=${EXTRACT_MODEL} judge=${JUDGE_MODEL} dry_run=${dryRun})`);

  const results: ProbeResult[] = [];
  for (const probe of filtered) {
    process.stderr.write(`  ${probe.id}... `);
    const result = await runProbe(probe, dryRun);
    results.push(result);
    writeDump(result);
    process.stderr.write(`P=${result.precision.toFixed(2)} R=${result.recall.toFixed(2)} F1=${result.f1.toFixed(2)} gate=${result.gate}\n`);
  }

  const summary = aggregate(results);

  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(join(DUMPS_DIR, '_summary.json'), JSON.stringify(summary, null, 2));

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('cat15 propose_takes — summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const split of [summary.training, summary.holdout]) {
    if (!split) continue;
    const target = split.split === 'training' ? TRAINING_GATE : HOLDOUT_GATE;
    console.log(`${split.split.padEnd(10)} avg_precision=${split.avg_precision.toFixed(3)}  avg_recall=${split.avg_recall.toFixed(3)}  avg_F1=${split.avg_f1.toFixed(3)} (target ${target})  ${split.gate_pass_count}/${split.probes} probes gate-pass`);
    for (const [g, stats] of Object.entries(split.by_genre)) {
      console.log(`  by genre ${g.padEnd(30)} n=${stats.count} avg_F1=${stats.avg_f1.toFixed(3)}`);
    }
  }
  console.log('');
  console.log(`gate: ${summary.overall_gate.toUpperCase()}`);
  if (summary.overall_gate === 'fail') {
    for (const reason of summary.gate_reasons) console.log(`  ✗ ${reason}`);
    console.log('');
    console.log(`Per-probe dumps in ${DUMPS_DIR}/<probe_id>.json. Read the .matches[] entries with extracted_index=null to find false negatives, and .false_positives[] to find over-extractions. See ../data/cat15-propose-takes/README.md for the failure-mode → fix-location map.`);
    process.exit(1);
  } else {
    console.log(`  ✓ all gates pass`);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[cat15] fatal:', err);
    process.exit(2);
  });
}

export { loadProbes, extractClaims, matchClaims, aggregate, runProbe };
export type { Probe, ProbeResult, RunSummary, ExtractedClaim, GroundTruthClaim, MatchResult };
