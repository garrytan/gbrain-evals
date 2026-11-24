/**
 * Set W's custody checks (the weekly outcome line; docs/benchmarks/2026-11-23-weekly-outcome-line-preregistration.md,
 * "The worlds" and "Custody and exposure"), run on the custody host. phrasing and seed read Set W's seed and private
 * phrasing, and seed also BG1's; batch reads only committed files and a previous batch's custody records. All three print
 * counts, hashes and world or slot ids only: no world, question, phrasing, seed or nonce text.
 *
 *   bun eval/custody/bg1/bgw-checks.ts phrasing --seed-file <path>.bgw-seed --phrasing <path>.bgw-phrasing.json
 *       [--batch <first slot>, default 1001]
 *   bun eval/custody/bg1/bgw-checks.ts seed --seed-file <path>.bgw-seed --phrasing <path>.bgw-phrasing.json
 *       --bg1-seed-file <path>.bg1-seed --bg1-phrasing <path>.bg1-phrasing.json
 *   bun eval/custody/bg1/bgw-checks.ts batch --batch <first slot> [--previous <the previous batch's mint.sh --bgw --out>]
 *   bun eval/custody/bg1/bgw-checks.ts length --batch <first slot>
 *
 * length prints the batch's world length in cl100k tokens and nothing else: its seed set's profile's target
 * (changing-facts-gen.ts BG1_PROFILES), 200000 for W1 and 1000000 for W1-long. mint.sh --bgw renders and validates to it
 * unless --target-tokens is given, and a real mint refuses any other.
 *
 * phrasing: the generator's phrasing check (loadPhrasing: keys, placeholders and the custody marker), then each slot of
 * the batch, its plan and questions from Set W's seed and the phrasing, in memory. Nothing is written. It passes when every
 * slot plans.
 *
 * seed: the line uses a seed and phrasing set of its own. It fails when Set W's seed holds BG1's 64 hex digits, when any
 * slot of a seed set that plans from W1's seed line (W1: 1001 to 1999; W1-long: 2001 to 2999) gets a world seed
 * (bgwWorldSeed) equal to the one BG1's seed gives that slot (sealedWorldSeed), or when the phrasing set shares any template with BG1's private phrasing. On a pass it prints,
 * for launch amendment A, the SHA-256 of the seed commitment, "gbrain-evals weekly-line seed commitment v1|<seed
 * line>|nonce=<nonce>", and of the phrasing file. The nonce is 32 random bytes in hex, kept beside the seed as
 * <name>.bgw-nonce (one line, mode 600): the first pass writes it and every later pass reuses it, so the commitment never
 * changes. It is never printed, and a failed check writes none. The first pass also records both SHA-256 values in
 * <name>.bgw-commitment.json (commitment.ts), which a real mint.sh --bgw checks before it spends, and a pass that would
 * record other values refuses.
 *
 * batch: whether a batch may mint (mint.sh --bgw runs it first). The batch must start on a slot of a seed set and fit
 * inside it; its manifest template and its slots in the split file must be committed (bgwCommittedProblems); and it must
 * start where the batch before it ended. The first batch of a seed set (1001 for W1) has no previous batch and takes no
 * --previous. Any other needs --previous, the previous batch's custody --out, whose batch.json names a batch of the same
 * seed set; that batch must be finished, its last slot the one where its 34th world passed validation or, short of 34,
 * its last slot with every slot resolved (a validation record or a dropped render record), and this batch must start on
 * the next slot.
 *
 * phrasing and seed refuse (exit 2) a seed or phrasing file that is misnamed, not owner-only or inside a git checkout;
 * batch refuses (exit 2) a batch that may not mint. Exit 12: a slot does not plan, or a seed or phrasing is BG1's. Exit 1:
 * an error, printed as its class and a hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BG1_PROFILES, buildQuestions, bgwWorldSeed, PlanError, sealedWorldSeed, type Phrasing } from '../../generators/changing-facts-gen.ts';
import { BGW_BATCH_KEPT, BGW_FIRST_SLOT, BGW_SEED_SETS, bgwBatchIds, bgwBatchSlots, bgwSeedSetOf, bgwSlotOf } from '../../runner/memory-qa/bg1-names.ts';
import { bgwCommittedProblems } from '../../runner/memory-qa/corpus.ts';
import { COMMITMENT_PREFIXES, recordCommitment } from './commitment.ts';
import { insideCheckout, ownerOnly, readPhrasing, readSeedLine, RenderRefusal, sealedPlan } from './render.ts';

export const COMMITMENT_PREFIX = COMMITMENT_PREFIXES.bgw;
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const flagOf = (argv: string[]) => (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** A batch's first slot from --batch (four digits), refusing one that does not start a batch inside a seed set. */
function batchArg(raw: string | undefined): number {
  if (!raw || !/^\d{4}$/.test(raw)) throw new RenderRefusal('--batch takes the four-digit first slot of the batch (1001 for the first)');
  try { bgwBatchSlots(Number(raw)); } catch (e) { throw new RenderRefusal((e as Error).message); }
  return Number(raw);
}

/** Set W's seed and phrasing, each named, owner-only and outside any git checkout. */
function custodyInputs(argv: string[]) {
  const flag = flagOf(argv);
  const seedFile = flag('--seed-file'), phrasingFile = flag('--phrasing');
  if (!seedFile || !phrasingFile) throw new RenderRefusal('usage: phrasing|seed --seed-file <path>.bgw-seed --phrasing <path>.bgw-phrasing.json');
  for (const f of [seedFile, phrasingFile]) if (insideCheckout(dirname(resolve(f)))) throw new RenderRefusal('the seed and phrasing files must sit outside any git checkout');
  return { seedFile: resolve(seedFile), seedLine: readSeedLine(resolve(seedFile), 'bgw'), phrasingFile: resolve(phrasingFile), phrasing: readPhrasing(resolve(phrasingFile), 'bgw'), flag };
}

/** phrasing: plans every slot of the batch with Set W's seed and phrasing, in memory. */
export function phrasingCheck(argv: string[]): { pass: boolean; line: string } {
  const { seedLine, phrasingFile, phrasing, flag } = custodyInputs(argv);
  const batch = flag('--batch') === undefined ? BGW_FIRST_SLOT : batchArg(flag('--batch'));
  const slots = bgwBatchSlots(batch), failed: number[] = [];
  let questions = 0;
  for (const slot of slots) {
    try { questions += buildQuestions(sealedPlan(seedLine, slot, phrasing, 'bgw'), phrasing).length; } catch (e) { if (!(e instanceof PlanError)) throw e; failed.push(slot); }
  }
  const failedSlots = failed.length ? ` failed_slots=${failed.join(',')}` : '';
  return { pass: failed.length === 0, line: `bgw-phrasing batch=bgw-${batch} slots=${slots.length} planned=${slots.length - failed.length} failed=${failed.length}${failedSlots} questions=${questions} status=${failed.length ? 'fail' : 'pass'} phrasing_sha256=${sha256(readFileSync(phrasingFile))}` };
}

/** Every template string of a phrasing set (frames and kinds, the custody marker left out). */
function templates(p: Phrasing): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => { if (typeof v === 'string') out.add(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(p.frames);
  walk(p.kinds);
  return out;
}

/** The nonce beside the seed: reused when present (one line of 64 hex digits, owner-only), else written once. */
function custodyNonce(seedFile: string): { nonce: string; written: boolean } {
  const path = seedFile.replace(/\.bgw-seed$/, '.bgw-nonce');
  if (existsSync(path)) {
    const nonce = readFileSync(path, 'utf8').trim();
    if (!ownerOnly(path) || !/^[0-9a-f]{64}$/.test(nonce)) throw new RenderRefusal('the nonce file beside the seed must be mode 600 or 400 and hold one line of 64 hex digits');
    return { nonce, written: false };
  }
  const nonce = randomBytes(32).toString('hex');
  writeFileSync(path, nonce + '\n', { mode: 0o600, flag: 'wx' });
  return { nonce, written: true };
}

/** seed: Set W's seed and phrasing checked apart from BG1's, then the commitment. */
export function seedCheck(argv: string[]): { pass: boolean; line: string } {
  const { seedFile, seedLine, phrasingFile, phrasing, flag } = custodyInputs(argv);
  const bg1Seed = flag('--bg1-seed-file'), bg1Phrasing = flag('--bg1-phrasing');
  if (!bg1Seed || !bg1Phrasing) throw new RenderRefusal('seed needs BG1\'s seed and private phrasing (--bg1-seed-file and --bg1-phrasing) to check that Set W uses neither');
  for (const f of [bg1Seed, bg1Phrasing]) if (insideCheckout(dirname(resolve(f)))) throw new RenderRefusal('BG1\'s seed and phrasing files must sit outside any git checkout');
  const bg1Line = readSeedLine(resolve(bg1Seed), 'bg1'), bg1Templates = templates(readPhrasing(resolve(bg1Phrasing), 'bg1'));
  const set = bgwSeedSetOf(BGW_FIRST_SLOT)!, planned = BGW_SEED_SETS.filter(s => s.seed === set.id);
  const hexDistinct = seedLine.split(':')[1] !== bg1Line.split(':')[1];
  let collisions = 0, slots = 0;
  for (const s of planned) for (let slot = s.first; slot <= s.last; slot++, slots++) if (bgwWorldSeed(seedLine, slot) === sealedWorldSeed(bg1Line, slot)) collisions++;
  const shared = [...templates(phrasing)].filter(t => bg1Templates.has(t)).length;
  const pass = hexDistinct && collisions === 0 && shared === 0;
  const counts = `bgw-seed set=${set.id} seed_sets=${planned.map(s => s.id).join(',')} slots=${slots} seed_distinct=${hexDistinct ? 'pass' : 'fail'} slot_seed_collisions=${collisions} shared_templates=${shared}`;
  if (!pass) return { pass, line: `${counts} status=fail` };
  const { nonce, written } = custodyNonce(seedFile);
  const commitment = sha256(`${COMMITMENT_PREFIX}|${seedLine}|nonce=${nonce}`), phrasingSha = sha256(readFileSync(phrasingFile));
  recordCommitment(seedFile, 'bgw', commitment, phrasingSha);
  return { pass, line: `${counts} status=pass nonce=${written ? 'written' : 'reused'} commitment_sha256=${commitment} phrasing_sha256=${phrasingSha}` };
}

/** A render record's status, or undefined when the file is missing or not JSON. */
function recordStatus(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try { return (JSON.parse(readFileSync(path, 'utf8')) as { status?: string }).status; } catch { return undefined; }
}

/**
 * The last slot of a finished batch from its custody --out's records: the slot where its 34th world passed validation,
 * or, short of 34, its last slot once every slot is resolved. Null while the batch is unfinished.
 */
export function bgwBatchEnd(out: string, first: number): number | null {
  const ids = bgwBatchIds(first);
  let kept = 0;
  for (const [i, id] of ids.entries()) {
    const validation = recordStatus(join(out, 'render', `${id}.validation.json`)), render = recordStatus(join(out, 'render', `${id}.json`));
    if (validation === 'pass' && ++kept === BGW_BATCH_KEPT) return first + i;
    if (validation === undefined && render !== 'dropped') return null;
  }
  return first + ids.length - 1;
}

/** batch: may this batch mint? `repo` is the checkout whose committed template and split file count. */
export function batchCheck(argv: string[], repo?: string): { pass: boolean; line: string } {
  const flag = flagOf(argv);
  const batch = batchArg(flag('--batch')), previous = flag('--previous');
  const slots = bgwBatchSlots(batch), set = bgwSeedSetOf(batch)!;
  const problems = bgwCommittedProblems(batch, repo, { head: true });
  if (problems.length) throw new RenderRefusal(`batch bgw-${batch} is not committed: ${problems.join('; ')}; its batch pull request commits both before it mints`);
  const head = `bgw-batch batch=bgw-${batch} set=${set.id} slots=${slots[0]}-${slots.at(-1)}`;
  if (batch === set.first) {
    if (previous !== undefined) throw new RenderRefusal(`bgw-${batch} is seed set ${set.id}'s first batch, so it has no previous batch and takes no --previous`);
    return { pass: true, line: `${head} previous=none status=pass` };
  }
  if (previous === undefined) throw new RenderRefusal(`bgw-${batch} is not seed set ${set.id}'s first batch, so it needs --previous, the previous batch's custody --out, to check that it starts where that batch ended`);
  let prev: { set?: unknown; batch?: unknown } = {};
  try { prev = JSON.parse(readFileSync(join(resolve(previous), 'batch.json'), 'utf8')) as typeof prev; } catch { throw new RenderRefusal('--previous holds no readable batch.json, so it is not a Set W batch\'s custody --out'); }
  const prevFirst = typeof prev.batch === 'string' ? bgwSlotOf(prev.batch) : null;
  if (prevFirst === null || prev.set !== set.id || prevFirst >= batch) throw new RenderRefusal(`--previous is not an earlier batch of seed set ${set.id}`);
  const end = bgwBatchEnd(resolve(previous), prevFirst);
  if (end === null) throw new RenderRefusal(`the previous batch bgw-${prevFirst} is not finished: it has fewer than ${BGW_BATCH_KEPT} worlds that passed validation and a slot that is not resolved`);
  if (batch !== end + 1) throw new RenderRefusal(`the previous batch bgw-${prevFirst} ended at slot ${end}, so the next batch is bgw-${end + 1}, not bgw-${batch}`);
  return { pass: true, line: `${head} previous=bgw-${prevFirst} previous_last=${end} status=pass` };
}

if (import.meta.main) {
  try {
    const [sub, ...argv] = process.argv.slice(2);
    if (sub === 'length') { console.log(String(BG1_PROFILES[bgwSeedSetOf(batchArg(argv[argv.indexOf('--batch') + 1]))!.profile].target_tokens)); process.exit(0); }
    if (sub !== 'phrasing' && sub !== 'seed' && sub !== 'batch') throw new RenderRefusal('usage: bgw-checks.ts phrasing|seed --seed-file <path>.bgw-seed --phrasing <path>.bgw-phrasing.json [phrasing: --batch <first slot>; seed: --bg1-seed-file <path>.bg1-seed --bg1-phrasing <path>.bg1-phrasing.json], or batch --batch <first slot> [--previous <out>]');
    const r = sub === 'phrasing' ? phrasingCheck(argv) : sub === 'seed' ? seedCheck(argv) : batchCheck(argv);
    console.log(r.line);
    process.exit(r.pass ? 0 : 12);
  } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof RenderRefusal ? `bgw-checks refused: ${e.message}\n` : `bgw-checks error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(e instanceof RenderRefusal ? 2 : 1);
  }
}
