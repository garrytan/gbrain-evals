/**
 * D8 manifest, run by the custodian on the custody host. It fills eval/decisions/datasets/d8-manifest.json, whose
 * file list stays empty (status unfilled) until then.
 *
 *   bun eval/runner/q1/d8-manifest.ts status [--json]        (reads the manifest only)
 *   bun eval/runner/q1/d8-manifest.ts fill [--write] [--json] (custodian; GBRAIN_EVALS_D8_SOURCE and GBRAIN_EVALS_CUSTODY_LOG)
 *
 * `fill` hashes every file beam-d8 reads (each conversation's chat file and its probing_questions/<ability>/<ability>.json
 * files) without parsing any of them, and prints paths and hashes only. `--write` records them and sets status to
 * filled; GBRAIN_EVALS_D8_MANIFEST names another manifest path (tests and stand-ins).
 */
import { writeFileSync } from 'node:fs';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';
import { DecideError, renderOperatorMessage, exitCodeFor, decideError } from '../decisions/errors.ts';
import { D8_CONVERSATIONS, d8ManifestFiles, d8ManifestPath, d8Source, readD8Manifest, type D8Manifest } from '../memory-qa/corpus.ts';

export function main(argv: string[], env: Record<string, string | undefined> = process.env, now = () => new Date().toISOString()): number {
  const json = argv.includes('--json');
  const path = d8ManifestPath();
  try {
    if (argv[0] === 'status') {
      const { manifest } = readD8Manifest(path);
      const out = { status: manifest.status, conversations: D8_CONVERSATIONS.length, files: manifest.files.length, filled_at: manifest.filled_at };
      console.log(json ? JSON.stringify(out) : `d8 manifest: ${out.status}, ${out.files} file(s) pinned for ${out.conversations} conversations${out.filled_at ? ` (filled ${out.filled_at})` : ''}`);
      return 0;
    }
    if (argv[0] !== 'fill') { console.error('usage: bun eval/runner/q1/d8-manifest.ts status|fill [--write] [--json]'); return 2; }
    const root = d8Source(env);
    const log = env.GBRAIN_EVALS_CUSTODY_LOG;
    if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'filling the D8 manifest needs the custody access log', why: 'every opening of a sealed set is logged, even to hash it',
      fix: { next: 'ask_user', user_message: 'the custodian fills the D8 manifest with GBRAIN_EVALS_CUSTODY_LOG set' } });
    const { manifest, sha256 } = readD8Manifest(path);
    appendAccessLog(log, { action: 'open', purpose: 'd8 manifest fill (hashes only, nothing parsed)', decision_id: env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', labels_sha256: sha256, run_sha256: null });
    const files = d8ManifestFiles(root);
    const filled: D8Manifest = { ...manifest, status: 'filled', files, filled_at: now() };
    if (argv.includes('--write')) writeFileSync(path, JSON.stringify(filled, null, 1) + '\n');
    if (json) console.log(JSON.stringify({ written: argv.includes('--write'), files }));
    else {
      for (const f of files) console.log(`${f.sha256}  ${f.path}`);
      console.log(argv.includes('--write') ? `recorded ${files.length} file(s) in ${path}` : `${files.length} file(s); rerun with --write to record them`);
    }
    return 0;
  } catch (e) {
    if (e instanceof DecideError) { console.error(renderOperatorMessage(e.op)); return exitCodeFor(e.op); }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
