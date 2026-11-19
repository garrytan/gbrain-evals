/**
 * Company auto-link rules on the person-dedupe company world plus its development V families
 * (eval/generators/company-dedupe-v-gen.ts). Opt-in: `bun eval/runner/person-dedupe.ts --company-autolink` prints
 * this table on the dev seed, and nothing in the default bench or the entity-dedupe head-to-head world reads it.
 *
 * Each arm is the contract emulator's auto tier on company pages only (people are unchanged and get no rows here),
 * written as a list of paths. A path names a key (a LinkedIn company page, a domain host, a registrable domain, or an
 * own-site domain) and a name test over every page that holds the key. A key's holders link when they pass the
 * finder's usual checks: 2 to 5 holders (more is crowded), one page per source and so cross-source, no contradicting
 * LinkedIn page, the path's name test, and no pair a user rejected. Linked groups that share a page are then checked as
 * one union: one page per source, every pair sharing a key, and no rejected pair, or none of them links.
 *
 * Own-site domain: a page whose website (or any domain value) has a URL path, such as a franchise, holding or
 * subsidiary page on a parent site, contributes no own-site domain keys.
 *
 * Rows beyond false merges and found pairs:
 *   rejected pairs   for each pair a user rejected, whether it comes back in a proposed group (every holder set of a
 *                    shared domain host or LinkedIn page, and every strict or variant name bucket, 2 to 5 pages) and
 *                    whether the arm auto-links it, under three rejection memories: none, keyed on the page key
 *                    (source:slug) at rejection, and keyed on the stable page id.
 *   older pass       the arm run on the world as it was before the moves, renames and rejections: the links it makes
 *                    that touch a page that later changed, and those that join a pair now rejected. A pass computed
 *                    then and applied late would install them.
 *
 * A stand-in for gbrain's finder, never reported as gbrain.
 */
import { scoreGroups, strictFold, variantFold, domainKey, type Group } from './person-dedupe.ts';
import { COMPANY_V_FAMILIES, type CompanyRejection, type CompanyVPage, type CompanyVWorld } from '../generators/company-dedupe-v-gen.ts';

const CROWDED_AFTER = 5;
const INITIAL_STOP_WORDS = new Set(['and', 'of', 'the', '&']);

/** A LinkedIn company or profile path, lowercase, as the finder keys it; null when the page has none. */
export function linkedinPath(p: { linkedin: string | null }): string | null {
  return p.linkedin?.trim().toLowerCase().match(/\/(in|company)\/[^/?#]+/)?.[0] ?? null;
}

/** A website or domain value with a URL path after the host (https://www.halwick.example/labs, or halwick.example/labs). */
export function hasUrlPath(raw: string): boolean {
  return /^[^/]+\/./.test(raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
}

/** The registrable part of a domain in this world (TLD .example; a two-letter label before it is a country code). */
export function registrableDomain(raw: string): string | null {
  const host = domainKey(raw);
  if (!host) return null;
  const labels = host.replace(/\.example$/, '').split('.');
  const cc = labels.length >= 2 && /^[a-z]{2}$/.test(labels.at(-1)!);
  return (cc ? labels.slice(-2) : labels.slice(-1)).join('.');
}

/** Domain hosts a page lists, distinct. */
export function domainHosts(p: { domains: readonly string[] }): string[] {
  return [...new Set(p.domains.map(domainKey).filter((d): d is string => d !== null))];
}

/** The page's own-site domains: its hosts, or none when any domain or website value has a URL path. */
export function ownSiteDomains(p: { domains: readonly string[] }): string[] {
  return p.domains.some(hasUrlPath) ? [] : domainHosts(p);
}

/** The company variant fold with dotted abbreviations read as one word: "Iselwood, L.L.C." folds like "Iselwood LLC". */
export function dottedVariantFold(title: string): string {
  return variantFold(title.replace(/\b([a-z])\.(?=[a-z]\.)/gi, '$1').replace(/\b([a-z])\.(?=\s|,|$)/gi, '$1'), 'company');
}

/** Initials of the company variant fold, without and/of/the: "Velfield United Minerals" gives "vum". */
export function companyInitials(title: string): string {
  return variantFold(title, 'company').split(' ').filter(w => !INITIAL_STOP_WORDS.has(w)).map(w => w[0]).join('');
}

/** One name is a single word of at least two letters that equals the other name's initials. */
export function initialsMatch(a: string, b: string): boolean {
  const va = variantFold(a, 'company'), vb = variantFold(b, 'company');
  return (!va.includes(' ') && va.length >= 2 && va === companyInitials(b)) || (!vb.includes(' ') && vb.length >= 2 && vb === companyInitials(a));
}

type Page = CompanyVPage;
const oneName = (f: (p: Page) => string) => (ps: readonly Page[]) => new Set(ps.map(f)).size === 1;
const strict = (p: Page) => strictFold(p.title), variant = (p: Page) => variantFold(p.title, 'company'), dotted = (p: Page) => dottedVariantFold(p.title);
const li = (p: Page) => [linkedinPath(p)].filter((k): k is string => k !== null);
const sameOwnSites = (a: Page, b: Page) => { const x = ownSiteDomains(a).sort().join(), y = ownSiteDomains(b).sort().join(); return x !== '' && x === y; };

/** A path: the keys it reads from a page and the name test its holders must pass. */
interface Path { keys: (p: Page) => string[]; name: (ps: readonly Page[]) => boolean }
const PATHS = {
  li_strict: { keys: li, name: oneName(strict) },
  li_variant: { keys: li, name: oneName(variant) },
  li_dotted: { keys: li, name: oneName(dotted) },
  li_initials: { keys: li, name: ps => ps.length === 2 && initialsMatch(ps[0].title, ps[1].title) },
  reg_variant: { keys: p => [...new Set(p.domains.map(registrableDomain).filter((d): d is string => d !== null))], name: oneName(variant) },
  reg_any: { keys: p => [...new Set(p.domains.map(registrableDomain).filter((d): d is string => d !== null))], name: () => true },
  own_strict: { keys: ownSiteDomains, name: oneName(strict) },
  own_variant: { keys: ownSiteDomains, name: oneName(variant) },
  own_dotted: { keys: ownSiteDomains, name: oneName(dotted) },
  own_initials: { keys: ownSiteDomains, name: ps => ps.length === 2 && initialsMatch(ps[0].title, ps[1].title) && sameOwnSites(ps[0], ps[1]) },
} satisfies Record<string, Path>;
export type CompanyPathId = keyof typeof PATHS;

export const COMPANY_AUTOLINK_ARMS: Record<string, { paths: CompanyPathId[]; text: string }> = {
  baseline: { paths: ['li_strict'], text: 'a shared LinkedIn company page and the same strict-folded name (the contract emulator\'s arm 7 on companies)' },
  a: { paths: ['li_strict', 'reg_variant'], text: 'baseline, or a shared registrable domain and the same name after the suffix fold' },
  b: { paths: ['li_strict', 'reg_any'], text: 'baseline, or a shared registrable domain alone' },
  c: { paths: ['li_variant'], text: 'a shared LinkedIn company page and the same name after the suffix fold' },
  d1: { paths: ['li_variant', 'own_variant'], text: 'an own-site domain and the same name after the suffix fold, or a LinkedIn company page and the same name after the suffix fold' },
  'd1-strict': { paths: ['li_strict', 'own_strict'], text: 'd1 with strict-folded names' },
  d2: { paths: ['li_variant', 'own_variant', 'own_initials', 'li_initials'], text: 'd1, or initials of one name equal the other with exactly the same own-site domain set, or initials on one LinkedIn company page' },
  d3: { paths: ['li_dotted', 'own_dotted', 'own_initials', 'li_initials'], text: 'd2 with dotted abbreviations read as one word in the name fold (L.L.C. = LLC)' },
};

export type Rejected = (a: Page, b: Page) => boolean;

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string { let p = this.parent.get(x) ?? x; if (p !== x) { p = this.find(p); this.parent.set(x, p); } return p; }
  union(a: string, b: string): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

/** The arm's auto-link groups on company pages, as cross_source clean groups; `rejected` is the rejection memory. */
export function companyAutoLink(pages: readonly Page[], armId: string, rejected: Rejected = () => false): Group[] {
  const arm = COMPANY_AUTOLINK_ARMS[armId];
  if (!arm) throw new Error(`company-autolink: unknown arm ${armId}`);
  const byKey = new Map(pages.map(p => [p.key, p]));
  const allKeys = new Map(pages.map(p => [p.key, arm.paths.flatMap(id => PATHS[id].keys(p).map(k => `${id}:${k}`))]));
  const anyRejected = (ms: readonly string[]) => ms.some((a, i) => ms.slice(i + 1).some(b => rejected(byKey.get(a)!, byKey.get(b)!)));
  const clean: Group[] = [];
  for (const id of arm.paths) {
    const holders = new Map<string, Page[]>();
    for (const p of pages) for (const k of PATHS[id].keys(p)) holders.set(k, [...(holders.get(k) ?? []), p]);
    for (const [k, h] of holders) {
      if (h.length < 2 || h.length > CROWDED_AFTER) continue;
      if (new Set(h.map(p => p.source)).size !== h.length) continue;
      if (new Set(h.map(linkedinPath).filter(Boolean)).size > 1) continue;
      if (!PATHS[id].name(h)) continue;
      const members = h.map(p => p.key);
      if (anyRejected(members)) continue;
      clean.push({ members: members.sort(), kind: 'cross_source', class: 'clean', rules: [`${id}:${k}`] });
    }
  }
  const uf = new UnionFind();
  for (const g of clean) for (const m of g.members.slice(1)) uf.union(g.members[0], m);
  const unions = new Map<string, Group[]>();
  for (const g of clean) { const r = uf.find(g.members[0]); unions.set(r, [...(unions.get(r) ?? []), g]); }
  const out: Group[] = [];
  for (const gs of unions.values()) {
    const ms = [...new Set(gs.flatMap(g => g.members))];
    const perSource = new Set(ms.map(m => byKey.get(m)!.source)).size === ms.length;
    const clique = ms.every((a, i) => ms.slice(i + 1).every(b => allKeys.get(a)!.some(k => allKeys.get(b)!.includes(k))));
    if (new Set(gs.map(g => g.members.join())).size === 1 || (perSource && clique && !anyRejected(ms))) out.push(...gs);
  }
  return out;
}

/** What the finder would propose for review: holder sets of a shared domain host or LinkedIn page and strict or variant name buckets (2 to 5 pages), less any page in a rejected pair with another member. */
export function companyProposed(pages: readonly Page[], rejected: Rejected = () => false): string[][] {
  const out: Page[][] = [];
  const add = (keys: (p: Page) => string[]) => {
    const m = new Map<string, Page[]>();
    for (const p of pages) for (const k of keys(p)) m.set(k, [...(m.get(k) ?? []), p]);
    for (const h of m.values()) if (h.length > 1 && h.length <= CROWDED_AFTER) out.push(h);
  };
  add(domainHosts);
  add(li);
  add(p => [strict(p)]);
  add(p => [variant(p)]);
  return out.map(h => h.filter((p, i) => !h.some((q, j) => j !== i && rejected(p, q)))).filter(h => h.length > 1).map(h => h.map(p => p.key));
}

export const REJECTION_MEMORIES = ['none', 'page-key', 'page-id'] as const;
export type RejectionMemory = typeof REJECTION_MEMORIES[number];

/** The rejection memory as a test on two current pages: page-key matches the keys recorded at rejection, page-id the stable ids. */
export function rejectionMemory(rejections: readonly CompanyRejection[], memory: RejectionMemory): Rejected {
  if (memory === 'none') return () => false;
  if (memory === 'page-key') return (p, q) => rejections.some(r => (r.a_key === p.key && r.b_key === q.key) || (r.a_key === q.key && r.b_key === p.key));
  return (p, q) => rejections.some(r => (r.a_id === p.page_id && r.b_id === q.page_id) || (r.a_id === q.page_id && r.b_id === p.page_id));
}

export interface Count { k: number; n: number }
export interface CompanyArmResult {
  arm: string;
  text: string;
  /** Scored with rejection memory keyed on the stable page id. */
  base: { false_merge: Count; found: Count };
  all: { false_merge: Count; found: Count; precision: Count };
  /** Per family: false merges over must-not-link pairs, found over must-link pairs. */
  families: Record<string, { label: string; false_merge: Count | null; found: Count | null }>;
  /** Per V family variant, keyed "<family> / <variant>". */
  variants: Record<string, { label: string; false_merge: Count | null; found: Count | null }>;
  rejected: Record<RejectionMemory, { reproposed: number; auto_linked: number; of: number }>;
  older_pass: { links: number; links_touching_changed_pages: number; links_joining_a_rejected_pair: number };
  false_merge_cases: Array<{ a: string; b: string; family: string; variant: string | null; via: string[] }>;
}

export function runCompanyAutoLink(world: CompanyVWorld, arms: readonly string[] = Object.keys(COMPANY_AUTOLINK_ARMS)): CompanyArmResult[] {
  const byId = new Map(world.pages.map(p => [p.page_id, p]));
  const baseFamilies = new Set(world.base_families);
  const before = world.pages.map(p => world.changes.find(c => c.after.page_id === p.page_id)?.before ?? p);
  const changed = new Set(world.changes.map(c => c.before.key));
  const tally = () => ({ fm: 0, nd: 0, fs: 0, ns: 0 });
  const counts = (t: ReturnType<typeof tally>, label: string) => ({ label, false_merge: t.nd ? { k: t.fm, n: t.nd } : null, found: t.ns ? { k: t.fs, n: t.ns } : null });
  return arms.map(armId => {
    const scored = REJECTION_MEMORIES.map(memory => {
      const rejected = rejectionMemory(world.rejections, memory);
      const groups = companyAutoLink(world.pages, armId, rejected);
      const uf = new UnionFind();
      for (const g of groups) for (const m of g.members.slice(1)) uf.union(g.members[0], m);
      const proposed = companyProposed(world.pages, rejected);
      const current = world.rejections.map(r => [byId.get(r.a_id)!.key, byId.get(r.b_id)!.key]);
      return {
        memory, groups, uf,
        reproposed: current.filter(([a, b]) => proposed.some(h => h.includes(a) && h.includes(b))).length,
        auto_linked: current.filter(([a, b]) => uf.find(a) === uf.find(b)).length,
      };
    });
    const main = scored.find(s => s.memory === 'page-id')!;
    const fam: Record<string, ReturnType<typeof tally>> = {}, vars: Record<string, ReturnType<typeof tally>> = {};
    const base = tally(), all = tally();
    const cases: CompanyArmResult['false_merge_cases'] = [];
    for (const p of world.pairs) {
      const merged = main.uf.find(p.a) === main.uf.find(p.b);
      const buckets = [fam[p.family] ??= tally(), all, ...(baseFamilies.has(p.family) ? [base] : []), ...(p.variant ? [vars[`${p.family} / ${p.variant}`] ??= tally()] : [])];
      for (const t of buckets) {
        if (p.label === 'different') { t.nd++; if (merged) t.fm++; } else { t.ns++; if (merged) t.fs++; }
      }
      if (p.label === 'different' && merged) {
        const via = main.groups.filter(g => g.members.includes(p.a) && g.members.includes(p.b)).map(g => g.rules.join('+'));
        cases.push({ a: p.a, b: p.b, family: p.family, variant: p.variant, via: via.length ? via : ['closure'] });
      }
    }
    const label = (f: string) => world.pairs.find(p => p.family === f)!.label;
    const precision = scoreGroups(main.groups, world.pairs, world.gold).precision;
    const old = companyAutoLink(before, armId);
    return {
      arm: armId, text: COMPANY_AUTOLINK_ARMS[armId].text,
      base: { false_merge: { k: base.fm, n: base.nd }, found: { k: base.fs, n: base.ns } },
      all: { false_merge: { k: all.fm, n: all.nd }, found: { k: all.fs, n: all.ns }, precision: { k: precision.k, n: precision.n } },
      families: Object.fromEntries(Object.entries(fam).map(([f, t]) => [f, counts(t, label(f))])),
      variants: Object.fromEntries(Object.entries(vars).map(([v, t]) => [v, counts(t, label(v.slice(0, v.indexOf(' / '))))])),
      rejected: Object.fromEntries(scored.map(s => [s.memory, { reproposed: s.reproposed, auto_linked: s.auto_linked, of: world.rejections.length }])) as CompanyArmResult['rejected'],
      older_pass: {
        links: old.length,
        links_touching_changed_pages: old.filter(g => g.members.some(m => changed.has(m))).length,
        links_joining_a_rejected_pair: old.filter(g => world.rejections.some(r => g.members.includes(r.a_key) && g.members.includes(r.b_key))).length,
      },
      false_merge_cases: cases,
    };
  });
}

const frac = (c: Count | null) => c ? `${c.k}/${c.n}` : '';

/** The result as Markdown tables: arms, then false merges or found per family and per V variant, then the rejection and older-pass rows. */
export function formatCompanyAutoLink(results: readonly CompanyArmResult[]): string[] {
  const lines: string[] = [];
  lines.push('| arm | rule | base false merges | base found | all false merges | all found | precision (all pairs) |', '|---|---|---|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.arm} | ${r.text} | ${frac(r.base.false_merge)} | ${frac(r.base.found)} | ${frac(r.all.false_merge)} | ${frac(r.all.found)} | ${frac(r.all.precision)} |`);
  const cell = (x: { false_merge: Count | null; found: Count | null }) => x.false_merge ? `fm ${frac(x.false_merge)}` : `found ${frac(x.found)}`;
  const families = Object.keys(results[0]?.families ?? {});
  lines.push('', `| family | ${results.map(r => r.arm).join(' | ')} |`, `|---|${results.map(() => '---|').join('')}`);
  for (const f of families) lines.push(`| ${f} | ${results.map(r => cell(r.families[f])).join(' | ')} |`);
  const variants = COMPANY_V_FAMILIES.flatMap(f => f.variants.map(v => `${f.id} / ${v}`)).filter(v => results[0]?.variants[v]);
  lines.push('', `| V family / variant | ${results.map(r => r.arm).join(' | ')} |`, `|---|${results.map(() => '---|').join('')}`);
  for (const v of variants) lines.push(`| ${v} | ${results.map(r => cell(r.variants[v])).join(' | ')} |`);
  lines.push('', '| arm | rejected pairs re-proposed (none / page key / page id) | rejected pairs auto-linked (none / page key / page id) | older pass: links touching a changed page | older pass: links joining a rejected pair |', '|---|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.arm} | ${REJECTION_MEMORIES.map(m => r.rejected[m].reproposed).join(' / ')} of ${r.rejected.none.of} | ${REJECTION_MEMORIES.map(m => r.rejected[m].auto_linked).join(' / ')} of ${r.rejected.none.of} | ${r.older_pass.links_touching_changed_pages} | ${r.older_pass.links_joining_a_rejected_pair} |`);
  return lines;
}
