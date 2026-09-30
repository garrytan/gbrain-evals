/**
 * Decision manifest v2 (auto v2 follow-up): keyless checks of the sanity
 * rule, the sealed superiority rule and the auto diagnostics.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideE2V2, decideSanity, loadDecisionManifestV2, validateDecisionManifestV2, type DecisionManifestV2 } from '../../eval/runner/evidence-delivery/decision-v2.ts';
import type { OutcomeRow } from '../../eval/runner/evidence-delivery/decision.ts';
import { autoDiagnostics, ruleSha } from '../../eval/runner/evidence-auto-v2.ts';

const { manifest } = loadDecisionManifestV2();

const lme = (correct: number, extra: (i: number) => Partial<OutcomeRow> = () => ({})): OutcomeRow[] =>
  Array.from({ length: 500 }, (_, i) => ({ question_id: `q${i}`, question_type: 'multi-session', cluster: `q${i}`, primary: i < correct ? 1 : 0, confirmation: i < correct ? 1 : 0, provider_input_tokens: 1000, ...extra(i) }));
const sealed = (outcome: (i: number) => 0 | 1, extra: (i: number) => Partial<OutcomeRow> = () => ({}), confirmation?: (i: number) => 0 | 1): OutcomeRow[] =>
  Array.from({ length: 150 }, (_, i) => ({ question_id: `s${String(i).padStart(3, '0')}`, question_type: 'sealed', cluster: `p${Math.floor(i / 5)}`, primary: outcome(i), confirmation: (confirmation ?? outcome)(i), provider_input_tokens: 2000, ...extra(i) }));

describe('manifest v2', () => {
  test('is internally consistent', () => {
    expect(validateDecisionManifestV2(manifest)).toEqual([]);
    expect(manifest.e2.decision_id).toBe('evidence-auto-v2-2026-09-30:e2:auto');
    expect(manifest.budget.campaign_cap_usd).toBe(150);
  });

  test('validation refuses a budgeted auto arm or page on the sealed set', () => {
    const bad: DecisionManifestV2 = JSON.parse(JSON.stringify(manifest));
    bad.arms[1].budget_tokens = 6000;
    bad.arms[2].sets.push('sealed');
    const problems = validateDecisionManifestV2(bad).join('\n');
    expect(problems).toContain('product default budget');
    expect(problems).toContain('LongMemEval reference only');
  });

  test('the rule hash ignores only the gbrain pin', () => {
    const pinned: DecisionManifestV2 = JSON.parse(JSON.stringify(manifest));
    pinned.candidate_commits.gbrain = 'a'.repeat(40);
    expect(ruleSha(pinned)).toBe(ruleSha({ ...manifest, candidate_commits: { ...manifest.candidate_commits, gbrain: null } }));
    pinned.e2.alpha = 0.1;
    expect(ruleSha(pinned)).not.toBe(ruleSha(manifest));
  });

  test('the committed power report was computed for this rule', () => {
    const path = join(import.meta.dir, '../../docs/benchmarks/2026-09-30-evidence-auto-v2/power-analysis.json');
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).decision_rule_sha256).toBe(ruleSha(manifest));
  });
});

describe('LongMemEval sanity: auto >= page - 2% of 500', () => {
  test('exactly ten below page passes; eleven below fails', () => {
    expect(decideSanity(manifest, lme(320), lme(440), lme(450))).toMatchObject({ threshold: 440, pass: true });
    expect(decideSanity(manifest, lme(320), lme(439), lme(450)).pass).toBe(false);
  });

  test('reader errors count as incorrect; a missing question is reported and fails', () => {
    const s = decideSanity(manifest, lme(320), lme(445, i => (i < 6 ? { reader_error: 'x' } : {})), lme(450));
    expect(s.auto).toBe(439);
    const m = decideSanity(manifest, lme(320), lme(450).slice(1), lme(450));
    expect(m.pass).toBe(false);
    expect(m.problems[0]).toContain('auto: 499 of 500');
  });
});

describe('sealed E2 superiority rule', () => {
  test('a clear gain spread over personas passes both tests and the confirmation judge', () => {
    const d = decideE2V2(manifest, sealed(i => (i % 5 !== 0 ? 1 : 0)), sealed(() => 1));
    expect(d.outcome).toBe('pass');
    expect(d).toMatchObject({ delta: 30, n_clusters: 30 });
    expect(d.mcnemar.p).toBeLessThan(0.05);
    expect(d.sign_flip.p).toBeLessThan(0.05);
  });

  test('a small gain that is not significant fails; a loss fails', () => {
    expect(decideE2V2(manifest, sealed(i => (i < 100 ? 1 : 0)), sealed(i => (i < 103 ? 1 : 0))).outcome).toBe('fail');
    expect(decideE2V2(manifest, sealed(i => (i < 110 ? 1 : 0)), sealed(i => (i < 100 ? 1 : 0))).outcome).toBe('fail');
  });

  test('offsetting wins and losses do not pass on the net count alone', () => {
    const d = decideE2V2(manifest, sealed(i => (i < 100 || (i >= 140) ? 1 : 0)), sealed(i => (i < 118 && !(i >= 90 && i < 100) ? 1 : 0)));
    expect(d.mcnemar.wins).toBe(18);
    expect(d.mcnemar.losses).toBe(20);
    expect(d.outcome).toBe('fail');
  });

  test('the same gain concentrated in four personas fails the clustered test', () => {
    const d = decideE2V2(manifest, sealed(i => (i < 100 ? 1 : 0)), sealed(i => (i < 120 ? 1 : 0)));
    expect(d.mcnemar.p).toBeLessThan(0.05);
    expect(d.sign_flip.p).toBeGreaterThan(0.05);
    expect(d.outcome).toBe('fail');
  });

  test('a confirmation judge that reverses a pass makes it inconclusive', () => {
    expect(decideE2V2(manifest, sealed(i => (i % 5 !== 0 ? 1 : 0)), sealed(() => 1, () => ({}), i => (i % 5 !== 0 && i > 10 ? 1 : 0))).outcome).toBe('inconclusive');
  });

  test('too many reader errors or a missing question is inconclusive', () => {
    expect(decideE2V2(manifest, sealed(i => (i < 100 ? 1 : 0)), sealed(i => (i < 120 ? 1 : 0), i => (i < 4 ? { reader_error: 'x' } : {}))).outcome).toBe('inconclusive');
    expect(decideE2V2(manifest, sealed(i => (i < 100 ? 1 : 0)), sealed(i => (i < 120 ? 1 : 0)).slice(1)).outcome).toBe('inconclusive');
  });
});

describe('auto diagnostics', () => {
  test('counts whole pages, cuts, over-budget conversations and plain chunks', () => {
    expect(autoDiagnostics([
      { delivered: { unit: 'page', reason: 'conversation_slug' } },
      { delivered: { unit: 'page', reason: 'conversation_slug', truncated: true } },
      { delivered: { unit: 'chunk', reason: 'conversation_over_budget' } },
      { delivered: { unit: 'chunk', reason: 'not_conversation' } },
      {},
    ])).toEqual({ blocks: 5, page: 2, chunk: 3, truncated: 1, conversation_over_budget: 1, not_conversation: 1, fallback: 0 });
  });
});
