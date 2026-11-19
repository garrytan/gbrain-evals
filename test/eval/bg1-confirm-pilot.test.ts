/**
 * BG1-C's pilot (eval/runner/bg1/verdict.ts pilot --set BG1-C; Amendment 1, R111) on synthetic smoke receipts of the
 * committed cell set's smoke cells: each row's smoke on bg1-dev-01 against conditions 1 and 3 of the pilot list (a frozen
 * context for all 64 questions, a mean fill rate of at least 0.90, all 64 questions answered and graded by each of the
 * three readers, gbrain's brain counts and each server's stored memories above 0, spend per world at most 1.5 times the
 * row's Budget rate, the mint's Gemini requests per kept world at most 504), with condition 2 from the paid BG1 and BG1-C
 * judge checks; each failure named by row (or the mint) and condition, with a non-zero exit. Keyless and offline: nothing
 * here builds a provider client, and fetch throws for the whole file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_MINT_GEMINI_PER_WORLD, SUPPLY_LIMIT } from '../../eval/custody/bg1/supply.ts';
import { instrumentFor } from '../../eval/runner/memory-qa/instruments.ts';
import { answerId } from '../../eval/runner/memory-qa/records.ts';
import { CELL_RECEIPT_SCHEMA, frontierInstrumentId } from '../../eval/runner/q1/cell.ts';
import { OPUS, PARTICLE } from '../../eval/runner/q1/cells/bg1.ts';
import { BG1C_RATES, BG1C_SOL } from '../../eval/runner/q1/cells/bg1c.ts';
import { BG1C_SETS, bg1JudgeOf, PER_READER_JUDGE_SETTINGS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { REREAD_RECEIPT_SCHEMA, rereadCellId } from '../../eval/runner/q1/reread-cell.ts';
import { BG1C_JUDGE_CHECK_SCHEMA } from '../../eval/runner/bg1/bg1c-judge-check.ts';
import { JUDGE_CHECK_SCHEMA } from '../../eval/runner/bg1/judge-check.ts';
import { bg1cPerWorld } from '../../eval/runner/bg1/pricing.ts';
import { CONFIRM_BG1_VERDICT_PATH, CONFIRM_BG1_VERDICT_SHA256, CONFIRM_CELLS_PATH, CONFIRM_DEV_MINT_REQUESTS, CONFIRM_JUDGE_CHECKS, CONFIRM_LIVE_READERS, CONFIRM_MINT_LINE, CONFIRM_PILOT_QUESTIONS, CONFIRM_PILOT_WORLD, CONFIRM_SHARED_RATE, confirmPilotSpendLine } from '../../eval/runner/bg1/confirm.ts';
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

/** unanswered and ungraded leave out a reader's first n answers or gating grades; misjudged has that reader's answers graded by the other judge. */
interface Smoke { cellUsd?: number | null; readerUsd?: number; judgeUsd?: number; keyless?: boolean; fill?: number; unfrozen?: number; world?: string; reread?: boolean; skip?: boolean; cell?: string;
  unanswered?: Partial<Record<string, number>>; ungraded?: Partial<Record<string, number>>; misjudged?: string }
let n = 0;
/** A smoke out dir with each row's smoke cell (or `cell`) on bg1-dev-01: rows, answers by both live readers and their gating grades, frozen contexts, meters as spend, and a particle-1 re-read with its answers and grades. */
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
    const instrument = instrumentFor(cellOf(row).canonical_instrument!);
    const first = (m: Partial<Record<string, number>> | undefined, reader: string, id: string) => qs.indexOf(id) < (m?.[reader] ?? 0);
    const answer = (cell_id: string, id: string, reader: string) => ({
      answer_id: answerId(cell_id, id, reader, 0), cell_id, realization_id: 'r0', question_id: id, conversation: s.world, system, arm: 'a', reader, replicate: 0, effort: 'medium',
      context_sha256: qs.indexOf(id) < s.unfrozen! ? sha(`no-context|retrieval_error`) : sha(`ctx|${system}|${id}`), text: 'Porto', usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, provider_input_tokens: 10, latency_ms: 1, outcome: 'scored',
    });
    const grades = (answers: Array<{ answer_id: string; question_id: string; reader: string }>) => answers.filter(a => !first(s.ungraded, a.reader, a.question_id)).map(a => {
      const judge = s.misjudged === a.reader ? (bg1JudgeOf(a.reader) === OPUS ? 'openai:gpt-6-astra' : OPUS) : bg1JudgeOf(a.reader);
      return { answer_id: a.answer_id, instrument_id: frontierInstrumentId(instrument.id, judge), instrument_sha256: instrument.sha256, judge, judge_replicate: 0, temperature: null, score: 1, parse_ok: true, raw_sha256: sha(judge + a.answer_id), outcome: 'scored',
        view: 'gating', settings: { ...PER_READER_JUDGE_SETTINGS }, judge_versions: [`${judge}-v1`] };
    });
    const answers = qs.flatMap(id => CONFIRM_LIVE_READERS.filter(reader => !first(s.unanswered, reader, id)).map(reader => answer(cell, id, reader)));
    ndjson(join(dir, 'answers.ndjson'), answers);
    ndjson(join(dir, 'judgments.ndjson'), grades(answers));
    ndjson(join(root, 'runs', run, 'contexts.ndjson'), qs.slice(s.unfrozen).map(id => ({ key: `r0|${id}|a`, prompt_sha256: sha(id), prompt: id, meta: { context_sha256: sha(`ctx|${system}|${id}`) } })));
    if (!s.reread) continue;
    const rid = rereadCellId(cell, PARTICLE);
    mkdirSync(join(root, 'cells', rid), { recursive: true });
    writeFileSync(join(root, 'cells', rid, 'receipt.json'), JSON.stringify({ schema: REREAD_RECEIPT_SCHEMA, cell_id: rid, keyless: s.keyless, run_status: 'complete', system: { kind: system }, source: { arm_cell_id: cell }, spend: { source: 'metering proxy', reader_usd: s.readerUsd, judge_usd: s.judgeUsd } }));
    const rereads = qs.filter(id => !first(s.unanswered, PARTICLE, id)).map(id => answer(rid, id, PARTICLE));
    ndjson(join(root, 'cells', rid, 'answers.ndjson'), rereads);
    ndjson(join(root, 'cells', rid, 'judgments.ndjson'), grades(rereads));
  }
  return root;
}
const BG1_JUDGES = { schema: 'gbrain-evals/bg1-judge-check/v1', gates: [{ gate: 'astra_opus_kappa', value: 0.82, line: 0.6, pass: true }, { gate: 'labelled_items', value: 120, line: 40, pass: true }], stop: false };
const BG1C_JUDGES = { schema: 'gbrain-evals/bg1c-judge-check/v1', gates: [{ gate: 'gemini_opus_kappa', value: 0.74, line: 0.6, pass: true }, { gate: 'labelled_items', value: 64, line: 40, pass: true }], stop: false };
/** A judge check as its run leaves it: report.json, and beside it the upstream.json that marks a paid run (keyless false) or a rehearsal; upstream null writes none. */
interface JudgeCheck { report: unknown; upstream?: unknown }
const PASSING_JUDGES: JudgeCheck[] = [{ report: BG1_JUDGES }, { report: BG1C_JUDGES }];
const judgeCheck = (j: JudgeCheck) => {
  const dir = join(tmp, `judge-check-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(j.report));
  if (j.upstream !== null) writeFileSync(join(dir, 'upstream.json'), JSON.stringify(j.upstream ?? { keyless: false }));
  return join(dir, 'report.json');
};
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
const MINT = { slots: [], gemini_requests: 1757, kept: 5, per_kept_world: 351.4, limit: 504, status: 'pass' };
interface Inputs { brain?: unknown; memories?: unknown; mint?: unknown; judges?: JudgeCheck[] | null }
/** The pilot's CLI with every input passing unless given; null leaves an input out, and a list of arguments replaces them all. */
const pilot = (root: string, given: Inputs | string[] = {}) => {
  const flag = (name: string, value: unknown, fallback: unknown) => (value === null ? [] : [name, file(`${name.slice(2)}.json`, value === undefined ? fallback : value)]);
  const i = Array.isArray(given) ? {} : given;
  const more = Array.isArray(given) ? given : [...flag('--brain-counts', i.brain, COUNTS), ...flag('--memory-counts', i.memories, MEMORIES), ...flag('--mint-rate', i.mint, MINT),
    ...(i.judges === null ? [] : (i.judges ?? PASSING_JUDGES).flatMap(j => ['--judge-check', judgeCheck(j)]))];
  const dir = join(tmp, `out${++n}`);
  return { ...run(['pilot', '--set', 'BG1-C', '--receipts', root, ...more, '--out', dir]), dir };
};
const failing = (r: { err: string }) => r.err.replace(/^BG1-C pilot failed: /, '').trim().split('; ');
const GRADED = 'answered and graded (claude-opus-5-5, gpt-6.2-sol, particle-1)';
const ALL_GRADED = `condition 1 ${GRADED} 64, 64, 64 answered, 64, 64, 64 graded (all 64 questions by each reader, each graded by its mapped judge) pass`;

describe('the BG1-C pilot', () => {
  test('each row\'s spend line is 1.5 times its Budget rate: its own line plus a third of the three-row lines', () => {
    expect([confirmPilotSpendLine(cellOf('gbrain')), confirmPilotSpendLine(cellOf('memory-bank')), confirmPilotSpendLine(cellOf('extract-first'))].map(x => Math.round(x * 1e6) / 1e6)).toEqual([7.515, 7.08, 12.315]);
  });

  // Value: protects=a row passes its pilot only with every frozen context, the fill rate, gbrain's brain counts, passing judges and spend within its line, and the run prints each row's wall time; fails_when=a passing smoke fails, or the receipts' spend, fill or contexts are read from the wrong place; why_new=Amendment 1 (R111); seam=main pilot --set BG1-C, confirmPilot; no_claim=the real smoke
  test('a smoke that meets every condition passes, prints each row and its wall time per world, and exits 0', () => {
    const r = pilot(smoke());
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.split('\n')[0]).toBe('BG1-C pilot on bg1-dev-01: pass');
    expect(r.out).toContain(`  gbrain: pass; condition 1 frozen contexts 64 (all 64 questions) pass; condition 1 mean fill rate 0.95 (at least 0.9) pass; ${ALL_GRADED}; condition 1 brain counts (tagged facts, slotted facts, changing slots) 212, 148, 31 (each above 0) pass; condition 2 judge checks 2 of 2 pass (a paid BG1 and a paid BG1-C judge check, every one passing) pass; condition 3 spend per world 4.75 (at most $7.515, 1.5 times the Budget rate) pass; ingest wall time per world 0.50 h`);
    expect(r.out).toContain('  extract-first: pass;');
    expect(r.out).toContain(`  memory-bank: pass; condition 1 frozen contexts 64 (all 64 questions) pass; condition 1 mean fill rate 0.95 (at least 0.9) pass; ${ALL_GRADED}; condition 1 stored memories 412 (above 0 for bg1-dev-01) pass;`);
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('  mint: pass; condition 3 Gemini requests per kept world 351.4 (at most 504, 1.5 times the dev mint\'s 336, over bg1-031 to bg1-035) pass');
    const p = JSON.parse(readFileSync(join(r.dir, 'pilot.json'), 'utf8'));
    expect([p.schema, p.world, p.pass, p.rows.map((x: { row: string }) => x.row), p.mint.pass]).toEqual(['gbrain-evals/bg1c-pilot/v1', 'bg1-dev-01', true, ['gbrain', 'memory-bank', 'extract-first'], true]);
    expect(p.rows[1].checks.map((c: { check: string }) => c.check)).toEqual(['frozen contexts', 'mean fill rate', GRADED, 'stored memories', 'judge checks', 'spend per world']);
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
    const judges = failing(pilot(smoke(), { judges: [...PASSING_JUDGES, { report: { ...BG1C_JUDGES, gates: [{ gate: 'labelled_items', value: 30, line: 40, pass: false }], stop: true } }] }));
    expect(judges).toEqual(['gbrain condition 2 (judge checks)', 'memory-bank condition 2 (judge checks)', 'extract-first condition 2 (judge checks)']);
    expect(failing(pilot(smoke(), { judges: null }))).toEqual(['gbrain condition 2 (judge checks)', 'memory-bank condition 2 (judge checks)', 'extract-first condition 2 (judge checks)']);
    const unpaid = pilot(smoke({ 'memory-bank': { keyless: true } }));
    expect(failing(unpaid)).toEqual(['memory-bank condition 3 (spend per world)']);
    expect(unpaid.out).toContain('condition 3 spend per world the particle-1 re-read is not paid');
    expect(failing(pilot(smoke({ 'memory-bank': { reread: false } })))).toEqual([`memory-bank condition 1 (${GRADED})`, 'memory-bank condition 3 (spend per world)']);
    expect(failing(pilot(smoke({ gbrain: { cellUsd: null } })))).toEqual(['gbrain condition 3 (spend per world)']);
    expect(failing(pilot(smoke({ 'extract-first': { skip: true } })))).toEqual(['extract-first condition 1 (frozen contexts)', 'extract-first condition 1 (mean fill rate)', `extract-first condition 1 (${GRADED})`, 'extract-first condition 3 (spend per world)']);
  });

  // Value: protects=each server row passes condition 1 only with stored memories for the smoke world, and the pilot passes condition 3 only with the mint's Gemini requests per kept world at most 1.5 times 336, read from supply.ts's per_kept_world with the same line; fails_when=a missing, zero or non-numeric memory count passes, a row's count is read for another row, a mint rate above 504, a missing one, the old key or a supply check with no kept world passes, the mint's failure is not named, or the line drifts from supply.ts's; why_new=Amendment 1 (R111), conditions 1 and 3, and the mint's supply.json (cbfe0ea7a); seam=main pilot --set BG1-C --memory-counts --mint-rate; no_claim=the mint's own count of the requests
  test('each server needs stored memories for the world, and the mint\'s supply check at most 504 Gemini requests per kept world', () => {
    expect(failing(pilot(smoke(), { memories: { 'memory-bank': 0, 'extract-first': 388 } }))).toEqual(['memory-bank condition 1 (stored memories)']);
    expect(failing(pilot(smoke(), { memories: { 'memory-bank': 412 } }))).toEqual(['extract-first condition 1 (stored memories)']);
    expect(failing(pilot(smoke(), { memories: { 'memory-bank': '412', 'extract-first': 388 } }))).toEqual(['memory-bank condition 1 (stored memories)']);
    const none = pilot(smoke(), { memories: null });
    expect([none.code, failing(none)]).toEqual([3, ['memory-bank condition 1 (stored memories)', 'extract-first condition 1 (stored memories)']]);
    expect(none.out).toContain('condition 1 stored memories none given (above 0 for bg1-dev-01) FAIL');
    expect(none.out).toContain('  gbrain: pass;');
    expect(CONFIRM_MINT_LINE).toBe(504);
    expect(pilot(smoke(), { mint: { ...MINT, per_kept_world: 504 } }).code).toBe(0);
    const over = pilot(smoke(), { mint: { ...MINT, per_kept_world: 504.1 } });
    expect([over.code, failing(over)]).toEqual([3, ['mint condition 3 (Gemini requests per kept world)']]);
    expect(over.out).toContain("  mint: FAIL; condition 3 Gemini requests per kept world 504.1 (at most 504, 1.5 times the dev mint's 336, over bg1-031 to bg1-035) FAIL");
    expect(JSON.parse(readFileSync(join(over.dir, 'pilot.json'), 'utf8')).pass).toBe(false);
    expect(failing(pilot(smoke(), { mint: null }))).toEqual(['mint condition 3 (Gemini requests per kept world)']);
    const misnamed = pilot(smoke(), { mint: { requests_per_world: 300 } });
    expect([failing(misnamed), misnamed.out.includes('Gemini requests per kept world missing (at most 504')]).toEqual([['mint condition 3 (Gemini requests per kept world)'], true]);
    expect(failing(pilot(smoke(), { mint: { gemini_requests_per_kept_world: 300 } }))).toEqual(['mint condition 3 (Gemini requests per kept world)']);
    const noneKept = pilot(smoke(), { mint: { ...MINT, kept: 0, per_kept_world: null, status: 'fail' } });
    expect([failing(noneKept), noneKept.out.includes('Gemini requests per kept world no kept world (at most 504')]).toEqual([['mint condition 3 (Gemini requests per kept world)'], true]);
    expect([CONFIRM_MINT_LINE, CONFIRM_DEV_MINT_REQUESTS]).toEqual([SUPPLY_LIMIT, DEV_MINT_GEMINI_PER_WORLD]);
  });

  // Value: protects=pilot condition 2 passes only on paid judge checks of both kinds the preregistration names, BG1's (gpt-6-astra on Opus's answers, claude-opus-5-5 on particle-1's) and BG1-C's (claude-opus-5-5 on gpt-6.2-sol's), each report read by its own schema and every given one passing; fails_when=a keyless rehearsal's report, a report with no paid marker beside it, a report of another schema or none, or only one of the two kinds passes, or the schemas drift from the judge checks' own; why_new=the Opus reader's gate note 1 on BG1-C harness item 3b; seam=main pilot --set BG1-C --judge-check, confirmPilot; no_claim=the judge checks' own gates
  test('condition 2 needs a paid BG1 and a paid BG1-C judge check, each read by its schema, and a keyless rehearsal fails it', () => {
    const judgesOnly = (r: { err: string }) => failing(r).length === 3 && failing(r).every(f => f.endsWith('condition 2 (judge checks)'));
    const rehearsal = pilot(smoke(), { judges: [{ report: BG1_JUDGES }, { report: BG1C_JUDGES, upstream: { keyless: true } }] });
    expect([rehearsal.code, judgesOnly(rehearsal)]).toEqual([3, true]);
    expect(rehearsal.out).toContain("condition 2 judge checks 1 of 2 pass, none of them BG1-C's (a paid BG1 and a paid BG1-C judge check, every one passing) FAIL");
    expect(judgesOnly(pilot(smoke(), { judges: [{ report: BG1_JUDGES, upstream: { keyless: true } }, { report: BG1C_JUDGES }] }))).toBe(true);
    expect(judgesOnly(pilot(smoke(), { judges: [{ report: BG1_JUDGES }, { report: BG1C_JUDGES, upstream: null }] }))).toBe(true);
    expect(judgesOnly(pilot(smoke(), { judges: [{ report: BG1_JUDGES }, { report: BG1C_JUDGES, upstream: {} }] }))).toBe(true);
    expect(judgesOnly(pilot(smoke(), { judges: [{ report: BG1_JUDGES }, { report: { ...BG1C_JUDGES, schema: 'live-recall-judge-check/v1' } }] }))).toBe(true);
    expect(judgesOnly(pilot(smoke(), { judges: [...PASSING_JUDGES, { report: { ...BG1C_JUDGES, schema: 'live-recall-judge-check/v1' } }] }))).toBe(true);
    expect(judgesOnly(pilot(smoke(), { judges: [...PASSING_JUDGES, { report: BG1_JUDGES, upstream: { keyless: true } }] }))).toBe(true);
    const { schema: _schema, ...unnamed } = BG1C_JUDGES;
    expect(judgesOnly(pilot(smoke(), { judges: [{ report: BG1_JUDGES }, { report: unnamed }] }))).toBe(true);
    const bg1Only = pilot(smoke(), { judges: [{ report: BG1_JUDGES }] });
    expect([judgesOnly(bg1Only), bg1Only.out.includes("condition 2 judge checks 1 of 1 pass, none of them BG1-C's")]).toEqual([true, true]);
    expect(judgesOnly(pilot(smoke(), { judges: [{ report: BG1C_JUDGES }, { report: BG1C_JUDGES }] }))).toBe(true);
    expect(pilot(smoke(), { judges: [{ report: BG1C_JUDGES }, { report: BG1_JUDGES }, { report: BG1_JUDGES }] }).code).toBe(0);
    expect(Object.keys(CONFIRM_JUDGE_CHECKS)).toEqual([JUDGE_CHECK_SCHEMA, BG1C_JUDGE_CHECK_SCHEMA]);
  });

  // Value: protects=each row passes condition 1 only when claude-opus-5-5 and gpt-6.2-sol (from the smoke) and particle-1 (from its re-read) each answered all 64 questions and each answer has its mapped judge's gating grade, with the counts printed; fails_when=a missing answer, a missing grade, a grade by another judge than the mapped one or a missing re-read passes, or a count is read for the wrong reader; why_new=the Opus reader's gate note 2 on BG1-C harness item 3b; seam=main pilot --set BG1-C, confirmPilot; no_claim=the grades themselves
  // Value: protects=BG1's paid judge check, which survives only as the judge_check block of BG1's published verdict.json with no upstream.json beside it, still meets pilot condition 2 as the preregistration's "BG1's judge check stands" says, while the same block anywhere else needs its paid marker; fails_when=the pilot needs an upstream.json beside BG1's published verdict, reads the whole verdict rather than its judge_check block, or takes the block as paid from any other path; why_new=the Opus reader's note 1 on the BG1-C harness commits after 9d4cf3b85; seam=main pilot --set BG1-C --judge-check <BG1 verdict.json>; no_claim=BG1's judge check's own numbers
  test("condition 2 takes BG1's published verdict as BG1's paid judge check, and the same block elsewhere needs its paid marker", () => {
    const judgesOnly = (r: { err: string }) => failing(r).length === 3 && failing(r).every(f => f.endsWith('condition 2 (judge checks)'));
    const inputs = ['--brain-counts', file('brain-counts.json', COUNTS), '--memory-counts', file('memory-counts.json', MEMORIES), '--mint-rate', file('mint-rate.json', MINT)];
    const bg1c = ['--judge-check', judgeCheck({ report: BG1C_JUDGES })];
    const published = pilot(smoke(), [...inputs, '--judge-check', CONFIRM_BG1_VERDICT_PATH, ...bg1c]);
    expect([published.code, published.out.includes('condition 2 judge checks 2 of 2 pass')]).toEqual([0, true]);
    const block = (JSON.parse(readFileSync(CONFIRM_BG1_VERDICT_PATH, 'utf8')) as { judge_check: unknown }).judge_check;
    expect(judgesOnly(pilot(smoke(), [...inputs, '--judge-check', judgeCheck({ report: block, upstream: null }), ...bg1c]))).toBe(true);
    expect(pilot(smoke(), [...inputs, '--judge-check', judgeCheck({ report: block }), ...bg1c]).code).toBe(0);
    expect(judgesOnly(pilot(smoke(), [...inputs, '--judge-check', file('verdict.json', JSON.parse(readFileSync(CONFIRM_BG1_VERDICT_PATH, 'utf8'))), ...bg1c]))).toBe(true);
    expect(createHash('sha256').update(readFileSync(CONFIRM_BG1_VERDICT_PATH)).digest('hex')).toBe(CONFIRM_BG1_VERDICT_SHA256);
  });

  test('condition 1 needs all 64 questions answered and graded by each of the three readers, and prints the counts', () => {
    const sol = pilot(smoke({ 'memory-bank': { unanswered: { [BG1C_SOL]: 1 } } }));
    expect([sol.code, failing(sol)]).toEqual([3, [`memory-bank condition 1 (${GRADED})`]]);
    expect(sol.out).toContain(`condition 1 ${GRADED} 64, 63, 64 answered, 64, 63, 64 graded (all 64 questions by each reader, each graded by its mapped judge) FAIL`);
    const particle = pilot(smoke({ gbrain: { ungraded: { [PARTICLE]: 2 } } }));
    expect([failing(particle), particle.out.includes(`${GRADED} 64, 64, 64 answered, 64, 64, 62 graded`)]).toEqual([[`gbrain condition 1 (${GRADED})`], true]);
    expect(pilot(smoke({ gbrain: { ungraded: { [OPUS]: 1 } } })).out).toContain(`${GRADED} 64, 64, 64 answered, 63, 64, 64 graded`);
    expect(pilot(smoke({ 'extract-first': { unanswered: { [PARTICLE]: 64 } } })).out).toContain(`${GRADED} 64, 64, 0 answered, 64, 64, 0 graded`);
    const misjudged = pilot(smoke({ 'extract-first': { misjudged: BG1C_SOL } }));
    expect([failing(misjudged), misjudged.out.includes(`${GRADED} 64, 64, 64 answered, 64, 0, 64 graded`)]).toEqual([[`extract-first condition 1 (${GRADED})`], true]);
    expect(pilot(smoke({ 'extract-first': { misjudged: OPUS } })).out).toContain(`${GRADED} 64, 64, 64 answered, 0, 64, 64 graded`);
  });

  // Value: protects=the pilot reads each row's own smoke cell in the committed cell set, its spend line from the cell set's rates, and its world and questions from the smoke set; fails_when=a receipt of the row's system under another cell id (a counted unit, an old dev-loop cell) is read as its pilot, or the lines and the smoke's world drift from bg1c.ts and definitions.ts; why_new=folding the pilot into the BG1-C cell set; seam=confirmPilot, confirmPilotSpendLine; no_claim=the smoke's run config
  test('the pilot reads each row\'s smoke cell from the cell set, never another cell of the same system', () => {
    const elsewhere = pilot(smoke({ 'memory-bank': { cell: 'bg1c.ext-memory-bank.recipe.component-b8000' } }));
    expect(failing(elsewhere)).toEqual(['memory-bank condition 1 (frozen contexts)', 'memory-bank condition 1 (mean fill rate)', `memory-bank condition 1 (${GRADED})`, 'memory-bank condition 3 (spend per world)']);
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
