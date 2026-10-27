/**
 * Seeded fictional link graphs for the graph-backend benchmark (GBRA-123).
 *
 * Every page is fictional: slug `p/NNNNNNN` with id order equal to slug order,
 * one of three fictional sources, type `note`. Edges follow a power law with
 * hubs: source rank floor(N * u^2), target rank floor(N * u^3), mapped to page
 * ids through one seeded permutation so hubs have high in- and out-degree and
 * are spread across the id order. No self loops and at most one link per
 * ordered (from, to) pair, so gbrain's (depth, from_slug, to_slug) row order is
 * a total order and its caps truncate deterministically.
 */
import { createHash } from 'node:crypto';

export const SEED = 20261017;
export const TIERS = {
  personal: { pages: 10_000, links: 60_000, salt: 1 },
  team: { pages: 100_000, links: 1_000_000, salt: 2 },
  company: { pages: 1_000_000, links: 10_000_000, salt: 3 },
} as const;
export type Tier = keyof typeof TIERS;

export const LINK_TYPES = ['works_with', 'works_at', 'invested_in', 'advises', 'founded', 'mentions'] as const;
const LINK_TYPE_SHARE = [0.3, 0.2, 0.15, 0.15, 0.1, 0.1];
export const SOURCES = ['src-alpha', 'src-beta', 'src-gamma'] as const;
export const FILTER_LINK_TYPE = 'works_with';

export function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const slugOf = (id: number) => `p/${String(id).padStart(7, '0')}`;

export interface Graph {
  tier: Tier;
  pages: number;
  /** source index per page id (index 0 unused) */
  source: Uint8Array;
  from: Int32Array;
  to: Int32Array;
  /** index into LINK_TYPES */
  type: Uint8Array;
  edgeSha256: string;
  hubs: number[];
  starts: number[];
  calibration: number[];
}

export function generate(tier: Tier): Graph {
  const { pages: n, links: m, salt } = TIERS[tier];
  const rand = mulberry32(SEED * 7 + salt);
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i + 1;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const source = new Uint8Array(n + 1);
  for (let id = 1; id <= n; id++) source[id] = Math.floor(rand() * SOURCES.length);
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  const type = new Uint8Array(m);
  const seen = new Set<number>();
  const cum = LINK_TYPE_SHARE.map((_, i) => LINK_TYPE_SHARE.slice(0, i + 1).reduce((a, b) => a + b, 0));
  let k = 0;
  while (k < m) {
    const f = perm[Math.floor(n * rand() ** 2)];
    const t = perm[Math.floor(n * rand() ** 3)];
    const r = rand();
    if (f === t) continue;
    const key = f * (n + 1) + t;
    if (seen.has(key)) continue;
    seen.add(key);
    from[k] = f; to[k] = t;
    let ti = cum.findIndex(c => r < c);
    if (ti < 0) ti = LINK_TYPES.length - 1;
    type[k] = ti;
    k++;
  }
  seen.clear();
  const h = createHash('sha256');
  h.update(Buffer.from(from.buffer)); h.update(Buffer.from(to.buffer)); h.update(Buffer.from(type.buffer));
  const degree = new Int32Array(n + 1);
  for (let i = 0; i < m; i++) { degree[from[i]]++; degree[to[i]]++; }
  const byDegree = Array.from({ length: n }, (_, i) => i + 1).sort((a, b) => degree[b] - degree[a] || a - b);
  const hubCount = Math.ceil(n * 0.01);
  const hubs = byDegree.slice(0, hubCount);
  const pick = (pool: number[], count: number, exclude: Set<number>) => {
    const out: number[] = [];
    const taken = new Set<number>();
    while (out.length < count) {
      const v = pool[Math.floor(rand() * pool.length)];
      if (taken.has(v) || exclude.has(v)) continue;
      taken.add(v); out.push(v);
    }
    return out;
  };
  const rest = byDegree.slice(hubCount);
  const starts = [...pick(hubs, 50, new Set()), ...pick(rest, 450, new Set())];
  for (let i = starts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = starts[i]; starts[i] = starts[j]; starts[j] = t;
  }
  const used = new Set(starts);
  const calibration = [...pick(hubs, 2, used), ...pick(rest, 18, used)];
  return { tier, pages: n, source, from, to, type, edgeSha256: h.digest('hex'), hubs, starts, calibration };
}

export type Call =
  | { id: string; start: number; kind: 'traverseGraph'; depth: number }
  | { id: string; start: number; kind: 'traversePaths'; depth: number; direction: 'out' | 'in' | 'both'; linkType: string | null };

/** The 22 calls per start page, in one seeded order over the whole list. */
export function callsFor(starts: number[], seed = SEED): Call[] {
  const calls: Call[] = [];
  for (const s of starts) {
    for (const depth of [1, 2, 3, 5]) calls.push({ id: `tg:${s}:${depth}`, start: s, kind: 'traverseGraph', depth });
    for (const direction of ['out', 'in', 'both'] as const)
      for (const linkType of [null, FILTER_LINK_TYPE])
        for (const depth of [1, 2, 3])
          calls.push({ id: `tp:${s}:${direction}:${linkType ?? 'all'}:${depth}`, start: s, kind: 'traversePaths', depth, direction, linkType });
  }
  const rand = mulberry32(seed + 99);
  for (let i = calls.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = calls[i]; calls[i] = calls[j]; calls[j] = t;
  }
  return calls;
}

export function cellOf(c: Call): string {
  return c.kind === 'traverseGraph' ? `traverseGraph:d${c.depth}` : `traversePaths:${c.direction}:${c.linkType ?? 'all'}:d${c.depth}`;
}

if (import.meta.main) {
  const tier = (process.argv[2] ?? 'personal') as Tier;
  const t0 = performance.now();
  const g = generate(tier);
  console.log(JSON.stringify({ tier, pages: g.pages, links: g.from.length, edgeSha256: g.edgeSha256, hubs: g.hubs.length, starts: g.starts.length, ms: Math.round(performance.now() - t0) }));
}
