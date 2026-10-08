/**
 * The sanitizer in front of every memory system (plan contract 5).
 *
 * Only opaque ids, dated text and speaker roles cross it:
 *   namespace  `ns-` + sha256(salt, conversation id)[0:16]; LongMemEval's
 *              conversation id is the question id and carries `_abs`, so it
 *              never leaves the harness;
 *   source     `src-` + the corpus occurrence id (corpus.ts `occurrenceId`),
 *              the same id gbrain's page slug uses;
 *   question   `PublicQuestion` (text and date), never id or category.
 *
 * The reverse maps stay evaluator-side. `forbiddenMarkers` lists raw ids,
 * category names and the abstention marker that must never appear in a
 * captured request (HTTP body, prompt, filename, metadata); a marker that
 * occurs in the corpus text itself is left out, since sessions legitimately
 * carry their own words. `findLeaks` is the tripwire both the HTTP client
 * and the metering proxy run.
 */
import { createHash } from 'node:crypto';
import { isoSessionDate, occurrenceId, type Conversation, type Corpus, type MemoryQuestion, type Session } from '../memory-qa/corpus.ts';
import type { PublicQuestion, SessionInput, Turn } from './types.ts';

export const NS_RE = /^ns-[0-9a-f]{16}$/;
export const SRC_RE = /^src-[0-9a-f]{16}$/;

export class SanitizerLeakError extends Error {
  constructor(readonly where: string, readonly count: number) {
    super(`${where}: ${count} forbidden marker(s) would leave the harness; the request was not sent`);
    this.name = 'SanitizerLeakError';
  }
}

export const opaqueNamespace = (salt: string, conversation: string) => `ns-${createHash('sha256').update(`shootout-ns\u0000${salt}\u0000${conversation}`).digest('hex').slice(0, 16)}`;
export const opaqueSourceId = (conversation: string, session: string) => `src-${occurrenceId(conversation, session)}`;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * An event time as ISO 8601 (minute precision, no zone), or null when the
 * dataset's form is unknown. Beyond the forms `isoSessionDate` reads
 * (LoCoMo, LongMemEval, ISO), BEAM's `March-15-2024` reads as that day at
 * midnight. The legacy gbrain pages keep the raw string.
 */
export function eventTimeOf(session: Session): string | null {
  const beam = session.date?.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/);
  if (beam && MONTHS.includes(beam[1].toLowerCase())) return `${beam[3]}-${String(MONTHS.indexOf(beam[1].toLowerCase()) + 1).padStart(2, '0')}-${beam[2].padStart(2, '0')}T00:00:00`;
  const iso = isoSessionDate(session.date);
  if (!iso) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso;
}

const addMinutes = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 19)}Z`);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + n * 60_000).toISOString().slice(0, 19);
};

export interface IngestStep { session: Session; input: SessionInput; event_time: string | null; synthetic_time: boolean }

function roleOf(speaker: string): Turn['role'] {
  const s = speaker.toLowerCase();
  return s === 'assistant' || s === 'system' ? s : 'user';
}

/** Every substring of `text` that equals a marker (case-sensitive), deduplicated. */
export function findLeaks(text: string, markers: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of markers) if (m && text.includes(m) && !out.includes(m)) out.push(m);
  return out;
}

/**
 * Raw ids, categories and the abstention marker for a corpus. A candidate
 * shorter than six characters, or one that appears as a word in the sessions'
 * own text or in any question text, is dropped so honest traffic never trips
 * it. Words split on anything but letters, digits, `_`, `:` and `-`; one pass
 * over the corpus, so a LongMemEval haystack set stays linear.
 */
export function forbiddenMarkers(corpus: Pick<Corpus, 'conversations' | 'questions'>): string[] {
  const candidates = new Set<string>();
  for (const c of corpus.conversations) { candidates.add(c.id); for (const s of c.sessions) candidates.add(s.id); }
  for (const q of corpus.questions) { candidates.add(q.id); candidates.add(q.category); for (const g of q.gold) candidates.add(g); }
  const words = new Set<string>();
  let abs = false;
  const scan = (text: string) => {
    if (!abs && text.includes('_abs')) abs = true;
    for (const w of text.split(/[^A-Za-z0-9_:-]+/)) if (w.length >= 6 && candidates.has(w)) words.add(w);
  };
  for (const c of corpus.conversations) for (const s of c.sessions) for (const t of s.turns) { scan(t.speaker); scan(t.content); }
  for (const q of corpus.questions) scan(q.question);
  const out = [...candidates].filter(m => m.length >= 6 && !words.has(m));
  if (!abs) out.push('_abs');
  return out.sort();
}

export class Sanitizer {
  private nsToConv = new Map<string, string>();
  private srcToSession = new Map<string, { conversation: string; session: string }>();
  readonly markers: string[];

  constructor(private corpus: Pick<Corpus, 'conversations' | 'questions'>, private salt: string) {
    for (const c of corpus.conversations) {
      this.nsToConv.set(opaqueNamespace(salt, c.id), c.id);
      for (const s of c.sessions) this.srcToSession.set(opaqueSourceId(c.id, s.id), { conversation: c.id, session: s.id });
    }
    this.markers = forbiddenMarkers(corpus);
  }

  ns(conversation: string): string { return opaqueNamespace(this.salt, conversation); }
  source(conversation: string, session: string): string { return opaqueSourceId(conversation, session); }

  /** The dataset session behind an opaque source id, or undefined when it is not a source of that namespace. */
  sessionOf(ns: string, sourceId: string): string | undefined {
    const hit = this.srcToSession.get(sourceId);
    return hit && this.nsToConv.get(ns) === hit.conversation ? hit.session : undefined;
  }

  session(conversation: string, s: Session): SessionInput {
    return { source_id: this.source(conversation, s.id), turns: s.turns.map(t => ({ role: roleOf(t.speaker), speaker: t.speaker, content: t.content })) };
  }

  /**
   * The question as a system sees it. A dataset that dates no questions
   * (LoCoMo) is asked at `fallback`, the latest event time of the
   * conversation, the same date the reader prompt falls back to.
   */
  question(q: MemoryQuestion, fallback: string | null = null): PublicQuestion {
    const iso = q.question_date ? isoSessionDate(q.question_date) : null;
    return { text: q.question, query_time: iso ? (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso) : fallback };
  }

  /**
   * Sessions in ingestion order: by event time, ties and undated sessions in
   * dataset order. An undated session gets a disclosed synthetic time one
   * minute after the previous dated one (or before the first dated one), and
   * is counted; a conversation with no dates at all keeps null times.
   */
  ingestPlan(conv: Conversation): IngestStep[] {
    const times = conv.sessions.map(eventTimeOf);
    const firstKnown = times.findIndex(t => t !== null);
    let last: string | null = null;
    const steps = conv.sessions.map((session, i) => {
      let t = times[i];
      let synthetic = false;
      if (t === null && firstKnown >= 0) {
        t = i < firstKnown ? addMinutes(times[firstKnown]!, i - firstKnown) : last ? addMinutes(last, 1) : null;
        synthetic = t !== null;
      }
      if (t) last = t;
      return { session, input: this.session(conv.id, session), event_time: t, synthetic_time: synthetic, order: i };
    });
    steps.sort((a, b) => (a.event_time ?? '') === (b.event_time ?? '') ? a.order - b.order : (a.event_time ?? '') < (b.event_time ?? '') ? -1 : 1);
    return steps.map(({ order: _order, ...s }) => s);
  }

  /** Throws when `text` carries a forbidden marker; the leak count is reported, never the marker. */
  assertClean(text: string, where: string): void {
    const leaks = findLeaks(text, this.markers);
    if (leaks.length) throw new SanitizerLeakError(where, leaks.length);
  }
}
