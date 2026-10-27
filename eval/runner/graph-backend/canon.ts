/**
 * Canonical digests of walk results, so arms can be compared call by call
 * without storing every result.
 *
 * - h_full: the whole answer. traverseGraph: every (slug, source, depth,
 *   title, type, per-node links) row; traversePathsDetailed: every
 *   (from, to, link type, depth) edge plus the truncated flag.
 * - h_set: the distinct answer without depths: distinct slugs, or distinct
 *   (from, to, link type) edges. Used for A vs B, where the old walk can list a
 *   page or edge at more than one depth.
 */
import { createHash } from 'node:crypto';

export interface GraphNodeLike { slug: string; source_id: string; title: string; type: string; depth: number; links: { to_slug: string; link_type: string }[] }
export interface GraphPathLike { from_slug: string; from_source_id: string; to_slug: string; to_source_id: string; link_type: string; depth: number }

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export function canonGraph(rows: GraphNodeLike[]) {
  const full = rows.map(r => `${r.slug}|${r.source_id}|${Number(r.depth)}|${r.title}|${r.type}|${[...new Set(r.links.map(l => `${l.to_slug}:${l.link_type}`))].sort().join(',')}`).sort();
  const set = [...new Set(rows.map(r => r.slug))].sort();
  return { n: rows.length, n_distinct: set.length, max_depth: rows.reduce((m, r) => Math.max(m, Number(r.depth)), 0), h_full: sha(full.join('\n')), h_set: sha(set.join('\n')) };
}

export function canonPaths(res: { paths: GraphPathLike[]; truncated: boolean }) {
  const full = res.paths.map(p => `${p.from_slug}|${p.from_source_id}|${p.to_slug}|${p.to_source_id}|${p.link_type}|${Number(p.depth)}`).sort();
  const set = [...new Set(res.paths.map(p => `${p.from_slug}|${p.to_slug}|${p.link_type}`))].sort();
  return { n: res.paths.length, n_distinct: set.length, truncated: res.truncated, max_depth: res.paths.reduce((m, p) => Math.max(m, Number(p.depth)), 0), h_full: sha(full.join('\n') + `|truncated=${res.truncated}`), h_set: sha(set.join('\n')) };
}
