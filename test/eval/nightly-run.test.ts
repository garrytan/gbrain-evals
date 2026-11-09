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
import { cat40Commands, cat40Rows, episodeRows, judgeFor, qaCommand, qaRows, qualifiedModel, seedRanges, toolErrorFromText, trialRows, type NightContext, type SuiteRun } from '../../eval/runner/nightly/adapters.ts';
import { canonicalDigest, loadDevSet } from '../../eval/runner/nightly/devset.ts';
import { NightlyCache } from '../../eval/runner/nightly/judge-cache.ts';
import { keylessEnv } from '../../eval/runner/nightly/keyless.ts';
import { readOutcomes } from '../../eval/runner/nightly/outcome.ts';
import { parseArgs, planSuites, requirementGap } from '../../eval/runner/nightly/run.ts';
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
  test('readers and judges: GPT-6 Astra judges Claude rows and Claude Opus 5.5 judges GPT rows', () => {
    expect(qualifiedModel('claude-opus-5-5')).toBe('anthropic:claude-opus-5-5');
    expect(qualifiedModel('gpt-6.1-sol')).toBe('openai:gpt-6.1-sol');
    expect(judgeFor('claude-opus-5-5')).toBe('openai:gpt-6-astra');
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

  test('QA: gbrain\'s own defaults, real embeddings, one reader and its cross-family judge, the --ids filter; the fake night uses the fake system', () => {
    const run = suiteRun('beam-1m-hard');
    const cmd = qaCommand(run, ctx(), 'gpt-6.1-sol', '/ids.txt', '/out').join(' ');
    expect(cmd).toContain('--benchmark beam-1m --split dev --gbrain /g@' + 'c'.repeat(40) + ' --gbrain-defaults --embed real --qa reader --reader openai:gpt-6.1-sol --judge anthropic:claude-opus-5-5 --ids /ids.txt --paid --budget-run-id');
    expect(qaCommand(run, ctx({ fake: true, paid: null }), 'fake', '/ids.txt', '/out').slice(3)).toEqual(['--benchmark', 'beam-1m', '--system', 'fake', '--ids', '/ids.txt', '--output', '/out']);
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
