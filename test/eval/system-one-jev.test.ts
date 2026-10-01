/**
 * System One v1 (Jev decision support): keyless checks of the mirrored
 * record and the per-slot definitions. No gbrain call, no key, no network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDatasets, checkDefinitions, checkReceipts, pairProblems, sharedArgs, RECEIPTS_DIR } from '../../eval/runner/system-one-jev.ts';
import { datasetHash16, loadDatasets, mPilotIds, splitHash, stageS7, CAT35_DIR, DATA_DIR } from '../../eval/runner/system-one/datasets.ts';
import { compareLeaves, mcnemar, readJsonl, recountTriage, summarizeTriage, type TriageRow } from '../../eval/runner/system-one/recount.ts';
import { EVALUATIONS, NOT_PORTED, evaluation, evaluationsFor, resolveArgs, type Evaluation } from '../../eval/runner/system-one/slots.ts';
import { validateStoredReceipt } from '../../eval/runner/receipt.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const scratch = () => mkdtempSync(join(tmpdir(), 'system-one-test-'));
const failing = (checks: { ok: boolean; id: string; detail: string }[]) => checks.filter(c => !c.ok).map(c => `${c.id}: ${c.detail}`);

describe('gbrain dataset hashes, reimplemented', () => {
  test('datasetHash16 is the first 16 hex of sha256 over the file text', () => {
    expect(datasetHash16('abc')).toBe('ba7816bf8f01cfea');
  });

  test('splitHash sorts id:split lines, so line order does not change it', () => {
    const a = [{ id: 'b', split: 'eval' as const }, { id: 'a', split: 'calibrate' as const }];
    expect(splitHash(a)).toBe(splitHash([...a].reverse()));
    expect(splitHash(a)).not.toBe(splitHash([{ id: 'b', split: 'calibrate' }, { id: 'a', split: 'calibrate' }]));
  });
});

describe('datasets', () => {
  test('every committed and rebuilt dataset matches its frozen hash, split and counts', () => {
    expect(failing(checkDatasets(scratch()))).toEqual([]);
  });

  test('label provenance is declared for every dataset, and none is a human hand label', () => {
    for (const d of loadDatasets().datasets) {
      const total = Object.values(d.label_provenance).reduce((a, b) => a + b, 0);
      expect([d.id, total]).toEqual([d.id, d.items]);
      expect([d.id, Object.keys(d.label_provenance).some(k => k.startsWith('human'))]).toEqual([d.id, false]);
      expect(d.label_note.length).toBeGreaterThan(40);
    }
  });

  test('S7 reuses the Cat 35 corpus instead of copying it', () => {
    const staged = stageS7(scratch());
    expect(readdirSync(join(staged, 'transcripts-txt'))).toHaveLength(254);
    expect(readdirSync(join(DATA_DIR, 's7-triage-synthetic/transcripts-txt'))).toHaveLength(230);
    for (const name of readdirSync(join(CAT35_DIR, 'gold'))) {
      const cat35 = JSON.parse(readFileSync(join(CAT35_DIR, 'gold', name), 'utf8'));
      const projected = JSON.parse(readFileSync(join(staged, 'gold', name), 'utf8'));
      expect(projected.expected_triage).toBe(cat35.expected_triage);
      expect(projected.label_source).toBe('upstream-gold');
    }
  });

  test('the M pilot list is derived from the committed selection, identical to gbrain\'s m-pilot-28.txt', () => {
    expect(mPilotIds().trim().split('\n')).toHaveLength(28);
  });
});

describe('receipts', () => {
  test('upstream files are verbatim, recounts reproduce the published summaries, verdict numbers match receipts', () => {
    expect(failing(checkReceipts())).toEqual([]);
  });

  test('the recount detects a changed triage decision (negative control)', () => {
    const published = JSON.parse(readFileSync(join(RECEIPTS_DIR, 's7/summary.json'), 'utf8'));
    const rows = readJsonl<TriageRow>(join(RECEIPTS_DIR, 's7/arm-on-1.jsonl'));
    const buried = rows.findIndex(r => r.id.startsWith('syn-buried'));
    rows[buried] = { ...rows[buried]!, worth: false };
    expect(compareLeaves(published.b, summarizeTriage(rows)).length).toBeGreaterThan(0);
    expect(compareLeaves(published, recountTriage(join(RECEIPTS_DIR, 's7')))).toEqual([]);
  });

  test('exact McNemar matches the published p values', () => {
    expect(mcnemar(11, 27)).toBeCloseTo(0.013852965261321515, 12);
    expect(Math.round(mcnemar(1, 9) * 1e4) / 1e4).toBe(0.0215);
    expect(mcnemar(0, 0)).toBe(1);
  });

  test('the post-eval fix is visible in the record: the S1 expansion arms never reranked', () => {
    const s = JSON.parse(readFileSync(join(RECEIPTS_DIR, 's1/longmemeval-s-summary.json'), 'utf8'));
    const m = JSON.parse(readFileSync(join(RECEIPTS_DIR, 's1/longmemeval-m-pilot-summary.json'), 'utf8'));
    expect(s.s_jev100x.decide_outcomes).toEqual({ 'rerank:skipped:timeout': 248 });
    expect(m.m_jev100x.decide_outcomes).toEqual({ 'rerank:skipped:timeout': 28 });
  });

  test('only S7 and S9 are wins, matching what gbrain enables with --recommended', () => {
    const verdicts = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/benchmarks/2026-09-30-system-one-jev/verdicts.json'), 'utf8')) as { slots: { slot: string; verdict: string }[]; model_resolved: string };
    expect(verdicts.slots.filter(s => s.verdict.startsWith('win')).map(s => s.slot).sort()).toEqual(['S7', 'S9']);
    expect(verdicts.model_resolved).toBe('jev-1.13.0');
  });
});

describe('per-slot definitions', () => {
  test('every evaluation is a matched pair with committed receipts', () => {
    expect(failing(checkDefinitions())).toEqual([]);
  });

  test('every slot S1-S9 has at least one evaluation', () => {
    expect([...new Set(EVALUATIONS.map(e => e.slot))].sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
  });

  test('the pair check rejects an on arm whose data or settings differ from every off arm (negative control)', () => {
    const base = evaluation('s1-rerank-lme-s')!;
    const broken: Evaluation = { ...base, arms: base.arms!.map(a => (a.name === 's_jev30' ? { ...a, args: [...a.args, '--top-k', '10'] } : a)) };
    expect(pairProblems(broken)).toEqual(['s_jev30: no off arm with the same data and settings']);
    const offOn: Evaluation = { ...base, arms: base.arms!.map(a => (a.role === 'off' ? { ...a, args: [...a.args, '--decide', 'rerank=on'] } : a)) };
    expect(pairProblems(offOn).some(p => p.includes('an off arm turns a slot on'))).toBe(true);
  });

  test('sharedArgs strips only the slot-under-test flags', () => {
    expect(sharedArgs(['--retrieval-only', '--decide', 'rerank=on', '--search-pin', 'search.reranker.top_n_in=30', '--expansion'])).toEqual(['--retrieval-only']);
    expect(sharedArgs(['--search-pin', 'search.mode=balanced'])).toEqual(['--search-pin', 'search.mode=balanced']);
  });

  test('placeholders resolve or fail loudly', () => {
    expect(resolveArgs(['{data}/x.jsonl', '{S}'], { data: 'd', S: 's.json' })).toEqual(['d/x.jsonl', 's.json']);
    expect(() => resolveArgs(['{nope}'], {})).toThrow('unresolved placeholder');
  });

  test('slot lookup accepts an id, a slot number or a decide slot name', () => {
    expect(evaluationsFor('S1').map(e => e.id)).toContain('s1-rerank-lme-s');
    expect(evaluationsFor('triage').map(e => e.id)).toEqual(['s7-triage-pair']);
    expect(evaluationsFor('s9-conflict-values')).toHaveLength(1);
  });

  test('parts that could not be ported say why', () => {
    for (const n of NOT_PORTED) expect(n.reason.length).toBeGreaterThan(40);
  });
});

describe('runner', () => {
  test('verify writes a valid passing receipt', () => {
    const out = scratch();
    const r = spawnSync('bun', ['eval/runner/system-one-jev.ts', 'verify', '--output', out], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const receipt = JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
    expect(validateStoredReceipt(receipt)).toEqual([]);
    expect(receipt.verdict).toBe('pass');
    expect(receipt.category).toBe('system-one-jev');
  });

  test('commands that execute gbrain refuse without --gbrain, and run refuses without --yes', () => {
    const noGbrain = spawnSync('bun', ['eval/runner/system-one-jev.ts', 'build'], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, GBRAIN_UNDER_TEST: '' } });
    expect(noGbrain.status).not.toBe(0);
    expect(noGbrain.stderr).toContain('--gbrain');
    const noYes = spawnSync('bun', ['eval/runner/system-one-jev.ts', 'run', '--eval', 'S9'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(noYes.status).toBe(2);
    expect(noYes.stderr).toContain('--yes');
  });
});
