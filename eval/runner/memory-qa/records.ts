/**
 * Q1 scoreboard records (PLAN §4.4): answers, judgments and rows as
 * immutable, append-only NDJSON files that every lane reads and writes
 * through this module.
 *
 *   answers.ndjson    one record per reader answer, keyed by `answer_id`
 *                     (sha256 of `cell_id|question_id|reader|replicate`),
 *                     with the full answer text, never truncated;
 *   judgments.ndjson  one record per judge verdict on a fixed answer, keyed
 *                     by answer, instrument hash, judge and judge replicate;
 *   rows.ndjson       the memory-qa retrieval row (`MemoryQaRow`) extended
 *                     with the realization, delivered tokens per tokenizer,
 *                     fill rate, packing loss, provenance and fan-out.
 *
 * Immutability (answers and judgments): a log refuses a second record under an existing key unless
 * it is byte-identical (then the append is a no-op, so a restarted run can
 * replay its writes). A torn last line from a killed process (no trailing
 * newline, not valid JSON) is dropped on open and on read; every other
 * malformed line is an error naming its line number.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProvenanceStatus } from '../systems/types.ts';
import type { PackingLoss } from '../systems/render.ts';
import { OUTCOMES, type Outcome } from './outcomes.ts';
import type { MemoryQaRow } from './run.ts';

export { OUTCOMES };

export interface Usage { input: number; output: number; cache_read: number; cache_write: number }

/** Mirrors eval/runner/q1/hedge.ts HEDGE_VERDICTS without importing it, so the classifier stays out of the cell's executed tree. */
const HEDGE_VERDICTS = ['abstain', 'hedged', 'confident'] as const;
type HedgeVerdict = (typeof HEDGE_VERDICTS)[number];

export interface AnswerRecord {
  answer_id: string;
  cell_id: string;
  realization_id: string;
  question_id: string;
  conversation: string;
  system: string;
  arm: string;
  reader: string;
  /** Reader replicate, 0-based. */
  replicate: number;
  /** Reasoning effort sent with the request (null when the reader takes none). */
  effort: string | null;
  /** `PackedContext.context_sha256` of the prompt the reader read. */
  context_sha256: string;
  /** The full answer text. */
  text: string;
  usage: Usage;
  /** The provider's own input count, the truth for every reader call; null when the provider reported none. */
  provider_input_tokens: number | null;
  latency_ms: number;
  outcome: Outcome;
  /** Answering agents (file agent, agent runtime): why the agent stopped (`submitted`, `turn_cap`, `context_overflow`, ...). */
  stop_reason?: string;
  /** Answering agents: model turns taken. */
  turns?: number;
  /** Answering agents: the ingested source ids whose files the agent opened (evaluator side). */
  opened_source_ids?: string[];
  /** Dollars the answer cost, when the caller priced it. */
  usd?: number;
  /**
   * A hedge verdict stamped by cells run before the classifier left the cell's executed tree; no longer written. Read
   * for back-compatibility only: the scoreboard ignores it and computes verdicts at render time (cells/<id>/derived/hedge.ndjson).
   */
  hedge?: { verdict: HedgeVerdict; classifier_version: string };
  /** Evidence the reader was given: the packed context's per-tokenizer counts (component arms) or `{ reader_input }`, the reader's total input tokens (whole-system arms). */
  delivered_tokens?: Record<string, number>;
}

/**
 * The answer an answering system returns (`AgentAnswer` in
 * eval/runner/systems/file-agent.ts is assignable to it); the cell adds the
 * identity fields to make an `AnswerRecord`.
 */
export type AnswerPayload = Pick<AnswerRecord, 'text' | 'outcome' | 'usage' | 'latency_ms'> & { provider_input_tokens: number | null; stop_reason?: string; turns?: number; opened_source_ids?: string[]; usd?: number; delivered_tokens?: Record<string, number> };

/** An answer record from a system's answer and the cell's identity fields; the id is derived, never passed. */
export function answerRecord(identity: Omit<AnswerRecord, 'answer_id' | keyof AnswerPayload>, a: AnswerPayload & { error?: string }): AnswerRecord {
  const { error: _error, ...payload } = a;
  return { answer_id: answerId(identity.cell_id, identity.question_id, identity.reader, identity.replicate), ...identity, ...payload };
}

export interface JudgmentRecord {
  answer_id: string;
  instrument_id: string;
  instrument_sha256: string;
  judge: string;
  /** 0 is the canonical judgment; repeats count up from 1. */
  judge_replicate: number;
  /** The temperature sent; null when the judge accepts only its default temperature. */
  temperature: number | null;
  /** 0..1; null when the judgment failed. */
  score: number | null;
  parse_ok: boolean;
  /** sha256 of JSON.stringify(raw), the judge outputs in call order. */
  raw_sha256: string;
  outcome: 'scored' | 'judge_error';
  /** The judge outputs in call order; omit outside custody when they may quote sealed text. */
  raw?: string[];
  /** Instrument-specific breakdown (per-rubric scores, event-ordering tau). */
  detail?: Record<string, unknown>;
}

export interface Q1RowFields {
  cell_id: string;
  realization_id: string;
  recall_any_at_10?: number;
  /** Raw evidence-block measure per tokenizer (`PackedContext.delivered`). */
  delivered_tokens: Record<string, number>;
  /** Largest reader count over the token budget; null without a budget. */
  fill_rate: number | null;
  packing_loss: PackingLoss | null;
  /** The weakest provenance among returned items; `none` when nothing was returned. */
  provenance_status: ProvenanceStatus | 'none';
  fanout: { mean: number; max: number };
}

export type Q1Row = MemoryQaRow & Q1RowFields;

export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export const answerId = (cellId: string, questionId: string, reader: string, replicate: number) => sha256(`${cellId}|${questionId}|${reader}|${replicate}`);

export const judgmentKey = (j: Pick<JudgmentRecord, 'answer_id' | 'instrument_sha256' | 'judge' | 'judge_replicate'>) => `${j.answer_id}|${j.instrument_sha256}|${j.judge}|${j.judge_replicate}`;

export const rawSha256 = (raw: readonly string[]) => sha256(JSON.stringify(raw));

// ─── Shape checks ────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
type Check = (v: unknown) => boolean;
const str: Check = v => typeof v === 'string' && v.length > 0;
const int: Check = v => Number.isInteger(v) && (v as number) >= 0;
const num: Check = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hex: Check = v => typeof v === 'string' && HEX64.test(v);
const nullable = (c: Check): Check => v => v === null || c(v);

function check(kind: string, rec: unknown, fields: Record<string, Check>, extra: (r: Record<string, unknown>) => string[] = () => []): string[] {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [`${kind} is not an object`];
  const r = rec as Record<string, unknown>;
  return [...Object.entries(fields).filter(([k, c]) => !c(r[k])).map(([k]) => `${kind}.${k} is missing or invalid`), ...extra(r)];
}

export function answerProblems(rec: unknown): string[] {
  return check('answer', rec, {
    answer_id: hex, cell_id: str, realization_id: str, question_id: str, conversation: str, system: str, arm: str, reader: str, replicate: int,
    effort: nullable(str), context_sha256: hex, text: v => typeof v === 'string', provider_input_tokens: nullable(int), latency_ms: num,
    outcome: v => OUTCOMES.includes(v as Outcome),
    usage: v => !!v && typeof v === 'object' && ['input', 'output', 'cache_read', 'cache_write'].every(k => int((v as Record<string, unknown>)[k])),
    stop_reason: v => v === undefined || str(v), turns: v => v === undefined || int(v), usd: v => v === undefined || num(v),
    opened_source_ids: v => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string')),
    hedge: v => v === undefined || (!!v && typeof v === 'object' && HEDGE_VERDICTS.includes((v as Record<string, unknown>).verdict as HedgeVerdict) && str((v as Record<string, unknown>).classifier_version)),
    delivered_tokens: v => v === undefined || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(int)),
  }, r => typeof r.cell_id === 'string' && typeof r.question_id === 'string' && typeof r.reader === 'string' && Number.isInteger(r.replicate)
    && r.answer_id !== answerId(r.cell_id, r.question_id, r.reader, r.replicate as number) ? ['answer.answer_id is not sha256(cell_id|question_id|reader|replicate)'] : []);
}

export function judgmentProblems(rec: unknown): string[] {
  return check('judgment', rec, {
    answer_id: hex, instrument_id: str, instrument_sha256: hex, judge: str, judge_replicate: int, temperature: nullable(num),
    score: nullable(v => typeof v === 'number' && v >= 0 && v <= 1), parse_ok: v => typeof v === 'boolean', raw_sha256: hex,
    outcome: v => v === 'scored' || v === 'judge_error',
  }, r => [
    ...(r.outcome === 'scored' && (r.score === null || r.parse_ok !== true) ? ['judgment: a scored judgment needs a score and parse_ok'] : []),
    ...(r.outcome === 'judge_error' && r.score !== null ? ['judgment: a failed judgment has a null score, never a "no"'] : []),
    ...(Array.isArray(r.raw) && r.raw_sha256 !== rawSha256(r.raw as string[]) ? ['judgment.raw_sha256 does not match raw'] : []),
  ]);
}

export function rowProblems(rec: unknown): string[] {
  return check('row', rec, {
    id: str, cell_id: str, realization_id: str, fill_rate: nullable(num),
    delivered_tokens: v => !!v && typeof v === 'object' && Object.values(v as object).every(int),
    packing_loss: v => v === null || (!!v && typeof v === 'object'),
    provenance_status: v => ['exact', 'partial', 'unavailable', 'none'].includes(v as string),
    fanout: v => !!v && typeof v === 'object' && num((v as Record<string, unknown>).mean) && num((v as Record<string, unknown>).max),
  });
}

// ─── Logs ────────────────────────────────────────────────────────────

export type RecordKind = 'answer' | 'judgment' | 'row';
type RecordOf<K extends RecordKind> = K extends 'answer' ? AnswerRecord : K extends 'judgment' ? JudgmentRecord : Q1Row;
const PROBLEMS: Record<RecordKind, (r: unknown) => string[]> = { answer: answerProblems, judgment: judgmentProblems, row: rowProblems };

/** Immutable kinds and their keys. Rows are not here: memory-qa rewrites them canonically (latest attempt wins, outcomes.ts). */
export type ImmutableKind = 'answer' | 'judgment';
const KEYS: { [K in ImmutableKind]: (r: RecordOf<K>) => string } = { answer: r => r.answer_id, judgment: judgmentKey };

/** Parse an NDJSON record file; a torn last line is ignored, any other bad line throws with its number. */
export function readRecords<K extends RecordKind>(path: string, kind: K): Array<RecordOf<K>> {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const out: Array<RecordOf<K>> = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const torn = i === lines.length - 1;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch (e) {
      if (torn) return;
      throw new Error(`${path}:${i + 1}: not JSON (${(e as Error).message})`);
    }
    const problems = PROBLEMS[kind](rec);
    if (problems.length) throw new Error(`${path}:${i + 1}: ${problems.join('; ')}`);
    out.push(rec as RecordOf<K>);
  });
  return out;
}

/** An append-only, key-unique record file. */
export class RecordLog<K extends ImmutableKind> {
  private byKey = new Map<string, string>();

  constructor(readonly path: string, readonly kind: K) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      const cut = text.lastIndexOf('\n') + 1;
      if (cut < text.length) {
        let torn = false;
        try { JSON.parse(text.slice(cut)); } catch { torn = true; }
        if (torn) truncateSync(path, Buffer.byteLength(text.slice(0, cut)));
        else appendFileSync(path, '\n');
      }
      for (const r of readRecords(path, kind)) this.remember(r);
    }
  }

  private remember(r: RecordOf<K>): void {
    const key = KEYS[this.kind](r as never);
    const json = JSON.stringify(r);
    const prior = this.byKey.get(key);
    if (prior !== undefined && prior !== json) throw new Error(`${this.path}: two different ${this.kind} records share key ${key}`);
    this.byKey.set(key, json);
  }

  has(key: string): boolean { return this.byKey.has(key); }
  get(key: string): RecordOf<K> | undefined { const j = this.byKey.get(key); return j === undefined ? undefined : JSON.parse(j); }
  get size(): number { return this.byKey.size; }
  all(): Array<RecordOf<K>> { return [...this.byKey.values()].map(j => JSON.parse(j)); }

  /** Append one record; `exists` when an identical record is already there, an error when a different one is. */
  append(rec: RecordOf<K>): 'appended' | 'exists' {
    const problems = PROBLEMS[this.kind](rec);
    if (problems.length) throw new Error(`refusing to write an invalid ${this.kind}: ${problems.join('; ')}`);
    const key = KEYS[this.kind](rec as never);
    const json = JSON.stringify(rec);
    const prior = this.byKey.get(key);
    if (prior === json) return 'exists';
    if (prior !== undefined) throw new Error(`${this.path}: ${this.kind} ${key} is immutable; a different record already exists`);
    appendFileSync(this.path, json + '\n');
    this.byKey.set(key, json);
    return 'appended';
  }
}
