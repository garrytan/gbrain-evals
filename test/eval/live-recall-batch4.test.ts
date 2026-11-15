import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { LiveRecallAbort } from '../../eval/runner/live-recall/brain.ts';
import { BATCH3_FIXTURE_QUESTIONS, FIXTURE_DIR, PRIOR_QUESTION_FILES, freezeSummaryBatch4, liveRecall, main, parseQuestions, priorOverlap } from '../../eval/runner/live-recall/run.ts';
import { COMPARISONS, PROTOCOL_TYPES, TYPES, validateScorecard } from '../../eval/runner/live-recall/scorecard.ts';
import { visibilityEpoch } from '../../eval/runner/live-recall/visibility-epoch.ts';

const gut = resolveGbrainUnderTest(null);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (fn: () => unknown) => { try { fn(); return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); } };
const abortCode = async (p: Promise<unknown>) => { try { await p; return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); } };
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};
const q = (id: string, exact: string, paraphrase: string, gold: string, type = 'topic') => JSON.stringify({ id, type, forms: { exact, paraphrase }, gold: [{ slug: gold }], gold_found_by: 'page_first' });

const b1Text = readFileSync(join(FIXTURE_DIR, 'questions.jsonl'), 'utf8');
const b2Text = q('b2-q1', 'Which runbook names the zeta failover?', 'Where do we keep the notes on switching zeta over?', 'ops/zeta-runbook') + '\n';
const b3Text = readFileSync(BATCH3_FIXTURE_QUESTIONS, 'utf8');
const expected = [
  { protocol: 'batch1' as const, sha256: sha(b1Text) },
  { protocol: 'batch2' as const, sha256: sha(b2Text) },
  { protocol: 'batch3' as const, sha256: sha(b3Text) },
];
const priors = [b1Text, b2Text, b3Text];
const b1 = parseQuestions(b1Text);
const b3 = parseQuestions(b3Text, 'batch3');
const fresh = [q('b4-q1', 'Which page lists the omega rollout dates?', 'When were we planning to ship omega?', 'brain/omega-plan'), q('b4-q2', 'What did the kappa review decide?', 'How did the kappa discussion end?', 'meetings/kappa-review', 'cross_source')].join('\n') + '\n';

describe('batch4 held-out check against earlier question files', () => {
  test('a fresh question set shares nothing with the earlier files', () => {
    expect(priorOverlap(parseQuestions(fresh, 'batch4'), priors, expected)).toEqual({ files: expected.map(p => p.sha256), question_ids: 0, forms: 0, gold_pages: 0 });
  });

  test('shared ids, forms after folding case, spacing and punctuation, and earlier gold or stale pages are each counted', () => {
    const earlier = b1[0]!, stale = b3.find(x => x.stale?.length)!.stale![0]!.slug;
    const text = [
      q(earlier.id, 'An entirely new question?', 'A new way to put it', 'brain/new-1'),
      q('b4-q3', '  ' + earlier.forms.paraphrase.toUpperCase().replace(/[?.]$/, '') + ' !! ', 'Something else', 'brain/new-2'),
      q('b4-q4', 'Fresh wording', 'Fresher wording', stale),
      q('b4-q5', 'More fresh wording', 'Still fresh', b1[1]!.gold[0]!.slug),
      q('b4-q6', 'Last fresh one', 'Truly last', b1[1]!.gold[0]!.slug),
    ].join('\n');
    expect(priorOverlap(parseQuestions(text, 'batch4'), priors, expected)).toMatchObject({ question_ids: 1, forms: 1, gold_pages: 2 });
  });

  test('the earlier files must be exactly the expected three, by sha256', () => {
    const questions = parseQuestions(fresh, 'batch4');
    expect(code(() => priorOverlap(questions, [b1Text, b2Text], expected))).toBe('LR_FREEZE_OVERLAP');
    expect(code(() => priorOverlap(questions, [b1Text, b2Text, b2Text], expected))).toBe('LR_FREEZE_OVERLAP');
    expect(code(() => priorOverlap(questions, [b1Text, b2Text, b3Text + '\n'], expected))).toBe('LR_FREEZE_OVERLAP');
    expect(code(() => priorOverlap(questions, [...priors, b2Text], expected))).toBe('LR_FREEZE_OVERLAP');
    expect(code(() => priorOverlap(questions, priors))).toBe('LR_FREEZE_OVERLAP');
    expect(PRIOR_QUESTION_FILES.map(p => p.sha256.slice(0, 12))).toEqual(['88eaa30c34d8', 'dd69701c5553', 'c023694ef59e']);
  });

  test('the batch4 freeze refuses any overlap, and a clean one records the epoch, the earlier files and G2\'s primary MDDs', () => {
    const questions = parseQuestions(fresh, 'batch4');
    const overlap = priorOverlap(questions, priors, expected);
    expect(code(() => freezeSummaryBatch4(fresh, questions, gut, { ...overlap, forms: 1 }))).toBe('LR_FREEZE_OVERLAP');
    expect(code(() => freezeSummaryBatch4(fresh, questions, gut, { ...overlap, gold_pages: 2 }))).toBe('LR_FREEZE_OVERLAP');
    const f = freezeSummaryBatch4(fresh, questions, { version: '0.60.654.0' }, overlap);
    expect(f).toMatchObject({ schema: 'live-recall-freeze/v1', protocol: 'batch4', questions_sha256: sha(fresh), n_questions: 2, gbrain_version: '0.60.654.0', visibility_epoch: 'post_gbra_398', prior_question_files: expected.map(p => p.sha256), prior_overlap: { question_ids: 0, forms: 0, gold_pages: 0 } });
    expect(Object.keys(f.mde_success_at_5)).toEqual(['p1_paraphrase', 'p2_paraphrase', 'batch1_p1_both_forms_range', 'g2_primary_paraphrase_vs_exact_configured']);
    expect(JSON.stringify(f)).not.toContain('omega');
  });

  test('a refusal names counts and hash prefixes only, never a form or slug from any file', () => {
    const shared = [q(b1[0]!.id, b1[0]!.forms.exact, 'Something new', b1[0]!.gold[0]!.slug)].join('\n');
    let message = '';
    try { freezeSummaryBatch4(shared, parseQuestions(shared, 'batch4'), gut, priorOverlap(parseQuestions(shared, 'batch4'), priors, expected)); } catch (e) { message = String(e); }
    expect(message).toContain('LR_FREEZE_OVERLAP');
    try { priorOverlap(parseQuestions(shared, 'batch4'), [b1Text], expected); } catch (e) { message += String(e); }
    for (const x of [...b1, ...b3].flatMap(x => [...Object.values(x.forms), ...x.gold.map(g => g.slug)])) expect(message).not.toContain(x);
  });

  test('the earlier files\' hashes in the runner match the frozen samples in the preregistration', () => {
    const prereg = readFileSync('docs/benchmarks/live-recall/PREREGISTRATION.md', 'utf8');
    for (const p of PRIOR_QUESTION_FILES) expect(prereg).toContain('**Question file sha256:** `' + p.sha256 + '`');
  });

  test('batch4 takes the five live types and batch 2\'s comparisons', () => {
    expect(PROTOCOL_TYPES.batch4).toEqual(TYPES);
    expect(COMPARISONS.batch4).toBe(COMPARISONS.batch2);
    expect(() => parseQuestions(b3Text, 'batch4')).toThrow('line 1 field type');
  });
});

describe('batch4 freeze and counted run refusals', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'live-recall-b4-')); writeFileSync(join(dir, 'q.jsonl'), fresh); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (freeze: unknown, gbrain = gut) => {
    writeFileSync(join(dir, 'freeze.json'), JSON.stringify(freeze));
    return abortCode(liveRecall({ fixture: false, questionsPath: join(dir, 'q.jsonl'), freezePath: join(dir, 'freeze.json'), databaseUrlEnv: 'LIVE_RECALL_TEST_UNSET', out: join(dir, 'out'), gut: gbrain }, () => {}));
  };
  const clean = () => ({ protocol: 'batch4', questions_sha256: sha(fresh), gbrain_version: gut.version, visibility_epoch: visibilityEpoch(gut.version), prior_question_files: PRIOR_QUESTION_FILES.map(p => p.sha256), prior_overlap: { question_ids: 0, forms: 0, gold_pages: 0 } });

  test('a clean batch4 freeze gets as far as the database URL, before opening any database', async () => {
    expect(await run(clean())).toBe('LR_NO_DATABASE_URL');
  });

  test('a freeze without a clean prior check, with other earlier files, or from the other epoch refuses', async () => {
    const { prior_overlap: _o, ...noOverlap } = clean();
    const { prior_question_files: _f, ...noFiles } = clean();
    expect(await run(noOverlap)).toBe('LR_FREEZE_MISMATCH');
    expect(await run(noFiles)).toBe('LR_FREEZE_MISMATCH');
    expect(await run({ ...clean(), prior_overlap: { question_ids: 0, forms: 1, gold_pages: 0 } })).toBe('LR_FREEZE_MISMATCH');
    expect(await run({ ...clean(), prior_question_files: [...PRIOR_QUESTION_FILES.map(p => p.sha256)].reverse() })).toBe('LR_FREEZE_MISMATCH');
    const other = clean().visibility_epoch === 'post_gbra_398' ? 'pre_gbra_398' : 'post_gbra_398';
    expect(await run({ ...clean(), visibility_epoch: other })).toBe('LR_FREEZE_MISMATCH');
  });

  test('the freeze command takes --prior only under batch4, and a missing or wrong earlier file writes nothing', async () => {
    const out = join(dir, 'freeze-out.json');
    expect(await quietly(() => main(['freeze', '--questions', join(dir, 'q.jsonl'), '--out', out, '--protocol', 'batch2', '--prior', join(dir, 'q.jsonl')]))).toBe(2);
    expect(await quietly(() => main(['freeze', '--questions', join(dir, 'q.jsonl'), '--out', out, '--protocol', 'batch4']))).toBe(3);
    expect(await quietly(() => main(['freeze', '--questions', join(dir, 'q.jsonl'), '--out', out, '--protocol', 'batch4', '--prior', join(FIXTURE_DIR, 'questions.jsonl'), '--prior', BATCH3_FIXTURE_QUESTIONS, '--prior', join(dir, 'q.jsonl')]))).toBe(3);
    expect(existsSync(out)).toBe(false);
  });
});

describe('batch4 fixture control (keyless)', () => {
  let dir: string;
  let card: any;
  let markdown: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-recall-b4-fixture-'));
    const paths = await liveRecall({ fixture: true, databaseUrlEnv: 'UNUSED', out: join(dir, 'run'), gut, protocol: 'batch4' }, () => {});
    card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    markdown = readFileSync(paths.markdown, 'utf8');
  }, 180_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('the scorecard carries the family band on every success@5 comparison and passes custody', () => {
    expect(() => validateScorecard(card)).not.toThrow();
    expect(card.protocol).toBe('batch4');
    expect(card.run.visibility_epoch).toBe(visibilityEpoch(gut.version));
    expect(card.run.freeze_visibility_epoch).toBeNull();
    const s5 = card.comparisons.filter((c: any) => c.metric === 'success_at_5');
    const banded = s5.filter((c: any) => 'family_ci95' in c);
    expect(banded.length).toBe(card.family.members);
    expect(banded.length).toBe(s5.filter((c: any) => c.n_pairs > 0).length);
    expect(card.comparisons.filter((c: any) => c.metric === 'mrr').some((c: any) => 'family_ci95' in c)).toBe(false);
    expect(card.family).toMatchObject({ method: 'max_t_cluster_bootstrap', level: 0.95, seed: 20261106, draws: 10000, n_strata: 5 });
    expect(Number.isFinite(card.family.critical_value)).toBe(true);
    for (const c of s5) expect(c.family_ci95 === null || (c.family_ci95.length === 2 && c.family_ci95.every(Number.isFinite))).toBe(true);
    expect(card.family.critical_value).toBeGreaterThan(1.96);
    expect(card.family.critical_value).toBeLessThanOrEqual(card.family.bonferroni_critical_value + 0.5);
    for (const c of banded.filter((c: any) => c.family_ci95 !== null)) expect(c.family_ci95[0] + c.family_ci95[1]).toBeCloseTo(2 * c.delta, 3);
    expect(markdown).toContain('## Family band (success@5, all comparisons together)');
    expect(markdown).toContain('Visibility epoch (GBRA-398)');
  });

  test('batch2 scorecards stay as they were: no family block', async () => {
    const paths = await liveRecall({ fixture: true, databaseUrlEnv: 'UNUSED', out: join(dir, 'run-b2'), gut, protocol: 'batch2' }, () => {});
    const b2 = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    expect('family' in b2).toBe(false);
    expect(b2.comparisons.some((c: any) => 'family_ci95' in c)).toBe(false);
    expect(b2.comparisons.filter((c: any) => c.metric === 'success_at_5').map((c: any) => [c.id, c.delta, c.ci95])).toEqual(card.comparisons.filter((c: any) => c.metric === 'success_at_5').map((c: any) => [c.id, c.delta, c.ci95]));
  }, 180_000);
});
