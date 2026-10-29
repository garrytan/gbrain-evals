/**
 * Q1 loaders (PLAN §4.2, §4.8.6, §4.8.10): LongMemEval-M streaming and its
 * stratified slice; BEAM-10M corpus-only loading, its structural inability to
 * read question files, the custodian's question loader, the manifest
 * generator, the structure check and the split file; and the outcome
 * vocabulary answering cells share. Synthetic fixtures only: no BEAM-10M
 * byte and no LongMemEval-M download is used here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import { beamChatSessions, beam10mCorpusManifest, loadBeam10mCorpus, parseAnchor, syntheticDate } from '../../eval/runner/memory-qa/beam10m-corpus.ts';
import { beam10mExclusions, loadBeam10mQuestions } from '../../eval/runner/memory-qa/beam10m-questions.ts';
import { DATASET_ROOT, LME_M_FILE, lmeMSelection, loadLmeM, originalSessionIds, scanJsonArray } from '../../eval/runner/memory-qa/corpus.ts';
import { canonicalize, HARNESS_FAILURES, NOT_APPLICABLE, PRODUCT_FAILURES, type Manifest } from '../../eval/runner/memory-qa/outcomes.ts';
import { answerProblems, answerRecord, type AnswerPayload } from '../../eval/runner/memory-qa/records.ts';
import { fillManifest, main as manifestMain, pythonExtractor, type Beam10mManifest } from '../../eval/runner/q1/beam10m-manifest.ts';
import { main as structureMain } from '../../eval/runner/q1/beam10m-structure.ts';
import type { AgentAnswer } from '../../eval/runner/systems/file-agent.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';
import type { Corpus } from '../../eval/runner/memory-qa/corpus.ts';

const ROOT = resolve(import.meta.dir, '../..');
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'q1-loaders-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { const d = dirs.pop()!; try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });

/** Capture stdout and stderr of a synchronous or async CLI main. */
async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const [o, e] = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)];
  (process.stdout as { write: unknown }).write = (s: string) => { out.push(s); return true; };
  (process.stderr as { write: unknown }).write = (s: string) => { err.push(s); return true; };
  try { return { code: await fn(), out: out.join(''), err: err.join('') }; } finally { (process.stdout as { write: unknown }).write = o; (process.stderr as { write: unknown }).write = e; }
}

// ─── LongMemEval-M ───────────────────────────────────────────────────

const TYPES = ['single-session-user', 'single-session-assistant', 'single-session-preference', 'temporal-reasoning', 'knowledge-update', 'multi-session'];
function lmeFixture(): unknown[] {
  return [...TYPES, 'abstention'].flatMap((t, ti) => [0, 1].map(k => {
    const id = t === 'abstention' ? `abs${k}_abs` : `${t.slice(0, 4)}${k}`;
    const sids = ['sess_a', `answer_${ti}_${k}`, 'sess_b', 'sess_a'];
    return {
      question_id: id, question_type: t === 'abstention' ? 'multi-session' : t, question: `Q {${id}} "quoted" \\ back`, answer: k ? 18 : 'Level "3" 🙂',
      question_date: '2023/05/30 (Tue) 10:00', haystack_dates: ['2023/05/01 (Mon) 09:00', '2023/05/02 (Tue) 09:00', '2023/05/03 (Wed) 09:00', '2023/05/04 (Thu) 09:00'],
      haystack_session_ids: sids, answer_session_ids: [`answer_${ti}_${k}`, ...(k ? ['sess_a'] : [])],
      haystack_sessions: sids.map((s, i) => [{ role: 'user', content: `turn ${i} of ${s}: braces } { [ ] and "quotes" and 日本語 and \\n`, has_answer: i === 1 }, { role: 'assistant', content: 'ok' }]),
    };
  }));
}

describe('LongMemEval-M loader', () => {
  test('streams the array with any chunk size, keeps occurrence ids, and never loads the file whole', () => {
    const d = tmp();
    const data = lmeFixture();
    const text = JSON.stringify(data, null, 1);
    const path = join(d, 'lme-m.json');
    writeFileSync(path, text);
    for (const chunk of [3, 7, 64, 1 << 20]) {
      const seen: unknown[] = [];
      const r = scanJsonArray(path, v => seen.push(v), chunk);
      expect(seen).toEqual(data);
      expect(r).toEqual({ sha256: sha(text), bytes: Buffer.byteLength(text), elements: data.length });
    }
    const c = loadLmeM({ path, sha256: sha(text), size: 7, chunkBytes: 5 });
    expect(c.questions.length).toBe(7);
    expect(Object.values(c.selection.quotas!).every(n => n === 1)).toBe(true);
    const q = c.questions.find(x => x.id.endsWith('1') && !x.abstention)!;
    const conv = c.conversations.find(x => x.id === q.conversation)!;
    expect(conv.sessions.map(s => s.id)).toEqual(['sess_a-occ-0', expect.stringMatching(/^answer_\d_1-occ-1$/), 'sess_b-occ-2', 'sess_a-occ-3']);
    expect(conv.sessions[3]).toMatchObject({ original_id: 'sess_a', date: '2023/05/04 (Thu) 09:00' });
    expect(q.gold.sort()).toEqual([conv.sessions[1].id, 'sess_a-occ-0', 'sess_a-occ-3'].sort());
    expect(originalSessionIds(conv, ['sess_a-occ-3', 'sess_a-occ-0', 'sess_b-occ-2'])).toEqual(['sess_a', 'sess_b']);
    expect(JSON.stringify(c.conversations)).not.toContain('has_answer');
    expect(c.questions.find(x => x.abstention)!.gold).toEqual([]);
  });

  test('a hash mismatch, a missing file and a truncated array refuse', () => {
    const d = tmp();
    const path = join(d, 'lme-m.json');
    writeFileSync(path, JSON.stringify(lmeFixture()));
    expect(() => loadLmeM({ path })).toThrow(DecideError);
    try { loadLmeM({ path }); } catch (e) { expect((e as DecideError).op.code).toBe('DATASET_HASH_MISMATCH'); }
    try { loadLmeM({ path: join(d, 'absent.json') }); } catch (e) { expect((e as DecideError).op).toMatchObject({ code: 'DATASET_MISSING', fix: { next: 'run' } }); }
    writeFileSync(path, JSON.stringify(lmeFixture()).slice(0, -2));
    expect(() => scanJsonArray(path, () => {})).toThrow(/truncated/);
  });

  test('the 100-question slice: proportional quotas, SHA-256 order inside each bucket, ids and types only', () => {
    const sizes: Record<string, number> = { 'single-session-user': 64, 'single-session-assistant': 56, 'single-session-preference': 30, 'temporal-reasoning': 127, 'knowledge-update': 72, 'multi-session': 121, abstention: 30 };
    const meta = Object.entries(sizes).flatMap(([t, n]) => Array.from({ length: n }, (_, i) => ({ question_id: t === 'abstention' ? `x${i}_abs` : `${t}-${i}`, question_type: t === 'abstention' ? 'temporal-reasoning' : t })));
    const sel = lmeMSelection(meta);
    expect(sel.quotas).toEqual({ abstention: 6, 'knowledge-update': 14, 'multi-session': 24, 'single-session-assistant': 11, 'single-session-preference': 6, 'single-session-user': 13, 'temporal-reasoning': 26 });
    expect(sel.selected.length).toBe(100);
    const key = (id: string) => sha(`q1-lme-m-v1\u0000${id}`);
    const abs = sel.selected.filter(id => id.endsWith('_abs'));
    expect(abs).toEqual(meta.filter(m => m.question_id.endsWith('_abs')).map(m => m.question_id).sort((a, b) => key(a) < key(b) ? -1 : 1).slice(0, 6));
    expect(lmeMSelection([...meta].reverse())).toEqual(sel);
  });

  test('the frozen selection file matches its method and, when the dataset is present, the loader', () => {
    const f = JSON.parse(readFileSync(join(ROOT, 'eval/decisions/datasets/lme-m-q1-selection.json'), 'utf8'));
    expect(f.dataset.sha256).toBe(LME_M_FILE.sha256);
    expect(sha(f.selected.join('\n'))).toBe(f.selected_sha256);
    expect(Object.values(f.quotas as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(100);
    const meta = Object.entries(f.bucket_sizes as Record<string, number>).flatMap(([t, n]) => Array.from({ length: n }, (_, i) => ({ question_id: t === 'abstention' ? `x${i}_abs` : `${t}-${i}`, question_type: t === 'abstention' ? 'multi-session' : t })));
    expect(lmeMSelection(meta).quotas).toEqual(f.quotas);
  });

  test.skipIf(!existsSync(join(DATASET_ROOT, LME_M_FILE.path)))('the pinned 2.7 GB file streams to the frozen selection', () => {
    const f = JSON.parse(readFileSync(join(ROOT, 'eval/decisions/datasets/lme-m-q1-selection.json'), 'utf8'));
    expect(loadLmeM().selection.selected).toEqual(f.selected);
  }, 300_000);
});

// ─── BEAM-10M ────────────────────────────────────────────────────────

const msg = (role: string, id: number, content: string, extra: Record<string, unknown> = {}) => ({ role, id, content, time_anchor: null, index: '1,1', ...extra });
/** A 10M-shaped chat as a parquet export gives it: one entry per plan, other plans' keys null. */
function tenMChat(opts: { anchors?: boolean; flatPlan2?: boolean } = {}) {
  const anchors = opts.anchors ?? true;
  const plan1 = [
    { batch_number: 1, time_anchor: anchors ? 'March-15-2024' : null, turns: [[msg('user', 0, 'SECRET-TEXT plan one first ->-> 1,1'), msg('assistant', 1, 'reply')], [msg('user', 2, 'second group', anchors ? { time_anchor: 'March-16-2024' } : {}), msg('assistant', 3, 'r')]] },
    { batch_number: 2, time_anchor: null, turns: [[msg('user', 4, 'later', anchors ? { time_anchor: 'April-2-2024' } : {}), msg('assistant', 5, 'r')]] },
  ];
  const plan2 = opts.flatPlan2
    ? [{ batch_number: 1, time_anchor: anchors ? 'May-1-2024' : null, turns: [msg('user', 0, 'flat a'), msg('assistant', 1, 'b'), msg('user', 2, 'flat c ->-> 1,N/A'), msg('assistant', 3, 'd'), msg('assistant', 4, 'e')] }]
    : [{ batch_number: 1, time_anchor: anchors ? 'May-1-2024' : null, turns: [[msg('user', 0, 'plan two'), msg('assistant', 1, 'r')]] }];
  return [{ 'plan-1': plan1, 'plan-2': null }, { 'plan-1': null, 'plan-2': plan2 }];
}

describe('BEAM-10M sessions and dates', () => {
  test('turn groups are sessions; groups inherit batch dates; plan ids restart are counted; markers are stripped', () => {
    const s = beamChatSessions('10m-x', tenMChat());
    expect(s.sessions.map(x => [x.id, x.date])).toEqual([
      ['p1-b1-g0', '2024-03-15T00:00:00'], ['p1-b1-g1', '2024-03-16T00:00:00'], ['p1-b2-g0', '2024-04-02T00:00:00'], ['p2-b1-g0', '2024-05-01T00:00:00']]);
    expect(s.sessions[0].turns[0].content).toBe('SECRET-TEXT plan one first');
    expect(s.structure).toMatchObject({ shape: 'plans', plans: 2, batches: 3, turn_groups: 4, groups_with_time_anchor: 2, batches_with_time_anchor: 3, sessions: 4, synthesized_sessions: 0,
      date_source: 'anchor', sessions_with_own_anchor: 2, sessions_with_batch_anchor: 2, duplicate_message_ids: 2, anchors_monotone: true });
    expect(s.sessionsOfMessage.get(0)).toEqual(['p1-b1-g0', 'p2-b1-g0']);
  });

  test('without groups, sessions are synthesized at message pairs; without dates, one synthetic monotone sequence', () => {
    const s = beamChatSessions('10m-x', tenMChat({ anchors: false, flatPlan2: true }));
    expect(s.sessions.map(x => x.id)).toEqual(['p1-b1-g0', 'p1-b1-g1', 'p1-b2-g0', 'p2-b1-s0', 'p2-b1-s1']);
    expect(s.sessions[4].turns.map(t => t.content)).toEqual(['flat c', 'd', 'e']);
    expect(s.sessions.map(x => x.date)).toEqual([0, 1, 2, 3, 4].map(syntheticDate));
    expect(syntheticDate(1)).toBe('2024-01-01T01:00:00');
    expect(s.structure).toMatchObject({ synthesized_sessions: 2, date_source: 'synthetic', sessions_without_anchor: 5, anchors_monotone: null });
    expect(s.sessionsOfMessage.get(3)).toEqual(['p1-b1-g1', 'p2-b1-s1']);
  });

  test('an undated session keeps no date (partial; the sanitizer dates it) while the rest keep theirs; a 1M-shaped chat keeps loadBeam ids', () => {
    const chat = tenMChat();
    (chat[0]['plan-1'] as Array<{ time_anchor: string | null }>)[0].time_anchor = 'not a date';
    const p = beamChatSessions('x', chat);
    expect(p.structure).toMatchObject({ date_source: 'partial', unparseable_anchors: 1 });
    expect(p.sessions.filter(x => x.date === undefined).length).toBeGreaterThan(0);
    expect(p.sessions.filter(x => x.date !== undefined).length).toBeGreaterThan(0);
    const conv = { id: 'x', sessions: p.sessions } as unknown as Corpus['conversations'][number];
    const plan = new Sanitizer({ conversations: [conv], questions: [] } as unknown as Corpus, 'q1-loaders').ingestPlan(conv);
    expect(plan.filter(s => s.synthetic_time).length).toBe(p.sessions.filter(x => x.date === undefined).length);
    expect(plan.every(s => s.event_time !== null)).toBe(true);
    const oneM = [{ batch_number: 1, time_anchor: 'January-02-2024', turns: [[msg('user', 1, 'a'), msg('assistant', 2, 'b')]] }, { batch_number: 2, turns: [[msg('user', 3, 'c')]] }];
    const s = beamChatSessions('1m-x', oneM);
    expect(s.sessions.map(x => x.id)).toEqual(['b1-g0', 'b2-g0']);
    expect(s.structure).toMatchObject({ shape: 'batches', date_source: 'partial', sessions_without_anchor: 1 });
    expect(s.sessions.map(x => x.date)).toEqual(['2024-01-02T00:00:00', undefined]);
    expect(parseAnchor('March-15-2024')).toBe('2024-03-15T00:00:00');
    expect(parseAnchor('15 Mar 2024')).toBe('2024-03-15T00:00:00');
    expect(parseAnchor('February-30-2024')).toBeNull();
  });
});

/** Build a filled manifest and custody files for two synthetic conversations. */
function custodyRoot(): { root: string; manifestPath: string; questionFiles: string[] } {
  const root = tmp();
  const m = JSON.parse(readFileSync(join(ROOT, 'eval/decisions/datasets/beam-10m-9b20961.json'), 'utf8')) as Beam10mManifest;
  const questionFiles: string[] = [];
  m.conversations = m.conversations.slice(0, 2).map((c, i) => {
    const chat = JSON.stringify({ conversation_id: c.hf_conversation_id, chat: tenMChat({ flatPlan2: i === 1 }) });
    const questions = JSON.stringify({ conversation_id: c.hf_conversation_id, probing_questions: {
      information_extraction: [{ question: 'SEALED-QUESTION what came first?', answer: 'plan one', source_chat_ids: [2], rubric: ['mentions plan one'] }],
      multi_session_reasoning: [{ question: 'SEALED-QUESTION across plans?', ideal_response: 'both', source_chat_ids: { first: [0], second: [4] }, rubric: ['a', 'b'] }],
      abstention: [{ question: 'SEALED-QUESTION unknown?', ideal_response: 'not stated', source_chat_ids: [] }],
    } });
    for (const [p, body] of [[c.chat_path, chat], [c.questions_path, questions]] as const) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
    questionFiles.push(join(root, c.questions_path));
    return { ...c, chat_sha256: sha(chat), chat_bytes: chat.length, questions_sha256: sha(questions), questions_bytes: questions.length };
  });
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ ...m, status: 'filled' }));
  return { root, manifestPath, questionFiles };
}

/** Repository modules a file imports at run time (type-only imports erased), transitively. */
function runtimeImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, 'utf8');
  for (const m of src.matchAll(/^import\s+(?!type\b)(?:[^'"]*?from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const target = resolve(dirname(entry), m[1]);
    if (/\{[^}]*\}/.test(m[0]) && /^import\s*\{\s*(?:type\s+[\w$]+\s*,?\s*)+\}/.test(m[0])) continue;
    runtimeImports(target, seen);
  }
  return seen;
}

describe('BEAM-10M corpus-only loading', () => {
  const entries = ['eval/runner/memory-qa/beam10m-corpus.ts', 'eval/runner/q1/beam10m-structure.ts'].map(p => join(ROOT, p));

  test('the corpus loader and the structure check have no code path to a question file', () => {
    for (const entry of entries) {
      const graph = [...runtimeImports(entry)].map(p => p.slice(ROOT.length + 1));
      expect(graph).not.toContain('eval/runner/memory-qa/corpus.ts');
      expect(graph).not.toContain('eval/runner/memory-qa/beam10m-questions.ts');
      for (const f of graph) expect(readFileSync(join(ROOT, f), 'utf8')).not.toMatch(/questions_path|questions_sha256|probing_questions/);
    }
  });

  test('loads with every question file unreadable, logs each opening, and returns no question text', () => {
    const { root, manifestPath, questionFiles } = custodyRoot();
    for (const f of questionFiles) chmodSync(f, 0o000);
    const log = join(root, 'custody', 'access.ndjson');
    const c = loadBeam10mCorpus({ root, manifestPath, log });
    expect(c.conversations.map(x => x.id)).toEqual(['10m-1', '10m-2']);
    expect(c.structure.map(s => s.synthesized_sessions)).toEqual([0, 2]);
    expect(JSON.stringify(c)).not.toContain('SEALED-QUESTION');
    expect('questions' in c).toBe(false);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.purpose)).toEqual(['beam-10m corpus 10m-1 (no questions)', 'beam-10m corpus 10m-2 (no questions)']);
    for (const f of questionFiles) rmSync(f);
    expect(loadBeam10mCorpus({ root, manifestPath }).conversations.length).toBe(2);
  });

  test('the committed manifest carries the custodian\'s hashes; off the custody host loading refuses and names the custodian step', () => {
    const m = beam10mCorpusManifest();
    expect(m.status).toBe('filled');
    expect(m.conversations.every(c => /^[0-9a-f]{64}$/.test(c.chat_sha256 ?? ''))).toBe(true);
    expect(JSON.stringify(m)).not.toContain('questions');
    const saved = process.env.GBRAIN_EVALS_DATASETS;
    process.env.GBRAIN_EVALS_DATASETS = tmp();
    try { loadBeam10mCorpus({ root: process.env.GBRAIN_EVALS_DATASETS }); throw new Error('loaded'); } catch (e) {
      expect((e as DecideError).op).toMatchObject({ code: 'DATASET_MISSING', fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch', '--write'] } });
    } finally { if (saved === undefined) delete process.env.GBRAIN_EVALS_DATASETS; else process.env.GBRAIN_EVALS_DATASETS = saved; }
  });

  test('a corpus file that differs from its pin refuses', () => {
    const { root, manifestPath } = custodyRoot();
    writeFileSync(join(root, 'beam-10m/9b20961/10m-1/chat.json'), '{"chat":[]}');
    try { loadBeam10mCorpus({ root, manifestPath }); throw new Error('loaded'); } catch (e) { expect((e as DecideError).op.code).toBe('DATASET_HASH_MISMATCH'); }
  });
});

describe('BEAM-10M questions (custodian)', () => {
  test('maps source_chat_ids to sessions, counts ids that repeat across plans, and logs before reading', () => {
    const { root, manifestPath } = custodyRoot();
    const corpus = loadBeam10mCorpus({ root, manifestPath });
    const log = join(root, 'custody', 'access.ndjson');
    const { questions, stats } = loadBeam10mQuestions(corpus, { log, decisionId: 'q1-scoreboard', purpose: 'test' }, { manifestPath, root });
    const q = questions.find(x => x.id === '10m-1:information_extraction:0')!;
    expect(q).toMatchObject({ gold: ['p1-b1-g1'], answer: 'plan one', rubric: ['mentions plan one'], abstention: false });
    expect(questions.find(x => x.id === '10m-1:multi_session_reasoning:0')!.gold.sort()).toEqual(['p1-b1-g0', 'p1-b2-g0', 'p2-b1-g0'].sort());
    expect(questions.find(x => x.id === '10m-1:abstention:0')).toMatchObject({ gold: [], abstention: true, answer: 'not stated' });
    expect(stats).toMatchObject({ questions: 6, ambiguous_gold: 3, unmapped_source_ids: 0 });
    expect(readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).purpose)).toEqual(['beam-10m questions 10m-1: test', 'beam-10m questions 10m-2: test']);
    expect(() => loadBeam10mQuestions(corpus, { log: '', decisionId: 'x', purpose: 'x' }, { manifestPath, root })).toThrow(/custody access log/);
  });

  test('the split is all sealed, matches the manifest, and excludes the exposed abstention question', () => {
    const split = loadSplit('beam-10m');
    expect(split.dev).toEqual([]);
    expect([...split.sealed].sort()).toEqual(beam10mCorpusManifest().conversations.map(c => c.conversation).sort());
    expect(beam10mExclusions()).toEqual([expect.objectContaining({ question: '10m-1:abstention:0', harness_id: '1_abstention_0' })]);
  });
});

describe('BEAM structure check and manifest generator', () => {
  test('structure check prints counts only, on any BEAM chat file; BEAM-10M mode needs custody', async () => {
    const d = tmp();
    const file = join(d, 'chat.json');
    writeFileSync(file, JSON.stringify(tenMChat({ flatPlan2: true })));
    const r = await capture(() => structureMain(['--chat-file', file, '--conversation', 'dev-1', '--json']));
    expect(r.code).toBe(0);
    const [rep] = JSON.parse(r.out);
    expect(rep).toMatchObject({ conversation: 'dev-1', turn_groups: 3, groups_with_time_anchor: 2, sessions: 5, synthesized_sessions: 2, sessions_over_24000_tokens: 0 });
    expect(rep.session_tokens_cl100k.max).toBeGreaterThan(0);
    expect(r.out).not.toContain('SECRET-TEXT');
    const text = await capture(() => structureMain(['--chat-file', file]));
    expect(text.out).not.toContain('SECRET-TEXT');
    const saved = process.env.GBRAIN_EVALS_CUSTODY_LOG;
    delete process.env.GBRAIN_EVALS_CUSTODY_LOG;
    try {
      const refused = await capture(() => structureMain(['--json']));
      expect(refused.code).toBe(3);
      expect(JSON.parse(refused.err).code).toBe('CUSTODY_MISSING');
    } finally { if (saved !== undefined) process.env.GBRAIN_EVALS_CUSTODY_LOG = saved; }
  });

  const fakeShards = (d: string) => ['a', 'b'].map((x, i) => { const p = join(d, `shard-${i}.parquet`); writeFileSync(p, `shard ${x}`); return p; });
  const manifestFor = (paths: string[]): Beam10mManifest => {
    // The unfilled template of the committed manifest: the generator fills it.
    const m = JSON.parse(readFileSync(join(ROOT, 'eval/decisions/datasets/beam-10m-9b20961.json'), 'utf8')) as Beam10mManifest;
    return { ...m, status: 'unfilled', shards: m.shards.map((s, i) => ({ ...s, sha256: null, bytes: readFileSync(paths[i]).length })),
      conversations: m.conversations.map(c => ({ ...c, chat_sha256: null, chat_bytes: null, questions_sha256: null, questions_bytes: null })) } as unknown as Beam10mManifest;
  };
  const fakeExtract = (ids: string[]) => (_shards: string[], out: string) => {
    for (const id of ids) {
      mkdirSync(join(out, `10m-${id}`), { recursive: true });
      writeFileSync(join(out, `10m-${id}`, 'chat.json'), JSON.stringify({ conversation_id: id, chat: tenMChat() }));
      writeFileSync(join(out, `10m-${id}`, 'questions.json'), JSON.stringify({ conversation_id: id, probing_questions: {} }));
    }
    return { rows: ids.length, conversations: ids.map(id => ({ conversation: `10m-${id}`, hf_conversation_id: id, conversation_id_source: 'column' })) };
  };

  test('fill: shard hashes checked against the hub, every output hashed, conversation ids must match', async () => {
    const d = tmp();
    const shards = fakeShards(d);
    const m = manifestFor(shards);
    const hub = Object.fromEntries(m.shards.map((s, i) => [s.path, sha(readFileSync(shards[i]))]));
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const log = join(d, 'access.ndjson');
    const filled = await fillManifest(m, { root: d, hub, log, shardFile: async s => shards[m.shards.indexOf(s)], extract: fakeExtract(ids) });
    expect(filled.status).toBe('filled');
    expect(filled.shards.map(s => s.sha256)).toEqual(Object.values(hub));
    expect(filled.conversations.every(c => /^[0-9a-f]{64}$/.test(c.chat_sha256!) && /^[0-9a-f]{64}$/.test(c.questions_sha256!))).toBe(true);
    expect(filled.extraction.script_sha256).toBe(sha(readFileSync(join(ROOT, 'eval/runner/q1/beam10m_extract.py'))));
    const manifestPath = join(d, 'filled.json');
    writeFileSync(manifestPath, JSON.stringify(filled));
    expect(loadBeam10mCorpus({ root: d, manifestPath, only: new Set(['10m-3']) }).conversations[0].sessions.length).toBe(4);
    await expect(fillManifest(m, { root: d, hub: { ...hub, [m.shards[0].path]: 'f'.repeat(64) }, log, shardFile: async s => shards[m.shards.indexOf(s)], extract: fakeExtract(ids) })).rejects.toThrow(/DATASET_HASH_MISMATCH/);
    await expect(fillManifest(m, { root: d, hub, log, shardFile: async s => shards[m.shards.indexOf(s)], extract: fakeExtract(['0', ...ids.slice(1)]) })).rejects.toThrow(/SPEC_INVALID/);
  });

  test('CLI: status costs nothing; fetch outside custody refuses with the custodian\'s command', async () => {
    const s = await capture(() => manifestMain(['status']));
    expect(JSON.parse(s.out)).toEqual({ status: 'filled', revision: '9b2096193fe74e2837e4713e483351e19817773c', shards: 2, conversations: 10, unfilled: 0 });
    const saved = process.env.GBRAIN_EVALS_CUSTODY_LOG;
    delete process.env.GBRAIN_EVALS_CUSTODY_LOG;
    try {
      const r = await capture(() => manifestMain(['fetch', '--json']));
      expect(r.code).toBe(3);
      expect(JSON.parse(r.err)).toMatchObject({ code: 'CUSTODY_MISSING', fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch', '--write'] } });
    } finally { if (saved !== undefined) process.env.GBRAIN_EVALS_CUSTODY_LOG = saved; }
  });

  const python = process.env.GBRAIN_EVALS_BEAM10M_PYTHON;
  test.skipIf(!python)('the pinned extractor splits a synthetic parquet into corpus and question files the loaders read', async () => {
    const d = tmp();
    const parquet = join(d, 'shard.parquet');
    const rows = [1, 2].map(i => ({ conversation_id: String(i), chat: tenMChat({ anchors: i === 1 }), probing_questions: String(JSON.stringify({ abstention: [{ question: 'SEALED-QUESTION', ideal_response: 'x', source_chat_ids: [] }] })) }));
    writeFileSync(join(d, 'rows.json'), JSON.stringify(rows));
    const make = Bun.spawnSync([python!, '-c', `import json,pyarrow as pa,pyarrow.parquet as pq;rows=json.load(open(${JSON.stringify(join(d, 'rows.json'))}));pq.write_table(pa.Table.from_pylist(rows),${JSON.stringify(parquet)})`]);
    expect(make.exitCode, make.stderr.toString()).toBe(0);
    const out = join(d, 'beam-10m', '9b20961');
    const summary = pythonExtractor([parquet], out);
    expect(summary.conversations.map(c => c.conversation)).toEqual(['10m-1', '10m-2']);
    const chat = JSON.parse(readFileSync(join(out, '10m-1', 'chat.json'), 'utf8'));
    expect(chat.chat[0]['plan-2']).toBeNull();
    expect(readFileSync(join(out, '10m-1', 'chat.json'), 'utf8')).not.toContain('SEALED-QUESTION');
    expect(beamChatSessions('10m-1', chat.chat).sessions.map(s => s.id)).toEqual(beamChatSessions('10m-1', tenMChat()).sessions.map(s => s.id));
    expect(JSON.parse(readFileSync(join(out, '10m-2', 'questions.json'), 'utf8')).probing_questions.abstention.length).toBe(1);
  }, 60_000);
});

// ─── Outcomes and answer records shared with answering cells ────────

describe('answering outcomes', () => {
  test('does_not_fit is not applicable; turn_cap and context_overflow are product failures; none is retried', () => {
    expect(NOT_APPLICABLE.has('does_not_fit')).toBe(true);
    expect(PRODUCT_FAILURES.has('does_not_fit') || HARNESS_FAILURES.has('does_not_fit')).toBe(false);
    expect(PRODUCT_FAILURES.has('turn_cap') && PRODUCT_FAILURES.has('context_overflow')).toBe(true);
    const manifest: Manifest = { kind: 'memory-qa-manifest', schema_version: 1, run_config_hash: 'h', expected: ['a', 'b', 'c', 'd'], expected_sha256: 'x', created_at: '' };
    const c = canonicalize(manifest, [{ id: 'a', outcome: 'does_not_fit' }, { id: 'b', outcome: 'turn_cap' }, { id: 'c', outcome: 'context_overflow' }, { id: 'd', outcome: 'retrieval_error' }]);
    expect([...c.pending]).toEqual(['d']);
    expect(c.counts).toMatchObject({ does_not_fit: 1, turn_cap: 1, context_overflow: 1, retrieval_error: 1 });
  });

  test('an answering agent\'s answer becomes a valid answer record with its stop reason, turns and opened sources', () => {
    const agent: AgentAnswer = { text: '', stop_reason: 'turn_cap', outcome: 'turn_cap', usage: { input: 50_000, output: 900, cache_read: 40_000, cache_write: 0 }, provider_input_tokens: 90_000, latency_ms: 81_000, turns: 40, usd: 0.21, opened_source_ids: ['src-1', 'src-9'] };
    const payload: AnswerPayload = agent;
    const rec = answerRecord({ cell_id: 'cell', realization_id: 'r', question_id: 'q', conversation: 'c', system: 'baseline-file-agent', arm: 'agent', reader: 'anthropic:claude-sonnet-5-5', replicate: 0, effort: 'medium', context_sha256: 'b'.repeat(64) }, { ...payload, error: 'x' });
    expect(answerProblems(rec)).toEqual([]);
    expect(rec).toMatchObject({ stop_reason: 'turn_cap', turns: 40, opened_source_ids: ['src-1', 'src-9'], outcome: 'turn_cap' });
    expect('error' in rec).toBe(false);
  });
});
