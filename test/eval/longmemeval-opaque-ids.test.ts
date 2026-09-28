/**
 * Opaque LongMemEval session ids (audit C-01, PD-05; PD-08 is covered in
 * longmemeval-m-pilot-replay.test.ts).
 *
 * Every gold session id in LongMemEval starts with `answer_` and no other
 * haystack id does. This fixture copies that shape and checks every input a
 * system under test or reader receives: the pages gbrain imports (slug,
 * frontmatter and the stored title), the answer model's evidence, and the
 * paired reading-notes requests. Scoring still sees the dataset ids.
 * Keyless and offline.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { importFromContent } from 'gbrain/import-file';
import type { ChatResult } from 'gbrain/ai/gateway';
import { parseOpts, run, sutPages, type NdjsonRow, type Question } from '../../eval/runner/longmemeval.ts';
import { loadLmeAnswerReplay, runLongMemEvalAnswers, type LmeAnswerInput, type LmeAnswerProfile } from '../../eval/runner/longmemeval-answers.ts';
import { prepareRequests } from '../../eval/runner/reading-notes-requests.ts';
import { runComparison } from '../../eval/runner/reading-notes-run.ts';

const turn = (content: string) => [{ role: 'user' as const, content }];
const dataset: Question[] = [
  { question_id: 'fixture_q1', question_type: 'single-session-user', question: 'Where did the flamingo expedition land?', answer: 'Port Kelp',
    haystack_session_ids: ['answer_4f1c9a20', 'sharegpt_Qz8mA1b_3', 'ultrachat_551902'], haystack_dates: ['2023/05/20 (Sat) 10:00', '2023/05/21 (Sun) 10:00', '2023/05/22 (Mon) 10:00'],
    haystack_sessions: [turn('The flamingo expedition landed at Port Kelp.'), turn('A grocery list with milk and eggs.'), turn('Notes about bicycle repair.')],
    answer_session_ids: ['answer_4f1c9a20'] },
  { question_id: 'fixture_q2_multi', question_type: 'multi-session', question: 'Which harbor hosted both badge ceremonies?', answer: 'Osprey Harbor',
    haystack_session_ids: ['sharegpt_Lk2pW9x_0', 'answer_9b7e33d1_1', 'answer_9b7e33d1_2'], haystack_dates: ['2023/06/01 (Thu) 09:00', '2023/06/02 (Fri) 09:00', '2023/06/03 (Sat) 09:00'],
    haystack_sessions: [turn('Unrelated weather notes.'), turn('The first badge ceremony was at Osprey Harbor.'), turn('The second badge ceremony was also at Osprey Harbor.')],
    answer_session_ids: ['answer_9b7e33d1_1', 'answer_9b7e33d1_2'] },
];
const isGold = (q: Question, sessionId: string) => q.answer_session_ids.map(id => id.toLowerCase()).includes(sessionId);

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lme-opaque-'));
  process.env.GBRAIN_HOME = join(root, 'gbrain-home');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('system under test inputs', () => {
  test('imported pages never carry the answer_ label, and stored titles have one shape for gold and non-gold', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      for (const q of dataset) {
        const { pages, originalByOpaque } = sutPages(q);
        expect(pages).toHaveLength(q.haystack_sessions.length);
        expect(JSON.stringify(pages)).not.toContain('answer_');
        const titles: Array<{ gold: boolean; title: string }> = [];
        for (const page of pages) {
          expect(page.slug).toMatch(/^chat\/s-[0-9a-f]{10}$/);
          await importFromContent(engine, page.slug, page.content, { noEmbed: true });
          const stored = await engine.getPage(page.slug);
          titles.push({ gold: isGold(q, originalByOpaque.get(page.slug.slice(5))!), title: stored!.title });
        }
        expect(titles.some(t => t.gold)).toBe(true);
        expect(titles.some(t => !t.gold)).toBe(true);
        for (const { title } of titles) expect(title.toLowerCase()).not.toContain('answer');
        expect(new Set(titles.map(t => t.title.replace(/[0-9a-f]/gi, 'x'))).size).toBe(1);
        expect([...originalByOpaque.values()].sort()).toEqual(q.haystack_session_ids!.map(id => id.toLowerCase()).sort());
      }
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('the runner scores against dataset ids and the answer model sees only opaque excerpts', async () => {
    const datasetPath = join(root, 'dataset.json');
    writeFileSync(datasetPath, JSON.stringify(dataset));
    const opts = { ...parseOpts([]), datasetPath, datasetName: 'opaque-fixture', adapters: ['keyword'], keywordOnly: true, topK: 2, noCache: true, minRecallAll: 0,
      output: join(root, 'report.json'), ndjsonPath: join(root, 'rows.ndjson'), reportsDir: join(root, 'reports'), retainEvidence: true };
    const result = await run(opts);
    const rows = readFileSync(opts.ndjsonPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as NdjsonRow);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.question_id === 'fixture_q1')!.retrieved[0]).toBe('answer_4f1c9a20');
    for (const row of rows) {
      expect(row.retrieved.every(id => dataset.find(q => q.question_id === row.question_id)!.haystack_session_ids!.map(s => s.toLowerCase()).includes(id))).toBe(true);
      expect(JSON.stringify(row.evidence!.returned_chunks.map(c => [c.slug, c.text]))).not.toContain('answer_');
    }
    expect(result.summaries[0].recall_any_at_k).toBeGreaterThan(0);

    const replay = loadLmeAnswerReplay({ datasetPath, rowsPath: opts.ndjsonPath, receiptPath: result.receiptFile, adapter: 'gbrain-keyword' });
    const profile: LmeAnswerProfile = { mode: 'offline', adapter: 'gbrain-keyword', ...replay.hashes, answer_model: 'test:answer',
      judge_model: 'claude-haiku-4-5-20251001', answer_max_tokens: 64, judge_max_tokens: 64 };
    delete (profile as Partial<typeof replay.hashes>).receipt_sha256;
    const inputs: LmeAnswerInput[] = [];
    const answer: ChatResult = { text: 'Scripted answer.', blocks: [{ type: 'text', text: 'Scripted answer.' }], model: 'test:answer', providerId: 'test', stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    const judgeClient = { messages: { create: async () => ({ id: 'judge', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'score', name: 'score_answer', input: { verdict: 'pass', overall_rationale: 'Scripted.',
        scores: ['grounding', 'answer_or_abstention'].map(criterion_id => ({ criterion_id, score: 5, rationale: 'Scripted.' })) } }],
      usage: { input_tokens: 1, output_tokens: 1 } }) } } as unknown as Anthropic;
    await runLongMemEvalAnswers({ datasetPath, rowsPath: opts.ndjsonPath, receiptPath: result.receiptFile, outputDir: join(root, 'answers'), profile,
      testRuntime: { async generate(input) { inputs.push(input); return answer; }, judgeClient } });
    expect(inputs.length).toBe(2);
    expect(inputs.flatMap(i => i.evidence).length).toBeGreaterThan(0);
    expect(JSON.stringify(inputs)).not.toContain('answer_');
    for (const evidence of inputs.flatMap(i => i.evidence)) expect(evidence.slug).toMatch(/^chat\/s-[0-9a-f]{10}$/);
  }, 120_000);
});

describe('reader inputs', () => {
  const model = 'anthropic:claude-sonnet-4-6';
  const frozen = dataset.map(q => ({ question_id: q.question_id, question: q.question, question_date: '2023/07/01 (Sat) 12:00',
    sources: q.haystack_session_ids!.map((id, i) => ({ session_id: id, slug: `chat/${id.toLowerCase()}`, date: q.haystack_dates![i], body: (q.haystack_sessions[i] as Array<{ content: string }>)[0].content })) }));

  test('paired reading-notes requests never show answer_ ids, and gold and non-gold ids share one shape', async () => {
    const prepared = await prepareRequests(frozen, model);
    expect(prepared.schema).toBe(2);
    expect(JSON.stringify(prepared.rows.map(r => r.request))).not.toContain('answer_');
    for (const row of prepared.rows) {
      const ids = [...row.request.messages[0].content.matchAll(/<chat_session id="([^"]+)"/g)].map(m => m[1]);
      const q = dataset.find(d => d.question_id === row.question_id)!;
      expect(ids).toHaveLength(q.haystack_sessions.length);
      for (const id of ids) expect(id).toMatch(/^s-[0-9a-f]{10}$/);
      expect(ids.map(id => row.session_map[id])).toEqual(q.haystack_session_ids!);
      expect(ids.filter(id => isGold(q, row.session_map[id].toLowerCase()))).toHaveLength(q.answer_session_ids.length);
    }
  });

  test('a schema 1 plan, which showed raw ids to the reader, cannot be executed', async () => {
    const plan = { ...(await prepareRequests(frozen, model)), schema: 1, identity: { input_sha256: '0'.repeat(64), installed_reader_sha256: '0'.repeat(64),
      installed_package_sha256: '0'.repeat(64), declared_reader_pin: 'none' } };
    await expect(runComparison(plan, { maxUsd: 1, approvalId: 'test', journalPath: join(root, 'never.ndjson'), inputBytes: Buffer.from('[]') },
      { call: async () => { throw new Error('provider must not be called'); } })).rejects.toThrow('invalid paired request plan');
  });
});
