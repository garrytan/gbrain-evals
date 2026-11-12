/**
 * The SOTA loop's outcome cache: what a reader did on one item once given only the gold evidence (an oracle row), or once
 * run as the strongest system we have for that benchmark (a leader row: the whole-history reader on LongMemEval, the
 * grep agent on BEAM). Attribution reads it and never buys a row; the paid runs (oracle.ts, leader.ts) write it.
 *
 *   bun eval/runner/sota/cache.ts check --cache <dir> --spec <spec.json> --items <ids.txt>
 *   bun eval/runner/sota/cache.ts status --cache <dir>
 *
 * A row is keyed like the nightly judge cache: its slot (kind, benchmark, item, system, reader) and every input its
 * verdict depends on (KEY_FIELDS: the system's code version, the reader's effort and output limit, the judge and its
 * prompt version, the pass threshold, the dataset pin, the answerability file the item's class came from and the
 * harness digest), plus the digest of the evidence or context the reader saw. A lookup against the current inputs (a
 * Spec) finds a row measured on exactly those inputs (hit), finds none in the slot (unknown: left out of recoverable
 * points and counted in the report), or finds only rows measured on other inputs (stale). A stale lookup never falls
 * back to the old row: check exits 6 with SOTA_CACHE_STALE, the inputs that changed, the command that re-buys the rows
 * and the paid-window request it needs, projected from the stale rows' recorded tokens at today's list prices.
 *
 * Rows live in <dir>/<kind>/<benchmark>.ndjson, appended and never rewritten in place, so a row measured on older
 * inputs stays as history and a return to those inputs finds it again. Only public and synthetic items are written
 * here (the Captain drive's handoffs/GBEV-56/nightly/sota-cache/); a sealed id refuses the write, and sealed rows stay
 * in custody.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chatPrice } from '../budget-ledger.ts';
import { assertNoSealedIds } from './sealed-guard.ts';

export const CACHE_SCHEMA = 'sota-cache/1';
export const STALE_EXIT = 6;
export type Kind = 'oracle' | 'leader';

/** The inputs a row's verdict depends on, besides its slot and the evidence it saw; any difference makes it stale. */
export const KEY_FIELDS = ['system_version', 'effort', 'max_tokens', 'judge', 'judge_prompt', 'pass_threshold', 'dataset', 'validator_version', 'harness_digest'] as const;
export type KeyField = typeof KEY_FIELDS[number];

/** The current inputs for one (kind, benchmark, system, reader): what a fresh row must have been measured on. */
export interface Spec {
  kind: Kind; benchmark: string; system: string; reader: string;
  system_version: string; effort: string | null; max_tokens: number; judge: string; judge_prompt: string; pass_threshold: number;
  dataset: string; validator_version: string; harness_digest: string;
}

export interface Usage { reader_input: number; reader_output: number; judge_input: number; judge_output: number }

export interface Row extends Spec {
  schema: typeof CACHE_SCHEMA;
  item: string;
  /** SHA-256 of the exact evidence (oracle) or context (leader) the reader was given. */
  context_digest: string;
  score: number | null;
  /** score >= pass_threshold; null when there is no verdict (an empty answer stopped at its output limit). */
  pass: boolean | null;
  finish_reason: string | null;
  usage: Usage | null;
  at: string;
  source: string;
}

export type Lookup = { status: 'hit'; row: Row } | { status: 'unknown' } | { status: 'stale'; row: Row; changed: string[] };

const slotOf = (r: { kind: Kind; benchmark: string; system: string; reader: string }, item: string) => [r.kind, r.benchmark, r.system, r.reader, item].join('\u0000');

export class OutcomeCache {
  private loaded = new Map<string, Row[]>();
  constructor(readonly dir: string) {}

  private file(kind: Kind, benchmark: string) { return join(this.dir, kind, `${benchmark}.ndjson`); }

  rows(kind: Kind, benchmark: string): Row[] {
    const path = this.file(kind, benchmark);
    if (!this.loaded.has(path)) {
      const rows = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Row) : [];
      for (const r of rows) if (r.schema !== CACHE_SCHEMA || r.kind !== kind || r.benchmark !== benchmark) throw new Error(`${path}: a row that is not a ${CACHE_SCHEMA} ${kind} row for ${benchmark}`);
      this.loaded.set(path, rows);
    }
    return this.loaded.get(path)!;
  }

  /** Appends rows (all of one kind and benchmark), refusing a sealed id and a row whose verdict disagrees with its score. */
  put(rows: Row[]): void {
    if (!rows.length) return;
    const { kind, benchmark } = rows[0]!;
    for (const r of rows) {
      if (r.kind !== kind || r.benchmark !== benchmark) throw new Error('put takes rows of one kind and benchmark');
      const expected = r.score === null ? null : r.score >= r.pass_threshold;
      if (r.pass !== null && r.pass !== expected) throw new Error(`${r.item}: pass ${r.pass} disagrees with score ${r.score} at threshold ${r.pass_threshold}`);
    }
    const path = this.file(kind, benchmark);
    const text = rows.map(r => JSON.stringify({ ...r, schema: CACHE_SCHEMA })).join('\n') + '\n';
    assertNoSealedIds(text, path);
    const prior = existsSync(path) ? readFileSync(path, 'utf8') : '';
    mkdirSync(join(this.dir, kind), { recursive: true });
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, prior + text);
    renameSync(tmp, path);
    this.loaded.delete(path);
  }

  /**
   * The row for one item measured on the spec's inputs (the newest, if several), else unknown or stale. contextDigest,
   * when the caller can compute it, must match too; attribution, which has no evidence text, passes none and relies on
   * the dataset pin.
   */
  lookup(spec: Spec, item: string, contextDigest?: string): Lookup {
    const slot = slotOf(spec, item);
    const rows = this.rows(spec.kind, spec.benchmark).filter(r => slotOf(r, r.item) === slot);
    if (!rows.length) return { status: 'unknown' };
    const differs = (r: Row) => [...KEY_FIELDS.filter(f => r[f] !== spec[f]), ...(contextDigest !== undefined && r.context_digest !== contextDigest ? ['context_digest'] : [])];
    const fresh = rows.filter(r => !differs(r).length);
    if (fresh.length) return { status: 'hit', row: fresh[fresh.length - 1]! };
    const newest = rows[rows.length - 1]!;
    return { status: 'stale', row: newest, changed: differs(newest) };
  }
}

export interface Freshness { spec: Spec; hits: Map<string, Row>; unknown: string[]; stale: Array<{ item: string; row: Row; changed: string[] }> }

/** Looks up every item for one spec. */
export function freshness(cache: OutcomeCache, spec: Spec, items: readonly string[]): Freshness {
  const out: Freshness = { spec, hits: new Map(), unknown: [], stale: [] };
  for (const item of items) {
    const l = cache.lookup(spec, item);
    if (l.status === 'hit') out.hits.set(item, l.row);
    else if (l.status === 'unknown') out.unknown.push(item);
    else out.stale.push({ item, row: l.row, changed: l.changed });
  }
  return out;
}

/** The paid-window unit a re-buy runs in, such as SOTA-REBUY-ORACLE-BEAM-1M. */
export const rebuyUnit = (spec: Spec) => `SOTA-REBUY-${spec.kind}-${spec.benchmark}`.toUpperCase();

/** The command that re-buys a spec's rows for the items listed in itemsFile. */
export function rebuyCommand(spec: Spec, itemsFile: string, cacheDir: string): string {
  return [`bun eval/runner/sota/${spec.kind}.ts run`, '--benchmark', spec.benchmark, ...(spec.kind === 'leader' ? ['--system', spec.system] : []), '--reader', spec.reader,
    '--items', itemsFile, '--cache', cacheDir, '--work', '<work dir>', '--paid', '--budget-ledger', '<window ledger>', '--budget-run-id', '<window run>'].join(' ');
}

const usd = (model: string, input: number, output: number) => {
  const p = chatPrice(model);
  return p ? (input * p.input + output * p.output) / 1e6 : null;
};

/**
 * A projected cap for re-buying the stale rows: their recorded reader and judge tokens at today's list prices, plus a
 * quarter for retries and longer answers. Null when no stale row recorded usage or a model has no list price.
 */
export function projectUsd(spec: Spec, stale: Freshness['stale']): number | null {
  const costs = stale.map(({ row }) => {
    if (!row.usage) return null;
    const reader = usd(spec.reader, row.usage.reader_input, row.usage.reader_output), judge = usd(spec.judge, row.usage.judge_input, row.usage.judge_output);
    return reader === null || judge === null ? null : reader + judge;
  });
  if (!costs.length || costs.some(c => c === null)) return null;
  return Math.ceil((costs as number[]).reduce((a, b) => a + b, 0) * 1.25 * 100) / 100;
}

/** The SOTA_CACHE_STALE message: what changed (cached value and current value, with the row count), the re-buy command and the window request, or for A4's imported oracle rows the keyless re-import. */
export function staleMessage(f: Freshness, itemsFile: string, cacheDir: string): string {
  const { spec } = f;
  const fields = new Map<string, { from: Set<string>; count: number }>();
  for (const s of f.stale) for (const k of s.changed) {
    const e = fields.get(k) ?? { from: new Set<string>(), count: 0 };
    e.from.add(String((s.row as unknown as Record<string, unknown>)[k]));
    e.count++;
    fields.set(k, e);
  }
  const now = (k: string) => (k === 'context_digest' ? '(the evidence now built)' : String(spec[k as KeyField]));
  const cap = projectUsd(spec, f.stale);
  const what = [
    `SOTA_CACHE_STALE: ${f.stale.length} ${spec.kind} row${f.stale.length === 1 ? '' : 's'} for ${spec.benchmark}, system ${spec.system}, reader ${spec.reader} were measured on other inputs`,
    ...[...fields].map(([k, e]) => `  changed ${k}: ${[...e.from].sort().join(', ')} -> ${now(k)} (${e.count} rows)`),
  ];
  if (spec.system_version === 'a4-oracle-gpt61sol') return [...what, `  re-import: bun eval/runner/sota/oracle.ts import-a4 --cache ${cacheDir} (A4's answers are imported keyless, never bought, so no paid window is needed)`].join('\n');
  return [
    ...what,
    `  re-buy: ${rebuyCommand(spec, itemsFile, cacheDir)}`,
    cap === null
      ? `  paid window: PAID WINDOW REQUEST ${rebuyUnit(spec)} <cap> (${f.stale.length} rows; no recorded usage or list price to project from, so size the cap with a one-item smoke)`
      : `  paid window: PAID WINDOW REQUEST ${rebuyUnit(spec)} ${cap.toFixed(2)} (${f.stale.length} rows; their recorded tokens at today's list prices, plus 25%)`,
  ].join('\n');
}

/** Writes the items a re-buy needs, one per line, under <cache>/rebuy/, and returns the path. */
export function writeRebuyItems(cacheDir: string, spec: Spec, items: readonly string[]): string {
  const path = join(cacheDir, 'rebuy', `${rebuyUnit(spec).toLowerCase()}-${spec.system}-${spec.reader.replace(/[^a-z0-9.-]+/gi, '_')}.txt`);
  const text = [...items].sort().join('\n') + '\n';
  assertNoSealedIds(text, path);
  mkdirSync(join(cacheDir, 'rebuy'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const need = (argv: string[], name: string) => { const v = flag(argv, name); if (!v) throw new Error(`pass ${name}`); return v; };

/** The command line; returns the exit code (6 when any spec has stale rows). */
export function main(argv: string[], log: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const cacheDir = resolve(need(argv, '--cache'));
  const cache = new OutcomeCache(cacheDir);
  if (argv[0] === 'status') {
    for (const kind of ['oracle', 'leader'] as const) {
      if (!existsSync(join(cacheDir, kind))) continue;
      for (const f of readdirSync(join(cacheDir, kind)).filter(n => n.endsWith('.ndjson')).sort()) log(`${kind} ${f.replace(/\.ndjson$/, '')}: ${cache.rows(kind, f.replace(/\.ndjson$/, '')).length} rows`);
    }
    return 0;
  }
  if (argv[0] !== 'check') throw new Error('usage: cache.ts check --cache <dir> --spec <spec.json> --items <ids.txt> | status --cache <dir>');
  const specs = [JSON.parse(readFileSync(need(argv, '--spec'), 'utf8'))].flat() as Spec[];
  const items = readFileSync(need(argv, '--items'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  let stale = 0;
  for (const spec of specs) {
    const f = freshness(cache, spec, items);
    log(`${spec.kind} ${spec.benchmark} ${spec.system} ${spec.reader}: ${f.hits.size} fresh, ${f.unknown.length} unknown, ${f.stale.length} stale`);
    if (!f.stale.length) continue;
    stale++;
    err(staleMessage(f, writeRebuyItems(cacheDir, spec, f.stale.map(s => s.item)), cacheDir));
  }
  return stale ? STALE_EXIT : 0;
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
