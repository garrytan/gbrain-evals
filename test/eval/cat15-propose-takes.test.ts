/**
 * cat15 propose_takes — hermetic regression tests for the 2026-08-31 audit
 * fixes (calibration-cats-02/06/07/09/11/14). No API keys, no network: the
 * Anthropic client is stubbed, extraction is injected via RunProbeDeps, and
 * the end-to-end runs use CAT15_DRY_RUN=1.
 *
 * Each previously-unfailable gate gets BOTH directions: constructed bad input
 * must fail, good input must pass.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import {
  EXTRACT_TAKES_PROMPT as GBRAIN_PROMPT,
} from '../../node_modules/gbrain/src/core/cycle/propose-takes.ts';
import {
  PRODUCTION_EXTRACT_TAKES_PROMPT,
  assertPromptContract,
  buildExtractionPrompt,
  validateMatchResult,
  computeCounts,
  matchClaims,
  runProbe,
  aggregate,
  corpusDir,
  loadProbes,
  DEFAULT_CORPUS_DIR,
  type Probe,
  type ProbeResult,
  type ExtractedClaim,
  type GroundTruthClaim,
} from '../../eval/runner/cat15-propose-takes.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const RUNNER = join(REPO_ROOT, 'eval', 'runner', 'cat15-propose-takes.ts');
const TEST_FIXTURES = join(REPO_ROOT, 'eval', 'data', 'cat15-propose-takes', 'test-fixtures');
const RECEIPT = join(REPO_ROOT, 'eval', 'reports', 'cat15-propose-takes', 'receipt.json');
const SUMMARY = join(REPO_ROOT, 'eval', 'reports', 'cat15-propose-takes', '_summary.json');

// ─── Prompt: production source, never mirrored (calibration-cats-06) ──

describe('extraction prompt comes from gbrain production source', () => {
  test('runner prompt IS gbrain EXTRACT_TAKES_PROMPT (same string, no mirror)', () => {
    expect(PRODUCTION_EXTRACT_TAKES_PROMPT).toBe(GBRAIN_PROMPT);
    // The production prompt's load-bearing fields (the old mirror dropped
    // holder, renamed weight, and lost the dedup block).
    expect(PRODUCTION_EXTRACT_TAKES_PROMPT).toContain('- holder');
    expect(PRODUCTION_EXTRACT_TAKES_PROMPT).toContain('- weight');
    expect(PRODUCTION_EXTRACT_TAKES_PROMPT).toContain('EXISTING FENCE ROWS');
  });

  test('assertPromptContract passes on the real prompt, throws on drift', () => {
    expect(() => assertPromptContract(GBRAIN_PROMPT)).not.toThrow();
    expect(() => assertPromptContract('a prompt with {PAGE_BODY} only')).toThrow(/EXISTING_TAKES_JSON/);
    expect(() => assertPromptContract('a prompt with {EXISTING_TAKES_JSON} only')).toThrow(/PAGE_BODY/);
  });

  test('buildExtractionPrompt substitutes both placeholders', () => {
    const built = buildExtractionPrompt('THE PAGE PROSE SENTINEL');
    expect(built).toContain('THE PAGE PROSE SENTINEL');
    expect(built).not.toContain('{PAGE_BODY}');
    expect(built).not.toContain('{EXISTING_TAKES_JSON}');
    // Fixture pages carry no existing fence rows.
    expect(built).toContain('EXISTING FENCE ROWS (already captured — do NOT propose duplicates):\n[]');
  });
});

// ─── Judge-output validation (calibration-cats-02) ───────────────────

describe('validateMatchResult rejects the metric-inflating shapes', () => {
  const entry = (gi: number, ei: number | null) => ({ ground_truth_index: gi, extracted_index: ei, reasoning: 'r' });

  test('good full-coverage output passes and normalizes', () => {
    const { result, defect } = validateMatchResult({
      matches: [entry(0, 1), entry(1, null), entry(2, 0)],
      false_positives: [2],
      rationale: 'ok',
    }, 3, 3);
    expect(defect).toBeNull();
    expect(result).not.toBeNull();
    expect(result!.matches).toHaveLength(3);
    expect(result!.false_positives).toEqual([2]);
  });

  test('REGRESSION: judge returning fewer entries than ground truth is rejected (old code scored recall 4/4 = 1.0 on 6 GT claims)', () => {
    const { result, defect } = validateMatchResult({
      matches: [entry(0, 0), entry(1, 1), entry(2, 2), entry(3, 3)],
      false_positives: [],
      rationale: 'partial coverage',
    }, 4, 6);
    expect(result).toBeNull();
    expect(defect).toMatch(/cover every ground-truth claim/);
    expect(defect).toMatch(/missing indices: 4, 5/);
  });

  test('duplicate ground_truth_index is rejected', () => {
    const { result, defect } = validateMatchResult({
      matches: [entry(0, 0), entry(0, 1)],
      false_positives: [],
      rationale: 'dupe gt',
    }, 2, 2);
    expect(result).toBeNull();
    expect(defect).toMatch(/appears twice/);
  });

  test('REGRESSION: two GT entries pointing at the same extracted_index (double-counted TP) is rejected', () => {
    const { result, defect } = validateMatchResult({
      matches: [entry(0, 0), entry(1, 0)],
      false_positives: [],
      rationale: 'double count',
    }, 1, 2);
    expect(result).toBeNull();
    expect(defect).toMatch(/matched to two ground-truth claims/);
  });

  test('out-of-range indices are rejected, not counted blind', () => {
    expect(validateMatchResult({ matches: [entry(5, 0)], false_positives: [], rationale: 'x' }, 1, 1).defect)
      .toMatch(/ground_truth_index 5 out of range/);
    expect(validateMatchResult({ matches: [entry(0, 9)], false_positives: [], rationale: 'x' }, 1, 1).defect)
      .toMatch(/extracted_index 9 out of range/);
    expect(validateMatchResult({ matches: [entry(0, 0)], false_positives: [7], rationale: 'x' }, 1, 1).defect)
      .toMatch(/false_positives entry 7 out of range/);
  });

  test('REGRESSION: extracted claim in neither matches nor false_positives (precision inflation) is rejected', () => {
    const { result, defect } = validateMatchResult({
      matches: [entry(0, 0)],
      false_positives: [],
      rationale: 'extracted index 1 vanished',
    }, 2, 1);
    expect(result).toBeNull();
    expect(defect).toMatch(/unaccounted extracted indices: 1/);
  });

  test('overlap between a match and false_positives is rejected', () => {
    const { defect } = validateMatchResult({
      matches: [entry(0, 0)],
      false_positives: [0],
      rationale: 'both',
    }, 1, 1);
    expect(defect).toMatch(/both a match and a false positive/);
  });

  test('duplicate false_positives entries are rejected', () => {
    const { defect } = validateMatchResult({
      matches: [entry(0, null)],
      false_positives: [0, 0],
      rationale: 'dupe fp',
    }, 2, 1);
    expect(defect).toMatch(/lists index 0 twice/);
  });
});

// ─── Scoring (calibration-cats-02 + calibration-cats-09) ─────────────

describe('computeCounts', () => {
  test('normal case derives fn and fp from true list lengths', () => {
    const c = computeCounts(5, 6, 4);
    expect(c.tp).toBe(4);
    expect(c.fp).toBe(1);
    expect(c.fn).toBe(2);
    expect(c.precision).toBeCloseTo(4 / 5);
    expect(c.recall).toBeCloseTo(4 / 6);
  });

  test('REGRESSION: both-empty (no claims, none extracted) scores 1.0, not 0 (old code failed the probe gate)', () => {
    const c = computeCounts(0, 0, 0);
    expect(c.precision).toBe(1);
    expect(c.recall).toBe(1);
    expect(c.f1).toBe(1);
    expect(c.trivially_correct).toBe(true);
  });

  test('extractor empty with GT present scores 0 (all misses still fail)', () => {
    const c = computeCounts(0, 3, 0);
    expect(c.f1).toBe(0);
    expect(c.trivially_correct).toBe(false);
  });

  test('GT empty with over-extraction scores 0 (all FP)', () => {
    const c = computeCounts(2, 0, 0);
    expect(c.precision).toBe(0);
    expect(c.f1).toBe(0);
  });
});

// ─── Matcher judge: corrective retry + judge-error path ──────────────

type FakeResponse = { content: Array<Record<string, unknown>> };

function fakeClient(responses: FakeResponse[], calls?: Array<{ messages: Array<{ content: unknown }> }>): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async (req: { messages: Array<{ content: unknown }> }) => {
        calls?.push(req);
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return r;
      },
    },
  } as unknown as Anthropic;
}

const EXTRACTED: ExtractedClaim[] = [
  { claim_text: 'acme closes seed by July', kind: 'bet', weight: 0.8, domain: 'fundraising' },
];
const GT: GroundTruthClaim[] = [
  { claim_text: 'acme-example closes their seed round by July', kind: 'bet', domain: 'fundraising', conviction: 0.8, since_date: '2026-05-03' },
];

const VALID_TOOL_USE: FakeResponse = {
  content: [{
    type: 'tool_use',
    name: 'match_claims',
    input: {
      matches: [{ ground_truth_index: 0, extracted_index: 0, reasoning: 'same claim' }],
      false_positives: [],
      rationale: 'clean match',
    },
  }],
};
const MALFORMED_TOOL_USE: FakeResponse = {
  content: [{
    type: 'tool_use',
    name: 'match_claims',
    input: { matches: [], false_positives: [], rationale: 'omitted the only GT claim' },
  }],
};

describe('matchClaims validation + retry', () => {
  test('valid first attempt returns the result', async () => {
    const out = await matchClaims('page', EXTRACTED, GT, fakeClient([VALID_TOOL_USE]));
    expect(out.result).not.toBeNull();
    expect(out.result!.matches[0].extracted_index).toBe(0);
  });

  test('malformed first attempt triggers ONE corrective retry naming the defect', async () => {
    const calls: Array<{ messages: Array<{ content: unknown }> }> = [];
    const out = await matchClaims('page', EXTRACTED, GT, fakeClient([MALFORMED_TOOL_USE, VALID_TOOL_USE], calls));
    expect(out.result).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toHaveLength(2);
    expect(String(calls[1].messages[1].content)).toMatch(/malformed/);
    expect(String(calls[1].messages[1].content)).toMatch(/cover every ground-truth claim/);
  });

  test('REGRESSION: malformed twice returns null + defect (judge error, NOT a scored 0)', async () => {
    const out = await matchClaims('page', EXTRACTED, GT, fakeClient([MALFORMED_TOOL_USE, MALFORMED_TOOL_USE]));
    expect(out.result).toBeNull();
    expect(out.defect).toMatch(/cover every ground-truth claim/);
  });

  test('judge API errors surface as defect after retry', async () => {
    const throwing = {
      messages: { create: async () => { throw new Error('overloaded_error 529'); } },
    } as unknown as Anthropic;
    const out = await matchClaims('page', EXTRACTED, GT, throwing);
    expect(out.result).toBeNull();
    expect(out.defect).toMatch(/judge API error: overloaded_error 529/);
  });
});

// ─── runProbe: gate can fail on bad input AND pass on good input ─────

const CLAIMS_PROBE: Probe = {
  id: 'test-claims', page: 'claims-page.md', ground_truth: 'claims-page.gradeable-claims.json',
  split: 'training', genre: 'test', f1_target: 0.85,
};
const EMPTY_PROBE: Probe = {
  id: 'test-empty', page: 'empty-page.md', ground_truth: 'empty-page.gradeable-claims.json',
  split: 'holdout', genre: 'test', f1_target: 0.80,
};

describe('runProbe', () => {
  test('good extractor + valid judge output → gate pass', async () => {
    const gt = JSON.parse(readFileSync(join(TEST_FIXTURES, 'claims-page.gradeable-claims.json'), 'utf-8')) as { claims: GroundTruthClaim[] };
    const outcome = await runProbe(CLAIMS_PROBE, false, {
      corpusDir: TEST_FIXTURES,
      extract: async () => ({
        claims: gt.claims.map(c => ({ claim_text: c.claim_text, kind: c.kind, weight: c.conviction, domain: c.domain })),
        raw_text: '[]',
        parse_failed: false,
      }),
      match: async (_page, extracted, groundTruth) => ({
        result: {
          matches: groundTruth.map((_, i) => ({ ground_truth_index: i, extracted_index: i < extracted.length ? i : null, reasoning: 'stub' })),
          false_positives: [],
          rationale: 'stub',
        },
        defect: null,
      }),
    });
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error('unreachable');
    expect(outcome.result.f1).toBe(1);
    expect(outcome.result.gate).toBe('pass');
    expect(outcome.sutError).toBeUndefined();
  });

  test('REGRESSION: degraded extractor (finds nothing) → gate fail', async () => {
    const outcome = await runProbe(CLAIMS_PROBE, false, {
      corpusDir: TEST_FIXTURES,
      extract: async () => ({ claims: [], raw_text: '[]', parse_failed: false }),
    });
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error('unreachable');
    expect(outcome.result.f1).toBe(0);
    expect(outcome.result.gate).toBe('fail');
    expect(outcome.result.false_negatives).toBe(2);
  });

  test('REGRESSION: unparseable extractor output is SUT misbehavior scored 0', async () => {
    const outcome = await runProbe(CLAIMS_PROBE, false, {
      corpusDir: TEST_FIXTURES,
      extract: async () => ({ claims: [], raw_text: 'I could not find any JSON to give you, sorry!', parse_failed: true }),
    });
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error('unreachable');
    expect(outcome.result.f1).toBe(0);
    expect(outcome.result.extraction_parse_failed).toBe(true);
    expect(outcome.sutError).toMatch(/unparseable/);
  });

  test('REGRESSION: page with no claims + correct [] extraction → trivially-correct pass (was F1=0 fail)', async () => {
    const outcome = await runProbe(EMPTY_PROBE, false, {
      corpusDir: TEST_FIXTURES,
      extract: async () => ({ claims: [], raw_text: '[]', parse_failed: false }),
    });
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error('unreachable');
    expect(outcome.result.f1).toBe(1);
    expect(outcome.result.gate).toBe('pass');
    expect(outcome.result.trivially_correct).toBe(true);
  });

  test('judge failure after retry is a judge error outcome (excluded, not scored 0)', async () => {
    const outcome = await runProbe(CLAIMS_PROBE, false, {
      corpusDir: TEST_FIXTURES,
      extract: async () => ({ claims: EXTRACTED, raw_text: 'x', parse_failed: false }),
      match: async () => ({ result: null, defect: 'still malformed' }),
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.origin).toBe('judge');
    expect(outcome.message).toMatch(/still malformed/);
  });

  test('extract API throw is a dependency error outcome', async () => {
    const outcome = await runProbe(CLAIMS_PROBE, false, {
      corpusDir: TEST_FIXTURES,
      extract: async () => { throw new Error('connection reset'); },
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.origin).toBe('dependency');
  });

  test('missing fixture is a harness error outcome', async () => {
    const outcome = await runProbe({ ...CLAIMS_PROBE, page: 'does-not-exist.md' }, false, { corpusDir: TEST_FIXTURES });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.origin).toBe('harness');
  });

  test('dry run stubs both stages and scores perfectly', async () => {
    const outcome = await runProbe(CLAIMS_PROBE, true, { corpusDir: TEST_FIXTURES });
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error('unreachable');
    expect(outcome.result.f1).toBe(1);
  });
});

// ─── Aggregate gates + provenance semantics (calibration-cats-14) ────

function probeRow(split: 'training' | 'holdout', f1: number, target: number): ProbeResult {
  return {
    probe_id: `p-${split}-${f1}`, split, genre: 'g', page_path: 'x.md',
    extracted_count: 1, ground_truth_count: 1, true_positives: f1 >= 1 ? 1 : 0,
    false_positives: 0, false_negatives: 0,
    precision: f1, recall: f1, f1, f1_target: target,
    gate: f1 >= target ? 'pass' : 'fail',
    extracted_claims: [], ground_truth_claims: [], matches: [],
  };
}

const FULL_OPTS = { dryRun: false, probeFilter: null, plannedSplits: ['training', 'holdout'] };

describe('aggregate', () => {
  test('good full run passes', () => {
    const s = aggregate([probeRow('training', 0.95, 0.85), probeRow('holdout', 0.9, 0.80)], FULL_OPTS);
    expect(s.overall_gate).toBe('pass');
  });

  test('REGRESSION: low holdout F1 fails the gate', () => {
    const s = aggregate([probeRow('training', 0.86, 0.85), probeRow('holdout', 0.5, 0.80)], FULL_OPTS);
    expect(s.overall_gate).toBe('fail');
    expect(s.gate_reasons.join(' ')).toMatch(/holdout avg F1 0\.500 < 0\.8/);
  });

  test('overfitting gap fails the gate', () => {
    const s = aggregate([probeRow('training', 0.99, 0.85), probeRow('holdout', 0.85, 0.80)], FULL_OPTS);
    expect(s.overall_gate).toBe('fail');
    expect(s.gate_reasons.join(' ')).toMatch(/gap/);
  });

  test('REGRESSION: dry run can never claim pass — forced to partial', () => {
    const s = aggregate(
      [probeRow('training', 1, 0.85), probeRow('holdout', 1, 0.80)],
      { ...FULL_OPTS, dryRun: true },
    );
    expect(s.overall_gate).toBe('partial');
    expect(s.partial_reasons.join(' ')).toMatch(/dry_run/);
  });

  test('REGRESSION: filtered run (holdout split never scored) is partial, not pass', () => {
    const s = aggregate(
      [probeRow('training', 1, 0.85)],
      { dryRun: false, probeFilter: 'cat15-train-daily', plannedSplits: ['training'] },
    );
    expect(s.overall_gate).toBe('partial');
    expect(s.partial_reasons.join(' ')).toMatch(/probe filter active/);
  });

  test('a planned split with zero scored probes is partial', () => {
    const s = aggregate([probeRow('training', 1, 0.85)], FULL_OPTS);
    expect(s.overall_gate).toBe('partial');
    expect(s.partial_reasons.join(' ')).toMatch(/split 'holdout' has no scored probes/);
  });

  test('gate failures beat partial (a filtered failing run is fail, not partial)', () => {
    const s = aggregate(
      [probeRow('training', 0.2, 0.85)],
      { dryRun: false, probeFilter: 'x', plannedSplits: ['training'] },
    );
    expect(s.overall_gate).toBe('fail');
  });
});

// ─── Corpus resolution (calibration-cats-07) ──────────────────────────

describe('corpus dir is repo-relative', () => {
  test('default resolves inside node_modules/gbrain and exists with every probe fixture', () => {
    expect(DEFAULT_CORPUS_DIR).toBe(join(REPO_ROOT, 'node_modules', 'gbrain', 'test', 'fixtures', 'calibration'));
    expect(existsSync(DEFAULT_CORPUS_DIR)).toBe(true);
    for (const p of loadProbes()) {
      expect(existsSync(join(DEFAULT_CORPUS_DIR, p.page))).toBe(true);
      expect(existsSync(join(DEFAULT_CORPUS_DIR, p.ground_truth))).toBe(true);
    }
  });

  test('CAT15_CORPUS_DIR env override wins', () => {
    const prev = process.env.CAT15_CORPUS_DIR;
    try {
      process.env.CAT15_CORPUS_DIR = '/tmp/somewhere-else';
      expect(corpusDir()).toBe('/tmp/somewhere-else');
    } finally {
      if (prev === undefined) delete process.env.CAT15_CORPUS_DIR;
      else process.env.CAT15_CORPUS_DIR = prev;
    }
  });

  test('README the failure output points at exists (calibration-cats-11)', () => {
    expect(existsSync(join(REPO_ROOT, 'eval', 'data', 'cat15-propose-takes', 'README.md'))).toBe(true);
  });
});

// ─── End-to-end hermetic subprocess runs ──────────────────────────────

function runRunner(env: Record<string, string | undefined>, args: string[] = []) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) merged[k] = v;
  }
  const proc = Bun.spawnSync(['bun', RUNNER, ...args], {
    cwd: REPO_ROOT,
    env: merged,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe('runner end-to-end (hermetic)', () => {
  test('REGRESSION: missing corpus writes a skipped receipt and exits NON-zero without --allow-skip', () => {
    const out = runRunner({ CAT15_CORPUS_DIR: '/nonexistent-cat15-corpus', CAT15_DRY_RUN: '1', CAT15_PROBES: undefined });
    expect(out.exitCode).toBe(3);
    const receipt = JSON.parse(readFileSync(RECEIPT, 'utf-8'));
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.skip_reason).toMatch(/corpus dir not found/);
    expect(receipt.publishable).toBe(false);
  }, 30000);

  test('--allow-skip acknowledges the skip and exits 0', () => {
    const out = runRunner({ CAT15_CORPUS_DIR: '/nonexistent-cat15-corpus', CAT15_DRY_RUN: '1', CAT15_PROBES: undefined }, ['--allow-skip']);
    expect(out.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(RECEIPT, 'utf-8'));
    expect(receipt.run_status).toBe('skipped');
  }, 30000);

  test('REGRESSION: dry run completes with verdict partial + publishable:false + provenance in _summary.json (was a clean pass)', () => {
    const out = runRunner({ CAT15_DRY_RUN: '1', CAT15_CORPUS_DIR: undefined, CAT15_PROBES: undefined });
    expect(out.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(RECEIPT, 'utf-8'));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('partial');
    expect(receipt.publishable).toBe(false);
    expect(receipt.n_total).toBe(8);
    expect(receipt.n_scored).toBe(8);
    expect(receipt.gbrain_version).not.toBe('unknown');
    expect(receipt.resolved_config.dry_run).toBe(true);
    expect(receipt.resolved_config.prompt_version).toBe('v0.36.1.0-tuned-cat15');
    const summary = JSON.parse(readFileSync(SUMMARY, 'utf-8'));
    expect(summary.overall_gate).toBe('partial');
    expect(summary.provenance.dry_run).toBe(true);
    expect(summary.provenance.probe_filter).toBeNull();
    expect(summary.provenance.probes_planned).toBe(8);
    expect(summary.provenance.extract_model.length).toBeGreaterThan(0);
    expect(summary.provenance.started_at.length).toBeGreaterThan(0);
  }, 60000);

  test('REGRESSION: filtered dry run is partial and non-publishable, not a clean pass', () => {
    const out = runRunner({ CAT15_DRY_RUN: '1', CAT15_PROBES: 'cat15-train-daily', CAT15_CORPUS_DIR: undefined });
    expect(out.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(RECEIPT, 'utf-8'));
    expect(receipt.verdict).toBe('partial');
    expect(receipt.publishable).toBe(false);
    expect(receipt.n_total).toBe(1);
    const summary = JSON.parse(readFileSync(SUMMARY, 'utf-8'));
    expect(summary.overall_gate).toBe('partial');
    expect(summary.provenance.probe_filter).toBe('cat15-train-daily');
  }, 60000);

  test('empty probe filter writes a skipped receipt and exits 2', () => {
    const out = runRunner({ CAT15_DRY_RUN: '1', CAT15_PROBES: 'no-such-probe', CAT15_CORPUS_DIR: undefined });
    expect(out.exitCode).toBe(2);
    const receipt = JSON.parse(readFileSync(RECEIPT, 'utf-8'));
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.skip_reason).toMatch(/matched nothing/);
  }, 30000);
});
