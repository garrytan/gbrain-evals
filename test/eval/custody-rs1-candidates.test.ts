/**
 * RS1 fix B (GST-1886): fifteen planned batches and selection from validated candidates. Covers
 * eval/custody/rs1/validate-candidates.ts, mint.sh --until and --candidates, rs1_mint.py's select from a candidate report,
 * and its plan and question steps with BEAM's num_batches replaced. Keyless: mint.sh runs in --fake mode, the validators
 * are fakes, BEAM is a stub namespace, and nothing reaches a provider. The seeds here are test seeds made at run time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { encodingCount } from '../../eval/runner/systems/render-v2.ts';
import { readBeamPaths } from '../../eval/custody/rs1/beam-paths.ts';
import { BudgetExceededError, BudgetRun, initLedger, installPaidRequestGuard, readLedger } from '../../eval/runner/budget-ledger.ts';
import {
  planCandidates, recordingAnthropicClient, recordingGeminiClient, validateCandidates, writeCandidateReport, type CandidateReport, type StopRecord,
} from '../../eval/custody/rs1/validate-candidates.ts';
import {
  ABILITIES, ANSWER_FIELD, SLOTS, VALIDATOR_IDS, anthropicClient, buildPublicIndex, fakeClient, geminiClient, validateSet, writeReport,
  type Ability, type ModelClient, type Options, type PublicIndex,
} from '../../eval/custody/rs1/validate.ts';

const REPO = resolve(import.meta.dir, '../..');
const RS1 = join(REPO, 'eval/custody/rs1');
const MINT = join(RS1, 'mint.sh');
const CANDIDATES = join(RS1, 'validate-candidates.ts');
const SECRET = 'sealedtext';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const seedLine = (name: string) => ['rs1', 'seed', 'v1'].join('-') + ':' + sha(name);
const word = (seed: string, i: number) => 'w' + sha(`${seed}/${i}`).slice(0, 7);
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => word(seed, i)).join(' ');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `rs1-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', PYTHONDONTWRITEBYTECODE: '1', ...env }, timeout: 240_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** custody-rs1.test.ts's BEAM-shaped public tree: public topics, and a chat and questions file per listed dev conversation. */
const PASSAGE = words('public-passage', 400);
const PUBLIC_QUESTION = 'Which public dataset question appears in the BEAM release?';
const BEAM_LIST = readBeamPaths().paths;
const PUBLIC_CHAT = BEAM_LIST.find(p => p.startsWith('chats/1M/') && p.endsWith('/chat.json'))!;
function fakeBeam(root: string): string {
  const beam = join(root, 'beam');
  const write = (rel: string, value: unknown) => { mkdirSync(dirname(join(beam, rel)), { recursive: true }); writeFileSync(join(beam, rel), JSON.stringify(value)); };
  const chat = (seed: string, passage = '') => [{ batch_number: 1, time_anchor: 'x', turns: Array.from({ length: 10 }, (_, i) => [{ role: 'user', id: 2 * i, content: i === 3 && passage ? passage : words(`${seed}-u${i}`, 60) }, { role: 'assistant', id: 2 * i + 1, content: words(`${seed}-a${i}`, 60) }]) }];
  write('topics/1M/1M_topics.json', ['Coding', 'Math', 'Cooking'].map((category, i) => ({ id: i + 1, category, title: `Public ${category} topic`, theme: `Public theme ${i}`, subtopics: ['a', 'b', 'c'] })));
  for (const rel of BEAM_LIST.filter(p => p.startsWith('chats/'))) {
    if (rel.endsWith('/chat.json') || rel.endsWith('/chat_trunecated.json')) write(rel, chat(`public-${rel}`, rel === PUBLIC_CHAT ? PASSAGE : ''));
    else write(rel, dirname(dirname(rel)) === dirname(PUBLIC_CHAT) ? { information_extraction: [{ question: PUBLIC_QUESTION, answer: 'x', rubric: ['y'] }] } : {});
  }
  return beam;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) files(p, out); else out.push(p); }
  return out;
}
/** Topic, item and chat text a custody tree holds, as probes of at least 16 characters, plus the seed. */
function sealedProbes(setDir: string, seed: string): string[] {
  const probes = new Set<string>([seed, seed.split(':')[1]]);
  for (const path of files(join(setDir, 'conversations'))) {
    const rel = relative(setDir, path);
    if (!/(topic|chat|probing_questions|rubric|topic-attempts)/.test(rel) || !path.endsWith('.json')) continue;
    for (const s of strings(readJson(path))) if (s.length >= 16) probes.add(s.slice(0, 48));
  }
  return [...probes];
}
const leaks = (output: string, probes: string[]) => probes.filter(p => output.includes(p)).length;

/** A validator that counts its calls by kind: support prompts carry <turns>, absence prompts <conversation_part>. */
function counting(inner: ModelClient) {
  const calls = { support: 0, absence: 0 };
  return { id: inner.id, calls, complete: (p: string, m: number) => { calls[p.includes('<conversation_part>') ? 'absence' : 'support']++; return inner.complete(p, m); } };
}
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a) + a.length, s.indexOf(b));
/** fakeClient, except that it finds no support for the questions in reject and answers the abstention questions in it. */
function picky(id: string, reject: Set<string>): ModelClient {
  const inner = fakeClient(id);
  return {
    id,
    async complete(prompt, max) {
      if (prompt.includes('<conversation_part>')) {
        const reply = JSON.parse(await inner.complete(prompt, max)) as { answered: number[] };
        between(prompt, '<questions>', '</questions>').trim().split('\n').forEach((line, i) => { if (reject.has(line.replace(/^\d+\.\s*/, ''))) reply.answered.push(i + 1); });
        return JSON.stringify(reply);
      }
      return reject.has(between(prompt, '<question>', '</question>')) ? '{"supported": false}' : inner.complete(prompt, max);
    },
  };
}

/** rs1_mint.py's flatten_candidates over a candidate file. */
function flatten(value: unknown, path: number[] = [], out: Array<[string, Record<string, unknown>]> = []): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, [...path, i], out));
  else if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).question === 'string') out.push([path.join('.') || '0', value as Record<string, unknown>]);
  return out;
}
const hmac = (key: Buffer, label: string) => createHmac('sha256', key).update(label).digest();
/** An ability's candidate keys in the order rs1_mint.py's select step ranks them: HMAC of the conversation seed. */
function seedOrder(seedName: string, index: number, ability: string, keys: string[]): string[] {
  const conv = hmac(Buffer.from(sha(seedName), 'hex'), `rs1/conversation/${index}`);
  return [...keys].sort((a, b) => Buffer.compare(hmac(conv, `select/${ability}/${a}`), hmac(conv, `select/${ability}/${b}`)));
}
const candidatesOf = (set: string, cid: string, ability: string) => flatten(readJson(join(set, 'conversations', cid, 'beam/1/probing_questions', ability, `${ability}.json`)));
const selection = (set: string, cid: string, n: number) => readJson(join(set, 'conversations', cid, 'selection', `${n}.json`)).slots as Record<string, string | null>;
const manifestSteps = (set: string, cid: string) => readJson(join(set, 'conversations', cid, 'manifest.json')).steps as Record<string, Record<string, unknown>>;

const FAKE_LENGTH = { targetTokens: 30_000, tolerance: 0.5, windowTokens: 4000, overlapTokens: 400 };

// ─── mint.sh --fake through probe, validate-candidates.ts, mint.sh --candidates, validate.ts ───────────

describe('validated candidates end to end (mint.sh --fake)', () => {
  const SEED = 'test seed candidates';
  let root = '', beam = '', seedFile = '', out = '', set = '';
  const mint = (dir: string, extra: string[] = [], count = '2') => run('bash', [MINT, '--fake', '--beam-dir', beam, '--out', dir, '--seed-file', seedFile, '--count', count, ...extra]);
  const options = (setDir: string, extra: Partial<Options> = {}): Options => ({ setDir, beamDir: beam, reportPath: join(root, 'unused.json'), cacheDir: join(dirname(setDir), 'validate-cache'), concurrency: 4, ...FAKE_LENGTH, ...extra });
  let probed: ReturnType<typeof run>;

  beforeAll(() => {
    root = scratch('candidates');
    beam = fakeBeam(root);
    mkdirSync(join(root, 'keys'));
    seedFile = join(root, 'keys/c.rs1-seed');
    writeFileSync(seedFile, seedLine(SEED) + '\n', { mode: 0o600 });
    out = join(root, 'rs1-custody-c');
    set = join(out, 'set');
    probed = mint(out, ['--until', 'probe']);
  }, 600_000);

  test('mint.sh --until probe stops each conversation after its probe step and counts it as awaiting candidates', () => {
    expect(probed.code).toBe(0);
    for (const line of probed.all.trim().split('\n')) expect(line).toMatch(/^rs1-mint( [a-z0-9_]+=[^ ]*)+$/);
    expect(probed.out).toContain('summary=mint mode=fake conversations=2 complete=0 ');
    expect(probed.out).toContain(' until=probe stopped=2 awaiting_candidates=2');
    for (const cid of ['c001', 'c002']) {
      const steps = manifestSteps(set, cid);
      expect(steps['probe@1'].status).toBe('done');
      expect(Object.keys(steps).filter(k => /^(select|rubric)@/.test(k))).toEqual([]);
    }
    const bad = mint(join(root, 'rs1-custody-bad-until'), ['--until', 'topic_check']);
    expect([bad.code, bad.err]).toEqual([2, 'rs1-mint refused: --until names a step of: plan question answer chat_json truncate probe select rubric\n']);
  });

  test('select takes only candidates both validators passed, the first passed ones in seed order, and validate.ts then buys no support call again', async () => {
    const rejectAbilities: Record<string, Ability[]> = { c001: ['knowledge_update', 'abstention'], c002: ['summarization', 'abstention'] };
    const rejected = new Map<string, Set<string>>();
    const reject = new Set<string>();
    for (const [cid, abilities] of Object.entries(rejectAbilities)) {
      rejected.set(cid, new Set());
      for (const ability of abilities) {
        const pool = candidatesOf(set, cid, ability);
        const first = seedOrder(SEED, Number(cid.slice(1)), ability, pool.map(([k]) => k))[0];
        rejected.get(cid)!.add(`${ability}/${first}`);
        reject.add(pool.find(([k]) => k === first)![1].question as string);
      }
    }
    const first = [counting(picky(VALIDATOR_IDS[0], reject)), counting(fakeClient(VALIDATOR_IDS[1]))];
    const report = await validateCandidates(options(set), first);
    for (const [cid, keys] of rejected) {
      const conv = report.conversations[cid];
      expect(conv.status).toBe('checked');
      expect(Object.keys(conv.candidates)).toHaveLength(ABILITIES.length * 4);
      for (const [key, result] of Object.entries(conv.candidates)) {
        const gate = key.startsWith('abstention/') ? 'absence' : 'support';
        expect([key, result]).toEqual([key, keys.has(key) ? { pass: false, gates: [`${gate}:${VALIDATOR_IDS[0]}`] } : { pass: true, gates: [] }]);
      }
      expect(conv.passed).toEqual(Object.fromEntries(ABILITIES.map(a => [a, rejectAbilities[cid].includes(a) ? 3 : 4])));
    }
    expect(report.totals).toMatchObject({ conversations: 2, checked: 2, fillable: 2, candidates: 80, pass: 76, fail: 4, support_calls: 144, validator_errors: 0 });
    expect(first[0].calls.support).toBe(72);
    expect(first[0].calls.absence).toBe(report.totals.windows);
    const reportPath = join(out, 'validation/candidates.json');
    writeCandidateReport(reportPath, report);

    const selected = mint(out, ['--candidates', reportPath]);
    expect(selected.code).toBe(0);
    expect(selected.out).toContain('summary=mint mode=fake conversations=2 complete=2 ');
    expect(selected.out).toContain(' until=none stopped=0 awaiting_candidates=0');
    for (const [cid, keys] of rejected) {
      const slots = selection(set, cid, 1);
      for (const ability of ABILITIES) {
        const order = seedOrder(SEED, Number(cid.slice(1)), ability, candidatesOf(set, cid, ability).map(([k]) => k));
        const passed = order.filter(k => !keys.has(`${ability}/${k}`));
        expect([ability, slots[`${ability}#0`], slots[`${ability}#1`]]).toEqual([ability, passed[0], passed[1]]);
      }
      for (const key of keys) expect(Object.entries(slots).some(([s, k]) => `${s.split('#')[0]}/${k}` === key)).toBe(false);
      expect(manifestSteps(set, cid)['select@1'].candidates_sha256).toBe(sha(readFileSync(reportPath)));
    }

    const last = [counting(fakeClient(VALIDATOR_IDS[0])), counting(fakeClient(VALIDATOR_IDS[1]))];
    const validated = await validateSet(options(set), last);
    expect(Object.values(validated.conversations).map(c => c.status)).toEqual(['keep', 'keep']);
    expect(validated.totals).toMatchObject({ items: 40, pass: 40 });
    expect(last.map(c => c.calls.support)).toEqual([0, 0]);
    expect(last.map(c => c.calls.absence)).toEqual([validated.totals.windows, validated.totals.windows]);
    expect(validated.totals.cached_calls).toBe(72);
    for (const cid of ['c001', 'c002']) {
      expect(validated.conversations[cid].tokens).toBe(report.conversations[cid].tokens);
      expect(validated.conversations[cid].contamination_share).toBe(report.conversations[cid].contamination_share);
      expect(validated.conversations[cid].chat_sha256).toBe(report.conversations[cid].chat_sha256);
    }
  }, 300_000);

  test('the --fake CLI prints counts and hashes only, and its report holds ids, keys, gates and numbers, no text', () => {
    const reportPath = join(out, 'validation/cli-candidates.json');
    const r = run('bun', [CANDIDATES, '--set', set, '--beam-dir', beam, '--report', reportPath, '--cache', join(out, 'cli-cache'), '--fake',
      '--target-tokens', '30000', '--tolerance', '0.5', '--window-tokens', '4000', '--overlap-tokens', '400']);
    expect(r.code).toBe(0);
    for (const line of r.all.trim().split('\n')) expect(line).toMatch(/^rs1-validate-candidates( [a-z0-9_]+=[^ ]*)+$/);
    expect(r.out).toContain('rs1-validate-candidates conversations=2 checked=2 drop=0 incomplete=0 unfinished=0 drop_length=0 drop_contamination=0 fillable=2');
    expect(r.out).toContain('rs1-validate-candidates candidates=80 pass=80 fail=0');
    expect(r.out).toContain(`report_sha256=${sha(readFileSync(reportPath))}`);
    const report = readJson(reportPath) as CandidateReport;
    expect(report.schema).toBe('rs1-candidates/v1');
    expect(report.validators).toEqual(VALIDATOR_IDS.map(id => `fake-${id}`));
    const probes = sealedProbes(set, seedLine(SEED));
    expect(probes.length).toBeGreaterThan(100);
    expect(leaks(r.all, probes)).toBe(0);
    expect(leaks(readFileSync(reportPath, 'utf8'), probes)).toBe(0);
  });

  test('select refuses a report that read another chat, holds the conversation as incomplete, lacks it or is not a candidate report', async () => {
    const dir = join(root, 'rs1-custody-refuse');
    const refuseSet = join(dir, 'set');
    expect(mint(dir, ['--until', 'probe'], '1').code).toBe(0);
    const good = await validateCandidates(options(refuseSet), [fakeClient(VALIDATOR_IDS[0]), fakeClient(VALIDATOR_IDS[1])]);
    expect(good.conversations.c001.status).toBe('checked');
    const variant = (name: string, change: (r: any) => void) => { const r = structuredClone(good) as any; change(r); const path = join(root, `${name}.json`); writeFileSync(path, JSON.stringify(r)); return path; };
    const cases: Array<[string, (r: any) => void, string]> = [
      ['foreign', r => { r.conversations.c001.chat_sha256 = sha('another chat'); }, 'the candidate report read another chat than this conversation\'s'],
      ['incomplete', r => { r.conversations.c001.status = 'incomplete'; }, 'the candidate report has c001 as incomplete, not checked or drop'],
      ['missing', r => { delete r.conversations.c001; }, 'the candidate report has c001 as absent, not checked or drop'],
      ['validation', r => { r.schema = 'rs1-validation/v1'; }, '--candidates names no validate-candidates.ts report'],
    ];
    for (const [name, change, why] of cases) {
      const r = mint(dir, ['--candidates', variant(name, change)], '1');
      expect([name, r.code]).toEqual([name, 1]);
      expect(r.err).toContain(`rs1-mint refused: ${why}`);
      expect(existsSync(join(refuseSet, 'conversations/c001/selection/1.json'))).toBe(false);
    }
    expect(mint(dir, ['--candidates', join(root, 'no-such-report.json')], '1')).toMatchObject({ code: 2, err: 'rs1-mint refused: --candidates names no file\n' });
  }, 300_000);

  test('a conversation the candidate report drops selects nothing, and validate.ts drops it on the same gate', async () => {
    const dir = join(root, 'rs1-custody-drop');
    const dropSet = join(dir, 'set');
    expect(mint(dir, ['--until', 'probe'], '1').code).toBe(0);
    const clients = [counting(fakeClient(VALIDATOR_IDS[0])), counting(fakeClient(VALIDATOR_IDS[1]))];
    const report = await validateCandidates(options(dropSet, { targetTokens: 1000, tolerance: 0.15 }), clients);
    expect(report.conversations.c001).toMatchObject({ status: 'drop', reasons: ['length'], passed: Object.fromEntries(ABILITIES.map(a => [a, 0])) });
    expect(report.conversations.c001.candidates).toEqual({});
    expect(clients.map(c => c.calls.support + c.calls.absence)).toEqual([0, 0]);
    const reportPath = join(dir, 'validation/candidates.json');
    writeCandidateReport(reportPath, report);
    const r = mint(dir, ['--candidates', reportPath], '1');
    expect(r.code).toBe(0);
    expect(Object.values(selection(dropSet, 'c001', 1)).every(k => k === null)).toBe(true);
    expect(manifestSteps(dropSet, 'c001')['select@1'].empty_slots).toBe(20);
    const validated = await validateSet(options(dropSet, { targetTokens: 1000, tolerance: 0.15 }), [fakeClient(VALIDATOR_IDS[0]), fakeClient(VALIDATOR_IDS[1])]);
    expect(validated.conversations.c001).toMatchObject({ status: 'drop', reasons: ['length'] });
  }, 300_000);

  test('a selection made before candidates were validated regenerates from passed candidates only, keeping the slots that passed', async () => {
    const dir = join(root, 'rs1-custody-legacy');
    const legacySet = join(dir, 'set');
    expect(mint(dir, [], '1').code).toBe(0);
    const before = selection(legacySet, 'c001', 1);
    const target = 'information_extraction';
    const pool = candidatesOf(legacySet, 'c001', target);
    const order = seedOrder(SEED, 1, target, pool.map(([k]) => k));
    expect([before[`${target}#0`], before[`${target}#1`]]).toEqual([order[0], order[1]]);
    const question = (key: string) => pool.find(([k]) => k === key)![1].question as string;
    const validation = await validateSet(options(legacySet), [picky(VALIDATOR_IDS[0], new Set([question(order[0])])), fakeClient(VALIDATOR_IDS[1])]);
    expect(validation.conversations.c001.status).toBe('regenerate');
    const validationPath = join(dir, 'validation/report-1.json');
    writeReport(validationPath, validation);
    const candidates = await validateCandidates(options(legacySet), [picky(VALIDATOR_IDS[0], new Set([question(order[0]), question(order[2])])), fakeClient(VALIDATOR_IDS[1])]);
    const candidatesPath = join(dir, 'validation/candidates.json');
    writeCandidateReport(candidatesPath, candidates);
    const r = mint(dir, ['--candidates', candidatesPath, '--regenerate', validationPath], '1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('step=select status=done attempt=2 ');
    const after = selection(legacySet, 'c001', 2);
    for (const slot of SLOTS) expect([slot, after[slot]]).toEqual([slot, slot === `${target}#0` ? order[3] : before[slot]]);
    const revalidated = await validateSet(options(legacySet), [fakeClient(VALIDATOR_IDS[0]), fakeClient(VALIDATOR_IDS[1])]);
    expect(revalidated.conversations.c001).toMatchObject({ status: 'keep', select_attempt: 2 });
  }, 300_000);
});

// ─── validate-candidates.ts gates on synthetic sets ──────────────────

interface ProbedConversation { messages: string[]; candidates: Record<string, Array<Record<string, unknown>>>; probed?: boolean }

/** n messages and three candidates per ability: the answers sit in the turns they cite, the abstention nonces nowhere. */
function probedConversation(seed: string, n = 60): ProbedConversation {
  const messages = Array.from({ length: n }, (_, i) => words(`${seed}/m${i}`, 40));
  const candidates: ProbedConversation['candidates'] = {};
  let planted = 0;
  for (const ability of ABILITIES) {
    candidates[ability] = [0, 1, 2].map(k => {
      if (ability === 'abstention') return { question: `What did I decide about nonce-${sha(`${seed}/${k}`).slice(0, 10)}?`, ideal_response: 'The chat holds no information about that.' };
      const fact = `fact ${words(`${seed}/${ability}/${k}/fact`, 5)}`, at = 2 + 2 * planted++;
      messages[at] += ` ${fact}`;
      return { question: `${words(`${seed}/${ability}/${k}/q`, 8)}?`, [ANSWER_FIELD[ability]]: fact, source_chat_ids: [at] };
    });
  }
  return { messages, candidates };
}

/** A set as mint.sh leaves it: probed, and with the first two candidates of each ability selected, so validate.ts reads it too. */
function writeProbedSet(root: string, conversations: ProbedConversation[]): string {
  const set = join(root, 'set');
  rmSync(set, { recursive: true, force: true });
  conversations.forEach((conv, i) => {
    const dir = join(set, 'conversations', `c${String(i + 1).padStart(3, '0')}`);
    mkdirSync(join(dir, 'beam/1'), { recursive: true });
    mkdirSync(join(dir, 'rubric/1'), { recursive: true });
    const steps = { 'probe@1': { status: conv.probed === false ? 'running' : 'done' }, 'select@1': { status: 'done' }, 'rubric@1': { status: 'done' } };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ steps }));
    const slots: Record<string, string> = {};
    for (const ability of ABILITIES) {
      mkdirSync(join(dir, 'beam/1/probing_questions', ability), { recursive: true });
      writeFileSync(join(dir, 'beam/1/probing_questions', ability, `${ability}.json`), JSON.stringify(conv.candidates[ability]));
      for (const n of [0, 1]) {
        slots[`${ability}#${n}`] = String(n);
        writeFileSync(join(dir, 'rubric/1', `${ability}#${n}.json`), JSON.stringify({ candidate: String(n), item: conv.candidates[ability][n] }));
      }
    }
    mkdirSync(join(dir, 'selection'), { recursive: true });
    writeFileSync(join(dir, 'selection/1.json'), JSON.stringify({ attempt: 1, slots, failed: [] }));
    const turns = [];
    for (let id = 0; id < conv.messages.length; id += 2) turns.push(conv.messages.slice(id, id + 2).map((content, j) => ({ role: j ? 'assistant' : 'user', id: id + j, content })));
    writeFileSync(join(dir, 'beam/1/chat.json'), JSON.stringify([{ batch_number: 1, time_anchor: 'x', turns }]));
  });
  return set;
}

describe('validate-candidates.ts gates', () => {
  let root = '', beam = '', index: PublicIndex;
  const options = (set: string, extra: Partial<Options> = {}): Options => ({ setDir: set, beamDir: beam, reportPath: join(root, 'report.json'), targetTokens: 1_000_000, tolerance: 0.9999, windowTokens: 600, overlapTokens: 60, concurrency: 4, ...extra });
  const fakes = () => [counting(fakeClient(VALIDATOR_IDS[0])), counting(fakeClient(VALIDATOR_IDS[1]))];
  beforeAll(() => { root = scratch('candidate-gates'); beam = fakeBeam(root); index = buildPublicIndex(beam); });

  test('both validators are asked about every candidate, and each window asks about every abstention candidate at once', async () => {
    const clients = fakes();
    const report = await validateCandidates(options(writeProbedSet(root, [probedConversation('clean')])), clients, index);
    const c = report.conversations.c001;
    expect(c.status).toBe('checked');
    expect(Object.keys(c.candidates).sort()).toEqual(ABILITIES.flatMap(a => [0, 1, 2].map(k => `${a}/${k}`)).sort());
    expect(Object.values(c.candidates).every(r => r.pass)).toBe(true);
    expect(c.passed).toEqual(Object.fromEntries(ABILITIES.map(a => [a, 3])));
    expect(c.windows).toBeGreaterThan(2);
    for (const client of clients) expect(client.calls).toEqual({ support: 27, absence: c.windows });
    expect(report.totals).toMatchObject({ checked: 1, fillable: 1, calls: 2 * (27 + c.windows), support_calls: 54, absence_calls: 2 * c.windows });
  });

  test('a public question, an uncited answer, an unsupported answer and an answered abstention question each fail their own candidate', async () => {
    const conv = probedConversation('gates', 120);
    conv.candidates.information_extraction[0].question = PUBLIC_QUESTION;
    conv.candidates.event_ordering[1].source_chat_ids = [9999];
    const nonce = /nonce-[0-9a-f]+/.exec(String(conv.candidates.abstention[1].question))![0];
    conv.messages[77] += ` I decided on ${nonce} after all.`;
    const blind = String(conv.candidates.knowledge_update[2].answer);
    const halfBlind: ModelClient = { id: VALIDATOR_IDS[1], complete: async (p, m) => (p.includes(`<answer>${blind}</answer>`) ? '{"supported": false}' : fakeClient(VALIDATOR_IDS[1]).complete(p, m)) };
    const clients = [counting(fakeClient(VALIDATOR_IDS[0])), counting(halfBlind)];
    const report = await validateCandidates(options(writeProbedSet(root, [conv])), clients, index);
    const c = report.conversations.c001;
    const failed = Object.fromEntries(Object.entries(c.candidates).filter(([, r]) => !r.pass).map(([k, r]) => [k, r.gates]));
    expect(failed).toEqual({
      'information_extraction/0': ['contamination'], 'event_ordering/1': ['uncited'], 'knowledge_update/2': [`support:${VALIDATOR_IDS[1]}`],
      'abstention/1': VALIDATOR_IDS.map(id => `absence:${id}`),
    });
    expect(c.status).toBe('checked');
    expect(c.passed).toMatchObject({ information_extraction: 2, event_ordering: 2, knowledge_update: 2, abstention: 2, summarization: 3 });
    expect(clients[0].calls).toEqual({ support: 25, absence: c.windows });
    expect(report.totals).toMatchObject({ gate_contamination: 1, gate_uncited: 1, gate_support: 1, gate_absence: 2 });
  });

  test('the length and contamination gates drop a conversation before any call, with validate.ts\'s numbers for the same chat', async () => {
    const dirty = probedConversation('dirty');
    dirty.messages[41] = PASSAGE.split(' ').slice(0, 120).join(' ');
    const set = writeProbedSet(root, [probedConversation('long'), dirty]);
    const tokens = probedConversation('long').messages.reduce((s, m) => s + encodingCount('cl100k_base', m), 0);
    const opts = options(set, { targetTokens: Math.round(tokens * 1.5), tolerance: 0.2 });
    const clients = fakes();
    const report = await validateCandidates(opts, clients, index);
    const validated = await validateSet(opts, fakes(), index);
    expect(report.conversations.c001).toMatchObject({ status: 'drop', reasons: ['length'], tokens });
    expect(report.conversations.c002).toMatchObject({ status: 'drop', reasons: expect.arrayContaining(['contamination']) });
    expect([report.conversations.c001.candidates, report.conversations.c002.candidates]).toEqual([{}, {}]);
    expect(report.conversations.c002.contamination_share!).toBeGreaterThan(0.01);
    for (const cid of ['c001', 'c002']) {
      expect(report.conversations[cid].tokens).toBe(validated.conversations[cid].tokens);
      expect(report.conversations[cid].contamination_share).toBe(validated.conversations[cid].contamination_share);
      expect(validated.conversations[cid].status).toBe('drop');
    }
    expect(clients.map(c => c.calls)).toEqual([{ support: 0, absence: 0 }, { support: 0, absence: 0 }]);
    expect(report.totals).toMatchObject({ drop: 2, drop_length: 2, drop_contamination: 1, fillable: 0 });
  });

  test('a validator error leaves the conversation incomplete, and a rerun asks only what it has no cached reply for', async () => {
    const set = writeProbedSet(root, [probedConversation('err'), { ...probedConversation('busy'), probed: false }]);
    const cacheDir = join(root, 'cache');
    let broken = true;
    const flaky: ModelClient = { id: VALIDATOR_IDS[0], complete: async (p, m) => { if (broken && p.includes('<question>')) throw new Error('HTTP 503'); return fakeClient(VALIDATOR_IDS[0]).complete(p, m); } };
    const first = await validateCandidates(options(set, { cacheDir }), [flaky, fakeClient(VALIDATOR_IDS[1])], index);
    expect(first.conversations.c001).toMatchObject({ status: 'incomplete', reasons: ['validator_error'] });
    expect(first.conversations.c002).toMatchObject({ status: 'unfinished', reasons: ['unfinished'], chat_sha256: null });
    expect(first.conversations.c002.candidates).toEqual({});
    expect(first.totals).toMatchObject({ validator_errors: 27, incomplete: 1, unfinished: 1 });
    broken = false;
    const clients = [counting(flaky), counting(fakeClient(VALIDATOR_IDS[1]))];
    const second = await validateCandidates(options(set, { cacheDir }), clients, index);
    expect(second.conversations.c001.status).toBe('checked');
    expect(clients.map(c => c.calls)).toEqual([{ support: 27, absence: 0 }, { support: 0, absence: 0 }]);
    expect(second.totals.cached_calls).toBe(second.totals.calls - 27);
  });

  test('refuses two validators from one family', async () => {
    const set = writeProbedSet(root, [probedConversation('family')]);
    await expect(validateCandidates(options(set), [fakeClient(VALIDATOR_IDS[0]), fakeClient('gemini:gemini-3.7-flash')], index)).rejects.toThrow('different families');
  });

  test('the CLI refuses without exactly one of --fake and --paid, and a paid run without its window, before any request', () => {
    const set = writeProbedSet(root, [probedConversation('cli')]);
    const env = { GEMINI_API_KEY: 'test-gemini-key-not-real', ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', BRAINBENCH_BUDGET_LEDGER: join(root, 'ledger.sqlite') };
    const base = [CANDIDATES, '--set', set, '--beam-dir', beam, '--report', join(root, 'cli-report.json')];
    for (const args of [base, [...base, '--paid'], [...base, '--fake', '--paid']]) {
      const r = run('bun', args, env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^rs1-validate-candidates refused: /);
      expect(r.all).not.toContain('not-real');
    }
    expect(existsSync(join(root, 'cli-report.json'))).toBe(false);
  });
});

// ─── validate-candidates.ts stop reasons (GST-1886, 2026-11-12) ──────

describe('validate-candidates.ts stop reasons', () => {
  let root = '', beam = '', index: PublicIndex;
  beforeAll(() => { root = scratch('candidate-stops'); beam = fakeBeam(root); index = buildPublicIndex(beam); });
  const KEY = 'test-key-not-real';
  const PROMPT = 'prompt ' + words('stop-prompt', 30);

  /** Runs body with a ledger guard whose sender is send, and returns the requests the guard passed on and its entries. */
  async function guarded<T>(send: (url: string, init: RequestInit) => unknown | Promise<unknown>, body: () => Promise<T>) {
    const ledgerPath = join(mkdtempSync(join(root, 'ledger-')), 'l.sqlite');
    initLedger({ ledgerPath, programCapUsd: 5 });
    const run = BudgetRun.open({ runner: 'rs1-stop-test', budgetUsd: 5, ledgerPath });
    const sent: Array<{ url: string; headers: unknown; body: unknown }> = [];
    const guard = installPaidRequestGuard(run, { fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push({ url: String(input), headers: init.headers, body: JSON.parse(String(init.body)) });
      const reply = await send(String(input), init);
      return reply instanceof Response ? reply : Response.json(reply);
    }) as unknown as typeof fetch });
    let result: T | Error;
    try { result = await body(); } catch (error) { result = error as Error; } finally { guard.uninstall(); run.close(); }
    return { result, sent, entries: readLedger(ledgerPath).entries.map(e => ({ reserved_usd: e.reserved_usd, actual_usd: e.actual_usd, status: e.status })) };
  }

  const anthropicReplies: Array<[unknown, StopRecord]> = [
    [{ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"answered": [' }, { type: 'text', text: '2]}' }], stop_reason: 'end_turn', usage: { input_tokens: 90, output_tokens: 12 } },
      { stop: 'end_turn', output_tokens: 12, blocks: ['text', 'thinking'] }],
    [{ content: [], stop_reason: 'end_turn', usage: { input_tokens: 90, output_tokens: 0 } }, { stop: 'end_turn', output_tokens: 0, blocks: [] }],
    [{ content: [], stop_reason: 'refusal', usage: { input_tokens: 90, output_tokens: 3 } }, { stop: 'refusal', output_tokens: 3, blocks: [] }],
    [{ stop_reason: 'stopped because of sealed text', usage: { input_tokens: 90 } }, { stop: 'other', output_tokens: null, blocks: [] }],
  ];
  const geminiReplies: Array<[unknown, StopRecord]> = [
    [{ candidates: [{ content: { parts: [{ thought: true, text: 'x' }, { text: '{"supported": true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 7 } },
      { stop: 'STOP', output_tokens: 7, blocks: ['text', 'thought'] }],
    [{ candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 0 } }, { stop: 'MAX_TOKENS', output_tokens: 0, blocks: [] }],
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 90 } }, { stop: 'blocked_PROHIBITED_CONTENT', output_tokens: null, blocks: [] }],
    [{ usageMetadata: { promptTokenCount: 90 } }, { stop: 'no_candidate', output_tokens: null, blocks: [] }],
  ];

  test('the recording clients send validate.ts\'s requests through the ledger guard, return validate.ts\'s text, and keep only how each reply ended', async () => {
    for (const [make, record, replies] of [
      [anthropicClient, recordingAnthropicClient, anthropicReplies], [geminiClient, recordingGeminiClient, geminiReplies],
    ] as const) {
      for (const [reply, ended] of replies) {
        const plain = await guarded(() => reply, () => make(KEY).complete(PROMPT, 8192));
        const client = record(KEY);
        const recorded = await guarded(() => reply, () => client.complete(PROMPT, 8192));
        expect(typeof plain.result).toBe('string');
        expect(recorded.result).toBe(plain.result);
        expect(recorded.sent).toEqual(plain.sent);
        expect(recorded.sent).toHaveLength(1);
        expect(recorded.entries).toEqual(plain.entries);
        expect(recorded.entries.map(e => e.status)).toEqual(['reconciled']);
        expect(client.stops.get(PROMPT)).toEqual(ended);
        expect(JSON.stringify([...client.stops])).not.toContain('sealed');
      }
      const status = await guarded(() => new Response('{"error": "sealed text"}', { status: 503 }), () => make(KEY).complete(PROMPT, 8192));
      const client = record(KEY);
      const refused = await guarded(() => new Response('{"error": "sealed text"}', { status: 503 }), () => client.complete(PROMPT, 8192));
      expect((refused.result as Error).message).toBe((status.result as Error).message);
      expect((refused.result as Error).message).toMatch(/ answered HTTP 503$/);
      expect(client.stops.get(PROMPT)).toEqual({ stop: 'http_503', output_tokens: null, blocks: [] });
    }
  });

  test('a request the guard refuses is never sent and records nothing', async () => {
    const ledgerPath = join(mkdtempSync(join(root, 'ledger-')), 'l.sqlite');
    initLedger({ ledgerPath, programCapUsd: 5 });
    const run = BudgetRun.open({ runner: 'rs1-stop-test', budgetUsd: 0.0001, ledgerPath });
    let sent = 0;
    const guard = installPaidRequestGuard(run, { fetchImpl: (async () => { sent++; return Response.json({}); }) as unknown as typeof fetch });
    const client = recordingAnthropicClient(KEY);
    try { await expect(client.complete(PROMPT.repeat(400), 8192)).rejects.toBeInstanceOf(BudgetExceededError); } finally { guard.uninstall(); run.close(); }
    expect(sent).toBe(0);
    expect(client.stops.size).toBe(0);
  });

  test('every unusable reply is listed with its validator, call and how it ended, and totals count them by stop reason', async () => {
    const fake = fakeClient(VALIDATOR_IDS[1]);
    const client = recordingAnthropicClient(KEY);
    const set = writeProbedSet(root, [probedConversation('stops')]);
    const opts: Options = { setDir: set, beamDir: beam, reportPath: join(root, 'report.json'), targetTokens: 1_000_000, tolerance: 0.9999, windowTokens: 600, overlapTokens: 60, concurrency: 4 };
    const { result: report, sent } = await guarded(async (_url, init) => {
      const prompt = JSON.parse(String(init.body)).messages[0].content as string;
      if (prompt.includes('<conversation_part>')) return { content: [], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 0 } };
      return { content: [{ type: 'text', text: await fake.complete(prompt, 8192) }], stop_reason: 'end_turn', usage: { input_tokens: 90, output_tokens: 6 } };
    }, () => validateCandidates(opts, [fakeClient(VALIDATOR_IDS[0]), client], index, 0));
    const r = report as CandidateReport;
    const c = r.conversations.c001;
    expect(c.status).toBe('incomplete');
    expect(sent).toHaveLength(27 + c.windows);
    expect(c.validator_errors).toHaveLength(c.windows);
    expect([...c.validator_errors].sort((a, b) => a.window! - b.window!)).toEqual(Array.from({ length: c.windows }, (_, window) => ({
      validator: VALIDATOR_IDS[1], kind: 'absence', candidate: null, window, prompt_tokens: expect.any(Number), stop: 'end_turn', output_tokens: 0, blocks: [],
    })));
    expect(r.totals).toMatchObject({ unusable_end_turn: c.windows, validator_errors: 0 });
    expect(Object.values(c.candidates).filter(i => !i.pass).map(i => i.gates)).toEqual([0, 1, 2].map(() => [`validator_error:${VALIDATOR_IDS[1]}`]));
    const broken: ModelClient = { id: VALIDATOR_IDS[0], complete: async (p, m) => (p.includes('<question>') ? 'no json here' : fakeClient(VALIDATOR_IDS[0]).complete(p, m)) };
    const unrecorded = await validateCandidates(opts, [broken, fakeClient(VALIDATOR_IDS[1])], index);
    expect(unrecorded.conversations.c001.validator_errors.map(e => [e.kind, e.stop, typeof e.candidate])).toEqual(Array.from({ length: 27 }, () => ['support', 'unrecorded', 'string']));
    expect(unrecorded.totals).toMatchObject({ unusable_unrecorded: 27 });
  });
});

// ─── validate-candidates.ts regrouped windows (GST-1886, 2026-11-12) ─

describe('validate-candidates.ts regrouped windows', () => {
  let root = '', beam = '', index: PublicIndex;
  beforeAll(() => { root = scratch('candidate-regroup'); beam = fakeBeam(root); index = buildPublicIndex(beam); });
  const options = (set: string, extra: Partial<Options> = {}): Options => ({ setDir: set, beamDir: beam, reportPath: join(root, 'report.json'), targetTokens: 1_000_000, tolerance: 0.9999, windowTokens: 600, overlapTokens: 60, concurrency: 4, ...extra });
  const questionsOf = (prompt: string) => between(prompt, '<questions>', '</questions>').trim().split('\n');
  /** fakeClient with a stop record per prompt; prompts for which refuse() names a stop reason come back empty with it. */
  function stopping(id: string, refuse: (prompt: string) => string | null): ModelClient & { stops: Map<string, StopRecord>; asked: string[] } {
    const inner = fakeClient(id), stops = new Map<string, StopRecord>(), asked: string[] = [];
    return {
      id, stops, asked,
      async complete(prompt, max) {
        asked.push(prompt);
        const stop = refuse(prompt);
        stops.set(prompt, stop ? { stop, output_tokens: 0, blocks: [] } : { stop: 'end_turn', output_tokens: 9, blocks: ['text'] });
        return stop ? '' : inner.complete(prompt, max);
      },
    };
  }
  const windowOf = (prompt: string, conv: ProbedConversation, n: number) => prompt.includes(conv.messages[n].slice(0, 60));

  test('a window answered in the wrong shape is asked again one candidate at a time, and each candidate passes or fails on its own reply', async () => {
    const conv = probedConversation('regroup', 120);
    const nonce = (k: number) => /nonce-[0-9a-f]+/.exec(String(conv.candidates.abstention[k].question))![0];
    conv.messages[61] += ` I decided on ${nonce(2)} after all.`;
    const haiku = stopping(VALIDATOR_IDS[1], p => {
      if (!p.includes('<conversation_part>') || !windowOf(p, conv, 61)) return null;
      const qs = questionsOf(p);
      return qs.length > 1 ? 'refusal' : qs[0].includes(nonce(1)) ? 'refusal' : null;
    });
    const gemini = counting(fakeClient(VALIDATOR_IDS[0]));
    const set = writeProbedSet(root, [conv]);
    const report = await validateCandidates(options(set, { cacheDir: join(root, 'cache-1') }), [gemini, haiku], index);
    const c = report.conversations.c001;
    expect(c.status).toBe('checked');
    const abstention = Object.fromEntries(Object.entries(c.candidates).filter(([k]) => k.startsWith('abstention/')).map(([k, r]) => [k, r.gates]));
    expect(abstention).toEqual({ 'abstention/0': [], 'abstention/1': [`refusal:${VALIDATOR_IDS[1]}`], 'abstention/2': expect.arrayContaining([`absence:${VALIDATOR_IDS[0]}`, `absence:${VALIDATOR_IDS[1]}`]) });
    expect(c.passed.abstention).toBe(1);
    const refusedWindows = c.regrouped.map(r => r.window);
    expect(refusedWindows.length).toBeGreaterThanOrEqual(1);
    expect(c.regrouped.every(r => r.validator === VALIDATOR_IDS[1] && !r.over_cap)).toBe(true);
    const singles = haiku.asked.filter(p => p.includes('<conversation_part>') && questionsOf(p).length === 1);
    expect(singles).toHaveLength(3 * refusedWindows.length);
    expect(gemini.calls.absence).toBe(c.windows);
    expect(c.validator_errors.map(e => [e.kind, e.stop, e.candidate])).toEqual(expect.arrayContaining([['absence', 'refusal', null], ['absence_single', 'refusal', 'abstention/1']]));
    expect(report.totals).toMatchObject({ regrouped_windows: refusedWindows.length, regroup_over_cap: 0, absence_single_calls: 3 * refusedWindows.length, gate_refusal: 1, validator_errors: 0 });
    const again = stopping(VALIDATOR_IDS[1], p => (p.includes('<conversation_part>') && windowOf(p, conv, 61) && questionsOf(p).length > 1 ? 'refusal' : null));
    const second = await validateCandidates(options(set, { cacheDir: join(root, 'cache-1') }), [fakeClient(VALIDATOR_IDS[0]), again], index);
    expect(again.asked.filter(p => questionsOf(p).length === 1 && p.includes('<conversation_part>'))).toHaveLength(refusedWindows.length);
    expect(second.conversations.c001.candidates['abstention/1'].pass).toBe(true);
  });

  test('a single reply in the wrong shape that is not a refusal, a window past the limit and a window that errors fail closed as validator_error', async () => {
    const conv = probedConversation('regroup-cap', 120);
    const set = writeProbedSet(root, [conv]);
    const empty = stopping(VALIDATOR_IDS[1], p => (p.includes('<conversation_part>') ? 'end_turn' : null));
    const report = await validateCandidates(options(set), [fakeClient(VALIDATOR_IDS[0]), empty], index, 1);
    const c = report.conversations.c001;
    expect(c.status).toBe('incomplete');
    expect(c.regrouped.filter(r => !r.over_cap)).toHaveLength(1);
    expect(c.regrouped.filter(r => r.over_cap)).toHaveLength(c.windows - 1);
    expect(report.totals).toMatchObject({ regrouped_windows: 1, regroup_over_cap: c.windows - 1, absence_single_calls: 3 });
    for (const k of [0, 1, 2]) expect(c.candidates[`abstention/${k}`].gates).toEqual([`validator_error:${VALIDATOR_IDS[1]}`]);
    let thrown = 0;
    const failing: ModelClient = { id: VALIDATOR_IDS[1], complete: async (p, m) => { if (p.includes('<conversation_part>')) { thrown++; throw new Error('HTTP 503'); } return fakeClient(VALIDATOR_IDS[1]).complete(p, m); } };
    const errored = await validateCandidates(options(set), [fakeClient(VALIDATOR_IDS[0]), failing], index);
    expect(thrown).toBe(errored.conversations.c001.windows);
    expect(errored.totals).toMatchObject({ regrouped_windows: 0, absence_single_calls: 0, validator_errors: thrown });
    expect(errored.conversations.c001.status).toBe('incomplete');
  });

  test('the estimate adds the dearest regroupings the limit allows, for windows not yet answered', async () => {
    const set = writeProbedSet(root, [probedConversation('regroup-price', 120)]);
    const opts = options(set, { cacheDir: join(root, 'cache-price') });
    const clients = [fakeClient(VALIDATOR_IDS[0]), fakeClient(VALIDATOR_IDS[1])];
    const [none, one, two] = [0, 1, 2].map(k => planCandidates(opts, clients, index, k).estimateUsd);
    expect(one).toBeGreaterThan(none);
    expect(two - one).toBeGreaterThan(0);
    expect(two - one).toBeLessThanOrEqual(one - none + 1e-12);
    await validateCandidates(opts, clients, index);
    expect(planCandidates(opts, clients, index, 2).estimateUsd).toBe(0);
  });
});

// ─── rs1_mint.py select in real mode ─────────────────────────────────

const WINDOW_ARGS = String.raw`
def window_args(out):
    import sqlite3
    path = str(out) + "-window.sqlite"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS caps (seq INTEGER PRIMARY KEY AUTOINCREMENT, program_cap_usd REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, budget_usd REAL NOT NULL, finished_at TEXT)")
    db.execute("INSERT OR IGNORE INTO runs VALUES ('rs1-test', 1, NULL)")
    if not db.execute("SELECT COUNT(*) FROM caps").fetchone()[0]:
        db.execute("INSERT INTO caps (program_cap_usd) VALUES (1)")
    db.commit()
    db.close()
    return ["--paid-window", "RS1-TEST", "--window-cap-usd", "1", "--budget-ledger", path, "--budget-run-id", "rs1-test"]
`;

const SELECT_HARNESS = String.raw`import json, sys
from pathlib import Path

rs1_dir, root, seed_file = sys.argv[1:4]
sys.path.insert(0, rs1_dir)
import rs1_mint as m


def provider(*args, **kwargs):
    raise AssertionError("a provider path was reached")


m.gemini_model = m.load_beam = m.embed = m.proxy_endpoint = provider
` + WINDOW_ARGS + String.raw`
out = Path(root) / "rs1-custody-real-select"
conv = out / "set" / "conversations" / "c001"
beam_chat = conv / "beam" / "1"
key = bytes(range(32))
m.write_json(beam_chat / "chat.json", m.fake_chat(key))
for ability in m.ABILITIES:
    m.write_json(m.candidate_file(beam_chat, ability), m.fake_candidates(key, ability))
m.write_json(conv / "manifest.json", {"schema": "rs1-mint-manifest/v1", "conversation": "c001", "index": 1, "mode": "real",
                                      "beam_commit": m.BEAM_COMMIT,
                                      "steps": {"topic_check@1": {"status": "done", "verdict": "accepted", "outputs": {}},
                                                "probe@1": {"status": "done", "outputs": {}}}})
chat = m.sha256_file(beam_chat / "chat.json")
passed = sorted("%s/%d.0.0" % (a, k) for a in m.ABILITIES for k in (1, 3))


def report(name, validators):
    path = Path(root) / name
    m.write_json(path, {"schema": "rs1-candidates/v1", "validators": validators, "conversations": {"c001": {
        "status": "checked", "chat_sha256": chat,
        "candidates": {"%s/%d.0.0" % (a, k): {"pass": "%s/%d.0.0" % (a, k) in passed, "gates": []} for a in m.ABILITIES for k in range(4)}}}})
    return str(path)


def select(extra):
    code = m.main(["step", "--out", str(out), "--conv-index", "1", "--step", "select", "--seed-file", seed_file, "--mode", "real",
                   "--beam-dir", str(out)] + window_args(out) + extra)
    return [code, (conv / "selection" / "1.json").exists()]


result = {"none": select([]),
          "fake": select(["--candidates", report("fake.json", ["fake-" + v for v in m.PAID_VALIDATORS])]),
          "paid": select(["--candidates", report("paid.json", m.PAID_VALIDATORS)])}
slots = m.read_json(conv / "selection" / "1.json")["slots"]
result["selected"] = sorted("%s/%s" % (s.split("#")[0], k) for s, k in slots.items() if k)
result["passed"] = passed
print("RESULT " + json.dumps(result), flush=True)
`;

describe('rs1_mint.py select in real mode', () => {
  test('refuses without --candidates and with a report the paid validators did not write; with theirs it selects only passed candidates, keyless', () => {
    const dir = scratch('real-select');
    writeFileSync(join(dir, 'k.rs1-seed'), seedLine('real select test') + '\n', { mode: 0o600 });
    const r = run('python3', ['-c', SELECT_HARNESS, RS1, dir, join(dir, 'k.rs1-seed')]);
    const line = r.out.split('\n').find(l => l.startsWith('RESULT '));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice(7));
    expect(result.none).toEqual([1, false]);
    expect(result.fake).toEqual([1, false]);
    expect(result.paid).toEqual([0, true]);
    expect(result.selected).toEqual(result.passed);
    expect(result.passed).toHaveLength(20);
    expect(r.err).toBe('rs1-mint refused: a real mint selects only from validated candidates; run validate-candidates.ts after the probe step and pass its report with --candidates\n'
      + 'rs1-mint refused: a real mint selects only from a candidate report the two paid validators wrote\n');
  });

  test('mint.sh in real mode without --candidates stops at probe, and refuses --until select or rubric before anything runs', () => {
    const src = readFileSync(MINT, 'utf8');
    expect(src).toContain('"") UNTIL=probe ;;');
    const dir = scratch('real-until');
    for (const step of ['select', 'rubric']) {
      const r = run('bash', [MINT, '--out', join(dir, 'rs1-custody'), '--seed-file', join(dir, 'k.rs1-seed'), '--count', '1', '--until', step]);
      expect([r.code, r.err]).toEqual([2, 'rs1-mint refused: a real mint selects only from validated candidates; pass --candidates <report> or stop at --until probe\n']);
    }
    expect(existsSync(join(dir, 'rs1-custody'))).toBe(false);
  });
});

// ─── rs1_mint.py fifteen planned batches ─────────────────────────────

const BATCH_HARNESS = String.raw`import json, re, sys, types
from pathlib import Path

rs1_dir, scenario, root, seed_file = sys.argv[1:5]
sys.path.insert(0, rs1_dir)
import rs1_mint as m

SECRET = "sealedtext"


def plan_text(b):
    bullets = ["Time Anchor: March %d, 2024" % b] + ["Point %d: %s point %d-%d" % (k, SECRET, b, k) for k in range(2, 28)]
    bullets += ["Information Update: %s update %d" % (SECRET, b), "User Instruction: %s reply in lists %d" % (SECRET, b),
                "Logical Contradiction: %s contradiction %d" % (SECRET, b)]
    return "BATCH %d PLAN\n" % b + "\n".join("\u2022 **%s:**%s" % tuple(x.split(":", 1)) for x in bullets)


def question_lines(b):
    lines = ["%s question %d-%d ->-> %d,%d" % (SECRET, b, i, b, 1 + i // 3) for i in range(90)]
    return lines + ["%s update line %d ->-> %d,28" % (SECRET, b, b), "%s reply in lists %d ->-> %d,29" % (SECRET, b, b),
                    "%s contradiction line %d ->-> %d,30" % (SECRET, b, b)]


calls = {"generate_plans": [], "user_messages_generation_fast": []}
fault = {"caller_batches": 10, "special_keeps": None, "raise": False}


def generate_plans(topic, theme, timeline, num_batches, num_bullets, labels, main_spec, relationships, llm_name,
                   save_address, input_address=None, domain="general"):
    """BEAM's generate_plans (src/beam/main.py:742) cut down to what it writes: one batch plan per batch asked for."""
    calls["generate_plans"].append(num_batches)
    if fault["raise"]:
        raise RuntimeError("the plan reply could not be parsed")
    plans = [plan_text(b) for b in range(1, num_batches + 1)]
    m.write_pickle(save_address + ".pickle", plans)
    Path(save_address + ".txt").write_text("\n\n".join(plans), encoding="utf-8")
    return plans


def add_special_bullets_to_plan(plan_address, num_bullets, llm_name):
    """BEAM's add_special_bullets_to_plan (src/beam/main.py:969): plan_new from plan; a fault keeps fewer batches."""
    plans = m.read_pickle(plan_address + ".pickle")[:fault["special_keeps"]]
    m.write_pickle(plan_address + "_new.pickle", plans)
    Path(plan_address + "_new.txt").write_text("\n\n".join(plans), encoding="utf-8")


def user_messages_generation_fast(topic, theme, plans, num_batches, sub_batches_per_batch, sub_batch_size, batch_size,
                                  llm_name, save_address, domain, sepcial_bullets=False):
    """BEAM's user_messages_generation_fast (src/beam/main.py:1307) cut down to what it writes: a batch per batch asked for."""
    calls["user_messages_generation_fast"].append(num_batches)
    m.write_pickle(save_address, [{"time_anchor": "x", "messages": [question_lines(b)]} for b in range(1, num_batches + 1)])


def run_plans_generation(chats_directory, chat_size, index):
    """BEAM's run_plans_generation (src/beam/run_pipeline.py:13-147) at 1M, cut down to its calls: generate_plans by its
    module-level name with num_batches=NUM_BATCHES (10), then add_special_bullets_to_plan."""
    topic = m.read_json(Path(chats_directory) / "topics.json")[index]
    chat = Path(chats_directory) / str(topic["id"])
    m.write_json(chat / "topic.json", topic)
    beam.run_pipeline.generate_plans(topic="t", theme="t", timeline="N/A", num_batches=fault["caller_batches"], num_bullets=30,
                                     labels="", main_spec="", relationships="", llm_name="gpt",
                                     save_address=str(chat / "plan"), input_address=None, domain="general")
    add_special_bullets_to_plan(plan_address=str(chat / "plan"), num_bullets=30, llm_name="gpt")


def run_question_generation(chats_directory, chat_size, index):
    """BEAM's run_question_generation (src/beam/run_pipeline.py:150-241) at 1M, cut down to its call."""
    chat = Path(chats_directory) / "1"
    beam.run_pipeline.user_messages_generation_fast(topic="t", theme="t", plans=m.read_pickle(chat / "plan_new.pickle"),
                                                    num_batches=10, sub_batches_per_batch=10, sub_batch_size=9,
                                                    batch_size=90, llm_name="llama",
                                                    save_address=str(chat / "user_messages.pickle"), domain="general",
                                                    sepcial_bullets=True)


beam = types.SimpleNamespace(run_pipeline=types.SimpleNamespace(
    generate_plans=generate_plans, user_messages_generation_fast=user_messages_generation_fast,
    run_plans_generation=run_plans_generation, run_question_generation=run_question_generation))
m.load_beam = lambda beam_dir, slot: beam
m.seed_rngs = lambda key: None
` + WINDOW_ARGS + String.raw`

out = Path(root) / "rs1-custody-batches"
conv = out / "set" / "conversations" / "c001"
beam_chat = conv / "beam" / "1"
beam_chat.mkdir(parents=True)
topic = {"id": 1, "category": "Travel", "title": SECRET + " title", "theme": SECRET + " theme", "subtopics": ["a", "b", "c"]}
m.write_json(conv / "topic.json", topic)
m.write_json(conv / "beam" / "topics.json", [topic])
steps = {"topic_check@1": {"status": "done", "verdict": "accepted", "outputs": {}}}
if scenario == "legacy":
    m.write_pickle(beam_chat / "plan_new.pickle", [plan_text(b) for b in range(1, 11)])
    steps["plan@1"] = {"status": "done", "outputs": {"beam/1/plan_new.pickle": m.sha256_file(beam_chat / "plan_new.pickle")}}
m.write_json(conv / "manifest.json", {"schema": "rs1-mint-manifest/v1", "conversation": "c001", "index": 1, "mode": "real",
                                      "beam_commit": m.BEAM_COMMIT, "steps": steps})


def step(name):
    return m.main(["step", "--out", str(out), "--conv-index", "1", "--step", name, "--seed-file", seed_file, "--mode", "real",
                   "--beam-dir", str(out)] + window_args(out))


def entry(name):
    return m.read_json(conv / "manifest.json")["steps"].get(name + "@1")


def held(name):
    return len(m.read_pickle(beam_chat / name)) if (beam_chat / name).exists() else None


restored = lambda: beam.run_pipeline.generate_plans is generate_plans and beam.run_pipeline.user_messages_generation_fast is user_messages_generation_fast
result = {}
if scenario in ("fifteen", "legacy"):
    result["codes"] = [step("plan"), step("question")]
    result["planned"] = entry("plan").get("planned_batches")
    result["pickles"] = [held("plan.pickle"), held("plan_new.pickle"), held("user_messages.pickle")]
    result["question"] = entry("question")["status"]
    result["check_gaps"] = m.main(["check-gaps", "--out", str(out)])
elif scenario == "short-plan":
    fault["special_keeps"] = 14
    result["codes"] = [step("plan")]
    result["recorded"] = entry("plan")
    fault["special_keeps"] = None
    result["codes"].append(step("plan"))
    result["planned"] = entry("plan").get("planned_batches")
elif scenario == "wrong-caller":
    fault["caller_batches"] = 15
    result["codes"] = [step("plan")]
    result["recorded"] = entry("plan")
elif scenario == "raises":
    fault["raise"] = True
    result["codes"] = [step("plan")]
    result["recorded"] = entry("plan")
elif scenario == "units":
    ns = types.SimpleNamespace(generate_plans=lambda *args, **kwargs: kwargs.get("num_batches"))
    outcomes = []
    with m.beam_batches(ns, "generate_plans", 15):
        outcomes.append(ns.generate_plans(num_batches=10, topic="t"))
        for args, kwargs in (((10,), {}), ((), {"num_batches": 9}), ((), {"topic": "t"})):
            try:
                outcomes.append(ns.generate_plans(*args, **kwargs))
            except m.StepFailure:
                outcomes.append("refused")
    try:
        with m.beam_batches(ns, "generate_plans", 15):
            raise KeyError("inside")
    except KeyError:
        outcomes.append(ns.generate_plans(num_batches=10))
    result["wrapper"] = outcomes
    q = [{"time_anchor": "x", "messages": [question_lines(b)]} for b in range(1, 16)]
    p = [plan_text(b) for b in range(1, 16)]
    result["gaps"] = {"fifteen": m.question_gaps(q, p, "general", 15)["gap_batches"],
                      "ten_of_fifteen": m.question_gaps(q[:10], p, "general", 15)["gap_batches"],
                      "fifteen_of_ten": m.question_gaps(q, p, "general", 10)["gap_batches"],
                      "legacy": m.question_gaps(q[:10], p[:10], "general", m.planned_batches({"plan@1": {"status": "done"}}))["gap_batches"]}
    result["planned"] = [m.planned_batches({}), m.planned_batches({"plan@1": {"status": "done"}}),
                         m.planned_batches({"plan@1": {"status": "done", "planned_batches": 15}})]
    prompts = types.SimpleNamespace(
        plan_generation_prompt_profile_and_topic_given_detailed_template="You plan one long conversation between a user and an assistant.\n<topic>\n- Generate exactly <num_batches> plans\n",
        add_special_bulletpoints_to_plan_implicit="You add three special bullets to every batch of the plan below and keep the rest.\n- **PLAN:** <plan>\n")
    stub = m.StubModel(bytes(32), m.Usage(Path(root) / "stub-usage.jsonl"))
    stub.bind_templates(prompts)
    heads = lambda text: len(re.findall(r"BATCH \d+ PLAN", text))
    result["stub"] = {}
    for n in (10, 15):
        plan = stub.invoke(prompts.plan_generation_prompt_profile_and_topic_given_detailed_template.replace("<topic>", "t").replace("<num_batches>", str(n))).content
        result["stub"][n] = [heads(plan), heads(stub.invoke(prompts.add_special_bulletpoints_to_plan_implicit.replace("<plan>", plan)).content)]
result["calls"] = calls
result["restored"] = restored()
print("RESULT " + json.dumps(result), flush=True)
`;

function batches(name: string) {
  const dir = scratch('batches');
  writeFileSync(join(dir, 'k.rs1-seed'), seedLine(`batch test ${name}`) + '\n', { mode: 0o600 });
  const r = run('python3', ['-c', BATCH_HARNESS, RS1, name, dir, join(dir, 'k.rs1-seed')]);
  const lines = r.out.split('\n').filter(Boolean);
  const result = lines.find(l => l.startsWith('RESULT '));
  if (!result) throw new Error(`scenario ${name} printed no RESULT (exit ${r.code}): ${r.err.slice(0, 400)}`);
  return { result: JSON.parse(result.slice(7)), out: lines.filter(l => !l.startsWith('RESULT ')), err: r.err };
}

describe('rs1_mint.py fifteen planned batches (stubbed BEAM)', () => {
  test('the plan and question steps pass num_batches=15 to BEAM, record planned_batches, restore BEAM, and check-gaps counts 15', () => {
    const { result, out, err } = batches('fifteen');
    expect(err).toBe('');
    expect(result).toEqual({
      codes: [0, 0], planned: 15, pickles: [15, 15, 15], question: 'done', check_gaps: 0,
      calls: { generate_plans: [15], user_messages_generation_fast: [15] }, restored: true,
    });
    expect(out).toContainEqual(expect.stringMatching(/^rs1-mint conv=c001 step=question gaps=0 batches=15\/15 gap_batches=none short=0 special_missing=0 min_messages=93 floor=85 sha256=[0-9a-f]{64} recorded=match$/));
    expect(out.join('\n')).not.toContain(SECRET);
  });

  test('a conversation planned with 10 before then is not planned again, asks for 10 batches of user messages, and passes its checks', () => {
    const { result, out, err } = batches('legacy');
    expect(err).toBe('');
    expect(result).toEqual({
      codes: [0, 0], planned: null, pickles: [null, 10, 10], question: 'done', check_gaps: 0,
      calls: { generate_plans: [], user_messages_generation_fast: [10] }, restored: true,
    });
    expect(out).toContainEqual(expect.stringMatching(/^rs1-mint conv=c001 step=plan status=skipped attempt=1 outputs=1 /));
    expect(out).toContainEqual(expect.stringMatching(/ step=question gaps=0 batches=10\/10 /));
  });

  test('the plan check refuses a plan that holds 14 batch plans and records nothing, and a rerun plans again', () => {
    const { result, err } = batches('short-plan');
    expect(result).toEqual({ codes: [1, 0], recorded: null, planned: 15, calls: { generate_plans: [15, 15], user_messages_generation_fast: [] }, restored: true });
    expect(err).toBe('rs1-mint refused: BEAM\'s plan_new.pickle holds 14 batch plans, not the 15 planned; a rerun plans again\n');
  });

  test('a call that does not pass BEAM\'s 1M num_batches=10 refuses before BEAM runs, and an error inside BEAM still restores it', () => {
    const wrong = batches('wrong-caller');
    expect(wrong.result).toEqual({ codes: [1], recorded: null, calls: { generate_plans: [], user_messages_generation_fast: [] }, restored: true });
    expect(wrong.err).toBe('rs1-mint refused: BEAM called generate_plans without its 1M recipe\'s num_batches=10 keyword\n');
    const raised = batches('raises');
    expect(raised.result).toEqual({ codes: [1], recorded: null, calls: { generate_plans: [15], user_messages_generation_fast: [] }, restored: true });
    expect(raised.out).toContainEqual(expect.stringMatching(/^rs1-mint conv=c001 step=plan status=error error_class=RuntimeError error_sha256=[0-9a-f]{16}$/));
  });

  test('beam_batches, question_gaps with a planned count, planned_batches\'s default of 10, and the stub model\'s plan length', () => {
    const { result, err } = batches('units');
    expect(err).toBe('');
    expect(result.wrapper).toEqual([15, 'refused', 'refused', 'refused', 10]);
    expect(result.gaps).toEqual({ fifteen: [], ten_of_fifteen: [11, 12, 13, 14, 15], fifteen_of_ten: [11, 12, 13, 14, 15], legacy: [] });
    expect(result.planned).toEqual([10, 10, 15]);
    expect(result.stub).toEqual({ 10: [10, 10], 15: [15, 15] });
  });
});

describe('validate.ts', () => {
  test('is byte-identical to the preregistered file', () => {
    expect(sha(readFileSync(join(RS1, 'validate.ts')))).toBe('7805fa768dd94caae2166faf5bf17a202559c20150398ddac239295ce7ed576e');
  });
});
