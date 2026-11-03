/**
 * RS1 hash list (GST-1154): the SHA-256 of every file under a custody tree, one "<sha256>  <path>" line per file,
 * sorted by path (sha256sum's format, so `sha256sum -c` checks it from the root), and the SHA-256 of the list. The draft
 * prereg publishes only the list's SHA-256; the list stays in custody, and a restore drill must reproduce it before
 * stage 3.
 *
 *   bun eval/custody/rs1/hashlist.ts --root <out>/set --out <custody path>    write the list
 *   bun eval/custody/rs1/hashlist.ts --root <restored>/set --check <list>      compare a restored tree with a list
 *
 * It prints only counts and hashes. A symlink, or anything else that is not a regular file or a directory, is refused,
 * since it could point outside custody, and so is a path that sha256sum would have to escape. The list is written
 * outside the root, so a later run does not hash it.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class HashListError extends Error {}

export interface HashList { text: string; sha256: string; files: number; bytes: number }

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export function hashTree(root: string): HashList {
  const entries: Array<[string, string]> = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join('/');
      if (/[\n\r\\]/.test(rel)) throw new HashListError(`a path under the root holds a newline or backslash (entry ${entries.length + 1})`);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) { const data = readFileSync(path); bytes += data.length; entries.push([rel, sha256(data)]); }
      else throw new HashListError(`${rel} is not a regular file or directory; a hash list follows no links`);
    }
  };
  if (!lstatSync(root).isDirectory()) throw new HashListError(`${root} is not a directory`);
  walk(root);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = entries.map(([rel, hash]) => `${hash}  ${rel}\n`).join('');
  return { text, sha256: sha256(text), files: entries.length, bytes };
}

const parse = (text: string) => new Map(text.split('\n').filter(Boolean).map(line => {
  const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
  if (!m) throw new HashListError('the list holds a line that is not "<sha256>  <path>"');
  return [m[2], m[1]] as [string, string];
}));

export interface CheckResult { matched: number; changed: number; missing: number; extra: number; identical: boolean; list_sha256: string; tree_sha256: string }

export function checkTree(root: string, listText: string): CheckResult {
  const want = parse(listText), tree = hashTree(root), have = parse(tree.text);
  let matched = 0, changed = 0, missing = 0;
  for (const [path, hash] of want) { const h = have.get(path); if (h === undefined) missing++; else if (h === hash) matched++; else changed++; }
  const extra = [...have.keys()].filter(p => !want.has(p)).length;
  return { matched, changed, missing, extra, identical: tree.sha256 === sha256(listText), list_sha256: sha256(listText), tree_sha256: tree.sha256 };
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = flag('--root'), out = flag('--out'), check = flag('--check');
  if (!root || (!out) === (!check)) throw new HashListError('usage: --root <dir> (--out <list> | --check <list>)');
  if (out) {
    if (inside(resolve(out), resolve(root))) throw new HashListError('--out must be outside --root');
    const list = hashTree(resolve(root));
    writeFileSync(resolve(out), list.text);
    console.log(`rs1-hashlist files=${list.files} bytes=${list.bytes} list_sha256=${list.sha256}`);
    return 0;
  }
  const r = checkTree(resolve(root), readFileSync(resolve(check!), 'utf8'));
  console.log(`rs1-hashlist matched=${r.matched} changed=${r.changed} missing=${r.missing} extra=${r.extra} identical=${r.identical} list_sha256=${r.list_sha256} tree_sha256=${r.tree_sha256}`);
  return r.identical ? 0 : 1;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof HashListError ? `rs1-hashlist refused: ${e.message}\n` : `rs1-hashlist error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(2);
  }
}
