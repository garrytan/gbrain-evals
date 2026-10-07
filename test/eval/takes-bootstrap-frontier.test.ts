/**
 * W4: the takes-bootstrap wrapper (caps, price flags, tree verification,
 * request stats, the label-independent verdict) and the harness overlay's
 * refusals. Hermetic: the overlay runs keyless and must refuse before any
 * provider call.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GBRAIN_DIR, OVERLAY, capFor, labelIndependentVerdict, parseCaps, priceFlags, requestStats, slugFor, verifyTree,
} from '../../eval/runner/takes-bootstrap-frontier.ts';

describe('takes-bootstrap wrapper', () => {
  test('parseCaps reads dollar caps and rest, and rejects bad entries', () => {
    expect(parseCaps('anthropic:claude-sonnet-5-5=0.8,anthropic:claude-fable-5-1=rest')).toEqual([
      { model: 'anthropic:claude-sonnet-5-5', maxUsd: 0.8 }, { model: 'anthropic:claude-fable-5-1', maxUsd: 'rest' }]);
    expect(() => parseCaps('openai:gpt-6.1-sol')).toThrow(/model=usd/);
    expect(() => parseCaps('openai:gpt-6.1-sol=-1')).toThrow(/positive/);
  });

  test('capFor gives rest the unspent budget, refuses past the budget and below a minimum', () => {
    expect(capFor({ model: 'm', maxUsd: 0.8 }, 6, 0)).toBe(0.8);
    expect(capFor({ model: 'm', maxUsd: 'rest' }, 6, 1.234)).toBe(4.76);
    expect(() => capFor({ model: 'm', maxUsd: 2 }, 6, 4.5)).toThrow(/exceeds/);
    expect(() => capFor({ model: 'fable', maxUsd: 'rest' }, 6, 4, 2.5)).toThrow(/below its preregistered minimum/);
  });

  test('priceFlags passes the ledger price only for models gbrain cannot price', () => {
    expect(priceFlags('anthropic:claude-sonnet-5-5', true)).toEqual([]);
    expect(priceFlags('openai:gpt-6.1-sol', false)).toEqual(['--price-input', '2', '--price-output', '10']);
    expect(() => priceFlags('openai:not-a-model', false)).toThrow(/no price/);
  });

  test('slugFor drops the provider prefix', () => {
    expect(slugFor('openai:gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(slugFor('anthropic:claude-fable-5-1')).toBe('claude-fable-5-1');
  });

  test('requestStats counts requests, non-2xx, output-limit finishes and retried cases', () => {
    expect(requestStats([
      { case: 'a', status: 200, stop: 'end_turn' }, { case: 'b', status: 529, stop: null }, { case: 'b', status: 200, stop: 'max_tokens' },
      { case: 'c', status: 200, stop: 'max_output_tokens' }, { case: null, status: 200, stop: 'completed' },
    ])).toEqual({ requests: 5, non_ok: 1, output_limit_finishes: 2, cases_with_retries: 1 });
  });

  test('labelIndependentVerdict passes only with zero malformed and zero forbidden attributions', () => {
    const variants = Array.from({ length: 123 }, () => ({}));
    expect(labelIndependentVerdict('m', { malformed: [], forbid_violations: [], by_variant: variants }).pass).toBe(true);
    expect(labelIndependentVerdict('m', { malformed: ['x'], forbid_violations: [], by_variant: variants }).pass).toBe(false);
    const v = labelIndependentVerdict('m', { malformed: [], forbid_violations: [{}, {}, {}], by_variant: variants });
    expect(v).toEqual({ model: 'm', cases: 123, malformed: 0, forbid_violations: 3, pass: false });
  });

  test('verifyTree detects an edited and a missing file against a commit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tree-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'x');
    const ref = git('rev-parse', 'HEAD');
    const copy = mkdtempSync(join(tmpdir(), 'copy-'));
    writeFileSync(join(copy, 'a.txt'), 'one\n');
    expect(verifyTree(repo, ref, copy, ['.'])).toEqual({ ref, files: 2, mismatched: [], missing: ['b.txt'] });
    writeFileSync(join(copy, 'b.txt'), 'changed\n');
    expect(verifyTree(repo, ref, copy, ['.']).mismatched).toEqual(['b.txt']);
  });
});

describe('takes-bootstrap harness overlay (keyless refusals)', () => {
  const env = { ...process.env, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } as Record<string, string>;
  const run = (args: string[], e = env) => spawnSync(process.execPath, [OVERLAY, '--gbrain-dir', DEFAULT_GBRAIN_DIR, ...args], { encoding: 'utf8', env: e, timeout: 120_000 });

  test('keyless live mode refuses with exit 2 before any call', () => {
    const r = run(['--model', 'openai:gpt-6.1-sol', '--max', '1', '--price-input', '2', '--price-output', '10']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('refusing to run keyless');
  });

  test('an unpriced model without price flags refuses with exit 2', () => {
    const r = run(['--model', 'openai:gpt-unpriced-fixture', '--max', '1'], { ...process.env, OPENAI_API_KEY: 'sk-test-not-used' } as Record<string, string>);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('has no canonical price');
  });

  test('a lone price flag refuses with exit 2', () => {
    const r = run(['--model', 'openai:gpt-6.1-sol', '--max', '1', '--price-input', '2'], { ...process.env, OPENAI_API_KEY: 'sk-test-not-used' } as Record<string, string>);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('together');
  });

  test('price flags let the estimate run and the over-cap refusal fire with exit 2', () => {
    const r = run(['--model', 'openai:gpt-6.1-sol', '--price-input', '2', '--price-output', '10', '--max-usd', '0.0001'], { ...process.env, OPENAI_API_KEY: 'sk-test-not-used' } as Record<string, string>);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('estimated spend $0.4683');
    expect(r.stderr).toContain('Refusing: the estimate exceeds --max-usd');
  });

  test('replay mode re-scores a predictions file at $0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    const preds = join(dir, 'p.jsonl');
    writeFileSync(preds, JSON.stringify({ id: 'take-plain-v1', claims: [{ claim: 'Acme Example is the strongest team in the batch.', kind: 'take', weight: 0.9 }] }) + '\n');
    const r = run(['--replay', preds, '--max', '1']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('GRADUATED');
  });
});
