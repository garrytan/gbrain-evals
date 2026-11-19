/**
 * BG1-C's pilot (eval/runner/bg1/verdict.ts pilot --set BG1-C; Amendment 1, R111) on synthetic smoke receipts of the
 * committed cell set's smoke cells: each row's smoke on bg1-dev-01 against conditions 1 and 3 of the pilot list (a frozen
 * context for all 64 questions, a mean fill rate of at least 0.90, gbrain's brain counts and each server's stored
 * memories above 0, spend per world at most 1.5 times the row's Budget rate, the mint's Gemini requests per kept world at
 * most 504), with condition 2 from the judge checks' reports; each failure named by row (or the mint) and condition, with
 * a non-zero exit. Keyless and offline: nothing here builds a provider client, and fetch throws for the whole file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerId } from '../../eval/runner/memory-qa/records.ts';
import { CELL_RECEIPT_SCHEMA } from '../../eval/runner/q1/cell.ts';
import { PARTICLE } from '../../eval/runner/q1/cells/bg1.ts';
import { BG1C_RATES } from '../../eval/runner/q1/cells/bg1c.ts';
import { BG1C_SETS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { REREAD_RECEIPT_SCHEMA, rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import { bg1cPerWorld } from '../../eval/runner/bg1/pricing.ts';
import { CONFIRM_CELLS_PATH, CONFIRM_LIVE_READERS, CONFIRM_MINT_LINE, CONFIRM_PILOT_QUESTIONS, CONFIRM_PILOT_WORLD, CONFIRM_SHARED_RATE, confirmPilotSpendLine } from '../../eval/runner/bg1/confirm.ts';
import { confirmPilot, main } from '../../eval/runner/bg1/verdict.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bg1c-pilot-'));
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('the BG1-C pilot tests are offline'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SYSTEMS = { gbrain: 'gbrain-defaults', 'memory-bank': 'ext-memory-bank', 'extract-first': 'ext-extract-first' } as const;
type Row = keyof typeof SYSTEMS;
const SMOKE_CELLS = (JSON.parse(readFileSync(CONFIRM_CELLS_PATH, 'utf8')) as { smoke_cells: CellDefinition[] }).smoke_cells;
const cellOf = (row: Row) => SMOKE_CELLS.find(c => c.system === SYSTEMS[row])!;
const QUESTIONS = Array.from({ length: CONFIRM_PILOT_QUESTIONS }, (_, i) => `${CONFIRM_PILOT_WORLD}-q${String(i).padStart(2, '0')}`);
const ndjson = (path: string, rows: unknown[]) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join('')); };

interface Smoke { cellUsd?: number | null; readerUsd?: number; judgeUsd?: number; keyless?: boolean; fill?: number; unfrozen?: number; world?: string; reread?: boolean; skip?: boolean; cell?: string }
let n = 0;
/** A smoke out dir with each row's smoke cell (or `cell`) on bg1-dev-01: rows, answers by both live readers, frozen contexts, meters as spend, and a particle-1 re-read. */
function smoke(o: Partial<Record<Row, Smoke>> = {}) {
  const root = join(tmp, `s${++n}`);
  for (const row of Object.keys(SYSTEMS) as Row[]) {
    const s: Smoke = { cellUsd: 4.2, readerUsd: 0.25, judgeUsd: 0.3, keyless: false, fill: 0.95, unfrozen: 0, world: CONFIRM_PILOT_WORLD, reread: true, ...o[row] };
    if (s.skip) continue;
    const system = SYSTEMS[row], cell = s.cell ?? cellOf(row).arms[0].cell_id, run = cellOf(row).id, dir = join(root, 'cells', cell);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ schema: CELL_RECEIPT_SCHEMA, cell_id: cell, run_cell: run, run_status: 'complete', system: { kind: system },
      readers: CONFIRM_LIVE_READERS, ingest: { conversations: 1, wall_ms: { total: 1_800_000 } }, spend: s.cellUsd === null ? { source: null } : { source: 'metering proxy', total_usd: s.cellUsd } }));
    const qs = QUESTIONS.map(q => q.replace(CONFIRM_PILOT_WORLD, s.world!));
    ndjson(join(dir, 'rows.ndjson'), qs.map(id => ({ id, cell_id: cell, conversation: s.world, fill_rate: s.fill })));
    const answers = qs.flatMap((id, i) => CONFIRM_LIVE_READERS.map(reader => ({
      answer_id: answerId(cell, id, reader, 0), cell_id: cell, realization_id: 'r0', question_id: id, conversation: s.world, system, arm: 'a', reader, replicate: 0, effort: 'medium',
      context_sha256: i < s.unfrozen! ? sha(`no-context|retrieval_error`) : sha(`ctx|${system}|${id}`), text: 'Porto', usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 1, outcome: 'scored',
    })));
    ndjson(join(dir, 'answers.ndjson'), answers);
    ndjson(join(root, 'runs', run, 'contexts.ndjson'), qs.slice(s.unfrozen).map(id => ({ key: `r0|${id}|a`, prompt_sha256: sha(id), prompt: id, meta: { context_sha256: sha(`ctx|${system}|${id}`) } })));
    if (!s.reread) continue;
    const rid = rereadCellId(cell, PARTICLE);
    mkdirSync(join(root, 'cells', rid), { recursive: true });
    writeFileSync(join(root, 'cells', rid, 'receipt.json'), JSON.stringify({ schema: REREAD_RECEIPT_SCHEMA, cell_id: rid, keyless: s.keyless, run_status: 'complete', system: { kind: system }, source: { arm_cell_id: cell }, spend: { source: 'metering proxy', reader_usd: s.readerUsd, judge_usd: s.judgeUsd } }));
  }
  return root;
}
const PASSING_JUDGES = { schema: 'gbrain-evals/bg1-judge-check/v1', gates: [{ gate: 'astra_opus_kappa', value: 0.82, line: 0.6, pass: true }, { gate: 'labelled_items', value: 120, line: 40, pass: true }], stop: false };
const COUNTS = { tagged_facts: 212, slotted_facts: 148, changing_slots: 31 };
const file = (name: string, body: unknown) => { const p = join(tmp, `${++n}-${name}`); writeFileSync(p, JSON.stringify(body)); return p; };
const run = (argv: string[]) => {
  let err = '', out = '';
  const w = process.stderr.write, o = process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as never;
  process.stdout.write = ((s: string) => { out += s; return true; }) as never;
  try { return { code: main(argv), err, out }; } finally { process.stderr.write = w; process.stdout.write = o; }
};
const MEMORIES = { 'memory-bank': 412, 'extract-first': 388 };
const MINT = { gemini_requests_per_kept_world: 351.4 };
interface Inputs { brain?: unknown; memories?: unknown; mint?: unknown; judges?: unknown[] | null }
/** The pilot's CLI with every input passing unless given; null leaves an input out, and a list of arguments replaces them all. */
const pilot = (root: string, given: Inputs | string[] = {}) => {
  const flag = (name: string, value: unknown, fallback: unknown) => (value === null ? [] : [name, file(`${name.slice(2)}.json`, value === undefined ? fallback : value)]);
  const i = Array.isArray(given) ? {} : given;
  const more = Array.isArray(given) ? given : [...flag('--brain-counts', i.brain, COUNTS), ...flag('--memory-counts', i.memories, MEMORIES), ...flag('--mint-rate', i.mint, MINT),
    ...(i.judges === null ? [] : (i.judges ?? [PASSING_JUDGES]).flatMap(j => ['--judge-check', file('judges.json', j)]))];
  const dir = join(tmp, `out${++n}`);
  return { ...run(['pilot', '--set', 'BG1-C', '--receipts', root, ...more, '--out', dir]), dir };
};
const failing = (r: { err: string }) => r.err.replace(/^BG1-C pilot failed: /, '').trim().split('; ');

describe('the BG1-C pilot', () => {
  test('each row\'s spend line is 1.5 times its Budget rate: its own line plus a third of the three-row lines', () => {
    expect([confirmPilotSpendLine(cellOf('gbrain')), confirmPilotSpendLine(cellOf('memory-bank')), confirmPilotSpendLine(cellOf('extract-first'))].map(x => Math.round(x * 1e6) / 1e6)).toEqual([7.515, 7.08, 12.315]);
  });

  // Value: protects=a row passes its pilot only with every frozen context, the fill rate, gbrain's brain counts, passing judges and spend within its line, and the run prints each row's wall time; fails_when=a passing smoke fails, or the receipts' spend, fill or contexts are read from the wrong place; why_new=Amendment 1 (R111); seam=main pilot --set BG1-C, confirmPilot; no_claim=the real smoke
  test('a smoke that meets every condition passes, prints each row and its wall time per world, and exits 0', () => {
    const r = pilot(smoke());
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.split('\n')[0]).toBe('BG1-C pilot on bg1-dev-01: pass');
    expect(r.out).toContain('  gbrain: pass; condition 1 frozen contexts 64 (all 64 questions) pass; condition 1 mean fill rate 0.95 (at least 0.9) pass; condition 1 brain counts (tagged facts, slotted facts, changing slots) 212, 148, 31 (each above 0) pass; condition 2 judge checks 1 of 1 pass (at least one, every one passing) pass; condition 3 spend per world 4.75 (at most $7.515, 1.5 times the Budget rate) pass; ingest wall time per world 0.50 h');
    expect(r.out).toContain('  extract-first: pass;');
    expect(r.out).toContain('  memory-bank: pass; condition 1 frozen contexts 64 (all 64 questions) pass; condition 1 mean fill rate 0.95 (at least 0.9) pass; condition 1 stored memories 412 (above 0 for bg1-dev-01) pass;');
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('  mint: pass; condition 3 Gemini requests per kept world 351.4 (at most 504, 1.5 times the dev mint\'s 336, over bg1-031 to bg1-035) pass');
    const p = JSON.parse(readFileSync(join(r.dir, 'pilot.json'), 'utf8'));
    expect([p.schema, p.world, p.pass, p.rows.map((x: { row: string }) => x.row), p.mint.pass]).toEqual(['gbrain-evals/bg1c-pilot/v1', 'bg1-dev-01', true, ['gbrain', 'memory-bank', 'extract-first'], true]);
    expect(p.rows[1].checks.map((c: { check: string }) => c.check)).toEqual(['frozen contexts', 'mean fill rate', 'stored memories', 'judge checks', 'spend per world']);
  });

  // Value: protects=each failure is named by its row and condition and the pilot exits non-zero; fails_when=a missing frozen context, a low fill rate, spend above the line, a missing or empty brain count, a failing or missing judge check, an unpaid re-read or a missing receipt passes, or the failure names the wrong row; why_new=Amendment 1 (R111); seam=main pilot --set BG1-C; no_claim=the real smoke
  test('each failing condition is named by row and condition, and the pilot exits 3', () => {
    const one = pilot(smoke({ 'memory-bank': { unfrozen: 2 } }));
    expect([one.code, failing(one)]).toEqual([3, ['memory-bank condition 1 (frozen contexts)']]);
    expect(one.out).toContain('condition 1 frozen contexts 62 (all 64 questions) FAIL');
    expect(failing(pilot(smoke({ 'extract-first': { fill: 0.89 } })))).toEqual(['extract-first condition 1 (mean fill rate)']);
    expect(pilot(smoke({ 'extract-first': { fill: 0.91 } })).code).toBe(0);
    const line = confirmPilotSpendLine(cellOf('gbrain'));
    expect(pilot(smoke({ gbrain: { cellUsd: line - 0.55 - 0.001 } })).code).toBe(0);
    expect(failing(pilot(smoke({ gbrain: { cellUsd: line - 0.55 + 0.001 } })))).toEqual(['gbrain condition 3 (spend per world)']);
    expect(failing(pilot(smoke(), { brain: { ...COUNTS, changing_slots: 0 } }))).toEqual(['gbrain condition 1 (brain counts (tagged facts, slotted facts, changing slots))']);
    expect(failing(pilot(smoke(), { brain: null }))).toEqual(['gbrain condition 1 (brain counts (tagged facts, slotted facts, changing slots))']);
    const judges = failing(pilot(smoke(), { judges: [PASSING_JUDGES, { ...PASSING_JUDGES, gates: [{ gate: 'labelled_items', value: 30, line: 40, pass: false }], stop: true }] }));
    expect(judges).toEqual(['gbrain condition 2 (judge checks)', 'memory-bank condition 2 (judge checks)', 'extract-first condition 2 (judge checks)']);
    expect(failing(pilot(smoke(), { judges: null }))).toEqual(['gbrain condition 2 (judge checks)', 'memory-bank condition 2 (judge checks)', 'extract-first condition 2 (judge checks)']);
    const unpaid = pilot(smoke({ 'memory-bank': { keyless: true } }));
    expect(failing(unpaid)).toEqual(['memory-bank condition 3 (spend per world)']);
    expect(unpaid.out).toContain('condition 3 spend per world the particle-1 re-read is not paid');
    expect(failing(pilot(smoke({ 'memory-bank': { reread: false } })))).toEqual(['memory-bank condition 3 (spend per world)']);
    expect(failing(pilot(smoke({ gbrain: { cellUsd: null } })))).toEqual(['gbrain condition 3 (spend per world)']);
    expect(failing(pilot(smoke({ 'extract-first': { skip: true } })))).toEqual(['extract-first condition 1 (frozen contexts)', 'extract-first condition 1 (mean fill rate)', 'extract-first condition 3 (spend per world)']);
  });

  // Value: protects=each server row passes condition 1 only with stored memories for the smoke world, and the pilot passes condition 3 only with the mint's Gemini requests per kept world at most 1.5 times 336; fails_when=a missing, zero or non-numeric memory count passes, a row's count is read for another row, a mint rate above 504 or a missing one passes, or the mint's failure is not named; why_new=Amendment 1 (R111), conditions 1 and 3; seam=main pilot --set BG1-C --memory-counts --mint-rate; no_claim=the mint's own record of the figure
  test('each server needs stored memories for the world, and the mint at most 504 Gemini requests per kept world', () => {
    expect(failing(pilot(smoke(), { memories: { 'memory-bank': 0, 'extract-first': 388 } }))).toEqual(['memory-bank condition 1 (stored memories)']);
    expect(failing(pilot(smoke(), { memories: { 'memory-bank': 412 } }))).toEqual(['extract-first condition 1 (stored memories)']);
    expect(failing(pilot(smoke(), { memories: { 'memory-bank': '412', 'extract-first': 388 } }))).toEqual(['memory-bank condition 1 (stored memories)']);
    const none = pilot(smoke(), { memories: null });
    expect([none.code, failing(none)]).toEqual([3, ['memory-bank condition 1 (stored memories)', 'extract-first condition 1 (stored memories)']]);
    expect(none.out).toContain('condition 1 stored memories none given (above 0 for bg1-dev-01) FAIL');
    expect(none.out).toContain('  gbrain: pass;');
    expect(CONFIRM_MINT_LINE).toBe(504);
    expect(pilot(smoke(), { mint: { gemini_requests_per_kept_world: 504 } }).code).toBe(0);
    const over = pilot(smoke(), { mint: { gemini_requests_per_kept_world: 504.1 } });
    expect([over.code, failing(over)]).toEqual([3, ['mint condition 3 (Gemini requests per kept world)']]);
    expect(over.out).toContain("  mint: FAIL; condition 3 Gemini requests per kept world 504.1 (at most 504, 1.5 times the dev mint's 336, over bg1-031 to bg1-035) FAIL");
    expect(JSON.parse(readFileSync(join(over.dir, 'pilot.json'), 'utf8')).pass).toBe(false);
    expect(failing(pilot(smoke(), { mint: null }))).toEqual(['mint condition 3 (Gemini requests per kept world)']);
    const misnamed = pilot(smoke(), { mint: { requests_per_world: 300 } });
    expect([failing(misnamed), misnamed.out.includes('Gemini requests per kept world missing (at most 504')]).toEqual([['mint condition 3 (Gemini requests per kept world)'], true]);
  });

  // Value: protects=the pilot reads each row's own smoke cell in the committed cell set, its spend line from the cell set's rates, and its world and questions from the smoke set; fails_when=a receipt of the row's system under another cell id (a counted unit, an old dev-loop cell) is read as its pilot, or the lines and the smoke's world drift from bg1c.ts and definitions.ts; why_new=folding the pilot into the BG1-C cell set; seam=confirmPilot, confirmPilotSpendLine; no_claim=the smoke's run config
  test('the pilot reads each row\'s smoke cell from the cell set, never another cell of the same system', () => {
    const elsewhere = pilot(smoke({ 'memory-bank': { cell: 'bg1c.ext-memory-bank.recipe.component-b8000' } }));
    expect(failing(elsewhere)).toEqual(['memory-bank condition 1 (frozen contexts)', 'memory-bank condition 1 (mean fill rate)', 'memory-bank condition 3 (spend per world)']);
    expect(JSON.parse(readFileSync(join(elsewhere.dir, 'pilot.json'), 'utf8')).rows.map((r: { cell: string }) => r.cell)).toEqual(SMOKE_CELLS.map(c => c.arms[0].cell_id));
    expect(SMOKE_CELLS.map(c => c.arms[0].cell_id)).toEqual(['bg1c-dev1.gbrain-defaults.rs1-stable.p', 'bg1c-dev1.ext-memory-bank.recipe.component-b8000', 'bg1c-dev1.ext-extract-first.common.component-b8000']);
    expect(SMOKE_CELLS.map(confirmPilotSpendLine)).toEqual(SMOKE_CELLS.map(c => 1.5 * (BG1C_RATES.row_usd_per_world[`${c.system}:${c.configuration}`] + CONFIRM_SHARED_RATE)));
    const l = bg1cPerWorld().lines;
    expect([l.sol_reads, l.sol_grading, l.particle_rereads].map(x => Math.round(x * 100) / 100).reduce((a, b) => a + b, 0) / 3).toBeCloseTo(CONFIRM_SHARED_RATE, 12);
    expect([CONFIRM_PILOT_WORLD, CONFIRM_PILOT_QUESTIONS]).toEqual([BG1C_SETS['BG1C-dev1'].only_conversations![0], BG1C_SETS['BG1C-dev1'].questions]);
  });

  test('it refuses a smoke on another world, two smoke receipts for one row, and a missing input file', () => {
    expect(pilot(smoke({ gbrain: { world: 'bg1-dev-02' } })).err).toMatch(/^bg1 pilot refused: .*the pilot reads the smoke on bg1-dev-01, and this receipt holds bg1-dev-02\n$/);
    const twice = smoke();
    const again = smoke();
    expect(() => confirmPilot([twice, again])).toThrow('the pilot reads one smoke receipt per row, and gbrain has 2');
    expect(pilot(smoke(), ['--brain-counts', join(tmp, 'missing.json')])).toMatchObject({ code: 2, err: `bg1 pilot refused: ${join(tmp, 'missing.json')} does not exist\n` });
  });
});
