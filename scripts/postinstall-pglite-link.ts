/**
 * gbrain's pglite-embedded-assets.ts reaches PGLite's WASM payload via a
 * repo-relative path (`../../node_modules/@electric-sql/pglite/dist/...`),
 * which assumes pglite sits in gbrain's OWN nested node_modules. That holds
 * in a gbrain checkout (and under `bun link gbrain`), but bun hoists
 * @electric-sql/pglite to the top level when gbrain is installed from the
 * pinned GitHub SHA — so `import 'gbrain/pglite-engine'` fails with
 * "Cannot find module .../pglite.wasm".
 *
 * Fix: recreate the nested layout with a relative symlink. Idempotent; no-op
 * when gbrain is locally linked (nested dir already real) or pglite isn't
 * hoisted.
 *
 * Runs from package.json "postinstall". Verify with:
 *   bun -e "await import('gbrain/pglite-engine')"
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const hoisted = join(root, 'node_modules', '@electric-sql', 'pglite');
const nestedParent = join(root, 'node_modules', 'gbrain', 'node_modules', '@electric-sql');
const nested = join(nestedParent, 'pglite');

if (!existsSync(join(root, 'node_modules', 'gbrain'))) {
  process.exit(0); // gbrain not installed (e.g. partial install); nothing to fix
}
if (!existsSync(hoisted)) {
  // pglite not hoisted — the nested copy must already exist AND resolve
  // (a stale symlink from a prior layout would exit here and leave a broken
  // link producing a confusing downstream import error).
  if (!existsSync(nested)) {
    try {
      if (lstatSync(nested).isSymbolicLink()) unlinkSync(nested);
    } catch {
      // nothing to clean
    }
    console.error('[postinstall] WARNING: no hoisted or nested @electric-sql/pglite found — gbrain/pglite-engine imports will fail');
  }
  process.exit(0);
}
try {
  const st = lstatSync(nested);
  if (st.isSymbolicLink()) unlinkSync(nested); // refresh a stale link
  else process.exit(0); // real nested install (linked checkout) — leave it alone
} catch {
  // nested path absent — create it
}
mkdirSync(nestedParent, { recursive: true });
symlinkSync(join('..', '..', '..', '@electric-sql', 'pglite'), nested, 'dir');
console.error('[postinstall] linked node_modules/gbrain/node_modules/@electric-sql/pglite -> hoisted copy');
