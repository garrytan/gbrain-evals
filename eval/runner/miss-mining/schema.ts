/**
 * Miss-mining log format. Wintermute keeps a private miss log on the box that
 * holds the brain: one JSONL line per real miss (a fact it got wrong, a page it
 * failed to find, a write that did not land). Each line holds a date, the kind of
 * ask, a cause id from eval/runner/predictive/causes.ts, how the miss was
 * detected, whether Garry noticed, and a pointer to the gold page. The ask text
 * and slugs are private and never leave the box; only weekly counts by cause,
 * ask kind and detection mode do (weekly-counts.ts, checked by custody.ts).
 * The run kit is docs/benchmarks/miss-mining/README.md.
 */
import { ALL_TYPES, type QType } from '../live-recall/scorecard.ts';
import { PRIVACY_SUBCAUSES, isCauseId, type CauseId, type PrivacySubcause } from '../predictive/causes.ts';

export const MISS_LOG_SCHEMA = 'miss-log/v1';

/** Ask kinds, from Wintermute's estimated ask mix in the GBEV-55 gap map. */
export const ASK_KINDS = [
  'ops_build', 'save_ingest', 'lookup_meeting_prep', 'drafting', 'research', 'status',
  'decision_recall', 'personal', 'tasks', 'counts_lists', 'correction', 'time_window',
] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** How a miss came to light: Garry corrected it, Wintermute found the right answer later, or a tool returned an error. */
export const DETECTION_MODES = ['garry_corrected', 'found_later', 'tool_error'] as const;
export type DetectionMode = (typeof DETECTION_MODES)[number];

export const MISS_ID = /^miss-\d{4}-\d{2}-\d{2}-\d{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface GoldPointer { slug: string; chunk_ids?: number[] }

export interface MissEntry {
  id: string;
  date: string;
  ask_kind: AskKind;
  cause: CauseId;
  /** Only with cause privacy_hidden. */
  privacy_subcause?: PrivacySubcause;
  detection: DetectionMode;
  garry_noticed: boolean;
  gold: GoldPointer[];
  /** Optional, private: the ask in its original words and a paraphrase, so the miss can become a live-recall question. */
  ask?: { exact: string; paraphrase: string };
  /** Optional, private: pages that held the superseded fact (a stale_fact miss). */
  stale?: Array<{ slug: string }>;
  /** Optional: the live-recall type to file the question under; to-live-recall.ts derives one when absent. */
  live_type?: QType;
}

export class MissMiningRefusal extends Error {
  constructor(readonly code: 'MM_LOG_INVALID' | 'MM_CUSTODY_LEAK', readonly detail: string) {
    super(code + ': ' + detail);
    this.name = 'MissMiningRefusal';
  }
}

const isDate = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Parse the private miss log. A refusal names the line and the field, never the content. */
export function parseMissLog(text: string): MissEntry[] {
  const out: MissEntry[] = [];
  const ids = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    const bad = (field: string) => new MissMiningRefusal('MM_LOG_INVALID', 'line ' + (i + 1) + ' field ' + field);
    let e: any;
    try { e = JSON.parse(raw); } catch { throw bad('json'); }
    if (typeof e?.id !== 'string' || !MISS_ID.test(e.id) || ids.has(e.id)) throw bad('id');
    if (!isDate(e.date)) throw bad('date');
    if (!(ASK_KINDS as readonly unknown[]).includes(e.ask_kind)) throw bad('ask_kind');
    if (!isCauseId(e.cause)) throw bad('cause');
    if (e.privacy_subcause !== undefined && (e.cause !== 'privacy_hidden' || !(PRIVACY_SUBCAUSES as readonly unknown[]).includes(e.privacy_subcause))) throw bad('privacy_subcause');
    if (!(DETECTION_MODES as readonly unknown[]).includes(e.detection)) throw bad('detection');
    if (typeof e.garry_noticed !== 'boolean') throw bad('garry_noticed');
    if (!Array.isArray(e.gold) || e.gold.length === 0) throw bad('gold');
    const gold = e.gold.map((g: any, j: number) => {
      if (!nonEmpty(g?.slug)) throw bad('gold[' + j + '].slug');
      if (g.chunk_ids !== undefined && (!Array.isArray(g.chunk_ids) || !g.chunk_ids.every((c: unknown) => Number.isInteger(c)))) throw bad('gold[' + j + '].chunk_ids');
      return g.chunk_ids ? { slug: g.slug, chunk_ids: g.chunk_ids } : { slug: g.slug };
    });
    if (e.ask !== undefined && (!nonEmpty(e.ask?.exact) || !nonEmpty(e.ask?.paraphrase))) throw bad('ask');
    if (e.stale !== undefined && (!Array.isArray(e.stale) || !e.stale.every((s: any) => nonEmpty(s?.slug)))) throw bad('stale');
    if (e.live_type !== undefined && !(ALL_TYPES as readonly unknown[]).includes(e.live_type)) throw bad('live_type');
    ids.add(e.id);
    out.push({
      id: e.id, date: e.date, ask_kind: e.ask_kind, cause: e.cause, detection: e.detection, garry_noticed: e.garry_noticed, gold,
      ...(e.privacy_subcause ? { privacy_subcause: e.privacy_subcause } : {}),
      ...(e.ask ? { ask: { exact: e.ask.exact, paraphrase: e.ask.paraphrase } } : {}),
      ...(e.stale ? { stale: e.stale.map((s: { slug: string }) => ({ slug: s.slug })) } : {}),
      ...(e.live_type ? { live_type: e.live_type } : {}),
    });
  });
  return out;
}

/** Every private string in a log: slugs and ask text. custody.ts scans outbound text for them. */
export function missNeedles(entries: MissEntry[]): Set<string> {
  return new Set(entries.flatMap(e => [...e.gold.map(g => g.slug), ...(e.stale ?? []).map(s => s.slug), ...(e.ask ? [e.ask.exact, e.ask.paraphrase] : [])]));
}
