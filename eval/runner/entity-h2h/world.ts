/**
 * Entity-dedupe head-to-head: the world every system reads, the order memory systems ingest it in, and the readout
 * of a memory system's entity nodes (docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md).
 *
 * A world is the person-dedupe people (eval/generators/person-dedupe-gen.ts) and companies
 * (eval/generators/company-dedupe-gen.ts) at one seed and per-family count, written as
 * <dir>/<source>/people/<slug>.md and <dir>/<source>/companies/<slug>.md, plus world.json, which names the seed,
 * the per-family count and both ledger fingerprints. loadWorld rebuilds the ledgers from world.json and refuses a
 * folder whose pages are not exactly the ones that seed renders, so a stale or edited world never reaches a system.
 *
 * Page keys are "<source>:<slug>" for people and "<source>:companies/<slug>" for companies, as the person-dedupe
 * scorer keys them.
 *
 * A memory system reports entity nodes, not page groups, so readoutFromEntities maps each page to the node its subject
 * (the page's title) became: among the nodes the page's source mentions, the one whose name best matches the title
 * (subjectOf). Pages whose subjects share a node, or whose nodes an `auto` link joins, form one auto group. A page
 * whose subject maps to no node is unresolved, a column of its own, never a silent singleton.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PERSON_DEDUPE_GENERATOR_VERSION, asciiFold, deriveGold, generateLedger, ledgerFingerprint, mulberry32, pageKey, renderPage, writtenPages,
  type DesignedPair, type Ledger, type WrittenPage,
} from '../../generators/person-dedupe-gen.ts';
import {
  COMPANY_DEDUPE_GENERATOR_VERSION, companyPageKey, companyWrittenPages, deriveCompanyGold, generateCompanyLedger, renderCompanyPage, type CompanyLedger,
} from '../../generators/company-dedupe-gen.ts';
import { writeCompanyWorld, writeWorld } from '../person-dedupe.ts';
import { RunnerRefusal } from '../runner-refusal.ts';

/** The public development seed and the held-out tuning seed. The counted seed is never in this repository. */
export const DEV_SEED = 20261117;
export const HELD_OUT_SEED = 20261118;
export const WORLD_MANIFEST = 'world.json';

export interface WorldPage { key: string; source: string; type: 'person' | 'company'; title: string; file: string; text: string; written: WrittenPage }

export interface H2hWorld {
  seed: number;
  per_family: number;
  /** The 2026-11-17 smoke's world: generator version 1, people only, instance 0 of each family, ingested in ledger order. */
  smoke: boolean;
  people: Ledger;
  companies: CompanyLedger;
  /** Every page, people first then companies, in ledger order. */
  pages: WorldPage[];
  /** Every designed pair, people then companies. */
  pairs: DesignedPair[];
  /** Page key to the true person or company id. */
  gold: Map<string, string>;
  people_gold: Map<string, string>;
  company_gold: Map<string, string>;
  fingerprints: { people: string; companies: string };
}

export interface WorldManifest {
  seed: number; per_family: number;
  person_generator_version: number; company_generator_version: number;
  people_ledger_sha256: string; company_ledger_sha256: string;
  pages: number; people_pages: number; company_pages: number;
  smoke?: true;
}

/** The smoke world's generator version and default size (2026-11-17 smoke: 69 pages at seed 20261117). */
export const SMOKE_GENERATOR_VERSION = 1;
export const SMOKE_PER_FAMILY = 2;

/** The 2026-11-17 smoke's world: the version-1 people ledger, instance 0 of each family, and the designed pairs among those pages. */
function buildSmokeWorld(seed: number, perFamily: number): H2hWorld {
  const generated = generateLedger(seed, perFamily, SMOKE_GENERATOR_VERSION);
  const kept = generated.pages.filter(p => p.instance === 0);
  const keys = new Set(kept.map(pageKey));
  const people = { ...generated, pages: kept, pairs: generated.pairs.filter(p => keys.has(p.a) && keys.has(p.b)) };
  const allCompanies = generateCompanyLedger(seed, perFamily, SMOKE_GENERATOR_VERSION);
  const companies = { ...allCompanies, pages: [], pairs: [] };
  const peopleGold = deriveGold(people), pw = writtenPages(people);
  return {
    seed, per_family: perFamily, smoke: true, people, companies,
    pages: people.pages.map((p, i) => ({ key: pageKey(p), source: p.source, type: 'person' as const, title: p.title, file: join(p.source, 'people', `${p.slug}.md`), text: renderPage(p), written: pw[i] })),
    pairs: people.pairs, gold: new Map(peopleGold), people_gold: peopleGold, company_gold: new Map(),
    fingerprints: { people: ledgerFingerprint(generated), companies: ledgerFingerprint(companies) },
  };
}

/** The world at a seed, built in memory (nothing written). */
export function buildWorld(seed: number, perFamily: number, smoke = false): H2hWorld {
  if (smoke) return buildSmokeWorld(seed, perFamily);
  const generated = generateLedger(seed, perFamily);
  const companies = generateCompanyLedger(seed, perFamily);
  const people = companies.founders?.length ? { ...generated, pages: [...generated.pages, ...companies.founders] } : generated;
  const peopleGold = deriveGold(people), companyGold = deriveCompanyGold(companies);
  const pw = writtenPages(people), cw = companyWrittenPages(companies);
  const pages: WorldPage[] = [
    ...people.pages.map((p, i) => ({ key: pageKey(p), source: p.source, type: 'person' as const, title: p.title, file: join(p.source, 'people', `${p.slug}.md`), text: renderPage(p), written: pw[i] })),
    ...companies.pages.map((p, i) => ({ key: companyPageKey(p), source: p.source, type: 'company' as const, title: p.title, file: join(p.source, 'companies', `${p.slug}.md`), text: renderCompanyPage(p), written: cw[i] })),
  ];
  return {
    seed, per_family: perFamily, smoke: false, people, companies, pages, pairs: [...people.pairs, ...companies.pairs],
    gold: new Map([...peopleGold, ...companyGold]), people_gold: peopleGold, company_gold: companyGold,
    fingerprints: { people: ledgerFingerprint(generated), companies: ledgerFingerprint(companies) },
  };
}

export function manifestOf(w: H2hWorld): WorldManifest {
  return {
    seed: w.seed, per_family: w.per_family,
    person_generator_version: w.smoke ? SMOKE_GENERATOR_VERSION : PERSON_DEDUPE_GENERATOR_VERSION, company_generator_version: w.smoke ? SMOKE_GENERATOR_VERSION : COMPANY_DEDUPE_GENERATOR_VERSION,
    people_ledger_sha256: w.fingerprints.people, company_ledger_sha256: w.fingerprints.companies,
    pages: w.pages.length, people_pages: w.people.pages.length, company_pages: w.companies.pages.length,
    ...(w.smoke ? { smoke: true as const } : {}),
  };
}

/** Writes the world's pages and world.json into a new folder. Refuses (WORLD_DIR_USED) a folder that already has files. */
export function writeH2hWorld(dir: string, seed: number, perFamily: number, smoke = false): H2hWorld {
  const used = existsSync(dir) ? readdirSync(dir).length : 0;
  if (used > 0) throw new RunnerRefusal('WORLD_DIR_USED', `entity-h2h: world folder ${dir} is not empty`, { entries_in_folder: used }, 'pass a fresh --output folder for the world');
  const w = buildWorld(seed, perFamily, smoke);
  writeWorld(w.people, dir);
  writeCompanyWorld(w.companies, dir);
  writeFileSync(join(dir, WORLD_MANIFEST), JSON.stringify(manifestOf(w), null, 2) + '\n');
  return w;
}

function markdownFiles(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap(e => e.isDirectory() ? markdownFiles(dir, join(rel, e.name)) : e.name.endsWith('.md') ? [join(rel, e.name)] : []);
}

/** Reads world.json, rebuilds the ledgers and checks every page on disk is exactly the one the seed renders, and no other page is there. */
export function loadWorld(dir: string): H2hWorld {
  const path = join(dir, WORLD_MANIFEST);
  if (!existsSync(path)) throw new Error(`entity-h2h: ${dir} has no ${WORLD_MANIFEST}; write worlds with: bun eval/runner/entity-h2h/run.ts world --seed N --output DIR`);
  const m = JSON.parse(readFileSync(path, 'utf8')) as WorldManifest;
  const w = buildWorld(m.seed, m.per_family, m.smoke === true);
  const want = manifestOf(w);
  for (const k of new Set([...Object.keys(want), ...Object.keys(m)]) as Set<keyof WorldManifest>) if (want[k] !== m[k]) throw new Error(`entity-h2h: ${path} says ${k} ${m[k]}, and seed ${m.seed} at ${m.per_family} per family gives ${want[k]}; rewrite the world`);
  const expected = new Set(w.pages.map(p => p.file));
  const extra = markdownFiles(dir).filter(f => !expected.has(f));
  if (extra.length) throw new Error(`entity-h2h: ${dir} holds ${extra.length} pages the seed does not render (first: ${extra[0]}); rewrite the world into a fresh folder`);
  const stale = w.pages.filter(p => !existsSync(join(dir, p.file)) || readFileSync(join(dir, p.file), 'utf8') !== p.text);
  if (stale.length) throw new Error(`entity-h2h: ${stale.length} of ${w.pages.length} pages in ${dir} are missing or differ from what seed ${m.seed} renders (first: ${stale[0].file}); rewrite the world into a fresh folder`);
  return w;
}

/**
 * The one ingest order every memory system uses: the world's pages shuffled by a generator seeded from the world seed
 * (Fisher-Yates over pages sorted by key), so the order is fixed by the seed and the same for every system.
 */
export function ingestOrder(w: H2hWorld): WorldPage[] {
  if (w.smoke) return [...w.pages];
  const out = [...w.pages].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rand = mulberry32((w.seed ^ 0x5eed0de) >>> 0);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The page-to-entity map an adapter's labeller reads. Only the held-out seed may be labelled. */
export function heldOutLabels(w: H2hWorld): { seed: number; per_family: number; people_ledger_sha256: string; company_ledger_sha256: string; entities: Record<string, string> } {
  if (w.seed !== HELD_OUT_SEED) throw new Error(`entity-h2h: labels and tuning come only from held-out seed ${HELD_OUT_SEED}; refusing to label seed ${w.seed}`);
  return { seed: w.seed, per_family: w.per_family, people_ledger_sha256: w.fingerprints.people, company_ledger_sha256: w.fingerprints.companies, entities: Object.fromEntries(w.gold) };
}

// ─── Memory-system readout ─────────────────────────────────────────────────

export interface EntityNode { id: string; name: string | null; type: string | null; source_ids: string[]; provenance_status: string }
export interface EntityLink { a: string; b: string; kind: string; tier: 'auto' | 'proposed'; score: number | null }
export interface EntitiesResponse { entities: EntityNode[]; links: EntityLink[]; notes?: string }

/** Opaque ids for the shim protocol (ns-<16 hex>, src-<16 hex>), stable for a run label and page key. */
export const opaque = (prefix: 'ns' | 'src', ...parts: string[]) => `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)}`;

const tokens = (s: string) => asciiFold(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

/** How well a node name matches a page title: 3 same folded name, 2 same last word and first initial, else token overlap. */
export function nameMatch(title: string, name: string): number {
  const t = tokens(title), n = tokens(name);
  if (!t.length || !n.length) return 0;
  if (t.join(' ') === n.join(' ')) return 3;
  if (t.at(-1) === n.at(-1) && t[0][0] === n[0][0]) return 2;
  const inter = t.filter(x => n.includes(x)).length;
  return inter / new Set([...t, ...n]).size;
}

/** The node a page's subject became: the best name match among the nodes its source mentions, if any scores 0.5 or more; a node of the page's own type wins a tie. */
export function subjectOf(title: string, candidates: readonly EntityNode[], type: 'person' | 'company' = 'person'): { node: EntityNode; match: number } | null {
  const want = type === 'person' ? /person/i : /organi[sz]ation|company/i;
  const bonus = (n: EntityNode) => (want.test(n.type ?? '') ? 0.01 : 0);
  let best: { node: EntityNode; match: number } | null = null;
  for (const node of candidates) {
    const m = nameMatch(title, node.name ?? '');
    if (m >= 0.5 && (!best || m + bonus(node) > best.match + bonus(best.node))) best = { node, match: m };
  }
  return best;
}

export interface SubjectRow { key: string; source_id: string; title: string; node: string | null; node_name: string | null; match: number | null }

/** Groups pages by the node their subject became (auto), and by the system's own links between nodes (auto and proposed). */
export function readoutFromEntities(pages: readonly Pick<WorldPage, 'key' | 'title' | 'type'>[], sourceOf: ReadonlyMap<string, string>, res: EntitiesResponse): { tiers: { auto: string[][]; proposed: string[][] }; subjects: SubjectRow[] } {
  const bySource = new Map<string, EntityNode[]>();
  for (const e of res.entities) for (const s of e.source_ids) bySource.set(s, [...(bySource.get(s) ?? []), e]);
  const subjects = pages.map(p => {
    const src = sourceOf.get(p.key)!;
    const hit = subjectOf(p.title, bySource.get(src) ?? [], p.type);
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
  const autoSet = new Set(auto.map(g => g.join('|')));
  return { tiers: { auto, proposed: groups(res.links).filter(g => !autoSet.has(g.join('|'))) }, subjects };
}

// ─── Proxy usage ───────────────────────────────────────────────────────────

export interface UsageTotals { calls: number; input: number; cached: number; cache_write: number; output: number; usd: number; charged_reservation: number; refused: number; budget_refused: number; by_model: Record<string, { calls: number; input: number; cached: number; output: number; usd: number }> }
export interface UsageRow { at: string; key: string; request_id?: string; brain?: string | null; provider: string; model: string | null; outcome: string; status?: number; reason?: string; actual_usd?: number; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; charged_reservation?: boolean }

export function readUsage(usageLog: string): UsageRow[] {
  if (!existsSync(usageLog)) return [];
  return readFileSync(usageLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as UsageRow);
}

/** Sums a metering proxy usage log (one line per request) per bound key; `since` drops lines before an ISO time. */
export function usageByKey(rows: readonly UsageRow[], keep: (key: string) => boolean = () => true, since = ''): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  for (const u of rows) {
    if (!keep(u.key) || u.at < since) continue;
    const t = out.get(u.key) ?? { calls: 0, input: 0, cached: 0, cache_write: 0, output: 0, usd: 0, charged_reservation: 0, refused: 0, budget_refused: 0, by_model: {} };
    out.set(u.key, t);
    if (u.outcome === 'refused') { t.refused++; if (u.status === 402) t.budget_refused++; continue; }
    const m = (t.by_model[`${u.provider}:${u.model}`] ??= { calls: 0, input: 0, cached: 0, output: 0, usd: 0 });
    t.calls++; m.calls++;
    t.input += u.input_tokens ?? 0; m.input += u.input_tokens ?? 0;
    t.cached += u.cache_read_tokens ?? 0; m.cached += u.cache_read_tokens ?? 0;
    t.cache_write += u.cache_write_tokens ?? 0;
    t.output += u.output_tokens ?? 0; m.output += u.output_tokens ?? 0;
    t.usd += u.actual_usd ?? 0; m.usd += u.actual_usd ?? 0;
    if (u.charged_reservation) t.charged_reservation++;
  }
  return out;
}

export const sumUsd = (totals: Iterable<UsageTotals>) => [...totals].reduce((s, t) => s + t.usd, 0);
