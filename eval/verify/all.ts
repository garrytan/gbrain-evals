/**
 * eval/verify/all.ts — the outside-verification gate, keyless, $0.
 *
 * Runs every check under eval/verify/ and exits under the shared contract
 * (0 clean, 1 any failure, 2 a check could not run). Designed to sit next
 * to the receipts-manifest gate in CI: the manifest proves the README's
 * headline numbers map to committed bytes; these prove the surrounding
 * claims and citations stay honest between audits.
 *
 *   cited-artifacts       every cited path is committed or disclosed
 *   claim-hygiene         retired figures stay retired, qualified stay qualified
 *   judge-model-evidence  alias-judged receipts carry server-reported model ids
 *   pins                  package.json / bun.lock / CI action pins agree
 *   cat34-crossrepo       the cross-repo Cat 34 baseline reproduces the receipt
 *
 * The stale-surface sweep (claim-hygiene --sweep) is NOT part of this gate:
 * it walks remote branches and PR heads, so it needs a fetch. Run it on a
 * schedule or by hand — see eval/RUNBOOK.md.
 *
 * Usage: bun eval/verify/all.ts [--quiet] [--strict] [--json] [--skip cat34-crossrepo,…]
 */

import { REPO_ROOT, parseArgs, runCli, type CheckReport } from './lib.ts';
import { checkCitedArtifacts } from './cited-artifacts.ts';
import { checkClaimHygiene } from './claim-hygiene.ts';
import { checkJudgeModelEvidence } from './judge-model-evidence.ts';
import { checkPins } from './pins.ts';
import { checkCat34CrossRepo } from './cat34-crossrepo.ts';

export const CHECKS: Array<{ name: string; run: (root: string) => CheckReport }> = [
  { name: 'cited-artifacts', run: root => checkCitedArtifacts({ root }) },
  { name: 'claim-hygiene', run: root => checkClaimHygiene({ root }) },
  { name: 'judge-model-evidence', run: root => checkJudgeModelEvidence({ root }) },
  { name: 'pins', run: root => checkPins({ root }) },
  { name: 'cat34-crossrepo', run: root => checkCat34CrossRepo({ root }) },
];

export function runAll(root = REPO_ROOT, skip: Set<string> = new Set()): CheckReport[] {
  return CHECKS.filter(c => !skip.has(c.name)).map(c => c.run(root));
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.get('root') === 'string' ? String(flags.get('root')) : REPO_ROOT;
  const skip = new Set(
    typeof flags.get('skip') === 'string' ? String(flags.get('skip')).split(',').map(s => s.trim()).filter(Boolean) : [],
  );
  runCli(runAll(root, skip), flags);
}
