/**
 * P8 custodian modes: the withdrawal-review pools file and the quote-grounding
 * held-out questions and sealed-confirmation corpus. Everything here is
 * synthetic: pools are built in the test, the corpus is a fixture in the
 * sealed-confirmation questions format, and no model is called.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEV_POOLS, DEV_SEED, MIN_ACTIONABLE_FAMILIES, generate, validatePools, type Wordings,
} from '../../eval/generators/p8-withdraw-review-gen.ts';
import {
  DEV_QUESTIONS, amaraPages, assertPagesExist, flaggedSpans, makeQuestions, parseQuestions, parseSealedCorpus, openSealedCorpus, renderSession, sealedPages,
} from '../../eval/runner/p8-quote-grounding.ts';
import { insideRepository, openCustodyFile, sha256Hex } from '../../eval/runner/sealed-confirmation-lib.ts';
import { haystackToPages } from '../../node_modules/gbrain/src/eval/longmemeval/adapter.ts';

const REPO = resolve(import.meta.dir, '../..');
const FIXTURE = join(REPO, 'test/eval/fixtures/p8-quote-grounding/synthetic-corpus');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'p8-custody-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const KEYS = DEV_POOLS.attrs.map(a => a.key);
const stub: Wordings = async (claim) => ({ restate1: `R1 ${claim}`, restate2: `R2 ${claim}`, negation: `N ${claim}`, temporal: `T ${claim}`, compound: `C ${claim}` });
const quiet = () => {};

/** A synthetic pools file: invented tokens, disjoint from the dev pools by construction. */
function syntheticPools(pairs = 50) {
  const names = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${String.fromCharCode(97 + i)}x`);
  return {
    first: names('Zyfir', 15),
    last: names('Qolas', 15),
    attributes: Object.fromEntries(KEYS.map(k => [k, { values: [`${k} value one`, `${k} value two`, `${k} value three`], ...(k === 'city' ? { say: '{who} has a home in {value}.' } : {}) }])),
    paraphrase_pairs: Array.from({ length: pairs }, (_, i) => ({ who: `Pairp${i} Pairq${i}`, attribute: KEYS[i % KEYS.length], value: `${KEYS[i % KEYS.length]} value one`, restatement: `hand-written restatement ${i}` })),
  };
}

describe('custody paths', () => {
  test('inside the repository: existing, not yet created, and through a symlink', () => {
    const outside = tmp();
    expect(insideRepository(join(REPO, 'eval/data'))).toBe(true);
    expect(insideRepository(join(REPO, 'eval/reports/not-there/x.json'))).toBe(true);
    expect(insideRepository(REPO)).toBe(true);
    expect(insideRepository(join(outside, 'a/b.json'))).toBe(false);
    symlinkSync(join(REPO, 'eval'), join(outside, 'link'));
    expect(insideRepository(join(outside, 'link/new.json'))).toBe(true);
  });

  test('openCustodyFile logs the open beside the file with the sha256 before handing bytes back, and refuses repository paths', () => {
    const d = tmp();
    writeFileSync(join(d, 'pools.json'), '{"secret":"held-out text"}');
    const r = openCustodyFile({ file: join(d, 'pools.json'), flag: '--pools-file', decisionId: 'd1', purpose: 'test' });
    expect(r.sha256).toBe(sha256Hex(readFileSync(join(d, 'pools.json'))));
    const line = JSON.parse(readFileSync(join(d, 'access-log.jsonl'), 'utf8').trim());
    expect([line.action, line.decision_id, line.purpose, line.labels_sha256]).toEqual(['open', 'd1', 'test', r.sha256]);
    expect(JSON.stringify(line)).not.toContain('held-out text');
    expect(() => openCustodyFile({ file: join(d, 'pools.json'), flag: '--pools-file', purpose: 'test' })).toThrow(/--decision-id and --purpose/);
    expect(() => openCustodyFile({ file: join(FIXTURE, 'questions.json'), flag: '--corpus-dir', decisionId: 'd', purpose: 'p' })).toThrow(/inside the repository/);
  });
});

describe('withdrawal-review generator pools', () => {
  test('dev pools at seed 1 still draw the committed families (claims, corrected values, independent facts)', async () => {
    const committed = readFileSync(join(REPO, 'eval/data/p8-withdraw-review/dev-seed1.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const rows = await generate(DEV_SEED, 150, 'unused', quiet, { wordings: stub });
    const pick = (rs: Array<{ id: string; fact: string; candidate: string; slice: string }>) => rs.filter(r => r.slice === 'corrected' || r.slice === 'independent').map(r => [r.id, r.fact, r.candidate]);
    expect(pick(rows)).toEqual(pick(committed));
  });

  test('a valid pools file generates pair families first, with the hand-written restatement and the say override', async () => {
    const pools = validatePools(syntheticPools());
    expect(pools.pairs.length).toBe(50);
    const rows = await generate(DEV_SEED, 60, 'unused', quiet, { pools, wordings: stub });
    const families = [...new Set(rows.map(r => r.family))];
    expect(families.length).toBe(60);
    for (const f of families.slice(0, 50)) {
      const fam = rows.filter(r => r.family === f);
      expect(fam.map(r => r.slice)).toEqual(['restates1', 'restates_human', 'corrected', 'negation', 'temporal', 'compound', 'independent']);
      expect(fam.filter(r => r.label === 'duplicate').length).toBe(2);
    }
    expect(rows.find(r => r.family === families[0] && r.slice === 'restates_human')!.candidate).toBe('hand-written restatement 0');
    expect(rows.find(r => r.family === families[1])!.fact).toBe('Pairp1 Pairq1 has a home in city value one.');
    for (const f of families.slice(50)) expect(rows.filter(r => r.family === f).map(r => r.slice)).toContain('restates2');
    const devTokens = [...DEV_POOLS.first, ...DEV_POOLS.last, ...DEV_POOLS.attrs.flatMap(a => a.values)];
    for (const r of rows) for (const t of devTokens) expect(r.candidate.includes(t) ? `${r.id}: ${t}` : null).toBeNull();
    for (const r of rows.filter(r => r.slice === 'corrected')) expect(r.candidate).not.toBe(r.fact);
  });

  test('rejects overlap with the dev pools, wrong keys, bad templates, too few pairs and too few people, without echoing pool text', () => {
    const bad = (mutate: (p: ReturnType<typeof syntheticPools>) => void, re: RegExp) => {
      const p = syntheticPools();
      mutate(p);
      expect(() => validatePools(p)).toThrow(re);
    };
    bad(p => { p.first[0] = DEV_POOLS.first[0]!; }, /first: 1 name\(s\) also in the dev pools/);
    bad(p => { (p.attributes as Record<string, { values: string[] }>).employer!.values[0] = DEV_POOLS.attrs[0]!.values[0]!; }, /attributes.employer: 1 value\(s\) also in the dev pools/);
    bad(p => { delete (p.attributes as Record<string, unknown>).pet; }, /exactly the dev keys/);
    bad(p => { (p.attributes as Record<string, { say?: string }>).diet!.say = '{who} eats things.'; }, /diet.say must be a string containing \{who\} and \{value\}/);
    bad(p => { p.paraphrase_pairs = p.paraphrase_pairs.slice(0, 49); }, /has 49; at least 50/);
    bad(p => { p.first = p.first.slice(0, 10); p.last = p.last.slice(0, 10); }, new RegExp(`allows 100 people; at least ${MIN_ACTIONABLE_FAMILIES}`));
    bad(p => { p.paraphrase_pairs[3]!.value = 'not a pool value'; }, /paraphrase_pairs\[3\]: value is not one of/);
    bad(p => { p.paraphrase_pairs[4]!.who = p.paraphrase_pairs[2]!.who; }, /paraphrase_pairs\[4\]: who is used by an earlier pair/);
    bad(p => { p.paraphrase_pairs[5]!.who = `${DEV_POOLS.first[1]} Newlast`; }, /paraphrase_pairs\[5\]: who uses a name from the dev pools/);
    const p = syntheticPools();
    p.first[0] = DEV_POOLS.first[0]!;
    try { validatePools(p); } catch (e) { expect((e as Error).message).not.toContain(DEV_POOLS.first[0]!); }
    expect(validatePools(syntheticPools(3), { minPairs: 0 }).pairs.length).toBe(3);
  });

  test('CLI refuses held-out seeds in dev mode and dev seeds, repository paths and missing decision ids in custodian mode, before any read', () => {
    const d = tmp();
    writeFileSync(join(d, 'pools.json'), JSON.stringify(syntheticPools()));
    const run = (...args: string[]) => spawnSync(process.execPath, ['eval/generators/p8-withdraw-review-gen.ts', ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' } });
    expect(run('--seed', '2', '--out', join(d, 'o.jsonl')).stderr).toContain('only dev seed 1 runs here');
    expect(run('--pools-file', join(d, 'pools.json'), '--decision-id', 'x', '--purpose', 'y', '--seed', '1', '--out', join(d, 'o.jsonl')).stderr).toContain('needs a held-out seed');
    expect(run('--pools-file', join(d, 'pools.json'), '--decision-id', 'x', '--purpose', 'y', '--seed', '9', '--out', join(REPO, 'eval/reports/o.jsonl')).stderr).toContain('--out');
    expect(run('--pools-file', join(d, 'pools.json'), '--seed', '9', '--out', join(d, 'o.jsonl')).stderr).toContain('--decision-id and --purpose');
    expect(existsSync(join(d, 'access-log.jsonl'))).toBe(false);
    expect(existsSync(join(d, 'o.jsonl'))).toBe(false);
  });
});

describe('quote grounding: sealed-confirmation corpus loader', () => {
  test('reads the questions format, one page per session, rendered as gbrain\'s LongMemEval adapter renders a session', () => {
    const bytes = readFileSync(join(FIXTURE, 'questions.json'));
    const pages = sealedPages(parseSealedCorpus(bytes));
    expect(pages.map(p => [p.haystack, p.page])).toEqual([
      ['h-0a1b2c3d4e', 'chats/s-1a2b3c4d5e'], ['h-0a1b2c3d4e', 'chats/s-2b3c4d5e6f'], ['h-0a1b2c3d4e', 'chats/s-3c4d5e6f7a'],
      ['h-4d5e6f7a8b', 'chats/s-4d5e6f7a8b'], ['h-4d5e6f7a8b', 'chats/s-5e6f7a8b9c'],
    ]);
    const q = JSON.parse(bytes.toString('utf8'));
    const h = q.haystacks[0];
    const theirs = haystackToPages({ question_id: 'x', question_type: 'x', question: 'x', answer: 'x', haystack_sessions: h.sessions.map((s: Parameters<typeof renderSession>[0]) => ({ session_id: s.session_id, turns: s.turns })), haystack_dates: h.sessions.map((s: { date: string }) => s.date), answer_session_ids: [] } as Parameters<typeof haystackToPages>[0]);
    const dropId = (c: string) => c.replace(/^session_id: .*$/m, '');
    expect(h.sessions.map((s: Parameters<typeof renderSession>[0]) => dropId(renderSession(s)))).toEqual(theirs.map(t => dropId(t.content)));
  });

  test('checks the manifest commitment and the input allowlist; never needs labels.json', () => {
    const bytes = readFileSync(join(FIXTURE, 'questions.json'));
    expect(() => parseSealedCorpus(bytes, { commitments: { 'questions.json': { sha256: sha256Hex(bytes), bytes: bytes.length } } })).not.toThrow();
    expect(() => parseSealedCorpus(bytes, { commitments: { 'questions.json': { sha256: '0'.repeat(64), bytes: bytes.length } } })).toThrow(/manifest commitment/);
    expect(() => parseSealedCorpus(bytes, { commitments: {} })).toThrow(/no questions.json commitment/);
    const leaky = JSON.parse(bytes.toString('utf8'));
    leaky.questions[0].answer = 'x';
    expect(() => parseSealedCorpus(Buffer.from(JSON.stringify(leaky)))).toThrow(/not on the input allowlist/);
    expect(existsSync(join(FIXTURE, 'labels.json'))).toBe(false);
  });

  test('custodian open: access-logged in the corpus directory, sha256 returned, repository copies refused', () => {
    const d = join(tmp(), 'corpus');
    cpSync(FIXTURE, d, { recursive: true });
    const r = openSealedCorpus({ dir: d, decisionId: 'dec', purpose: 'make held-out questions' });
    expect(r.pages.length).toBe(5);
    expect(r.sha256).toBe(sha256Hex(readFileSync(join(d, 'questions.json'))));
    expect(JSON.parse(readFileSync(join(d, 'access-log.jsonl'), 'utf8').trim()).labels_sha256).toBe(r.sha256);
    expect(() => openSealedCorpus({ dir: FIXTURE, decisionId: 'dec', purpose: 'p' })).toThrow(/inside the repository/);
  });
});

describe('quote grounding: flag attribution', () => {
  test('a supported span inside or around a different flagged quote stays kept', () => {
    const long = 'the team is strong, and the execution record is hard to ignore';
    expect(flaggedSpans([long, 'hard to ignore'], [long])).toEqual([true, false]);
    expect(flaggedSpans([long, 'hard to ignore'], ['hard to ignore'])).toEqual([false, true]);
    expect(flaggedSpans(['threshold conversion model', 'threshold conversion model,'], ['threshold conversion model,'])).toEqual([false, true]);
  });

  test('matches gbrain\'s reported form: whitespace collapsed, clipped at 300 characters', () => {
    const span = `${'word '.repeat(80)}end`;
    const reported = `${span.replace(/\s+/g, ' ').slice(0, 297)}...`;
    expect(flaggedSpans([span, 'two  spaced\nwords here'], [reported, 'two spaced words here'])).toEqual([true, true]);
    expect(flaggedSpans(['no flags at all here'], [])).toEqual([false]);
  });
});

describe('quote grounding: questions', () => {
  test('the dev file reads as amara questions whose pages exist', () => {
    const doc = parseQuestions(JSON.parse(readFileSync(join(REPO, DEV_QUESTIONS), 'utf8')));
    expect(doc.seed).toBe(1);
    expect(new Set(doc.questions.map(q => q.corpus))).toEqual(new Set(['amara']));
    expect(() => assertPagesExist(doc.questions, amaraPages())).not.toThrow();
    expect(() => assertPagesExist([{ ...doc.questions[0]!, page: 'notes/missing.md' }], amaraPages())).toThrow(/missing from their corpus/);
    expect(() => parseQuestions({ seed: 1, questions: [{ id: 'a', corpus: 'sealed-confirmation', page: 'chats/s', kind: 'quote', question: 'q' }] })).toThrow(/names its haystack/);
  });

  test('makeQuestions draws pages from the chosen corpus, records haystacks, splits 70/30 and honours the exclusion set', async () => {
    const pages = [...amaraPages(), ...sealedPages(parseSealedCorpus(readFileSync(join(FIXTURE, 'questions.json'))))];
    const prompts: string[] = [];
    const ask = async (_m: string, p: string) => { prompts.push(p); return `"Question ${prompts.length}?"`; };
    const qs = await makeQuestions({ pages, corpus: 'sealed-confirmation', n: 4, seed: 1, model: 'm', ask });
    expect(qs.length).toBe(4);
    expect(qs.map(q => q.kind)).toEqual(['quote', 'quote', 'quote', 'natural']);
    for (const q of qs) expect([q.corpus, q.page.startsWith('chats/'), typeof q.haystack]).toEqual(['sealed-confirmation', true, 'string']);
    expect(qs[0]!.question).toBe('Question 1?');
    expect(prompts[0]).toContain('conversation between a user and an assistant');
    expect(() => assertPagesExist(qs, pages)).not.toThrow();
    const again = await makeQuestions({ pages, corpus: 'sealed-confirmation', n: 4, seed: 1, model: 'm', ask });
    expect(again.map(q => q.page)).toEqual(qs.map(q => q.page));
    const devPages = new Set(parseQuestions(JSON.parse(readFileSync(join(REPO, DEV_QUESTIONS), 'utf8'))).questions.map(q => q.page));
    const amara = await makeQuestions({ pages, corpus: 'amara', n: 30, seed: 1, model: 'm', ask, exclude: devPages });
    for (const q of amara) expect([q.corpus, devPages.has(q.page), q.haystack]).toEqual(['amara', false, undefined]);
  });

  test('CLI refuses sealed questions in dev mode and custody paths or dev seeds that break custodian rules, before any model call', () => {
    const d = tmp();
    const run = (...args: string[]) => spawnSync(process.execPath, ['eval/runner/p8-quote-grounding.ts', ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GBRAIN_EVALS_QA_CACHE: join(d, 'cache') } });
    writeFileSync(join(d, 'dev-sealed.json'), JSON.stringify({ seed: 1, questions: [{ id: 'a', corpus: 'sealed-confirmation', haystack: 'h-0a1b2c3d4e', page: 'chats/s-1a2b3c4d5e', kind: 'quote', question: 'q' }] }));
    expect(run('--questions', join(d, 'dev-sealed.json'), '--out', join(d, 'out')).stderr).toContain('custodian-only');
    writeFileSync(join(d, 'seed9.json'), JSON.stringify({ seed: 9, questions: [] }));
    expect(run('--questions', join(d, 'seed9.json'), '--out', join(d, 'out')).stderr).toContain('only dev seeds 1 run here');
    expect(run('--heldout-questions', join(REPO, DEV_QUESTIONS), '--decision-id', 'x', '--purpose', 'y', '--out', join(d, 'out')).stderr).toContain('inside the repository');
    expect(run('--heldout-questions', join(d, 'seed9.json'), '--decision-id', 'x', '--purpose', 'y', '--out', join(REPO, 'eval/reports/x')).stderr).toContain('--out');
    expect(run('--make-questions', '--seed', '1', '--decision-id', 'x', '--purpose', 'y', '--out-questions', join(d, 'q.json')).stderr).toContain('needs a held-out seed');
    expect(run('--make-questions', '--corpus', 'sealed-confirmation', '--seed', '9', '--out-questions', join(d, 'q.json')).stderr).toContain('--decision-id and --purpose');
    expect(run('--make-questions', '--seed', '9', '--out-questions', join(d, 'q.json')).stderr).toContain('only dev seeds 1 run here');
    expect(run('--make-questions', '--corpus', 'sealed-confirmation', '--seed', '9', '--decision-id', 'x', '--purpose', 'y', '--out-questions', join(REPO, 'eval/reports/q.json')).stderr).toContain('inside the repository');
    expect(existsSync(join(d, 'q.json'))).toBe(false);
  });
});
