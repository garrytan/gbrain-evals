/**
 * query-contract: `gbrain query --limit N` with no token budget returns exactly N rows on a brain whose pages carry
 * Facts fences. From v0.60.491.0 to v0.60.554.0 the dated facts block ran on no-budget queries too and put up to 40
 * fact rows ahead of the N pages (#8411, fixed in v0.60.555.0).
 */
import { check, jsonOut, seedBrain, tail, type SmokeContext } from './harness.ts';

const PROBES: Array<[string, number]> = [['works at Acme Example', 3], ['renewed its contract', 5], ['decision shipped', 4]];

export async function queryContract(ctx: SmokeContext): Promise<string> {
  const root = ctx.tonightRoot;
  const b = await seedBrain(ctx, root, { seed: 11 });
  const recall = await b.cli(root, ['recall', 'people/ada-alder-example', '--json']);
  check(recall.code === 0 && /Ada Alder works at Acme Example/.test(recall.stdout), 'facts_not_imported',
    () => `the seeded Facts fence of people/ada-alder-example is not recallable, so the contract would hold vacuously: ${tail(recall.stdout + recall.stderr, 4)}`);
  const seen: string[] = [];
  for (const [question, n] of PROBES) {
    const r = await b.cli(root, ['query', question, '--limit', String(n), '--json']);
    check(r.code === 0, 'query_failed', () => `query "${question}" exited ${r.code}: ${tail(r.stdout + r.stderr, 4)}`);
    const rows = jsonOut<Array<Record<string, unknown>>>(r);
    check(Array.isArray(rows), 'query_json_unreadable', () => `query "${question}" --json printed no JSON array: ${tail(r.stdout, 3)}`);
    const facts = rows!.filter(x => x.result_type === 'fact').length;
    check(rows!.length === n, 'query_limit_not_honored', `query "${question}" --limit ${n} with no budget returned ${rows!.length} rows (${facts} fact rows)`);
    seen.push(`${n}/${n} (${facts} facts)`);
  }
  return `query --limit N returned N rows on every probe: ${seen.join(', ')}`;
}
