/**
 * The seed commitment file a sealed set's real mint checks (BG1-C and Set W; launch amendment A of each preregistration).
 * bg1c-checks.ts seed and bgw-checks.ts seed write it on their first pass, beside the seed as <name>.bg1c-commitment.json
 * or <name>.bgw-commitment.json (one JSON line, mode 600): the commitment and phrasing SHA-256 they print for the
 * amendment. A later pass that would record other values refuses, so the file keeps what was published.
 *
 *   bun eval/custody/bg1/commitment.ts (--bg1c | --bgw) --seed-file <path> --phrasing <path>
 *
 * mint.sh --bg1c and --bgw run this check in real mode before anything else that spends: the seed line and the nonce
 * beside it must re-derive the recorded commitment, and the phrasing file must hash to the recorded phrasing SHA-256.
 * It prints one counts-and-hashes line and exits 0; a missing, unreadable or mismatched file refuses (exit 2), so a mint
 * never renders from a seed or phrasing other than the ones the amendment published. It prints no seed or nonce text.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ownerOnly, readPhrasing, readSeedLine, RenderRefusal, type SealedKind } from './render.ts';

export type CommittedSet = 'bg1c' | 'bgw';
const SPEC: Record<CommittedSet, { prefix: string; kind: SealedKind; seed: string; nonce: string; file: string }> = {
  bg1c: { prefix: 'gbrain-evals bg1-c seed commitment v1', kind: 'bg1', seed: '.bg1-seed', nonce: '.bg1c-nonce', file: '.bg1c-commitment.json' },
  bgw: { prefix: 'gbrain-evals weekly-line seed commitment v1', kind: 'bgw', seed: '.bgw-seed', nonce: '.bgw-nonce', file: '.bgw-commitment.json' },
};
export const COMMITMENT_PREFIXES = { bg1c: SPEC.bg1c.prefix, bgw: SPEC.bgw.prefix } as const;
export const COMMITMENT_SCHEMA = 'gbrain-evals/seed-commitment/v1';
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const sibling = (seedFile: string, set: CommittedSet, ext: string) => seedFile.slice(0, -SPEC[set].seed.length) + ext;

/** The commitment file beside a seed file. */
export const commitmentFile = (seedFile: string, set: CommittedSet) => sibling(resolve(seedFile), set, SPEC[set].file);

/** The commitment from a seed line and its nonce, in the preregistration's form. */
export const commitmentOf = (set: CommittedSet, seedLine: string, nonce: string) => sha256(`${SPEC[set].prefix}|${seedLine}|nonce=${nonce}`);

/** Records a passing seed check's commitment and phrasing SHA-256 once; a file that records other values refuses. */
export function recordCommitment(seedFile: string, set: CommittedSet, commitment: string, phrasingSha: string): void {
  const path = commitmentFile(seedFile, set);
  const text = JSON.stringify({ schema: COMMITMENT_SCHEMA, set, commitment_sha256: commitment, phrasing_sha256: phrasingSha }) + '\n';
  if (!existsSync(path)) { writeFileSync(path, text, { mode: 0o600, flag: 'wx' }); return; }
  if (readFileSync(path, 'utf8') !== text) throw new RenderRefusal('the commitment file beside the seed records another commitment or phrasing SHA-256, and a published commitment never changes');
}

/** The mint's check: the seed, its nonce and the phrasing file re-derive the recorded commitment and phrasing SHA-256. */
export function checkCommitment(set: CommittedSet, seedFile: string, phrasingFile: string): string {
  const seedLine = readSeedLine(resolve(seedFile), SPEC[set].kind);
  readPhrasing(resolve(phrasingFile), SPEC[set].kind);
  const path = commitmentFile(seedFile, set), noncePath = sibling(resolve(seedFile), set, SPEC[set].nonce);
  if (!existsSync(path)) throw new RenderRefusal(`there is no commitment file beside the seed (${SPEC[set].file}); run the seed check, which writes it, and publish its commitment before a real mint`);
  if (!ownerOnly(path)) throw new RenderRefusal('the commitment file beside the seed must be mode 600 or 400');
  let rec: { schema?: unknown; set?: unknown; commitment_sha256?: unknown; phrasing_sha256?: unknown } = {};
  try { rec = JSON.parse(readFileSync(path, 'utf8')) as typeof rec; } catch { throw new RenderRefusal('the commitment file beside the seed is not readable JSON'); }
  if (rec.schema !== COMMITMENT_SCHEMA || rec.set !== set || typeof rec.commitment_sha256 !== 'string' || typeof rec.phrasing_sha256 !== 'string') throw new RenderRefusal(`the commitment file beside the seed is not a ${set} seed commitment`);
  if (!existsSync(noncePath) || !ownerOnly(noncePath)) throw new RenderRefusal('the nonce file beside the seed is missing or not mode 600 or 400');
  const nonce = readFileSync(noncePath, 'utf8').trim();
  if (commitmentOf(set, seedLine, nonce) !== rec.commitment_sha256) throw new RenderRefusal('the seed and its nonce do not re-derive the recorded commitment, so this is not the published seed');
  const phrasingSha = sha256(readFileSync(resolve(phrasingFile)));
  if (phrasingSha !== rec.phrasing_sha256) throw new RenderRefusal('the phrasing file does not hash to the recorded phrasing SHA-256, so this is not the published phrasing');
  return `bg1-commitment set=${set} status=pass commitment_sha256=${rec.commitment_sha256} phrasing_sha256=${phrasingSha}`;
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const sets = (['bg1c', 'bgw'] as const).filter(s => argv.includes(`--${s}`));
    const seedFile = flag('--seed-file'), phrasingFile = flag('--phrasing');
    if (sets.length !== 1 || !seedFile || !phrasingFile) throw new RenderRefusal('usage: (--bg1c | --bgw) --seed-file <path> --phrasing <path>');
    console.log(checkCommitment(sets[0], seedFile, phrasingFile));
    process.exit(0);
  } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof RenderRefusal ? `bg1-commitment refused: ${e.message}\n` : `bg1-commitment error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(e instanceof RenderRefusal ? 2 : 1);
  }
}
