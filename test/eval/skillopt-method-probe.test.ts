/**
 * SkillOpt method A1 probe (GST-799, plan decision A): tool coverage, the
 * preregistered gate, the paid-run refusal and a keyless end-to-end run on
 * the fake transport. No model call.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withHermeticEnv } from '../../eval/runner/hermetic-env.ts';
import { NO_SKILL_TEXT, PROBE_GATE, probeGate, runProbe, servedTools, toolCoverage, type SkillProbe } from '../../eval/runner/skillopt-method/probe.ts';

const REPO_ROOT = join(import.meta.dir, '../..');

describe('tool coverage', () => {
  test("lists each seed's frontmatter brain operations that the rollout does not serve, and its tools outside the brain apart", () => {
    expect(servedTools()).toEqual(expect.arrayContaining(['get_backlinks', 'get_page', 'list_pages', 'query', 'search', 'traverse_graph']));
    expect(servedTools()).not.toContain('put_page');
    expect(toolCoverage().map(c => [c.skill, c.missing, c.outside_brain, c.full])).toEqual([
      ['query', ['recall', 'get_timeline'], [], false],
      ['briefing', ['get_timeline'], [], false],
      ['fact-check', [], ['web_search', 'web_fetch'], true],
    ]);
  });
});

describe('the preregistered gate', () => {
  const row = (skill: SkillProbe['skill'], seed: number, kept: number, gaps: string[] = []): SkillProbe => ({ skill, ceiling: 1, no_skill: 0, seed, one_shot_repeats: [kept], one_shot_kept: kept, seed_opus: seed, tool_gaps: gaps });
  test('build when two skills have the seed in band and room below the ceiling', () => {
    const g = probeGate([row('query', 0.5, 0.6), row('briefing', 0.2, 0.85), row('fact-check', 0.9, 0.9)]);
    expect(g.verdict).toBe('build');
    expect(g.qualifying).toEqual(['query', 'briefing']);
    expect(g.reasons['fact-check']).toEqual(['seed-above-band', 'one-shot-at-ceiling']);
  });
  test('one-shot at the ceiling: harden once, then stop, and a stop on a skill with a tool gap waits for its rerun', () => {
    const rows = [row('query', 0.5, 0.95, ['recall']), row('briefing', 0.5, 0.9), row('fact-check', 0.5, 0.6)];
    expect(probeGate(rows).verdict).toBe('harden-and-reprobe');
    const after = probeGate(rows, { afterHardening: true });
    expect(after.verdict).toBe('stop');
    expect(after.waits_for_rerun).toEqual(['query']);
  });
  test('a seed outside the band with room left is out of band, and a missing arm is incomplete', () => {
    expect(probeGate([row('query', 0.1, 0.3), row('briefing', 0.95, 0.5), row('fact-check', 0.5, 0.5)]).verdict).toBe('out-of-band');
    expect(probeGate([{ ...row('query', 0.5, 0.5), seed: null }, row('briefing', 0.9, 0.9), row('fact-check', 0.5, 0.5)]).verdict).toBe('incomplete');
    expect(PROBE_GATE).toEqual({ seedLow: 0.2, seedHigh: 0.8, minRoomBelowCeiling: 0.15, minSkills: 2 });
  });
});

describe('probe runs', () => {
  test('refuses a live probe without --paid --budget-run-id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'n15-ledger-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$/.test(k)));
      const r = Bun.spawnSync(['bun', 'eval/runner/n15-skillopt-method.ts', '--probe', '--budget-ledger', join(dir, 'ledger.sqlite'), '--output', dir], { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' });
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain('--paid --budget-run-id <id>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fake probe runs end to end through runSkillOpt and scoreSkillOnTasks and reads no test file', async () => {
    const r = await withHermeticEnv('n15-probe-test', async () => runProbe({ fake: true, skills: ['query'] }));
    expect(r.mode).toBe('fake');
    expect(r.files_read).toEqual(['eval/data/skillopt-method-v2/query/train.jsonl', 'eval/data/skillopt-method-v2/query/sel.jsonl']);
    const q = r.skills[0]!;
    expect({ no_skill: q.no_skill, seed: q.seed, repeats: q.one_shot_repeats, kept: q.one_shot_kept, seed_opus: q.seed_opus, ceiling: q.ceiling }).toEqual({ no_skill: 0, seed: 0.5, repeats: [1, 1], kept: 1, seed_opus: 0.5, ceiling: 1 });
    expect(Object.keys(q.arms.seed.per_task).length).toBe(24);
    expect(Object.values(q.arms.seed.per_task).every(runs => runs.length === 3)).toBe(true);
    expect(Object.values(q.arms.seed_opus.per_task).every(runs => runs.length === 1)).toBe(true);
    expect(q.arms.one_shot.filter(a => a.kept).length).toBe(1);
    expect(q.rewrites.every(t => !t.includes(NO_SKILL_TEXT))).toBe(true);
    expect(r.gate.verdict).toBe('harden-and-reprobe');
  }, 120_000);
});
