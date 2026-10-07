/**
 * Eval-category wave step 0 shared pieces: hermetic environment, promotion
 * rules and their all.ts gating, --only, the paid-arm guard and the bug
 * ledger.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGISTRY, RUNNER_VERDICT, WAVE_2026_10_ALIASES, registryEntry } from '../../eval/registry.ts';
import { deriveStatus, paidGuard, parseOnly, selectCategories } from '../../eval/runner/all.ts';
import { BudgetRun, initLedger } from '../../eval/runner/budget-ledger.ts';
import { renderBugLedgerMarkdown, upsertBug, validateBugEntry, type BugEntry } from '../../eval/runner/bug-ledger.ts';
import {
  DECIDE_OFF, HERMETIC_STRIPPED_KEYS, SystemOneOnError, assertSystemOneOff, enterHermeticEnv, strippedKeysIn, withHermeticEnv,
} from '../../eval/runner/hermetic-env.ts';
import { PaidArmRefusal, paidRequested, requirePaidArm } from '../../eval/runner/paid-arm.ts';
import { checkPasses, evaluatePromotion, readPath } from '../../eval/runner/promotion.ts';
import type { Receipt } from '../../eval/runner/receipt.ts';

describe('hermetic env', () => {
  const dirty = () => ({
    OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'a', VOYAGE_API_KEY: 'v', TYPESAFE_API_KEY: 't', JEV_TYPESAFE_API_KEY: 'j',
    GBRAIN_DECIDE_SLOTS: 'triage=on', OPENAI_BASE_URL: 'http://proxy', SOMENEW_API_KEY: 'n', GBRAIN_HOME: '/home/someone',
    PATH: '/usr/bin', DATABASE_URL: 'postgres://keep',
  } as Record<string, string | undefined>);

  test('strips every provider and TypeSafe key, the decide override and base URLs, including key names gbrain adds later', () => {
    const env = dirty();
    const h = enterHermeticEnv('t', env);
    try {
      expect(h.stripped).toEqual(['ANTHROPIC_API_KEY', 'GBRAIN_DECIDE_SLOTS', 'JEV_TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'SOMENEW_API_KEY', 'TYPESAFE_API_KEY', 'VOYAGE_API_KEY']);
      for (const k of h.stripped) expect(env[k]).toBeUndefined();
      expect(env.PATH).toBe('/usr/bin');
      expect(env.DATABASE_URL).toBe('postgres://keep');
      expect(env.GBRAIN_HOME).toBe(h.home);
      expect(existsSync(h.home)).toBe(true);
      expect(h.decide).toBe(DECIDE_OFF);
      expect(() => assertSystemOneOff(h.home, env)).not.toThrow();
    } finally {
      h.restore();
    }
    expect(env).toEqual(dirty());
    expect(existsSync(h.home)).toBe(false);
  });

  test('the explicit list covers both TypeSafe names and the keys earlier runners stripped', () => {
    for (const k of ['TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY', 'ZEROENTROPY_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY']) expect(HERMETIC_STRIPPED_KEYS).toContain(k as never);
    expect(strippedKeysIn({ HOME: '/h', FOO_API_KEY: undefined })).toEqual([]);
  });

  test('restores the environment when the run throws', async () => {
    const before = { ...process.env };
    process.env.JEV_TYPESAFE_API_KEY = 'jev-test';
    let home = '';
    await expect(withHermeticEnv('t', async h => {
      home = h.home;
      expect(process.env.JEV_TYPESAFE_API_KEY).toBeUndefined();
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(process.env.JEV_TYPESAFE_API_KEY).toBe('jev-test');
    expect(existsSync(home)).toBe(false);
    if (before.JEV_TYPESAFE_API_KEY === undefined) delete process.env.JEV_TYPESAFE_API_KEY;
    else process.env.JEV_TYPESAFE_API_KEY = before.JEV_TYPESAFE_API_KEY;
  });

  test('a key or gbrain config that appears during the run voids it, with problem, cause and fix wording', async () => {
    await expect(withHermeticEnv('t', async () => { process.env.TYPESAFE_API_KEY = 'leak'; })).rejects.toThrow(SystemOneOnError);
    expect(process.env.TYPESAFE_API_KEY === 'leak').toBe(false);
    const home = mkdtempSync(join(tmpdir(), 'hermetic-test-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), '{}');
      let message = '';
      try { assertSystemOneOff(home, { GBRAIN_HOME: home, JEV_TYPESAFE_API_KEY: 'x' }); } catch (e) { message = (e as Error).message; }
      expect(message).toContain('System One may be on because a TypeSafe key is in the environment (JEV_TYPESAFE_API_KEY)');
      expect(message).toContain('.gbrain/config.json');
      expect(message).toContain('This category measures the keyless default');
      expect(message).toContain('Unset TYPESAFE_API_KEY, JEV_TYPESAFE_API_KEY and GBRAIN_DECIDE_SLOTS, or run `gbrain decide disable --all`');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Promotion rules ─────────────────────────────────────────────────────

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  schema_version: 1, benchmark_version: '0.5.0', category: 'x', run_status: 'completed', verdict: 'pass',
  n_total: 10, n_scored: 10, completion_rate: 1, errors: [], publishable: true, gbrain_version: 'v', gbrain_pin: 'p',
  started_at: 't', finished_at: 't', ...over,
});

describe('promotion rules', () => {
  test('every dispatched entry has rules; it gates exactly when a safety contract or quality threshold exists', () => {
    for (const e of REGISTRY) {
      if (e.run.kind !== 'dispatched') continue;
      expect([e.id, e.promotion !== undefined]).toEqual([e.id, true]);
      const p = e.promotion!;
      expect([e.id, /^\d{4}-\d{2}-\d{2}$/.test(p.preregistered) && p.basis.length > 10]).toEqual([e.id, true]);
      expect([e.id, e.gate]).toEqual([e.id, p.safety_contracts.length + p.quality_thresholds.length > 0 && !p.held ? 'gate' : 'report-only']);
      const ids = [...p.safety_contracts, ...p.quality_thresholds].map(c => c.id);
      expect([e.id, new Set(ids).size]).toEqual([e.id, ids.length]);
      for (const c of [...p.safety_contracts, ...p.quality_thresholds]) expect([e.id, c.id, c.description.length > 10, c.path.length > 0]).toEqual([e.id, c.id, true, true]);
    }
  });

  test('wave categories preregister their own rules: no bare runner verdict, and rules before the runner lands', () => {
    for (const alias of WAVE_2026_10_ALIASES) {
      const e = registryEntry(alias);
      if (!e) continue;
      expect([alias, e.promotion !== undefined]).toEqual([alias, true]);
      expect([alias, [...e.promotion!.safety_contracts, ...e.promotion!.quality_thresholds].some(c => c.path === RUNNER_VERDICT.path)]).toEqual([alias, false]);
    }
  });

  test('N3, N4 and N6 carry their recorded rules; N4 gates on safety while recall stays exploratory', () => {
    expect(registryEntry('N3')!.promotion!.quality_thresholds.map(c => c.id)).toEqual(['runner-verdict']);
    const n4 = registryEntry('N4')!;
    expect(n4.gate).toBe('gate');
    expect(n4.promotion!.safety_contracts.map(c => c.id)).toContain('no-identity-leak');
    expect(n4.promotion!.quality_thresholds.map(c => c.path)).not.toContain('verdict');
    const n6 = registryEntry('N6')!.promotion!;
    expect(n6.safety_contracts.map(c => c.id)).toEqual(['no-content-leak', 'no-existence-leak', 'no-existence-oracle', 'no-gate-bypass', 'no-sealed-chunk-violation', 'runner-verdict']);
  });

  test('paths, operators and missing values', () => {
    expect(readPath({ a: { b: 0 } }, 'a.b')).toBe(0);
    expect(readPath({ a: null }, 'a.b')).toBeUndefined();
    expect(checkPasses({ op: '==', value: 0 }, 0)).toBe(true);
    expect(checkPasses({ op: '==', value: 0 }, undefined)).toBe(false);
    expect(checkPasses({ op: '>=', value: 1 }, null)).toBe(false);
    expect(checkPasses({ op: '>=', value: 1 }, Number.NaN)).toBe(false);
    expect(checkPasses({ op: '<=', value: 0.1 }, 0.05)).toBe(true);
  });

  test('all.ts gates on the rules, not the verdict: N4 with a failing verdict but clean contracts passes', () => {
    const n4 = registryEntry('N4')!.promotion!;
    const surface = { wrong_merges: 0, floor: { rate: 1 } };
    const data = { identity: { leaks: 0 }, surfaces: { resolver: surface, recall: surface, remember: surface, resolve_on_save: surface }, search_floor: { rate: 1 } };
    const clean = deriveStatus({ kind: 'ok', receipt: receipt({ verdict: 'fail', data }) }, n4);
    expect(clean.status).toBe('pass');
    expect(clean.statusNote).toContain('verdict=fail; safety 5/5, quality 2/2');
    const leaky = deriveStatus({ kind: 'ok', receipt: receipt({ verdict: 'fail', data: { ...data, identity: { leaks: 1 } } }) }, n4);
    expect(leaky.status).toBe('fail');
    expect(leaky.statusNote).toContain('no-identity-leak (data.identity.leaks == 0, observed 1)');
    const missing = deriveStatus({ kind: 'ok', receipt: receipt({ verdict: 'pass', data: {} }) }, n4);
    expect(missing.status).toBe('fail');
    expect(missing.statusNote).toContain('observed missing');
  });

  test('legacy runner-verdict gates and report-only rules keep their old meaning', () => {
    const legacy = registryEntry('1')!.promotion!;
    expect(deriveStatus({ kind: 'ok', receipt: receipt({ verdict: 'partial' }) }, legacy).status).toBe('fail');
    expect(deriveStatus({ kind: 'ok', receipt: receipt() }, legacy).status).toBe('pass');
    const reportOnly = registryEntry('13')!.promotion!;
    expect(evaluatePromotion(reportOnly, receipt()).gated).toBe(false);
    expect(deriveStatus({ kind: 'ok', receipt: receipt({ verdict: 'fail' }) }, reportOnly).status).toBe('reported');
    expect(deriveStatus({ kind: 'ok', receipt: receipt({ run_status: 'error', verdict: undefined }) }, reportOnly).status).toBe('fail');
  });

  test('held rules are evaluated and reported but do not gate; a broken run still fails', () => {
    const rules = { preregistered: '2026-10-01', basis: 'a frozen floor waiting on a gbrain fix', safety_contracts: [{ id: 'zero-x', path: 'data.x', op: '==' as const, value: 0, description: 'no x ever appears' }], quality_thresholds: [], exploratory: [] };
    const held = { ...rules, held: { since: '2026-10-01', reason: 'waits on a gbrain fix' } };
    const failing = receipt({ verdict: 'fail', data: { x: 3 } } as Partial<Receipt>);
    expect(deriveStatus({ kind: 'ok', receipt: failing }, rules).status).toBe('fail');
    expect(evaluatePromotion(held, failing)).toMatchObject({ gated: false, pass: false });
    const reported = deriveStatus({ kind: 'ok', receipt: failing }, held);
    expect(reported.status).toBe('reported');
    expect(reported.statusNote).toContain('rules held since 2026-10-01 (safety 0/1');
    expect(deriveStatus({ kind: 'missing' }, held).status).toBe('fail');
  });
});

// ─── all.ts --only ───────────────────────────────────────────────────────

describe('all.ts --only', () => {
  test('accepts registry ids and legacy aliases, in either flag form', () => {
    expect([...parseOnly(['--only', 'N3,entity-resolution'])!].sort()).toEqual(['entity-resolution', 'temporal-asof']);
    expect([...parseOnly(['--only=N6'])!]).toEqual(['visibility-leak-fuzz']);
    expect(parseOnly(['--tier', 'offline'])).toBeNull();
  });

  test('an unknown id fails and lists the valid ids', () => {
    expect(() => parseOnly(['--only', 'N3,N99'])).toThrow(/unknown category "N99".*temporal-asof \(N3\)/);
    expect(() => parseOnly(['--only', ''])).toThrow(/comma-separated/);
  });

  test('runs exactly the selected categories and names every other one as not selected', () => {
    const { dispatch, notRun } = selectCategories('offline', parseOnly(['--only', 'N3,N4']));
    expect(dispatch.map(c => c.id)).toEqual(['N3', 'N4']);
    expect(notRun.filter(n => n.reason === 'not selected by --only')).toHaveLength(REGISTRY.length - 2);
    const paidOnly = selectCategories('offline', parseOnly(['--only', '13']));
    expect(paidOnly.dispatch).toEqual([]);
    expect(paidOnly.notRun.find(n => n.id === '13')!.reason).toBe('tier P not selected');
  });
});

// ─── Paid-arm guard ──────────────────────────────────────────────────────

describe('paid-arm guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paid-arm-'));
  const ledgerPath = join(dir, 'ledger.sqlite');
  initLedger({ ledgerPath });

  test('refuses without both flags and names the fix and the money left', () => {
    let message = '';
    try { requirePaidArm([], { arm: 'N1 paid arm', estimateUsd: 5, ledgerPath }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('N1 paid arm spends money (estimate $5.00), and --paid and --budget-run-id <id> are missing');
    expect(message).toContain('Pass `--paid --budget-run-id <id>`');
    expect(message).toContain('$500.00 left of its $500.00 program cap; the wave cap is $150.00');
    expect(() => requirePaidArm(['--paid'], { arm: 'a', estimateUsd: 1, ledgerPath })).toThrow(/--budget-run-id <id> is missing/);
    expect(() => requirePaidArm(['--budget-run-id', 'x'], { arm: 'a', estimateUsd: 1, ledgerPath })).toThrow(/--paid is missing/);
    expect(() => requirePaidArm(['--paid', '--budget-run-id', 'nope'], { arm: 'a', estimateUsd: 1, ledgerPath })).toThrow(PaidArmRefusal);
  });

  test('accepts an open run with money left and reports what is left; refuses an estimate over it', () => {
    const run = BudgetRun.open({ runner: 'eval-category-wave', budgetUsd: 150, ledgerPath });
    const ok = requirePaidArm(['--paid', '--budget-run-id', run.runId], { arm: 'a', estimateUsd: 5, ledgerPath });
    expect(ok).toEqual({ budgetRunId: run.runId, remainingUsd: 150 });
    expect(() => requirePaidArm(['--paid', `--budget-run-id=${run.runId}`], { arm: 'big', estimateUsd: 200, ledgerPath })).toThrow(/has only \$150.00 left/);
    expect(paidRequested(['--paid'])).toBe(true);
    expect(paidRequested(['--seed', '3'])).toBe(false);
  });

  test('all.ts refuses a selection with paid categories, and passes the run id to children when allowed', () => {
    const paid = selectCategories('paid').dispatch;
    expect(() => paidGuard([], paid, { ledgerPath })).toThrow(/spends money \(estimate unmeasured\)/);
    expect(paidGuard([], selectCategories('offline').dispatch, { ledgerPath })).toEqual({});
    const run = BudgetRun.open({ runner: 'eval-category-wave', budgetUsd: 10, ledgerPath });
    expect(paidGuard(['--paid', '--budget-run-id', run.runId], selectCategories('paid', parseOnly(['--only', 'relational-ab'])).dispatch, { ledgerPath }))
      .toEqual({ BRAINBENCH_BUDGET_RUN_ID: run.runId });
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Bug ledger ──────────────────────────────────────────────────────────

describe('bug ledger', () => {
  const entry: BugEntry = {
    id: 'N5-1', category: 'forget-residue', classification: 'bug', contract: 'forget withdraws a fact from active recall (src/core/facts/forget.ts header)',
    gbrain_sha: '3a284aea26889b77c633aebb4149c3016d834ee6', surface: 'recall', repro: 'bun eval/runner/n5-forget-residue.ts --seed 1',
    expected: 'no withdrawn claim in recall', actual: 'withdrawn claim returned after reimport', status: 'open',
  };

  test('validates required fields, sha, status reasons and that only bugs get fixed', () => {
    expect(validateBugEntry(entry)).toEqual([]);
    expect(validateBugEntry({ ...entry, gbrain_sha: '3a284ae' })).toContain('N5-1: gbrain_sha must be a full 40-character commit');
    expect(validateBugEntry({ ...entry, status: 'deferred' })).toContain('N5-1: a deferred entry needs a reason');
    expect(validateBugEntry({ ...entry, status: 'fixed' })).toContain('N5-1: a fixed entry needs fixing_pr');
    expect(validateBugEntry({ ...entry, classification: 'feature-gap', status: 'fixed', fixing_pr: '#1' }).join(' ')).toContain('only a bug can be fixed');
    expect(validateBugEntry({ ...entry, id: 'bad id' })).toContain('bad id: id must look like <category>-<n>');
  });

  test('validates fix commits, closed gaps and reviews', () => {
    const sha = 'd44296cf4d6481a10eb85562d3179e38cfd02c43';
    const review = { date: '2026-10-02', gbrain_sha: sha, evidence: 'rerun' as const, receipts: ['docs/benchmarks/x/receipt.json'] };
    expect(validateBugEntry({ ...entry, status: 'fixed', fixing_pr: 'garrytan/gbrain#5845', fixing_commit: sha, review })).toEqual([]);
    expect(validateBugEntry({ ...entry, fixing_commit: 'd44296c' })).toContain('N5-1: fixing_commit must be a full 40-character commit');
    expect(validateBugEntry({ ...entry, review: { ...review, receipts: [] } })).toContain('N5-1: a rerun review names its receipts');
    expect(validateBugEntry({ ...entry, review: { ...review, evidence: 'trust-me' as never } }).join(' ')).toContain('review.evidence must be one of');
    expect(validateBugEntry({ ...entry, review: { ...review, date: '2 Oct' } })).toContain('N5-1: review.date must be YYYY-MM-DD');
    expect(validateBugEntry({ ...entry, status: 'closed', reason: 'r', fixing_pr: '#1' })).toContain('N5-1: a bug is fixed, not closed');
    expect(validateBugEntry({ ...entry, classification: 'feature-gap', status: 'closed' })).toContain('N5-1: a closed entry needs a reason and fixing_pr');
    expect(validateBugEntry({ ...entry, classification: 'feature-gap', status: 'closed', reason: 'gbrain now gates it', fixing_pr: '#1', review })).toEqual([]);
    const later = { ...review, date: '2026-10-03' };
    expect(validateBugEntry({ ...entry, review: later, review_history: [review] })).toEqual([]);
    expect(validateBugEntry({ ...entry, review, review_history: [later] })).toContain('N5-1: reviews must be in date order, oldest first');
    expect(validateBugEntry({ ...entry, review_history: [review] })).toContain('N5-1: review_history needs a current review');
    expect(validateBugEntry({ ...entry, review: later, review_history: [{ ...review, receipts: [] }] })).toContain('N5-1: a rerun review names its receipts');
  });

  test('the wave ledger records a review on or after 2026-10-03 on every entry and keeps the earlier reviews', () => {
    const ledger = JSON.parse(readFileSync(join(import.meta.dir, '../../docs/benchmarks/2026-10-01-wave-bugs.json'), 'utf8')) as { entries: BugEntry[] };
    expect(ledger.entries.filter(e => !e.review || e.review.date < '2026-10-03').map(e => e.id)).toEqual([]);
    const foundOn20261004 = ['N6-1', 'CL-1', 'CL-2'];
    const reviewedAgain = ledger.entries.filter(e => e.review?.date === '2026-10-04' && !foundOn20261004.includes(e.id));
    expect(reviewedAgain.filter(e => e.review_history?.at(-1)?.date !== '2026-10-03').map(e => e.id)).toEqual([]);
    const foundOn20261006 = ['N6-2'];
    const foundOn20261007 = ['N1-7', 'N6-3'];
    const firstWave = ledger.entries.filter(e => !['N7-8', 'N12-9', 'Cat7-1', ...foundOn20261004, ...foundOn20261006, ...foundOn20261007].includes(e.id));
    expect(firstWave.filter(e => e.review_history?.[0]?.date !== '2026-10-02').map(e => e.id)).toEqual([]);
    expect(ledger.entries.filter(e => e.status === 'fixed' && !e.fixing_commit).map(e => e.id)).toEqual([]);
  });

  test('upserts by id and renders the Markdown view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug-ledger-'));
    const path = join(dir, 'bugs.json');
    upsertBug(entry, path);
    upsertBug({ ...entry, id: 'N5-2', classification: 'feature-gap', status: 'deferred', reason: 'paraphrase retraction is not implemented' }, path);
    const ledger = upsertBug({ ...entry, status: 'fixed', fixing_pr: 'garrytan/gbrain#1' }, path);
    expect(ledger.entries.map(e => [e.id, e.status])).toEqual([['N5-1', 'fixed'], ['N5-2', 'deferred']]);
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(2);
    const md = renderBugLedgerMarkdown(ledger);
    expect(md).toContain('2 findings: 1 bugs (1 fixed), 1 feature gaps, 0 category defects.');
    expect(md).toContain('| N5-2 | forget-residue | feature-gap | deferred | `recall` |');
    expect(() => upsertBug({ ...entry, id: 'N5-3', gbrain_sha: 'x' }, path)).toThrow(/invalid bug entry/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Overlay mismatch wording ────────────────────────────────────────────

describe('overlay mismatch message', () => {
  test('names the problem, the likely cause and the fix', async () => {
    const { overlayMismatchMessage } = await import('../../eval/runner/gbrain-under-test.ts');
    const build = {
      commit: 'a'.repeat(40), tree: 'b'.repeat(40), version: '0.60.26.0',
      verified: { copy_tree: 'c'.repeat(40), tree_matches: false, symlinks_under_src: 0, dir_is_realpath: true, cli_version: '0.60.26.0', cli_version_matches: true },
    };
    const dirty = overlayMismatchMessage({ spec: '../gbrain', checkout: '/x/gbrain', ref: 'HEAD', dirty: true, build });
    expect(dirty).toContain('the copied tree is `cccccccccccc`, but `--gbrain ../gbrain` asked for commit `aaaaaaaaaaaa`');
    expect(dirty).toContain('has uncommitted changes');
    expect(dirty).toContain('Commit or stash, or pass `--gbrain <path>@<ref>`');
    expect(overlayMismatchMessage({ spec: 'g', checkout: 'g', ref: 'main', dirty: false, build })).toContain('The ref main probably moved');
  });
});
