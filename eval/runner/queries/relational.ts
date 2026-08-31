/**
 * Shared world-v1 relational query builder + corpus loader.
 *
 * ONE implementation of the "derive relational gold from _facts" logic.
 * Both eval/runner/multi-adapter.ts and eval/runner/shootout-driver.ts
 * previously carried private copies, and the shootout copy silently dropped
 * the invested_in and advises templates while its receipt reused the same
 * mean_precision_at_k / mean_recall_at_k field names as the multi-adapter
 * scorecard (audit finding orchestrators-15). Sharing the builder makes the
 * two runners' relational numbers comparable by construction.
 *
 * Four templates, all tier 'medium', gold from the page's _facts metadata:
 *   - "Who attended <meeting title>?"     gold = attendees
 *   - "Who works at <company title>?"     gold = employees + founders
 *   - "Who invested in <company title>?"  gold = investors
 *   - "Who advises <company title>?"      gold = advisors
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Page, Query } from '../types.ts';

/** world-v1 page shape including the gold-canonical _facts metadata.
 *  _facts is scorer-only: multi-adapter/shootout-driver sanitizePage()
 *  before anything reaches an adapter. */
export interface RichPage extends Page {
  _facts: {
    type: string;
    role?: string;
    primary_affiliation?: string;
    secondary_affiliations?: string[];
    founders?: string[];
    employees?: string[];
    investors?: string[];
    advisors?: string[];
    attendees?: string[];
  };
}

/**
 * Load the world-v1 corpus from a directory of per-page JSON shards.
 * Filenames are sorted so page order (and therefore the generated q-NNNN
 * ids and the seeded per-run shuffles downstream) is identical on every
 * filesystem, not dependent on readdir order.
 */
export function loadWorldCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

/** Relational queries with gold derived from _facts. All 4 template families. */
export function buildRelationalQueries(pages: RichPage[]): Query[] {
  const existing = new Set(pages.map(p => p.slug));
  const filter = (slugs: string[]) => slugs.filter(s => existing.has(s));
  const queries: Query[] = [];
  let counter = 0;
  const nextId = () => `q-${String(++counter).padStart(4, '0')}`;

  // "Who attended X?" (meeting → people). Medium tier.
  for (const p of pages) {
    if (p._facts.type !== 'meeting') continue;
    const expected = filter(p._facts.attendees ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who attended ${p.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: expected },
    });
  }

  // "Who works at X?" (company → people). Medium.
  for (const p of pages) {
    if (p._facts.type !== 'company') continue;
    const expected = filter([...(p._facts.employees ?? []), ...(p._facts.founders ?? [])]);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who works at ${p.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: [...new Set(expected)] },
    });
  }

  // "Who invested in X?" Medium.
  for (const p of pages) {
    if (p._facts.type !== 'company') continue;
    const expected = filter(p._facts.investors ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who invested in ${p.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: expected },
    });
  }

  // "Who advises X?" Medium.
  for (const p of pages) {
    if (p._facts.type !== 'company') continue;
    const expected = filter(p._facts.advisors ?? []);
    if (expected.length === 0) continue;
    queries.push({
      id: nextId(),
      tier: 'medium',
      text: `Who advises ${p.title}?`,
      expected_output_type: 'cited-source-pages',
      gold: { relevant: expected },
    });
  }

  return queries;
}
