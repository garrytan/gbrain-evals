/**
 * Shared helpers for the messy-company-v1 lane scorers: gold loading,
 * value normalization, Wilson intervals and a fixed report format.
 *
 * Every scorer reads a system's output as one JSON file in the shape its
 * header documents (also in eval/data/messy-company-v1/SCORING.md) and
 * prints counts with a 95% Wilson interval for each rate.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export const DATASET = join(import.meta.dir, '../../data/messy-company-v1');
export type Split = 'dev' | 'heldout';

export function loadGold<T = Record<string, any>>(lane: string, split: Split, root = DATASET): T[] {
  return readFileSync(join(root, 'labels', lane, `${split}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
}

export function wilson(k: number, n: number, z = 1.959963984540054): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export interface Metric { name: string; k: number; n: number; rate: number | null; ci95: [number, number] | null; note?: string }
export const metric = (name: string, k: number, n: number, note?: string): Metric => ({ name, k, n, rate: n ? k / n : null, ci95: n ? wilson(k, n) : null, ...(note ? { note } : {}) });

export interface Report { lane: string; split: Split; view?: string; metrics: Metric[]; breakdown?: Record<string, Metric[]>; extra?: Record<string, unknown> }

export function formatReport(r: Report): string {
  const f = (m: Metric) => `  ${m.name.padEnd(42)} ${String(m.k).padStart(5)} / ${String(m.n).padEnd(5)} ${m.rate === null ? '   n/a' : (100 * m.rate).toFixed(1).padStart(5) + '%'}${m.ci95 ? `  [${(100 * m.ci95[0]).toFixed(1)}, ${(100 * m.ci95[1]).toFixed(1)}]` : ''}${m.note ? `  (${m.note})` : ''}`;
  const out = [`[messy-company] lane=${r.lane} split=${r.split}${r.view ? ` view=${r.view}` : ''}`, ...r.metrics.map(f)];
  for (const [k, ms] of Object.entries(r.breakdown ?? {})) out.push(`  by ${k}:`, ...ms.map(m => '  ' + f(m)));
  for (const [k, v] of Object.entries(r.extra ?? {})) out.push(`  ${k}: ${JSON.stringify(v)}`);
  return out.join('\n');
}

export const normText = (s: string) => s.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').toLowerCase().replace(/\s+/g, ' ').trim();

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Gold-vs-answer value match: dates by calendar day, numbers by value, text by normalized containment. */
export function sameValue(gold: unknown, got: unknown): boolean {
  if (got === null || got === undefined || got === '') return false;
  const g = String(gold), s = String(got);
  if (/^\d{4}-\d\d-\d\d$/.test(g)) return isoDate(s) === g;
  if (/^\d+(\.\d+)?$/.test(g)) {
    const nums = (s.replace(/,/g, '').match(/\d+(\.\d+)?/g) ?? []).map(Number);
    return nums.length > 0 && nums[0] === Number(g);
  }
  const n = (x: string) => normText(x).replace(/[^a-z0-9$%. ]/g, ' ').replace(/\s+/g, ' ').trim();
  return n(s) === n(g) || n(s).includes(n(g));
}

export const setEq = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); return A.size === B.size && [...A].every(x => B.has(x)); };

export function group<T>(rows: T[], key: (r: T) => string, ok: (r: T) => boolean): Metric[] {
  const m = new Map<string, [number, number]>();
  for (const r of rows) { const k = key(r); const v = m.get(k) ?? [0, 0]; v[1]++; if (ok(r)) v[0]++; m.set(k, v); }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, [ok_, n]]) => metric(k, ok_, n));
}

export interface Cli { split: Split; system: any; json: boolean; view: 'full' | 'public' }
export function parseCli(argv = process.argv.slice(2)): Cli {
  const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const split = (val('--split') ?? 'dev') as Split;
  const file = val('--system');
  if (!file || !['dev', 'heldout'].includes(split)) {
    console.error('usage: --split dev|heldout --system <output.json> [--view full|public] [--json]');
    process.exit(2);
  }
  return { split, system: JSON.parse(readFileSync(file, 'utf8')), json: argv.includes('--json'), view: (val('--view') ?? 'full') as 'full' | 'public' };
}

export function emit(r: Report, json: boolean) {
  console.log(json ? JSON.stringify(r, null, 2) : formatReport(r));
}
