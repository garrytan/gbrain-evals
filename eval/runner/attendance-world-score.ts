/**
 * Keyless scorer for W3, the attendance world (docs/benchmarks/2026-10-06-attendance-world-preregistration.md).
 * Reads N9 receipts (one-hop "Who attended <meeting>?" rows and composed
 * attendance families) and scores them against the attendee list on each
 * meeting page of the corpus the receipt ran on, never against gbrain output.
 *
 * Usage: bun eval/runner/attendance-world-score.ts --receipt <n9 receipt.json> --corpus <dir> [--json]
 */
import { readFileSync } from 'node:fs';
import { buildRelationalQueries, loadWorldCorpus, type RichPage } from './queries/relational.ts';

export const FIRE_FLOOR = 0.8;
export const ATTENDANCE_SPLITS = ['one-hop-template', 'one-hop-paraphrase'] as const;
export const ATTENDANCE_FAMILIES = ['meeting_investors', 'investor_founder_meetings'] as const;

interface PerQuery { seed: number; query_id: string; split: string; template: string; fired: boolean; seeds_resolved: number; relevant?: string[]; relational_slugs?: string[]; on: { recall_at_5?: number } | null; off: { recall_at_5?: number } | null; error: string | null }
interface Perturbation { meeting: string; kind: 'added' | 'removed'; person: string }

export interface SplitScore {
  runs: number;
  seed_resolved: number;
  fired: number;
  fire_rate: number;
  /** (run, person) pairs the relational arm returned for a meeting whose page list does not name the person. */
  false_attendance: Array<{ seed: number; meeting: string; person: string }>;
  recall_at_5_off: number;
  recall_at_5_on: number;
  errors: number;
  missing_fields: number;
  meets_fire_floor: boolean;
}

export interface PerturbedScore { meeting: string; kind: 'added' | 'removed'; person: string; runs: number; fired: number; person_returned: number }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Query id → meeting slug for the one-hop attendance questions, rebuilt from the corpus the receipt ran on. */
export function attendanceQueryMeetings(pages: RichPage[]): Map<string, string> {
  const titleToSlug = new Map(pages.filter(p => p._facts.type === 'meeting').map(p => [p.title, p.slug]));
  const out = new Map<string, string>();
  for (const q of buildRelationalQueries(pages)) {
    const m = /^Who attended (.+)\?$/.exec(q.text);
    if (m && titleToSlug.has(m[1]!)) out.set(q.id, titleToSlug.get(m[1]!)!);
  }
  return out;
}

export function scoreAttendance(receipt: { data?: { one_hop?: { per_query?: PerQuery[] } | null; composed?: { by_split_family?: Record<string, Record<string, unknown>> } } }, pages: RichPage[], perturbations: readonly Perturbation[] = []) {
  const meetings = attendanceQueryMeetings(pages);
  const list = new Map(pages.filter(p => p._facts.type === 'meeting').map(p => [p.slug, new Set(p._facts.attendees ?? [])]));
  const people = new Set(pages.filter(p => p._facts.type === 'person').map(p => p.slug));
  const rows = (receipt.data?.one_hop?.per_query ?? []).filter(r => r.template === 'attended');
  const meetingOf = (r: PerQuery) => meetings.get(r.query_id.replace(/-p$/, ''));
  const bySplit = Object.fromEntries(ATTENDANCE_SPLITS.map(split => {
    const rs = rows.filter(r => r.split === split);
    const fired = rs.filter(r => r.fired).length;
    const fa: SplitScore['false_attendance'] = [];
    for (const r of rs) {
      const m = meetingOf(r);
      if (!m) continue;
      for (const s of r.relational_slugs ?? []) if (people.has(s) && !list.get(m)!.has(s)) fa.push({ seed: r.seed, meeting: m, person: s });
    }
    const score: SplitScore = {
      runs: rs.length, seed_resolved: rs.filter(r => r.seeds_resolved > 0).length, fired, fire_rate: rs.length ? fired / rs.length : 0,
      false_attendance: fa, recall_at_5_off: mean(rs.map(r => r.off?.recall_at_5 ?? 0)), recall_at_5_on: mean(rs.map(r => r.on?.recall_at_5 ?? 0)),
      errors: rs.filter(r => r.error).length, missing_fields: rs.filter(r => !r.relational_slugs || !meetingOf(r)).length,
      meets_fire_floor: rs.length > 0 && fired / rs.length >= FIRE_FLOOR,
    };
    return [split, score];
  })) as Record<(typeof ATTENDANCE_SPLITS)[number], SplitScore>;
  const perturbed: Record<string, PerturbedScore[]> = Object.fromEntries(ATTENDANCE_SPLITS.map(split => [split, perturbations.map(p => {
    const rs = rows.filter(r => r.split === split && meetingOf(r) === p.meeting);
    return { ...p, runs: rs.length, fired: rs.filter(r => r.fired).length, person_returned: rs.filter(r => (r.relational_slugs ?? []).includes(p.person)).length };
  })]));
  const faithful = (split: string) => {
    const pm = new Set(perturbations.map(p => p.meeting));
    const rs = rows.filter(r => r.split === split && !pm.has(meetingOf(r) ?? ''));
    return { runs: rs.length, fired: rs.filter(r => r.fired).length, fire_rate: rs.length ? rs.filter(r => r.fired).length / rs.length : 0 };
  };
  const composed = Object.fromEntries(Object.entries(receipt.data?.composed?.by_split_family ?? {}).map(([split, fams]) => [split, Object.fromEntries(ATTENDANCE_FAMILIES.filter(f => f in fams).map(f => [f, fams[f]]))]));
  return {
    by_split: bySplit,
    faithful_meetings: Object.fromEntries(ATTENDANCE_SPLITS.map(s => [s, faithful(s)])),
    perturbed_meetings: perturbed,
    composed_attendance_families: composed,
    gate: {
      fire_floor: FIRE_FLOOR,
      every_split_meets_fire_floor: ATTENDANCE_SPLITS.every(s => bySplit[s].meets_fire_floor),
      false_attendance: ATTENDANCE_SPLITS.reduce((n, s) => n + bySplit[s].false_attendance.length, 0),
    },
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const receiptPath = flag('--receipt');
  const corpus = flag('--corpus');
  if (!receiptPath || !corpus) { console.error('usage: bun eval/runner/attendance-world-score.ts --receipt <n9 receipt.json> --corpus <dir> [--json]'); process.exit(2); }
  const pages = loadWorldCorpus(corpus);
  let perturbations: Perturbation[] = [];
  try { perturbations = (JSON.parse(readFileSync(`${corpus}/_attendees-ledger.json`, 'utf8')) as { perturbations: Perturbation[] }).perturbations; } catch { /* world-v1 has no perturbations */ }
  const s = scoreAttendance(JSON.parse(readFileSync(receiptPath, 'utf8')), pages, perturbations);
  if (argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0); }
  for (const split of ATTENDANCE_SPLITS) {
    const b = s.by_split[split];
    console.log(`${split}: fired ${b.fired}/${b.runs} (${(b.fire_rate * 100).toFixed(1)}%), seed resolved ${b.seed_resolved}, false attendance ${b.false_attendance.length}, recall@5 off ${b.recall_at_5_off.toFixed(3)} on ${b.recall_at_5_on.toFixed(3)}`);
  }
  console.log(`gate: every split fires on at least ${FIRE_FLOOR * 100}% of runs: ${s.gate.every_split_meets_fire_floor}; false attendance: ${s.gate.false_attendance}`);
}
