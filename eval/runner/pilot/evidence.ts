/**
 * Frozen evidence for the wave 1 architecture pilot (A4/A5 of the 10x memory
 * advantage plan): the W10a captures of gbrain `c5fb0201`'s own LongMemEval-S
 * reader requests (release retrieval, top 5 whole sessions), joined to their
 * harness rows. Every pilot arm starts from the same captured request, so
 * every arm sees identical evidence; only the representation delivered to
 * the reader changes.
 *
 * The evidence section of a captured user text is everything after
 * "Retrieved sessions:\n". An arm replaces that section (its "delivered
 * evidence"), keeping the question, the date line and the system text
 * byte-for-byte.
 */
import { join, resolve } from 'node:path';
import { estimateTokens } from '../../../node_modules/gbrain/src/core/chunkers/token-estimate.ts';
import { parseSessionBlocks, readNdjson, reportType, stratifiedSample, type ReaderText } from '../batch/sources.ts';
import { subsets, SEED } from '../batch/w10.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const W10A_DIR = 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin';
export const EVIDENCE_MARKER = 'Retrieved sessions:\n';
/** The pilot split's seed (the W10 round's seed plus the plan's wave number). */
export const PILOT_SEED = SEED + 1;
/** The W10 round's seed (20261006); later wave 1 seeds are offsets from it. */
export const SEED_BASE = SEED;

export interface PilotSession { session_id: string; date?: string; body: string; rank: number; gold: boolean }

export interface PilotQuestion {
  question_id: string;
  question: string;
  question_date: string;
  question_type: string;
  report_type: string;
  answer: string;
  answerable: boolean;
  answer_session_ids: string[];
  capture: ReaderText & { max_tokens: number; model: string };
  /** The user text before the evidence section ("Question: ... Retrieved sessions:\n"). */
  prefix: string;
  /** The captured evidence section, as the A0 reader receives it. */
  evidence: string;
  sessions: PilotSession[];
}

let cache: Map<string, PilotQuestion> | null = null;

/** Session body as it sits inside a captured `<chat_session>` block (already sanitized by gbrain's renderer). */
function blockBody(user: string, start: number, end: number): string {
  const block = user.slice(start, end);
  return block.slice(block.indexOf('>\n') + 2, block.length - '\n</chat_session>'.length);
}

export function loadPilotEvidence(): Map<string, PilotQuestion> {
  if (cache) return cache;
  const rows = readNdjson(join(ROOT, W10A_DIR, 'capture/harness-rows.ndjson.gz')).filter(r => typeof r.question_id === 'string');
  const caps = new Map(readNdjson(join(ROOT, W10A_DIR, 'capture/captures.ndjson.gz')).map(c => [c.question as string, c]));
  const out = new Map<string, PilotQuestion>();
  for (const r of rows) {
    const c = caps.get(r.question);
    if (!c) throw new Error(`${r.question_id}: no W10a capture for its question`);
    const user = c.user as string;
    if (!user.startsWith(`Question:\n${r.question}\n\n`)) throw new Error(`${r.question_id}: capture does not open with its question`);
    const at = user.indexOf(EVIDENCE_MARKER);
    if (at < 0) throw new Error(`${r.question_id}: capture has no evidence section`);
    const slugToRaw = new Map((r.retrieved ?? []).map((x: any) => [String(x.slug).replace(/^chat\//, ''), x.session_id as string]));
    const blocks = parseSessionBlocks(user);
    const sessions = blocks.map((b, rank) => ({
      session_id: b.id, ...(b.date ? { date: b.date } : {}), body: blockBody(user, b.start, b.end), rank,
      gold: (r.answer_session_ids ?? []).includes(slugToRaw.get(b.id)),
    }));
    out.set(r.question_id, {
      question_id: r.question_id, question: r.question, question_date: c.question_date, question_type: r.question_type,
      report_type: reportType(r as { question_id: string; question_type: string }), answer: String(r.answer),
      answerable: !String(r.question_id).endsWith('_abs'), answer_session_ids: r.answer_session_ids ?? [],
      capture: { system: c.system, user, max_tokens: c.max_tokens, model: c.model },
      prefix: user.slice(0, at + EVIDENCE_MARKER.length), evidence: user.slice(at + EVIDENCE_MARKER.length), sessions,
    });
  }
  cache = out;
  return out;
}

/**
 * The pilot split: a seeded 100-question sample stratified by report type,
 * drawn inside W10c's 150-question subset so every pilot question has a
 * committed `gpt-6.1-sol` A0 row as well as W10a's Sonnet 5.5 row. The other
 * 400 of the 500 questions are the confirm split, never read by the pilot.
 */
export function pilotSplit(): { pilot: string[]; confirm: string[]; allocation: Record<string, number> } {
  const ev = loadPilotEvidence();
  const pool = new Set(subsets.w10c150());
  const types = new Map([...ev.values()].filter(q => pool.has(q.question_id)).map(q => [q.question_id, q.report_type]));
  const { ids, allocation } = stratifiedSample(types, 100, PILOT_SEED);
  const pilot = new Set(ids);
  return { pilot: ids, confirm: [...ev.keys()].filter(id => !pilot.has(id)).sort(), allocation };
}

/** The reader text with the evidence section replaced. */
export function withEvidence(q: PilotQuestion, evidence: string): ReaderText {
  return { system: q.capture.system, user: q.prefix + evidence };
}

export const cl100k = (text: string) => estimateTokens(text);

/**
 * TRUNC@budget: whole sessions in retrieval rank order while the next one
 * fits the budget (cl100k tokens of the evidence section); when even the
 * top-ranked session does not fit, its head is cut to the budget at a line
 * boundary. Blocks are copied verbatim from the capture.
 */
export function truncEvidence(q: PilotQuestion, budget: number): { evidence: string; sessions: number; cut: boolean; tokens: number } {
  const blocks = parseSessionBlocks(q.capture.user).map(b => q.capture.user.slice(b.start, b.end));
  const kept: string[] = [];
  for (const b of blocks) {
    const next = [...kept, b].join('\n\n');
    if (cl100k(next) > budget) break;
    kept.push(b);
  }
  if (kept.length) { const evidence = kept.join('\n\n'); return { evidence, sessions: kept.length, cut: false, tokens: cl100k(evidence) }; }
  const evidence = headCut(blocks[0], budget);
  return { evidence, sessions: 1, cut: true, tokens: cl100k(evidence) };
}

/** A `<chat_session>` block cut to its head at a line boundary so the whole block fits `budget` cl100k tokens (the longest such head, by binary search over line counts). */
export function headCut(block: string, budget: number): string {
  if (cl100k(block) <= budget) return block;
  const head = block.slice(0, block.indexOf('>\n') + 2);
  const lines = block.slice(head.length, block.length - '\n</chat_session>'.length).split('\n');
  const render = (k: number) => `${head}${lines.slice(0, k).join('\n')}\n</chat_session>`;
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cl100k(render(mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  return render(lo);
}
