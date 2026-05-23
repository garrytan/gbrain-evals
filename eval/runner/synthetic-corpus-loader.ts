/**
 * Shared loader for the synthetic-v1 corpus.
 *
 * Walks eval/data/synthetic-v1/ and returns a {slug, body, frontmatter} array.
 * Used by Cat 18 / 20 / 25 / 26 / 27 / 29.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const CORPUS_DIR = join(process.cwd(), 'eval/data/synthetic-v1');

export interface SyntheticPage {
  slug: string;
  body: string;
  type: string;
}

export function loadSyntheticV1(): SyntheticPage[] {
  const pages: SyntheticPage[] = [];
  walk(CORPUS_DIR, (file) => {
    if (!file.endsWith('.md')) return;
    if (file.endsWith('_manifest.json')) return;
    const rel = relative(CORPUS_DIR, file).replace(/\.md$/, '');
    const body = readFileSync(file, 'utf8');
    // Extract type from frontmatter (simple line scan)
    const typeMatch = body.match(/^type:\s*(\S+)/m);
    pages.push({
      slug: rel,
      body,
      type: typeMatch?.[1] ?? 'page',
    });
  });
  return pages;
}

function walk(dir: string, cb: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, cb);
    else cb(full);
  }
}

/**
 * Queries that traverse the synthetic corpus' relational structure.
 * Each query has a gold-set derived from the deterministic generator.
 *
 * The seed was 0x42424242; these queries exploit known artifacts of that
 * seed (e.g., "alice-example-0 works at acme-ai-X" etc.). If you regenerate
 * the corpus with a different seed, queries must also regenerate.
 */
export interface SyntheticQuery {
  id: string;
  text: string;
  relevant_slugs: string[];
}

export function syntheticQueries(pages: SyntheticPage[]): SyntheticQuery[] {
  // Auto-derive relational queries from page content.
  const queries: SyntheticQuery[] = [];
  let qid = 0;
  const nextId = () => `synq-${String(++qid).padStart(4, '0')}`;

  // Q1: for each company, find pages that link to it.
  const companies = pages.filter(p => p.slug.startsWith('companies/'));
  for (const c of companies.slice(0, 10)) {
    const title = c.body.match(/^title:\s*(.+)/m)?.[1]?.trim() ?? c.slug;
    const linkers = pages.filter(p =>
      p.body.includes(`[[${c.slug}]]`) && p.slug !== c.slug
    ).map(p => p.slug);
    if (linkers.length === 0) continue;
    queries.push({
      id: nextId(),
      text: `Who is associated with ${title}?`,
      relevant_slugs: linkers,
    });
  }

  // Q2: for each concept, find pages that mention it.
  const concepts = pages.filter(p => p.slug.startsWith('concepts/'));
  for (const c of concepts.slice(0, 10)) {
    const linkers = pages.filter(p =>
      p.body.includes(`[[${c.slug}]]`) && p.slug !== c.slug
    ).map(p => p.slug);
    if (linkers.length === 0) continue;
    const topic = c.slug.replace('concepts/', '').replace(/-/g, ' ');
    queries.push({
      id: nextId(),
      text: `What pages discuss ${topic}?`,
      relevant_slugs: linkers,
    });
  }

  // Q3: meetings — find the attendees.
  const meetings = pages.filter(p => p.slug.startsWith('meetings/'));
  for (const m of meetings.slice(0, 5)) {
    const refs: string[] = [];
    const re = /\[\[(people\/[a-z0-9-]+)\]\]/g;
    let match;
    while ((match = re.exec(m.body)) !== null) refs.push(match[1]);
    if (refs.length === 0) continue;
    const topic = m.slug.match(/meetings\/[\d-]+-([a-z0-9-]+)/)?.[1] ?? 'meeting';
    queries.push({
      id: nextId(),
      text: `Who attended the ${topic.replace(/-/g, ' ')} meeting?`,
      relevant_slugs: [...new Set(refs)],
    });
  }

  return queries;
}
