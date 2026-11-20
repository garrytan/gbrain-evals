/**
 * BG1 hash list (GST-2010): the SHA-256 of every file under a BG1 custody tree, one "<sha256>  <path>" line per file,
 * sorted by path (sha256sum's format), and the SHA-256 of the list. It is RS1's hash list (eval/custody/rs1/hashlist.ts:
 * no links followed, no escaped paths, the list written outside the root) under BG1's name, so the two custody records
 * read the same way. The preregistration publishes only the list's SHA-256; the list stays in custody, and a restore
 * drill must reproduce it before the counted run.
 *
 *   bun eval/custody/bg1/hashlist.ts --root <out>/set --out <custody path>    write the list
 *   bun eval/custody/bg1/hashlist.ts --root <restored>/set --check <list>      compare a restored tree with a list
 *
 * It prints only counts and hashes.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { checkTree, HashListError, hashTree } from '../rs1/hashlist.ts';

export { checkTree, HashListError, hashTree };

const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };

export function main(argv: string[]): { line: string; code: number } {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = flag('--root'), out = flag('--out'), check = flag('--check');
  if (!root || (!out) === (!check)) throw new HashListError('usage: --root <dir> (--out <list> | --check <list>)');
  if (out) {
    if (inside(resolve(out), resolve(root))) throw new HashListError('--out must be outside --root');
    const list = hashTree(resolve(root));
    writeFileSync(resolve(out), list.text, { mode: 0o600 });
    return { line: `bg1-hashlist files=${list.files} bytes=${list.bytes} list_sha256=${list.sha256}`, code: 0 };
  }
  const r = checkTree(resolve(root), readFileSync(resolve(check!), 'utf8'));
  return { line: `bg1-hashlist matched=${r.matched} changed=${r.changed} missing=${r.missing} extra=${r.extra} identical=${r.identical} list_sha256=${r.list_sha256} tree_sha256=${r.tree_sha256}`, code: r.identical ? 0 : 1 };
}

if (import.meta.main) {
  try { const r = main(process.argv.slice(2)); console.log(r.line); process.exit(r.code); } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof HashListError ? `bg1-hashlist refused: ${e.message}\n` : `bg1-hashlist error class=${e.name} sha256=${createHash('sha256').update(String(e.message)).digest('hex').slice(0, 16)}\n`);
    process.exit(2);
  }
}
