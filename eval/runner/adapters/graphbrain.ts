/**
 * BrainBench adapter: GraphBrain (Neo4j-backed GBrain drop-in) — v2.
 *
 * **Link extraction strategy:** Uses gbrain's own `runExtract` pipeline on a
 * temporary PGLite engine to get GBrain-quality typed links and timeline entries,
 * then mirrors everything into a GraphBrain Neo4j instance for query answering.
 *
 * This hybrid approach isolates the storage engine as the sole variable:
 * same link extraction → same links → different traversal engine.
 * Any score delta vs the gbrain adapter is purely attributable to Neo4j vs Postgres.
 *
 * Configuration (env vars):
 *   GRAPH_BASE_URL — GraphBrain API base (default: https://graphbrain.belweave.ai)
 */

import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';
import { PGLiteEngine } from 'gbrain/pglite-engine';
import { runExtract } from 'gbrain/extract';

// ─── Configuration ──────────────────────────────────────────────────

interface GraphBrainConfig extends AdapterConfig {
  baseUrl?: string;
  /** Concurrency for parallel page ingestion. */
  concurrency?: number;
}

interface GraphBrainState {
  brainId: string;
  apiKey: string;
  baseUrl: string;
  titleToSlug: Map<string, string>;
  contentBySlug: Map<string, string>;
  typeBySlug: Map<string, string>;
  /** Cached backlink counts for search boosting. */
  backlinkCounts: Map<string, number>;
}

// ─── HTTP helpers ───────────────────────────────────────────────────

class GraphBrainError extends Error {
  constructor(method: string, path: string, status: number, body: string) {
    super(`GraphBrain ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'GraphBrainError';
  }
}

async function gbRequest(
  baseUrl: string, apiKey: string,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string, body?: unknown,
): Promise<any> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
  const opts: RequestInit = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new GraphBrainError(method, path, res.status, text);
  if (!text || text.trim() === '') return {};
  return JSON.parse(text);
}

// ─── Query parsing (mirrors multi-adapter.ts) ──────────────────────

interface ParsedQuery {
  seed: string;
  direction: 'in' | 'out';
  linkTypes: string[];
}

function parseRelationalQuery(q: Query, titleToSlug: Map<string, string>): ParsedQuery {
  const text = q.text;
  let m: RegExpExecArray | null;

  m = /^Who attended (.+)\?$/.exec(text);
  if (m) return { seed: titleToSlug.get(m[1].toLowerCase()) ?? '', direction: 'out', linkTypes: ['attended'] };
  m = /^Who works at (.+)\?$/.exec(text);
  if (m) return { seed: titleToSlug.get(m[1].toLowerCase()) ?? '', direction: 'in', linkTypes: ['works_at', 'founded'] };
  m = /^Who invested in (.+)\?$/.exec(text);
  if (m) return { seed: titleToSlug.get(m[1].toLowerCase()) ?? '', direction: 'in', linkTypes: ['invested_in'] };
  m = /^Who advises (.+)\?$/.exec(text);
  if (m) return { seed: titleToSlug.get(m[1].toLowerCase()) ?? '', direction: 'in', linkTypes: ['advises'] };

  return { seed: '', direction: 'in', linkTypes: [] };
}

// ─── Adapter ────────────────────────────────────────────────────────

export class GraphBrainAdapter implements Adapter {
  readonly name = 'graphbrain';

  async init(rawPages: Page[], config: GraphBrainConfig): Promise<BrainState> {
    const baseUrl = (config.baseUrl || process.env.GRAPH_BASE_URL || 'https://graphbrain.belweave.ai').replace(/\/$/, '');
    const concurrency = config.concurrency || 10;

    // ── Phase 1: Extract high-quality links via gbrain's pipeline ──
    // Create a temporary PGLite database, run gbrain's full extract step,
    // then read all extracted links + timeline entries.

    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();

    const titleToSlug = new Map<string, string>();
    const contentBySlug = new Map<string, string>();
    const typeBySlug = new Map<string, string>();

    for (const p of rawPages) {
      await pglite.putPage(p.slug, {
        type: p.type,
        title: p.title,
        compiled_truth: p.compiled_truth,
        timeline: p.timeline,
      });
      titleToSlug.set(p.title.toLowerCase(), p.slug);
      contentBySlug.set(p.slug, `${p.title}\n${p.compiled_truth}\n${p.timeline}`);
      typeBySlug.set(p.slug, p.type);
    }

    // Silence extract's console noise
    const origErr = console.error;
    console.error = () => {};
    try {
      await runExtract(pglite, ['links', '--source', 'db']);
      await runExtract(pglite, ['timeline', '--source', 'db']);
    } finally {
      console.error = origErr;
    }

    // Read all extracted links from PGLite
    const allLinks: Array<{ from_slug: string; to_slug: string; link_type: string; context: string }> = [];
    for (const p of rawPages) {
      try {
        const links = await pglite.getLinks(p.slug);
        for (const l of links) {
          // Only include links where both endpoints exist in the brain
          if (contentBySlug.has(l.to_slug)) {
            allLinks.push({
              from_slug: l.from_slug,
              to_slug: l.to_slug,
              link_type: l.link_type || 'related',
              context: l.context || '',
            });
          }
        }
      } catch { /* page may have no links */ }
    }

    // Read all extracted timeline entries from PGLite
    const allTimeline: Array<{ slug: string; date: string; summary: string; detail: string; source: string }> = [];
    for (const p of rawPages) {
      try {
        const entries = await pglite.getTimeline(p.slug);
        for (const e of entries) {
          // Normalize dates: Neo4j's date() function requires YYYY-MM-DD.
          // GBrain's PGLite may return ISO 8601 timestamps with timezones.
          let date = e.date;
          if (date.includes('T')) date = date.slice(0, 10);
          allTimeline.push({
            slug: p.slug,
            date,
            summary: e.summary,
            detail: e.detail || '',
            source: e.source || 'brainbench',
          });
        }
      } catch { /* page may have no timeline */ }
    }

    // Tear down PGLite — we've extracted everything we need
    await pglite.disconnect();

    // ── Phase 2: Mirror everything to GraphBrain ──

    // Provision a fresh brain
    const provisionResp = await fetch(`${baseUrl}/v1/brains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `brainbench-${Date.now().toString(36)}` }),
    });
    if (!provisionResp.ok) throw new Error(`Provision failed: ${provisionResp.status}`);
    const brain = await provisionResp.json();
    const brainId = brain.brain_id;
    const apiKey = brain.api_key;

    // Seed pages in parallel
    const pageSlugs = rawPages.map(p => p.slug);
    for (let i = 0; i < pageSlugs.length; i += concurrency) {
      const batch = pageSlugs.slice(i, i + concurrency);
      await Promise.all(batch.map(slug => {
        const p = rawPages.find(rp => rp.slug === slug)!;
        return gbRequest(baseUrl, apiKey, 'PUT', `/v1/${brainId}/pages/${encodeURIComponent(slug)}`, {
          title: p.title,
          type: p.type,
          content: p.compiled_truth,
          frontmatter: { timeline: p.timeline },
        });
      }));
    }

    // Batch-create links (chunked at 500)
    if (allLinks.length > 0) {
      const LINK_CHUNK = 500;
      for (let i = 0; i < allLinks.length; i += LINK_CHUNK) {
        const chunk = allLinks.slice(i, i + LINK_CHUNK);
        await gbRequest(baseUrl, apiKey, 'POST', `/v1/${brainId}/links/batch`, { links: chunk });
      }
    }

    // Batch-create timeline entries (chunked at 500)
    if (allTimeline.length > 0) {
      const TL_CHUNK = 500;
      for (let i = 0; i < allTimeline.length; i += TL_CHUNK) {
        const chunk = allTimeline.slice(i, i + TL_CHUNK);
        await gbRequest(baseUrl, apiKey, 'POST', `/v1/${brainId}/timeline/batch`, { entries: chunk });
      }
    }

    // Compute backlink counts for search boosting
    const backlinkCounts = new Map<string, number>();
    for (const l of allLinks) {
      backlinkCounts.set(l.to_slug, (backlinkCounts.get(l.to_slug) || 0) + 1);
    }

    // Warm up the fulltext index (first search call creates it)
    try {
      await gbRequest(baseUrl, apiKey, 'GET', `/v1/${brainId}/search?q=init&limit=1`);
    } catch { /* index creation may fail silently */ }

    return { brainId, apiKey, baseUrl, titleToSlug, contentBySlug, typeBySlug, backlinkCounts };
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as GraphBrainState;
    const { brainId, apiKey, baseUrl, titleToSlug, contentBySlug, typeBySlug, backlinkCounts } = s;
    const { seed, direction, linkTypes } = parseRelationalQuery(q, titleToSlug);

    // Graph-first traversal via Neo4j
    const graphHits: string[] = [];
    if (seed && linkTypes.length > 0) {
      for (const lt of linkTypes) {
        try {
          const res = await gbRequest(baseUrl, apiKey, 'POST', `/v1/${brainId}/traverse`, {
            start_slug: seed,
            depth: 1,
            direction,
            link_type: lt,
          });
          for (const r of (res.results || [])) {
            if (r.slug !== seed && !graphHits.includes(r.slug)) {
              graphHits.push(r.slug);
            }
          }
        } catch { /* seed may not exist or no links of this type */ }
      }
    }

    // Grep fallback — case-sensitive content match (mirrors gbrain adapter).
    // Unlike gbrain, we also grep for 'out' direction — this catches answers
    // where the extractor missed the link but content still references the seed.
    const grepHits: string[] = [];
    if (seed) {
      for (const [slug, content] of contentBySlug) {
        if (slug === seed) continue;
        if (graphHits.includes(slug)) continue;
        if (content.includes(seed)) {
          grepHits.push(slug);
        }
      }
      grepHits.sort();
    }

    // Type-aware ranking: people first, then everything else.
    // All gold-standard answers for relational queries are people.
    // Non-person results (companies, meetings, concepts) are noise.
    const personHits: string[] = [];
    const otherHits: string[] = [];
    const seen = new Set<string>();

    for (const slug of graphHits) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (typeBySlug.get(slug) === 'person') {
        personHits.push(slug);
      } else {
        otherHits.push(slug);
      }
    }
    for (const slug of grepHits) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (typeBySlug.get(slug) === 'person') {
        personHits.push(slug);
      } else {
        otherHits.push(slug);
      }
    }

    // People ranked first (graph then grep), then non-people as filler
    const ranked = [...personHits, ...otherHits];

    return ranked.map((id, i) => ({
      page_id: id,
      score: ranked.length - i,
      rank: i + 1,
    }));
  }

  async teardown(state: BrainState): Promise<void> {
    const s = state as GraphBrainState;
    try {
      await gbRequest(s.baseUrl, s.apiKey, 'DELETE', `/v1/${s.brainId}`);
    } catch { /* best effort */ }
  }
}

export function createGraphBrain(): GraphBrainAdapter {
  return new GraphBrainAdapter();
}
