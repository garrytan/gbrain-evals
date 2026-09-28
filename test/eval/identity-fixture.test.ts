import { expect, test } from 'bun:test';

test('identity keyword fixtures install the authored chunks as a current projection', () => {
  const script = `
    globalThis.fetch = async () => { throw new Error('network forbidden in identity fixture'); };
    process.argv = ['bun','eval/runner/identity.ts','--json'];
    const { main } = await import('./eval/runner/identity.ts');
    await main();
  `;
  const result = Bun.spawnSync(['bun', '-e', script], { cwd: process.cwd(), timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString());
  const report = JSON.parse(result.stdout.toString());
  expect(report.results).toHaveLength(800);
  expect(report.summary.docByType.fullname).toEqual({ found: 100, total: 100 });
  expect(report.summary.docByType.handle.total).toBe(100);
  expect(report.summary.docByType.email.total).toBe(100);
  expect(report.results.filter((row: { category: string }) => row.category === 'undocumented')).toHaveLength(400);
  expect(report.summary.docByType['handle-plain']).toEqual({ found: 100, total: 100 });
  expect(report.summary.undocByType['handle-plain']).toBeUndefined();
  expect(report.verdict).toBe('pass');
}, 70_000);

test('C-03: the handle without @ is present in the indexed text, so it is scored as documented', async () => {
  const { generateEntities, aliasType, cat3Verdict } = await import('../../eval/runner/identity.ts');
  for (const e of generateEntities(100)) {
    const handlePlain = e.indexedAliases[1].slice(1);
    expect(e.documentedAliases).toContain(handlePlain);
    expect(e.undocumentedAliases).not.toContain(handlePlain);
    const indexedTokens = new Set(`${e.fullName} ${e.indexedAliases.join(' ')}`.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean));
    for (const alias of e.undocumentedAliases) {
      expect(alias.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean).every(t => indexedTokens.has(t))).toBe(false);
    }
  }
  expect(aliasType('schen', 'documented')).toBe('handle-plain');
  expect(aliasType('S. Chen', 'undocumented')).toBe('initial');
  expect(cat3Verdict({ docRecall: 0.99, docMrr: 1 })).toBe('fail');
  expect(cat3Verdict({ docRecall: 1, docMrr: 0.9 })).toBe('fail');
  expect(cat3Verdict({ docRecall: 1, docMrr: 0.99 })).toBe('pass');
});
