/**
 * The launcher end to end on the keyless fixture: plan, run through the
 * metering proxy against the stub upstream, refuse a second run, resume
 * without repeating work, and refuse a resume whose inputs changed.
 *
 * Needs the pinned harness venv (`bun run harness:setup`). Skipped when it is
 * missing unless MPW_REQUIRE_HARNESS=1, which makes a missing venv a failure.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureHarness } from '../../eval/runner/harness-env.ts';

const ROOT = resolve(import.meta.dir, '../..');
let ready = true;
try { ensureHarness({ checkOnly: true }); } catch { ready = false; }
if (!ready && process.env.MPW_REQUIRE_HARNESS === '1') throw new Error('the harness venv is missing; run `bun run harness:setup`');

const SPEC = join(ROOT, 'eval/harness-provider/cells/fixture-gbrain-rag.json');

function launch(args: string[]) {
  const p = Bun.spawnSync([process.execPath, 'eval/runner/harness-cell.ts', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe.skipIf(!ready)('harness:cell keyless fixture', () => {
  test('plan, run, refuse rerun, resume idempotently, refuse changed inputs', () => {
    const cells = mkdtempSync(join(tmpdir(), 'mpw-cells-'));
    try {
      const plan = launch(['plan', SPEC, '--cells-dir', cells, '--stub-upstream']);
      expect(plan.code).toBe(0);
      const planned = JSON.parse(plan.out);
      expect(planned.cell_id).toMatch(/^fixture-tiny-gbrain-rag-[0-9a-f]{12}$/);
      const dir = join(cells, planned.cell_id);
      expect(existsSync(join(dir, 'stages'))).toBe(false);

      const run = launch(['run', SPEC, '--cells-dir', cells, '--stub-upstream']);
      expect(run.code, run.err).toBe(0);
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
      expect(summary.scheduled).toBe(4);
      expect(summary.score.complete).toBe(true);
      expect(summary.gates).toEqual({ complete: true, no_answer_or_retrieval_failures: true, delivered_context: true, no_remote_clamp: true });
      for (const stage of ['ingest', 'retrieve', 'answer', 'judge']) expect(readdirSync(join(dir, 'stages', stage)).length).toBeGreaterThan(0);
      const answer = JSON.parse(readFileSync(join(dir, 'stages/answer', readdirSync(join(dir, 'stages/answer'))[0]), 'utf8'));
      expect(answer.requests.length).toBe(1);
      expect(answer.requests[0].body.model).toBe('gpt-6-luna');
      expect(answer.final_prompt).not.toContain('answer_');
      const spend = JSON.parse(readFileSync(join(dir, 'spend.json'), 'utf8'));
      expect(spend.metered_by_label.byLabel.gbrain.requests).toBeGreaterThan(0);
      expect(spend.metered_by_label.byLabel.harness.requests).toBe(8);
      expect(spend.runs[0].stub).toBe(true);

      const again = launch(['run', SPEC, '--cells-dir', cells, '--stub-upstream']);
      expect(again.code).toBe(1);
      expect(again.err).toContain('already has');

      const mtimes = () => Object.fromEntries(readdirSync(join(dir, 'stages/answer')).map(f => [f, statSync(join(dir, 'stages/answer', f)).mtimeMs]));
      const before = mtimes();
      const resumed = launch(['resume', planned.cell_id, '--cells-dir', cells, '--stub-upstream']);
      expect(resumed.code, resumed.err).toBe(0);
      expect(mtimes()).toEqual(before);

      const cell = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8'));
      cell.spec.budget_usd = 2;
      writeFileSync(join(dir, 'cell.json'), JSON.stringify(cell));
      const changed = launch(['resume', planned.cell_id, '--cells-dir', cells, '--stub-upstream']);
      expect(changed.code).toBe(1);
      expect(changed.err).toContain('no longer matches its inputs');
      expect(changed.err).toContain('budget_usd');
    } finally {
      rmSync(cells, { recursive: true, force: true });
    }
  }, 300_000);
});
