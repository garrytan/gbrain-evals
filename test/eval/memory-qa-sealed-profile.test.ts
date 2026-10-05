/**
 * Sealed execution profile for memory-qa custodian cells: destinations stay
 * inside the custody root, and only allowlisted aggregates leave it. Planted
 * sealed markers in answers, source ids, exception text, contexts and
 * filenames must not survive the export. Keyless.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkSealedDestinations, exportAggregates, sealedPaths } from '../../eval/runner/memory-qa/sealed-profile.ts';
import { parseRunArgs, runArm } from '../../eval/runner/memory-qa/run.ts';

const ROOT = resolve(import.meta.dir, '../..');
const custody = mkdtempSync(join(tmpdir(), 'custody-'));
afterAll(() => rmSync(custody, { recursive: true, force: true }));
const MARKERS = ['SEALEDMARK-answer-7f3a', 'SEALEDMARK-src-91bc', 'SEALEDMARK-error-22de', 'SEALEDMARK-context-0a0a', 'SEALEDMARK-file-5e5e', 'SEALEDMARK-conv-1234'];

describe('sealed destinations', () => {
  test('output and caches inside the custody root pass', () => {
    expect(() => checkSealedDestinations(sealedPaths(custody, join(custody, 'out')))).not.toThrow();
  });
  test('repository, shared cache and outside-root destinations are refused', () => {
    expect(() => checkSealedDestinations(sealedPaths(custody, join(ROOT, 'eval/reports/x')))).toThrow(/output is outside the custody root.*inside the repository/);
    expect(() => checkSealedDestinations(sealedPaths(join(ROOT, 'eval/reports/custody'), join(ROOT, 'eval/reports/custody/out')))).toThrow(/overlaps the repository/);
    expect(() => checkSealedDestinations(sealedPaths(join(homedir(), '.cache', 'gbrain-evals', 'c'), join(homedir(), '.cache', 'gbrain-evals', 'c', 'o')))).toThrow(/shared gbrain-evals cache/);
    expect(() => checkSealedDestinations({ ...sealedPaths(custody, join(custody, 'out')), qaCache: join(homedir(), '.cache', 'gbrain-evals', 'qa-cache') })).toThrow(/QA cache/);
  });
  test('memory-qa refuses a sealed shootout run without the profile, and a profile pointing into the repository, before reading any data', async () => {
    const base = ['--benchmark', 'locomo', '--system', 'fake', '--split', 'sealed', '--decision-id', 'd', '--purpose', 'p'];
    const prev = process.env.GBRAIN_EVALS_CUSTODY_LOG;
    process.env.GBRAIN_EVALS_CUSTODY_LOG = join(custody, 'access.log');
    try {
      await expect(runArm(parseRunArgs([...base, '--output', join(custody, 'o1')]))).rejects.toThrow(/needs --sealed-profile/);
      await expect(runArm(parseRunArgs([...base, '--output', join(ROOT, 'eval/reports/sealed-x'), '--sealed-profile', custody]))).rejects.toThrow(/sealed profile refused/);
      expect(() => readFileSync(join(custody, 'access.log'))).toThrow();
    } finally { if (prev === undefined) delete process.env.GBRAIN_EVALS_CUSTODY_LOG; else process.env.GBRAIN_EVALS_CUSTODY_LOG = prev; }
  });
});

describe('aggregate export', () => {
  test('planted sealed markers never survive the allowlist', () => {
    const receipt = {
      kind: 'memory-qa-arm', schema_version: 1, benchmark: 'locomo', split: 'sealed', run_status: 'partial',
      invalid_reasons: [`row ${MARKERS[2]} failed`], run_config_hash: 'a'.repeat(64), manifest_sha256: 'b'.repeat(64),
      product: { commit: MARKERS[5], version: '0.60.46.0' }, arm_config: { note: MARKERS[0] },
      dataset: { files: [{ path: `${MARKERS[4]}.json`, sha256: 'c'.repeat(64) }] },
      selection: { categories: [MARKERS[5]], questions_expected: 120, conversations: 14 },
      counts: { rows: 118, scored: 110, errors: 2, abstention: 6, sample_error: MARKERS[2] },
      summary: { recall_all_at_5: 0.71, qa_score: 0.64, qa_answer: MARKERS[0], latency_p50_ms: 120 },
      outcomes: { scored: 110, retrieval_error: 2, reader_error: 1, note: MARKERS[3] },
      cost: { usd: 3.21, ledger: `/custody/${MARKERS[4]}` },
      system: { name: 'mem0', capabilities: { source: MARKERS[1] } }, context: 'native', policy: { name: `mem0:${MARKERS[1]}`, mode: 'fixed-evidence' },
      rows: [{ id: MARKERS[5], qa_prompt: MARKERS[3], retrieved: [MARKERS[1]] }],
      run_status_note: 'complete', comparison_complete: false, ingest: { conversations: 14, degraded_conversations: 1 },
    };
    const out = exportAggregates(receipt);
    const text = JSON.stringify(out);
    for (const m of MARKERS) expect(text).not.toContain(m);
    expect(out).toMatchObject({ kind: 'memory-qa-arm', benchmark: 'locomo', split: 'sealed', run_status: 'partial', 'summary.recall_all_at_5': 0.71, 'summary.qa_score': 0.64,
      'outcomes.reader_error': 1, 'cost.usd': 3.21, 'system.name': 'mem0', context: 'native', 'policy.mode': 'fixed-evidence', 'selection.questions_expected': 120, comparison_complete: false });
    expect(Object.keys(out).some(k => k.startsWith('rows') || k.startsWith('invalid_reasons') || k.startsWith('product') || k.startsWith('dataset'))).toBe(false);
  });

  test('the export CLI writes only the allowlisted view', () => {
    const dir = join(custody, 'cli'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ kind: 'memory-qa-arm', benchmark: 'locomo', summary: { recall_all_at_5: 0.5 }, invalid_reasons: [MARKERS[2]] }));
    const r = Bun.spawnSync([process.execPath, 'eval/runner/memory-qa/sealed-profile.ts', 'export', '--receipt', join(dir, 'receipt.json'), '--out', join(dir, 'public.json')], { cwd: ROOT });
    expect(r.exitCode).toBe(0);
    const text = readFileSync(join(dir, 'public.json'), 'utf8');
    expect(text).not.toContain(MARKERS[2]);
    expect(JSON.parse(text)['summary.recall_all_at_5']).toBe(0.5);
  });
});
