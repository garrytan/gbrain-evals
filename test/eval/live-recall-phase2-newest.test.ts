/**
 * Live recall phase 2 at gbrain's newest release (PHASE2-PREREGISTRATION.md, "2026-11-16 amendment"), keyless: the
 * carried judge check pinned to phase 2's runner, the reference build's privacy gate on the public fixture, a
 * reference-build run's identity, and the cross-build compare on synthetic records. Provider keys are blanked for the
 * whole file; every model call goes to a scripted fetch, and a fetch that is not scripted fails the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { BudgetRun, installPaidRequestGuard } from '../../eval/runner/budget-ledger.ts';
import { importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { ABORT_CODES, LiveRecallAbort, installGuards } from '../../eval/runner/live-recall/brain.ts';
import {
  COMPARE_SCHEMA, PHASE2_FREEZE_SHA256_PREFIX, PHASE2_HARNESS_DIGEST, PHASE2_JUDGE_FILES, PHASE2_JUDGE_REQUESTS, PHASE2_RUNNER_COMMIT, PHASE2_TASKS_SHA256_PREFIX, SDD, carriedJudgeCheck, checkCompareOutbound, compareBuilds, judgeFileHashes,
  judgeRequestDigest, referencePrivacyGate, renderCompareMarkdown, sddFrom, unboundCallerSql, validateCompare, verdictOf, type BrainPages, type BuildVisibility, type CompareRun, type PrivacyGate,
} from '../../eval/runner/live-recall/phase2-newest.ts';
import { FIXTURE_DIM, buildFixtureBrain, ingestFixture, useFixtureTransports } from '../../eval/runner/live-recall/run.ts';
import { episodeKey, judgeEpisode, type AnswerRecord, type JudgeRecord, type Task, type TaskArm, type TaskForm } from '../../eval/runner/live-recall/task-arms.ts';
import { JUDGE_SYSTEM, judgeFor } from '../../eval/runner/live-recall/task-judge.ts';
import { buildTaskScorecard } from '../../eval/runner/live-recall/task-scorecard.ts';
import { FIXTURE_TASKS, HARNESS_FILES, PHASE2_PAGES, compareRunDirs, harnessDigest, main, parseTasks, readJudgeCheck, runTaskSet, type Paid } from '../../eval/runner/live-recall/tasks.ts';

const REPO = resolve(import.meta.dir, '../..');
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PARTICLE_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY'];
const savedKeys = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
beforeAll(() => { for (const k of KEYS) delete process.env[k]; });
afterAll(() => { for (const k of KEYS) if (savedKeys[k] !== undefined) process.env[k] = savedKeys[k]; });

const gut = resolveGbrainUnderTest(null);
const fixtureText = readFileSync(FIXTURE_TASKS, 'utf8');
const fixtureTasks = parseTasks(fixtureText).map(t => t.task);
const sha256 = (t: string | Buffer) => createHash('sha256').update(t).digest('hex');
const abortCode = async (run: () => unknown) => { try { await run(); return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code + ': ' + e.detail : String(e); } };
const hasPhase2Runner = (() => { try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', PHASE2_RUNNER_COMMIT + '^{commit}'], { stdio: 'ignore' }); return true; } catch { return false; } })();
/** A reference build as brain.ts names it, loaded from the pinned gbrain's own source (the fixture has no 0.60.613.0 checkout). */
const NEWEST_BUILD = { version: '0.60.733.0', commit: '6ce7195b44a034f85aec811f11fbf862db376f50' };
const modulesOf = async (g: GbrainUnderTest): Promise<BuildVisibility> => ({ visibility: await importGbrain<any>(g, 'src/core/search/private-visibility.ts'), caller: await importGbrain<any>(g, 'src/core/access/caller.ts') });
/** A build whose predicate for the runner's caller hides more: one extra conjunct on privatePagesFilterForCaller. */
const narrowed = (b: BuildVisibility, extra: (alias: string) => string): BuildVisibility => ({ caller: b.caller, visibility: { ...b.visibility, privatePagesFilterForCaller: (a: string) => '(' + b.visibility.privatePagesFilterForCaller(a) + ' AND ' + extra(a) + ')' } });
const asReference = (g: GbrainUnderTest) => ({ ...g, version: '0.60.613.0', overlay: { ...(g.overlay ?? {}), build: { commit: '98dda48fb9fd339609d6d4eef009811280ff648d' } } } as unknown as GbrainUnderTest);

// ─── The carried judge check ───────────────────────────────────────────────────────────────────────────────────────

describe('the judge check carried over from phase 2', () => {
  test('the judge files hash to their bytes at phase 2\'s runner, and this checkout still has those bytes', () => {
    expect(Object.keys(PHASE2_JUDGE_FILES).sort()).toEqual(['eval/runner/live-recall/task-judge.ts', 'eval/runner/live-recall/task-scorecard.ts']);
    expect(judgeFileHashes()).toEqual({ ...PHASE2_JUDGE_FILES });
    expect(HARNESS_FILES).toContain('eval/runner/live-recall/phase2-newest.ts');
  });

  test.skipIf(!hasPhase2Runner)('the pinned judge file hashes are git\'s bytes at 4740c1f3 (skipped when this checkout lacks that commit)', () => {
    for (const [file, hash] of Object.entries(PHASE2_JUDGE_FILES)) expect(sha256(execFileSync('git', ['-C', REPO, 'show', PHASE2_RUNNER_COMMIT + ':' + file]))).toBe(hash);
  });

  test('the judge\'s requests and parsed records match the pinned fingerprint, touch no network and put fetch back', async () => {
    const before = globalThis.fetch;
    expect(await judgeRequestDigest()).toBe(PHASE2_JUDGE_REQUESTS);
    expect(globalThis.fetch).toBe(before);
    const louder = (async (ctx: any, task: Task, rec: AnswerRecord, judge: string, kind: JudgeRecord['kind'], effort?: string) => judgeEpisode(ctx, task, rec, judge, kind, kind === 'judge' ? 'high' : effort)) as typeof judgeEpisode;
    expect(await judgeRequestDigest(louder)).not.toBe(PHASE2_JUDGE_REQUESTS);
  }, 60_000);

  test.skipIf(!hasPhase2Runner)('phase 2\'s own judge code at 4740c1f3 produces the pinned fingerprint (skipped when this checkout lacks that commit)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lr2-4740-'));
    try {
      execFileSync('sh', ['-c', 'git -C "$0" archive ' + PHASE2_RUNNER_COMMIT + ' eval/runner package.json | tar -x -C "$1"', REPO, root]);
      symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
      const old = await import(join(root, 'eval/runner/live-recall/task-arms.ts'));
      expect(await judgeRequestDigest(old.judgeEpisode, old.citedSlugs)).toBe(PHASE2_JUDGE_REQUESTS);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  describe('readJudgeCheck', () => {
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lr2-carry-')); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const need = { models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], arms: ['B'] };
    const phase2 = { schema: 'live-recall-judge-check/v1', passed: true, stop: null, complete: true, n_tasks_checked: 20, tasks_sha256: sha256(fixtureText), run: { harness_digest: PHASE2_HARNESS_DIGEST, runner_commit: PHASE2_RUNNER_COMMIT, control: false, models: need.models, arms: ['A', 'B', 'C', 'D'] }, judges: {} };
    let n = 0;
    const write = (c: unknown) => { const p = join(dir, 'judge-check-' + n++ + '.json'); writeFileSync(p, JSON.stringify(c)); return p; };

    test('carries phase 2\'s passing check only with the pinned judge fingerprint, and records the carry', async () => {
      const carried = readJudgeCheck(write(phase2), fixtureText, null, need, PHASE2_JUDGE_REQUESTS);
      expect(carried).toMatchObject({ passed: true, waiver: null, carried: { from_harness_digest: PHASE2_HARNESS_DIGEST, from_runner_commit: PHASE2_RUNNER_COMMIT, judge_requests: PHASE2_JUDGE_REQUESTS, judge_files: { ...PHASE2_JUDGE_FILES } } });
      expect(readJudgeCheck(write({ ...phase2, run: { ...phase2.run, harness_digest: harnessDigest() } }), fixtureText, null, need)).toMatchObject({ passed: true, carried: null });
      for (const requests of [null, '0'.repeat(64)]) expect(await abortCode(() => readJudgeCheck(write(phase2), fixtureText, null, need, requests))).toStartWith('LR_JUDGE_CHECK');
    });

    test('refuses a check from another runner, one that did not pass (waiver or not), and one that misses tasks, models, arms or the task file', async () => {
      const refused = async (c: unknown, waiver: string | null = null) => expect(await abortCode(() => readJudgeCheck(write(c), fixtureText, waiver, need, PHASE2_JUDGE_REQUESTS))).toStartWith('LR_JUDGE_CHECK');
      await refused({ ...phase2, run: { ...phase2.run, runner_commit: 'f'.repeat(40) } });
      await refused({ ...phase2, run: { ...phase2.run, harness_digest: 'e'.repeat(64) } });
      await refused({ ...phase2, run: { ...phase2.run, control: true } });
      await refused({ ...phase2, passed: false });
      await refused({ ...phase2, passed: false }, 'gbev3-waiver-1');
      await refused({ ...phase2, complete: false });
      await refused({ ...phase2, n_tasks_checked: 19 });
      await refused({ ...phase2, run: { ...phase2.run, models: ['claude-opus-5-5'] } });
      await refused({ ...phase2, run: { ...phase2.run, arms: ['A'] } });
      await refused({ ...phase2, tasks_sha256: '0'.repeat(64) });
    });

    test('refuses the carry when a judge file has changed since phase 2', async () => {
      const files = { ...PHASE2_JUDGE_FILES, 'eval/runner/live-recall/task-scorecard.ts': 'c'.repeat(64) };
      expect(await abortCode(() => carriedJudgeCheck(phase2, PHASE2_JUDGE_REQUESTS, files))).toBe('LR_JUDGE_CHECK: phase 2\'s judge check carries over only while eval/runner/live-recall/task-scorecard.ts match phase 2\'s runner, and it has changed');
      expect(carriedJudgeCheck(phase2, PHASE2_JUDGE_REQUESTS).judge_files).toEqual({ ...PHASE2_JUDGE_FILES });
    });
  });
});

// ─── The reference build's privacy gate ────────────────────────────────────────────────────────────────────────────

describe('the reference build\'s privacy gate', () => {
  let brain: { engine: any; close: () => Promise<void> };
  let build: BuildVisibility;
  const publicSlug = () => fixtureTasks[0]!.gold_pages[0]!;
  beforeAll(async () => {
    brain = await buildFixtureBrain(gut, PHASE2_PAGES);
    installGuards(brain.engine, { refusals: {} });
    build = await modulesOf(gut);
  }, 120_000);
  afterAll(async () => { await brain?.close(); });
  const newest = (b: BuildVisibility = build) => ({ ...NEWEST_BUILD, ...b });
  const relaxedBy = (gate: PrivacyGate | string) => 'LR_PRIVACY_RELAXED: reference-build privacy gate: ' + gate;

  test('judges each build by its own predicate for the runner\'s caller, and passes, counts only, when the reference build hides at least what the newest hides', async () => {
    const access = await build.caller.remoteCallerAccess(brain.engine, undefined, undefined, 'stdio');
    expect(await unboundCallerSql(brain.engine, build)).toBe(build.visibility.withCallerAccess(access, () => build.visibility.privatePagesFilterForCaller('p')));
    const gate = await referencePrivacyGate(brain.engine, 'default', build, newest());
    expect(gate).toMatchObject({ newest_version: '0.60.733.0', shown_by_reference_hidden_by_newest: 0 });
    expect(gate.pages).toBeGreaterThan(30);
    expect(gate.hidden_by_newest).toBeGreaterThanOrEqual(1);
    expect(gate.hidden_by_reference).toBe(gate.hidden_by_newest);
    expect(Object.values(gate).every(v => typeof v === 'number' || /^[0-9a-f.]+$/.test(String(v)))).toBe(true);
  });

  test('stops with LR_PRIVACY_RELAXED when the newest build hides a page the reference build shows', async () => {
    const pages = (await referencePrivacyGate(brain.engine, 'default', build, newest())).pages;
    expect(await abortCode(() => referencePrivacyGate(brain.engine, 'default', build, newest(narrowed(build, a => a + ".slug <> '" + publicSlug() + "'"))))).toBe(relaxedBy('1 of ' + pages + ' pages in the reader\'s source would be shown by the reference build and are hidden by the newest'));
    expect(await abortCode(() => referencePrivacyGate(brain.engine, 'default', build, newest(narrowed(build, () => 'NULL'))))).toStartWith(relaxedBy(''));
  });

  test('counts what the newest build\'s access for that caller hides, beyond its bare private-page rule', async () => {
    const prefix = publicSlug().slice(0, publicSlug().indexOf('/') + 1);
    const covered = { visibility: build.visibility, caller: { remoteCallerAccess: async (...a: unknown[]) => ({ ...(await build.caller.remoteCallerAccess(...a)), restricted: true, folderCoverage: [{ source_id: 'default', prefix }] }) } };
    const under = Number((await brain.engine.executeRaw("SELECT count(*)::int AS n FROM pages WHERE source_id = 'default' AND deleted_at IS NULL AND slug LIKE $1 AND (" + build.visibility.privatePagesFilterFragment('pages') + ')', [prefix + '%']))[0].n);
    expect(under).toBeGreaterThan(0);
    expect(await abortCode(() => referencePrivacyGate(brain.engine, 'default', build, newest(covered)))).toStartWith(relaxedBy(under + ' of '));
  });

  test('fails closed when it cannot run, or when either build would read wider than an unbound caller', async () => {
    const wider = (over: Record<string, unknown>) => ({ visibility: build.visibility, caller: { remoteCallerAccess: async (...a: unknown[]) => ({ ...(await build.caller.remoteCallerAccess(...a)), ...over }) } });
    const noCounts = (rows: unknown[]) => new Proxy(brain.engine, { get: (t, k) => (k === 'executeRaw' ? async (sql: string, p?: unknown[]) => (sql.includes(' AS relaxed ') ? rows : t.executeRaw(sql, p)) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    for (const [ref, nw, engine, why] of [
      [build, null, brain.engine, 'no newest build to compare with'],
      [build, newest({ visibility: build.visibility, caller: null }), brain.engine, 'the newest build gives no predicate'],
      [{ visibility: { ...build.visibility, privatePagesFilterForCaller: undefined }, caller: build.caller }, newest(), brain.engine, 'the reference build gives no predicate'],
      [build, newest(wider({ owner: true })), brain.engine, 'the newest build gives no predicate'],
      [wider({ identity: ['member:someone'] }), newest(), brain.engine, 'the reference build gives no predicate'],
      [build, newest(wider({ privateReadableSources: ['default'] })), brain.engine, 'the newest build gives no predicate'],
      [build, newest(wider({ hidePrivate: false })), brain.engine, 'the newest build gives no predicate'],
      [build, newest(narrowed(build, () => 'no such column here')), brain.engine, 'the comparison query failed'],
      [build, newest(), noCounts([]), 'the comparison returned no counts'],
      [build, newest(), noCounts([{ pages: 'x' }]), 'the comparison returned no counts'],
    ] as const) expect(await abortCode(() => referencePrivacyGate(engine as any, 'default', ref as any, nw as any))).toStartWith(relaxedBy(why));
  });
});

// ─── A reference-build run ─────────────────────────────────────────────────────────────────────────────────────────

/** Scripted claude-opus-5-5 and its gpt-6-astra judge in their wire formats: every answer says it does not know. */
function scriptedOpus() {
  const sent: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push(url);
    if (url.includes('anthropic.com')) return Response.json({ id: 'msg_' + sent.length, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: 'toolu_' + sent.length, name: 'submit_answer', input: { answer: 'I do not know.', sources: [] } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    if (url.includes('openai.com') && body.instructions === JUDGE_SYSTEM) {
      const ids = [...String(body.input[0].content).matchAll(/^- ([A-Za-z0-9_-]+): <<<QUOTED/gm)].map(m => m[1]);
      const args = { facts: ids.map(id => ({ id, verdict: 'missing' })), abstained: true, citations: [] };
      return Response.json({ id: 'resp_' + sent.length, object: 'response', model: body.model, status: 'completed', output: [{ type: 'function_call', id: 'fc_' + sent.length, call_id: 'call_' + sent.length, name: 'submit_answer', arguments: JSON.stringify(args) }], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } });
    }
    throw new Error('unscripted request');
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe('tasks.ts run --reference-build', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lr2-ref-')); process.env.GBRAIN_AUDIT_DIR = dir; });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const paidOn = (fetchImpl: typeof fetch, name: string): Paid => {
    const ledgerPath = join(dir, name + '-ledger.sqlite');
    const run = BudgetRun.open({ runner: 'live-recall-phase2-newest-test', budgetUsd: 2, ledgerPath, programCapUsd: 10 });
    return { run, guard: installPaidRequestGuard(run, { fetchImpl }), runner: 'live-recall-phase2-newest-test', capUsd: 2, ledgerPath };
  };
  const options = (out: string, paid: Paid, extra: Record<string, unknown>) => ({
    out: join(dir, out), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as TaskForm[], arms: ['A'] as TaskArm[],
    models: ['claude-opus-5-5'], limit: 2, concurrency: 1, resume: false, windowNote: null, paid, ...extra,
  });
  const withPaid = async <T>(name: string, body: (paid: Paid, sent: string[]) => Promise<T>) => {
    const p = scriptedOpus();
    const paid = paidOn(p.fetchImpl, name);
    try { return await body(paid, p.sent); } finally { paid.guard.uninstall(); paid.run.close({ finish: false }); }
  };

  test('refuses a build that is not a named reference build before it builds the brain, and stops at the privacy gate before any model call', async () => {
    await withPaid('refusals', async (paid, sent) => {
      expect(await abortCode(() => runTaskSet(options('unnamed', paid, { referenceBuild: true }), () => {}))).toStartWith('LR_REFERENCE_BUILD');
      expect(await abortCode(() => runTaskSet(options('no-newest', paid, { gut: asReference(gut), referenceBuild: true, privacyReference: null }), () => {}))).toStartWith('LR_PRIVACY_RELAXED: reference-build privacy gate: no newest build');
      const stricter = { ...NEWEST_BUILD, ...narrowed(await modulesOf(gut), a => a + ".slug <> '" + fixtureTasks[0]!.gold_pages[0] + "'") };
      expect(await abortCode(() => runTaskSet(options('relaxed', paid, { gut: asReference(gut), referenceBuild: true, privacyReference: stricter }), () => {}))).toStartWith('LR_PRIVACY_RELAXED: reference-build privacy gate: 1 of ');
      expect(sent).toHaveLength(0);
      for (const out of ['no-newest', 'relaxed']) expect(existsSync(join(dir, out, 'records.local.jsonl')) && readFileSync(join(dir, out, 'records.local.jsonl'), 'utf8').trim()).toBeFalsy();
    });
  }, 120_000);

  test('records the reference build, the schema its code expects and the gate\'s counts, and a resume must keep them', async () => {
    const latest = Number((await importGbrain<any>(gut, 'src/core/migrate.ts')).LATEST_VERSION);
    const newest = { ...NEWEST_BUILD, ...(await modulesOf(gut)) };
    await withPaid('reference', async (paid, sent) => {
      const lines: string[] = [];
      const r = await runTaskSet(options('reference', paid, { gut: asReference(gut), referenceBuild: true, privacyReference: newest }), l => lines.push(l));
      expect(r.result).toBe('complete');
      expect(sent.length).toBeGreaterThan(0);
      const run = JSON.parse(readFileSync(join(dir, 'reference', 'run.json'), 'utf8'));
      expect(run.identity.gbrain_loaded_version).toBe('0.60.613.0');
      expect(run.build).toMatchObject({ reference_build: '0.60.613.0', code_schema_version: latest, privacy_gate: { newest_version: '0.60.733.0', newest_commit: newest.commit, shown_by_reference_hidden_by_newest: 0 } });
      expect(run.judge_check_carried).toBeNull();
      expect(run.identity.runner_commit).toBe(execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      expect(run.brain_pages.at_start).toBeGreaterThan(30);
      expect(run.brain_pages).toEqual({ at_start: run.brain_pages.at_start, at_end: run.brain_pages.at_start, updated_since_start: run.brain_pages.at_start });
      expect(lines.some(l => l.startsWith('reference build 0.60.613.0 (code expects schema ' + latest + '); privacy gate against 0.60.733.0'))).toBe(true);
      expect(readFileSync(r.scorecard, 'utf8')).not.toContain('reference_build');
      expect(await abortCode(() => runTaskSet({ ...options('reference', paid, { gut: asReference(gut) }), resume: true }, () => {}))).toBe('LR_FREEZE_MISMATCH: the resume differs from the first session in reference_build');
    });
    await withPaid('newest', async paid => {
      await runTaskSet(options('newest', paid, {}), () => {});
      expect(JSON.parse(readFileSync(join(dir, 'newest', 'run.json'), 'utf8')).build).toEqual({ reference_build: null, code_schema_version: latest, privacy_gate: null });
    });
  }, 180_000);

  test('the CLI takes --reference-build and --privacy-reference only together and only on run', async () => {
    const errors: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
    try {
      expect(await main(['judge-check', '--fixture', '--reference-build', '--budget-usd', '1'])).toBe(2);
      expect(await main(['run', '--fixture', '--privacy-reference', '/x@abc', '--budget-usd', '1'])).toBe(2);
    } finally { console.error = error; }
    expect(errors).toEqual(['live-recall: --reference-build, with --privacy-reference <newest checkout>@<commit>, is for tasks.ts run only', 'live-recall: --reference-build, with --privacy-reference <newest checkout>@<commit>, is for tasks.ts run only']);
  });
});

// ─── The cross-build compare ───────────────────────────────────────────────────────────────────────────────────────

const MODELS2 = ['claude-opus-5-5', 'gpt-6.1-sol'];
const FORMS2: TaskForm[] = ['paraphrase', 'exact'];
const bit = (s: string) => parseInt(sha256(s).slice(0, 8), 16) % 100;
type Outcome = { correct: boolean; goldSeen?: boolean; status?: 'answered' | 'no_answer' | 'degraded' };

function episode(form: TaskForm, task: Task, arm: TaskArm, model: string, o: Outcome, judge = judgeFor(model)): Array<AnswerRecord | JudgeRecord> {
  const key = episodeKey(form, task.id, arm, model), status = o.status ?? 'answered';
  const goldSeen = arm !== 'A' && (o.goldSeen ?? true);
  const answer: AnswerRecord = {
    kind: 'answer', key, task: task.id, form, arm, model, attempt: 1, status, answer: o.correct ? task.gold_answer.text : 'not sure', cited: arm === 'A' || !o.correct ? [] : [task.gold_pages[0]!],
    exposure: { tool_calls: arm === 'A' ? 0 : 2, searched: arm !== 'A', gold_seen: goldSeen, gold_opened: false, gold_cited: arm !== 'A' && o.correct, summary_gold_cited: null, pasted_gold: null },
    stages: [], meta_missing: 0, ai_refused: [], roles: {}, snapshots: [], slugs_seen: task.gold_pages, ms: 10, at: '2026-11-17T01:00:00.000Z', error: null,
  };
  if (status !== 'answered') return [answer];
  const derived = { correct: o.correct, partial: false, contradicted: false, abstained: !o.correct, grounded: o.correct && arm !== 'A', citations: o.correct && arm !== 'A' ? 1 : 0, supported: o.correct && arm !== 'A' ? 1 : 0 };
  return [answer, { kind: 'judge', key, judge, judge_version: null, effort: 'medium', max_output_tokens: 8192, truncated: false, status: 'ok', verdict: { facts: {}, abstained: !o.correct, citations: {} }, derived, usd: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 1 }, ms: 1, at: '2026-11-17T01:00:02.000Z' }];
}

interface RunSpec { version: string; commit: string; arms: TaskArm[]; outcome: (form: TaskForm, task: Task, arm: TaskArm, model: string) => Outcome; reference?: boolean; gate?: PrivacyGate | null; harness?: string; runner?: string; kept?: string[]; judge?: (model: string) => string }

function runOf(s: RunSpec): CompareRun {
  const kept = s.kept ?? fixtureTasks.map(t => t.id);
  const tasks = fixtureTasks.filter(t => kept.includes(t.id));
  return {
    run: {
      identity: {
        harness_digest: s.harness ?? 'a'.repeat(64), runner_commit: s.runner ?? 'b'.repeat(40), runner_dirty: false, gbrain_loaded_version: s.version, gbrain_loaded_commit: s.commit, schema_version: 317, control: true,
        judges: Object.fromEntries(MODELS2.map(m => [m, judgeFor(m)])), effort: 'medium', max_output_tokens: 8192, max_turns: 12, tool_result_chars: 16000, source_scope_default: true,
        search_mode: 'tokenmax', reranker_model: 'voyage:rerank-2.5', embedding_model: 'voyage:voyage-4', started_at: '2026-11-17T01:00:00.000Z', finished_at: '2026-11-17T02:00:00.000Z',
      },
      tasks_sha256: sha256(fixtureText), kept_ids: kept, forms: FORMS2, arms: s.arms, models: MODELS2,
      task_summary: { submitted: fixtureTasks.length, kept_at_freeze: fixtureTasks.length, dropped_unreachable: 0, gold_missing_at_run: fixtureTasks.length - kept.length, sha_prefix: sha256(fixtureText).slice(0, 12), n_frozen: fixtureTasks.length },
      build: { reference_build: s.reference ? s.version : null, code_schema_version: s.reference ? 296 : 317, privacy_gate: s.gate ?? null },
      judge_check: { judge_check_sha256: 'd'.repeat(64), passed: true, waiver: null, judges: {} }, judge_check_carried: null,
    },
    records: FORMS2.flatMap(form => tasks.flatMap(task => s.arms.flatMap(arm => MODELS2.flatMap(model => episode(form, task, arm, model, s.outcome(form, task, arm, model), s.judge?.(model) ?? judgeFor(model)))))),
  };
}

const NEWEST = { version: '0.60.733.0', commit: '6ce7195b44a034f85aec811f11fbf862db376f50' };
const GATE: PrivacyGate = { newest_version: NEWEST.version, newest_commit: NEWEST.commit, pages: 32, hidden_by_newest: 1, hidden_by_reference: 1, shown_by_reference_hidden_by_newest: 0 };
const baseline = (form: TaskForm, task: Task, arm: TaskArm, model: string): Outcome => ({ correct: arm === 'A' ? bit('a' + form + task.id + model) < 15 : bit('b' + form + task.id + model) < 80 });
const stored = () => runOf({ version: '0.60.613.0', commit: '98dda48fb9fd339609d6d4eef009811280ff648d', arms: ['A', 'B'], outcome: baseline, harness: PHASE2_HARNESS_DIGEST, runner: PHASE2_RUNNER_COMMIT });
const reference = (outcome = baseline, extra: Partial<RunSpec> = {}) => runOf({ version: '0.60.613.0', commit: '98dda48fb9fd339609d6d4eef009811280ff648d', arms: ['B'], outcome, reference: true, gate: GATE, ...extra });
const newestRun = (outcome = baseline, extra: Partial<RunSpec> = {}) => runOf({ ...NEWEST, arms: ['B'], outcome, ...extra });
const FREEZE = { sha256: 'f'.repeat(64), kept_ids: fixtureTasks.map(t => t.id), n_submitted: fixtureTasks.length, n_kept: fixtureTasks.length, dropped_unreachable: 0 };
const input = (over: Record<string, unknown> = {}) => ({
  tasks: fixtureTasks, tasksSha256: sha256(fixtureText), freeze: FREEZE, newest: newestRun(), reference: reference(), stored: stored(),
  storedIdentity: { harness_digest: PHASE2_HARNESS_DIGEST, runner_commit: PHASE2_RUNNER_COMMIT }, publishedA: null, ...over,
}) as Parameters<typeof compareBuilds>[0];

describe('tasks.ts compare: arm B at two builds, arm A from phase 2\'s stored run', () => {
  test('the smallest detectable differences follow from phase 2\'s public scorecard as the amendment states', () => {
    const card = JSON.parse(readFileSync(join(REPO, 'docs/benchmarks/2026-11-09-live-recall-phase2/scorecard.json'), 'utf8'));
    expect(card.tasks.gold_clusters.n).toBe(87);
    for (const [model, short] of [['claude-opus-5-5', 'opus'], ['particle-1', 'particle'], ['gpt-6.1-sol', 'sol']]) {
      const c = card.comparisons.find((x: any) => x.id === 'c_vs_b_correct_paraphrase_' + short);
      expect(sddFrom(c.mcnemar.discordant, c.n_pairs, card.tasks.gold_clusters.n)).toBe(SDD[model]!);
    }
    expect(SDD).toEqual({ 'claude-opus-5-5': 0.091, 'particle-1': 0.129, 'gpt-6.1-sol': 0.109 });
  });

  test('B minus stored A is computed exactly as phase 2\'s scorecard computes P1', () => {
    const s = stored();
    const same = runOf({ ...NEWEST, arms: ['B'], outcome: baseline });
    const c = compareBuilds(input({ newest: same, stored: s }));
    const card = buildTaskScorecard({ tasks: fixtureTasks, forms: FORMS2, arms: ['A', 'B'], models: MODELS2, records: s.records, identity: {}, task_summary: { submitted: 21, kept_at_freeze: 21, dropped_unreachable: 0, gold_missing_at_run: 0, sha_prefix: 'x', n_frozen: 21 }, custody: { readonly_verified_start: true, readonly_verified_end: true, guard_refusals: {} }, stop: null, ledger_usd: null, audit: null });
    expect(c.b_vs_a.paired).toBe(true);
    let checked = 0;
    for (const x of c.b_vs_a.comparisons as any[]) {
      const short = x.model === 'claude-opus-5-5' ? 'opus' : 'sol';
      const ref = card.comparisons.find(y => y.id === 'b_vs_a_correct_' + x.form + '_' + short)!;
      expect({ n: x.n_pairs, a: x.mean_a, b: x.mean_b, d: x.delta, ci: x.ci95, worse: x.worse_tasks, p: x.p_two_sided, mde: x.mde, reading: x.reading }).toEqual({ n: ref.n_pairs, a: ref.mean_a, b: ref.mean_b, d: ref.delta, ci: ref.ci95, worse: ref.worse_tasks, p: ref.p_two_sided, mde: ref.mde, reading: ref.reading });
      checked++;
    }
    expect(checked).toBe(6);
    expect((c.drift as any[]).every(x => x.delta === 0 && x.reading === 'no_measurable_difference')).toBe(true);
  });

  test('a large drop at the newest build reads as a regression for the primary model, with failure classes by task type', () => {
    const lost = (form: TaskForm, task: Task, arm: TaskArm, model: string): Outcome => (model === 'claude-opus-5-5' && form === 'paraphrase' ? { correct: false, goldSeen: false } : baseline(form, task, arm, model));
    const c = compareBuilds(input({ newest: newestRun(lost) }));
    const opus = c.builds.find(x => x.id === 'newest_vs_reference_correct_paraphrase_opus')!;
    expect(opus).toMatchObject({ primary: true, sdd: 0.091, verdict: 'regression', reading: 'b_lower' });
    expect(opus.ci95![1]!).toBeLessThan(0);
    expect(opus.p_holm).not.toBeNull();
    const sol = c.builds.find(x => x.id === 'newest_vs_reference_correct_paraphrase_sol')!;
    expect(sol).toMatchObject({ primary: false, sdd: 0.109, verdict: 'no_measurable_difference', delta: 0 });
    expect(c.builds.filter(x => x.primary).map(x => x.model)).toEqual(['claude-opus-5-5']);
    const classes = (c.failure_classes as any)['claude-opus-5-5'].paraphrase;
    const lostTotal = Object.values(classes).reduce((s: number, x: any) => s + x.lost, 0);
    expect(lostTotal).toBe(opus.worse_tasks!);
    expect(Object.values(classes).every((x: any) => x.gold_not_found === x.lost && x.no_answer === 0 && x.gained === 0)).toBe(true);
    expect(Object.keys(classes).sort()).toEqual(['cross_source', 'error_string', 'identifier', 'time_window', 'topic']);
  });

  test('the verdict follows the decision rule', () => {
    expect(verdictOf({ delta: -0.12, ci95: [-0.2, -0.03] }, 0.091)).toBe('regression');
    expect(verdictOf({ delta: -0.091, ci95: [-0.2, -0.01] }, 0.091)).toBe('regression');
    expect(verdictOf({ delta: -0.05, ci95: [-0.09, -0.01] }, 0.091)).toBe('drop_smaller_than_sdd');
    expect(verdictOf({ delta: -0.12, ci95: [-0.25, 0] }, 0.091)).toBe('no_measurable_difference');
    expect(verdictOf({ delta: 0.1, ci95: [0.02, 0.2] }, 0.091)).toBe('newest_higher');
    expect(verdictOf({ delta: null, ci95: null }, 0.091)).toBeNull();
  });

  test('a task lost by one run leaves the pair and is counted, and without the stored run B minus A reads against the published A rates, unpaired', () => {
    const dropped = fixtureTasks[0]!.id;
    const c = compareBuilds(input({ reference: reference(baseline, { kept: fixtureTasks.slice(1).map(t => t.id) }), stored: null, publishedA: { paraphrase: { 'claude-opus-5-5': 0.131, 'gpt-6.1-sol': 0.091 }, exact: { 'claude-opus-5-5': 0.162, 'gpt-6.1-sol': 0.071 } } }));
    const opus = c.builds.find(x => x.id === 'newest_vs_reference_correct_paraphrase_opus')!;
    expect(opus.n_pairs).toBe(fixtureTasks.length - 1);
    expect(opus.pairs_lost).toEqual({ a_only: 0, b_only: 1 });
    expect(c.b_vs_a.paired).toBe(false);
    const row = (c.b_vs_a.comparisons as any[]).find(x => x.id === 'newest_vs_published_a_correct_paraphrase_opus');
    expect(row.mean_a).toBe(0.131);
    expect(row.delta).toBeCloseTo(row.mean_b - 0.131, 4);
    expect(c.drift).toBeNull();
    expect(dropped).toBeTruthy();
  });

  test('refuses inputs the amendment does not let it pair', async () => {
    const refused = async (over: Record<string, unknown>, why: string) => expect(await abortCode(() => compareBuilds(input(over)))).toBe('LR_COMPARE_MISMATCH: ' + why);
    const n = newestRun();
    await refused({ tasksSha256: '0'.repeat(64) }, 'the newest run was made on another task file');
    await refused({ freeze: { ...FREEZE, kept_ids: fixtureTasks.slice(1).map(t => t.id) } }, 'the newest run keeps tasks the freeze did not keep');
    await refused({ freeze: { ...FREEZE, n_kept: fixtureTasks.length - 1 } }, 'the newest run was made on another freeze of this task file');
    await refused({ reference: (r => ({ ...r, run: { ...r.run, task_summary: { ...r.run.task_summary, dropped_unreachable: 1 } } }))(reference()) }, 'the reference run was made on another freeze of this task file');
    await refused({ reference: { ...reference(), run: { ...reference().run, build: { reference_build: null, code_schema_version: 296, privacy_gate: GATE } } } }, 'the reference run did not load its build with --reference-build');
    await refused({ reference: reference(baseline, { gate: { ...GATE, newest_commit: 'f'.repeat(40) } }) }, 'the reference run\'s privacy gate did not compare against the newest run\'s build');
    await refused({ reference: reference(baseline, { gate: null }) }, 'the reference run\'s privacy gate did not compare against the newest run\'s build');
    await refused({ reference: runOf({ ...NEWEST, arms: ['B'], outcome: baseline, reference: true, gate: GATE }) }, 'both runs loaded the same gbrain build');
    await refused({ reference: reference(baseline, { harness: 'c'.repeat(64) }) }, 'the two runs differ in harness_digest');
    await refused({ newest: { ...n, run: { ...n.run, identity: { ...n.run.identity, control: false } } } }, 'one run is the fixture and the other is not');
    await refused({ freeze: null, newest: { ...n, run: { ...n.run, identity: { ...n.run.identity, control: false } } }, reference: (r => ({ ...r, run: { ...r.run, identity: { ...r.run.identity, control: false } } }))(reference()) }, 'a counted compare needs --freeze');
    await refused({ stored: runOf({ version: '0.60.613.0', commit: '98dda48fb9fd339609d6d4eef009811280ff648d', arms: ['A', 'B'], outcome: baseline, harness: 'e'.repeat(64), runner: PHASE2_RUNNER_COMMIT }) }, 'the stored run is not phase 2\'s counted run (harness digest, runner commit or a dirty runner)');
    await refused({ stored: (x => ({ ...x, run: { ...x.run, identity: { ...x.run.identity, runner_dirty: true } } }))(stored()) }, 'the stored run is not phase 2\'s counted run (harness digest, runner commit or a dirty runner)');
    const lacking = stored();
    const dropKey = episodeKey('exact', fixtureTasks[3]!.id, 'A', 'gpt-6.1-sol');
    lacking.records = lacking.records.filter(x => !(x.kind === 'answer' && x.key === dropKey));
    await refused({ stored: lacking }, 'the stored run\'s records lack arm A answers for 1 episodes');
    await refused({ stored: { ...stored(), records: [] } }, 'the stored run\'s records lack arm A answers for ' + 2 * 2 * fixtureTasks.length + ' episodes');
    await refused({ stored: runOf({ version: '0.60.613.0', commit: '98dda48fb9fd339609d6d4eef009811280ff648d', arms: ['B'], outcome: baseline, harness: PHASE2_HARNESS_DIGEST, runner: PHASE2_RUNNER_COMMIT }) }, 'the stored run has no arm A');
    await refused({ stored: runOf({ version: '0.60.613.0', commit: '98dda48fb9fd339609d6d4eef009811280ff648d', arms: ['A', 'B'], outcome: baseline, harness: PHASE2_HARNESS_DIGEST, runner: PHASE2_RUNNER_COMMIT, kept: fixtureTasks.slice(1).map(t => t.id) }) }, 'the new runs keep tasks the stored run did not');
    await refused({ stored: runOf({ version: '0.60.613.0', commit: '98dda48fb9fd339609d6d4eef009811280ff648d', arms: ['A', 'B'], outcome: baseline, harness: PHASE2_HARNESS_DIGEST, runner: PHASE2_RUNNER_COMMIT, judge: () => 'claude-opus-5-5' }) }, 'a stored arm A verdict came from another judge than phase 2\'s');
  });

  test('a counted compare takes only phase 2\'s frozen task file and freeze.json, as its public record names them', async () => {
    const card = JSON.parse(readFileSync(join(REPO, 'docs/benchmarks/2026-11-09-live-recall-phase2/scorecard.json'), 'utf8'));
    expect(card.tasks.sha_prefix).toBe(PHASE2_TASKS_SHA256_PREFIX);
    expect(readFileSync(join(REPO, 'docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md'), 'utf8')).toContain('`freeze.json` has sha256\n  `' + PHASE2_FREEZE_SHA256_PREFIX + '…');
    const P2_TASKS = PHASE2_TASKS_SHA256_PREFIX + '0'.repeat(52), P2_FREEZE = PHASE2_FREEZE_SHA256_PREFIX + '0'.repeat(56);
    const counted = (x: CompareRun, sha: string): CompareRun => ({ ...x, run: { ...x.run, tasks_sha256: sha, identity: { ...x.run.identity, control: false } } });
    const runs = (sha = P2_TASKS) => ({ tasksSha256: sha, newest: counted(newestRun(), sha), reference: counted(reference(), sha), stored: counted(stored(), sha) });
    expect(compareBuilds(input({ ...runs(), freeze: { ...FREEZE, sha256: P2_FREEZE } }))).toMatchObject({ control: false, tasks: { sha_prefix: PHASE2_TASKS_SHA256_PREFIX, freeze_sha256: P2_FREEZE }, b_vs_a: { paired: true } });
    expect(await abortCode(() => compareBuilds(input({ ...runs(sha256(fixtureText)), freeze: { ...FREEZE, sha256: P2_FREEZE } })))).toBe('LR_COMPARE_MISMATCH: the task file is not phase 2\'s frozen task file');
    expect(await abortCode(() => compareBuilds(input({ ...runs(), freeze: FREEZE })))).toBe('LR_COMPARE_MISMATCH: the freeze is not phase 2\'s freeze.json');
  });

  test('the compare file passes its own allowlist and the leak scan, and a private string or an unknown key stops it', () => {
    const c = compareBuilds(input());
    const md = renderCompareMarkdown(c);
    const runs = [newestRun(), reference(), stored()];
    const json = checkCompareOutbound(c, md, fixtureTasks, runs);
    expect(JSON.parse(json).schema).toBe(COMPARE_SCHEMA);
    expect(md).toContain('## Primary: newest minus reference, correct, paraphrase form');
    expect(() => validateCompare({ ...c, note: 'x' })).toThrow('LR_CUSTODY_LEAK');
    expect(() => validateCompare({ ...c, runs: { ...c.runs, newest: { ...c.runs.newest, gbrain_loaded_version: fixtureTasks[0]!.forms.paraphrase } } })).toThrow('LR_CUSTODY_LEAK');
    expect(() => checkCompareOutbound(c, md + '\n' + fixtureTasks[0]!.gold_answer.required_facts[0]!.fact, fixtureTasks, runs)).toThrow('LR_CUSTODY_LEAK');
    expect(ABORT_CODES.LR_COMPARE_MISMATCH).toContain('--stored');
  });

  test('shows how many pages each run saw change, and whether the brain changed during the session', () => {
    const withPages = (r: CompareRun, p: BrainPages): CompareRun => ({ ...r, run: { ...r.run, brain_pages: p } });
    const still = { at_start: 40, at_end: 40, updated_since_start: 0 };
    const quiet = compareBuilds(input({ newest: withPages(newestRun(), still), reference: withPages(reference(), still) }));
    expect([quiet.brain_changed, quiet.runs.reference.brain_pages]).toEqual([false, still]);
    const md = renderCompareMarkdown(quiet);
    expect(md).toContain('The brain during the session: newest run 40 pages at the start, 40 at the end, 0 written or changed since it started');
    expect(md).toContain('No page changed during either run and the page count held between them.');
    expect(JSON.parse(checkCompareOutbound(quiet, md, fixtureTasks, [newestRun(), reference(), stored()])).brain_changed).toBe(false);
    for (const p of [{ ...still, updated_since_start: 2 }, { at_start: 41, at_end: 41, updated_since_start: 0 }, { ...still, at_end: 39 }]) {
      expect(compareBuilds(input({ newest: withPages(newestRun(), still), reference: withPages(reference(), p) })).brain_changed).toBe(true);
    }
    const unknown = compareBuilds(input({ newest: withPages(newestRun(), still), reference: withPages(reference(), { ...still, at_end: null }) }));
    expect(unknown.brain_changed).toBeNull();
    expect(renderCompareMarkdown(compareBuilds(input()))).toContain('newest run not recorded; reference run not recorded. Whether pages changed between the runs is not known.');
  });

  test('the CLI compares two finished run directories and refuses one that still owes calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lr2-compare-'));
    try {
      const write = (name: string, r: CompareRun, extra: Record<string, unknown> = {}) => {
        const d = join(root, name);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'run.json'), JSON.stringify({ ...r.run, tasks_path: FIXTURE_TASKS, truncation_waivers: [], ...extra }));
        writeFileSync(join(d, 'records.local.jsonl'), r.records.map(x => JSON.stringify(x)).join('\n') + '\n');
        return d;
      };
      const n = write('newest', newestRun()), ref = write('reference', reference()), s = write('stored', stored());
      const lines: string[] = [];
      const path = compareRunDirs({ newest: n, reference: ref, stored: s, tasksPath: FIXTURE_TASKS, freezePath: null, out: join(root, 'out') }, l => lines.push(l));
      expect(JSON.parse(readFileSync(path, 'utf8')).b_vs_a.paired).toBe(true);
      expect(readFileSync(join(root, 'out', 'compare.md'), 'utf8')).toBe(renderCompareMarkdown(JSON.parse(readFileSync(path, 'utf8'))));
      expect(lines.at(-1)).toStartWith('compare (send these two files): ');
      const short = newestRun();
      short.records = short.records.filter(x => !(x.kind === 'judge' && x.key.startsWith('exact|')));
      const owing = write('owing', short);
      expect(await abortCode(() => compareRunDirs({ newest: owing, reference: ref, stored: s, tasksPath: FIXTURE_TASKS, freezePath: null, out: join(root, 'out2') }, () => {}))).toStartWith('LR_COMPARE_MISMATCH: a run directory still owes calls');
      expect(await main(['compare', '--newest', owing, '--reference', ref, '--tasks', FIXTURE_TASKS, '--out', join(root, 'out3')])).toBe(3);
      expect(existsSync(join(root, 'out2', 'compare.json'))).toBe(false);
      const bare = join(root, 'bare');
      mkdirSync(bare);
      writeFileSync(join(bare, 'run.json'), readFileSync(join(s, 'run.json')));
      writeFileSync(join(root, 'torn.json'), '{');
      const base = { newest: n, reference: ref, stored: s as string | null, tasksPath: FIXTURE_TASKS, freezePath: null as string | null, out: join(root, 'out4') };
      for (const [over, why] of [
        [{ freezePath: join(root, 'no-freeze.json') }, 'freeze.json is missing or unreadable'],
        [{ freezePath: join(root, 'torn.json') }, 'freeze.json is not JSON'],
        [{ stored: join(root, 'no-such-run') }, 'the stored run\'s run.json is missing or unreadable'],
        [{ stored: bare }, 'the stored run has no records.local.jsonl'],
        [{ tasksPath: join(root, 'no-tasks.jsonl') }, 'the task file is missing or unreadable'],
      ] as const) expect(await abortCode(() => compareRunDirs({ ...base, ...over }, () => {}))).toBe('LR_COMPARE_MISMATCH: ' + why);
      expect(existsSync(join(root, 'out4'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


// ─── A counted run on a real Postgres brain (opt-in) ───────────────────────────────────────────────────────────────

/**
 *   docker run -d --name lr-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55440:5432 pgvector/pgvector:pg17
 *   LIVE_RECALL_PG_TEST_URL=postgresql://postgres:postgres@127.0.0.1:55440/postgres bun test test/eval/live-recall-phase2-newest.test.ts
 *
 * The URL must name a superuser on a scratch server. The fixture's phase 2 brain is built in a database of its own and
 * read through a SELECT-only role, with hash embeddings and scripted model replies, so nothing leaves the process.
 */
const PG_URL = process.env.LIVE_RECALL_PG_TEST_URL;

describe.skipIf(!PG_URL)('tasks.ts on a real Postgres brain (opt-in)', () => {
  const suffix = String(process.pid), db = 'lr2_src_' + suffix, role = 'lr2_reader_' + suffix;
  const dbUrl = (name: string, user?: string, password?: string) => {
    const u = new URL(PG_URL!);
    u.pathname = '/' + name;
    if (user) { u.username = user; u.password = password!; }
    return u.toString();
  };
  const ENV = ['GBRAIN_HOME', 'HOME', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'LIVE_RECALL_DATABASE_URL', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL', 'GBRAIN_AUDIT_DIR', 'GIT_TEST_ASSUME_DIFFERENT_OWNER'];
  const saved: Record<string, string | undefined> = {};
  let admin: ReturnType<typeof postgres>;
  let dir: string, operator: string;
  let reset: () => void;

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ['GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL']) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'lr2-pg-'));
    operator = join(dir, 'operator');
    mkdirSync(join(operator, '.gbrain'), { recursive: true });
    process.env.GBRAIN_HOME = operator;
    process.env.GBRAIN_AUDIT_DIR = dir;
    process.env.OPENAI_API_KEY = 'fixture';
    process.env.VOYAGE_API_KEY = 'fixture';
    writeFileSync(join(operator, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: dbUrl(db), embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: FIXTURE_DIM, voyage_api_key: 'fixture', search: { keyword_statement_timeout_ms: 9000, token: 'fixture' } }));
    admin = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS ' + db + ' WITH (FORCE)');
    await admin.unsafe('DROP ROLE IF EXISTS ' + role);
    await admin.unsafe('CREATE DATABASE ' + db);
    reset = await useFixtureTransports(gut);
    const { createEngine } = await importGbrain<any>(gut, 'src/core/engine-factory.ts');
    const engine = await createEngine({ engine: 'postgres', database_url: dbUrl(db) });
    await engine.connect({ engine: 'postgres', database_url: dbUrl(db) });
    await engine.initSchema();
    await ingestFixture(gut, engine, PHASE2_PAGES);
    await engine.disconnect();
    await admin.unsafe('CREATE ROLE ' + role + " LOGIN PASSWORD 'reader-pw' BYPASSRLS");
    await admin.unsafe('GRANT CONNECT ON DATABASE ' + db + ' TO ' + role);
    const s = postgres(dbUrl(db), { max: 1, onnotice: () => {} });
    await s.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await s.unsafe('GRANT USAGE ON SCHEMA public TO ' + role);
    await s.unsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + role);
    await s.end();
  }, 300_000);
  const readerUrl = () => { process.env.LIVE_RECALL_DATABASE_URL = dbUrl(db, role, 'reader-pw'); };

  afterAll(async () => {
    reset?.();
    if (admin) {
      await admin.unsafe('DROP DATABASE IF EXISTS ' + db + ' WITH (FORCE)');
      await admin.unsafe('DROP ROLE IF EXISTS ' + role);
      await admin.end();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('freeze and run open the brain with gbrain in a home of its own inside the run directory, read the runner\'s commit before the home moves, and record the brain\'s page counts', async () => {
    const freezePath = join(dir, 'freeze.json');
    readerUrl();
    expect(await main(['freeze', '--tasks', FIXTURE_TASKS, '--database-url-env', 'LIVE_RECALL_DATABASE_URL', '--out', freezePath])).toBe(5);
    expect(JSON.parse(readFileSync(join(dir, 'freeze-log', 'gbrain-home', '.gbrain', 'config.json'), 'utf8')).database_url).toBeUndefined();
    expect({ GBRAIN_HOME: process.env.GBRAIN_HOME, HOME: process.env.HOME }).toEqual({ GBRAIN_HOME: operator, HOME: saved.HOME });
    const checkPath = join(dir, 'judge-check.json');
    writeFileSync(checkPath, JSON.stringify({ schema: 'live-recall-judge-check/v1', passed: true, stop: null, complete: true, n_tasks_checked: 20, tasks_sha256: sha256(fixtureText), run: { harness_digest: PHASE2_HARNESS_DIGEST, runner_commit: PHASE2_RUNNER_COMMIT, control: false, models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], arms: ['A', 'B', 'C', 'D'] }, judges: {} }));
    writeFileSync(join(operator, '.gitconfig'), '[safe]\n\tdirectory = *\n');
    process.env.HOME = operator;
    const before = { GBRAIN_HOME: process.env.GBRAIN_HOME, HOME: process.env.HOME };
    const out = join(dir, 'run'), home = join(out, 'gbrain-home');
    const p = scriptedOpus();
    let during = null as Record<string, string | undefined> | null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { during ??= { GBRAIN_HOME: process.env.GBRAIN_HOME, HOME: process.env.HOME }; return p.fetchImpl(input, init); }) as typeof fetch;
    const ledgerPath = join(dir, 'ledger.sqlite');
    const budget = BudgetRun.open({ runner: 'live-recall-phase2-newest-test', budgetUsd: 2, ledgerPath, programCapUsd: 10 });
    const paid: Paid = { run: budget, guard: installPaidRequestGuard(budget, { fetchImpl }), runner: 'live-recall-phase2-newest-test', capUsd: 2, ledgerPath };
    try {
      readerUrl();
      process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
      const r = await runTaskSet({
        out, gut, fixture: false, tasksPath: FIXTURE_TASKS, freezePath, databaseUrlEnv: 'LIVE_RECALL_DATABASE_URL', forms: ['paraphrase'], arms: ['B'], models: ['claude-opus-5-5'],
        limit: 2, concurrency: 1, resume: false, windowNote: null, paid, judgeCheckPath: checkPath, judgeCheckWaiver: null, truncationWaiver: null,
      }, () => {});
      expect(r.result).toBe('complete');
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
      paid.guard.uninstall();
      budget.close({ finish: false });
    }
    expect(p.sent.length).toBeGreaterThan(0);
    expect(during).toEqual({ GBRAIN_HOME: home, HOME: home });
    expect({ GBRAIN_HOME: process.env.GBRAIN_HOME, HOME: process.env.HOME }).toEqual(before);
    const copied = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    expect(copied).toMatchObject({ engine: 'postgres', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: FIXTURE_DIM, search: { keyword_statement_timeout_ms: 9000 } });
    expect([copied.database_url, copied.voyage_api_key, copied.search.token]).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(copied).filter(k => /_api_key$/.test(k))).toEqual([]);
    const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
    expect(run.identity).toMatchObject({ barrier: 'no_write_privilege', runner_commit: execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runner_dirty: execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '', engine: 'postgres' });
    expect(run.judge_check_carried).toMatchObject({ from_harness_digest: PHASE2_HARNESS_DIGEST, judge_requests: PHASE2_JUDGE_REQUESTS });
    expect(run.brain_pages.at_start).toBeGreaterThan(30);
    expect(run.brain_pages).toEqual({ at_start: run.brain_pages.at_start, at_end: run.brain_pages.at_start, updated_since_start: 0 });
  }, 300_000);
});
