/**
 * The gbrain packages this repository installs:
 *
 *   gbrain         the product under test, pinned to a gbrain master commit.
 *   gbrain-cues    the memory-cue experiments (situation recall, the
 *                  LongMemEval-M pilot and Cat 36 cue arms). The cue code
 *                  exists only on the gbrain branch capy/situation-aware-recall,
 *                  so it is installed under its own alias instead of holding
 *                  the product pin back.
 *   gbrain-reader  the reading-notes reader A/B, pinned to gbrain master
 *                  e78f1c3 (v0.59.0.0), whose src/ tree is byte-identical to
 *                  the orphaned a9de062 the study first installed.
 *
 * Code that needs a pin reads it from package.json through declaredPin, so a
 * re-pin is a package.json edit, not a hunt for copies of the SHA.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');

/** The dependency spec in package.json, e.g. github:garrytan/gbrain#<sha>. */
export function declaredPin(name: 'gbrain' | 'gbrain-cues' | 'gbrain-reader', evalRoot = REPO_ROOT): string {
  const spec = JSON.parse(readFileSync(join(evalRoot, 'package.json'), 'utf8')).dependencies?.[name];
  if (typeof spec !== 'string') throw new Error(`package.json declares no ${name} dependency`);
  return spec;
}
