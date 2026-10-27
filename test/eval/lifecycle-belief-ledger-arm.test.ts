import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SliceCell } from '../../eval/runner/lifecycle/slice.ts';

/** A CLI cell whose operator steps are recorded instead of run; `failing` names a step that exits 1. */
class StubCell extends SliceCell {
  readonly steps: Array<{ step: string; args: string[] }> = [];
  failing = '';
  override async operator(step: string, args: string[]) {
    this.steps.push({ step, args });
    const code = step === this.failing ? 1 : 0;
    this.operatorLog.push({ step, args, code, ms: 0, tail: code ? `${step} refused` : '' });
    return { code, stdout: step === 'decide-status' ? JSON.stringify({ slots: [{ slot: 'answer', effective: 'off' }] }) : '', stderr: '' };
  }
}

const work = mkdtempSync(join(tmpdir(), 'belief-arm-'));
const saved = process.env.EVAL_BELIEF_LEDGER;
const cell = (label: string) => new StubCell({ buildDir: work, engine: 'pglite', iface: 'cli', work, label, pgAdminUrl: '', port: 0 });

afterEach(() => {
  if (saved === undefined) delete process.env.EVAL_BELIEF_LEDGER;
  else process.env.EVAL_BELIEF_LEDGER = saved;
});

test('EVAL_BELIEF_LEDGER=1 enables the ledger on the vault after it becomes the default source and before any page is written', async () => {
  process.env.EVAL_BELIEF_LEDGER = '1';
  const c = cell('on');
  await c.setup();
  const names = c.steps.map(s => s.step);
  expect(c.steps.find(s => s.step === 'beliefs-enable')?.args).toEqual(['beliefs', 'enable', '--source', 'vault']);
  expect(names.indexOf('beliefs-enable')).toBe(names.indexOf('sources-default') + 1);
  expect(names.indexOf('beliefs-enable')).toBeLessThan(names.indexOf('decide-status'));
  expect(c.calls).toEqual([]);
});

test('without EVAL_BELIEF_LEDGER=1 the cell never runs beliefs enable', async () => {
  for (const value of [undefined, '0', 'true']) {
    if (value === undefined) delete process.env.EVAL_BELIEF_LEDGER;
    else process.env.EVAL_BELIEF_LEDGER = value;
    const c = cell(`off-${value ?? 'unset'}`);
    await c.setup();
    expect(c.steps.map(s => s.step)).not.toContain('beliefs-enable');
  }
});

test('a refused beliefs enable stops the cell before it serves a call', async () => {
  process.env.EVAL_BELIEF_LEDGER = '1';
  const c = cell('refused');
  c.failing = 'beliefs-enable';
  await expect(c.setup()).rejects.toThrow('beliefs enable failed: beliefs-enable refused');
  expect(c.steps.map(s => s.step)).not.toContain('decide-status');
  rmSync(work, { recursive: true, force: true });
});
