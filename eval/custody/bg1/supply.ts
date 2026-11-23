/**
 * BG1-C's custody supply check (R111; docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md, "A
 * pilot for every row", condition 3): once mint.sh --bg1c has resolved slots 31 to 35, it counts the Gemini requests
 * their metering proxies sent upstream (<out>/proxy/requests/bg1-0NN-gemini.jsonl, every line the proxy did not refuse)
 * and the worlds among them that passed validation (<out>/render/bg1-0NN.validation.json). It passes when the requests
 * per kept world are at most 1.5 times the dev mint's 336 per world (5,714 requests for 17 worlds), 504; five slots with
 * no kept world fail. It writes <out>/render/supply.json and prints one counts-only line.
 *
 *   bun eval/custody/bg1/supply.ts --out <dir>/bg1-custody...
 *
 * Exit codes: 0 pass; 12 over the limit, which goes to GBEV-3 as the mint's stops do; 2 refused, when a slot among 31 to
 * 35 is not yet resolved (no validation record and no dropped render record) or a request log line is not JSON.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BG1C_FIRST_SLOT, bg1WorldId } from '../../runner/memory-qa/bg1-names.ts';
import { RenderRefusal } from './render.ts';

/** The dev mint's Gemini requests per world (5,714 for 17 worlds), and the R111 limit, 1.5 times it. */
export const DEV_MINT_GEMINI_PER_WORLD = 336;
export const SUPPLY_LIMIT = 1.5 * DEV_MINT_GEMINI_PER_WORLD;
const SLOTS = Array.from({ length: 5 }, (_, i) => BG1C_FIRST_SLOT + i);

export function supplyCheck(argv: string[]): { pass: boolean; line: string } {
  const i = argv.indexOf('--out'), out = i >= 0 ? argv[i + 1] : undefined;
  if (!out) throw new RenderRefusal('usage: --out <mint.sh --bg1c --out>');
  const status = (path: string) => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { status?: string }).status : undefined);
  const slots = SLOTS.map(slot => {
    const id = bg1WorldId(slot), render = join(resolve(out), 'render');
    const validation = status(join(render, `${id}.validation.json`)), dropped = status(join(render, `${id}.json`)) === 'dropped';
    if (!validation && !dropped) throw new RenderRefusal(`slots 31 to 35 are not all resolved: ${id} has neither a validation record nor a dropped render record`);
    const log = join(resolve(out), 'proxy', 'requests', `${id}-gemini.jsonl`);
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const requests = lines.filter(l => { try { return (JSON.parse(l) as { refused?: boolean }).refused !== true; } catch { throw new RenderRefusal(`${id}'s Gemini request log has a line that is not JSON`); } }).length;
    return { world: id, kept: validation === 'pass', requests };
  });
  const requests = slots.reduce((n, s) => n + s.requests, 0), kept = slots.filter(s => s.kept).length;
  const perKept = kept ? requests / kept : null;
  const pass = perKept !== null && perKept <= SUPPLY_LIMIT;
  writeFileSync(join(resolve(out), 'render', 'supply.json'), JSON.stringify({ slots, gemini_requests: requests, kept, per_kept_world: perKept, limit: SUPPLY_LIMIT, status: pass ? 'pass' : 'fail' }, null, 1) + '\n', { mode: 0o600 });
  return { pass, line: `bg1-supply slots=31-35 gemini_requests=${requests} kept=${kept} per_kept_world=${perKept === null ? 'none' : perKept.toFixed(1)} limit=${SUPPLY_LIMIT} status=${pass ? 'pass' : 'fail'}` };
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
