/**
 * RS1 custody scripts (GST-1154): eval/custody/rs1/mint.sh, validate.ts and hashlist.ts, and the sealed key in
 * .gstack/pregate.json. Keyless: mint.sh runs in --fake mode, the validators are fakes, and nothing reaches a provider.
 * The seeds here are test seeds made at run time; the RS1 seed is chosen in custody and is never one of them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { priceRequest } from '../../eval/runner/budget-ledger.ts';
import { loadSplit } from '../../eval/runner/decisions/splits.ts';
import { encodingCount } from '../../eval/runner/systems/render-v2.ts';
import { BEAM_PATHS_FILE, deriveBeamPaths, readBeamPaths, renderBeamPaths } from '../../eval/custody/rs1/beam-paths.ts';
import { checkTree, hashTree } from '../../eval/custody/rs1/hashlist.ts';
import {
  ANSWER_FIELD, CALIBRATION, SLOTS, VALIDATOR_IDS, anthropicRequest, buildPublicIndex, calibrate, chunkMessages,
  deriveCalibration, fakeClient, geminiRequest, ngrams, planValidation, publicSources, validateSet, writeReport, ValidateError,
  type Calibration, type CalibrationMeasure, type ModelClient, type Options, type PublicIndex,
} from '../../eval/custody/rs1/validate.ts';

const REPO = resolve(import.meta.dir, '../..');
const MINT = join(REPO, 'eval/custody/rs1/mint.sh');
const VALIDATE = join(REPO, 'eval/custody/rs1/validate.ts');
const HASHLIST = join(REPO, 'eval/custody/rs1/hashlist.ts');
const MARKER = ['RS1', 'SEALED', 'CUSTODY', 'v1'].join('-');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const seedLine = (name: string) => ['rs1', 'seed', 'v1'].join('-') + ':' + sha(name);
const word = (seed: string, i: number) => 'w' + sha(`${seed}/${i}`).slice(0, 7);
const words = (seed: string, n: number) => Array.from({ length: n }, (_, i) => word(seed, i)).join(' ');

const roots: string[] = [];
const scratch = (name: string) => { const d = mkdtempSync(join(tmpdir(), `rs1-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env }, timeout: 240_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

/**
 * A BEAM-shaped public tree: three public topics, a chat and questions file for every dev conversation in the BEAM
 * path list (the first 1M one holds PASSAGE and PUBLIC_QUESTION, and the second, larger one quotes 32 of PASSAGE's
 * words), and SEALED_PASSAGE in a sealed 1M conversation and a 10M chat, which the list leaves out. The calibration
 * from it is τ 2% (20 of the first chat's 1,300 13-grams are in the second) and bounds around the fake mint's
 * conversations; --fake does not stop on its range.
 */
const PASSAGE = words('public-passage', 400);
const SEALED_PASSAGE = words('sealed-passage', 400);
const PUBLIC_QUESTION = 'Which public dataset question appears in the BEAM release?';
const BEAM_LIST = readBeamPaths().paths;
const PUBLIC_CHAT = BEAM_LIST.find(p => p.startsWith('chats/1M/') && p.endsWith('/chat.json'))!;
const QUOTING_CHAT = BEAM_LIST.filter(p => p.startsWith('chats/1M/') && p.endsWith('/chat.json'))[1];
/** The calibration subjects of a full tree: the listed 1M conversations, as public ids in list order. */
const LISTED_1M = BEAM_LIST.filter(p => p.startsWith('chats/1M/') && p.endsWith('/chat.json')).map(p => `1m-${p.split('/')[2]}`);
const SEALED_CHATS = ['chats/1M/1/chat.json', 'chats/10M/1/chat.json'];
function fakeBeam(root: string): string {
  const beam = join(root, 'beam');
  const write = (rel: string, value: unknown) => { mkdirSync(dirname(join(beam, rel)), { recursive: true }); writeFileSync(join(beam, rel), JSON.stringify(value)); };
  const chat = (seed: string, passage = '') => [{ batch_number: 1, time_anchor: 'x', turns: Array.from({ length: 10 }, (_, i) => [{ role: 'user', id: 2 * i, content: i === 3 && passage ? passage : words(`${seed}-u${i}`, 60) }, { role: 'assistant', id: 2 * i + 1, content: words(`${seed}-a${i}`, 60) }]) }];
  write('topics/1M/1M_topics.json', ['Coding', 'Math', 'Cooking'].map((category, i) => ({ id: i + 1, category, title: `Public ${category} topic`, theme: `Public theme ${i}`, subtopics: ['a', 'b', 'c'] })));
  for (const rel of BEAM_LIST.filter(p => p.startsWith('chats/'))) {
    if (rel.endsWith('/chat.json') || rel.endsWith('/chat_trunecated.json')) write(rel, chat(`public-${rel}`, rel === PUBLIC_CHAT ? PASSAGE : ''));
    else write(rel, dirname(dirname(rel)) === dirname(PUBLIC_CHAT) ? { information_extraction: [{ question: PUBLIC_QUESTION, answer: 'x', rubric: ['y'] }] } : {});
  }
  const quote = PASSAGE.split(' ').slice(0, 32).join(' ');
  write(QUOTING_CHAT, [{ batch_number: 1, time_anchor: 'x', turns: Array.from({ length: 50 }, (_, i) => [{ role: 'user', id: 2 * i, content: i === 7 ? quote : words(`public-big-u${i}`, 100) }, { role: 'assistant', id: 2 * i + 1, content: words(`public-big-a${i}`, 100) }]) }]);
  for (const rel of SEALED_CHATS) write(rel, chat(`sealed-${rel}`, SEALED_PASSAGE));
  return beam;
}

/** The public index of a tree and its calibration, recording rather than refusing an out-of-range gate (as --fake does). */
function openCalibration(beam: string): { index: PublicIndex; cal: Calibration } {
  const index = buildPublicIndex(beam);
  return { index, cal: calibrate(beam, index.paths, index.sourcesSha256, { enforceRange: false }) };
}

/** Every string value in a JSON tree. */
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
  const probes = new Set<string>([seed, seed.split(':')[1], MARKER]);
  for (const path of files(join(setDir, 'conversations'))) {
    const rel = relative(setDir, path);
    if (!/(topic|chat|probing_questions|rubric|topic-attempts)/.test(rel) || !path.endsWith('.json')) continue;
    for (const s of strings(JSON.parse(readFileSync(path, 'utf8')))) if (s.length >= 16) probes.add(s.slice(0, 48));
  }
  return [...probes];
}

const leaks = (output: string, probes: string[]) => probes.filter(p => output.includes(p)).length;

// ─── mint.sh --fake, validate.ts and hashlist.ts end to end ──────────

describe('RS1 custody scripts end to end (mint.sh --fake)', () => {
  let root = '', beam = '', seedA = '', seedB = '';
  const mint = (out: string, seedFile: string, extra: string[] = []) => run('bash', [MINT, '--fake', '--beam-dir', beam, '--out', out, '--seed-file', seedFile, '--count', '2', ...extra]);
  let first: ReturnType<typeof run>, again: ReturnType<typeof run>, twin: ReturnType<typeof run>, other: ReturnType<typeof run>;

  beforeAll(() => {
    root = scratch('mint');
    beam = fakeBeam(root);
    mkdirSync(join(root, 'keys'));
    seedA = join(root, 'keys/a.rs1-seed');
    seedB = join(root, 'keys/b.rs1-seed');
    writeFileSync(seedA, seedLine('test seed a') + '\n', { mode: 0o600 });
    writeFileSync(seedB, seedLine('test seed b') + '\n', { mode: 0o600 });
    first = mint(join(root, 'rs1-custody-a'), seedA);
    again = mint(join(root, 'rs1-custody-a'), seedA);
    twin = mint(join(root, 'rs1-custody-twin'), seedA);
    other = mint(join(root, 'rs1-custody-b'), seedB);
  }, 600_000);

  test('mints, and prints only counts and hashes: no topic, item, chat or seed text', () => {
    for (const r of [first, again, twin, other]) {
      expect(r.code).toBe(0);
      for (const line of r.all.trim().split('\n')) expect(line).toMatch(/^rs1-mint( [a-z0-9_]+=[^ ]*)+$/);
    }
    const probes = sealedProbes(join(root, 'rs1-custody-a/set'), seedLine('test seed a'));
    expect(probes.length).toBeGreaterThan(100);
    expect(leaks(first.all + again.all + twin.all, probes)).toBe(0);
    expect(first.out).toContain('summary=mint mode=fake conversations=2 complete=2');
  });

  test('the same seed mints the same set, and another seed a different one', () => {
    const content = (out: string) => hashTree(join(root, out, 'set/conversations')).text.split('\n').filter(l => /(chat|probing_questions|topic)[^/]*\.json$/.test(l)).join('\n');
    expect(content('rs1-custody-twin')).toBe(content('rs1-custody-a'));
    expect(content('rs1-custody-b')).not.toBe(content('rs1-custody-a'));
    expect(content('rs1-custody-a').split('\n').length).toBeGreaterThan(6);
  });

  test('a rerun resumes: every finished step is verified and skipped, nothing is sampled again', () => {
    const usage = (r: ReturnType<typeof run>) => /usage_sha256=([0-9a-f]{64})/.exec(r.out)?.[1];
    expect(usage(again)).toBe(usage(first));
    expect(again.out).toMatch(/steps_run=0 /);
    expect(again.out).not.toMatch(/status=done/);
  });

  test('refuses an output outside rs1-custody*, inside a checkout, a missing seed and a readable seed file', () => {
    const loose = join(root, 'keys/loose.rs1-seed');
    writeFileSync(loose, seedLine('test seed loose') + '\n', { mode: 0o644 });
    chmodSync(loose, 0o644);
    const cases = [
      mint(join(root, 'custody-x'), seedA),
      mint(join(REPO, 'rs1-custody-in-checkout'), seedA),
      run('bash', [MINT, '--fake', '--beam-dir', beam, '--out', join(root, 'rs1-custody-c')]),
      mint(join(root, 'rs1-custody-loose'), loose),
    ];
    for (const r of cases) {
      expect(r.code).not.toBe(0);
      expect(r.all).toContain('refused');
      expect(r.all).not.toContain(sha('test seed a'));
      expect(r.all).not.toContain(sha('test seed loose'));
    }
    expect(existsSync(join(REPO, 'rs1-custody-in-checkout'))).toBe(false);
  });

  test('validate.ts --fake keeps the fake set and prints counts and hashes only', () => {
    const set = join(root, 'rs1-custody-a/set');
    const report = join(root, 'rs1-custody-a/validation/report.json');
    const r = run('bun', [VALIDATE, '--set', set, '--beam-dir', beam, '--report', report, '--fake', '--window-tokens', '4000', '--overlap-tokens', '400']);
    expect(r.code).toBe(0);
    for (const line of r.all.trim().split('\n')) expect(line).toMatch(/^rs1-validate( [a-z0-9_]+=[^ ]*)+$/);
    expect(r.out).toContain('conversations=2 keep=2 regenerate=0 drop=0 incomplete=0');
    expect(r.out).toContain('items=40 pass=40 fail=0');
    expect(r.out).toContain(`calibration_subjects=${LISTED_1M.length} calibration_dropped=0 calibration_accepted=0 `);
    expect(r.out).toContain(' tau=0.02 ');
    const written = JSON.parse(readFileSync(report, 'utf8'));
    expect(written.calibration).toMatchObject({ tau: 0.02, max_share_subject: `1m-${PUBLIC_CHAT.split('/')[2]}`, out_of_range: [{ rule: 'low_below_min' }] });
    expect(written.calibration.subjects.map((s: { id: string }) => s.id)).toEqual(LISTED_1M);
    expect(Object.keys(written.params)).not.toContain('contamination_max');
    const probes = sealedProbes(set, seedLine('test seed a'));
    expect(leaks(r.all, probes)).toBe(0);
    expect(leaks(readFileSync(report, 'utf8'), probes)).toBe(0);
    expect(existsSync(join(root, 'rs1-custody-a/validate-cache'))).toBe(true);
  });

  test('a --fake run never answers a later --paid run from the reply cache', () => {
    const set = join(root, 'rs1-custody-a/set');
    const cache = join(root, 'rs1-custody-a/shared-cache');
    const report = (name: string) => join(root, 'rs1-custody-a/validation', name);
    const args = (mode: string, name: string) => [VALIDATE, '--set', set, '--beam-dir', beam, '--report', report(name), '--cache', cache, mode, '--window-tokens', '4000', '--overlap-tokens', '400'];
    expect(run('bun', args('--fake', 'fake-cached.json')).code).toBe(0);
    expect(JSON.parse(readFileSync(report('fake-cached.json'), 'utf8')).validators).toEqual(VALIDATOR_IDS.map(id => `fake-${id}`));
    const { index, cal } = openCalibration(beam);
    const paidPlan = planValidation({ setDir: set, beamDir: beam, reportPath: report('unused.json'), cacheDir: cache, windowTokens: 4000, overlapTokens: 400, concurrency: 1 }, VALIDATOR_IDS.map(id => fakeClient(id)), index, cal);
    expect(paidPlan.calls.length).toBeGreaterThan(0);
    expect(paidPlan.calls.filter(c => c.cached)).toHaveLength(0);
    const paid = run('bun', args('--paid', 'paid.json'), { GEMINI_API_KEY: 'test-gemini-key-not-real', ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', BRAINBENCH_BUDGET_LEDGER: join(root, 'ledger.sqlite') });
    expect(paid.code).toBe(2);
    expect(paid.err).toMatch(/^rs1-validate refused: /);
    expect(paid.err).toContain('RS1_CALIBRATION_OUT_OF_RANGE');
    expect(paid.all).not.toContain('not-real');
    expect(existsSync(report('paid.json'))).toBe(false);
  });

  test('a regenerate report from validate.ts replaces exactly the failed slots in mint.sh --regenerate', async () => {
    const set = join(root, 'rs1-custody-b/set');
    const target = 'temporal_reasoning#1';
    const failing = JSON.parse(readFileSync(join(set, 'conversations/c001/rubric/1', `${target}.json`), 'utf8')).item.question as string;
    const picky: ModelClient = { id: VALIDATOR_IDS[0], complete: async (p, m) => (p.includes(`<question>${failing}</question>`) ? '{"supported": false}' : fakeClient(VALIDATOR_IDS[0]).complete(p, m)) };
    const opts: Options = { setDir: set, beamDir: beam, reportPath: join(root, 'b-report.json'), windowTokens: 4000, overlapTokens: 400, concurrency: 4 };
    const { index, cal } = openCalibration(beam);
    const report = await validateSet(opts, [picky, fakeClient(VALIDATOR_IDS[1])], index, cal);
    expect(report.conversations.c001.status).toBe('regenerate');
    expect(report.conversations.c001.items[target].gates).toEqual([`support:${VALIDATOR_IDS[0]}`]);
    expect(report.conversations.c002.status).toBe('keep');
    writeReport(opts.reportPath, report);
    const r = mint(join(root, 'rs1-custody-b'), seedB, ['--regenerate', opts.reportPath]);
    expect(r.code).toBe(0);
    const before = JSON.parse(readFileSync(join(set, 'conversations/c001/selection/1.json'), 'utf8')).slots;
    const after = JSON.parse(readFileSync(join(set, 'conversations/c001/selection/2.json'), 'utf8')).slots;
    for (const slot of SLOTS) expect(after[slot] === before[slot]).toBe(slot !== target);
    expect(existsSync(join(set, 'conversations/c002/selection/2.json'))).toBe(false);
    const revalidated = await validateSet(opts, [fakeClient(VALIDATOR_IDS[0]), fakeClient(VALIDATOR_IDS[1])], index, cal);
    expect(revalidated.conversations.c001.select_attempt).toBe(2);
    expect(revalidated.conversations.c001.status).toBe('keep');
    expect(leaks(r.all, sealedProbes(set, seedLine('test seed b')))).toBe(0);
  }, 120_000);

  test('a failed candidate is rejected only for its own ability, and a rerun with an applied report skips it', () => {
    const out = join(root, 'rs1-custody-reject');
    const conv = join(out, 'set/conversations/c001');
    const one = (extra: string[] = []) => run('bash', [MINT, '--fake', '--beam-dir', beam, '--out', out, '--seed-file', seedA, '--count', '1', ...extra]);
    const selection = (n: number) => JSON.parse(readFileSync(join(conv, 'selection', `${n}.json`), 'utf8')).slots as Record<string, string | null>;
    const report = (name: string, attempt: number, failing: string[]) => {
      const path = join(root, `${name}.json`);
      const chat = sha(readFileSync(join(conv, 'beam/1/chat.json'), 'utf8'));
      writeFileSync(path, JSON.stringify({ conversations: { c001: { status: 'regenerate', select_attempt: attempt, chat_sha256: chat, items: Object.fromEntries(SLOTS.map(s => [s, { pass: !failing.includes(s), gates: [] }])) } } }));
      return path;
    };
    expect(one().code).toBe(0);
    const first = selection(1);
    const updates = ['knowledge_update#0', 'knowledge_update#1'];
    const other = SLOTS.find(s => !updates.includes(s) && !updates.some(u => first[u] === first[s]));
    expect(other).toBeDefined();
    const applied = report('reject-1', 1, [other!]);
    expect(one(['--regenerate', applied]).code).toBe(0);
    const rerun = one(['--regenerate', applied]);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain('step=select status=skipped attempt=2 ');
    expect(one(['--regenerate', report('reject-2', 2, updates)]).code).toBe(0);
    const third = selection(3);
    for (const u of updates) {
      expect(third[u]).not.toBeNull();
      expect(updates.map(x => first[x])).not.toContain(third[u]);
    }
    expect(third[updates[0]]).not.toBe(third[updates[1]]);
  }, 240_000);

  test('mint.sh --regenerate refuses a report that read another chat', () => {
    const out = join(root, 'rs1-custody-foreign');
    const one = (extra: string[] = []) => run('bash', [MINT, '--fake', '--beam-dir', beam, '--out', out, '--seed-file', seedA, '--count', '1', ...extra]);
    expect(one().code).toBe(0);
    const report = join(root, 'foreign-report.json');
    const items = Object.fromEntries(SLOTS.map((s, i) => [s, { pass: i > 0, gates: [] }]));
    writeFileSync(report, JSON.stringify({ validators: [...VALIDATOR_IDS], conversations: { c001: { status: 'regenerate', select_attempt: 1, chat_sha256: sha('another chat'), items } } }));
    const r = one(['--regenerate', report]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('rs1-mint refused: ');
    expect(existsSync(join(out, 'set/conversations/c001/selection/2.json'))).toBe(false);
  }, 120_000);

  test('hashlist.ts writes a sha256sum-format list, prints only counts and hashes, and a restore check matches it', () => {
    const set = join(root, 'rs1-custody-a/set');
    const list = join(root, 'rs1-custody-a/hashlist.txt');
    const w = run('bun', [HASHLIST, '--root', set, '--out', list]);
    expect(w.code).toBe(0);
    expect(w.all.trim()).toMatch(/^rs1-hashlist files=[0-9]+ bytes=[0-9]+ list_sha256=[0-9a-f]{64}$/);
    expect(w.out).toContain(`list_sha256=${sha(readFileSync(list, 'utf8'))}`);
    const c = run('bun', [HASHLIST, '--root', set, '--check', list]);
    expect(c.code).toBe(0);
    expect(c.out).toContain('changed=0 missing=0 extra=0 identical=true');
    expect(leaks(w.all + c.all, sealedProbes(set, seedLine('test seed a')))).toBe(0);
    expect(run('bun', [HASHLIST, '--root', set, '--out', join(set, 'list.txt')]).code).toBe(2);
  });
});

// ─── validate.ts gates on synthetic sets ─────────────────────────────

interface FakeConversation { messages: string[]; items: Record<string, Record<string, unknown> | null>; attempt?: number; unfinished?: boolean }

/** A conversation of n messages whose items cite the turns holding their answers; abstention items name absent nonces. */
function conversation(seed: string, n = 60): FakeConversation {
  const messages = Array.from({ length: n }, (_, i) => words(`${seed}/m${i}`, 40));
  const items: FakeConversation['items'] = {};
  SLOTS.forEach((slot, k) => {
    const ability = slot.split('#')[0] as keyof typeof ANSWER_FIELD;
    if (ability === 'abstention') {
      items[slot] = { question: `What did I decide about nonce-${sha(seed + slot).slice(0, 10)}?`, ideal_response: 'The chat holds no information about that.', abstention_type: 'missing_detail' };
      return;
    }
    const fact = `fact ${words(`${seed}/${slot}/fact`, 5)}`;
    messages[2 + 2 * k] += ` ${fact}`;
    items[slot] = { question: `${words(`${seed}/${slot}/q`, 8)}?`, [ANSWER_FIELD[ability]]: fact, source_chat_ids: [2 + 2 * k] };
  });
  return { messages, items };
}

function writeSet(root: string, conversations: FakeConversation[]): string {
  const set = join(root, 'set');
  rmSync(set, { recursive: true, force: true });
  conversations.forEach((conv, i) => {
    const dir = join(set, 'conversations', `c${String(i + 1).padStart(3, '0')}`);
    const attempt = conv.attempt ?? 1;
    const steps: Record<string, { status: string }> = {};
    for (let a = 1; a <= attempt; a++) { steps[`select@${a}`] = { status: 'done' }; steps[`rubric@${a}`] = { status: conv.unfinished && a === attempt ? 'running' : 'done' }; }
    mkdirSync(join(dir, 'beam/1'), { recursive: true });
    mkdirSync(join(dir, 'selection'), { recursive: true });
    mkdirSync(join(dir, 'rubric', String(attempt)), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 'rs1-manifest/v1', steps }));
    writeFileSync(join(dir, 'selection', `${attempt}.json`), JSON.stringify({ attempt, slots: Object.fromEntries(SLOTS.map(s => [s, conv.items[s] ? `k-${s}` : null])), failed: [] }));
    for (const slot of SLOTS) if (conv.items[slot]) writeFileSync(join(dir, 'rubric', String(attempt), `${slot}.json`), JSON.stringify({ candidate: `k-${slot}`, item: conv.items[slot] }));
    const turns = [];
    for (let id = 0; id < conv.messages.length; id += 2) turns.push(conv.messages.slice(id, id + 2).map((content, j) => ({ role: j ? 'assistant' : 'user', id: id + j, content })));
    writeFileSync(join(dir, 'beam/1/chat.json'), JSON.stringify([{ batch_number: 1, time_anchor: 'x', turns }]));
  });
  return set;
}

function counting(inner: ModelClient) {
  let calls = 0;
  return { id: inner.id, get calls() { return calls; }, complete: (p: string, m: number) => { calls++; return inner.complete(p, m); } };
}
const fakes = () => [counting(fakeClient(VALIDATOR_IDS[0])), counting(fakeClient(VALIDATOR_IDS[1]))];

describe('validate.ts gates', () => {
  let root = '', beam = '', index: PublicIndex, cal: Calibration;
  const options = (set: string, extra: Partial<Options> = {}): Options => ({ setDir: set, beamDir: beam, reportPath: join(root, 'report.json'), windowTokens: 600, overlapTokens: 60, concurrency: 4, ...extra });
  beforeAll(() => { root = scratch('gates'); beam = fakeBeam(root); ({ index, cal } = openCalibration(beam)); });

  test('a clean set keeps every conversation and asks both validators about every item', async () => {
    const clients = fakes();
    const report = await validateSet(options(writeSet(root, [conversation('one'), conversation('two')])), clients, index, cal);
    expect(Object.values(report.conversations).map(c => c.status)).toEqual(['keep', 'keep']);
    expect(report.totals.items).toBe(40);
    expect(report.totals.pass).toBe(40);
    expect(report.verdict).toBe('continue');
    expect(clients[0].calls).toBe(clients[1].calls);
    expect(clients[0].calls).toBe(2 * 18 + report.totals.windows);
    expect(report.totals.windows).toBeGreaterThan(2);
  });

  test('13-gram contamination: a conversation holding a public passage is dropped, and the public file is named', async () => {
    const dirty = conversation('dirty');
    dirty.messages[41] = PASSAGE.split(' ').slice(0, 120).join(' ');
    const report = await validateSet(options(writeSet(root, [conversation('clean'), dirty])), fakes(), index, cal);
    const c = report.conversations.c002;
    expect(c.status).toBe('drop');
    expect(c.reasons).toEqual(['contamination']);
    expect(c.contamination_share!).toBeGreaterThanOrEqual(cal.tau);
    expect(c.contamination_source).toBe(PUBLIC_CHAT);
    expect(c.contamination_union_share!).toBeGreaterThanOrEqual(c.contamination_share!);
    expect(report.conversations.c001.contamination_share).toBe(0);
    expect(Object.keys(c.items)).toHaveLength(0);
  });

  test('the public index reads only the path list (F28): a sealed or 10M chat never counts, and a missing listed file refuses', async () => {
    const list = readBeamPaths();
    const indexed = list.paths.filter(p => p.startsWith('chats/') && !p.endsWith('/chat_trunecated.json'));
    expect(index.sources).toBe(indexed.length);
    expect(index.paths.map(p => relative(beam, p))).toEqual(indexed);
    expect(index.sourceListSha256).toBe(list.sha256);
    const sealed = conversation('sealed');
    sealed.messages[41] = SEALED_PASSAGE.split(' ').slice(0, 120).join(' ');
    const report = await validateSet(options(writeSet(root, [sealed])), fakes(), index, cal);
    expect(report.conversations.c001.contamination_share).toBe(0);
    expect(report.conversations.c001.status).toBe('keep');
    expect(report.public_index.source_list_sha256).toBe(list.sha256);
    const partial = fakeBeam(scratch('partial'));
    rmSync(join(partial, PUBLIC_CHAT));
    expect(() => buildPublicIndex(partial)).toThrow(/1 public BEAM files of the path list are missing/);
  });

  test('a public question is contaminated, and a repeated question is a duplicate', async () => {
    const a = conversation('qa'), b = conversation('qb');
    a.items['information_extraction#0']!.question = PUBLIC_QUESTION;
    b.items['event_ordering#1']!.question = a.items['event_ordering#1']!.question;
    const report = await validateSet(options(writeSet(root, [a, b])), fakes(), index, cal);
    expect(report.conversations.c001.items['information_extraction#0'].gates).toEqual(['contamination']);
    expect(report.conversations.c002.items['event_ordering#1'].gates).toEqual(['duplicate']);
    expect(report.conversations.c001.status).toBe('regenerate');
    expect(report.conversations.c002.status).toBe('regenerate');
  });

  test('length gate: a cl100k count at the calibrated low or high bound passes, and one token outside drops it', async () => {
    const conv = conversation('len');
    const tokens = conv.messages.reduce((s, m) => s + encodingCount('cl100k_base', m), 0);
    const gate = async (low_tokens: number, high_tokens: number) => (await validateSet(options(writeSet(root, [conv])), fakes(), index, { ...cal, low_tokens, high_tokens })).conversations.c001;
    expect(await gate(tokens, tokens + 10)).toMatchObject({ tokens, status: 'keep' });
    expect(await gate(tokens - 10, tokens)).toMatchObject({ tokens, status: 'keep' });
    expect((await gate(tokens + 1, tokens + 10)).reasons).toEqual(['length']);
    expect((await gate(tokens - 10, tokens - 1)).reasons).toEqual(['length']);
  });

  test('exact and near-duplicate conversations are dropped', async () => {
    const a = conversation('dup');
    const near = conversation('dup');
    for (let i = 1; i < 60; i += 10) near.messages[i] = words(`near/${i}`, 40);
    const report = await validateSet(options(writeSet(root, [a, conversation('dup'), near, conversation('fresh')])), fakes(), index, cal);
    expect(report.conversations.c002.reasons).toEqual(['duplicate']);
    expect(report.conversations.c003.reasons).toEqual(['duplicate']);
    expect(report.conversations.c003.near_duplicate_of).toBe('c001');
    expect(report.conversations.c004.status).toBe('keep');
  });

  test('both validators must find support in the cited turns; a missing or uncited item fails without a call', async () => {
    const conv = conversation('support');
    conv.items['knowledge_update#0']!.answer = 'an answer no turn holds';
    conv.items['summarization#1']!.source_chat_ids = [9999];
    conv.items['temporal_reasoning#0'] = null;
    const blindSpot = ['<answer>', String(conv.items['multi_session_reasoning#0']!.answer), '</answer>'].join('');
    const halfBlind: ModelClient = { id: VALIDATOR_IDS[1], complete: async (p, m) => (p.includes(blindSpot) ? '{"supported": false}' : fakeClient(VALIDATOR_IDS[1]).complete(p, m)) };
    const report = await validateSet(options(writeSet(root, [conv])), [fakeClient(VALIDATOR_IDS[0]), halfBlind], index, cal);
    const items = report.conversations.c001.items;
    expect(items['knowledge_update#0'].gates).toEqual(VALIDATOR_IDS.map(id => `support:${id}`));
    expect(items['multi_session_reasoning#0'].gates).toEqual([`support:${VALIDATOR_IDS[1]}`]);
    expect(items['summarization#1'].gates).toEqual(['uncited']);
    expect(items['temporal_reasoning#0'].gates).toEqual(['missing']);
    expect(report.conversations.c001.status).toBe('regenerate');
    expect(report.abilities.knowledge_update).toEqual({ pass: 1, fail: 1 });
  });

  test('the chunked absence scan fails an abstention item that one window can answer', async () => {
    const conv = conversation('absence', 120);
    const nonce = /nonce-[0-9a-f]+/.exec(String(conv.items['abstention#1']!.question))![0];
    conv.messages[77] += ` I decided on ${nonce} after all.`;
    const clients = fakes();
    const report = await validateSet(options(writeSet(root, [conv])), clients, index, cal);
    const c = report.conversations.c001;
    expect(c.windows).toBeGreaterThan(4);
    expect(c.items['abstention#1'].gates).toEqual(VALIDATOR_IDS.map(id => `absence:${id}`));
    expect(c.items['abstention#0'].pass).toBe(true);
    expect(clients[0].calls).toBe(18 + c.windows);
  });

  test('windows cover every message and every pair of neighbours that fits one window, within the window size', () => {
    const tokens = Array.from({ length: 400 }, (_, i) => 1 + ((i * 7919) % 389));
    tokens[150] = 900;
    const windows = chunkMessages(tokens, 600, 60);
    expect(windows[0][0]).toBe(0);
    expect(windows.at(-1)![1]).toBe(tokens.length);
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (tokens[i] + tokens[i + 1] <= 600) expect(windows.some(([s, e]) => s <= i && i + 1 < e)).toBe(true);
    }
    expect(windows.some(([s, e]) => s === 150 && e === 151)).toBe(true);
    for (const [s, e] of windows) {
      const used = tokens.slice(s, e).reduce((a, b) => a + b, 0);
      expect(e - s === 1 || used <= 600).toBe(true);
    }
    for (let w = 1; w < windows.length; w++) if (windows[w - 1][1] - windows[w - 1][0] > 1) expect(windows[w][0]).toBeLessThan(windows[w - 1][1]);
  });

  test('per-ability floor: a failed item regenerates up to twice, then drops the conversation; over 20% failing stops', async () => {
    const fail = (seed: string, attempt: number, n: number) => {
      const conv = { ...conversation(seed), attempt };
      SLOTS.filter(s => !s.startsWith('abstention')).slice(0, n).forEach(s => { conv.items[s] = { ...conv.items[s]!, [ANSWER_FIELD[s.split('#')[0] as keyof typeof ANSWER_FIELD]]: 'nothing cited says this' }; });
      return conv;
    };
    const early = await validateSet(options(writeSet(root, [fail('f1', 1, 2), fail('f2', 2, 2)])), fakes(), index, cal);
    expect(Object.values(early.conversations).map(c => c.status)).toEqual(['regenerate', 'regenerate']);
    expect(early.verdict).toBe('continue');
    const late = await validateSet(options(writeSet(root, [fail('f3', 3, 2), conversation('ok', 60)])), fakes(), index, cal);
    expect(late.conversations.c001.status).toBe('drop');
    expect(late.conversations.c001.reasons).toEqual(['floor']);
    expect(late.totals.finished_fail).toBe(2);
    expect(late.verdict).toBe('continue');
    const stop = await validateSet(options(writeSet(root, [fail('f4', 3, 9), conversation('ok2', 60)])), fakes(), index, cal);
    expect(stop.totals.finished_fail / stop.totals.finished_items).toBeGreaterThan(0.2);
    expect(stop.verdict).toBe('stop');
  });

  test('a validator error leaves the conversation incomplete, not regenerate, and cached replies are not asked again', async () => {
    const set = writeSet(root, [conversation('err'), { ...conversation('busy'), unfinished: true }]);
    const cacheDir = join(root, 'cache');
    let broken = true;
    const flaky: ModelClient = { id: VALIDATOR_IDS[0], complete: async (p, m) => { if (broken && p.includes('<question>')) throw new Error('HTTP 503'); return fakeClient(VALIDATOR_IDS[0]).complete(p, m); } };
    const first = await validateSet(options(set, { cacheDir }), [flaky, fakeClient(VALIDATOR_IDS[1])], index, cal);
    expect(first.conversations.c001.status).toBe('incomplete');
    expect(first.conversations.c001.reasons).toEqual(['validator_error']);
    expect(first.conversations.c002.reasons).toEqual(['unfinished']);
    expect(first.totals.validator_errors).toBe(18);
    broken = false;
    const clients = [counting(flaky), counting(fakeClient(VALIDATOR_IDS[1]))];
    const second = await validateSet(options(set, { cacheDir }), clients, index, cal);
    expect(second.conversations.c001.status).toBe('keep');
    expect(clients[0].calls).toBe(18);
    expect(clients[1].calls).toBe(0);
    expect(second.totals.cached_calls).toBe(second.totals.calls - 18);
  });

  test('a conversation whose every topic mint.sh rejected is dropped for its topic, an unfinished one is incomplete', async () => {
    const set = writeSet(root, [conversation('topic-a'), { ...conversation('topic-b'), unfinished: true }]);
    const manifest = join(set, 'conversations/c002/manifest.json');
    const checks = Object.fromEntries([1, 2, 3, 4, 5].map(a => [`topic_check@${a}`, { status: 'done', verdict: 'rejected' }]));
    writeFileSync(manifest, JSON.stringify({ steps: checks }));
    const report = await validateSet(options(set), fakes(), index, cal);
    expect(report.conversations.c002).toMatchObject({ status: 'drop', reasons: ['topic'] });
    expect(report.totals.drop_topic).toBe(1);
    writeFileSync(manifest, JSON.stringify({ steps: { ...checks, 'topic_check@5': { status: 'done', verdict: 'accepted' } } }));
    expect((await validateSet(options(set), fakes(), index, cal)).conversations.c002).toMatchObject({ status: 'incomplete', reasons: ['unfinished'] });
  });

  test('refuses two validators from one family', async () => {
    const set = writeSet(root, [conversation('family')]);
    await expect(validateSet(options(set), [fakeClient(VALIDATOR_IDS[0]), fakeClient('gemini:gemini-3.7-flash')], index, cal)).rejects.toThrow('different families');
  });

  test('the budget ledger prices both validator requests (gemini-3.8-flash and claude-haiku-5-5)', () => {
    const g = geminiRequest('x'.repeat(3000), 8192), a = anthropicRequest('x'.repeat(3000), 8192);
    expect(priceRequest(g.url, g.body)).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash', maxOutputTokens: 8192 });
    expect(priceRequest(a.url, a.body)).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', maxOutputTokens: 8192 });
  });

  test('the CLI refuses paid validation without --paid and an open run, before any request, and never prints a key', () => {
    const set = writeSet(root, [conversation('cli')]);
    const env = { GEMINI_API_KEY: 'test-gemini-key-not-real', ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', BRAINBENCH_BUDGET_LEDGER: join(root, 'ledger.sqlite') };
    const base = [VALIDATE, '--set', set, '--beam-dir', beam, '--report', join(root, 'cli-report.json')];
    for (const args of [base, [...base, '--paid'], [...base, '--fake', '--paid']]) {
      const r = run('bun', args, env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^rs1-validate refused: /);
      expect(r.all).not.toContain('not-real');
    }
    expect(existsSync(join(root, 'cli-report.json'))).toBe(false);
  });
});

// ─── validate.ts gate calibration ────────────────────────────────────

/** A BEAM tree of chats/<tier>/<n> directories; chat_trunecated.json, when asked for, holds the first `truncated` messages. */
function beamTree(beam: string, convs: Record<string, { messages: string[]; truncated?: number; questions?: string[] }>): string {
  rmSync(beam, { recursive: true, force: true });
  const chat = (messages: string[]) => JSON.stringify([{ batch_number: 1, time_anchor: 'x', turns: messages.map((content, id) => [{ role: id % 2 ? 'assistant' : 'user', id, content }]) }]);
  for (const [dir, conv] of Object.entries(convs)) {
    const d = join(beam, 'chats', dir);
    mkdirSync(join(d, 'probing_questions'), { recursive: true });
    writeFileSync(join(d, 'chat.json'), chat(conv.messages));
    if (conv.truncated) writeFileSync(join(d, 'chat_trunecated.json'), chat(conv.messages.slice(0, conv.truncated)));
    writeFileSync(join(d, 'probing_questions/probing_questions.json'), JSON.stringify({ information_extraction: (conv.questions ?? []).map(question => ({ question, answer: 'x' })) }));
  }
  return beam;
}
/** A message of exactly n distinct 13-grams, and n words of a message from a given word. */
const grams = (seed: string, n: number) => words(seed, n + 12);
const cut = (text: string, from: number, n: number) => text.split(' ').slice(from, from + n).join(' ');
/** The conversations the BEAM path list names (1M/2, 500K/10, ...): validate refuses a tree that lacks one. */
const LISTED_CONVERSATIONS = BEAM_LIST.filter(p => p.endsWith('/chat.json')).map(p => dirname(p).slice('chats/'.length));
/** beamTree over every listed conversation, each a filler of nine 100-gram messages unless convs gives it. */
const listedTree = (beam: string, convs: Parameters<typeof beamTree>[1]) => beamTree(beam, {
  ...Object.fromEntries(LISTED_CONVERSATIONS.map(dir => [dir, { messages: Array.from({ length: 9 }, (_, i) => grams(`cal-filler/${dir}/${i}`, 100)) }])),
  ...convs,
});
const tokensOf = (messages: string[]) => messages.reduce((s, m) => s + encodingCount('cl100k_base', m), 0);
/** A 1,000-word message for million-token chats: a cheap 32-bit mix per word, so 13-word runs never repeat across seeds. */
function bulk(seed: string): string {
  const s = parseInt(sha(seed).slice(0, 8), 16);
  return Array.from({ length: 1000 }, (_, i) => {
    let h = (i + 0x6a09e667) | 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return 'v' + ((h ^ s) >>> 0).toString(16).padStart(8, '0');
  }).join(' ');
}
const measure = (subjects: Array<[tokens: number, shared: number, ngrams: number]>): CalibrationMeasure => ({
  sources: 9, sources_sha256: 'a'.repeat(64), subjects_sha256: 'b'.repeat(64),
  subjects: subjects.map(([tokens, shared, ngrams], i) => ({ id: `1m-${i + 2}`, file: `chats/1M/${i + 2}/chat.json`, tokens, ngrams, shared, share: shared / ngrams, source: shared ? 'chats/500K/10/chat.json' : null })),
});
const refusal = (fn: () => unknown): ValidateError => { try { fn(); } catch (error) { if (error instanceof ValidateError) return error; throw error; } throw new Error('no refusal'); };

describe('validate.ts gate calibration', () => {
  // Tree A holds every listed conversation: subject 1m-2 is counted on its truncated chat (8 messages, 800 13-grams) and
  // 16 of them are in 500k-10's chat; subject 1m-3 (1,000) has 10 there. Each subject's questions quote its own chat.
  // The other listed conversations are fillers of nine messages that share nothing, so 1m-2 is the smallest subject and
  // 1m-3 the largest.
  const A2 = Array.from({ length: 10 }, (_, i) => grams(`cal-a2/${i}`, 100));
  const A3 = Array.from({ length: 10 }, (_, i) => grams(`cal-a3/${i}`, 100));
  const treeA = (beam: string, extra: Parameters<typeof beamTree>[1] = {}) => listedTree(beam, {
    '1M/2': { messages: A2, truncated: 8, questions: [cut(A2[0], 0, 40)] },
    '1M/3': { messages: A3, questions: [cut(A3[0], 0, 30)] },
    '500K/10': { messages: [cut(A2[1], 0, 28), cut(A3[0], 50, 22), grams('cal-a5/filler', 100)] },
    ...extra,
  });
  // Tree B adds 500k-12, holding three whole messages of 1m-3 (300 of its 1,000 13-grams) beside 300 of its own.
  const B12 = { messages: [A3[2], A3[3], A3[4], ...[1, 2, 3].map(i => grams(`cal-b12/${i}`, 100))] };
  let root = '', beamA = '', beamB = '', indexA: PublicIndex, calA: Calibration;
  beforeAll(() => {
    root = scratch('calibration');
    beamA = treeA(join(root, 'beam-a'));
    beamB = treeA(join(root, 'beam-b'), { '500K/12': B12 });
    indexA = buildPublicIndex(beamA);
    calA = calibrate(beamA, indexA.paths, indexA.sourcesSha256, { enforceRange: false });
  });

  test('s(c) leaves out the subject\'s own chat, truncated chat and questions; bounds and τ follow; every subject passes', () => {
    const designed = calA.subjects.filter(s => s.id === '1m-2' || s.id === '1m-3');
    expect(designed.map(s => [s.id, s.file, s.ngrams, s.shared, s.share, s.source])).toEqual([
      ['1m-2', 'chats/1M/2/chat_trunecated.json', 800, 16, 0.02, 'chats/500K/10/chat.json'],
      ['1m-3', 'chats/1M/3/chat.json', 1000, 10, 0.01, 'chats/500K/10/chat.json'],
    ]);
    expect(calA.subjects.map(s => s.id)).toEqual(LISTED_CONVERSATIONS.filter(d => d.startsWith('1M/')).map(d => `1m-${d.slice(3)}`));
    for (const s of calA.subjects) if (!designed.includes(s)) expect([s.id, s.shared, s.source]).toEqual([s.id, 0, null]);
    const t2 = tokensOf(A2.slice(0, 8)), t3 = tokensOf(A3);
    expect(designed.map(s => s.tokens)).toEqual([t2, t3]);
    expect(calA).toMatchObject({ schema: 'rs1-calibration/v1', sources: BEAM_LIST.filter(p => p.startsWith('chats/') && !p.endsWith('/chat_trunecated.json')).length, sources_sha256: indexA.sourcesSha256, low_tokens: Math.floor(95 * Math.min(t2, t3) / 100), high_tokens: Math.ceil(105 * Math.max(t2, t3) / 100), max_share: 0.02, max_share_subject: '1m-2', tau: 0.025, dropped: [], accepted: [] });
    for (const s of calA.subjects) {
      expect(s.tokens).toBeGreaterThanOrEqual(calA.low_tokens);
      expect(s.tokens).toBeLessThanOrEqual(calA.high_tokens);
      expect(s.share).toBeLessThan(calA.tau);
    }
    expect(calA.out_of_range).toEqual([{ rule: 'low_below_min', value: calA.low_tokens, limit: CALIBRATION.low_min, subject: '1m-2' }]);
  });

  test('τ is 1.25 × the largest share rounded up to a whole 0.1 percentage point; the bounds widen by 5%', () => {
    const tau = (shared: number, ngrams: number) => deriveCalibration(measure([[1_000_000, shared, ngrams], [1_200_000, 0, 1000]])).tau;
    expect(tau(16, 1000)).toBe(0.02);
    expect(tau(17, 1000)).toBe(0.022);
    expect(tau(1601, 100_000)).toBe(0.021);
    expect(tau(1, 100_000)).toBe(0.001);
    expect(tau(40, 1000)).toBe(0.05);
    const cal = deriveCalibration(measure([[1_000_000, 16, 1000], [1_200_000, 5, 1000]]));
    expect(cal).toMatchObject({ low_tokens: 950_000, high_tokens: 1_260_000, max_share_subject: '1m-2', out_of_range: [] });
    expect(deriveCalibration(measure([[1_000_001, 3, 1000], [1_199_999, 5, 1000]]))).toMatchObject({ low_tokens: 950_000, high_tokens: 1_259_999, tau: 0.007, max_share_subject: '1m-3' });
    expect(deriveCalibration(measure([[1_000_000, 16, 1000], [1_200_000, 5, 1000]]), { drop: ['1m-2'] })).toMatchObject({ dropped: ['1m-2'], low_tokens: 1_140_000, tau: 0.007 });
    expect(() => deriveCalibration(measure([[1_000_000, 16, 1000]]), { drop: ['1m-9'] })).toThrow('name no calibration subject 1m-9');
  });

  test('the ceiling stop: τ above 5%, τ of 0, or bounds outside 600,000 to 1,600,000 tokens', () => {
    const ranges = (subjects: Array<[number, number, number]>) => deriveCalibration(measure(subjects)).out_of_range.map(o => [o.rule, o.value, o.subject]);
    expect(ranges([[631_579, 40, 1000], [1_523_809, 1, 1000]])).toEqual([]);
    expect(ranges([[631_578, 41, 1000], [1_523_810, 1, 1000]])).toEqual([['tau_above_max', 0.052, '1m-2'], ['low_below_min', 599_999, '1m-2'], ['high_above_max', 1_600_001, '1m-3']]);
    expect(ranges([[1_000_000, 0, 1000], [1_100_000, 0, 1000]])).toEqual([['tau_zero', 0, null]]);
    const r = run('bun', [VALIDATE, '--calibrate-only', '--beam-dir', beamA]);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^rs1-validate refused: RS1_CALIBRATION_OUT_OF_RANGE: /);
    for (const s of [`low_below_min value=${calA.low_tokens} limit=600000 subject=1m-2`, `sources_sha256=${indexA.sourcesSha256}`, 'No gate ran and no report was written.', `drop: bun eval/custody/rs1/validate.ts --calibrate-only --beam-dir ${beamA} --calibration-drop 1m-2`]) expect(r.err).toContain(s);
  });

  test('the related-file guard refuses before any gate with the pair, both shares and the pool hash; no report is written', () => {
    const index = buildPublicIndex(beamB);
    const error = refusal(() => calibrate(beamB, index.paths, index.sourcesSha256, { enforceRange: false }));
    expect(error.code).toBe('RS1_CALIBRATION_RELATED_FILES');
    const set = writeSet(root, [conversation('related')]);
    const report = join(root, 'related-report.json');
    const r = run('bun', [VALIDATE, '--set', set, '--beam-dir', beamB, '--report', report, '--fake']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^rs1-validate refused: RS1_CALIBRATION_RELATED_FILES: /);
    const args = `bun eval/custody/rs1/validate.ts --set ${set} --beam-dir ${beamB} --report ${report} --fake`;
    for (const s of [
      'pair subject=1m-3 file=chats/500K/12/chat.json file_id=500k-12 subject_share=0.300000 file_share=0.500000', `sources_sha256=${index.sourcesSha256}`,
      'No gate ran and no report was written.', 'keep it and accept the larger tau (0.375, above the 0.05 ceiling', `drop: ${args} --calibration-drop 1m-3`, `accept: ${args} --calibration-accept 1m-3`,
    ]) expect(r.err).toContain(s);
    expect(existsSync(report)).toBe(false);
    const dropped = calibrate(beamB, index.paths, index.sourcesSha256, { drop: ['1m-3'], enforceRange: false });
    expect(dropped).toMatchObject({ dropped: ['1m-3'], tau: 0.025, max_share_subject: '1m-2', low_tokens: Math.floor(95 * tokensOf(A2.slice(0, 8)) / 100) });
    expect(calibrate(beamB, index.paths, index.sourcesSha256, { accept: ['1m-3'], enforceRange: false })).toMatchObject({ accepted: ['1m-3'], tau: 0.375 });
    const kept = refusal(() => calibrate(beamB, index.paths, index.sourcesSha256, { accept: ['1m-3'] }));
    expect(kept.code).toBe('RS1_CALIBRATION_OUT_OF_RANGE');
    expect(kept.message).toContain('tau_above_max value=0.375 limit=0.05 subject=1m-3');
  });

  test('a minted conversation whose single-file share is exactly τ is dropped, and one 13-gram under is kept', async () => {
    const atShare = (seed: string, shared: number) => {
      const conv = conversation(seed);
      const own = new Set(conv.messages.flatMap(m => ngrams(m).map(([a, b]) => `${a}:${b}`))).size;
      conv.messages.push(cut(A3[5], 0, shared + 12), words(`${seed}/filler`, 2000 - shared - own + 12));
      return conv;
    };
    const report = await validateSet({ setDir: writeSet(root, [atShare('at-tau', 50), atShare('under-tau', 49)]), beamDir: beamA, reportPath: join(root, 'tau.json'), windowTokens: 600, overlapTokens: 60, concurrency: 4 }, fakes(), indexA, { ...calA, low_tokens: 1, high_tokens: 10_000_000 });
    expect(report.conversations.c001).toMatchObject({ status: 'drop', reasons: ['contamination'], contamination_share: 0.025, contamination_source: 'chats/1M/3/chat.json' });
    expect(report.conversations.c002).toMatchObject({ status: 'keep', reasons: [], contamination_share: 0.0245 });
    expect(report.conversations.c002.contamination_union_share).toBe(0.0245);
    expect(report.calibration.tau).toBe(0.025);
  });

  test('the measurements are cached beside the public index by the pool and subject hashes', () => {
    const beam = treeA(join(root, 'beam-cache'));
    const index = buildPublicIndex(beam), cachePath = join(root, 'cache/public-13gram.bin');
    const first = calibrate(beam, index.paths, index.sourcesSha256, { cachePath, enforceRange: false });
    const file = `${cachePath}.calibration.json`;
    const head = JSON.parse(readFileSync(file, 'utf8'));
    expect(head).toMatchObject({ schema: 'rs1-calibration-measure/v1', sources_sha256: index.sourcesSha256, subjects_sha256: first.subjects_sha256 });
    writeFileSync(file, JSON.stringify({ ...head, subjects: head.subjects.map((s: { tokens: number }) => ({ ...s, tokens: s.tokens + 1 })) }));
    expect(calibrate(beam, index.paths, index.sourcesSha256, { cachePath, enforceRange: false }).subjects[0].tokens).toBe(first.subjects[0].tokens + 1);
    treeA(beam, { '1M/3': { messages: [...A3, grams('cal-cache/extra', 100)] } });
    const moved = buildPublicIndex(beam);
    const again = calibrate(beam, moved.paths, moved.sourcesSha256, { cachePath, enforceRange: false });
    expect(again.subjects.slice(0, 2).map(s => s.tokens)).toEqual([tokensOf(A2.slice(0, 8)), tokensOf([...A3, grams('cal-cache/extra', 100)])]);
  });

  test('--calibrate-only reads the listed dev files only: a sealed-split conversation and the 10M tier change nothing, and it prints ids, counts and hashes only', () => {
    // A million-token subject, so the ceiling stop passes: 1m-2, with 500k-10 quoting it; the other listed 1M subjects are
    // fillers, dropped. 1m-1 (a sealed split) and 10m-1 (the 10M tier) each hold whole messages of 1m-2, so reading either
    // would raise τ.
    const C1 = Array.from({ length: 130 }, (_, i) => bulk(`cal-c1/${i}`)), C2 = Array.from({ length: 160 }, (_, i) => bulk(`cal-c2/${i}`));
    const dev = { '1M/2': { messages: C2 }, '500K/10': { messages: [cut(C2[0], 0, 112), cut(C1[0], 0, 62), grams('cal-c5/filler', 100)] } };
    const full = listedTree(join(root, 'beam-c'), { ...dev, '1M/1': { messages: [...C1, C2[1]] }, '10M/1': { messages: [C2[2], C2[3]] } });
    const devOnly = listedTree(join(root, 'beam-c-dev'), dev);
    expect(publicSources(full).filter(p => /\/chats\/(1M\/1|10M)\//.test(p))).toEqual([]);
    const fillers = LISTED_CONVERSATIONS.filter(d => d.startsWith('1M/') && d !== '1M/2').map(d => `1m-${d.slice(3)}`);
    const calibrateOnly = (beam: string) => run('bun', [VALIDATE, '--calibrate-only', '--beam-dir', beam, ...fillers.flatMap(id => ['--calibration-drop', id])]);
    const a = calibrateOnly(full);
    expect(a.err).toBe('');
    expect(a.code).toBe(0);
    const cal = JSON.parse(a.out) as Calibration;
    expect(cal.dropped).toEqual([...fillers].sort());
    expect(cal.subjects.filter(s => s.id === '1m-2').map(s => [s.id, s.shared, s.ngrams, s.source])).toEqual([['1m-2', 100, 160 * 988, 'chats/500K/10/chat.json']]);
    const t2 = cal.subjects.find(s => s.id === '1m-2')!.tokens;
    expect(cal).toMatchObject({ tau: 0.001, out_of_range: [], low_tokens: Math.floor(95 * t2 / 100), high_tokens: Math.ceil(105 * t2 / 100) });
    const b = calibrateOnly(devOnly);
    expect(b.code).toBe(0);
    expect(b.out).toBe(a.out);
    const allowed = /^([0-9a-f]{64}|1m-\d+|chats\/(1M|500K)\/\d+\/(chat|chat_trunecated|probing_questions\/probing_questions)\.json|rs1-calibration\/v1)$/;
    for (const s of strings(cal)) expect(s).toMatch(allowed);
    expect(leaks(a.out, [...C1, ...C2].flatMap(m => [m.slice(0, 9), cut(m, 500, 1)]))).toBe(0);
  }, 120_000);
});

// ─── mint.sh start_proxy ─────────────────────────────────────────────

// ─── the BEAM path list and the sparse checkout (F28) ────────────────

describe('the BEAM path list (F28)', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, 'eval/decisions/datasets/beam-b2da22e.json'), 'utf8')).sizes as Record<string, Array<{ conversation: string; chat_path: string; questions_path: string }>>;
  const folder = (size: string, id: string) => dirname(manifest[size].find(c => c.conversation === id)!.chat_path) + '/';

  test('is the list derived from the committed split and dataset files', () => {
    expect(readFileSync(BEAM_PATHS_FILE, 'utf8')).toBe(renderBeamPaths());
  });

  test('names no sealed conversation and nothing of the 10M tier, and every dev conversation and pipeline path', () => {
    for (const size of ['100k', '500k', '1m']) {
      const split = loadSplit(`beam-${size}`);
      for (const id of split.sealed) expect(BEAM_LIST.filter(p => p.startsWith(folder(size, id)))).toEqual([]);
      for (const id of split.dev) {
        const { chat_path } = manifest[size].find(c => c.conversation === id)!;
        const chats = [...new Set([`${folder(size, id)}chat.json`, chat_path])];
        expect(BEAM_LIST.filter(p => p.startsWith(folder(size, id)))).toEqual([...chats, `${folder(size, id)}probing_questions/probing_questions.json`]);
      }
    }
    expect(loadSplit('beam-10m').dev).toEqual([]);
    expect(BEAM_LIST.filter(p => /10M/i.test(p))).toEqual([]);
    expect(BEAM_LIST.filter(p => !p.startsWith('chats/'))).toEqual(['src/', 'requirements.txt', 'LICENSE', 'README.md', 'topics/100k/100k_topics.json', 'topics/500k/500k_topics.json', 'topics/1M/1M_topics.json']);
  });

  test('refuses a conversation its split names neither dev nor sealed, and a dev conversation the manifest lacks', () => {
    const entry = (id: string) => ({ conversation: id, chat_path: `chats/1M/${id}/chat.json`, questions_path: `chats/1M/${id}/probing_questions/probing_questions.json` });
    const only1m = (dev: string[], sealed: string[]) => (name: string) => (name === 'beam-1m' ? { dev, sealed } : { dev: [], sealed: [] });
    expect(() => deriveBeamPaths({ '1m': [entry('1'), entry('2')] }, only1m(['1'], []))).toThrow('beam-1m: 2 in no split');
    expect(() => deriveBeamPaths({ '1m': [entry('1')] }, only1m(['1', '3'], []))).toThrow('beam-1m: dev conversations 3 are not in');
    const paths = deriveBeamPaths({ '1m': [entry('1'), entry('2')] }, only1m(['1'], ['2']));
    expect(paths).toContain('chats/1M/1/chat.json');
    expect(paths.filter(p => p.startsWith('chats/1M/2/'))).toEqual([]);
  });
});

describe('beam-checkout.sh', () => {
  const CHECKOUT = join(REPO, 'eval/custody/rs1/beam-checkout.sh');
  /** BEAM files the list leaves out: a sealed 1M conversation, the 10M tier, a per-tier topics copy and a dev pickle. */
  const EXCLUDED = ['chats/1M/1/chat.json', 'chats/1M/1/probing_questions/probing_questions.json', 'chats/10M/1/chat.json', 'topics/10M/10M_topics.json', 'chats/1M/topics.json', `${dirname(PUBLIC_CHAT)}/chat.pickle`];
  /** The modules rs1_mint.py's load_beam imports. */
  const PIPELINE = ['src/__init__.py', 'src/llm.py', 'src/prompts.py', 'src/beam/__init__.py', 'src/beam/adjust_chats_length.py', 'src/beam/main.py', 'src/beam/run_pipeline.py', 'src/beam/utils.py'];
  const LISTED = [...BEAM_LIST.filter(p => !p.endsWith('/')), ...PIPELINE].sort();
  let root = '', url = '', commit = '';
  const git = (dir: string, args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_NO_LAZY_FETCH: '1' } });
  const checkout = (dir: string, at = commit) => run('bash', [CHECKOUT, dir, url, at, BEAM_PATHS_FILE], { HOME: root });
  const onDisk = (dir: string) => files(dir).map(p => relative(dir, p)).filter(p => !p.startsWith('.git/')).sort();
  const blob = (rel: string) => git(join(root, 'origin'), ['rev-parse', `HEAD:${rel}`]).stdout.trim();
  const hasObject = (dir: string, rel: string) => git(dir, ['cat-file', '-e', blob(rel)]).status === 0;

  beforeAll(() => {
    root = scratch('beam-checkout');
    const origin = join(root, 'origin');
    for (const rel of [...LISTED, ...EXCLUDED]) { mkdirSync(dirname(join(origin, rel)), { recursive: true }); writeFileSync(join(origin, rel), `content of ${rel}\n`); }
    const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
    for (const args of [['init', '-q'], ['add', '-A'], [...ident, 'commit', '-qm', 'beam'], ['config', 'uploadpack.allowFilter', 'true'], ['config', 'uploadpack.allowAnySHA1InWant', 'true']]) expect(git(origin, args).status).toBe(0);
    url = `file://${origin}`;
    commit = git(origin, ['rev-parse', 'HEAD']).stdout.trim();
  });

  test('checks out only the listed paths: the excluded files are on neither the disk nor the object store', () => {
    const dir = join(root, 'out/beam');
    const r = checkout(dir);
    expect(r.code).toBe(0);
    expect(r.all.trim()).toMatch(new RegExp(`^rs1-mint beam=verified commit=${commit} tree=[0-9a-f]{40} sparse_files=${LISTED.length} absent_blobs=${EXCLUDED.length} paths_sha256=[0-9a-f]{64} replaced=0$`));
    expect(onDisk(dir)).toEqual(LISTED);
    for (const rel of EXCLUDED) expect(hasObject(dir, rel)).toBe(false);
    for (const rel of [...PIPELINE, PUBLIC_CHAT, 'topics/1M/1M_topics.json']) expect(hasObject(dir, rel)).toBe(true);
  });

  test('a rerun verifies without fetching again; a local change, a stray file or a stray object refuses', () => {
    const dir = join(root, 'rerun/beam');
    expect(checkout(dir).code).toBe(0);
    expect(checkout(dir).out).toContain(' replaced=0');
    writeFileSync(join(dir, 'LICENSE'), 'edited\n');
    expect(checkout(dir).err).toContain('rs1-mint refused: the BEAM checkout has local changes');
    expect(git(dir, ['checkout', '-q', 'LICENSE']).status).toBe(0);
    expect(checkout(dir).code).toBe(0);
    mkdirSync(join(dir, 'chats/10M/1'), { recursive: true });
    writeFileSync(join(dir, 'chats/10M/1/chat.json'), 'content of chats/10M/1/chat.json\n');
    const outside = checkout(dir);
    expect(outside.code).toBe(2);
    expect(outside.err).toContain('rs1-mint refused: the BEAM checkout holds 1 files outside the path list; deleted the checkout');
    expect(existsSync(dir)).toBe(false);
    expect(checkout(dir).code).toBe(0);
    const stray = spawnSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'content of chats/10M/1/chat.json\n', encoding: 'utf8' });
    expect(stray.stdout.trim()).toBe(blob('chats/10M/1/chat.json'));
    const refused = checkout(dir);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('rs1-mint refused: the BEAM object store holds 1 files outside the path list; deleted the checkout');
    expect(existsSync(dir)).toBe(false);
  });

  test('a full checkout from before F28 is deleted and fetched again sparse', () => {
    const dir = join(root, 'full/beam');
    mkdirSync(dirname(dir), { recursive: true });
    expect(spawnSync('git', ['clone', '-q', url, dir]).status).toBe(0);
    expect(hasObject(dir, 'chats/10M/1/chat.json')).toBe(true);
    const r = checkout(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain(' replaced=1');
    expect(onDisk(dir)).toEqual(LISTED);
    for (const rel of EXCLUDED) expect(hasObject(dir, rel)).toBe(false);
  });

  test('removes the origin remote, so a later git read cannot fetch an excluded file', () => {
    const dir = join(root, 'remote/beam');
    expect(checkout(dir).code).toBe(0);
    expect(git(dir, ['remote']).stdout.trim()).toBe('');
    expect(spawnSync('git', ['-C', dir, 'show', '--stat', 'HEAD'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root } }).status).not.toBe(0);
    for (const rel of EXCLUDED) expect(hasObject(dir, rel)).toBe(false);
    expect(git(dir, ['remote', 'add', 'origin', url]).status).toBe(0);
    expect(checkout(dir).out).toContain(' replaced=0');
    expect(git(dir, ['remote']).stdout.trim()).toBe('');
  });

  test('a refusal that finds an excluded file deletes the checkout, and never deletes through a symlink', () => {
    const plain = join(root, 'nofilter.git');
    expect(spawnSync('git', ['clone', '-q', '--bare', join(root, 'origin'), plain]).status).toBe(0);
    for (const [key, value] of [['uploadpack.allowFilter', 'false'], ['uploadpack.allowAnySHA1InWant', 'true']]) expect(git(plain, ['config', key, value]).status).toBe(0);
    const dir = join(root, 'nofilter/beam');
    const r = run('bash', [CHECKOUT, dir, `file://${plain}`, commit, BEAM_PATHS_FILE], { HOME: root });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/rs1-mint refused: the BEAM object store holds \d+ files outside the path list; deleted the checkout/);
    expect(existsSync(dir)).toBe(false);
    const real = join(root, 'linked/beam'), link = join(root, 'link-to-beam');
    expect(checkout(real).code).toBe(0);
    symlinkSync(real, link);
    spawnSync('git', ['-C', real, 'hash-object', '-w', '--stdin'], { input: 'content of chats/10M/1/chat.json\n' });
    const refused = checkout(link);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('outside the path list; delete it and run again');
    expect(existsSync(join(real, '.git'))).toBe(true);
  });

  test('refuses a commit it cannot fetch', () => {
    const r = checkout(join(root, 'other/beam'), '0'.repeat(40));
    expect(r.code).toBe(2);
    expect(r.err).toContain('rs1-mint refused: could not fetch BEAM at');
  });
});

describe('mint.sh start_proxy', () => {
  test('passes the provider key to the metering proxy through the environment, never on a command line', () => {
    const dir = scratch('proxy');
    const src = readFileSync(MINT, 'utf8');
    const fn = (name: string) => new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)![0];
    const dummy = 'rs1-dummy-gemini-value-not-a-key', other = 'rs1-dummy-openai-value-not-a-key', canary = 'rs1-canary-value';
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'out/proxy/ready'), { recursive: true });
    writeFileSync(join(dir, 'bin/env'), `#!/bin/bash\ntr '\\0' '\\n' < /proc/$$/cmdline > '${dir}/env.cmdline'\nexec /usr/bin/env "$@"\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'bin/bun'), `#!/bin/bash\ntrap 'kill $! 2>/dev/null; exit 0' TERM\nwhile [ $# -gt 0 ]; do [ "$1" = --ready-file ] && echo '{}' > "$2"; shift; done\nsleep 30 & wait\n`, { mode: 0o755 });
    const harness = [
      'set -euo pipefail',
      `OUT='${dir}/out' LEDGER='${dir}/ledger.sqlite' RUN_ID=rs1-test REPO='${REPO}'`,
      `export GEMINI_API_KEY='${dummy}' OPENAI_API_KEY='${other}' RS1_CANARY='${canary}'`,
      'die() { echo "refused: $*" >&2; exit 2; }',
      'PROXY_PID=""',
      fn('stop_proxy'),
      fn('start_proxy'),
      'start_proxy c001 plan gemini',
      `tr '\\0' '\\n' < "/proc/$PROXY_PID/cmdline" > '${dir}/proxy.cmdline'`,
      `tr '\\0' '\\n' < "/proc/$PROXY_PID/environ" > '${dir}/proxy.environ'`,
      'stop_proxy',
    ].join('\n');
    const r = run('bash', ['-c', harness], { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` });
    expect(r.code).toBe(0);
    const envArgv = readFileSync(join(dir, 'env.cmdline'), 'utf8'), proxyArgv = readFileSync(join(dir, 'proxy.cmdline'), 'utf8');
    const proxyEnv = readFileSync(join(dir, 'proxy.environ'), 'utf8').split('\n');
    expect(proxyArgv).toContain('harness-metering-proxy.ts');
    for (const argv of [envArgv, proxyArgv]) for (const value of [dummy, other, canary]) expect(argv).not.toContain(value);
    expect(proxyEnv).toContain(`GEMINI_API_KEY=${dummy}`);
    expect(proxyEnv.join('\n')).not.toContain(other);
    expect(proxyEnv.join('\n')).not.toContain(canary);
  });
});

// ─── hashlist.ts ─────────────────────────────────────────────────────

describe('hashlist.ts', () => {
  test('lists every file sorted by path, detects changed, missing and extra files, and follows no links', () => {
    const root = scratch('hash');
    const tree = join(root, 'set');
    mkdirSync(join(tree, 'b/c'), { recursive: true });
    writeFileSync(join(tree, 'b/c/z.json'), 'z');
    writeFileSync(join(tree, 'a.json'), 'a');
    writeFileSync(join(tree, 'b/y.json'), 'y');
    const list = hashTree(tree);
    expect(list.text).toBe(['a.json', 'b/c/z.json', 'b/y.json'].map(p => `${sha(p.slice(-6, -5))}  ${p}\n`).join(''));
    expect(list.sha256).toBe(sha(list.text));
    expect(checkTree(tree, list.text)).toMatchObject({ matched: 3, changed: 0, missing: 0, extra: 0, identical: true });
    writeFileSync(join(tree, 'a.json'), 'changed');
    rmSync(join(tree, 'b/y.json'));
    writeFileSync(join(tree, 'new.json'), 'n');
    expect(checkTree(tree, list.text)).toMatchObject({ matched: 1, changed: 1, missing: 1, extra: 1, identical: false });
    symlinkSync('/etc/hostname', join(tree, 'link.json'));
    expect(() => hashTree(tree)).toThrow('follows no links');
  });
});

// ─── the sealed key ──────────────────────────────────────────────────

describe('the sealed key in .gstack/pregate.json', () => {
  const pregate = JSON.parse(readFileSync(join(REPO, '.gstack/pregate.json'), 'utf8'));
  const sealed = pregate.sealed as { paths: string[]; answer_markers: string[]; seed_patterns: string[]; case_insensitive: boolean };

  test('covers the custody output, the seed files, the custody marker and the seed format', () => {
    expect(sealed.paths).toEqual(expect.arrayContaining(['**/rs1-custody*', '**/rs1-custody*/**', '**/*.rs1-seed']));
    expect(sealed.case_insensitive).toBe(true);
    expect(sealed.answer_markers.some(r => new RegExp(r).test(`"custody": "${MARKER}"`))).toBe(true);
    expect(sealed.seed_patterns.some(r => new RegExp(r).test(seedLine('any seed')))).toBe(true);
  });

  test('no committed RS1 file, the policy file included, matches its text rules', () => {
    const rules = [...sealed.answer_markers, ...sealed.seed_patterns].map(r => new RegExp(r));
    const committed = [join(REPO, '.gstack/pregate.json'), import.meta.path, ...files(join(REPO, 'eval/custody/rs1')).filter(p => !p.includes('__pycache__'))];
    for (const path of committed) for (const line of readFileSync(path, 'utf8').split('\n')) for (const re of rules) expect(re.test(line)).toBe(false);
  });
});
