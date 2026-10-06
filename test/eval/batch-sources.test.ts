/**
 * W10 request sources and statistics wiring (eng test plan F1-F6, B9, S1, S2,
 * S4). Uses only committed receipts and a synthetic dataset; no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import '../../eval/runner/budget-ledger.ts';
import { runEvalLongMemEval } from '../../node_modules/gbrain/src/commands/eval-longmemeval.ts';
import { buildReaderRequest, resolveReaderConfig } from '../../node_modules/gbrain/src/eval/longmemeval/reader.ts';
import {
  assertFitsWindow, captureClient, fullHistoryText, loadReplay, officialPromptFromReplay, officialReaderPrompt, parseSessionBlocks, readerBody, readNdjson,
  removeSessionBlock, replaySessionIds, reportType, seededSample, stratifiedSample, swapSessions, type CapturedRequest, type Question,
} from '../../eval/runner/batch/sources.ts';
import { crossArmRows, pairByIds, superiorityFamily } from '../../eval/runner/batch/receipts.ts';
import { evaluateFamily, validateFamily } from '../../eval/runner/stats/gates.ts';
import { runCompare } from '../../eval/runner/compare.ts';

const ROOT = resolve(import.meta.dir, '../..');
const R = join(ROOT, 'docs/benchmarks/2026-09-29-longmemeval-opaque-qa');
const r1 = loadReplay(join(R, 'reranker-on/r1'));
const r2 = loadReplay(join(R, 'reranker-on/r2'));

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'batch-src-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('R1/R2 replay', () => {
  test('F2: all 500 reader calls of r1 and r2 join to distinct question ids', () => {
    for (const replay of [r1, r2]) {
      expect(replay.size).toBe(500);
      for (const row of replay.values()) expect(row.user.startsWith(`Question:\n${row.question}\n\n`)).toBe(true);
    }
    expect([...r1.keys()].sort()).toEqual([...r2.keys()].sort());
  });

  test('B9: the batch body carries the replayed system and user text byte for byte; only model, limit and effort change', () => {
    const calls = readNdjson(join(R, 'reranker-on/r1/calls.ndjson.gz')).filter(c => c.lane === 'reader');
    const row = r1.get('a06e4cfe')!;
    const call = calls.find(c => c.question === row.question)!;
    const body = readerBody('claude-sonnet-5-5', row) as any;
    expect(body.system).toBe(call.system);
    expect(body.messages).toEqual([{ role: 'user', content: call.user }]);
    expect(body).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 4096, system: call.system, messages: [{ role: 'user', content: call.user }], output_config: { effort: 'low' } });
    const gbrainShape = buildReaderRequest({ question: row.question, questionDate: row.question_date, rendered: call.user.slice(call.user.indexOf('Retrieved sessions:\n') + 20) }, 'claude-sonnet-5-5', resolveReaderConfig({ mode: 'notes', maxTokens: 4096 }));
    expect({ model: body.model, max_tokens: body.max_tokens, system: body.system, messages: body.messages }).toEqual(gbrainShape);
    const oai = readerBody('gpt-6.1-sol', row) as any;
    expect(oai.messages).toEqual([{ role: 'system', content: call.system }, { role: 'user', content: call.user }]);
    expect([oai.reasoning_effort, oai.max_completion_tokens]).toEqual(['medium', 12000]);
  });

  test('F3: no replayed reader text carries an answer_ session id', () => {
    for (const replay of [r1, r2]) for (const row of replay.values()) expect(`${row.system}${row.user}`.includes('answer_')).toBe(false);
  });

  test('F4: sessions parsed from R1 user text map to exactly the retrieved session ids of each row', () => {
    for (const row of r1.values()) expect(replaySessionIds(row)).toEqual(row.retrieved_session_ids);
  });

  test('F4: the official prompt builder reproduces arm b\'s committed prompts byte for byte', () => {
    const rows = readNdjson(join(R, 'b/rows.ndjson.gz')).slice(0, 40);
    for (const b of rows) {
      const prompt: string = b.reader_prompt;
      const sessions = [...prompt.matchAll(/\n### Session \d+:\nSession Date: ([^\n]*)\nSession Content:\n\n(.*)\n/g)];
      expect(sessions.length).toBe(b.reader_context_sessions);
      const head = /\n\nCurrent Date: ([^\n]*)\nQuestion: ([\s\S]*)\nAnswer \(step by step\):$/.exec(prompt)!;
      const q = {
        question_id: b.question_id, question: head[2], question_date: head[1],
        haystack_session_ids: sessions.map((_, i) => `s${i}`), haystack_dates: sessions.map(s => s[1]), haystack_sessions: sessions.map(s => JSON.parse(s[2])),
      };
      expect(officialReaderPrompt(q, [...q.haystack_session_ids]).prompt).toBe(prompt);
    }
  });

  test('official prompt from a replay row uses the sessions the house reader saw', () => {
    const row = r1.get('a06e4cfe')!;
    const ids = replaySessionIds(row);
    const q = {
      question_id: row.question_id, question: row.question, question_date: row.question_date, haystack_session_ids: ids,
      haystack_dates: ids.map((_, i) => `2023/05/0${i + 1} (Mon) 10:00`), haystack_sessions: ids.map(id => [{ role: 'user', content: `session ${id}` }]),
    };
    const out = officialPromptFromReplay(row, q);
    expect(out.sessions).toBe(ids.length);
    expect(out.session_ids).toEqual(row.retrieved_session_ids);
  });

  test('session surgery for the W8 controls: remove one block, swap the retrieved section', () => {
    const row = r1.get('a06e4cfe')!;
    const blocks = parseSessionBlocks(row.user);
    expect(blocks.length).toBe(5);
    for (const b of blocks) {
      const cut = removeSessionBlock(row.user, b.id);
      expect(parseSessionBlocks(cut).map(x => x.id)).toEqual(blocks.filter(x => x.id !== b.id).map(x => x.id));
      expect(cut.includes('\n\n\n\n')).toBe(false);
    }
    const donor = [...r1.values()][7];
    const swapped = swapSessions(row.user, donor.user);
    expect(swapped.startsWith(`Question:\n${row.question}\n\n`)).toBe(true);
    expect(parseSessionBlocks(swapped).map(b => b.id)).toEqual(parseSessionBlocks(donor.user).map(b => b.id));
  });
});

const longTurn = 'The user talks about pottery. '.repeat(200) + 'I started pottery class on Tuesday at the Clayworks studio.';
const fixture: Question[] = [{
  question_id: 'qa1', question_type: 'single-session-user', question: 'Where did I start pottery class?', question_date: '2023/05/30 (Tue) 23:48', answer: 'Clayworks',
  answer_session_ids: ['answer_x1'], haystack_session_ids: ['answer_x1', 'sharegpt_a', 'ultrachat_b'],
  haystack_dates: ['2023/05/01 (Mon) 10:00', '2023/05/02 (Tue) 10:00', '2023/05/03 (Wed) 10:00'],
  haystack_sessions: [
    [{ role: 'user', content: longTurn }, { role: 'assistant', content: 'Nice, enjoy Clayworks!' }],
    [{ role: 'user', content: 'Tell me about cooking pasta with pottery bowls.' }, { role: 'assistant', content: 'Boil water.' }],
    [{ role: 'user', content: 'What is the weather like?' }, { role: 'assistant', content: 'Sunny.' }],
  ],
}];

describe('W10a capture and W10c full history', () => {
  test('F1: the capture records the harness\'s own reader request; the batch body equals it apart from model, limit and effort; full sessions, not chunk text', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'ds.json'), JSON.stringify(fixture));
    const caps: CapturedRequest[] = [];
    await runEvalLongMemEval([join(dir, 'ds.json'), '--keyword-only', '--top-k', '5', '--no-trajectory', '--no-embed-cache', '--model', 'anthropic:claude-sonnet-5-5', '--output', join(dir, 'rows.ndjson'), '--yes'],
      { client: captureClient(c => caps.push(c)) as any, exitOnError: false });
    expect(caps.length).toBe(1);
    const c = caps[0];
    expect(c.params).toEqual({ model: c.model, max_tokens: 1024, system: c.system, messages: [{ role: 'user', content: c.user }] });
    expect(c.user.includes(longTurn)).toBe(true);
    expect(c.user.includes('answer_')).toBe(false);
    const body = readerBody('claude-sonnet-5-5', c) as any;
    expect([body.system, body.messages[0].content]).toEqual([c.system, c.user]);
    const rows = readNdjson(join(dir, 'rows.ndjson')).filter(r => r.question_id === 'qa1');
    expect(rows[0].hypothesis).toContain('placeholder');
    // W10c renders every haystack session the way the harness rendered the retrieved ones.
    const full = fullHistoryText(fixture[0]);
    expect(full.system).toBe(c.system);
    const fullBlocks = new Map(parseSessionBlocks(full.user).map(b => [b.id, full.user.slice(b.start, b.end)]));
    expect(fullBlocks.size).toBe(3);
    for (const b of parseSessionBlocks(c.user)) expect(c.user.slice(b.start, b.end)).toBe(fullBlocks.get(b.id)!);
    expect(full.user.includes('answer_')).toBe(false);
  });

  test('F5: the stratified subset is reproducible from its seed with the preregistered allocation; prompts over the window refuse', () => {
    const types = new Map([...r1.values()].map(r => [r.question_id, reportType(r)]));
    const a = stratifiedSample(types, 150, 20261006);
    const b = stratifiedSample(types, 150, 20261006);
    expect(a).toEqual(b);
    expect(a.ids.length).toBe(150);
    expect(a.allocation).toEqual({ abstention: 9, 'knowledge-update': 22, 'multi-session': 36, 'single-session-assistant': 17, 'single-session-preference': 9, 'single-session-user': 19, 'temporal-reasoning': 38 });
    expect(stratifiedSample(types, 150, 7).ids).not.toEqual(a.ids);
    expect(seededSample([...types.keys()], 100, 1)).toEqual(seededSample([...types.keys()].reverse(), 100, 1));
    expect(() => assertFitsWindow('claude-sonnet-5-5', 'q', 197_000, 4096)).toThrow(/exceed/);
    expect(() => assertFitsWindow('gpt-6.1-sol', 'q', 120_000, 12_000)).not.toThrow();
  });
});

describe('statistics wiring', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `q${String(i).padStart(2, '0')}`);
  const comparator = new Map(ids.map((id, i) => [id, (i % 5 === 0 ? 0 : 1) as 0 | 1]));
  const better = new Map(ids.map(id => [id, 1 as 0 | 1]));
  const same = new Map(comparator);

  test('F6: pairing refuses mismatched id sets', () => {
    const a = ids.map(question_id => ({ question_id }));
    expect(pairByIds(a, [...a].reverse()).length).toBe(60);
    expect(() => pairByIds(a, a.slice(1))).toThrow(/mismatched/);
    expect(() => pairByIds(a, a, ids.slice(0, 50))).toThrow(/preregistered/);
  });

  test('S1 + S4: one family evaluation holds every arm, Holm covers all of them, and each prints a power note', () => {
    const dir = tmp();
    const rows = crossArmRows(comparator, [{ field: 'correct__better', rows: better }, { field: 'correct__same', rows: same }], ids);
    const family = superiorityFamily('w10b-test', '2026-10-06', ['correct__better', 'correct__same'], 'test');
    writeFileSync(join(dir, 'a.ndjson'), rows.a.map(r => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'b.ndjson'), rows.b.map(r => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'family.json'), JSON.stringify(family));
    const out = runCompare({ a: join(dir, 'a.ndjson'), b: join(dir, 'b.ndjson'), family: join(dir, 'family.json'), metrics: [], excludeWhen: [], where: [], aWhere: [], bWhere: [], seed: 42, draws: 10000, alpha: 0.05, json: true });
    expect(out.decision.holm_family).toEqual(['correct__better-vs-comparator', 'correct__same-vs-comparator']);
    const byId = new Map(out.decision.comparisons.map(c => [c.id, c]));
    expect(byId.get('correct__better-vs-comparator')!.mcnemar).toMatchObject({ wins: 12, losses: 0 });
    for (const c of out.decision.comparisons) expect(c.power?.note.length).toBeGreaterThan(20);
    expect(byId.get('correct__better-vs-comparator')!.power!.note).toMatch(/60 pairs/);
  });

  test('S2: a non-inferiority family never passes on a non-significant result', () => {
    const slightlyWorse = new Map(ids.map((id, i) => [id, (i % 5 === 0 || i === 1 ? 0 : 1) as 0 | 1]));
    const family = validateFamily({ schema_version: 1, family_id: 'w10c-test', registered_at: '2026-10-06', alpha: 0.05, seed: 1, draws: 2000, id_field: 'question_id',
      comparisons: [{ id: 'ni', metric: 'correct', gate: 'noninferiority', direction: 'higher', tolerance: 0.07, cluster_by: 'question_id' }] });
    const a = ids.map(id => ({ question_id: id, correct: comparator.get(id) }));
    const b = ids.slice(0, 20).map(id => ({ question_id: id, correct: slightlyWorse.get(id) }));
    const d = evaluateFamily(a.slice(0, 20), b, family);
    expect(d.comparisons[0].status).not.toBe('pass');
  });
});
