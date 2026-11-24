/**
 * BG1-C's custody supply check (R111; docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md, "A
 * pilot for every row", condition 3): once mint.sh --bg1c has resolved slots 31 to 35, it counts the Gemini requests
 * their metering proxies sent upstream (<out>/proxy/requests/bg1-0NN-gemini.jsonl, every line the proxy did not refuse)
 * and the worlds among them that passed validation (<out>/render/bg1-0NN.validation.json). It passes when the requests
 * per kept world are at most 1.5 times the dev mint's 336 per world (5,714 requests for 17 worlds), 504; five slots with
 * no kept world fail. It writes <out>/render/supply.json and prints one counts-only line.
 *
 *   bun eval/custody/bg1/supply.ts --out <dir>/bg1-custody...
 *   bun eval/custody/bg1/supply.ts --bgw --batch <first slot> --out <dir>/bgw-custody...
 *
 * --bgw runs the same check on a Set W batch's first five slots (mint.sh --bgw, once per batch, each batch in a custody
 * --out of its own), against the limit of the batch's seed set (SUPPLY_BASELINES). W1's is BG1-C's: its worlds are
 * BG1-C's length and its mint follows BG1-C's validation and drop rules, so the per-kept-world number holds for each
 * month's batch. W1-long's worlds are about five times longer, and no mint has measured their requests yet, so its
 * baseline is unrecorded: the check writes what the first five slots measured with status unmeasured and pauses the mint
 * there, as an over-limit check does, until a limit measured from those slots is recorded here or GBEV-3 acknowledges.
 *
 * Exit codes: 0 pass; 12 over the limit or no limit recorded, which goes to GBEV-3 as the mint's stops do; 2 refused,
 * when a slot among the five is not yet resolved (no validation record and no dropped render record), a request log line
 * is not JSON, or the batch's seed set has no supply baseline entry at all.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BG1C_FIRST_SLOT, bg1WorldId, bgwBatchSlots, bgwSeedSetOf, bgwWorldId } from '../../runner/memory-qa/bg1-names.ts';
import { RenderRefusal } from './render.ts';

/** The dev mint's Gemini requests per world (5,714 for 17 worlds), and the R111 limit, 1.5 times it. */
export const DEV_MINT_GEMINI_PER_WORLD = 336;
export const SUPPLY_MULTIPLE = 1.5;
export const SUPPLY_LIMIT = SUPPLY_MULTIPLE * DEV_MINT_GEMINI_PER_WORLD;
/**
 * Each set's R111 baseline, in Gemini requests per world: BG1-C's and W1's are the dev mint's 336 (limit 504). W1-long's
 * is null until the requests its first batch's first five slots used are recorded here, in a dated change.
 */
export const SUPPLY_BASELINES: Readonly<Record<string, number | null>> = { 'BG1-C': DEV_MINT_GEMINI_PER_WORLD, W1: DEV_MINT_GEMINI_PER_WORLD, 'W1-long': null };

/** A set's supply limit: 1.5 times its recorded baseline, or null while none is recorded. Refuses a set with no entry. */
export function supplyLimitOf(set: string): number | null {
  if (!Object.hasOwn(SUPPLY_BASELINES, set)) throw new RenderRefusal(`set ${set} has no supply baseline entry (supply.ts SUPPLY_BASELINES), so its mint has no supply check`);
  const baseline = SUPPLY_BASELINES[set];
  return baseline === null ? null : SUPPLY_MULTIPLE * baseline;
}

export function supplyCheck(argv: string[]): { pass: boolean; line: string } {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out'), bgw = argv.includes('--bgw'), batch = flag('--batch');
  if (!out || (bgw && !/^\d{4}$/.test(batch ?? ''))) throw new RenderRefusal('usage: [--bgw --batch <first slot>] --out <mint.sh --bg1c or --bgw --out>');
  let first = BG1C_FIRST_SLOT;
  if (bgw) { try { first = bgwBatchSlots(Number(batch))[0]; } catch (e) { throw new RenderRefusal((e as Error).message); } }
  const limit = supplyLimitOf(bgw ? bgwSeedSetOf(first)!.id : 'BG1-C');
  const checked = Array.from({ length: 5 }, (_, i) => first + i), worldId = bgw ? bgwWorldId : bg1WorldId, span = `${checked[0]} to ${checked[4]}`;
  const status = (path: string) => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { status?: string }).status : undefined);
  const slots = checked.map(slot => {
    const id = worldId(slot), render = join(resolve(out), 'render');
    const validation = status(join(render, `${id}.validation.json`)), dropped = status(join(render, `${id}.json`)) === 'dropped';
    if (!validation && !dropped) throw new RenderRefusal(`slots ${span} are not all resolved: ${id} has neither a validation record nor a dropped render record`);
    const log = join(resolve(out), 'proxy', 'requests', `${id}-gemini.jsonl`);
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const requests = lines.filter(l => { try { return (JSON.parse(l) as { refused?: boolean }).refused !== true; } catch { throw new RenderRefusal(`${id}'s Gemini request log has a line that is not JSON`); } }).length;
    return { world: id, kept: validation === 'pass', requests };
  });
  const requests = slots.reduce((n, s) => n + s.requests, 0), kept = slots.filter(s => s.kept).length;
  const perKept = kept ? requests / kept : null;
  const pass = perKept !== null && limit !== null && perKept <= limit;
  const verdict = limit === null ? 'unmeasured' : pass ? 'pass' : 'fail';
  writeFileSync(join(resolve(out), 'render', 'supply.json'), JSON.stringify({ slots, gemini_requests: requests, kept, per_kept_world: perKept, limit, status: verdict }, null, 1) + '\n', { mode: 0o600 });
  return { pass, line: `bg1-supply slots=${checked[0]}-${checked[4]} gemini_requests=${requests} kept=${kept} per_kept_world=${perKept === null ? 'none' : perKept.toFixed(1)} limit=${limit ?? 'none'} status=${verdict}` };
}

if (import.meta.main) {
  try {
    const r = supplyCheck(process.argv.slice(2));
    console.log(r.line);
    process.exit(r.pass ? 0 : 12);
  } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof RenderRefusal ? `bg1-supply refused: ${e.message}\n` : `bg1-supply error class=${e.name} sha256=${createHash('sha256').update(String(e.message)).digest('hex').slice(0, 16)}\n`);
    process.exit(e instanceof RenderRefusal ? 2 : 1);
  }
}
