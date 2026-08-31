/**
 * BrainBench Cat 15 — propose_takes precision/recall against a hand-labeled corpus.
 *
 * FEATURE BOUNDARY — what is under test vs what is scaffolding:
 *
 *   UNDER TEST: gbrain's production propose_takes extractor prompt.
 *     EXTRACT_TAKES_PROMPT is imported directly from
 *     node_modules/gbrain/src/core/cycle/propose-takes.ts (the module that
 *     stamps PROPOSE_TAKES_PROMPT_VERSION = 'v0.36.1.0-tuned-cat15'), never
 *     mirrored — so prompt drift between production and this eval is
 *     structurally impossible. The eval measures whether that prompt, run
 *     against the extract model, finds the gradeable claims a human labeled
 *     in the fixture pages. The empty-vs-unparseable discriminator
 *     (isWellFormedEmptyExtraction) is also gbrain's production code.
 *
 *   SEEDED / STUBBED (legitimately):
 *     - Fixture pages + hand-labeled .gradeable-claims.json ground truth ship
 *       inside the gbrain package at test/fixtures/calibration/.
 *     - TP/FP/FN matching is a Haiku judge at temperature 0 whose tool output
 *       is VALIDATED for full coverage (one entry per ground-truth claim,
 *       every extracted claim accounted exactly once) with one corrective
 *       retry; a still-malformed judge is a 'judge' error via probe
 *       accounting (excluded from means, capped), never scored as 0.
 *     - CAT15_DRY_RUN=1 stubs both extractor and matcher for a hermetic
 *       pipeline smoke. A dry-run (or CAT15_PROBES-filtered) run can never
 *       report verdict 'pass': its summary + receipt are forced to 'partial'
 *       and publishable:false.
 *
 * Per-probe flow:
 *   1. Read the fixture page (CAT15_CORPUS_DIR or the gbrain package default).
 *   2. Run the production extract prompt against the page body via Sonnet.
 *   3. Load the hand-labeled .gradeable-claims.json ground truth.
 *   4. Haiku matcher judge labels TP/FP/FN via structured tool-use; output is
 *      validated (coverage, index range, no double-counting) before any
 *      metric math.
 *   5. Compute precision/recall/F1 per probe; aggregate per-split.
 *   6. Gate: training avg F1 >= 0.85, holdout avg F1 >= 0.80,
 *      train-holdout gap <= 0.10.
 *
 * Run:
 *   bun eval/runner/cat15-propose-takes.ts
 *   CAT15_PROBES=cat15-train-concept-market bun eval/runner/cat15-propose-takes.ts
 *   CAT15_DRY_RUN=1 bun eval/runner/cat15-propose-takes.ts
 *   CAT15_CORPUS_DIR=/path/to/fixtures/calibration bun eval/runner/cat15-propose-takes.ts
 *   bun eval/runner/cat15-propose-takes.ts --allow-skip   # skip (missing corpus/key) exits 0
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  EXTRACT_TAKES_PROMPT,
  PROPOSE_TAKES_PROMPT_VERSION,
  PROPOSE_TAKES_MAX_TOKENS,
  isWellFormedEmptyExtraction,
} from '../../node_modules/gbrain/src/core/cycle/propose-takes.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import {
  writeReceipt,
  receiptPath,
  RECEIPT_SCHEMA_VERSION,
  BENCHMARK_VERSION,
  type Receipt,
  type ReceiptVerdict,
} from './receipt.ts';
import { gbrainVersion, gbrainPin } from './gbrain-version.ts';

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
  /** The production prompt emits `weight`. */
  weight?: number;
  /** Older extractor prompts emitted `conviction`; accept both. */
  conviction?: number;
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
  extracted_index: number | null; // null = false negative (missed)
  reasoning: string;
}

interface MatchResult {
  matches: ClaimMatch[];
  false_positives: number[]; // indices in extracted that match no GT
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
  /** Page had no gradeable claims and the extractor correctly returned []. */
  trivially_correct?: boolean;
  /** Extractor output was unparseable (not a well-formed [] either) — SUT misbehavior, scored 0. */
  extraction_parse_failed?: boolean;
  extracted_claims: ExtractedClaim[];
  ground_truth_claims: GroundTruthClaim[];
  matches: ClaimMatch[];
}

type ProbeOutcome =
  | { kind: 'scored'; result: ProbeResult; sutError?: string }
  | { kind: 'error'; origin: 'harness' | 'dependency' | 'judge'; message: string };

// ─── Paths + fixture loader ────────────────────────────────────────

const RUNNER_DIR = import.meta.dir;
const REPO_ROOT = join(RUNNER_DIR, '..', '..');
const DATA_DIR = join(RUNNER_DIR, '..', 'data', 'cat15-propose-takes');
const PROBES_PATH = join(DATA_DIR, 'probes.jsonl');
const README_PATH = join(DATA_DIR, 'README.md');
const REPORTS_ROOT = join(RUNNER_DIR, '..', 'reports');
const DUMPS_DIR = join(REPORTS_ROOT, 'cat15-propose-takes');
const CATEGORY = 'cat15-propose-takes';

/**
 * The corpus ships inside the gbrain package itself (test/fixtures/calibration
 * is where the production prompt was tuned) — repo-relative, no machine-specific
 * absolute path. CAT15_CORPUS_DIR overrides for local gbrain checkouts.
 */
const DEFAULT_CORPUS_DIR = join(REPO_ROOT, 'node_modules', 'gbrain', 'test', 'fixtures', 'calibration');

function corpusDir(): string {
  const env = process.env.CAT15_CORPUS_DIR;
  if (env) return env;
  return DEFAULT_CORPUS_DIR;
}

function loadProbes(): Probe[] {
  const text = readFileSync(PROBES_PATH, 'utf-8');
  const probes: Probe[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    probes.push(JSON.parse(t) as Probe);
  }
  return probes;
}

// ─── Extraction prompt — gbrain production source, never mirrored ──

/**
 * Fail loudly at startup if gbrain restructures the prompt's substitution
 * contract: buildExtractionPrompt substitutes both placeholders, and a
 * silent no-op substitution would send a template marker to the model.
 */
export function assertPromptContract(prompt: string): void {
  const missing = ['{PAGE_BODY}', '{EXISTING_TAKES_JSON}'].filter(ph => !prompt.includes(ph));
  if (missing.length > 0) {
    throw new Error(
      `gbrain EXTRACT_TAKES_PROMPT no longer carries placeholder(s) ${missing.join(', ')} — ` +
      `the substitution contract drifted from production (prompt_version ${PROPOSE_TAKES_PROMPT_VERSION}). ` +
      `Update buildExtractionPrompt in eval/runner/cat15-propose-takes.ts to match the new shape.`,
    );
  }
}

/** Eval fixture pages carry no existing takes fence, so the dedup block gets an empty list. */
export function buildExtractionPrompt(pageBody: string): string {
  assertPromptContract(EXTRACT_TAKES_PROMPT);
  return EXTRACT_TAKES_PROMPT
    .replace('{EXISTING_TAKES_JSON}', '[]')
    .replace('{PAGE_BODY}', pageBody);
}

// ─── Anthropic clients ─────────────────────────────────────────────

const EXTRACT_MODEL = process.env.CAT15_MODEL ?? 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.CAT15_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';
const JUDGE_TEMPERATURE = 0;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required');
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

// ─── Extraction ─────────────────────────────────────────────────────

interface ExtractOutcome {
  claims: ExtractedClaim[];
  raw_text: string;
  /** Output was empty/unparseable and NOT a well-formed empty array — SUT misbehavior. */
  parse_failed: boolean;
}

async function extractClaims(pageBody: string, client?: Anthropic): Promise<ExtractOutcome> {
  const prompt = buildExtractionPrompt(pageBody);
  const res = await (client ?? getAnthropic()).messages.create({
    model: EXTRACT_MODEL,
    max_tokens: PROPOSE_TAKES_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = res.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  const raw = block?.text ?? '';
  // Tolerant of fence wrappers: find a JSON array in the output.
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) {
        const claims = parsed.filter(
          (c): c is ExtractedClaim =>
            !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).claim_text === 'string',
        );
        return { claims, raw_text: raw, parse_failed: false };
      }
    } catch {
      // fall through to the well-formed-empty discriminator
    }
  }
  // gbrain's production discriminator: a cleanly-parsed `[]` is a genuine
  // "no gradeable claims" result; anything else unparseable is misbehavior.
  return { claims: [], raw_text: raw, parse_failed: !isWellFormedEmptyExtraction(raw) };
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
        description: 'EXACTLY one entry per ground-truth claim, covering every ground_truth_index once. If an extracted claim captures it, set extracted_index to that claim\'s 0-based index (each extracted index used at most once). If no extracted claim captures it, set extracted_index to null.',
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
        description: 'Indices in the extracted list that do NOT match any ground-truth claim (false positives), including duplicates-after-the-first. Every extracted index must appear either here or as some match\'s extracted_index — account for all of them.',
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

/**
 * Validate the judge's match_claims output BEFORE any metric math (audit
 * finding calibration-cats-02: unvalidated output inflated both precision
 * and recall). Coverage is part of validity:
 *   - exactly one entry per ground-truth index (none missing, none duplicated)
 *   - extracted_index values unique and in range (no double-counted TPs)
 *   - every extracted index accounted exactly once across matches ∪ false_positives
 * Returns the normalized result or a defect string for the corrective retry.
 */
export function validateMatchResult(
  input: unknown,
  extractedCount: number,
  gtCount: number,
): { result: MatchResult | null; defect: string | null } {
  const bad = (defect: string) => ({ result: null, defect });
  if (!input || typeof input !== 'object') return bad('tool input was not an object');
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.matches)) return bad('matches was not an array');
  if (!Array.isArray(obj.false_positives)) return bad('false_positives was not an array');
  if (typeof obj.rationale !== 'string') return bad('rationale missing');

  const matches: ClaimMatch[] = [];
  const seenGt = new Set<number>();
  const seenExtracted = new Set<number>();
  for (const m of obj.matches) {
    if (!m || typeof m !== 'object') return bad('matches[] entry was not an object');
    const mm = m as Record<string, unknown>;
    const gi = mm.ground_truth_index;
    if (typeof gi !== 'number' || !Number.isInteger(gi) || gi < 0 || gi >= gtCount) {
      return bad(`ground_truth_index ${JSON.stringify(gi)} out of range [0, ${gtCount})`);
    }
    if (seenGt.has(gi)) return bad(`ground_truth_index ${gi} appears twice — one entry per ground-truth claim`);
    seenGt.add(gi);
    const ei = mm.extracted_index;
    if (ei !== null) {
      if (typeof ei !== 'number' || !Number.isInteger(ei) || ei < 0 || ei >= extractedCount) {
        return bad(`extracted_index ${JSON.stringify(ei)} out of range [0, ${extractedCount}) (use null for a miss)`);
      }
      if (seenExtracted.has(ei)) {
        return bad(`extracted_index ${ei} matched to two ground-truth claims — each extracted claim matches at most one`);
      }
      seenExtracted.add(ei);
    }
    if (typeof mm.reasoning !== 'string') return bad('matches[] entries require a reasoning string');
    matches.push({ ground_truth_index: gi, extracted_index: ei as number | null, reasoning: mm.reasoning });
  }
  if (matches.length !== gtCount) {
    const missing: number[] = [];
    for (let i = 0; i < gtCount; i++) if (!seenGt.has(i)) missing.push(i);
    return bad(
      `matches must cover every ground-truth claim exactly once: got ${matches.length} entries for ` +
      `${gtCount} claims (missing indices: ${missing.join(', ') || 'none'})`,
    );
  }

  const fps: number[] = [];
  const seenFp = new Set<number>();
  for (const f of obj.false_positives) {
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f >= extractedCount) {
      return bad(`false_positives entry ${JSON.stringify(f)} out of range [0, ${extractedCount})`);
    }
    if (seenFp.has(f)) return bad(`false_positives lists index ${f} twice`);
    if (seenExtracted.has(f)) return bad(`extracted index ${f} is both a match and a false positive — pick one`);
    seenFp.add(f);
    fps.push(f);
  }
  if (seenExtracted.size + seenFp.size !== extractedCount) {
    const unaccounted: number[] = [];
    for (let i = 0; i < extractedCount; i++) {
      if (!seenExtracted.has(i) && !seenFp.has(i)) unaccounted.push(i);
    }
    return bad(
      `every extracted claim must be either a match or a false positive; ` +
      `unaccounted extracted indices: ${unaccounted.join(', ')}`,
    );
  }

  return { result: { matches, false_positives: fps, rationale: obj.rationale }, defect: null };
}

interface MatchOutcome {
  result: MatchResult | null;
  defect: string | null;
}

async function callMatcherOnce(
  client: Anthropic,
  sys: string,
  user: string,
  extractedCount: number,
  gtCount: number,
  correctiveFeedback?: string,
): Promise<{ result: MatchResult | null; defect: string | null }> {
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: user }];
  if (correctiveFeedback) {
    // Retry carries the specific defect — re-sending the identical request at
    // temperature 0 would mostly reproduce the identical malformed output.
    messages.push({
      role: 'user',
      content: `Your previous match_claims call was malformed: ${correctiveFeedback}. Call match_claims again with a valid, complete matching (one entry per ground-truth claim; every extracted index accounted exactly once).`,
    });
  }
  const res = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2000,
    temperature: JUDGE_TEMPERATURE,
    system: sys,
    tools: [MATCH_TOOL],
    tool_choice: { type: 'tool', name: 'match_claims' },
    messages,
  });
  const t = res.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === 'match_claims');
  if (!t) return { result: null, defect: 'no match_claims tool_use block in response' };
  return validateMatchResult(t.input, extractedCount, gtCount);
}

/**
 * Judge with validation + one corrective retry. Returns result:null with the
 * final defect when both attempts fail — the caller records a 'judge' error
 * via probe accounting (excluded from means), never a fake 0.
 * Precondition: extracted and groundTruth are both non-empty (the
 * deterministic empty cases are scored without an LLM call in runProbe).
 */
async function matchClaims(
  pageBody: string,
  extracted: ExtractedClaim[],
  groundTruth: GroundTruthClaim[],
  client?: Anthropic,
): Promise<MatchOutcome> {
  const sys = `You match extracted gradeable claims against hand-labeled ground-truth claims for the same page. A match is "claim X in the extracted list captures the same gradeable assertion as claim Y in the ground truth." Loose paraphrase OK; the kinds should align in spirit; the domain should be the same.

Be strict about duplicates: if two extracted claims capture the same ground-truth assertion, only the first is a TP; the second is a false positive (over-extraction).

Be strict about over-extraction: if an extracted claim is a restatement, a pure fact (not a forecast), a direct quote, or evidence for another claim, it's a false positive.

Coverage is mandatory: output exactly one matches[] entry per ground-truth claim, and account for EVERY extracted claim exactly once (as some entry's extracted_index or in false_positives).`;
  const user = `PAGE PROSE:
${pageBody}

GROUND-TRUTH CLAIMS:
${groundTruth.map((c, i) => `  [${i}] ${c.claim_text} (kind=${c.kind}, domain=${c.domain}, conviction=${c.conviction})`).join('\n')}

EXTRACTED CLAIMS:
${extracted.map((c, i) => `  [${i}] ${c.claim_text} (kind=${c.kind ?? '?'}, domain=${c.domain ?? '?'}, weight=${c.weight ?? c.conviction ?? '?'})`).join('\n')}

Call match_claims with the complete matching.`;

  const judgeClient = client ?? getAnthropic();
  let lastDefect = 'unknown judge failure';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { result, defect } = await callMatcherOnce(
        judgeClient, sys, user, extracted.length, groundTruth.length,
        attempt === 2 ? lastDefect : undefined,
      );
      if (result) return { result, defect: null };
      lastDefect = defect ?? 'invalid structured output';
    } catch (err) {
      lastDefect = `judge API error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { result: null, defect: lastDefect };
}

// ─── Scoring ────────────────────────────────────────────────────────

interface Counts {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  trivially_correct: boolean;
}

/**
 * Counts derive from the VALIDATED match plus the true list lengths — never
 * from raw judge list lengths (audit finding calibration-cats-02):
 *   fn = gtCount - tp, fp = extractedCount - tp.
 * Both-empty (page with no gradeable claims, extractor correctly returned [])
 * scores a trivially-correct 1.0 instead of the 0-denominator fallback
 * (audit finding calibration-cats-09).
 */
export function computeCounts(extractedCount: number, gtCount: number, tp: number): Counts {
  const fn = gtCount - tp;
  const fp = extractedCount - tp;
  if (extractedCount === 0 && gtCount === 0) {
    return { tp: 0, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1, trivially_correct: true };
  }
  const precision = extractedCount > 0 ? tp / extractedCount : 0;
  // gt empty but extractor over-produced: vacuous recall 1, precision 0 → f1 0.
  const recall = gtCount > 0 ? tp / gtCount : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1, trivially_correct: false };
}

// ─── Run one probe ──────────────────────────────────────────────────

interface GroundTruthFile {
  claims: GroundTruthClaim[];
}

interface RunProbeDeps {
  client?: Anthropic;
  extract?: (pageBody: string) => Promise<ExtractOutcome>;
  match?: (pageBody: string, extracted: ExtractedClaim[], gt: GroundTruthClaim[]) => Promise<MatchOutcome>;
  corpusDir?: string;
}

async function runProbe(probe: Probe, dryRun: boolean, deps: RunProbeDeps = {}): Promise<ProbeOutcome> {
  const dir = deps.corpusDir ?? corpusDir();
  let pageBody: string;
  let groundTruth: GroundTruthClaim[];
  try {
    pageBody = readFileSync(join(dir, probe.page), 'utf-8');
    const gtJson = JSON.parse(readFileSync(join(dir, probe.ground_truth), 'utf-8')) as GroundTruthFile;
    if (!Array.isArray(gtJson.claims)) throw new Error(`ground truth ${probe.ground_truth} has no claims[] array`);
    groundTruth = gtJson.claims;
  } catch (err) {
    return { kind: 'error', origin: 'harness', message: `fixture load failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let extracted: ExtractedClaim[];
  let parseFailed = false;
  let match: MatchResult;

  if (dryRun) {
    // Stub the extractor AND matcher: pipeline smoke only, never publishable.
    extracted = groundTruth.map(c => ({
      claim_text: c.claim_text,
      kind: c.kind,
      domain: c.domain,
      weight: c.conviction,
      holder: 'brain',
    }));
    const stub: MatchResult = {
      matches: groundTruth.map((_, i) => ({ ground_truth_index: i, extracted_index: i, reasoning: 'DRY-RUN perfect match' })),
      false_positives: [],
      rationale: 'DRY-RUN stub',
    };
    const { result, defect } = validateMatchResult(stub, extracted.length, groundTruth.length);
    if (!result) return { kind: 'error', origin: 'harness', message: `dry-run stub failed validation: ${defect}` };
    match = result;
  } else {
    let extraction: ExtractOutcome;
    try {
      extraction = await (deps.extract ? deps.extract(pageBody) : extractClaims(pageBody, deps.client));
    } catch (err) {
      return { kind: 'error', origin: 'dependency', message: `extract call failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    extracted = extraction.claims;
    parseFailed = extraction.parse_failed;

    if (parseFailed) {
      // SUT misbehavior: unparseable output. Scored as a total miss even when
      // the page has zero claims (a correct model returns a clean []).
      const result: ProbeResult = {
        probe_id: probe.id,
        split: probe.split,
        genre: probe.genre,
        page_path: probe.page,
        extracted_count: 0,
        ground_truth_count: groundTruth.length,
        true_positives: 0,
        false_positives: 0,
        false_negatives: groundTruth.length,
        precision: 0,
        recall: 0,
        f1: 0,
        f1_target: probe.f1_target,
        gate: 'fail',
        extraction_parse_failed: true,
        extracted_claims: [],
        ground_truth_claims: groundTruth,
        matches: [],
      };
      return { kind: 'scored', result, sutError: `extractor output unparseable (not a well-formed [] either): ${extraction.raw_text.slice(0, 200)}` };
    }

    if (extracted.length === 0 || groundTruth.length === 0) {
      // Deterministic — no judge call needed. Covers: both-empty (trivially
      // correct), extractor-empty (all FN), gt-empty (all FP).
      match = {
        matches: groundTruth.map((_, i) => ({ ground_truth_index: i, extracted_index: null, reasoning: 'extractor produced empty list' })),
        false_positives: extracted.map((_, i) => i),
        rationale: extracted.length === 0 && groundTruth.length === 0
          ? 'both lists empty — trivially correct'
          : extracted.length === 0 ? 'extracted empty; all ground-truth missed' : 'ground truth empty; all extracted are false positives',
      };
    } else {
      const outcome = await (deps.match ? deps.match(pageBody, extracted, groundTruth) : matchClaims(pageBody, extracted, groundTruth, deps.client));
      if (!outcome.result) {
        return { kind: 'error', origin: 'judge', message: `match_claims judge failed after corrective retry: ${outcome.defect}` };
      }
      match = outcome.result;
    }
  }

  const tp = match.matches.filter(m => m.extracted_index !== null).length;
  const counts = computeCounts(extracted.length, groundTruth.length, tp);
  const gate: 'pass' | 'fail' = counts.trivially_correct || counts.f1 >= probe.f1_target ? 'pass' : 'fail';

  const result: ProbeResult = {
    probe_id: probe.id,
    split: probe.split,
    genre: probe.genre,
    page_path: probe.page,
    extracted_count: extracted.length,
    ground_truth_count: groundTruth.length,
    true_positives: counts.tp,
    false_positives: counts.fp,
    false_negatives: counts.fn,
    precision: counts.precision,
    recall: counts.recall,
    f1: counts.f1,
    f1_target: probe.f1_target,
    gate,
    ...(counts.trivially_correct ? { trivially_correct: true } : {}),
    extracted_claims: extracted,
    ground_truth_claims: groundTruth,
    matches: match.matches,
  };
  return { kind: 'scored', result };
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

interface RunProvenance {
  dry_run: boolean;
  probe_filter: string | null;
  probes_planned: number;
  probes_scored: number;
  probes_in_fixture: number;
  extract_model: string;
  judge_model: string;
  prompt_version: string;
  prompt_source: string;
  corpus_dir: string;
  started_at: string;
  finished_at: string;
}

interface RunSummary {
  training: SplitSummary | null;
  holdout: SplitSummary | null;
  /** 'partial' = executed but not a real full-fixture verdict (dry run, filter, or a split with no scored probes). */
  overall_gate: 'pass' | 'partial' | 'fail';
  gate_reasons: string[];
  partial_reasons: string[];
  provenance?: RunProvenance;
}

interface AggregateOpts {
  dryRun: boolean;
  probeFilter: string | null;
  plannedSplits: string[];
}

const TRAINING_GATE = 0.85;
const HOLDOUT_GATE = 0.80;
const OVERFIT_GAP = 0.10;

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function aggregate(results: ProbeResult[], opts: AggregateOpts): RunSummary {
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
  if (training && holdout && (training.avg_f1 - holdout.avg_f1) > OVERFIT_GAP) {
    reasons.push(`training-holdout gap ${(training.avg_f1 - holdout.avg_f1).toFixed(3)} > ${OVERFIT_GAP} (overfitting signal)`);
  }

  // A dry-run or filtered run can never claim 'pass' — its metrics are stubbed
  // or partial (audit finding calibration-cats-14).
  const partialReasons: string[] = [];
  if (opts.dryRun) partialReasons.push('dry_run: extractor + matcher stubbed; metrics are pipeline smoke only');
  if (opts.probeFilter) partialReasons.push(`probe filter active (CAT15_PROBES=${opts.probeFilter}); not a full-fixture run`);
  for (const split of opts.plannedSplits) {
    const summary = split === 'training' ? training : split === 'holdout' ? holdout : null;
    if (!summary) partialReasons.push(`split '${split}' has no scored probes; its gate could not be evaluated`);
  }

  return {
    training,
    holdout,
    overall_gate: reasons.length > 0 ? 'fail' : partialReasons.length > 0 ? 'partial' : 'pass',
    gate_reasons: reasons,
    partial_reasons: partialReasons,
  };
}

// ─── Receipt helpers ────────────────────────────────────────────────

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

function resolvedConfig(dryRun: boolean, filter: string | null): Record<string, unknown> {
  return {
    extract_model: EXTRACT_MODEL,
    judge_model: JUDGE_MODEL,
    judge_temperature: JUDGE_TEMPERATURE,
    prompt_version: PROPOSE_TAKES_PROMPT_VERSION,
    prompt_source: 'node_modules/gbrain/src/core/cycle/propose-takes.ts (imported directly, not mirrored)',
    dry_run: dryRun,
    probe_filter: filter,
    corpus_dir: corpusDir(),
    // WS5: cat15 exercises the propose_takes extraction prompt only — no
    // gbrain engine, search, or reranker is in the loop, so there is no
    // search mode to pin.
    search_mode: 'not_applicable (no retrieval in this eval)',
    reranker_enabled: 'not_applicable (no retrieval in this eval)',
  };
}

function writeSkipReceipt(startedAt: string, reason: string, nTotal: number): void {
  writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
    ...baseReceipt(startedAt),
    run_status: 'skipped',
    skip_reason: reason,
    n_total: nTotal,
    n_scored: 0,
    completion_rate: 0,
    errors: [],
    publishable: false,
    resolved_config: resolvedConfig(process.env.CAT15_DRY_RUN === '1', process.env.CAT15_PROBES ?? null),
  });
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const allowSkip = process.argv.includes('--allow-skip');
  const dryRun = process.env.CAT15_DRY_RUN === '1';
  const filter = process.env.CAT15_PROBES ?? null;

  // Fail loudly at startup if the production prompt's substitution contract drifted.
  assertPromptContract(EXTRACT_TAKES_PROMPT);

  const probes = loadProbes();
  const filtered = filter ? probes.filter(p => filter.split(',').includes(p.id)) : probes;

  if (filtered.length === 0) {
    console.error(`[cat15] no probes matched filter: ${filter}`);
    writeSkipReceipt(startedAt, `probe filter matched nothing: ${filter}`, 0);
    process.exit(2);
  }

  const corpus = corpusDir();
  if (!existsSync(corpus)) {
    const reason = `corpus dir not found at ${corpus} — set CAT15_CORPUS_DIR or reinstall gbrain (fixtures ship in the package)`;
    console.error(`[cat15] SKIP: ${reason}`);
    writeSkipReceipt(startedAt, reason, filtered.length);
    process.exit(allowSkip ? 0 : 3);
  }
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    const reason = 'ANTHROPIC_API_KEY required for a live run (CAT15_DRY_RUN=1 runs the hermetic pipeline smoke)';
    console.error(`[cat15] SKIP: ${reason}`);
    writeSkipReceipt(startedAt, reason, filtered.length);
    process.exit(allowSkip ? 0 : 3);
  }

  console.log(`[cat15] running ${filtered.length} probes (extract=${EXTRACT_MODEL} judge=${JUDGE_MODEL} dry_run=${dryRun} prompt=${PROPOSE_TAKES_PROMPT_VERSION})`);

  const acc = new ProbeAccounting(filtered.length);
  const results: ProbeResult[] = [];
  for (const probe of filtered) {
    process.stderr.write(`  ${probe.id}... `);
    const outcome = await runProbe(probe, dryRun);
    if (outcome.kind === 'error') {
      acc.error(probe.id, outcome.origin, outcome.message);
      process.stderr.write(`ERROR(${outcome.origin}): ${outcome.message.slice(0, 120)}\n`);
      continue;
    }
    const r = outcome.result;
    results.push(r);
    writeDump(r);
    if (outcome.sutError) {
      // SUT misbehaved: recorded AND scored 0 (stays in the denominator).
      acc.error(probe.id, 'sut', outcome.sutError);
    } else {
      acc.score(probe.id, r.f1);
    }
    process.stderr.write(`P=${r.precision.toFixed(2)} R=${r.recall.toFixed(2)} F1=${r.f1.toFixed(2)} gate=${r.gate}${r.trivially_correct ? ' (trivially correct: no claims, none extracted)' : ''}\n`);
  }

  const plannedSplits = [...new Set(filtered.map(p => p.split))];
  const summary = aggregate(results, { dryRun, probeFilter: filter, plannedSplits });
  const accSummary = acc.summary();
  summary.provenance = {
    dry_run: dryRun,
    probe_filter: filter,
    probes_planned: filtered.length,
    probes_scored: accSummary.n_scored,
    probes_in_fixture: probes.length,
    extract_model: EXTRACT_MODEL,
    judge_model: JUDGE_MODEL,
    prompt_version: PROPOSE_TAKES_PROMPT_VERSION,
    prompt_source: 'node_modules/gbrain/src/core/cycle/propose-takes.ts',
    corpus_dir: corpus,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };

  if (!existsSync(DUMPS_DIR)) mkdirSync(DUMPS_DIR, { recursive: true });
  writeFileSync(join(DUMPS_DIR, '_summary.json'), JSON.stringify(summary, null, 2));

  // Receipt — the artifact all.ts aggregates. Invalid runs (infra error rate
  // over the cap) are run_status 'error': they produced no trustworthy verdict.
  if (accSummary.run_invalid) {
    writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
      ...baseReceipt(startedAt),
      run_status: 'error',
      n_total: accSummary.n_total,
      n_scored: accSummary.n_scored,
      completion_rate: accSummary.completion_rate,
      errors: accSummary.errors,
      publishable: false,
      resolved_config: resolvedConfig(dryRun, filter),
      judge: { model: JUDGE_MODEL, temperature: JUDGE_TEMPERATURE },
      data: { summary },
    });
    console.error(`[cat15] RUN INVALID: infra error rate ${(accSummary.infra_error_rate * 100).toFixed(0)}% over cap; see receipt errors[]`);
    process.exit(2);
  }

  const verdict: ReceiptVerdict = summary.overall_gate;
  writeReceipt(receiptPath(CATEGORY, REPORTS_ROOT), {
    ...baseReceipt(startedAt),
    run_status: 'completed',
    verdict,
    n_total: accSummary.n_total,
    n_scored: accSummary.n_scored,
    completion_rate: accSummary.completion_rate,
    errors: accSummary.errors,
    publishable: accSummary.publishable && !dryRun && !filter,
    resolved_config: resolvedConfig(dryRun, filter),
    judge: { model: JUDGE_MODEL, temperature: JUDGE_TEMPERATURE },
    data: { summary },
  });

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
  if (accSummary.errors.length > 0) {
    console.log(`errors: ${accSummary.errors.length} (${accSummary.errors.map(e => `${e.probe_id}:${e.origin}`).join(', ')})`);
  }
  console.log('');
  console.log(`gate: ${summary.overall_gate.toUpperCase()}`);
  for (const reason of summary.partial_reasons) console.log(`  ~ ${reason}`);
  if (summary.overall_gate === 'fail') {
    for (const reason of summary.gate_reasons) console.log(`  ✗ ${reason}`);
    console.log('');
    console.log(`Per-probe dumps in ${DUMPS_DIR}/<probe_id>.json. Read the .matches[] entries with extracted_index=null to find false negatives, and count false positives via extracted_count - true_positives. See ${README_PATH} for the failure-mode → fix-location map.`);
    process.exit(1);
  } else if (summary.overall_gate === 'pass') {
    console.log(`  ✓ all gates pass`);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('[cat15] fatal:', err);
    process.exit(2);
  });
}

export {
  loadProbes,
  corpusDir,
  extractClaims,
  matchClaims,
  aggregate,
  runProbe,
  DEFAULT_CORPUS_DIR,
  EXTRACT_TAKES_PROMPT as PRODUCTION_EXTRACT_TAKES_PROMPT,
  TRAINING_GATE,
  HOLDOUT_GATE,
};
export type {
  Probe,
  ProbeResult,
  ProbeOutcome,
  RunSummary,
  ExtractedClaim,
  GroundTruthClaim,
  MatchResult,
  MatchOutcome,
  ExtractOutcome,
  RunProbeDeps,
  AggregateOpts,
};
