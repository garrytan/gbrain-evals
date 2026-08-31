/**
 * cat34-brainbench-memory.ts regression tests (audit findings
 * skillopt-cats-04 and skillopt-cats-10).
 *
 * Hermetic: no API keys, no real gbrain checkout. A fake "gbrain repo" is
 * built in a temp dir whose src/cli.ts is a tiny bun script that honors the
 * published foreign-runner surface (`eval brainbench ... --out FILE`) and
 * behaves per a mode file: write a valid doc, write a contract-violating
 * doc, or exit without writing at all.
 *
 * Gates proven failable AND passing:
 *   - skillopt-cats-04: a stale result.json left by a previous run can no
 *     longer be graded as the current run (subprocess writes nothing →
 *     harness error, stale artifact purged, receipt carries zero stale data);
 *     the good-path run still passes with a fresh artifact.
 *   - skillopt-cats-10: a result_schema_version !== 1 (or truncated) document
 *     is a typed contract-mismatch error, not a TypeError or a silent grade.
 *   - the verdict is real: gold_failed > 0, a missing suite, or seed
 *     failures each flip verdict to fail with non-zero exit, even though the
 *     subprocess itself exits 0 (BrainBench without --compare).
 *   - missing checkout → run_status 'skipped' + non-zero exit unless
 *     allowSkip.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CAT34_CATEGORY,
  resolveGbrainRepo,
  runCat34,
  validateResultDoc,
} from '../../eval/runner/cat34-brainbench-memory.ts';

const RUN_TIMEOUT = 60_000;

// ─── Fake gbrain checkout speaking the foreign-runner contract ────────

const FAKE_CLI = `
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
const mode = readFileSync('mode.txt', 'utf-8').trim();

const suites = ['know-to-ask', 'push', 'write-back', 'continuity'];
const harnesses = ['openclaw', 'claude-code', 'codex'];
const cells = [];
for (const h of harnesses) {
  for (const s of suites) {
    cells.push({
      harness: h,
      seam: h === 'openclaw' ? 'production' : 'contract',
      suite: s,
      gold_total: 5,
      gold_failed: 0,
      metrics: { push_recall: 1 },
      fixtures: [],
    });
  }
}
const doc = {
  receipt: {
    result_schema_version: 1,
    fixtures_hash: 'f'.repeat(40),
    harness_sha: 'a'.repeat(40),
    ts: new Date().toISOString(),
    cmd_args: argv,
    seed: 42,
    include_holdout: false,
    llm: false,
  },
  cells,
  turn_rows: [],
  seed_failures: [],
};

let exitCode = 0;
if (mode === 'no-write') {
  process.stderr.write('eval brainbench: run failed: simulated flag/fixture error\\n');
  process.exit(2);
} else if (mode === 'gold-fail') {
  doc.cells[0].gold_failed = 2;
} else if (mode === 'schema-v2') {
  doc.receipt.result_schema_version = 2;
} else if (mode === 'missing-suite') {
  doc.cells = doc.cells.filter((c) => c.suite !== 'continuity');
} else if (mode === 'seed-fail') {
  doc.seed_failures = [{ fixture_id: 'gen-adv-001', error: 'simulated seed failure' }];
  exitCode = 2; // real brainbench exits 2 on seed failures
} else if (mode === 'vacuous') {
  for (const c of doc.cells) c.gold_total = 0;
}

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\\n');
}
process.exit(exitCode);
`;

let fakeRepo: string;

beforeAll(() => {
  fakeRepo = mkdtempSync(join(tmpdir(), 'cat34-fake-gbrain-'));
  mkdirSync(join(fakeRepo, 'src'), { recursive: true });
  mkdirSync(join(fakeRepo, 'evals', 'brainbench', 'fixtures'), { recursive: true });
  writeFileSync(join(fakeRepo, 'src', 'cli.ts'), FAKE_CLI);
  writeFileSync(join(fakeRepo, 'package.json'), JSON.stringify({ name: 'gbrain', version: '0.0.0-fake' }));
  writeFileSync(join(fakeRepo, 'mode.txt'), 'good');
});

function tmpReports(): string {
  return mkdtempSync(join(tmpdir(), 'cat34-test-reports-'));
}

async function runWithMode(mode: string, reportsDir = tmpReports()) {
  writeFileSync(join(fakeRepo, 'mode.txt'), mode);
  const run = await runCat34({ repo: fakeRepo, reportsDir, quiet: true });
  return { run, reportsDir, reportDir: join(reportsDir, CAT34_CATEGORY) };
}

// ─── validateResultDoc: the contract gate, unit-level ─────────────────

describe('validateResultDoc', () => {
  const goodDoc = {
    receipt: {
      result_schema_version: 1,
      fixtures_hash: 'f'.repeat(40),
      harness_sha: 'a'.repeat(40),
      ts: '2026-08-31T00:00:00Z',
      include_holdout: false,
      llm: false,
    },
    cells: [{ harness: 'openclaw', seam: 'production', suite: 'push', gold_total: 5, gold_failed: 0, metrics: {} }],
    seed_failures: [],
  };

  test('a schema-valid v1 document passes', () => {
    expect(validateResultDoc(goodDoc)).toEqual([]);
  });

  test('result_schema_version 2 is a violation', () => {
    const v2 = { ...goodDoc, receipt: { ...goodDoc.receipt, result_schema_version: 2 } };
    expect(validateResultDoc(v2).join('; ')).toContain('result_schema_version must be 1');
  });

  test('a truncated document is a violation list, not a crash', () => {
    expect(validateResultDoc({}).length).toBeGreaterThan(0);
    expect(validateResultDoc(null).length).toBeGreaterThan(0);
    expect(validateResultDoc({ receipt: goodDoc.receipt, cells: 'nope', seed_failures: [] }).join('; ')).toContain('cells must be an array');
  });

  test('a malformed cell is a violation', () => {
    const bad = { ...goodDoc, cells: [{ harness: 'openclaw' }] };
    expect(validateResultDoc(bad).join('; ')).toContain('cells[0]');
  });
});

// ─── End-to-end: good path ─────────────────────────────────────────────

describe('runCat34 good path', () => {
  test('all-pass matrix → completed/pass, exit 0, fresh canonical artifact', async () => {
    const { run, reportDir } = await runWithMode('good');
    expect(run.exitCode).toBe(0);
    expect(run.receipt.run_status).toBe('completed');
    expect(run.receipt.verdict).toBe('pass');
    expect(run.receipt.n_total).toBe(12); // 3 harnesses x 4 suites
    expect(run.receipt.n_scored).toBe(12);
    expect(run.receipt.errors).toEqual([]);
    expect(run.receipt.publishable).toBe(true);
    // provenance
    expect((run.receipt.resolved_config as any).gbrain_repo).toBe(fakeRepo);
    expect((run.receipt.resolved_config as any).sut_gbrain_version).toBe('0.0.0-fake');
    expect((run.receipt.resolved_config as any).reranker_enabled).toBe(false);
    expect(run.receipt.hashes?.fixtures).toBe('f'.repeat(40));
    // fresh canonical artifact, no nonced leftovers
    expect(existsSync(join(reportDir, 'result.json'))).toBe(true);
    expect(existsSync(join(reportDir, 'scorecard.md'))).toBe(true);
    const leftovers = readdirSync(reportDir).filter((f) => /^result-.*\.json$/.test(f));
    expect(leftovers).toEqual([]);
    // receipt written at the canonical path
    expect(existsSync(run.receiptFile)).toBe(true);
  }, RUN_TIMEOUT);
});

// ─── skillopt-cats-04: the stale-result regression ─────────────────────

describe('stale result.json (skillopt-cats-04)', () => {
  test('subprocess writes nothing → harness error, stale artifact never graded', async () => {
    const reportsDir = tmpReports();
    const reportDir = join(reportsDir, CAT34_CATEGORY);
    mkdirSync(reportDir, { recursive: true });
    // A stale result.json from "last week" with a distinctive hash.
    const staleHash = 'STALEHASH'.repeat(4);
    writeFileSync(join(reportDir, 'result.json'), JSON.stringify({
      receipt: {
        result_schema_version: 1, fixtures_hash: staleHash, harness_sha: 'b'.repeat(40),
        ts: '2026-01-01T00:00:00Z', include_holdout: false, llm: false,
      },
      cells: [{ harness: 'openclaw', seam: 'production', suite: 'push', gold_total: 5, gold_failed: 0, metrics: {} }],
      seed_failures: [],
    }));

    const { run, reportDir: dir } = await runWithMode('no-write', reportsDir);
    expect(run.exitCode).toBe(2);
    expect(run.receipt.run_status).toBe('error');
    expect(run.receipt.verdict).toBeUndefined();
    expect(run.receipt.errors.length).toBe(1);
    expect(run.receipt.errors[0]!.origin).toBe('harness');
    expect(run.receipt.errors[0]!.message).toMatch(/no fresh result artifact/);
    expect(run.receipt.publishable).toBe(false);
    // The stale artifact was purged, not promoted.
    expect(existsSync(join(dir, 'result.json'))).toBe(false);
    // Nothing from the stale doc leaked into the published receipt.
    const receiptRaw = readFileSync(run.receiptFile, 'utf-8');
    expect(receiptRaw).not.toContain(staleHash);
  }, RUN_TIMEOUT);
});

// ─── skillopt-cats-10: contract-mismatch gate ──────────────────────────

describe('result schema mismatch (skillopt-cats-10)', () => {
  test('result_schema_version 2 → typed dependency error, exit 2', async () => {
    const { run } = await runWithMode('schema-v2');
    expect(run.exitCode).toBe(2);
    expect(run.receipt.run_status).toBe('error');
    expect(run.receipt.errors[0]!.origin).toBe('dependency');
    expect(run.receipt.errors[0]!.message).toMatch(/result schema mismatch/);
    expect(run.receipt.errors[0]!.message).toMatch(/result_schema_version must be 1/);
  }, RUN_TIMEOUT);
});

// ─── The verdict is real: constructed bad inputs must FAIL ─────────────

describe('failable gate', () => {
  test('gold_failed > 0 → verdict fail, exit 1 (subprocess exited 0)', async () => {
    const { run } = await runWithMode('gold-fail');
    expect(run.exitCode).toBe(1);
    expect(run.receipt.run_status).toBe('completed');
    expect(run.receipt.verdict).toBe('fail');
    const sut = run.receipt.errors.filter((e) => e.origin === 'sut');
    expect(sut.length).toBe(1);
    expect(sut[0]!.message).toContain('gold_failed=2/5');
    expect((run.receipt.data as any).subprocess_exit).toBe(0);
  }, RUN_TIMEOUT);

  test('a suite missing from the matrix → verdict fail', async () => {
    const { run } = await runWithMode('missing-suite');
    expect(run.exitCode).toBe(1);
    expect(run.receipt.verdict).toBe('fail');
    expect(run.receipt.errors.some((e) => e.probe_id === 'suite:continuity' && e.origin === 'sut')).toBe(true);
    expect((run.receipt.data as any).missing_suites).toEqual(['continuity']);
  }, RUN_TIMEOUT);

  test('seed failures → verdict fail even with all cells green', async () => {
    const { run } = await runWithMode('seed-fail');
    expect(run.exitCode).toBe(1);
    expect(run.receipt.verdict).toBe('fail');
    expect(run.receipt.errors.some((e) => e.probe_id === 'seed:gen-adv-001' && e.origin === 'sut')).toBe(true);
  }, RUN_TIMEOUT);

  test('vacuous cells (gold_total 0) cannot pass — run invalidated', async () => {
    const { run } = await runWithMode('vacuous');
    expect(run.exitCode).toBe(2);
    expect(run.receipt.run_status).toBe('error'); // 100% infra-class error rate
    expect(run.receipt.errors.every((e) => e.origin === 'harness')).toBe(true);
    expect(run.receipt.errors[0]!.message).toContain('vacuous');
  }, RUN_TIMEOUT);
});

// ─── Skip semantics ────────────────────────────────────────────────────

describe('missing checkout', () => {
  test('resolveGbrainRepo(explicit invalid) returns null, no fallback', () => {
    expect(resolveGbrainRepo('/nonexistent/gbrain-xyz')).toBeNull();
  });

  test('skip → run_status skipped + NON-ZERO exit without allowSkip', async () => {
    const run = await runCat34({ repo: '/nonexistent/gbrain-xyz', reportsDir: tmpReports(), quiet: true });
    expect(run.exitCode).toBe(2);
    expect(run.receipt.run_status).toBe('skipped');
    expect(run.receipt.skip_reason).toContain('no gbrain checkout');
    expect(run.receipt.publishable).toBe(false);
  }, RUN_TIMEOUT);

  test('skip with allowSkip → exit 0, still recorded as skipped', async () => {
    const run = await runCat34({ repo: '/nonexistent/gbrain-xyz', reportsDir: tmpReports(), quiet: true, allowSkip: true });
    expect(run.exitCode).toBe(0);
    expect(run.receipt.run_status).toBe('skipped');
  }, RUN_TIMEOUT);
});
