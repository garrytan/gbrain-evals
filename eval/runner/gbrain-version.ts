/**
 * gbrain version provenance — the ONE correct way to stamp receipts.
 *
 * 17 runners (cat18–cat33) previously did `import pkg from
 * 'gbrain/package.json'`, which is not in gbrain's export map, so every
 * receipt shipped `gbrain_version: 'unknown'` (audit critic cross-cut).
 * `require.resolve('gbrain/package.json')` fails the same way under the
 * strict export map.
 *
 * Mechanism: resolve gbrain's entry file (the "." export IS exported), then
 * walk up to the package root and fs-read package.json — fs does not care
 * about export maps. This reports the INSTALLED version, which under
 * `bun link` is the linked checkout — the code that actually ran.
 * `gbrainPin()` reports the DECLARED dependency spec so receipts make
 * link-vs-packaged divergence visible (WS0 hybrid policy).
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let cachedVersion: string | null = null;
let cachedPin: string | null = null;

/** Version of the gbrain actually installed/linked. 'unknown' only if resolution fails entirely. */
export function gbrainVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = 'unknown';
  try {
    const resolved = import.meta.resolve('gbrain');
    let dir = dirname(fileURLToPath(resolved));
    for (let i = 0; i < 10; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'gbrain' && typeof pkg.version === 'string') {
          cachedVersion = pkg.version;
          break;
        }
      } catch {
        // no package.json at this level — keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // resolution failed — leave 'unknown'
  }
  return cachedVersion;
}

/** The dependency spec declared in this repo's package.json (e.g. github:garrytan/gbrain#<sha>). */
export function gbrainPin(): string {
  if (cachedPin !== null) return cachedPin;
  cachedPin = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    cachedPin = pkg.dependencies?.gbrain ?? 'unknown';
  } catch {
    // leave 'unknown'
  }
  return cachedPin;
}
