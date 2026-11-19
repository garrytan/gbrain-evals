import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_TYPE_PROMPT_SHA256, answerTypePrompt, checkReport, cohenKappa, itemsCellId, labelRows, materialize, parseAnswerType, readItems, rubricCells, safeName, typeJudgeFor, type Item, type Label } from '../../eval/runner/beam-no-evidence.ts';
import type { ChatLike } from '../../eval/runner/memory-qa/qa-v2.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'beam-no-evidence-'));

describe('answer-type label', () => {
  test('the prompt shows the question and answer and never the gold', () => {
    const p = answerTypePrompt('What is my cat called?', 'Probably Tom.');
    expect(p).toContain('What is my cat called?');
    expect(p).toContain('Probably Tom.');
    expect(p).not.toContain('{question}');
    expect(ANSWER_TYPE_PROMPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('parses the last LABEL line and nothing else', () => {
    expect(parseAnswerType('thinking...\nLABEL: hedged')).toBe('hedged');
    expect(parseAnswerType('LABEL: committed\nLABEL: declined')).toBe('declined');
    expect(parseAnswerType('**LABEL: Committed**')).toBe('committed');
    expect(parseAnswerType('I would say declined.')).toBeNull();
    expect(parseAnswerType('LABEL: unsure')).toBeNull();
  });

  test('no family labels its own rows and particle-1 never judges', () => {
    expect(typeJudgeFor('anthropic:claude-opus-5-5')).toBe('openai:gpt-6-astra');
    expect(typeJudgeFor('particle:particle-1')).toBe('openai:gpt-6-astra');
    expect(typeJudgeFor('openai:gpt-6.2-sol')).toBe('anthropic:claude-opus-5-5');
    expect(() => typeJudgeFor('gemini:gemini-3.8-flash')).toThrow();
  });

  test('labelRows routes each row to its cross-family judge, records the label, and resumes', async () => {
    const calls: string[] = [];
    const chat: ChatLike = { chat: async (model) => { calls.push(model); return { text: 'LABEL: committed', input_tokens: 10, output_tokens: 2, cached: false, finish: 'stop', usage: null } as never; } };
    const out = join(tmp(), 'labels.ndjson');
    const rows = [
      { cell: 'b-opus', qid: '10_abstention_0', reader: 'anthropic:claude-opus-5-5', question: 'q', answer: 'a' },
      { cell: 'b-sol', qid: '10_abstention_0', reader: 'openai:gpt-6.2-sol', question: 'q', answer: 'a' },
    ];
    const first = await labelRows(rows, chat, out);
    expect(calls).toEqual(['openai:gpt-6-astra', 'anthropic:claude-opus-5-5']);
    expect(first.map(l => l.label)).toEqual(['committed', 'committed']);
    expect(await labelRows(rows, chat, out)).toEqual([]);
    expect(calls.length).toBe(2);
    await expect(labelRows([rows[0]], chat, join(tmp(), 'x.ndjson'), ['particle:particle-1'])).rejects.toThrow('never judges');
  });
});

test('label refuses to run without --paid and an open budget run', () => {
  const dir = tmp();
  const p = Bun.spawnSync(['bun', 'eval/runner/beam-no-evidence.ts', 'label', '--cells', dir, '--out', join(dir, 'l.ndjson'), '--budget-ledger', join(dir, 'ledger.sqlite')], {
    env: { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '' }, stderr: 'pipe', stdout: 'pipe' });
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toMatch(/--paid|budget/);
});

describe('judge check', () => {
  test('kappa: perfect agreement is 1, chance-level is 0', () => {
    expect(cohenKappa(['a', 'b', 'a', 'b'], ['a', 'b', 'a', 'b'])).toBe(1);
    expect(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b'])).toBe(0);
  });

  const SOURCE = 'b';

  function fixture(rubricWrong: number, typeWrong: number, opts: { rubricJudge?: string; sharedQuestions?: boolean } = {}) {
    const dir = tmp();
    const items: Item[] = [];
    for (let i = 0; i < 48; i++) items.push({ id: 'r' + String(i).padStart(2, '0'), qid: '500k-10:x:' + (opts.sharedQuestions ? i % 22 : i), instrument: 'rubric', text: 'r answer ' + i, label: i < 24 ? 'good' : 'bad' });
    for (let i = 0; i < 48; i++) items.push({ id: 't' + String(i).padStart(2, '0'), qid: '500k-10:y:' + (i % 20), instrument: 'type', text: 't answer ' + i, label: ['declined', 'hedged', 'committed'][i % 3] });
    writeFileSync(join(dir, 'items.json'), JSON.stringify(items));
    const cell = join(dir, SOURCE);
    mkdirSync(cell);
    writeFileSync(join(cell, 'cell.json'), JSON.stringify({ cell_id: SOURCE, spec: { models: { answer: 'anthropic:claude-opus-5-5' } }, resolved: { schedule: [] } }));
    const out = join(dir, 'out');
    const m = materialize(cell, readItems(join(dir, 'items.json')), out);
    const rejudged = join(dir, 'rejudged');
    const at = rubricCells(items);
    items.filter(i => i.instrument === 'rubric').forEach((i, k) => {
      const d = join(rejudged, itemsCellId(SOURCE, at.get(i.id)!), 'stages', 'judge');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, safeName(i.qid) + '.json'), JSON.stringify({ outcome: 'answered', judge_model: opts.rubricJudge ?? 'gemini:gemini-3.5-flash', correct: (i.label === 'good') !== (k < rubricWrong) }));
    });
    const labels: Label[] = [];
    for (const judge of ['openai:gpt-6-astra', 'anthropic:claude-opus-5-5'])
      items.filter(i => i.instrument === 'type').forEach((i, k) => labels.push({ cell: 'judge-check:' + i.id, qid: i.qid, reader: 'construction', question: 'q', answer: i.text, judge,
        prompt_id: '', prompt_sha256: '', label: (k < typeWrong ? 'hedged' : i.label) as never, raw: '', finish: null, input_tokens: 0, output_tokens: 0 }));
    return { items, m, rejudged, labels };
  }

  test('materialize writes at least two cells on one schedule and a rows file for the type items', () => {
    const { m } = fixture(0, 0);
    expect(m.cells.length).toBe(2);
    const cells = m.cells.map(c => JSON.parse(readFileSync(join(c, 'cell.json'), 'utf8')));
    expect(cells[0].resolved.schedule.length).toBe(48);
    expect(cells[1].resolved.schedule).toEqual(cells[0].resolved.schedule);
    expect(cells.map(c => c.judge_check.items.length).reduce((a, b) => a + b)).toBe(48);
    expect(cells.every(c => c.judge_check.items.length > 0)).toBe(true);
    expect(JSON.parse(readFileSync(m.rows, 'utf8')).length).toBe(48);
  });

  test('rubric items on one question land in different cells, each answer file under its harness name', () => {
    const { items, m } = fixture(0, 0, { sharedQuestions: true });
    const at = rubricCells(items);
    const rubric = items.filter(i => i.instrument === 'rubric');
    for (const qid of new Set(rubric.map(i => i.qid))) {
      const cells = rubric.filter(i => i.qid === qid).map(i => at.get(i.id));
      expect(new Set(cells).size).toBe(cells.length);
    }
    expect(m.cells.length).toBe(3);
    for (const i of rubric) {
      const a = JSON.parse(readFileSync(join(m.cells[at.get(i.id)!], 'stages', 'answer', safeName(i.qid) + '.json'), 'utf8'));
      expect(a.answer).toBe(i.text);
    }
    expect(safeName('500k-10:x:1')).toMatch(/^500k-10_x_1-[0-9a-f]{12}$/);
  });

  test('passes when both instruments agree with the construction labels, and reports hashes, never texts', () => {
    const { items, rejudged, labels } = fixture(2, 2);
    const r = checkReport(items, SOURCE, rejudged, labels);
    expect(r.pass).toBe(true);
    expect(JSON.stringify(r)).not.toContain('answer 1');
    const shared = fixture(2, 2, { sharedQuestions: true });
    expect(checkReport(shared.items, SOURCE, shared.rejudged, shared.labels).pass).toBe(true);
  });

  test('fails closed on a weak judge, on a missing type judge and on unparseable outputs', () => {
    const weak = fixture(20, 0);
    expect(checkReport(weak.items, SOURCE, weak.rejudged, weak.labels).pass).toBe(false);
    const one = fixture(0, 0);
    expect(checkReport(one.items, SOURCE, one.rejudged, one.labels.filter(l => l.judge === 'openai:gpt-6-astra')).pass).toBe(false);
    const bad = fixture(0, 0);
    bad.labels[0].label = null;
    expect(checkReport(bad.items, SOURCE, bad.rejudged, bad.labels).pass).toBe(false);
  });

  test('fails closed when a judge is not the preregistered one', () => {
    const rubric = fixture(0, 0, { rubricJudge: 'gemini:gemini-3.8-flash' });
    const r = checkReport(rubric.items, SOURCE, rubric.rejudged, rubric.labels);
    expect(r.pass).toBe(false);
    expect(r.gates.find(g => g.gate.startsWith('rubric judge is'))!.pass).toBe(false);
    const type = fixture(0, 0);
    const swapped = type.labels.map(l => (l.judge === 'anthropic:claude-opus-5-5' ? { ...l, judge: 'openai:gpt-6.2-sol' } : l));
    expect(checkReport(type.items, SOURCE, type.rejudged, swapped).pass).toBe(false);
  });
});

test('labelRows refuses a judge that is not the reader row\'s cross-family judge', async () => {
  const chat: ChatLike = { chat: async () => { throw new Error('no call expected'); } };
  const row = { cell: 'b-opus', qid: 'q', reader: 'anthropic:claude-opus-5-5', question: 'q', answer: 'a' };
  await expect(labelRows([row], chat, join(tmp(), 'x.ndjson'), ['anthropic:claude-opus-5-5'])).rejects.toThrow('not the preregistered');
  expect(typeJudgeFor('openai:particle-1')).toBe('openai:gpt-6-astra');
});

test('label refuses --judges without --rows', () => {
  const dir = tmp();
  const p = Bun.spawnSync(['bun', 'eval/runner/beam-no-evidence.ts', 'label', '--cells', dir, '--judges', 'openai:gpt-6-astra', '--out', join(dir, 'l.ndjson')], {
    env: { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', PARTICLE_API_KEY: '' }, stderr: 'pipe', stdout: 'pipe' });
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toContain('--judges only with --rows');
});
