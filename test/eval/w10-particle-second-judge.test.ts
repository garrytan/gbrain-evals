/**
 * Second-judge sensitivity for the particle-1 W10b finding: the judge plan, the committed judgments, and the finding's
 * keyless recheck (scripts/finding-particle-w10b.py --check). Keyless: reads the committed W10b answers and second-judge
 * rows, calls no provider.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
Object.assign(process.env, { W10_STATE_DIR: join(tmpdir(), `w10-second-judge-test-${process.pid}`), W10_PARTICLE_STATE_DIR: join(tmpdir(), `w10-second-judge-state-${process.pid}`) });
const { JUDGES, tasks } = await import('../../eval/runner/batch/w10-particle-second-judge.ts');
const { judgeVerdict, readNdjson } = await import('../../eval/runner/batch/sources.ts');

const ROOT = resolve(import.meta.dir, '../..');
const OUT = join(ROOT, 'docs/findings/2026-11-01-particle-1-longmemeval-w10b/second-judge');
const LAB: Record<string, string> = { 'particle-1': 'particle', 'claude-opus-5-5': 'anthropic', 'claude-sonnet-5-5': 'anthropic', 'gpt-6.1-sol': 'openai' };

describe('w10-particle-second-judge', () => {
  test('no judge reads an arm from its own lab, and every pair with particle-1 has a judge', () => {
    for (const { model, arms } of Object.values(JUDGES)) {
      const lab = model.slice(0, model.indexOf(':'));
      expect(arms).toContain('particle-1');
      for (const arm of arms) expect(LAB[arm]).not.toBe(lab);
    }
    const judged = Object.values(JUDGES).flatMap(j => j.arms).filter(a => a !== 'particle-1').sort();
    expect(judged).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']);
  });

  for (const judge of Object.keys(JUDGES)) {
    test(`${judge}: the committed rows are exactly the judgments it owes, each verdict read from its reply`, () => {
      const owed = tasks(judge);
      expect(owed.length).toBe(500 * JUDGES[judge].arms.length);
      const rows = readNdjson(join(OUT, judge, 'rows.ndjson'));
      const key = (r: { arm: unknown; question_id: unknown }) => `${r.arm}/${r.question_id}`;
      expect(rows.map(key).sort()).toEqual(owed.map(key).sort());
      for (const r of rows) {
        expect(r.judge).toBe(judge);
        expect(r.error).toBeNull();
        if (r.skipped) expect(r.verdict).toBe(false);
        else expect(r.verdict).toBe(judgeVerdict(String(r.raw)));
      }
      const receipt = JSON.parse(readFileSync(join(OUT, 'receipt.json'), 'utf8')).judges[judge];
      expect(receipt.judged).toBe(rows.length);
      expect(receipt.errors).toBe(0);
      expect(receipt.yes).toBe(rows.filter(r => r.verdict === true).length);
      expect(receipt.response_models).toEqual({ [judge]: rows.length });
    });
  }

  test('the finding recheck reproduces the committed analysis from the rows', () => {
    const r = Bun.spawnSync(['python3', 'scripts/finding-particle-w10b.py', '--check'], { cwd: ROOT });
    expect({ code: r.exitCode, stderr: r.stderr.toString().trim() }).toEqual({ code: 0, stderr: 'recheck matches analysis.txt and analysis.json' });
  }, 300_000);
});
