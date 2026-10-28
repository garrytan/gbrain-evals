#!/usr/bin/env bun
/**
 * Structure-aware chunks (GBRA-234, follow-up to the STAIR paper review, arXiv 2609.03874).
 *
 * Question: does gbrain retrieve the right passage of a long, heading-structured document more often when
 *   (1) the chunk's heading path rides in the embed-time contextual prefix (GBRAIN_EXP_HEADING_PREFIX=1), or
 *   (2) inline pages chunk with headingsLead, so a heading starts its section's chunk (GBRAIN_EXP_HEADINGS_LEAD=1),
 * and, on keyless brains, when (3) the heading path is added to each chunk's search_vector at weight C?
 *
 * Arms 1 and 2 live on a local gbrain experiment branch (its patch is committed beside the results); arm 3 is applied
 * here with SQL after import, because no column stores a heading path today. Everything else is gbrain as it is,
 * loaded through gbrain-under-test.ts (--gbrain <checkout>@<ref>).
 *
 * Retrieval is WITHIN ONE DOCUMENT: each document is imported into a per-arm PGLite brain, its questions run, then the
 * page is soft-deleted, so the only live page is the target. Two measurements per question:
 *   - lead: hybridSearch's row for the page (gbrain returns one chunk per page; this is the chunk an agent is shown).
 *   - hit@k: the page's chunks ranked by RRF (k=60) over gbrain's two chunk-grain legs: searchKeywordChunks and the
 *     cosine of the query embedding with each stored chunk vector (keyless cells: the keyword leg alone).
 * Corpus aw (A-wide, corpus A's deciding measurement) is the exception: all 118 messy-company dev pages share one brain,
 * one question per (account, attribute), and hit@k counts hybridSearch's top-k rows (one chunk per page).
 * A chunk hits when it holds the gold passage (corpus A: the deciding-passage line; corpus B: a 20-word run of a
 * Qasper evidence paragraph, or a whole evidence paragraph of 5 to 19 words). Pins: balanced mode, reranker off
 * (a paid model call, outside the approved budget), expansion off, query cache off. No LLM runs anywhere.
 *
 * Preregistration: docs/benchmarks/2026-10-28-structure-aware-chunks-preregistration.md
 *
 *   bun eval/runner/structure-aware-chunks.ts plan  --gbrain <ckout>@<ref> --qasper <qasper-dev-v0.3.json>
 *   bun eval/runner/structure-aware-chunks.ts run   --gbrain <ckout>@<ref> --qasper <json> --corpus a|aw|b --arm <arm>
 *        --out <dir> --embed-cache <sqlite> --budget-usd <cap for this process> [--stub-embed] [--limit-docs N]
 *   bun eval/runner/structure-aware-chunks.ts cat   --gbrain <ckout>@<ref> --cat 13|13b --arm base|prefix|kw_base|kw_terms --out <dir>
 *        --embed-cache <sqlite> --budget-usd <cap> [--stub-embed]
 *   bun eval/runner/structure-aware-chunks.ts guard --gbrain <ckout>@<ref> --out <dir>
 *   bun eval/runner/structure-aware-chunks.ts report --out <dir>
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gbrainSpecFrom, importGbrain, overlaySummary, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
export const QASPER_DEV_SHA256 = '2ae7ee62a65b1c4225791c70de80c2aad4e8998cf1fd4f09a53103db4f21af93';
export const MESSY_DIR = join(REPO_ROOT, 'eval/data/messy-company-v1');
export const MIN_DOC_CHUNKS = 4;
export const SHINGLE = 20;
export const MIN_EVIDENCE_WORDS = 5;
export const RRF_K = 60;
export const EMBED_MODEL = 'openai:text-embedding-3-large';
export const EMBED_DIMS = 1536;
/** text-embedding-3-large list price, USD per million input tokens. */
export const EMBED_USD_PER_MTOK = 0.13;
const SEARCH_PINS: Record<string, string> = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'search.expansion': 'false',
  'search.cache.enabled': 'false',
};

export type ArmName = 'base' | 'prefix' | 'lead' | 'prefix_lead' | 'kw_base' | 'kw_lead' | 'kw_terms' | 'kw_lead_terms';
interface ArmSpec { prefix: boolean; lead: boolean; embed: boolean; terms: boolean }
export const ARMS: Record<ArmName, ArmSpec> = {
  base: { prefix: false, lead: false, embed: true, terms: false },
  prefix: { prefix: true, lead: false, embed: true, terms: false },
  lead: { prefix: false, lead: true, embed: true, terms: false },
  prefix_lead: { prefix: true, lead: true, embed: true, terms: false },
  kw_base: { prefix: false, lead: false, embed: false, terms: false },
  kw_lead: { prefix: false, lead: true, embed: false, terms: false },
  kw_terms: { prefix: false, lead: false, embed: false, terms: true },
  kw_lead_terms: { prefix: false, lead: true, embed: false, terms: true },
};

/** Primary contrast (alpha 0.05, no correction) and the secondary family (Holm-corrected pooled p). Others are descriptive. */
export const PRIMARY = 'prefix vs base';
export const SECONDARY = ['lead vs base', 'prefix_lead vs prefix', 'kw_terms vs kw_base', 'kw_lead vs kw_base'];

/** Preregistered contrasts: [treatment, control, label]. */
export const CONTRASTS: Array<[ArmName, ArmName, string]> = [
  ['prefix', 'base', 'idea 1: heading path in the embedding prefix'],
  ['lead', 'base', 'idea 2: chunks start at headings'],
  ['prefix_lead', 'prefix', 'idea 2 on top of idea 1'],
  ['prefix_lead', 'base', 'both ideas'],
  ['kw_terms', 'kw_base', 'keyless: heading path in search_vector (weight C)'],
  ['kw_lead', 'kw_base', 'keyless: chunks start at headings'],
  ['kw_lead_terms', 'kw_base', 'keyless: both'],
];

export function setArmEnv(arm: ArmName): void {
  delete process.env.GBRAIN_EXP_HEADING_PREFIX;
  delete process.env.GBRAIN_EXP_HEADINGS_LEAD;
  if (ARMS[arm].prefix) process.env.GBRAIN_EXP_HEADING_PREFIX = '1';
  if (ARMS[arm].lead) process.env.GBRAIN_EXP_HEADINGS_LEAD = '1';
}

// ─── Gold ──────────────────────────────────────────────────────────────

export const norm = (s: string): string => s
  .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[*_\x60#>|]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();

export interface Gold { kind: 'contains' | 'shingle'; needles: string[] }
export interface Question { id: string; query: string; gold: Gold; meta?: Record<string, unknown> }
export interface Doc { slug: string; content: string; questions: Question[] }

function shingles(words: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

export function chunkHits(chunkText: string, gold: Gold): boolean {
  const c = norm(chunkText);
  if (gold.kind === 'contains') return gold.needles.some(n => c.includes(n));
  const sh = shingles(c.split(' '));
  const padded = ' ' + c + ' ';
  return gold.needles.some(p => {
    const pw = p.split(' ');
    if (pw.length < SHINGLE) return padded.includes(' ' + p + ' ');
    for (let i = 0; i + SHINGLE <= pw.length; i++) if (sh.has(pw.slice(i, i + SHINGLE).join(' '))) return true;
    return false;
  });
}

// ─── Corpus A: messy-company-v1 governing-records, dev split ────────────

/** One natural question per attribute, fixed in the preregistration before any run. */
export const ATTRIBUTE_QUERIES: Record<string, string> = {
  seats: 'How many user seats does the customer subscribe to?',
  price_per_seat: 'What is the price per seat?',
  discount_pct: 'What discount does the customer get?',
  payment_terms_days: 'How many days does the customer have to pay an invoice?',
  notice_days: 'How much notice is needed to cancel or not renew the agreement?',
  renewal_date: 'When does the agreement renew?',
  sla_tier: 'What support SLA tier does the customer have?',
};

function walkMd(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir).sort()) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walkMd(full, out);
    else if (e.endsWith('.md')) out.push(full);
  }
  return out;
}

export function corpusA(root = MESSY_DIR): Doc[] {
  const dir = join(root, 'corpus', 'dev');
  const pages = new Map(walkMd(dir).map(p => [relative(dir, p).replace(/\.md$/, ''), readFileSync(p, 'utf8')]));
  const rows = readFileSync(join(root, 'labels', 'governing-records', 'dev.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const groups = new Map<string, { slug: string; attribute: string; needles: Set<string>; rows: string[] }>();
  for (const r of rows) {
    const dp = r.deciding_passage;
    if (!dp?.slug || !dp.quote) continue;
    const key = dp.slug + '|' + r.attribute;
    const g = groups.get(key) ?? { slug: dp.slug, attribute: r.attribute, needles: new Set<string>(), rows: [] as string[] };
    const words = norm(dp.quote).split(' ');
    g.needles.add((words.length > 40 ? words.slice(0, 25) : words).join(' '));
    g.rows.push(r.id);
    groups.set(key, g);
  }
  const docs = new Map<string, Doc>();
  for (const g of [...groups.values()].sort((a, b) => (a.slug + a.attribute).localeCompare(b.slug + b.attribute))) {
    const content = pages.get(g.slug);
    if (!content) throw new Error('corpus A: deciding passage on missing page ' + g.slug);
    const query = ATTRIBUTE_QUERIES[g.attribute];
    if (!query) throw new Error('corpus A: no preregistered query for attribute ' + g.attribute);
    const doc = docs.get(g.slug) ?? { slug: g.slug, content, questions: [] };
    doc.questions.push({ id: g.slug + ':' + g.attribute, query, gold: { kind: 'contains', needles: [...g.needles] }, meta: { attribute: g.attribute, label_rows: g.rows.length } });
    docs.set(g.slug, doc);
  }
  return [...docs.values()];
}

/**
 * Corpus A-wide: the same governing-records dev labels asked across the whole dev brain (all 118 pages), one question per
 * (account, attribute), naming the account. Gold: every deciding passage labelled for that pair (the as-of choice between
 * them is the reader's job, not retrieval's). Within-document corpus A keeps only the documents that chunk to 4 or more
 * pieces, which on the dev split is too few questions to decide anything, so this is corpus A's decision measurement.
 */
export const ACCOUNT_NAMES: Record<string, string> = {
  brackenwater: 'Brackenwater Freight Co.', 'marrow-agrisupply': 'Marrow Agrisupply', 'marrow-fieldworks': 'Marrow Fieldworks',
  orrin: 'Thornbury Cloth Co. (formerly Orrin Mills)', quarrendon: 'Quarrendon Freight Lines', tamsin: 'Tamsin Cold Chain',
  tansleigh: 'Tansleigh Packaging', 'tansley-parcel': 'Tansley Parcel',
};
export const ACCOUNT_QUERIES: Record<string, string> = {
  seats: 'How many user seats does {account} subscribe to?',
  price_per_seat: 'What is the price per seat for {account}?',
  discount_pct: 'What discount does {account} get?',
  payment_terms_days: 'How many days does {account} have to pay an invoice?',
  notice_days: 'How much notice does {account} need to give to cancel or not renew?',
  renewal_date: 'When does the {account} agreement renew?',
  sla_tier: 'What support SLA tier does {account} have?',
};

export function corpusAWide(root = MESSY_DIR): { pages: Array<{ slug: string; content: string }>; questions: Array<Question & { gold_slugs: string[] }> } {
  const dir = join(root, 'corpus', 'dev');
  const pages = walkMd(dir).map(p => ({ slug: relative(dir, p).replace(/.md$/, ''), content: readFileSync(p, 'utf8') }));
  const rows = readFileSync(join(root, 'labels', 'governing-records', 'dev.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const groups = new Map<string, { account: string; attribute: string; needles: Set<string>; slugs: Set<string> }>();
  for (const r of rows) {
    const dp = r.deciding_passage;
    if (!dp?.slug || !dp.quote) continue;
    const key = r.account + '|' + r.attribute;
    const g = groups.get(key) ?? { account: r.account, attribute: r.attribute, needles: new Set<string>(), slugs: new Set<string>() };
    const words = norm(dp.quote).split(' ');
    g.needles.add((words.length > 40 ? words.slice(0, 25) : words).join(' '));
    g.slugs.add(dp.slug);
    groups.set(key, g);
  }
  const questions = [...groups.values()].sort((a, b) => (a.account + a.attribute).localeCompare(b.account + b.attribute)).map(g => {
    const name = ACCOUNT_NAMES[g.account];
    const tpl = ACCOUNT_QUERIES[g.attribute];
    if (!name || !tpl) throw new Error('corpus A-wide: no preregistered name or query for ' + g.account + '/' + g.attribute);
    return { id: g.account + ':' + g.attribute, query: tpl.replace('{account}', name), gold: { kind: 'contains' as const, needles: [...g.needles] }, gold_slugs: [...g.slugs].sort() };
  });
  return { pages, questions };
}

// ─── Corpus B: Qasper dev ───────────────────────────────────────────────

export function renderQasper(p: { title: string; abstract: string; full_text: Array<{ section_name: string | null; paragraphs: string[] }> }): string {
  let body = '## Abstract\n\n' + p.abstract.trim() + '\n\n';
  const seen = new Set<string>();
  for (const s of p.full_text) {
    const parts = String(s.section_name ?? '').split(':::').map(x => x.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join(' ::: ');
      if (seen.has(key)) continue;
      seen.add(key);
      body += '#'.repeat(Math.min(i + 2, 6)) + ' ' + parts[i] + '\n\n';
    }
    for (const para of s.paragraphs) if (para.trim()) body += para.trim() + '\n\n';
  }
  return '---\ntitle: ' + JSON.stringify(p.title.trim()) + '\ntype: note\n---\n\n' + body;
}

export function corpusB(path: string): Doc[] {
  const raw = readFileSync(path);
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== QASPER_DEV_SHA256) throw new Error('qasper dev file sha256 ' + sha + ' != pinned ' + QASPER_DEV_SHA256);
  const data = JSON.parse(raw.toString('utf8')) as Record<string, any>;
  const docs: Doc[] = [];
  for (const id of Object.keys(data).sort()) {
    const p = data[id];
    const content = renderQasper(p);
    const body = norm(content);
    const questions: Question[] = [];
    for (const qa of p.qas) {
      const needles = new Set<string>();
      for (const a of qa.answers) {
        if (a.answer.unanswerable) continue;
        for (const ev of a.answer.evidence as string[]) {
          if (ev.startsWith('FLOAT SELECTED')) continue;
          const n = norm(ev);
          if (n.split(' ').length < MIN_EVIDENCE_WORDS) continue;
          if (body.includes(n)) needles.add(n);
        }
      }
      if (needles.size > 0) questions.push({ id: id + ':' + qa.question_id, query: qa.question.trim(), gold: { kind: 'shingle', needles: [...needles] } });
    }
    if (questions.length > 0) docs.push({ slug: 'qasper/' + id.replace(/[^a-z0-9.-]/gi, '-'), content, questions });
  }
  return docs;
}

// ─── gbrain modules ─────────────────────────────────────────────────────

export interface G {
  gut: GbrainUnderTest;
  PGLiteEngine: any; importFromContent: any; hybridSearch: any; embedQuery: any; parseMarkdown: any; prepareMarkdownChunks: any;
  buildContextualPrefix: any; configureGateway: any; setTransport: any; embedCache: any; loadSearchModeConfig: any; resolveSearchMode: any;
}

export async function loadG(argv: string[]): Promise<G> {
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const m = (p: string) => importGbrain<any>(gut, p);
  const [eng, imp, hyb, emb, md, mc, ec, gw, cache, mode] = await Promise.all([
    m('src/core/pglite-engine.ts'), m('src/core/import-file.ts'), m('src/core/search/hybrid.ts'), m('src/core/embedding.ts'),
    m('src/core/markdown.ts'), m('src/core/markdown-chunks.ts'), m('src/core/embedding-context.ts'), m('src/core/ai/gateway.ts'),
    m('src/eval/shared/embed-cache.ts'), m('src/core/search/mode.ts'),
  ]);
  if (typeof mc.experimentHeadingPaths !== 'function') throw new Error('gbrain under test lacks the experiment patch (markdown-chunks.ts experimentHeadingPaths)');
  return { gut, PGLiteEngine: eng.PGLiteEngine, importFromContent: imp.importFromContent, hybridSearch: hyb.hybridSearch, embedQuery: emb.embedQuery,
    parseMarkdown: md.parseMarkdown, prepareMarkdownChunks: mc.prepareMarkdownChunks, buildContextualPrefix: ec.buildContextualPrefix,
    configureGateway: gw.configureGateway, setTransport: gw.__setEmbedTransportForTests, embedCache: cache,
    loadSearchModeConfig: mode.loadSearchModeConfig, resolveSearchMode: mode.resolveSearchMode };
}

/** The heading path a chunk carries in the prefix and the terms arm: the patch's path minus a leading page-title heading. */
export function displayPath(headingPath: string | undefined, title: string): string {
  if (!headingPath) return '';
  const parts = headingPath.split(' › ');
  if (parts[0]?.trim().toLowerCase() === title.trim().toLowerCase()) parts.shift();
  return parts.join(' › ');
}

/** The chunks and exact embedding inputs gbrain's import would produce for a document under an arm (no I/O). */
export async function projectDoc(g: G, doc: Doc, arm: ArmName): Promise<{ title: string; chunks: Array<{ chunk_index: number; chunk_text: string; chunk_source: string; heading_path: string; input: string }> }> {
  setArmEnv(arm);
  const parsed = g.parseMarkdown(doc.content, doc.slug + '.md');
  const chunks = await g.prepareMarkdownChunks(parsed);
  const titlePrefix = g.buildContextualPrefix(parsed.title, null);
  return {
    title: parsed.title,
    chunks: chunks.map((c: any) => {
      const path = displayPath(c.heading_path, parsed.title);
      const prefix = ARMS[arm].prefix && path ? g.buildContextualPrefix(parsed.title, path) : titlePrefix;
      return { chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source, heading_path: path,
        input: c.chunk_source === 'fenced_code' || !prefix ? c.chunk_text : prefix + c.chunk_text };
    }),
  };
}

// ─── Plan: eligibility, chunk counts and projected cost (no network) ───

export interface Eligible { docs: Doc[]; excluded: { short_docs: number; unreachable_questions: number }; questions: number }

export async function eligible(g: G, docs: Doc[]): Promise<Eligible> {
  const out: Doc[] = [];
  let shortDocs = 0, unreachable = 0;
  for (const d of docs) {
    const base = await projectDoc(g, d, 'base');
    if (base.chunks.length < MIN_DOC_CHUNKS) { shortDocs++; continue; }
    const qs = d.questions.filter(q => base.chunks.some(c => chunkHits(c.chunk_text, q.gold)));
    unreachable += d.questions.length - qs.length;
    if (qs.length > 0) out.push({ ...d, questions: qs });
  }
  setArmEnv('base');
  return { docs: out, excluded: { short_docs: shortDocs, unreachable_questions: unreachable }, questions: out.reduce((a, d) => a + d.questions.length, 0) };
}

const tokensOf = (s: string) => Math.ceil(s.length / 3.5);

async function plan(argv: string[]): Promise<void> {
  const g = await loadG(argv);
  const corpora: Record<string, Doc[]> = { a: corpusA(), b: corpusB(need(argv, '--qasper')) };
  const report: Record<string, any> = { gbrain: overlaySummary(g.gut), corpora: {} };
  let usd = 0;
  for (const [name, docs] of Object.entries(corpora)) {
    const el = await eligible(g, docs);
    const arms: Record<string, unknown> = {};
    for (const arm of Object.keys(ARMS) as ArmName[]) {
      let chunks = 0, withPath = 0, tok = 0, reachable = 0;
      for (const d of el.docs) {
        const p = await projectDoc(g, d, arm);
        chunks += p.chunks.length;
        withPath += p.chunks.filter(c => c.heading_path).length;
        tok += p.chunks.reduce((a, c) => a + tokensOf(c.input), 0);
        reachable += d.questions.filter(q => p.chunks.some(c => chunkHits(c.chunk_text, q.gold))).length;
      }
      const qTok = el.docs.reduce((a, d) => a + d.questions.reduce((b, q) => b + tokensOf(q.query), 0), 0);
      const cost = ARMS[arm].embed ? (tok + qTok) * EMBED_USD_PER_MTOK / 1e6 : 0;
      usd += cost;
      arms[arm] = { chunks, chunks_with_heading_path: withPath, embed_tokens_est: ARMS[arm].embed ? tok + qTok : 0, usd_est: Number(cost.toFixed(4)), reachable_questions: reachable };
    }
    report.corpora[name] = { docs_in: docs.length, docs: el.docs.length, questions: el.questions, excluded: el.excluded, arms };
  }
  setArmEnv('base');
  report.usd_est_total_cold_cache = Number(usd.toFixed(4));
  console.log(JSON.stringify(report, null, 2));
}

// ─── Run one (corpus, arm) cell ─────────────────────────────────────────

export function rrf(lists: number[][], k = RRF_K): number[] {
  const score = new Map<number, number>();
  for (const l of lists) l.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

function toVec(e: unknown): Float32Array {
  if (e instanceof Float32Array) return e;
  if (typeof e === 'string') return Float32Array.from(JSON.parse(e));
  if (Array.isArray(e)) return Float32Array.from(e as number[]);
  throw new Error('chunk embedding has an unexpected shape');
}

function hashEmbed(text: string): number[] {
  const v = new Array(EMBED_DIMS).fill(0);
  for (const w of text.toLowerCase().split(/\W+/)) {
    if (!w) continue;
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    v[h % EMBED_DIMS] += 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

async function setupEmbedding(g: G, argv: string[], stub: boolean, budget: number) {
  if (!stub && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for a live run (or pass --stub-embed)');
  if (stub) process.env.OPENAI_API_KEY ||= 'dummy-stubbed-transport';
  g.configureGateway({ embedding_model: EMBED_MODEL, embedding_dimensions: EMBED_DIMS, env: process.env as Record<string, string | undefined> });
  const spend = { tokens: 0, chars: 0, calls: 0 };
  let installed: { uninstall(): void } | null = null;
  let cache: any = null;
  if (stub) {
    g.setTransport(async (p: { values: string[] }) => ({ embeddings: p.values.map(hashEmbed), values: p.values, warnings: [], usage: { tokens: 0 } }));
  } else {
    const aiPath = (Bun as any).resolveSync('ai', join(g.gut.root, 'src/eval/shared'));
    const { embedMany } = await import(aiPath);
    const real = async (params: any) => {
      const chars = (params.values as string[]).reduce((a: number, v: string) => a + v.length, 0);
      const projected = (spend.tokens + Math.ceil(chars / 3.5)) * EMBED_USD_PER_MTOK / 1e6;
      if (projected > budget) throw new Error('budget: this batch would take embedding spend to $' + projected.toFixed(4) + ', over the $' + budget + ' cap for this process');
      const res = await embedMany(params);
      spend.calls++; spend.chars += chars; spend.tokens += Number(res?.usage?.tokens ?? Math.ceil(chars / 3.5));
      return res;
    };
    cache = new g.embedCache.EmbeddingCache(resolve(need(argv, '--embed-cache')));
    installed = g.embedCache.installEmbedCache(cache, { realTransport: real, model: EMBED_MODEL, dims: EMBED_DIMS });
  }
  return { spend, installed, cache };
}

async function pinnedEngine(g: G): Promise<{ engine: any; resolved: any }> {
  const engine = new g.PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [k, v] of Object.entries(SEARCH_PINS)) await engine.setConfig(k, v);
  const resolved = g.resolveSearchMode(await g.loadSearchModeConfig(engine));
  if (resolved.contextual_retrieval !== 'title' || resolved.reranker_enabled || resolved.expansion) {
    throw new Error('search pins not applied: ' + JSON.stringify({ cr: resolved.contextual_retrieval, reranker: resolved.reranker_enabled, expansion: resolved.expansion }));
  }
  return { engine, resolved };
}

async function applyHeadingTerms(g: G, engine: any, doc: { slug: string; content: string }, arm: ArmName, stored: any[]): Promise<void> {
  const projected = await projectDoc(g, { ...doc, questions: [] }, arm);
  for (let i = 0; i < stored.length; i++) {
    const path = projected.chunks[i]?.heading_path;
    if (!path) continue;
    await engine.executeRaw("UPDATE content_chunks SET search_vector = search_vector || setweight(to_tsvector('english', gbrain_fts_input($1)), 'C') WHERE id = $2", [path, stored[i].id]);
  }
}

/** Corpus A-wide: one brain holding every dev page; hits are the result rows (one chunk per page). */
async function runWide(g: G, argv: string[]): Promise<void> {
  const arm = need(argv, '--arm') as ArmName;
  if (!ARMS[arm]) throw new Error('unknown arm ' + arm);
  const spec = ARMS[arm];
  const out = resolve(need(argv, '--out'));
  const stub = argv.includes('--stub-embed');
  const { pages, questions } = corpusAWide();
  mkdirSync(out, { recursive: true });
  const cell = 'aw.' + arm + (stub ? '.stub' : '');
  const rowsPath = join(out, 'rows.' + cell + '.jsonl');
  writeFileSync(rowsPath, '');
  const { spend, installed, cache } = await setupEmbedding(g, argv, stub, Number(need(argv, '--budget-usd')));
  const origLog = console.log, origErr = console.error;
  console.log = () => {}; console.error = () => {};
  const rows: Row[] = [];
  let resolved: any, engine: any;
  try {
    ({ engine, resolved } = await pinnedEngine(g));
    const chunkTexts: string[] = [];
    for (const p of pages) {
      const projected = await projectDoc(g, { ...p, questions: [] }, arm);
      setArmEnv(arm);
      const res = await g.importFromContent(engine, p.slug, p.content, { noEmbed: !spec.embed });
      if (spec.embed && res?.embedding_deferred) throw new Error('embedding deferred for ' + p.slug);
      const stored = (await engine.getChunks(p.slug)).sort((a: any, b: any) => a.chunk_index - b.chunk_index);
      if (stored.length !== projected.chunks.length || stored.some((c: any, i: number) => c.chunk_text !== projected.chunks[i].chunk_text)) {
        throw new Error('stored chunks of ' + p.slug + ' differ from the projected chunks; the arm env did not reach the import');
      }
      if (spec.terms) await applyHeadingTerms(g, engine, p, arm, stored);
      chunkTexts.push(...stored.map((c: any) => c.chunk_text));
    }
    for (const q of questions) {
      const row: Row = { corpus: 'aw', arm, qid: q.id, slug: q.gold_slugs.join(','), n_chunks: chunkTexts.length, reachable: chunkTexts.some(t => chunkHits(t, q.gold)),
        lead_hit: false, lead_chunk: null, top3: [], hit1: false, hit3: false };
      try {
        const hits = await g.hybridSearch(engine, q.query, { limit: 10, ...(spec.embed ? {} : { _embeddingOptedOut: true }) });
        row.top3 = hits.slice(0, 3).map((h: any) => h.chunk_index);
        row.lead_chunk = hits[0]?.chunk_index ?? null;
        row.lead_hit = !!hits[0] && chunkHits(hits[0].chunk_text, q.gold);
        row.hit1 = row.lead_hit;
        row.hit3 = hits.slice(0, 3).some((h: any) => chunkHits(h.chunk_text, q.gold));
        (row as any).top3_slugs = hits.slice(0, 3).map((h: any) => h.slug);
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      rows.push(row);
      appendFileSync(rowsPath, JSON.stringify(row) + '\n');
    }
  } finally {
    console.log = origLog; console.error = origErr;
    await engine?.disconnect().catch(() => {});
    setArmEnv('base');
    installed?.uninstall();
  }
  writeSummary(out, cell, 'aw', arm, stub, g, resolved, pages.length, rows, { short_docs: 0, unreachable_questions: rows.filter(r => !r.reachable).length }, spend, cache);
}

function writeSummary(out: string, cell: string, corpus: string, arm: ArmName, stub: boolean, g: G, resolved: any, docs: number, rows: Row[], excluded: unknown, spend: { tokens: number; calls: number }, cache: any): void {
  const stats = cache?.stats?.() ?? null;
  cache?.close?.();
  const n = rows.length;
  const rate = (f: (r: Row) => boolean) => n ? rows.filter(f).length / n : null;
  const summary = {
    cell, corpus, arm, stub, gbrain: overlaySummary(g.gut), pins: SEARCH_PINS,
    resolved: { contextual_retrieval: resolved?.contextual_retrieval, reranker_enabled: resolved?.reranker_enabled, expansion: resolved?.expansion },
    docs, questions: n, errors: rows.filter(r => r.error).length, excluded,
    hit1: rate(r => r.hit1), hit3: rate(r => r.hit3), lead_hit: rate(r => r.lead_hit), reachable: rate(r => r.reachable),
    embedding: stub ? { stubbed: true } : { model: EMBED_MODEL, dims: EMBED_DIMS, provider_tokens: spend.tokens, calls: spend.calls, usd: Number((spend.tokens * EMBED_USD_PER_MTOK / 1e6).toFixed(4)), cache: stats },
  };
  writeFileSync(join(out, 'summary.' + cell + '.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}

export interface Row {
  corpus: string; arm: ArmName; qid: string; slug: string; n_chunks: number; reachable: boolean;
  lead_hit: boolean; lead_chunk: number | null; top3: number[]; hit1: boolean; hit3: boolean; error?: string;
}

async function run(argv: string[]): Promise<void> {
  const g = await loadG(argv);
  const corpus = need(argv, '--corpus');
  if (corpus === 'aw') return runWide(g, argv);
  const arm = need(argv, '--arm') as ArmName;
  if (!ARMS[arm]) throw new Error('unknown arm ' + arm);
  const out = resolve(need(argv, '--out'));
  const stub = argv.includes('--stub-embed');
  const budget = Number(need(argv, '--budget-usd'));
  const limitDocs = argv.includes('--limit-docs') ? Number(need(argv, '--limit-docs')) : Infinity;
  const docsAll = corpus === 'a' ? corpusA() : corpusB(need(argv, '--qasper'));
  const el = await eligible(g, docsAll);
  const docs = el.docs.slice(0, limitDocs);
  mkdirSync(out, { recursive: true });
  const cell = corpus + '.' + arm + (stub ? '.stub' : '');
  const rowsPath = join(out, 'rows.' + cell + '.jsonl');
  writeFileSync(rowsPath, '');

  const { spend, installed, cache } = await setupEmbedding(g, argv, stub, budget);

  const origLog = console.log, origErr = console.error;
  console.log = () => {}; console.error = () => {};
  const rows: Row[] = [];
  let resolved: any, engine: any;
  try {
    ({ engine, resolved } = await pinnedEngine(g));
    const spec = ARMS[arm];
    for (const doc of docs) {
      const projected = await projectDoc(g, doc, arm);
      setArmEnv(arm);
      const res = await g.importFromContent(engine, doc.slug, doc.content, { noEmbed: !spec.embed });
      if (spec.embed && res?.embedding_deferred) throw new Error('embedding deferred for ' + doc.slug);
      const stored = (await engine.getChunks(doc.slug, { includeEmbedding: spec.embed })).sort((a: any, b: any) => a.chunk_index - b.chunk_index);
      if (stored.length !== projected.chunks.length || stored.some((c: any, i: number) => c.chunk_text !== projected.chunks[i].chunk_text)) {
        throw new Error('stored chunks of ' + doc.slug + ' differ from the projected chunks; the arm env did not reach the import');
      }
      if (spec.terms) await applyHeadingTerms(g, engine, doc, arm, stored);
      const byId = new Map<number, any>(stored.map((c: any) => [c.id, c]));
      for (const q of doc.questions) {
        const row: Row = { corpus, arm, qid: q.id, slug: doc.slug, n_chunks: stored.length, reachable: stored.some((c: any) => chunkHits(c.chunk_text, q.gold)),
          lead_hit: false, lead_chunk: null, top3: [], hit1: false, hit3: false };
        try {
          const hits = await g.hybridSearch(engine, q.query, { limit: 10, ...(spec.embed ? {} : { _embeddingOptedOut: true }) });
          if (hits.some((h: any) => h.slug !== doc.slug)) throw new Error('a result came from a page other than the target');
          if (hits[0]) { row.lead_chunk = hits[0].chunk_index; row.lead_hit = chunkHits(hits[0].chunk_text, q.gold); }
          const kw = (await engine.searchKeywordChunks(q.query, { limit: 1000 })) as any[];
          if (kw.some(h => h.slug !== doc.slug)) throw new Error('a keyword chunk came from a page other than the target');
          const lists: number[][] = [kw.map(h => h.chunk_id)];
          if (spec.embed) {
            const qv = await g.embedQuery(q.query);
            lists.push(stored.map((c: any) => ({ id: c.id, s: cosine(qv, toVec(c.embedding)) })).sort((a: any, b: any) => b.s - a.s || a.id - b.id).map((x: any) => x.id));
          }
          const ranked = rrf(lists).filter(id => byId.has(id));
          row.top3 = ranked.slice(0, 3).map(id => byId.get(id).chunk_index);
          row.hit1 = ranked.slice(0, 1).some(id => chunkHits(byId.get(id).chunk_text, q.gold));
          row.hit3 = ranked.slice(0, 3).some(id => chunkHits(byId.get(id).chunk_text, q.gold));
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e);
        }
        rows.push(row);
        appendFileSync(rowsPath, JSON.stringify(row) + '\n');
      }
      await engine.deletePage(doc.slug);
    }
  } finally {
    console.log = origLog; console.error = origErr;
    await engine?.disconnect().catch(() => {});
    setArmEnv('base');
    installed?.uninstall();
  }
  writeSummary(out, cell, corpus, arm, stub, g, resolved, docs.length, rows, el.excluded, spend, cache);
}

// ─── Report: paired contrasts ───────────────────────────────────────────

function logChoose(n: number, k: number): number { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
/** Exact two-sided McNemar (binomial on the discordant pairs). */
export function mcnemar(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const m = Math.min(wins, losses);
  let p = 0;
  for (let i = 0; i <= m; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

function readRows(out: string, cell: string): Row[] | null {
  const p = join(out, 'rows.' + cell + '.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : null;
}

export function contrast(t: Row[], c: Row[], metric: 'hit3' | 'hit1' | 'lead_hit') {
  const cm = new Map(c.map(r => [r.qid, r]));
  let wins = 0, losses = 0, n = 0, tk = 0, ck = 0;
  for (const r of t) {
    const o = cm.get(r.qid);
    if (!o) continue;
    n++; if (r[metric]) tk++; if (o[metric]) ck++;
    if (r[metric] && !o[metric]) wins++; else if (!r[metric] && o[metric]) losses++;
  }
  if (n !== t.length || n !== c.length) throw new Error('arms answered different question sets');
  return { n, treatment: tk / n, control: ck / n, wins, losses, net: wins - losses, p: mcnemar(wins, losses) };
}

/** Corpora that decide (preregistered): corpus A is measured on aw (all dev pages, one brain); a (within-document) is reported only. */
export const DECIDING = ['aw', 'b'] as const;
/** Preregistered no-regression bounds for Cat 13 and Cat 13b. */
export const CAT13_NDCG_TOLERANCE = 0.01;
export const CAT13B_TOP1_TOLERANCE_QUERIES = 1;

function catCheck(out: string, treatment: ArmName, control: ArmName): Record<string, any> | null {
  const read = (c: string, a: ArmName) => { const p = join(out, 'summary.cat' + c + '.' + a + '.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const t13 = read('13', treatment), c13 = read('13', control), t13b = read('13b', treatment), c13b = read('13b', control);
  if (!t13 || !c13 || !t13b || !c13b) return null;
  const p1 = contrast(t13.per_query.map((q: any) => ({ qid: q.id, hit: q.p1_strict === 1 })) as any, c13.per_query.map((q: any) => ({ qid: q.id, hit: q.p1_strict === 1 })) as any, 'hit' as any);
  const top1 = (s: any) => s.per_query.filter((q: any) => q.targetRank === 1).length;
  const top3 = (s: any) => s.per_query.filter((q: any) => q.targetRank >= 1 && q.targetRank <= 3).length;
  const r = {
    cat13: { ndcg5: [t13.ndcg5, c13.ndcg5], delta: t13.ndcg5 - c13.ndcg5, p1_strict: p1 },
    cat13b: { top1: [top1(t13b), top1(c13b)], top3: [top3(t13b), top3(c13b)], queries: t13b.queries, errors: t13b.errors + c13b.errors },
    ok: false,
  };
  r.ok = r.cat13.delta >= -CAT13_NDCG_TOLERANCE && !(p1.losses > p1.wins && p1.p < 0.05)
    && top1(t13b) >= top1(c13b) - CAT13B_TOP1_TOLERANCE_QUERIES && r.cat13b.errors === 0;
  return r;
}

async function report(argv: string[]): Promise<void> {
  const out = resolve(need(argv, '--out'));
  const corpora = ['a', 'aw', 'b'];
  const result: Record<string, any> = { cells: {}, cat_cells: {}, contrasts: [] };
  for (const c of corpora) for (const arm of Object.keys(ARMS)) {
    const p = join(out, 'summary.' + c + '.' + arm + '.json');
    if (existsSync(p)) result.cells[c + '.' + arm] = JSON.parse(readFileSync(p, 'utf8'));
  }
  for (const c of ['13', '13b']) for (const arm of ['base', 'prefix', 'kw_base', 'kw_terms']) {
    const p = join(out, 'summary.cat' + c + '.' + arm + '.json');
    if (existsSync(p)) { const { per_query: _pq, ...s } = JSON.parse(readFileSync(p, 'utf8')); result.cat_cells['cat' + c + '.' + arm] = s; }
  }
  for (const [t, ctl, label] of CONTRASTS) {
    const entry: Record<string, any> = { treatment: t, control: ctl, label };
    const pooledT: Row[] = [], pooledC: Row[] = [];
    for (const c of corpora) {
      const tr = readRows(out, c + '.' + t), cr = readRows(out, c + '.' + ctl);
      if (!tr || !cr) continue;
      entry[c] = { hit3: contrast(tr, cr, 'hit3'), hit1: contrast(tr, cr, 'hit1'), lead_hit: contrast(tr, cr, 'lead_hit') };
      if ((DECIDING as readonly string[]).includes(c)) { pooledT.push(...tr); pooledC.push(...cr); }
    }
    if (DECIDING.every(c => entry[c])) {
      entry.pooled_hit3 = contrast(pooledT, pooledC, 'hit3');
      entry.decision = { hit3_up_on_aw: entry.aw.hit3.net > 0, hit3_up_on_b: entry.b.hit3.net > 0, pooled_p_below_0_05: entry.pooled_hit3.p < 0.05 };
      entry.role = t + ' vs ' + ctl === PRIMARY ? 'primary' : SECONDARY.includes(t + ' vs ' + ctl) ? 'secondary' : 'descriptive';
      const cats = ARMS[t].lead && !ARMS[t].prefix && !ARMS[t].terms ? { ok: true, by: 'guard: no-op on Cat 13 and Cat 13b' }
        : t === 'prefix_lead' ? (catCheck(out, 'prefix', 'base') ? { ...catCheck(out, 'prefix', 'base'), by: 'prefix vs base (lead is a no-op there)' } : null)
        : t === 'kw_lead_terms' ? (catCheck(out, 'kw_terms', 'kw_base') ? { ...catCheck(out, 'kw_terms', 'kw_base'), by: 'kw_terms vs kw_base (lead is a no-op there)' } : null)
        : catCheck(out, t, ctl);
      entry.no_regression = cats;
      entry.decision.no_cat13_cat13b_regression = cats ? cats.ok : null;
      entry.decision.rule_met = Object.values(entry.decision).every(v => v === true);
    }
    result.contrasts.push(entry);
  }
  const family = result.contrasts.filter((e: any) => e.role === 'secondary' && e.pooled_hit3).sort((x: any, y: any) => x.pooled_hit3.p - y.pooled_hit3.p);
  let running = 0;
  family.forEach((e: any, i: number) => {
    running = Math.max(running, Math.min(1, (family.length - i) * e.pooled_hit3.p));
    e.pooled_hit3.p_holm = running;
    e.decision.pooled_p_below_0_05 = running < 0.05;
    e.decision.rule_met = Object.entries(e.decision).filter(([k]) => k !== 'rule_met').every(([, v]) => v === true);
  });
  for (const e of result.contrasts) if (e.role === 'descriptive' && e.decision) e.decision.rule_met = null;
  writeFileSync(join(out, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  const pct = (x: number) => (100 * x).toFixed(1);
  const lines = ['| Cell | Docs | Questions | Errors | hit@1 | hit@3 | lead hit | Embedding USD |', '|---|---|---|---|---|---|---|---|'];
  for (const [k, s] of Object.entries<any>(result.cells)) lines.push('| ' + k + ' | ' + s.docs + ' | ' + s.questions + ' | ' + s.errors + ' | ' + pct(s.hit1) + ' | ' + pct(s.hit3) + ' | ' + pct(s.lead_hit) + ' | ' + (s.embedding?.usd ?? 0) + ' |');
  lines.push('', '| Cat cell | Score | Secondary | Embedding USD |', '|---|---|---|---|');
  for (const [k, s] of Object.entries<any>(result.cat_cells)) lines.push('| ' + k + ' | ' + (s.ndcg5 !== undefined ? 'nDCG@5 ' + s.ndcg5.toFixed(4) : 'top-1 ' + pct(s.top1_hit_rate)) + ' | ' + (s.ndcg5 !== undefined ? 'P@1 strict ' + pct(s.p1_strict) : 'top-3 ' + pct(s.top3_hit_rate) + ', errors ' + s.errors) + ' | ' + (s.embedding?.usd ?? 0) + ' |');
  lines.push('', '| Contrast | Corpus | hit@3 treatment vs control | wins/losses | exact p | lead hit treatment vs control | wins/losses |', '|---|---|---|---|---|---|---|');
  for (const e of result.contrasts) {
    for (const c of corpora) {
      if (!e[c]) continue;
      lines.push('| ' + e.treatment + ' vs ' + e.control + ' | ' + c + ' | ' + pct(e[c].hit3.treatment) + ' vs ' + pct(e[c].hit3.control) + ' | +' + e[c].hit3.wins + '/-' + e[c].hit3.losses + ' | ' + e[c].hit3.p.toPrecision(2) + ' | ' + pct(e[c].lead_hit.treatment) + ' vs ' + pct(e[c].lead_hit.control) + ' | +' + e[c].lead_hit.wins + '/-' + e[c].lead_hit.losses + ' |');
    }
    if (e.pooled_hit3) lines.push('| ' + e.treatment + ' vs ' + e.control + ' | pooled aw+b | ' + pct(e.pooled_hit3.treatment) + ' vs ' + pct(e.pooled_hit3.control) + ' | +' + e.pooled_hit3.wins + '/-' + e.pooled_hit3.losses + ' | ' + e.pooled_hit3.p.toPrecision(2) + (e.pooled_hit3.p_holm !== undefined ? ' (Holm ' + e.pooled_hit3.p_holm.toPrecision(2) + ')' : '') + ' | ' + e.role + '; no Cat 13/13b regression: ' + e.decision.no_cat13_cat13b_regression + ' | rule met: ' + e.decision.rule_met + ' |');
  }
  writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

// ─── Cat 13 / Cat 13b under an arm (the no-regression check) ───────────

/** Score gbrain's inline adapter on Cat 13 (world-v1) or Cat 13b (source-swamp-v1) with the arm's env set and gbrain loaded from the overlay. */
async function cat(argv: string[]): Promise<void> {  const g = await loadG(argv);
  const which = need(argv, '--cat');
  if (which !== '13' && which !== '13b') throw new Error('--cat must be 13 or 13b');
  const arm = need(argv, '--arm') as ArmName;
  if (!['base', 'prefix', 'kw_base', 'kw_terms'].includes(arm)) throw new Error('cat arms: base, prefix, kw_base, kw_terms (lead arms are no-ops on these corpora; see guard)');
  const spec = ARMS[arm];
  const out = resolve(need(argv, '--out'));
  const stub = argv.includes('--stub-embed');
  mkdirSync(out, { recursive: true });
  const cell = 'cat' + which + '.' + arm + (stub ? '.stub' : '');
  let embedding: { spend: { tokens: number; calls: number }; installed: { uninstall(): void } | null; cache: any } | null = null;
  if (spec.embed) embedding = await setupEmbedding(g, argv, stub, Number(need(argv, '--budget-usd')));
  else delete process.env.OPENAI_API_KEY;
  delete process.env.GBRAIN_SOURCE_BOOST;
  setArmEnv(arm);
  const { GbrainInlineAdapter } = await import('./adapters/gbrain-inline.ts');
  const { ProbeAccounting } = await import('./probe-accounting.ts');
  let termChunks = 0;
  class ArmAdapter extends GbrainInlineAdapter {
    async init(pages: any[], cfg: any) {
      const state = await super.init(pages, cfg);
      if (!spec.terms) return state;
      const engine = this.engineOf(state) as any;
      for (const p of pages) {
        const content = ['---', 'type: ' + p.type, 'title: ' + JSON.stringify(p.title), '---', '', '# ' + p.title, '', p.compiled_truth];
        if (p.timeline && p.timeline.trim().length > 0) content.push('', '## Timeline', '', p.timeline);
        const doc = { slug: p.slug, content: content.join('\n') };
        const stored = (await engine.getChunks(p.slug)).sort((a: any, b: any) => a.chunk_index - b.chunk_index);
        const projected = await projectDoc(g, { ...doc, questions: [] }, arm);
        if (stored.length !== projected.chunks.length || stored.some((c: any, i: number) => c.chunk_text !== projected.chunks[i].chunk_text)) throw new Error('stored chunks of ' + p.slug + ' differ from the projected chunks');
        await applyHeadingTerms(g, engine, doc, arm, stored);
        termChunks += projected.chunks.filter(c => c.heading_path).length;
      }
      return state;
    }
  }
  const origLog = console.log;
  let summary: Record<string, unknown>;
  try {
    console.log = () => {};
    if (which === '13') {
      const c13 = await import('./cat13-conceptual.ts');
      const pages = c13.loadCorpus(join(REPO_ROOT, 'eval/data/world-v1'));
      const { probes, gradesByQuery } = c13.buildProbes(pages, c13.resolveTargetProbes());
      const searchConfig = c13.pinnedSearchConfig({ reranker: 'off', autocut: 'off' });
      const adapter = new ArmAdapter({ topK: c13.TOP_K, searchConfig, embeddingModel: EMBED_MODEL, embeddingDimensions: EMBED_DIMS, productRoot: g.gut.root, embed: spec.embed });
      const s = await c13.scoreAdapter(adapter, pages, probes, gradesByQuery, new ProbeAccounting(probes.length));
      summary = { metric: 'nDCG@5 (graded)', ndcg5: s.ndcg5, p1_strict: s.p1_strict, p5_graded: s.p5_graded, probes: probes.length, probes_scored: s.probesScored, search_pins: searchConfig,
        per_query: s.per_query.map((q: any) => ({ id: q.id, ndcg5: q.ndcg5, p1_strict: q.p1_strict })) };
    } else {
      const c13b = await import('./cat13b-source-swamp.ts');
      const pages = c13b.loadCorpus(join(REPO_ROOT, 'eval/data/source-swamp-v1'));
      c13b.assertCorpusPremise(pages, c13b.QUERIES);
      const adapter = new ArmAdapter({ topK: c13b.TOP_K, searchConfig: c13b.GBRAIN_SEARCH_CONFIG, embeddingModel: EMBED_MODEL, embeddingDimensions: EMBED_DIMS, productRoot: g.gut.root, embed: spec.embed });
      const s = await c13b.scoreAdapter(adapter, pages, c13b.QUERIES, new ProbeAccounting(c13b.QUERIES.length));
      summary = { metric: 'top-1 hit rate', top1_hit_rate: s.top1_hit_rate, top3_hit_rate: s.top3_hit_rate, swamp_at_top: s.swamp_at_top, queries: c13b.QUERIES.length, search_pins: c13b.GBRAIN_SEARCH_CONFIG,
        errors: s.per_query.filter((q: any) => q.error).length, per_query: s.per_query.map((q: any) => ({ id: q.id, targetRank: q.targetRank, error: q.error })) };
    }
  } finally {
    console.log = origLog;
    setArmEnv('base');
    embedding?.installed?.uninstall();
  }
  const stats = embedding?.cache?.stats?.() ?? null;
  embedding?.cache?.close?.();
  const full = { cell, cat: which, arm, stub, gbrain: overlaySummary(g.gut), heading_term_chunks: spec.terms ? termChunks : undefined, ...summary,
    embedding: !spec.embed ? { keyless: true } : stub ? { stubbed: true } : { model: EMBED_MODEL, dims: EMBED_DIMS, provider_tokens: embedding!.spend.tokens, calls: embedding!.spend.calls, usd: Number((embedding!.spend.tokens * EMBED_USD_PER_MTOK / 1e6).toFixed(4)), cache: stats } };
  writeFileSync(join(out, 'summary.' + cell + '.json'), JSON.stringify(full, null, 2) + '\n');
  const { per_query: _pq, ...brief } = full as any;
  console.log(JSON.stringify(brief));
}

// ─── Guard: are the arms no-ops on the Cat 13 and Cat 13b corpora? ─────

function guardPages(): Record<string, Array<{ slug: string; content: string }>> {
  const render = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort().map(f => {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const truth = Array.isArray(p.compiled_truth) ? p.compiled_truth.join('\n\n') : String(p.compiled_truth ?? '');
    const timeline = Array.isArray(p.timeline) ? p.timeline.join('\n') : String(p.timeline ?? '');
    const fm = ['---', 'type: ' + p.type, 'title: ' + JSON.stringify(p.title), '---', '', '# ' + p.title, '', truth];
    if (timeline.trim()) fm.push('', '## Timeline', '', timeline);
    return { slug: String(p.slug), content: fm.join('\n') };
  });
  return { cat13_world_v1: render(join(REPO_ROOT, 'eval/data/world-v1')), cat13b_source_swamp_v1: render(join(REPO_ROOT, 'eval/data/source-swamp-v1')) };
}

async function guard(argv: string[]): Promise<void> {
  const g = await loadG(argv);
  const out = resolve(need(argv, '--out'));
  mkdirSync(out, { recursive: true });
  const result: Record<string, any> = { gbrain: overlaySummary(g.gut), note: 'Pages rendered the way eval/runner/adapters/gbrain-inline.ts renders them for Cat 13 and Cat 13b. An arm whose chunk texts, heading terms and embedding inputs equal the base arm on every page cannot change either category.' };
  for (const [name, pages] of Object.entries(guardPages())) {
    const per: Record<string, any> = {};
    const base = new Map<string, Awaited<ReturnType<typeof projectDoc>>>();
    for (const p of pages) base.set(p.slug, await projectDoc(g, { slug: p.slug, content: p.content, questions: [] }, 'base'));
    for (const arm of ['prefix', 'lead', 'prefix_lead', 'kw_lead', 'kw_terms', 'kw_lead_terms'] as ArmName[]) {
      let changedPages = 0, changedChunks = 0, totalChunks = 0;
      const examples: string[] = [];
      for (const p of pages) {
        const a = await projectDoc(g, { slug: p.slug, content: p.content, questions: [] }, arm);
        const b = base.get(p.slug)!;
        const key = (c: { chunk_text: string; input: string; heading_path: string }) => ARMS[arm].embed ? c.input : c.chunk_text + (ARMS[arm].terms ? '\u0000' + c.heading_path : '');
        const keyBase = (c: { chunk_text: string; input: string }) => ARMS[arm].embed ? c.input : c.chunk_text + (ARMS[arm].terms ? '\u0000' : '');
        const x = a.chunks.map(key), y = b.chunks.map(keyBase);
        totalChunks += x.length;
        const diff = x.length !== y.length ? Math.max(x.length, y.length) : x.filter((v, i) => v !== y[i]).length;
        if (diff > 0) { changedPages++; changedChunks += diff; if (examples.length < 5) examples.push(p.slug); }
      }
      per[arm] = { pages: pages.length, chunks: totalChunks, changed_pages: changedPages, changed_chunks: changedChunks, no_op: changedPages === 0, example_slugs: examples };
    }
    result[name] = per;
  }
  setArmEnv('base');
  writeFileSync(join(out, 'guard-noop.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

function need(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v || v.startsWith('--')) throw new Error(flag + ' is required');
  return v;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = ({ plan, run, report, guard, cat } as Record<string, (a: string[]) => Promise<void>>)[cmd];
  if (!fn) { console.error('usage: structure-aware-chunks.ts plan|run|report|guard|cat ...'); process.exit(2); }
  fn(rest).then(() => process.exit(0), e => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exit(1); });
}
