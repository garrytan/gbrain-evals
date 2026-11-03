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
import { join, relative, resolve } from 'node:path';
import { priceRequest } from '../../eval/runner/budget-ledger.ts';
import { encodingCount } from '../../eval/runner/systems/render-v2.ts';
import { checkTree, hashTree } from '../../eval/custody/rs1/hashlist.ts';
import {
  ANSWER_FIELD, SLOTS, VALIDATOR_IDS, anthropicRequest, buildPublicIndex, chunkMessages, fakeClient, geminiRequest,
  validateSet, writeReport, type ModelClient, type Options, type PublicIndex,
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

/** A BEAM-shaped public tree: three public topics, one public chat holding PASSAGE, and one public question. */
const PASSAGE = words('public-passage', 400);
const PUBLIC_QUESTION = 'Which public dataset question appears in the BEAM release?';
function fakeBeam(root: string): string {
  const beam = join(root, 'beam');
  mkdirSync(join(beam, 'topics/1M'), { recursive: true });
  mkdirSync(join(beam, 'chats/1M/1/probing_questions'), { recursive: true });
  writeFileSync(join(beam, 'topics/1M/1M_topics.json'), JSON.stringify(['Coding', 'Math', 'Cooking'].map((category, i) => ({ id: i + 1, category, title: `Public ${category} topic`, theme: `Public theme ${i}`, subtopics: ['a', 'b', 'c'] }))));
  const turns = Array.from({ length: 10 }, (_, i) => [{ role: 'user', id: 2 * i, content: i === 3 ? PASSAGE : words(`public-u${i}`, 60) }, { role: 'assistant', id: 2 * i + 1, content: words(`public-a${i}`, 60) }]);
  writeFileSync(join(beam, 'chats/1M/1/chat.json'), JSON.stringify([{ batch_number: 1, time_anchor: 'x', turns }]));
  writeFileSync(join(beam, 'chats/1M/1/probing_questions/probing_questions.json'), JSON.stringify({ information_extraction: [{ question: PUBLIC_QUESTION, answer: 'x', rubric: ['y'] }] }));
  return beam;
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
    const r = run('bun', [VALIDATE, '--set', set, '--beam-dir', beam, '--report', report, '--fake', '--target-tokens', '30000', '--tolerance', '0.5', '--window-tokens', '4000', '--overlap-tokens', '400']);
    expect(r.code).toBe(0);
    for (const line of r.all.trim().split('\n')) expect(line).toMatch(/^rs1-validate( [a-z0-9_]+=[^ ]*)+$/);
    expect(r.out).toContain('conversations=2 keep=2 regenerate=0 drop=0 incomplete=0');
    expect(r.out).toContain('items=40 pass=40 fail=0');
    const probes = sealedProbes(set, seedLine('test seed a'));
    expect(leaks(r.all, probes)).toBe(0);
    expect(leaks(readFileSync(report, 'utf8'), probes)).toBe(0);
    expect(existsSync(join(root, 'rs1-custody-a/validate-cache'))).toBe(true);
  });

  test('a --fake run never answers a later --paid run from the reply cache', () => {
    const set = join(root, 'rs1-custody-a/set');
    const cache = join(root, 'rs1-custody-a/shared-cache');
    const report = (name: string) => join(root, 'rs1-custody-a/validation', name);
    const args = (mode: string, name: string) => [VALIDATE, '--set', set, '--beam-dir', beam, '--report', report(name), '--cache', cache, mode, '--target-tokens', '30000', '--tolerance', '0.5', '--window-tokens', '4000', '--overlap-tokens', '400'];
    expect(run('bun', args('--fake', 'fake-cached.json')).code).toBe(0);
    expect(JSON.parse(readFileSync(report('fake-cached.json'), 'utf8')).validators).toEqual(VALIDATOR_IDS.map(id => `fake-${id}`));
    const paid = run('bun', args('--paid', 'paid.json'), { GEMINI_API_KEY: 'test-gemini-key-not-real', ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', BRAINBENCH_BUDGET_LEDGER: join(root, 'ledger.sqlite') });
    expect(paid.code).toBe(2);
    expect(paid.err).toMatch(/^rs1-validate refused: /);
    expect(paid.all).not.toContain('not-real');
    expect(existsSync(report('paid.json'))).toBe(false);
  });

  test('a regenerate report from validate.ts replaces exactly the failed slots in mint.sh --regenerate', async () => {
    const set = join(root, 'rs1-custody-b/set');
    const target = 'temporal_reasoning#1';
    const failing = JSON.parse(readFileSync(join(set, 'conversations/c001/rubric/1', `${target}.json`), 'utf8')).item.question as string;
    const picky: ModelClient = { id: VALIDATOR_IDS[0], complete: async (p, m) => (p.includes(`<question>${failing}</question>`) ? '{"supported": false}' : fakeClient(VALIDATOR_IDS[0]).complete(p, m)) };
    const opts: Options = { setDir: set, beamDir: beam, reportPath: join(root, 'b-report.json'), targetTokens: 30_000, tolerance: 0.5, windowTokens: 4000, overlapTokens: 400, concurrency: 4 };
    const report = await validateSet(opts, [picky, fakeClient(VALIDATOR_IDS[1])]);
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
    const revalidated = await validateSet(opts, [fakeClient(VALIDATOR_IDS[0]), fakeClient(VALIDATOR_IDS[1])]);
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
      writeFileSync(path, JSON.stringify({ conversations: { c001: { status: 'regenerate', select_attempt: attempt, items: Object.fromEntries(SLOTS.map(s => [s, { pass: !failing.includes(s), gates: [] }])) } } }));
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
  let root = '', beam = '', index: PublicIndex;
  const options = (set: string, extra: Partial<Options> = {}): Options => ({ setDir: set, beamDir: beam, reportPath: join(root, 'report.json'), targetTokens: 1_000_000, tolerance: 0.9999, windowTokens: 600, overlapTokens: 60, concurrency: 4, ...extra });
  beforeAll(() => { root = scratch('gates'); beam = fakeBeam(root); index = buildPublicIndex(beam); });

  test('a clean set keeps every conversation and asks both validators about every item', async () => {
    const clients = fakes();
    const report = await validateSet(options(writeSet(root, [conversation('one'), conversation('two')])), clients, index);
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
    const report = await validateSet(options(writeSet(root, [conversation('clean'), dirty])), fakes(), index);
    const c = report.conversations.c002;
    expect(c.status).toBe('drop');
    expect(c.reasons).toEqual(['contamination']);
    expect(c.contamination_share!).toBeGreaterThan(0.01);
    expect(c.contamination_source).toBe('chats/1M/1/chat.json');
    expect(c.contamination_union_share!).toBeGreaterThanOrEqual(c.contamination_share!);
    expect(report.conversations.c001.contamination_share).toBe(0);
    expect(Object.keys(c.items)).toHaveLength(0);
  });

  test('a public question is contaminated, and a repeated question is a duplicate', async () => {
    const a = conversation('qa'), b = conversation('qb');
    a.items['information_extraction#0']!.question = PUBLIC_QUESTION;
    b.items['event_ordering#1']!.question = a.items['event_ordering#1']!.question;
    const report = await validateSet(options(writeSet(root, [a, b])), fakes(), index);
    expect(report.conversations.c001.items['information_extraction#0'].gates).toEqual(['contamination']);
    expect(report.conversations.c002.items['event_ordering#1'].gates).toEqual(['duplicate']);
    expect(report.conversations.c001.status).toBe('regenerate');
    expect(report.conversations.c002.status).toBe('regenerate');
  });

  test('length gate: outside the target ± tolerance in cl100k tokens drops the conversation', async () => {
    const conv = conversation('len');
    const tokens = conv.messages.reduce((s, m) => s + encodingCount('cl100k_base', m), 0);
    const keep = await validateSet(options(writeSet(root, [conv]), { targetTokens: tokens, tolerance: 0.15 }), fakes(), index);
    expect(keep.conversations.c001.tokens).toBe(tokens);
    expect(keep.conversations.c001.status).toBe('keep');
    const drop = await validateSet(options(writeSet(root, [conv]), { targetTokens: Math.round(tokens * 1.2), tolerance: 0.15 }), fakes(), index);
    expect(drop.conversations.c001.reasons).toEqual(['length']);
  });

  test('exact and near-duplicate conversations are dropped', async () => {
    const a = conversation('dup');
    const near = conversation('dup');
    for (let i = 1; i < 60; i += 10) near.messages[i] = words(`near/${i}`, 40);
    const report = await validateSet(options(writeSet(root, [a, conversation('dup'), near, conversation('fresh')])), fakes(), index);
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
    const report = await validateSet(options(writeSet(root, [conv])), [fakeClient(VALIDATOR_IDS[0]), halfBlind], index);
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
    const report = await validateSet(options(writeSet(root, [conv])), clients, index);
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
    const early = await validateSet(options(writeSet(root, [fail('f1', 1, 2), fail('f2', 2, 2)])), fakes(), index);
    expect(Object.values(early.conversations).map(c => c.status)).toEqual(['regenerate', 'regenerate']);
    expect(early.verdict).toBe('continue');
    const late = await validateSet(options(writeSet(root, [fail('f3', 3, 2), conversation('ok', 60)])), fakes(), index);
    expect(late.conversations.c001.status).toBe('drop');
    expect(late.conversations.c001.reasons).toEqual(['floor']);
    expect(late.totals.finished_fail).toBe(2);
    expect(late.verdict).toBe('continue');
    const stop = await validateSet(options(writeSet(root, [fail('f4', 3, 9), conversation('ok2', 60)])), fakes(), index);
    expect(stop.totals.finished_fail / stop.totals.finished_items).toBeGreaterThan(0.2);
    expect(stop.verdict).toBe('stop');
  });

  test('a validator error leaves the conversation incomplete, not regenerate, and cached replies are not asked again', async () => {
    const set = writeSet(root, [conversation('err'), { ...conversation('busy'), unfinished: true }]);
    const cacheDir = join(root, 'cache');
    let broken = true;
    const flaky: ModelClient = { id: VALIDATOR_IDS[0], complete: async (p, m) => { if (broken && p.includes('<question>')) throw new Error('HTTP 503'); return fakeClient(VALIDATOR_IDS[0]).complete(p, m); } };
    const first = await validateSet(options(set, { cacheDir }), [flaky, fakeClient(VALIDATOR_IDS[1])], index);
    expect(first.conversations.c001.status).toBe('incomplete');
    expect(first.conversations.c001.reasons).toEqual(['validator_error']);
    expect(first.conversations.c002.reasons).toEqual(['unfinished']);
    expect(first.totals.validator_errors).toBe(18);
    broken = false;
    const clients = [counting(flaky), counting(fakeClient(VALIDATOR_IDS[1]))];
    const second = await validateSet(options(set, { cacheDir }), clients, index);
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
    const report = await validateSet(options(set), fakes(), index);
    expect(report.conversations.c002).toMatchObject({ status: 'drop', reasons: ['topic'] });
    expect(report.totals.drop_topic).toBe(1);
    writeFileSync(manifest, JSON.stringify({ steps: { ...checks, 'topic_check@5': { status: 'done', verdict: 'accepted' } } }));
    expect((await validateSet(options(set), fakes(), index)).conversations.c002).toMatchObject({ status: 'incomplete', reasons: ['unfinished'] });
  });

  test('refuses two validators from one family', async () => {
    const set = writeSet(root, [conversation('family')]);
    await expect(validateSet(options(set), [fakeClient(VALIDATOR_IDS[0]), fakeClient('gemini:gemini-3.7-flash')], index)).rejects.toThrow('different families');
  });

  test('the budget ledger prices both validator requests (gemini-3.8-flash and claude-haiku-5-5)', () => {
    const g = geminiRequest('x'.repeat(3000), 8192), a = anthropicRequest('x'.repeat(3000), 8192);
    expect(priceRequest(g.url, g.body)).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash', maxOutputTokens: 8192 });
    expect(priceRequest(a.url, a.body)).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', maxOutputTokens: 8192 });
  });

  test('the CLI refuses paid validation without --paid and an open run, before any request, and never prints a key', () => {
    const set = writeSet(root, [conversation('cli')]);
    const env = { GEMINI_API_KEY: 'test-gemini-key-not-real', ANTHROPIC_API_KEY: 'test-anthropic-key-not-real', BRAINBENCH_BUDGET_LEDGER: join(root, 'ledger.sqlite') };
    const base = [VALIDATE, '--set', set, '--beam-dir', beam, '--report', join(root, 'cli-report.json'), '--target-tokens', '1000000', '--tolerance', '0.9999'];
    for (const args of [base, [...base, '--paid'], [...base, '--fake', '--paid']]) {
      const r = run('bun', args, env);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^rs1-validate refused: /);
      expect(r.all).not.toContain('not-real');
    }
    expect(existsSync(join(root, 'cli-report.json'))).toBe(false);
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
