/**
 * The SOTA loop's leader rows: each dev-pool question answered by the strongest system we have for its benchmark, so a
 * gbrain miss the leader solved is a miss someone has already shown how to avoid. On LongMemEval the leader is the
 * whole-history reader (every session in the prompt); on BEAM-1M it is the grep agent (the file agent: 40 turns,
 * list_dir, grep and read_file over the sessions as files). Both run as q1 cells (definitions.ts
 * generateSotaLeaderCells), judged by the reader's per-row frontier judge (q1's frontierJudgeOf: gpt-6.1-sol grades
 * Claude rows, claude-opus-5-5 grades GPT rows), and are written to the outcome cache, which attribution reads.
 *
 *   bun eval/runner/sota/leader.ts plan --cache <dir>
 *   bun eval/runner/sota/leader.ts import --from <q1 out dir> --cell <cell id> --cache <dir>
 *   bun eval/runner/sota/leader.ts run --benchmark beam-1m|lme-s --system <leader> --reader <provider:model> --items <ids.txt>
 *       --cache <dir> --work <dir> --paid --budget-ledger <path> --budget-run-id <id>
 *
 * plan (keyless) lists, per benchmark and nightly reader, the dev-pool items whose leader row is fresh, unknown or
 * stale, and writes the ids to buy. import (keyless) turns a q1 cell's published answers and frontier judgments into
 * leader rows: the leader cells' own, and the SOTA dev test's grep-agent rows, which are BEAM-1M leader rows for the
 * dev conversations, so the leader cache buys only the pool questions the dev test leaves out. It refuses a run whose
 * reader prompt or judging instrument differs from today's. run buys the rows the cache lacks for the listed items: the
 * leader cell narrowed to those items and the reader's own arm, through q1's paid guard and ledger, then imported.
 *
 * A row's verdict is the frontier judgment's score against ORACLE_PASS. An agent that ran out of turns or context, or a
 * history that does not fit the reader, is the leader failing (score 0). Answers with a harness failure, a degraded
 * ingest, an empty text, a cut-off at the output limit (the nightly's rule since #420; the whole-history reader gets
 * q1's 2,048 tokens, and Claude's adaptive thinking counts against them) or no frontier judgment write no row, so their
 * items stay unknown. q1's judgments record no tokens, so a row's usage holds the reader's tokens and zero judge
 * tokens, and a stale re-buy's projected cap counts readers only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { instrumentFor } from '../memory-qa/instruments.ts';
import { READER_TEMPLATE } from '../memory-qa/qa-v2.ts';
import { readRecords, type AnswerRecord } from '../memory-qa/records.ts';
import { qaPromptVersion } from '../nightly/judge-cache.ts';
import { frontierInstrumentId, paidGuard, readerMaxTokens, runCell } from '../q1/cell.ts';
import { estimateCell, frontierJudgeOf, loadManifest, type CellDefinition } from '../q1/cells/definitions.ts';
import { FRONTIER_READERS, FULL_CONTEXT_EFFORT } from '../systems/baselines.ts';
import { FILE_AGENT_EFFORT, FILE_AGENT_SYSTEM } from '../systems/file-agent.ts';
import { AGENT_ARM_PARITY } from '../systems/gbrain-agent.ts';
import { ORACLE_PASS } from './answerability.ts';
import { CACHE_SCHEMA, freshness, OutcomeCache, type Row, type Spec } from './cache.ts';
import { datasetPin, poolItems, validatorVersion } from './oracle.ts';
import { assertNoSealedIds } from './sealed-guard.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const sha16 = (...files: string[]) => { const h = createHash('sha256'); for (const f of files) h.update(readFileSync(join(ROOT, f))); return h.digest('hex').slice(0, 16); };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The leader per benchmark: its name in the cache, the q1 cell and arm that run it (one arm per reader, `<arm>-<reader>`),
 * the q1 system and mode it is, the code that defines it, its reader prompt, its effort and its reader output limit.
 */
export const LEADERS: Record<string, { system: string; cell: string; arm: string; q1_system: string; mode: string; code: string[]; prompt: string; effort: string; maxTokens: (reader: string) => number }> = {
  'beam-1m': { system: 'grep-agent', cell: 'sota-leader-beam.baseline-file-agent.baseline', arm: 'whole-agent', q1_system: 'baseline-file-agent', mode: 'agent',
    code: ['eval/runner/systems/file-agent.ts', 'eval/runner/cat40/loop.ts'], prompt: FILE_AGENT_SYSTEM, effort: FILE_AGENT_EFFORT,
    maxTokens: reader => AGENT_ARM_PARITY.output_tokens[reader.split(':')[0] as keyof typeof AGENT_ARM_PARITY.output_tokens] },
  'lme-s': { system: 'whole-history', cell: 'sota-leader-lme.baseline-full-context.baseline', arm: 'whole-full-context', q1_system: 'baseline-full-context', mode: 'full-context',
    code: ['eval/runner/systems/baselines.ts', 'eval/runner/memory-qa/qa-v2.ts'], prompt: READER_TEMPLATE, effort: FULL_CONTEXT_EFFORT, maxTokens: readerMaxTokens },
};

/** The leader's judge for a reader: the q1 cells' frontier judge, the BEAM judges rule (gpt-6.1-sol grades Claude and particle-1 rows, claude-opus-5-5 grades GPT rows). */
export const leaderJudge = frontierJudgeOf;

/** The current inputs for a benchmark's leader rows with one reader, or null when the benchmark has no leader or the leader cells don't run the reader (only the nightly's frontier readers). */
export function leaderSpec(benchmark: string, reader: string): Spec | null {
  const l = LEADERS[benchmark];
  if (!l || !(FRONTIER_READERS as readonly string[]).includes(reader)) return null;
  return {
    kind: 'leader', benchmark, system: l.system, reader, system_version: sha16(...l.code), effort: l.effort, max_tokens: l.maxTokens(reader),
    judge: leaderJudge(reader), judge_prompt: `${instrumentFor(benchmark).sha256.slice(0, 16)}:${qaPromptVersion()}`, pass_threshold: ORACLE_PASS, dataset: datasetPin(benchmark),
    validator_version: validatorVersion(benchmark), harness_digest: sha16('eval/runner/sota/leader.ts'),
  };
}

/** Outcomes that are the leader failing the question: it ran out of turns or context, or the history does not fit. */
const LEADER_FAILED = new Set(['turn_cap', 'context_overflow', 'does_not_fit']);
/** Finish reasons of an answer that stopped at its output limit (the nightly's rule since #420: a harness row, never a verdict). */
const CUT_OFF = new Set(['length', 'max_tokens', 'max_output_tokens']);

interface RunConfig { run_cell: string; cell: { benchmark: string; system: string }; arm: { mode: string }; instrument: { id: string; sha256: string }; reader: { prompt_sha256: string | null } }

/**
 * Leader rows from a q1 cell's published output (<out>/cells/<cell>.<arm>/): every replicate-0 answer by a nightly
 * reader, with its frontier judgment. Refuses an arm that is not a leader or ran on another prompt or instrument.
 */
export function leaderRows(out: string, cell: string, at = new Date().toISOString()): { rows: Row[]; unknown: Array<{ item: string; reader: string; outcome: string }>; skipped: number } {
  const dir = join(out, 'cells');
  const arms = existsSync(dir) ? readdirSync(dir).filter(d => d.startsWith(`${cell}.`) && existsSync(join(dir, d, 'run-config.json'))).sort() : [];
  if (!arms.length) throw new Error(`${dir} holds no published arm of ${cell}`);
  const rows: Row[] = [], unknown: Array<{ item: string; reader: string; outcome: string }> = [];
  let skipped = 0;
  for (const arm of arms) {
    const cfg = JSON.parse(readFileSync(join(dir, arm, 'run-config.json'), 'utf8')) as RunConfig;
    const benchmark = cfg.cell.benchmark, l = LEADERS[benchmark];
    if (cfg.run_cell !== cell) throw new Error(`${arm}: run-config names cell ${cfg.run_cell}, not ${cell}`);
    if (!l || l.q1_system !== cfg.cell.system || l.mode !== cfg.arm.mode) throw new Error(`${arm}: ${cfg.cell.system} (${cfg.arm.mode}) on ${benchmark} is not a leader; the leaders are ${Object.entries(LEADERS).map(([b, x]) => `${x.q1_system} (${x.mode}) on ${b}`).join(' and ')}`);
    const instrument = instrumentFor(benchmark);
    if (cfg.instrument.sha256 !== instrument.sha256) throw new Error(`${arm}: judged with instrument ${cfg.instrument.sha256.slice(0, 16)}, and today's ${instrument.id} is ${instrument.sha256.slice(0, 16)}; its rows would be stale, so buy them again`);
    if (cfg.reader.prompt_sha256 !== sha256(l.prompt)) throw new Error(`${arm}: read with prompt ${String(cfg.reader.prompt_sha256).slice(0, 16)}, and today's ${l.system} prompt is ${sha256(l.prompt).slice(0, 16)}; its rows would be stale, so buy them again`);
    const pool = new Set(poolItems(benchmark));
    const judgments = readRecords(join(dir, arm, 'judgments.ndjson'), 'judgment').filter(j => j.judge_replicate === 0);
    for (const a of readRecords(join(dir, arm, 'answers.ndjson'), 'answer') as AnswerRecord[]) {
      if (a.replicate !== 0 || !(FRONTIER_READERS as readonly string[]).includes(a.reader)) { skipped++; continue; }
      if (!pool.has(a.question_id)) throw new Error(`${arm}: ${a.question_id} is not in the ${benchmark} dev pool`);
      const spec = leaderSpec(benchmark, a.reader)!;
      const j = judgments.find(x => x.answer_id === a.answer_id && x.instrument_id === frontierInstrumentId(instrument.id, spec.judge));
      const failed = LEADER_FAILED.has(a.outcome);
      const why = failed ? null : a.outcome !== 'scored' ? a.outcome : a.truncated || CUT_OFF.has(a.finish ?? '') ? 'cut off at its output limit' : !a.text.trim() ? 'empty answer'
        : j?.outcome !== 'scored' || typeof j.score !== 'number' ? 'no frontier judgment' : null;
      if (why) { unknown.push({ item: a.question_id, reader: a.reader, outcome: why }); continue; }
      const score = failed ? 0 : j!.score!;
      rows.push({ ...spec, schema: CACHE_SCHEMA, item: a.question_id, context_digest: a.context_sha256, score, pass: score >= spec.pass_threshold,
        finish_reason: failed ? a.outcome : a.stop_reason ?? a.finish ?? null, usage: { reader_input: a.usage.input, reader_output: a.usage.output, judge_input: 0, judge_output: 0 },
        at, source: `q1 ${arm}` });
    }
  }
  return { rows, unknown, skipped };
}

/** Writes the rows the cache lacks (no fresh row on the same context) and returns how many. */
export function importLeader(cache: OutcomeCache, rows: readonly Row[]): number {
  const fresh = rows.filter(r => cache.lookup(r, r.item, r.context_digest).status !== 'hit');
  for (const benchmark of new Set(fresh.map(r => r.benchmark))) cache.put(fresh.filter(r => r.benchmark === benchmark));
  return fresh.length;
}

/** The leader cell narrowed to the items and to the reader's arm, with that arm's own estimate, for a run that buys exactly those rows. */
export function leaderRunCell(benchmark: string, reader: string, items: readonly string[], manifest = loadManifest()): CellDefinition {
  const l = LEADERS[benchmark];
  if (!l) throw new Error(`${benchmark} has no leader (leaders: ${Object.keys(LEADERS).join(', ')})`);
  const base = (manifest.addon_cells ?? []).find(c => c.id === l.cell);
  if (!base) throw new Error(`the q1 manifest has no ${l.cell}; regenerate it with bun eval/runner/q1/cells/definitions.ts`);
  const arm = base.arms.find(a => a.readers.length === 1 && a.readers[0] === reader);
  if (!arm) throw new Error(`${l.cell} has no arm for ${reader} (readers: ${base.arms.flatMap(a => a.readers).join(', ')})`);
  const ids = [...new Set(items)].sort();
  if (!ids.length) throw new Error('no items to run');
  const conversations = benchmark.startsWith('beam-') ? { only_conversations: [...new Set(ids.map(id => id.slice(0, id.indexOf(':'))))].sort() } : {};
  const { estimate: _whole, ...narrowed } = { ...base, ...conversations, selection: { kind: 'ids' as const, ids }, arms: [arm] };
  return { ...narrowed, estimate: estimateCell(narrowed) };
}

export interface RunOptions { benchmark: string; system: string; reader: string; items: string[]; cache: string; work: string; argv: string[] }

/** Buys the leader rows the cache lacks for these items in a paid window, then imports them. */
export async function runLeader(o: RunOptions): Promise<{ bought: number; fresh: number; unknown: Array<{ item: string; reader: string; outcome: string }> }> {
  const spec = leaderSpec(o.benchmark, o.reader);
  if (!spec || spec.system !== o.system) throw new Error(`${o.benchmark}'s leader is ${LEADERS[o.benchmark]?.system ?? 'none'}, not ${o.system}`);
  assertNoSealedIds(o.items.join('\n'), '--items');
  const pool = new Set(poolItems(o.benchmark));
  const outside = o.items.filter(id => !pool.has(id));
  if (outside.length) throw new Error(`${outside.length} items are not in the ${o.benchmark} dev pool: ${outside.slice(0, 5).join(', ')}`);
  const cache = new OutcomeCache(o.cache);
  const f = freshness(cache, spec, o.items);
  const todo = o.items.filter(id => !f.hits.has(id));
  if (!todo.length) return { bought: 0, fresh: f.hits.size, unknown: [] };
  const def = leaderRunCell(o.benchmark, o.reader, todo);
  const estimateUsd = paidGuard(o.argv, def, todo.length);
  startPaidRun(`sota-leader:${def.id}`, { ...budgetOptionsFrom(o.argv), estimateUsd });
  const out = join(o.work, `${def.arms[0]!.cell_id}-${sha256(JSON.stringify(spec) + todo.join('\n')).slice(0, 12)}`);
  mkdirSync(o.work, { recursive: true });
  await runCell(def, { out, arms: [def.arms[0]!.id], frontier: true });
  const { rows, unknown } = leaderRows(out, def.id);
  return { bought: importLeader(cache, rows), fresh: f.hits.size, unknown };
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };
const unknownLine = (u: Array<{ item: string; reader: string; outcome: string }>) => (u.length ? `; ${u.length} left unknown: ${u.map(x => `${x.item} ${x.reader} (${x.outcome})`).join(', ')}` : '');

export async function main(argv: string[], log: (s: string) => void = console.log): Promise<number> {
  const cache = new OutcomeCache(resolve(need(argv, '--cache')));
  switch (argv[0]) {
    case 'plan': {
      for (const benchmark of Object.keys(LEADERS)) for (const reader of FRONTIER_READERS) {
        const spec = leaderSpec(benchmark, reader)!, items = poolItems(benchmark), f = freshness(cache, spec, items);
        const buy = [...f.unknown, ...f.stale.map(s => s.item)].sort();
        const file = join(cache.dir, 'plan', `leader-${benchmark}-${reader.replace(/[^a-z0-9.-]+/gi, '_')}.txt`);
        if (buy.length) { mkdirSync(join(cache.dir, 'plan'), { recursive: true }); writeFileSync(file, buy.join('\n') + '\n'); }
        log(`${benchmark} ${spec.system} ${reader}: ${items.length} items, ${f.hits.size} fresh, ${f.unknown.length} unknown, ${f.stale.length} stale${buy.length ? `; to buy: ${file}` : ''}`);
      }
      return 0;
    }
    case 'import': {
      const { rows, unknown, skipped } = leaderRows(resolve(need(argv, '--from')), need(argv, '--cell'));
      log(`import: ${importLeader(cache, rows)} rows written, ${rows.length} read${skipped ? `, ${skipped} answers by other readers or replicates skipped` : ''}${unknownLine(unknown)}`);
      return 0;
    }
    case 'run': {
      if (!argv.includes('--paid')) throw new Error('run buys leader answers: pass --paid with the window\'s --budget-ledger and --budget-run-id');
      const items = readFileSync(need(argv, '--items'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
      const r = await runLeader({ benchmark: need(argv, '--benchmark'), system: need(argv, '--system'), reader: need(argv, '--reader'), items, cache: cache.dir, work: resolve(need(argv, '--work')), argv });
      log(`run: ${r.bought} rows bought, ${r.fresh} already fresh${unknownLine(r.unknown)}`);
      return r.unknown.length ? 1 : 0;
    }
    default: throw new Error('usage: leader.ts plan|import|run --cache <dir> ...');
  }
}

if (import.meta.main) main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
