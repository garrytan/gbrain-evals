/**
 * RS1 manifest fill (GST-1886): writes the filled RS1 manifest on the custody host from the custody set root and the
 * custodian's kept list. Only conversation ids, file paths and SHA-256 hashes go into it; no RS1 byte is copied, and it
 * prints only counts and hashes.
 *
 *   bun eval/custody/rs1/fill-manifest.ts --root <out>/set --kept rs1-001,rs1-002,... --out <out>/set/rs1-manifest.json
 *       [--n-final <20 to 33>]
 *
 * The fill starts from the committed template (eval/decisions/datasets/rs1-manifest.json): `status: "filled"`,
 * `filled_at`, `kept` as given and `files` the chat and probing-questions file of every kept slot with its SHA-256
 * (rs1ManifestFiles). When --out already holds a filled manifest the fill is a refill: every earlier kept id stays in
 * place and in order and new ids only follow it, every earlier file keeps its hash, an n_final once set never changes,
 * and the earlier fill's SHA-256 is appended to `earlier_fills`.
 *
 * It refuses a root inside the checkout, an --out outside the root, a pinned file that is a link or resolves outside the
 * root, and any fill the beam-rs1 loader would refuse: it writes the candidate beside --out, checks it with rs1Kept,
 * loads the kept conversations through loadRs1 against it (each opening logged to GBRAIN_EVALS_CUSTODY_LOG), and only
 * then renames it into place.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DecideError } from '../../runner/decisions/errors.ts';
import { loadRs1, readRs1Manifest, RS1_MANIFEST, rs1Kept, rs1ManifestFiles, rs1Source, type Rs1Manifest } from '../../runner/memory-qa/corpus.ts';

export class FillError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };

export interface FillResult { manifest_sha256: string; files: number; kept: number; first: string; last: string; n_final: number | null; earlier_fills: number }

export function fillManifest(opts: { root: string; kept: string[]; out: string; nFinal?: number; log: string; now?: Date }): FillResult {
  const root = rs1Source({ GBRAIN_EVALS_RS1_SOURCE: opts.root });
  const out = resolve(opts.out);
  if (!inside(out, root)) throw new FillError('--out must sit inside --root, where the custody push and the loader find the manifest beside the files it pins');
  const realRoot = realpathSync(root);
  let earlier: { manifest: Rs1Manifest; sha256: string } | null = null;
  if (existsSync(out)) {
    if (lstatSync(out).isSymbolicLink()) throw new FillError('--out is a link');
    const read = readRs1Manifest(out);
    if (read.manifest.status === 'filled') earlier = read;
  }
  const kept = opts.kept;
  if (!kept.length) throw new FillError('--kept names no conversation');
  if (earlier) {
    const before = earlier.manifest.kept ?? [];
    if (kept.length < before.length || before.some((id, i) => kept[i] !== id)) throw new FillError(`the kept list is append-only: the earlier fill keeps ${before.length} conversation(s), and the new list does not start with them in the same order`);
  }
  const files = rs1ManifestFiles(root, kept);
  for (const f of files) {
    const abs = join(root, f.path);
    if (lstatSync(abs).isSymbolicLink() || !inside(realpathSync(abs), realRoot)) throw new FillError(`${f.path} is a link or resolves outside --root; a filled manifest pins only files inside the custody root`);
  }
  if (earlier) {
    const now = new Map(files.map(f => [f.path, f.sha256]));
    const changed = earlier.manifest.files.filter(f => now.get(f.path) !== f.sha256);
    if (changed.length) throw new FillError(`a refill only adds files: ${changed.length} file(s) the earlier fill pins are missing or changed (first ${changed[0].path})`);
  }
  const nFinal = opts.nFinal ?? earlier?.manifest.n_final;
  if (earlier?.manifest.n_final !== undefined && nFinal !== earlier.manifest.n_final) throw new FillError(`n_final is ${earlier.manifest.n_final} in the earlier fill and never changes`);
  const template = JSON.parse(readFileSync(join(REPO_ROOT, RS1_MANIFEST), 'utf8')) as Rs1Manifest;
  const manifest: Rs1Manifest = { ...template, status: 'filled', files, filled_at: (opts.now ?? new Date()).toISOString(), kept: [...kept],
    ...(nFinal !== undefined ? { n_final: nFinal } : {}), ...(earlier ? { earlier_fills: [...(earlier.manifest.earlier_fills ?? []), earlier.sha256] } : {}) };
  rs1Kept(manifest);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const candidate = `${out}.candidate`;
  writeFileSync(candidate, text, { mode: 0o600 });
  try {
    loadRs1({ log: opts.log, decisionId: process.env.GBRAIN_EVALS_DECISION_ID ?? 'q1-scoreboard', purpose: 'rs1 fill-manifest check' }, { only: new Set(kept), root, manifestPath: candidate });
    renameSync(candidate, out);
  } finally {
    rmSync(candidate, { force: true });
  }
  return { manifest_sha256: sha256(text), files: files.length, kept: kept.length, first: kept[0], last: kept.at(-1)!, n_final: nFinal ?? null, earlier_fills: manifest.earlier_fills?.length ?? 0 };
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = flag('--root'), keptArg = flag('--kept'), out = flag('--out'), nFinalArg = flag('--n-final');
  if (!root || !keptArg || !out) throw new FillError('usage: --root <set root> --kept rs1-NNN,... --out <manifest inside the root> [--n-final <n>]');
  const nFinal = nFinalArg === undefined ? undefined : Number(nFinalArg);
  if (nFinal !== undefined && !Number.isInteger(nFinal)) throw new FillError('--n-final must be a whole number');
  const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
  if (!log) throw new FillError('GBRAIN_EVALS_CUSTODY_LOG is not set; the check opens each kept conversation and logs it first');
  const r = fillManifest({ root, kept: keptArg.split(',').map(s => s.trim()).filter(Boolean), out, nFinal, log });
  console.log(`rs1-fill status=filled files=${r.files} kept=${r.kept} first=${r.first} last=${r.last} n_final=${r.n_final ?? 'absent'} earlier_fills=${r.earlier_fills} manifest_sha256=${r.manifest_sha256}`);
  return 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof FillError ? `rs1-fill refused: ${e.message}\n` : e instanceof DecideError ? `rs1-fill refused: ${e.op.code} ${e.op.message}\n` : `rs1-fill error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(2);
  }
}
