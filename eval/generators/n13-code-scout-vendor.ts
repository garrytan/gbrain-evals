/**
 * N13 scout corpus: hash check for the vendored pathe snapshot.
 *
 *   verifyVendoredCorpus()  offline: every stored file matches manifest.json
 *                           (the runner calls this before importing anything);
 *   --check                 online: downloads each file from GitHub at the
 *                           pinned commit and compares hashes with the
 *                           manifest (manual; CI never runs it).
 *
 * Usage: bun eval/generators/n13-code-scout-vendor.ts [--check]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const N13_CORPUS_DIR = join(import.meta.dir, '../data/n13-code-scout');

export interface VendoredFile { path: string; stored_as: string; sha256: string; bytes: number }
export interface CorpusManifest {
  repository: string;
  commit: string;
  commit_date: string;
  license: string;
  license_file: { stored_as: string; sha256: string };
  files: VendoredFile[];
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function readCorpusManifest(dir = N13_CORPUS_DIR): CorpusManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as CorpusManifest;
}

/** Problems with the vendored copy: one line per file whose bytes do not match, naming both hashes. */
export function verifyVendoredCorpus(dir = N13_CORPUS_DIR): { manifest: CorpusManifest; problems: string[]; files: Array<VendoredFile & { content: string }> } {
  const manifest = readCorpusManifest(dir);
  const problems: string[] = [];
  const files: Array<VendoredFile & { content: string }> = [];
  for (const f of [...manifest.files, { path: 'LICENSE', stored_as: manifest.license_file.stored_as, sha256: manifest.license_file.sha256, bytes: -1 }]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, f.stored_as));
    } catch {
      problems.push(`${f.stored_as}: missing (manifest sha256 ${f.sha256})`);
      continue;
    }
    const got = sha256(bytes);
    if (got !== f.sha256) problems.push(`${f.stored_as}: sha256 ${got}, manifest says ${f.sha256}`);
    else if (f.path !== 'LICENSE') files.push({ ...f, content: bytes.toString('utf8') });
  }
  return { manifest, problems, files };
}

async function checkUpstream(): Promise<number> {
  const m = readCorpusManifest();
  const base = m.repository.replace('https://github.com/', 'https://raw.githubusercontent.com/');
  let bad = 0;
  for (const f of [...m.files, { path: 'LICENSE', sha256: m.license_file.sha256 }]) {
    const res = await fetch(`${base}/${m.commit}/${f.path}`);
    const got = sha256(Buffer.from(await res.arrayBuffer()));
    const ok = res.ok && got === f.sha256;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'DIFF'} ${f.path} ${got}${ok ? '' : ` (manifest ${f.sha256}, HTTP ${res.status})`}`);
  }
  return bad;
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    process.exit((await checkUpstream()) ? 1 : 0);
  } else {
    const { problems, manifest } = verifyVendoredCorpus();
    console.log(problems.length ? problems.join('\n') : `ok: ${manifest.files.length} files match ${manifest.repository}@${manifest.commit.slice(0, 12)}`);
    process.exit(problems.length ? 1 : 0);
  }
}
