/**
 * The gbrain packages this repository installs, in one place.
 *
 *   gbrain         the product under test, pinned to a gbrain master commit.
 *   gbrain-cues    the memory-cue experiments (situation recall, the
 *                  LongMemEval-M pilot and Cat 36 cue arms). The cue code
 *                  exists only on the gbrain branch capy/situation-aware-recall,
 *                  so it is installed under its own alias instead of holding
 *                  the product pin back.
 *   gbrain-reader  the reading-notes reader A/B.
 *
 * Every test or runner that needs an exact pin reads it from package.json
 * through these helpers, so a re-pin is a package.json edit, not a hunt for
 * copies of the SHA.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type GbrainPackage = 'gbrain' | 'gbrain-cues' | 'gbrain-reader';

export const GBRAIN_CUES_PACKAGE: GbrainPackage = 'gbrain-cues';

const REPO_ROOT = resolve(import.meta.dir, '../..');

/** The dependency spec in package.json, e.g. github:garrytan/gbrain#<sha>. */
export function declaredPin(name: GbrainPackage, evalRoot = REPO_ROOT): string {
  const spec = JSON.parse(readFileSync(join(evalRoot, 'package.json'), 'utf8')).dependencies?.[name];
  if (typeof spec !== 'string') throw new Error(`package.json declares no ${name} dependency`);
  return spec;
}

/** The full 40-character commit a github: pin names. */
export function pinnedSha(name: GbrainPackage, evalRoot = REPO_ROOT): string {
  const sha = /^github:garrytan\/gbrain#([a-f0-9]{40})$/.exec(declaredPin(name, evalRoot))?.[1];
  if (!sha) throw new Error(`${name} is not pinned to a full gbrain commit`);
  return sha;
}

/** Real path of the installed package directory. */
export function installedPackageRoot(name: GbrainPackage, evalRoot = REPO_ROOT): string {
  return realpathSync(join(evalRoot, 'node_modules', name));
}
