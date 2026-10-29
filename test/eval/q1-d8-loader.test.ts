/**
 * beam-d8, the D8 long-history reserve: ten BEAM-generator conversations held in owner custody, all sealed. Its
 * loader, manifest, split, instrument and custody refusals, on synthetic fixtures written in the generator's layout
 * (tiny invented content) and, when the public BEAM 1m-16 dev files are cached, on that conversation converted to the
 * D8 layout. No D8 byte is used here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { devConversations, loadSplit } from '../../eval/runner/decisions/splits.ts';
import { DATASET_ROOT, D8_CONVERSATIONS, beamManifest, fetchDataset, fileSha256, filesFor, loadBeam, loadCorpus, loadD8, verifyD8Custody, type Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { INSTRUMENTS, instrumentFor, type JudgeCall } from '../../eval/runner/memory-qa/instruments.ts';
import { exportAggregates } from '../../eval/runner/memory-qa/sealed-profile.ts';
import { needsCustody, splitConversations } from '../../eval/runner/q1/cell.ts';
import { main as manifestMain } from '../../eval/runner/q1/d8-manifest.ts';

const ROOT = resolve(import.meta.dir, '../..');
const ENV = ['GBRAIN_EVALS_D8_SOURCE', 'GBRAIN_EVALS_D8_MANIFEST', 'GBRAIN_EVALS_CUSTODY_LOG', 'GBRAIN_EVALS_DECISION_ID'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'q1-d8-')); dirs.push(d); return d; };
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const writeJson = (path: string, v: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 2)); };

/** One invented conversation in BEAM's generator layout: two batches, three turn groups, five abilities. */
function writeConversation(root: string, n: number) {
  const dir = join(root, 'conversations', String(n));
  const msg = (id: number, role: string, content: string, extra: Record<string, unknown> = {}) => ({ role, id, index: '1,1', question_type: 'main_question', content, ...extra });
  writeJson(join(dir, 'chat.json'), [
    { batch_number: 1, time_anchor: 'March-01-2024', turns: [
      [msg(0, 'user', `c${n} my cat is called Pebble ->-> 1,1`, { time_anchor: 'March-01-2024' }), msg(1, 'assistant', 'Noted.')],
      [msg(2, 'user', 'I moved the garden party to Sunday.'), msg(3, 'assistant', 'Sunday it is. ->-> 1,2')],
    ] },
    { batch_number: 2, time_anchor: null, turns: [
      [msg(4, 'user', 'Pebble now likes the blue blanket.', { time_anchor: 'April-02-2024' }), msg(5, 'assistant', 'Good to know.')],
    ] },
  ]);
  writeFileSync(join(dir, 'plan.txt'), 'invented plan');
  writeJson(join(dir, 'topic.json'), { category: 'general', title: 'invented' });
  const pq = (ability: string, v: unknown) => writeJson(join(dir, 'probing_questions', ability, `${ability}.json`), v);
  pq('information_extraction', [
    [{ question: 'What is the cat called?', answer: 'Pebble', ideal_response: 'not this one', source_chat_ids: [0, 1] },
     { question: 'Which day is the party?', answer: 'Sunday', source_chat_ids: { first: [2], second: [3] } }],
    [{ question: 'Which blanket?', answer: 'blue', source_chat_ids: [4, 99], rubric: ['Says blue', 'Names the blanket'] }],
  ]);
  pq('abstention', [[{ question: 'What is the dog called?', ideal_response: 'There is no dog in the conversation.', source_chat_ids: [0], rubric: ['Says it is not mentioned'] }]]);
  pq('preference_following', [{ question: 'Suggest a gift.', expected_compliance: 'Mentions a blue blanket', compliance_indicators: ['blue'], source_chat_ids: [4] }]);
  pq('summarization', [{ question: 'Summarize.', ideal_summary: 'Cat, party, blanket.' }]);
  pq('event_ordering', [{ question: 'Order the events.', answer: 'party then blanket', source_chat_ids: [2, 4], rubric: ['party', 'blanket'] }]);
}

function fixture(conversations = [1, 2]): { root: string; log: string; manifest: string } {
  const root = tmp();
  for (const n of conversations) writeConversation(root, n);
  const manifest = join(root, 'stand-in-manifest.json');
  cpSync(join(ROOT, 'eval/decisions/datasets/d8-manifest.json'), manifest);
  process.env.GBRAIN_EVALS_D8_SOURCE = root;
  process.env.GBRAIN_EVALS_D8_MANIFEST = manifest;
  process.env.GBRAIN_EVALS_CUSTODY_LOG = join(root, 'custody', 'access-log.jsonl');
  return { root, log: process.env.GBRAIN_EVALS_CUSTODY_LOG, manifest };
}

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof DecideError ? e.op.code : `not a DecideError: ${(e as Error).message}`; } return 'no refusal'; };
const quiet = <T>(fn: () => T): T => { const w = process.stderr.write.bind(process.stderr); (process.stderr as { write: unknown }).write = () => true; try { return fn(); } finally { (process.stderr as { write: unknown }).write = w; } };
const custody = (log: string) => ({ log, decisionId: 'test', purpose: 'unit test' });

describe('beam-d8 loader', () => {
  test('builds sessions as loadBeam does: one per turn group, b<batch>-g<group>, group or batch date, markers stripped', () => {
    const f = fixture();
    const c = quiet(() => loadCorpus('beam-d8', undefined, new Set(['d8-1', 'd8-2'])));
    expect(c.benchmark).toBe('beam-d8');
    expect(c.conversations.map(x => x.id)).toEqual(['d8-1', 'd8-2']);
    const s = c.conversations[0].sessions;
    expect(s.map(x => x.id)).toEqual(['b1-g0', 'b1-g1', 'b2-g0']);
    expect(s.map(x => x.date)).toEqual(['March-01-2024', 'March-01-2024', 'April-02-2024']);
    expect(s[0].turns).toEqual([{ speaker: 'user', content: 'c1 my cat is called Pebble', message_ids: [0] }, { speaker: 'assistant', content: 'Noted.', message_ids: [1] }]);
    expect(s[1].turns[1].content).toBe('Sunday it is.');
    expect(f.root).toBeTruthy();
  });

  test('reads every ability file, flattens the generator list of lists, maps gold and keeps BEAM reference precedence and rubrics', () => {
    fixture();
    const c = quiet(() => loadCorpus('beam-d8', undefined, new Set(['d8-1', 'd8-2'])));
    const q = Object.fromEntries(c.questions.filter(x => x.conversation === 'd8-2').map(x => [x.id, x]));
    expect(Object.keys(q).sort()).toEqual(['d8-2:abstention:0', 'd8-2:event_ordering:0', 'd8-2:information_extraction:0', 'd8-2:information_extraction:1', 'd8-2:information_extraction:2', 'd8-2:preference_following:0', 'd8-2:summarization:0']);
    expect(c.questions).toHaveLength(14);
    expect(q['d8-2:information_extraction:0']).toMatchObject({ question: 'What is the cat called?', category: 'information_extraction', gold: ['b1-g0'], abstention: false, answer: 'Pebble' });
    expect(q['d8-2:information_extraction:0'].rubric).toBeUndefined();
    expect(q['d8-2:information_extraction:1'].gold).toEqual(['b1-g1']);
    expect(q['d8-2:information_extraction:2']).toMatchObject({ gold: ['b2-g0'], rubric: ['Says blue', 'Names the blanket'] });
    expect(q['d8-2:abstention:0']).toMatchObject({ gold: [], abstention: true, answer: 'There is no dog in the conversation.', rubric: ['Says it is not mentioned'] });
    expect(q['d8-2:preference_following:0']).toMatchObject({ answer: 'Mentions a blue blanket', gold: ['b2-g0'] });
    expect(q['d8-2:preference_following:0'].rubric).toBeUndefined();
    expect(q['d8-2:summarization:0']).toMatchObject({ answer: 'Cat, party, blanket.', gold: [] });
    expect(q['d8-2:event_ordering:0']).toMatchObject({ gold: ['b1-g1', 'b2-g0'], rubric: ['party', 'blanket'] });
  });

  test('logs each conversation before reading it and records every file hash while the manifest is unfilled', () => {
    const f = fixture();
    const c = quiet(() => loadD8(custody(f.log), { only: new Set(['d8-1', 'd8-2']) }));
    const lines = readFileSync(f.log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => [l.action, l.purpose])).toEqual([['open', 'beam-d8 d8-1: unit test'], ['open', 'beam-d8 d8-2: unit test']]);
    expect(lines[0].labels_sha256).toBe(fileSha256(f.manifest));
    expect(c.source.revision).toBe('unfilled');
    expect(c.source.files[0]).toEqual({ path: 'eval/decisions/datasets/d8-manifest.json', sha256: fileSha256(f.manifest) });
    const paths = c.source.files.slice(1).map(x => x.path);
    expect(paths).toContain('conversations/1/chat.json');
    expect(paths).toContain('conversations/2/probing_questions/event_ordering/event_ordering.json');
    expect(paths.some(p => p.endsWith('plan.txt') || p.endsWith('topic.json'))).toBe(false);
    for (const x of c.source.files.slice(1)) expect(x.sha256).toBe(fileSha256(join(f.root, x.path)));
  });

  test('prefers chat_trunecated.json when the generator wrote one, as BEAM does', () => {
    const f = fixture([1]);
    const chat = JSON.parse(readFileSync(join(f.root, 'conversations/1/chat.json'), 'utf8'));
    writeJson(join(f.root, 'conversations/1/chat_trunecated.json'), chat.slice(0, 1));
    const c = quiet(() => loadD8(custody(f.log), { only: new Set(['d8-1']) }));
    expect(c.conversations[0].sessions.map(s => s.id)).toEqual(['b1-g0', 'b1-g1']);
  });

  test('refuses without GBRAIN_EVALS_D8_SOURCE, without the custody log, inside the repository, and never fetches', async () => {
    fixture();
    delete process.env.GBRAIN_EVALS_D8_SOURCE;
    expect(code(() => loadCorpus('beam-d8'))).toBe('CUSTODY_MISSING');
    try { loadCorpus('beam-d8'); } catch (e) { expect((e as DecideError).op.message).toContain('GBRAIN_EVALS_D8_SOURCE'); expect((e as DecideError).op.fix.next).toBe('ask_user'); }
    process.env.GBRAIN_EVALS_D8_SOURCE = join(ROOT, 'eval');
    expect(code(() => loadCorpus('beam-d8'))).toBe('CUSTODY_MISSING');
    fixture();
    delete process.env.GBRAIN_EVALS_CUSTODY_LOG;
    expect(code(() => loadCorpus('beam-d8'))).toBe('CUSTODY_MISSING');
    expect(code(() => filesFor('beam-d8'))).toBe('CUSTODY_MISSING');
    let err: unknown;
    try { await fetchDataset('beam-d8', { log: () => {} }); } catch (e) { err = e; }
    expect(err instanceof DecideError && err.op.code).toBe('CUSTODY_MISSING');
  });

  test('refuses a missing conversation directory or ability file, and an unknown conversation id', () => {
    const f = fixture();
    expect(code(() => quiet(() => loadCorpus('beam-d8')))).toBe('DATASET_MISSING');
    rmSync(join(f.root, 'conversations/2/probing_questions/summarization/summarization.json'));
    expect(code(() => quiet(() => loadD8(custody(f.log), { only: new Set(['d8-2']) })))).toBe('DATASET_MISSING');
    expect(() => loadD8(custody(f.log), { only: new Set(['d8-11']) })).toThrow(/no conversation d8-11/);
  });
});

describe('beam-d8 manifest', () => {
  test('the committed template is unfilled and holds no hashes', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'eval/decisions/datasets/d8-manifest.json'), 'utf8'));
    expect(m.status).toBe('unfilled');
    expect(m.files).toEqual([]);
    expect(m.filled_at).toBeNull();
  });

  test('fill pins every file the loader reads; a filled manifest refuses tampered, unlisted and missing files', async () => {
    const f = fixture(D8_CONVERSATIONS.map((_, i) => i + 1));
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => { out.push(s); };
    try { expect(manifestMain(['fill', '--write', '--json'], process.env, () => '2026-10-29T00:00:00Z')).toBe(0); } finally { console.log = log; }
    const m = JSON.parse(readFileSync(f.manifest, 'utf8'));
    expect(m.status).toBe('filled');
    expect(m.files).toHaveLength(60);
    expect(JSON.parse(out[0]).files).toEqual(m.files);
    const all = loadD8(custody(f.log));
    expect(all.conversations).toHaveLength(10);
    expect(all.questions).toHaveLength(70);
    expect(all.source.revision).toBe(fileSha256(f.manifest).slice(0, 7));
    expect(verifyD8Custody(() => {})).toBe(60);
    expect(await fetchDataset('beam-d8', { log: () => {} })).toEqual({ fetched: 0, verified: 60 });

    const chat = join(f.root, 'conversations/3/chat.json');
    const original = readFileSync(chat);
    writeFileSync(chat, Buffer.concat([original, Buffer.from(' ')]));
    expect(code(() => loadD8(custody(f.log), { only: new Set(['d8-3']) }))).toBe('DATASET_HASH_MISMATCH');
    expect(code(() => verifyD8Custody(() => {}))).toBe('DATASET_HASH_MISMATCH');
    writeFileSync(chat, original);

    writeJson(join(f.root, 'conversations/4/probing_questions/knowledge_update/knowledge_update.json'), [{ question: 'invented', answer: 'x' }]);
    expect(code(() => loadD8(custody(f.log), { only: new Set(['d8-4']) }))).toBe('DATASET_HASH_MISMATCH');
    rmSync(join(f.root, 'conversations/4/probing_questions/knowledge_update'), { recursive: true });

    writeJson(join(f.root, 'conversations/5/chat_trunecated.json'), []);
    expect(code(() => loadD8(custody(f.log), { only: new Set(['d8-5']) }))).toBe('DATASET_MISSING');
    rmSync(join(f.root, 'conversations/5/chat_trunecated.json'));
    expect(loadD8(custody(f.log), { only: new Set(['d8-5']) }).questions).toHaveLength(7);
  });

  test('status reads the manifest only', () => {
    fixture([]);
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => { out.push(s); };
    try { expect(manifestMain(['status', '--json'])).toBe(0); } finally { console.log = log; }
    expect(JSON.parse(out[0])).toEqual({ status: 'unfilled', conversations: 10, files: 0, filled_at: null });
  });
});

describe('beam-d8 split, custody and instrument', () => {
  test('all ten conversations are sealed and none is dev', () => {
    const s = loadSplit('beam-d8');
    expect(s.dev).toEqual([]);
    expect(s.dev_fraction).toBe(0);
    expect([...s.sealed].sort()).toEqual([...D8_CONVERSATIONS].sort());
    expect(devConversations('beam-d8')).toEqual(new Set());
    expect(needsCustody({ benchmark: 'beam-d8', split: 'sealed' })).toBe(true);
    const corpus = { benchmark: 'beam-d8', conversations: [], questions: [], source: { name: '', files: [], revision: '', license: '' } } as Corpus;
    expect(splitConversations('beam-d8', 'sealed', corpus)).toEqual(new Set(D8_CONVERSATIONS));
    expect(splitConversations('beam-d8', 'dev', corpus)).toEqual(new Set());
  });

  test('beam-d8 is judged by the BEAM rubric instrument under its own id, falling back to the reference without a rubric', async () => {
    const d8 = instrumentFor('beam-d8');
    const b1m = INSTRUMENTS['beam-1m'];
    expect(d8.id).toBe('beam-d8');
    expect(d8.templates).toEqual(b1m.templates);
    expect(d8.source).toEqual(b1m.source);
    expect(d8.canonical_judge).toBe(b1m.canonical_judge);
    expect(d8.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d8.sha256).not.toBe(b1m.sha256);
    const prompts: string[] = [];
    const ask = async (call: JudgeCall) => { prompts.push(call.prompt); return { raw: '{"score": 1}', value: 1 }; };
    const q = { id: 'd8-1:preference_following:0', conversation: 'd8-1', question: 'Suggest a gift.', category: 'preference_following', gold: [], abstention: false, answer: 'Mentions a blue blanket' };
    expect(await d8.score(q, 'a blue blanket', ask)).toEqual({ score: 1, detail: { rubric_scores: [1], rubric_fallback: true } });
    expect(prompts[0]).toContain('RUBRIC CRITERION (what to check): Mentions a blue blanket');
  });

  test('a sealed receipt exports its beam-d8 benchmark name', () => {
    expect(exportAggregates({ benchmark: 'beam-d8', split: 'sealed' })).toEqual({ benchmark: 'beam-d8', split: 'sealed' });
  });
});

describe('beam-d8 against public BEAM data', () => {
  const m = beamManifest().sizes['1m'].find(c => c.conversation === '1m-16')!;
  const chatPath = join(DATASET_ROOT, 'beam', m.chat_path);
  const questionsPath = join(DATASET_ROOT, 'beam', m.questions_path);
  const cached = existsSync(chatPath) && existsSync(questionsPath) && fileSha256(chatPath) === m.chat_sha256 && fileSha256(questionsPath) === m.questions_sha256;
  if (!cached) console.log('[skip] beam-d8 parity with BEAM 1m-16: the dev files are not cached (bun run eval:decide fetch --benchmark beam-1m --conversations 1m-16)');

  test.skipIf(!cached)('1m-16 in the D8 layout loads the same sessions, gold, references and rubrics as loadBeam', () => {
    const root = tmp();
    mkdirSync(join(root, 'conversations/1'), { recursive: true });
    cpSync(chatPath, join(root, 'conversations/1/chat.json'));
    const pq = JSON.parse(readFileSync(questionsPath, 'utf8')) as Record<string, unknown[]>;
    for (const [ability, items] of Object.entries(pq)) writeJson(join(root, 'conversations/1/probing_questions', ability, `${ability}.json`), items);
    const manifest = join(root, 'manifest.json');
    cpSync(join(ROOT, 'eval/decisions/datasets/d8-manifest.json'), manifest);
    const d8 = quiet(() => loadD8(custody(join(root, 'log.jsonl')), { only: new Set(['d8-1']), root, manifestPath: manifest }));
    const beam = loadBeam('1m', new Set(['1m-16']));
    expect(d8.conversations[0].sessions).toEqual(beam.conversations[0].sessions);
    const rename = (q: Corpus['questions'][number]) => ({ ...q, id: q.id.replace(/^[^:]+:/, ''), conversation: '' });
    const order = (qs: Corpus['questions']) => qs.map(rename).sort((a, b) => a.id < b.id ? -1 : 1);
    expect(order(d8.questions)).toEqual(order(beam.questions));
    expect(d8.questions.length).toBe(beam.questions.length);
  });
});
