#!/usr/bin/env bun
/**
 * Memory proof wave, A2: build, check and open the grouping manifest.
 *
 *   bun eval/runner/memory-proof-wave-grouping.ts build --private-dir <dir outside the repo> [--inputs <inputs.json>]
 *   bun eval/runner/memory-proof-wave-grouping.ts check [--private <dir>/grouping-private.json]
 *   bun eval/runner/memory-proof-wave-grouping.ts open --split dev --strata beam/500k,beam/1m
 *   bun eval/runner/memory-proof-wave-grouping.ts open --split validation --strata beam/500k,beam/1m \
 *       --private <dir>/grouping-private.json --access-log <dir>/access-log.jsonl --purpose "<why>"
 *   bun eval/runner/memory-proof-wave-grouping.ts open --split sealed --strata beam/500k,beam/1m \
 *       --private <dir>/grouping-private.json --access-log <dir>/access-log.jsonl --purpose "<why>" \
 *       --decision-id <id> --preregistration docs/benchmarks/<date>-memory-proof-wave-preregistration.md [--out <ids.json>]
 *
 * `build` refuses to overwrite a committed manifest: the split is fixed once,
 * before any tuning. `open` prints ids as JSON, or writes them to --out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256Hex } from './sealed-confirmation-lib.ts';
import type { PowerInputs } from './memory-proof-wave/harness-inputs.ts';
import { buildManifest, checkPrivate, checkPublic, loadManifest, newSalt, openSplit, PRIVATE_FILE_NAME, PUBLIC_MANIFEST_PATH, SPLITS, writePrivate, type Split } from './memory-proof-wave/grouping.ts';
import { DEFAULT_INPUTS } from './memory-proof-wave-power.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isCommitted(path: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path], { stdio: 'ignore' });
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', path], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const manifestPath = arg('manifest') ?? PUBLIC_MANIFEST_PATH;
  if (cmd === 'build') {
    if (existsSync(manifestPath)) throw new Error(`${manifestPath} exists; the split is fixed once, before tuning. Delete it only if nothing has been tuned or run on any split.`);
    const privateDir = arg('private-dir');
    if (!privateDir) throw new Error('build needs --private-dir <directory outside the repository> for the salt and the validation and sealed ids');
    if (resolve(privateDir).startsWith(resolve('.') + '/')) throw new Error('--private-dir must be outside the repository');
    const inputsPath = arg('inputs') ?? DEFAULT_INPUTS;
    const raw = readFileSync(inputsPath);
    const { manifest, privateBytes } = buildManifest(JSON.parse(raw.toString('utf8')) as PowerInputs, { path: inputsPath, sha256: sha256Hex(raw) }, newSalt(), new Date().toISOString().slice(0, 10));
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const privatePath = join(privateDir, PRIVATE_FILE_NAME);
    writePrivate(privatePath, privateBytes);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    const problems = checkPrivate(manifest, privatePath);
    if (problems.length) throw new Error(`built manifest fails its own check: ${problems.join('; ')}`);
    console.log(`wrote ${manifestPath} and ${privatePath}. Keep the private file and its access log with the sealed-confirmation files; it is the only copy of the salt.`);
    for (const g of manifest.groups) for (const s of g.strata) console.log(`  ${g.group} ${s.stratum}: dev ${s.dev.count}, validation ${s.validation.count}, sealed ${s.sealed.count} (${s.sealed.questions} questions)`);
    return;
  }
  if (cmd === 'check') {
    const m = loadManifest(manifestPath);
    const priv = arg('private');
    const problems = priv ? checkPrivate(m, priv) : checkPublic(m);
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log(`${manifestPath}: ok${priv ? ' (private file, salt and every commitment verified)' : ' (public checks only)'}`);
    return;
  }
  if (cmd === 'open') {
    const m = loadManifest(manifestPath);
    const split = arg('split') as Split;
    if (!SPLITS.includes(split)) throw new Error(`--split must be one of ${SPLITS.join(', ')}`);
    const strata = (arg('strata') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!strata.length) throw new Error('--strata is required, e.g. beam/500k,beam/1m');
    const preregPath = arg('preregistration');
    const ids = openSplit(m, {
      split, strata, purpose: arg('purpose') ?? '', privatePath: arg('private'), accessLogPath: arg('access-log'), decisionId: arg('decision-id') ?? null,
      preregistration: preregPath ? { path: preregPath, bytes: readFileSync(preregPath), committed: isCommitted(preregPath) } : undefined,
    });
    const out = arg('out');
    if (out) { writeFileSync(out, JSON.stringify(ids, null, 2) + '\n'); console.log(`wrote ${split} ids for ${strata.join(', ')} to ${out}`); }
    else console.log(JSON.stringify(ids, null, 2));
    return;
  }
  console.error('usage: memory-proof-wave-grouping.ts build --private-dir <dir> | check [--private <file>] | open --split dev|validation|sealed --strata <a,b> [...]');
  process.exit(2);
}

if (import.meta.main) await main();
