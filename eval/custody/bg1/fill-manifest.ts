/**
 * BG1 manifest fill (GST-2010), run in custody after eval/custody/bg1/validate.ts. It is keyless and reads only the set
 * root and the validation report: it pins world.json and questions.json of every world the report keeps, with their
 * SHA-256 (bg1ManifestFiles), and writes the filled manifest to <root>/bg1-manifest.json, beside the files it pins, where
 * the custody host and each cell VM point GBRAIN_EVALS_BG1_MANIFEST. The committed manifest
 * (eval/decisions/datasets/bg1-manifest.json) is only its template and stays unfilled. It prints counts and hashes only.
 *
 *   bun eval/custody/bg1/fill-manifest.ts --root <out>/set --report <validation report> [--target-tokens 200000]
 *       [--tolerance 0.15]
 *
 * It refuses, before it writes anything:
 *   - a report that is not a bg1-validation/v1 report, or that validate.ts ran with another target or tolerance than
 *     the ones given (by default the preregistered 200,000 tokens and 15%);
 *   - a kept list that is not the report's first passing worlds in slot order (the first n_final of them when the report
 *     sets n_final), or that passes over a slot the report does not account for;
 *   - a kept list that is too short: fewer than wave A's BG1_WAVE_A (12) worlds without n_final, fewer than n_final with
 *     it, and more than BG1_N_CAP (40) either way; n_final itself must be 30 to 40;
 *   - any file of a kept world (plan.json, questions.json and world.json) whose SHA-256 differs from the one the report
 *     records, so the manifest pins exactly the bytes validate.ts passed;
 *   - a root inside the checkout, a manifest path or pinned file that is a link, and a pinned file that resolves outside
 *     the root.
 * When <root>/bg1-manifest.json already holds a filled manifest the fill is a refill: the earlier kept list must start
 * the new one in the same order, every file the earlier fill pins keeps its hash, an n_final once set never changes, and
 * the earlier fill's SHA-256 is appended to `earlier_fills`. The new manifest is written beside the old one and renamed
 * into place.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { BG1_TARGET_TOKENS } from '../../generators/changing-facts-gen.ts';
import { BG1_CONVERSATIONS, BG1_N_CAP, BG1_N_FLOOR, BG1_WAVE_A } from '../../runner/bg1/types.ts';
import { DecideError } from '../../runner/decisions/errors.ts';
import { BG1_MANIFEST, bg1Kept, bg1ManifestFiles, bg1Source, readBg1Manifest, type Bg1Manifest } from '../../runner/memory-qa/corpus.ts';
import { VALIDATION_SCHEMA, WORLD_FILES, type ValidationReport } from './validate.ts';

export class FillError extends Error {}

export const FILLED_MANIFEST = 'bg1-manifest.json';
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };

export interface FillResult { manifest_sha256: string; files: number; kept: number; first: string; last: string; n_final: number | null; earlier_fills: number }

export function fillManifest(opts: { root: string; report: string; targetTokens?: number; tolerance?: number; now?: Date }): FillResult {
  const root = bg1Source({ GBRAIN_EVALS_BG1_SOURCE: opts.root });
  const realRoot = realpathSync(root);
  const out = join(root, FILLED_MANIFEST);
  let report: ValidationReport;
  try { report = JSON.parse(readFileSync(resolve(opts.report), 'utf8')) as ValidationReport; } catch { throw new FillError('--report is not a readable JSON file'); }
  if (report?.schema !== VALIDATION_SCHEMA || !Array.isArray(report.worlds) || !Array.isArray(report.kept)) throw new FillError(`--report is not a ${VALIDATION_SCHEMA} report`);
  const targetTokens = opts.targetTokens ?? BG1_TARGET_TOKENS, tolerance = opts.tolerance ?? 0.15;
  if (report.target_tokens !== targetTokens || report.tolerance !== tolerance) throw new FillError(`the report was validated at ${report.target_tokens} tokens within ${report.tolerance}, not ${targetTokens} within ${tolerance}`);

  const kept = report.kept, nFinal = report.n_final ?? null;
  const passing = report.worlds.filter(w => w.status === 'pass').map(w => w.id);
  if (JSON.stringify(kept) !== JSON.stringify(nFinal === null ? passing : passing.slice(0, nFinal))) throw new FillError('the kept list is not the report\'s first passing worlds in slot order');
  if (nFinal !== null && !(Number.isInteger(nFinal) && nFinal >= BG1_N_FLOOR && nFinal <= BG1_N_CAP)) throw new FillError(`the report's n_final ${nFinal} is not a whole number from ${BG1_N_FLOOR} to ${BG1_N_CAP}`);
  if (kept.length < (nFinal ?? BG1_WAVE_A)) throw new FillError(`the kept list is too short: the report keeps ${kept.length} world(s), and ${nFinal === null ? `a fill without n_final needs wave A's ${BG1_WAVE_A}` : `its n_final needs ${nFinal}`}`);
  if (kept.length > BG1_N_CAP) throw new FillError(`the report keeps ${kept.length} worlds, more than the ${BG1_N_CAP} a kept set holds`);
  const listed = new Set(report.worlds.map(w => w.id));
  const skipped = BG1_CONVERSATIONS.slice(0, BG1_CONVERSATIONS.indexOf(kept.at(-1)!) + 1).filter(id => !listed.has(id));
  if (skipped.length) throw new FillError(`the report does not account for ${skipped.join(', ')}, below the last kept world, so the kept list may not be the first passing slots`);

  const byId = new Map(report.worlds.map(w => [w.id, w]));
  const mismatched: string[] = [];
  for (const id of kept) for (const f of WORLD_FILES) {
    const path = `worlds/${id}/${f}`, abs = join(root, path);
    if (!existsSync(abs) || sha256(readFileSync(abs)) !== byId.get(id)?.files_sha256?.[f]) { mismatched.push(path); continue; }
    if (lstatSync(abs).isSymbolicLink() || !inside(realpathSync(abs), realRoot)) throw new FillError(`${path} is a link or resolves outside --root; a filled manifest pins only files inside the custody root`);
  }
  if (mismatched.length) throw new FillError(`${mismatched.length} file(s) of kept worlds are missing or differ from the report's SHA-256 (first ${mismatched[0]}); validate the set again`);
  const files = bg1ManifestFiles(root, kept);

  let earlier: { manifest: Bg1Manifest; sha256: string } | null = null;
  if (existsSync(out)) {
    if (lstatSync(out).isSymbolicLink()) throw new FillError(`<root>/${FILLED_MANIFEST} is a link`);
    const read = readBg1Manifest(out);
    if (read.manifest.status === 'filled') earlier = read;
  }
  if (earlier) {
    const before = earlier.manifest.kept ?? [];
    if (before.some((id, i) => kept[i] !== id)) throw new FillError(`a refill only adds worlds: the earlier fill keeps ${before.length} world(s), and the new kept list does not start with them in the same order`);
    const now = new Map(files.map(f => [f.path, f.sha256]));
    const changed = earlier.manifest.files.filter(f => now.get(f.path) !== f.sha256);
    if (changed.length) throw new FillError(`a refill only adds files: ${changed.length} file(s) the earlier fill pins are missing or changed (first ${changed[0].path})`);
    if (earlier.manifest.n_final !== undefined && earlier.manifest.n_final !== nFinal) throw new FillError(`n_final is ${earlier.manifest.n_final} in the earlier fill and never changes`);
  }
  const template = JSON.parse(readFileSync(join(REPO_ROOT, BG1_MANIFEST), 'utf8')) as Bg1Manifest;
  if (template.status !== 'unfilled') throw new FillError(`${BG1_MANIFEST} is the template and must stay unfilled`);
  const manifest: Bg1Manifest = { ...template, status: 'filled', files, filled_at: (opts.now ?? new Date()).toISOString(), kept: [...kept],
    ...(nFinal !== null ? { n_final: nFinal } : {}), ...(earlier ? { earlier_fills: [...(earlier.manifest.earlier_fills ?? []), earlier.sha256] } : {}) };
  bg1Kept(manifest);
  const text = JSON.stringify(manifest, null, 1) + '\n';
  const candidate = `${out}.candidate`;
  rmSync(candidate, { force: true });
  writeFileSync(candidate, text, { mode: 0o600 });
  renameSync(candidate, out);
  return { manifest_sha256: sha256(text), files: files.length, kept: kept.length, first: kept[0], last: kept.at(-1)!, n_final: nFinal, earlier_fills: manifest.earlier_fills?.length ?? 0 };
}

export function main(argv: string[]): string {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const root = flag('--root'), report = flag('--report'), target = flag('--target-tokens'), tolerance = flag('--tolerance');
  if (!root || !report) throw new FillError('usage: --root <out>/set --report <validation report> [--target-tokens <n>] [--tolerance <x>]');
  const r = fillManifest({ root, report, targetTokens: target === undefined ? undefined : Number(target), tolerance: tolerance === undefined ? undefined : Number(tolerance) });
  return `bg1-fill status=filled files=${r.files} kept=${r.kept} first=${r.first} last=${r.last} n_final=${r.n_final ?? 'absent'} earlier_fills=${r.earlier_fills} manifest_sha256=${r.manifest_sha256}`;
}

if (import.meta.main) {
  try { console.log(main(process.argv.slice(2))); process.exit(0); } catch (error) {
    const e = error as Error;
    if (e instanceof FillError || e instanceof DecideError) {
      process.stderr.write(`bg1-fill refused: ${e instanceof DecideError ? `${e.op.code} ${e.op.message}` : e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`bg1-fill error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(1);
  }
}
