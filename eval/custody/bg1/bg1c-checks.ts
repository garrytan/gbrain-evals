/**
 * BG1-C's three custody checks before its mint (docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md,
 * "The worlds" and run order steps 4 and 5), run on the custody host. phrasing and seed read BG1's seed and private
 * phrasing; controls reads only BG1's listed worlds. All three print counts, hashes and world or slot ids only: no world,
 * question, phrasing, seed or nonce text.
 *
 *   bun eval/custody/bg1/bg1c-checks.ts phrasing --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json
 *   bun eval/custody/bg1/bg1c-checks.ts seed --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json
 *       [--bg1-root <BG1's set root, default GBRAIN_EVALS_BG1_SOURCE>] [--bg1-manifest <BG1's filled manifest, default
 *       GBRAIN_EVALS_BG1_MANIFEST>]
 *   bun eval/custody/bg1/bg1c-checks.ts controls [--bg1-root <dir>] [--bg1-manifest <file>] (defaults as for seed)
 *
 * phrasing: the generator's phrasing check (loadPhrasing: keys, placeholders and the custody marker), then each BG1-C
 * slot's plan and questions, 31 to 96, from the seed and the phrasing, in memory. Nothing is written. It passes when
 * every slot plans.
 *
 * seed: BG1's seed stays fixed. For each of BG1's slots 1 to 30 whose questions.json BG1's filled manifest lists, it
 * re-derives that file from the seed and the phrasing and compares its SHA-256 with the manifest's, and it checks every
 * file the manifest lists against its bytes under BG1's set root. On a pass it prints, for launch amendment A, the
 * SHA-256 of the seed commitment, "gbrain-evals bg1-c seed commitment v1|<seed line>|nonce=<nonce>", and of the phrasing
 * file. The nonce is 32 random bytes in hex, kept beside the seed as <name>.bg1c-nonce (one line, mode 600): the first
 * pass writes it and every later pass reuses it, so the commitment never changes. It is never printed.
 *
 * controls: a descriptive count for launch amendment A, which has render.ts drop control characters other than newline
 * and tab before a world is written. Over the world.json files BG1's filled manifest lists, each read only when it
 * matches its SHA-256 there, it counts U+0000, the other control characters, the sessions and worlds holding any, and the
 * questions whose evidence sessions include one. It needs no seed or phrasing, changes nothing and gates nothing.
 *
 * phrasing and seed refuse (exit 2) a seed or phrasing file that is misnamed, not owner-only or inside a git checkout.
 * Exit 12: a slot does not plan, a re-derived or stored file does not match, or a file controls reads is missing,
 * changed or not readable JSON. Exit 1: an error, printed as its class and a hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildQuestions, PlanError, type QuestionRecord, type World } from '../../generators/changing-facts-gen.ts';
import { BG1_CONVERSATIONS, BG1C_FIRST_SLOT, BG1C_LAST_SLOT } from '../../runner/memory-qa/bg1-names.ts';
import { BG1_SET, type Bg1Manifest } from '../../runner/memory-qa/corpus.ts';
import { insideCheckout, ownerOnly, readPhrasing, readSeedLine, RenderRefusal, sealedPlan } from './render.ts';

export const COMMITMENT_PREFIX = 'gbrain-evals bg1-c seed commitment v1';
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

/** The seed and phrasing, each named, owner-only and outside any git checkout. */
function custodyInputs(argv: string[]) {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const seedFile = flag('--seed-file'), phrasingFile = flag('--phrasing');
  if (!seedFile || !phrasingFile) throw new RenderRefusal('usage: phrasing|seed --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json');
  for (const f of [seedFile, phrasingFile]) if (insideCheckout(dirname(resolve(f)))) throw new RenderRefusal('the seed and phrasing files must sit outside any git checkout');
  return { seedFile: resolve(seedFile), seedLine: readSeedLine(resolve(seedFile)), phrasingFile: resolve(phrasingFile), phrasing: readPhrasing(resolve(phrasingFile)), flag };
}

/** phrasing: plans every BG1-C slot with the custody phrasing, in memory. */
export function phrasingCheck(argv: string[]): { pass: boolean; line: string } {
  const { seedLine, phrasingFile, phrasing } = custodyInputs(argv);
  const failed: number[] = [];
  let questions = 0;
  for (let slot = BG1C_FIRST_SLOT; slot <= BG1C_LAST_SLOT; slot++) {
    try { questions += buildQuestions(sealedPlan(seedLine, slot, phrasing), phrasing).length; } catch (e) { if (!(e instanceof PlanError)) throw e; failed.push(slot); }
  }
  const slots = BG1C_LAST_SLOT - BG1C_FIRST_SLOT + 1;
  const failedSlots = failed.length ? ` failed_slots=${failed.join(',')}` : '';
  return { pass: failed.length === 0, line: `bg1c-phrasing slots=${slots} planned=${slots - failed.length} failed=${failed.length}${failedSlots} questions=${questions} status=${failed.length ? 'fail' : 'pass'} phrasing_sha256=${sha256(readFileSync(phrasingFile))}` };
}

/** The nonce beside the seed: reused when present (one line of 64 hex digits, owner-only), else written once. */
function custodyNonce(seedFile: string): { nonce: string; written: boolean } {
  const path = seedFile.replace(/\.bg1-seed$/, '.bg1c-nonce');
  if (existsSync(path)) {
    const nonce = readFileSync(path, 'utf8').trim();
    if (!ownerOnly(path) || !/^[0-9a-f]{64}$/.test(nonce)) throw new RenderRefusal('the nonce file beside the seed must be mode 600 or 400 and hold one line of 64 hex digits');
    return { nonce, written: false };
  }
  const nonce = randomBytes(32).toString('hex');
  writeFileSync(path, nonce + '\n', { mode: 0o600, flag: 'wx' });
  return { nonce, written: true };
}

/** BG1's set root and filled manifest, from --bg1-root and --bg1-manifest or BG1's two environment variables. */
function bg1Inputs(what: string, flag: (name: string) => string | undefined, env: Record<string, string | undefined>): { root: string; manifest: Bg1Manifest } {
  const root = flag('--bg1-root') ?? env[BG1_SET.env.source], manifestPath = flag('--bg1-manifest') ?? env[BG1_SET.env.manifest];
  if (!root || !manifestPath) throw new RenderRefusal(`${what} needs BG1's set root and filled manifest (--bg1-root and --bg1-manifest, or ${BG1_SET.env.source} and ${BG1_SET.env.manifest})`);
  if (!existsSync(resolve(manifestPath))) throw new RenderRefusal('BG1\'s filled manifest does not exist');
  let manifest: Bg1Manifest;
  try { manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as Bg1Manifest; } catch { throw new RenderRefusal('BG1\'s filled manifest is not readable JSON'); }
  if (manifest.dataset !== BG1_SET.dataset || manifest.status !== 'filled' || !Array.isArray(manifest.files) || !manifest.files.length) throw new RenderRefusal('the manifest is not BG1\'s filled manifest');
  return { root, manifest };
}

/** seed: BG1's questions re-derived from the seed and phrasing and its files checked against its filled manifest, then the commitment. */
export function seedCheck(argv: string[], env: Record<string, string | undefined> = process.env): { pass: boolean; line: string } {
  const { seedFile, seedLine, phrasingFile, phrasing, flag } = custodyInputs(argv);
  const { root, manifest } = bg1Inputs('seed', flag, env);
  const listed = new Map(manifest.files.map(f => [f.path, f.sha256]));
  const q = { listed: 0, match: 0, mismatch: 0 };
  BG1_CONVERSATIONS.forEach((id, i) => {
    const want = listed.get(`worlds/${id}/questions.json`);
    if (want === undefined) return;
    q.listed++;
    if (sha256(json(buildQuestions(sealedPlan(seedLine, i + 1, phrasing), phrasing))) === want) q.match++; else q.mismatch++;
  });
  const f = { listed: manifest.files.length, match: 0, missing: 0, mismatch: 0 };
  for (const file of manifest.files) {
    const path = join(resolve(root), file.path);
    if (!existsSync(path)) f.missing++;
    else if (sha256(readFileSync(path)) === file.sha256) f.match++;
    else f.mismatch++;
  }
  const pass = q.listed > 0 && q.match === q.listed && f.match === f.listed;
  const counts = `bg1c-seed slots=${BG1_CONVERSATIONS.length} questions_listed=${q.listed} questions_match=${q.match} questions_mismatch=${q.mismatch} files=${f.listed} files_match=${f.match} files_missing=${f.missing} files_mismatch=${f.mismatch}`;
  if (!pass) return { pass, line: `${counts} status=fail` };
  const { nonce, written } = custodyNonce(seedFile);
  const commitment = sha256(`${COMMITMENT_PREFIX}|${seedLine}|nonce=${nonce}`);
  return { pass, line: `${counts} status=pass nonce=${written ? 'written' : 'reused'} commitment_sha256=${commitment} phrasing_sha256=${sha256(readFileSync(phrasingFile))}` };
}

const CONTROL_CHARS = /[^\P{Cc}\t\n]/gu;

/** controls: U+0000 and the other control characters (not newline or tab) in BG1's listed worlds, counts only. */
export function controlsCheck(argv: string[], env: Record<string, string | undefined> = process.env): { pass: boolean; line: string } {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const { root, manifest } = bg1Inputs('controls', flag, env);
  const listed = new Map(manifest.files.map(f => [f.path, f.sha256]));
  const read = <T>(path: string): T | null => {
    const abs = join(resolve(root), path);
    if (!existsSync(abs)) return null;
    const bytes = readFileSync(abs);
    if (sha256(bytes) !== listed.get(path)) return null;
    try { return JSON.parse(bytes.toString('utf8')) as T; } catch { return null; }
  };
  const c = { worlds: 0, unreadable: 0, nul: 0, other: 0, sessions: 0, questions: 0 };
  const affected: string[] = [];
  for (const path of listed.keys()) {
    const id = /^worlds\/([^/]+)\/world\.json$/.exec(path)?.[1];
    if (!id) continue;
    c.worlds++;
    const world = read<World>(path);
    if (!Array.isArray(world?.sessions)) { c.unreadable++; continue; }
    const hit = new Set<string>();
    for (const s of world!.sessions) for (const t of s.turns) {
      const all = t.content.match(CONTROL_CHARS)?.length ?? 0, nul = t.content.split('\u0000').length - 1;
      c.nul += nul; c.other += all - nul;
      if (all) hit.add(s.id);
    }
    if (!hit.size) continue;
    affected.push(id);
    c.sessions += hit.size;
    const questions = read<QuestionRecord[]>(`worlds/${id}/questions.json`);
    if (!questions) { c.unreadable++; continue; }
    c.questions += questions.filter(q => q.evidence_sessions.some(e => hit.has(e))).length;
  }
  const pass = c.unreadable === 0;
  return { pass, line: `bg1c-controls worlds=${c.worlds} unreadable=${c.unreadable} nul=${c.nul} other=${c.other} sessions_affected=${c.sessions} worlds_affected=${affected.join(',') || 'none'} questions_citing=${c.questions} status=${pass ? 'pass' : 'fail'}` };
}

if (import.meta.main) {
  try {
    const [sub, ...argv] = process.argv.slice(2);
    if (sub !== 'phrasing' && sub !== 'seed' && sub !== 'controls') throw new RenderRefusal('usage: bg1c-checks.ts phrasing|seed --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json [seed: --bg1-root <dir> --bg1-manifest <file>], or controls [--bg1-root <dir> --bg1-manifest <file>]');
    const r = sub === 'phrasing' ? phrasingCheck(argv) : sub === 'seed' ? seedCheck(argv) : controlsCheck(argv);
    console.log(r.line);
    process.exit(r.pass ? 0 : 12);
  } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof RenderRefusal ? `bg1c-checks refused: ${e.message}\n` : `bg1c-checks error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(e instanceof RenderRefusal ? 2 : 1);
  }
}
