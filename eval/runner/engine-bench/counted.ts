/**
 * Counted or development run, for the engine-bench stages. A stage run is counted unless `--dev` is passed. A counted
 * run refuses to start unless `--prereg` names a committed, unchanged preregistration that is on origin, and unless
 * the machine's load average is at most 2. The returned fields go into the stage receipt as they are, so
 * eval/runner/prereg.ts can check the attestation against the experiment's preregistration.
 */
import { loadavg } from 'node:os';
import { attestPreregistration, type Attestation } from '../prereg.ts';

export interface CountedRun {
  counted: boolean;
  preregistration_attestation: Attestation | null;
}

export function countedRun(argv: string[], repoRoot: string, load = loadavg()[0]): CountedRun {
  if (argv.includes('--dev')) return { counted: false, preregistration_attestation: null };
  const i = argv.indexOf('--prereg');
  const path = i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith('--prereg='))?.slice('--prereg='.length);
  if (!path) throw new Error('A counted run needs --prereg <committed preregistration>; pass --dev for an uncounted run.');
  const attestation = attestPreregistration(path, repoRoot);
  if (load > 2) throw new Error(`load average ${load.toFixed(2)} is above 2 at launch; a counted run needs the machine to itself`);
  return { counted: true, preregistration_attestation: attestation };
}
