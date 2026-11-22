/**
 * beam-rs1, the RS1 set: 48 mint slots minted in custody with BEAM's generator by eval/custody/rs1/mint.sh,
 * all sealed. Its loader, manifest, split, instrument and custody refusals, on synthetic fixtures written in the mint's
 * set layout (tiny invented content), and on a set mint.sh --fake mints from a test seed. No RS1 byte is used here.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { closeLedgers } from '../../eval/runner/budget-ledger.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { devConversations, loadSplit } from '../../eval/runner/decisions/splits.ts';
import { freePort } from '../../eval/runner/lifecycle/slice.ts';
import { DATASET_ROOT, RS1_CONVERSATIONS, beamManifest, fetchDataset, fileSha256, filesFor, loadBeam, loadCorpus, loadRs1, rs1ConversationFiles, rs1Kept, rs1ManifestFiles, rs1ManifestPath, rs1Source, rs1UnitConversations, verifyRs1Custody, type Corpus } from '../../eval/runner/memory-qa/corpus.ts';
import { INSTRUMENTS, instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { exportAggregates } from '../../eval/runner/memory-qa/sealed-profile.ts';
import { needsCustody, splitConversations } from '../../eval/runner/q1/cell.ts';
import { DATASET_PINS } from '../../eval/runner/q1/reuse-check.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { rs1CustodyPush, runRemote } from '../../eval/runner/shootout-cell.ts';

const ROOT = resolve(import.meta.dir, '../..');
const MANIFEST = 'eval/decisions/datasets/rs1-manifest.json';
const ENV = ['GBRAIN_EVALS_RS1_SOURCE', 'GBRAIN_EVALS_RS1_MANIFEST', 'GBRAIN_EVALS_CUSTODY_LOG', 'GBRAIN_EVALS_DECISION_ID', 'GBRAIN_EVALS_RS1_UNIT'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rs1-loader-')); dirs.push(d); return d; };
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
afterAll(() => closeLedgers());

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const writeJson = (path: string, v: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 2)); };
const cid = (n: number) => `c${String(n).padStart(3, '0')}`;

/**
 * One invented conversation in the mint's set layout: BEAM's chat under beam/1 (two batches, three turn groups), the
 * selected items in probing_questions.json, and decoys the loader must not read (a candidate file, an earlier attempt,
 * the mint's manifest and topic, a plan).
 */
function writeConversation(root: string, n: number) {
  const conv = join(root, 'conversations', cid(n));
  const dir = join(conv, 'beam', '1');
  const msg = (id: number, role: string, content: string, extra: Record<string, unknown> = {}) => ({ role, id, index: '1,1', question_type: 'main_question', content, ...extra });
  writeJson(join(dir, 'chat.json'), [
    { batch_number: 1, time_anchor: 'March-01-2024', turns: [
      [msg(0, 'user', `${cid(n)} my cat is called Pebble ->-> 1,1`, { time_anchor: 'March-01-2024' }), msg(1, 'assistant', 'Noted.')],
      [msg(2, 'user', 'I moved the garden party to Sunday.'), msg(3, 'assistant', 'Sunday it is. ->-> 1,2')],
    ] },
    { batch_number: 2, time_anchor: null, turns: [
      [msg(4, 'user', 'Pebble now likes the blue blanket.', { time_anchor: 'April-02-2024' }), msg(5, 'assistant', 'Good to know.')],
    ] },
  ]);
  writeFileSync(join(dir, 'plan_new.txt'), 'invented plan');
  writeJson(join(conv, 'topic.json'), { category: 'general', title: 'invented' });
  writeJson(join(conv, 'manifest.json'), { schema: 'rs1-mint-manifest/v1', steps: {} });
  writeJson(join(dir, 'probing_questions', 'information_extraction', 'information_extraction.json'), [[{ question: 'An unselected candidate?', answer: 'never loaded', source_chat_ids: [0] }]]);
  writeJson(join(dir, 'probing_questions', 'attempts', '1.json'), { information_extraction: [{ question: 'An earlier attempt?', answer: 'never loaded' }] });
  writeJson(join(dir, 'probing_questions', 'probing_questions.json'), {
    abstention: [{ question: 'What is the dog called?', ideal_response: 'There is no dog in the conversation.', rubric: ['Says it is not mentioned'], custody: 'synthetic-tag' }],
    information_extraction: [
      { question: 'What is the cat called?', answer: 'Pebble', ideal_response: 'not this one', source_chat_ids: [0, 1], rubric: ['LLM response should state: Pebble'] },
      { question: 'Which day is the party?', answer: 'Sunday', source_chat_ids: { first: [2], second: [3] }, rubric: ['LLM response should state: Sunday'] },
    ],
    preference_following: [{ question: 'Suggest a gift.', expected_compliance: 'Mentions a blue blanket', source_chat_ids: [4] }],
    event_ordering: [{ question: 'Order the events.', answer: 'party then blanket', source_chat_ids: [2, 4, 99], rubric: ['party', 'blanket'] }],
    knowledge_update: [],
  });
}

function fixture(conversations = [1, 2]): { root: string; log: string; manifest: string } {
  const root = tmp();
  for (const n of conversations) writeConversation(root, n);
  const manifest = join(root, 'stand-in-manifest.json');
  cpSync(join(ROOT, MANIFEST), manifest);
  process.env.GBRAIN_EVALS_RS1_SOURCE = root;
  process.env.GBRAIN_EVALS_RS1_MANIFEST = manifest;
  process.env.GBRAIN_EVALS_CUSTODY_LOG = join(root, 'custody', 'access-log.jsonl');
  return { root, log: process.env.GBRAIN_EVALS_CUSTODY_LOG, manifest };
}

const decide = (fn: () => unknown): DecideError => { try { fn(); } catch (e) { if (e instanceof DecideError) return e; throw e; } throw new Error('expected a DecideError'); };
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof DecideError ? e.op.code : `not a DecideError: ${(e as Error).message}`; } return 'no refusal'; };
const caught = (fn: () => unknown): ScoreboardError => { try { fn(); } catch (e) { if (e instanceof ScoreboardError) return e; throw e; } throw new Error('expected a ScoreboardError'); };
const quiet = <T>(fn: () => T): T => { const w = process.stderr.write.bind(process.stderr); (process.stderr as { write: unknown }).write = () => true; try { return fn(); } finally { (process.stderr as { write: unknown }).write = w; } };
const custody = (log: string) => ({ log, decisionId: 'test', purpose: 'unit test' });

describe('beam-rs1 loader', () => {
  test('conversation rs1-<NNN> is conversations/c<NNN>/beam/1; sessions are loadBeam\'s: one per turn group, group or batch date, markers stripped', () => {
    const f = fixture();
    expect(RS1_CONVERSATIONS).toHaveLength(48);
    expect([RS1_CONVERSATIONS[0], RS1_CONVERSATIONS[47]]).toEqual(['rs1-001', 'rs1-048']);
    expect(rs1ConversationFiles(f.root, 'rs1-002')).toEqual({ chat: 'conversations/c002/beam/1/chat.json', questions: 'conversations/c002/beam/1/probing_questions/probing_questions.json' });
    const c = quiet(() => loadCorpus('beam-rs1', undefined, new Set(['rs1-001', 'rs1-002'])));
    expect(c.benchmark).toBe('beam-rs1');
    expect(c.conversations.map(x => x.id)).toEqual(['rs1-001', 'rs1-002']);
    const s = c.conversations[0].sessions;
    expect(s.map(x => x.id)).toEqual(['b1-g0', 'b1-g1', 'b2-g0']);
    expect(s.map(x => x.date)).toEqual(['March-01-2024', 'March-01-2024', 'April-02-2024']);
    expect(s[0].turns).toEqual([{ speaker: 'user', content: 'c001 my cat is called Pebble', message_ids: [0] }, { speaker: 'assistant', content: 'Noted.', message_ids: [1] }]);
    expect(s[1].turns[1].content).toBe('Sunday it is.');
  });

  test('reads the selected items from probing_questions.json only, maps gold and keeps BEAM reference precedence and rubrics', () => {
    fixture();
    const c = quiet(() => loadCorpus('beam-rs1', undefined, new Set(['rs1-001', 'rs1-002'])));
    const q = Object.fromEntries(c.questions.filter(x => x.conversation === 'rs1-002').map(x => [x.id, x]));
    expect(Object.keys(q).sort()).toEqual(['rs1-002:abstention:0', 'rs1-002:event_ordering:0', 'rs1-002:information_extraction:0', 'rs1-002:information_extraction:1', 'rs1-002:preference_following:0']);
    expect(c.questions).toHaveLength(10);
    expect(c.questions.some(x => /unselected candidate|earlier attempt/.test(x.question))).toBe(false);
    expect(q['rs1-002:information_extraction:0']).toMatchObject({ question: 'What is the cat called?', category: 'information_extraction', gold: ['b1-g0'], abstention: false, answer: 'Pebble', rubric: ['LLM response should state: Pebble'] });
    expect(q['rs1-002:information_extraction:1'].gold).toEqual(['b1-g1']);
    expect(q['rs1-002:abstention:0']).toEqual({ id: 'rs1-002:abstention:0', conversation: 'rs1-002', question: 'What is the dog called?', category: 'abstention', gold: [], abstention: true, answer: 'There is no dog in the conversation.', rubric: ['Says it is not mentioned'] });
    expect(q['rs1-002:preference_following:0']).toMatchObject({ answer: 'Mentions a blue blanket', gold: ['b2-g0'] });
    expect(q['rs1-002:preference_following:0'].rubric).toBeUndefined();
    expect(q['rs1-002:event_ordering:0']).toMatchObject({ gold: ['b1-g1', 'b2-g0'], rubric: ['party', 'blanket'] });
  });

  test('logs each conversation before reading it and records every file hash while the manifest is unfilled, with a notice', () => {
    const f = fixture();
    const notices: string[] = [];
    const w = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => { notices.push(String(s)); return true; };
    const c = (() => { try { return loadRs1(custody(f.log), { only: new Set(['rs1-001', 'rs1-002']) }); } finally { (process.stderr as { write: unknown }).write = w; } })();
    expect(notices.join('')).toMatch(/\[custody\] beam-rs1: the manifest is unfilled, so 4 file\(s\) loaded without pinned hashes/);
    const lines = readFileSync(f.log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => [l.action, l.purpose])).toEqual([['open', 'beam-rs1 rs1-001: unit test'], ['open', 'beam-rs1 rs1-002: unit test']]);
    expect(lines[0].labels_sha256).toBe(fileSha256(f.manifest));
    expect(c.source.revision).toBe('unfilled');
    expect(c.source.license).toBe('custodian-held');
    expect(c.source.files[0]).toEqual({ path: MANIFEST, sha256: fileSha256(f.manifest) });
    expect(c.source.files.slice(1).map(x => x.path)).toEqual([
      'conversations/c001/beam/1/chat.json', 'conversations/c001/beam/1/probing_questions/probing_questions.json',
      'conversations/c002/beam/1/chat.json', 'conversations/c002/beam/1/probing_questions/probing_questions.json',
    ]);
    for (const x of c.source.files.slice(1)) expect(x.sha256).toBe(fileSha256(join(f.root, x.path)));
  });

  test('prefers chat_trunecated.json when the mint truncated the chat, as BEAM and validate.ts do', () => {
    const f = fixture([1]);
    const chat = JSON.parse(readFileSync(join(f.root, 'conversations/c001/beam/1/chat.json'), 'utf8'));
    writeJson(join(f.root, 'conversations/c001/beam/1/chat_trunecated.json'), chat.slice(0, 1));
    const c = quiet(() => loadRs1(custody(f.log), { only: new Set(['rs1-001']) }));
    expect(c.conversations[0].sessions.map(s => s.id)).toEqual(['b1-g0', 'b1-g1']);
    expect(c.source.files[1].path).toBe('conversations/c001/beam/1/chat_trunecated.json');
  });

  test('refuses without GBRAIN_EVALS_RS1_SOURCE, inside the repository, without the custody log, and never fetches', async () => {
    const f = fixture();
    delete process.env.GBRAIN_EVALS_RS1_SOURCE;
    expect(code(() => loadCorpus('beam-rs1'))).toBe('CUSTODY_MISSING');
    const unset = decide(() => loadCorpus('beam-rs1')).op;
    expect(unset.message).toBe('beam-rs1: GBRAIN_EVALS_RS1_SOURCE is not set');
    expect(unset.fix.next).toBe('ask_user');
    expect(code(() => rs1Source({}))).toBe('CUSTODY_MISSING');
    process.env.GBRAIN_EVALS_RS1_SOURCE = join(ROOT, 'eval');
    expect(code(() => loadCorpus('beam-rs1'))).toBe('CUSTODY_MISSING');
    expect(decide(() => rs1Source({ GBRAIN_EVALS_RS1_SOURCE: ROOT })).op.message).toMatch(/inside the repository/);
    expect(decide(() => rs1Source({ GBRAIN_EVALS_RS1_SOURCE: join(ROOT, 'eval') })).op.message).toMatch(/inside the repository/);
    let err: unknown;
    try { await fetchDataset('beam-rs1', { log: () => {} }); } catch (e) { err = e; }
    expect(err instanceof DecideError && err.op.code).toBe('CUSTODY_MISSING');
    process.env.GBRAIN_EVALS_RS1_SOURCE = f.root;
    delete process.env.GBRAIN_EVALS_CUSTODY_LOG;
    expect(code(() => loadCorpus('beam-rs1'))).toBe('CUSTODY_MISSING');
    expect(code(() => loadRs1(custody(''), { root: f.root }))).toBe('CUSTODY_MISSING');
    expect(code(() => filesFor('beam-rs1'))).toBe('CUSTODY_MISSING');
    expect(existsSync(f.log)).toBe(false);
  });

  test('refuses a missing conversation directory or questions file, and an unknown conversation id', () => {
    const f = fixture();
    expect(code(() => quiet(() => loadCorpus('beam-rs1')))).toBe('DATASET_MISSING');
    rmSync(join(f.root, 'conversations/c002/beam/1/probing_questions/probing_questions.json'));
    const missing = decide(() => quiet(() => loadRs1(custody(f.log), { only: new Set(['rs1-002']) }))).op;
    expect(missing).toMatchObject({ code: 'DATASET_MISSING', message: 'beam-rs1: conversations/c002/beam/1/probing_questions/probing_questions.json is not under GBRAIN_EVALS_RS1_SOURCE' });
    expect(() => loadRs1(custody(f.log), { only: new Set(['rs1-076']) })).toThrow(/no conversation rs1-076/);
    expect(() => loadRs1(custody(f.log), { only: new Set(['rs1-1']) })).toThrow(/no conversation rs1-1/);
  });

  test('on a VM the custody root and manifest resolve from ~/ paths', () => {
    expect(rs1Source({ GBRAIN_EVALS_RS1_SOURCE: '~/custody/rs1' })).toBe(join(homedir(), 'custody/rs1'));
    process.env.GBRAIN_EVALS_RS1_MANIFEST = '~/custody/rs1/stand-in-rs1-manifest.json';
    expect(rs1ManifestPath()).toBe(join(homedir(), 'custody/rs1/stand-in-rs1-manifest.json'));
    delete process.env.GBRAIN_EVALS_RS1_MANIFEST;
    expect(rs1ManifestPath()).toBe(join(ROOT, MANIFEST));
  });
});

describe('beam-rs1 manifest', () => {
  test('the committed template is unfilled, holds no hashes and names the mint\'s layout', () => {
    const m = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'));
    expect(m.status).toBe('unfilled');
    expect(m.files).toEqual([]);
    expect(m.filled_at).toBeNull();
    expect(m.layout).toContain('conversations/c<NNN>/beam/1/probing_questions/probing_questions.json');
  });

  test('an unfilled manifest loads with recorded hashes but verifies nothing: decide fetch refuses', async () => {
    const f = fixture();
    expect(quiet(() => loadRs1(custody(f.log), { only: new Set(['rs1-001']) })).questions).toHaveLength(5);
    expect(decide(() => verifyRs1Custody(() => {})).op).toMatchObject({ code: 'CUSTODY_MISSING', message: 'beam-rs1: the manifest has no hashes yet' });
    let err: unknown;
    try { await fetchDataset('beam-rs1', { log: () => {} }); } catch (e) { err = e; }
    expect(err instanceof DecideError && err.op.code).toBe('CUSTODY_MISSING');
  });

  test('rs1ManifestFiles pins every file the loader reads; a filled manifest refuses tampered, unlisted and missing files', async () => {
    const f = fixture(RS1_CONVERSATIONS.map((_, i) => i + 1));
    const files = rs1ManifestFiles(f.root);
    expect(files).toHaveLength(96);
    expect(files.slice(0, 2).map(x => x.path)).toEqual(['conversations/c001/beam/1/chat.json', 'conversations/c001/beam/1/probing_questions/probing_questions.json']);
    const template = JSON.parse(readFileSync(f.manifest, 'utf8'));
    writeFileSync(f.manifest, JSON.stringify({ ...template, status: 'filled', files, filled_at: '2026-11-03T00:00:00Z' }, null, 1) + '\n');
    const all = loadRs1(custody(f.log));
    expect(all.conversations).toHaveLength(48);
    expect(all.questions).toHaveLength(240);
    expect(all.source.revision).toBe(fileSha256(f.manifest).slice(0, 7));
    expect(verifyRs1Custody(() => {})).toBe(96);
    expect(await fetchDataset('beam-rs1', { log: () => {} })).toEqual({ fetched: 0, verified: 96 });

    const chat = join(f.root, 'conversations/c003/beam/1/chat.json');
    const original = readFileSync(chat);
    writeFileSync(chat, Buffer.concat([original, Buffer.from(' ')]));
    expect(code(() => loadRs1(custody(f.log), { only: new Set(['rs1-003']) }))).toBe('DATASET_HASH_MISMATCH');
    expect(code(() => verifyRs1Custody(() => {}))).toBe('DATASET_HASH_MISMATCH');
    writeFileSync(chat, original);

    writeJson(join(f.root, 'conversations/c004/beam/1/probing_questions/knowledge_update/knowledge_update.json'), [{ question: 'invented candidate', answer: 'x' }]);
    expect(loadRs1(custody(f.log), { only: new Set(['rs1-004']) }).questions).toHaveLength(5);

    writeJson(join(f.root, 'conversations/c005/beam/1/chat_trunecated.json'), []);
    expect(code(() => loadRs1(custody(f.log), { only: new Set(['rs1-005']) }))).toBe('DATASET_MISSING');
    rmSync(join(f.root, 'conversations/c005/beam/1/chat_trunecated.json'));
    expect(loadRs1(custody(f.log), { only: new Set(['rs1-005']) }).questions).toHaveLength(5);

    rmSync(join(f.root, 'conversations/c006/beam/1/probing_questions/probing_questions.json'));
    expect(code(() => loadRs1(custody(f.log), { only: new Set(['rs1-006']) }))).toBe('DATASET_MISSING');
    expect(code(() => verifyRs1Custody(() => {}))).toBe('DATASET_MISSING');
  });
});

describe('beam-rs1 kept list (the custodian names the kept conversations in the filled manifest)', () => {
  const filled = (root: string, kept: number[], extra: Record<string, unknown> = {}) => ({ dataset: 'RS1', status: 'filled' as const, layout: '', note: '', filled_at: '2026-11-08T00:00:00Z',
    files: rs1ManifestFiles(root, kept.map(n => `rs1-${String(n).padStart(3, '0')}`)), kept: kept.map(n => `rs1-${String(n).padStart(3, '0')}`), ...extra });

  test('rs1Kept returns the kept ids in slot order and refuses an unfilled manifest, an id outside the 48 slots, an unpinned id and a bad order', () => {
    const f = fixture([1, 2, 3, 5, 7]);
    expect(rs1Kept(filled(f.root, [1, 2, 3, 5]))).toEqual({ kept: ['rs1-001', 'rs1-002', 'rs1-003', 'rs1-005'], n_final: null });
    expect(code(() => rs1Kept({ ...filled(f.root, [1]), status: 'unfilled' }))).toBe('DATASET_MISSING');
    expect(decide(() => rs1Kept({ ...filled(f.root, [1]), kept: ['rs1-001', 'rs1-049'] })).op.message).toContain('rs1-049 is not one of the 48 mint slots');
    expect(decide(() => rs1Kept({ ...filled(f.root, [1, 2]), kept: ['rs1-001', 'rs1-002', 'rs1-007'] })).op.message).toContain('rs1-007 has no pinned chat or questions file');
    expect(decide(() => rs1Kept({ ...filled(f.root, [1, 2]), kept: ['rs1-002', 'rs1-001'] })).op.message).toContain('strictly increasing slot order');
    expect(code(() => rs1Kept(filled(f.root, [1, 2], { n_final: 1 })))).toBe('DATASET_MISSING');
  });

  test('a launch unit takes five kept conversations in slot order; a short last unit runs only once n_final completes the list', () => {
    const slots = Array.from({ length: 23 }, (_, i) => i + 1).filter(n => n !== 4 && n !== 9);
    const f = fixture(slots);
    const m = filled(f.root, slots);
    expect(rs1UnitConversations(m, 0, 5)).toEqual(['rs1-001', 'rs1-002', 'rs1-003', 'rs1-005', 'rs1-006']);
    expect(rs1UnitConversations(m, 3, 5)).toEqual(['rs1-018', 'rs1-019', 'rs1-020', 'rs1-021', 'rs1-022']);
    expect(decide(() => rs1UnitConversations(m, 4, 5)).op.message).toContain('launch unit 4 needs kept conversations 21 to 25, and the kept list holds 21');
    expect(rs1UnitConversations({ ...m, n_final: 21 }, 4, 5)).toEqual(['rs1-023']);
    expect(code(() => rs1UnitConversations({ ...m, n_final: 21 }, 5, 5))).toBe('DATASET_MISSING');
  });
});

describe('beam-rs1 split, instrument and reuse pin', () => {
  test('all 48 mint slots are sealed and none is dev', () => {
    const s = loadSplit('beam-rs1');
    expect(s.dev).toEqual([]);
    expect(s.dev_fraction).toBe(0);
    expect([...s.sealed].sort()).toEqual([...RS1_CONVERSATIONS].sort());
    expect(devConversations('beam-rs1')).toEqual(new Set());
    expect(needsCustody({ benchmark: 'beam-rs1', split: 'sealed' })).toBe(true);
    const corpus = { benchmark: 'beam-rs1', conversations: [], questions: [], source: { name: '', files: [], revision: '', license: '' } } as Corpus;
    expect(splitConversations('beam-rs1', 'sealed', corpus)).toEqual(new Set(RS1_CONVERSATIONS));
    expect(splitConversations('beam-rs1', 'dev', corpus)).toEqual(new Set());
  });

  test('instrumentFor(beam-rs1) is BEAM\'s rubric instrument under its own id, with gpt-4.1-mini as its canonical judge', () => {
    const rs1 = instrumentFor('beam-rs1');
    const b1m = INSTRUMENTS['beam-1m'];
    expect(rs1.id).toBe('beam-rs1');
    expect(rs1.canonical_judge).toBe('openai:gpt-4.1-mini');
    expect(rs1.canonical_judge).toBe(b1m.canonical_judge);
    expect(rs1.templates).toEqual(b1m.templates);
    expect(rs1.source).toEqual(b1m.source);
    expect(rs1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rs1.sha256).not.toBe(b1m.sha256);
    expect(rs1.sha256).not.toBe(instrumentFor('beam-d8').sha256);
  });

  test('a sealed receipt exports its beam-rs1 benchmark name, and the RS1 manifest is a pin only beam-rs1 cells compare', () => {
    expect(exportAggregates({ benchmark: 'beam-rs1', split: 'sealed' })).toEqual({ benchmark: 'beam-rs1', split: 'sealed' });
    expect(DATASET_PINS[MANIFEST]).toEqual(['beam-rs1']);
  });
});

/** A synthetic RS1 stand-in: two conversations in the mint's layout and a filled manifest inside the root. */
function standIn() {
  const root = tmp();
  const files = Array.from({ length: 10 }, (_, i) => i + 1).flatMap(n => [[`conversations/${cid(n)}/beam/1/chat.json`, JSON.stringify({ synthetic: `chat ${n}` })], [`conversations/${cid(n)}/beam/1/probing_questions/probing_questions.json`, JSON.stringify({ abstention: [{ question: `SYNTHETIC ${n}` }] })]] as const);
  for (const [p, body] of files) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  const manifest = join(root, 'stand-in-rs1-manifest.json');
  writeFileSync(manifest, JSON.stringify({ dataset: 'RS1 stand-in', status: 'filled', layout: 'stand-in', note: 'synthetic', files: files.map(([path, body]) => ({ path, sha256: sha(body) })), filled_at: '2026-11-03T00:00:00Z', kept: Array.from({ length: 10 }, (_, i) => `rs1-${String(i + 1).padStart(3, '0')}`) }));
  return { root, manifest, files: files.map(([p]) => p) };
}

describe('the RS1 custody push', () => {
  const UNIT0 = { index: 0, size: 5 };
  test('checks the unit\'s files against the filled manifest, pushes them and the manifest to ~/custody/rs1, and points the loader there', () => {
    const s = standIn();
    const push = rs1CustodyPush({ GBRAIN_EVALS_RS1_SOURCE: s.root, GBRAIN_EVALS_RS1_MANIFEST: s.manifest }, '<campaign>', UNIT0);
    expect(push).toEqual({ source: s.root, dest: 'custody/rs1', list: [...s.files.slice(0, 10), 'stand-in-rs1-manifest.json'],
      env: ['GBRAIN_EVALS_RS1_SOURCE=~/custody/rs1', 'GBRAIN_EVALS_RS1_MANIFEST=~/custody/rs1/stand-in-rs1-manifest.json', 'GBRAIN_EVALS_RS1_UNIT=rs1-001,rs1-002,rs1-003,rs1-004,rs1-005'] });
  });

  test('D1: a unit-0 VM receives no file of any other unit; a push without a unit, or of a unit not yet kept, refuses', () => {
    const s = standIn();
    const ok = { GBRAIN_EVALS_RS1_SOURCE: s.root, GBRAIN_EVALS_RS1_MANIFEST: s.manifest };
    const unit0 = rs1CustodyPush(ok, '<campaign>', UNIT0).list;
    for (const n of [6, 7, 8, 9, 10]) expect(unit0.some(p => p.startsWith(`conversations/${cid(n)}/`))).toBe(false);
    const unit1 = rs1CustodyPush(ok, '<campaign>', { index: 1, size: 5 }).list;
    expect(unit1.filter(p => p.startsWith('conversations/')).map(p => p.split('/')[1])).toEqual(['c006', 'c006', 'c007', 'c007', 'c008', 'c008', 'c009', 'c009', 'c010', 'c010']);
    expect(caught(() => rs1CustodyPush(ok)).op.message).toMatch(/names no launch unit/);
    expect(caught(() => rs1CustodyPush(ok, '<campaign>', { index: 2, size: 5 })).op.message).toMatch(/launch unit 2 needs kept conversations 11 to 15/);
  });

  test('D1 on the VM: setup\'s fetch and the loader accept a root holding exactly the unit, refuse any other conversation, and fail closed on a changed byte', async () => {
    const host = fixture(Array.from({ length: 10 }, (_, i) => i + 1));
    const kept = Array.from({ length: 10 }, (_, i) => `rs1-${String(i + 1).padStart(3, '0')}`);
    const template = JSON.parse(readFileSync(host.manifest, 'utf8'));
    writeFileSync(host.manifest, JSON.stringify({ ...template, status: 'filled', files: rs1ManifestFiles(host.root, kept), filled_at: '2026-11-08T00:00:00Z', kept }, null, 1) + '\n');
    const push = rs1CustodyPush(process.env, '<campaign>', UNIT0);
    const vm = tmp();
    for (const p of push.list) { mkdirSync(dirname(join(vm, p)), { recursive: true }); cpSync(join(host.root, p), join(vm, p)); }
    const unit = kept.slice(0, 5);
    process.env.GBRAIN_EVALS_RS1_SOURCE = vm;
    process.env.GBRAIN_EVALS_RS1_MANIFEST = join(vm, 'stand-in-manifest.json');
    process.env.GBRAIN_EVALS_RS1_UNIT = unit.join(',');
    expect(verifyRs1Custody(() => {})).toBe(10);
    expect(await fetchDataset('beam-rs1', { log: () => {} })).toEqual({ fetched: 0, verified: 10 });
    expect(loadRs1(custody(host.log), { only: new Set(unit) }).conversations.map(c => c.id)).toEqual(unit);
    for (const only of [new Set(['rs1-001', 'rs1-006']), undefined]) expect(decide(() => loadRs1(custody(host.log), { only })).op).toMatchObject({ code: 'CUSTODY_MISSING', message: expect.stringContaining('this VM holds launch unit rs1-001, rs1-002, rs1-003, rs1-004, rs1-005 only') });
    process.env.GBRAIN_EVALS_RS1_UNIT = 'rs1-001,rs1-011';
    expect(decide(() => verifyRs1Custody(() => {})).op.message).toContain('names rs1-011, which the filled manifest does not keep');
    process.env.GBRAIN_EVALS_RS1_UNIT = unit.join(',');
    cpSync(join(host.root, 'conversations/c006'), join(vm, 'conversations/c006'), { recursive: true });
    expect(decide(() => verifyRs1Custody(() => {})).op).toMatchObject({ code: 'CUSTODY_MISSING', message: expect.stringContaining('holds 1 conversation(s) outside launch unit') });
    rmSync(join(vm, 'conversations/c006'), { recursive: true });
    const chat = join(vm, 'conversations/c003/beam/1/chat.json');
    writeFileSync(chat, readFileSync(chat, 'utf8') + ' ');
    expect(code(() => verifyRs1Custody(() => {}))).toBe('DATASET_HASH_MISMATCH');
    expect(code(() => loadRs1(custody(host.log), { only: new Set(unit) }))).toBe('DATASET_HASH_MISMATCH');
    rmSync(join(vm, 'conversations/c004/beam/1/probing_questions/probing_questions.json'));
    expect(code(() => verifyRs1Custody(() => {}))).not.toBe('no refusal');
  });

  test('an unset source, a source inside the repository, no manifest, an unfilled one, one outside the source, a changed byte or a missing file refuses before any VM', () => {
    const s = standIn();
    const ok = { GBRAIN_EVALS_RS1_SOURCE: s.root, GBRAIN_EVALS_RS1_MANIFEST: s.manifest };
    expect(caught(() => rs1CustodyPush({})).op).toMatchObject({ code: 'CUSTODY_REQUIRED', message: expect.stringMatching(/GBRAIN_EVALS_RS1_SOURCE is not set/) });
    expect(caught(() => rs1CustodyPush({ ...ok, GBRAIN_EVALS_RS1_SOURCE: join(ROOT, 'eval') })).op.message).toMatch(/inside the repository/);
    expect(caught(() => rs1CustodyPush({ GBRAIN_EVALS_RS1_SOURCE: s.root })).op.message).toMatch(/GBRAIN_EVALS_RS1_MANIFEST is not set/);
    const outside = join(tmp(), 'rs1-manifest-outside.json');
    writeFileSync(outside, readFileSync(s.manifest));
    expect(caught(() => rs1CustodyPush({ ...ok, GBRAIN_EVALS_RS1_MANIFEST: outside })).op).toMatchObject({ code: 'USAGE', message: expect.stringMatching(/must sit inside GBRAIN_EVALS_RS1_SOURCE/) });
    const unfilled = join(s.root, 'unfilled.json');
    writeFileSync(unfilled, readFileSync(join(ROOT, MANIFEST)));
    expect(caught(() => rs1CustodyPush({ ...ok, GBRAIN_EVALS_RS1_MANIFEST: unfilled }, '<campaign>', UNIT0)).op.message).toMatch(/has no hashes/);
    const f = join(s.root, s.files[3]);
    writeFileSync(f, readFileSync(f, 'utf8') + ' ');
    expect(caught(() => rs1CustodyPush(ok, '<campaign>', UNIT0)).op.message).toMatch(/conversations\/c002\/beam\/1\/probing_questions\/probing_questions\.json .*not the pinned bytes/);
    rmSync(join(s.root, s.files[0]));
    expect(caught(() => rs1CustodyPush(ok, '<campaign>', UNIT0)).op.message).toMatch(/conversations\/c001\/beam\/1\/chat\.json .*missing/);
  });

  test('the remote command wipes the pushed ~/custody/rs1 at teardown', async () => {
    const base = tmp();
    const out = join(base, 'out', 'rs1-c0', 'lease-r');
    mkdirSync(join(base, 'rs1'), { recursive: true });
    writeFileSync(join(base, 'rs1', 'f'), 'x');
    const port = await freePort(0);
    const exit = await runRemote({ lease_id: 'lease-r', lease_usd: 0.1, out, cell: 'rs1-c0', sealed: true, command: '[ -f "$SHOOTOUT_CUSTODY/../rs1/f" ] || exit 9' }, { port, custodyBase: base });
    expect(exit).toBe(0);
    expect(existsSync(join(base, 'rs1'))).toBe(false);
  }, 30_000);
});

describe('beam-rs1 on a set mint.sh --fake mints', () => {
  test('the loader reads the mint\'s own layout: 2 conversations, two items per ability, gold in every cited item', () => {
    const root = tmp();
    const beam = join(root, 'beam');
    const turns = Array.from({ length: 4 }, (_, i) => [{ role: 'user', id: 2 * i, content: `public user ${i}` }, { role: 'assistant', id: 2 * i + 1, content: `public assistant ${i}` }]);
    writeJson(join(beam, 'topics/1M/1M_topics.json'), ['Coding', 'Math', 'Cooking'].map((category, i) => ({ id: i + 1, category, title: `Public ${category} topic`, theme: `Public theme ${i}`, subtopics: ['a', 'b', 'c'] })));
    writeJson(join(beam, 'chats/1M/1/chat.json'), [{ batch_number: 1, time_anchor: 'x', turns }]);
    mkdirSync(join(root, 'keys'));
    const seed = join(root, 'keys/loader.rs1-seed');
    writeFileSync(seed, ['rs1', 'seed', 'v1'].join('-') + ':' + sha('rs1 loader test seed') + '\n', { mode: 0o600 });
    const out = join(root, 'rs1-custody-loader');
    const r = spawnSync('bash', [join(ROOT, 'eval/custody/rs1/mint.sh'), '--fake', '--beam-dir', beam, '--out', out, '--seed-file', seed, '--count', '2'],
      { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, timeout: 120_000 });
    expect(r.status).toBe(0);
    const set = join(out, 'set');
    const manifest = join(root, 'stand-in-manifest.json');
    cpSync(join(ROOT, MANIFEST), manifest);
    const c = quiet(() => loadRs1(custody(join(root, 'access-log.jsonl')), { root: set, manifestPath: manifest, only: new Set(['rs1-001', 'rs1-002']) }));
    expect(c.conversations.map(x => x.id)).toEqual(['rs1-001', 'rs1-002']);
    expect(c.source.files.slice(1).map(x => x.path)).toEqual(['c001', 'c002'].flatMap(d => [`conversations/${d}/beam/1/chat.json`, `conversations/${d}/beam/1/probing_questions/probing_questions.json`]));
    for (const conv of c.conversations) {
      const qs = c.questions.filter(q => q.conversation === conv.id);
      const sessions = new Set(conv.sessions.map(s => s.id));
      expect(qs).toHaveLength(20);
      expect(new Set(qs.map(q => q.category)).size).toBe(10);
      for (const q of qs) {
        expect(q.answer).toBeTruthy();
        expect(q.rubric?.length).toBeGreaterThan(0);
        if (q.abstention) expect(q.gold).toEqual([]);
        else { expect(q.gold.length).toBeGreaterThan(0); for (const g of q.gold) expect(sessions.has(g)).toBe(true); }
      }
    }
  }, 120_000);
});

describe('beam-rs1 against public BEAM data', () => {
  const m = beamManifest().sizes['1m'].find(c => c.conversation === '1m-16')!;
  const chatPath = join(DATASET_ROOT, 'beam', m.chat_path);
  const questionsPath = join(DATASET_ROOT, 'beam', m.questions_path);
  const cached = existsSync(chatPath) && existsSync(questionsPath) && fileSha256(chatPath) === m.chat_sha256 && fileSha256(questionsPath) === m.questions_sha256;
  if (!cached) console.log('[skip] beam-rs1 parity with BEAM 1m-16: the dev files are not cached (bun run eval:decide fetch --benchmark beam-1m --conversations 1m-16)');

  test.skipIf(!cached)('1m-16 in the mint\'s layout loads the same sessions, gold, references and rubrics as loadBeam', () => {
    const root = tmp();
    mkdirSync(join(root, 'conversations/c001/beam/1/probing_questions'), { recursive: true });
    cpSync(chatPath, join(root, 'conversations/c001/beam/1/chat.json'));
    cpSync(questionsPath, join(root, 'conversations/c001/beam/1/probing_questions/probing_questions.json'));
    const manifest = join(root, 'manifest.json');
    cpSync(join(ROOT, MANIFEST), manifest);
    const rs1 = quiet(() => loadRs1(custody(join(root, 'log.jsonl')), { only: new Set(['rs1-001']), root, manifestPath: manifest }));
    const beam = loadBeam('1m', new Set(['1m-16']));
    expect(rs1.conversations[0].sessions).toEqual(beam.conversations[0].sessions);
    const rename = (q: Corpus['questions'][number]) => ({ ...q, id: q.id.replace(/^[^:]+:/, ''), conversation: '' });
    expect(rs1.questions.map(rename)).toEqual(beam.questions.map(rename));
  });
});
