/**
 * Sealed evidence-delivery decisions: the committed decision 1 files, the
 * reader's evidence shape, delivery counts and the preregistered rule over
 * compare.ts output. Keyless; invented rows only.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideEvidence, deliveryCounts, evidenceSessions, loadDecision, loadManifest, type EvidenceDecision } from '../../eval/runner/sealed-confirmation.ts';
import { evaluateFamily, loadFamily } from '../../eval/runner/stats/gates.ts';

const ROOT = join(import.meta.dir, '..', '..');
const DIR = join(ROOT, 'docs/benchmarks/2026-10-02-sealed-v2-decision-1');
const V2 = join(ROOT, 'eval/data/sealed-confirmation-v2/manifest.json');

describe('sealed v2 decision 1 files', () => {
  test('the decision file matches the v2 commitments and names a 40-hex gbrain pin', () => {
    const { decision } = loadDecision(join(DIR, 'decision.json'), loadManifest(V2));
    expect(decision.candidate_commits.gbrain).toBe('d44296cf4d6481a10eb85562d3179e38cfd02c43');
    expect(decision.arms.map(a => a.id)).toEqual(['chunk', 'auto']);
    expect(decision.arms.find(a => a.id === 'auto')!.expected_budget_tokens).toBe(24000);
  });

  test('the decision file refuses the v1 manifest', () => {
    expect(() => loadDecision(join(DIR, 'decision.json'), loadManifest(join(ROOT, 'eval/data/sealed-confirmation-v1/manifest.json')))).toThrow(/sealed-confirmation-v2/);
  });

  test('the family carries the rule the decision names', () => {
    const decision = JSON.parse(readFileSync(join(DIR, 'decision.json'), 'utf8')) as EvidenceDecision & { rule: { noninferiority_margin: number } };
    const family = loadFamily(join(ROOT, decision.rule.family));
    const ni = family.comparisons.find(c => c.id === decision.rule.noninferiority_comparison)!;
    expect(ni.gate).toBe('noninferiority');
    expect(ni.gate === 'noninferiority' && ni.tolerance).toBe(decision.rule.noninferiority_margin);
    expect(ni.cluster_by).toBe('haystack_id');
    expect(family.comparisons.find(c => c.id === decision.rule.superiority_comparison)!.metric).toBe('answer_correct');
    expect(family.alpha).toBe(decision.rule.alpha);
  });
});

describe('reader evidence', () => {
  test('one dated single-turn pseudo-session per delivered block', () => {
    const fq = { pages: [{ slug: 'chat/a', date: '2025/01/02' }, { slug: 'chat/b', date: null }], hits5: [] };
    const texts: Record<string, string> = { h1: 'chunk one', h2: 'chunk two' };
    expect(evidenceSessions(fq, [{ slug: 'chat/a', text: 'h1' }, { slug: 'chat/b', text: 'h2' }], h => texts[h])).toEqual([
      { date: '2025/01/02', turns: [{ role: 'user', content: 'chunk one' }] },
      { date: '', turns: [{ role: 'user', content: 'chunk two' }] },
    ]);
  });

  test('delivery counts pages, chunks, truncation and over-budget fallbacks', () => {
    expect(deliveryCounts([{ delivered: { unit: 'page' } }, { delivered: { unit: 'page', truncated: true } }, { delivered: { unit: 'chunk', reason: 'conversation_over_budget' } }, {}]))
      .toEqual({ blocks: 4, page: 2, chunk: 2, truncated: 1, over_budget: 1 });
  });
});

describe('decideEvidence', () => {
  const decision = JSON.parse(readFileSync(join(DIR, 'decision.json'), 'utf8')) as EvidenceDecision;
  const family = loadFamily(join(DIR, 'family.json'));
  /** 40 personas x 5 questions; `flip(j, k)` returns [chunk, auto] correctness. */
  const rows = (flip: (j: number, k: number) => [boolean, boolean]) => {
    const a = [], b = [];
    for (let j = 0; j < 40; j++) for (let k = 0; k < 5; k++) {
      const [x, y] = flip(j, k);
      a.push({ question_id: `q${j}-${k}`, haystack_id: `h${j}`, answer_correct: x, recall_all: k < 4 ? 1 : null });
      b.push({ question_id: `q${j}-${k}`, haystack_id: `h${j}`, answer_correct: y, recall_all: k < 4 ? 1 : null });
    }
    return evaluateFamily(a, b, { ...family, draws: 2000 });
  };

  test('a large gain passes non-inferiority and confirms superiority', () => {
    const out = decideEvidence(decision.rule, { decision: rows((j, k) => [k < 2, k < 4]) as any }, { chunk: 0, auto: 0 });
    expect(out.verdict).toBe('pass');
    expect(out.superiority).toBe('confirmed');
  });

  test('no net difference with many disagreements leaves non-inferiority within 3 points unshown', () => {
    const out = decideEvidence(decision.rule, { decision: rows((j, k) => k < 2 ? [true, true] : [(j + k) % 2 === 0, (j + k) % 2 === 1]) as any }, { chunk: 0, auto: 0 });
    expect(out.verdict).toBe('inconclusive');
    expect(out.superiority).toBe('not_tested');
  });

  test('a large loss fails', () => {
    const out = decideEvidence(decision.rule, { decision: rows((j, k) => [k < 4, k < 2]) as any }, { chunk: 0, auto: 0 });
    expect(out.verdict).toBe('fail');
  });

  test('a small consistent gain passes non-inferiority without confirming superiority', () => {
    const out = decideEvidence(decision.rule, { decision: rows((j, k) => [k < 3, k < 3 || (k === 3 && j < 3)]) as any }, { chunk: 0, auto: 0 });
    expect(out.verdict).toBe('pass');
    expect(out.superiority).toBe('not_confirmed');
  });

  test('more than three reader errors in an arm is inconclusive whatever the scores', () => {
    const out = decideEvidence(decision.rule, { decision: rows((j, k) => [k < 2, k < 4]) as any }, { chunk: 0, auto: 4 });
    expect(out.verdict).toBe('inconclusive');
  });

  test('a scored row only carries error fields when it failed, so compare.ts keeps it eligible', () => {
    const a = [{ question_id: 'q1', haystack_id: 'h', answer_correct: true }, { question_id: 'q2', haystack_id: 'h', answer_correct: false, error: true, error_origin: 'sut' }];
    const d = evaluateFamily(a, a, { ...family, draws: 2000, min_clusters: 2, comparisons: [family.comparisons[1]] });
    expect(d.comparisons[0].n_pairs).toBe(2);
  });
});
