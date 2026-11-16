import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { LiveRecallAbort } from '../../eval/runner/live-recall/brain.ts';
import { BATCH3_FIXTURE_QUESTIONS, BATCH5_PRIOR_QUESTION_FILES, FIXTURE_DIR, HELD_OUT_PRIORS, PRIOR_QUESTION_FILES, archiveLayoutCounts, freezeSummaryBatch5, liveRecall, main, parseQuestions, priorOverlap } from '../../eval/runner/live-recall/run.ts';
import { COMPARISONS, EPOCH_PROTOCOLS, FILL_MIN_WINS, PROTOCOL_TYPES, TYPES } from '../../eval/runner/live-recall/scorecard.ts';
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
const b4Text = q('b4-q1', 'Which page lists the omega rollout dates?', 'When were we planning to ship omega?', 'brain/omega-plan') + '\n';
const expected = [
  { protocol: 'batch1' as const, sha256: sha(b1Text) },
  { protocol: 'batch2' as const, sha256: sha(b2Text) },
  { protocol: 'batch3' as const, sha256: sha(b3Text) },
  { protocol: 'batch4' as const, sha256: sha(b4Text) },
];
const priors = [b1Text, b2Text, b3Text, b4Text];
const fresh = [q('b5-q1', 'Which page lists the sigma launch dates?', 'When were we going to ship sigma?', 'brain/sigma-plan'), q('b5-q2', 'What did the tau review decide?', 'How did the tau discussion end?', 'meetings/tau-review', 'cross_source')].join('\n') + '\n';

describe('batch5 held-out check against the four earlier question files', () => {
  test('batch5 checks batch 4\'s three files and batch 4 itself, whose hash is the frozen one', () => {
    expect(HELD_OUT_PRIORS.batch5).toBe(BATCH5_PRIOR_QUESTION_FILES);
    expect(HELD_OUT_PRIORS.batch4).toBe(PRIOR_QUESTION_FILES);
    expect(BATCH5_PRIOR_QUESTION_FILES.map(p => p.sha256.slice(0, 12))).toEqual(['88eaa30c34d8', 'dd69701c5553', 'c023694ef59e', '69f923673764']);
    const prereg = readFileSync('docs/benchmarks/live-recall/PREREGISTRATION.md', 'utf8');
    for (const p of BATCH5_PRIOR_QUESTION_FILES) expect(prereg).toContain('`' + p.sha256 + '`');
  });

  test('a batch 4 gold page or form counts as overlap, and three files are not enough', () => {
    const questions = parseQuestions(fresh, 'batch5');
    expect(priorOverlap(questions, priors, expected)).toEqual({ files: expected.map(p => p.sha256), question_ids: 0, forms: 0, gold_pages: 0 });
    const reused = [q('b5-q3', 'When were we planning to ship omega', 'Fresh wording', 'brain/omega-plan')].join('\n');
    expect(priorOverlap(parseQuestions(reused, 'batch5'), priors, expected)).toMatchObject({ forms: 1, gold_pages: 1 });
    expect(code(() => priorOverlap(questions, priors.slice(0, 3), expected))).toBe('LR_FREEZE_OVERLAP');
  });

  test('the batch5 freeze refuses overlap, and a clean one records four earlier files, the epoch and the fill threshold', () => {
    const questions = parseQuestions(fresh, 'batch5');
    const overlap = priorOverlap(questions, priors, expected);
    expect(code(() => freezeSummaryBatch5(fresh, questions, gut, { ...overlap, question_ids: 1 }))).toBe('LR_FREEZE_OVERLAP');
    const f = freezeSummaryBatch5(fresh, questions, { version: '0.60.733.0' }, overlap);
    expect(f).toMatchObject({ protocol: 'batch5', questions_sha256: sha(fresh), n_questions: 2, gbrain_version: '0.60.733.0', visibility_epoch: 'post_gbra_398', prior_question_files: expected.map(p => p.sha256), prior_overlap: { question_ids: 0, forms: 0, gold_pages: 0 } });
    expect(f.fill_primary).toEqual({ test: 'exact_one_sided_sign', alpha: 0.05, min_wins_no_losses: 5, smallest_detectable_paraphrase: 2.5 });
    expect(FILL_MIN_WINS).toBe(5);
    expect(0.5 ** FILL_MIN_WINS).toBeLessThan(0.05);
    expect(0.5 ** (FILL_MIN_WINS - 1)).toBeGreaterThanOrEqual(0.05);
    expect(JSON.stringify(f)).not.toContain('sigma');
  });

  test('batch5 takes the five live types, batch 2\'s comparisons and the epoch rule', () => {
    expect(PROTOCOL_TYPES.batch5).toEqual(TYPES);
    expect(COMPARISONS.batch5).toBe(COMPARISONS.batch2);
    expect(EPOCH_PROTOCOLS).toContain('batch5');
    expect(() => parseQuestions(b3Text, 'batch5')).toThrow('line 1 field type');
  });
});

describe('batch5 freeze and counted run refusals', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'live-recall-b5-')); writeFileSync(join(dir, 'q.jsonl'), fresh); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (freeze: unknown) => {
    writeFileSync(join(dir, 'freeze.json'), JSON.stringify(freeze));
    return abortCode(liveRecall({ fixture: false, questionsPath: join(dir, 'q.jsonl'), freezePath: join(dir, 'freeze.json'), databaseUrlEnv: 'LIVE_RECALL_TEST_UNSET', out: join(dir, 'out'), gut }, () => {}));
  };
  const clean = () => ({ protocol: 'batch5', questions_sha256: sha(fresh), gbrain_version: gut.version, visibility_epoch: visibilityEpoch(gut.version), prior_question_files: BATCH5_PRIOR_QUESTION_FILES.map(p => p.sha256), prior_overlap: { question_ids: 0, forms: 0, gold_pages: 0 } });

  test('a clean batch5 freeze gets as far as the database URL; batch 4\'s three files alone refuse', async () => {
    expect(await run(clean())).toBe('LR_NO_DATABASE_URL');
    expect(await run({ ...clean(), prior_question_files: PRIOR_QUESTION_FILES.map(p => p.sha256) })).toBe('LR_FREEZE_MISMATCH');
    expect(await run({ ...clean(), prior_overlap: { question_ids: 0, forms: 0, gold_pages: 1 } })).toBe('LR_FREEZE_MISMATCH');
    expect(await run({ ...clean(), visibility_epoch: clean().visibility_epoch === 'post_gbra_398' ? 'pre_gbra_398' : 'post_gbra_398' })).toBe('LR_FREEZE_MISMATCH');
  });

  test('the freeze command takes --prior under batch5, and a missing or wrong earlier file writes nothing', async () => {
    const out = join(dir, 'freeze-out.json');
    expect(await quietly(() => main(['freeze', '--questions', join(dir, 'q.jsonl'), '--out', out, '--protocol', 'batch3', '--prior', join(dir, 'q.jsonl')]))).toBe(2);
    expect(await quietly(() => main(['freeze', '--questions', join(dir, 'q.jsonl'), '--out', out, '--protocol', 'batch5']))).toBe(3);
    expect(await quietly(() => main(['freeze', '--questions', join(dir, 'q.jsonl'), '--out', out, '--protocol', 'batch5', '--prior', join(FIXTURE_DIR, 'questions.jsonl'), '--prior', BATCH3_FIXTURE_QUESTIONS, '--prior', join(dir, 'q.jsonl'), '--prior', join(dir, 'q.jsonl')]))).toBe(3);
    expect(existsSync(out)).toBe(false);
  });
});

describe('conversation-archive layout counts (2026-11-16 build entry)', () => {
  test('counts live pages in gbrain #9433\'s archive layout and the distinct gold pages among them', async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE TABLE pages (slug text NOT NULL, source_id text NOT NULL, deleted_at timestamptz)');
      await db.exec(`INSERT INTO pages VALUES
        ('conversations/claude-code/2026-11-15/abc12345', 'default', NULL),
        ('conversations/days/2026-11-14', 'default', NULL),
        ('conversations/openclaw/2026-11-13', 'default', now()),
        ('notes/kept', 'conversations-owner', NULL),
        ('conversations/Claude/2026-11-15/x', 'default', NULL),
        ('conversations/claude-code/notes', 'default', NULL),
        ('meetings/2026-11-15-standup', 'default', NULL)`);
      const engine = { executeRaw: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows as any[] };
      const gold = ['conversations/days/2026-11-14', 'notes/kept', 'notes/kept', 'meetings/2026-11-15-standup', 'conversations/openclaw/2026-11-13'];
      expect(await archiveLayoutCounts(engine, gold)).toEqual({ archive_layout_pages: 3, gold_pages_in_archive_layout: 2 });
      expect(await archiveLayoutCounts(engine, [])).toEqual({ archive_layout_pages: 3, gold_pages_in_archive_layout: 0 });
    } finally {
      await db.close();
    }
  });
});
