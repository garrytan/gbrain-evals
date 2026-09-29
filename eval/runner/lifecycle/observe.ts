/**
 * Read what a caller can see, through the product surface under test.
 * Observations are raw: which slugs are listed, what text each page holds,
 * which links and timeline rows each page reports, and which facts recall
 * returns. Scoring against the ledger happens in `score.ts`.
 */
import type { CallResult, Driver } from './drivers.ts';
import { IDENTITIES, PRIVATE_ID, PUBLIC_TWIN_ID, identityById, versionAt } from './scenario.ts';

export interface PageObs {
  slug: string;
  source_id: string | null;
  source_path: string | null;
  text: string;
  canaries: string[];
  links: string[];
  links_error?: string;
  timeline: Array<{ date: string; summary: string }>;
  timeline_error?: string;
  get_error?: string;
}

export interface FactObs { fact_id: string; fact: string; entity_slug: string | null }

export interface Snapshot {
  observer: 'local' | 'remote';
  interface: string;
  pages: PageObs[];
  list_error?: string;
  facts: Record<string, { active: FactObs[]; error?: string }>;
  search?: Record<string, { found: boolean; error?: string }>;
  /** get_page on a slug a file had before it moved or was renamed. */
  old_slugs?: Record<string, { resolved_to: string | null; canaries: string[]; error?: string }>;
  errors: string[];
  calls: number;
  call_ms: number;
}

const CANARY = /cnry[a-z0-9]+/g;

function collect(obj: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(obj)) { for (const x of obj) collect(x, key, out); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key && typeof v === 'string') out.push(v);
      else collect(v, key, out);
    }
  }
  return out;
}

function asArray(data: unknown, keys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

function dateOnly(v: unknown): string {
  const s = String(v ?? '');
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : s;
}

export class Observer {
  calls = 0;
  ms = 0;
  constructor(public driver: Driver) {}
  async call(op: string, args: Record<string, unknown>): Promise<CallResult> {
    const r = await this.driver.call(op, args);
    this.calls++;
    this.ms += r.ms;
    return r;
  }
}

export const FACT_ENTITIES = ['people/alice-example', 'people/bob-example', 'people/frank-example', 'people/exa-cheng', 'people/exa-chen'];

export async function observe(
  driver: Driver,
  opts: { search?: boolean; facts?: boolean; searchIds?: string[]; extraSources?: string[]; oldSlugs?: string[] } = {},
): Promise<Snapshot> {
  const o = new Observer(driver);
  const snap: Snapshot = {
    observer: driver.remote ? 'remote' : 'local', interface: driver.kind, pages: [], facts: {}, errors: [], calls: 0, call_ms: 0,
  };
  const listed: Array<{ slug: string; source_id: string | null }> = [];
  const limit = 100;
  // list_pages scopes to the default source unless told otherwise, so each extra source is listed by id.
  for (const source of [null, ...(opts.extraSources ?? [])]) {
    for (let offset = 0; offset < 2000; offset += limit) {
      const r = await o.call('list_pages', source ? { limit, offset, source_id: source } : { limit, offset });
      if (!r.ok) { snap.list_error = `${source ?? 'default'}: ${r.error}`; break; }
      if (!Array.isArray(r.data) && !(r.data && typeof r.data === 'object' && Array.isArray((r.data as Record<string, unknown>).pages))) {
        snap.list_error = `unexpected list_pages response (${r.raw.length} chars): ${r.raw.slice(0, 120)} ... ${r.raw.slice(-300)}`;
        break;
      }
      const rows = asArray(r.data, ['pages', 'results']);
      for (const row of rows) {
        const item = { slug: String(row.slug), source_id: row.source_id == null ? null : String(row.source_id) };
        if (!listed.some(x => x.slug === item.slug && x.source_id === item.source_id)) listed.push(item);
      }
      if (rows.length < limit) break;
    }
  }
  for (const { slug, source_id } of listed) {
    const page: PageObs = { slug, source_id, source_path: null, text: '', canaries: [], links: [], timeline: [] };
    const g = await o.call('get_page', source_id ? { slug, source_id } : { slug });
    if (g.ok && g.data && typeof g.data === 'object') {
      const d = g.data as Record<string, unknown>;
      page.source_path = d.source_path == null ? null : String(d.source_path);
      page.text = `${d.compiled_truth ?? ''}\n${d.timeline ?? ''}`;
      page.canaries = [...new Set(page.text.match(CANARY) ?? [])];
    } else page.get_error = g.error ?? 'no data';
    // get_links and get_timeline take no source parameter; the second vault is scored on identity only.
    if (source_id && source_id !== 'vault') { snap.pages.push(page); continue; }
    const l = await o.call('get_links', { slug });
    if (l.ok) page.links = [...new Set(asArray(l.data, ['links']).map(x => String(x.to_slug ?? x.slug ?? '')).filter(Boolean))];
    else page.links_error = l.error;
    const t = await o.call('get_timeline', { slug });
    if (t.ok) page.timeline = asArray(t.data, ['entries', 'timeline']).map(x => ({ date: dateOnly(x.date), summary: String(x.summary ?? '') }));
    else page.timeline_error = t.error;
    snap.pages.push(page);
  }
  if (opts.facts !== false) {
    for (const entity of FACT_ENTITIES) {
      const r = await o.call('recall', { entity });
      if (!r.ok) { snap.facts[entity] = { active: [], error: r.error }; continue; }
      const facts = asArray(r.data, ['facts']).filter(f => f.expired_at == null).map(f => ({
        fact_id: String(f.fact_id ?? f.id), fact: String(f.fact ?? ''), entity_slug: f.entity_slug == null ? null : String(f.entity_slug),
      }));
      snap.facts[entity] = { active: facts };
    }
  }
  if (opts.search) {
    snap.search = {};
    const ids = opts.searchIds ?? IDENTITIES.map(i => i.id);
    for (const id of ids) {
      const v = versionAt(identityById(id), 'correct') ?? versionAt(identityById(id), 'outage');
      if (!v) continue;
      const r = await o.call('search', { query: v.canary, limit: 10 });
      snap.search[id] = r.ok ? { found: r.raw.includes(v.canary) || collect(r.data, 'slug').some(s => snap.pages.find(p => p.slug === s)?.canaries.includes(v.canary)) } : { found: false, error: r.error };
    }
  }
  if (opts.oldSlugs?.length) {
    snap.old_slugs = {};
    for (const slug of opts.oldSlugs) {
      const r = await o.call('get_page', { slug });
      const d = (r.ok && r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
      const text = `${d.compiled_truth ?? ''}\n${d.timeline ?? ''}`;
      snap.old_slugs[slug] = { resolved_to: d.slug == null ? null : String(d.slug), canaries: [...new Set(text.match(CANARY) ?? [])], ...(r.ok ? {} : { error: r.error?.slice(0, 200) }) };
    }
  }
  snap.calls = o.calls;
  snap.call_ms = o.ms;
  return snap;
}

export interface LeakProbe {
  name: string;
  /** The private page's own text, tag or timeline marker appears in the response. */
  content_leak: boolean;
  /** A result row names the private page (its slug in a slug field), disclosing that it exists. */
  existence_leak: boolean;
  /** The same probe against the public twin returns the twin, so the probe can see a page of this shape. */
  control: boolean;
  leak_error?: string;
  control_error?: string;
  evidence?: string;
}

const SLUG_FIELDS = ['slug', 'to_slug', 'from_slug', 'entity_slug', 'page_slug', 'target_slug', 'source_slug'];

function namedSlugs(data: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(data)) { for (const x of data) namedSlugs(x, out); return out; }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (SLUG_FIELDS.includes(k) && typeof v === 'string') out.add(v);
      else namedSlugs(v, out);
    }
  }
  return out;
}

function stringsIn(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Leak probes for a remote caller. Each probe has a presence control on the
 * public twin page, which has the same shape as the private page. A probe
 * whose control is absent measures nothing and is reported as "no signal",
 * never as "no leak". Public pages may mention the private slug in their own
 * text (the team note links to it), so a leak is the private page's own
 * markers, or a result row whose slug field names the private page.
 */
export async function probeLeaks(driver: Driver): Promise<LeakProbe[]> {
  const priv = versionAt(identityById(PRIVATE_ID), 'ingest')!;
  const pub = versionAt(identityById(PUBLIC_TWIN_ID), 'ingest')!;
  const privSlug = priv.path.replace(/\.md$/, '');
  const pubSlug = pub.path.replace(/\.md$/, '');
  const markers = (v: typeof priv) => [v.canary, ...(v.tags ?? []), ...v.timeline.map(t => t.summary.split(' ')[0])];
  const privTokens = markers(priv);
  const pubTokens = markers(pub);
  const content = (r: CallResult, toks: string[]) => r.ok && toks.some(t => r.raw.includes(t));
  const names = (r: CallResult, slug: string) => r.ok && (namedSlugs(r.data).has(slug) || stringsIn(r.data).includes(slug));
  const probes: LeakProbe[] = [];
  const push = (name: string, a: CallResult, b: CallResult) => {
    const content_leak = content(a, privTokens);
    const existence_leak = names(a, privSlug);
    probes.push({
      name, content_leak, existence_leak,
      control: content(b, pubTokens) || names(b, pubSlug),
      ...(a.error ? { leak_error: a.error.slice(0, 200) } : {}),
      ...(b.error ? { control_error: b.error.slice(0, 200) } : {}),
      ...(content_leak || existence_leak ? { evidence: excerpt(a.raw, [...privTokens, privSlug]) } : {}),
    });
  };

  for (const op of ['get_page', 'get_tags', 'get_timeline', 'get_chunks', 'get_versions', 'get_backlinks']) {
    push(`${op}(named page)`, await driver.call(op, { slug: privSlug }), await driver.call(op, { slug: pubSlug }));
  }
  const tokenSearches: Array<[string, string, string, string]> = [
    ['search', 'page marker', priv.canary, pub.canary],
    ['query', 'page marker', priv.canary, pub.canary],
    ['recall', 'page marker', priv.canary, pub.canary],
    ['search', 'timeline marker', priv.timeline[0].summary.split(' ')[0], pub.timeline[0].summary.split(' ')[0]],
    ['search', 'tag marker', priv.tags![0], pub.tags![0]],
  ];
  for (const [op, label, a1, b1] of tokenSearches) {
    push(`${op}(${label})`, await driver.call(op, { query: a1, limit: 10 }), await driver.call(op, { query: b1, limit: 10 }));
  }
  const lists: Array<[string, Record<string, unknown>]> = [
    ['list_pages', { limit: 100 }],
    ['get_links', { slug: 'notes/team' }],
    ['traverse_graph', { slug: 'notes/team', depth: 1 }],
    ['resolve_slugs', { partial: 'people/da' }],
    ['search', { query: 'offsite planning', limit: 20 }],
    ['query', { query: 'offsite planning', limit: 20 }],
  ];
  for (const [op, args] of lists) {
    const r = await driver.call(op, args);
    push(`${op}(listing)`, r, r);
  }
  return probes;
}

function excerpt(raw: string, needles: string[]): string {
  for (const n of needles) {
    const i = raw.indexOf(n);
    if (i >= 0) return raw.slice(Math.max(0, i - 150), i + 150);
  }
  return raw.slice(0, 300);
}
