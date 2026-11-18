/**
 * Entity-resolution head-to-head: the smoke world, the neutral readout and its scoring.
 *
 * Every system reads the same pages: instance 0 of every family in the person-dedupe ledger
 * (eval/generators/person-dedupe-gen.ts) at a seed and per-family count, so each family's designed pairs stay whole.
 * A system's decision comes back in one neutral shape, scored by the person-dedupe scorer against the ledger
 * restricted to those pages:
 *
 *   { system, version, config, model, tiers: { auto: [[pageKey, ...]], proposed: [[pageKey, ...]] } }
 *
 * Page keys are "<source_id>:<slug>", as the scorer keys pages. `auto` groups pages the system treats as one entity;
 * `proposed` is a review band (empty where the system has none). The scorer closes groups transitively.
 *
 * A memory system reports entity nodes, not page groups, so readoutFromEntities maps each page to the node its subject
 * (the page's title person) became: among the nodes the page's source mentions, the one whose name best matches the
 * title (subjectOf). Pages whose subjects share a node, or whose nodes an `auto` link joins, form one auto group.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asciiFold, deriveGold, generateLedger, ledgerFingerprint, pageKey, type Ledger } from '../../generators/person-dedupe-gen.ts';
import { scoreGroups, type Group, type Score } from '../person-dedupe.ts';

export interface SmokePage { key: string; source: string; slug: string; title: string; path: string }
export interface Readout { system: string; version: string; config: Record<string, unknown>; model: string; tiers: { auto: string[][]; proposed: string[][] } }
export interface EntityNode { id: string; name: string | null; type: string | null; source_ids: string[]; provenance_status: string }
export interface EntityLink { a: string; b: string; kind: string; tier: 'auto' | 'proposed'; score: number | null }
export interface EntitiesResponse { entities: EntityNode[]; links: EntityLink[]; notes?: string }

export const SMOKE_PER_FAMILY = 2;

/** Instance 0 of every family, in ledger order, with the file `person-dedupe.ts --write-world` wrote for each. */
export function smokePages(ledger: Ledger, worldDir: string): SmokePage[] {
  return ledger.pages.filter(p => p.instance === 0).map(p => ({ key: pageKey(p), source: p.source, slug: p.slug, title: p.title, path: join(worldDir, p.source, 'people', `${p.slug}.md`) }));
}

/** Opaque ids for the shim protocol (ns-<16 hex>, src-<16 hex>), stable for a run label and page key. */
export const opaque = (prefix: 'ns' | 'src', ...parts: string[]) => `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)}`;

const tokens = (s: string) => asciiFold(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

/** How well a node name matches a page title: 3 same folded name, 2 same surname and first initial, else token overlap. */
export function nameMatch(title: string, name: string): number {
  const t = tokens(title), n = tokens(name);
  if (!t.length || !n.length) return 0;
  if (t.join(' ') === n.join(' ')) return 3;
  if (t.at(-1) === n.at(-1) && t[0][0] === n[0][0]) return 2;
  const inter = t.filter(x => n.includes(x)).length;
  return inter / new Set([...t, ...n]).size;
}

/** The node a page's subject became: the best name match among the nodes its source mentions, if any scores 0.5 or more. */
export function subjectOf(title: string, candidates: readonly EntityNode[]): { node: EntityNode; match: number } | null {
  let best: { node: EntityNode; match: number } | null = null;
  for (const node of candidates) {
    const m = nameMatch(title, node.name ?? '');
    const person = /person/i.test(node.type ?? '') ? 0.01 : 0;
    if (m >= 0.5 && (!best || m + person > best.match + (/person/i.test(best.node.type ?? '') ? 0.01 : 0))) best = { node, match: m };
  }
  return best;
}

export interface SubjectRow { key: string; source_id: string; title: string; node: string | null; node_name: string | null; match: number | null }

export function readoutFromEntities(pages: readonly SmokePage[], sourceOf: ReadonlyMap<string, string>, res: EntitiesResponse, meta: Omit<Readout, 'tiers'>): { readout: Readout; subjects: SubjectRow[] } {
  const bySource = new Map<string, EntityNode[]>();
  for (const e of res.entities) for (const s of e.source_ids) bySource.set(s, [...(bySource.get(s) ?? []), e]);
  const subjects = pages.map(p => {
    const src = sourceOf.get(p.key)!;
    const hit = subjectOf(p.title, bySource.get(src) ?? []);
    return { key: p.key, source_id: src, title: p.title, node: hit?.node.id ?? null, node_name: hit?.node.name ?? null, match: hit ? Math.round(hit.match * 100) / 100 : null };
  });
  const pagesOf = new Map<string, string[]>();
  for (const s of subjects) if (s.node) pagesOf.set(s.node, [...(pagesOf.get(s.node) ?? []), s.key]);
  const groups = (extra: EntityLink[]) => {
    const parent = new Map<string, string>();
    const find = (x: string): string => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
    for (const l of extra) { const a = find(l.a), b = find(l.b); if (a !== b) parent.set(a, b); }
    const out = new Map<string, Set<string>>();
    for (const [node, keys] of pagesOf) { const r = find(node); out.set(r, new Set([...(out.get(r) ?? []), ...keys])); }
    return [...out.values()].map(s => [...s].sort()).filter(g => g.length > 1).sort();
  };
  const auto = groups(res.links.filter(l => l.tier === 'auto'));
  const withProposed = groups(res.links);
  const autoSet = new Set(auto.map(g => g.join('|')));
  return { readout: { ...meta, tiers: { auto, proposed: withProposed.filter(g => !autoSet.has(g.join('|'))) } }, subjects };
}

/** Throws on a readout the bench cannot score: wrong keys, or a page key outside the smoke world. */
export function parseReadout(raw: unknown, known: ReadonlySet<string>): Readout {
  const r = raw as Readout;
  const keys = Object.keys(r ?? {}).sort().join(',');
  if (keys !== 'config,model,system,tiers,version') throw new Error(`entity-h2h: readout has keys ${keys}`);
  if (Object.keys(r.tiers ?? {}).sort().join(',') !== 'auto,proposed') throw new Error('entity-h2h: readout tiers must be exactly auto and proposed');
  for (const tier of ['auto', 'proposed'] as const) for (const g of r.tiers[tier]) for (const k of g) if (!known.has(k)) throw new Error(`entity-h2h: readout ${tier} names ${k}, which the smoke world does not have`);
  return r;
}

/** Scores the auto tier alone and auto plus proposed, against the ledger's pairs among the smoke pages only. */
export function scoreReadout(ledger: Ledger, pages: readonly SmokePage[], raw: unknown): Record<'auto' | 'auto+proposed', Score> {
  const keep = new Set(pages.map(p => p.key));
  const r = parseReadout(raw, keep);
  const person = new Map([...deriveGold(ledger)].filter(([k]) => keep.has(k)));
  const pairs = ledger.pairs.filter(p => keep.has(p.a) && keep.has(p.b));
  const groups = (gs: string[][], cls: string): Group[] => gs.filter(g => g.length > 1).map(members => ({ members: [...new Set(members)].sort(), kind: 'cross_source', class: cls, rules: [r.system] }));
  return {
    auto: scoreGroups(groups(r.tiers.auto, 'clean'), pairs, person),
    'auto+proposed': scoreGroups([...groups(r.tiers.auto, 'clean'), ...groups(r.tiers.proposed, 'likely')], pairs, person),
  };
}

export interface UsageTotals { calls: number; input: number; cached: number; cache_write: number; output: number; usd: number; charged_reservation: number; refused: number; by_model: Record<string, { calls: number; input: number; cached: number; output: number; usd: number }> }

/** Sums a metering proxy usage log (one line per request) per bound key. */
export function usageByKey(usageLog: string, keep: (key: string) => boolean = () => true, since = ''): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  for (const line of readFileSync(usageLog, 'utf8').split('\n').filter(Boolean)) {
    const u = JSON.parse(line) as { at: string; key: string; provider: string; model: string | null; outcome: string; actual_usd?: number; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; charged_reservation?: boolean };
    if (!keep(u.key) || u.at < since) continue;
    const t = out.get(u.key) ?? { calls: 0, input: 0, cached: 0, cache_write: 0, output: 0, usd: 0, charged_reservation: 0, refused: 0, by_model: {} };
    if (u.outcome === 'refused') { t.refused++; out.set(u.key, t); continue; }
    const m = (t.by_model[`${u.provider}:${u.model}`] ??= { calls: 0, input: 0, cached: 0, output: 0, usd: 0 });
    t.calls++; m.calls++;
    t.input += u.input_tokens ?? 0; m.input += u.input_tokens ?? 0;
    t.cached += u.cache_read_tokens ?? 0; m.cached += u.cache_read_tokens ?? 0;
    t.cache_write += u.cache_write_tokens ?? 0;
    t.output += u.output_tokens ?? 0; m.output += u.output_tokens ?? 0;
    t.usd += u.actual_usd ?? 0; m.usd += u.actual_usd ?? 0;
    if (u.charged_reservation) t.charged_reservation++;
    out.set(u.key, t);
  }
  return out;
}

export function loadSmokeWorld(worldDir: string, seed: number, perFamily = SMOKE_PER_FAMILY) {
  const ledger = generateLedger(seed, perFamily);
  const pages = smokePages(ledger, worldDir);
  for (const p of pages) readFileSync(p.path);
  return { ledger, pages, fingerprint: ledgerFingerprint(ledger) };
}
