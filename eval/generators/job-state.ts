/**
 * Job-state helpers shared by the timeline round-trip category
 * (eval/runner/temporal.ts) and the N3 temporal and as-of category
 * (eval/generators/n3-temporal-gen.ts).
 *
 * The as-of gold in both categories comes from ForwardJobState: a streaming
 * state machine that consumes a person's events in valid-time order and
 * snapshots the employer held when each query date passed. It never filters
 * or sorts the event list the way a system-side predictor does, so a storage
 * or query bug that drops, re-dates or mis-orders a job change makes the
 * prediction and the gold diverge (audit misc-runners-06).
 */

export const EVENT_TYPES = ['joined', 'announced', 'spoke at', 'hired by', 'promoted to'] as const;
export type EventType = typeof EVENT_TYPES[number];
export const JOB_CHANGE_TYPES: ReadonlySet<string> = new Set(['joined', 'hired by']);

/**
 * Normalize a timeline date to YYYY-MM-DD. gbrain types TimelineEntry.date
 * as string, but PGLite date columns can surface Date objects at runtime;
 * accept both without tripping TS2358 on a string-typed instanceof.
 */
export function dateKey(d: unknown): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** Company id ('startup-N') from a job-change summary; null for other events. */
export function jobChangeCompany(summary: string): string | null {
  const m = /^(?:joined|hired by) (startup-\d+)$/.exec(summary);
  return m ? m[1] : null;
}

/**
 * SYSTEM-side as-of predictor: over a retrieved timeline, the latest
 * job-change entry on or before asOfDate. The measured artifact is the
 * retrieved timeline; the gold comes from ForwardJobState.
 */
export function predictCompanyAsOf(
  timeline: ReadonlyArray<{ date: unknown; summary: string }>,
  asOfDate: string,
): string | null {
  let bestDate = '';
  let bestCompany: string | null = null;
  for (const t of timeline) {
    const d = dateKey(t.date);
    if (d > asOfDate) continue;
    const company = jobChangeCompany(t.summary);
    if (company === null) continue;
    if (d >= bestDate) {
      bestDate = d;
      bestCompany = company;
    }
  }
  return bestCompany;
}

/**
 * Forward job-state machine. Construct it with the query dates, feed one
 * person's events in non-decreasing date order with observe(), then read
 * finish(). A query date answers with the employer held at the END of that
 * day: an event dated on the query date counts. A query date before every
 * job change answers null ("no state yet").
 */
export class ForwardJobState {
  #current: string | null = null;
  #lastDate = '';
  readonly #pending: string[];
  readonly #answers = new Map<string, string | null>();

  constructor(queryDates: Iterable<string>) {
    this.#pending = [...new Set(queryDates)].sort();
  }

  observe(date: string, summary: string): void {
    if (date < this.#lastDate) throw new Error(`ForwardJobState: event ${date} arrived after ${this.#lastDate}; feed events in date order`);
    this.#lastDate = date;
    while (this.#pending.length > 0 && this.#pending[0] < date) this.#answers.set(this.#pending.shift()!, this.#current);
    const company = jobChangeCompany(summary);
    if (company !== null) this.#current = company;
  }

  finish(): Map<string, string | null> {
    while (this.#pending.length > 0) this.#answers.set(this.#pending.shift()!, this.#current);
    return new Map(this.#answers);
  }
}
