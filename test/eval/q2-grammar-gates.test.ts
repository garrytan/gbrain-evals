import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocRecord, MintedLine } from '../../eval/runner/line-grammar-junk-audit.ts';
import { AttemptCheckpoint } from '../../eval/runner/q2/checkpoints.ts';
import { stratifiedByModel, type GrammarLine } from '../../eval/runner/q2/grammar-lines.ts';
import { Q2_JUDGE_PROMPT_SHA256, labelKey, labelLines, lineOutcome, q2JudgePrompt, type LineVerdict } from '../../eval/runner/q2/judge.ts';
import { drawG2, mintId, scoreG1, scoreG2, scoreG4, g3Gates } from '../../eval/runner/q2/junk-audit.ts';
import { PUBLISHED_USAGE_LABELS, q2ItemClass, q2ListLines } from '../../eval/runner/q2/junk-classes.ts';
import { devKPages, matchCandidates, parseKPages, probeNearMiss, scoreK } from '../../eval/runner/q2/k-conformance.ts';
import { BEAM_AMENDMENT_1_EXCLUDED, loadNSet, validateNManifest } from '../../eval/runner/q2/n-corpus.ts';
import { wilson, wilsonUpperPer100k } from '../../eval/runner/q2/stats.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'q2-gates-'));

describe('runner-defined zero-tolerance classes (independent of the parser)', () => {
  test('template slots and usage labels, with link, escape and code exceptions', () => {
    expect(q2ItemClass('[Time] - [Event]')).toBe('template_slot');
    expect(q2ItemClass('[Day] | Notes')).toBe('template_slot');
    expect(q2ItemClass('[Start] – [End]: [Session]')).toBe('template_slot');
    expect(q2ItemClass('[noun] Runbook: a guide')).toBe('usage_label');
    expect(q2ItemClass('[Adj.] tall')).toBe('usage_label');
    for (const ok of ['[preference] Prefers tea', '[fact] value [label](https://x)', '[fact] see [[people/a]]', '[fact] -40 degrees', '[fact] `[Slot]` in code', '[fact] escaped \\[Slot] here', '[[people/a]] - [Role]', '[label](https://x) - [Event]'])
      expect(q2ItemClass(ok)).toBeNull();
    expect(PUBLISHED_USAGE_LABELS).toHaveLength(30);
  });
  test('H3 classes keep precedence and machine sections stay machine sections', () => {
    expect(q2ItemClass('[x] done')).toBe('task_marker');
    const lines = q2ListLines('# Notes\n\n- [Time] - [Event]\n\n## Timeline\n\n- [noun] word\n');
    expect(lines.map(l => l.zero_tolerance)).toEqual(['template_slot', 'machine_section']);
  });
});

describe('Wilson bounds match the preregistration', () => {
  test('per 100,000 at 500,000 lines: 3 wrong gives 1.76, 4 gives 2.06; G2 293/300 -> 0.953, 292/300 -> 0.948', () => {
    expect(wilsonUpperPer100k(3, 500_000).toFixed(2)).toBe('1.76');
    expect(wilsonUpperPer100k(4, 500_000).toFixed(2)).toBe('2.06');
    expect(wilson(293, 300).lower.toFixed(3)).toBe('0.953');
    expect(wilson(292, 300).lower.toFixed(3)).toBe('0.948');
    expect(wilson(0, 18).upper.toFixed(3)).toBe('0.176');
  });
});

function labels(entries: Array<[string, LineVerdict | 'terminal' | 'retryable', LineVerdict | 'terminal' | 'retryable']>): AttemptCheckpoint<{ verdict: LineVerdict }> {
  const c = new AttemptCheckpoint<{ verdict: LineVerdict }>(join(scratch(), 'labels.jsonl'));
  for (const [id, a, b] of entries) for (const [j, v] of [['claude-opus-5-5', a], ['gpt-6.1-sol', b]] as const) {
    if (v === 'terminal' || v === 'retryable') c.record(labelKey(id, j), { line: id, judge: j }, { state: v, usd: 0, error: 'x' });
    else c.record(labelKey(id, j), { line: id, judge: j }, { state: 'done', result: { verdict: v }, usd: 0.01 });
  }
  return c;
}

describe('labels: a disagreement counts as wrong; no adjudication', () => {
  test('outcomes', () => {
    const c = labels([['a', 'correct', 'correct'], ['b', 'correct', 'incorrect'], ['c', 'terminal', 'correct'], ['d', 'retryable', 'correct'], ['e', 'retryable', 'incorrect']]);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map(id => lineOutcome(id, c))).toEqual(['correct', 'wrong', 'wrong', 'unlabeled', 'wrong', 'unlabeled']);
  });
  test('judge retry: transient errors retry, a 400 is terminal, repeated unparseable replies are terminal; reruns skip finished pairs', async () => {
    const c = new AttemptCheckpoint<{ verdict: LineVerdict }>(join(scratch(), 'labels.jsonl'));
    const calls: string[] = [];
    let flaky = 0;
    const chat = async (model: string, _s: string, user: string) => {
      calls.push(`${model}:${user.includes('LINE-A') ? 'a' : user.includes('LINE-B') ? 'b' : 'c'}`);
      if (user.includes('LINE-A') && model === 'gpt-6.1-sol' && flaky++ === 0) throw new Error('judge provider error 503: busy');
      if (user.includes('LINE-B') && model === 'gpt-6.1-sol') throw new Error('judge provider error 400: bad request');
      if (user.includes('LINE-C') && model === 'gpt-6.1-sol') return { text: 'not json', usd: 0.001, input_tokens: 1, output_tokens: 1 };
      return { text: '{"verdict":"correct"}', usd: 0.002, input_tokens: 1, output_tokens: 1 };
    };
    const line = (id: string, text: string) => ({ id, kind: 'fact' as const, parsed: 'fact category x', text, context: text });
    const lines = [line('a', '- [x] LINE-A'), line('b', '- [x] LINE-B'), line('c', '- [x] LINE-C')];
    await labelLines(lines, c, { chat, backoffMs: 1, concurrency: 1 });
    expect(c.get(labelKey('a', 'gpt-6.1-sol'))).toMatchObject({ state: 'done', attempts: 2 });
    expect(c.get(labelKey('b', 'gpt-6.1-sol'))).toMatchObject({ state: 'terminal', attempts: 1 });
    expect(c.get(labelKey('c', 'gpt-6.1-sol'))).toMatchObject({ state: 'terminal', attempts: 3 });
    expect(lineOutcome('a', c)).toBe('correct');
    expect(lineOutcome('b', c)).toBe('wrong');
    const before = calls.length;
    await labelLines(lines, new AttemptCheckpoint<{ verdict: LineVerdict }>(c.path), { chat, backoffMs: 1 });
    expect(calls.length).toBe(before);
    expect(c.spendUsd()).toBeGreaterThan(0);
  });
  test('the frozen prompt has a stable hash and asks for a verdict only', () => {
    expect(Q2_JUDGE_PROMPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(q2JudgePrompt({ kind: 'relation', parsed: 'relation type works_at', text: '- works_at [[x]]', context: '' })).toContain('{"verdict": "correct" | "incorrect"}');
  });
});

const mint = (doc: string, line: number, text: string, extra: Partial<MintedLine> = {}): MintedLine => ({ id: `${doc}:${line}`, doc, corpus: 'stress', line, kind: 'fact', parsed: 'fact category x', text, context: '', zero_tolerance: null, ...extra });
const docRec = (corpus: string, doc: string, listLines: number, minted: MintedLine[], zt: Record<string, number> = {}, error?: string): DocRecord => ({ key: `${corpus}|${doc}`, corpus, doc, list_lines: listLines, zero_tolerance_list_lines: zt, advisory: null, minted, ...(error ? { error } : {}) });

describe('G1 scoring', () => {
  const big = docRec('vault', 'v', 600_000, [mint('v', 1, '- [a] x', { corpus: 'vault' }), mint('v', 2, '- [b] y', { corpus: 'vault' }), mint('v', 3, '- [c] z', { corpus: 'vault' })]);
  const stress = docRec('stress', 's', 3000, [mint('s', 1, '- [preference] tea')], { template_slot: 2500 });
  const byId = (m: Record<string, 'correct' | 'wrong' | 'unlabeled'>) => (id: string) => m[id] ?? 'correct';
  test('passes with 3 wrong in 603,000 lines and a clean stress stratum', () => {
    const wrong = Object.fromEntries(big.minted.map(m => [mintId(m), 'wrong' as const]));
    const r = scoreG1([big, stress], byId(wrong));
    expect(Object.fromEntries(r.gates.map(g => [g.gate, g.outcome]))).toEqual({ 'G1.material_floor': 'pass', 'G1.zero_tolerance': 'pass', 'G1.stress_wrong': 'pass', 'G1.wrong_per_100k': 'pass' });
    expect(r.summary.wrong).toBe(3);
  });
  test('one wrong stress mint fails the exact bar; a zero-tolerance mint fails; unlabeled lines leave label gates not run', () => {
    const r = scoreG1([big, stress], byId({ [mintId(stress.minted[0])]: 'wrong' }));
    expect(r.gates.find(g => g.gate === 'G1.stress_wrong')).toMatchObject({ outcome: 'fail', failed_threshold: 'stress wrong mints = 0' });
    const zt = docRec('stress', 'z', 2000, [mint('z', 1, '- [Time] - [Event]', { zero_tolerance: 'template_slot' })], { template_slot: 2000 });
    expect(scoreG1([big, zt], byId({})).gates.find(g => g.gate === 'G1.zero_tolerance')!.outcome).toBe('fail');
    const r2 = scoreG1([big, stress], byId({ [mintId(stress.minted[0])]: 'unlabeled' }));
    expect(r2.gates.find(g => g.gate === 'G1.wrong_per_100k')).toMatchObject({ outcome: 'not_run', denominators: { planned: 4, attempted: 4, scored: 3, errors: 1 } });
  });
  test('below the floors is insufficient; a page error blocks the gates', () => {
    expect(scoreG1([stress], byId({})).gates[0]).toMatchObject({ outcome: 'insufficient' });
    const err = docRec('vault', 'e', 0, [], {}, 'write failed');
    const r = scoreG1([big, stress, err], byId({}));
    expect(r.gates.find(g => g.gate === 'G1.wrong_per_100k')!.outcome).toBe('blocked');
    expect(r.gates[0].denominators).toEqual({ planned: 3, attempted: 3, scored: 2, errors: 1 });
  });
});

describe('G4 guard loss', () => {
  test('share of judge-correct baseline mints the candidate keeps (same line, same parse)', () => {
    const keep = Array.from({ length: 99 }, (_, i) => mint('p', i + 1, `- [fact] claim ${i}`));
    const lost = mint('p', 200, '- [fact] lost one');
    const junk = mint('p', 300, '- [Time] - [Event]');
    const base = [docRec('k', 'p', 400, [...keep, lost, junk])];
    const cand = [docRec('k', 'p', 400, keep)];
    const outcome = (id: string) => (id === mintId(junk) ? 'wrong' as const : 'correct' as const);
    const r = scoreG4([{ set: 'K', baseline: base, candidate: cand }], outcome);
    expect(r.summary).toMatchObject({ baseline_correct: 100, kept: 99, lost: 1 });
    expect(r.gate.outcome).toBe('pass');
    const reparsed = [docRec('k', 'p', 400, keep.map((m, i) => (i === 0 ? { ...m, parsed: 'fact category y' } : m)))];
    expect(scoreG4([{ set: 'K', baseline: base, candidate: reparsed }], outcome).gate).toMatchObject({ outcome: 'fail' });
  });
});

describe('K conformance', () => {
  const pages = devKPages();
  test('the dev K set parses and every class is present', () => {
    expect(parseKPages(pages.map(p => JSON.stringify(p)).join('\n'))).toHaveLength(4);
    expect(() => parseKPages(JSON.stringify({ ...pages[0], lines: [{ line: 999, class: 'relation', kind: 'relation', expected: {} }] }))).toThrow('ask the custodian');
  });
  test('near-miss shapes are valid or decoys by what the frozen build accepts', () => {
    const accepted = probeNearMiss(t => ({ relations: /- works_at: \[\[/.test(t) ? [{ type: 'works_at' }] : [] }));
    expect(accepted).toEqual({ colon_type: true, bold_type: false, backtick_type: false });
    const relLines = pages.flatMap(p => p.lines.filter(l => l.class === 'relation' || l.class === 'colon_type').map(l => ({ page: p, l })));
    const mints = relLines.map(({ page, l }) => ({ doc: page.id, text: page.content.split('\n')[(l.line as number) - 1], kind: 'relation' as const, parsed: `relation type ${l.expected.type}` }));
    const k = scoreK(pages, mints, accepted);
    expect(k.relation).toMatchObject({ valid: 16, recalled: 16 });
    expect(k.decoys.colon_type).toBeUndefined();
    expect(k.decoys.bold_type).toEqual({ candidates: 4, minted: 0 });
    const withDecoy = scoreK(pages, [...mints, { doc: pages[0].id, text: '- [Time] - [Event]', kind: 'fact', parsed: 'fact category Time' }], accepted);
    expect(withDecoy.decoys.template_slot.minted).toBe(1);
    const gates = g3Gates({ ...withDecoy, below_minimum: [] });
    expect(gates.find(g => g.gate === 'G3.decoys')).toMatchObject({ outcome: 'fail' });
    expect(g3Gates(k)[0].outcome).toBe('insufficient');
  });
  test('candidates match minted lines by text, in order of occurrence', () => {
    const p = { id: 'x', slug: 'x', content: 'a\n- works_at [[c]]\n- works_at [[c]]\n', lines: [{ line: 2, class: 'relation' as const, kind: 'relation' as const, expected: { type: 'works_at' } }, { line: 3, class: 'relation' as const, kind: 'relation' as const, expected: { type: 'works_at' } }] };
    const m = matchCandidates(p, [{ doc: 'x', text: '- works_at [[c]]', kind: 'relation', parsed: 'relation type works_at' }]);
    expect(m.map(x => !!x.mint)).toEqual([true, false]);
  });
});

describe('G2 sample and precision', () => {
  const gl = (model: string, i: number, kind: 'relation' | 'fact' = 'relation'): GrammarLine => ({ id: `${model}-${kind}-${i}`, corpus: 'career', model, arm: 'B', ingest: i % 3, slug: 's', line: i, text: 't', context: '', kind, parsed: 'relation type works_at' });
  test('stratified by model with a frozen seed; a small model gives its share to the others', () => {
    const lines = [...Array.from({ length: 200 }, (_, i) => gl('a', i)), ...Array.from({ length: 20 }, (_, i) => gl('b', i)), ...Array.from({ length: 200 }, (_, i) => gl('c', i))];
    const s = stratifiedByModel(lines, 300, 7);
    expect(s.allocation).toEqual({ a: { lines: 200, drawn: 140 }, b: { lines: 20, drawn: 20 }, c: { lines: 200, drawn: 140 } });
    expect(stratifiedByModel(lines, 300, 7).sample.map(x => x.id)).toEqual(s.sample.map(x => x.id));
    expect(stratifiedByModel(lines.slice(0, 50), 300, 7).sample).toHaveLength(50);
  });
  test('only arm B lines enter; fewer than 150 is insufficient; 293/300 passes and 292/300 fails', () => {
    const lines = [...Array.from({ length: 150 }, (_, i) => gl('a', i)), ...Array.from({ length: 150 }, (_, i) => gl('b', i)), { ...gl('a', 999), arm: 'A' }];
    const sample = drawG2(lines, 11);
    expect(sample.relation.lines).toHaveLength(300);
    const bad = new Set(sample.relation.lines.slice(0, 7).map(l => l.id));
    expect(scoreG2(sample, id => (bad.has(id) ? 'wrong' : 'correct')).gate.outcome).toBe('pass');
    bad.add(sample.relation.lines[7].id);
    expect(scoreG2(sample, id => (bad.has(id) ? 'wrong' : 'correct')).gate).toMatchObject({ outcome: 'fail' });
    const small = drawG2(lines.slice(0, 100), 11);
    expect(scoreG2(small, () => 'correct').gate).toMatchObject({ outcome: 'insufficient', failed_threshold: 'sample n = 100 < 150' });
  });
});

describe('N custody loader', () => {
  test('validates the manifest shape', () => {
    expect(validateNManifest({ id: 'n', strata: [{ id: 'beam', license: 'x', source: 'y' }] })[0]).toContain('conversation_ids');
    expect(validateNManifest({ id: 'n', strata: [{ id: 'vault', license: 'x', source: 'y', files: [{ path: '../escape.md', sha256: 'a'.repeat(64) }] }] })[0]).toContain('stay inside');
  });
  test('hash-checks and logs every file, and drops the amendment 1 BEAM conversations with a record', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'vault'));
    const text = '# Note\n\n- [preference] tea\n';
    writeFileSync(join(dir, 'vault', 'a.md'), text);
    const sha = createHash('sha256').update(text).digest('hex');
    const sealed = JSON.parse(readFileSync(join(import.meta.dir, '../../eval/decisions/splits/beam-1m.json'), 'utf8')).sealed as string[];
    const keep = sealed.find(id => !BEAM_AMENDMENT_1_EXCLUDED.includes(id))!;
    writeFileSync(join(dir, 'n-manifest.json'), JSON.stringify({ id: 'n-test', strata: [
      { id: 'vault', license: 'CC0-1.0', source: 'test', files: [{ path: 'vault/a.md', sha256: sha }] },
      { id: 'beam', license: 'x', source: 'BEAM', conversation_ids: [keep, '1m-6', '1m-26'] },
    ] }));
    const requested: string[][] = [];
    const n = loadNSet(dir, { decisionId: 'q2', purpose: 'test' }, { loadBeam: ids => { requested.push([...ids]); return [{ id: keep, sessions: [{ id: 's1', turns: [{ speaker: 'user', content: 'hi' }] }] }]; } });
    expect(requested).toEqual([[keep]]);
    expect(n.beam_excluded).toMatchObject({ listed_and_dropped: ['1m-6', '1m-26'], conversations_kept: 1 });
    expect(n.docs.map(d => d.corpus)).toEqual(['vault', 'beam']);
    expect(readFileSync(join(dir, 'vault', 'access-log.jsonl'), 'utf8')).toContain(sha);
    writeFileSync(join(dir, 'vault', 'a.md'), text + 'changed');
    expect(() => loadNSet(dir, { decisionId: 'q2', purpose: 'test' }, { loadBeam: () => [] })).toThrow('not the manifest');
    expect(existsSync(join(dir, 'access-log.jsonl'))).toBe(true);
  });
  test('refuses beam ids that are not BEAM-1M sealed conversations', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'n-manifest.json'), JSON.stringify({ id: 'n', strata: [{ id: 'beam', license: 'x', source: 'y', conversation_ids: ['not-a-sealed-id'] }] }));
    expect(() => loadNSet(dir, { decisionId: 'q2', purpose: 't' }, { loadBeam: () => [] })).toThrow('not BEAM-1M sealed');
  });
});
