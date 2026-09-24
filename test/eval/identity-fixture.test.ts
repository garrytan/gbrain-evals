import { expect, test } from 'bun:test';

test('identity keyword fixtures install the authored chunks as a current projection', () => {
  const script = `
    globalThis.fetch = async () => { throw new Error('network forbidden in identity fixture'); };
    process.argv = ['bun','eval/runner/identity.ts','--json'];
    await import('./eval/runner/identity.ts');
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { cwd: process.cwd(), timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString());
  const report = JSON.parse(result.stdout.toString());
  expect(report.results).toHaveLength(800);
  expect(report.summary.docByType.fullname).toEqual({ found: 100, total: 100 });
  expect(report.summary.docByType.handle.total).toBe(100);
  expect(report.summary.docByType.email.total).toBe(100);
  expect(report.results.filter((row: { category: string }) => row.category === 'undocumented')).toHaveLength(500);
}, 70_000);
