/**
 * Page attributes and filters for the filtered vector search experiment
 * (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md, "Build and data" and "Cells").
 *
 * Each page gets four ranks in [0, 1), one per attribute (type, frontmatter tag, date, source). In independent mode a
 * rank is a hash of the page id. In clustered mode pages are ordered by the locality-sensitive bucket of their first
 * chunk's vector (a per-attribute seeded order of the 256 buckets, ties broken by the hash), so a filter selects whole
 * regions of the vector space. The attribute values come from the rank, so a share s of pages has each level.
 */

export const SHARES = [0.001, 0.01, 0.05, 0.2, 0.5] as const;
export const SHARE_LABELS = ['0.1', '1', '5', '20', '50'] as const;
export const LSH_BITS = 8;
export const MODES = ['independent', 'clustered'] as const;
export type Mode = (typeof MODES)[number];
export type Attribute = 'type' | 'tag' | 'date' | 'source';
export const ATTRIBUTES: Attribute[] = ['type', 'tag', 'date', 'source'];

/** 32-bit integer hash of a list of integers (murmur3 finalizer over a running mix). */
export function hash32(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const part of parts) {
    let k = Math.imul(part | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h = Math.imul(h ^ Math.imul(k, 0x1b873593), 5) + 0xe6546b64;
    h = (h << 13) | (h >>> 19);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export const unit = (...parts: number[]) => hash32(...parts) / 2 ** 32;

/** Seeded uniform generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** `count` seeded Gaussian projection vectors of `dims` dimensions, for the bucket of a vector. */
export function lshProjections(seed: number, dims: number, count = LSH_BITS): number[][] {
  const next = rng(hash32(seed, 0x15a));
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return Array.from({ length: count }, () => Array.from({ length: dims }, gauss));
}

const ATTRIBUTE_SALT: Record<Attribute, number> = { type: 1, tag: 2, date: 3, source: 4 };

/**
 * Ranks in [0, 1) for every page of `pageIds` (in that order). `buckets` is null in independent mode; in clustered
 * mode it holds each page's bucket (0 to 2^LSH_BITS - 1).
 */
export function attributeRanks(pageIds: ArrayLike<number>, buckets: ArrayLike<number> | null, seed: number, attribute: Attribute): Float64Array {
  const salt = ATTRIBUTE_SALT[attribute];
  const n = pageIds.length;
  const out = new Float64Array(n);
  if (!buckets) {
    for (let i = 0; i < n; i++) out[i] = unit(seed, salt, pageIds[i]!);
    return out;
  }
  const order = Array.from({ length: n }, (_, i) => i);
  const bucketKey = (b: number) => hash32(seed, salt, 0xb0c, b);
  order.sort((a, b) => bucketKey(buckets[a]!) - bucketKey(buckets[b]!) || hash32(seed, salt, pageIds[a]!) - hash32(seed, salt, pageIds[b]!) || pageIds[a]! - pageIds[b]!);
  order.forEach((page, rank) => { out[page] = (rank + 0.5) / n; });
  return out;
}

/** Index of the share band a rank falls in (bands laid end to end: 0.1%, then 1%, 5%, 20%, 50%), or -1 for the rest. */
export function band(u: number): number {
  let start = 0;
  for (let i = 0; i < SHARES.length; i++) {
    if (u >= start && u < start + SHARES[i]!) return i;
    start += SHARES[i]!;
  }
  return -1;
}

export const typeValue = (u: number) => { const b = band(u); return b < 0 ? 'note' : `fv-t${SHARE_LABELS[b]}`; };
export const tagValue = (u: number) => { const b = band(u); return b < 0 ? 'none' : `t${SHARE_LABELS[b]}`; };

export const DATE_START_MS = Date.UTC(2020, 0, 1);
export const DATE_SPAN_DAYS = 2190;
const DAY_MS = 86_400_000;
/** Whole-minute timestamps keep the date filter's share exact to well under one page in 100,000. */
export const dateFor = (u: number) => new Date(DATE_START_MS + Math.floor(u * DATE_SPAN_DAYS * 1440) * 60_000).toISOString();
/** `afterDate` that selects the share `s` of pages with the latest dates. */
export const afterDateFor = (s: number) => new Date(DATE_START_MS + Math.floor((1 - s) * DATE_SPAN_DAYS * 1440) * 60_000 - 1).toISOString();
export const sourceValue = (u: number) => (u < 0.01 ? 'fv-s01' : u < 0.04 ? 'fv-s03' : u < 0.5 ? 'fv-s46' : 'fv-s50');
export const SOURCES = ['fv-s01', 'fv-s03', 'fv-s46', 'fv-s50'] as const;
/** A page is private when its visibility draw is at or above this: 10% of pages. */
export const PRIVATE_FROM = 0.9;

export interface PageAttributes { type: string; tag: string; date: string; source: string; private: boolean }

export function pageAttributes(ranks: Record<Attribute, number>, vis: number): PageAttributes {
  return { type: typeValue(ranks.type), tag: tagValue(ranks.tag), date: dateFor(ranks.date), source: sourceValue(ranks.source), private: vis >= PRIVATE_FROM };
}

export interface FilterSpec {
  id: string;
  kind: 'type' | 'date' | 'where' | 'combo' | 'scope' | 'sanity';
  /** Nominal share of pages selected; the run records the measured share. */
  share: number;
  /** The arms run different settings only for affected filters. */
  affected: boolean;
  opts: Record<string, unknown>;
  matches: (page: PageAttributes) => boolean;
}

export function filters(): FilterSpec[] {
  const out: FilterSpec[] = [];
  SHARES.forEach((share, i) => {
    const label = SHARE_LABELS[i]!;
    out.push({ id: `type-${label}`, kind: 'type', share, affected: true, opts: { type: `fv-t${label}` }, matches: p => p.type === `fv-t${label}` });
    const after = afterDateFor(share);
    out.push({ id: `date-${label}`, kind: 'date', share, affected: true, opts: { afterDate: after }, matches: p => p.date > after });
    out.push({ id: `where-${label}`, kind: 'where', share, affected: true, opts: { where: { fv_tag: [`t${label}`] } }, matches: p => p.tag === `t${label}` });
  });
  const after50 = afterDateFor(0.5);
  out.push({ id: 'type-20+date-50', kind: 'combo', share: 0.1, affected: true, opts: { type: 'fv-t20', afterDate: after50 }, matches: p => p.type === 'fv-t20' && p.date > after50 });
  out.push({ id: 'scope-1', kind: 'scope', share: 0.01, affected: true, opts: { sourceIds: ['fv-s01'] }, matches: p => p.source === 'fv-s01' });
  out.push({ id: 'scope-3', kind: 'scope', share: 0.03, affected: true, opts: { sourceIds: ['fv-s03'] }, matches: p => p.source === 'fv-s03' });
  out.push({ id: 'none', kind: 'sanity', share: 1, affected: false, opts: {}, matches: () => true });
  out.push({ id: 'scope-50', kind: 'sanity', share: 0.5, affected: false, opts: { sourceIds: ['fv-s50'] }, matches: p => p.source === 'fv-s50' });
  return out;
}

export const CALLERS = ['trusted', 'untrusted'] as const;
export type Caller = (typeof CALLERS)[number];
export const callerOpts = (caller: Caller): Record<string, unknown> => (caller === 'untrusted' ? { excludePrivate: true } : {});
export const callerSees = (caller: Caller, page: PageAttributes) => caller === 'trusted' || !page.private;
