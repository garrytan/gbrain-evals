/**
 * Eval-only HydraDB adapter for gbrain's two graph walks (GBRA-123).
 *
 * Talks to a HydraDB graph-node over its HTTP query API only. Vertex id = gbrain
 * page id. The projection holds, for every link type in the fixture's fixed
 * mapping table, a forward relationship T_<TYPE> (from -> to) and a reversed
 * one R_<TYPE> (to -> from), plus catch-all LINK / LINK_R over every link.
 * Reversed types exist because HydraDB's subset rejects incoming patterns in
 * variable-length MATCH and in batched UNWIND reads, so an incoming walk is an
 * outgoing walk over the reversed type.
 *
 * Results reproduce gbrain's breadth-first semantics and caps (see the
 * preregistration): each page once at its minimum depth, layers filled in
 * (slug, id) order (= id order in this fixture) up to TRAVERSE_WALK_ROW_CAP,
 * edges once at one past their shallower walked endpoint, ordered by
 * (depth, from, to) and cut at TRAVERSE_PATH_ROW_CAP. Page metadata (slug,
 * source, title, type) is hydrated from Postgres so the call returns gbrain's
 * shape.
 */
import { LINK_TYPES } from './generate.ts';

export const WALK_CAP = 20_000;
export const PATH_CAP = 5_000;
export const BATCH = 1_000;
export const PAGE_SIZE = 4_096;

const upper = (t: string) => t.toUpperCase();
export const relFwd = (ti: number) => `T_${upper(LINK_TYPES[ti])}`;
export const relRev = (ti: number) => `R_${upper(LINK_TYPES[ti])}`;
export const typeIndex = (t: string) => {
  const i = (LINK_TYPES as readonly string[]).indexOf(t);
  if (i < 0) throw new Error(`link type ${t} is not in the fixture mapping table`);
  return i;
};

export interface HydraConfig { url: string; token: string; graph: string; namespace: string; cell: string; concurrency: number }

export class HydraError extends Error {}

export class HydraClient {
  requests = 0;
  constructor(readonly cfg: HydraConfig) {}

  async query(query: string, parameters?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown[][]> {
    const base: Record<string, unknown> = { cell_id: this.cfg.cell, query, page_size: PAGE_SIZE };
    if (parameters) base.parameters = parameters;
    let body = base;
    const rows: unknown[][] = [];
    for (;;) {
      this.requests++;
      const res = await fetch(`${this.cfg.url}/v1/graphs/${this.cfg.graph}/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.token}`, 'x-graph-namespace': this.cfg.namespace, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let json: { rows?: unknown[][]; error?: { code: string; message: string }; next_cursor?: unknown; query_id?: string };
      try { json = JSON.parse(text); } catch { throw new HydraError(`HTTP ${res.status}: ${text.slice(0, 300)}`); }
      if (json.error) throw new HydraError(`${json.error.code}: ${json.error.message}`);
      if (!res.ok || !Array.isArray(json.rows)) throw new HydraError(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      for (const r of json.rows) rows.push(r);
      if (json.next_cursor === null || json.next_cursor === undefined) return rows;
      body = { ...base, cursor: json.next_cursor, query_id: json.query_id };
    }
  }

  /** Run tasks with at most cfg.concurrency in flight. */
  async pool<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const out: T[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } };
    await Promise.all(Array.from({ length: Math.min(this.cfg.concurrency, tasks.length) }, worker));
    return out;
  }

  /** One-hop neighbours of every id over each relationship: [src, dst, relIndex] triples. */
  async expand(ids: number[], rels: string[], signal?: AbortSignal): Promise<Array<[number, number, number]>> {
    const tasks: Array<() => Promise<Array<[number, number, number]>>> = [];
    for (let ri = 0; ri < rels.length; ri++) {
      for (let lo = 0; lo < ids.length; lo += BATCH) {
        const rows = ids.slice(lo, lo + BATCH).map(id => ({ id }));
        const rel = rels[ri];
        tasks.push(async () => {
          const res = await this.query(`UNWIND $rows AS row MATCH (a {id: row.id})-[:${rel}]->(b) RETURN row.id AS src, b.id AS dst`, { rows }, signal);
          return res.map(r => [Number((r[0] as { value: number }).value), Number((r[1] as { value: number }).value), ri] as [number, number, number]);
        });
      }
    }
    return (await this.pool(tasks)).flat();
  }

  /** Pages at walk distance exactly d from seed over rel, for each d in 1..maxDepth. */
  async perDepth(seed: number, maxDepth: number, rel: string, signal?: AbortSignal): Promise<Set<number>[]> {
    const tasks = Array.from({ length: maxDepth }, (_, i) => async () => {
      const d = i + 1;
      const rows = await this.query(`MATCH (a {id: $s})-[:${rel}*${d}..${d}]->(b) RETURN DISTINCT b.id AS id`, { s: seed }, signal);
      return new Set(rows.map(r => Number((r[0] as { value: number }).value)));
    });
    return this.pool(tasks);
  }
}

export interface PageMeta { slug: string; source_id: string; title: string; type: string }
export type Hydrate = (ids: number[]) => Promise<Map<number, PageMeta>>;

export type WalkStrategy = 'layer' | 'perdepth';

export class HydraWalker {
  constructor(readonly hydra: HydraClient, readonly hydrate: Hydrate, readonly strategy: WalkStrategy = 'layer') {}

  /** gbrain traverseGraph(slug, depth) for a page id: out-walk over every link type. */
  async traverseGraph(seed: number, depth: number, signal?: AbortSignal) {
    const allFwd = LINK_TYPES.map((_, i) => relFwd(i));
    const order: number[] = [seed];
    const depthOf = new Map<number, number>([[seed, 0]]);
    const out = new Map<number, Array<[number, number]>>();
    const expanded = new Set<number>();
    const fetchOut = async (ids: number[]) => {
      const triples = await this.hydra.expand(ids, allFwd, signal);
      for (const id of ids) { expanded.add(id); if (!out.has(id)) out.set(id, []); }
      for (const [s, d, ti] of triples) out.get(s)!.push([d, ti]);
      return triples;
    };
    const addLayer = (cands: number[], d: number) => {
      const next = [...new Set(cands)].filter(id => !depthOf.has(id)).sort((a, b) => a - b).slice(0, Math.max(0, WALK_CAP + 1 - order.length));
      for (const id of next) { depthOf.set(id, d); order.push(id); }
      return next;
    };
    if (this.strategy === 'perdepth') {
      const layers = await this.hydra.perDepth(seed, depth, 'LINK', signal);
      for (let d = 1; d <= depth && order.length <= WALK_CAP; d++) if (addLayer([...layers[d - 1]].filter(id => id !== seed), d).length === 0) break;
    } else {
      let frontier = [seed];
      for (let d = 1; d <= depth && frontier.length > 0 && order.length <= WALK_CAP; d++) {
        const triples = await fetchOut(frontier);
        frontier = addLayer(triples.map(t => t[1]), d);
      }
    }
    const kept = order.slice(0, WALK_CAP);
    const need = kept.filter(id => !expanded.has(id));
    if (need.length) await fetchOut(need);
    const ids = new Set<number>(kept);
    for (const id of kept) for (const [d] of out.get(id)!) ids.add(d);
    const meta = await this.hydrate([...ids]);
    const rows = kept.map(id => {
      const m = meta.get(id)!;
      const links = new Map<string, { to_slug: string; link_type: string }>();
      for (const [d, ti] of out.get(id)!) {
        const to_slug = meta.get(d)!.slug;
        links.set(`${to_slug}|${ti}`, { to_slug, link_type: LINK_TYPES[ti] });
      }
      return { slug: m.slug, source_id: m.source_id, title: m.title, type: m.type, depth: depthOf.get(id)!, links: [...links.values()] };
    });
    rows.sort((a, b) => a.depth - b.depth || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) || (a.source_id < b.source_id ? -1 : 1));
    return rows;
  }

  /** gbrain traversePathsDetailed(slug, { depth, direction, linkType }) for a page id. */
  async traversePaths(seed: number, depth: number, direction: 'out' | 'in' | 'both', linkType: string | null, signal?: AbortSignal) {
    const types = linkType === null ? LINK_TYPES.map((_, i) => i) : [typeIndex(linkType)];
    const rels: string[] = [];
    const relInfo: Array<{ ti: number; reversed: boolean }> = [];
    if (direction !== 'in') for (const ti of types) { rels.push(relFwd(ti)); relInfo.push({ ti, reversed: false }); }
    if (direction !== 'out') for (const ti of types) { rels.push(relRev(ti)); relInfo.push({ ti, reversed: true }); }
    const visited = new Set<number>([seed]);
    const nodeDepth = new Map<number, number>([[seed, 0]]);
    let walked = 1;
    const edges: Array<[number, number, number, number]> = [];
    if (this.strategy === 'perdepth' && direction !== 'both') {
      const walkRel = linkType === null ? (direction === 'out' ? 'LINK' : 'LINK_R') : rels[0];
      const layers = depth > 1 ? await this.hydra.perDepth(seed, depth - 1, walkRel, signal) : [];
      const byDepth: number[][] = [[seed]];
      for (let d = 1; d < depth && walked <= WALK_CAP; d++) {
        const next = [...layers[d - 1]].filter(id => !visited.has(id)).sort((x, y) => x - y).slice(0, Math.max(0, WALK_CAP + 1 - walked));
        if (next.length === 0) break;
        const kept: number[] = [];
        for (const id of next) { visited.add(id); walked++; if (walked <= WALK_CAP) { nodeDepth.set(id, d); kept.push(id); } }
        byDepth.push(kept);
      }
      for (let k = 0; k < byDepth.length && edges.length <= PATH_CAP; k++) {
        if (byDepth[k].length === 0) break;
        for (const [w, x, ri] of await this.hydra.expand(byDepth[k], rels, signal)) {
          const { ti, reversed } = relInfo[ri];
          edges.push(reversed ? [x, w, ti, k + 1] : [w, x, ti, k + 1]);
        }
      }
    } else {
      let layer = [seed];
      for (let k = 0; k < depth && layer.length > 0; k++) {
        const triples = await this.hydra.expand(layer, rels, signal);
        const neighbours: number[] = [];
        for (const [w, x, ri] of triples) {
          const { ti, reversed } = relInfo[ri];
          neighbours.push(x);
          const dx = nodeDepth.get(x);
          if (!reversed) {
            if (direction === 'out' || dx === undefined || dx >= k) edges.push([w, x, ti, k + 1]);
          } else if (direction === 'in' || dx === undefined || dx > k) {
            edges.push([x, w, ti, k + 1]);
          }
        }
        if (edges.length > PATH_CAP || k + 1 >= depth) break;
        const next = [...new Set(neighbours)].filter(id => !visited.has(id)).sort((a, b) => a - b).slice(0, Math.max(0, WALK_CAP + 1 - walked));
        layer = [];
        for (const id of next) {
          visited.add(id);
          walked++;
          if (walked <= WALK_CAP) { nodeDepth.set(id, k + 1); layer.push(id); }
        }
      }
    }
    const walkTruncated = walked > WALK_CAP;
    edges.sort((a, b) => a[3] - b[3] || a[0] - b[0] || a[1] - b[1]);
    const truncated = edges.length > PATH_CAP || walkTruncated;
    const kept = edges.slice(0, PATH_CAP);
    const ids = new Set<number>();
    for (const e of kept) { ids.add(e[0]); ids.add(e[1]); }
    const meta = await this.hydrate([...ids]);
    const paths = kept.map(([f, t, ti, d]) => {
      const mf = meta.get(f)!; const mt = meta.get(t)!;
      return { from_slug: mf.slug, from_source_id: mf.source_id, to_slug: mt.slug, to_source_id: mt.source_id, link_type: LINK_TYPES[ti], context: '', depth: d };
    });
    return { paths, truncated };
  }
}
