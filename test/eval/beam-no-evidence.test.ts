import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANSWER_TYPE_PROMPT_SHA256, answerTypePrompt, checkReport, cohenKappa, labelRows, materialize, parseAnswerType, readItems, typeJudgeFor, type Item, type Label } from '../../eval/runner/beam-no-evidence.ts';
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

  function fixture(rubricWrong: number, typeWrong: number) {
    const dir = tmp();
    const items: Item[] = [];
    for (let i = 0; i < 48; i++) items.push({ id: 'r' + i, qid: '10_x_' + i, instrument: 'rubric', text: 'r answer ' + i, label: i < 24 ? 'good' : 'bad' });
    for (let i = 0; i < 48; i++) items.push({ id: 't' + i, qid: '10_y_' + i, instrument: 'type', text: 't answer ' + i, label: ['declined', 'hedged', 'committed'][i % 3] });
    writeFileSync(join(dir, 'items.json'), JSON.stringify(items));
    const cell = join(dir, 'b');
    mkdirSync(cell);
    writeFileSync(join(cell, 'cell.json'), JSON.stringify({ cell_id: 'b', spec: { models: { answer: 'anthropic:claude-opus-5-5' } }, resolved: { schedule: [] } }));
    const m = materialize(cell, readItems(join(dir, 'items.json')), join(dir, 'out'));
    const judge = join(dir, 'judge');
    mkdirSync(judge);
    items.filter(i => i.instrument === 'rubric').forEach((i, k) => writeFileSync(join(judge, i.qid + '.json'), JSON.stringify({ outcome: 'answered', judge_model: 'gemini:gemini-3.5-flash', correct: (i.label === 'good') !== (k < rubricWrong) })));
    const labels: Label[] = [];
    for (const judge of ['openai:gpt-6-astra', 'anthropic:claude-opus-5-5'])
      items.filter(i => i.instrument === 'type').forEach((i, k) => labels.push({ cell: 'judge-check', qid: i.qid, reader: 'construction', question: 'q', answer: i.text, judge,
        prompt_id: '', prompt_sha256: '', label: (k < typeWrong ? 'hedged' : i.label) as never, raw: '', finish: null, input_tokens: 0, output_tokens: 0 }));
    return { items, m, judge, labels };
  }

  test('materialize writes one answer per rubric item and a rows file for the type items', () => {
    const { m } = fixture(0, 0);
    const cell = JSON.parse(readFileSync(join(m.cell, 'cell.json'), 'utf8'));
    expect(cell.resolved.schedule.length).toBe(48);
    expect(JSON.parse(readFileSync(m.rows, 'utf8')).length).toBe(48);
  });

  test('passes when both instruments agree with the construction labels, and reports hashes, never texts', () => {
    const { items, judge, labels } = fixture(2, 2);
    const r = checkReport(items, judge, labels);
    expect(r.pass).toBe(true);
    expect(JSON.stringify(r)).not.toContain('answer 1');
  });

  test('fails closed on a weak judge, on a missing type judge and on unparseable outputs', () => {
    const weak = fixture(20, 0);
    expect(checkReport(weak.items, weak.judge, weak.labels).pass).toBe(false);
    const one = fixture(0, 0);
    expect(checkReport(one.items, one.judge, one.labels.filter(l => l.judge === 'openai:gpt-6-astra')).pass).toBe(false);
    const bad = fixture(0, 0);
    bad.labels[0].label = null;
    expect(checkReport(bad.items, bad.judge, bad.labels).pass).toBe(false);
  });

  test('rubric items must each have their own question', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'i.json'), JSON.stringify([{ id: 'a', qid: 'q', instrument: 'rubric', text: 'x', label: 'good' }, { id: 'b', qid: 'q', instrument: 'rubric', text: 'y', label: 'bad' }]));
    expect(() => readItems(join(dir, 'i.json'))).toThrow('share a question');
  });
});
