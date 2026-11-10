/**
 * Find the first bad first-parent commit of a nightly flag by binary search, rerunning only the firing items.
 *
 *   bun eval/runner/nightly/bisect.ts --suite <id> --items <a,b,...> [--reader <model>] --good <sha> --bad <sha>
 *     --gbrain-clone <path> --out <dir> [--fake | --paid --budget-run-id <id> --budget-ledger <path>]
 *     [--cat40-slot-allowance-usd <n>] [--pg-admin <url> [--pg-template <database>]] [--pg15-admin <url>]
 *
 * The range is the first-parent commits after --good up to --bad (the night's master), so a merged branch counts as the
 * one commit that brought it in, and about 4 steps cover a night's 16 commits. A commit is bad when at least half of the
 * firing items' trials fail there (the items passed on the good night and failed on the bad one). Each step is one
 * run.ts invocation on that commit with only those items, with the settings its suite needs (Cat 40's slot allowance, the
 * Postgres servers). Keyless suites cost machine time only. A paid bisect takes a nightly ledger run its caller opened
 * (`ledger.ts open`), passes it to every step and leaves it to that caller to close (`ledger.ts close`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readOutcomes } from './outcome.ts';

/** The run.ts flags a bisect step takes from bisect's own: the paid flags, the reader and the settings its suite needs. */
export function stepFlags(argv: readonly string[]): string[] {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  return [...['--fake', '--paid'].filter(f => argv.includes(f)),
    ...['--budget-run-id', '--budget-ledger', '--cat40-slot-allowance-usd', '--pg-admin', '--pg-template', '--pg15-admin'].flatMap(f => flag(f) ? [f, flag(f)!] : []),
    ...(flag('--reader') ? ['--readers', flag('--reader')!] : [])];
}

export function firstParentCommits(clone: string, good: string, bad: string): string[] {
  return execFileSync('git', ['-C', clone, 'rev-list', '--first-parent', '--reverse', `${good}..${bad}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/**
 * The first commit for which isBad holds, given that the last commit is bad and the commit before the first is good.
 * Every step is recorded, so a report can show the search.
 */
export async function bisect(commits: string[], isBad: (sha: string) => Promise<boolean>): Promise<{ first_bad: string | null; steps: Array<{ sha: string; bad: boolean }> }> {
  const steps: Array<{ sha: string; bad: boolean }> = [];
  if (!commits.length) return { first_bad: null, steps };
  let lo = 0, hi = commits.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bad = await isBad(commits[mid]!);
    steps.push({ sha: commits[mid]!, bad });
    if (bad) hi = mid; else lo = mid + 1;
  }
  return { first_bad: commits[lo]!, steps };
}

/** Bad when at least half of the firing items' non-harness trials fail. */
export function firingItemsBad(rows: Array<{ item: string; pass: boolean; harness: unknown }>, items: readonly string[]): boolean {
  const mine = rows.filter(r => items.includes(r.item) && !r.harness);
  if (!mine.length) throw new Error(`no outcome for the firing items ${items.join(', ')} (every trial was a harness error or the suite was skipped)`);
  return mine.filter(r => !r.pass).length * 2 >= mine.length;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const need = (name: string) => flag(name) ?? (() => { throw new Error(`${name} is required`); })();
  const suite = need('--suite'), items = need('--items').split(','), clone = resolve(need('--gbrain-clone')), out = resolve(need('--out'));
  const passthrough = stepFlags(argv);
  const commits = firstParentCommits(clone, need('--good'), need('--bad'));
  const result = await bisect(commits, async sha => {
    const dir = join(out, sha.slice(0, 12));
    const r = spawnSync('bun', [join(import.meta.dir, 'run.ts'), '--ref', sha, '--tier', 'bisect', '--suites', suite, '--items', items.join(','), '--gbrain-clone', clone, '--night-dir', dir, ...passthrough], { stdio: 'inherit' });
    if (r.status !== 0 && r.status !== 5) throw new Error(`run.ts on ${sha.slice(0, 12)} exited ${r.status}; the bisect stops there`);
    return firingItemsBad(readOutcomes(join(dir, 'outcomes.jsonl')), items);
  });
  console.log(JSON.stringify({ suite, items, commits: commits.length, ...result }, null, 2));
}
