/**
 * The nightly runner (eval/runner/nightly/run.ts) and its suite adapters (adapters.ts): tiers, the ancestor check, each
 * adapter's command and its reading of the runner's records into outcome rows, the tool-contract replay through all
 * three paths of the pinned build, and run.ts --fake end to end on a two-item slice with every key blanked and a dead
 * upstream (that last test needs a gbrain clone in NIGHTLY_GBRAIN_CLONE; it builds an overlay and a worktree there).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import type { HardTask } from '../../eval/generators/hard/schema.ts';
import type { MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import { classify, nightlyFailure } from '../../eval/runner/failure-causes/index.ts';
import { cat40Commands, cat40DevSet, cat40Rows, episodeRows, judgeFor, latestRowPerItem, outcome, qaCommand, qaRows, replayAdapter, seedRanges, skippedRows, smokeRows, SUITE_FACTS, toolErrorFromText,
  trialRows, type NightContext, type SuiteRun } from '../../eval/runner/nightly/adapters.ts';
import { canonicalDigest, loadDevSet } from '../../eval/runner/nightly/devset.ts';
import { NightlyCache } from '../../eval/runner/nightly/judge-cache.ts';
import { buildDevSet } from '../../eval/runner/nightly/select-devset.ts';
import { keylessEnv } from '../../eval/runner/nightly/keyless.ts';
import { harnessCause, qualifiedModel, readOutcomes, resumable, type Outcome } from '../../eval/runner/nightly/outcome.ts';
import { main, parseArgs, planSuites, requirementGap } from '../../eval/runner/nightly/run.ts';
import { isContentMiss, recordedCalls, replayItems } from '../../eval/runner/nightly/tool-contract.ts';

const ROOT = resolve(import.meta.dir, '../..');
const devset = loadDevSet();
const tmp = () => mkdtempSync(join(tmpdir(), 'nightly-run-'));
const plan = (...argv: string[]) => { const a = parseArgs(['--out', '/tmp/x', ...argv]); return planSuites(devset, a); };
const ctx = (o: Partial<NightContext> = {}): NightContext => ({
  night: '2026-11-09', ref: 'master', sha: 'c'.repeat(40), dir: tmp(), tier: 'matrix', fake: false, clone: '/g', overlayRoot: '/o', worktree: async () => '/w', overlayFor: async () => '/o',
  cache: new NightlyCache(tmp()), paid: { runId: 'nightly:2026-11-09:master-x', ledger: '/ledger.sqlite' }, pg: { admin: null, template: null, pg15Admin: null },
  smokeRefs: { previous: null, old: null }, cat40SlotAllowanceUsd: 1, log: () => {}, signal: new AbortController().signal, ...o,
});
const suiteRun = (id: string, items?: string[], o: Partial<SuiteRun> = {}): SuiteRun => {
  const suite = devset.suites.find(s => s.id === id)!;
  return { suite, digest: 'digest', items: suite.items.filter(i => !items || items.includes(i.id)), readers: ['claude-opus-5-5', 'gpt-6.1-sol'], k: 1, ...o };
};

describe('tiers and the ancestor check', () => {
  test('nightly: the five cheap suites, agent suites on gpt-6.1-sol at k = 3, keyless suites with no reader', () => {
    const p = plan('--tier', 'nightly');
    expect(p.map(r => r.suite.id).sort()).toEqual(['concurrent-writers', 'refresh-barrier-agents', 'refused-write-agents', 'system-smokes', 'tool-contract-replay']);
    expect(p.find(r => r.suite.id === 'refused-write-agents')).toMatchObject({ readers: ['gpt-6.1-sol'], k: 3 });
    expect(p.find(r => r.suite.id === 'concurrent-writers')).toMatchObject({ readers: [null], k: 1 });
  });

  test('matrix: every suite, both frontier readers, k = 3 on agent suites and 1 on QA; smoke: every item once', () => {
    const m = plan('--tier', 'matrix');
    expect(m.length).toBe(devset.suites.length);
    expect(m.find(r => r.suite.id === 'cat40-hard-m')).toMatchObject({ readers: ['claude-opus-5-5', 'gpt-6.1-sol'], k: 3, items: devset.suites.find(s => s.id === 'cat40-hard-m')!.items });
    expect(m.find(r => r.suite.id === 'lme-s-hard')).toMatchObject({ k: 1 });
    expect(plan('--tier', 'smoke').every(r => r.k === 1)).toBe(true);
  });

  test('a particle-1 reader goes to the QA suites only, because Part C and Cat 40 Hard run Claude and GPT readers', () => {
    const p = plan('--tier', 'matrix', '--readers', 'claude-opus-5-5,particle-1');
    for (const id of ['cat40-hard-m', 'refresh-barrier-agents', 'refused-write-agents']) expect(p.find(r => r.suite.id === id)!.readers).toEqual(['claude-opus-5-5']);
    for (const id of ['lme-s-hard', 'beam-1m-hard']) expect(p.find(r => r.suite.id === id)!.readers).toEqual(['claude-opus-5-5', 'particle-1']);
    expect(plan('--tier', 'matrix', '--readers', 'particle-1').filter(r => r.suite.kind === 'agent')).toEqual([]);
  });

  test('--suites and --items narrow the plan; an engine-prefixed item selects its seed; an unknown suite is refused', () => {
    const p = plan('--tier', 'matrix', '--items', '2001,pglite:5002,sol-query');
    expect(p.map(r => [r.suite.id, r.items.map(i => i.id)])).toEqual([['refused-write-agents', ['2001']], ['concurrent-writers', ['5002']], ['tool-contract-replay', ['sol-query']]]);
    expect(() => plan('--suites', 'no-such-suite')).toThrow('unknown suites no-such-suite');
  });

  test('flag refusals: the smoke tier runs on master; a bisect step names one suite, its items and a night directory', () => {
    expect(() => parseArgs(['--out', '/tmp/x', '--tier', 'smoke', '--ref', 'stable'])).toThrow('the smoke tier runs on master');
    expect(() => parseArgs(['--tier', 'bisect', '--suites', 'a,b', '--items', 'x', '--night-dir', '/tmp/n'])).toThrow('--tier bisect takes one --suites id');
    expect(() => parseArgs(['--tier', 'nightly'])).toThrow('--out <dir> is required');
  });

  test('a suite whose required commit is not an ancestor is skipped with the reason', () => {
    const repo = tmp();
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    const one = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    const two = git('rev-parse', 'HEAD');
    expect(requirementGap(repo, two, one)).toBeNull();
    expect(requirementGap(repo, two, undefined)).toBeNull();
    expect(requirementGap(repo, one, two)).toBe(`gbrain ${one.slice(0, 12)} predates ${two.slice(0, 12)}, which this suite needs`);
    expect(requirementGap(repo, two, 'f'.repeat(40))).toBe('the clone does not have ffffffffffff, which this suite needs');
  });
});

describe('adapter commands', () => {
  test('readers and judges: GPT-6 Astra judges Claude and particle-1 rows, so the two share a judge, and Claude Opus 5.5 judges GPT rows', () => {
    expect(qualifiedModel('claude-opus-5-5')).toBe('anthropic:claude-opus-5-5');
    expect(qualifiedModel('gpt-6.1-sol')).toBe('openai:gpt-6.1-sol');
    expect(judgeFor('claude-opus-5-5')).toBe('openai:gpt-6-astra');
    expect(judgeFor('particle-1')).toBe('openai:gpt-6-astra');
    expect(judgeFor('particle:particle-1')).toBe('openai:gpt-6-astra');
    expect(judgeFor('gpt-6.1-sol')).toBe('anthropic:claude-opus-5-5');
  });

  test('Cat 40: the gbrain-hard arm on world M with the dev set\'s tasks; scripted on keyword-only slots on a fake night; the paid night joins the ledger run', () => {
    const run = suiteRun('cat40-hard-m', ['H1-02', 'H1-03'], { k: 3 });
    const dirs = { root: '/r', slots: '/s', cells: '/c' };
    const paid = cat40Commands(run, ctx(), '/cache/world/world.json', dirs);
    expect(paid.cells.join(' ')).toContain('--arms gbrain --gbrain-label gbrain-hard --tasks H1-02,H1-03 --repeat 3');
    expect(paid.cells.join(' ')).toContain('--models claude-opus-5-5,gpt-6.1-sol --judge gpt-6.1-sol --budget-run-id nightly:2026-11-09:master-x --budget-ledger /ledger.sqlite');
    expect(paid.world[1]!.join(' ')).toContain('--mode hard --seed 20261021 --knobs ' + join(ROOT, 'docs/benchmarks/cat40-hard/knobs.frozen.json') + ' --scale large');
    expect(paid.slots).toHaveLength(5);
    expect([paid.cells, ...paid.slots].every(cmd => cmd.includes('--dev-set'))).toBe(true);
    paid.slots.forEach((cmd, i) => {
      expect(cmd.join(' ')).toContain(`--slots 5 --build-slot-ids ${i} --slot-build-allowance-usd`);
      expect(cmd.join(' ')).toContain(`--budget-ledger /ledger.sqlite --out /s/slot${i}`);
    });
    const fake = cat40Commands(run, ctx({ fake: true, paid: null }), '/cache/world/world.json', dirs);
    expect(fake.cells).toContain('--scripted');
    expect(fake.cells).toContain('--keyless-slots');
    expect(fake.cells.join(' ')).not.toContain('--models');
    expect(fake.slots.flat().join(' ')).not.toContain('--budget');
    expect(fake.slots.every(cmd => cmd.includes('--keyless-slots'))).toBe(true);
    expect(() => cat40Commands(run, ctx({ cat40SlotAllowanceUsd: null }), '/w', dirs)).toThrow('--cat40-slot-allowance-usd');
  });

  test('Cat 40: the suite carries the newest cells receipt\'s dev-set label and drifted files', () => {
    const cells = mkdtempSync(join(tmpdir(), 'nightly-cat40-'));
    expect(cat40DevSet(cells)).toBeNull();
    writeFileSync(join(cells, 'receipt-900.json'), JSON.stringify({ dev_set: { label: 'old', freeze_drift: [] } }));
    writeFileSync(join(cells, 'receipt-1000.json'), JSON.stringify({ dev_set: { label: 'dev-set run', freeze_drift: ['eval/runner/cat40/loop.ts'] } }));
    expect(cat40DevSet(cells)).toEqual({ label: 'dev-set run', freeze_drift: ['eval/runner/cat40/loop.ts'] });
    expect(cat40DevSet(join(cells, 'missing'))).toBeNull();
  });

  test('QA: gbrain\'s own defaults, real embeddings, one reader and its cross-family judge, the --ids filter; the fake night uses the fake system', () => {
    const run = suiteRun('beam-1m-hard');
    const cmd = qaCommand(run, ctx(), 'gpt-6.1-sol', '/ids.txt', '/out').join(' ');
    expect(cmd).toContain('--benchmark beam-1m --split dev --gbrain /g@' + 'c'.repeat(40) + ' --gbrain-defaults --embed real --qa reader --reader openai:gpt-6.1-sol --judge anthropic:claude-opus-5-5 --ids /ids.txt --paid --budget-run-id');
    expect(qaCommand(run, ctx({ fake: true, paid: null }), 'fake', '/ids.txt', '/out').slice(3)).toEqual(['--benchmark', 'beam-1m', '--system', 'fake', '--ids', '/ids.txt', '--output', '/out']);
  });

  test('QA: the reader gets its suite\'s output limit, 8,192 tokens on both QA suites, and a paid QA suite that names none is refused', () => {
    expect(buildDevSet()).toEqual(devset);
    expect(devset.suites.filter(s => s.kind === 'qa').map(s => [s.id, s.config?.qa_max_tokens])).toEqual([['lme-s-hard', 8192], ['beam-1m-hard', 8192]]);
    for (const id of ['lme-s-hard', 'beam-1m-hard']) expect(qaCommand(suiteRun(id), ctx(), 'claude-opus-5-5', '/ids.txt', '/out').join(' ')).toContain('--qa-max-tokens 8192 --output /out');
    const run = suiteRun('beam-1m-hard');
    const bare = { ...run, suite: { ...run.suite, config: { benchmark: 'beam-1m', split: 'dev' } } };
    expect(() => qaCommand(bare, ctx(), 'claude-opus-5-5', '/ids.txt', '/out')).toThrow('qa_max_tokens');
    expect(qaCommand(bare, ctx({ fake: true, paid: null }), 'fake', '/ids.txt', '/out')).not.toContain('--qa-max-tokens');
  });

  test('concurrency trials take contiguous seed ranges', () => {
    expect(seedRanges([5001, 5002, 5003, 5007, 5009, 5008])).toEqual(['5001-5003', '5007-5009']);
  });
});

describe('reading runner records into outcome rows', () => {
  test('gbrain tool errors: a coded refusal, and a crash', () => {
    expect(toolErrorFromText('get_page', 'Error: {"error":"invalid_params","message":"slug must be a string"}')).toEqual({ tool: 'get_page', code: 'invalid_params', refused: true, message: 'slug must be a string' });
    expect(toolErrorFromText('search', 'Error: {"code":"internal_error","message":"boom"}')!.refused).toBe(false);
    expect(toolErrorFromText('search', '{"results":[]}')).toBeNull();
  });

  test('Cat 40 cells: the canonical attempt, its transcript\'s refusals, cost with the judge, and a harness row for a key with no clean attempt', () => {
    const dir = tmp();
    const cell = (o: Record<string, unknown>) => ({ schema: 'cat40-cell-v2', attempt: 1, model: 'gpt-6.1-sol', arm: 'gbrain-hard', family: 'H1', repeat: 0, stop: 'submitted',
      score: { success: false, submitted: true, said_wrong: false, evidence_cited: ['d1'], missed_evidence: ['d2'], wrote: false }, claims: null, total_usd: 0.25, judge_usd: 0.05,
      sessions: [{ index: 1, role: 'question', stop: 'submitted', usd: 0.25, run: { turns: 4, tool_calls: [{ name: 'search', ms: 5, chars: 10, truncated: false }] } }],
      timings: { agent_ms: 1 }, wall_ms: 2, experiment: { scale: 'large' }, ...o });
    const lines = [cell({ key: 'gpt-6.1-sol|gbrain-hard|H1-02|0', attempt_id: 'gpt-6.1-sol|gbrain-hard|H1-02|0#1', task: 'H1-02' }),
      cell({ key: 'gpt-6.1-sol|gbrain-hard|H1-03|0', attempt_id: 'gpt-6.1-sol|gbrain-hard|H1-03|0#1', task: 'H1-03', stop: 'harness_error', error: 'MCP server exited' })];
    writeFileSync(join(dir, 'attempts.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(dir, 'transcripts.jsonl'), JSON.stringify({ key: 'gpt-6.1-sol|gbrain-hard|H1-02|0', attempt_id: 'gpt-6.1-sol|gbrain-hard|H1-02|0#1',
      tools: [{ session: 1, name: 'get_page', args: {}, result: 'Error: {"error":"invalid_params","message":"bad selector"}' }, { session: 1, name: 'search', args: {}, result: '{"results":[]}' }] }) + '\n');
    const rows = cat40Rows(suiteRun('cat40-hard-m', ['H1-02', 'H1-03']), ctx(), dir);
    expect(rows.map(r => [r.item, r.reader, r.trial, r.pass, r.harness?.error ?? null])).toEqual([['H1-02', 'gpt-6.1-sol', 1, false, null], ['H1-03', 'gpt-6.1-sol', 1, false, 'every attempt was a harness error']]);
    expect(rows[0]).toMatchObject({ cost_usd: 0.3, tool_errors: [{ tool: 'get_page', code: 'invalid_params', refused: true }], evidence: { kind: 'agent-qa', missed_evidence: ['d2'], evidence_cited: ['d1'] } });
  });

  test('Part C episodes: the nightly score, refused calls, and a provider stop as a harness row', () => {
    const dir = tmp();
    const score = { pass: false, tokens_once: false, report_correct: true, no_resend: true, duplicated: ['F3'], missing: [], acknowledged_missing: [], resent: [], misreports: [], unreported: [] };
    writeFileSync(join(dir, 'task-2001-t1.json'), JSON.stringify({ usd: 0.02, loop: { stop: 'submitted' }, nightly_score: score, score: { success: false },
      calls: [{ name: 'put_page', cls: 'refused', code: 'worktree_refreshing', harness_error: null }, { name: 'put_page', cls: 'committed', code: null, harness_error: null }], behavior: { refusals: [{ outcome: 'retried_same_id' }] } }));
    writeFileSync(join(dir, 'task-2001-t2.json'), JSON.stringify({ usd: 0, loop: { stop: 'error', error: '529 overloaded' }, nightly_score: { ...score, pass: false }, calls: [], behavior: { refusals: [] } }));
    const rows = episodeRows(suiteRun('refused-write-agents', ['2001'], { k: 2 }), ctx(), 'gpt-6.1-sol', dir).sort((a, b) => a.trial - b.trial);
    expect(rows[0]).toMatchObject({ item: '2001', trial: 1, pass: false, cost_usd: 0.02, tool_errors: [{ tool: 'put_page', code: 'worktree_refreshing', refused: true }],
      evidence: { kind: 'write', duplicated: ['F3'], refusal_outcomes: ['retried_same_id'], counted_scorer_success: false } });
    expect(rows[1]!.harness).toEqual({ error: 'error: 529 overloaded' });
  });

  test('concurrency trials: failure classes from Part A\'s own checks, a placeholder as a harness row', () => {
    const dir = tmp();
    const ok = { flags: { converge: { ok: true }, quiesce: { ok: true } }, ops: [{ state: 'committed' }], switches: [{ refresh_barrier: true }], arm: 'on', faults: {}, upstream: { missing_head: 0 } };
    writeFileSync(join(dir, '5001.json'), JSON.stringify(ok));
    writeFileSync(join(dir, '5002.json'), JSON.stringify({ ...ok, ops: [{ state: 'committed', duplicated: true }] }));
    writeFileSync(join(dir, '5003.json'), JSON.stringify({ seed: 5003, ops: [], placeholder: true, harness_error: { exit: 1 } }));
    const rows = trialRows(suiteRun('concurrent-writers', ['5001', '5002', '5003']), ctx(), 'pglite', dir).sort((a, b) => a.item.localeCompare(b.item));
    expect(rows.map(r => [r.item, r.pass, r.evidence.failure_classes, r.harness !== null])).toEqual([['pglite:5001', true, [], false], ['pglite:5002', false, ['duplicated'], false], ['pglite:5003', false, [], true]]);
  });

  test('QA rows: a judged row passes at a judge score of at least 0.5; a provider error is a harness row; a fake night scores retrieval', () => {
    const dir = tmp();
    const rows = [{ id: '0a995998', abstention: false, recall_all_at_5: 1, recall_any_at_5: 1, qa_score: 1, qa_answer: 'Paris', retrieved: ['s1'], qa_receipts: [{ role: 'reader', from_cache: true }] },
      { id: '08f4fc43', abstention: false, recall_all_at_5: 0, recall_any_at_5: 0, qa_score: 0, qa_answer: 'Lyon', retrieved: ['s9'] },
      { id: '0bc8ad93', abstention: false, qa_error: 'anthropic 529' }];
    writeFileSync(join(dir, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ cost_usd_all_attempts: 0.3 }));
    const out = qaRows(suiteRun('lme-s-hard', ['0a995998', '08f4fc43', '0bc8ad93']), ctx(), 'gpt-6.1-sol', dir, 'anthropic:claude-opus-5-5');
    expect(out.map(r => [r.item, r.pass, r.score, r.harness?.error ?? null])).toEqual([['0a995998', true, 1, null], ['08f4fc43', false, 0, null], ['0bc8ad93', false, null, 'anthropic 529']]);
    expect(out[0]!.cost_usd).toBeCloseTo(0.1, 10);
    expect(out[0]!.evidence).toMatchObject({ kind: 'qa', judge: 'anthropic:claude-opus-5-5', reader_from_cache: true });
    const fake = qaRows(suiteRun('lme-s-hard', ['0a995998', '08f4fc43']), ctx({ fake: true }), 'fake', dir, null);
    expect(fake.map(r => [r.pass, r.score])).toEqual([[true, 1], [false, 0]]);
  });

  test('QA rows: a retried question keeps its newest non-harness row, not the failed first attempt', () => {
    const dir = tmp();
    const rows = [{ id: '0a995998', abstention: false, qa_error: 'anthropic 529' },
      { id: '0a995998', abstention: false, recall_all_at_5: 1, recall_any_at_5: 1, qa_score: 1, qa_answer: 'Paris', retrieved: ['s1'] },
      { id: '08f4fc43', abstention: false, qa_error: 'anthropic 529' }];
    writeFileSync(join(dir, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const all = qaRows(suiteRun('lme-s-hard', ['0a995998', '08f4fc43']), ctx(), 'gpt-6.1-sol', dir, 'anthropic:claude-opus-5-5');
    expect(latestRowPerItem(all, ['0a995998', '08f4fc43']).map(r => [r.item, r.pass, r.harness?.error ?? null])).toEqual([['0a995998', true, null], ['08f4fc43', false, 'anthropic 529']]);
  });

  test("QA rows: a failed reading lane records whose call failed, the judge's (a shared stage) or the reader's own, so a judge error isn't read as the reader's", () => {
    const dir = tmp();
    const rows = [{ id: '0a995998', abstention: false, qa_error: 'openai 500: The server had an error', qa_receipts: [{ role: 'reader', status: 'ok', finish: 'stop' }, { role: 'judge', status: 'error' }] },
      { id: '08f4fc43', abstention: false, qa_error: 'particle 503: Service Unavailable', qa_receipts: [{ role: 'reader', status: 'error' }] },
      { id: '0bc8ad93', abstention: false, qa_error: 'no call was made' }];
    writeFileSync(join(dir, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const out = qaRows(suiteRun('lme-s-hard', ['0a995998', '08f4fc43', '0bc8ad93']), ctx(), 'particle-1', dir, 'openai:gpt-6-astra');
    expect(out.map(r => r.harness)).toEqual([{ error: 'openai 500: The server had an error', cause: 'judge' }, { error: 'particle 503: Service Unavailable', cause: 'reader' }, { error: 'no call was made' }]);
    expect(out.map(r => harnessCause(r.harness!))).toEqual(['judge', 'reader', 'reader']);
  });

  test("(e) QA rows: gbrain's own error (error_origin sut) is a search tool error that carries the provider stage whose 429 or 5xx caused it, read from the whole error", () => {
    const dir = tmp();
    const late = `import failed: chat/${'lme-s-0a995998-session-'.repeat(8)} could not be embedded: [embed(openai:text-embedding-3-large)] status 429`;
    const rows = [{ id: '0a995998', abstention: false, error: 'Rate limit reached for text-embedding-3-large in organization org-test on tokens per min (TPM). (429)', error_origin: 'sut', error_kind: 'product_error', outcome: 'retrieval_error' },
      { id: '08f4fc43', abstention: false, error: late, error_origin: 'sut' },
      { id: '0bc8ad93', abstention: false, error: 'search failed: Voyage returned 503: upstream overloaded', error_origin: 'sut' },
      { id: '10d9b85a', abstention: false, error: "TypeError: Cannot read properties of undefined (reading 'slug')", error_origin: 'sut' }];
    writeFileSync(join(dir, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const out = qaRows(suiteRun('lme-s-hard', rows.map(r => r.id)), ctx(), 'particle-1', dir, 'openai:gpt-6-astra');
    expect(out.map(r => [r.item, r.pass, r.stop, r.harness])).toEqual(rows.map(r => [r.id, false, 'answered', null]));
    const search = (message: string, cause?: 'embedding' | 'retrieval') => [{ tool: 'search', code: null, refused: false, message, ...(cause ? { cause } : {}) }];
    expect(out.map(r => r.tool_errors)).toEqual([search(rows[0]!.error, 'embedding'), search(late.slice(0, 200), 'embedding'), search(rows[2]!.error, 'retrieval'), search(rows[3]!.error)]);
  });

  test('smokes: a harness_* code means the smoke could not run, so its row is a harness row and never a gbrain failure', () => {
    const rows = smokeRows(suiteRun('system-smokes', ['managed-sync', 'postgres-15', 'query-contract', 'upgrade-from-old']), ctx(), [
      { id: 'managed-sync', pass: false, code: 'harness_error', detail: 'TypeError', ms: 1 },
      { id: 'postgres-15', pass: false, code: 'harness_missing_postgres', detail: 'postgres-15 needs both servers', ms: 1 },
      { id: 'query-contract', pass: false, code: 'contract_broken', detail: 'a gbrain failure', ms: 1 },
      { id: 'upgrade-from-old', pass: true, code: null, detail: '', ms: 1 }]);
    expect(rows.map(r => [r.item, r.pass, r.harness?.error ?? null])).toEqual([['managed-sync', false, 'harness_error: TypeError'],
      ['postgres-15', false, 'harness_missing_postgres: postgres-15 needs both servers'], ['query-contract', false, null], ['upgrade-from-old', true, null]]);
  });

  test('a fresh run into a night directory that already holds night.json is refused and points to --resume', async () => {
    const clone = tmp();
    const git = (...args: string[]) => execFileSync('git', ['-C', clone, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args]);
    git('init', '-q', '-b', 'master');
    git('commit', '-q', '--allow-empty', '-m', 'fixture');
    const out = tmp();
    mkdirSync(join(out, '2026-11-09', 'master'), { recursive: true });
    writeFileSync(join(out, '2026-11-09', 'master', 'night.json'), '{}\n');
    await expect(main(['--ref', 'master', '--tier', 'nightly', '--fake', '--out', out, '--gbrain-clone', clone, '--night', '2026-11-09'])).rejects.toThrow('already holds a night; resume it with');
  });
});

describe('the fields the failure-cause adapter reads', () => {
  test("(f) a gbrain search error whose embedding provider returned a 429 keeps its failure-cause label; the provider cause is for the agreement check only", () => {
    const dir = tmp();
    writeFileSync(join(dir, 'rows.ndjson'), JSON.stringify({ id: '0a995998', abstention: false, error: 'Rate limit reached for text-embedding-3-large in organization org-test on tokens per min (TPM). (429)', error_origin: 'sut', outcome: 'retrieval_error' }) + '\n');
    const [o] = qaRows(suiteRun('lme-s-hard', ['0a995998']), ctx(), 'particle-1', dir, 'openai:gpt-6-astra');
    const label = classify(nightlyFailure(o!, 'nightly-lme-s-hard', []));
    expect(label).toMatchObject({ cause: 'unclassified', basis: 'unclassified', rule_id: 'residual.delivery_unmeasured', secondary: [], tags: [] });
    const bare = o!.tool_errors.map(({ tool, code, refused, message }) => ({ tool, code, refused, message }));
    expect(classify(nightlyFailure({ ...o!, tool_errors: bare }, 'nightly-lme-s-hard', []))).toEqual(label);
  });

  test('every dev-set suite has its facts; a row says gbrain, the suite at its ref, and default on master or variant elsewhere', () => {
    expect(devset.suites.map(s => s.id).filter(id => !SUITE_FACTS[id])).toEqual([]);
    const run = suiteRun('lme-s-hard');
    expect(outcome(run, ctx(), { item: '08f4fc43', pass: true })).toMatchObject({ system: 'gbrain', arm: 'lme-s-hard@master', arm_role: 'gbrain_default', condition: 'natural', visibility: 'public', agent_loop: false });
    expect(outcome(suiteRun('concurrent-writers'), ctx({ ref: 'stable' }), { item: 'pglite:5001', pass: true }))
      .toMatchObject({ arm: 'concurrent-writers@stable', arm_role: 'gbrain_variant', condition: 'forced', visibility: 'synthetic' });
    expect(outcome(suiteRun('refused-write-agents'), ctx(), { item: '2001', pass: true })).toMatchObject({ condition: 'forced', agent_loop: true });
    expect(() => outcome({ ...run, suite: { ...run.suite, id: 'no-such-suite' } }, ctx(), { item: 'x', pass: true })).toThrow('suite no-such-suite has no row in SUITE_FACTS');
  });

  test('skipped rows: one per reader, item and trial with the reason; a fake night\'s model suite has the fake reader, a keyless suite none', () => {
    const rows = skippedRows(suiteRun('refused-write-agents', ['2001', '2002'], { k: 2 }), ctx(), 'gbrain predates it');
    expect(rows).toHaveLength(8);
    expect(rows.every(r => r.skipped === 'gbrain predates it' && !r.pass && r.harness === null)).toBe(true);
    expect(new Set(rows.map(r => r.reader))).toEqual(new Set(['claude-opus-5-5', 'gpt-6.1-sol']));
    expect(skippedRows(suiteRun('refused-write-agents', ['2001']), ctx({ fake: true }), 'x').map(r => r.reader)).toEqual(['fake']);
    expect(skippedRows(suiteRun('concurrent-writers', ['5001'], { readers: [null] }), ctx(), 'x', ['postgres:5001'])).toMatchObject([{ item: 'postgres:5001', reader: null, skipped: 'x' }]);
  });

  test('Cat 40 cells: each call with its refusal and recovery, the gold from cited and missed evidence, searched and opened coverage, the answer and the world task', () => {
    const dir = tmp();
    const cell = (o: Record<string, unknown>) => ({ schema: 'cat40-cell-v2', attempt: 1, model: 'gpt-6.1-sol', arm: 'gbrain-hard', family: 'H1', repeat: 0, stop: 'submitted', claims: null, total_usd: 0.25, judge_usd: 0.05,
      timings: { agent_ms: 1 }, wall_ms: 2, experiment: { scale: 'large' }, ...o });
    const calls = [{ name: 'get_page', ms: 5, chars: 1, truncated: false }, { name: 'get_page', ms: 6, chars: 1, truncated: false }, { name: 'search', ms: 7, chars: 1, truncated: false }];
    writeFileSync(join(dir, 'attempts.jsonl'), [
      cell({ key: 'gpt-6.1-sol|gbrain-hard|H1-02|0', attempt_id: 'gpt-6.1-sol|gbrain-hard|H1-02|0#1', task: 'H1-02',
        score: { success: false, submitted: true, said_wrong: false, evidence_cited: ['people/ada-example'], missed_evidence: ['deals/acme-example'], wrote: false },
        sessions: [{ index: 1, role: 'question', stop: 'submitted', usd: 0.25, run: { turns: 4, final: { answer: 'Ada Example' }, tool_calls: calls } }] }),
      cell({ key: 'gpt-6.1-sol|gbrain-hard|H1-03|0', attempt_id: 'gpt-6.1-sol|gbrain-hard|H1-03|0#1', task: 'H1-03', stop: 'turn_cap',
        score: { success: false, submitted: false, said_wrong: false, evidence_cited: [], missed_evidence: ['deals/acme-example'], wrote: false },
        sessions: [{ index: 1, role: 'question', stop: 'turn_cap', usd: 0.25, run: { turns: 30, final: null, tool_calls: calls.slice(2) } }] }),
    ].map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(dir, 'transcripts.jsonl'), JSON.stringify({ key: 'gpt-6.1-sol|gbrain-hard|H1-02|0', attempt_id: 'gpt-6.1-sol|gbrain-hard|H1-02|0#1', tools: [
      { session: 1, name: 'get_page', args: { slug: 'people/ada-example' }, result: 'Error: {"error":"invalid_params","message":"bad selector"}' },
      { session: 1, name: 'get_page', args: { slug: 'people/ada-example' }, result: '{"slug":"people/ada-example"}' },
      { session: 1, name: 'search', args: { query: 'acme' }, result: '{"results":[{"slug":"people/ada-example"},{"slug":"deals/acme-example-2"}]}' }] }) + '\n');
    const task = { id: 'H1-02', question: 'Who leads the Acme deal?', gold: { answer: ['Ada Example', 'Ada'], evidence: ['people/ada-example', 'deals/acme-example'] } } as unknown as HardTask;
    const [one, two] = cat40Rows(suiteRun('cat40-hard-m', ['H1-02', 'H1-03']), ctx(), dir, new Map([['H1-02', task]])).sort((a, b) => a.item.localeCompare(b.item));
    expect(one).toMatchObject({ category: 'H1', gold_count: 2, searched_gold: ['people/ada-example'], retrieved: 'partial', delivered: 'partial', opened: 'partial', answered: true, answer: 'Ada Example',
      question: 'Who leads the Acme deal?', expected: 'Ada Example | Ada', system: 'gbrain', arm: 'cat40-hard-m@master', condition: 'natural', visibility: 'synthetic', agent_loop: true });
    expect(one!.calls).toEqual([{ name: 'get_page', error: 'invalid_params', recovered: true, ms: 5, memory: true }, { name: 'get_page', error: null, recovered: null, ms: 6, memory: true },
      { name: 'search', error: null, recovered: null, ms: 7, memory: true }]);
    expect(two).toMatchObject({ stop: 'turn_cap', gold_count: 1, opened: 'none', calls: null, retrieved: null, searched_gold: null, answered: false, answer: null, question: null });
  });

  test('Part C episodes: every logged call with its recovery, the write losses the nightly scorer measures, and whether a report came back', () => {
    const dir = tmp();
    const score = { pass: false, tokens_once: false, report_correct: true, no_resend: false, duplicated: ['F3'], missing: ['F4'], acknowledged_missing: ['F2'], resent: ['F1'], misreports: [], unreported: [] };
    const calls = [
      { name: 'put_page', write: true, is_error: true, cls: 'refused', code: 'worktree_refreshing', tokens: ['F1'], ms: 4, harness_error: null },
      { name: 'put_page', write: true, is_error: true, cls: 'refused', code: 'worktree_refreshing', tokens: ['F5'], ms: 5, harness_error: null },
      { name: 'get_page', write: false, is_error: true, cls: null, code: 'not_found', tokens: [], ms: 6, harness_error: null },
      { name: 'get_page', write: false, is_error: false, cls: null, code: null, tokens: [], ms: 7, harness_error: null },
    ];
    const transcript = ['notes/a', 'notes/b', 'notes/a', 'notes/a'].map((slug, i) => ({ name: calls[i]!.name, args: { slug } }));
    writeFileSync(join(dir, 'task-1001-t1.json'), JSON.stringify({ usd: 0.02, loop: { stop: 'submitted' }, nightly_score: score, score: { success: false }, calls, transcript,
      report: { ok: true, source: 'submit_answer' }, behavior: { refusals: [] } }));
    writeFileSync(join(dir, 'task-1001-t2.json'), JSON.stringify({ usd: 0.01, loop: { stop: 'turn_cap' }, nightly_score: { ...score, resent: [] }, score: { success: false }, calls: calls.slice(2),
      report: { ok: false, source: null }, behavior: { refusals: [] } }));
    const [one, two] = episodeRows(suiteRun('refresh-barrier-agents', ['1001'], { k: 2 }), ctx(), 'gpt-6.1-sol', dir).sort((a, b) => a.trial - b.trial);
    expect(one!.calls!.map(c => [c.name, c.error, c.recovered, c.ms])).toEqual([['put_page', 'refused/worktree_refreshing', false, 4], ['put_page', 'refused/worktree_refreshing', true, 5],
      ['get_page', 'not_found', true, 6], ['get_page', null, null, 7]]);
    expect(one).toMatchObject({ writes: { lost: ['F2'], stuck: null, overwritten: null, duplicated: ['F3'] }, answered: true, agent_loop: true });
    expect(two!.calls!.map(c => [c.error, c.recovered])).toEqual([['not_found', null], [null, null]]);
    expect(two!.answered).toBe(false);
  });

  test('concurrency trials: write ids by class from Part A\'s per-op flags', () => {
    const dir = tmp();
    const base = { flags: { converge: { ok: true }, quiesce: { ok: true } }, switches: [{ refresh_barrier: true }], arm: 'on', faults: {}, upstream: { missing_head: 0 } };
    writeFileSync(join(dir, '5004.json'), JSON.stringify({ ...base, ops: [{ state: 'committed', request_id: 'r1', lost: true }, { state: 'pending', writer: 2, op: 7, stuck: true },
      { state: 'committed', request_id: 'r3', overwritten: true }, { state: 'committed' }] }));
    const [r] = trialRows(suiteRun('concurrent-writers', ['5004']), ctx(), 'pglite', dir);
    expect(r!.writes).toEqual({ lost: ['r1'], stuck: ['w2.7'], overwritten: ['r3'], duplicated: [] });
    expect(r).toMatchObject({ reader: null, condition: 'forced', agent_loop: false });
  });

  test('QA rows: recall at 10 beside the runner\'s @5, coverage at 10, delivered from the packed prefix, and the question, reference and answer', () => {
    const dir = tmp();
    const run = suiteRun('lme-s-hard');
    const [a, b] = run.items.map(i => i.id);
    const rows = [
      { id: a, category: 'multi-session', gold_count: 2, abstention: false, recall_all_at_5: 0, recall_any_at_5: 0, recall_all_at_10: 0, retrieved: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 'g1'],
        qa_sessions: 5, qa_score: 0, qa_answer: 'Lyon', qa_receipts: [{ role: 'reader', finish: 'stop' }, { role: 'judge', finish: 'stop' }] },
      { id: b, category: 'single-session', gold_count: 1, abstention: false, recall_all_at_5: 1, recall_any_at_5: 1, recall_all_at_10: 1, retrieved: ['g3', 's1'], qa_sessions: 2, qa_score: 0,
        qa_answer: '  ', qa_receipts: [{ role: 'reader', finish: 'max_tokens' }] },
    ];
    writeFileSync(join(dir, 'rows.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ qa: { mode: 'reader', context: 'sessions' } }));
    const q = (id: string, gold: string[], answer: string): [string, MemoryQuestion] => [id, { id, conversation: 'c', question: `Question ${id}?`, category: 'x', gold, abstention: false, answer }];
    const [one, two] = qaRows(run, ctx(), 'gpt-6.1-sol', dir, 'anthropic:claude-opus-5-5', new Map([q(a!, ['g1', 'g2'], 'Paris'), q(b!, ['g3'], 'Rome')]));
    expect(one).toMatchObject({ category: 'multi-session', gold_count: 2, retrieved: 'partial', delivered: 'none', answered: true, finish_reason: 'stop', question: `Question ${a}?`, expected: 'Paris',
      answer: 'Lyon', evidence: { recall_any_at_10: 1, recall_all_at_10: 0, recall_any_at_5: 0, recall_all_at_5: 0 } });
    expect(two).toMatchObject({ retrieved: 'all', delivered: 'all', answered: false, finish_reason: 'max_tokens' });
    const at5 = qaRows(run, ctx(), 'gpt-6.1-sol', dir, 'anthropic:claude-opus-5-5');
    expect(at5.map(r => [r.retrieved, r.delivered, r.evidence.recall_any_at_10, r.question])).toEqual([['none', null, null, null], ['all', null, null, null]]);
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ qa: { mode: 'think', context: 'sessions' } }));
    expect(qaRows(run, ctx(), 'gpt-6.1-sol', dir, 'anthropic:claude-opus-5-5', new Map([q(a!, ['g1', 'g2'], 'Paris')]))[0]!.delivered).toBeNull();
  });

  test('every row carries a finish reason, null where its suite records none; a QA answer cut off at its output limit is a harness row, and an older row reads the same', () => {
    const none = [outcome(suiteRun('cat40-hard-m'), ctx(), { item: 'H1-02', pass: false }), ...smokeRows(suiteRun('system-smokes'), ctx(), [{ id: 'query-contract', pass: true, code: null, detail: '', ms: 1 }]),
      ...skippedRows(suiteRun('concurrent-writers', ['5001']), ctx(), 'postgres trials need --pg-admin <url>')];
    for (const r of none) expect(r).toMatchObject({ finish_reason: null, harness: null });
    const dir = tmp();
    const run = suiteRun('beam-1m-hard');
    const [a, b] = run.items.map(i => i.id);
    writeFileSync(join(dir, 'rows.ndjson'), [{ id: a, qa_score: 1, qa_answer: 'Paris', qa_receipts: [{ role: 'reader', finish: 'stop' }] },
      { id: b, qa_score: 1, qa_answer: 'The user moved to', qa_receipts: [{ role: 'reader', finish: 'max_tokens' }, { role: 'judge', finish: 'stop' }] }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const [whole, cut] = qaRows(run, ctx(), 'claude-opus-5-5', dir, 'openai:gpt-6-astra');
    expect(whole).toMatchObject({ pass: true, finish_reason: 'stop', harness: null });
    expect(cut).toMatchObject({ pass: true, finish_reason: 'max_tokens', harness: { error: 'output_truncated: the answer was cut off at its output limit (finish max_tokens)' } });
    const file = join(tmp(), 'outcomes.jsonl');
    const { finish_reason: _absent, ...older } = whole!;
    writeFileSync(file, [older, { ...cut, harness: null }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(readOutcomes(file).map(r => [r.item, r.finish_reason, r.harness])).toEqual([[a, null, null], [b, 'max_tokens', cut!.harness]]);
  });

  test('a resume reruns skipped and harness rows, but not an answer cut off at its output limit, which a rerun would only repeat', () => {
    const run = suiteRun('beam-1m-hard');
    const item = run.items[0]!.id;
    const row = (o: Partial<Outcome>) => outcome(run, ctx(), { item, reader: 'claude-opus-5-5', pass: true, ...o });
    expect(row({}).harness).toBeNull();
    expect(resumable(row({}))).toBe(false);
    expect(row({ finish_reason: 'length' }).harness?.error).toStartWith('output_truncated:');
    expect(resumable(row({ finish_reason: 'length' }))).toBe(false);
    expect(resumable(row({ finish_reason: 'length', harness: { error: 'memory-qa exited 1: provider 529' } }))).toBe(true);
    expect(resumable(row({ pass: false, harness: { error: 'no row recorded' } }))).toBe(true);
    expect(resumable(row({ pass: false, skipped: 'postgres trials need --pg-admin <url>' }))).toBe(true);
  });

  test('tool-contract replay rows: every replayed call by tool, and a refusal never recovered, since a replay sends each call once', async () => {
    const c = ctx();
    const dir = join(c.dir, 'suites', 'tool-contract-replay');
    mkdirSync(dir, { recursive: true });
    const paths = { rollout: { ok: 2, ok_by_tool: { get_page: 2 }, refused: {} }, 'write-capture': { ok: 1, ok_by_tool: { get_page: 1 }, refused: { get_page: { invalid_params: 1 } } },
      mcp: { ok: 2, ok_by_tool: { get_page: 1, traverse_graph: 1 }, refused: {} } };
    writeFileSync(join(dir, 'replay.json'), JSON.stringify([{ item: 'sol-query', family: 'sol', skill: 'query', calls: 2, unparseable: 0, refusals: 1, paths }]));
    const [r] = (await replayAdapter(suiteRun('tool-contract-replay', ['sol-query'], { readers: [null] }), c)).rows;
    expect(r).toMatchObject({ pass: false, category: 'query', condition: 'forced', reader: null });
    expect(r!.calls).toHaveLength(6);
    expect(r!.calls!.filter(x => x.error)).toEqual([{ name: 'get_page', error: 'invalid_params', recovered: false, ms: null, memory: true }]);
    expect(r!.calls!.filter(x => x.name === 'traverse_graph')).toHaveLength(1);
  });

  test('system smokes: a failed smoke is the operation it checks, with its code; a harness_ code is a harness row', () => {
    const [ok, failed, harness] = smokeRows(suiteRun('system-smokes', undefined, { readers: [null] }), ctx(), [{ id: 'managed-sync', pass: true, code: 'ok', detail: '', ms: 1 },
      { id: 'source-pinned-sync', pass: false, code: 'delete_not_pushed', detail: 'the delete never reached the remote', ms: 2 },
      { id: 'postgres-15', pass: false, code: 'harness_missing_postgres', detail: 'needs --pg15', ms: 3 }]);
    expect([ok!.operation, ok!.harness]).toEqual([null, null]);
    expect(failed).toMatchObject({ operation: { step: 'source-pinned-sync', error: 'delete_not_pushed' }, harness: null, condition: 'forced' });
    expect(harness).toMatchObject({ operation: null, harness: { error: 'harness_missing_postgres: needs --pg15' } });
  });
});

describe('tool-contract replay', () => {
  test('each family\'s recorded calls parse from the SkillOpt probe inputs', () => {
    for (const family of ['sol', 'opus']) for (const skill of ['query', 'briefing', 'fact-check']) expect(recordedCalls(family, skill).length).toBeGreaterThan(0);
  });

  test('one item through the rollout, write-capture and MCP paths of the pinned build: every parsed call answered or refused on every path', async () => {
    const [r] = await replayItems(resolveGbrainUnderTest(null).root, [{ family: 'opus', skill: 'query' }]);
    expect(r!.item).toBe('opus-query');
    for (const path of ['rollout', 'write-capture', 'mcp'] as const) {
      const p = r!.paths[path];
      expect(p.ok + Object.values(p.refused).flatMap(Object.values).reduce((a, b) => a + b, 0)).toBe(r!.calls - r!.unparseable);
      expect(Object.values(p.ok_by_tool).reduce((a, b) => a + b, 0)).toBe(p.ok);
    }
  }, 120_000);

  test('content misses: a section the replay page lacks, or a recorded-time read before the brain\'s history; argument refusals stay refusals', () => {
    expect(isContentMiss({ section: 'overview' }, { code: 'invalid_params', message: 'get_page: page people/vera-chen-14 has no heading "overview". It has no headings.' })).toBe(true);
    expect(isContentMiss({ known_as_of: '2026-10-14T23:59:59Z' }, { code: 'coverage_from', message: 'no history at that instant' })).toBe(true);
    expect(isContentMiss({ known_as_of: '2026-10-14T23:59:59Z' }, { code: 'coverage_gap', message: 'history has a gap' })).toBe(true);
    expect(isContentMiss({ section: '' }, { code: 'invalid_params', message: 'has no heading ""' })).toBe(false);
    expect(isContentMiss({ known_as_of: '' }, { code: 'invalid_params', message: 'get_page: known_as_of does not combine with include_content, lines, bytes.' })).toBe(false);
  });

  test('a named section the replay page has no heading for is a content miss, not a refusal: Opus\'s briefing calls all answer on the pinned build', async () => {
    const [r] = await replayItems(resolveGbrainUnderTest(null).root, [{ family: 'opus', skill: 'briefing' }]);
    expect(r!.refusals).toBe(0);
    expect(r!.paths.mcp.ok).toBe(r!.calls - r!.unparseable);
  }, 120_000);
});

const CLONE = process.env.NIGHTLY_GBRAIN_CLONE;

describe('run.ts --fake end to end (needs NIGHTLY_GBRAIN_CLONE)', () => {
  test.skipIf(!CLONE)('a two-item slice: a fake Part C episode and a fake memory-qa question, outcomes, report, and a resume that adds nothing', () => {
    const work = tmp();
    const pick = (id: string) => devset.suites.find(s => s.id === id)!;
    const body = { version: devset.version, readers: devset.readers, k: { ...devset.k, agent: 1 }, reserved: [], suites: [
      { ...pick('refused-write-agents'), items: [{ id: '2001', role: 'headroom' }] },
      { ...pick('lme-s-hard'), config: { benchmark: 'fixture', split: 'dev' }, items: [{ id: 'fx-00', role: 'headroom' }] }] };
    writeFileSync(join(work, 'devset.json'), JSON.stringify({ ...body, digest: canonicalDigest(body) }));
    const run = (...argv: string[]) => spawnSync('bun', ['--no-env-file', join(ROOT, 'eval/runner/nightly/run.ts'), ...argv], { cwd: ROOT, env: keylessEnv(), encoding: 'utf8', timeout: 900_000 });
    const first = run('--ref', 'master', '--tier', 'matrix', '--fake', '--devset', join(work, 'devset.json'), '--out', join(work, 'out'), '--gbrain-clone', CLONE!, '--night', '2026-11-09');
    expect(first.stderr).not.toContain('NIGHTLY_');
    expect(first.status).toBe(0);
    const dir = join(work, 'out', '2026-11-09', 'master');
    const rows = readOutcomes(join(dir, 'outcomes.jsonl'));
    expect(rows.map(r => [r.suite, r.item, r.reader, r.harness]).sort()).toEqual([['lme-s-hard', 'fx-00', 'fake', null], ['refused-write-agents', '2001', 'fake', null]]);
    expect(rows.find(r => r.suite === 'refused-write-agents')!.evidence).toMatchObject({ kind: 'write', tokens_once: true });
    const night = JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8'));
    expect(night).toMatchObject({ fake: true, attempts: 1, exit: null, suites: [{ id: 'refused-write-agents', status: 'ran' }, { id: 'lme-s-hard', status: 'ran' }] });
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('fake providers (plumbing only; no number here measures a model)');
    for (const f of ['summary.json', 'outcomes.jsonl.gz']) expect(existsSync(join(dir, f))).toBe(true);
    const lines = readFileSync(join(dir, 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    const again = run('--resume', dir);
    expect(again.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')).attempts).toBe(2);
    expect(readFileSync(join(dir, 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).length).toBe(lines);
  }, 900_000);

  test.skipIf(!CLONE)('a resume reruns on the commit the night started on after master moves', () => {
    const work = tmp();
    const clone = join(work, 'gbrain');
    execFileSync('git', ['clone', '--quiet', '--local', '--no-checkout', CLONE!, clone]);
    const body = { version: devset.version, readers: devset.readers, k: { ...devset.k, agent: 1 }, reserved: [], suites: [
      { ...devset.suites.find(s => s.id === 'refused-write-agents')!, items: [{ id: '2001', role: 'headroom' }] }] };
    writeFileSync(join(work, 'devset.json'), JSON.stringify({ ...body, digest: canonicalDigest(body) }));
    const run = (...argv: string[]) => spawnSync('bun', ['--no-env-file', join(ROOT, 'eval/runner/nightly/run.ts'), ...argv], { cwd: ROOT, env: keylessEnv(), encoding: 'utf8', timeout: 900_000 });
    expect(run('--ref', 'master', '--tier', 'matrix', '--fake', '--devset', join(work, 'devset.json'), '--out', join(work, 'out'), '--gbrain-clone', clone, '--night', '2026-11-09').status).toBe(0);
    const dir = join(work, 'out', '2026-11-09', 'master');
    const sha = JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')).sha as string;
    execFileSync('git', ['-C', clone, 'update-ref', 'refs/heads/master', `${sha}^`]);
    writeFileSync(join(dir, 'outcomes.jsonl'), '');
    expect(run('--resume', dir).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'night.json'), 'utf8')).sha).toBe(sha);
    expect(readOutcomes(join(dir, 'outcomes.jsonl')).map(r => [r.item, r.sha])).toEqual([['2001', sha]]);
  }, 900_000);
});
